import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline/promises";
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

Commands that change the system ask for your password through sudo.
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
    out("Enter the proxy router address.");
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
