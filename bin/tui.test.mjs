#!/usr/bin/env node
/**
 * U-2: the terminal view renders what the read model says, on all four
 * screens, and its command line sends only what core offers.
 *
 *   1. every screen fits the width it was given, line for line
 *   2. each screen shows the read model's facts: stages and reasons, inbox
 *      facts, run tokens, the same first-pass figure as dashboard.metrics
 *   3. the transcript tail is raw and redacted: a planted key never shows
 *   4. the command line's options are exactly lifecycle.commandsFor's, and a
 *      command sent from it is core's, recorded with via "tui"
 *   5. --once prints a frame and exits, without a terminal
 *
 * Run: node bin/tui.test.mjs
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "./readmodel.mjs";
import { frame, load, painter, SCREENS, selectedTask, vlen } from "./tui.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
  if (!cond) failures += 1;
};

/* fixture ----------------------------------------------------------------- */
const root = mkdtempSync(join(tmpdir(), "caretaker-tui-"));
const ops = join(root, "ops", "caretaker");
const state = join(root, "state");
mkdirSync(join(ops, "events"), { recursive: true });
mkdirSync(join(root, "docs"), { recursive: true });
copyFileSync(join(HERE, "board.mjs"), join(ops, "board.mjs"));
copyFileSync(join(HERE, "dashboard.mjs"), join(ops, "dashboard.mjs"));
const cfgPath = join(ops, "config.json");
writeFileSync(cfgPath, JSON.stringify({ name: "Fixture", board: "docs/board.json", runs: "ops/caretaker/runs.jsonl", repo: ".", activePhase: "P", operator: "five" }));
const boardFile = join(root, "docs", "board.json");
writeFileSync(
  boardFile,
  `${JSON.stringify(
    {
      meta: { name: "Fixture" },
      phases: [
        {
          name: "P",
          tasks: [
            { id: "T-1", title: "rework me", owner: "b", est: "2h", status: "doing", ac: "x", gate: { qa: { verdict: "fail", at: "2026-09-29", history: [{ verdict: "fail", at: "2026-09-26" }] } } },
            { id: "T-2", title: "queued one", owner: "b", est: "3h", status: "todo", ac: "y", questions: [{ id: "q1", q: "which port?", by: "b", at: "2026-09-28T10:00:00Z" }] },
            { id: "T-3", title: "closed one", owner: "b", est: "1h", status: "done", completed: "2026-09-28", ac: "z", gate: { reviewer: { verdict: "pass", at: "2026-09-28" }, qa: { verdict: "pass", at: "2026-09-28" } } },
            { id: "T-4", title: "nobody looked", status: "todo" },
          ],
        },
      ],
    },
    null,
    2,
  )}\n`,
);
const KEY = `ghp_${"A1b2C3d4".repeat(5)}`;
const RUN = "r_0000abcd";
writeFileSync(
  join(ops, "runs.jsonl"),
  [
    { t: "2026-09-28T09:00:00Z", kind: "start", name: "builder", task: "T-1", run: RUN, model: "m-1" },
    { t: "2026-09-28T09:30:00Z", kind: "end", name: "builder", task: "T-1", run: RUN, state: "completed", tokens: 1200, in: 200, cached: 800, write: 100, out: 100, turns: 4 },
    { t: "2026-09-20T09:30:00Z", kind: "end", name: "builder", task: "T-3", state: "completed", tokens: 500 },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);
mkdirSync(join(state, "runs", RUN), { recursive: true });
writeFileSync(join(state, "runs", RUN, "run.json"), JSON.stringify({ task: "T-1" }));
writeFileSync(join(state, "runs", RUN, "transcript.log"), `line one\n<script>x</script>\ntoken ${KEY}\nlast line\n`);
spawnSync("git", ["-C", root, "init", "-q"]);
spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);

const rm = await open(cfgPath, { stateDir: state });
const p = painter(false);
const W = 110;
const H = 30;
const show = (screen, sel = 0) => {
  const st = { screen, sel, days: 14, cmd: null, msg: "" };
  const d = load(rm, st);
  return { st, d, lines: frame(d, st, W, H, p) };
};

/* 1. widths --------------------------------------------------------------- */
for (const s of SCREENS) {
  const { lines } = show(s);
  ok(`${s}: every line is exactly ${W} wide and there are ${H}`, lines.length === H && lines.every((l) => vlen(l) === W), lines.map((l) => vlen(l)).join(","));
  const colored = frame(load(rm, { screen: s, sel: 0, days: 14 }), { screen: s, sel: 0, days: 14 }, W, H, painter(true));
  ok(`${s}: color codes do not change the visible width`, colored.every((l) => vlen(l) === W));
}

/* 2. facts ---------------------------------------------------------------- */
{
  const runs = show("runs").lines.join("\n");
  ok("runs lists the identified run and keeps the legacy row apart", runs.includes(RUN) && /1 legacy rows, unidentified, not paired/.test(runs));
  ok("runs shows the token breakdown", /tokens 1,200 +cached 800 · in 200 · write 100 · out 100/.test(runs), runs);
  ok("runs shows the queue", /Queue[\s\S]*T-2 +queued one/.test(runs));

  const b = show("board");
  const board = b.lines.join("\n");
  const w = rm.work();
  for (const t of w.tasks) ok(`board shows ${t.id} in its server-derived stage (${t.lifecycle})`, board.includes(t.id));
  ok("board puts the rework item first in its column, marked with its count", /r2 T-1/.test(board), board);
  ok("board names empty stages rather than drawing empty columns", /empty: .*triage/.test(board));
  ok("board's detail line is the server's reason", board.includes(w.tasks.find((t) => t.id === selectedTask(b.d, b.st)).reason));

  const inbox = show("inbox").lines.join("\n");
  const ib = rm.inbox();
  ok("inbox lists every item the read model derived", ib.items.every((i) => inbox.includes(`${i.task} ${i.title}`)), inbox);
  ok("inbox shows the selected item's fact", inbox.includes(ib.items[0].fact.slice(0, 30)));

  const metrics = show("metrics").lines.join("\n");
  const m = rm.metrics(14);
  ok("metrics' first-pass figure is dashboard.metrics'", metrics.includes(`first-pass ${m.quality.firstPassPct}% of ${m.quality.gated}`), metrics);
  ok("metrics labels its sources", /source: run log/.test(metrics) && /source: board.json verdicts/.test(metrics));
}

/* 3. transcript ----------------------------------------------------------- */
{
  const runs = show("runs").lines.join("\n");
  ok("the transcript tail is shown raw", runs.includes("<script>x</script>") && runs.includes("last line"));
  ok("a planted key is redacted by shape", !runs.includes(KEY) && runs.includes("[redacted:github]"), runs);
}

/* 4. commands ------------------------------------------------------------- */
{
  const b = show("board");
  const task = selectedTask(b.d, b.st);
  const offered = rm.workItem(task).commands.map((c) => c.cmd);
  const summary = rm.work().tasks.find((t) => t.id === task).commands.map((c) => c.cmd);
  ok("the command line's options are the work item's commandsFor list", JSON.stringify(offered) === JSON.stringify(summary) && offered.length > 0);
  ok("no verdict is offered", !offered.some((c) => ["reviewer", "qa", "security"].includes(c)));
  const r = rm.command("T-2", "ask", { text: "from the terminal?" }, { via: "tui" });
  const q = JSON.parse(readFileSync(boardFile, "utf8")).phases[0].tasks.find((t) => t.id === "T-2").questions.at(-1);
  ok("a command from the terminal is core's, recorded by the operator via tui", r.status === 200 && q.by === "five" && q.via === "tui", JSON.stringify(q));
  const before = readFileSync(boardFile, "utf8");
  const refused = rm.command("T-1", "done", {}, { via: "tui" });
  ok("a refusal comes back in core's words and changes nothing", refused.status === 409 && refused.body.refused?.missing?.length > 0 && readFileSync(boardFile, "utf8") === before);
  const inboxSt = { screen: "inbox", sel: 0, days: 14 };
  ok("on the Inbox the selection is the item's work item", selectedTask(load(rm, inboxSt), inboxSt) === rm.inbox().items[0].task);
}

/* 5. --once --------------------------------------------------------------- */
{
  const r = spawnSync("node", [join(HERE, "tui.mjs"), cfgPath, "--state-dir", state, "--once", "--screen", "board", "--width", "100", "--height", "20", "--no-color"], { encoding: "utf8" });
  ok("--once prints one frame and exits 0", r.status === 0 && r.stdout.split("\n").filter(Boolean).length >= 5 && /2 Board/.test(r.stdout), r.stderr);
  ok("and writes no escape codes with --no-color", !/\x1b\[/.test(r.stdout));
}

/* no Encore -------------------------------------------------------------- */
{
  const src = readFileSync(join(HERE, "tui.mjs"), "utf8");
  ok("the terminal view knows nothing of tickets, orders or payments", !/ticket|stripe|checkout|refund|purchase/i.test(src));
}

rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n[tui] ${failures} FAILED` : "\n[tui] all checks passed");
process.exit(failures ? 1 : 0);
