import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { after, before, describe, it } from "node:test";
import { checkTunnel, probeProxy } from "../src/check.js";
import { startRelay } from "../src/relay.js";
import {
  close,
  hasOpenssl,
  makeCertificate,
  readOnce,
  scratchDir,
  startHttpProxy,
  startEcho,
  startSocksProxy,
  startTlsOrigin
} from "./helpers.js";

const HOST = "api.anthropic.com";

describe("relay end to end", { skip: !hasOpenssl() && "openssl is not installed" }, () => {
  let dir;
  let credentials;
  let origin;
  let httpProxy;
  let socksProxy;
  let relay;
  let relayPort;
  let config;
  const logs = [];

  before(async () => {
    dir = scratchDir();
    credentials = makeCertificate(dir, HOST);
    origin = await startTlsOrigin(credentials);
    httpProxy = await startHttpProxy({ targetPort: origin.port });
    socksProxy = await startSocksProxy({ targetPort: origin.port });
    config = { proxy: `http://127.0.0.1:${httpProxy.port}`, hosts: [HOST, "claude.ai"] };
    relay = await startRelay({
      port: 0,
      addresses: ["127.0.0.1"],
      loadConfig: () => config,
      logger: (level, message) => logs.push(`${level} ${message}`),
      helloTimeoutMs: 300
    });
    relayPort = relay.servers[0].address().port;
  });

  after(async () => {
    await relay.close();
    await Promise.all([close(origin.server), close(httpProxy.server), close(socksProxy.server)]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The client trusts only the origin's certificate: a successful, verified handshake
  // proves the relay passed TLS through untouched.
  function connectThroughRelay(servername = HOST) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host: "127.0.0.1", port: relayPort, servername, ca: credentials.cert });
      socket.once("secureConnect", () => resolve(socket));
      socket.once("error", reject);
    });
  }

  it("tunnels TLS through an HTTP proxy with the certificate verified end to end", async () => {
    config.proxy = `http://127.0.0.1:${httpProxy.port}`;
    const socket = await connectThroughRelay();
    assert.equal(socket.authorized, true);
    const reply = readOnce(socket);
    socket.write("ping");
    assert.equal(await reply, "pong:ping");
    socket.destroy();
    assert.equal(httpProxy.requests.at(-1).requestLine, `CONNECT ${HOST}:443 HTTP/1.1`);
  });

  it("picks up a proxy change on the next connection without a restart", async () => {
    config.proxy = `socks5://127.0.0.1:${socksProxy.port}`;
    const socket = await connectThroughRelay();
    const reply = readOnce(socket);
    socket.write("again");
    assert.equal(await reply, "pong:again");
    socket.destroy();
    assert.equal(socksProxy.requests.at(-1).host, HOST);
  });

  it("drops a host that is not in the list", async () => {
    await assert.rejects(connectThroughRelay("example.com"), /socket disconnected|ECONNRESET/);
    assert.ok(logs.some((line) => line.includes("example.com: not in the host list")));
  });

  it("drops a client that is not speaking TLS", async () => {
    const socket = net.connect(relayPort, "127.0.0.1");
    socket.on("error", () => {});
    const closed = new Promise((resolve) => socket.once("close", resolve));
    socket.write("GET / HTTP/1.1\r\n\r\n");
    await closed;
    assert.ok(logs.some((line) => line.includes("without a TLS server name")));
  });

  it("drops a client that never finishes its ClientHello", async () => {
    const socket = net.connect(relayPort, "127.0.0.1");
    socket.on("error", () => {});
    const closed = new Promise((resolve) => socket.once("close", resolve));
    socket.write(Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00]));
    await closed;
    assert.ok(logs.some((line) => line.includes("no complete TLS ClientHello")));
  });

  it("closes the client when no proxy is configured", async () => {
    const saved = config.proxy;
    config.proxy = null;
    try {
      await assert.rejects(connectThroughRelay(), /socket disconnected|ECONNRESET/);
      assert.ok(logs.some((line) => line.includes("no proxy configured")));
    } finally {
      config.proxy = saved;
    }
  });

  it("checkTunnel reports success and whether Node trusts the certificate", async () => {
    config.proxy = `http://127.0.0.1:${httpProxy.port}`;
    const result = await checkTunnel({ host: HOST, port: relayPort });
    assert.equal(result.ok, true);
    assert.equal(result.trusted, false); // self-signed, not in Node's CA bundle
  });

  it("checkTunnel fails when the certificate is for another name", async () => {
    config.proxy = `http://127.0.0.1:${httpProxy.port}`;
    const result = await checkTunnel({ host: "claude.ai", port: relayPort });
    assert.equal(result.ok, false);
    assert.match(result.error, /not for claude\.ai/);
  });

  it("checkTunnel reports a broken path", async () => {
    config.proxy = "http://127.0.0.1:1";
    const result = await checkTunnel({ host: HOST, port: relayPort, timeoutMs: 3000 });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
});

describe("startRelay", () => {
  it("refuses to start when the port is already taken", async () => {
    const squatter = net.createServer();
    await new Promise((resolve) => squatter.listen(0, "127.0.0.1", resolve));
    try {
      await assert.rejects(
        startRelay({ port: squatter.address().port, addresses: ["127.0.0.1"], loadConfig: () => ({}), logger: () => {} }),
        /cannot listen on 127\.0\.0\.1/
      );
    } finally {
      await close(squatter);
    }
  });

  it("cuts open connections on close instead of waiting for them", async () => {
    const relay = await startRelay({ port: 0, addresses: ["127.0.0.1"], loadConfig: () => ({}), logger: () => {} });
    const socket = net.connect(relay.servers[0].address().port, "127.0.0.1");
    socket.on("error", () => {});
    await new Promise((resolve) => socket.once("connect", resolve));
    const closed = new Promise((resolve) => socket.once("close", resolve));
    const started = Date.now();
    await relay.close();
    await closed;
    assert.ok(Date.now() - started < 1000);
  });
});

describe("probeProxy (onboarding round trip)", { skip: !hasOpenssl() && "openssl is not installed" }, () => {
  let dir;
  let origin;
  let echo;
  before(async () => {
    dir = scratchDir();
    origin = await startTlsOrigin(makeCertificate(dir, HOST));
    echo = await startEcho();
  });
  after(async () => {
    await Promise.all([close(origin.server), close(echo.server)]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const names = (result) => result.stages.map((stage) => `${stage.name}:${stage.ok ? "ok" : "fail"}`);

  it("passes all three stages through an HTTP proxy", async () => {
    const proxy = await startHttpProxy({ targetPort: origin.port });
    try {
      const result = await probeProxy(`http://127.0.0.1:${proxy.port}`, { host: HOST });
      assert.equal(result.ok, true);
      assert.deepEqual(names(result), ["proxy:ok", "tunnel:ok", "tls:ok"]);
      assert.equal(result.trusted, false);
      assert.equal(proxy.requests[0].requestLine, `CONNECT ${HOST}:443 HTTP/1.1`);
    } finally {
      await close(proxy.server);
    }
  });

  it("passes through a SOCKS5 proxy", async () => {
    const proxy = await startSocksProxy({ targetPort: origin.port });
    try {
      const result = await probeProxy(`socks5://127.0.0.1:${proxy.port}`, { host: HOST });
      assert.deepEqual(names(result), ["proxy:ok", "tunnel:ok", "tls:ok"]);
    } finally {
      await close(proxy.server);
    }
  });

  it("stops at the first stage when the proxy is unreachable", async () => {
    const unused = net.createServer();
    await new Promise((resolve) => unused.listen(0, "127.0.0.1", resolve));
    const { port } = unused.address();
    await close(unused);
    const result = await probeProxy(`http://127.0.0.1:${port}`, { host: HOST });
    assert.equal(result.ok, false);
    assert.deepEqual(names(result), ["proxy:fail"]);
    assert.match(result.error, /cannot reach proxy/);
  });

  it("stops at the tunnel stage when the proxy refuses", async () => {
    const proxy = await startHttpProxy({ targetPort: origin.port, requireAuth: "a:b" });
    try {
      const result = await probeProxy(`http://127.0.0.1:${proxy.port}`, { host: HOST });
      assert.deepEqual(names(result), ["proxy:ok", "tunnel:fail"]);
      assert.match(result.error, /407/);
    } finally {
      await close(proxy.server);
    }
  });

  it("stops at the TLS stage when the far end does not speak TLS", async () => {
    const proxy = await startHttpProxy({ targetPort: echo.port });
    try {
      const result = await probeProxy(`http://127.0.0.1:${proxy.port}`, { host: HOST, timeoutMs: 2000 });
      assert.deepEqual(names(result), ["proxy:ok", "tunnel:ok", "tls:fail"]);
    } finally {
      await close(proxy.server);
    }
  });

  it("fails the TLS stage when the certificate is for another host", async () => {
    const proxy = await startHttpProxy({ targetPort: origin.port });
    try {
      const result = await probeProxy(`http://127.0.0.1:${proxy.port}`, { host: "claude.ai" });
      assert.deepEqual(names(result), ["proxy:ok", "tunnel:ok", "tls:fail"]);
      assert.match(result.error, /not for claude\.ai/);
    } finally {
      await close(proxy.server);
    }
  });

  it("rejects an invalid url without contacting anything", async () => {
    const result = await probeProxy("ftp://x", { host: HOST });
    assert.deepEqual(names(result), ["proxy:fail"]);
    assert.match(result.error, /unsupported/);
  });
});
