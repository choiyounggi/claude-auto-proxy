import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { checkTunnel, probeProxy } from "./check.js";
import { configDir, daemonIds, DAEMON_USER, DEFAULT_HOSTS, loadConfig, normalizeHost, saveConfig } from "./config.js";
import { applyBlock, blockHosts, flushDns, hasBlock, readHosts, stripBlock, writeHosts } from "./hosts.js";
import {
  APP_DIR,
  APP_SCRIPT,
  install,
  installApp,
  installedVersion,
  isLoaded,
  isRootOwned,
  isVersionManagedPath,
  LABEL,
  LOG_PATH,
  stablePath,
  uninstall
} from "./launchd.js";
import { normalizeProxyInput, redactProxyUrl } from "./proxy-url.js";
import { log, startRelay } from "./relay.js";
import {
  claudeConfigDirs,
  claudeLogin,
  conflicts,
  fetchRouterStatus,
  fileMode,
  formatAccounts,
  keychainLookup,
  loadRouter,
  localOverrides,
  maskKey,
  parseRouterUrl,
  pingRouter,
  readSettings,
  resolveSettingsFile,
  routeSettings,
  routeState,
  saveRouter,
  unrouteSettings,
  validRouterKey,
  writeSettings
} from "./router.js";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, "package.json"), "utf8")).version;

const USAGE = `claude-auto-proxy ${VERSION} — route Claude Code traffic through a proxy (macOS)

Usage:
  claude-auto-proxy onboard [url] [--on] guided setup: checks the proxy, registers it, offers to turn on
  claude-auto-proxy set-proxy <url>      check and register a proxy: http://[user:pass@]host:port,
                                         https://…, socks5://host:port (bare host:port means http)
  claude-auto-proxy on                   start routing (installs the daemon on first use)
  claude-auto-proxy off                  stop routing; Claude Code connects directly again
  claude-auto-proxy status               show mode, daemon and tunnel health
  claude-auto-proxy hosts                list routed hosts
  claude-auto-proxy hosts add <host>     route another host
  claude-auto-proxy hosts remove <host>  stop routing a host
  claude-auto-proxy hosts reset          back to the default host list
  claude-auto-proxy install              (re)install the daemon, e.g. after changing Node versions
  claude-auto-proxy uninstall [--purge]  remove the daemon (and with --purge, the config)

Router mode (a claude-proxy-router answering plain HTTP, e.g. over Tailscale):
  claude-auto-proxy router onboard [url] [--on]
                                         ping-pong the router with its key, register it
                                         (without a terminal, the key is read from stdin)
  claude-auto-proxy router on            point Claude Code's settings at the router
  claude-auto-proxy router off           restore Claude Code's settings
  claude-auto-proxy router status        show the router, each account's usage and which settings use it;
                                         warns about a claude.ai login left in a routed config directory

Commands that change the system ask for your password through sudo.
Router commands only touch your own files and run without sudo.
`;

class UsageError extends Error {}

function out(line = "") {
  process.stdout.write(`${line}\n`);
}

function requireMac() {
  if (process.platform !== "darwin") throw new Error("claude-auto-proxy only supports macOS");
}

// Re-runs this command under sudo with absolute paths. `sudo claude-auto-proxy`
// would fail for nvm and Homebrew installs, since sudo's secure_path has neither.
function escalate(argv) {
  if (process.getuid() === 0) return null;
  const nodePath = stablePath(process.execPath);
  const scriptPath = stablePath(path.resolve(process.argv[1]));
  const result = spawnSync("/usr/bin/sudo", ["--", nodePath, scriptPath, ...argv], { stdio: "inherit" });
  return result.status ?? 1;
}

function waitForPort(port, address, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ port, host: address });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

function describeTunnel(result) {
  if (!result.ok) return `FAILED — ${result.error}`;
  return result.trusted
    ? "ok (certificate trusted)"
    : `ok, but Node does not trust the certificate chain (${result.detail}) — expected behind a TLS-inspecting proxy`;
}

function routingOn() {
  return hasBlock(readHosts());
}

function setHostsBlock(hosts) {
  const text = readHosts();
  writeHosts(hosts ? applyBlock(text, hosts) : stripBlock(text));
  flushDns();
}

// Probes the path Claude Code will actually take: the host name resolved through
// /etc/hosts. A proxy that resolves names on this Mac loops back into the relay,
// which only shows once the hosts block is in place, so this runs after applying it.
async function verifyRouting(hosts) {
  return checkTunnel({ host: hosts[0], address: hosts[0] });
}

function ensureDaemon({ force = false } = {}) {
  if (!force && isLoaded() && installedVersion() === VERSION) return;

  const nodePath = stablePath(process.execPath);
  if (isVersionManagedPath(nodePath)) {
    out(`warning: the daemon will run ${nodePath}.`);
    out("         Removing that Node version stops it; run `claude-auto-proxy install` after switching.");
  }
  if (!isRootOwned(nodePath)) {
    out(`note: ${nodePath} is writable without root, and the daemon starts as root before`);
    out(`      dropping to "${DAEMON_USER}". See "Security" in the README.`);
  }
  installApp(SOURCE_ROOT);
  install({ nodePath, scriptPath: APP_SCRIPT });
  out(`daemon installed (${LABEL}, version ${VERSION})`);
}

async function cmdOn() {
  const config = loadConfig();
  if (!config.proxy) throw new Error("no proxy configured yet — run: claude-auto-proxy set-proxy <url>");

  ensureDaemon();
  if (!(await waitForPort(443, "127.0.0.1", 5000))) {
    throw new Error(`the daemon is not listening on 127.0.0.1:443 — see ${LOG_PATH}`);
  }

  // Probe through the relay before touching /etc/hosts: switching on a broken path
  // would cut Claude Code off entirely.
  const before = await checkTunnel({ host: config.hosts[0] });
  if (!before.ok) throw new Error(`tunnel check failed, routing left off: ${before.error}`);

  const wasOn = routingOn();
  setHostsBlock(config.hosts);
  const after = await verifyRouting(config.hosts);
  if (!after.ok) {
    if (!wasOn) setHostsBlock(null);
    throw new Error(`routing failed once /etc/hosts was switched, so it was rolled back: ${after.error}`);
  }

  out(`on — ${config.hosts.length} hosts routed via ${redactProxyUrl(config.proxy)}`);
  out(`tunnel: ${describeTunnel(after)}`);
  out("Running sessions switch over as their open connections are replaced.");
}

function cmdOff() {
  if (!routingOn()) {
    out("already off");
    return;
  }
  setHostsBlock(null);
  out("off — Claude Code connects directly");
}

async function cmdStatus() {
  const text = readHosts();
  const routed = blockHosts(text);
  const on = hasBlock(text);
  out(`mode:    ${on ? `on (${routed.length} hosts)` : "off"}`);
  if (on) out(`hosts:   ${routed.join(", ")}`);

  const loaded = isLoaded();
  const running = installedVersion();
  out(`daemon:  ${loaded ? `loaded (${LABEL}${running ? `, version ${running}` : ""})` : "not installed"}`);
  if (loaded && running && running !== VERSION) out(`         this CLI is ${VERSION}; run \`claude-auto-proxy install\` to update the daemon`);

  try {
    const config = loadConfig();
    out(`proxy:   ${config.proxy ? redactProxyUrl(config.proxy) : "not set"}`);
  } catch (error) {
    out(`proxy:   ${error.code === "EACCES" ? "(config is not readable by you; run with sudo to show)" : `unreadable — ${error.message}`}`);
  }

  if (!loaded) return on ? 1 : 0;
  const host = routed[0] ?? DEFAULT_HOSTS[0];
  const probe = on ? await verifyRouting([host]) : await checkTunnel({ host });
  out(`tunnel:  ${describeTunnel(probe)}`);
  if (on && !probe.ok) {
    out("");
    out("Routing is on but the tunnel is broken, so Claude Code cannot connect.");
    out(`Run \`claude-auto-proxy off\` to connect directly, and check ${LOG_PATH}.`);
    return 1;
  }
  return 0;
}

// Saves a config change and, when routing is on, proves it still works — restoring
// the previous config (and hosts block) if it does not.
async function saveAndVerify(previous, next) {
  const saved = saveConfig(next);
  if (!routingOn()) return { saved, applied: false };

  setHostsBlock(saved.hosts);
  const probe = await verifyRouting(saved.hosts);
  if (!probe.ok) {
    saveConfig(previous);
    setHostsBlock(previous.hosts);
    throw new Error(`the change broke routing and was rolled back: ${probe.error}`);
  }
  return { saved, applied: true };
}

const STAGE_LABELS = {
  proxy: "reach the proxy",
  tunnel: "open a tunnel to the target",
  tls: "TLS handshake with the target"
};

// The registration gate: a proxy is saved only after a full round trip through it to
// the real API host succeeded, so a typo or an unreachable router never gets stored.
async function registerProxy(input) {
  const url = normalizeProxyInput(input);
  const target = loadConfig().hosts[0];
  out(`checking ${redactProxyUrl(url)} → ${target}:443`);
  const probe = await probeProxy(url, { host: target });
  probe.stages.forEach((stage, index) => {
    const mark = stage.ok ? "ok" : "FAILED";
    out(`  [${index + 1}/3] ${STAGE_LABELS[stage.name].padEnd(30)} ${mark} (${stage.ms} ms)${stage.ok ? "" : ` — ${stage.error}`}`);
  });
  if (!probe.ok) throw new Error("the proxy did not pass the check, so it was not registered");
  if (!probe.trusted) {
    out("  note: Node does not trust the certificate chain — expected behind a TLS-inspecting proxy");
  }

  const previous = loadConfig();
  const { saved, applied } = await saveAndVerify(previous, { ...previous, proxy: url });
  out(`registered: ${redactProxyUrl(saved.proxy)}`);
  const { hostname } = new URL(saved.proxy);
  if (/^(127\.|\[?::1\]?$|localhost$)/.test(hostname)) {
    out("note: a proxy on this Mac must not resolve host names through /etc/hosts, or it loops back into the relay.");
  }
  return { applied };
}

async function cmdSetProxy(args) {
  if (args.length !== 1) throw new UsageError("set-proxy takes exactly one url");
  const { applied } = await registerProxy(args[0]);
  out(applied ? "routing is on and verified with the new proxy" : "run `claude-auto-proxy on` to start routing");
}

async function ask(question) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(question)).trim();
  } finally {
    prompt.close();
  }
}

async function cmdOnboard(args) {
  const turnOn = args.includes("--on");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 1) throw new UsageError("onboard takes at most one url");
  const interactive = process.stdin.isTTY === true;

  let input = positional[0];
  if (input === undefined) {
    if (!interactive) throw new UsageError("onboard needs a url when not run in a terminal");
    out("Enter the proxy address (for a claude-proxy-router, use `claude-auto-proxy router onboard`).");
    out("  examples: http://proxy.example.com:3128  socks5://127.0.0.1:1055  100.64.0.10:3128");
    input = await ask("proxy: ");
  }

  const { applied } = await registerProxy(input);
  if (applied) {
    out("routing is already on and now uses this proxy");
    return;
  }

  const answer = turnOn ? "y" : interactive ? await ask("Turn routing on now? [Y/n] ") : "n";
  if (/^(y|yes|)$/i.test(answer)) await cmdOn();
  else out("registered only — run `claude-auto-proxy on` when you want to start routing");
}

async function cmdHosts(args) {
  const [action, value] = args;
  const config = loadConfig();
  if (action === undefined) {
    for (const host of config.hosts) out(host);
    return;
  }

  let hosts;
  if (action === "add" && value) hosts = [...config.hosts, normalizeHost(value)];
  else if (action === "remove" && value) {
    const target = normalizeHost(value);
    if (!config.hosts.includes(target)) throw new Error(`${target} is not in the host list`);
    hosts = config.hosts.filter((host) => host !== target);
  } else if (action === "reset" && !value) hosts = [...DEFAULT_HOSTS];
  else throw new UsageError(`unknown hosts command: ${args.join(" ")}`);

  const { saved, applied } = await saveAndVerify(config, { ...config, hosts });
  out(`hosts: ${saved.hosts.join(", ")}${applied ? " (applied)" : ""}`);
}

function cmdUninstall(args) {
  const purge = args.includes("--purge");
  if (routingOn()) setHostsBlock(null);
  uninstall();
  fs.rmSync(APP_DIR, { recursive: true, force: true });
  if (purge) fs.rmSync(configDir(), { recursive: true, force: true });
  out(`uninstalled${purge ? " (config removed)" : ` (config kept in ${configDir()})`}`);
}

// Typed keys are not echoed, so the router key stays out of the terminal scrollback:
// readline echoes into a stream that discards everything, while it keeps the
// terminal in raw mode so the terminal itself does not echo either.
async function askSecret(question) {
  process.stdout.write(question);
  const discard = new Writable({ write: (_chunk, _encoding, done) => done() });
  const prompt = readline.createInterface({ input: process.stdin, output: discard, terminal: true });
  try {
    return (await prompt.question("")).trim();
  } finally {
    prompt.close();
    process.stdout.write("\n");
  }
}

async function readStdinLine() {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (/\r?\n/.test(data)) break;
  }
  return data.split(/\r?\n/)[0].trim();
}

const PING_FAILURES = {
  unreachable: "unreachable — wrong address, router not running, or not on the same tailnet",
  bad_key: "the router answered but refused the key",
  not_router: "something answered, but it is not a claude-proxy-router",
  no_status: "this claude-proxy-router has no /_router/status yet; update it on the router Mac"
};

async function checkRouter(url, key) {
  const ping = await pingRouter(url, key);
  if (!ping.ok) {
    out(`  ping ${url}  FAILED (${ping.ms} ms) — ${PING_FAILURES[ping.reason]}${ping.error ? ` [${ping.error}]` : ""}`);
    return ping;
  }
  const accounts = Number.isInteger(ping.info.accounts) ? ping.info.accounts : "?";
  out(`  ping ${url}  ok (${ping.ms} ms, ${accounts} accounts available, router ${ping.info.version ?? "?"})`);
  if (ping.info.accounts === 0) out("  note: the router has no account that can take a request right now (all limited or logged out)");
  return ping;
}

function requireUser() {
  // Under sudo, HOME and the settings files would be root's, not the person's running Claude Code.
  if (process.getuid() === 0) throw new Error("run router commands as yourself, without sudo");
}

/** Every settings file read up front: one unreadable file aborts before anything is written. */
function readAllSettings() {
  const dirs = claudeConfigDirs();
  const seen = new Set();
  const targets = [];
  for (const dir of dirs) {
    const file = resolveSettingsFile(dir);
    if (seen.has(file)) continue;
    seen.add(file);
    targets.push({ dir, file, settings: readSettings(file), mode: fileMode(file) });
  }
  return targets;
}

/** Warn about routed config directories that still keep a claude.ai login (see claudeLogin). */
function warnLeftoverLogins(dirs) {
  // A Keychain that hangs or refuses once is not asked again for the remaining directories.
  let keychainBroken = false;
  const lookup = (service) => {
    if (keychainBroken) return null;
    const status = keychainLookup(service);
    if (status !== 0 && status !== 44) keychainBroken = true;
    return status;
  };
  const found = [];
  const unchecked = [];
  for (const dir of new Set(dirs)) {
    const login = claudeLogin(dir, { lookup });
    if (login === "unchecked") unchecked.push(dir);
    else if (login) found.push(dir);
  }
  if (found.length > 0) {
    out("");
    out("warning: a claude.ai login is still saved for these config directories. Claude Code sends some account");
    out("requests (startup bootstrap, fast-mode check) to api.anthropic.com with that login, not through the router:");
    for (const dir of found) out(`  ${dir}`);
    out("To route every account request through the router, run /logout in a Claude Code session that uses each one.");
  }
  if (unchecked.length > 0) {
    out("");
    out("note: could not ask the Keychain whether these config directories still hold a claude.ai login:");
    for (const dir of unchecked) out(`  ${dir}`);
  }
}

async function cmdRouterOn({ skipPing = false } = {}) {
  const router = loadRouter();
  if (!router) throw new Error("no router registered yet — run: claude-auto-proxy router onboard");
  // A dead router would leave every new Claude Code session unable to connect.
  if (!skipPing && !(await checkRouter(router.url, router.key)).ok) throw new Error("the router did not answer, so nothing was changed");

  const targets = readAllSettings();
  if (targets.length === 0) throw new Error("no Claude Code config directory found (~/.claude does not exist)");
  const restore = { ...router.restore };
  for (const { dir, file, settings, mode } of targets) {
    const next = routeSettings(settings, router, restore[file], mode);
    // The restore entry is saved before the file changes: if this write (or a later
    // one) fails, `off` still knows what to put back.
    restore[file] = next.entry;
    saveRouter({ url: router.url, key: router.key, restore });
    if (next.changed) writeSettings(file, next.settings);
    const clash = [...conflicts(next.settings), ...localOverrides(dir)];
    out(`  ${file}: ${next.changed ? "routed" : "already routed"}${clash.length ? ` — warning: ${clash.join(", ")} may override the router` : ""}`);
  }

  out(`router on — Claude Code uses ${router.url} (key ${maskKey(router.key)})`);
  out("New Claude Code sessions use the router; restart sessions that are already running.");
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_BASE_URL) {
    out("warning: ANTHROPIC_API_KEY or ANTHROPIC_BASE_URL is set in this shell; sessions started from it may not use the router.");
  }
  if (routingOn()) out("note: tunnel routing (/etc/hosts) is also on; API calls now go to the router instead.");
  warnLeftoverLogins(claudeConfigDirs());
}

function cmdRouterOff() {
  requireUser();
  const router = loadRouter();
  const files = Object.keys(router?.restore ?? {});
  if (!router || files.length === 0) {
    out("router already off");
    return;
  }
  const restore = { ...router.restore };
  let failed = 0;
  for (const file of files) {
    const entry = restore[file];
    try {
      const next = unrouteSettings(readSettings(file), entry);
      if (next.changed) writeSettings(file, next.settings, { mode: entry.mode ?? 0o600 });
      if (next.foreign) {
        out(`  ${file}: base url left alone — it was changed by hand since \`router on\`${next.changed ? " (router key removed)" : ""}`);
      } else out(`  ${file}: ${next.changed ? "restored" : "not routed"}`);
    } catch (error) {
      // The entry stays, so a later `router off` can still restore this file.
      failed += 1;
      out(`  ${file}: skipped — ${error.message}`);
      continue;
    }
    delete restore[file];
    saveRouter({ url: router.url, key: router.key, restore });
  }
  if (failed > 0) throw new Error(`${failed} settings file(s) could not be restored; fix them and run \`router off\` again`);
  out("router off — new Claude Code sessions connect as before; restart sessions that are already running.");
}

async function cmdRouterStatus() {
  requireUser();
  const router = loadRouter();
  if (!router) {
    out("router:  not registered (claude-auto-proxy router onboard)");
    return 0;
  }
  out(`router:  ${router.url} (key ${maskKey(router.key)})`);
  let routed = 0;
  let stale = 0;
  const files = new Map();
  // Every directory whose settings use the router, including ones sharing a settings file.
  const routedDirs = [];
  for (const dir of claudeConfigDirs()) {
    let state;
    let file = path.join(dir, "settings.json");
    try {
      file = resolveSettingsFile(dir);
      if (files.has(file)) {
        if (files.get(file) === "on" || files.get(file) === "stale") routedDirs.push(dir);
        continue;
      }
      state = routeState(readSettings(file), router, router.restore[file]);
    } catch (error) {
      state = `unreadable — ${error.message}`;
    }
    files.set(file, state);
    if (state === "on" || state === "stale") routedDirs.push(dir);
    if (state === "on") routed += 1;
    if (state === "stale") stale += 1;
    out(`  ${file}: ${state === "stale" ? "on, but with an older router address or key" : state}`);
  }
  out(`mode:    ${routed + stale > 0 ? `on (${routed + stale} settings files)` : "off"}`);
  const ping = await checkRouter(router.url, router.key);
  if (ping.ok) {
    // Claude Code's own /status and /usage cannot show these: its only credential is the router key.
    const view = await fetchRouterStatus(router.url, router.key);
    out("");
    if (view.ok) {
      out("accounts (from the router):");
      // Reset times are judged on the router's clock, as the router itself does.
      const routerNow = Date.parse(view.generatedAt ?? "");
      for (const line of formatAccounts(view.accounts, Number.isFinite(routerNow) ? routerNow : Date.now(), { limitPct: view.limitPct ?? 100 })) {
        out(line);
      }
    } else out(`accounts: not available — ${PING_FAILURES[view.reason]}`);
  }
  if (stale > 0) {
    out("");
    out("Some settings still point at an older router address or key. Run `claude-auto-proxy router on` to update them.");
  }
  if (routed + stale > 0 && !ping.ok) {
    out("");
    out("Router mode is on but the router does not answer, so new Claude Code sessions cannot connect.");
    out("Run `claude-auto-proxy router off` to connect directly.");
  }
  warnLeftoverLogins(routedDirs);
  return stale > 0 || (routed > 0 && !ping.ok) ? 1 : 0;
}

async function cmdRouterOnboard(args) {
  requireUser();
  const turnOn = args.includes("--on");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length > 1) throw new UsageError("router onboard takes at most one url");
  const interactive = process.stdin.isTTY === true;

  let input = positional[0];
  if (input === undefined) {
    if (!interactive) throw new UsageError("router onboard needs a url when not run in a terminal");
    out("Enter the router address and key (on the router Mac: claude-proxy-router key).");
    input = await ask("router address (e.g. http://100.64.0.10:18787): ");
  }
  const url = parseRouterUrl(input);
  const key = interactive ? await askSecret("router key: ") : await readStdinLine();
  if (key === "") throw new UsageError("the router key is empty");
  if (!validRouterKey(key)) throw new UsageError("the router key has spaces or characters a router key never has");

  const ping = await checkRouter(url, key);
  if (!ping.ok) throw new Error("the router did not pass the ping, so it was not registered");

  const previous = loadRouter();
  const wasOn = Object.keys(previous?.restore ?? {}).length > 0;
  saveRouter({ url, key, restore: previous?.restore ?? {} });
  out(`registered: ${url} (key ${maskKey(key)})`);

  if (wasOn) {
    await cmdRouterOn({ skipPing: true });
    return;
  }
  const answer = turnOn ? "y" : interactive ? await ask("Point Claude Code at the router now? [Y/n] ") : "n";
  if (/^(y|yes|)$/i.test(answer)) await cmdRouterOn({ skipPing: true });
  else out("registered only — run `claude-auto-proxy router on` when you want to use it");
}

async function cmdRouter(args) {
  const [action, ...rest] = args;
  switch (action) {
    case "onboard":
      await cmdRouterOnboard(rest);
      return 0;
    case "on":
      requireUser();
      if (rest.length) throw new UsageError("router on takes no arguments");
      await cmdRouterOn();
      return 0;
    case "off":
      if (rest.length) throw new UsageError("router off takes no arguments");
      cmdRouterOff();
      return 0;
    case "status":
      return await cmdRouterStatus();
    default:
      // Not echoed: a key pasted in the wrong place must not land in the terminal.
      throw new UsageError("unknown router command (onboard, on, off or status)");
  }
}

async function cmdDaemon(args) {
  const portIndex = args.indexOf("--port");
  const bindIndex = args.indexOf("--bind");
  const port = portIndex === -1 ? 443 : Number(args[portIndex + 1]);
  const addresses = bindIndex === -1 ? undefined : String(args[bindIndex + 1]).split(",");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new UsageError("--port needs a port number");

  const relay = await startRelay({ port, addresses, loadConfig });

  // Root is only needed to bind a port below 1024 on loopback. Everything after —
  // parsing untrusted bytes, talking to the proxy — runs unprivileged.
  if (process.getuid() === 0) {
    const { uid, gid } = daemonIds();
    process.setgroups([gid]);
    process.setgid(gid);
    process.setuid(uid);
    log("info", `dropped privileges to ${DAEMON_USER} (${uid}:${gid})`);
  }

  const stop = () => {
    // launchd waits for the process to exit; a stuck close must not hold it.
    setTimeout(() => process.exit(0), 2000).unref();
    relay.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

const PRIVILEGED = new Set(["onboard", "on", "off", "set-proxy", "hosts", "install", "uninstall"]);

export async function main(argv) {
  const [command, ...args] = argv;

  try {
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      process.stdout.write(USAGE);
      return command === undefined ? 1 : 0;
    }
    if (command === "--version" || command === "-v") {
      out(VERSION);
      return 0;
    }

    requireMac();
    if (PRIVILEGED.has(command)) {
      const status = escalate(argv);
      if (status !== null) return status;
    }

    switch (command) {
      case "on":
        await cmdOn();
        return 0;
      case "off":
        cmdOff();
        return 0;
      case "status":
        return await cmdStatus();
      case "onboard":
        await cmdOnboard(args);
        return 0;
      case "set-proxy":
        await cmdSetProxy(args);
        return 0;
      case "hosts":
        await cmdHosts(args);
        return 0;
      case "install":
        ensureDaemon({ force: true });
        return 0;
      case "uninstall":
        cmdUninstall(args);
        return 0;
      case "router":
        return await cmdRouter(args);
      case "daemon":
        await cmdDaemon(args);
        return null;
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    if (error instanceof UsageError) process.stderr.write(`\n${USAGE}`);
    return 1;
  }
}
