import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { applyBlock, BEGIN, blockHosts, END, flushDns, hasBlock, stripBlock, writeHosts } from "../src/hosts.js";
import { scratchDir } from "./helpers.js";

const ORIGINAL = "127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n::1             localhost\n";

describe("hosts block", () => {
  it("appends a block with IPv4 and IPv6 entries and keeps existing lines", () => {
    const text = applyBlock(ORIGINAL, ["api.anthropic.com", "claude.ai"]);
    assert.ok(text.startsWith(ORIGINAL));
    assert.match(text, /127\.0\.0\.1 api\.anthropic\.com\n::1 api\.anthropic\.com/);
    assert.match(text, /::1 claude\.ai\n# <<< claude-auto-proxy <<<\n$/);
    assert.deepEqual(blockHosts(text), ["api.anthropic.com", "claude.ai"]);
  });

  it("is idempotent and replaces the previous block", () => {
    const once = applyBlock(ORIGINAL, ["api.anthropic.com"]);
    const twice = applyBlock(once, ["claude.ai"]);
    assert.equal(twice.split(BEGIN).length, 2);
    assert.deepEqual(blockHosts(twice), ["claude.ai"]);
  });

  it("strips back to the original text", () => {
    assert.equal(stripBlock(applyBlock(ORIGINAL, ["claude.ai"])), ORIGINAL);
  });

  it("handles a file without a trailing newline or with no content", () => {
    assert.match(applyBlock("127.0.0.1 localhost", ["claude.ai"]), /^127\.0\.0\.1 localhost\n# >>>/);
    assert.ok(applyBlock("", ["claude.ai"]).startsWith(BEGIN));
  });

  it("reports absence", () => {
    assert.equal(hasBlock(ORIGINAL), false);
    assert.deepEqual(blockHosts(ORIGINAL), []);
    assert.equal(stripBlock(ORIGINAL), ORIGINAL);
  });

  it("refuses to guess when the end marker is missing", () => {
    const broken = `${ORIGINAL}${BEGIN}\n127.0.0.1 claude.ai\n10.0.0.1 my-own-entry\n`;
    assert.throws(() => stripBlock(broken), /without an end marker/);
    assert.throws(() => applyBlock(broken, ["claude.ai"]), /without an end marker/);
  });

  it("ignores an end marker that comes before the start marker", () => {
    const text = `${END}\n${ORIGINAL}`;
    assert.equal(hasBlock(text), false);
  });
});

describe("writeHosts", () => {
  const dir = scratchDir();
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("backs up, replaces atomically and leaves the file world-readable", () => {
    const file = path.join(dir, "hosts");
    fs.writeFileSync(file, ORIGINAL);
    writeHosts(applyBlock(ORIGINAL, ["claude.ai"]), { path: file });

    assert.equal(fs.readFileSync(`${file}.claude-auto-proxy.bak`, "utf8"), ORIGINAL);
    assert.ok(hasBlock(fs.readFileSync(file, "utf8")));
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    assert.equal(fs.existsSync(`${file}.claude-auto-proxy.tmp`), false);
  });

  it("fails without touching anything when the file is missing", () => {
    const file = path.join(dir, "missing");
    assert.throws(() => writeHosts("x", { path: file }), /ENOENT/);
    assert.equal(fs.existsSync(file), false);
  });
});

describe("flushDns", () => {
  it("runs both flush commands and swallows failures", () => {
    const calls = [];
    flushDns((command, args) => {
      calls.push([command, ...args].join(" "));
      throw new Error("not permitted");
    });
    assert.deepEqual(calls, ["/usr/bin/dscacheutil -flushcache", "/usr/bin/killall -HUP mDNSResponder"]);
  });
});
