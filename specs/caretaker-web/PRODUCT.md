---
title: Caretaker Web v1 — product
status: accepted
updated: 2026-09-29
---

```spec
hosts:
governs: web/src/pages/**
```

# Caretaker Web v1 — product

An optional, local, real-time web view of a Caretaker project: what is being
worked on, what is stuck, what ran, what it cost, and what needs a human.

It is a **client of the core, never a peer**. The board, the gates, the run log,
the event log and the drift gate stay authoritative. The web app shows what
they record, and when you act, it calls the same core functions the CLI calls.
If the web app and the CLI ever disagree, the web app is the one that is wrong.

`docs/board.html` stays. It is the zero-dependency, offline report you send to
someone who is not at the machine. The web app is for the person who is.

The architecture is in `TECH.md` beside this file, and the decision to have a
web client at all is in `docs/decisions/0002-an-optional-web-client.md`.

## Who it is for

- **The operator**: one person on their own machine, running agents against a
  repo, who wants to watch runs and answer the things only a human can answer
  without tailing four files.
- **Not** a team server, a hosted service, or a multi-tenant dashboard. v1
  binds to loopback only (see TECH.md §1).

## Concepts

| concept | what it is | where it is recorded |
|---|---|---|
| **Work item** | a board task, with identity from intake to done | `board.json` |
| **Run** | one agent execution | `runs.jsonl` plus the run archive (TECH.md C-4) |
| **Lifecycle stage** | where a work item is, *computed* from what has been recorded | nowhere; it is derived on every read |
| **Gate verdict** | reviewer / qa / security pass or fail, appended rather than overwritten | `board.json` `gate.<k>` and `.history` |
| **Inbox item** | a decision only a human can make, derived from recorded facts | nowhere; it is derived on every read |
| **Spec** | a document with a ```` ```spec ```` block that declares the paths it governs | `specs/**` |

### Runs are separate from work items

- A run is its own entity, keyed by its run id (`r_` plus eight hex digits,
  from the harness).
- A work item has zero or more runs. A run can also span tasks, because
  `docs/events.md` makes the task a *field* and never a folder.
- A run can have a **parent**. This is an adversarial-verify run (H-3)
  examining another run's result, or a reconciliation run (H-5) proposing a
  spec change from another run's diff. The parent/child link is recorded on
  the child.

## The lifecycle

```
intake → triage → spec → build → verify → review → human → done
```

**The stage is derived, never declared.** This follows `docs/memory.md`
("status should be derived, not declared") and B-7 (the board as a projection
of the log). There is no `stage` field for anyone to forget to update. Every
stage comes with a **reason**, which names the recorded fact that put the item
there. A stage without evidence would be a status report, which is exactly
what the gates exist to refuse.

| stage | means | typical evidence |
|---|---|---|
| intake | captured, not yet looked at | no triage record and no acceptance criterion |
| triage | being assessed; the finish line, owner or estimate is missing, or triage was not accepted | a triage record, or missing `ac`/`owner`/`est` |
| spec | a governing spec must be approved before building | the task's spec has no approval for its current content |
| build | work in progress, or rework after a failed gate | `doing`, an open run, or the latest verdict on a required gate is `fail` |
| verify | a run produced a measured diff, and no verdicts yet | a finished run with files changed |
| review | some required verdicts passed, others outstanding | partial gate record, none failing |
| human | every required gate has passed; a human closes it and merges | the missing-gates set is empty |
| done | closed through the gate | only reachable through core `done`, which refuses unless the gates passed |

- **Stages are skippable.** A task with no governing spec never enters
  `spec`. A task someone already specified in full skips triage. This follows
  Warp's framing of stages as "responsibilities, not a fixed pipeline".
- **Blocked is a badge, not a stage.** A blocked task shows its reason at
  whatever stage it is in.
- **Dropped is outside the lifecycle.** It is excluded from columns, the
  Inbox and progress, as it already is from progress in `board.mjs`.
- **Verify comes before review.** Verify is *evidence*: qa, the drift gate,
  adversarial verification. Review is *judgement*: reviewer and security.

The exact rules are in TECH.md §Lifecycle, and they live in one core module.
The browser never computes a stage.

## The Inbox

Only what requires a human. The Inbox is **derived** from recorded facts, so
an item disappears by construction the moment the fact that created it is
answered. Nobody has to "clear" it.

1. **Unanswered questions.** An agent or person asked a question on a work
   item (`ask`), and there is no answer yet. Action: answer.
2. **Spec approvals.** The work item's governing spec has changed since it was
   last approved, or it was never approved. Actions: approve, or reject.
   Approval is tied to the spec's content, so editing the spec reopens it.
3. **Gate failures requiring review.** Not every failure qualifies. A single
   qa fail sends the item back to build, which is what agents are for. An item
   enters the Inbox when:
   - a security verdict failed,
   - the drift gate failed for the task and nothing has passed since, or
   - the same gate has failed repeatedly (a configurable threshold, default 2).

   Action: read the failure and decide. A drift failure shows the exact
   `drift.mjs` dismissal command rather than a button (TECH.md explains why).
4. **PRs ready for human review.** Every required gate passed and a PR is
   recorded. Action: review and merge outside Caretaker, then close with `done`.
5. **Decisions no document records.** A run declared a decision
   (`DECISION: … because …`) that no spec or ADR already says. Action: keep
   it, which writes it as a draft ADR citing the run, or discard it with a
   reason. Like a drift dismissal, both are shown as the exact
   `harvest.mjs` command rather than a button.

**The Inbox is not verification.** ADR-0001 rejects "human approval gates as
the verification story", because a person approving their fortieth diff of the
day is a rubber stamp. The gates remain the verification. The Inbox holds the
decisions the machinery cannot make: what we meant (spec approval), what we
don't know (questions), when to stop fighting (repeated failure), and whether
to ship (merge). A growing Inbox is itself the signal that something upstream
is wrong.

## Pages

Every page follows three rules:

- **Unknown is not zero.** If a source file does not exist or a field was not
  recorded, the page says *not recorded*, and names what would record it. It
  never shows 0, an empty chart, or a pulse over a snapshot. `harness.mjs`
  already treats null cost as "unknown, not zero", and the web app keeps that
  distinction all the way to the screen.
- **Actions are offered by the server.** Every button comes from the list of
  commands core says it would accept right now. Clicking one calls core, which
  checks again. A refusal is shown in core's own words.
- **Numbers come from the same functions as `docs/board.html`.** The two
  surfaces cannot headline different figures.

### Layout

The layout is Warp Factories' web app, taken from the screenshots in Warp's
docs. TECH.md §4 has the colors, font and logo.

- **Sidebar, left.**
  - At the top: the CARETAKER wordmark, search, and a collapse button.
  - Next, the two lists you check most: **Inbox**, with an unread count, and
    **Runs**.
  - Under **Project**: Dashboard, Activity, Agents, Specs & drift, Metrics and
    Settings.
  - Factories lists Runs twice, once across factories and once per factory.
    One server shows one project, so Runs is listed once.
  - Under **Also in your terminal**: a page showing the same screens in the
    TUI and how to open it.
  - At the bottom: **Getting started**.
- **Top bar.**
  - Breadcrumbs.
  - Search and filter buttons.
  - One black primary button. It reads **Go to**, or **Actions** on a work
    item, and opens the command menu.
- **Pages.**
  - Bordered cards.
  - Lists of rows with a colored icon tile, a title, one line of
    description, and chips on the right.
  - Line charts with the value in large type above them, as on the Factories
    dashboard.

### The command menu

The menu opens from the primary button or Ctrl-K, and it searches as you type.
It lists:

- the pages
- work items and runs, by id and title
- on a work item, the commands core offers for it right now, from
  `lifecycle.commandsFor`

Commands core does not offer are not listed, and the menu adds no command of
its own. Choosing a command does exactly what the same button on the page does.

### 1. Dashboard
The first thing you see.
- Current-phase progress, **by effort and by task count**, with the gap
  between them kept visible, exactly as `board.html` shows it.
- ETA, or "no rate" when nothing closed in the window.
- Held at a gate, blocked, and no finish line.
- **Executing now**: runs with a start and no end, live over SSE. A run past
  the staleness threshold shows as *no end recorded*, not as still running.
- Inbox count, linking to the Inbox, with its four oldest items listed.
- A live feed of recent events, filterable by level.
- Three headline cards, the same figures as `board.html`:
  - first-pass rate. Its trend line needs `history.jsonl` to record the rate.
    Today the daily row has progress, ETA, done, held and blocked, and adding
    the rate is one more field in the same row.
  - median cycle time against the median estimate
  - tokens per closed task
- **Closed vs started**, per day. *Not in v1.* Closed dates come from git, but
  nothing records when a task started. This needs a start fact in core
  (`board.mjs start` appending one), and until then the card says *not
  recorded*.

### 2. Activity (the work board)
Factories calls this page Activity, and so does the sidebar.
- Columns by **lifecycle stage**, with a toggle to the **status** columns that
  `board.html` uses (Working / Queued / Blocked / Done from `config.columns`).
- A card shows id, title, owner, estimate, the gate rail (one segment per
  gate: filled on pass, red on fail, hollow if not run), missing gates, a
  blocked badge, run count and tokens when a run log exists, and the task's
  spec path when it has one (as `board.md` and `board.html` cards do, as a link).
- **Work item detail** shows: the stage and its reason; acceptance criterion;
  the notes, newest first; the **full gate history with attempt counts**; the
  runs (linking to run detail); questions and answers; the spec link and its
  approval state; the PR link. A governing spec links to the Specs page at
  `/specs?path=<spec>`, which marks that row; a context doc stays text.
- Actions (only those the server offers): start, block (with reason), reset
  to todo, note, close (`done`), ask, answer, triage accept/reject, spec
  approve/reject, record PR, drop (with reason).
- **Not offered in the browser:** recording reviewer, qa or security verdicts.
  Those come from gate runs and the CLI. A one-click "pass" in a browser is
  exactly the rubber stamp ADR-0001 rejects.

### 3. Inbox
The five kinds above, oldest first, each with its one action and a link to the
work item (and, for a decision, to the run that made it). When empty, it says
so plainly.
- **A list with a detail pane,** as in Factories. Each row has its kind's icon
  tile: questions blue, spec reviews orange, gate failures red, PRs green,
  decisions violet.
  Selecting a row opens the pane, which shows the item's evidence, the exact
  fact that put it there, and its one action.
- **Filter tabs by kind,** each with its count.
- **Read and unread are kept in the browser only,** in `localStorage`. Marking
  an item read changes nothing in core and nothing for anyone else. It only
  dims the row.
- **No Resolve button.** Factories has one. Here an item leaves the Inbox when
  the fact behind it changes, so a Resolve button would be a second, separate
  way to clear it.

### 4. Runs
- A list of runs: id, work item, agent, model, harness, status, started,
  duration, tokens.
- Filters: status, work item, agent, model.
- Status comes from the harness verdict (`completed`, `failed`, `killed`,
  `unavailable`) when archived, otherwise from the start/end rows. A start with
  no end shows as **no end recorded**. `run.mjs` keeps start and end as two
  facts precisely so a crash stays visible, and the UI must not paper over it.
- Rows logged before runs carried an id are grouped as **legacy,
  unidentified**, not guessed into runs.
- Reconstructed rows (`src: reconstructed`) are labelled, never blended in.

### 5. Run detail
Everything Caretaker measured about one run. Each section shows its source, and
*not recorded* when that source is absent.

| section | shows |
|---|---|
| identity | run id, parent run, child runs |
| work item | linked task(s) |
| agent | agent name, model, harness adapter and CLI |
| status | verdict state and reason, exit code, whether it was killed and why, warnings the harness raised (for example, running with no sandbox or no enforced limit) |
| timestamps | start, end, duration, timeout ceiling |
| tokens | in, cached, write, out, turns, total; null fields shown as unknown |
| measured diff | files changed, insertions and deletions, the patch; truncation and the fact that gitignored paths are not measured are stated on the page |
| transcript | the redacted transcript and stderr as **raw text**, live-tailing while the run is in flight |
| gate results | drift gate events recorded against this run; the work item's gate verdicts, shown as *task-level with their dates*, never attributed to this run unless the record says so |
| egress | each connection the run's proxy decided: `allowed`, `refused` (with its reason) or `error` (with why), as `bin/egress.mjs` writes them. With no log, the reason, from the run's archived record: sandbox none (the host's network, uncontrolled), a proxy that saw no connection, no network at all, another network (not recorded), or no record. For the API adapter, also that its model calls left from this machine, and to which host |
| artifacts | patch, transcript, stderr, drift report, PR link |

What is available today and what waits on prerequisite core work is spelled
out in TECH.md §Run detail. Until then, those sections say *not recorded*.

### 6. Agents
- Roles from the project's agent definitions (`config.agentsDir`): name,
  model, and harness where known.
- Per agent: runs, tokens, first-pass gate rate, and what it is running now.
- When no agent definitions exist, as in this repo, the page says so and
  points at `agentsDir`.

### 7. Specs and drift
- Every spec, what it governs, and parse errors if any.
- The ownership map: path to spec. It shows **unowned** changed paths and
  **orphaned** globs that match nothing, as `drift.mjs` reports them.
- The latest drift verdicts from the event log, with dismissals, their reason
  and who made them.
- Spec approval state per work item.
- **Whether each document can be trusted**, computed from git on every load:
  a spec older than the code it governs is *stale*, a doc edited after the
  `updated:` date it claims has a *date that lies*, and a doc with no date is
  *undated*. There is no freshness flag to set (P-5, B-3).
- Read-only for drift. Dismissal stays with `drift.mjs check --dismiss`, and
  the page shows the exact command.

### 8. Metrics
Everything Caretaker measures. Each figure is labelled with where it comes
from. A range picker (7, 14 or 30 days) applies to figures built from dated
rows: run log rows and gate verdicts. A figure with no dates behind it says
*all time*.

- **From `dashboard.mjs` today** (exported in C-2):
  - tokens by kind, as cached, in, write and out per day
  - context churn: the share of context the cache could not match
  - rework spend: a failed task's tokens up to its last failed gate verdict
    (the attempts sent back, not the run that passed)
  - pass rate per gate, counting every attempt from the verdict history, in
    the range and all time. Core computes pass% and fail% (fail is 100 minus
    pass), so the page, board.html and the terminal show the same figures
  - first-pass rate
  - estimate against elapsed time for closed tasks
  - tokens by agent and by model
- **From `kpis.mjs`** (B-2, B-4), each "not recorded" with its reason when
  its inputs were not:
  - delivery from git: deploys per week (a deploy is a merge on main), lead
    time, change failure rate (merges reverted after landing), time to restore
  - tokens per closed task, tokens per merged diff line, and dollars per merged
    line only when the config prices every model in the run log
  - first-pass and rework rates, model mix, estimate calibration, and the
    human intervention rate
  - open work in tokens, re-estimated per task type from closed work
  - the KPIs left out on purpose, each with why: lines of code, agents
    spawned, unweighted tasks per day
- **Not in v1:**
  - Cycle time per lifecycle stage. Stages are derived on every read, so how
    long an item sat in each one needs dated transitions from the event log
    (B-7).

### 9. Settings
- The resolved config (read-only in v1), and which data sources exist on disk:
  board, run log, event log, run archive, agent definitions.
- The state directory, and the server binding and port.
- How to rotate the access token (restart the server).

### 10. Getting started
First, a new repo walked to its first closed task, in terminal commands:
install, try to close T-001 and be refused, start it, a reviewer and qa
verdict from someone else, then close it. `bin/getting-started.test.mjs` runs
exactly those commands, from the page, in a scratch repo.

Then how to build the client and start the server, both copied from TECH.md §1, and
how to reach it over `ssh -L`. It also lists what the server promises: no
daemon, no database, loopback only, and the token handling. It says plainly that
paths and commands still say `caretaker`.

## The terminal view (U-2)

The TUI shows the same project over SSH with nothing listening. It reads the
same functions as the web client, `readmodel` and `lifecycle` (C-2, C-3), so
the two cannot disagree either. It has four screens, switched with `1` to `4`:

| screen | shows |
|---|---|
| Runs | a list of runs on the left; on the right, the selected run's transcript tail, its token breakdown and its gate state; the queue below |
| Board | the lifecycle columns, with rework and active items first |
| Inbox | the same five kinds; the selected item shows the fact that put it there, such as its gate history |
| Metrics | the Metrics page's figures from `dashboard.mjs`, as text |

- `:` opens a command line that lists only what `commandsFor` offers, like the
  web command menu.
- The transcript tail is the raw redacted transcript (C-4), the same as Run
  detail. `bin/tui-mock.mjs` shows per-tool lines (read, edit, bash). Those
  would need the harness to emit normalised events first, and until it does,
  the TUI shows raw text.
- U-2's acceptance criterion covers watching and steering one run. The four
  screens widen it, and the reviewer should update U-2 on the board if this
  is accepted. This change does not edit `docs/board.json`.

## What "not recorded" will mean on day one

Several run-detail sections depend on core work that has not happened yet: run
ids in the run log, archiving harness results, and attributing egress to a run
(TECH.md C-4, C-5). On this repo today there is also no run log file and no
agent definitions. So the first version of the Runs and Run detail pages will
mostly say *not recorded*. That is correct, and it is the product working: the
page shows exactly how much of the factory is measured. It does not fabricate
what isn't.

## Non-goals for v1

- **Launching runs from the browser.** Runs start from the loop or the CLI.
- **Steering a run mid-flight.** This is U-2. The harness has no steering
  channel: the prompt goes in on stdin, and stdin is then closed.
- **Recording gate verdicts from the browser.** See Activity.
- **Editing config or the board's structure** (phases, new tasks) from the
  browser.
- **Remote access, multiple users, or a hosted service.** Tunnel over SSH if
  you need it remotely.
- **A database.** The files stay authoritative.
- **Replacing** the TUI (U-1/U-2) or `docs/board.html`.
- **A skills format, or any vendor SDK in the client.**

## Borrowed from Warp Factories: concepts, not code

Studied for product ideas only. Caretaker's runtime stays its own.

**Sources read:**
- `github.com/warpdotdev-demos/cloud-factory-demo`: README, `vision.md`,
  `roadmap.md`, `.agents/skills/triage/SKILL.md`, `.agents/skills/spec/SKILL.md`.
- Warp's Factories docs, read as source in `github.com/warpdotdev/docs`
  (`src/content/docs/factories/`): `how-factories-work.mdx`,
  `factory-dashboard.mdx`, `factory-inbox.mdx`, `factory-agents.mdx`.
  docs.warp.dev itself was not reachable from the environment these specs were
  written in, so the published pages may differ from that source.

**Taken:**
- **A work item keeps its identity from intake to handoff,** and each stage is
  carried out by an ordinary run. So there are many runs per item, with
  parent/child links between runs.
- **Stages are responsibilities, not a fixed pipeline.** Here that falls out of
  deriving the stage: a stage with nothing to do is simply never entered.
- **Three human checkpoints:** spec approval, questions (ask rather than guess),
  and merge. Caretaker already forbids an unattended merge in
  `ops/caretaker/prompt.txt`.
- **An Inbox of things waiting on you, which clears itself** when an item stops
  being relevant.
- **Product and tech specs side by side**, as `specs/<slug>/PRODUCT.md` and
  `specs/<slug>/TECH.md`. This document pair follows that.
- **A run detail page** with timeline, cost, child runs, and a transcript that
  outlives the sandbox.
- **An "autonomy" measure,** the share of work that needed no human. It is
  already planned here as B-4's human intervention rate.
- **The web app's layout and look:** the sidebar, breadcrumbs, one black
  primary button, bordered cards, icon tiles and line charts, the Activity name,
  and the Inbox as a list with a detail pane. See §Layout and TECH.md §4.

**Recorded as an idea, not in v1:** the reviewing run uses a different model
from the building run, to avoid shared blind spots. It is a natural extension
of "nobody closes their own work".

**Not taken:**
- **Cloud execution, a factory definition file, automations and webhooks,
  self-improvement loops, benchmarks, credits.** Out of scope, or at odds with
  a local-first tool.
- **An orchestrator agent that decides what runs.** Caretaker's control plane is
  code and gates, not a model.
- **Human approval as the verification step.** See the Inbox, and ADR-0001.
- **A Resolve button in the Inbox.** Items clear when their fact changes.
- **A "New run" button.** Runs start from the loop or the CLI (Non-goals).
- **A structured session view of the transcript.** It would parse one vendor's
  output above the harness seam. Transcripts stay raw text.
