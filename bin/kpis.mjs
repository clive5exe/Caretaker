#!/usr/bin/env node
/**
 * KPIS — B-2 and B-4. Estimates in tokens, and the delivery and AI numbers,
 * each computed from what was recorded and none of them entered by hand.
 *
 * B-2: ESTIMATE IN TOKENS. Hours are what a human spends and has to report, so
 * the calibration loop never closes. Tokens are measured at the end of every
 * run. A task may carry `estTokens` ("400k", "1.2m"); its actuals are the run
 * log's rows for it. Per task type (the task's `owner`), closed work gives:
 *   factor         actual tokens / estimated tokens
 *   tokensPerHour  actual tokens / estimated hours
 * and the open work is re-estimated from them with no human input: a token
 * estimate scaled by the factor, or an hour estimate converted at the rate.
 * Each figure says which basis it came from. Hours stay as a second display.
 *
 * B-4: THE KPIS. Delivery, from git: a deploy is a merge commit on the
 * first-parent history (this is how PRs land here); lead time runs from the
 * merged branch's first commit to the merge; a merge is a failed change when a
 * later commit reverts it or a commit it brought in; time to restore is merge
 * to revert. AI, from the run log and the board: tokens per closed task,
 * tokens (and, with prices configured, dollars) per merged diff line,
 * first-pass and rework rates, model mix, estimate calibration, and the human
 * intervention rate. Every one is null, with a reason, when its inputs were
 * not recorded; null is not zero.
 *
 * Left out on purpose, and listed as left out so their absence reads as a
 * decision (ANTI_KPIS).
 *
 * Usage: node bin/kpis.mjs [--config ops/caretaker/config.json] [--days 30] [--json]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { estHours, quality, tokenStats } from "./dashboard.mjs";

export const ANTI_KPIS = [
  { name: "lines of code", why: "rewards volume; the cheapest way to raise it is to write worse code" },
  { name: "agents spawned", why: "rewards fan-out, which spends tokens whether or not it finishes anything" },
  { name: "tasks per day, unweighted", why: "rewards splitting work into trivia; effort-weighted progress is shown instead" },
];

const DAY_MS = 86_400_000;
const allTasks = (board) => (board.phases ?? []).flatMap((p) => p.tasks ?? []);
const round = (n, d = 2) => (n === null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** "400k" -> 400000, "1.2m" -> 1200000, 5000 -> 5000; anything else null. */
export function parseTokens(v) {
  if (Number.isFinite(v)) return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*(tok(ens)?)?\s*$/i.exec(String(v ?? ""));
  if (!m) return null;
  return Math.round(Number(m[1]) * { "": 1, k: 1e3, m: 1e6 }[m[2].toLowerCase()]);
}

/** Tokens the run log recorded per task. */
export function actualsByTask(runs) {
  const out = new Map();
  for (const r of runs ?? []) {
    if (!r.task || !Number.isFinite(r.tokens)) continue;
    out.set(r.task, (out.get(r.task) ?? 0) + r.tokens);
  }
  return out;
}

/* -------------------------------------------------------------------- B-2 */

export function tokenEstimates(board, runs) {
  const actual = actualsByTask(runs);
  const tasks = allTasks(board).filter((t) => t.status !== "dropped");
  const typeOf = (t) => t.owner ?? "(no owner)";
  const cal = new Map();
  const bucket = (k) => {
    if (!cal.has(k)) cal.set(k, { closed: 0, estTok: 0, actTokForEst: 0, estHrs: 0, actTokForHrs: 0 });
    return cal.get(k);
  };
  for (const t of tasks.filter((x) => x.status === "done")) {
    const act = actual.get(t.id);
    if (!act) continue;
    for (const k of [typeOf(t), "*"]) {
      const b = bucket(k);
      b.closed += 1;
      const est = parseTokens(t.estTokens);
      if (est) {
        b.estTok += est;
        b.actTokForEst += act;
      }
      const hrs = estHours(t);
      if (hrs) {
        b.estHrs += hrs;
        b.actTokForHrs += act;
      }
    }
  }
  const rates = (k) => {
    const b = cal.get(k);
    return b ? { factor: b.estTok ? b.actTokForEst / b.estTok : null, tokensPerHour: b.estHrs ? b.actTokForHrs / b.estHrs : null } : { factor: null, tokensPerHour: null };
  };
  const open = tasks
    .filter((t) => t.status !== "done")
    .map((t) => {
      const type = typeOf(t);
      const est = parseTokens(t.estTokens);
      const hrs = estHours(t);
      const own = rates(type);
      const all = rates("*");
      let estimate = null;
      let basis;
      if (est && own.factor !== null) [estimate, basis] = [est * own.factor, `estTokens x ${round(own.factor)} (${type} calibration)`];
      else if (est && all.factor !== null) [estimate, basis] = [est * all.factor, `estTokens x ${round(all.factor)} (all closed work; none for ${type})`];
      else if (est) [estimate, basis] = [est, "estTokens, uncalibrated: no closed task has both an estimate and actuals"];
      else if (hrs && own.tokensPerHour !== null) [estimate, basis] = [hrs * own.tokensPerHour, `${hrs}h x ${Math.round(own.tokensPerHour)} tok/h (${type})`];
      else if (hrs && all.tokensPerHour !== null) [estimate, basis] = [hrs * all.tokensPerHour, `${hrs}h x ${Math.round(all.tokensPerHour)} tok/h (all closed work; none for ${type})`];
      else basis = hrs ? "no closed task with token actuals to convert hours from" : "no estimate";
      return { id: t.id, type, estimate: estimate === null ? null : Math.round(estimate), basis, hours: hrs || null, actualSoFar: actual.get(t.id) ?? 0 };
    });
  const estimated = open.filter((o) => o.estimate !== null);
  return {
    calibration: [...cal.entries()].map(([type, b]) => ({ type, closed: b.closed, ...Object.fromEntries(Object.entries(rates(type)).map(([k, v]) => [k, round(v, k === "factor" ? 2 : 0)])) })),
    open,
    remaining: estimated.length ? { tokens: estimated.reduce((n, o) => n + o.estimate, 0), estimated: estimated.length, unestimated: open.length - estimated.length } : null,
  };
}

/* ------------------------------------------------------------- B-4: git */

/**
 * Merges on the first-parent history in the window, each with the commits its
 * branch brought in, and every revert commit that names what it reverts.
 * `null` outside a git checkout.
 */
export function gitFacts(repo, { days = 30, now = new Date() } = {}) {
  const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (git("rev-parse", "--is-inside-work-tree").stdout.trim() !== "true") return null;
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  const merges = git("log", "--first-parent", "--merges", `--since=${since}`, "--format=%H %P%x09%cI").stdout.split("\n").filter(Boolean).map((l) => {
    const [ids, at] = l.split("\t");
    const [sha, p1, p2] = ids.split(" ");
    const brought = git("log", "--format=%H%x09%aI", `${p1}..${p2}`).stdout.split("\n").filter(Boolean).map((x) => x.split("\t"));
    const stat = git("diff", "--shortstat", p1, sha).stdout;
    const lines = [...stat.matchAll(/(\d+) (insertion|deletion)/g)].reduce((n, m) => n + Number(m[1]), 0);
    return { sha, at, shas: brought.map((b) => b[0]), firstAt: brought.map((b) => b[1]).sort()[0] ?? at, lines };
  });
  const reverts = git("log", "--format=%H%x09%cI%x09%B%x00", `--since=${since}`, "--grep=This reverts commit").stdout.split("\0").map((c) => c.trim()).filter(Boolean).map((c) => {
    const [sha, at, ...body] = c.split("\t");
    return { sha, at, reverts: [...body.join("\t").matchAll(/This reverts commit ([0-9a-f]{7,40})/g)].map((m) => m[1]) };
  });
  return { days, merges, reverts };
}

export function delivery(facts) {
  if (!facts) return { reason: "not a git checkout", deploysPerWeek: null, leadTimeHours: null, changeFailureRate: null, timeToRestoreHours: null };
  const { merges, reverts, days } = facts;
  if (!merges.length) return { reason: `no merge commits on the first-parent history in ${days} days; a deploy is counted as one`, deploys: 0, deploysPerWeek: 0, leadTimeHours: null, changeFailureRate: null, timeToRestoreHours: null };
  const hours = (a, b) => (Date.parse(b) - Date.parse(a)) / 3_600_000;
  const failed = [];
  for (const m of merges) {
    // Not a revert the merge itself brought in: work undone on its branch
    // before it landed never failed as a change.
    const hit = reverts.find((r) => !m.shas.includes(r.sha) && r.reverts.some((s) => m.sha.startsWith(s) || m.shas.some((x) => x.startsWith(s))));
    if (hit) failed.push({ merge: m.sha, revert: hit.sha, restoreHours: hours(m.at, hit.at) });
  }
  return {
    reason: null,
    deploys: merges.length,
    deploysPerWeek: round((merges.length / days) * 7, 1),
    leadTimeHours: round(median(merges.map((m) => hours(m.firstAt, m.at))), 1),
    changeFailureRate: round(failed.length / merges.length, 2),
    timeToRestoreHours: failed.length ? round(median(failed.map((f) => f.restoreHours)), 1) : null,
    failed,
  };
}

/* -------------------------------------------------------------- B-4: AI */

/** Dollars for a run row, from cfg.pricing {model: {in, cached, write, out}} in dollars per million tokens. null if unpriced. */
export function dollars(row, pricing) {
  const p = pricing?.[row.model];
  if (!p || !["in", "cached", "write", "out"].some((k) => k in row)) return null;
  return ["in", "cached", "write", "out"].reduce((n, k) => n + ((row[k] ?? 0) * (p[k] ?? 0)) / 1e6, 0);
}

export function ai(board, runs, facts, { gates = ["reviewer", "qa", "security"], pricing = null } = {}) {
  const tasks = allTasks(board);
  const closed = tasks.filter((t) => t.status === "done");
  const actual = actualsByTask(runs);
  const closedWith = closed.filter((t) => actual.get(t.id));
  const q = quality(board.phases ?? [], gates);
  const ts = runs ? tokenStats(runs) : null;
  const tokensTotal = ts?.total ?? null;
  const mergedLines = facts ? facts.merges.reduce((n, m) => n + m.lines, 0) : null;
  const priced = (runs ?? []).map((r) => dollars(r, pricing));
  const allPriced = runs?.length && priced.every((d) => d !== null);
  const est = tokenEstimates(board, runs ?? []);
  const cal = est.calibration.find((c) => c.type === "*");
  const intervened = (t) =>
    (t.questions ?? []).length > 0 || (t.triage ?? []).some((x) => x.decision !== "accept") || (t.specReview ?? []).some((x) => x.decision !== "approve");
  return {
    tokensPerClosedTask: closedWith.length ? Math.round(closedWith.reduce((n, t) => n + actual.get(t.id), 0) / closedWith.length) : null,
    tokensPerClosedTaskBasis: `${closedWith.length} of ${closed.length} closed task(s) have token actuals`,
    tokensPerMergedLine: tokensTotal !== null && mergedLines ? round(tokensTotal / mergedLines, 1) : null,
    dollarsPerMergedLine: allPriced && mergedLines ? round(priced.reduce((n, d) => n + d, 0) / mergedLines, 4) : null,
    costBasis: !runs ? "no run log" : !mergedLines ? "no merged lines in the window" : allPriced ? "cfg.pricing" : "tokens only: no cfg.pricing for every model in the run log",
    firstPassRate: q.gated ? round(q.firstPass / q.gated, 2) : null,
    reworkRate: q.gated ? round(q.reworked / q.gated, 2) : null,
    gatedTasks: q.gated,
    modelMix: ts ? ts.byModel.map(([model, v]) => ({ model, share: round(v.tokens / ts.total, 2), runs: v.runs })) : null,
    estimateCalibration: cal?.factor ?? null,
    humanInterventionRate: closed.length ? round(closed.filter(intervened).length / closed.length, 2) : null,
    humanInterventionBasis: "a closed task that needed a question answered, or had triage or a spec review not approved",
  };
}

export function kpis({ board, runs, facts, cfg = {} }) {
  return {
    delivery: delivery(facts),
    ai: ai(board, runs, facts, { gates: cfg.gates ?? ["reviewer", "qa", "security"], pricing: cfg.pricing ?? null }),
    estimates: tokenEstimates(board, runs ?? []),
    antiKpis: ANTI_KPIS,
  };
}

/* -------------------------------------------------------------------- cli */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const argv = process.argv.slice(2);
  const flag = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? d : argv[i + 1];
  };
  const cfgPath = resolve(flag("config", "ops/caretaker/config.json"));
  if (!existsSync(cfgPath)) {
    console.error(`kpis.mjs: no config at ${cfgPath}`);
    process.exit(2);
  }
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const root = resolve(dirname(cfgPath), "..", "..", cfg.repo ?? ".");
  const board = JSON.parse(readFileSync(resolve(root, cfg.board ?? "docs/board.json"), "utf8"));
  const runsPath = resolve(root, cfg.runs ?? "ops/caretaker/runs.jsonl");
  const runs = existsSync(runsPath) ? readFileSync(runsPath, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : null;
  const k = kpis({ board, runs, facts: gitFacts(root, { days: Number(flag("days", 30)) }), cfg });
  if (argv.includes("--json")) console.log(JSON.stringify(k, null, 2));
  else {
    const show = (v, unit = "") => (v === null || v === undefined ? "not recorded" : `${v}${unit}`);
    const d = k.delivery;
    console.log(`Delivery${d.reason ? `  (${d.reason})` : ""}`);
    console.log(`  deploys/week ${show(d.deploysPerWeek)}  lead time ${show(d.leadTimeHours, "h")}  change failure ${show(d.changeFailureRate)}  time to restore ${show(d.timeToRestoreHours, "h")}`);
    const a = k.ai;
    console.log("AI");
    console.log(`  tokens/closed task ${show(a.tokensPerClosedTask)} (${a.tokensPerClosedTaskBasis})`);
    console.log(`  tokens/merged line ${show(a.tokensPerMergedLine)}  $/merged line ${show(a.dollarsPerMergedLine)} (${a.costBasis})`);
    console.log(`  first pass ${show(a.firstPassRate)}  rework ${show(a.reworkRate)} over ${a.gatedTasks} gated task(s)`);
    console.log(`  model mix ${a.modelMix ? a.modelMix.map((m) => `${m.model} ${m.share}`).join(", ") || "none" : "not recorded"}`);
    console.log(`  estimate calibration ${show(a.estimateCalibration)}  human intervention ${show(a.humanInterventionRate)}`);
    const r = k.estimates.remaining;
    console.log(`Open work: ${r ? `${r.tokens} tokens over ${r.estimated} task(s), ${r.unestimated} with no basis` : "no basis to estimate in tokens yet"}`);
    console.log(`Left out on purpose: ${k.antiKpis.map((x) => x.name).join(", ")}`);
  }
}
