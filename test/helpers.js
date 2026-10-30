import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

const ROOT = path.resolve(import.meta.dirname, "..", ".tmp");

/** A fresh scratch directory inside the repo (gitignored), removed by the caller. */
export function scratchDir() {
  fs.mkdirSync(ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(ROOT, "t-"));
}

export function hasOpenssl() {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Self-signed certificate for `host`, generated per run so no key is ever committed. */
export function makeCertificate(dir, host) {
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1",
      "-subj", `/CN=${host}`, "-addext", `subjectAltName=DNS:${host}`],
    { stdio: "ignore" }
  );
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

export function listen(server, host = "127.0.0.1") {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

export function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** TLS server that answers every line with "pong:<line>". */
export async function startTlsOrigin({ key, cert }) {
  const server = tls.createServer({ key, cert }, (socket) => {
    socket.on("data", (data) => socket.write(`pong:${data}`));
    socket.on("error", () => {});
  });
  return { server, port: await listen(server) };
}

/** Plain TCP echo server. */
export async function startEcho() {
  const server = net.createServer((socket) => {
    socket.on("data", (data) => socket.write(`echo:${data}`));
    socket.on("error", () => {});
  });
  return { server, port: await listen(server) };
}

/**
 * Fake HTTP CONNECT proxy. Every CONNECT is sent to `targetPort` on localhost; the
 * requested authority and headers are recorded so tests can assert on them.
 */
export async function startHttpProxy({ targetPort, status = 200, requireAuth = null }) {
  const requests = [];
  const server = net.createServer((client) => {
    client.on("error", () => {});
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.off("data", onData);
      const [requestLine, ...headerLines] = buf.slice(0, end).split("\r\n");
      const headers = Object.fromEntries(headerLines.map((line) => {
        const i = line.indexOf(":");
        return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()];
      }));
      requests.push({ requestLine, headers });

      if (requireAuth && headers["proxy-authorization"] !== `Basic ${Buffer.from(requireAuth).toString("base64")}`) {
        client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        return;
      }
      if (status !== 200) {
        client.end(`HTTP/1.1 ${status} Nope\r\n\r\n`);
        return;
      }
      const upstream = net.connect(targetPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
        const rest = buf.slice(end + 4);
        if (rest) upstream.write(Buffer.from(rest, "latin1"));
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
  });
  return { server, port: await listen(server), requests };
}

/** Fake SOCKS5 proxy (no auth, or username/password). Records the requested domain. */
export async function startSocksProxy({ targetPort, credentials = null, reply = 0x00 }) {
  const requests = [];
  const server = net.createServer((client) => {
    client.on("error", () => {});
    let buf = Buffer.alloc(0);
    let stage = "greeting";
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (stage === "greeting") {
          if (buf.length < 2 || buf.length < 2 + buf[1]) return;
          const methods = [...buf.subarray(2, 2 + buf[1])];
          buf = buf.subarray(2 + buf[1]);
          const wanted = credentials ? 0x02 : 0x00;
          if (!methods.includes(wanted)) {
            client.end(Buffer.from([0x05, 0xff]));
            return;
          }
          client.write(Buffer.from([0x05, wanted]));
          stage = credentials ? "auth" : "request";
        } else if (stage === "auth") {
          if (buf.length < 2) return;
          const ulen = buf[1];
          if (buf.length < 3 + ulen) return;
          const plen = buf[2 + ulen];
          if (buf.length < 3 + ulen + plen) return;
          const user = buf.subarray(2, 2 + ulen).toString();
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
          buf = buf.subarray(3 + ulen + plen);
          const ok = `${user}:${pass}` === credentials;
          client.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          if (!ok) {
            client.end();
            return;
          }
          stage = "request";
        } else if (stage === "request") {
          if (buf.length < 5) return;
          const nameLength = buf[4];
          if (buf.length < 5 + nameLength + 2) return;
          const host = buf.subarray(5, 5 + nameLength).toString();
          const port = buf.readUInt16BE(5 + nameLength);
          requests.push({ atyp: buf[3], host, port });
          const rest = buf.subarray(5 + nameLength + 2);
          client.off("data", onData);
          if (reply !== 0x00) {
            client.end(Buffer.from([0x05, reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return;
          }
          const upstream = net.connect(targetPort, "127.0.0.1", () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
            if (rest.length) upstream.write(rest);
            client.pipe(upstream);
            upstream.pipe(client);
          });
          upstream.on("error", () => client.destroy());
          return;
        }
      }
    };
    client.on("data", onData);
  });
  return { server, port: await listen(server), requests };
}

/** Captures the first bytes a TLS client sends — a real ClientHello. */
export async function captureClientHello(options) {
  let resolveHello;
  const hello = new Promise((resolve) => {
    resolveHello = resolve;
  });
  const server = net.createServer((socket) => {
    socket.once("data", (data) => {
      resolveHello(data);
      socket.destroy();
    });
  });
  const port = await listen(server);
  const client = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, ...options });
  client.on("error", () => {});
  const data = await hello;
  client.destroy();
  await close(server);
  return data;
}

export function readOnce(socket) {
  return new Promise((resolve, reject) => {
    socket.once("data", (data) => resolve(data.toString()));
    socket.once("error", reject);
  });
}
