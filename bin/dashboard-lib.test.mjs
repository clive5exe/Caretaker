#!/usr/bin/env node
/**
 * C-2: the dashboard's metrics are exported, and the page did not change.
 *
 *   1. BACK TO BACK. The pre-C-2 dashboard is frozen in
 *      testdata/dashboard.pre-c2.mjs. Both render the same fixture repo (a git
 *      history, a board with closed and held tasks, a run log with a token
 *      breakdown, agent definitions and an ETA history) and the two pages must
 *      be identical. Normalised, and only these: the `built` stamp, git's
 *      relative dates (`%ar`), which do not freeze, and the commit shas, which
 *      differ because each fixture commits its own copy of the dashboard.
 *   2. IMPORT. Importing dashboard.mjs writes nothing, and metrics() returns the
 *      numbers the page headlines.
 *
 * Run: node bin/dashboard-lib.test.mjs
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
};

function fixture(dashFile) {
  const root = mkdtempSync(join(tmpdir(), "caretaker-dashlib-"));
  const ops = join(root, "ops", "caretaker");
  mkdirSync(ops, { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  copyFileSync(dashFile, join(ops, "dashboard.mjs"));
  writeFileSync(
    join(ops, "config.json"),
    JSON.stringify({
      name: "Fixture <&>",
      board: "docs/board.json",
      out: "docs/board.html",
      runs: "ops/caretaker/runs.jsonl",
      history: "ops/caretaker/history.jsonl",
      agentsDir: ".claude/agents",
      repo: ".",
      activePhase: "Phase 1",
      gates: ["reviewer", "qa", "security"],
      columns: [
        { key: "doing", label: "Working" },
        { key: "todo", label: "Queued" },
        { key: "blocked", label: "Blocked" },
        { key: "done", label: "Done" },
      ],
    }),
  );
  const g = (verdict, at, history) => ({ verdict, at, ...(history ? { history } : {}) });
  writeFileSync(
    join(root, "docs", "board.json"),
    JSON.stringify({
      meta: { name: "Fixture" },
      phases: [
        { name: "Phase 0", tasks: [{ id: "T-100", title: "old", owner: "you", est: "2h", status: "done", completed: day(3) }] },
        {
          name: "Phase 1",
          tasks: [
            { id: "T-001", title: "closed <b>early</b>", owner: "builder", est: "1d", status: "done", completed: day(2), ac: "a",
              gate: { reviewer: g("pass", day(2)), qa: g("pass", day(2), [{ verdict: "fail", at: day(4) }]) } },
            { id: "T-002", title: "held on qa", owner: "builder", est: "4h", status: "doing", ac: "b",
              gate: { reviewer: g("pass", day(1)) } },
            { id: "T-003", title: "failed security", owner: "security", est: "M", status: "doing", ac: "c",
              gate: { security: g("fail", day(1)) } },
            { id: "T-004", title: "blocked", owner: "founder", est: "2w", status: "blocked", blockedReason: "needs a key" },
            { id: "T-005", title: "unestimated", owner: "builder", status: "todo", ac: "d" },
            { id: "T-006", title: "dropped", owner: "builder", est: "1h", status: "dropped" },
            { id: "T-007", title: "closed too", owner: "reviewer", est: "30m", status: "done", completed: day(0), ac: "e",
              gate: { reviewer: g("pass", day(0)), qa: g("pass", day(0)) } },
          ],
        },
      ],
    }),
  );
  writeFileSync(
    join(ops, "runs.jsonl"),
    [
      // T-001's first attempt, sent back by qa on day(4); the day(2) run then passed.
      { t: `${day(4)}T10:00:00Z`, kind: "end", name: "builder", state: "done", task: "T-001", tokens: 40000, model: "opus", src: "live" },
      { t: `${day(2)}T10:00:00Z`, kind: "start", name: "builder", state: "running", task: "T-001" },
      { t: `${day(2)}T11:00:00Z`, kind: "end", name: "builder", state: "done", task: "T-001", tokens: 120000, in: 5000, cached: 100000, write: 10000, out: 5000, turns: 12, model: "opus", src: "live" },
      { t: `${day(1)}T11:00:00Z`, kind: "end", name: "reviewer", state: "done", task: "T-002", tokens: 3000, model: "haiku", src: "reconstructed" },
      { t: `${day(0)}T09:00:00Z`, kind: "start", name: "security", state: "running", task: "T-003", note: "attacking <it>" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n{half a line",
  );
  writeFileSync(join(ops, "history.jsonl"), JSON.stringify({ d: day(1), pctEffort: 3, pctTasks: 20, remainingHours: 120, eta: day(-30), done: 1, held: 2, blocked: 1 }) + "\n");
  writeFileSync(join(root, ".claude", "agents", "builder.md"), "---\nname: builder\nmodel: opus\n---\n");
  writeFileSync(join(root, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\n---\n");
  const git = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  git("init", "-q");
  // Commits dated inside the window, naming task ids, so velocity and cycle time have data.
  for (const [i, msg] of [[5, "start T-001"], [3, "T-001 again and T-002"], [2, "close T-001"], [0, "T-007 <script>"]]) {
    writeFileSync(join(root, `f${i}`), msg);
    git("add", "-A");
    spawnSync("git", ["-C", root, "commit", "-q", "-m", msg], {
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x", GIT_AUTHOR_DATE: `${day(i)}T12:00:00`, GIT_COMMITTER_DATE: `${day(i)}T12:00:00` },
    });
  }
  return { root, ops };
}

const normalise = (html) =>
  html
    .replace(/built \d{4}-\d\d-\d\d \d\d:\d\d/g, "built <built>")
    .replace(/<li><code>[0-9a-f]+<\/code><span class="dim">[^<]*<\/span>/g, "<li><code><sha></code><span class=\"dim\"><ar></span>");

/* 1. back to back --------------------------------------------------------- */
{
  const old = fixture(join(HERE, "testdata", "dashboard.pre-c2.mjs"));
  const neu = fixture(join(HERE, "dashboard.mjs"));
  const ro = spawnSync("node", [join(old.ops, "dashboard.mjs")], { cwd: old.root, encoding: "utf8" });
  const rn = spawnSync("node", [join(neu.ops, "dashboard.mjs")], { cwd: neu.root, encoding: "utf8" });
  ok("the old page renders", ro.status === 0, ro.stderr);
  ok("the new page renders", rn.status === 0, rn.stderr);
  const a = normalise(readFileSync(join(old.root, "docs", "board.html"), "utf8"));
  const b = normalise(readFileSync(join(neu.root, "docs", "board.html"), "utf8"));
  let firstDiff = -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { firstDiff = i; break; }
  ok(
    `the page is identical, old and new (${a.length} bytes)`,
    a === b,
    firstDiff < 0 ? "" : `first difference at ${firstDiff}:\n      old: ${JSON.stringify(a.slice(firstDiff - 80, firstDiff + 120))}\n      new: ${JSON.stringify(b.slice(firstDiff - 80, firstDiff + 120))}`,
  );
  ok("the console summary line is identical", ro.stdout === rn.stdout, `${ro.stdout}\n      ${rn.stdout}`);
  ok("the history file is identical", readFileSync(join(old.ops, "history.jsonl"), "utf8") === readFileSync(join(neu.ops, "history.jsonl"), "utf8"));
  // The fixture must exercise the parts it claims to: held, tokens, the ETA table.
  ok("the fixture reaches held tasks, token composition, rework and ETA history", /failed/.test(b) && /attempts that were sent back/.test(b) && /Where the tokens go/.test(b) && /drift vs now/.test(b) && /builder/.test(b));
  for (const x of [old, neu]) rmSync(x.root, { recursive: true, force: true });
}

/* 2. import --------------------------------------------------------------- */
{
  const f = fixture(join(HERE, "dashboard.mjs"));
  const probe = `
    const m = await import(${JSON.stringify(pathToFileURL(join(f.ops, "dashboard.mjs")).href)});
    const { readFileSync } = await import("node:fs");
    const { cfg, root } = m.readConfig(${JSON.stringify(join(f.ops, "config.json"))});
    const board = JSON.parse(readFileSync(root + "/" + cfg.board, "utf8"));
    const git = m.readGit(root, 14);
    const r = m.metrics(board, m.readRuns(root, cfg), git, cfg);
    console.log(JSON.stringify({
      keys: Object.keys(m).sort(),
      pctTasks: r.pctTasks, pctEffort: r.pctEffort, held: r.heldTotal, blocked: r.blockedTotal,
      eta: r.eta, fp: r.quality.firstPassPct, tokens: r.tokenStats.total, rework: r.reworkSpend.wasted,
      // Independent review: the run that finally passed was counted as rework.
      rw: m.reworkSpend(
        [{ tasks: [{ id: "A", gate: { qa: { verdict: "pass", at: "2026-01-03", history: [{ verdict: "fail", at: "2026-01-01" }, { verdict: "fail", at: "2026-01-02" }] } } }, { id: "B", gate: { qa: { verdict: "pass", at: "2026-01-02" } } }] }],
        [
          { task: "A", t: "2026-01-01T10:00:00Z", tokens: 1 },
          { task: "A", t: "2026-01-02T10:00:00Z", tokens: 10 },
          { task: "A", t: "2026-01-03T10:00:00Z", tokens: 100 },
          { task: "A", tokens: 1000 },
          { task: "B", t: "2026-01-01T10:00:00Z", tokens: 10000 },
        ],
        ["qa"],
      ),
      est: [m.estHours({ est: "1d" }), m.estHours({ est: "1d" }, 6), m.estHours({ est: "nonsense" })],
      noGit: m.metrics(board, null, { commitsByDay: [], commitsPerTask: new Map() }, cfg).pctTasks,
    }));
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", probe], { cwd: tmpdir(), encoding: "utf8" });
  ok("importing dashboard.mjs runs no page build", r.status === 0 && !existsSync(join(f.root, "docs", "board.html")), r.stderr);
  ok("importing does not append history", readFileSync(join(f.ops, "history.jsonl"), "utf8").trim().split("\n").length === 1);
  let o = {};
  try {
    o = JSON.parse(r.stdout.trim());
  } catch {}
  for (const k of ["estHours", "held", "eta", "quality", "gateStats", "tokenStats", "reworkSpend", "cycle", "byOwner", "metrics", "render"]) {
    ok(`exports ${k}`, o.keys?.includes(k));
  }
  // Phase 1 live tasks: 7 listed, all counted by the page (dropped included, as before).
  ok("metrics: task-count progress is 2 of 7", o.pctTasks === Math.round((2 / 7) * 100), JSON.stringify(o));
  ok("metrics: held counts the partial and the failed task", o.held === 2);
  ok("metrics: blocked is 1", o.blocked === 1);
  // Gated: T-001 (qa failed once), T-002, T-003 (security failed), T-007.
  ok("metrics: first-pass rate is 2 of 4 gated tasks", o.fp === 50, `fp=${o.fp}`);
  ok("metrics: tokens total the rows that carry them", o.tokens === 163000);
  ok("metrics: rework spend is a failed task's tokens up to its failed verdict, not the run that passed", o.rework === 40000, JSON.stringify(o));
  ok("rework: every run up to the day of the LAST failure counts, the passing run does not", o.rw?.wasted === 11, JSON.stringify(o.rw));
  ok("rework: a run with no time on a failed task is unplaced, not rework", o.rw?.unplaced === 1000 && o.rw?.total === 11111);
  ok("rework: a task that never failed spends nothing on rework", o.rw?.tasks === 1);
  ok("estHours: 1d is 8h by default, 6h with a 6h day, null when unparsed", JSON.stringify(o.est) === "[8,6,null]");
  ok("metrics: no git and no run log still computes", o.noGit === o.pctTasks);
  rmSync(f.root, { recursive: true, force: true });
}

console.log(failures ? `\n[dashboard-lib] ${failures} FAILED` : "\n[dashboard-lib] all checks passed");
process.exit(failures ? 1 : 0);
