#!/usr/bin/env node
// Checked before loading the CLI: an older `node` first on PATH would otherwise die
// on a stack trace from syntax and APIs it lacks, instead of saying what is wrong.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 11)) {
  process.stderr.write(`error: claude-auto-proxy needs Node.js 20.11 or newer, but ${process.execPath} is ${process.version}.\n`);
  process.stderr.write("Put a newer node first on PATH, or run it with one: /path/to/node $(command -v claude-auto-proxy) ...\n");
  process.exit(1);
}

const { main } = await import("../src/cli.js");
const code = await main(process.argv.slice(2));
// The daemon keeps running on its own listeners; every other command exits.
if (code !== null) process.exit(code);
