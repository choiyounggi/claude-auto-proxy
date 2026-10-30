import assert from "node:assert/strict";
import fs from "node:fs";
import { after, beforeEach, describe, it } from "node:test";
import { configPath, DEFAULT_HOSTS, loadConfig, saveConfig, validateConfig } from "../src/config.js";
import { scratchDir } from "./helpers.js";

describe("config", () => {
  const dir = scratchDir();
  process.env.CLAUDE_AUTO_PROXY_HOME = dir;
  after(() => {
    delete process.env.CLAUDE_AUTO_PROXY_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => fs.rmSync(configPath(), { force: true }));

  it("defaults to no proxy and the default hosts when nothing is saved", () => {
    assert.deepEqual(loadConfig(), { proxy: null, hosts: [...DEFAULT_HOSTS] });
  });

  it("round-trips through a root-only file", () => {
    saveConfig({ proxy: "http://u:p@proxy.corp:3128", hosts: ["API.anthropic.com", "claude.ai", "claude.ai"] });
    assert.deepEqual(loadConfig(), { proxy: "http://u:p@proxy.corp:3128", hosts: ["api.anthropic.com", "claude.ai"] });
    assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600);
  });

  it("hands the file to the daemon's group as 0640 when saved as root", () => {
    const calls = [];
    const fsImpl = {
      ...fs,
      chownSync: (file, uid, gid) => calls.push(["chown", uid, gid]),
      chmodSync: (file, mode) => {
        calls.push(["chmod", mode]);
        fs.chmodSync(file, mode);
      }
    };
    saveConfig({ proxy: null, hosts: ["claude.ai"] }, { fsImpl, ids: { uid: 1, gid: 4242 } });
    assert.deepEqual(calls, [["chmod", 0o600], ["chown", 0, 4242], ["chmod", 0o640]]);
    assert.equal(fs.statSync(configPath()).mode & 0o777, 0o640);
  });

  it("rejects a proxy that is itself in the host list", () => {
    assert.throws(
      () => validateConfig({ proxy: "http://claude.ai:3128", hosts: ["claude.ai"] }),
      /cannot also be in the host list/
    );
  });

  it("rejects an empty host list and invalid host names", () => {
    assert.throws(() => validateConfig({ proxy: null, hosts: [] }), /empty/);
    assert.throws(() => validateConfig({ proxy: null, hosts: ["not a host"] }), /invalid host name/);
    assert.throws(() => validateConfig({ proxy: null, hosts: ["localhost"] }), /invalid host name/);
  });

  it("rejects an invalid proxy before saving", () => {
    assert.throws(() => saveConfig({ proxy: "socks4://x:1", hosts: ["claude.ai"] }), /unsupported/);
    assert.equal(fs.existsSync(configPath()), false);
  });

  it("reports a corrupted file", () => {
    fs.writeFileSync(configPath(), "{");
    assert.throws(() => loadConfig(), /not valid JSON/);
  });
});
