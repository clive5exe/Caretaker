#!/usr/bin/env node
/**
 * Step 4: a review from Warp's review-pr records the board's reviewer gate,
 * but only after Warp's own validator accepts it. A real install (install.sh),
 * a real board, Warp's real validator.
 *
 * Run: node bin/review-gate.test.mjs
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewGateError, reviewGate, verdictOf } from "./review-gate.mjs";
import { build } from "./vendor.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};
const refused = async (p, code) => p.then(() => "recorded", (e) => (e instanceof ReviewGateError && e.code === code ? true : `${e.code}: ${e.message}`));

const T = mkdtempSync(join(tmpdir(), "review-gate-test-"));
try {
  const ws = join(T, "repo");
  spawnSync("git", ["init", "-q", ws]);
  const inst = spawnSync("bash", [join(ROOT, "install.sh"), ws, "Demo"], { encoding: "utf8" });
  ok("the board installs", inst.status === 0, inst.stderr);
  const built = join(T, "built");
  build(built);
  cpSync(built, ws, { recursive: true });
  const boardFile = join(ws, "docs/board.json");
  const b = JSON.parse(readFileSync(boardFile, "utf8"));
  b.phases[0].tasks.push({ id: "T-002", title: "reviewed by itself", owner: "review-pr", est: "1h", status: "doing", deps: [], ac: "x" });
  writeFileSync(boardFile, `${JSON.stringify(b, null, 2)}\n`);

  writeFileSync(join(ws, "raw.diff"), "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a + b\n+    return a - b\n");
  spawnSync("python3", [".agents/skills/review-pr/scripts/annotate_diff.py", "--input", "raw.diff", "--output", "pr_diff.txt"], { cwd: ws });
  const reject = { verdict: "REJECT", body: "🚨 add() subtracts.\nFound: 1 critical, 0 important, 0 suggestions\nDisposition: Request changes", comments: [{ path: "app.py", line: 2, side: "RIGHT", body: "🚨 [CRITICAL] add() subtracts." }] };
  const approve = { verdict: "APPROVE", body: "No findings.\nFound: 0 critical, 0 important, 0 suggestions\nDisposition: Approve", comments: [] };
  const gate = () => JSON.parse(readFileSync(boardFile, "utf8")).phases[0].tasks.find((t) => t.id === "T-001").gate?.reviewer;

  ok("APPROVE maps to pass, REJECT to fail", verdictOf(approve).verdict === "pass" && verdictOf(reject).verdict === "fail");
  ok("the note carries the Found line and the PR", verdictOf(reject, "https://x/pull/3").note === "review-pr REJECT: Found: 1 critical, 0 important, 0 suggestions (https://x/pull/3)");

  writeFileSync(join(ws, "review.json"), JSON.stringify(reject));
  const r = await reviewGate({ reviewPath: "review.json", diffPath: "pr_diff.txt", task: "T-001", pr: "https://x/pull/3", configPath: "ops/caretaker/config.json", workspace: ws, via: "ci" });
  const g = gate();
  ok("a REJECT records reviewer fail on the board", r.verdict === "fail" && g?.verdict === "fail", JSON.stringify(g));
  ok("recorded by review-pr, via ci", g?.by === "review-pr" && g?.via === "ci");

  writeFileSync(join(ws, "review.json"), JSON.stringify(approve));
  await reviewGate({ reviewPath: "review.json", diffPath: "pr_diff.txt", task: "T-001", configPath: "ops/caretaker/config.json", workspace: ws, via: "ci" });
  const g2 = gate();
  ok("a later APPROVE records pass and keeps the fail in history", g2?.verdict === "pass" && g2?.history?.[0]?.verdict === "fail", JSON.stringify(g2));

  // A comment on a line that is not in the diff: Warp's validator rejects it.
  writeFileSync(join(ws, "review.json"), JSON.stringify({ ...reject, comments: [{ path: "app.py", line: 99, side: "RIGHT", body: "🚨 [CRITICAL] nowhere" }] }));
  ok("a review Warp's validator rejects records nothing", (await refused(reviewGate({ reviewPath: "review.json", diffPath: "pr_diff.txt", task: "T-001", configPath: "ops/caretaker/config.json", workspace: ws }), "INVALID_REVIEW")) === true && gate().verdict === "pass");

  writeFileSync(join(ws, "review.json"), JSON.stringify(approve));
  ok("a task that is not on the board is refused", (await refused(reviewGate({ reviewPath: "review.json", diffPath: "pr_diff.txt", task: "T-404", configPath: "ops/caretaker/config.json", workspace: ws }), "REFUSED")) === true);
  ok("a task owned by review-pr is refused: nobody reviews their own work", (await refused(reviewGate({ reviewPath: "review.json", diffPath: "pr_diff.txt", task: "T-002", configPath: "ops/caretaker/config.json", workspace: ws }), "REFUSED")) === true);

  const cli = spawnSync(process.execPath, [join(ROOT, "bin/review-gate.mjs"), "--review", "review.json", "--diff", "pr_diff.txt", "--task", "T-001", "--workspace", ws], { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "" } });
  ok("the CLI records and says what", cli.status === 0 && /T-001 reviewer pass — review-pr APPROVE/.test(cli.stdout), cli.stdout + cli.stderr);
  ok("from a terminal it is recorded via cli", gate().via === "cli");
} finally {
  rmSync(T, { recursive: true, force: true });
}

console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
