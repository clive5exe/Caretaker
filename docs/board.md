---
title: Task board
summary: Every planned task with owner, estimate, dates and status. Generated from tasks.json — do not hand-edit.
status: current
audience: [founder, eng, design, ops]
owner: clive
updated: 2026-08-30
order: 2
---

<div class="board">
<div class="boardhead">
  <div class="bignum">0<span>%</span></div>
  <div class="boardmeta">
    <b>Layer 0 — The spec format &middot; 0 of 5 tasks closed through the full gate</b>
    <span>0 more are built and waiting only on reviewer / qa / security verdicts &middot; launch target <b>Invalid Date</b></span>
    <span>All phases ever, including pre-V1 scope: 1 of 26 (4%)</span>
  </div>
</div>
<div class="pbar big"><div class="pfill" style="width:0%"></div></div>
<div class="legend">
  <span class="chip ok">Done 1</span>
  <span class="chip warn">In progress 0</span>
  <span class="chip bad">Blocked 2</span>
  <span class="chip neutral">To do 23</span>
  
</div>
</div>

<div class="snap">
<div class="snapcol"><h3>Being worked on <span class="chip warn">0</span></h3><ul></ul></div>
<div class="snapcol"><h3>Blocked <span class="chip bad">2</span></h3><ul><li><code class="tid">U-1</code> <b>The walkthrough: folder, spec, environment, harness, repo, loop</b> <span class="tmi">frontend</span></li><li><code class="tid">U-2</code> <b>Watch a run and steer it mid-flight</b> <span class="tmi">frontend</span></li></ul></div>
<div class="snapcol"><h3>Done <span class="chip ok">1</span></h3><ul><li><code class="tid">B-1</code> <b>Tasks, gates, dashboard, run log, unattended loop</b> <span class="tmi">you</span></li></ul></div>
</div>

## Layer 0 — The spec format

<div class="phasebar"><div class="phasemeta"><b>Invalid Date &rarr; Invalid Date</b> &middot; 0/5 done &middot; 4d remaining</div><div class="pbar "><div class="pfill" style="width:0%"></div></div></div>

undefined

<div class="task todo"><div class="taskhead"><code class="tid">P-1</code><span class="ttitle">A spec schema the environment can be derived from</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>architect</b></span><span class="tmi">1d</span></div><div class="acc"><b>Accept:</b> a spec carries a structured block declaring runtime, services and external hosts, with prose below it, and a parser turns that block into an image spec and an egress allowlist without a human editing either</div><div class="tnote"><b>Latest:</b> FIRST, because everything downstream reads it. Free-text specs make environment derivation impossible, and the egress allowlist is the control that makes the sandbox real. This is also what turns allowlisting from a chore nobody maintains into a byproduct of writing the spec you were writing anyway.</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">P-2</code><span class="ttitle">Appended gate verdicts, before there is data to lose</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>backend</b></span><span class="tmi">2h</span> <span class="chip ok" title="first attempt">qa pass</span></div><div class="acc"><b>Accept:</b> a gate records every verdict rather than the latest, and rework rate and first-pass rate are computable from the board</div><div class="tnote"><b>Latest:</b> CHEAP NOW, IMPOSSIBLE RETROACTIVELY. The board keeps one verdict per gate, so a task that failed qa three times and passed once reads as a pass. Two of the KPIs that matter most are therefore unmeasurable, and the dashboard already prints a warning saying so.</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">P-3</code><span class="ttitle">A spec declares which paths it governs</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>architect</b></span><span class="tmi">4h</span><span class="tmi">after P-1</span></div><div class="acc"><b>Accept:</b> the spec's structured block names the paths it is the authority for, and a tool can answer 'which spec governs this file' for any path in the repo</div><div class="tnote"><b>Latest:</b> Same block the environment derives from, one more field. This is what makes drift detectable mechanically rather than by someone remembering.</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">P-4</code><span class="ttitle">Three tiers: decision, spec, log — separated, not one docs pile</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>architect</b></span><span class="tmi">1d</span><span class="tmi">after P-1</span></div><div class="acc"><b>Accept:</b> decisions are immutable and superseded rather than edited, specs carry current state only, and the log is append-only; a tool can answer 'why is this like this' from the decisions without reading the log</div><div class="tnote"><b>Latest:</b> They rot at completely different speeds and want opposite treatment. A spec that accumulates a changelog becomes unreadable, unreadable specs are not consulted, and unconsulted specs drift. An ADR that gets edited stops being a record of what was decided.</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">P-5</code><span class="ttitle">Staleness is computed, never declared</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>backend</b></span><span class="tmi">1d</span><span class="tmi">after P-3</span></div><div class="acc"><b>Accept:</b> a check reports stale (the doc's updated: is older than the last commit touching the paths it GOVERNS), orphaned (governs paths that no longer exist) and unowned (code no spec claims), with no manual freshness flag anywhere</div><div class="tnote"><b>Latest:</b> A manual 'is this current?' flag stops being updated the first time someone is in a hurry, and then there is no way to tell a current doc from an abandoned one. Comparing against the governed paths rather than the doc's own last commit is the stronger check: a doc can be true and untouched while the code under it moves.</div></div>

## Layer 1 — Environment

<div class="phasebar"><div class="phasemeta"><b>Invalid Date &rarr; Invalid Date</b> &middot; 0/4 done &middot; 6d remaining</div><div class="pbar "><div class="pfill" style="width:0%"></div></div></div>

undefined

<div class="task todo"><div class="taskhead"><code class="tid">E-1</code><span class="ttitle">Container runner: podman, resource limits, repo bind-mount</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>backend</b></span><span class="tmi">1d</span><span class="tmi">after P-1</span></div><div class="acc"><b>Accept:</b> an agent runs inside a container with --memory, --cpus and --pids-limit enforced, a read-only root, the repo bind-mounted, and NO container socket; a test proves each limit actually binds rather than being passed and ignored</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">E-2</code><span class="ttitle">Egress allowlist proxy, generated from the spec</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>security</b></span><span class="tmi">2d</span><span class="tmi">after E-1, P-1</span></div><div class="acc"><b>Accept:</b> the container has no route to the internet and reaches only the hosts the spec declared, through a proxy; a test proves an undeclared host is refused and logged, and proves the repo cannot be POSTed anywhere</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">E-3</code><span class="ttitle">Prove the sandbox by attacking it</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>security</b></span><span class="tmi">1d</span><span class="tmi">after E-2</span></div><div class="acc"><b>Accept:</b> written attempts to (a) write outside the repo mount, (b) exhaust host memory, (c) reach an undeclared host and (d) reach the container socket each fail, with the command and its output recorded</div><div class="tnote"><b>Latest:</b> A sandbox nobody has tried to break is a claim, not a control. This task never gets dropped as obviously fine.</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">E-4</code><span class="ttitle">Target a box you own, not only a PaaS</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>devops</b></span><span class="tmi">2d</span><span class="tmi">after E-2</span></div><div class="acc"><b>Accept:</b> the environment layer can produce a deployable for a plain Linux host with its own Postgres and a Prometheus scrape config, not only a managed platform</div><div class="tnote"><b>Latest:</b> Follows from the thesis rather than being bolted on. Every agent tool on the market assumes a PaaS. The migration failure that started this - ten migrations missing from a live database with no ledger anywhere, while the test suite stayed green because it replayed onto a throwaway cluster - happened because managed convenience meant nobody owned the migration path.</div></div>

## Layer 2 — Harness

<div class="phasebar"><div class="phasemeta"><b>Invalid Date &rarr; Invalid Date</b> &middot; 0/7 done &middot; 9d remaining</div><div class="pbar "><div class="pfill" style="width:0%"></div></div></div>

undefined

<div class="task todo"><div class="taskhead"><code class="tid">H-1</code><span class="ttitle">Define the run seam and implement one vendor</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>backend</b></span><span class="tmi">2d</span><span class="tmi">after E-1</span></div><div class="acc"><b>Accept:</b> run(workspace, prompt, policy) returns diff, transcript, verdict and cost for one vendor, and nothing above this layer imports that vendor's SDK</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">H-2</code><span class="ttitle">Second vendor, to prove the seam is a seam</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>backend</b></span><span class="tmi">1d</span><span class="tmi">after H-1</span></div><div class="acc"><b>Accept:</b> a second agent CLI runs behind the same interface with no change above it; if the interface had to change, that change is recorded as what the first vendor had baked in</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">H-3</code><span class="ttitle">Adversarial verify as a first-class step</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>architect</b></span><span class="tmi">1d</span><span class="tmi">after H-1</span></div><div class="acc"><b>Accept:</b> a run can be declared as an attempt to REFUTE another run's result, and its verdict can fail the task rather than merely commenting on it</div><div class="tnote"><b>Latest:</b> The technique behind grill-me, without the branding. Every defect worth finding in the project this came from was found by one agent refusing to take another's word: a security review that failed a rate-limit fix and found an OTP brute-force bypass, a qa run that found the paid checkout path returning 500 on every order. Neither came from an agent doing work.</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">H-4</code><span class="ttitle">Drift gate: a governed path changed and its spec did not</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>backend</b></span><span class="tmi">1d</span><span class="tmi">after P-3, H-1</span></div><div class="acc"><b>Accept:</b> after a run, the diff's touched paths are compared against the ownership map, and a task cannot close while a governed path has changed without its governing spec being touched or the drift being explicitly dismissed with a recorded reason</div><div class="tnote"><b>Latest:</b> DETECTION IS A GATE, NOT A HARNESS FEATURE, and the distinction is the whole design. The harness already returns a diff, which is exactly the evidence needed; no model is required to notice that pricing.ts changed and pricing.md did not. Putting it in the harness would mean the spec silently follows the code, and a spec that always agrees with the code cannot ever say the code is wrong.</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">H-5</code><span class="ttitle">Reconciliation run: propose the spec change, do not make it</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>backend</b></span><span class="tmi">1d</span><span class="tmi">after H-4</span></div><div class="acc"><b>Accept:</b> a reconciliation run receives the diff and the governing spec and returns a PROPOSED spec diff plus a stated direction, which a human accepts or rejects; nothing is committed to a spec without that acceptance</div><div class="tnote"><b>Latest:</b> THE DIRECTION IS THE POINT AND MUST BE RECORDED. 'We learned something, the spec should change' and 'the code drifted from what we decided' are opposite events with opposite fixes, and the tool must not guess which. Forcing the answer is where the value is; auto-applying either one destroys it.</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">H-6</code><span class="ttitle">Harvest decisions the transcript holds and no document does</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>architect</b></span><span class="tmi">2d</span><span class="tmi">after H-5</span></div><div class="acc"><b>Accept:</b> after a run, decisions made in the transcript that appear in no spec or ADR are surfaced for a human to keep or discard</div><div class="tnote"><b>Latest:</b> Prompt-driven development means the PROMPT is the real spec, transiently. Intent gets settled in a conversation and lands nowhere. This is the graduate idea applied continuously instead of only at handoff.</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">H-7</code><span class="ttitle">Drift direction is a project default, overridable per task</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>architect</b></span><span class="tmi">1d</span><span class="tmi">after H-4, H-5</span></div><div class="acc"><b>Accept:</b> a project declares whether the spec or the code is the authority, the drift gate blocks or harvests accordingly, and a single task can override it</div><div class="tnote"><b>Latest:</b> The three ways people actually work want the SAME machinery pointed in different directions. Spec-first: drift means the code is wrong, block. Build-as-you-go: drift means the spec is behind, harvest and propose. Handoff: reconcile before anyone inherits it. Two of those are one code path with the arrow reversed, which is the reason not to build three products.</div></div>

## Layer 3 — Skills

<div class="phasebar"><div class="phasemeta"><b>Invalid Date &rarr; Invalid Date</b> &middot; 0/2 done &middot; 6d remaining</div><div class="pbar "><div class="pfill" style="width:0%"></div></div></div>

undefined

<div class="task todo"><div class="taskhead"><code class="tid">S-1</code><span class="ttitle">Consume the existing skills standard</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>backend</b></span><span class="tmi">4h</span><span class="tmi">after H-1</span></div><div class="acc"><b>Accept:</b> a project can point at any repo following skills/&lt;category&gt;/&lt;name&gt;/SKILL.md and have those skills available to a run; no second format is invented</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">S-2</code><span class="ttitle">Derive skills from the project rather than installing them</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>architect</b></span><span class="tmi">1w</span><span class="tmi">after S-1, P-2</span></div><div class="acc"><b>Accept:</b> after a run of closed tasks, the tool can emit a skill describing how THIS repo does a recurring thing, citing the incident that made the rule, and a human can accept or reject it</div><div class="tnote"><b>Latest:</b> The version of 'your own skills' that is not just rewriting someone else's in your voice. A generic migration skill is worth less than one that says how migrations work HERE and what went wrong the day the rule was written. It cannot be sold to you; it can only be grown.</div></div>

## Layer 4 — Board and tracking

<div class="phasebar"><div class="phasemeta"><b>Invalid Date &rarr; Invalid Date</b> &middot; 1/5 done &middot; 5d remaining</div><div class="pbar "><div class="pfill" style="width:20%"></div></div></div>

undefined

<div class="task todo"><div class="taskhead"><code class="tid">B-2</code><span class="ttitle">Estimate in tokens, not hours</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>backend</b></span><span class="tmi">1d</span><span class="tmi">after P-2</span></div><div class="acc"><b>Accept:</b> a task's estimate is in tokens, actuals come from the run log automatically, and a calibration factor per task type re-estimates the open work with no human input</div><div class="tnote"><b>Latest:</b> Hours are what humans spend and require a human to report, so the calibration loop never closes. Tokens are measured exactly at the end of every run. Hours stay as a secondary display for people who think in days.</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">B-3</code><span class="ttitle">A task points at its spec, and a stale doc is visible</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>backend</b></span><span class="tmi">4h</span><span class="tmi">after P-1</span></div><div class="acc"><b>Accept:</b> a task carries a spec path rendered as a link on its card, and a check compares each doc's claimed updated: date against the last commit that touched it and names the ones that lie</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">B-4</code><span class="ttitle">KPIs: delivery and AI, and the anti-KPIs left out on purpose</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>backend</b></span><span class="tmi">2d</span><span class="tmi">after B-2, P-2</span></div><div class="acc"><b>Accept:</b> the dashboard reports deploy frequency, lead time, change failure rate and time to restore from git and the board; and tokens per closed task, cost per merged diff line, first-pass gate rate, rework rate, model mix, estimate calibration and human intervention rate from the run log</div><div class="tnote"><b>Latest:</b> Lines of code, agents spawned and tasks-per-day without effort weighting are deliberately absent. Each rewards exactly the wrong behaviour.</div></div>
<div class="task todo"><div class="taskhead"><code class="tid">B-5</code><span class="ttitle">Externalise before compaction, continuously</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>backend</b></span><span class="tmi">1d</span><span class="tmi">after H-6</span></div><div class="acc"><b>Accept:</b> reasoning is written to the artifact it explains as a run proceeds rather than at the end, so a compacted or killed session loses nothing that was already decided</div><div class="tnote"><b>Latest:</b> Compaction is lossy and unavoidable, so the principle is externalise early rather than avoid compacting. Measured in the project this came from: everything that survived was written where it attaches to the artifact - commit message, board note, decision record. Everything that lived only in the conversation is gone, including reasoning that took hours to reach.</div></div>
<div class="task done"><div class="taskhead"><code class="tid">B-1</code><span class="ttitle">Tasks, gates, dashboard, run log, unattended loop</span><span class="chip ok">Done</span></div><div class="taskmeta"><span class="tmi"><b>you</b></span><span class="tmi">1d</span><span class="tmi">closed 2026-08-30</span> <span class="chip ok" title="first attempt">reviewer pass</span> <span class="chip ok" title="first attempt">qa pass</span></div><div class="acc"><b>Accept:</b> done is refused until the gate verdicts exist, and the dashboard reports effort, ETA and cost</div></div>

## Layer 5 — TUI

<div class="phasebar"><div class="phasemeta"><b>Invalid Date &rarr; Invalid Date</b> &middot; 0/2 done &middot; 8d remaining</div><div class="pbar "><div class="pfill" style="width:0%"></div></div></div>

undefined

<div class="task blocked"><div class="taskhead"><code class="tid">U-1</code><span class="ttitle">The walkthrough: folder, spec, environment, harness, repo, loop</span><span class="chip bad">Blocked</span></div><div class="taskmeta"><span class="tmi"><b>frontend</b></span><span class="tmi">1w</span><span class="tmi">after H-1, P-1</span></div><div class="acc"><b>Accept:</b> starting in an empty or existing folder, a person is walked through writing the spec, standing up the environment derived from it, choosing a harness, and starting the loop, without editing a config file by hand</div></div>
<div class="task blocked"><div class="taskhead"><code class="tid">U-2</code><span class="ttitle">Watch a run and steer it mid-flight</span><span class="chip bad">Blocked</span></div><div class="taskmeta"><span class="tmi"><b>frontend</b></span><span class="tmi">3d</span><span class="tmi">after U-1</span></div><div class="acc"><b>Accept:</b> a running agent's output streams to the terminal and a person can interrupt or redirect it without killing the run</div><div class="tnote"><b>Latest:</b> TUI rather than a web UI on purpose: no daemon, no auth, no port, and it works over SSH. The static HTML dashboard is not a competitor to this, it is the artifact you send to someone who is not in a terminal.</div></div>

## Layer 6 — Graduate

<div class="phasebar"><div class="phasemeta"><b>Invalid Date &rarr; Invalid Date</b> &middot; 0/1 done &middot; 3d remaining</div><div class="pbar "><div class="pfill" style="width:0%"></div></div></div>

undefined

<div class="task todo"><div class="taskhead"><code class="tid">G-1</code><span class="ttitle">Generate CI and docs from what actually happened</span><span class="chip neutral">To do</span></div><div class="taskmeta"><span class="tmi"><b>devops</b></span><span class="tmi">3d</span><span class="tmi">after B-3, E-4</span></div><div class="acc"><b>Accept:</b> a graduate command emits a workflow file built from the commands the gates really ran, a docs site from the specs really written, and a decision index from the ADRs really recorded; nothing in the output is a template placeholder</div><div class="tnote"><b>Latest:</b> Every scaffolder emits CI at init, when it knows nothing about the project. During a build CI is friction; at handoff its absence is what makes a project unmaintainable.</div></div>

## Load by agent

| Agent | Tasks | Remaining |
|---|---|---|
| `backend` | 12 | 13d |
| `architect` | 7 | 12d |
| `security` | 2 | 3d |
| `devops` | 2 | 5d |
| `frontend` | 2 | 8d |
| `you` | 1 | 0d |

## Maintaining this

Generated from `the board named in ops/foreman/config.json`. **Never edit the generated page.**

```
node ops/foreman/board.mjs done T-012        mark complete, stamps today's date
node ops/foreman/board.mjs start T-012       mark in progress
node ops/foreman/board.mjs block T-012 "why" mark blocked with a reason
node ops/foreman/board.mjs note T-012 "text" append a note
node ops/foreman/board.mjs                   print the board to the terminal
```

Every mutating command rebuilds this page and the whole docs site, so it can never drift from the data.
