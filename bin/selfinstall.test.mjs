#!/usr/bin/env node
/**
 * Tests for the self-install drift gate.
 *
 * THE LOAD-BEARING ONE IS `CODE matches install.sh`. Everything else here is
 * mechanics; that one is the reason the tool is not just `diff -r`. selfinstall
 * keeps a list of which files are code and which are per-project state, and a
 * second hand-maintained copy of a file list is the same defect the tool exists
 * to catch, one level up. So the list is READ BACK OUT OF install.sh and
 * compared, and this test goes red when someone adds a fifth tool to the copy
 * loop and not to CODE — which is the realistic way this rots.
 *
 * Run: node bin/selfinstall.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE, INSTANCE, compare, sync } from "./selfinstall.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
let failures = 0;
const ok = (name, passed, detail = "") => {
  console.log(passed ? `PASS ${name}` : `FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  if (!passed) failures += 1;
};

// --- the list is install.sh's list, read from install.sh -------------------
const installSh = readFileSync(join(REPO, "install.sh"), "utf8");
const loop = installSh.match(/for f in ([^;]+); do/);
ok("install.sh still has a `for f in ... ; do` copy loop to read", loop !== null,
   "if the copy loop was restructured, this test must be re-pointed, not deleted");
if (loop) {
  const declared = loop[1].trim().split(/\s+/).sort();
  ok("CODE matches install.sh's copy loop exactly",
     JSON.stringify(declared) === JSON.stringify([...CODE].sort()),
     `install.sh=[${declared}] CODE=[${[...CODE].sort()}]`);
}
ok("CODE and INSTANCE are disjoint",
   CODE.every((f) => !INSTANCE.includes(f)),
   "a file that is both copied and per-project state cannot be either");

// --- a scratch tree, so the assertions are about behaviour not this repo ---
const work = mkdtempSync(join(tmpdir(), "selfinstall-test-"));
const seed = (binBody, opsBody, file = "run.mjs") => {
  const root = mkdtempSync(join(work, "r-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "ops", "foreman"), { recursive: true });
  for (const f of CODE) {
    writeFileSync(join(root, "bin", f), f === file ? binBody : `shared ${f}\n`);
    if (opsBody !== null) writeFileSync(join(root, "ops", "foreman", f), f === file ? opsBody : `shared ${f}\n`);
  }
  return root;
};
const stateOf = (rows, f) => rows.find((r) => r.file === f)?.state;

const identical = seed("same\n", "same\n");
ok("identical trees report `same` for every file",
   compare(identical).every((r) => r.state === "same"));

const drifted = seed("new body\n", "old body\n");
ok("a byte difference reports `drifted`", stateOf(compare(drifted), "run.mjs") === "drifted");
ok("and only for the file that differs",
   compare(drifted).filter((r) => r.state !== "same").length === 1);

const missingRoot = seed("body\n", "body\n");
rmSync(join(missingRoot, "ops", "foreman", "run.mjs"));
ok("an absent destination reports `missing`, not `same`",
   stateOf(compare(missingRoot), "run.mjs") === "missing",
   "`missing` and `drifted` are different repairs — one is a fresh install, one is a stale one");

// --- sync ------------------------------------------------------------------
const synced = seed("new body\n", "old body\n");
const done = sync(synced);
ok("sync reports exactly the files it copied", JSON.stringify(done) === JSON.stringify(["run.mjs"]));
ok("sync makes the destination byte-identical to the source",
   readFileSync(join(synced, "ops", "foreman", "run.mjs"), "utf8") === "new body\n");
ok("sync is idempotent — a second run copies nothing", sync(synced).length === 0);

// THE ONE THAT MATTERS: sync must never touch per-project state. This is the
// data loss install.sh refuses, and a `cp -r` would commit it.
const withState = seed("new body\n", "old body\n");
for (const f of INSTANCE) writeFileSync(join(withState, "ops", "foreman", f), `MINE ${f}\n`);
sync(withState);
ok("sync leaves config.json, prompt.txt and RULES.md untouched",
   INSTANCE.every((f) => readFileSync(join(withState, "ops", "foreman", f), "utf8") === `MINE ${f}\n`),
   "overwriting a project's own config from the template is the loss install.sh exists to prevent");

rmSync(work, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
