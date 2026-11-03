// Router mode: Claude Code talks to a claude-proxy-router over plain HTTP instead of
// to api.anthropic.com. Turning it on writes ANTHROPIC_BASE_URL and
// ANTHROPIC_AUTH_TOKEN into the `env` of every Claude Code settings file on this Mac;
// turning it off puts back whatever those two keys held before.
// The router side's contract is PROTOCOL.md in claude-proxy-router.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ENV_URL = "ANTHROPIC_BASE_URL";
export const ENV_KEY = "ANTHROPIC_AUTH_TOKEN";
export const PROTOCOL = 1;
export const DEFAULT_PORT = "18787";
// Enough to recognise values written before a few key rotations; older ones are dropped.
const ROUTED_HISTORY = 5;

export function routerHome() {
  return process.env.CLAUDE_AUTO_PROXY_USER_HOME || path.join(os.homedir(), "Library/Application Support/claude-auto-proxy");
}

export function routerConfigPath() {
  return path.join(routerHome(), "router.json");
}

/** `host[:port]`, `http://host:port` or `https://host:port`; no path, query or credentials. */
export function parseRouterUrl(input) {
  const raw = String(input ?? "").trim();
  if (raw === "") throw new Error("the router address is empty");
  // A key pasted into the address prompt must not be echoed back as an address.
  if (/^cpr_/i.test(raw)) throw new Error("that looks like the router key, not its address");
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url;
  try {
    url = new URL(hasScheme ? raw : `http://${raw}`);
  } catch {
    throw new Error("the router address is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("the router address must be http:// or https://");
  if (url.username || url.password) throw new Error("put the router key in the key prompt, not in the address");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("the router address takes no path — Claude Code adds /v1/... itself");
  }
  if (!hasScheme && url.port === "") url.port = DEFAULT_PORT;
  return `${url.protocol}//${url.host}`;
}

/** Header-safe: printable ASCII without spaces. */
export function validRouterKey(key) {
  return /^[\x21-\x7e]+$/.test(String(key ?? ""));
}

export function maskKey(key) {
  const value = String(key ?? "");
  return value.length <= 8 ? "***" : `${value.slice(0, 4)}***${value.slice(-2)}`;
}

/**
 * The onboarding ping-pong from PROTOCOL.md. Registers only on 200 with
 * `pong: true`, `service: "claude-proxy-router"` and `protocol: 1`.
 * Returns {ok, reason: "unreachable" | "bad_key" | "not_router" | null, ms, info}.
 */
export async function pingRouter(url, key, { timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  let res;
  try {
    res = await fetchImpl(`${url}/_router/ping`, {
      headers: { "x-router-key": key },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual"
    });
  } catch (error) {
    return { ok: false, reason: "unreachable", ms: elapsed(), error: error.cause?.code ?? error.name ?? "error", info: null };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON: something other than the router answered.
  }
  const fromRouter = body?.service === "claude-proxy-router";
  if (res.status === 401 && fromRouter) return { ok: false, reason: "bad_key", ms: elapsed(), info: null };
  if (res.status === 200 && fromRouter && body.pong === true && body.protocol === PROTOCOL) {
    return { ok: true, reason: null, ms: elapsed(), info: body };
  }
  return { ok: false, reason: "not_router", ms: elapsed(), status: res.status, info: null };
}

/**
 * Claude Code config directories on this Mac: $CLAUDE_CONFIG_DIR, ~/.claude, and every
 * Orca profile (each runs Claude Code with its own CLAUDE_CONFIG_DIR, so each has its
 * own settings.json). Existing directories only.
 */
export function claudeConfigDirs({ home = os.homedir(), env = process.env, fsImpl = fs } = {}) {
  const candidates = [];
  if (env.CLAUDE_CONFIG_DIR) candidates.push(path.resolve(env.CLAUDE_CONFIG_DIR));
  candidates.push(path.join(home, ".claude"));
  const profiles = path.join(home, "Library/Application Support/orca/claude-profiles");
  let names = [];
  try {
    names = fsImpl.readdirSync(profiles).sort();
  } catch {
    // No Orca on this Mac.
  }
  for (const name of names) {
    if (fsImpl.existsSync(path.join(profiles, name, "profile.json"))) candidates.push(path.join(profiles, name, "home"));
  }
  return candidates.filter((dir) => {
    try {
      return fsImpl.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * The real path of a directory's settings.json. Writing through the real path keeps a
 * symlinked settings.json (dotfiles) a symlink, and two directories sharing one file
 * resolve to one target.
 */
export function resolveSettingsFile(dir, { fsImpl = fs } = {}) {
  const file = path.join(dir, "settings.json");
  try {
    return fsImpl.realpathSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return path.join(fsImpl.realpathSync(dir), "settings.json");
  }
}

/** Unique real settings files across all config directories. */
export function settingsFiles(options = {}) {
  return [...new Set(claudeConfigDirs(options).map((dir) => resolveSettingsFile(dir, options)))];
}

/** A missing file is an empty object. Anything that is not a JSON object is refused, never overwritten. */
export function readSettings(file, { fsImpl = fs } = {}) {
  let text;
  try {
    text = fsImpl.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  if (text.trim() === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON; fix it first (left untouched)`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object (left untouched)`);
  }
  return parsed;
}

export function fileMode(file, { fsImpl = fs } = {}) {
  try {
    return fsImpl.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

// Written through a temp file and rename: Claude Code may read it at any moment.
// The temp file can hold the router key, so it never outlives a failed write.
export function writeSettings(file, settings, { mode = 0o600, fsImpl = fs } = {}) {
  const temp = `${file}.claude-auto-proxy.tmp`;
  try {
    fsImpl.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    fsImpl.chmodSync(temp, mode);
    fsImpl.renameSync(temp, file);
  } catch (error) {
    fsImpl.rmSync(temp, { force: true });
    throw error;
  }
}

function wroteUrl(entry, url) {
  return url !== undefined && (entry?.routed ?? []).some((value) => value.url === url);
}

function wroteKey(entry, key) {
  return key !== undefined && (entry?.routed ?? []).some((value) => value.key === key);
}

function withValue(env, name, value) {
  if (value === null || value === undefined) delete env[name];
  else env[name] = value;
}

function withEnv(settings, env) {
  const next = { ...settings, env };
  if (Object.keys(env).length === 0) delete next.env;
  return next;
}

/**
 * Settings with the router switched on, and the restore entry for the file:
 * `{ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, mode, routed: [{url, key}]}`.
 * Values this tool wrote earlier are never recorded as "what was there before" —
 * neither when re-running `on` nor when an earlier `on` died before saving its entry.
 */
export function routeSettings(settings, router, entry, mode = null) {
  const env = { ...(settings.env ?? {}) };
  let base;
  if (entry && wroteUrl(entry, env[ENV_URL])) base = entry;
  else {
    const ours = env[ENV_URL] === router.url || env[ENV_KEY] === router.key || wroteUrl(entry, env[ENV_URL]);
    base = {
      [ENV_URL]: ours ? null : env[ENV_URL] ?? null,
      [ENV_KEY]: ours || wroteKey(entry, env[ENV_KEY]) ? null : env[ENV_KEY] ?? null,
      mode,
      routed: entry?.routed ?? []
    };
  }
  const changed = env[ENV_URL] !== router.url || env[ENV_KEY] !== router.key;
  env[ENV_URL] = router.url;
  env[ENV_KEY] = router.key;
  const routed = [...base.routed.filter((value) => value.url !== router.url || value.key !== router.key), { url: router.url, key: router.key }];
  return { settings: { ...settings, env }, entry: { ...base, routed: routed.slice(-ROUTED_HISTORY) }, changed };
}

/**
 * Settings with the router switched off. A base url changed by hand since `on` is left
 * alone, but a router key still in the file is taken back out — otherwise Claude Code
 * would send it to that other server.
 */
export function unrouteSettings(settings, entry) {
  const env = { ...(settings.env ?? {}) };
  if (wroteUrl(entry, env[ENV_URL])) {
    withValue(env, ENV_URL, entry[ENV_URL]);
    withValue(env, ENV_KEY, entry[ENV_KEY]);
    return { settings: withEnv(settings, env), changed: true, foreign: false };
  }
  const foreign = env[ENV_URL] !== undefined;
  if (wroteKey(entry, env[ENV_KEY])) {
    withValue(env, ENV_KEY, entry[ENV_KEY]);
    return { settings: withEnv(settings, env), changed: true, foreign };
  }
  return { settings, changed: false, foreign };
}

/** "on" (current router), "stale" (an older router url or key this tool wrote), or "off". */
export function routeState(settings, router, entry) {
  const env = settings.env ?? {};
  if (env[ENV_URL] === router.url && env[ENV_KEY] === router.key) return "on";
  return wroteUrl(entry, env[ENV_URL]) ? "stale" : "off";
}

/** Settings in this file that would send something else than the router key. */
export function conflicts(settings) {
  const found = [];
  if (settings.env?.ANTHROPIC_API_KEY) found.push("env.ANTHROPIC_API_KEY");
  if (settings.apiKeyHelper) found.push("apiKeyHelper");
  return found;
}

export const KEYCHAIN_SERVICE = "Claude Code-credentials";
const SECURITY_BIN = "/usr/bin/security";

const sha8 = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);

/**
 * The Keychain item holding a config directory's claude.ai login: the bare name for
 * ~/.claude, otherwise the name plus the first 8 hex of sha256 of the directory string.
 * $CLAUDE_CONFIG_DIR is hashed exactly as written — the same rule claude-proxy-router's
 * keychainServiceFor uses to read these items.
 */
export function keychainServiceFor(dir, { home = os.homedir(), env = process.env } = {}) {
  const raw = env.CLAUDE_CONFIG_DIR;
  if (raw && path.resolve(raw) === dir) return `${KEYCHAIN_SERVICE}-${sha8(raw)}`;
  if (dir === path.join(home, ".claude")) return KEYCHAIN_SERVICE;
  return `${KEYCHAIN_SERVICE}-${sha8(dir)}`;
}

/** Exit status of `security find-generic-password -s <service>` (0 found, 44 not found), or null if it could not run. -w is never passed, so the secret is never read. */
export function keychainLookup(service) {
  const result = spawnSync(SECURITY_BIN, ["find-generic-password", "-s", service], { stdio: "ignore", timeout: 2000 });
  return result.error ? null : result.status;
}

function readJsonFile(file, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Whether a config directory still keeps a claude.ai login: "file" (.credentials.json,
 * Claude Code's fallback store, holds `claudeAiOauth`), "keychain" (the directory's
 * .claude.json names an `oauthAccount` and its Keychain item exists), "unchecked"
 * (an account is named but the Keychain could not be asked) or null. The credential
 * store can hold only MCP tokens, so an item existing is not enough on its own.
 * With router mode on, Claude Code still sends a few account requests (startup
 * bootstrap, fast-mode check) to api.anthropic.com with that login, not through the router.
 */
export function claudeLogin(dir, { home = os.homedir(), env = process.env, fsImpl = fs, lookup = keychainLookup } = {}) {
  if (readJsonFile(path.join(dir, ".credentials.json"), fsImpl)?.claudeAiOauth) return "file";
  const isDefault = dir === path.join(home, ".claude");
  // ~/.claude keeps its .claude.json in the home directory unless CLAUDE_CONFIG_DIR points at it.
  const accountFiles = isDefault ? [path.join(home, ".claude.json"), path.join(dir, ".claude.json")] : [path.join(dir, ".claude.json")];
  if (!accountFiles.some((file) => readJsonFile(file, fsImpl)?.oauthAccount)) return null;
  // With CLAUDE_CONFIG_DIR=~/.claude, sessions started with and without it use different items.
  const services = [...new Set([keychainServiceFor(dir, { home, env }), ...(isDefault ? [KEYCHAIN_SERVICE] : [])])];
  let unknown = false;
  for (const service of services) {
    const status = lookup(service);
    if (status === 0) return "keychain";
    if (status !== 44) unknown = true;
  }
  return unknown ? "unchecked" : null;
}

/** settings.local.json overrides settings.json, so router keys set there win over ours. */
export function localOverrides(dir, { fsImpl = fs } = {}) {
  let local;
  try {
    local = readSettings(path.join(dir, "settings.local.json"), { fsImpl });
  } catch {
    return ["settings.local.json (unreadable)"];
  }
  const found = [ENV_URL, ENV_KEY, "ANTHROPIC_API_KEY"].filter((name) => local.env?.[name] !== undefined).map((name) => `env.${name}`);
  if (local.apiKeyHelper) found.push("apiKeyHelper");
  return found.map((name) => `settings.local.json ${name}`);
}

// The first router-mode build kept a single `routedUrl` per file.
function normalizeEntry(entry, key) {
  if (Array.isArray(entry?.routed)) return entry;
  const { routedUrl, ...rest } = entry ?? {};
  return { mode: null, ...rest, routed: routedUrl ? [{ url: routedUrl, key }] : [] };
}

/** {url, key, restore: {<real settings file>: entry}} or null when no router is registered. */
export function loadRouter({ fsImpl = fs } = {}) {
  const file = routerConfigPath();
  if (!fsImpl.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (typeof parsed?.url !== "string" || typeof parsed?.key !== "string" || parsed.key === "") {
    throw new Error(`${file} has no router url and key; run: claude-auto-proxy router onboard`);
  }
  const restore = {};
  for (const [name, entry] of Object.entries(parsed.restore ?? {})) restore[name] = normalizeEntry(entry, parsed.key);
  return { url: parseRouterUrl(parsed.url), key: parsed.key, restore };
}

export function saveRouter(router, { fsImpl = fs } = {}) {
  const dir = routerHome();
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = routerConfigPath();
  const temp = `${file}.tmp`;
  try {
    fsImpl.writeFileSync(temp, `${JSON.stringify(router, null, 2)}\n`, { mode: 0o600 });
    fsImpl.chmodSync(temp, 0o600);
    fsImpl.renameSync(temp, file);
  } catch (error) {
    fsImpl.rmSync(temp, { force: true });
    throw error;
  }
}
