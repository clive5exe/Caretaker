#!/usr/bin/env node
/**
 * TUI MOCKUP — the layout, with fake data, so it can be argued about before it
 * is built.
 *
 * This renders once and exits. It is a LAYOUT SPEC that happens to be runnable,
 * not the beginning of the TUI: U-1 stays blocked until a run works, and a live
 * dashboard with nothing live on it is a screensaver.
 *
 * The three decisions it exists to make visible:
 *
 *   MASTER / DETAIL. Several agents run at once, so the left column lists them
 *   and the right shows the selected one. Without this the screen is either one
 *   agent (useless when three are running) or all of them interleaved (useless
 *   always).
 *
 *   AGENT OUTPUT IS A TAIL OF THE LOG, NEVER A SECOND WRITER. The agent writes
 *   to the event log; this reads it. Two writers on one terminal produce
 *   shredded output and an unusable screen, and retrofitting that means
 *   rewriting the whole thing.
 *
 *   THE TOKEN BREAKDOWN IS ON THE DETAIL PANE, not just a total. Mid-run is
 *   exactly when the composition is actionable, because it is when you can still
 *   kill something burning context replay on a task estimated at a fifth of it.
 *
 * Run: node bin/tui-mock.mjs [--width 100] [--no-color]
 */
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const W = Math.max(88, Number(flag("width", process.stdout.columns || 100)));
const COLOR = !argv.includes("--no-color") && process.stdout.isTTY !== false;

const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c("38;5;244", s);
const faint = (s) => c("38;5;240", s);
const lime = (s) => c("38;5;155", s);
const amber = (s) => c("38;5;214", s);
const red = (s) => c("38;5;203", s);
const bold = (s) => c("1", s);
const inv = (s) => c("7", s);
/** Visible length, ignoring escape codes, so padding is not thrown off. */
const vlen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
/** Truncate to `n` visible chars, then pad. Overflow breaks the column rule. */
const fit = (s, n) => {
  if (vlen(s) <= n) return s + " ".repeat(n - vlen(s));
  // Cheap truncation that keeps escape codes intact by only cutting plain runs.
  let outp = "";
  let seen = 0;
  for (let i = 0; i < s.length && seen < n - 1; i++) {
    if (s[i] === "\x1b") {
      const end = s.indexOf("m", i);
      outp += s.slice(i, end + 1);
      i = end;
      continue;
    }
    outp += s[i];
    seen += 1;
  }
  return outp + "\x1b[0m…" + " ".repeat(Math.max(0, n - seen - 1));
};
const pad = (s, n) => fit(s, n);
const rule = (ch = "─") => faint(ch.repeat(W));

const LEFT = 34;
const RIGHT = W - LEFT - 3;

const out = [];
const row = (l, r) => out.push(`${pad(l, LEFT)} ${faint("│")} ${pad(r, RIGHT)}`);

/* ------------------------------------------------------------------ header */

out.push(
  pad(`${bold("FOREMAN")}  ${dim("Layer 2 — Harness")}`, W - 34) +
    `${lime("28%")} ${faint("▏")} ${dim("ETA 28 Sep")} ${faint("▏")} ${dim("02:14:33")}`,
);
out.push(rule());

/* --------------------------------------------------------------- kpi strip */

const kpi = (label, value, tone = dim) => `${faint(label)} ${tone(value)}`;
out.push(
  "  " +
    [
      kpi("RUNNING", "2", lime),
      kpi("HELD", "1", amber),
      kpi("BLOCKED", "2", red),
      kpi("TOKENS TODAY", "1.24M"),
      kpi("REWORK", "12%", amber),
      kpi("GRAPH", "rebuilding…", amber),
    ].join(faint("   ·   ")),
);
out.push(rule());

/* ------------------------------------------------------- master / detail */

row(faint("AGENTS"), `${bold("qa")} ${faint("·")} ${dim("T-277")} ${faint("·")} ${dim("money gates")}`);
row("", faint("─".repeat(RIGHT)));

const agents = [
  { sel: true, name: "qa", task: "T-277", el: "2m14s", tok: "412k", bar: 4 },
  { sel: false, name: "reviewer", task: "H-1", el: "0m31s", tok: "18k", bar: 1 },
  { sel: false, name: "graph", task: "—", el: "1m02s", tok: "—", bar: 2 },
];
const log = [
  [dim("14:22:01"), faint("bash "), "npm run qa"],
  [dim("14:22:47"), lime("  ✓  "), dim("53 scripts passed")],
  [dim("14:23:10"), faint("read "), `src/lib/pricing.ts  ${faint("2.1k tok")}`],
  [dim("14:23:14"), faint("edit "), "src/lib/pricing.ts"],
  [dim("14:23:40"), faint("bash "), "node scripts/qa/platform-fee.mjs"],
  [dim("14:23:58"), red("  ✗  "), red("3 FAILED — every price 1c..$600 charged 200c")],
  [dim("14:24:02"), faint("read "), `docs/decisions/0029-*.md  ${faint("8.4k tok")}`],
];

agents.forEach((a, i) => {
  const marker = a.sel ? lime("▸") : " ";
  const nm = a.sel ? bold(a.name) : dim(a.name);
  const bar = a.bar ? lime("▓".repeat(a.bar)) : "";
  const left = `${marker} ${pad(nm, 9)}${pad(dim(a.task), 7)}${pad(dim(a.el), 7)}${pad(dim(a.tok), 6)}${bar}`;
  const l = log[i] ?? null;
  row(left, l ? `${l[0]} ${l[1]} ${l[2]}` : "");
});

for (let i = agents.length; i < log.length; i++) {
  const l = log[i];
  row(i === agents.length ? "" : "", `${l[0]} ${l[1]} ${l[2]}`);
}

row("", "");
row(faint("QUEUE"), faint("─".repeat(RIGHT)));
row(`  ${dim("H-2")}  ${dim("second vendor")}`, `${faint("in")} 12.4k   ${faint("cached")} 288k   ${amber("write")} 31k   ${lime("out")} 6.1k`);
row(`  ${dim("H-4")}  ${dim("drift gate")}`, `${faint("38 turns · 10.8k/turn ·")} ${dim("opus")}`);
row(`  ${dim("H-9")}  ${dim("timeouts")}`, amber("  output share 1.5% — this run is paying to re-read"));

/* ------------------------------------------------------------------ board */

out.push(rule());
out.push(
  "  " +
    [
      `${faint("WORKING")} ${bold("3")}`,
      `${faint("QUEUED")} ${dim("8")}`,
      `${faint("HELD")} ${amber("1")}`,
      `${faint("BLOCKED")} ${red("2")}`,
      `${faint("DONE")} ${lime("1")}`,
      faint("│"),
      `${faint("H-1")} ${dim("seam")} ${lime("▓▓▓▓▓▓")}${faint("░░░░")} 60%`,
    ].join("   "),
);
out.push(rule());

/* ----------------------------------------------------------------- footer */

const key = (k, label) => `${inv(` ${k} `)} ${dim(label)}`;
out.push(
  "  " +
    [
      key("↑↓", "select"),
      key("⏎", "follow"),
      key("f", "filter"),
      key("k", "kill"),
      key("␣", "pause"),
      key("b", "board"),
      key("q", "quit"),
    ].join("  "),
);

console.log("\n" + out.join("\n") + "\n");
