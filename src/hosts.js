import { execFileSync } from "node:child_process";
import fs from "node:fs";

export const HOSTS_PATH = "/etc/hosts";
export const BEGIN = "# >>> claude-auto-proxy >>> (managed block; remove with `claude-auto-proxy off`)";
export const END = "# <<< claude-auto-proxy <<<";

function splitBlock(text) {
  const lines = text.split("\n");
  const begin = lines.indexOf(BEGIN);
  if (begin === -1) return { lines, begin: -1, end: -1 };
  const end = lines.indexOf(END, begin + 1);
  // Without an end marker we cannot tell where our block stops, and guessing could
  // delete the user's own entries.
  if (end === -1) throw new Error(`${HOSTS_PATH} has a claude-auto-proxy start marker without an end marker; fix it by hand`);
  return { lines, begin, end };
}

export function hasBlock(text) {
  return splitBlock(text).begin !== -1;
}

/** Host names inside the managed block, in order, without duplicates. */
export function blockHosts(text) {
  const { lines, begin, end } = splitBlock(text);
  if (begin === -1) return [];
  const hosts = lines.slice(begin + 1, end).map((line) => line.trim().split(/\s+/)[1]).filter(Boolean);
  return [...new Set(hosts)];
}

export function stripBlock(text) {
  const { lines, begin, end } = splitBlock(text);
  if (begin === -1) return text;
  lines.splice(begin, end - begin + 1);
  return lines.join("\n");
}

// Both families are listed: with only an IPv4 entry, a client asking for AAAA records
// still gets the real IPv6 address from DNS and goes around the relay.
export function renderBlock(hosts) {
  const entries = hosts.flatMap((host) => [`127.0.0.1 ${host}`, `::1 ${host}`]);
  return [BEGIN, ...entries, END].join("\n");
}

export function applyBlock(text, hosts) {
  let base = stripBlock(text);
  if (base.length > 0 && !base.endsWith("\n")) base += "\n";
  return `${base}${renderBlock(hosts)}\n`;
}

export function readHosts({ path = HOSTS_PATH, fsImpl = fs } = {}) {
  return fsImpl.readFileSync(path, "utf8");
}

// Keeps a copy of what was there before, then swaps the file in with a rename so a
// crash mid-write cannot leave a truncated /etc/hosts behind.
export function writeHosts(text, { path = HOSTS_PATH, fsImpl = fs } = {}) {
  fsImpl.copyFileSync(path, `${path}.claude-auto-proxy.bak`);
  const temp = `${path}.claude-auto-proxy.tmp`;
  fsImpl.writeFileSync(temp, text, { mode: 0o644 });
  fsImpl.chmodSync(temp, 0o644);
  fsImpl.renameSync(temp, path);
}

/** Drops cached lookups so new connections see the hosts change right away. Best effort. */
export function flushDns(run = execFileSync) {
  for (const [command, args] of [
    ["/usr/bin/dscacheutil", ["-flushcache"]],
    ["/usr/bin/killall", ["-HUP", "mDNSResponder"]]
  ]) {
    try {
      run(command, args, { stdio: "ignore" });
    } catch {
      // a stale cache only delays the switch; it is not worth failing over
    }
  }
}
