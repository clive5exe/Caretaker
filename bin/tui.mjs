#!/usr/bin/env node
/**
 * The terminal view (U-2): the same project as the web client, over SSH, with
 * nothing listening on a port.
 *
 *     node bin/tui.mjs path/to/ops/caretaker/config.json
 *     node bin/tui.mjs config.json --once --screen board [--width 120] [--no-color]
 *
 * Four screens, switched with 1 to 4:
 *   1 Runs     runs on the left, the queue under them; the selected run's
 *              tokens, gate state and transcript tail on the right
 *   2 Board    the lifecycle columns, rework and active items first
 *   3 Inbox    the four kinds; the selected item shows the fact behind it
 *   4 Metrics  the Metrics page's figures from dashboard.mjs, as text
 *
 * `:` opens a command line listing only what lifecycle.commandsFor offers for
 * the selected work item. Choosing one calls core's own `command`, under
 * core's lock, recorded with via "tui"; a refusal is printed in core's words.
 *
 * It computes nothing: every figure, stage and offered command comes from
 * bin/readmodel.mjs, the functions the web client's server reads, so the two
 * cannot disagree (PRODUCT.md §The terminal view). The transcript tail is the
 * raw redacted transcript. It is not parsed into tool lines: that would read
 * one vendor's output above the harness seam.
 *
 * Built-ins only. q or Ctrl-C quits and restores the terminal.
 */
import { emitKeypressEvents } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { open as openReadModel } from "./readmodel.mjs";

export const SCREENS = ["runs", "board", "inbox", "metrics"];
const TITLES = { runs: "Runs", board: "Board", inbox: "Inbox", metrics: "Metrics" };
const KIND_LABEL = { question: "question", "spec-approval": "spec review", "gate-failure": "gate failure", "pr-review": "PR review" };

/* ------------------------------------------------------------------ paint */
export function painter(color = true) {
  const c = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return {
    bold: c("1"),
    dim: c("38;5;245"),
    faint: c("38;5;240"),
    inv: c("7"),
    violet: c("38;5;141"),
    blue: c("38;5;75"),
    orange: c("38;5;209"),
    pink: c("38;5;205"),
    pass: c("38;5;114"),
    fail: c("38;5;203"),
    warn: c("38;5;214"),
  };
}
/** Visible length, ignoring escape codes. */
export const vlen = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "").length;
/** Cut to n visible characters and pad; escape codes survive the cut. */
export function fit(s, n) {
  s = String(s);
  if (n <= 0) return "";
  const len = vlen(s);
  if (len <= n) return s + " ".repeat(n - len);
  let out = "";
  let seen = 0;
  for (let i = 0; i < s.length && seen < n - 1; i++) {
    if (s[i] === "\x1b") {
      const end = s.indexOf("m", i);
      out += s.slice(i, end + 1);
      i = end;
      continue;
    }
    out += s[i];
    seen += 1;
  }
  return `${out}${s.includes("\x1b[") ? "\x1b[0m" : ""}…${" ".repeat(Math.max(0, n - seen - 1))}`;
}
const wrap = (text, n) => {
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    let line = "";
    for (const w of para.split(/\s+/)) {
      if (!w) continue;
      if (vlen(line) + w.length + (line ? 1 : 0) > n) {
        if (line) out.push(line);
        line = w.length > n ? w.slice(0, n) : w;
      } else line = line ? `${line} ${w}` : w;
    }
    out.push(line);
  }
  return out;
};
const side = (left, right, lw, rw, sep) => {
  const n = Math.max(left.length, right.length);
  const out = [];
  for (let i = 0; i < n; i++) out.push(`${fit(left[i] ?? "", lw)} ${sep} ${fit(right[i] ?? "", rw)}`);
  return out;
};
const tokens = (n) => (n == null ? "unknown" : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString("en-US"));
const dur = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return "unknown";
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const when = (t) => (t ? String(t).replace("T", " ").slice(0, 16) : "unknown");
const NR = (p, what) => p.warn(`not recorded: ${what}`);

function runGlyph(p, status) {
  if (status === "running") return p.blue("●");
  if (status === "no end recorded") return p.warn("!");
  if (/^(completed|ok|ended)$/.test(status)) return p.pass("✓");
  if (/^(failed|killed|error|timeout)$/.test(status)) return p.fail("✗");
  return p.dim("·");
}
function verdict(p, v) {
  return v === "pass" ? p.pass("pass") : v === "fail" ? p.fail("fail") : p.dim(v ?? "not run");
}
function rail(p, gates, cells, missing) {
  return gates
    .map((g) => {
      const v = cells[g]?.verdict;
      return v === "pass" ? p.pass("■") : v === "fail" ? p.fail("■") : missing.includes(g) ? p.dim("□") : p.faint("·");
    })
    .join("");
}

/* ----------------------------------------------------------------- screens */
/**
 * Pure: (data, state, size, paint) -> lines. `data` is what the read model
 * returned; nothing here changes it or derives a stage, a gate or a number.
 */
export function renderRuns(d, st, W, H, p) {
  const LW = Math.min(46, Math.floor(W * 0.42));
  const RW = W - LW - 3;
  const left = [];
  const runs = d.runs.runs;
  if (runs === null) {
    left.push(NR(p, "no run log, events or archive"));
  } else if (!runs.length) left.push(p.dim("no identified runs yet"));
  else {
    runs.forEach((r, i) => {
      const line = `${runGlyph(p, r.status)} ${r.id} ${fit(r.task ?? "-", 6)} ${r.agent ?? "?"}`;
      left.push(i === st.sel ? p.inv(fit(line, LW)) : line);
    });
  }
  if (d.runs.legacy?.length) left.push(p.faint(`${d.runs.legacy.length} legacy rows, unidentified, not paired`));
  left.push("");
  left.push(p.bold("Queue"));
  const queued = d.work.tasks.filter((t) => t.lifecycle === "ready");
  if (queued.length) for (const t of queued.slice(0, 8)) left.push(`${p.dim(fit(t.id, 6))} ${t.title}`);
  else left.push(p.dim("nothing queued"));

  const right = [];
  const r = runs?.[st.sel];
  if (!r) right.push(p.dim(runs === null ? "Runs appear once bin/run.mjs logs one, or the harness archives it." : "Select a run."));
  else {
    const det = d.run ?? {};
    right.push(`${p.bold(r.id)}${r.parent ? p.dim(` child of ${r.parent}`) : ""}  ${runGlyph(p, r.status)} ${r.status}`);
    right.push(p.dim(`${r.task ?? "no work item"}${det.taskTitle ? ` · ${det.taskTitle}` : ""}`));
    right.push(`${r.agent ?? "agent unknown"} · ${r.model ?? "model unknown"} · ${r.adapter ?? r.cli ?? "harness unknown"}`);
    right.push(`started ${when(r.start)} · ${r.status === "running" && r.start ? dur(Date.now() - Date.parse(r.start)) : dur(r.durationMs)}`);
    const b = det.breakdown;
    if (b) {
      const parts = ["cached", "in", "write", "out"].map((k) => `${k} ${tokens(b[k] ?? null)}`);
      right.push(`tokens ${p.bold(tokens(r.tokens))}  ${p.dim(parts.join(" · "))}${b.turns != null ? p.dim(` · ${b.turns} turns`) : ""}`);
    } else right.push(`tokens ${r.tokens == null ? NR(p, "no cost returned") : p.bold(tokens(r.tokens))}`);
    const tg = det.taskGates;
    right.push(
      `gates ${tg && Object.keys(tg).length ? Object.entries(tg).map(([g, v]) => `${g} ${verdict(p, v.verdict)}`).join("  ") : p.dim("none recorded")} ${p.faint("(task-level)")}`,
    );
    right.push(p.faint("─".repeat(Math.max(0, RW))));
    right.push(p.dim("transcript tail · redacted · raw text"));
    const room = Math.max(3, H - right.length - 1);
    if (d.transcript == null) right.push(NR(p, "no transcript in the run archive"));
    else for (const l of d.transcript.split("\n").filter((x, i, a) => i < a.length - 1 || x).slice(-room)) right.push(l.replace(/\t/g, "  "));
  }
  return side(left, right, LW, RW, p.faint("│")).slice(0, H);
}

export function renderBoard(d, st, W, H, p) {
  const tasks = d.work.tasks.filter((t) => t.lifecycle !== "dropped");
  const lanes = d.work.stages.map((s) => ({ s, items: tasks.filter((t) => (t.lifecycle === "ready" ? "build" : t.lifecycle) === s) }));
  const order = (t) => (t.rework ? 0 : t.lifecycle === "ready" ? 2 : 1);
  for (const l of lanes) l.items.sort((a, b) => order(a) - order(b));
  const shown = lanes.filter((l) => l.items.length);
  const empty = lanes.filter((l) => !l.items.length).map((l) => l.s);
  const flat = shown.flatMap((l) => l.items);
  const sel = flat[Math.min(st.sel, flat.length - 1)];
  const cw = shown.length ? Math.max(14, Math.floor((W - (shown.length - 1)) / shown.length)) : W;
  const out = [];
  out.push(shown.map((l) => fit(p.bold(`${l.s} ${p.dim(String(l.items.length))}`), cw)).join(" "));
  const depth = Math.max(0, ...shown.map((l) => l.items.length));
  const room = Math.max(1, H - 7);
  for (let i = 0; i < Math.min(depth, room); i++) {
    out.push(
      shown
        .map((l) => {
          const t = l.items[i];
          if (!t) return " ".repeat(cw);
          const mark = t.rework ? p.fail(`r${t.rework}`) : t.blocked ? p.warn("B") : t.lifecycle === "ready" ? p.faint("q") : " ";
          const cell = `${mark} ${t.id} ${rail(p, d.work.gates, t.gates, t.missingGates)} ${t.title}`;
          return t === sel ? p.inv(fit(cell, cw)) : fit(cell, cw);
        })
        .join(" "),
    );
  }
  if (depth > room) out.push(p.dim(`… ${depth - room} more rows`));
  if (empty.length) out.push(p.faint(`empty: ${empty.join(", ")}`));
  out.push(p.faint("─".repeat(W)));
  if (sel) {
    out.push(`${p.bold(sel.id)} ${sel.title}  ${p.dim(`${sel.owner ?? "no owner"} · ${sel.est ?? "no estimate"} · ${sel.status}`)}`);
    out.push(`${sel.lifecycle}: ${sel.reason}${sel.blocked ? p.warn(`  blocked: ${sel.blocked}`) : ""}`);
    out.push(p.dim(`missing ${sel.missingGates.join(", ") || "nothing"} · ${sel.runs} runs · ${sel.openQuestions} open questions · : for ${sel.commands.length} commands`));
  }
  return out.slice(0, H);
}

export function renderInbox(d, st, W, H, p) {
  const LW = Math.min(52, Math.floor(W * 0.45));
  const RW = W - LW - 3;
  const items = d.inbox.items;
  const left = [];
  const SHORT = { question: "questions", "spec-approval": "specs", "gate-failure": "gates", "pr-review": "PRs" };
  left.push(p.dim(Object.entries(d.inbox.counts).map(([k, n]) => `${SHORT[k]} ${n}`).join(" · ")));
  if (!items.length) left.push(p.dim("Nothing needs you right now."));
  items.forEach((it, i) => {
    const tag = { question: p.blue, "spec-approval": p.orange, "gate-failure": p.fail, "pr-review": p.pass }[it.kind](fit(KIND_LABEL[it.kind], 12));
    const line = `${tag} ${it.task} ${it.title}`;
    left.push(i === st.sel ? p.inv(fit(line, LW)) : line);
  });
  const right = [];
  const it = items[st.sel];
  if (it) {
    right.push(`${p.bold(`${it.task} ${it.title}`)}`);
    right.push(p.dim(`${KIND_LABEL[it.kind]} · ${it.since ? `since ${when(it.since)}` : "undated"}${it.owner ? ` · ${it.owner}` : ""}`));
    right.push("");
    right.push(...wrap(it.fact, RW));
    if (it.question) right.push(...wrap(`“${it.question.q}”`, RW).map((l) => p.dim(l)));
    if (it.spec) right.push(p.dim(`${it.spec.path} at ${it.spec.blob ? it.spec.blob.slice(0, 7) : "an unhashable version"}`));
    if (it.gateHistory) {
      right.push("");
      for (const [g, h] of Object.entries(it.gateHistory)) right.push(`${fit(g, 9)} ${h.map((a) => `${verdict(p, a.verdict)} ${p.dim(a.at ?? "undated")}`).join(" → ")}`);
    }
    if (it.dismissCommand) {
      right.push("");
      right.push(p.dim("dismiss in the terminal, with a reason:"));
      right.push(...wrap(it.dismissCommand, RW));
    }
    right.push("");
    right.push(it.actions.length ? p.dim(`: offers ${it.actions.map((a) => a.cmd).join(", ")}`) : p.dim("no command: read the failure on the work item and decide"));
    right.push(p.faint("It leaves the Inbox when its fact changes. There is no resolve."));
  }
  return side(left, right, LW, RW, p.faint("│")).slice(0, H);
}

export function renderMetrics(d, st, W, H, p) {
  const s = d.snapshot;
  const m = d.metrics;
  const out = [];
  const pr = s.progress;
  out.push(`${p.bold("Progress")}  ${pr.pctEffort}% by effort · ${pr.pctTasks}% by count · ${pr.doneCount}/${pr.total} tasks · ${pr.remainingHours}h left   ETA ${s.eta ? `${s.eta.date} (${Number(s.eta.perDay).toFixed(1)}h a day)` : "no rate"}`);
  out.push(`${p.dim("held")} ${s.held}  ${p.dim("blocked")} ${s.blocked}  ${p.dim("no finish line")} ${s.noAc}   ${p.faint("source: board.json, git")}`);
  out.push("");
  out.push(`${p.bold(`Last ${m.days} days`)} ${p.faint("(t cycles 7, 14, 30)")}`);
  out.push(`first-pass ${m.quality.gated ? `${m.quality.firstPassPct}% of ${m.quality.gated}` : p.dim("no verdict in range")}   all time ${m.allTime.quality.gated ? `${m.allTime.quality.firstPassPct}% of ${m.allTime.quality.gated}` : p.dim("none")}   ${p.faint("source: board.json verdicts")}`);
  const bw = Math.max(10, Math.min(40, W - 40));
  for (const [g, v] of m.gateStats) {
    const n = v.pass + v.fail;
    if (!n) {
      out.push(`  ${fit(g, 9)} ${p.dim("no attempts in range")}`);
      continue;
    }
    const pct = Math.round((v.pass / n) * 100);
    const fill = Math.round((pct / 100) * bw);
    const bar = (pct >= 80 ? p.pass : pct < 50 ? p.fail : p.warn)("█".repeat(fill)) + p.faint("░".repeat(bw - fill));
    out.push(`  ${fit(g, 9)} ${bar} ${pct}% ${p.dim(`${v.pass}/${n}`)}`);
  }
  out.push("");
  if (m.tokens) {
    const t = m.tokens;
    out.push(`${p.bold("Tokens")} ${tokens(t.total)}  ${p.dim(`${t.liveCount} live${t.reconCount ? `, ${t.reconCount} reconstructed` : ""}`)}   ${p.faint("source: run log")}`);
    if (t.compTotal) {
      out.push(`  ${["cached", "in", "write", "out"].map((k) => `${k} ${tokens(t.comp[k])}`).join(" · ")}`);
      out.push(`  churn ${t.churnShare == null ? "unknown" : `${Math.round(t.churnShare * 100)}%`} · output ${t.outShare == null ? "unknown" : `${Math.round(t.outShare * 100)}%`} · per turn ${t.perTurn == null ? "unknown" : tokens(t.perTurn)}`);
    }
    if (m.reworkSpend) out.push(`  rework spend ${tokens(m.reworkSpend.wasted)} (${m.reworkSpend.pct}%) on ${m.reworkSpend.tasks} tasks`);
    if (t.byAgent.length) out.push(`  by agent  ${t.byAgent.map(([a, v]) => `${a ?? "unnamed"} ${tokens(v.tokens)}`).join(" · ")}`);
    if (t.byModel.length) out.push(`  by model  ${t.byModel.map(([a, v]) => `${a} ${tokens(v.tokens)}`).join(" · ")}`);
  } else out.push(`${p.bold("Tokens")} ${NR(p, m.sources.runs === "absent" ? "no run log (ops/caretaker/runs.jsonl)" : "no tokens logged in range")}`);
  out.push("");
  out.push(`${p.bold("Cycle")} ${m.medDays != null ? `median ${m.medDays} days against an estimate of ${m.medEst}h over ${m.cycle.length} closed` : p.dim("no closed task with commits naming it")}   ${p.faint("all time · git + board.json")}`);
  out.push(`${p.bold("Commits")} ${m.commitsByDay.join(" ")}   ${p.faint(`per day, last ${m.closedWindow.length} days · git`)}`);
  out.push("");
  out.push(p.faint("Not in v1: cycle time per stage (needs dated transitions), cost in money (tokens only)."));
  return out.slice(0, H);
}

/* -------------------------------------------------------------- the frame */
export function frame(d, st, W, H, p) {
  const s = d.snapshot;
  const head = `${p.bold("CARETAKER")}  ${p.dim(`${s.name ?? "project"} · ${s.activePhase ?? "no active phase"}`)}`;
  const rightHead = `${p.violet(`${s.progress.pctEffort}%`)} ${p.faint("▏")} ${p.dim(s.eta ? `ETA ${s.eta.date}` : "no rate")} ${p.faint("▏")} ${p.dim(`inbox ${s.inbox.count}`)}`;
  const out = [];
  out.push(fit(head, W - vlen(rightHead)) + rightHead);
  out.push(fit(SCREENS.map((k, i) => (k === st.screen ? p.inv(` ${i + 1} ${TITLES[k]} `) : p.dim(` ${i + 1} ${TITLES[k]} `))).join(" "), W));
  out.push(p.faint("─".repeat(W)));
  const bodyH = H - out.length - 2;
  const body = { runs: renderRuns, board: renderBoard, inbox: renderInbox, metrics: renderMetrics }[st.screen](d, st, W, bodyH, p);
  for (let i = 0; i < bodyH; i++) out.push(fit(body[i] ?? "", W));
  out.push(p.faint("─".repeat(W)));
  if (st.cmd) out.push(fit(cmdLine(st, p), W));
  else out.push(fit(st.msg ? st.msg : p.dim("1-4 screens · j/k move · : command · t range · r refresh · q quit"), W));
  return out;
}

function cmdLine(st, p) {
  const c = st.cmd;
  if (c.field) return `${p.bold(`${c.chosen.cmd} ${c.task}`)} ${c.field}: ${c.input}${p.inv(" ")}`;
  const list = c.options
    .map((o, i) => {
      const label = `${o.cmd}${o.fixed ? ` ${Object.values(o.fixed).join(" ")}` : ""}`;
      return i === c.sel ? p.inv(label) : label;
    })
    .join("  ");
  return `${p.bold(`:${c.input}`)}${p.inv(" ")} ${c.task ? p.dim(`${c.task} ▸ `) : ""}${list || p.dim(c.task ? "core offers no command matching that" : "select a work item first")}`;
}

/* ---------------------------------------------------------------- the app */
/** Everything a frame needs, read once from the read model. */
export function load(rm, st) {
  const runs = rm.runs();
  const d = { snapshot: rm.snapshot(), work: rm.work(), inbox: rm.inbox(), runs, metrics: rm.metrics(st.days) };
  if (st.screen === "runs") {
    const r = runs.runs?.[st.sel];
    if (r) {
      d.run = rm.run(r.id);
      const name = rm.runFilePath(r.id, "transcript.log") ? "transcript.log" : rm.runFilePath(r.id, "transcript.live.log") ? "transcript.live.log" : null;
      if (name) {
        const size = d.run?.archiveFiles?.[name] ?? 0;
        d.transcript = rm.runFile(r.id, name, Math.max(0, size - 64 * 1024))?.text ?? null;
      } else d.transcript = null;
    }
  }
  return d;
}

/** The work item the selection points at, on any screen. */
export function selectedTask(d, st) {
  if (st.screen === "board") {
    const tasks = d.work.tasks.filter((t) => t.lifecycle !== "dropped");
    const lanes = d.work.stages.map((s) => tasks.filter((t) => (t.lifecycle === "ready" ? "build" : t.lifecycle) === s));
    const order = (t) => (t.rework ? 0 : t.lifecycle === "ready" ? 2 : 1);
    const flat = lanes.flatMap((l) => [...l].sort((a, b) => order(a) - order(b)));
    return flat[Math.min(st.sel, flat.length - 1)]?.id ?? null;
  }
  if (st.screen === "inbox") return d.inbox.items[st.sel]?.task ?? null;
  if (st.screen === "runs") return d.runs.runs?.[st.sel]?.task ?? null;
  return null;
}

const listLength = (d, st) =>
  st.screen === "runs" ? (d.runs.runs?.length ?? 0) : st.screen === "board" ? d.work.tasks.filter((t) => t.lifecycle !== "dropped").length : st.screen === "inbox" ? d.inbox.items.length : 0;

async function main(argv) {
  const flag = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cfgPath = argv.find((a, i) => !a.startsWith("--") && !["--screen", "--width", "--height", "--state-dir", "--days"].includes(argv[i - 1]));
  if (!cfgPath) {
    console.error("usage: node bin/tui.mjs path/to/ops/caretaker/config.json [--once --screen runs|board|inbox|metrics] [--width N] [--no-color]");
    process.exit(2);
  }
  const rm = await openReadModel(cfgPath, { stateDir: flag("--state-dir") });
  const st = { screen: SCREENS.includes(flag("--screen")) ? flag("--screen") : "runs", sel: 0, days: [7, 14, 30].includes(Number(flag("--days"))) ? Number(flag("--days")) : 14, cmd: null, msg: "" };
  const once = argv.includes("--once") || !process.stdout.isTTY;
  const p = painter(!argv.includes("--no-color") && (process.stdout.isTTY || argv.includes("--color")));
  const size = () => ({ W: Number(flag("--width")) || process.stdout.columns || 100, H: Number(flag("--height")) || process.stdout.rows || 32 });

  if (once) {
    const { W, H } = size();
    process.stdout.write(`${frame(load(rm, st), st, W, H, p).join("\n")}\n`);
    return;
  }

  let d = load(rm, st);
  const draw = () => {
    const { W, H } = size();
    process.stdout.write(`\x1b[H\x1b[2J${frame(d, st, W, H, p).join("\n")}`);
  };
  const refresh = () => {
    try {
      d = load(rm, st);
    } catch (e) {
      st.msg = p.fail(String(e.message).split("\n")[0]);
    }
    draw();
  };
  const quit = () => {
    clearInterval(timer);
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    process.exit(0);
  };
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode?.(true);
  process.stdout.on("resize", draw);
  // The files are the source; a stat poll is enough and works over any filesystem.
  const timer = setInterval(refresh, 2000);

  const openCmd = () => {
    const task = selectedTask(d, st);
    const all = task ? (rm.workItem(task)?.commands ?? []) : [];
    st.cmd = { task, all, options: all, input: "", sel: 0, field: null, chosen: null, values: {}, fields: [] };
  };
  const filterCmd = () => {
    const c = st.cmd;
    c.options = c.all.filter((o) => `${o.cmd} ${Object.values(o.fixed ?? {}).join(" ")}`.includes(c.input.trim()));
    c.sel = 0;
  };
  const send = () => {
    const c = st.cmd;
    const r = rm.command(c.task, c.chosen.cmd, { ...(c.chosen.fixed ?? {}), ...c.values }, { via: "tui" });
    st.cmd = null;
    st.msg =
      r.status === 200
        ? p.pass(`${c.chosen.cmd} ${c.task}: recorded`)
        : p.fail(`refused by core: ${r.body.refused ? `missing ${r.body.refused.missing.join(", ")}` : r.body.error}`);
    refresh();
  };

  process.stdin.on("keypress", (str, key = {}) => {
    if (key.ctrl && key.name === "c") return quit();
    if (st.cmd) {
      const c = st.cmd;
      if (key.name === "escape") st.cmd = null;
      else if (c.field) {
        if (key.name === "return") {
          c.values[c.field] = c.input;
          c.input = "";
          const next = c.fields.shift();
          if (next) c.field = next;
          else return send();
        } else if (key.name === "backspace") c.input = c.input.slice(0, -1);
        else if (str && !key.ctrl && str >= " ") c.input += str;
      } else if (key.name === "return") {
        const o = c.options[c.sel];
        if (o) {
          c.chosen = o;
          c.fields = [...(o.needs ?? []), ...(o.optional ?? [])];
          c.field = c.fields.shift() ?? null;
          c.input = "";
          if (!c.field) return send();
        }
      } else if (key.name === "tab" || key.name === "right") c.sel = Math.min(c.options.length - 1, c.sel + 1);
      else if (key.name === "left") c.sel = Math.max(0, c.sel - 1);
      else if (key.name === "backspace") {
        c.input = c.input.slice(0, -1);
        filterCmd();
      } else if (str && !key.ctrl && str >= " ") {
        c.input += str;
        filterCmd();
      }
      return draw();
    }
    st.msg = "";
    if (str === "q") return quit();
    if (["1", "2", "3", "4"].includes(str)) {
      st.screen = SCREENS[Number(str) - 1];
      st.sel = 0;
      return refresh();
    }
    if (str === "j" || key.name === "down") st.sel = Math.min(Math.max(0, listLength(d, st) - 1), st.sel + 1);
    else if (str === "k" || key.name === "up") st.sel = Math.max(0, st.sel - 1);
    else if (str === ":") openCmd();
    else if (str === "t") st.days = st.days === 7 ? 14 : st.days === 14 ? 30 : 7;
    else if (str === "r") return refresh();
    else return;
    refresh();
  });
  draw();
}

const isEntry = (() => {
  try {
    return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isEntry) {
  main(process.argv.slice(2)).catch((e) => {
    if (process.stdout.isTTY) process.stdout.write("\x1b[?25h");
    console.error(`tui: ${e.message}`);
    process.exit(1);
  });
}
