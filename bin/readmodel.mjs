/**
 * READ MODEL — core reads composed into the shapes the web API returns. W-2.
 *
 * It computes nothing core does not already compute. Stages and offered
 * commands come from lifecycle.mjs, which gates apply from board.mjs's
 * missingGates, and every headline number from dashboard.mjs's metrics() — the
 * functions docs/board.html is rendered from, so the page and the API cannot
 * headline different figures (TECH.md §2, C-2). What is here is selection:
 * which rows, which task, which days.
 *
 * UNKNOWN IS NOT ZERO. Every response carries `sources`, saying which data
 * files exist, and a missing source comes back as null rather than as an empty
 * list or a 0, so the client can say "not recorded" and name what records it.
 *
 * The board and dashboard modules are the TARGET repo's own installed copies
 * (ops/caretaker/board.mjs beside its config), so the server applies exactly the
 * rules that repo's CLI applies. drift, events, lifecycle and secrets come from
 * this checkout; none of them is installed into target repos.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as drift from "./drift.mjs";
import * as events from "./events.mjs";
import { freshness as computeFreshness } from "./freshness.mjs";
import { commandsFor, openQuestions, requiredGates, specApprovalNeeded, stageOf, STAGES } from "./lifecycle.mjs";
import { KEY_SHAPES } from "./secrets.mjs";
import { stateDirFor } from "./runstore.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const RUN_ID = /^r_[0-9a-f]{8}$/;
export const RUN_FILES = ["run.json", "diff.patch", "transcript.log", "transcript.live.log", "stderr.log", "egress.jsonl"];
export const COMMANDS = ["start", "block", "todo", "note", "done", "ask", "answer", "triage", "spec-approve", "spec-reject", "pr", "drop"];

const readJsonl = (p) => {
  if (!existsSync(p)) return null;
  return events.parse(readFileSync(p, "utf8")).events;
};
const dayOf = (t) => (t ? String(t).slice(0, 10) : null);
const byTime = (a, b) => (String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0);

/** Second-pass redaction for served text, on whole lines only (TECH.md §1). */
export function redactShapes(text) {
  let s = String(text);
  for (const shape of KEY_SHAPES) {
    s = s.replace(shape.re, (...m) => (shape.keepGroup ? `${m[shape.keepGroup]}[redacted:${shape.name}]` : `[redacted:${shape.name}]`));
  }
  return s;
}

/**
 * Load the target repo's modules and config. Refuses a board.mjs without
 * API_VERSION, with how to upgrade, rather than serving a board whose rules it
 * cannot call.
 */
export async function open(cfgPath, { now = () => new Date(), stateDir: stateOverride } = {}) {
  const cfgAbs = resolve(cfgPath);
  const opsDir = dirname(cfgAbs);
  const boardPath = join(opsDir, "board.mjs");
  if (!existsSync(boardPath)) throw new Error(`no board.mjs beside ${cfgAbs}; point serve at an installed ops/caretaker/config.json`);
  const board = await import(pathToFileURL(boardPath).href);
  if (board.API_VERSION !== 1 || typeof board.command !== "function") {
    throw new Error(
      `${boardPath} predates the web API (no API_VERSION 1). Upgrade the installed tool files from this checkout: ` +
        `cp bin/board.mjs bin/dashboard.mjs ${opsDir}/ — config.json, board.json and prompt.txt are not touched.`,
    );
  }
  let dash = null;
  const dashPath = join(opsDir, "dashboard.mjs");
  if (existsSync(dashPath)) {
    const m = await import(pathToFileURL(dashPath).href);
    if (typeof m.metrics === "function") dash = m;
  }
  dash ??= await import(pathToFileURL(join(HERE, "dashboard.mjs")).href);
  return createReadModel({ cfgPath: cfgAbs, board, dash, now, stateOverride });
}

export function createReadModel({ cfgPath, board, dash, now = () => new Date(), stateOverride }) {
  const ctx = board.loadConfig(cfgPath, dirname(cfgPath));
  const cfg = ctx.cfg;
  const root = ctx.root;
  const at = (p) => join(root, p);
  const GATES = cfg.gates ?? ["reviewer", "qa", "security"];
  const eventsDir = at(cfg.events ?? "ops/caretaker/events");
  const specsDir = cfg.specs ?? "specs";
  // One definition of where runs live, shared with the writer (runstore.mjs).
  const stateDir = stateOverride ? resolve(stateOverride) : stateDirFor(root, cfg);
  const archiveDir = join(stateDir, "runs");
  const staleMs = (cfg.staleRunHours ?? 24) * 3600 * 1000;
  const reworkThreshold = cfg.inbox?.reworkThreshold ?? 2;

  /* --------------------------------------------------------------- sources */
  const hasFiles = (dir, re) => {
    try {
      return readdirSync(dir).some((n) => re.test(n));
    } catch {
      return false;
    }
  };
  function sources() {
    return {
      board: existsSync(ctx.data) ? "present" : "absent",
      runs: existsSync(at(cfg.runs ?? "ops/caretaker/runs.jsonl")) ? "present" : "absent",
      events: hasFiles(eventsDir, /^events-\d{4}-\d\d-\d\d\.jsonl$/) ? "present" : "absent",
      archive: existsSync(archiveDir) ? "present" : "absent",
      agents: cfg.agentsDir && existsSync(at(cfg.agentsDir)) ? "present" : "absent",
      history: existsSync(at(cfg.history ?? "ops/caretaker/history.jsonl")) ? "present" : "absent",
    };
  }

  // Git is spawned three times per read; a short cache keeps a page of
  // parallel requests from spawning it thirty. Five seconds is below the
  // stream's poll interval, so a commit still shows on the next refetch.
  let gitCache = { at: 0, v: null };
  function gitFacts() {
    const t = Date.now();
    if (!gitCache.v || t - gitCache.at > 5000) gitCache = { at: t, v: dash.readGit(root, cfg.window ?? 14, now()) };
    return gitCache.v;
  }

  const loadBoard = () => board.load(ctx);
  // dashboard.mjs reads cfg.runs with no default; the server applies the one
  // every other reader here uses, so a config without it still finds the log.
  const runRows = () => (sources().runs === "present" ? dash.readRuns(root, { ...cfg, runs: cfg.runs ?? "ops/caretaker/runs.jsonl" }) : null);
  const eventLog = () => (sources().events === "present" ? events.read(eventsDir).events : null);

  /* ------------------------------------------------------------------ runs */
  function archived() {
    const out = new Map();
    let names = [];
    try {
      names = readdirSync(archiveDir);
    } catch {
      return out;
    }
    for (const id of names) {
      if (!RUN_ID.test(id)) continue;
      try {
        out.set(id, JSON.parse(readFileSync(join(archiveDir, id, "run.json"), "utf8")));
      } catch {
        out.set(id, null); // a directory without a readable run.json is still a run
      }
    }
    return out;
  }

  /**
   * Runs, folded by id from the event log (B-6 agent events), the run log
   * (rows carrying `run`) and the archive. Rows with no id are LEGACY and are
   * returned apart, never paired by guesswork. A start with no end older than
   * staleRunHours is `noEndRecorded`, not running.
   */
  function foldRuns() {
    const runs = new Map();
    const get = (id) => {
      if (!runs.has(id)) runs.set(id, { id, task: null, agent: null, model: null, adapter: null, cli: null, parent: null, start: null, end: null, state: null, reason: null, tokens: null, files: null, durationMs: null, src: [], warnings: [] });
      return runs.get(id);
    };
    const ev = eventLog();
    for (const e of ev ?? []) {
      if (e.kind !== "agent" || !e.run) continue;
      const r = get(e.run);
      if (!r.src.includes("events")) r.src.push("events");
      r.task ??= e.task ?? null;
      if (e.phase === "start") r.start = e.t;
      if (e.phase === "end") {
        r.end = e.t;
        r.state = e.state ?? r.state;
        r.tokens = Number.isFinite(e.tokens) ? e.tokens : r.tokens;
        r.files = Number.isFinite(e.files) ? e.files : r.files;
        r.durationMs = Number.isFinite(e.durationMs) ? e.durationMs : r.durationMs;
        r.reason = e.detail ?? r.reason;
      }
    }
    const rows = runRows();
    const legacy = [];
    for (const row of rows ?? []) {
      if (!row.run || !RUN_ID.test(row.run)) {
        legacy.push({ t: row.t ?? null, kind: row.kind ?? null, agent: row.name ?? null, state: row.state ?? null, task: row.task ?? null, tokens: Number.isFinite(row.tokens) ? row.tokens : null, model: row.model ?? null, src: row.src ?? "live", note: row.note ?? null });
        continue;
      }
      const r = get(row.run);
      if (!r.src.includes("runlog")) r.src.push("runlog");
      r.task ??= row.task ?? null;
      r.agent ??= row.name ?? null;
      r.model ??= row.model ?? null;
      r.parent ??= row.parent ?? null;
      r.adapter ??= row.adapter ?? null;
      r.cli ??= row.cli ?? null;
      if (row.src === "reconstructed") r.reconstructed = true;
      if (row.kind === "start") r.start ??= row.t;
      if (row.kind === "end") {
        r.end ??= row.t;
        r.state ??= row.state ?? null;
        if (Number.isFinite(row.tokens)) r.tokens ??= row.tokens;
        for (const k of ["in", "cached", "write", "out", "turns"]) if (Number.isFinite(row[k])) (r.breakdown ??= {})[k] = row[k];
      }
    }
    for (const [id, rec] of archived()) {
      const r = get(id);
      r.src.push("archive");
      if (!rec) continue;
      const v = rec.verdict ?? {};
      r.task = rec.task ?? r.task;
      r.parent = rec.parent ?? r.parent;
      r.adapter = rec.adapter ?? v.adapter ?? r.adapter;
      r.cli = rec.cli ?? v.cli ?? r.cli;
      r.model = rec.model ?? r.model;
      r.state = v.state ?? r.state;
      r.reason = v.reason ?? r.reason;
      r.start = v.startedAt ?? r.start;
      r.end = v.endedAt ?? r.end;
      r.durationMs = v.durationMs ?? r.durationMs;
      r.timeoutMs = v.timeoutMs ?? null;
      r.exitCode = v.exitCode ?? null;
      r.warnings = v.warnings ?? [];
      if (rec.cost?.tokens) r.breakdown = rec.cost.tokens;
      if (Number.isFinite(rec.cost?.tokens?.total)) r.tokens = rec.cost.tokens.total;
      if (rec.diff) r.diff = rec.diff;
      if (Number.isFinite(rec.diff?.files?.length)) r.files = rec.diff.files.length;
    }
    const t = now().getTime();
    for (const r of runs.values()) {
      if (r.start && !r.end) {
        r.noEndRecorded = t - Date.parse(r.start) > staleMs;
        r.status = r.noEndRecorded ? "no end recorded" : "running";
      } else r.status = r.state ?? (r.end ? "ended" : "unknown");
    }
    const list = [...runs.values()].sort((a, b) => byTime(b.start ?? b.end, a.start ?? a.end));
    for (const r of list) r.children = list.filter((c) => c.parent === r.id).map((c) => c.id);
    return { runs: list, legacy, sourced: ev !== null || rows !== null || runs.size > 0 };
  }

  /* ------------------------------------------------------------------ work */
  function taskCtx(t, runsByTask) {
    return { cfg, runs: runsByTask.get(t.id) ?? [], spec: board.specInfo(root, t), now: now(), missingGates: board.missingGates };
  }
  const runsByTaskOf = (runs) => {
    const m = new Map();
    for (const r of runs) if (r.task) m.set(r.task, [...(m.get(r.task) ?? []), r]);
    return m;
  };
  const tokensByTask = (legacy, runs) => {
    const m = new Map();
    for (const r of [...runs, ...legacy]) if (r.task && Number.isFinite(r.tokens)) m.set(r.task, (m.get(r.task) ?? 0) + r.tokens);
    return m;
  };

  function summarise(t, phase, c, tokens) {
    const s = stageOf(t, c);
    return {
      id: t.id,
      title: t.title,
      owner: t.owner ?? null,
      est: t.est ?? null,
      status: t.status,
      phase,
      deps: t.deps ?? [],
      lifecycle: s.stage,
      reason: s.reason,
      rework: s.rework ?? null,
      blocked: s.blocked ?? null,
      missingGates: s.missing,
      gates: Object.fromEntries(GATES.map((g) => [g, t.gate?.[g] ? { verdict: t.gate[g].verdict, attempts: (t.gate[g].history ?? []).length + 1 } : null])),
      runs: c.runs.length,
      tokens: tokens ?? null,
      openQuestions: openQuestions(t).length,
      pr: t.pr?.url ?? null,
      hasAc: !!(Array.isArray(t.ac) ? t.ac.length : String(t.ac ?? "").trim()),
      commands: commandsFor(t, c),
    };
  }

  function work() {
    const d = loadBoard();
    const { runs, legacy } = foldRuns();
    const rbt = runsByTaskOf(runs);
    const tbt = tokensByTask(legacy, runs);
    const tasks = board.allTasks(d).map((t) => summarise(t, t.phase.name, taskCtx(t, rbt), tbt.get(t.id)));
    const active = d.phases.find((p) => p.name === cfg.activePhase) ?? d.phases[d.phases.length - 1];
    return {
      sources: sources(),
      phases: d.phases.map((p) => p.name),
      activePhase: active?.name ?? null,
      stages: [...STAGES.slice(0, -1), "done"],
      columns: cfg.columns ?? [],
      gates: GATES,
      tasks,
    };
  }

  function workItem(id) {
    const d = loadBoard();
    const hit = board.find(d, id);
    if (!hit) return null;
    const t = hit.t;
    const { runs, legacy } = foldRuns();
    const rbt = runsByTaskOf(runs);
    const c = taskCtx(t, rbt);
    const sum = summarise(t, hit.p.name, c, tokensByTask(legacy, runs).get(t.id));
    const notes = String(t.note ?? "")
      .split(/\s+—\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .reverse();
    const gateHistory = Object.fromEntries(
      Object.entries(t.gate ?? {}).map(([g, rec]) => [g, [...(rec.history ?? []), { verdict: rec.verdict, at: rec.at, note: rec.note }]]),
    );
    const ev = eventLog();
    return {
      sources: sources(),
      ...sum,
      ac: t.ac ?? null,
      completed: t.completed ?? null,
      blockedReason: t.blockedReason ?? null,
      notes,
      gateHistory,
      requiredGates: requiredGates(t, board.missingGates),
      questions: t.questions ?? [],
      triage: t.triage ?? [],
      spec: c.spec,
      specReview: t.specReview ?? [],
      specApprovalNeeded: specApprovalNeeded(t, c.spec),
      prRecord: t.pr ?? null,
      dropped: t.dropped ?? null,
      runList: c.runs.map(runRow),
      legacyRuns: legacy.filter((r) => r.task === t.id),
      events: ev === null ? null : ev.filter((e) => e.task === t.id).slice(-50).reverse(),
    };
  }

  /* ----------------------------------------------------------------- inbox */
  function inboxItems(d, runs) {
    const rbt = runsByTaskOf(runs);
    const ev = eventLog() ?? [];
    const items = [];
    for (const t of board.allTasks(d)) {
      if (t.status === "dropped" || t.status === "done") continue;
      const c = taskCtx(t, rbt);
      const cmds = commandsFor(t, c);
      const base = { task: t.id, title: t.title, owner: t.owner ?? null };
      for (const q of openQuestions(t)) {
        items.push({ ...base, kind: "question", since: q.at ?? null, fact: `${q.by ?? "someone"} asked: ${q.q}`, question: q, actions: cmds.filter((x) => x.cmd === "answer" && x.fixed?.qid === q.id) });
      }
      if (specApprovalNeeded(t, c.spec)) {
        const last = (t.specReview ?? []).filter((r) => r.path === c.spec.path).slice(-1)[0];
        items.push({
          ...base,
          kind: "spec-approval",
          since: last?.at ?? null,
          fact: last ? `${c.spec.path} changed since it was last reviewed (${last.decision} at ${String(last.blob).slice(0, 7)})` : `${c.spec.path} has never been approved`,
          spec: c.spec,
          actions: cmds.filter((x) => x.cmd === "spec-approve" || x.cmd === "spec-reject"),
        });
      }
      const gate = t.gate ?? {};
      const required = requiredGates(t, board.missingGates);
      const reasons = [];
      let since = null;
      if (gate.security?.verdict === "fail") {
        reasons.push(`security failed on ${gate.security.at}`);
        since = gate.security.at;
      }
      // Refutations (H-3, `source: "refute"`) are gate events too, but they are
      // not the drift gate: they land on the board as qa verdicts, and the qa
      // rework rule below is where they surface. Counting one here would attach
      // a drift-dismissal command to it, and a later one could mask a drift fail.
      const driftGate = ev.filter((e) => e.task === t.id && e.kind === "gate" && e.verdict && e.source !== "refute").sort((a, b) => byTime(a.t, b.t));
      const lastDrift = driftGate[driftGate.length - 1];
      if (lastDrift?.verdict === "fail") {
        reasons.push(`the drift gate failed at ${lastDrift.t}: ${lastDrift.detail ?? ""}`.trim());
        since ??= lastDrift.t;
      }
      for (const g of required) {
        const rec = gate[g];
        if (!rec) continue;
        const fails = [...(rec.history ?? []), rec].filter((a) => a.verdict === "fail");
        if (rec.verdict === "fail" && fails.length >= reworkThreshold) {
          reasons.push(`${g} has failed ${fails.length} times`);
          since ??= fails[0].at;
        }
      }
      if (reasons.length) {
        items.push({
          ...base,
          kind: "gate-failure",
          since,
          fact: reasons.join("; "),
          gateHistory: Object.fromEntries(Object.entries(gate).map(([g, rec]) => [g, [...(rec.history ?? []), { verdict: rec.verdict, at: rec.at, note: rec.note }]])),
          dismissCommand: lastDrift?.verdict === "fail" ? `node bin/drift.mjs check --task ${t.id} --dismiss <glob> --reason "…" --by <you>` : null,
          actions: [],
        });
      }
      const s = stageOf(t, c);
      if (s.stage === "human" && t.pr?.url) {
        items.push({ ...base, kind: "pr-review", since: t.pr.at ?? null, fact: `every required gate passed; PR ${t.pr.url}`, pr: t.pr.url, actions: cmds.filter((x) => x.cmd === "done") });
      }
    }
    // Oldest first; an item whose fact carries no time sorts last, not first.
    return items.sort((a, b) => (a.since && b.since ? byTime(a.since, b.since) : a.since ? -1 : b.since ? 1 : 0));
  }
  function inbox() {
    const { runs } = foldRuns();
    const items = inboxItems(loadBoard(), runs);
    const counts = { question: 0, "spec-approval": 0, "gate-failure": 0, "pr-review": 0 };
    for (const i of items) counts[i.kind] += 1;
    return { sources: sources(), threshold: reworkThreshold, counts, items };
  }

  /* ----------------------------------------------------------- run reads */
  function runRow(r) {
    return {
      id: r.id, task: r.task, agent: r.agent, model: r.model, adapter: r.adapter, cli: r.cli, parent: r.parent,
      status: r.status, noEndRecorded: !!r.noEndRecorded, start: r.start, end: r.end,
      durationMs: r.durationMs ?? (r.start && r.end ? Date.parse(r.end) - Date.parse(r.start) : null),
      tokens: r.tokens, files: r.files, reconstructed: !!r.reconstructed, src: r.src, children: r.children ?? [],
    };
  }
  function runsList(filter = {}) {
    const { runs, legacy, sourced } = foldRuns();
    const legacyOrNull = runRowsNull(legacy);
    const keep = (r) =>
      (!filter.task || r.task === filter.task) &&
      (!filter.state || r.status === filter.state) &&
      (!filter.agent || r.agent === filter.agent) &&
      (!filter.model || r.model === filter.model);
    return {
      sources: sources(),
      runs: sourced ? runs.filter(keep).map(runRow) : null,
      legacy: legacyOrNull === null ? null : legacyOrNull.filter((r) => (!filter.task || r.task === filter.task) && (!filter.agent || r.agent === filter.agent) && (!filter.model || r.model === filter.model)),
      staleRunHours: cfg.staleRunHours ?? 24,
    };
  }
  const runRowsNull = (legacy) => (sources().runs === "present" ? legacy : null);

  function run(id) {
    if (!RUN_ID.test(id)) return null;
    const { runs } = foldRuns();
    const r = runs.find((x) => x.id === id);
    if (!r) return null;
    const ev = eventLog();
    const archiveFiles = {};
    for (const f of RUN_FILES) archiveFiles[f] = runFilePath(id, f) ? statSync(runFilePath(id, f)).size : null;
    const d = loadBoard();
    const hit = r.task ? board.find(d, r.task) : null;
    return {
      sources: sources(),
      ...runRow(r),
      reason: r.reason,
      exitCode: r.exitCode ?? null,
      timeoutMs: r.timeoutMs ?? null,
      warnings: r.warnings ?? [],
      breakdown: r.breakdown ?? null,
      diff: r.diff ? { files: r.diff.files ?? null, insertions: r.diff.insertions ?? null, deletions: r.diff.deletions ?? null, truncated: !!r.diff.truncated, ignoredPathsNotMeasured: r.diff.ignoredPathsNotMeasured ?? true } : null,
      archiveFiles,
      events: ev === null ? null : ev.filter((e) => e.run === id),
      // Task-level verdicts, with their dates. Never attributed to this run:
      // a board verdict belongs to the task, and its date carries no time.
      taskGates: hit ? Object.fromEntries(Object.entries(hit.t.gate ?? {}).map(([g, rec]) => [g, { verdict: rec.verdict, at: rec.at }])) : null,
      taskTitle: hit?.t.title ?? null,
    };
  }

  /**
   * A path inside the run archive, or null. The id and the name are checked
   * against fixed shapes first, then the resolved path must sit under the
   * archive after symlinks are followed. shadow/ is never in RUN_FILES.
   */
  function runFilePath(id, name) {
    if (!RUN_ID.test(id) || !RUN_FILES.includes(name)) return null;
    const p = join(archiveDir, id, name);
    try {
      const real = realpathSync(p);
      const base = realpathSync(archiveDir);
      if (!real.startsWith(base + sep)) return null;
      return statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  }

  /**
   * Bytes of an archived file from `from`, as whole lines, redacted. Returns
   * { text, next } where `next` is the offset on disk to resume from; a partial
   * last line is held back until its newline arrives.
   */
  function runFile(id, name, from = 0) {
    const p = runFilePath(id, name);
    if (!p) return null;
    const size = statSync(p).size;
    const start = Math.max(0, Math.min(Number(from) || 0, size));
    const len = Math.min(size - start, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(p, "r");
    try {
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
    const lastNl = buf.lastIndexOf(10);
    const whole = lastNl < 0 ? Buffer.alloc(0) : buf.subarray(0, lastNl + 1);
    return { text: redactShapes(whole.toString("utf8")), next: start + whole.length, size };
  }

  /* ---------------------------------------------------------------- agents */
  function agents() {
    const defs = sources().agents === "present" ? dash.readAgents(root, cfg) : null;
    const { runs, legacy } = foldRuns();
    const d = loadBoard();
    const all = [...runs.map(runRow), ...legacy.map((l) => ({ ...l, status: l.state }))];
    const names = new Set([...(defs ?? []).map((a) => a.name), ...all.map((r) => r.agent).filter(Boolean)]);
    return {
      sources: sources(),
      defined: defs !== null,
      agentsDir: cfg.agentsDir ?? null,
      agents: [...names].sort().map((name) => {
        const def = defs?.find((a) => a.name === name) ?? null;
        const mine = all.filter((r) => r.agent === name);
        const owned = d.phases.map((p) => ({ ...p, tasks: (p.tasks ?? []).filter((t) => t.owner === name) }));
        const q = dash.quality(owned, GATES);
        return {
          name,
          model: def?.model ?? mine.find((r) => r.model)?.model ?? null,
          defined: !!def,
          runs: mine.length,
          tokens: mine.some((r) => Number.isFinite(r.tokens)) ? mine.reduce((n, r) => n + (Number.isFinite(r.tokens) ? r.tokens : 0), 0) : null,
          firstPass: q.gated ? { pct: q.firstPassPct, gated: q.gated } : null,
          current: runs.filter((r) => r.agent === name && r.status === "running").map((r) => ({ id: r.id, task: r.task })),
          openTasks: board.allTasks(d).filter((t) => t.owner === name && t.status !== "done" && t.status !== "dropped").length,
        };
      }),
    };
  }

  /* ----------------------------------------------------------------- specs */
  function specs() {
    const { specs: list, skipped } = drift.loadSpecs(specsDir, { repo: root });
    const own = drift.buildOwnership(list);
    let tree = null;
    let changed = null;
    try {
      tree = drift.treeFromGit(root);
      changed = drift.changedFromGit(root);
    } catch {
      /* not a git checkout: ownership still shows, orphans and unowned do not */
    }
    const resolver = drift.createGlobResolver(own);
    const specIds = new Set(own.specIds);
    const unowned = changed === null ? null : changed.filter((p) => !specIds.has(p) && !resolver.owners(p).length);
    const ev = eventLog();
    const d = loadBoard();
    const approvals = board
      .allTasks(d)
      .filter((t) => t.spec)
      .map((t) => {
        const info = board.specInfo(root, t);
        const last = (t.specReview ?? []).slice(-1)[0] ?? null;
        return { task: t.id, title: t.title, path: t.spec, governing: !!info?.governing, exists: !!info?.exists, needed: specApprovalNeeded(t, info), last };
      });
    return {
      sources: sources(),
      specsDir,
      specs: list.map((s) => ({ id: s.id, governs: s.governs, errors: s.errors })),
      skipped,
      claims: own.claims.map(({ spec, glob }) => ({ spec, glob, matches: tree ? tree.filter((p) => resolver.matches(p).some((m) => m.spec === spec && m.glob === glob)).length : null })),
      orphaned: drift.findOrphaned(own, tree),
      unowned,
      changed,
      drift: ev === null ? null : ev.filter((e) => e.kind === "drift" || (e.kind === "gate" && /drift|governed/.test(e.detail ?? ""))).slice(-100).reverse(),
      approvals,
      dismissCommand: `node bin/drift.mjs check --dismiss <glob> --reason "why" --by <you> [--dismiss-task T-1]`,
      // Computed from git on every read (P-5, B-3). null, not empty, when this
      // is not a git checkout: "nothing is stale" and "cannot tell" differ.
      freshness: (() => {
        if (tree === null) return null;
        try {
          const f = computeFreshness({ repo: root, specsDir });
          return { stale: f.stale, lying: f.lying, undated: f.undated, ok: f.ok };
        } catch {
          return null;
        }
      })(),
    };
  }

  /* --------------------------------------------------------------- metrics */
  function headline() {
    const d = loadBoard();
    const rows = runRows();
    return dash.metrics(d, rows, gitFacts(), cfg, now());
  }

  function snapshot() {
    const m = headline();
    const { runs, legacy } = foldRuns();
    const d = loadBoard();
    const items = inboxItems(d, runs);
    const ev = eventLog();
    const doneIds = new Set(board.allTasks(d).filter((t) => t.status === "done").map((t) => t.id));
    const closedTok = m.tokenStats ? m.tokenStats.byTask.filter(([k]) => doneIds.has(k)) : null;
    return {
      sources: sources(),
      name: cfg.name ?? null,
      activePhase: m.active?.name ?? null,
      progress: {
        pctEffort: m.pctEffort, pctTasks: m.pctTasks, doneHours: m.doneHours, totalHours: m.totalHours,
        doneCount: m.doneCount, total: m.activeTasks.length, unestimated: m.unestimated, remainingHours: m.remainingHours,
      },
      eta: m.eta,
      window: m.DAYS,
      held: m.heldTotal,
      blocked: m.blockedTotal,
      noAc: m.noAc,
      quality: m.quality,
      cycle: { medDays: m.medDays || null, medEst: m.medEst || null, closed: m.cycle.length },
      tokensPerClosedTask: closedTok && closedTok.length ? { tokens: Math.round(closedTok.reduce((n, [, v]) => n + v.tokens, 0) / closedTok.length), tasks: closedTok.length } : null,
      executing: runs.filter((r) => r.start && !r.end).map(runRow),
      legacyRunning: runRowsNull(legacy)?.filter((r) => r.state === "running") ?? null,
      inbox: { count: items.length, oldest: items.slice(0, 4) },
      events: ev === null ? null : ev.slice(-40).reverse(),
      commitsByDay: m.commitsByDay,
      closedByDay: m.closedByDay,
      windowDays: m.WINDOW,
    };
  }

  /** The Metrics page: dashboard.mjs's functions, over the rows inside the range. */
  function metrics(days = 14) {
    days = [7, 14, 30].includes(Number(days)) ? Number(days) : 14;
    const d = loadBoard();
    const rows = runRows();
    const window = dash.lastDays(days, now());
    const inRange = (t) => t && dayOf(t) >= window[0];
    const ranged = rows === null ? null : rows.filter((r) => inRange(r.t));
    const perDay = rows === null ? null : window.map((day) => {
      const ts = dash.tokenStats(rows.filter((r) => dayOf(r.t) === day));
      return { day, comp: ts?.compTotal ? ts.comp : null, total: ts?.total ?? 0 };
    });
    // Gate verdicts inside the range: the same gateStats and quality, over a
    // board whose attempts outside the window are removed.
    const rangedPhases = d.phases.map((p) => ({
      ...p,
      tasks: (p.tasks ?? []).map((t) => {
        const gate = {};
        for (const [g, rec] of Object.entries(t.gate ?? {})) {
          const att = [...(rec.history ?? []), { verdict: rec.verdict, at: rec.at }].filter((a) => inRange(a.at));
          if (att.length) gate[g] = { ...att[att.length - 1], history: att.slice(0, -1) };
        }
        return { ...t, gate };
      }),
    }));
    const m = headline();
    return {
      sources: sources(),
      days,
      window,
      tokens: ranged === null ? null : dash.tokenStats(ranged),
      tokensPerDay: perDay,
      reworkSpend: ranged === null ? null : dash.reworkSpend(d.phases, ranged, GATES),
      gateStats: dash.gateStats(rangedPhases, GATES),
      quality: dash.quality(rangedPhases, GATES),
      allTime: { gateStats: m.gateStats, quality: m.quality },
      cycle: m.cycle,
      medDays: m.medDays || null,
      medEst: m.medEst || null,
      commitsByDay: m.commitsByDay,
      closedByDay: m.closedByDay,
      closedHoursByDay: m.closedHoursByDay,
      closedWindow: m.WINDOW,
    };
  }

  function recentEvents({ limit = 100, level = null } = {}) {
    const ev = eventLog();
    const order = events.LEVELS;
    return {
      sources: sources(),
      events: ev === null ? null : ev.filter((e) => !level || order.indexOf(e.level) >= order.indexOf(level)).slice(-limit).reverse(),
    };
  }

  function settings(server = {}) {
    return {
      sources: sources(),
      config: cfg,
      configPath: cfgPath,
      root,
      stateDir,
      eventsDir,
      specsDir: join(root, specsDir),
      paths: {
        board: ctx.data,
        runs: at(cfg.runs ?? "ops/caretaker/runs.jsonl"),
        history: at(cfg.history ?? "ops/caretaker/history.jsonl"),
        archive: archiveDir,
        agents: cfg.agentsDir ? at(cfg.agentsDir) : null,
        page: cfg.out ? at(cfg.out) : null,
      },
      operator: board.operator(cfg),
      server,
    };
  }

  /* --------------------------------------------------------------- command */
  /**
   * Every mutation goes through core's own `command`, under core's lock, and
   * core checks again. The caller adds only who (`by`, with `via`: "web" from
   * the server, "tui" from the terminal view) and
   * the spec's current blob for spec review, computed by core's specInfo.
   */
  function command(id, cmd, args = {}, { via = "web" } = {}) {
    if (!COMMANDS.includes(cmd)) return { status: 400, body: { error: `unknown command: ${cmd}` } };
    const opts = { by: board.operator(cfg), via };
    const res = board.mutate(ctx, (d) => {
      const hit = board.find(d, id);
      if (!hit) return { ok: false, notFound: true, error: `no such task: ${id}` };
      if (cmd.startsWith("spec-")) opts.spec = board.specInfo(root, hit.t);
      return board.command(d, id, cmd, args, opts);
    });
    if (res.notFound) return { status: 404, body: { error: res.error } };
    if (!res.ok) return { status: 409, body: res.refused ? { refused: res.refused } : { error: res.error } };
    try {
      board.build(ctx);
    } catch {
      /* the board changed; a failed markdown rebuild must not report it did not */
    }
    return { status: 200, body: { task: workItem(res.task.id) } };
  }

  return {
    cfg, root, stateDir, eventsDir, archiveDir, ctx,
    sources, snapshot, work, workItem, inbox, runs: runsList, run, runFile, runFilePath,
    agents, specs, metrics, settings, events: recentEvents, command,
    watchPaths: () => ({
      board: ctx.data,
      runs: at(cfg.runs ?? "ops/caretaker/runs.jsonl"),
      eventsDir,
      archiveDir,
      specsDir: join(root, specsDir),
    }),
  };
}
