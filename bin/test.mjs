#!/usr/bin/env node
/**
 * RUN EVERY GATE IN THIS REPO.
 *
 * WHY THIS DID NOT EXIST UNTIL 2026-09-06, which is the finding rather than the
 * omission: there were eight `*.test.mjs` files in bin/ and NOTHING ran them.
 * Measured before writing this — `grep -rn "test.mjs" CLAUDE.md README.md
 * RULES.md bin/loop.sh` returns nothing, and there is no package.json, so there
 * was no documented way to run them and no unattended path that did. A repo
 * whose entire product is "a gate you cannot talk your way past" had eight
 * gates that only ran when somebody remembered their filenames.
 *
 * DISCOVERY, NOT A LIST. The files are found by reading bin/, so adding
 * `foo.test.mjs` is enough to have it run. A hand-maintained list here would be
 * the same defect selfinstall.mjs exists to catch, one level up.
 *
 * SELF-INSTALL IS RUN AS A GATE TOO, not as a test file, because it asserts
 * something about the WORKING TREE rather than about a function: that
 * ops/foreman/ — the copy this repo actually executes — matches bin/. It is the
 * one check here that can be red without any code being wrong, and the message
 * says what to do about it.
 *
 * SERIAL, and deliberately. Several of these boot containers or bind ports.
 *
 * Run: node bin/test.mjs [--only NAME]
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;

const files = readdirSync(HERE)
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => !only || f.includes(only))
  .sort();

const run = (label, argv) => {
  process.stdout.write(`\n=== ${label} ===\n`);
  const r = spawnSync(process.execPath, argv, { cwd: path.resolve(HERE, ".."), stdio: "inherit" });
  return r.status === 0;
};

const results = [];
if (!only || "selfinstall".includes(only)) {
  results.push(["selfinstall (working tree)", run("selfinstall — ops/foreman/ vs bin/", [path.join(HERE, "selfinstall.mjs"), "check"])]);
}
for (const f of files) results.push([f, run(f, [path.join(HERE, f)])]);

const failed = results.filter(([, passed]) => !passed);
process.stdout.write(`\n${"=".repeat(60)}\n`);
for (const [name, passed] of results) process.stdout.write(`  ${passed ? "PASS" : "FAIL"}  ${name}\n`);
process.stdout.write(
  failed.length
    ? `\n${failed.length} of ${results.length} FAILED: ${failed.map(([n]) => n).join(", ")}\n`
    : `\nall ${results.length} green\n`,
);
process.exit(failed.length ? 1 : 0);
