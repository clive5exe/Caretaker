#!/usr/bin/env node
/**
 * THE CARETAKER DASHBOARD — what the build is doing, where it is stuck, whether
 * it is moving, and when it lands.
 *
 * PORTABLE ON PURPOSE. Nothing here knows what the project is. Every path, label and
 * gate name comes from `config.json` beside this file, and the only schema this
 * assumes is the board's: phases, each with tasks carrying id/title/status/
 * owner/gate/est. Point it at another repo's board and it renders that one.
 *
 * THREE SOURCES, none of them a status report: the board, git, and the agent
 * definitions. It does NOT know what is executing right now unless something
 * appends to `runs.jsonl`, and it says so rather than animating a fake pulse
 * over a snapshot.
 *
 * TWO PROGRESS NUMBERS, BECAUSE ONE OF THEM LIES. Counting tasks treats "rotate
 * the service-role key" and "fix a typo" as equal, so a phase can read 47% while
 * every cheap task is done and every expensive one is not. The effort-weighted
 * number uses the board's own `est` field and is the one the ETA is computed
 * from. Both are shown, and where they disagree that disagreement is the signal.
 *
 * THE ETA IS AN EXTRAPOLATION AND IS LABELLED AS ONE. Remaining effort divided
 * by effort actually closed per day over a trailing window. It is honest about
 * two things a burndown usually hides: idle days are IN the divisor, so the rate
 * is calendar throughput rather than a best day; and when nothing has closed in
 * the window there is no rate, so it says "no rate" instead of projecting from
 * one data point.
 *
 * TABS ARE CSS-ONLY. Radio inputs plus sibling selectors, no script, because the
 * page has to stay one file that works from disk with no server and no build.
 *
 * IT IS ALSO A LIBRARY (TECH.md C-2). The metric functions below are pure and
 * exported, and `metrics()` composes them. The web API calls the same functions
 * this page is rendered from, so the two surfaces cannot headline different
 * numbers. Reading sources, the history append and the file write happen only
 * when this file is executed.
 *
 * Run: node ops/caretaker/dashboard.mjs [path/to/config.json]
 */
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, mkdirSync, realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/* ------------------------------------------------------------------ metrics */
// Pure: every function here takes what it reads as arguments and touches no
// file, no clock and no process.

/** The last n calendar days ending on `now`, oldest first, as YYYY-MM-DD. */
export function lastDays(n, now = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * An estimate in hours, or null when the board does not carry one.
 *
 * ACCEPTS WHAT THE BOARD ACTUALLY CONTAINS rather than a format someone should
 * have used: `30m`, `1h`, `1.5d`, `2w` and the S/M/L shirt sizes all appear in
 * this data. Anything unrecognised returns null and is counted separately, so an
 * unparsed estimate shows up as a known gap instead of silently weighing zero.
 */
export function estHours(t, dayHours = 8) {
  const raw = String(t.est ?? t.estimate ?? "").trim().toLowerCase();
  if (!raw) return null;
  const shirt = { xs: 1, s: 2, m: 6, l: 16, xl: 32 };
  if (raw in shirt) return shirt[raw];
  const m = /^([\d.]+)\s*(m|h|d|w)$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return { m: n / 60, h: n, d: n * dayHours, w: n * dayHours * 5 }[m[2]];
}


export const isDone = (t) => t.status === "done";
export const verdict = (t, k) => (t.gate ?? {})[k]?.verdict ?? null;

export function held(t, GATES) {
  if (isDone(t)) return null;
  const present = GATES.filter((k) => verdict(t, k));
  const failed = present.filter((k) => verdict(t, k) !== "pass");
  if (failed.length) return { kind: "failed", gates: failed };
  if (present.length) return { kind: "partial", missing: GATES.filter((k) => !verdict(t, k)) };
  return null;
}

export const acOf = (t) => {
  const a = t.ac ?? t.accept ?? "";
  return (Array.isArray(a) ? a.join(" ") : String(a)).trim();
};

/**
 * The ETA. Idle days stay in the divisor deliberately — the question is when
 * this lands on a calendar, not what a good day looks like.
 */
export function eta(closedHoursByDay, remainingHours, DAYS, now = new Date()) {
  const closed = closedHoursByDay.reduce((a, b) => a + b, 0);
  if (closed <= 0 || remainingHours <= 0) return null;
  const perDay = closed / DAYS;
  const days = Math.ceil(remainingHours / perDay);
  const when = new Date(now);
  when.setDate(when.getDate() + days);
  return { days, perDay, date: when.toISOString().slice(0, 10) };
}

/**
 * Estimate against elapsed, for closed tasks that git can date.
 *
 * ELAPSED IS CALENDAR TIME, NOT EFFORT, and conflating them would be the whole
 * defect. A 2h task opened on Monday and closed on Friday took four days of
 * wall clock and possibly two hours of work. What this measures is how long a
 * task SITS, which is the thing an ETA actually depends on.
 */
export function cycle(phases, commitsPerTask, dayHours = 8) {
  const rows = [];
  for (const p of phases) {
    for (const t of p.tasks ?? []) {
      if (!isDone(t) || !t.completed) continue;
      const c = commitsPerTask.get(t.id);
      if (!c) continue;
      const days =
        Math.round((Date.parse(t.completed) - Date.parse(c.first)) / 86400000) + 1;
      if (!Number.isFinite(days) || days < 1) continue;
      rows.push({ id: t.id, title: t.title, est: estHours(t, dayHours), days, commits: c.n });
    }
  }
  return rows.sort((a, b) => b.days - a.days);
}

export const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Remaining effort by owner: who the queue is actually waiting on. */
export function byOwner(activeTasks, hoursOf) {
  const m = new Map();
  for (const t of activeTasks) {
    if (isDone(t)) continue;
    const k = t.owner ?? "unassigned";
    const cur = m.get(k) ?? { n: 0, h: 0, blocked: 0 };
    cur.n += 1;
    cur.h += hoursOf.get(t.id) ?? 0;
    if (t.status === "blocked") cur.blocked += 1;
    m.set(k, cur);
  }
  return [...m.entries()].sort((a, b) => b[1].h - a[1].h);
}

/**
 * Every gate verdict ever recorded, by role — including the ones that were
 * superseded.
 *
 * THIS USED TO READ THE LATEST VERDICT ONLY, and so it counted a task that
 * failed qa three times and passed once as a single pass. The fail-rate column
 * understated rework by construction and the page had to carry a caveat saying
 * so. P-2 made verdicts append, so the history is here and the caveat is gone.
 */
export function gateStats(phases, GATES) {
  const m = new Map(GATES.map((g) => [g, { pass: 0, fail: 0 }]));
  for (const p of phases) {
    for (const t of p.tasks ?? []) {
      for (const g of GATES) {
        const rec = (t.gate ?? {})[g];
        if (!rec?.verdict) continue;
        const cur = m.get(g);
        for (const v of [...(rec.history ?? []).map((h) => h.verdict), rec.verdict]) {
          if (v === "pass") cur.pass += 1;
          else cur.fail += 1;
        }
      }
    }
  }
  return [...m.entries()];
}

/**
 * First-pass rate and rework, the two quality metrics that actually predict
 * anything and that were unmeasurable before verdicts appended.
 *
 * COUNTED OVER TASKS THAT REACHED A GATE AT ALL, not over every task. A task
 * nobody has reviewed is not a first-pass success, and including it would make
 * the number improve every time work is skipped.
 */
export function quality(phases, GATES) {
  let gated = 0;
  let firstPass = 0;
  let reworked = 0;
  let attempts = 0;
  for (const p of phases) {
    for (const t of p.tasks ?? []) {
      const recs = GATES.map((g) => (t.gate ?? {})[g]).filter((r) => r?.verdict);
      if (!recs.length) continue;
      gated += 1;
      const everFailed = recs.some(
        (r) => r.verdict !== "pass" || (r.history ?? []).some((h) => h.verdict !== "pass"),
      );
      if (everFailed) reworked += 1;
      else firstPass += 1;
      attempts += recs.reduce((n, r) => n + 1 + (r.history ?? []).length, 0);
    }
  }
  return {
    gated,
    firstPass,
    reworked,
    attempts,
    firstPassPct: gated ? Math.round((firstPass / gated) * 100) : 0,
    reworkPct: gated ? Math.round((reworked / gated) * 100) : 0,
  };
}

/**
 * Token spend, from the run log. Absent until something writes one, and split by
 * provenance because a line written as work happened and a line written later
 * from a transcript are different objects. Averaging them silently would invent
 * precision this page has no right to.
 */
export function tokenStats(runList) {
  const list = (runList ?? []).filter((r) => Number.isFinite(r.tokens));
  if (!list.length) return null;
  const byTask = new Map();
  for (const r of list) {
    const k = r.task ?? "(no task)";
    const cur = byTask.get(k) ?? { tokens: 0, runs: 0, agents: new Set(), recon: 0 };
    cur.tokens += r.tokens;
    cur.runs += 1;
    cur.agents.add(r.name);
    if (r.src && r.src !== "live") cur.recon += 1;
    byTask.set(k, cur);
  }
  const byAgent = new Map();
  for (const r of list) {
    const cur = byAgent.get(r.name) ?? { tokens: 0, runs: 0 };
    cur.tokens += r.tokens;
    cur.runs += 1;
    byAgent.set(r.name, cur);
  }
  /*
   * COMPOSITION IS THE NUMBER THAT CHANGES BEHAVIOUR, and the total hides it.
   * A run reporting 400k tokens is unreadable; the same run as 380k cache reads,
   * 15k fresh input and 5k output says immediately that the cost is context
   * REPLAY rather than work. Those want opposite fixes — better context
   * selection versus a smaller task — and one number cannot tell them apart.
   *
   * Only rows carrying the breakdown are counted here, so a log of totals shows
   * no composition rather than a fabricated one.
   */
  const detailed = list.filter((r) => ["in", "cached", "write", "out"].some((k) => k in r));
  const sum = (k) => detailed.reduce((n, r) => n + (r[k] ?? 0), 0);
  const comp = { in: sum("in"), cached: sum("cached"), write: sum("write"), out: sum("out") };
  const compTotal = comp.in + comp.cached + comp.write + comp.out;
  const turns = detailed.reduce((n, r) => n + (r.turns ?? 0), 0);

  const byModel = new Map();
  for (const r of list) {
    if (!r.model) continue;
    const cur = byModel.get(r.model) ?? { tokens: 0, runs: 0 };
    cur.tokens += r.tokens;
    cur.runs += 1;
    byModel.set(r.model, cur);
  }

  return {
    total: list.reduce((n, r) => n + r.tokens, 0),
    liveCount: list.filter((r) => !r.src || r.src === "live").length,
    reconCount: list.filter((r) => r.src && r.src !== "live").length,
    byTask: [...byTask.entries()].sort((a, b) => b[1].tokens - a[1].tokens),
    byAgent: [...byAgent.entries()].sort((a, b) => b[1].tokens - a[1].tokens),
    byModel: [...byModel.entries()].sort((a, b) => b[1].tokens - a[1].tokens),
    detailedCount: detailed.length,
    comp,
    compTotal,
    turns,
    // Share of spend that is generated rather than re-read. A small number on a
    // large total means the loop is paying to look at things.
    outShare: compTotal ? comp.out / compTotal : null,
    // Context sent that could NOT be matched against the cache. High write
    // against low cached is the expensive failure: the context keeps changing
    // shape, so nothing can be reused.
    churnShare: compTotal ? comp.write / (comp.cached + comp.write || 1) : null,
    perTurn: turns ? Math.round(compTotal / turns) : null,
  };
}

/**
 * Tokens spent on work that had to be done again.
 *
 * THE ONE ACTIONABLE WASTE NUMBER. Everything else on this page describes what
 * the spend WAS; this says which part went on attempts a gate sent back: a
 * failed task's runs up to its last failed verdict. Only computable since
 * verdicts started appending.
 */
export function reworkSpend(phases, runList, GATES) {
  if (!runList) return null;
  // Per task that failed a gate: the day of its LAST failed verdict. Runs up
  // to that day are the attempts sent back; the run that then passed bought
  // the work and is not rework (independent review: it was counted).
  const lastFail = new Map();
  for (const p of phases) {
    for (const t of p.tasks ?? []) {
      for (const g of GATES) {
        const r = (t.gate ?? {})[g];
        if (!r) continue;
        for (const e of [...(r.history ?? []), r]) {
          if (e.verdict === "pass") continue;
          const at = /^\d{4}-\d{2}-\d{2}/.test(e.at ?? "") ? e.at.slice(0, 10) : "";
          if (!lastFail.has(t.id) || at > lastFail.get(t.id)) lastFail.set(t.id, at);
        }
      }
    }
  }
  let wasted = 0;
  let total = 0;
  let unplaced = 0;
  for (const r of runList) {
    if (!Number.isFinite(r.tokens)) continue;
    total += r.tokens;
    if (!r.task || !lastFail.has(r.task)) continue;
    // Verdicts carry a date only, so a run on the day of the failure counts
    // as rework. A run or a failure with no date cannot be placed either side.
    const day = /^\d{4}-\d{2}-\d{2}/.test(r.t ?? "") ? r.t.slice(0, 10) : "";
    if (!day || !lastFail.get(r.task)) unplaced += r.tokens;
    else if (day <= lastFail.get(r.task)) wasted += r.tokens;
  }
  return { wasted, total, pct: total ? Math.round((wasted / total) * 100) : 0, tasks: lastFail.size, unplaced };
}

/**
 * Every number the page shows, from the board, the run log and git facts.
 * `git` is { commitsByDay, commitsPerTask } as readGit returns them, so a
 * caller with no git passes empty ones and gets empty velocity, not an error.
 */
export function metrics(board, runList, git, cfg, now = new Date()) {
  const phases = board.phases ?? [];
  const GATES = cfg.gates ?? ["reviewer", "qa", "security"];
  const DAYS = cfg.window ?? 14;
  /** A working day, in hours. Used to turn `1d` and `1w` into a common unit. */
  const DAY_HOURS = cfg.dayHours ?? 8;
  const WINDOW = lastDays(DAYS, now);
  const { commitsByDay, commitsPerTask } = git;

  const active = phases.find((p) => p.name === cfg.activePhase) ?? phases[phases.length - 1];
  const activeTasks = (active?.tasks ?? []).map((t) => ({ ...t, phase: active.name }));

  const doneCount = activeTasks.filter(isDone).length;
  const pctTasks = activeTasks.length ? Math.round((doneCount / activeTasks.length) * 100) : 0;

  /* Effort, and an explicit count of what could not be parsed. */
  const hoursOf = new Map(activeTasks.map((t) => [t.id, estHours(t, DAY_HOURS)]));
  const unestimated = activeTasks.filter((t) => hoursOf.get(t.id) === null).length;
  const sumHours = (list) => list.reduce((n, t) => n + (hoursOf.get(t.id) ?? 0), 0);
  const totalHours = sumHours(activeTasks);
  const doneHours = sumHours(activeTasks.filter(isDone));
  const remainingHours = totalHours - doneHours;
  const pctEffort = totalHours ? Math.round((doneHours / totalHours) * 100) : 0;

  /* Effort closed per calendar day in the window, from the board's own stamps. */
  const closedHoursByDay = (() => {
    const counts = Object.fromEntries(WINDOW.map((d) => [d, 0]));
    for (const p of phases) {
      for (const t of p.tasks ?? []) {
        if (t.completed && t.completed in counts) counts[t.completed] += estHours(t, DAY_HOURS) ?? 0;
      }
    }
    return WINDOW.map((d) => counts[d]);
  })();
  const closedByDay = (() => {
    const counts = Object.fromEntries(WINDOW.map((d) => [d, 0]));
    for (const p of phases) {
      for (const t of p.tasks ?? []) {
        if (t.completed && t.completed in counts) counts[t.completed] += 1;
      }
    }
    return WINDOW.map((d) => counts[d]);
  })();

  const etaV = eta(closedHoursByDay, remainingHours, DAYS, now);

  const heldTotal = activeTasks.filter((t) => held(t, GATES)).length;
  const blockedTotal = activeTasks.filter((t) => t.status === "blocked").length;
  const noAc = activeTasks.filter((t) => !isDone(t) && !acOf(t)).length;
  const landedToday = commitsByDay[commitsByDay.length - 1] ?? 0;

  const cycleRows = cycle(phases, commitsPerTask, DAY_HOURS);
  return {
    phases, GATES, DAYS, DAY_HOURS, WINDOW, commitsByDay,
    active, activeTasks, doneCount, pctTasks, hoursOf, unestimated,
    totalHours, doneHours, remainingHours, pctEffort,
    closedHoursByDay, closedByDay, eta: etaV,
    heldTotal, blockedTotal, noAc, landedToday,
    cycle: cycleRows,
    medDays: median(cycleRows.map((r) => r.days)),
    medEst: median(cycleRows.filter((r) => r.est).map((r) => r.est)),
    byOwner: byOwner(activeTasks, hoursOf),
    gateStats: gateStats(phases, GATES),
    quality: quality(phases, GATES),
    runList,
    tokenStats: tokenStats(runList),
    reworkSpend: reworkSpend(phases, runList, GATES),
  };
}

/* ------------------------------------------------------------------ sources */

export function readAgents(root, cfg) {
  const dir = join(root, cfg.agentsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const head = readFileSync(join(dir, f), "utf8").slice(0, 2000);
      const m = /^model:\s*(\S+)/m.exec(head);
      return { name: f.replace(/\.md$/, ""), model: m ? m[1] : "inherit" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/*
 * A literal separator rather than an ASCII control code: a control character in
 * a shell argument is invisible in a diff and in an approval prompt, and an
 * earlier version of this file was rejected for exactly that.
 */
const SEP = "|~|";
const gitIn = (root) => (args, fallback = "") => {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  } catch {
    return fallback;
  }
};

/** Commits, commits per day in the window, and commits per task id, from git. */
export function readGit(root, DAYS = 14, now = new Date()) {
  const git = gitIn(root);
  const WINDOW = lastDays(DAYS, now);
  const commits = git(["log", "-20", `--pretty=format:%h${SEP}%ar${SEP}%s`])
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, when, ...rest] = l.split(SEP);
      return { sha, when, subject: rest.join(SEP) };
    });

  const commitsByDay = (() => {
    const counts = Object.fromEntries(WINDOW.map((d) => [d, 0]));
    for (const line of git(["log", `--since=${DAYS}.days`, "--pretty=format:%ad", "--date=short"])
      .split("\n")
      .filter(Boolean)) {
      if (line in counts) counts[line] += 1;
    }
    return WINDOW.map((d) => counts[d]);
  })();

  /**
   * Task to commits, by scanning subjects and bodies for the id. Loose on
   * purpose: this is a CHURN signal, not an audit. A task named in twenty commits
   * is one that fought back, which is worth seeing next to its estimate.
   */
  const commitsPerTask = (() => {
    const map = new Map();
    const log = git(["log", `--pretty=format:%H${SEP}%ad${SEP}%s %b`, "--date=short"]);
    for (const line of log.split("\n").filter(Boolean)) {
      const [, date, text] = line.split(SEP);
      const ids = new Set(String(text).match(/\bT-\d+[a-z]?\b/g) ?? []);
      for (const id of ids) {
        const cur = map.get(id) ?? { n: 0, first: date, last: date };
        cur.n += 1;
        if (date < cur.first) cur.first = date;
        if (date > cur.last) cur.last = date;
        map.set(id, cur);
      }
    }
    return map;
  })();


  return { commits, commitsByDay, commitsPerTask };
}

export function readRuns(root, cfg) {
  const p = join(root, cfg.runs);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null; // a half-written last line is normal in an appended file
      }
    })
    .filter(Boolean);
}

/** The config and the repo root it describes, as the page has always resolved them. */
export function readConfig(cfgPath = join(HERE, "config.json")) {
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const root = resolve(dirname(cfgPath), "..", "..", cfg.repo ?? ".");
  return { cfg, root };
}

/* ------------------------------------------------------------------- history */

/*
 * ONE LINE PER BUILD, so the ETA can be checked against what happened rather
 * than only asserted. Nothing else on this page has a memory: every other number
 * is recomputed from the board and from git, which is why they cannot rot. This
 * one file is the exception, and it is append-only for the same reason an audit
 * table is — a prediction you can quietly revise is not a prediction.
 */
export function recordHistory(HIST, m, today) {
  const history = existsSync(HIST)
    ? readFileSync(HIST, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];
  // One record per DAY, not per build: this script runs on every publish, and a
  // day with forty builds would otherwise drown a day with one.
  if (!history.some((h) => h.d === today)) {
    const row = {
      d: today,
      pctEffort: m.pctEffort,
      pctTasks: m.pctTasks,
      remainingHours: Math.round(m.remainingHours),
      eta: m.eta?.date ?? null,
      done: m.doneCount,
      held: m.heldTotal,
      blocked: m.blockedTotal,
    };
    try {
      mkdirSync(dirname(HIST), { recursive: true });
      appendFileSync(HIST, JSON.stringify(row) + "\n");
      history.push(row);
    } catch {
      // A read-only checkout still renders; it just cannot remember.
    }
  }

  return history;
}

/* -------------------------------------------------------------------- render */

/** The page, from metrics() and the few sources only the page shows. */
export function render(m, { cfg, agentList = [], commits = [], history = [], now = new Date() }) {
  const {
    phases, GATES, DAYS, WINDOW, commitsByDay, active, activeTasks, doneCount, pctTasks,
    hoursOf, unestimated, totalHours, doneHours, remainingHours, pctEffort, closedHoursByDay,
    closedByDay, eta, heldTotal, blockedTotal, noAc, landedToday, cycle, medDays, medEst,
    byOwner, gateStats, quality, runList, tokenStats, reworkSpend,
  } = m;
  const sumHours = (list) => list.reduce((n, t) => n + (hoursOf.get(t.id) ?? 0), 0);


function spark(values, cls) {
  const w = 240;
  const h = 44;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => [i * step, h - (v / max) * (h - 5) - 2]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return `<svg class="spark ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <path class="a" d="${line} L${w} ${h} L0 ${h} Z"/><path class="l" d="${line}"/></svg>`;
}

const tile = ({ label, value, sub, values, tone }) => `<div class="tile ${tone}">
      <p class="tl">${esc(label)}</p><p class="tv">${esc(value)}</p><p class="ts">${sub}</p>
      ${values ? spark(values, tone) : ""}</div>`;

function gateRail(t) {
  return `<div class="rail" aria-label="gates">${GATES.map((k) => {
    const v = verdict(t, k);
    return `<i class="${v === "pass" ? "pass" : v ? "fail" : "none"}" title="${esc(k)}: ${esc(
      v ?? "not run",
    )}"></i>`;
  }).join("")}</div>`;
}

/** B-3: a task's spec, as a link relative to this page; text when it is not a plain path inside the repo. */
function specMeta(t, pageRel) {
  if (!t.spec) return "";
  const s = String(t.spec);
  const href = /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("/") || s.split("/").includes("..") ? null : posix.relative(posix.dirname(pageRel), s);
  return `<span class="es">spec ${href ? `<a href="${esc(href)}">${esc(s)}</a>` : esc(s)}</span>`;
}

function taskCard(t) {
  const h = held(t, GATES);
  const hrs = hoursOf.get(t.id);
  const meta = [
    t.owner ? `<span class="ow">${esc(t.owner)}</span>` : "",
    t.est ? `<span class="es">${esc(t.est)}</span>` : `<span class="es no">no estimate</span>`,
    t.deps?.length ? `<span class="es">after ${esc(t.deps.join(", "))}</span>` : "",
    specMeta(t, cfg.out ?? "docs/board.html"),
  ]
    .filter(Boolean)
    .join("");
  const flag = h
    ? `<p class="hold ${h.kind}">${
        h.kind === "failed" ? `${h.gates.join(", ")} failed` : `waiting on ${h.missing.join(" + ")}`
      }</p>`
    : "";
  const noac = !acOf(t) && !isDone(t) ? `<p class="hold failed">no finish line</p>` : "";
  const why =
    t.status === "blocked"
      ? `<p class="why">${esc(t.blockedReason ?? "no reason recorded")}</p>`
      : "";
  return `<article class="card${h ? " is-held" : ""}">
      <header><code>${esc(t.id)}</code>${gateRail(t)}</header>
      <h3>${esc(t.title)}</h3><div class="meta">${meta}</div>${flag}${noac}${why}
    </article>`;
}

const columns = (cfg.columns ?? [])
  .map((c) => {
    const list = activeTasks.filter((t) => t.status === c.key);
    const hrs = sumHours(list);
    return `<section class="col">
      <h2>${esc(c.label)}<span class="n">${list.length}</span>
        <span class="hr">${hrs ? `${Math.round(hrs)}h` : ""}</span></h2>
      ${list.length ? list.map(taskCard).join("") : `<p class="empty">nothing here</p>`}
    </section>`;
  })
  .join("");

const running = runList?.filter((r) => r.state === "running") ?? [];
const runStrip =
  runList === null
    ? `<p class="note">No run log yet. This fills in when something appends to
       <code>${esc(cfg.runs)}</code>. Until then the board is a snapshot rather than a live view,
       and saying so is the point.</p>`
    : running.length
      ? `<ul class="runs">${running
          .map(
            (r) =>
              `<li><span class="pulse"></span><b>${esc(r.name)}</b>${
                r.task ? `<code>${esc(r.task)}</code>` : ""
              }<span class="dim">${esc(r.note ?? "")}</span></li>`,
          )
          .join("")}</ul>`
      : `<p class="note">Nothing executing. Last record ${esc(runList.at(-1)?.t ?? "unknown")}.</p>`;

const velocity = (() => {
  const max = Math.max(1, ...commitsByDay);
  const mean = commitsByDay.reduce((a, b) => a + b, 0) / DAYS;
  const bars = WINDOW.map((d, i) => {
    const c = commitsByDay[i];
    const k = closedByDay[i];
    const kh = Math.round(closedHoursByDay[i]);
    return `<div class="vday" title="${d}: ${c} commit${c === 1 ? "" : "s"}, ${k} closed${
      kh ? ` (${kh}h)` : ""
    }">
        <div class="vbars"><i class="vc" style="height:${Math.round((c / max) * 100)}%"></i>
        ${k ? `<i class="vk" style="height:${Math.round((k / max) * 100)}%"></i>` : ""}</div>
        <span class="vd">${d.slice(8)}</span></div>`;
  }).join("");
  return `<div class="vwrap"><div class="vmean" style="bottom:${Math.round(
    (mean / max) * 100,
  )}%"><span>avg ${mean.toFixed(1)}</span></div>${bars}</div>`;
})();

const phaseRows = phases
  .map((p) => {
    const ts = p.tasks ?? [];
    const d = ts.filter(isDone).length;
    const q = ts.length ? Math.round((d / ts.length) * 100) : 0;
    return `<tr${p.name === active?.name ? ' class="cur"' : ""}>
      <td>${esc(p.name)}</td><td class="num">${d}/${ts.length}</td>
      <td class="bar"><i style="width:${q}%"></i></td><td class="num">${q}%</td></tr>`;
  })
  .join("");

const agentRows = (() => {
  const list = agentList;
  if (!list.length) return "";
  const byModel = new Map();
  for (const a of list) byModel.set(a.model, [...(byModel.get(a.model) ?? []), a.name]);
  return [...byModel.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(
      ([model, names]) =>
        `<tr><td><code>${esc(model)}</code></td><td class="num">${names.length}</td>
         <td class="agents">${names.map(esc).join(", ")}</td></tr>`,
    )
    .join("");
})();

const commitRows = commits
  .map(
    (c) =>
      `<li><code>${esc(c.sha)}</code><span class="dim">${esc(c.when)}</span>
       <span class="sub">${esc(c.subject)}</span></li>`,
  )
  .join("");

/* The ETA as it was predicted on each day it was recorded, against today's. */
const etaHistoryRows = history
  .slice(-DAYS)
  .reverse()
  .map((h) => {
    const drift =
      h.eta && eta ? Math.round((Date.parse(eta.date) - Date.parse(h.eta)) / 86400000) : null;
    return `<tr><td class="num">${esc(h.d)}</td><td class="num">${h.pctEffort}%</td>
      <td class="num">${h.remainingHours}h</td><td class="num">${esc(h.eta ?? "-")}</td>
      <td class="num ${drift === null ? "" : drift > 0 ? "worse" : drift < 0 ? "better" : ""}">${
        drift === null ? "-" : drift === 0 ? "held" : drift > 0 ? `+${drift}d` : `${drift}d`
      }</td></tr>`;
  })
  .join("");

const cycleRows = cycle
  .slice(0, 12)
  .map(
    (r) =>
      `<tr><td class="num">${esc(r.id)}</td><td>${esc(r.title)}</td>
       <td class="num">${r.est ? `${r.est}h` : "-"}</td><td class="num">${r.days}d</td>
       <td class="num">${r.commits}</td></tr>`,
  )
  .join("");

const ownerRows = byOwner
  .map(
    ([who, v]) =>
      `<tr><td>${esc(who)}</td><td class="num">${v.n}</td><td class="num">${Math.round(v.h)}h</td>
       <td class="bar"><i style="width:${
         remainingHours ? Math.round((v.h / remainingHours) * 100) : 0
       }%"></i></td>
       <td class="num">${v.blocked ? `${v.blocked} blocked` : ""}</td></tr>`,
  )
  .join("");

const gateRows = gateStats
  .map(
    ([g, v]) =>
      `<tr><td>${esc(g)}</td><td class="num">${v.pass}</td><td class="num ${
        v.fail ? "worse" : ""
      }">${v.fail}</td><td class="num">${
        v.pass + v.fail ? Math.round((v.fail / (v.pass + v.fail)) * 100) : 0
      }%</td></tr>`,
  )
  .join("");

const tokenTaskRows = (tokenStats?.byTask ?? [])
  .slice(0, 10)
  .map(
    ([task, v]) =>
      `<tr><td class="num">${esc(task)}</td><td class="num">${v.tokens.toLocaleString("en-US")}</td>
       <td class="num">${v.runs}</td><td class="agents">${[...v.agents].map(esc).join(", ")}</td>
       <td class="num">${v.recon ? `${v.recon} recon` : ""}</td></tr>`,
  )
  .join("");

const tokenAgentRows = (tokenStats?.byAgent ?? [])
  .map(
    ([name, v]) =>
      `<tr><td>${esc(name)}</td><td class="num">${v.tokens.toLocaleString("en-US")}</td>
       <td class="num">${v.runs}</td>
       <td class="num">${Math.round(v.tokens / v.runs).toLocaleString("en-US")}</td></tr>`,
  )
  .join("");

const pct = (n) => `${Math.round(n * 100)}%`;
const compBar = tokenStats?.compTotal
  ? (() => {
      const c = tokenStats.comp;
      const t = tokenStats.compTotal;
      const seg = (k, cls, label) =>
        c[k] ? `<i class="${cls}" style="width:${(c[k] / t) * 100}%" title="${label}: ${c[k].toLocaleString("en-US")} (${pct(c[k] / t)})"></i>` : "";
      return `<div class="compbar">
          ${seg("cached", "s-cached", "cache reads — context re-sent and matched")}
          ${seg("write", "s-write", "cache writes — context that could not be matched")}
          ${seg("in", "s-in", "fresh input")}
          ${seg("out", "s-out", "generated output")}
        </div>
        <div class="complegend">
          <span><i class="s-cached"></i>cache read ${pct(c.cached / t)}</span>
          <span><i class="s-write"></i>cache write ${pct(c.write / t)}</span>
          <span><i class="s-in"></i>fresh in ${pct(c.in / t)}</span>
          <span><i class="s-out"></i>output ${pct(c.out / t)}</span>
        </div>`;
    })()
  : "";

const built = now.toISOString().replace("T", " ").slice(0, 16);
const etaLine = eta
  ? `<b>${esc(eta.date)}</b> &middot; ${eta.days} day${eta.days === 1 ? "" : "s"} at
     ${eta.perDay.toFixed(1)}h/day`
  : `<b>no rate</b> &middot; nothing closed in ${DAYS} days, so there is nothing to extrapolate`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(cfg.name)}</title>
<style>
:root{
  --bg:#08080a; --panel:#111114; --line:#1e1e23; --line2:#2c2c34;
  --ink:#ece9e2; --dim:#918f87; --faint:#5f5d57;
  --lime:#c6f24a; --amber:#f5a524; --red:#ff5d51;
  /* Plex is used when installed locally; nothing is fetched. The page makes no
     request to another origin, so it opens offline and leaks nothing. */
  --sans:"IBM Plex Sans Condensed",ui-sans-serif,system-ui,"Segoe UI",Helvetica,Arial,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
  font-size:17px;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:1560px;margin:0 auto;padding:28px 26px 72px}

.top{display:flex;flex-wrap:wrap;align-items:baseline;gap:14px;margin-bottom:18px}
.top h1{font-size:26px;font-weight:700;letter-spacing:.01em;margin:0;text-transform:uppercase}
.top .ph{color:var(--lime);font-family:var(--mono);font-size:13px;letter-spacing:.04em}
.top .bt{margin-left:auto;color:var(--faint);font-family:var(--mono);font-size:12px}

/* progress -------------------------------------------------------------- */
.prog{margin-bottom:26px}
.prognums{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px 20px;margin-bottom:11px}
.prognums .big{font-family:var(--mono);font-size:58px;font-weight:600;line-height:.9;
  letter-spacing:-.035em;color:var(--lime);font-variant-numeric:tabular-nums}
.prognums .lab{font-family:var(--mono);font-size:12px;letter-spacing:.12em;
  text-transform:uppercase;color:var(--faint)}
.prognums .alt{font-family:var(--mono);font-size:20px;color:var(--ink);
  font-variant-numeric:tabular-nums}
.prognums .eta{margin-left:auto;font-size:15px;color:var(--dim);text-align:right}
.prognums .eta b{color:var(--lime);font-family:var(--mono)}
.track{position:relative;height:16px;background:#141418;border:1px solid var(--line);
  border-radius:99px;overflow:hidden}
.track .t{position:absolute;inset:0 auto 0 0;background:var(--lime);border-radius:99px}
.track .e{position:absolute;top:0;bottom:0;width:2px;background:#08080a;opacity:.85}
.tracknote{margin:8px 0 0;font-size:13px;color:var(--faint)}

/* tabs (CSS only) -------------------------------------------------------- */
.tabin{position:absolute;opacity:0;pointer-events:none}
.tabs{display:flex;gap:5px;border-bottom:1px solid var(--line);margin-bottom:20px}
.tabs label{font-family:var(--mono);font-size:12px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--faint);padding:9px 15px;cursor:pointer;border-bottom:2px solid transparent;
  margin-bottom:-1px}
.tabs label:hover{color:var(--dim)}
#tb:checked~.tabs label[for=tb],#td:checked~.tabs label[for=td],
#ts:checked~.tabs label[for=ts]{color:var(--ink);border-bottom-color:var(--lime)}
.pane{display:none}
#tb:checked~.pane-board,#td:checked~.pane-data,#ts:checked~.pane-stats{display:block}
.worse{color:var(--amber)} .better{color:var(--lime)}
.compbar{display:flex;height:22px;border-radius:4px;overflow:hidden;background:var(--line);
  margin:4px 0 10px}
.compbar i{display:block;height:100%}
.s-cached{background:#3f5d6b} .s-write{background:var(--amber)}
.s-in{background:#6b7f8c} .s-out{background:var(--lime)}
.complegend{display:flex;flex-wrap:wrap;gap:14px;font-family:var(--mono);font-size:11px;
  color:var(--dim)}
.complegend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;
  vertical-align:-1px}
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:14px 0 0}
.kpi div{border-left:2px solid var(--line2);padding-left:11px}
.kpi .k{font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--faint);margin:0}
.kpi .v{font-family:var(--mono);font-size:22px;margin:3px 0 2px;font-variant-numeric:tabular-nums}
.kpi .w{font-size:12px;color:var(--dim);margin:0;line-height:1.45}
.panel p.cav{margin:11px 0 0;font-size:13px;color:var(--faint);line-height:1.6}
th{text-align:left;font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--faint);font-weight:500;padding:0 8px 7px 0;
  border-bottom:1px solid var(--line)}
th.num{text-align:right}

/* tiles ------------------------------------------------------------------ */
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(228px,1fr));gap:13px;
  margin-bottom:22px}
.tile{position:relative;overflow:hidden;background:var(--panel);border:1px solid var(--line);
  border-radius:12px;padding:15px 17px 38px}
.tile .tl{margin:0;font-size:12px;letter-spacing:.13em;text-transform:uppercase;color:var(--faint)}
.tile .tv{margin:7px 0 3px;font-family:var(--mono);font-size:42px;font-weight:600;line-height:1;
  letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.tile .ts{margin:0;font-size:13.5px;color:var(--dim);position:relative;z-index:1}
.tile.good .tv{color:var(--lime)} .tile.warn .tv{color:var(--amber)}
.tile.bad .tv{color:var(--red)} .tile.plain .tv{color:var(--ink)}
.spark{position:absolute;left:0;right:0;bottom:0;width:100%;height:44px}
.spark .a{fill:currentColor;opacity:.13} .spark .l{fill:none;stroke:currentColor;stroke-width:1.5}
.spark.good{color:var(--lime)} .spark.plain{color:var(--dim)}

.strip{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:14px 17px;margin-bottom:22px}
.strip h2,.panel h2,.col h2{font-family:var(--mono);font-size:11px;letter-spacing:.16em;
  text-transform:uppercase;color:var(--faint);margin:0 0 10px;font-weight:500}
.note{color:var(--dim);font-size:14px;margin:0}
.runs{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.runs li{display:flex;align-items:center;gap:9px;font-size:15px}
.pulse{width:8px;height:8px;border-radius:99px;background:var(--lime);flex:none;
  animation:p 1.6s ease-in-out infinite}
@keyframes p{0%,100%{opacity:1}50%{opacity:.2}}

/* board ------------------------------------------------------------------ */
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(296px,1fr));gap:15px}
.col h2{display:flex;align-items:center;gap:8px}
.col h2 .n{font-family:var(--mono);color:var(--ink);background:var(--line);border-radius:99px;
  padding:1px 8px;font-size:11px;letter-spacing:0}
.col h2 .hr{margin-left:auto;color:var(--faint);letter-spacing:0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;
  padding:12px 13px;margin-bottom:10px}
.card.is-held{border-color:#3a3320;background:linear-gradient(180deg,#16140d 0%,var(--panel) 62%)}
.card header{display:flex;align-items:center;justify-content:space-between;gap:8px;
  margin-bottom:8px}
.card code{font-family:var(--mono);font-size:11.5px;color:var(--faint)}
.card h3{font-size:15px;font-weight:500;margin:0 0 9px;line-height:1.38;color:var(--ink)}
.rail{display:flex;gap:3px;flex:none}
.rail i{width:16px;height:4px;border-radius:99px;background:var(--line2);display:block}
.rail i.pass{background:var(--lime)} .rail i.fail{background:var(--red)}
.meta{display:flex;flex-wrap:wrap;gap:5px;font-family:var(--mono);font-size:11px}
.ow{color:var(--ink);border:1px solid var(--line2);border-radius:99px;padding:1px 8px}
.es{color:var(--faint);border:1px solid var(--line);border-radius:99px;padding:1px 8px}
.es.no{color:var(--amber);border-color:#3a3320}
.hold{font-family:var(--mono);font-size:12px;margin:9px 0 0;color:var(--amber)}
.hold.failed{color:var(--red)}
.why{font-size:13px;color:var(--dim);margin:8px 0 0;border-left:2px solid var(--line2);
  padding-left:10px;line-height:1.45}
.empty{color:var(--faint);font-size:14px;font-style:italic}

/* data pane -------------------------------------------------------------- */
.vwrap{position:relative;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:6px;
  height:132px;align-items:end;padding-top:16px}
.vday{display:flex;flex-direction:column;justify-content:flex-end;height:100%;gap:6px}
.vbars{position:relative;display:flex;align-items:flex-end;gap:2px;height:100%}
.vbars i{display:block;flex:1;border-radius:2px 2px 0 0;min-height:2px}
.vc{background:var(--line2)} .vk{background:var(--lime)}
.vd{font-family:var(--mono);font-size:10px;color:var(--faint);text-align:center}
.vmean{position:absolute;left:0;right:0;border-top:1px dashed #35353e;pointer-events:none}
.vmean span{position:absolute;right:0;top:-16px;font-family:var(--mono);font-size:10px;
  color:var(--faint)}
.legend{display:flex;gap:16px;font-family:var(--mono);font-size:11px;color:var(--faint);
  margin-top:11px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;
  vertical-align:-1px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(345px,1fr));gap:15px;
  margin-top:15px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:6px 8px 6px 0;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
tr.cur td{color:var(--lime)}
.num{font-family:var(--mono);text-align:right;white-space:nowrap;color:var(--dim);
  font-variant-numeric:tabular-nums}
.bar{width:32%} .bar i{display:block;height:5px;background:var(--line2);border-radius:99px}
tr.cur .bar i{background:var(--lime)}
.agents{color:var(--dim);font-size:13px;line-height:1.45}
.log{list-style:none;margin:0;padding:0;display:grid;gap:7px;font-size:14px}
.log li{display:grid;grid-template-columns:62px 96px 1fr;gap:11px;align-items:baseline}
.log code{font-family:var(--mono);font-size:12px;color:var(--lime)}
.log .sub{color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dim{color:var(--faint);font-size:11.5px;font-family:var(--mono)}
footer{margin-top:34px;color:var(--faint);font-size:13px;line-height:1.7;
  border-top:1px solid var(--line);padding-top:15px}
@media(max-width:680px){
  body{font-size:16px} .prognums .big{font-size:44px} .prognums .eta{margin-left:0;text-align:left}
  .tile .tv{font-size:34px} .log li{grid-template-columns:58px 1fr} .log .dim{grid-column:1/-1}
  .vd{display:none}
}
</style></head><body><div class="wrap">

<div class="top"><h1>${esc(cfg.name)}</h1>
  <span class="ph">${esc(active?.name ?? "")}</span>
  <span class="bt">built ${esc(built)}</span></div>

<div class="prog">
  <div class="prognums">
    <span class="big">${pctEffort}%</span>
    <span class="lab">by effort<br>${Math.round(doneHours)}h of ${Math.round(totalHours)}h</span>
    <span class="alt">${pctTasks}%</span>
    <span class="lab">by task count<br>${doneCount} of ${activeTasks.length}</span>
    <span class="eta">ETA ${etaLine}</span>
  </div>
  <div class="track"><i class="t" style="width:${pctEffort}%"></i>
    <i class="e" style="left:${pctTasks}%"></i></div>
  <p class="tracknote">The bar is EFFORT, from the board's own estimates; the notch is the
    task count. They disagree when the cheap work is done and the expensive work is not, and
    that gap is the honest part.${
      unestimated
        ? ` ${unestimated} open task${unestimated === 1 ? " carries" : "s carry"} no estimate and
            weigh${unestimated === 1 ? "s" : ""} zero here.`
        : ""
    }</p>
</div>

<input class="tabin" type="radio" name="tab" id="tb" checked>
<input class="tabin" type="radio" name="tab" id="td">
<input class="tabin" type="radio" name="tab" id="ts">
<div class="tabs"><label for="tb">Board</label><label for="td">Data</label>
  <label for="ts">Stats</label></div>

<div class="pane pane-board">
  <div class="tiles">
    ${tile({
      label: "Held at a gate",
      value: String(heldTotal),
      sub: heldTotal ? "work done, verdict outstanding" : "nothing waiting on a signature",
      tone: "warn",
    })}
    ${tile({
      label: "Blocked",
      value: String(blockedTotal),
      sub: "waiting on a decision or a credential",
      tone: "bad",
    })}
    ${tile({
      label: "No finish line",
      value: String(noAc),
      sub: noAc ? "cannot be closed by anyone" : "every open task has one",
      tone: noAc ? "bad" : "good",
    })}
    ${tile({
      label: "Landed today",
      value: String(landedToday),
      sub: `commits &middot; ${DAYS}-day trend`,
      values: commitsByDay,
      tone: "plain",
    })}
  </div>
  <div class="strip"><h2>Executing now</h2>${runStrip}</div>
  <div class="cols">${columns}</div>
</div>

<div class="pane pane-data">
  <div class="panel"><h2>Velocity &middot; last ${DAYS} days</h2>${velocity}
    <div class="legend"><span><i style="background:var(--line2)"></i>commits</span>
      <span><i style="background:var(--lime)"></i>tasks closed</span></div></div>
  <div class="grid2">
    <div class="panel"><h2>Phases</h2><table>${phaseRows}</table></div>
    <div class="panel"><h2>Agent routing</h2><table>${
      agentRows || "<tr><td>no agent definitions found</td></tr>"
    }</table></div>
  </div>
  <div class="panel" style="margin-top:15px"><h2>What landed</h2>
    <ul class="log">${commitRows || "<li>no git history</li>"}</ul></div>
</div>

<div class="pane pane-stats">
  <div class="grid2" style="margin-top:0">
    <div class="panel"><h2>ETA, as predicted &middot; and how it moved</h2>
      <table><tr><th>day</th><th class="num">effort</th><th class="num">left</th>
        <th class="num">predicted</th><th class="num">drift vs now</th></tr>
        ${etaHistoryRows || '<tr><td colspan="5">first recorded build. A row lands per day from now.</td></tr>'}</table>
      <p class="cav">Drift compares each day&rsquo;s prediction to today&rsquo;s. Positive means
        the date moved OUT since that day. One row per day, appended on the first build of
        each day, never rewritten.</p></div>
    <div class="panel"><h2>Remaining effort by owner</h2>
      <table><tr><th>owner</th><th class="num">open</th><th class="num">hours</th>
        <th></th><th class="num"></th></tr>${ownerRows}</table>
      <p class="cav">Open tasks only, weighted by the board&rsquo;s own estimates. This is the
        queue, not a workload: a blocked task sits here while nobody is working on it.</p></div>
  </div>
  ${
    tokenStats?.compTotal
      ? `<div class="panel" style="margin-top:15px"><h2>Where the tokens go</h2>
         ${compBar}
         <div class="kpi">
           <div><p class="k">Output share</p>
             <p class="v" style="color:${tokenStats.outShare < 0.05 ? "var(--amber)" : "var(--lime)"}">${pct(tokenStats.outShare)}</p>
             <p class="w">of spend is generated rather than re-read. A small number on a large
               total means the loop is paying to look at things.</p></div>
           <div><p class="k">Context churn</p>
             <p class="v" style="color:${tokenStats.churnShare > 0.3 ? "var(--amber)" : "var(--ink)"}">${pct(tokenStats.churnShare)}</p>
             <p class="w">of context could not be matched against the cache. High churn means the
               context keeps changing shape, so nothing gets reused.</p></div>
           ${tokenStats.perTurn ? `<div><p class="k">Per turn</p>
             <p class="v">${tokenStats.perTurn.toLocaleString("en-US")}</p>
             <p class="w">tokens per round trip across ${tokenStats.turns} turn${tokenStats.turns === 1 ? "" : "s"}.
               A run with eighty turns is a loop that did not converge.</p></div>` : ""}
           ${reworkSpend?.wasted ? `<div><p class="k">Rework</p>
             <p class="v worse">${reworkSpend.pct}%</p>
             <p class="w">${reworkSpend.wasted.toLocaleString("en-US")} tokens on
               ${reworkSpend.tasks} task${reworkSpend.tasks === 1 ? "" : "s"} that failed a gate, spent
               up to the day each last failed: the attempts that were sent back. Verdicts carry a
               date only, so a retry on the day of a failure is counted here too.</p></div>` : ""}
         </div>
         <p class="cav">Composition is computed from ${tokenStats.detailedCount} run(s) that
           reported a breakdown; runs logging only a total are counted in the totals elsewhere but
           not here, so this shows no composition rather than a fabricated one.</p></div>`
      : ""
  }
  ${
    tokenStats?.byModel?.length
      ? `<div class="panel" style="margin-top:15px"><h2>Spend by model</h2>
         <table><tr><th>model</th><th class="num">tokens</th><th class="num">runs</th>
           <th class="num">share</th></tr>
         ${tokenStats.byModel
           .map(
             ([m, v]) =>
               `<tr><td><code>${esc(m)}</code></td>
                <td class="num">${v.tokens.toLocaleString("en-US")}</td>
                <td class="num">${v.runs}</td>
                <td class="num">${pct(v.tokens / tokenStats.total)}</td></tr>`,
           )
           .join("")}</table>
         <p class="cav">Whether the expensive model is doing the expensive work, or just doing
           the work.</p></div>`
      : ""
  }
  <div class="grid2">
    <div class="panel"><h2>Gate verdicts recorded</h2>
      <table><tr><th>gate</th><th class="num">pass</th><th class="num">fail</th>
        <th class="num">fail rate</th></tr>${gateRows}</table>
      <p class="cav">Every verdict ever recorded, superseded ones included, so this is the
        real find rate rather than a snapshot of the latest.<br><br>
        Of ${quality.gated} task${quality.gated === 1 ? "" : "s"} that reached a gate,
        <b>${quality.firstPassPct}% passed first time</b> and ${quality.reworkPct}% needed
        rework, across ${quality.attempts} attempt${quality.attempts === 1 ? "" : "s"}.
        Counted over tasks that reached a gate at all &mdash; a task nobody reviewed is not a
        first-pass success, and counting it would make the number improve every time work is
        skipped.</p></div>
    <div class="panel"><h2>${tokenStats ? "Tokens by agent" : "What is not measured here"}</h2>
      ${
        tokenStats
          ? `<table><tr><th>agent</th><th class="num">tokens</th><th class="num">runs</th>
             <th class="num">avg</th></tr>${tokenAgentRows}</table>
             <p class="cav"><b>${tokenStats.total.toLocaleString("en-US")}</b> tokens across
             ${tokenStats.byAgent.length} agent${tokenStats.byAgent.length === 1 ? "" : "s"}.
             ${tokenStats.reconCount} of these rows are RECONSTRUCTED, written after the fact from
             a transcript rather than as the work happened, and ${tokenStats.liveCount} are live.
             Those are different objects and the split is shown rather than averaged away.</p>`
          : `<p class="cav"><b>Tokens per task.</b> Not recoverable retrospectively. Agent runs
             report their token use when they finish, but nothing writes it down, so there is no
             record to read. It becomes available once something appends to
             <code>${esc(cfg.runs)}</code> — see ops/caretaker/run.mjs.</p>`
      }
      <p class="cav">
        <b>Actual effort.</b> The board stamps a close date but no start, so elapsed below is
        calendar time from the first commit naming a task. A 2h task opened Monday and closed
        Friday reads as four days. That measures how long work SITS, which is what the ETA
        actually depends on, but it is not hours worked and must not be read as such.<br><br>
        <b>Rework is measured now</b> and is no longer on this list. Verdicts append, so the
        gate panel reports the real first-pass and rework rates rather than a snapshot of the
        latest verdict.</p></div>
  </div>
  <div class="panel" style="margin-top:15px">
    <h2>Slowest closed tasks &middot; estimate against elapsed</h2>
    <table><tr><th>id</th><th>title</th><th class="num">est</th><th class="num">elapsed</th>
      <th class="num">commits</th></tr>${cycleRows || '<tr><td colspan="5">no closed task has a dated commit</td></tr>'}</table>
    <p class="cav">Median estimate ${medEst ? `${medEst}h` : "n/a"}, median elapsed
      ${medDays || "n/a"} day${medDays === 1 ? "" : "s"}, across ${cycle.length} closed tasks git
      can date. Commit count is a churn signal: a task named in twenty commits fought back, and
      that is worth seeing next to what it was estimated at.</p></div>
  ${
    tokenStats
      ? `<div class="panel" style="margin-top:15px"><h2>Tokens by task</h2>
         <table><tr><th>task</th><th class="num">tokens</th><th class="num">runs</th>
           <th>agents</th><th class="num">provenance</th></tr>${tokenTaskRows}</table>
         <p class="cav">Only work that was LOGGED appears here, so a task with no row was not
           necessarily cheap — it may simply predate the log. Rows marked recon were written
           afterwards from a transcript; they carry real measured token counts but their
           timestamps are approximate, which is why they are labelled rather than blended in.</p>
         </div>`
      : ""
  }
</div>

<footer>
  Generated by <code>ops/caretaker/dashboard.mjs</code> from the board, from git, and from the agent
  definitions. It reports the board's own state and does not judge it.<br>
  <b>ETA</b> is remaining effort divided by effort actually closed per calendar day over the last
  ${DAYS} days. Idle days are in the divisor on purpose: the question is when this lands, not what
  a good day looks like. It is an extrapolation from the board's estimates and moves whenever
  either changes.<br>
  Each card draws one rail segment per gate &mdash; filled on a pass, red on a fail, hollow when it
  has not run. <b>Held</b> counts open tasks with a verdict recorded but not the full set, or one
  that failed.
</footer>
</div></body></html>`;
  return html;
}

/* --------------------------------------------------------------------- cli */
const isEntry = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntry) {
  const cfgPath = process.argv[2] ? resolve(process.argv[2]) : join(HERE, "config.json");
  const { cfg, root: ROOT } = readConfig(cfgPath);
  const at = (p) => join(ROOT, p);
  const now = new Date();
  const board = JSON.parse(readFileSync(at(cfg.board), "utf8"));
  const gitFacts = readGit(ROOT, cfg.window ?? 14, now);
  const m = metrics(board, readRuns(ROOT, cfg), gitFacts, cfg, now);
  const history = recordHistory(at(cfg.history ?? "ops/caretaker/history.jsonl"), m, now.toISOString().slice(0, 10));
  const html = render(m, { cfg, agentList: readAgents(ROOT, cfg), commits: gitFacts.commits, history, now });

  const outPath = at(cfg.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  const { pctEffort, doneHours, totalHours, pctTasks, doneCount, activeTasks, heldTotal, blockedTotal, noAc, eta } = m;
  console.log(
    `[caretaker] ${cfg.name}: ${pctEffort}% by effort (${Math.round(doneHours)}/${Math.round(
      totalHours,
    )}h), ${pctTasks}% by count (${doneCount}/${activeTasks.length}), ${heldTotal} held, ` +
      `${blockedTotal} blocked, ${noAc} no finish line, ETA ${eta ? eta.date : "no rate"} -> ${cfg.out}`,
  );
}
