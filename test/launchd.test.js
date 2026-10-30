import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  install,
  installApp,
  installedVersion,
  isLoaded,
  isRootOwned,
  isVersionManagedPath,
  LABEL,
  renderPlist,
  stablePath
} from "../src/launchd.js";
import { scratchDir } from "./helpers.js";

describe("stablePath", () => {
  const exists = (p) => p.startsWith("/opt/homebrew/opt/");

  it("maps a Homebrew Cellar path to its opt symlink", () => {
    assert.equal(stablePath("/opt/homebrew/Cellar/node/25.6.0/bin/node", exists), "/opt/homebrew/opt/node/bin/node");
    assert.equal(
      stablePath("/opt/homebrew/Cellar/claude-auto-proxy/0.1.0/libexec/bin/claude-auto-proxy.js", exists),
      "/opt/homebrew/opt/claude-auto-proxy/libexec/bin/claude-auto-proxy.js"
    );
  });

  it("keeps the path when the opt symlink does not exist", () => {
    assert.equal(stablePath("/usr/local/Cellar/node/20.1.0/bin/node", exists), "/usr/local/Cellar/node/20.1.0/bin/node");
  });

  it("leaves non-Cellar paths alone", () => {
    assert.equal(stablePath("/usr/local/bin/node", exists), "/usr/local/bin/node");
  });
});

describe("isVersionManagedPath", () => {
  it("flags version-manager installs", () => {
    assert.equal(isVersionManagedPath("/Users/a/.nvm/versions/node/v22.1.0/bin/node"), true);
    assert.equal(isVersionManagedPath("/Users/a/.volta/tools/image/node/22/bin/node"), true);
    assert.equal(isVersionManagedPath("/Users/a/.local/share/mise/installs/node/22/bin/node"), true);
  });

  it("does not flag system or Homebrew node", () => {
    assert.equal(isVersionManagedPath("/opt/homebrew/opt/node/bin/node"), false);
    assert.equal(isVersionManagedPath("/usr/local/bin/node"), false);
  });
});

describe("renderPlist", () => {
  it("runs the daemon command and escapes paths", () => {
    const plist = renderPlist({ nodePath: "/opt/node", scriptPath: "/Users/a&b/<x>/cli.js" });
    assert.match(plist, new RegExp(`<string>${LABEL}</string>`));
    assert.match(plist, /<string>\/Users\/a&amp;b\/&lt;x&gt;\/cli\.js<\/string>\s*<string>daemon<\/string>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  });
});

describe("launchctl calls", () => {
  it("isLoaded reflects the launchctl exit status", () => {
    assert.equal(isLoaded(() => Buffer.alloc(0)), true);
    assert.equal(isLoaded(() => {
      throw new Error("Could not find service");
    }), false);
  });

  it("install retries bootstrap and gives up with the launchctl message", () => {
    const calls = [];
    const fsImpl = { writeFileSync() {}, chmodSync() {} };
    const run = (_command, args) => {
      calls.push(args[0]);
      if (args[0] === "print") throw new Error("not loaded");
      const error = new Error("failed");
      error.stderr = Buffer.from("Bootstrap failed: 5: Input/output error");
      throw error;
    };
    assert.throws(() => install({ nodePath: "/n", scriptPath: "/s", run, fsImpl }), /Input\/output error/);
    assert.equal(calls.filter((call) => call === "bootstrap").length, 5);
  });
});

describe("app copy", () => {
  const dir = scratchDir();
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.resolve(import.meta.dirname, "..");

  it("copies the runtime files and reports their version", () => {
    const appDir = path.join(dir, "app");
    installApp(repo, { appDir });
    assert.ok(fs.existsSync(path.join(appDir, "bin", "claude-auto-proxy.js")));
    assert.ok(fs.existsSync(path.join(appDir, "src", "relay.js")));
    assert.equal(fs.existsSync(path.join(appDir, "test")), false);
    assert.equal(fs.statSync(path.join(appDir, "src", "relay.js")).mode & 0o777, 0o644);
    const version = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
    assert.equal(installedVersion({ appDir }), version);
  });

  it("replaces a previous copy, dropping stale files", () => {
    const appDir = path.join(dir, "app2");
    fs.mkdirSync(path.join(appDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "src", "stale.js"), "");
    installApp(repo, { appDir });
    assert.equal(fs.existsSync(path.join(appDir, "src", "stale.js")), false);
  });

  it("reports no version when nothing is installed", () => {
    assert.equal(installedVersion({ appDir: path.join(dir, "missing") }), null);
  });

  it("isRootOwned walks up the directory chain", () => {
    assert.equal(isRootOwned("/bin/sh"), true);
    const file = path.join(dir, "mine");
    fs.writeFileSync(file, "");
    assert.equal(isRootOwned(file), process.getuid() === 0);
  });
});
