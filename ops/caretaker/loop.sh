#!/bin/bash
# THE UNATTENDED LOOP. One pass of the build queue, run headlessly by cron so the
# work continues when nobody has a session open.
#
# WHY THIS EXISTS. The interactive /loop only lives as long as its session; close
# the terminal and the queue stops. This is the durable half. Same shape as
# any long-lived cron job worth trusting: a lockfile so overlapping fires cannot
# stack, and a log that records FAILURE, because a job that goes quiet when it
# breaks is worse than no job.
#
# THREE GUARDS, and each one is here because of something that has actually gone
# wrong on this box or in this repo:
#
#   flock -n     A pass can take longer than the cron interval (npm run qa alone
#                is about twenty minutes). Without this, fires stack until the
#                box dies. Non-blocking: a late fire gives up immediately rather
#                than queueing behind the last one and then running them all.
#
#   memory gate  On a small box with an OOM killer live, a pass that starts
#                while memory is already tight gets something killed mid-write,
#                and a half-written file in a shared tree is the state that gets
#                committed by accident. Skipping a pass costs nothing; a killed
#                one costs the tree.
#
#   token log    Every run appends what it spent to the caretaker run log, so the
#                dashboard can show unattended spend beside interactive spend
#                rather than the founder discovering it on a bill.
#
# WHAT THE PROMPT FORBIDS is as important as what it asks for, and is spelled out
# there rather than here: no deploy, no merge to master, no pushing through a red
# suite. Those are the three irreversible things, and none of them should happen
# with nobody watching.
#
# Install:  crontab -e   ->   */30 * * * * /path/to/<repo>/ops/caretaker/loop.sh
# Disable:  comment that line out, or `touch <repo>/ops/caretaker/PAUSED`

set -uo pipefail

# PATHS ARE DERIVED, NOT TYPED, so this file works in another repo unchanged.
# The script sits at <repo>/ops/caretaker/loop.sh, so the repo is two levels up.
# The lock is namespaced by the repo path for the same reason: two projects
# looping on one box must not block each other.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LOCK="/tmp/caretaker-loop-$(echo "$ROOT" | tr -c 'A-Za-z0-9' '-').lock"
LOG="$HERE/loop.log"
PAUSE="$HERE/PAUSED"
CLAUDE="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"
NODE=$(command -v node)
MIN_FREE_MB=1800

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { echo "[$(ts)] $*" >> "$LOG"; }

# A file, not a config edit: the founder can stop this without editing crontab
# or reading this script, and `ls` shows whether it is paused.
if [ -f "$PAUSE" ]; then
  say "paused — $PAUSE exists, skipping"
  exit 0
fi

exec 9>"$LOCK"
if ! flock -n 9; then
  say "skip — a previous pass is still running"
  exit 0
fi

FREE_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
if [ "${FREE_MB:-0}" -lt "$MIN_FREE_MB" ]; then
  say "skip — only ${FREE_MB}MB available, need ${MIN_FREE_MB}MB"
  exit 0
fi

# THE PROMPT LIVES IN A FILE, NOT HERE, because it is the only project-specific
# thing left in this script. Edit ops/caretaker/prompt.txt to point the loop at a
# different board, a different publish command, or different limits; the script
# itself needs no change to work in another repo.
PROMPT_FILE="$HERE/prompt.txt"
[ -r "$PROMPT_FILE" ] || { say "FAIL — no prompt at $PROMPT_FILE"; exit 1; }
PROMPT=$(cat "$PROMPT_FILE")

say "start — ${FREE_MB}MB available"
OUT=$(mktemp /tmp/caretaker-loop-out.XXXXXX)
cd "$ROOT" || { say "FAIL — cannot cd to $ROOT"; exit 1; }

# --permission-mode auto: unattended means nothing can answer a prompt. The
# limits that matter are in the prompt above and in the repo's own gates, not in
# a dialog nobody is there to read.
# stream-json: each event is written as it happens, so a pass that is killed
# has already written what it decided (B-5, independent re-review: with json
# nothing was printed until exit). --print needs --verbose to stream.
"$CLAUDE" -p "$PROMPT" \
  --permission-mode auto \
  --output-format stream-json --verbose \
  > "$OUT" 2>>"$LOG"
RC=$?

# DECISIONS FIRST, and on a FAILED pass too, because the output is deleted
# below. A killed or failed pass used to exit here, before the harvest, so what
# it had decided was lost with it, and the raw tail of its output went into
# loop.log unredacted (independent re-review). This loop calls the CLI
# directly rather than through runstore, so nothing else would archive what it
# said: harvest.mjs archives the output as a run (redacted) and puts any
# DECISION: line no spec or ADR records in the Inbox. harvest.mjs lives in the
# caretaker checkout, not the installed copy; without it the decision lines are
# kept in loop.log rather than lost with the output.
HARVEST="${CARETAKER_HARVEST:-$ROOT/bin/harvest.mjs}"
RUN_ID=""
if [ -n "$NODE" ] && [ -f "$HARVEST" ]; then
  RUN_ID=$("$NODE" "$HARVEST" import --config "$HERE/config.json" --transcript "$OUT" \
    --cli claude --source loop.sh 2>>"$LOG")
  case "$RUN_ID" in r_????????) ;; *) say "harvest failed — decision lines below"; RUN_ID="" ;; esac
fi
if [ -z "$RUN_ID" ]; then
  [ -f "$HARVEST" ] || say "no harvest.mjs at $HARVEST — decision lines kept here, not in the Inbox"
  grep -o 'DECISION:[^"\\]*' "$OUT" | sed 's/^/  /' >> "$LOG"
fi

if [ $RC -ne 0 ]; then
  say "FAIL — claude exited $RC. Its output is ${RUN_ID:+archived, redacted, as run $RUN_ID}${RUN_ID:-not archived: decision lines above}."
  if [ -n "$NODE" ]; then
    "$NODE" "$HERE/run.mjs" end --name cron-loop ${RUN_ID:+--run "$RUN_ID"} --state failed \
      --note "unattended pass, claude exited $RC" >> "$LOG" 2>&1
  fi
  rm -f "$OUT"
  exit $RC
fi

# Token spend, if the JSON carries it. Best effort on purpose: a shape change in
# the CLI's output must not fail a pass that already did its work. The
# breakdown, not only the total: run.mjs derives the total from the parts, and
# the dashboard's composition panel is empty for a row that has only a total.
if [ -n "$NODE" ]; then
  mapfile -t RUN_FLAGS < <("$NODE" -e '
    const fs = require("node:fs");
    try {
      // The final result event: the last line that is one, from a streamed
      // transcript, or the whole file from an older json one.
      const text = fs.readFileSync(process.argv[1], "utf8");
      const docs = text.split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      const j = docs.filter((d) => d && d.type === "result").at(-1) ?? JSON.parse(text);
      const u = j.usage ?? {};
      const out = [];
      const put = (flag, v) => { if (Number.isFinite(v)) out.push(flag, String(v)); };
      put("--in", u.input_tokens);
      put("--cached", u.cache_read_input_tokens);
      put("--write", u.cache_creation_input_tokens);
      put("--out", u.output_tokens);
      put("--turns", j.num_turns);
      // One model or none: a pass that used two would put all its tokens on one.
      const models = Object.keys(j.modelUsage ?? {});
      if (models.length === 1) out.push("--model", models[0]);
      process.stdout.write(out.join("\n"));
    } catch {}
  ' "$OUT" 2>/dev/null)
  if [ "${#RUN_FLAGS[@]}" -gt 0 ]; then
    "$NODE" "$HERE/run.mjs" end --name cron-loop "${RUN_FLAGS[@]}" \
      ${RUN_ID:+--run "$RUN_ID"} --state done --note "unattended pass" >> "$LOG" 2>&1
  fi
  say "done — ${RUN_ID:-no run id}${RUN_FLAGS[*]:+, ${RUN_FLAGS[*]}}"
else
  say "done — node not found, token spend not recorded"
fi

rm -f "$OUT"
