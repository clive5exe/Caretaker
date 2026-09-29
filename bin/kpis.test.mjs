#!/usr/bin/env node
/**
 * B-2 and B-4: estimates in tokens, calibrated from closed work with no human
 * input; and the delivery and AI KPIs, each from what was recorded.
 *
 * Delivery is measured on a scratch git repo with dated merges, a revert after
 * a merge (a failed change) and a revert on a branch before its merge (not one).
 *
 * Run: node bin/kpis.test.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ANTI_KPIS, ai, delivery, dollars, gitFacts, kpis, parseTokens, tokenEstimates } from "./kpis.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};
const TMP = mkdtempSync(join(tmpdir(), "kpis-test-"));

/* ------------------------------------------------------------ parseTokens */
ok("token estimates read as written", parseTokens("400k") === 400000 && parseTokens("1.2m") === 1200000 && parseTokens("5000") === 5000 && parseTokens(7) === 7 && parseTokens("400k tokens") === 400000);
ok("an unreadable estimate is null, not zero", parseTokens("lots") === null && parseTokens(undefined) === null);

/* -------------------------------------------------------------------- B-2 */
const T = (id, owner, status, extra = {}) => ({ id, title: id, owner, status, ...extra });
const BOARD = {
  phases: [{
    name: "P",
    tasks: [
      // backend: estimated 100k, took 150k -> factor 1.5; estimated 1d (8h) -> 150k/8h
      T("B1", "backend", "done", { estTokens: "100k", est: "1d" }),
      // devops: estimated 200k, took 100k -> factor 0.5; no hours
      T("D1", "devops", "done", { estTokens: "200k" }),
      T("B2", "backend", "doing", { estTokens: "40k" }),
      T("D2", "devops", "todo", { estTokens: "40k" }),
      T("X1", "design", "todo", { estTokens: "10k" }), // no design history: all closed work
      T("B3", "backend", "todo", { est: "4h" }), // hours only: converted at backend's rate
      T("N1", "nobody", "todo"), // no estimate at all
      T("Z1", "backend", "dropped", { estTokens: "999k" }),
    ],
  }],
};
const RUNS = [
  { task: "B1", tokens: 100_000, model: "big", in: 10_000, cached: 80_000, write: 0, out: 10_000 },
  { task: "B1", tokens: 50_000, model: "small", in: 5_000, cached: 40_000, write: 0, out: 5_000 },
  { task: "D1", tokens: 100_000, model: "big", in: 10_000, cached: 80_000, write: 0, out: 10_000 },
  { task: "B2", tokens: 5_000, model: "big", in: 1_000, cached: 3_000, write: 0, out: 1_000 },
];
{
  const e = tokenEstimates(BOARD, RUNS);
  const cal = Object.fromEntries(e.calibration.map((c) => [c.type, c]));
  ok("actuals come from the run log, per task type", cal.backend.factor === 1.5 && cal.devops.factor === 0.5 && cal.backend.closed === 1);
  ok("…and a tokens-per-hour rate where hours were estimated", cal.backend.tokensPerHour === 18750 && cal.devops.tokensPerHour === null);
  const o = Object.fromEntries(e.open.map((x) => [x.id, x]));
  ok("open work is re-estimated by its type's calibration", o.B2.estimate === 60000 && /backend calibration/.test(o.B2.basis) && o.D2.estimate === 20000);
  ok("a type with no history uses all closed work, and says so", o.X1.estimate === Math.round(10000 * (250 / 300)) && /all closed work; none for design/.test(o.X1.basis), JSON.stringify(o.X1));
  ok("an hours-only task is converted to tokens at its type's rate", o.B3.estimate === 75000 && /4h x 18750 tok\/h \(backend\)/.test(o.B3.basis), JSON.stringify(o.B3));
  ok("a task with no estimate stays unestimated, with the reason", o.N1.estimate === null && o.N1.basis === "no estimate");
  ok("dropped work is not open work", !o.Z1);
  ok("the remaining total counts only what has a basis", e.remaining.tokens === 60000 + 20000 + o.X1.estimate + 75000 && e.remaining.unestimated === 1);
  ok("tokens already spent on open work are shown beside the estimate", o.B2.actualSoFar === 5000);
  const cold = tokenEstimates(BOARD, []);
  ok("with no actuals yet, a token estimate is shown uncalibrated and hours cannot be converted", /uncalibrated/.test(cold.open.find((x) => x.id === "B2").basis) && cold.open.find((x) => x.id === "B3").estimate === null);
}

/* -------------------------------------------------------- B-4: delivery */
const R = join(TMP, "repo");
mkdirSync(R);
const env = (at) => ({ ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
const git = (at, ...a) => {
  const r = spawnSync("git", ["-C", R, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8", env: env(at) });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (at, file, text, msg) => {
  writeFileSync(join(R, file), text);
  git(at, "add", "-A");
  git(at, "commit", "-qm", msg);
  return git(at, "rev-parse", "HEAD");
};
git("2026-09-01T00:00:00Z", "init", "-q", "-b", "main");
commit("2026-09-01T00:00:00Z", "base.txt", "0\n", "base");
// Merge 1: branch started 10:00, merged 20:00 (lead 10h). Reverted later: a failed change.
git("2026-09-02T10:00:00Z", "checkout", "-qb", "f1");
const bad = commit("2026-09-02T10:00:00Z", "a.txt", "a\nb\n", "feature one");
git("2026-09-02T20:00:00Z", "checkout", "-q", "main");
git("2026-09-02T20:00:00Z", "merge", "-q", "--no-ff", "-m", "Merge f1", "f1");
// Merge 2: branch 09:00 -> merged 13:00 (lead 4h). Its branch reverts its own first commit before merging: NOT a failed change.
git("2026-09-03T09:00:00Z", "checkout", "-qb", "f2");
const oops = commit("2026-09-03T09:00:00Z", "b.txt", "b\n", "feature two");
git("2026-09-03T10:00:00Z", "revert", "--no-edit", oops);
commit("2026-09-03T11:00:00Z", "c.txt", "c\n", "feature two, again");
git("2026-09-03T13:00:00Z", "checkout", "-q", "main");
git("2026-09-03T13:00:00Z", "merge", "-q", "--no-ff", "-m", "Merge f2", "f2");
// The revert of merge 1's commit, 26h after merge 1.
git("2026-09-03T22:00:00Z", "revert", "--no-edit", bad);
{
  const facts = gitFacts(R, { days: 30, now: new Date("2026-09-10T00:00:00Z") });
  const d = delivery(facts);
  ok("a deploy is a merge on the first-parent history", d.deploys === 2 && d.deploysPerWeek === Math.round((2 / 30) * 7 * 10) / 10, JSON.stringify(d));
  ok("lead time runs from the branch's first commit to its merge", d.leadTimeHours === 7, String(d.leadTimeHours));
  ok("a merge reverted after it landed is a failed change", d.changeFailureRate === 0.5 && d.failed.length === 1 && d.failed[0].merge.length === 40);
  ok("…and a revert on a branch before its merge is not", !d.failed.some((f) => f.revert && facts.merges[0].shas.includes(f.revert)));
  ok("time to restore runs from the merge to its revert", d.timeToRestoreHours === 26);
  ok("merged diff lines are counted from each merge", facts.merges.reduce((n, m) => n + m.lines, 0) === 3, JSON.stringify(facts.merges.map((m) => m.lines)));
  const narrow = delivery(gitFacts(R, { days: 1, now: new Date("2026-09-10T00:00:00Z") }));
  ok("no merges in the window is a stated reason, not a zero lead time", narrow.deploys === 0 && narrow.leadTimeHours === null && /no merge commits/.test(narrow.reason));
  ok("outside git, delivery is not recorded", delivery(gitFacts(TMP)).reason === "not a git checkout" && delivery(null).deploysPerWeek === null);
}

/* -------------------------------------------------------------- B-4: AI */
{
  const facts = gitFacts(R, { days: 30, now: new Date("2026-09-10T00:00:00Z") });
  const gated = {
    phases: [{
      name: "P",
      tasks: [
        // Planned checkpoints a person passed are not interventions.
        { ...BOARD.phases[0].tasks[0], gate: { qa: { verdict: "pass" } }, triage: [{ decision: "accept" }], specReview: [{ decision: "approve" }] },
        { ...BOARD.phases[0].tasks[1], gate: { qa: { verdict: "pass", history: [{ verdict: "fail" }] } }, questions: [{ id: "q1", q: "which?" }] },
        ...BOARD.phases[0].tasks.slice(2),
      ],
    }],
  };
  const a = ai(gated, RUNS, facts, { gates: ["qa"] });
  ok("tokens per closed task, over closed tasks with actuals", a.tokensPerClosedTask === 125000 && /2 of 2 closed/.test(a.tokensPerClosedTaskBasis));
  ok("tokens per merged diff line", a.tokensPerMergedLine === Math.round((255000 / 3) * 10) / 10, String(a.tokensPerMergedLine));
  ok("first-pass and rework rates over gated tasks", a.firstPassRate === 0.5 && a.reworkRate === 0.5 && a.gatedTasks === 2);
  ok("model mix is each model's share of tokens", JSON.stringify(a.modelMix.map((m) => [m.model, m.share])) === '[["big",0.8],["small",0.2]]');
  ok("estimate calibration is actual over estimate across closed work", a.estimateCalibration === Math.round((250 / 300) * 100) / 100);
  ok("human intervention is the share of closed tasks that needed a person; an accepted triage or approved spec is not one", a.humanInterventionRate === 0.5);
  ok("without prices for every model, cost stays in tokens and says why", a.dollarsPerMergedLine === null && /no cfg\.pricing/.test(a.costBasis));
  const partly = ai(gated, RUNS, facts, { gates: ["qa"], pricing: { big: { in: 3, cached: 0.3, write: 3.75, out: 15 } } });
  ok("prices for only some models give no dollar figure, rather than a partial one", partly.dollarsPerMergedLine === null);
  const priced = ai(gated, RUNS, facts, { gates: ["qa"], pricing: { big: { in: 3, cached: 0.3, write: 3.75, out: 15 }, small: { in: 1, cached: 0.1, write: 1.25, out: 5 } } });
  const spend = RUNS.reduce((n, r) => n + dollars(r, { big: { in: 3, cached: 0.3, write: 3.75, out: 15 }, small: { in: 1, cached: 0.1, write: 1.25, out: 5 } }), 0);
  ok("with prices for every model, dollars per merged line", priced.dollarsPerMergedLine === Math.round((spend / 3) * 1e4) / 1e4 && priced.costBasis === "cfg.pricing", String(priced.dollarsPerMergedLine));
  const empty = ai({ phases: [] }, null, null);
  ok("with nothing recorded, every AI number is null rather than 0", empty.tokensPerClosedTask === null && empty.tokensPerMergedLine === null && empty.firstPassRate === null && empty.modelMix === null && empty.humanInterventionRate === null);
}
{
  const k = kpis({ board: BOARD, runs: RUNS, facts: null });
  ok("the anti-KPIs are listed as left out, each with its reason", k.antiKpis === ANTI_KPIS && ["lines of code", "agents spawned", "tasks per day, unweighted"].every((n) => k.antiKpis.some((x) => x.name === n && x.why)));
}

/* -------------------------------------------------------------------- cli */
{
  const ops = join(R, "ops", "caretaker");
  mkdirSync(ops, { recursive: true });
  mkdirSync(join(R, "docs"), { recursive: true });
  writeFileSync(join(ops, "config.json"), JSON.stringify({ board: "docs/board.json", runs: "ops/caretaker/runs.jsonl", repo: "." }));
  writeFileSync(join(R, "docs", "board.json"), JSON.stringify(BOARD));
  writeFileSync(join(ops, "runs.jsonl"), `${RUNS.map((r) => JSON.stringify(r)).join("\n")}\n{half a line`);
  const r = spawnSync(process.execPath, [join(HERE, "kpis.mjs"), "--config", join(ops, "config.json"), "--json"], { encoding: "utf8" });
  const out = r.status === 0 ? JSON.parse(r.stdout) : null;
  ok("the CLI reports all of it, skipping a half-written run log line", out?.ai.tokensPerClosedTask === 125000 && out.estimates.remaining.tokens > 0, r.stderr);
}

rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n[kpis] ${failures} FAILED` : "\n[kpis] all checks passed");
process.exit(failures ? 1 : 0);
