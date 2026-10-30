import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseProxyUrl } from "./proxy-url.js";

// Hosts Claude Code uses for API calls and sign-in. Everything else it contacts
// (plugin downloads, npm, GitHub, telemetry) is left alone unless added by hand.
export const DEFAULT_HOSTS = Object.freeze([
  "api.anthropic.com",
  "mcp-proxy.anthropic.com",
  "claude.ai",
  "claude.com",
  "platform.claude.com"
]);

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// The daemon binds port 443 as root, then runs as this account. It reads the config
// through the account's group, so the proxy password is never world-readable.
export const DAEMON_USER = "nobody";

export function daemonIds(run = execFileSync) {
  const id = (flag) => Number(String(run("/usr/bin/id", [flag, DAEMON_USER], { encoding: "utf8" })).trim());
  return { uid: id("-u"), gid: id("-g") };
}

export function configDir() {
  return process.env.CLAUDE_AUTO_PROXY_HOME || "/Library/Application Support/claude-auto-proxy";
}

export function configPath() {
  return path.join(configDir(), "config.json");
}

export function normalizeHost(host) {
  const value = String(host ?? "").trim().toLowerCase();
  if (!HOSTNAME.test(value)) throw new Error(`invalid host name: ${host}`);
  return value;
}

export function validateConfig(config) {
  const hosts = [...new Set((config.hosts ?? []).map(normalizeHost))];
  if (hosts.length === 0) throw new Error("the host list is empty");

  const proxy = config.proxy ?? null;
  if (proxy !== null) {
    const { host } = parseProxyUrl(proxy);
    // The proxy itself must resolve normally; listing it would point it at the relay.
    if (hosts.includes(host.toLowerCase())) {
      throw new Error(`the proxy host ${host} cannot also be in the host list`);
    }
  }
  return { proxy, hosts };
}

/** Missing file means "not configured yet": no proxy, default hosts. Read errors propagate (EACCES etc.). */
export function loadConfig({ fsImpl = fs } = {}) {
  const file = configPath();
  if (!fsImpl.existsSync(file)) return { proxy: null, hosts: [...DEFAULT_HOSTS] };
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${file} is not valid JSON`);
    throw error;
  }
  return validateConfig({ proxy: parsed.proxy ?? null, hosts: parsed.hosts ?? DEFAULT_HOSTS });
}

// The proxy URL may carry credentials: root owns the file and only the daemon's
// group may read it (0640). Written through a temp file and rename so the daemon,
// which reads it on every connection, never sees half a file.
export function saveConfig(config, { fsImpl = fs, ids = null } = {}) {
  const valid = validateConfig(config);
  const dir = configDir();
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const file = configPath();
  const temp = `${file}.tmp`;
  fsImpl.writeFileSync(temp, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  fsImpl.chmodSync(temp, 0o600);
  const owner = ids ?? (process.getuid() === 0 ? daemonIds() : null);
  if (owner) {
    fsImpl.chownSync(temp, 0, owner.gid);
    fsImpl.chmodSync(temp, 0o640);
  }
  fsImpl.renameSync(temp, file);
  return valid;
}
