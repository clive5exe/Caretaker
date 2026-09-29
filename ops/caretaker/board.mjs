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
//   node ops/caretaker/board.mjs ask T-012 "question"          record a question
//   node ops/caretaker/board.mjs answer T-012 q1 "text"        answer it
//   node ops/caretaker/board.mjs triage T-012 accept|reject "why"
//   node ops/caretaker/board.mjs spec-approve T-012            approve the spec as it is now
//   node ops/caretaker/board.mjs spec-reject T-012 "why"
//   node ops/caretaker/board.mjs pr T-012 https://…            record the PR
//   node ops/caretaker/board.mjs drop T-012 "why"              drop it from scope
//
// Any mutating command rebuilds the page automatically, so the docs site is
// never stale relative to the data.
//
// IT IS ALSO A LIBRARY. The web server imports the target repo's own installed
// copy of this file, so the rules it applies are exactly the rules the CLI
// applies (specs/caretaker-web/TECH.md, C-1). That is why the exports live here
// and not in a second module: install.sh copies four files, and a new import
// would break every installed copy on upgrade.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";

/** Bumped when an export changes shape. The server refuses a board.mjs without it. */
export const API_VERSION = 1;

// Paths come from config.json beside this file, so board.mjs is identical in
// every project that installs it.
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the config at call time, not at import time, so importing this file
 * reads nothing. FACTORY_CONFIG and the config.json beside this file stay the
 * defaults, exactly as when the CLI resolved them at module load.
 */
export function loadConfig(cfgPath = process.env.FACTORY_CONFIG || path.join(HERE, "config.json"), base = HERE) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  // The repo root is two levels above `base`, which is THIS FILE's directory
  // for the CLI, as it always was: ops/caretaker/ sits two levels below the repo
  // it serves. A library caller holding a config path passes its directory,
  // which is the same place for an installed copy and the right one otherwise.
  const root = path.resolve(base, "..", "..", cfg.repo ?? ".");
  return {
    cfg,
    cfgPath: path.resolve(cfgPath),
    root,
    data: path.join(root, cfg.board),
    out: path.join(root, cfg.boardMarkdown ?? "docs/board.md"),
  };
}

export const load = (ctx) => JSON.parse(fs.readFileSync(ctx.data, "utf8"));
// Trailing newline is load-bearing, not cosmetic: without it every board write
// lands as "\ No newline at end of file" and the last line of the diff churns
// on top of the real change. d9e37df was a repair of this exact file after it
// was written by hand; the tool should not reintroduce a diff-noise defect.
//
// Written to a temp file and renamed over the original, so a reader never sees
// half a board: rename within one directory is atomic on POSIX filesystems.
export function save(ctx, d) {
  const tmp = `${ctx.data}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(d, null, 2)}\n`);
  fs.renameSync(tmp, ctx.data);
}
const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ lock */
// One writer at a time, for the whole read-modify-write. Without it, two CLI
// invocations that overlap both read the same board and the second write
// discards the first one's change. A server beside the CLI makes that likelier,
// so the lock lives here where both writers take it.
//
// O_EXCL ("wx") is the primitive: creating the file either succeeds for exactly
// one process or fails with EEXIST. The file holds the holder's pid and start
// time, so a lock left by a process that died is recognised and taken over
// rather than wedging the board forever.
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A lock's identity is its inode AND its content. The inode alone is not
// enough: a filesystem reuses a freed inode at once, so the lock the next
// writer creates can carry the number of the one just removed. The content
// holds a random nonce, so two locks never read the same.
const lockId = (lockPath) => {
  try {
    return { ino: fs.statSync(lockPath).ino, text: fs.readFileSync(lockPath, "utf8") };
  } catch {
    return null;
  }
};
const sameLock = (a, b) => !!a && !!b && a.ino === b.ino && a.text === b.text;

// The lock's identity if it is stale (its holder is dead, or it is older than
// any board command runs), else null. null too if it vanished meanwhile: that
// is a release, and the caller simply tries again.
function staleLockId(lockPath) {
  let st;
  try {
    st = fs.statSync(lockPath);
  } catch {
    return null;
  }
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    // Empty or half-written: the holder is between open and write. Only its
    // age can tell, so fall through to the mtime check.
  }
  if (info?.pid) {
    try {
      process.kill(info.pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") return lockId(lockPath); // the holder is gone
    }
  }
  return Date.now() - st.mtimeMs > LOCK_STALE_MS ? lockId(lockPath) : null;
}

// Remove a stale lock without removing a fresh one that replaced it. Renaming
// is atomic, so we hold whatever we renamed; if it is not the lock we judged
// stale, another writer took the lock in between and it goes straight back.
// linkSync never overwrites, so putting it back cannot clobber a third
// writer. What is NOT covered: that third writer acquiring in the instant the
// fresh lock is moved aside. That needs a crash and three writers at once.
function breakStaleLock(lockPath, id) {
  const aside = `${lockPath}.${process.pid}.stale`;
  try {
    fs.renameSync(lockPath, aside);
  } catch {
    return; // already gone
  }
  try {
    if (!sameLock(lockId(aside), id)) {
      try {
        fs.linkSync(aside, lockPath);
      } catch {
        /* see above */
      }
    }
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

export function withLock(ctx, fn) {
  const lockPath = `${ctx.data}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let mine;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      const text = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), nonce: randomBytes(8).toString("hex") });
      mine = { ino: fs.fstatSync(fd).ino, text };
      fs.writeSync(fd, text);
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const id = staleLockId(lockPath);
      if (id !== null) {
        breakStaleLock(lockPath, id);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`board is locked by another writer (${lockPath}); retry, or remove it if no board command is running`);
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    // Only OUR lock. A holder that outlived LOCK_STALE_MS may have had its lock
    // judged stale and taken by the next writer; removing that one would let a
    // third writer in beside it (independent review). Same move as breaking a
    // stale lock: take it aside, and put it back if it is not ours.
    breakStaleLock(lockPath, mine);
  }
}

/** Load, apply fn, save when fn reports ok. Returns fn's result. */
export function mutate(ctx, fn) {
  return withLock(ctx, () => {
    const d = load(ctx);
    const res = fn(d);
    if (res?.ok) save(ctx, d);
    return res;
  });
}

export const STATUS = {
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
export const live = (tasks) => tasks.filter((t) => t.status !== "dropped");

export const allTasks = (d) => d.phases.flatMap((p) => p.tasks.map((t) => ({ ...t, phase: p })));
export const find = (d, id) => {
  for (const p of d.phases) {
    const t = p.tasks.find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (t) return { t, p };
  }
  return null;
};

/* ------------------------------------------------------------- estimates */
// "4h" | "2d" | "1.5w" -> days
export function toDays(est) {
  if (!est) return 0;
  const m = String(est).match(/^([\d.]+)\s*([hdw])$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return m[2] === "h" ? n / 8 : m[2] === "w" ? n * 5 : n;
}

/* ---------------------------------------------------------------- render */
export function progress(all) {
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

/**
 * B-3: a task's spec, as a link relative to the page it is shown on. A value
 * that is not a plain path inside the repo (a URL, absolute, or climbing out
 * with ..) is shown as text, never as a link.
 */
const specHref = (spec, pageRel) => {
  const s = String(spec ?? "");
  // Plain path characters only, and the RESULT checked too: the relative path
  // strips leading directories, so "docs/javascript:x" came out as
  // "javascript:x" and passed a check made before it (independent review).
  if (!/^[\w.\/-]+$/.test(s) || s.startsWith("/") || s.split("/").includes("..")) return null;
  const href = path.posix.relative(path.posix.dirname(pageRel), s);
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") ? null : href;
};
const specMeta = (t, pageRel, cls) => {
  if (!t.spec) return "";
  const href = specHref(t.spec, pageRel);
  return `<span class="${cls}">spec ${href ? `<a href="${esc(href)}">${esc(t.spec)}</a>` : esc(t.spec)}</span>`;
};

function taskBlock(t, pageRel = "docs/board.md") {
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
    specMeta(t, pageRel, "tmi"),
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

export function build(ctx = loadConfig()) {
  const { cfg: CFG, root: ROOT, out: OUT } = ctx;
  const d = load(ctx);
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
      md += taskBlock(t, path.relative(ROOT, OUT).split(path.sep).join("/"));
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

/* ---------------------------------------------------------------- domain */
// The rules the CLI enforces, as functions that return a result instead of
// printing and exiting, so a second caller (the web server) applies exactly
// these rules rather than a copy of them.

export const GATE_CMDS = ["reviewer", "qa", "security"];
export const TRANSITIONS = ["done", "start", "block", "todo", "note"];

/**
 * Which required gates a task has not passed. The body of `done`'s check,
 * moved verbatim: the keyword test, the docs-only exemption and the order of
 * the missing list are all unchanged, and the CLI prints this list as before.
 *
 * Known and recorded, not fixed here (TECH.md, Findings): this is one of four
 * places that decide which gates apply, and the keyword lists are Encore's.
 */
export function missingGates(t) {
  // THE LOOP IS NOT OPTIONAL. A task is done when the gate passed, not when
  // the builder says so. Money/auth/tenant tasks additionally need security.
  const g = t.gate || {};
  // CLAUDE.md: money, auth and ISOLATION changes need security. The list was
  // the ticketing project's (stripe, refund, fee, tenant…), which had no word
  // for sandbox, egress or secrets, so this repo's isolation work could close
  // without a security verdict (independent review). Whole words only.
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
  return { missing, docsOnly };
}

const noTask = (id) => ({ ok: false, error: `no such task: ${id}` });

/**
 * start | block | todo | note | done, applied to a loaded board in place.
 * Returns { ok, task } or { ok:false, refused:{ missing, docsOnly } } when the
 * gate refuses `done`, or { ok:false, error } for a bad id. It never exits.
 */
/**
 * H-4: is the drift gate failing for this task? Its latest gate event in the
 * project's event log (refutations aside, which are qa verdicts) is read here,
 * where `done` can refuse on it, because a verdict nobody consults is a
 * comment: the drift gate failed, and `done` closed the task anyway
 * (independent review). Returns the failing event's detail, or null.
 */
export function driftGateFailing(ctx, id) {
  const dir = path.join(ctx.root, ctx.cfg.events ?? "ops/caretaker/events");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return null;
  }
  let last = null;
  for (const f of names) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e?.kind === "gate" && e.task === id && e.verdict && e.source === undefined && (!last || String(e.t) >= String(last.t))) last = e;
    }
  }
  return last?.verdict === "fail" ? last.detail ?? "the drift gate failed" : null;
}

export function transition(d, id, cmd, text = "", opts = {}) {
  if (!TRANSITIONS.includes(cmd)) return { ok: false, error: `unknown command: ${cmd}` };
  const hit = find(d, id);
  if (!hit) return noTask(id);
  const { t } = hit;

  if (cmd === "note") {
    t.note = t.note ? `${t.note} — ${text}` : text;
  } else {
    if (cmd === "done") {
      const { missing, docsOnly } = missingGates(t);
      if (opts.driftFailing) missing.push("drift gate");
      if (missing.length) return { ok: false, task: t, refused: { missing, docsOnly, ...(opts.driftFailing ? { drift: opts.driftFailing } : {}) } };
      t.completed = today();
    }
    if (cmd !== "done") delete t.completed;
    t.status = cmd === "start" ? "doing" : cmd === "block" ? "blocked" : cmd;
    if (cmd === "block" && text) t.blockedReason = text;
    else delete t.blockedReason;
    if (cmd === "block" && text) t.note = t.note ? `${t.note} — BLOCKED: ${text}` : `BLOCKED: ${text}`;
  }
  // W-4: who moved it, when, and from where (independent review: the web
  // claimed to record the operator and "via web", and nothing did). Appended,
  // like every other fact; a refused `done` records nothing.
  if (opts.by) (t.transitions ||= []).push({ cmd, ...stamp(opts) });
  d.meta.updated = today();
  return { ok: true, task: t };
}

/**
 * Record a reviewer | qa | security verdict. APPEND, NEVER OVERWRITE (P-2).
 * This used to replace the verdict, so a task that failed qa three times and
 * passed once recorded a single pass. Rework rate and first-pass rate — the
 * two quality metrics that actually predict anything — were therefore not
 * computable from the board at all.
 *
 * The shape stays BACKWARD COMPATIBLE. `gate.reviewer` is still an object with
 * `.verdict`, and it is still the LATEST one, so every existing reader keeps
 * working untouched. The history lives beside it in `gate.reviewer.history`,
 * oldest first, and is only read by the code that wants it.
 */
export function recordVerdict(d, id, gate, verdict, note) {
  if (!GATE_CMDS.includes(gate)) return { ok: false, error: `unknown gate: ${gate}` };
  const hit = find(d, id);
  if (!hit) return noTask(id);
  verdict = String(verdict || "").toLowerCase();
  if (!["pass", "fail"].includes(verdict)) return { ok: false, error: "verdict must be pass or fail" };
  hit.t.gate = hit.t.gate || {};
  const previous = hit.t.gate[gate];
  const entry = { verdict, at: today(), note: note || undefined };
  const history = previous
    ? [...(previous.history || []), { verdict: previous.verdict, at: previous.at, note: previous.note }]
    : [];
  hit.t.gate[gate] = { ...entry, ...(history.length ? { history } : {}) };
  d.meta.updated = today();
  return { ok: true, task: hit.t };
}

/* ------------------------------------------------------ new facts (C-6) */
// Questions, triage, spec review, PR links and drops, as append-only records on
// the task. Every field is optional and additive, so a board carrying them is
// still read correctly by an older board.mjs, which ignores them.
//
// Every record carries `by` and `at`. `at` is a full ISO instant: verdicts
// carry a date only, and two facts on the same day cannot be ordered by a date.

export const FACT_CMDS = ["ask", "answer", "triage", "spec-approve", "spec-reject", "pr", "drop"];

/** Who is acting: the config's `operator`, else the OS user. */
export function operator(cfg = {}) {
  if (cfg.operator) return String(cfg.operator);
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

const stamp = (opts = {}) => ({
  by: opts.by ?? "unknown",
  at: opts.at ?? new Date().toISOString(),
  ...(opts.via ? { via: opts.via } : {}),
});
const need = (v, what) => (String(v ?? "").trim() ? null : { ok: false, error: `${what} is required` });
const closed = (t) => (t.status === "done" || t.status === "dropped" ? { ok: false, error: `${t.id} is ${t.status}` } : null);

/** ask <id> "question": questions[] {id, q, by, at}. Ids are q1, q2, … per task. */
export function ask(d, id, q, opts) {
  const hit = find(d, id);
  if (!hit) return noTask(id);
  const bad = need(q, "a question") ?? closed(hit.t);
  if (bad) return bad;
  const t = hit.t;
  t.questions = t.questions || [];
  const qid = `q${t.questions.length + 1}`;
  t.questions.push({ id: qid, q: String(q), ...stamp(opts) });
  d.meta.updated = today();
  return { ok: true, task: t, qid };
}

/** answer <id> <qid> "text": answer {text, by, at} on that question, once. */
export function answer(d, id, qid, text, opts) {
  const hit = find(d, id);
  if (!hit) return noTask(id);
  const q = (hit.t.questions || []).find((x) => x.id === qid);
  if (!q) return { ok: false, error: `${hit.t.id} has no question ${qid}` };
  if (q.answer) return { ok: false, error: `${hit.t.id} ${qid} is already answered` };
  const bad = need(text, "an answer");
  if (bad) return bad;
  q.answer = { text: String(text), ...stamp(opts) };
  d.meta.updated = today();
  return { ok: true, task: hit.t };
}

/** triage <id> accept|reject "why": triage[] {decision, why, by, at}. */
export function triage(d, id, decision, why, opts) {
  const hit = find(d, id);
  if (!hit) return noTask(id);
  if (!["accept", "reject"].includes(decision)) return { ok: false, error: "triage decision must be accept or reject" };
  const bad = (decision === "reject" ? need(why, "a reason") : null) ?? closed(hit.t);
  if (bad) return bad;
  hit.t.triage = hit.t.triage || [];
  hit.t.triage.push({ decision, ...(why ? { why: String(why) } : {}), ...stamp(opts) });
  d.meta.updated = today();
  return { ok: true, task: hit.t };
}

/**
 * The task's spec file, whether it GOVERNS (contains a ```spec block), and the
 * git blob sha of its current content. Approval is keyed on that sha, so an
 * edit to the spec reopens it. A shared doc with no ```spec block is context,
 * not a governing spec, and never needs approval (TECH.md §Lifecycle).
 */
export function specInfo(root, t) {
  if (!t.spec) return null;
  const rel = String(t.spec);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root) + path.sep)) return { path: rel, exists: false, governing: false, blob: null };
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return { path: rel, exists: false, governing: false, blob: null };
  }
  let blob = null;
  try {
    blob = execFileSync("git", ["hash-object", "--", abs], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    blob = null; // not a git checkout, or no git: approval cannot be keyed
  }
  return { path: rel, exists: true, governing: /^```spec\s*$/m.test(text), blob };
}

/**
 * spec-approve <id> | spec-reject <id> "why": specReview[] {path, blob,
 * decision, why, by, at}. `spec` is specInfo() for the task, passed in so this
 * stays a pure function of the board; the CLI and the server both compute it.
 */
export function specReview(d, id, decision, why, spec, opts) {
  const hit = find(d, id);
  if (!hit) return noTask(id);
  if (!["approve", "reject"].includes(decision)) return { ok: false, error: "spec decision must be approve or reject" };
  if (!spec?.exists) return { ok: false, error: `${hit.t.id} has no spec file to review` };
  if (!spec.governing) return { ok: false, error: `${spec.path} has no \`\`\`spec block, so it governs nothing and needs no approval` };
  if (!spec.blob) return { ok: false, error: `cannot hash ${spec.path}; approval is keyed on its git blob` };
  const bad = (decision === "reject" ? need(why, "a reason") : null) ?? closed(hit.t);
  if (bad) return bad;
  hit.t.specReview = hit.t.specReview || [];
  hit.t.specReview.push({ path: spec.path, blob: spec.blob, decision, ...(why ? { why: String(why) } : {}), ...stamp(opts) });
  d.meta.updated = today();
  return { ok: true, task: hit.t };
}

/**
 * pr <id> <url>: pr {url, by, at}. A later pr becomes the current one, and the
 * one it replaced goes to pr.history with its by and at, as gate verdicts do:
 * an append-only fact is never overwritten (independent QA).
 */
export function recordPr(d, id, url, opts) {
  const hit = find(d, id);
  if (!hit) return noTask(id);
  if (!/^https?:\/\/\S+$/.test(String(url ?? ""))) return { ok: false, error: "pr needs an http(s) url" };
  const bad = closed(hit.t);
  if (bad) return bad;
  const prev = hit.t.pr;
  const history = prev ? [...(prev.history || []), { url: prev.url, by: prev.by, at: prev.at }] : [];
  hit.t.pr = { url: String(url), ...stamp(opts), ...(history.length ? { history } : {}) };
  d.meta.updated = today();
  return { ok: true, task: hit.t };
}

/**
 * drop <id> "why": status "dropped" plus dropped {why, by, at}. `dropped` was
 * already a status (see STATUS) but nothing set it. A task reopened and
 * dropped again keeps the earlier drop in dropped.history.
 */
export function drop(d, id, why, opts) {
  const hit = find(d, id);
  if (!hit) return noTask(id);
  const bad = need(why, "a reason") ?? closed(hit.t);
  if (bad) return bad;
  hit.t.status = "dropped";
  const prev = hit.t.dropped;
  const history = prev ? [...(prev.history || []), { why: prev.why, by: prev.by, at: prev.at }] : [];
  hit.t.dropped = { why: String(why), ...stamp(opts), ...(history.length ? { history } : {}) };
  delete hit.t.completed;
  delete hit.t.blockedReason;
  d.meta.updated = today();
  return { ok: true, task: hit.t };
}

/**
 * One entry point for every command a second caller may issue, so a server
 * routes to this and nothing else. Verdicts are not here on purpose: they come
 * from gate runs and the CLI, never from a browser (ADR-0001, TECH.md §2).
 */
export function command(d, id, cmd, args = {}, opts = {}) {
  switch (cmd) {
    case "start":
    case "todo":
    case "done":
      return transition(d, id, cmd, "", opts);
    case "block":
    case "note":
      return transition(d, id, cmd, String(args.text ?? ""), opts);
    case "ask":
      return ask(d, id, args.text, opts);
    case "answer":
      return answer(d, id, args.qid, args.text, opts);
    case "triage":
      return triage(d, id, args.decision, args.text, opts);
    case "spec-approve":
      return specReview(d, id, "approve", undefined, opts.spec, opts);
    case "spec-reject":
      return specReview(d, id, "reject", args.text, opts.spec, opts);
    case "pr":
      return recordPr(d, id, args.url, opts);
    case "drop":
      return drop(d, id, args.text, opts);
    default:
      return { ok: false, error: `unknown command: ${cmd}` };
  }
}

/* ------------------------------------------------------------------ cli */
function cli(argv) {
  const [cmd, id, ...rest] = argv;
  const text = rest.join(" ");

  if (!cmd || cmd === "status") {
    const ctx = loadConfig();
    const CFG = ctx.cfg;
    const d = load(ctx);
    const all = allTasks(d);
    const o = progress(all);
    // LEAD WITH THE CURRENT PHASE, matching the dashboard. The all-phases figure
    // sums every phase this board has ever had, including scope nobody is
    // building, so it reads far lower than the work actually in flight and moves
    // for reasons unrelated to today. The dashboard demoted it to a subline
    // already; this printed it as THE number, so `ops/caretaker/board.mjs status`,
    // the stop hook and the dashboard were quoting three different figures for
    // the same board.
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
  } else if (GATE_CMDS.includes(cmd)) {
    // record a gate verdict:  node ops/caretaker/board.mjs reviewer T-012 pass "notes"
    if (!id) { console.error("need a task id"); process.exit(1); }
    const ctx = loadConfig();
    const verdict = (rest[0] || "").toLowerCase();
    const res = mutate(ctx, (d) => {
      if (!find(d, id)) return noTask(id);
      if (!["pass", "fail"].includes(verdict)) return { ok: false, badVerdict: true };
      return recordVerdict(d, id, cmd, verdict, rest.slice(1).join(" "));
    });
    if (res.badVerdict) {
      console.error("verdict must be pass or fail:  node ops/caretaker/board.mjs " + cmd + " " + id + " pass");
      process.exit(1);
    }
    if (!res.ok) { console.error(res.error); process.exit(1); }
    build(ctx);
    const rec = res.task.gate[cmd];
    const attempts = (rec.history || []).length + 1;
    console.log(
      `${res.task.id} · ${cmd} → ${verdict}` +
        (attempts > 1 ? `   (attempt ${attempts}; previous: ${(rec.history || []).map((h) => h.verdict).join(", ")})` : ""),
    );
  } else if (TRANSITIONS.includes(cmd)) {
    if (!id) { console.error("need a task id, e.g. T-012"); process.exit(1); }
    const ctx = loadConfig();
    const opts = { by: operator(ctx.cfg), via: "cli", ...(cmd === "done" ? { driftFailing: driftGateFailing(ctx, id) } : {}) };
    const res = mutate(ctx, (d) => transition(d, id, cmd, text, opts));
    if (res.refused) {
      const { missing, docsOnly } = res.refused;
      const t = res.task;
      console.error(`\n  REFUSED — ${t.id} has not passed the gate${docsOnly ? " (docs-only: reviewer required)" : ""}.\n`);
      console.error(`  Missing: ${missing.join(", ")}\n`);
      console.error(`  Record verdicts first:`);
      for (const m of missing) {
        if (m === "drift gate") console.error(`    node bin/drift.mjs check --task ${t.id}   (the drift gate is failing: ${res.refused.drift}; change the spec, reconcile, or dismiss with a reason)`);
        else console.error(`    node ops/caretaker/board.mjs ${m.split(" ")[0]} ${t.id} pass`);
      }
      console.error(`\n  This is enforced. Builder-says-done is a status report, not a completion.\n`);
      process.exit(1);
    }
    if (!res.ok) { console.error(res.error); process.exit(1); }
    const t = res.task;
    const o = build(ctx);
    console.log(`${t.id} → ${t.status}${t.completed ? ` (${t.completed})` : ""}   ${o.currentName} now ${o.currentPct}% (${o.currentDone}/${o.currentTotal})`);
  } else if (FACT_CMDS.includes(cmd)) {
    if (!id) { console.error(`need a task id, e.g. ${cmd} T-012`); process.exit(1); }
    const ctx = loadConfig();
    const opts = { by: operator(ctx.cfg), via: "cli" };
    const args =
      cmd === "answer" ? { qid: rest[0], text: rest.slice(1).join(" ") }
      : cmd === "triage" ? { decision: rest[0], text: rest.slice(1).join(" ") }
      : cmd === "pr" ? { url: rest[0] }
      : { text };
    const res = mutate(ctx, (d) => {
      if (cmd.startsWith("spec-")) {
        const hit = find(d, id);
        if (hit) opts.spec = specInfo(ctx.root, hit.t);
      }
      return command(d, id, cmd, args, opts);
    });
    if (!res.ok) { console.error(res.error); process.exit(1); }
    const o = build(ctx);
    const what = cmd === "ask" ? `asked ${res.qid}` : cmd === "drop" ? "dropped" : `${cmd} recorded`;
    console.log(`${res.task.id} · ${what}   ${o.currentName} now ${o.currentPct}% (${o.currentDone}/${o.currentTotal})`);
  } else {
    console.log("usage: node ops/caretaker/board.mjs [status|build|start|done|block|todo|note] [T-012] [text]");
    console.log("       node ops/caretaker/board.mjs [reviewer|qa|security] T-012 [pass|fail] [note]");
    console.log("       node ops/caretaker/board.mjs ask T-012 \"question\" | answer T-012 q1 \"text\" | triage T-012 accept|reject [\"why\"]");
    console.log("       node ops/caretaker/board.mjs spec-approve T-012 | spec-reject T-012 \"why\" | pr T-012 <url> | drop T-012 \"why\"");
  }
}

// Run as a command only when executed, never when imported. realpath on both
// sides so a symlinked ops/caretaker/ still counts as "executed".
const isEntry = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntry) cli(process.argv.slice(2));
