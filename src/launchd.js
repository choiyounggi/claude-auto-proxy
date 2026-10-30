import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const LABEL = "io.github.choiyounggi.claude-auto-proxy";
export const PLIST_PATH = `/Library/LaunchDaemons/${LABEL}.plist`;
export const LOG_PATH = "/Library/Logs/claude-auto-proxy.log";

// launchd starts the daemon as root, so the code it loads must not be writable by the
// user: npm and Homebrew both install into user-owned directories. The daemon runs a
// root-owned copy instead, refreshed whenever the installed version changes.
export const APP_DIR = "/Library/Application Support/claude-auto-proxy/app";
export const APP_SCRIPT = path.join(APP_DIR, "bin", "claude-auto-proxy.js");
const APP_ENTRIES = ["package.json", "bin", "src"];

export function installApp(sourceRoot, { appDir = APP_DIR, fsImpl = fs } = {}) {
  fsImpl.rmSync(appDir, { recursive: true, force: true });
  fsImpl.mkdirSync(appDir, { recursive: true, mode: 0o755 });
  for (const entry of APP_ENTRIES) {
    fsImpl.cpSync(path.join(sourceRoot, entry), path.join(appDir, entry), { recursive: true });
  }
  lockDown(appDir, fsImpl);
}

function lockDown(target, fsImpl) {
  const stat = fsImpl.statSync(target);
  if (process.getuid() === 0) fsImpl.chownSync(target, 0, 0);
  fsImpl.chmodSync(target, stat.isDirectory() ? 0o755 : 0o644);
  if (stat.isDirectory()) {
    for (const name of fsImpl.readdirSync(target)) lockDown(path.join(target, name), fsImpl);
  }
}

/** Version of the copy the daemon runs, or null when none is installed. */
export function installedVersion({ appDir = APP_DIR, fsImpl = fs } = {}) {
  try {
    return JSON.parse(fsImpl.readFileSync(path.join(appDir, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/** True when the file and every directory above it belong to root. */
export function isRootOwned(target, { fsImpl = fs } = {}) {
  let current = fsImpl.realpathSync(target);
  for (;;) {
    if (fsImpl.statSync(current).uid !== 0) return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

/**
 * Maps a Homebrew Cellar path (versioned, deleted on upgrade) to its stable opt/
 * symlink when that exists. launchd keeps the absolute path it was given, so a
 * versioned path would stop the daemon after the next `brew upgrade`.
 */
export function stablePath(p, exists = fs.existsSync) {
  const match = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.*)$/.exec(p);
  if (!match) return p;
  const candidate = `${match[1]}/opt/${match[2]}/${match[3]}`;
  return exists(candidate) ? candidate : p;
}

/** Node installed by a version manager disappears when that version is removed. */
export function isVersionManagedPath(p) {
  return /\/\.(nvm|volta|asdf|fnm|nodenv)\/|\/fnm\/|\/mise\/installs\//.test(p);
}

function xml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderPlist({ nodePath, scriptPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(scriptPath)}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
`;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isLoaded(run = execFileSync) {
  try {
    run("/bin/launchctl", ["print", `system/${LABEL}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function install({ nodePath, scriptPath, run = execFileSync, fsImpl = fs }) {
  fsImpl.writeFileSync(PLIST_PATH, renderPlist({ nodePath, scriptPath }), { mode: 0o644 });
  fsImpl.chmodSync(PLIST_PATH, 0o644);

  if (isLoaded(run)) {
    try {
      run("/bin/launchctl", ["bootout", `system/${LABEL}`], { stdio: "ignore" });
    } catch {
      // already gone
    }
  }

  // bootout returns before the service is fully torn down, and bootstrapping too soon
  // fails with "Input/output error". A few short retries cover it.
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      run("/bin/launchctl", ["bootstrap", "system", PLIST_PATH], { stdio: "pipe" });
      return;
    } catch (error) {
      lastError = error;
      sleepMs(500);
    }
  }
  throw new Error(`launchctl bootstrap failed: ${String(lastError?.stderr || lastError?.message).trim()}`);
}

export function uninstall({ run = execFileSync, fsImpl = fs } = {}) {
  if (isLoaded(run)) {
    try {
      run("/bin/launchctl", ["bootout", `system/${LABEL}`], { stdio: "ignore" });
    } catch {
      // already gone
    }
  }
  if (fsImpl.existsSync(PLIST_PATH)) fsImpl.unlinkSync(PLIST_PATH);
}
