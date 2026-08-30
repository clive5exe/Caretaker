# House rules

These are what make the gates worth passing. Copy this into the project's
`CLAUDE.md` (or reference it from there) — the board engine enforces the first
three mechanically, and the rest are the ones that were learned by getting them
wrong.

## Enforced by `board.mjs`, not by goodwill

- **Nobody closes their own work.** `done` is refused until the gate verdicts are
  recorded. Builder-says-done is a status report, not a completion.
- **Money, auth and tenant-isolation changes need `security` AND `qa`.** Not one
  or the other.
- **Every task needs an acceptance criterion.** A task with no finish line cannot
  be closed by anyone, and a board full of them only goes down as a percentage.
  The dashboard counts them so they cannot hide.

## Learned the hard way

- **Never `git add -A` while an agent is working.** Stage explicit paths. A
  shared tree has half-written files in it, and a prove-red test deliberately
  puts a BROKEN version on disk. One board commit swept exactly that and briefly
  capped every paid basket at ten tickets on the main branch.

- **A count in a comment is legitimate only if the line below asserts it, or the
  comment names the command that produces it.** Executed counts cannot rot;
  narrated ones always do. A single note once carried `626 lines` (638),
  `11 scripts` (21), `432 PASS` (1129) and a constant that did not exist.

- **A comment that asserts a measurement must name what was run.** State the
  command or the mutation and its result, or write nothing.

- **Never assert a set is complete unless you enumerated it.** "The main ones" is
  honest. "Both" is a claim.

- **A comment defending a correct control with a wrong reason is worse than no
  comment.** The next reader checks it, finds it false, and discards the control
  along with it. This is the single most expensive defect class here.

- **Prove a test can fail before believing it passes.** Mutate the source, watch
  the gate go red BY NAME, restore, and verify the restore with a checksum. A
  gate written without this is decorative: one shipped with the literal `true` as
  its condition and read as coverage on the page for hours.

- **Delete a number when nothing executable keeps it honest; correct it when
  something does.** Paraphrasing digits into prose does not help — three
  positional claims in words rot at the same rate and are harder to falsify. A
  wrong number is at least wrong at a glance.

- **DB-level constraints are the real backstop.** Anything that must not oversell
  or go negative carries a CHECK. Application logic is not the only guard.

- **Migrations are numbered and never edited once applied.** Write a new one. And
  keep a ledger of what is applied — without one, "which migrations are live" is
  answerable only by probing for a column and guessing, and a database can sit
  ten files behind while the test suite is green because it replays onto a
  throwaway cluster.

## For unattended runs

Three things must not happen with nobody watching, and they are in
`prompt.txt` rather than here so the loop actually reads them:

- no deploy
- no merge to the protected branch
- no pushing through a red suite — never disable a gate to get green
