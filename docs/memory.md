# What survives, and where it lives

Sessions compress. Context is dropped. Anything that existed only in a
conversation is gone, and you usually find out months later when you need the
reason for a decision and nobody has it.

This is not a problem to be solved by bigger context windows. Compaction is
lossy and unavoidable, so the design principle is **externalise before you
compact**, not avoid compacting.

## The empirical version

In the project this tooling came from, the things that survived every compaction
were the ones written **where they attach to the artifact** rather than where
they attach to the session:

- commit messages, attached to the change they explain
- board notes, attached to the task
- ADRs, attached to the decision

Everything that lived only in the conversation is gone, including reasoning that
took hours to reach. That is the whole finding, and it is why the commit messages
in that repo are long. They are not documentation etiquette; they are the only
durable place a reason can sit next to the thing it explains.

## Three tiers, separated by decay rate

The common mistake is collapsing these into one "docs" pile. They rot at
completely different speeds and want opposite treatment.

| | decays | edited? | read how |
|---|---|---|---|
| **Decision** | never | never — superseded, not edited | in full, months later |
| **Spec** | with the code | continuously | in full, now |
| **Log** | instantly | append-only | searched, never read whole |

**Decisions are immutable.** An ADR that gets edited stops being a record of
what was decided and becomes a record of what someone currently believes. When a
decision changes, write a new one with `supersedes:` and leave the old one
standing. A pricing rail that reversed five times in one project stayed traceable
only because each reversal was a new record rather than an edit to the last.

**Specs must match reality and nothing else.** They carry current state, not
history. A spec that accumulates a changelog becomes unreadable, and unreadable
specs are not consulted, and unconsulted specs drift. Put the history in the
decisions and the log; keep the spec about now.

**The log is append-only and is never read in full.** Commit messages,
transcripts, run records, gate verdicts. Its job is to be searchable when
somebody asks "why is this like this", not to be read.

## Status should be DERIVED, not declared

A manual "is this current?" flag is a lie waiting to happen, because the moment
someone is in a hurry it stops being updated and there is no way to tell a
current doc from an abandoned one.

What works is computed:

- **stale** — the doc's claimed `updated:` date is older than the last commit
  touching the paths it governs. This is stronger than comparing against the
  doc's own last commit, because a doc can be true and untouched while the code
  under it moves.
- **orphaned** — it governs paths that no longer exist.
- **unowned** — code with no spec claiming it. The inverse check, and usually the
  more alarming one.

Declared status is still right for decisions, because there the status is a fact
about the decision rather than about freshness: `draft`, `accepted`,
`superseded-by: ADR-0031`.

## The modes, and why they are one mechanism

Not everyone works the same way, and the machinery has to serve all of them
without becoming two products.

**A — spec first, let it run.** Specs are the input, agents execute against
them, the human touches little. Wants: strict drift gating, adversarial verify,
tight acceptance criteria.

**B — build it out as you go.** The spec is DISCOVERED. Prompting produces code
and the understanding arrives with it. Strict drift gating here is constant
noise, and a gate that cries wolf gets switched off.

**C — inherit and maintain.** Neither is authority; the job is to make them agree
before somebody else picks it up.

The insight that keeps this one system: **all three want the same machinery
pointed in a different direction.**

```
A   spec is authority     drift means the CODE is wrong
B   code is discovery     drift means the SPEC is behind
C   neither               drift means they must be reconciled before handoff
```

So it is one drift mechanism with a **default direction**, set per project and
overridable per task. Mode A defaults to "code is wrong" and blocks. Mode B
defaults to "spec is behind" and harvests: at the end of a run, propose the spec
change from the diff and the transcript. Mode C is `graduate` — reconcile, then
generate the CI and docs from what actually happened.

Two of those are the same code path with the arrow reversed. That is the reason
not to build three products.

## What the others do

**Fabro** — per its README, every stage commits code and execution metadata to
git branches, plus "durable events, checkpoints, conclusions, and stage
outputs". Their durability story is the RUN HISTORY: the graph is the spec, and
what survives is the trace of what executed.

That is genuinely good for reproducing a run and genuinely weak for answering
"why". A trace tells you what happened; it does not tell you what was decided or
what was rejected. There is no equivalent of a decision record, because the DOT
graph is a plan rather than a rationale.

**Claude Code** — compaction with a file-based memory directory for facts worth
keeping across sessions. The memory is the right idea and the interesting part is
what it does NOT hold: it explicitly excludes anything the repo already records,
because a fact stored in two places is a fact that can disagree with itself.

**Where we do better:** keep the run history, add the two things a trace cannot
carry — an immutable decision record, and a derived staleness signal that makes
a rotten doc visible without anybody remembering to look. Then point the drift
machinery in whichever direction the project actually works in, rather than
assuming everyone builds spec-first.
