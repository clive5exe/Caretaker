#!/usr/bin/env node
/**
 * REVIEW → GATE (docs/plan.md step 4). A review from Warp's review-pr skill
 * records the board's `reviewer` gate for a task:
 *
 *     APPROVE -> reviewer pass      REJECT -> reviewer fail
 *
 * recorded `by: "review-pr"`, `via: "ci"` under GitHub Actions and `"cli"`
 * otherwise, with the review's "Found: ..." line and the PR as the note.
 *
 * Nothing here judges the review. It is checked first with WARP'S OWN
 * validator (.agents/skills/review-pr/scripts/validate_review_json.py, against
 * the annotated diff), and a review Warp's validator rejects records nothing.
 * The review is then the verdict of the model that wrote it, which is not the
 * builder: nobody closes their own work, so a task OWNED by "review-pr" is
 * refused.
 *
 * The board is the installed one beside --config (ops/caretaker/board.mjs), so
 * the verdict goes through the same rules as `board.mjs reviewer`.
 *
 * Usage:
 *   node bin/review-gate.mjs --review review.json --diff pr_diff.txt --task T-1
 *        [--pr URL] [--config ops/caretaker/config.json] [--workspace .]
 * Exit: 0 recorded, 1 refused (the reason is printed), 2 misuse.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export class ReviewGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReviewGateError";
    this.code = code;
  }
}

export const REVIEWER = "review-pr";
const VALIDATOR = ".agents/skills/review-pr/scripts/validate_review_json.py";

/** The review's pass/fail and a one-line note. Throws on anything else. */
export function verdictOf(review, pr = null) {
  if (!review || typeof review !== "object" || Array.isArray(review)) throw new ReviewGateError("BAD_REVIEW", "review.json is not a JSON object");
  const v = { APPROVE: "pass", REJECT: "fail" }[review.verdict];
  if (!v) throw new ReviewGateError("BAD_REVIEW", `review verdict ${JSON.stringify(review.verdict)} is neither APPROVE nor REJECT`);
  const found = /Found:[^\n]*/.exec(String(review.body ?? ""))?.[0]?.trim() ?? `${(review.comments ?? []).length} inline comment(s)`;
  return { verdict: v, note: `${REVIEWER} ${review.verdict}: ${found}${pr ? ` (${pr})` : ""}`.slice(0, 500) };
}

/** Warp's validator, from the workspace's installed skill. Returns null when it accepts. */
export function warpRejects({ workspace, reviewPath, diffPath, run = spawnSync }) {
  const script = join(workspace, VALIDATOR);
  if (!existsSync(script)) throw new ReviewGateError("NO_VALIDATOR", `${VALIDATOR} is not installed in ${workspace}`);
  const r = run("python3", [script, "--review-json", reviewPath, "--diff", diffPath], { cwd: workspace, encoding: "utf8" });
  if (r.error) throw new ReviewGateError("NO_PYTHON", `could not run Warp's validator: ${r.error.message}`);
  return r.status === 0 ? null : `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || `exit ${r.status}`;
}

/** Validate, map, record. Returns { verdict, note, task }. */
export async function reviewGate({ reviewPath, diffPath, task, pr = null, configPath = "ops/caretaker/config.json", workspace = ".", via = process.env.GITHUB_ACTIONS ? "ci" : "cli" }) {
  const ws = resolve(workspace);
  const rp = resolve(ws, reviewPath);
  const dp = resolve(ws, diffPath);
  for (const [what, p] of [["review", rp], ["diff", dp]]) if (!existsSync(p)) throw new ReviewGateError("MISSING", `the ${what} ${p} does not exist`);
  const rejected = warpRejects({ workspace: ws, reviewPath: rp, diffPath: dp });
  if (rejected) throw new ReviewGateError("INVALID_REVIEW", `Warp's validator rejected the review, so no verdict is recorded:\n${rejected}`);
  let review;
  try {
    review = JSON.parse(readFileSync(rp, "utf8"));
  } catch (e) {
    throw new ReviewGateError("BAD_REVIEW", `review.json is not JSON: ${e.message}`);
  }
  const { verdict, note } = verdictOf(review, pr);

  const cfgAbs = resolve(ws, configPath);
  const boardPath = join(dirname(cfgAbs), "board.mjs");
  if (!existsSync(boardPath)) throw new ReviewGateError("NO_BOARD", `no board.mjs beside ${cfgAbs}`);
  const board = await import(pathToFileURL(boardPath).href);
  if (board.API_VERSION !== 1) throw new ReviewGateError("OLD_BOARD", `${boardPath} predates API_VERSION 1; upgrade the installed tools`);
  const ctx = board.loadConfig(cfgAbs, dirname(cfgAbs));
  const res = board.mutate(ctx, (d) => {
    const hit = board.find(d, task);
    if (!hit) return { ok: false, error: `no task ${task} on the board` };
    if (String(hit.t.owner ?? "") === REVIEWER) return { ok: false, error: `${task} is owned by ${REVIEWER}; nobody reviews their own work` };
    return board.recordVerdict(d, task, "reviewer", verdict, note, { by: REVIEWER, via });
  });
  if (!res?.ok) throw new ReviewGateError("REFUSED", res?.error ?? "the board refused the verdict");
  return { verdict, note, task };
}

/* -------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const KEYS = ["review", "diff", "task", "pr", "config", "workspace"];
  const f = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || !KEYS.includes(k) || argv[i + 1] === undefined) {
      console.error("usage: review-gate.mjs --review review.json --diff pr_diff.txt --task T-1 [--pr URL] [--config ops/caretaker/config.json] [--workspace .]");
      process.exit(2);
    }
    f[k] = argv[i + 1];
  }
  if (!f.review || !f.diff || !f.task) {
    console.error("review-gate: --review, --diff and --task are required");
    process.exit(2);
  }
  try {
    const r = await reviewGate({ reviewPath: f.review, diffPath: f.diff, task: f.task, pr: f.pr ?? null, configPath: f.config, workspace: f.workspace });
    console.log(`[review-gate] ${r.task} reviewer ${r.verdict} — ${r.note}`);
  } catch (e) {
    console.error(`[review-gate] ${e.message}`);
    process.exit(e instanceof ReviewGateError ? 1 : 2);
  }
}
