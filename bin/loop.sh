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
"$CLAUDE" -p "$PROMPT" \
  --permission-mode auto \
  --output-format json \
  > "$OUT" 2>>"$LOG"
RC=$?

if [ $RC -ne 0 ]; then
  say "FAIL — claude exited $RC. Last of its output:"
  tail -c 2000 "$OUT" >> "$LOG"
  rm -f "$OUT"
  exit $RC
fi

# Token spend, if the JSON carries it. Best effort on purpose: a shape change in
# the CLI's output must not fail a pass that already did its work.
if [ -n "$NODE" ]; then
  "$NODE" -e '
    const fs = require("node:fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const u = j.usage ?? {};
      const tok =
        (u.input_tokens ?? 0) + (u.output_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      process.stdout.write(String(tok || 0));
    } catch { process.stdout.write("0"); }
  ' "$OUT" > /tmp/caretaker-loop-tokens 2>/dev/null
  TOK=$(cat /tmp/caretaker-loop-tokens 2>/dev/null || echo 0)
  if [ "${TOK:-0}" -gt 0 ]; then
    "$NODE" "$HERE/run.mjs" end --name cron-loop --tokens "$TOK" \
      --state done --note "unattended pass" >/dev/null 2>&1
  fi
  say "done — ${TOK:-0} tokens"
else
  say "done — node not found, token spend not recorded"
fi

rm -f "$OUT" /tmp/caretaker-loop-tokens
