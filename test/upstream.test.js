import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { parseProxyUrl } from "../src/proxy-url.js";
import { connectViaProxy } from "../src/upstream.js";
import { close, listen, readOnce, startEcho, startHttpProxy, startSocksProxy } from "./helpers.js";

async function roundTrip(socket) {
  const reply = readOnce(socket);
  socket.resume();
  socket.write("hi");
  const text = await reply;
  socket.destroy();
  return text;
}

describe("connectViaProxy over HTTP CONNECT", () => {
  let echo;
  before(async () => {
    echo = await startEcho();
  });
  after(() => close(echo.server));

  it("opens a tunnel and asks the proxy for the host name", async () => {
    const proxy = await startHttpProxy({ targetPort: echo.port });
    try {
      const socket = await connectViaProxy(parseProxyUrl(`http://127.0.0.1:${proxy.port}`), "api.anthropic.com", 443);
      assert.equal(await roundTrip(socket), "echo:hi");
      assert.equal(proxy.requests[0].requestLine, "CONNECT api.anthropic.com:443 HTTP/1.1");
      assert.equal(proxy.requests[0].headers["proxy-authorization"], undefined);
    } finally {
      await close(proxy.server);
    }
  });

  it("sends basic credentials", async () => {
    const proxy = await startHttpProxy({ targetPort: echo.port, requireAuth: "alice:s3cret" });
    try {
      const socket = await connectViaProxy(parseProxyUrl(`http://alice:s3cret@127.0.0.1:${proxy.port}`), "claude.ai", 443);
      assert.equal(await roundTrip(socket), "echo:hi");
    } finally {
      await close(proxy.server);
    }
  });

  it("fails on a non-2xx answer", async () => {
    const proxy = await startHttpProxy({ targetPort: echo.port, requireAuth: "alice:s3cret" });
    try {
      await assert.rejects(
        connectViaProxy(parseProxyUrl(`http://127.0.0.1:${proxy.port}`), "claude.ai", 443),
        /proxy refused CONNECT claude\.ai:443: HTTP\/1\.1 407/
      );
    } finally {
      await close(proxy.server);
    }
  });

  it("fails when the proxy is unreachable", async () => {
    const unused = net.createServer();
    const port = await listen(unused);
    await close(unused);
    await assert.rejects(connectViaProxy(parseProxyUrl(`http://127.0.0.1:${port}`), "claude.ai", 443), /cannot reach proxy/);
  });

  it("times out when the proxy never answers", async () => {
    // resume() so the server reads the client's FIN; an unread socket never closes
    // and server.close() would wait forever.
    const silent = net.createServer((socket) => socket.on("error", () => {}).resume());
    const port = await listen(silent);
    try {
      await assert.rejects(
        connectViaProxy(parseProxyUrl(`http://127.0.0.1:${port}`), "claude.ai", 443, { timeoutMs: 200 }),
        /timed out waiting for the proxy/
      );
    } finally {
      await close(silent);
    }
  });

  it("fails when the proxy hangs up mid-handshake", async () => {
    const rude = net.createServer((socket) => socket.resume().end());
    const port = await listen(rude);
    try {
      await assert.rejects(connectViaProxy(parseProxyUrl(`http://127.0.0.1:${port}`), "claude.ai", 443), /closed the connection/);
    } finally {
      await close(rude);
    }
  });
});

describe("connectViaProxy over SOCKS5", () => {
  let echo;
  before(async () => {
    echo = await startEcho();
  });
  after(() => close(echo.server));

  it("sends the domain name for the proxy to resolve", async () => {
    const proxy = await startSocksProxy({ targetPort: echo.port });
    try {
      const socket = await connectViaProxy(parseProxyUrl(`socks5://127.0.0.1:${proxy.port}`), "api.anthropic.com", 443);
      assert.equal(await roundTrip(socket), "echo:hi");
      assert.deepEqual(proxy.requests[0], { atyp: 3, host: "api.anthropic.com", port: 443 });
    } finally {
      await close(proxy.server);
    }
  });

  it("authenticates with username and password", async () => {
    const proxy = await startSocksProxy({ targetPort: echo.port, credentials: "bob:pw" });
    try {
      const socket = await connectViaProxy(parseProxyUrl(`socks5://bob:pw@127.0.0.1:${proxy.port}`), "claude.ai", 443);
      assert.equal(await roundTrip(socket), "echo:hi");
    } finally {
      await close(proxy.server);
    }
  });

  it("fails on wrong credentials and on a missing auth method", async () => {
    const proxy = await startSocksProxy({ targetPort: echo.port, credentials: "bob:pw" });
    try {
      await assert.rejects(
        connectViaProxy(parseProxyUrl(`socks5://bob:nope@127.0.0.1:${proxy.port}`), "claude.ai", 443),
        /authentication failed/
      );
      await assert.rejects(
        connectViaProxy(parseProxyUrl(`socks5://127.0.0.1:${proxy.port}`), "claude.ai", 443),
        /none of the offered auth methods/
      );
    } finally {
      await close(proxy.server);
    }
  });

  it("reports the proxy's refusal reason", async () => {
    const proxy = await startSocksProxy({ targetPort: echo.port, reply: 0x05 });
    try {
      await assert.rejects(
        connectViaProxy(parseProxyUrl(`socks5://127.0.0.1:${proxy.port}`), "claude.ai", 443),
        /SOCKS5 proxy refused claude\.ai:443: connection refused/
      );
    } finally {
      await close(proxy.server);
    }
  });
});
