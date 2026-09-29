# The event log

Autonomous runs produce a stream. A developer tails it. That is the whole
interface.

## One file, append-only, one JSON object per line

```json
{"t":"2026-08-30T14:22:01Z","run":"r_8f2c","task":"T-001","stage":"review",
 "kind":"gate","level":"warn","verdict":"fail",
 "detail":"pricing.ts changed, pricing.md did not","tokens":1240}
```

`tail` and `jq` are the tooling. Nothing to build.

```
tail -F "$(node bin/events.mjs path)"                       watch today live
cd ops/foreman/events
jq -cR 'fromjson? | select(.task=="T-001")'   events-*.jsonl   one task
jq -cR 'fromjson? | select(.run=="r_8f2c")'   events-*.jsonl   one run
jq -cR 'fromjson? | select(.verdict=="fail")' events-*.jsonl   only what broke
jq -cR 'fromjson? | select(.level!="debug")'  events-*.jsonl   only what matters
```

**`-R 'fromjson? | …'`, not plain `jq`.** Plain `jq` stops at a half-written
line: it prints the lines before it, then exits 5 with a parse error, so a file
read while something is appending to it looks broken. `-R` reads each line as
text and `fromjson?` drops the ones that do not parse. `bin/events.test.mjs`
runs all four filters above against a file with a fragment in it, and asserts
that plain `jq` still fails on it, so the day that changes is noticed.

`tail -F` rather than `-f`, because the file changes name at midnight UTC.

## Why append-only, specifically

- **Nothing is ever rewritten**, so two concurrent runs cannot corrupt each other
  and no locking is required.
- **A killed run leaves a half-written last line at worst.** That is why every
  reader skips unparseable lines rather than throwing — a partial final line is
  the normal state of a file something is appending to, not an error.
- **It survives a crash**, which an in-memory queue does not.
- **`tail -f` already works.** Any format that needs a client to read it will be
  read by nobody at 3am.

## The organising key is a FIELD, never a folder

The tempting question is "organise by issue, or by PR?" — and the answer is
neither, because both are fields.

A run can span several tasks. A task can span several runs. A PR maps cleanly to
neither. Whichever becomes the directory structure locks in an assumption that
breaks the first time work does not fit it, and by then there is history in the
old shape.

One file. Filters give every view.

## Fields

| field | why |
|---|---|
| `t` | ISO instant, UTC. Sorting and rotation both need it. |
| `run` | which execution. Groups everything one agent invocation produced. |
| `task` | which board item, when there is one. Absent for setup and maintenance. |
| `stage` | where in the loop: `plan`, `build`, `review`, `verify`, `merge`. |
| `kind` | `gate`, `agent`, `tool`, `drift`, `system`. |
| `level` | `debug`, `info`, `warn`, `error`. |
| `verdict` | `pass` / `fail`, only on gate events. |
| `tokens` | cost, when the event is the end of a run. |
| `detail` | one human-readable sentence. Never a stack trace; those go to a file the event names. |

**`level` is not optional and is easy to skip.** Autonomous runs are noisy.
Without it you log either too little to debug or too much to read, and you will
choose wrong in both directions on the same day.

## Rotate by day

`events-2026-08-30.jsonl`. Tailing stays simple, deleting old ones is trivial,
and the date is the one key that is never the wrong choice.

## State is a projection, not a record

"Is T-001 done?" is not stored. It is computed by replaying the events.

That is the point rather than a purity argument: **the log cannot disagree with
the board, because the board IS the log, folded up.** The same reasoning made
gate verdicts append instead of overwrite — a board that keeps only the latest
verdict cannot answer how many attempts it took, and that question turned out to
matter more than the current state did.

## Writing it

`bin/events.mjs` is the one writer and the one reader. Everything goes to
`ops/foreman/events/events-YYYY-MM-DD.jsonl` unless told otherwise, and that
directory is gitignored.

- `append(dir, events)` checks each line against the table above and refuses a
  bad batch whole. `level` is required, never defaulted. `verdict` is allowed
  only on a `gate` event. `detail` must be one line.
- Each line goes to the file for its own `t`, so a batch that crosses midnight
  is split.
- If a killed writer left a half-written line, `append` starts a new line
  before writing. Without that, the next event lands on the fragment's line and
  both are lost to every reader.
- Shell scripts use `node bin/events.mjs emit --kind … --level … --detail …`.

**Every harness run appends two events.** Both have `kind: "agent"`, the run
id and the policy's `task` and `stage`. `phase: "start"` is written before the
first snapshot. `phase: "end"` is written after the second, and carries
`state`, `tokens`, `files` and `durationMs`. A start with no end means the
harness process itself died. A run that never started (an unknown CLI, no
image) still gets an end, with `state: "not-started"`. A log that cannot be
written does not fail the run; it goes into `verdict.warnings`.

The drift gate writes through the same `append`.

## What already does this

`ops/foreman/runs.jsonl` and `ops/foreman/history.jsonl` are this shape already.
This generalises what is there rather than replacing it.
