#!/usr/bin/env node
/**
 * SELF-INSTALL DRIFT — the copy this repo RUNS versus the copy it SHIPS.
 *
 * foreman dogfoods itself: `install.sh` copies bin/ into <target>/ops/foreman/,
 * and this repo is one of those targets. So there are two copies of every tool,
 * and only one of them is ever edited.
 *
 * THE FAILURE THIS EXISTS TO CATCH, found 2026-09-06 and measured before it was
 * written rather than after:
 *
 *   $ diff bin/run.mjs ops/foreman/run.mjs | wc -l
 *   105
 *
 * ops/foreman/run.mjs predates commit 7d63587 ("tokens: record the breakdown"),
 * so it does not know the keys `in`, `cached`, `write`, `out` or `turns`. The
 * repo whose whole claim is that it governs its own delivery was running a build
 * that could not report its own token breakdown, and nothing said so. Not a
 * hypothetical: `node ops/foreman/dashboard.mjs` is what writes docs/board.html.
 *
 * WHY IT DRIFTED, and it is not carelessness. install.sh REFUSES to overwrite an
 * existing ops/foreman — its `REFUSING — $DEST already exists` branch — because
 * copying over a live board is
 * the one mistake that loses work. That refusal is correct. Its consequence is
 * that the self-install freezes at the moment of first install and every later
 * improvement to bin/ stops at the door. A refusal with no paired update path is
 * how a copy goes stale silently.
 *
 * So this is that paired path, and it is deliberately TWO commands rather than
 * one:
 *
 *   check   report the drift, exit 1 if any. Safe. What a gate runs.
 *   sync    copy bin/ -> ops/foreman/ for CODE ONLY.
 *
 * WHAT SYNC WILL NOT TOUCH, and this is the whole reason it is not `cp -r`:
 * config.json, prompt.txt and RULES.md are INSTANCE state. install.sh generates
 * config.json per project (its `sed` over config.example.json rewrites the name)
 * and prompt.txt is
 * the project's own prompt. Overwriting those from the template is exactly the
 * data loss install.sh refuses. `sync` copies the four executables install.sh
 * names in its `for f in ...` copy loop and nothing else, and `check` reports the rest as INSTANCE so a
 * reader is not left wondering whether it was missed.
 *
 * Run: node bin/selfinstall.mjs check | sync
 */
import { readFileSync, copyFileSync, existsSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// THE LIST IS install.sh's LIST. Kept as one array and asserted against
// install.sh by selfinstall.test.mjs, because a second hand-maintained copy of
// a file list is the same defect one level up.
export const CODE = ["board.mjs", "dashboard.mjs", "run.mjs", "loop.sh"];
export const INSTANCE = ["config.json", "prompt.txt", "RULES.md"];

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** @returns {{file: string, state: "same"|"drifted"|"missing"}[]} */
export function compare(root = ROOT) {
  return CODE.map((file) => {
    const src = path.join(root, "bin", file);
    const dst = path.join(root, "ops", "foreman", file);
    if (!existsSync(dst)) return { file, state: "missing", src, dst };
    return { file, state: sha(src) === sha(dst) ? "same" : "drifted", src, dst };
  });
}

export function sync(root = ROOT) {
  const done = [];
  for (const r of compare(root)) {
    if (r.state === "same") continue;
    copyFileSync(r.src, r.dst);
    if (r.file.endsWith(".sh")) chmodSync(r.dst, 0o755);
    done.push(r.file);
  }
  return done;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] ?? "check";
  if (cmd !== "check" && cmd !== "sync") {
    console.log("usage: selfinstall.mjs [check|sync]");
    process.exit(2);
  }
  if (cmd === "sync") {
    const done = sync();
    console.log(done.length ? `synced: ${done.join(", ")}` : "nothing to sync");
  }
  const rows = compare();
  for (const r of rows) console.log(`  ${r.state.padEnd(8)} ops/foreman/${r.file}`);
  for (const f of INSTANCE) console.log(`  instance ops/foreman/${f}  (never synced — per-project state)`);
  const bad = rows.filter((r) => r.state !== "same");
  if (bad.length) {
    console.log(
      `\nDRIFTED: ${bad.map((r) => r.file).join(", ")}. ops/foreman/ is what this repo RUNS ` +
        "(see CLAUDE.md's Board and Dashboard lines), bin/ is what it ships. " +
        "Run `node bin/selfinstall.mjs sync`.",
    );
    process.exit(1);
  }
  console.log("\nself-install is current.");
}
