#!/usr/bin/env node
import { main } from "../src/cli.js";

const code = await main(process.argv.slice(2));
// The daemon keeps running on its own listeners; every other command exits.
if (code !== null) process.exit(code);
