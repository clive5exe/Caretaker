#!/usr/bin/env node
// Task board: single source of truth is tasks.json.
//
//   node ops/caretaker/board.mjs                       show the board
//   node ops/caretaker/board.mjs status                same
//   node ops/caretaker/board.mjs start T-012           mark in progress
//   node ops/caretaker/board.mjs done  T-012           mark done, stamp the date
//   node ops/caretaker/board.mjs block T-012 "reason"  mark blocked
//   node ops/caretaker/board.mjs todo  T-012           reset
//   node ops/caretaker/board.mjs note  T-012 "text"    append a note
//   node ops/caretaker/board.mjs build                 regenerate the HTML page
//
// Any mutating command rebuilds the page automatically, so the docs site is
// never stale relative to the data.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import os from "node:os";

// PATHS COME FROM config.json, so this file is the same in every project. It
// Paths come from config.json beside this file, so board.mjs is identical in
// every project that installs it.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(
  fs.readFileSync(process.env.FACTORY_CONFIG || path.join(HERE, "config.json"), "utf8"),
);
const ROOT = path.resolve(HERE, "..", "..", CFG.repo ?? ".");
const DATA = path.join(ROOT, CFG.board);
const OUT = path.join(ROOT, CFG.boardMarkdown ?? "docs/board.md");

const load = () => JSON.parse(fs.readFileSync(DATA, "utf8"));
// Trailing newline is load-bearing, not cosmetic: without it every board write
// lands as "\ No newline at end of file" and the last line of the diff churns
// on top of the real change. d9e37df was a repair of this exact file after it
// was written by hand; the tool should not reintroduce a diff-noise defect.
const save = (d) => fs.writeFileSync(DATA, `${JSON.stringify(d, null, 2)}\n`);
const today = () => new Date().toISOString().slice(0, 10);

const STATUS = {
  todo: { label: "To do", chip: "neutral", weight: 0 },
  doing: { label: "In progress", chip: "warn", weight: 0.5 },
  blocked: { label: "Blocked", chip: "bad", weight: 0 },
  done: { label: "Done", chip: "ok", weight: 1 },
  // Work the product no longer wants. NOT failure, and NOT completion — it is
  // scope that was deleted by a decision, so it leaves the denominator
  // entirely (see `live()`). Counting it as done would inflate the headline;
  // leaving it as todo would understate it forever.
  dropped: { label: "Dropped", chip: "neutral", weight: 0 },
};

// The board's denominator. Dropped scope is excluded everywhere progress is
// computed or listed, so ADR-0028 deleting 26 tier tasks moves the percentage
// because the work is gone, not because anything was built.
const live = (tasks) => tasks.filter((t) => t.status !== "dropped");

const allTasks = (d) => d.phases.flatMap((p) => p.tasks.map((t) => ({ ...t, phase: p })));
const find = (d, id) => {
  for (const p of d.phases) {
    const t = p.tasks.find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (t) return { t, p };
  }
  return null;
};

/* ------------------------------------------------------------- estimates */
// "4h" | "2d" | "1.5w" -> days
function toDays(est) {
  if (!est) return 0;
  const m = String(est).match(/^([\d.]+)\s*([hdw])$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return m[2] === "h" ? n / 8 : m[2] === "w" ? n * 5 : n;
}

/* ---------------------------------------------------------------- render */
function progress(all) {
  const tasks = live(all);
  if (!tasks.length) return { pct: 0, done: 0, total: 0, dropped: all.length };
  const w = tasks.reduce((a, t) => a + (STATUS[t.status]?.weight ?? 0), 0);
  return {
    // RAW closed/total. Deliberately NOT weighted: giving "in progress" half
    // credit inflates the headline and hides that the bottleneck is gate
    // verdicts, not building. `weight` is kept for callers that want it.
    pct: Math.round((tasks.filter((t) => t.status === "done").length / tasks.length) * 100),
    done: tasks.filter((t) => t.status === "done").length,
    total: tasks.length,
    dropped: all.length - tasks.length,
  };
}

function bar(pct, cls = "") {
  return `<div class="pbar ${cls}"><div class="pfill" style="width:${pct}%"></div></div>`;
}

// Quotes too, not only & < >. No user text sits in an attribute in this output
// today — the one title="…" carries validated verdicts only — so this closes a
// latent hazard rather than a live one: the day someone adds an attribute, it
// is already safe. Same five characters dashboard.mjs escapes.
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Notes are appended chronologically joined by " — ". The newest entry is the
// current state and is the only part worth showing by default; the rest is
// history and goes behind a disclosure so it cannot swamp the page.
function noteBlock(note) {
  if (!note) return "";
  const parts = String(note)
    .split(/\s+—\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return "";
  const latest = parts[parts.length - 1];
  const history = parts.slice(0, -1);
  let out = `<div class="tnote"><b>Latest:</b> ${esc(latest)}</div>`;
  if (history.length) {
    out +=
      `<details class="thist"><summary>${history.length} earlier note${history.length > 1 ? "s" : ""}</summary>` +
      history.map((h) => `<p>${esc(h)}</p>`).join("") +
      `</details>`;
  }
  return out;
}

function acBlock(ac) {
  if (!ac) return "";
  const list = Array.isArray(ac) ? ac : [ac];
  return `<div class="acc"><b>Accept:</b> ${list.map((a) => esc(a)).join("<br>")}</div>`;
}

function taskBlock(t) {
  const st = STATUS[t.status] || STATUS.todo;
  const g = t.gate || {};
  const gates = ["reviewer", "qa", "security"]
    .filter((k) => g[k])
    .map((k) => {
      // A gate that passed on the fourth attempt is not the same fact as one that
      // passed first time, and until P-2 the board could not tell them apart.
      const tries = (g[k].history || []).length + 1;
      const suffix = tries > 1 ? ` (${tries})` : "";
      return `<span class="chip ${g[k].verdict === "pass" ? "ok" : "bad"}" title="${
        tries > 1 ? `attempt ${tries}; earlier: ${(g[k].history || []).map((h) => h.verdict).join(", ")}` : "first attempt"
      }">${k} ${g[k].verdict}${suffix}</span>`;
    })
    .join(" ");
  const meta = [
    `<span class="tmi"><b>${esc(t.owner)}</b></span>`,
    t.est ? `<span class="tmi">${esc(t.est)}</span>` : "",
    t.deps?.length ? `<span class="tmi">after ${t.deps.join(", ")}</span>` : "",
    t.completed ? `<span class="tmi">closed ${esc(t.completed)}</span>` : "",
  ]
    .filter(Boolean)
    .join("");

  return (
    `<div class="task ${t.status}">` +
    `<div class="taskhead"><code class="tid">${t.id}</code>` +
    `<span class="ttitle">${esc(t.title)}</span>` +
    `<span class="chip ${st.chip}">${st.label}</span></div>` +
    `<div class="taskmeta">${meta}${gates ? ` ${gates}` : ""}</div>` +
    acBlock(t.ac) +
    noteBlock(t.note) +
    `</div>\n`
  );
}

function build() {
  const d = load();
  const all = allTasks(d);
  const overall = progress(all);
  const daysLeft = live(all).filter((t) => t.status !== "done").reduce((a, t) => a + toDays(t.est), 0);
  const byOwner = {};
  for (const t of all) (byOwner[t.owner] ||= []).push(t);

  // Dates, goals and a launch target are optional in board.json. This repo's
  // own board has none of them, and formatting a missing date printed
  // "Invalid Date" and a missing goal printed "undefined" into every phase.
  const fmt = (s) =>
    new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const span = (p) => {
    if (p.start && p.end) return `<b>${fmt(p.start)} &rarr; ${fmt(p.end)}</b> &middot; `;
    if (p.start) return `<b>from ${fmt(p.start)}</b> &middot; `;
    if (p.end) return `<b>until ${fmt(p.end)}</b> &middot; `;
    return "";
  };

  // The headline number is RAW closed/total — no half credit for "in progress".
  // A weighted score reads higher than reality and hides the actual bottleneck,
  // which is that finished engineering sits waiting on gate verdicts. Show that
  // as its own figure instead of burying it inside the percentage.
  const rawPct = Math.round((overall.done / overall.total) * 100);
  const gatePending = live(all).filter((t) => t.status === "doing").length;

  // THE HEADLINE IS THE CURRENT PHASE, NOT THE ALL-TIME TOTAL.
  // ==========================================================================
  // `overall` sums EVERY phase this project has ever had — Week 0 through
  // Week 4 and Waves 1-3, which are pre-V1 scope that is not being built. That
  // made the big number read 57/255 while the thing actually under construction
  // (Phase 1) was 22/65, and it moved for reasons that had nothing to
  // do with today's work. The founder, reasonably: "how the fuck did we go from
  // 40 something tasks to 66 then 233".
  //
  // The current phase comes from config.activePhase, falling back to the LAST
  // phase in the file. It used to be the last phase unconditionally, which was
  // right for a board whose newest phase was always the live one and wrong the
  // first time a board listed its phases in build order — this repo's own,
  // where the last phase is the one that ships LAST. It reported 0% of Layer 6
  // as the headline while all the real work sat in Layer 1, and it disagreed
  // with the dashboard, which had honoured activePhase all along. Two tools
  // giving two answers about the same board is worse than either answer.
  //
  // The all-time figure is kept, demoted to a subline, because it is still true
  // and still occasionally useful — it just is not the headline.
  const currentPhase =
    d.phases.find((p) => p.name === CFG.activePhase) ?? d.phases[d.phases.length - 1];
  const current = progress(currentPhase.tasks);
  const currentPct = current.total ? Math.round((current.done / current.total) * 100) : 0;

  let md = `---
title: Task board
summary: Every planned task with owner, estimate, dates and status. Generated from tasks.json — do not hand-edit.
status: current
audience: [founder, eng, design, ops]
owner: clive
updated: ${d.meta.updated}
order: 2
---

<div class="board">
<div class="boardhead">
  <div class="bignum">${currentPct}<span>%</span></div>
  <div class="boardmeta">
    <b>${currentPhase.name} &middot; ${current.done} of ${current.total} tasks closed through the full gate</b>
    <span>${gatePending} more are built and waiting only on reviewer / qa / security verdicts${d.meta.launch ? ` &middot; launch target <b>${fmt(d.meta.launch)}</b>` : ""}</span>
    <span>All phases ever, including pre-V1 scope: ${overall.done} of ${overall.total} (${rawPct}%)</span>
  </div>
</div>
${bar(currentPct, "big")}
<div class="legend">
  <span class="chip ok">Done ${live(all).filter((t) => t.status === "done").length}</span>
  <span class="chip warn">In progress ${live(all).filter((t) => t.status === "doing").length}</span>
  <span class="chip bad">Blocked ${live(all).filter((t) => t.status === "blocked").length}</span>
  <span class="chip neutral">To do ${live(all).filter((t) => t.status === "todo").length}</span>
  ${overall.dropped ? `<span class="chip neutral">Dropped ${overall.dropped}</span>` : ""}
</div>
</div>

`;

  // ---- the three questions, answered before any phase detail -------------
  const line = (t) =>
    `<li><code class="tid">${t.id}</code> <b>${esc(t.title)}</b> <span class="tmi">${esc(t.owner)}</span></li>`;
  const doing = live(all).filter((t) => t.status === "doing");
  const blocked = live(all).filter((t) => t.status === "blocked");
  const founderBlocked = blocked.filter((t) => t.owner === "founder" || t.owner === "devops");
  const doneList = all.filter((t) => t.status === "done");

  md += `<div class="snap">\n`;
  md += `<div class="snapcol"><h3>Being worked on <span class="chip warn">${doing.length}</span></h3><ul>${doing.map(line).join("")}</ul></div>\n`;
  md += `<div class="snapcol"><h3>Blocked <span class="chip bad">${blocked.length}</span></h3><ul>${blocked.map(line).join("")}</ul>${founderBlocked.length ? `<p class="tmi">${founderBlocked.length} need a decision or access from you.</p>` : ""}</div>\n`;
  md += `<div class="snapcol"><h3>Done <span class="chip ok">${doneList.length}</span></h3><ul>${doneList.map(line).join("")}</ul></div>\n`;
  md += `</div>\n\n`;

  // per-phase
  for (const p of d.phases) {
    const pr = progress(p.tasks);
    const pdays = p.tasks.filter((t) => t.status !== "done").reduce((a, t) => a + toDays(t.est), 0);
    md += `## ${p.name}\n\n`;
    md += `<div class="phasebar"><div class="phasemeta">${span(p)}${pr.done}/${pr.total} done &middot; ${Math.ceil(pdays)}d remaining</div>${bar(pr.pct)}</div>\n\n`;
    if (p.goal) md += `${p.goal}\n\n`;
    // Full-width blocks, NOT a table. A five-column table crushes the title and
    // the note into one narrow cell, which is unreadable the moment a task has
    // any real history on it.
    const order = { doing: 0, blocked: 1, todo: 2, done: 3 };
    for (const t of [...p.tasks].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))) {
      md += taskBlock(t);
    }
    md += `\n`;
  }

  // by owner
  md += `## Load by agent\n\n| Agent | Tasks | Remaining |\n|---|---|---|\n`;
  for (const [o, ts] of Object.entries(byOwner).sort((a, b) => b[1].length - a[1].length)) {
    const rem = ts.filter((t) => t.status !== "done").reduce((a, t) => a + toDays(t.est), 0);
    md += `| \`${o}\` | ${ts.length} | ${Math.ceil(rem)}d |\n`;
  }

  md += `\n## Maintaining this\n\nGenerated from \`the board named in ops/caretaker/config.json\`. **Never edit the generated page.**\n\n\`\`\`\nnode ops/caretaker/board.mjs done T-012        mark complete, stamps today's date\nnode ops/caretaker/board.mjs start T-012       mark in progress\nnode ops/caretaker/board.mjs block T-012 "why" mark blocked with a reason\nnode ops/caretaker/board.mjs note T-012 "text" append a note\nnode ops/caretaker/board.mjs                   print the board to the terminal\n\`\`\`\n\nEvery mutating command rebuilds this page and the whole docs site, so it can never drift from the data.\n`;

  fs.writeFileSync(OUT, md);

  // status-latest.md carried a HAND-TYPED "Board: 23% (53/235 tasks)" that
  // nothing updated, so the dashboard showed two different totals on one page —
  // a fresh one in the header and a stale one in the status block. That is the
  // narrated-count rot CLAUDE.md forbids. Rewrite the line from the board on
  // every build so it cannot drift again. If the line is ever removed by hand
  // this is a no-op rather than an error: it must not break a build.
  const STATUS = path.join(ROOT, CFG.statusMarkdown ?? "docs/board-status.md");
  try {
    const before = fs.readFileSync(STATUS, "utf8");
    const after = before.replace(
      /^- \*\*Board:\*\* .*$/m,
      `- **Board:** ${currentPct}% (${current.done}/${current.total} ${currentPhase.name}) · all phases ${overall.done}/${overall.total}`,
    );
    if (after !== before) fs.writeFileSync(STATUS, after);
  } catch {
    /* status-latest.md is optional; a missing file is not a build failure. */
  }
  // An OPTIONAL docs-site hook. The project this came from had a build.mjs
  // beside the board; nothing here ships one, so running it unconditionally
  // printed "build.mjs failed" on every mutation — noise that teaches people to
  // ignore this script's stderr. A hook that exists still runs, and still
  // reports its own failure; a hook that does not exist is not an error.
  const hook = path.join(HERE, "build.mjs");
  if (fs.existsSync(hook)) {
    try {
      execFileSync("node", [hook], { stdio: "pipe" });
    } catch (e) {
      console.error("build.mjs failed:", e.message);
    }
  }
  // The CURRENT-PHASE figures ride along, because every caller that echoes a
  // number should echo the same one the dashboard headlines. Before this, the
  // build and done echoes quoted the all-phases percentage while the dashboard
  // showed the phase percentage, so the board reported two different truths
  // depending on which surface you looked at.
  return {
    ...overall,
    currentPct,
    currentDone: current.done,
    currentTotal: current.total,
    currentName: currentPhase.name,
  };
}

/* ------------------------------------------------------------------ cli */
const [cmd, id, ...rest] = process.argv.slice(2);
const text = rest.join(" ");

if (!cmd || cmd === "status") {
  const d = load();
  const all = allTasks(d);
  const o = progress(all);
  // LEAD WITH THE CURRENT PHASE, matching the dashboard. The all-phases figure
  // sums Week 0 through Wave 3 — 45 tasks of pre-V1 scope that nobody is
  // building — so it reads far lower than the work actually in flight and moves
  // for reasons unrelated to today. The dashboard demoted it to a subline
  // already; this printed it as THE number, so `ops/caretaker/board.mjs status`, the stop
  // hook and the dashboard were quoting three different figures for the same
  // board. Founder, 2026-08-29: "We were at 34% not at 24, that board is
  // fucking useless." He was reading 35% on the dashboard and 23% here.
  const cur =
    d.phases.find((p) => p.name === CFG.activePhase) ?? d.phases[d.phases.length - 1];
  const cp = progress(cur.tasks);
  console.log(`\n  ${cp.pct}%  ${cp.done}/${cp.total}  ${cur.name}`);
  console.log(`         all phases ever, incl. pre-V1 scope: ${o.done}/${o.total} (${o.pct}%)\n`);
  for (const p of d.phases) {
    const pr = progress(p.tasks);
    const blocked = p.tasks.filter((t) => t.status === "blocked").length;
    console.log(`  ${String(pr.pct).padStart(3)}%  ${p.name}  (${pr.done}/${pr.total})${blocked ? `  ${blocked} BLOCKED` : ""}`);
  }
  const active = all.filter((t) => t.status === "doing" || t.status === "blocked");
  if (active.length) {
    console.log("\n  Active:");
    for (const t of active) console.log(`    ${t.status === "blocked" ? "!" : ">"} ${t.id}  ${t.title}`);
  }
  console.log("");
} else if (cmd === "build") {
  const o = build();
  console.log(`board rebuilt — ${o.currentPct}% (${o.currentDone}/${o.currentTotal} ${o.currentName})  ·  all phases ${o.done}/${o.total}`);
} else if (["reviewer", "qa", "security"].includes(cmd)) {
  // record a gate verdict:  node ops/caretaker/board.mjs reviewer T-012 pass "notes"
  if (!id) { console.error("need a task id"); process.exit(1); }
  const d = load();
  const hit = find(d, id);
  if (!hit) { console.error(`no such task: ${id}`); process.exit(1); }
  const verdict = (rest[0] || "").toLowerCase();
  if (!["pass", "fail"].includes(verdict)) {
    console.error("verdict must be pass or fail:  node ops/caretaker/board.mjs " + cmd + " " + id + " pass");
    process.exit(1);
  }
  // APPEND, NEVER OVERWRITE (P-2). This used to replace the verdict, so a task
  // that failed qa three times and passed once recorded a single pass. Rework
  // rate and first-pass rate — the two quality metrics that actually predict
  // anything — were therefore not computable from the board at all, and the
  // dashboard had to print a caveat saying its fail-rate column understated
  // reality. Cheap to fix while there is no history to lose; impossible after.
  //
  // The shape stays BACKWARD COMPATIBLE. `gate.reviewer` is still an object with
  // `.verdict`, and it is still the LATEST one, so every existing reader keeps
  // working untouched. The history lives beside it in `gate.reviewer.history`,
  // oldest first, and is only read by the code that wants it.
  hit.t.gate = hit.t.gate || {};
  const previous = hit.t.gate[cmd];
  // B-8 and W-16, mirrored: the instant beside the date, and who recorded it.
  let by = "unknown";
  try { by = CFG.operator ? String(CFG.operator) : os.userInfo().username; } catch { /* unknown */ }
  const entry = { verdict, at: today(), t: new Date().toISOString(), by, via: "cli", note: rest.slice(1).join(" ") || undefined };
  const kept = (e) => ({ verdict: e.verdict, at: e.at, ...(e.t ? { t: e.t } : {}), ...(e.by ? { by: e.by } : {}), ...(e.via ? { via: e.via } : {}), note: e.note });
  const history = previous ? [...(previous.history || []), kept(previous)] : [];
  hit.t.gate[cmd] = { ...entry, ...(history.length ? { history } : {}) };
  d.meta.updated = today();
  save(d);
  build();
  const attempts = (hit.t.gate[cmd].history || []).length + 1;
  console.log(
    `${hit.t.id} · ${cmd} → ${verdict}` +
      (attempts > 1 ? `   (attempt ${attempts}; previous: ${(hit.t.gate[cmd].history || []).map((h) => h.verdict).join(", ")})` : ""),
  );
} else if (["done", "start", "block", "todo", "note"].includes(cmd)) {
  if (!id) { console.error("need a task id, e.g. T-012"); process.exit(1); }
  const d = load();
  const hit = find(d, id);
  if (!hit) { console.error(`no such task: ${id}`); process.exit(1); }
  const { t } = hit;

  if (cmd === "note") {
    t.note = t.note ? `${t.note} — ${text}` : text;
  } else {
    if (cmd === "done") {
      // THE LOOP IS NOT OPTIONAL. A task is done when the gate passed, not when
      // the builder says so. Money/auth/tenant tasks additionally need security.
      const g = t.gate || {};
      const needsSecurity =
    /\b(money|payments?|billing|auth|oauth|sign[- ]?in|login|credentials?|secrets?|api[- ]key|bearer|sandbox(ed|ing)?|isolation|egress|allowlist|escape|container socket|permission mode|cookies?|csrf|csp|cors|redact(ed|ion)?|needs security)\b/i
      .test(`${t.title} ${t.note || ""}`);
      // Docs-only work has no executable surface — reviewer is the whole gate.
      // Roles that never write code, on tasks that name no code path.
      const DOC_ROLES = ["product-architect", "legal", "marketing", "product-manager"];
      const NAMES_CODE = /web\/|\.tsx|\.ts\b|migration|schema|route|endpoint|component|playwright|spec\b|ci\b|gate\.yml/i;
      const docsOnly =
        DOC_ROLES.includes(t.owner) && !NAMES_CODE.test(`${t.title} ${t.ac || ""}`);
      const missing = [];
      if (g.reviewer?.verdict !== "pass") missing.push("reviewer");
      if (!docsOnly && g.qa?.verdict !== "pass") missing.push("qa");
      if (!docsOnly && needsSecurity && g.security?.verdict !== "pass") missing.push("security (money/auth/isolation)");
      // A FAIL blocks whether or not the gate was required: a refutation recorded
      // on a docs-only task is still a failing check (independent review).
      if (docsOnly && g.qa?.verdict === "fail") missing.push("qa");
      // H-4: the drift gate's latest verdict for this task, from the event log.
      let drift = null;
      try {
        const dir = path.join(ROOT, CFG.events ?? "ops/caretaker/events");
        for (const f of fs.readdirSync(dir).filter((x) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort()) {
          for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
            let e;
            try { e = JSON.parse(line); } catch { continue; }
            if (e?.kind === "gate" && e.task === t.id && e.verdict && e.source === undefined && (!drift || String(e.t) >= String(drift.t))) drift = e;
          }
        }
      } catch { /* no event log */ }
      if (drift?.verdict === "fail") missing.push("drift gate");
      if (missing.length) {
        console.error(`\n  REFUSED — ${t.id} has not passed the gate${docsOnly ? " (docs-only: reviewer required)" : ""}.\n`);
        console.error(`  Missing: ${missing.join(", ")}\n`);
        console.error(`  Record verdicts first:`);
        for (const m of missing) {
          if (m === "drift gate") console.error(`    node bin/drift.mjs check --task ${t.id}   (the drift gate is failing: ${drift.detail ?? "the drift gate failed"}; change the spec, reconcile, or dismiss with a reason)`);
          else console.error(`    node ops/caretaker/board.mjs ${m.split(" ")[0]} ${t.id} pass`);
        }
        console.error(`\n  This is enforced. Builder-says-done is a status report, not a completion.\n`);
        process.exit(1);
      }
      t.completed = today();
    }
    if (cmd !== "done") delete t.completed;
    t.status = cmd === "start" ? "doing" : cmd === "block" ? "blocked" : cmd;
    if (cmd === "block" && text) t.blockedReason = text;
    else delete t.blockedReason;
    if (cmd === "block" && text) t.note = t.note ? `${t.note} — BLOCKED: ${text}` : `BLOCKED: ${text}`;
  }
  // W-4 (an intentional change, mirrored here): who moved it, when, from where.
  let by = "unknown";
  try { by = CFG.operator ? String(CFG.operator) : os.userInfo().username; } catch { /* unknown */ }
  (t.transitions ||= []).push({ cmd, by, at: new Date().toISOString(), via: "cli" });
  d.meta.updated = today();
  save(d);
  const o = build();
  console.log(`${t.id} → ${t.status}${t.completed ? ` (${t.completed})` : ""}   ${o.currentName} now ${o.currentPct}% (${o.currentDone}/${o.currentTotal})`);
} else {
  console.log("usage: node ops/caretaker/board.mjs [status|build|start|done|block|todo|note] [T-012] [text]");
  console.log("       node ops/caretaker/board.mjs [reviewer|qa|security] T-012 [pass|fail] [note]");
}
