import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  claudeConfigDirs,
  claudeLogin,
  ENV_KEY,
  KEYCHAIN_SERVICE,
  keychainServiceFor,
  ENV_URL,
  maskKey,
  parseRouterUrl,
  pingRouter,
  readSettings,
  routeSettings,
  routeState,
  unrouteSettings,
  validRouterKey,
  writeSettings
} from "../src/router.js";
import { close, listen, scratchDir } from "./helpers.js";

const KEY = "cpr_test-router-key-0123456789";
const KEY2 = "cpr_rotated-router-key-9876543210";
const BIN = path.resolve(import.meta.dirname, "..", "bin", "claude-auto-proxy.js");

/** Answers like claude-proxy-router's /_router/ping (PROTOCOL.md v1). */
async function startFakeRouter({ protocol = 1, key = KEY } = {}) {
  const server = http.createServer((req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["x-router-key"] !== key) {
      json(401, { type: "error", error: { type: "authentication_error" }, service: "claude-proxy-router" });
    } else if (req.url === "/_router/ping") {
      json(200, { pong: true, service: "claude-proxy-router", protocol, version: "0.1.0", accounts: 2 });
    } else json(404, {});
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}` };
}

async function startOtherServer() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>hello</html>");
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}` };
}

describe("parseRouterUrl", () => {
  it("normalizes an address, defaulting a bare host to the router's port", () => {
    assert.equal(parseRouterUrl("100.64.0.10:18787"), "http://100.64.0.10:18787");
    assert.equal(parseRouterUrl("100.64.0.10"), "http://100.64.0.10:18787");
    assert.equal(parseRouterUrl(" https://router.tail1234.ts.net/ "), "https://router.tail1234.ts.net");
  });

  it("refuses paths, credentials, other schemes and a pasted key", () => {
    assert.throws(() => parseRouterUrl("http://h:1/v1"), /no path/);
    assert.throws(() => parseRouterUrl("http://u:p@h:1"), /key prompt/);
    assert.throws(() => parseRouterUrl("socks5://h:1"), /http/);
    assert.throws(() => parseRouterUrl(KEY), (error) => /router key/.test(error.message) && !error.message.includes(KEY));
  });

  it("refuses an empty address", () => {
    assert.throws(() => parseRouterUrl("   "), /empty/);
    assert.throws(() => parseRouterUrl(undefined), /empty/);
  });
});

describe("router key", () => {
  it("masks all but the ends of a key, and all of a short one", () => {
    assert.equal(maskKey(KEY), "cpr_***89");
    assert.equal(maskKey("short"), "***");
    assert.equal(maskKey(""), "***");
  });

  it("accepts only header-safe keys", () => {
    assert.equal(validRouterKey(KEY), true);
    assert.equal(validRouterKey("has space"), false);
    assert.equal(validRouterKey("키"), false);
    assert.equal(validRouterKey(""), false);
  });
});

describe("pingRouter", () => {
  let router;
  let other;
  let oldProtocol;
  before(async () => {
    router = await startFakeRouter();
    other = await startOtherServer();
    oldProtocol = await startFakeRouter({ protocol: 2 });
  });
  after(async () => {
    await close(router.server);
    await close(other.server);
    await close(oldProtocol.server);
  });

  it("passes on a pong from a claude-proxy-router", async () => {
    const ping = await pingRouter(router.url, KEY);
    assert.equal(ping.ok, true);
    assert.equal(ping.info.accounts, 2);
  });

  it("tells a wrong key apart from a wrong address", async () => {
    assert.equal((await pingRouter(router.url, "cpr_wrong")).reason, "bad_key");
    assert.equal((await pingRouter(other.url, KEY)).reason, "not_router");
    assert.equal((await pingRouter(oldProtocol.url, KEY)).reason, "not_router");
  });

  it("reports an address nobody listens on as unreachable", async () => {
    const probe = http.createServer();
    const port = await listen(probe);
    await close(probe);
    const ping = await pingRouter(`http://127.0.0.1:${port}`, KEY, { timeoutMs: 2000 });
    assert.equal(ping.ok, false);
    assert.equal(ping.reason, "unreachable");
  });
});

describe("settings", () => {
  const dir = scratchDir();
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const router = { url: "http://100.64.0.10:18787", key: KEY };
  const rotated = { url: "http://100.64.0.11:18787", key: KEY2 };

  it("switches on and back off, keeping other settings and the previous values", () => {
    const original = { model: "opus", env: { FOO: "1", [ENV_URL]: "https://gateway.example", [ENV_KEY]: "corp" } };
    const on = routeSettings(original, router, undefined, 0o644);
    assert.equal(routeState(on.settings, router, on.entry), "on");
    assert.equal(on.settings.env.FOO, "1");
    assert.equal(on.entry.mode, 0o644);

    // Running `on` again must not record the router as the value to restore.
    const again = routeSettings(on.settings, router, on.entry);
    assert.equal(again.changed, false);
    assert.deepEqual(again.entry, on.entry);

    const off = unrouteSettings(again.settings, again.entry);
    assert.equal(off.changed, true);
    assert.deepEqual(off.settings, original);
  });

  it("never records the router as the previous value when an earlier `on` lost its entry", () => {
    const routedWithoutEntry = { env: { [ENV_URL]: router.url, [ENV_KEY]: router.key } };
    const on = routeSettings(routedWithoutEntry, router, undefined);
    assert.equal(on.entry[ENV_URL], null);
    assert.equal(on.entry[ENV_KEY], null);
    assert.deepEqual(unrouteSettings(on.settings, on.entry).settings, {});
  });

  it("restores the original after a rotation, even if the file still has the old router", () => {
    const original = { env: { [ENV_URL]: "https://gateway.example" } };
    const first = routeSettings(original, router, undefined);
    const second = routeSettings(first.settings, rotated, first.entry);
    assert.equal(routeState(first.settings, rotated, second.entry), "stale");
    // The file was never rewritten for the rotated router (the write failed).
    assert.deepEqual(unrouteSettings(first.settings, second.entry).settings, original);
    assert.deepEqual(unrouteSettings(second.settings, second.entry).settings, original);
  });

  it("leaves a base url changed by hand alone but takes the router key back out", () => {
    const on = routeSettings({ env: { [ENV_KEY]: "my-own-token" } }, router, undefined);
    const edited = { env: { ...on.settings.env, [ENV_URL]: "https://elsewhere.example" } };
    const off = unrouteSettings(edited, on.entry);
    assert.equal(off.changed, true);
    assert.equal(off.foreign, true);
    assert.deepEqual(off.settings.env, { [ENV_URL]: "https://elsewhere.example", [ENV_KEY]: "my-own-token" });
  });

  it("changes nothing in a file it never routed", () => {
    const untouched = { env: { [ENV_URL]: "https://elsewhere.example", [ENV_KEY]: "x" } };
    const off = unrouteSettings(untouched, { routed: [{ url: router.url, key: KEY }] });
    assert.equal(off.changed, false);
    assert.equal(off.settings, untouched);
  });

  it("reads a missing or empty file as {} and refuses anything that is not a JSON object", () => {
    const file = path.join(dir, "settings.json");
    assert.deepEqual(readSettings(path.join(dir, "missing.json")), {});
    fs.writeFileSync(file, "  \n");
    assert.deepEqual(readSettings(file), {});
    fs.writeFileSync(file, "{ // comment\n}");
    assert.throws(() => readSettings(file), /not valid JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{ // comment\n}");
    fs.writeFileSync(file, "[1]");
    assert.throws(() => readSettings(file), /not a JSON object/);
  });

  it("writes owner-only by default and leaves no temp file behind when a write fails", () => {
    const file = path.join(dir, "written.json");
    fs.writeFileSync(file, "{}", { mode: 0o644 });
    writeSettings(file, { env: { [ENV_KEY]: KEY } });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { env: { [ENV_KEY]: KEY } });

    const target = path.join(dir, "is-a-directory");
    fs.mkdirSync(target);
    assert.throws(() => writeSettings(target, { env: { [ENV_KEY]: KEY } }));
    assert.equal(fs.existsSync(`${target}.claude-auto-proxy.tmp`), false);
  });
});

describe("claudeConfigDirs", () => {
  const home = scratchDir();
  after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profiles = path.join(home, "Library/Application Support/orca/claude-profiles");

  it("finds CLAUDE_CONFIG_DIR, ~/.claude and Orca profiles", () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(profiles, "b-profile", "home"), { recursive: true });
    fs.writeFileSync(path.join(profiles, "b-profile", "profile.json"), "{}");
    fs.mkdirSync(path.join(profiles, "a-not-a-profile", "home"), { recursive: true });
    const dirs = claudeConfigDirs({ home, env: { CLAUDE_CONFIG_DIR: path.join(home, "custom") } });
    assert.deepEqual(dirs, [path.join(home, ".claude"), path.join(profiles, "b-profile", "home")]);
    fs.mkdirSync(path.join(home, "custom"));
    assert.equal(claudeConfigDirs({ home, env: { CLAUDE_CONFIG_DIR: path.join(home, "custom") } })[0], path.join(home, "custom"));
  });

  it("returns nothing when no config directory exists", () => {
    assert.deepEqual(claudeConfigDirs({ home: path.join(home, "nobody-here"), env: {} }), []);
  });
});

describe("claude.ai login left in a config directory", () => {
  const home = "/Users/u";
  const profile = "/Users/u/Library/Application Support/orca/claude-profiles/p1/home";

  it("names the Keychain item the way Claude Code does", () => {
    assert.equal(keychainServiceFor(path.join(home, ".claude"), { home, env: {} }), KEYCHAIN_SERVICE);
    // sha256 of the directory string, first 8 hex (computed independently with shasum -a 256).
    assert.equal(keychainServiceFor(profile, { home, env: {} }), `${KEYCHAIN_SERVICE}-b4ac90b8`);
    // $CLAUDE_CONFIG_DIR is hashed exactly as written, trailing slash included.
    assert.equal(keychainServiceFor("/Users/u/custom-config", { home, env: { CLAUDE_CONFIG_DIR: "/Users/u/custom-config/" } }),
      `${KEYCHAIN_SERVICE}-b5bb2f82`);
    assert.equal(keychainServiceFor("/Users/u/custom-config", { home, env: {} }), `${KEYCHAIN_SERVICE}-3259defd`);
  });

  it("treats an empty CLAUDE_CONFIG_DIR as unset", () => {
    assert.equal(keychainServiceFor(path.join(home, ".claude"), { home, env: { CLAUDE_CONFIG_DIR: "" } }), KEYCHAIN_SERVICE);
  });

  // Obviously fake stores: the shapes Claude Code writes, never real values.
  const LOGIN_STORE = JSON.stringify({ claudeAiOauth: { accessToken: "fake-access" } });
  const MCP_ONLY_STORE = JSON.stringify({ mcpOAuth: { "example|0": { accessToken: "fake-mcp" } } });
  const ACCOUNT = JSON.stringify({ oauthAccount: { emailAddress: "someone@example.com" } });
  function configDir() {
    const root = scratchDir();
    const dir = path.join(root, "profile-home");
    fs.mkdirSync(dir);
    return { root, dir };
  }
  const never = () => { throw new Error("the Keychain must not be asked"); };

  it("reports a Keychain login when .claude.json names an account, asking only that directory's item", () => {
    const { root, dir } = configDir();
    try {
      fs.writeFileSync(path.join(dir, ".claude.json"), ACCOUNT);
      const asked = [];
      const lookup = (service) => { asked.push(service); return 0; };
      assert.equal(claudeLogin(dir, { home: root, env: {}, lookup }), "keychain");
      assert.deepEqual(asked, [keychainServiceFor(dir, { home: root, env: {} })]);
      assert.equal(claudeLogin(dir, { home: root, env: {}, lookup: () => 44 }), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not ask the Keychain when no account is named, so an MCP-only item is no login", () => {
    const { root, dir } = configDir();
    try {
      assert.equal(claudeLogin(dir, { home: root, env: {}, lookup: never }), null);
      fs.writeFileSync(path.join(dir, ".credentials.json"), MCP_ONLY_STORE);
      assert.equal(claudeLogin(dir, { home: root, env: {}, lookup: never }), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a .credentials.json that holds a claude.ai login, and ignores a broken one", () => {
    const { root, dir } = configDir();
    try {
      fs.writeFileSync(path.join(dir, ".credentials.json"), "{not json");
      assert.equal(claudeLogin(dir, { home: root, env: {}, lookup: never }), null);
      fs.writeFileSync(path.join(dir, ".credentials.json"), LOGIN_STORE);
      assert.equal(claudeLogin(dir, { home: root, env: {}, lookup: never }), "file");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("says unchecked when the Keychain cannot be asked", () => {
    const { root, dir } = configDir();
    try {
      fs.writeFileSync(path.join(dir, ".claude.json"), ACCOUNT);
      assert.equal(claudeLogin(dir, { home: root, env: {}, lookup: () => null }), "unchecked");
      assert.equal(claudeLogin(dir, { home: root, env: {}, lookup: () => 36 }), "unchecked");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks both items for ~/.claude when CLAUDE_CONFIG_DIR points at it, reading ~/.claude.json", () => {
    const root = scratchDir();
    const dir = path.join(root, ".claude");
    fs.mkdirSync(dir);
    try {
      fs.writeFileSync(path.join(root, ".claude.json"), ACCOUNT);
      const asked = [];
      const lookup = (service) => { asked.push(service); return service === KEYCHAIN_SERVICE ? 0 : 44; };
      assert.equal(claudeLogin(dir, { home: root, env: { CLAUDE_CONFIG_DIR: dir }, lookup }), "keychain");
      assert.deepEqual(asked, [keychainServiceFor(dir, { home: root, env: { CLAUDE_CONFIG_DIR: dir } }), KEYCHAIN_SERVICE]);
      assert.notEqual(asked[0], KEYCHAIN_SERVICE);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("router CLI", () => {
  const homes = [];
  let router;
  before(async () => {
    router = await startFakeRouter();
  });
  after(async () => {
    await close(router.server);
    for (const home of homes) {
      fs.chmodSync(home, 0o700);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  function newHome(settings) {
    const home = scratchDir();
    homes.push(home);
    fs.mkdirSync(path.join(home, ".claude"));
    if (settings !== undefined) fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(settings));
    return home;
  }
  const settingsOf = (home) => JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  const env = (home) => ({ PATH: process.env.PATH, HOME: home, CLAUDE_AUTO_PROXY_USER_HOME: path.join(home, "state") });

  // Spawned asynchronously: the fake router runs in this process and must keep answering.
  function run(command, args, home, input = "", extraEnv = {}) {
    return new Promise((resolve) => {
      const child = spawn(command, args, { env: { ...env(home), ...extraEnv } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(input);
    });
  }
  const cli = (home, args, input, extraEnv) => run(process.execPath, [BIN, ...args], home, input, extraEnv);

  it("does not register a router whose key is refused", async () => {
    const home = newHome({ model: "opus" });
    const result = await cli(home, ["router", "onboard", router.url, "--on"], "cpr_wrong\n");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /refused the key/);
    assert.equal(fs.existsSync(path.join(home, "state", "router.json")), false);
    assert.deepEqual(settingsOf(home), { model: "opus" });
  });

  it("onboards, switches on, reports, and restores on off without printing the key", async () => {
    const original = { model: "opus", env: { [ENV_URL]: "https://gateway.example" } };
    const home = newHome(original);
    fs.chmodSync(path.join(home, ".claude", "settings.json"), 0o644);
    const onboard = await cli(home, ["router", "onboard", router.url, "--on"], `${KEY}\n`);
    assert.equal(onboard.status, 0, onboard.stderr);
    assert.match(onboard.stdout, /router on/);
    assert.equal(settingsOf(home).env[ENV_URL], router.url);
    assert.equal(settingsOf(home).env[ENV_KEY], KEY);

    const status = await cli(home, ["router", "status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /mode: {4}on \(1 settings files\)/);

    const off = await cli(home, ["router", "off"]);
    assert.equal(off.status, 0, off.stderr);
    assert.deepEqual(settingsOf(home), original);
    assert.equal(fs.statSync(path.join(home, ".claude", "settings.json")).mode & 0o777, 0o644);

    for (const output of [onboard, status, off]) assert.equal(`${output.stdout}${output.stderr}`.includes(KEY), false);
  });

  it("warns on and status about a config directory that still holds a claude.ai login", async () => {
    const home = newHome({});
    const profile = path.join(home, "Library/Application Support/orca/claude-profiles/p1");
    fs.mkdirSync(path.join(profile, "home"), { recursive: true });
    fs.writeFileSync(path.join(profile, "profile.json"), "{}");
    fs.writeFileSync(path.join(profile, "home", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake-access" } }));

    const on = await cli(home, ["router", "onboard", router.url, "--on"], `${KEY}\n`);
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /claude\.ai login is still saved/);
    assert.ok(on.stdout.includes(`  ${path.join(profile, "home")}\n`), on.stdout);

    const status = await cli(home, ["router", "status"]);
    // The warning never changes the exit status: the router itself is healthy.
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /claude\.ai login is still saved/);
    assert.ok(status.stdout.includes(`  ${path.join(profile, "home")}\n`), status.stdout);

    const off = await cli(home, ["router", "off"]);
    assert.equal(off.status, 0, off.stderr);
    assert.doesNotMatch(off.stdout, /claude\.ai login/);
  });

  it("lists a directory once when CLAUDE_CONFIG_DIR is ~/.claude, and stays quiet for MCP-only stores", async () => {
    const home = newHome({});
    const dotClaude = path.join(home, ".claude");
    const profile = path.join(home, "Library/Application Support/orca/claude-profiles/p1");
    fs.mkdirSync(path.join(profile, "home"), { recursive: true });
    fs.writeFileSync(path.join(profile, "profile.json"), "{}");
    fs.writeFileSync(path.join(profile, "home", ".credentials.json"), JSON.stringify({ mcpOAuth: { "example|0": { accessToken: "fake-mcp" } } }));
    fs.writeFileSync(path.join(dotClaude, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake-access" } }));

    const on = await cli(home, ["router", "onboard", router.url, "--on"], `${KEY}\n`, { CLAUDE_CONFIG_DIR: dotClaude });
    assert.equal(on.status, 0, on.stderr);
    assert.equal(on.stdout.split(`  ${dotClaude}\n`).length - 1, 1, on.stdout);
    assert.equal(on.stdout.includes(path.join(profile, "home")), true); // listed as a routed settings file
    assert.equal(on.stdout.includes(`  ${path.join(profile, "home")}\n`), false, on.stdout); // but not as a login

    const status = await cli(home, ["router", "status"], "", { CLAUDE_CONFIG_DIR: dotClaude });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout.split(`  ${dotClaude}\n`).length - 1, 1, status.stdout);
  });

  it("asks the Keychain for a directory that names an account, and stays quiet when its item does not exist", async () => {
    const home = newHome({});
    const profile = path.join(home, "Library/Application Support/orca/claude-profiles/p1");
    fs.mkdirSync(path.join(profile, "home"), { recursive: true });
    fs.writeFileSync(path.join(profile, "profile.json"), "{}");
    // An account is named, so the real `security` is asked for an item named after this unique scratch path: always 44.
    fs.writeFileSync(path.join(profile, "home", ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "someone@example.com" } }));

    const on = await cli(home, ["router", "onboard", router.url, "--on"], `${KEY}\n`);
    assert.equal(on.status, 0, on.stderr);
    assert.doesNotMatch(on.stdout, /claude\.ai login is still saved|could not ask the Keychain/);
  });

  it("keeps what to restore when a later settings file cannot be written", async () => {
    const original = { env: { [ENV_URL]: "https://gateway.example", [ENV_KEY]: "corp" } };
    const home = newHome(original);
    const profile = path.join(home, "Library/Application Support/orca/claude-profiles/p1");
    fs.mkdirSync(path.join(profile, "home"), { recursive: true });
    fs.writeFileSync(path.join(profile, "profile.json"), "{}");
    fs.chmodSync(path.join(profile, "home"), 0o500);

    const on = await cli(home, ["router", "onboard", router.url, "--on"], `${KEY}\n`);
    assert.equal(on.status, 1);
    assert.equal(settingsOf(home).env[ENV_URL], router.url);

    fs.chmodSync(path.join(profile, "home"), 0o700);
    const again = await cli(home, ["router", "on"]);
    assert.equal(again.status, 0, again.stderr);
    const off = await cli(home, ["router", "off"]);
    assert.equal(off.status, 0, off.stderr);
    assert.deepEqual(settingsOf(home), original);
  });

  it("writes through a symlinked settings.json and keeps it a symlink", async () => {
    const home = newHome();
    const dotfile = path.join(home, "dotfiles-settings.json");
    fs.writeFileSync(dotfile, JSON.stringify({ model: "opus" }));
    const link = path.join(home, ".claude", "settings.json");
    fs.symlinkSync(dotfile, link);

    assert.equal((await cli(home, ["router", "onboard", router.url, "--on"], `${KEY}\n`)).status, 0);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(JSON.parse(fs.readFileSync(dotfile, "utf8")).env[ENV_URL], router.url);

    assert.equal((await cli(home, ["router", "off"])).status, 0);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(dotfile, "utf8")), { model: "opus" });
  });

  it("re-onboarding while on switches every file and still restores the original", async () => {
    const rotated = await startFakeRouter({ key: KEY2 });
    try {
      const original = { env: { [ENV_URL]: "https://gateway.example" } };
      const home = newHome(original);
      assert.equal((await cli(home, ["router", "onboard", router.url, "--on"], `${KEY}\n`)).status, 0);
      const second = await cli(home, ["router", "onboard", rotated.url], `${KEY2}\n`);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(settingsOf(home).env[ENV_URL], rotated.url);
      assert.equal(settingsOf(home).env[ENV_KEY], KEY2);
      assert.equal((await cli(home, ["router", "off"])).status, 0);
      assert.deepEqual(settingsOf(home), original);
    } finally {
      await close(rotated.server);
    }
  });

  it("status flags settings that still point at an older router", async () => {
    const home = newHome({});
    assert.equal((await cli(home, ["router", "onboard", router.url, "--on"], `${KEY}\n`)).status, 0);
    const state = path.join(home, "state", "router.json");
    const saved = JSON.parse(fs.readFileSync(state, "utf8"));
    fs.writeFileSync(state, JSON.stringify({ ...saved, url: "http://127.0.0.1:9" }));
    const status = await cli(home, ["router", "status"]);
    assert.equal(status.status, 1);
    assert.match(status.stdout, /older router address or key/);
  });

  it("refuses `router on` while the router is down, leaving settings untouched", async () => {
    const down = await startFakeRouter();
    const home = newHome({ model: "opus" });
    assert.equal((await cli(home, ["router", "onboard", down.url], `${KEY}\n`)).status, 0);
    await close(down.server);
    const result = await cli(home, ["router", "on"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /nothing was changed/);
    assert.deepEqual(settingsOf(home), { model: "opus" });
  });

  // A real terminal: the key typed at the prompt must not be echoed. The input is
  // delayed so it arrives after readline has put the terminal in raw mode.
  it("does not echo the key typed at the prompt", { skip: !fs.existsSync("/usr/bin/script") }, async () => {
    const home = newHome({});
    const command = `sleep 2; printf '%s\\n' '${KEY}'`;
    const result = await run("/bin/sh", ["-c", `(${command}) | /usr/bin/script -q /dev/null "${process.execPath}" "${BIN}" router onboard ${router.url} --on`], home);
    assert.match(result.stdout, /router on/, result.stdout + result.stderr);
    assert.equal(result.stdout.includes(KEY), false);
  });
});
