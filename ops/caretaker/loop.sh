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
cd "$ROOT" || { say "FAIL — cannot cd to $ROOT"; exit 1; }

# B-2: WHICH TASK the pass worked on, so its spend calibrates estimates. The
# prompt lets the agent pick; the board says what it picked. Each task's JSON
# is fingerprinted before and after: exactly one changed means that task, none
# or several means no task, and the log says which (independent re-review:
# loop rows carried no task, so loop work never calibrated).
board_prints() {
  [ -n "$NODE" ] || return 0
  "$NODE" -e '
    const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
    try {
      const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const root = path.resolve(path.dirname(process.argv[1]), "..", "..", cfg.repo ?? ".");
      const d = JSON.parse(fs.readFileSync(path.join(root, cfg.board ?? "docs/board.json"), "utf8"));
      for (const p of d.phases ?? []) for (const t of p.tasks ?? [])
        console.log(t.id + " " + crypto.createHash("sha256").update(JSON.stringify(t)).digest("hex"));
    } catch {}
  ' "$HERE/config.json" 2>/dev/null
}
BOARD_BEFORE=$(board_prints)

# --permission-mode auto: unattended means nothing can answer a prompt. The
# limits that matter are in the prompt above and in the repo's own gates, not in
# a dialog nobody is there to read.
# stream-json: each event is written as it happens, so a pass that is killed
# has already written what it decided (B-5). --print needs --verbose to stream.
#
# RECORDED AS IT STREAMS (B-5): the stream goes straight into harvest.mjs
# record, which redacts each line into the run's archive as it arrives and
# notes each DECISION line on the way. Nothing raw is written anywhere. The
# stream used to sit in /tmp until the pass ended, so killing loop.sh itself
# archived nothing and left the unredacted stream behind (independent
# re-review). Killed now, the CLI and the recorder run on, and the recorder
# finishes the run when the stream ends; killed with them, what streamed is
# already archived and the next pass finishes it. harvest.mjs lives in the
# caretaker checkout, not the installed copy.
HARVEST="${CARETAKER_HARVEST:-$ROOT/bin/harvest.mjs}"
RUN_ID=""
TRANSCRIPT=""
OUT=""
if [ -n "$NODE" ] && [ -f "$HARVEST" ]; then
  RUN_ID="r_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  # Holds the archive's PATH when the stream ends, never any output.
  RUN_DIR_FILE=$(mktemp /tmp/caretaker-loop-run.XXXXXX)
  "$CLAUDE" -p "$PROMPT" \
    --permission-mode auto \
    --output-format stream-json --verbose \
    2>>"$LOG" \
    | "$NODE" "$HARVEST" record --config "$HERE/config.json" --run "$RUN_ID" \
        --cli claude --source loop.sh > "$RUN_DIR_FILE" 2>>"$LOG"
  STATUS=("${PIPESTATUS[@]}")
  RC=${STATUS[0]}
  RUN_DIR=$(cat "$RUN_DIR_FILE")
  rm -f "$RUN_DIR_FILE"
  if [ "${STATUS[1]}" -ne 0 ] || [ ! -f "$RUN_DIR/transcript.log" ]; then
    say "recording failed (harvest.mjs exited ${STATUS[1]}) — this pass's output was not archived"
    RUN_ID=""
  else
    TRANSCRIPT="$RUN_DIR/transcript.log"
  fi
else
  # Nothing here can redact, so the stream goes to a private temp file, its
  # DECISION lines are copied to the log, and the file is deleted below.
  OUT=$(mktemp /tmp/caretaker-loop-out.XXXXXX)
  "$CLAUDE" -p "$PROMPT" \
    --permission-mode auto \
    --output-format stream-json --verbose \
    > "$OUT" 2>>"$LOG"
  RC=$?
  [ -f "$HARVEST" ] || say "no harvest.mjs at $HARVEST — decision lines kept here, not in the Inbox"
  grep -o 'DECISION:[^"\\]*' "$OUT" | sed 's/^/  /' >> "$LOG"
  TRANSCRIPT="$OUT"
fi

TASK_FLAGS=()
CHANGED=$(comm -3 <(echo "$BOARD_BEFORE" | sort) <(board_prints | sort) | awk '{print $1}' | sort -u)
case "$(echo "$CHANGED" | grep -c .)" in
  1) TASK_FLAGS=(--task "$CHANGED") ;;
  0) say "no task: the pass changed none on the board, so its spend calibrates nothing" ;;
  *) say "no task: the pass changed several ($(echo $CHANGED)), so its spend is not put on one" ;;
esac

if [ $RC -ne 0 ]; then
  if [ -n "$RUN_ID" ]; then WHERE="archived, redacted, as run $RUN_ID"; else WHERE="not archived: decision lines above"; fi
  say "FAIL — claude exited $RC. Its output is $WHERE."
  if [ -n "$NODE" ]; then
    "$NODE" "$HERE/run.mjs" end --name cron-loop ${RUN_ID:+--run "$RUN_ID"} "${TASK_FLAGS[@]}" --state failed \
      --note "unattended pass, claude exited $RC" >> "$LOG" 2>&1
  fi
  if [ -n "$OUT" ]; then rm -f "$OUT"; fi
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
  ' "$TRANSCRIPT" 2>/dev/null)
  if [ "${#RUN_FLAGS[@]}" -gt 0 ]; then
    "$NODE" "$HERE/run.mjs" end --name cron-loop "${RUN_FLAGS[@]}" "${TASK_FLAGS[@]}" \
      ${RUN_ID:+--run "$RUN_ID"} --state done --note "unattended pass" >> "$LOG" 2>&1
  fi
  say "done — ${RUN_ID:-no run id}${RUN_FLAGS[*]:+, ${RUN_FLAGS[*]}}"
else
  say "done — node not found, token spend not recorded"
fi

if [ -n "$OUT" ]; then rm -f "$OUT"; fi
exit 0
