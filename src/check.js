import tls from "node:tls";
import { parseProxyUrl } from "./proxy-url.js";
import { connectViaProxy } from "./upstream.js";

/**
 * Opens a TLS connection to `address:port` asking for `host`, the way Claude Code
 * would once /etc/hosts points `host` at the relay. A completed handshake proves the
 * whole path: relay, proxy and the real server.
 *
 * A certificate for a different name is a failure: something other than the relay
 * answered (another program holding port 443, say), and Claude Code would refuse it.
 * `trusted` only reports whether Node's bundled CAs accept the chain — a proxy that
 * inspects TLS issues a matching certificate from its own CA, which Claude Code may
 * accept through the system keychain, so an untrusted chain is a warning.
 */
export function checkTunnel({ host = "api.anthropic.com", address = "127.0.0.1", port = 443, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const socket = tls.connect({ host: address, port, servername: host, rejectUnauthorized: false });
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: `no TLS handshake within ${timeoutMs / 1000}s` }));
    socket.once("error", (error) => finish({ ok: false, error: error.message }));
    socket.once("secureConnect", () => {
      const identityError = tls.checkServerIdentity(host, socket.getPeerCertificate());
      if (identityError) {
        finish({ ok: false, error: `the certificate is not for ${host}: ${identityError.message}` });
        return;
      }
      finish({
        ok: true,
        trusted: socket.authorized,
        detail: socket.authorizationError ? String(socket.authorizationError) : null
      });
    });
  });
}

export const PROBE_STAGES = ["proxy", "tunnel", "tls"];

/**
 * Talks to the proxy directly, without the relay or /etc/hosts, in three round trips:
 * reach the proxy, have it open `host:443`, then complete a TLS handshake with the
 * real server through that tunnel. Used to decide whether a proxy may be registered.
 *
 * Resolves with `{ ok, stages, trusted, error }`; `stages` lists every step reached,
 * each with `ok` and elapsed `ms`, so the failing step is the last one.
 */
export async function probeProxy(proxyUrl, { host = "api.anthropic.com", timeoutMs = 10_000, connect = connectViaProxy } = {}) {
  const stages = [];
  let mark = Date.now();
  const pass = (name) => {
    const now = Date.now();
    stages.push({ name, ok: true, ms: now - mark });
    mark = now;
  };
  const fail = (name, error) => {
    stages.push({ name, ok: false, ms: Date.now() - mark, error });
    return { ok: false, stages, trusted: null, error };
  };

  let proxy;
  try {
    proxy = parseProxyUrl(proxyUrl);
  } catch (error) {
    return fail("proxy", error.message);
  }

  let socket;
  try {
    socket = await connect(proxy, host, 443, {
      timeoutMs,
      onStage: (stage) => pass(stage === "connected" ? "proxy" : "tunnel")
    });
  } catch (error) {
    return fail(stages.length === 0 ? "proxy" : "tunnel", error.message);
  }

  const handshake = await new Promise((resolve) => {
    const secure = tls.connect({ socket, servername: host, rejectUnauthorized: false });
    const finish = (result) => {
      secure.destroy();
      socket.destroy();
      resolve(result);
    };
    secure.setTimeout(timeoutMs, () => finish({ error: `no TLS handshake with ${host} within ${timeoutMs / 1000}s` }));
    secure.once("error", (error) => finish({ error: `TLS handshake with ${host} failed: ${error.message}` }));
    secure.once("secureConnect", () => {
      const identityError = tls.checkServerIdentity(host, secure.getPeerCertificate());
      finish(identityError ? { error: `the certificate is not for ${host}: ${identityError.message}` } : { trusted: secure.authorized });
    });
  });

  if (handshake.error) return fail("tls", handshake.error);
  pass("tls");
  return { ok: true, stages, trusted: handshake.trusted, error: null };
}
