import net from "node:net";
import { parseProxyUrl, redactProxyUrl } from "./proxy-url.js";
import { extractSni, NEED_MORE } from "./sni.js";
import { connectViaProxy } from "./upstream.js";

const MAX_HELLO_BYTES = 64 * 1024;

export function log(level, message) {
  process.stdout.write(`${new Date().toISOString()} ${level.padEnd(5)} ${message}\n`);
}

/**
 * Accepts TLS connections, reads the SNI from the ClientHello and tunnels the raw
 * bytes through the configured proxy. TLS is never terminated: the client verifies
 * the real server's certificate end to end.
 *
 * The config is loaded per connection so `set-proxy` and host edits apply without
 * restarting the daemon.
 */
export function createRelayHandler({ loadConfig, connect = connectViaProxy, logger = log, helloTimeoutMs = 10_000, upstreamPort = 443 }) {
  return function handle(client) {
    client.setNoDelay(true);
    client.on("error", () => {});

    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      logger("warn", "client sent no complete TLS ClientHello in time; closed");
      client.destroy();
    }, helloTimeoutMs);
    client.once("close", () => clearTimeout(timer));

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const sni = buf.length > MAX_HELLO_BYTES ? null : extractSni(buf);
      if (sni === NEED_MORE) return;

      client.off("data", onData);
      client.pause();
      clearTimeout(timer);
      if (!sni) {
        logger("warn", "rejected a connection without a TLS server name");
        client.destroy();
        return;
      }
      tunnel(client, sni, buf).catch((error) => {
        logger("error", `${sni}: ${error.message}`);
        client.destroy();
      });
    };
    client.on("data", onData);
  };

  async function tunnel(client, host, hello) {
    const config = loadConfig();
    if (!config.proxy) throw new Error("no proxy configured (run: claude-auto-proxy set-proxy <url>)");
    // Anything that reaches the relay but is not ours to forward is dropped, so the
    // daemon is never a general-purpose tunnel for other local processes.
    if (!config.hosts.includes(host)) throw new Error("not in the host list; connection dropped");

    const upstream = await connect(parseProxyUrl(config.proxy), host, upstreamPort);
    upstream.on("error", (error) => logger("debug", `${host}: upstream ${error.message}`));
    if (client.destroyed) {
      upstream.destroy();
      return;
    }

    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.once("close", close);
    upstream.once("close", close);

    upstream.write(hello);
    client.pipe(upstream);
    upstream.pipe(client);
    logger("info", `${host} -> tunnel via ${redactProxyUrl(config.proxy)}`);
  }
}

// Bounds the damage of a proxy that loops back into the relay (one resolving names
// through this Mac's /etc/hosts): each loop iteration costs two sockets.
const MAX_CONNECTIONS = 512;

/**
 * Listens on every address in `addresses`. An address the system does not have
 * (IPv6 disabled) is skipped; any other failure — above all another program already
 * holding the port — is fatal, since clients resolving to that address would reach
 * the other program instead.
 */
export async function startRelay({ port = 443, addresses = ["127.0.0.1", "::1"], logger = log, ...handlerOptions }) {
  const handle = createRelayHandler({ logger, ...handlerOptions });
  const servers = [];
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  for (const address of addresses) {
    const server = net.createServer((client) => {
      track(client);
      handle(client);
    });
    server.maxConnections = MAX_CONNECTIONS;
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ port, host: address }, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      if (error.code === "EADDRNOTAVAIL") {
        logger("warn", `not listening on ${address}: address not available`);
        continue;
      }
      await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
      throw new Error(`cannot listen on ${address}:${port}: ${error.message}`);
    }
    server.on("error", (error) => logger("error", `listener ${address}: ${error.message}`));
    servers.push(server);
    logger("info", `listening on ${net.isIPv6(address) ? `[${address}]` : address}:${server.address().port}`);
  }
  if (servers.length === 0) throw new Error("no listen address is available");

  return {
    servers,
    // Open tunnels are cut rather than waited for: server.close() alone would keep a
    // stopping daemon alive until every Claude Code connection ends.
    close: () => {
      const closed = Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      for (const socket of sockets) socket.destroy();
      return closed;
    }
  };
}
