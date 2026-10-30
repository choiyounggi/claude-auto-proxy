import net from "node:net";
import tls from "node:tls";

const MAX_HTTP_RESPONSE_HEAD = 16 * 1024;

const SOCKS_REPLIES = {
  1: "general SOCKS server failure",
  2: "connection not allowed by ruleset",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported"
};

// Returns the socket immediately so a caller that gives up waiting can still destroy it.
function openSocket(proxy) {
  const socket =
    proxy.protocol === "https"
      ? tls.connect({ host: proxy.host, port: proxy.port, servername: net.isIP(proxy.host) ? undefined : proxy.host })
      : net.connect({ host: proxy.host, port: proxy.port });
  const event = proxy.protocol === "https" ? "secureConnect" : "connect";
  const ready = new Promise((resolve, reject) => {
    const onError = (error) => reject(new Error(`cannot reach proxy ${proxy.host}:${proxy.port}: ${error.message}`));
    socket.once("error", onError);
    socket.once(event, () => {
      socket.off("error", onError);
      resolve();
    });
  });
  return { socket, ready };
}

// Sends `payload` and reads until `parse` recognizes a complete reply. Bytes past the
// reply are pushed back so the tunnel sees them, and the socket is left paused for
// the caller to pipe.
function exchange(socket, payload, parse) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.pause();
    };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let result;
      try {
        result = parse(buf);
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (!result) return;
      cleanup();
      const rest = buf.subarray(result.consumed);
      if (rest.length > 0) socket.unshift(rest);
      resolve(result.value);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("proxy closed the connection during the handshake"));
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    // A socket paused by a previous exchange does not resume when a listener is added.
    socket.resume();
    if (payload) socket.write(payload);
  });
}

async function httpConnect(socket, proxy, host, port) {
  const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
  if (proxy.username !== null) {
    const token = Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64");
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  const request = `${lines.join("\r\n")}\r\n\r\n`;

  await exchange(socket, request, (buf) => {
    const end = buf.indexOf("\r\n\r\n");
    if (end === -1) {
      if (buf.length > MAX_HTTP_RESPONSE_HEAD) throw new Error("proxy sent an oversized CONNECT response");
      return null;
    }
    const statusLine = buf.subarray(0, buf.indexOf("\r\n")).toString("latin1");
    const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
    if (!match) throw new Error(`proxy sent a malformed CONNECT response: ${statusLine.slice(0, 80)}`);
    const status = Number(match[1]);
    if (status < 200 || status > 299) {
      throw new Error(`proxy refused CONNECT ${host}:${port}: ${statusLine.slice(0, 80)}`);
    }
    return { consumed: end + 4, value: status };
  });
}

async function socks5Connect(socket, proxy, host, port) {
  const hasCredentials = proxy.username !== null;
  const methods = hasCredentials ? [0x00, 0x02] : [0x00];

  const method = await exchange(socket, Buffer.from([0x05, methods.length, ...methods]), (buf) => {
    if (buf.length < 2) return null;
    if (buf[0] !== 0x05) throw new Error("proxy is not a SOCKS5 server");
    if (buf[1] === 0xff) throw new Error("SOCKS5 proxy accepted none of the offered auth methods");
    return { consumed: 2, value: buf[1] };
  });

  if (method === 0x02) {
    if (!hasCredentials) throw new Error("SOCKS5 proxy requires a username and password");
    const user = Buffer.from(proxy.username);
    const pass = Buffer.from(proxy.password ?? "");
    if (user.length > 255 || pass.length > 255) throw new Error("SOCKS5 credentials must be at most 255 bytes");
    const auth = Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]);
    await exchange(socket, auth, (buf) => {
      if (buf.length < 2) return null;
      if (buf[1] !== 0x00) throw new Error("SOCKS5 authentication failed");
      return { consumed: 2, value: true };
    });
  } else if (method !== 0x00) {
    throw new Error(`SOCKS5 proxy chose an unsupported auth method (${method})`);
  }

  // Address type 3 (domain name): the proxy resolves the host. Resolving it here would
  // return 127.0.0.1 from our own /etc/hosts entry and loop back into the relay.
  const name = Buffer.from(host);
  if (name.length > 255) throw new Error("host name too long for SOCKS5");
  const request = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
    name,
    Buffer.from([port >> 8, port & 0xff])
  ]);

  await exchange(socket, request, (buf) => {
    if (buf.length < 5) return null;
    if (buf[0] !== 0x05) throw new Error("malformed SOCKS5 reply");
    if (buf[1] !== 0x00) {
      throw new Error(`SOCKS5 proxy refused ${host}:${port}: ${SOCKS_REPLIES[buf[1]] ?? `code ${buf[1]}`}`);
    }
    const addressType = buf[3];
    const addressLength =
      addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : addressType === 0x03 ? 1 + buf[4] : null;
    if (addressLength === null) throw new Error(`malformed SOCKS5 reply (address type ${addressType})`);
    const total = 4 + addressLength + 2;
    if (buf.length < total) return null;
    return { consumed: total, value: true };
  });
}

/**
 * Opens a raw TCP tunnel to host:port through the proxy and resolves with the socket,
 * paused and ready to pipe. The proxy resolves the host name, never this machine.
 * `onStage` hears "connected" once the proxy accepts TCP and "tunnel" once it opened
 * the target, so a caller can say which step failed.
 */
export async function connectViaProxy(proxy, host, port, { timeoutMs = 10_000, onStage = () => {} } = {}) {
  const { socket, ready } = openSocket(proxy);
  try {
    await withTimeout(ready, timeoutMs, `timed out connecting to proxy ${proxy.host}:${proxy.port}`);
    onStage("connected");
    const handshake = proxy.protocol === "socks5" ? socks5Connect(socket, proxy, host, port) : httpConnect(socket, proxy, host, port);
    await withTimeout(handshake, timeoutMs, `timed out waiting for the proxy to open ${host}:${port}`);
    onStage("tunnel");
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
