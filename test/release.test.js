import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  bumpVersion,
  classifyCommit,
  compareVersions,
  planRelease,
  renderNotes,
  updateFormula
} from "../scripts/release.mjs";

const commit = (subject, body = "", hash = "abcdef1234567890") => ({ hash, subject, body });

describe("classifyCommit", () => {
  it("maps conventional types to bumps", () => {
    assert.equal(classifyCommit(commit("feat: add onboarding")).bump, "minor");
    assert.equal(classifyCommit(commit("fix(relay): close sockets")).bump, "patch");
    assert.equal(classifyCommit(commit("docs: typo")).bump, "none");
    assert.equal(classifyCommit(commit("ci: cache npm")).bump, "none");
  });

  it("treats ! and BREAKING CHANGE as major", () => {
    assert.equal(classifyCommit(commit("feat!: drop node 20")).bump, "major");
    assert.equal(classifyCommit(commit("refactor: config", "BREAKING CHANGE: new path")).bump, "major");
  });

  it("releases unconventional messages as a patch", () => {
    assert.deepEqual(classifyCommit(commit("Update stuff")), { type: null, bump: "patch", title: "Update stuff" });
  });
});

describe("versions", () => {
  it("bumps each part and resets the lower ones", () => {
    assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
    assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
    assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  });

  it("compares numerically, not as strings", () => {
    assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
    assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
  });

  it("rejects malformed versions", () => {
    assert.throws(() => bumpVersion("1.2", "patch"), /not a release version/);
    assert.throws(() => bumpVersion("1.2.3", "huge"), /unknown bump/);
  });
});

describe("planRelease", () => {
  it("releases package.json's version when there is no tag yet", () => {
    const plan = planRelease({ previousTag: null, packageVersion: "0.1.0", commits: [commit("feat: x")] });
    assert.deepEqual([plan.release, plan.version, plan.bump], [true, "0.1.0", "initial"]);
  });

  it("takes the highest bump since the last tag", () => {
    const plan = planRelease({
      previousTag: "v0.1.0",
      packageVersion: "0.1.0",
      commits: [commit("fix: a"), commit("feat: b"), commit("docs: c")]
    });
    assert.deepEqual([plan.release, plan.version, plan.bump], [true, "0.2.0", "minor"]);
  });

  it("skips when only non-releasing commits landed", () => {
    const plan = planRelease({ previousTag: "v0.2.0", packageVersion: "0.2.0", commits: [commit("docs: a"), commit("ci: b")] });
    assert.equal(plan.release, false);
  });

  it("ignores its own release commits", () => {
    const plan = planRelease({
      previousTag: "v0.2.0",
      packageVersion: "0.2.0",
      commits: [commit("chore(release): v0.2.0"), commit("chore(release): update Homebrew formula for v0.2.0")]
    });
    assert.equal(plan.release, false);
    assert.equal(plan.commits.length, 0);
  });

  it("honors a version raised by hand in package.json", () => {
    const plan = planRelease({ previousTag: "v0.2.0", packageVersion: "1.0.0", commits: [commit("fix: a")] });
    assert.equal(plan.version, "1.0.0");
  });

  it("skips with no commits at all", () => {
    assert.equal(planRelease({ previousTag: "v0.2.0", packageVersion: "0.2.0", commits: [] }).release, false);
  });
});

describe("renderNotes", () => {
  it("groups changes and links the compare view", () => {
    const plan = planRelease({ previousTag: "v0.1.0", packageVersion: "0.1.0", commits: [commit("feat: onboarding"), commit("fix: leak")] });
    const notes = renderNotes(plan);
    assert.match(notes, /## Features\n\n- onboarding \(abcdef1\)/);
    assert.match(notes, /## Fixes and other changes\n\n- leak/);
    assert.match(notes, /compare\/v0\.1\.0\.\.\.v0\.2\.0/);
  });

  it("says initial release when nothing is grouped", () => {
    assert.match(renderNotes({ version: "0.1.0", previous: null, commits: [] }), /Initial release\.[\s\S]*commits\/v0\.1\.0/);
  });
});

describe("updateFormula", () => {
  const formula = fs.readFileSync(path.resolve(import.meta.dirname, "..", "Formula", "claude-auto-proxy.rb"), "utf8");
  const sha = "a".repeat(64);

  it("points url and sha256 at the new tag", () => {
    const next = updateFormula(formula, "0.3.1", sha);
    assert.match(next, /archive\/refs\/tags\/v0\.3\.1\.tar\.gz"/);
    assert.match(next, new RegExp(`sha256 "${sha}"`));
    assert.match(next, /head "https:\/\/github\.com\/choiyounggi\/claude-auto-proxy\.git"/);
  });

  it("rejects a bad checksum or a formula without the lines", () => {
    assert.throws(() => updateFormula(formula, "0.3.1", "nope"), /not a sha256/);
    assert.throws(() => updateFormula("class X; end", "0.3.1", sha), /no url\/sha256/);
  });
});
