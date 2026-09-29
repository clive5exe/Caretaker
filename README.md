# foreman

A task board that refuses to let you sign off your own work, a dashboard over
it, a run log, and an unattended loop.

Four files. No install, no service, no dependencies beyond node and git.

```
bash install.sh /path/to/repo "Project Name"
```

## Why

A board is only worth keeping if it can tell you something you did not already
believe. Most of them cannot, because the person who did the work is the person
who marks it done, and nothing in the tool disagrees.

```
$ node ops/foreman/board.mjs done T-001

  REFUSED — T-001 has not passed the gate.

  Missing: reviewer, qa

  Record verdicts first:
    node ops/foreman/board.mjs reviewer T-001 pass
    node ops/foreman/board.mjs qa T-001 pass

  This is enforced. Builder-says-done is a status report, not a completion.
```

That is the whole idea. Everything else exists to make that refusal readable.

## What you get

```
ops/foreman/board.mjs       move a task, record a gate verdict, refuse a
                            builder closing their own work
ops/foreman/dashboard.mjs   board + git + agent defs -> one self-contained page
ops/foreman/run.mjs         the run log: what ran, and what it cost
ops/foreman/loop.sh         one unattended pass, for cron
ops/foreman/config.json     paths, phase, gates, columns
ops/foreman/prompt.txt      what an unattended pass is told to do
ops/foreman/RULES.md        the rules the gates are enforcing
docs/board.json             your board
docs/board.html             the page
```

## The dashboard

One HTML file. No CDN, no script, no build step — open it from disk, copy it to
a server, attach it to a message.

**Two progress numbers, because one of them lies.** Counting tasks treats
"rotate the production key" and "fix a typo" as equal, so a board reads high
exactly when the cheap work is done and the expensive work is not. The bar is
effort, weighted by the board's own estimates; a notch marks the task count. The
gap between them is the honest part.

**An ETA that says "no rate" instead of guessing.** Remaining effort over effort
actually closed per calendar day. Idle days stay in the divisor on purpose: the
question is when this lands, not what a good day looks like.

**A gate rail per task** — one segment per gate, filled on a pass, red on a
fail, hollow when it has not run. A task sitting at "doing" with three passes
recorded used to look identical to one with none.

**Counts that explain a stall:** how many tasks are held at a gate, how many are
blocked, and how many have no acceptance criterion at all — those can never be
closed by anyone, and a board full of them only goes down.

**Rework, measured.** Gate verdicts append rather than overwrite, so a task that
failed qa three times and then passed reads as four attempts, not one pass. The
stats tab reports first-pass rate, rework rate, and, once a run log exists, the tokens spent on
tasks that failed a gate and ran again.

### And what it will not tell you

Printed on the page, next to the numbers they qualify:

- **What is executing right now**, unless something appends to `runs.jsonl`. It
  says so rather than animating a pulse over a snapshot.
- **Effort actually spent.** The board stamps a close date and no start, so
  elapsed is calendar days from the first commit naming a task. That measures how
  long work *sits*, which is what the ETA depends on. It is not hours worked.

A dashboard that implies precision it does not have is worse than the gap it
hides.

## The board format

```json
{ "phases": [ { "name": "Phase 1", "tasks": [
  { "id": "T-001", "title": "…",
    "status": "todo|doing|blocked|done|dropped",
    "owner": "backend", "est": "4h",
    "ac": "how you know it is done",
    "completed": "2026-08-29",
    "deps": ["T-000"],
    "blockedReason": "needs an API key",
    "gate": { "reviewer": { "verdict": "pass", "at": "2026-08-29",
                            "history": [ { "verdict": "fail", "at": "2026-08-28" } ] } } } ] } ] }
```

Only `id`, `title` and `status` are required. `dropped` is scope a decision
deleted: it leaves the denominator entirely, rather than counting as done or
sitting in todo forever. Gate verdicts append: `gate.<name>` is always the latest,
and earlier attempts sit in its `history`, oldest first. Everything else makes the page say
more. `est` accepts what a board actually contains — `30m`, `1h`, `1.5d`, `2w`,
and S/M/L/XL — and anything else is counted as unestimated and shown as such
rather than silently weighing zero.

## Configuration

```json
{
  "name": "Project",
  "board": "docs/board.json",
  "out": "docs/board.html",
  "activePhase": "Phase 1",
  "gates": ["reviewer", "qa"],
  "columns": [{ "key": "doing", "label": "Working" }]
}
```

`gates` is the list of gates the dashboard draws and counts.

**`done` does not read it yet**, and the two can disagree. Today `done` demands:
- `reviewer`, always;
- `qa`, unless the task is docs-only (owned by a docs role, with nothing in the
  title or criterion that names code);
- `security`, when the title or note matches its money/auth/tenant keywords.

Making `done` honour `gates` is a known, separate fix.

`agentsDir` is optional. If the project keeps agent definitions with a `model:`
in their frontmatter, the dashboard shows which model each role runs on, so spend
routing is visible instead of folklore. Point it anywhere or leave it out.

## The unattended loop

`loop.sh` runs one pass from cron so work continues when nobody has a session
open. It derives its own paths, so it needs no editing, and its lockfile is
namespaced by repo path so two projects can loop on one machine without blocking
each other.

Three guards, each there for a reason:

- **A non-blocking lockfile.** A pass can outlast the interval. Without this,
  fires stack until the machine dies.
- **A memory gate.** If the box is already tight, a pass gets killed mid-write,
  and a half-written file in a shared tree is what gets committed by accident.
  Skipping a pass costs nothing.
- **A token log.** Every run appends what it spent, so unattended cost shows up
  on the dashboard rather than on a bill.

What `prompt.txt` **forbids** matters more than what it asks for: no deploy, no
merge to the protected branch, no pushing through a red suite. Those are the
irreversible ones, and none of them should happen with nobody watching.

Stop it with `touch ops/foreman/PAUSED` — no crontab edit, and `ls` shows whether
it is paused.

## Beyond the board

The board is the part that ships through `install.sh`. The rest of `bin/` is the
layers underneath it, built bottom-up. None of it is installed into other repos
yet. `docs/architecture.md` explains how they fit, and `docs/board.json` records
where each one stands.

```
bin/sandbox.mjs    run a command in a rootless podman container with enforced
                   limits, a read-only root, and never the container socket
bin/egress.mjs     a CONNECT proxy that allows only declared hosts and logs
                   every refusal
bin/netns.mjs      the network wiring that makes the proxy the only way out,
                   plus the suite that attacks it
bin/secrets.mjs    get an API key to a run without it touching the repo, the
                   image or the log; redaction for anything that writes one
bin/spec.mjs       the spec block: which hosts a spec allows, which paths it
                   governs
bin/drift.mjs      the drift gate: a governed path changed and its spec did not
bin/harness.mjs    the seam, run(workspace, prompt, policy) -> diff, transcript,
                   verdict, cost. The CLI adapter exists; the SDK adapter says
                   it is not implemented rather than faking a result.
bin/tui-mock.mjs   a runnable layout mockup of the terminal UI
```

Tests are plain scripts with no runner: `node bin/<name>.test.mjs`.

## RULES.md

Ships with the install. The rules the gates enforce, and the ones that were
learned by getting them wrong: never `git add -A` while an agent is working; a
count in a comment is legitimate only if something asserts it or it names the
command that produces it; never claim a set is complete unless you enumerated it;
prove a test can fail before believing it passes; and a comment defending a
correct control with a wrong reason is worse than no comment, because the next
reader checks it, finds it false, and discards the control along with it.

## Licence

MIT.
