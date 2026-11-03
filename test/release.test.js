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

  it("releases nothing for a merge commit, whatever it merges", () => {
    assert.equal(classifyCommit(commit("Merge pull request #12 from someone/feature")).bump, "none");
    assert.equal(classifyCommit(commit("Merge branch 'main' into topic")).bump, "none");
    assert.equal(classifyCommit(commit("Merge remote-tracking branch 'origin/main'")).bump, "none");
    // Only the merge itself is ignored: the merged commits are listed and classified on their own.
    assert.equal(classifyCommit(commit("Merged the parser: faster")).bump, "patch");
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

  it("skips a range of merge commits around non-releasing work", () => {
    const plan = planRelease({ previousTag: "v0.2.0", packageVersion: "0.2.0",
      commits: [commit("Merge pull request #3 from choiyounggi/ci"), commit("ci: b"), commit("Merge branch 'main' of github.com:x/y")] });
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
    assert.match(notes, /## Fixes\n\n- leak/);
    assert.match(notes, /compare\/v0\.1\.0\.\.\.v0\.2\.0/);
  });

  it("lists every commit since the last tag by kind, leaving out release and merge commits", () => {
    const commits = [
      commit("feat!: drop node 20", "", "a00000000"),
      commit("feat: onboarding", "", "b00000000"),
      commit("fix(relay): close sockets", "", "c00000000"),
      commit("refactor: split cli", "", "d00000000"),
      commit("Update stuff", "", "e00000000"),
      commit("docs: README", "", "f00000000"),
      commit("ci: publish with trusted publishing", "", "100000000"),
      commit("chore(release): update Homebrew formula for v0.1.0", "", "200000000"),
      commit("Merge pull request #3 from someone/topic", "", "300000000"),
      commit("test: more cases", "", "400000000")
    ];
    const notes = renderNotes(planRelease({ previousTag: "v0.1.0", packageVersion: "0.1.0", commits }));
    assert.deepEqual([...notes.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
      ["Breaking changes", "Features", "Fixes", "Other changes", "Documentation", "Maintenance"]);
    assert.match(notes, /## Other changes\n\n- split cli \(d000000\)\n- Update stuff \(e000000\)\n/);
    assert.match(notes, /## Documentation\n\n- README \(f000000\)\n/);
    assert.match(notes, /## Maintenance\n\n- publish with trusted publishing \(1000000\)\n- more cases \(4000000\)\n/);
    assert.doesNotMatch(notes, /\(2000000\)|\(3000000\)|Merge pull request/);
  });

  it("leaves out only the bot's release commits, also when handed to renderNotes directly", () => {
    const listed = [
      commit("chore(release): v0.4.2", "", "500000000"),
      commit("chore(release): update Homebrew formula for v0.4.2", "", "600000000"),
      commit("chore(release): switch to trusted publishing (#16)", "", "700000000")
    ].map((c) => ({ ...c, ...classifyCommit(c) }));
    const notes = renderNotes({ version: "0.4.2", previous: "0.4.1", commits: listed });
    assert.match(notes, /## Maintenance\n\n- switch to trusted publishing \(#16\) \(7000000\)\n/);
    assert.doesNotMatch(notes, /\(5000000\)|\(6000000\)/);
    // planRelease agrees: a human chore(release) commit stays in the range.
    assert.equal(planRelease({ previousTag: "v0.4.1", packageVersion: "0.4.1", commits: [commit("chore(release): switch to trusted publishing (#16)")] }).commits.length, 1);
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
