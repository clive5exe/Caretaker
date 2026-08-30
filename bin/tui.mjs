#!/usr/bin/env node
/**
 * FOREMAN TUI — the live dashboard. Not a mockup; this one runs.
 *
 *   node bin/tui.mjs --demo            replay a synthetic pass, no run needed
 *   node bin/tui.mjs --log run.jsonl   tail a real run's event log
 *   node bin/tui.mjs --frame 2         render ONE frame to stdout and exit
 *
 * WHY IT TAILS A LOG RATHER THAN OWNING THE AGENTS. Two writers on one terminal
 * produce shredded output, and it cannot be retrofitted — the renderer has to be
 * the only thing holding the screen from the first line. So the agent appends
 * JSONL and this reads it. That also means the TUI can attach to a run already
 * in progress, and dying does not kill the run.
 *
 * --frame exists because a TUI is the one kind of program that cannot be checked
 * by running it: it takes the terminal, so its output never lands anywhere you
 * can read. With --frame the renderer is a pure function of state and prints one
 * frame to a pipe, which is how the layout below was actually verified rather
 * than assumed.
 */
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/* ─────────────────────────────────────────────────────────────────── ansi */

const ESC = "\x1b";
const CSI = `${ESC}[`;
const SGR = (...n) => `${CSI}${n.join(";")}m`;
const RESET = SGR(0);

// 256-colour, because truecolour is not universal over ssh and these six read
// correctly in every terminal that has ever been pointed at this box.
const C = {
  ink: SGR(38, 5, 253),
  dim: SGR(38, 5, 245),
  faint: SGR(38, 5, 238),
  lime: SGR(38, 5, 155),
  cyan: SGR(38, 5, 80),
  amber: SGR(38, 5, 214),
  red: SGR(38, 5, 203),
  mauve: SGR(38, 5, 176),
  bold: SGR(1),
  inv: SGR(7),
};
let NOCOLOR = false;
export const setColor = (on) => (NOCOLOR = !on);
const p = (code, s) => (NOCOLOR ? String(s) : `${code}${s}${RESET}`);
const dim = (s) => p(C.dim, s);
const faint = (s) => p(C.faint, s);
const lime = (s) => p(C.lime, s);
const cyan = (s) => p(C.cyan, s);
const amber = (s) => p(C.amber, s);
const red = (s) => p(C.red, s);
const mauve = (s) => p(C.mauve, s);
const bold = (s) => p(C.bold + C.ink, s);
const inv = (s) => p(C.inv, s);

/** Visible width, ignoring SGR sequences. Every pad in this file goes through it. */
export const vlen = (s) => [...String(s).replace(/\x1b\[[0-9;]*m/g, "")].length;

/**
 * Truncate to `n` visible columns, preserving colour runs, then pad.
 *
 * Overflow is the failure that matters: one cell a character too wide shifts
 * every column to its right and the frame reads as broken rather than as a
 * rounding error. So this always returns EXACTLY n columns.
 */
function fit(s, n) {
  const v = vlen(s);
  if (v === n) return s;
  if (v < n) return s + " ".repeat(n - v);
  let out = "";
  let seen = 0;
  const str = String(s);
  for (let i = 0; i < str.length && seen < n - 1; i++) {
    if (str[i] === ESC) {
      const end = str.indexOf("m", i);
      if (end === -1) break;
      out += str.slice(i, end + 1);
      i = end;
      continue;
    }
    out += str[i];
    seen++;
  }
  // The RESET is conditional: in --no-color the escape has nowhere to go and
  // prints as a literal "[0m" in the middle of the text, which is exactly the
  // kind of thing a piped frame shows and a live terminal hides.
  return `${out}${NOCOLOR ? "" : RESET}${faint("…")}${" ".repeat(Math.max(0, n - seen - 1))}`;
}

const bar = (frac, width, on = "█", off = "░") => {
  const f = Math.max(0, Math.min(1, frac));
  const k = Math.round(f * width);
  const tone = f > 0.85 ? red : f > 0.6 ? amber : lime;
  return tone(on.repeat(k)) + faint(off.repeat(width - k));
};

const BRAILLE = [..."⣀⣄⣤⣦⣶⣷⣿"];
const spark = (vals, width, tone = cyan) => {
  const v = vals.slice(-width);
  const max = Math.max(1, ...v);
  const s = v.map((x) => BRAILLE[Math.min(6, Math.floor((x / max) * 6.99))]).join("");
  return faint("·".repeat(Math.max(0, width - v.length))) + tone(s);
};

const human = (n) => {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
};
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);

/* ──────────────────────────────────────────────────────────────── the state */

/**
 * ONE STATE, FOUR RENDERERS. The board CLI and the HTML dashboard already
 * disagreed once about which phase was current, because each computed it from
 * the raw file separately. Every screen here reads this object and nothing else,
 * so a fifth view costs a render function and cannot introduce a fifth answer.
 */
export function newState() {
  return {
    started: Date.now(),
    pass: 1,
    layer: "—",
    agents: new Map(), // name -> agent
    order: [], // stable display order; a Map's iteration order is insertion,
    // but agents get replaced on restart and would jump rows.
    rate: [], // tokens/minute samples
    lastSample: Date.now(),
    lastSampleTokens: 0,
    gates: { reviewer: null, qa: null, security: null },
    board: null,
    notice: null,
  };
}

function agentOf(st, name) {
  let a = st.agents.get(name);
  if (!a) {
    a = {
      name,
      task: "—",
      model: "—",
      status: "idle",
      started: Date.now(),
      ended: null,
      lines: [],
      tok: { in: 0, cached: 0, write: 0, out: 0 },
      turns: 0,
      spans: [], // [startMs, endMs|null] for the waterfall
      rate: [],
      lastTok: 0,
    };
    st.agents.set(name, a);
    st.order.push(name);
  }
  return a;
}

const totalTok = (t) => t.in + t.cached + t.write + t.out;
const stateTokens = (st) =>
  [...st.agents.values()].reduce((n, a) => n + totalTok(a.tok), 0);

/**
 * Apply one event. This is the ONLY mutation path — the renderers are pure, so
 * anything that changes the screen is an event on the log and is replayable.
 */
export function apply(st, e) {
  const t = e.t ? Date.parse(e.t) : Date.now();
  switch (e.kind) {
    case "pass":
      st.pass = e.pass ?? st.pass;
      st.layer = e.layer ?? st.layer;
      break;
    case "agent.start": {
      const a = agentOf(st, e.agent);
      a.task = e.task ?? a.task;
      a.model = e.model ?? a.model;
      a.status = "running";
      a.started = t;
      a.ended = null;
      a.spans.push([t, null]);
      break;
    }
    case "agent.end": {
      const a = agentOf(st, e.agent);
      a.status = e.verdict ?? "done";
      a.ended = t;
      const open = a.spans.find((s) => s[1] === null);
      if (open) open[1] = t;
      break;
    }
    case "tool": {
      const a = agentOf(st, e.agent);
      a.lines.push({ t, tone: e.tone ?? "n", verb: e.verb ?? "", text: e.text ?? "", meta: e.meta ?? "" });
      if (a.lines.length > 500) a.lines.shift();
      break;
    }
    case "tokens": {
      const a = agentOf(st, e.agent);
      for (const k of ["in", "cached", "write", "out"]) {
        if (typeof e[k] === "number") a.tok[k] += e[k];
      }
      if (e.turn) a.turns += 1;
      break;
    }
    case "gate":
      st.gates[e.gate] = { verdict: e.verdict, fails: e.fails ?? 0 };
      break;
    case "notice":
      st.notice = e.text;
      break;
  }
}

/** Sample tokens/minute once a second. A rate you compute per frame is noise. */
function sample(st) {
  const now = Date.now();
  const dt = now - st.lastSample;
  if (dt < 1000) return;
  const tot = stateTokens(st);
  const perMin = ((tot - st.lastSampleTokens) / dt) * 60000;
  st.rate.push(Math.max(0, perMin));
  if (st.rate.length > 240) st.rate.shift();
  for (const a of st.agents.values()) {
    const at = totalTok(a.tok);
    a.rate.push(Math.max(0, ((at - a.lastTok) / dt) * 60000));
    if (a.rate.length > 60) a.rate.shift();
    a.lastTok = at;
  }
  st.lastSample = now;
  st.lastSampleTokens = tot;
}

/* ───────────────────────────────────────────────────────────────── screens */

export const SCREENS = ["deck", "cycle", "tail", "waterfall"];

/** ╭─ title ─────╮ */
const boxTop = (title, w) => {
  const label = ` ${title} `;
  return faint("╭─") + bold(label) + faint("─".repeat(Math.max(0, w - 3 - label.length)) + "╮");
};
const boxMid = (title, w) => {
  const label = ` ${title} `;
  return faint("├─") + dim(label) + faint("─".repeat(Math.max(0, w - 3 - label.length)) + "┤");
};
const boxBot = (w) => faint("╰" + "─".repeat(Math.max(0, w - 2)) + "╯");
const boxRow = (s, w) => faint("│ ") + fit(s, Math.max(0, w - 4)) + faint(" │");

/* ------------------------------------------------------------------ deck */

function deck(st, w, h, ui) {
  const out = [];
  const elapsed = clock(Date.now() - st.started);
  out.push(boxTop("foreman", w));

  const running = [...st.agents.values()].filter((a) => a.status === "running").length;
  out.push(
    boxRow(
      `${bold(`pass ${st.pass}`)}  ${dim(st.layer)}` +
        " ".repeat(Math.max(1, w - 34 - vlen(`pass ${st.pass}  ${st.layer}`))) +
        `${dim(`${running} running`)}  ${dim(elapsed)}  ${cyan(human(stateTokens(st)))}`,
      w,
    ),
  );

  /* agents — master list, and the selected row drives every other screen */
  out.push(boxMid("agents", w));
  const inner = w - 4;
  const sparkW = Math.max(8, Math.min(18, inner - 62));
  if (st.order.length === 0) {
    out.push(boxRow(faint("  no agents yet — waiting for the first event"), w));
  }
  st.order.forEach((name, i) => {
    const a = st.agents.get(name);
    const sel = i === ui.sel;
    const live = a.status === "running";
    const el = clock((a.ended ?? Date.now()) - a.started);
    const load = Math.min(1, (a.rate.at(-1) ?? 0) / 30000);
    const tone = a.status === "fail" ? red : a.status === "running" ? lime : dim;
    out.push(
      boxRow(
        (sel ? lime("▸ ") : "  ") +
          fit(sel ? bold(a.name) : dim(a.name), 10) +
          fit(dim(a.task), 8) +
          fit(cyan(el), 7) +
          fit(load > 0.7 ? amber(human(totalTok(a.tok))) : dim(human(totalTok(a.tok))), 7) +
          (live ? bar(load, 12) : faint("░".repeat(12))) +
          "  " +
          // A done agent's rate history is all zeros, which the sparkline would
          // draw as a flat run of ⣀ — indistinguishable from a live agent that
          // has stalled, which is the one thing this column exists to show.
          (live ? spark(a.rate, sparkW) : faint("·".repeat(sparkW))) +
          "  " +
          tone(a.status),
        w,
      ),
    );
  });

  /* tokens per minute — the one graph that earns a row */
  out.push(boxMid("tokens / minute", w));
  const gw = Math.max(20, inner - 40);
  const peak = Math.max(0, ...st.rate);
  const now = st.rate.at(-1) ?? 0;
  const avg = st.rate.length ? st.rate.reduce((x, y) => x + y, 0) / st.rate.length : 0;
  out.push(
    boxRow(
      " " +
        spark(st.rate, gw) +
        "   " +
        faint("peak ") +
        amber(human(Math.round(peak))) +
        faint("  avg ") +
        cyan(human(Math.round(avg))) +
        faint("  now ") +
        (now > avg * 1.5 ? amber(human(Math.round(now))) : cyan(human(Math.round(now)))),
      w,
    ),
  );

  /* composition — the number that changes behaviour */
  out.push(boxMid("where the tokens go", w));
  const tot = [...st.agents.values()].reduce(
    (acc, a) => {
      for (const k of ["in", "cached", "write", "out"]) acc[k] += a.tok[k];
      return acc;
    },
    { in: 0, cached: 0, write: 0, out: 0 },
  );
  const sum = Math.max(1, totalTok(tot));
  const bw = inner - 1;
  // Segment widths ARE the percentages. A stacked bar whose widths disagree
  // with its own legend teaches the reader the screen is lying.
  const seg = (k, fn) => fn("█".repeat(Math.round((tot[k] / sum) * bw)));
  const drawn =
    seg("cached", cyan) + seg("write", amber) + seg("in", (s) => dim(s)) + seg("out", lime);
  out.push(boxRow(" " + fit(drawn, bw), w));
  const pct = (k) => `${((tot[k] / sum) * 100).toFixed(1)}%`;
  out.push(
    boxRow(
      ` ${cyan(`cache read ${pct("cached")}`)}   ${amber(`write ${pct("write")}`)}   ` +
        `${dim(`fresh ${pct("in")}`)}   ${lime(`output ${pct("out")}`)}`,
      w,
    ),
  );
  const outShare = (tot.out / sum) * 100;
  if (sum > 1000 && outShare < 3) {
    out.push(
      boxRow(
        amber(` ▲ output share ${outShare.toFixed(1)}% — this pass is paying to re-read, not to work`),
        w,
      ),
    );
  }

  /* gates */
  out.push(boxMid("gates", w));
  const gate = (name) => {
    const g = st.gates[name];
    if (!g) return `${dim(name)} ${faint("▱▱▱▱▱▱▱▱")} ${faint("—")}`;
    const ok = g.verdict === "pass";
    const fill = ok ? "▰▰▰▰▰▰▰▰" : "▰▰▰▱▱▱▱▱";
    const tone = ok ? lime : red;
    return `${dim(name)} ${tone(fill)} ${tone(ok ? "pass" : `fail ×${g.fails}`)}`;
  };
  out.push(boxRow(" " + ["reviewer", "qa", "security"].map(gate).join("    "), w));
  out.push(boxBot(w));
  return out;
}

/* ----------------------------------------------------------------- cycle */

function cycle(st, w, h) {
  const out = [];
  if (!st.board) {
    out.push("");
    out.push("  " + amber("no board found"));
    out.push("");
    out.push("  " + dim("This screen reads the same tasks.json the board CLI does. Point it at one:"));
    out.push("  " + faint("node bin/tui.mjs --demo --board docs/board.json"));
    out.push("");
    out.push(
      "  " + faint("An invented board is worse than none — it would read as real work."),
    );
    return out;
  }

  /*
   * THE COLUMNS ARE THE BOARD'S OWN STATUSES, not a second vocabulary. An
   * earlier version mapped `blocked` onto a column it called "review", which
   * meant the screen answered a different question from the board and the two
   * disagreed by design. `verify` has no status of its own — it is the gate
   * state — so it reads from st.gates rather than inventing a bucket.
   */
  const bucket = (k) => st.board.filter((t) => t.status === k);
  const gatesPending = Object.entries(st.gates).filter(([, g]) => g && g.verdict !== "pass");
  const stages = [
    { n: "queued", items: bucket("todo"), tone: dim },
    { n: "working", items: bucket("doing"), tone: lime },
    { n: "held", items: bucket("blocked"), tone: amber },
    {
      n: "verify",
      items: gatesPending.map(([g, v]) => ({ id: g, title: `${v.verdict} ×${v.fails}` })),
      tone: red,
    },
    { n: "done", items: bucket("done"), tone: cyan },
  ];

  const COL = Math.max(11, Math.floor((w - 4) / 5));
  const BOX = COL - 6;
  // A column of 34 queued tasks would run off the bottom, so each is capped and
  // says how many it is hiding. Silent truncation would read as "that is all".
  const CAP = Math.max(3, Math.min(9, h - 12));
  const shown = stages.map((s2) => s2.items.slice(0, CAP));
  const tallest = Math.max(1, ...shown.map((x) => x.length));

  out.push("");
  out.push("  " + stages.map((s2) => fit(dim(s2.n), COL)).join(""));
  out.push(
    "  " +
      stages
        .map((s2) => {
          const tone = s2.items.length ? s2.tone : faint;
          return tone("┌" + "─".repeat(BOX - 2) + "┐") + " ".repeat(COL - BOX);
        })
        .join(""),
  );
  for (let r = 0; r < tallest; r++) {
    out.push(
      "  " +
        stages
          .map((s2, i) => {
            const tone = s2.items.length ? s2.tone : faint;
            const it = shown[i][r];
            if (!it) {
              return r === 0
                ? tone("│") + " ".repeat(BOX - 2) + tone("│") + " ".repeat(COL - BOX)
                : " ".repeat(COL);
            }
            return (
              tone("│") +
              fit(" " + (s2.n === "held" ? bold(it.id) : dim(it.id)), BOX - 2) +
              tone("│") +
              " ".repeat(COL - BOX)
            );
          })
          .join(""),
    );
  }
  out.push(
    "  " +
      stages
        .map((s2) => {
          const tone = s2.items.length ? s2.tone : faint;
          return tone("└" + "─".repeat(BOX - 2) + "┘") + " ".repeat(COL - BOX);
        })
        .join(""),
  );
  out.push(
    "   " +
      stages
        .map((s2, i) => {
          const hidden = s2.items.length - shown[i].length;
          const label = hidden > 0 ? `${s2.items.length}  +${hidden} more` : String(s2.items.length);
          return fit(s2.items.length ? s2.tone(label) : faint("0"), COL);
        })
        .join(""),
  );
  out.push("");

  const held = stages[2].items.length;
  const working = stages[1].items.length;
  if (held >= 2 && working === 0) {
    out.push("  " + amber(`▲ ${held} held and nothing being built — the queue is behind a decision`));
  } else if (held >= 2) {
    out.push("  " + amber(`▲ ${held} tasks are waiting on a verdict`));
  } else {
    out.push("  " + faint("nothing is piling up"));
  }
  out.push(faint("─".repeat(w)));

  // The held tasks by name, with their reason. A count you cannot act on is
  // decoration; the reason is the whole point of the column.
  for (const t of stages[2].items.slice(0, 4)) {
    out.push(
      " " +
        fit(bold(t.id), 8) +
        fit(dim(t.title ?? ""), Math.max(10, w - 42)) +
        amber(fit(t.blocked ?? t.note ?? "held", 32)),
    );
  }

  const longest = [...st.agents.values()]
    .filter((a) => a.status === "running")
    .sort((a, x) => a.started - x.started)[0];
  if (longest) {
    out.push(faint("─".repeat(w)));
    out.push(
      " " +
        dim("longest run  ") +
        fit(bold(longest.name), 10) +
        fit(dim(longest.task), 10) +
        cyan(clock(Date.now() - longest.started)) +
        dim("   burned ") +
        amber(human(totalTok(longest.tok))),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ tail */

function tail(st, w, h, ui) {
  const name = st.order[ui.sel];
  const a = name ? st.agents.get(name) : null;
  const out = [];
  if (!a) {
    out.push("");
    out.push("  " + faint("no agent selected — press 1 for the deck and pick one with ↑↓"));
    return out;
  }
  const live = a.status === "running";
  out.push(
    " " +
      bold(a.name) +
      faint(" · ") +
      dim(a.task) +
      faint(" · ") +
      cyan(clock((a.ended ?? Date.now()) - a.started)) +
      faint(" · ") +
      amber(human(totalTok(a.tok))) +
      faint(" · ") +
      dim(a.model) +
      " ".repeat(Math.max(1, w - 48 - vlen(`${a.name}${a.task}${a.model}`))) +
      (live ? lime("● running") : a.status === "fail" ? red("● failed") : dim("● done")),
  );
  out.push(faint("─".repeat(w)));

  const room = Math.max(3, h - 8);
  const lines = a.lines.slice(-room + ui.scroll);
  const TONE = { ok: lime, bad: red, n: dim, hi: cyan };
  for (const l of lines.slice(-room)) {
    out.push(
      " " +
        dim(hhmmss(l.t)) +
        "  " +
        fit((TONE[l.tone] ?? dim)(l.verb), 6) +
        fit(l.tone === "bad" ? red(l.text) : l.tone === "ok" ? dim(l.text) : l.text, w - 30) +
        faint(l.meta),
    );
  }
  while (out.length < h - 3) out.push("");
  out.push(faint("─".repeat(w)));
  out.push(
    " " +
      faint("in ") +
      dim(human(a.tok.in)) +
      faint("   cached ") +
      cyan(human(a.tok.cached)) +
      faint("   write ") +
      amber(human(a.tok.write)) +
      faint("   out ") +
      lime(human(a.tok.out)) +
      faint("     ") +
      dim(`${a.turns} turn${a.turns === 1 ? "" : "s"}`) +
      faint("   ") +
      dim(`${human(Math.round(totalTok(a.tok) / Math.max(1, a.turns)))}/turn`),
  );
  return out;
}

/* ------------------------------------------------------------- waterfall */

function waterfall(st, w, h) {
  const out = [];
  const t0 = st.started;
  const t1 = Date.now();
  const span = Math.max(1000, t1 - t0);
  const GUTTER = 10;
  const track = Math.max(20, w - GUTTER - 16);
  const col = (t) => Math.round(((t - t0) / span) * track);

  out.push(" " + dim(`pass ${st.pass} · `) + bold(`${hhmmss(t0)} → ${hhmmss(t1)}`) + dim(` · ${clock(span)} wall`));
  out.push("");

  // Axis ticks at round fractions of the elapsed window, labelled with real
  // wall-clock times so a stall can be found in the log by timestamp.
  let lab = "";
  let ax = "";
  for (const f of [0, 0.25, 0.5, 0.75]) {
    const c = Math.round(f * track);
    // Over a short pass every hh:mm label is identical and the axis says
    // nothing. Below an hour the ticks are elapsed mm:ss instead.
    lab = lab.padEnd(c) + (span < 3600000 ? clock(f * span) : hhmmss(t0 + f * span).slice(0, 5));
    ax = ax.padEnd(c, "─") + "┼";
  }
  ax = "├" + ax.slice(1);
  ax = ax.padEnd(track, "─") + "┤";
  out.push(" ".repeat(GUTTER) + faint(lab));
  out.push(" ".repeat(GUTTER) + faint(ax));

  let agentMs = 0;
  for (const name of st.order) {
    const a = st.agents.get(name);
    let cells = "";
    let at = 0;
    for (const [s, e] of a.spans) {
      const from = Math.max(0, col(s));
      const to = Math.max(from + 1, col(e ?? t1));
      agentMs += (e ?? t1) - s;
      if (from > at) cells += faint("·".repeat(from - at));
      const tone = a.status === "fail" ? red : name === "graph" ? mauve : lime;
      cells += tone("█".repeat(to - from));
      at = to;
    }
    if (at < track) cells += faint("·".repeat(track - at));
    const mine = a.spans.reduce((n, [s, e]) => n + ((e ?? t1) - s), 0);
    out.push(
      " " +
        fit(dim(a.name), 9) +
        fit(cells, track) +
        "  " +
        fit(faint(clock(mine)), 7) +
        dim(human(totalTok(a.tok))),
    );
  }

  out.push("");
  out.push(faint("─".repeat(w)));
  out.push(
    " " +
      dim("wall clock ") +
      bold(clock(span)) +
      dim("     agent time ") +
      bold(clock(agentMs)) +
      dim("     concurrency ") +
      lime(`${(agentMs / span).toFixed(2)}×`) +
      dim("     tokens ") +
      amber(human(stateTokens(st))),
  );
  return out;
}

/* ─────────────────────────────────────────────────────────────── the frame */

const RENDER = { deck, cycle, tail, waterfall };

/**
 * Build the whole frame. PURE: same state and size in, same lines out. That is
 * what makes --frame a real check rather than a screenshot of a guess.
 */
export function frame(st, w, h, ui) {
  const body = RENDER[SCREENS[ui.screen]](st, w, h - 2, ui);
  const lines = body.slice(0, h - 2).map((l) => fit(l, w));
  while (lines.length < h - 2) lines.push(" ".repeat(w));

  const tabs = SCREENS.map((s, i) =>
    i === ui.screen ? inv(` ${i + 1} ${s} `) : faint(` ${i + 1} ${s} `),
  ).join("");
  const keys = [
    ["↑↓", "select"],
    ["⏎", "follow"],
    ["k", "kill"],
    ["q", "quit"],
  ]
    .map(([k, l]) => `${inv(` ${k} `)}${dim(` ${l}`)}`)
    .join("  ");
  lines.push(fit(tabs + "   " + (st.notice ? amber(st.notice) : ""), w));
  lines.push(fit(" " + keys, w));
  return lines;
}

/* ──────────────────────────────────────────────────────────── the terminal */

/**
 * DIFF WRITER. Repainting the whole screen every tick flickers and floods a slow
 * ssh link; only changed lines are sent. `prev` is the last frame, so the cost
 * of an idle second is a cursor move and nothing else.
 */
function makePainter(stream) {
  let prev = [];
  return {
    paint(lines) {
      let buf = "";
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === prev[i]) continue;
        buf += `${CSI}${i + 1};1H${CSI}2K${lines[i]}`;
      }
      if (prev.length > lines.length) {
        for (let i = lines.length; i < prev.length; i++) buf += `${CSI}${i + 1};1H${CSI}2K`;
      }
      if (buf) stream.write(buf);
      prev = lines;
    },
    reset() {
      prev = [];
    },
  };
}

function enterTerminal(out) {
  out.write(`${CSI}?1049h${CSI}?25l${CSI}2J`);
}
function leaveTerminal(out) {
  out.write(`${CSI}?25h${CSI}?1049l`);
}

/* ─────────────────────────────────────────────────────────────── the source */

/** Tail a JSONL file, handing each new complete line to `onLine`. */
function tailFile(path, onLine) {
  let pos = existsSync(path) ? 0 : 0;
  let carry = "";
  const pump = () => {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size < pos) {
      pos = 0;
      carry = "";
    } // truncated / rotated
    if (size === pos) return;
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(size - pos);
    readSync(fd, buf, 0, buf.length, pos);
    closeSync(fd);
    pos = size;
    carry += buf.toString("utf8");
    const parts = carry.split("\n");
    carry = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        /* a half-written line is normal while a run is appending */
      }
    }
  };
  pump();
  return setInterval(pump, 200);
}

/**
 * DEMO SOURCE — a scripted pass, so the TUI is alive with no run attached.
 *
 * It is deliberately a SCRIPT OF THE SAME EVENTS a real run emits, not a
 * separate rendering path: if the demo looks right the real one does too, and
 * there is no second code path to keep in sync.
 */
export const DEMO_SCRIPT = [
  [0, { kind: "pass", pass: 14, layer: "layer 2 · harness" }],
  [200, { kind: "agent.start", agent: "spec", task: "H-4", model: "opus" }],
  [400, { kind: "tool", agent: "spec", tone: "n", verb: "read", text: "docs/specs/drift.md", meta: "1.9k" }],
  [1200, { kind: "tokens", agent: "spec", cached: 24000, in: 1800, out: 420, turn: 1 }],
  [1600, { kind: "tool", agent: "spec", tone: "n", verb: "write", text: "docs/specs/H-4.md", meta: "+84" }],
  [2400, { kind: "tokens", agent: "spec", cached: 31000, in: 900, write: 4200, out: 1100, turn: 1 }],
  [2600, { kind: "agent.end", agent: "spec", verdict: "done" }],
  [2700, { kind: "agent.start", agent: "build", task: "H-4", model: "opus" }],
  [2800, { kind: "agent.start", agent: "graph", task: "—", model: "haiku" }],
  [3000, { kind: "tool", agent: "build", tone: "n", verb: "read", text: "bin/drift.mjs", meta: "6.2k" }],
  [3400, { kind: "tokens", agent: "build", cached: 88000, in: 6200, out: 900, turn: 1 }],
  [3600, { kind: "tool", agent: "graph", tone: "n", verb: "scan", text: "1,284 files", meta: "" }],
  [4000, { kind: "tokens", agent: "graph", cached: 41000, in: 5200, out: 380, turn: 1 }],
  [10400, { kind: "tokens", agent: "graph", cached: 38000, in: 4800, out: 310, turn: 1 }],
  [4200, { kind: "tool", agent: "build", tone: "n", verb: "edit", text: "bin/drift.mjs", meta: "+31 −18" }],
  [4600, { kind: "tokens", agent: "build", cached: 96000, write: 8800, out: 2100, turn: 1 }],
  [4800, { kind: "agent.end", agent: "graph", verdict: "done" }],
  [5000, { kind: "tool", agent: "build", tone: "n", verb: "bash", text: "node bin/drift.test.mjs", meta: "" }],
  [5800, { kind: "tool", agent: "build", tone: "ok", verb: "  ✓", text: "70 checks passed", meta: "" }],
  [6000, { kind: "tokens", agent: "build", cached: 104000, in: 2200, out: 1800, turn: 1 }],
  [6200, { kind: "agent.end", agent: "build", verdict: "done" }],
  [6300, { kind: "gate", gate: "reviewer", verdict: "pass" }],
  [6400, { kind: "agent.start", agent: "qa", task: "H-4", model: "opus" }],
  [6800, { kind: "tool", agent: "qa", tone: "n", verb: "bash", text: "node bin/drift.test.mjs --mutate", meta: "" }],
  [7600, { kind: "tokens", agent: "qa", cached: 142000, in: 3100, out: 640, turn: 1 }],
  [8200, { kind: "tool", agent: "qa", tone: "bad", verb: "  ✗", text: "3 FAILED — mutation 7 not detected", meta: "" }],
  [8300, { kind: "gate", gate: "qa", verdict: "fail", fails: 3 }],
  [8400, { kind: "notice", text: "qa failed — merge is blocked" }],
  [8600, { kind: "tool", agent: "qa", tone: "n", verb: "read", text: "bin/drift.mjs", meta: "6.2k" }],
  [9400, { kind: "tokens", agent: "qa", cached: 188000, in: 6400, out: 900, turn: 1 }],
  [9800, { kind: "agent.start", agent: "graph", task: "rebuild", model: "haiku" }],
  [10600, { kind: "tool", agent: "qa", tone: "n", verb: "edit", text: "bin/drift.mjs", meta: "+12 −3" }],
  [11000, { kind: "tokens", agent: "qa", cached: 204000, write: 5600, out: 2400, turn: 1 }],
  [11400, { kind: "agent.end", agent: "graph", verdict: "done" }],
  [11800, { kind: "tool", agent: "qa", tone: "n", verb: "bash", text: "node bin/drift.test.mjs --mutate", meta: "" }],
  [12800, { kind: "tool", agent: "qa", tone: "ok", verb: "  ✓", text: "10 of 10 mutations caught", meta: "" }],
  [13000, { kind: "gate", gate: "qa", verdict: "pass" }],
  [13100, { kind: "notice", text: null }],
  [13400, { kind: "tokens", agent: "qa", cached: 219000, in: 2800, out: 1900, turn: 1 }],
  [13600, { kind: "agent.end", agent: "qa", verdict: "done" }],
  [13800, { kind: "gate", gate: "security", verdict: "pass" }],
];

function demoSource(emit) {
  const timers = DEMO_SCRIPT.map(([at, e]) => setTimeout(() => emit(e), at));
  return () => timers.forEach(clearTimeout);
}

/* ───────────────────────────────────────────────────────────────────── cli */

const isEntry =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntry) {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(`--${f}`);
  const val = (f, d) => {
    const i = argv.indexOf(`--${f}`);
    return i === -1 ? d : argv[i + 1];
  };
  NOCOLOR = has("no-color") || process.env.NO_COLOR != null;

  const st = newState();
  const ui = { screen: 0, sel: 0, scroll: 0, follow: true };

  // The board feeds the cycle screen. Optional: without it that screen says so
  // rather than inventing tasks, because a fabricated board is worse than none.
  // Resolved the same way board.mjs resolves it, so the TUI and the CLI cannot
  // end up reading different files and reporting different counts.
  const boardPath =
    val("board", null) ??
    (() => {
      for (const cfg of ["ops/foreman/config.json", "bin/config.json"]) {
        try {
          return JSON.parse(readFileSync(cfg, "utf8")).board;
        } catch {}
      }
      return "docs/board.json";
    })();
  try {
    const raw = JSON.parse(readFileSync(boardPath, "utf8"));
    st.board = (raw.phases ?? []).flatMap((ph) => ph.tasks ?? []);
  } catch {
    st.board = null;
  }

  /* --frame: render N seconds into a demo and print it. This is the check. */
  const frameAt = val("frame", null);
  if (frameAt != null) {
    const secs = Number(frameAt);
    // Replay the demo script synchronously up to `secs`, with timestamps
    // rewritten so the elapsed clocks read as if it really took that long.
    const events = DEMO_SCRIPT;
    st.started = Date.now() - secs * 1000;
    for (const [at, e] of events) {
      if (at > secs * 1000) continue;
      apply(st, { ...e, t: new Date(st.started + at).toISOString() });
    }
    // Synthesise the rate history the live loop would have sampled.
    for (const a of st.agents.values()) {
      a.rate = Array.from({ length: 40 }, (_, i) =>
        a.status === "running" ? 8000 + 14000 * Math.abs(Math.sin(i / 3)) : 0,
      );
    }
    st.rate = Array.from({ length: 80 }, (_, i) => 6000 + 20000 * Math.abs(Math.sin(i / 5)));
    const w = Number(val("width", 100));
    const h = Number(val("height", 30));
    const screen = val("screen", null);
    if (screen) ui.screen = Math.max(0, SCREENS.indexOf(screen));
    ui.sel = Math.max(0, st.order.length - 1);
    console.log(frame(st, w, h, ui).join("\n"));
    process.exit(0);
  }

  /* live */
  const out = process.stdout;
  let W = out.columns || 100;
  let H = out.rows || 30;
  const painter = makePainter(out);

  let stopSource = () => {};
  const logPath = val("log", null);
  if (logPath) {
    const iv = tailFile(logPath, (e) => apply(st, e));
    stopSource = () => clearInterval(iv);
  } else if (has("demo")) {
    stopSource = demoSource((e) => apply(st, e));
  } else {
    st.notice = "no source — pass --demo or --log FILE";
  }

  const quit = (code = 0) => {
    stopSource();
    clearInterval(ticker);
    try {
      process.stdin.setRawMode(false);
    } catch {}
    process.stdin.pause();
    leaveTerminal(out);
    process.exit(code);
  };

  enterTerminal(out);
  // Restoring the terminal on EVERY exit path, not just q. A TUI that leaves the
  // alternate buffer on and the cursor hidden after a crash is the single most
  // hated failure of the genre — the shell is still there and looks dead.
  process.on("exit", () => leaveTerminal(out));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => quit(0));
  process.on("uncaughtException", (e) => {
    leaveTerminal(out);
    console.error(e);
    process.exit(1);
  });

  out.on("resize", () => {
    W = out.columns || W;
    H = out.rows || H;
    out.write(`${CSI}2J`);
    painter.reset();
  });

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (buf) => {
      const s = buf.toString();
      if (s === "\x03" || s === "q") return quit(0);
      if (s === "\x1b[A") ui.sel = Math.max(0, ui.sel - 1);
      else if (s === "\x1b[B") ui.sel = Math.min(Math.max(0, st.order.length - 1), ui.sel + 1);
      else if (s === "\r" || s === "\n") ui.screen = 2; // follow the selected agent
      else if (s === "\x1b") ui.screen = 0;
      else if (s === "\t") ui.screen = (ui.screen + 1) % SCREENS.length;
      else if (s >= "1" && s <= "4") ui.screen = Number(s) - 1;
      else if (s === "k") st.notice = "kill is not wired to a runner yet";
    });
  }

  const ticker = setInterval(() => {
    sample(st);
    painter.paint(frame(st, W, H, ui));
  }, 250);
}
