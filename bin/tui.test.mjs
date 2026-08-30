#!/usr/bin/env node
/**
 * Tests for the TUI.
 *
 * A TUI is the one kind of program that cannot be checked by running it: it
 * takes the terminal, so nothing it draws lands anywhere you can assert on. The
 * whole design exists to make it testable anyway — `frame()` is a pure function
 * of (state, width, height, ui), so these call it directly and read the lines.
 *
 * IN-PROCESS, NOT SUBPROCESS. An earlier version shelled out to `--frame` once
 * per case: 144 node spawns, ninety seconds, too slow to run while editing. The
 * pure function is the whole point; this uses it.
 *
 * WHAT IS ACTUALLY PROTECTED. Column drift — a cell wider than its slot shifts
 * everything to its right and the borders stop lining up. It cannot be caught by
 * eye at one width, because it only shows at the widths you did not try.
 *
 * Run: node bin/tui.test.mjs
 */
import { frame, newState, apply, SCREENS, DEMO_SCRIPT, vlen, setColor } from "./tui.mjs";

let failures = 0;
const ok = (name, passed, detail = "") => {
  console.log(passed ? `PASS ${name}` : `FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  if (!passed) failures += 1;
};

/** Replay the demo script `secs` in, with timestamps rewritten to match. */
function stateAt(secs, board = null) {
  const st = newState();
  st.board = board;
  st.started = Date.now() - secs * 1000;
  for (const [at, e] of DEMO_SCRIPT) {
    if (at > secs * 1000) continue;
    apply(st, { ...e, t: new Date(st.started + at).toISOString() });
  }
  for (const a of st.agents.values()) {
    a.rate = Array.from({ length: 40 }, (_, i) => (a.status === "running" ? 8000 + 14000 * Math.abs(Math.sin(i / 3)) : 0));
  }
  st.rate = Array.from({ length: 80 }, (_, i) => 6000 + 20000 * Math.abs(Math.sin(i / 5)));
  return st;
}

const BOARD = [
  { id: "P-1", title: "spec schema", status: "todo" },
  { id: "P-2", title: "parser", status: "todo" },
  { id: "H-1", title: "the seam", status: "doing" },
  { id: "U-1", title: "the walkthrough", status: "blocked", blocked: "needs a decision" },
  { id: "U-2", title: "steer mid-flight", status: "blocked", blocked: "waiting on H-1" },
  { id: "B-1", title: "board engine", status: "done" },
];

const render = (screen, w, h, colour = false, sel = 3) => {
  setColor(colour);
  const lines = frame(stateAt(12, BOARD), w, h, { screen: SCREENS.indexOf(screen), sel, scroll: 0 });
  setColor(false);
  return lines;
};

const WIDTHS = [40, 60, 72, 80, 100, 120, 160, 200, 300];
const HEIGHTS = [10, 14, 18, 24, 40, 60];

/* ---------------------------------------------- the frame fills the screen */

for (const screen of SCREENS) {
  let bad = null;
  for (const w of WIDTHS) {
    for (const h of HEIGHTS) {
      for (const colour of [true, false]) {
        let lines;
        try {
          lines = render(screen, w, h, colour);
        } catch (e) {
          bad ??= `${w}x${h}: threw ${String(e.message).slice(0, 90)}`;
          continue;
        }
        const wrong = lines.findIndex((l) => vlen(l) !== w);
        if (wrong !== -1) bad ??= `${w}x${h}${colour ? "" : " plain"}: line ${wrong} is ${vlen(lines[wrong])} not ${w}`;
        if (lines.length !== h) bad ??= `${w}x${h}: ${lines.length} lines`;
      }
    }
  }
  ok(`${screen}: exactly W×H at every size, colour and plain`, !bad, bad ?? "");
}

/* ----------------------------------------------------- the borders line up */

/*
 * THE CHECK THE WIDTH ASSERTION DOES NOT MAKE. Every row being W wide does not
 * mean the columns inside it agree — a row can be padded back to width while its
 * contents have all shifted one place left. The deck draws a box, so its
 * verticals are a hard invariant: every row of the box has │ at column 0 and at
 * column W-1, and nowhere in between.
 */
for (const w of [72, 100, 160]) {
  const lines = render("deck", w, 24, false).filter((l) => l.startsWith("│"));
  const bad = lines.find((l) => l[0] !== "│" || l[w - 1] !== "│" || l.slice(1, w - 1).includes("│"));
  ok(
    `deck w=${w}: every box row has its verticals at 0 and ${w - 1} and nowhere else`,
    lines.length > 0 && !bad,
    bad ? JSON.stringify(bad.slice(0, 60)) : lines.length === 0 ? "no box rows found" : "",
  );
}

{
  // The agent rows are built from fixed-width cells, so the status word starts
  // at the same column in every one. If it does not, a cell overflowed.
  const lines = render("deck", 100, 24, false);
  const rows = lines.filter((l) => /(running|done|fail)\s*│$/.test(l));
  const cols = rows.map((l) => l.search(/(running|done|fail)\s*│$/));
  ok(
    "deck: the status column starts at the same place on every agent row",
    rows.length >= 3 && new Set(cols).size === 1,
    `${rows.length} rows, columns ${JSON.stringify(cols)}`,
  );
}

/* ------------------------------------------------ no escape sequence leaks */

for (const screen of SCREENS) {
  const plain = render(screen, 90, 24, false).join("\n");
  ok(
    `${screen}: plain mode emits no literal escape codes`,
    !/\x1b|\[0m|\[38;/.test(plain),
    plain.match(/\[[0-9;]*m/)?.[0] ?? "",
  );
}

/* ---------------------------------------------- the frame carries the state */

{
  const deck = render("deck", 100, 24, false).join("\n");
  ok("deck names every agent from the event stream", ["spec", "build", "graph", "qa"].every((n) => deck.includes(n)));
  ok("deck shows the gate verdicts", /reviewer/.test(deck) && /fail ×3/.test(deck));
  ok(
    "deck warns when output share is the problem",
    /output share .* paying to re-read/.test(deck),
    "the composition bar is only useful if it says what it means",
  );
  // The legend and the bar are the same numbers. A stacked bar whose widths
  // disagree with its own percentages teaches the reader the screen is lying.
  const legend = deck.split("\n").find((l) => l.includes("cache read"));
  const pcts = [...(legend ?? "").matchAll(/([\d.]+)%/g)].map((m) => Number(m[1]));
  ok(
    "deck composition percentages sum to 100",
    pcts.length === 4 && Math.abs(pcts.reduce((a, b) => a + b, 0) - 100) < 0.5,
    `${JSON.stringify(pcts)} sums to ${pcts.reduce((a, b) => a + b, 0).toFixed(1)}`,
  );

  /*
   * AND THE BAR ITSELF MUST MATCH THAT LEGEND. Checking only that the legend
   * sums to 100 passed a mutation that pinned every segment to a fixed 8 cells:
   * the legend is computed separately from the bar, so it stayed correct while
   * the picture above it became meaningless. The segments are colour-coded, so
   * measuring them means reading the frame WITH colour and counting each run.
   */
  setColor(true);
  const colourDeck = frame(stateAt(12, BOARD), 100, 24, { screen: 0, sel: 3, scroll: 0 });
  setColor(false);
  // Located by POSITION — the row directly above the legend — not by matching a
  // long run of blocks. Finding it by run length would mean the locator depends
  // on the property under test, and a mutation that shortens the segments would
  // report "no bar" rather than "wrong bar".
  const legendIdx = colourDeck.findIndex((l) => l.includes("cache read"));
  const barLine = legendIdx > 0 ? colourDeck[legendIdx - 1] : "";
  const runs = [...barLine.matchAll(/\x1b\[38;5;(\d+)m(█+)/g)].map((m) => m[2].length);
  const total = runs.reduce((a, b) => a + b, 0);
  const fromBar = runs.map((n) => (n / total) * 100);
  const drift = pcts.map((want, i) => Math.abs(want - (fromBar[i] ?? 0)));
  ok(
    "deck composition BAR widths match the legend it prints",
    runs.length === 4 && drift.every((d) => d < 1.5),
    `legend ${JSON.stringify(pcts)} vs bar ${JSON.stringify(fromBar.map((x) => +x.toFixed(1)))}`,
  );
}

{
  const wf = render("waterfall", 100, 24, false);
  const line = wf.find((l) => l.includes("concurrency")) ?? "";
  ok("waterfall reports concurrency", Boolean(line), wf.slice(0, 3).join(" / "));
  ok("waterfall concurrency exceeds 1 when agents overlap", /concurrency 1\.\d\d×/.test(line), line);
  ok(
    "waterfall ticks are elapsed time on a short pass",
    /00:0/.test(wf[2] ?? ""),
    // hh:mm labels over a twelve-second span are all identical and say nothing.
    wf[2] ?? "",
  );
  const bars = wf.filter((l) => /█/.test(l));
  ok("waterfall draws a row per agent", bars.length === 4, `${bars.length} rows`);
}

{
  const cyc = render("cycle", 110, 30, false).join("\n");
  ok("cycle columns come from the board's own statuses", /queued/.test(cyc) && /held/.test(cyc));
  ok("cycle places a blocked task in held and names its reason", /U-1/.test(cyc) && /needs a decision/.test(cyc));
  ok(
    "cycle warns that work is held",
    /2 tasks are waiting on a verdict/.test(cyc),
    cyc.split("\n").find((l) => l.includes("▲")) ?? "no warning line",
  );
  // The stronger warning is reserved for the case that actually means nobody is
  // working: held tasks AND an empty build column. The fixture has one doing.
  const idle = BOARD.filter((t) => t.status !== "doing");
  setColor(false);
  const stalled = frame(stateAt(12, idle), 110, 30, { screen: 1, sel: 0, scroll: 0 }).join("\n");
  ok(
    "cycle escalates the warning when nothing is being built at all",
    /behind a decision/.test(stalled),
    stalled.split("\n").find((l) => l.includes("▲")) ?? "no warning line",
  );
}

{
  const none = frame(stateAt(12, null), 100, 24, { screen: 1, sel: 0, scroll: 0 }).join("\n");
  ok(
    "cycle says it has no board rather than inventing one",
    /no board found/.test(none),
    // A fabricated board would read as real work, which is worse than a blank.
    none.split("\n")[1] ?? "",
  );
}

{
  const t = render("tail", 100, 26, false).join("\n");
  ok("tail shows the selected agent's output", /drift\.test\.mjs/.test(t));
  ok("tail shows the token split, not just a total", /in .*cached .*write .*out/.test(t));
  ok("tail pluralises turns", !/\b1 turns\b/.test(t), t.split("\n").find((l) => l.includes("turn")) ?? "");
}

console.log(failures === 0 ? `\n[tui] all checks passed` : `\n[tui] ${failures} FAILURE(S) above.`);
process.exit(failures === 0 ? 0 : 1);
