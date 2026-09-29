#!/bin/bash
# Install caretaker into a repo.
#
#     bash install.sh /path/to/repo "Project Name"
#
# Puts board.mjs, dashboard.mjs, run.mjs and loop.sh into <repo>/ops/caretaker/,
# writes a config pointing at that repo's paths, drops a starter board, and
# renders the page once so you can see it worked.
#
# IT REFUSES TO OVERWRITE. If ops/caretaker already exists in the target, this
# stops. Copying over a live board is the one mistake here that loses work, and
# a --force flag would exist only to be used in a hurry.
#
#     bash install.sh --upgrade /path/to/repo
#
# UPGRADE REPLACES THE TOOL FILES AND NOTHING ELSE. board.mjs, dashboard.mjs,
# run.mjs, loop.sh and RULES.md are copied over; config.json, prompt.txt and the
# board itself are what the refusal above protects, and upgrade never opens
# them. Every file it replaces is kept in ops/caretaker/.upgrade-backup-<time>/,
# and if the upgraded board cannot read the repo's own board, the old files go
# back and it exits 1. An upgrade that leaves a repo with a board it cannot
# read is the same lost work the refusal exists to prevent.
#
# AN INSTALL FROM BEFORE THE RENAME is moved, not refused. The project was
# called something else, and its installs live at ops/<old name>/. Upgrade
# moves that directory to ops/caretaker/ (git mv when it is tracked, so history
# follows) and rewrites the ops/<old name>/ paths inside config.json and
# prompt.txt — those paths and nothing else, with the originals kept in the
# backup. If the upgraded board then cannot read the repo's board, all of it is
# undone: the files, the two edits and the move.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS="board.mjs dashboard.mjs run.mjs loop.sh"

if [ "${1:-}" = "--upgrade" ]; then
  TARGET="${2:-}"
  [ -n "$TARGET" ] || { echo "usage: bash install.sh --upgrade /path/to/repo"; exit 2; }
  DEST="$TARGET/ops/caretaker"
  # The project's name before the rename. It appears here only so an old
  # install can be found and moved; nothing new is ever written under it.
  OLD_NAME="foreman"
  OLD="$TARGET/ops/$OLD_NAME"
  moved=""
  if [ ! -e "$DEST" ] && [ -f "$OLD/config.json" ]; then
    if git -C "$TARGET" ls-files --error-unmatch "ops/$OLD_NAME/config.json" >/dev/null 2>&1; then
      git -C "$TARGET" mv "ops/$OLD_NAME" "ops/caretaker" || { echo "FAILED moving ops/$OLD_NAME to ops/caretaker"; exit 1; }
      moved="git"
    else
      mv "$OLD" "$DEST" || { echo "FAILED moving $OLD to $DEST"; exit 1; }
      moved="mv"
    fi
  fi
  [ -f "$DEST/config.json" ] || { echo "REFUSING — no install at $DEST (no config.json). Install first."; exit 1; }
  BACKUP="$DEST/.upgrade-backup-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$BACKUP"
  changed=""
  if [ -n "$moved" ]; then
    for f in config.json prompt.txt; do
      [ -f "$DEST/$f" ] || continue
      cp -p "$DEST/$f" "$BACKUP/$f"
      sed -i "s#ops/$OLD_NAME/#ops/caretaker/#g" "$DEST/$f"
    done
    changed=" (moved ops/$OLD_NAME to ops/caretaker)"
  fi
  for f in $TOOLS; do
    if [ -e "$DEST/$f" ] && cmp -s "$HERE/bin/$f" "$DEST/$f"; then continue; fi
    [ -e "$DEST/$f" ] && cp -p "$DEST/$f" "$BACKUP/$f"
    cp "$HERE/bin/$f" "$DEST/$f" || { echo "FAILED copying $f"; exit 1; }
    changed="$changed $f"
  done
  if ! cmp -s "$HERE/RULES.md" "$DEST/RULES.md"; then
    [ -e "$DEST/RULES.md" ] && cp -p "$DEST/RULES.md" "$BACKUP/RULES.md"
    cp "$HERE/RULES.md" "$DEST/RULES.md"
    changed="$changed RULES.md"
  fi
  chmod +x "$DEST/loop.sh"
  # The check is a READ: `status` loads the repo's board through the new code
  # and writes nothing, so a failed upgrade is undone without a board rebuild.
  if ! ( cd "$TARGET" && node ops/caretaker/board.mjs status >/dev/null 2>&1 ); then
    for f in $TOOLS RULES.md config.json prompt.txt; do [ -e "$BACKUP/$f" ] && cp -p "$BACKUP/$f" "$DEST/$f"; done
    if [ "$moved" = "git" ]; then git -C "$TARGET" mv "ops/caretaker" "ops/$OLD_NAME"; elif [ "$moved" = "mv" ]; then mv "$DEST" "$OLD"; fi
    echo "ROLLED BACK — the upgraded board.mjs could not read $TARGET's board. The previous files are restored${moved:+, and the install is back at ops/$OLD_NAME}."
    exit 1
  fi
  if [ -z "$changed" ]; then
    rmdir "$BACKUP"
    echo "already current — nothing replaced in $DEST"
  else
    echo "upgraded$changed in $DEST"
    echo "previous files kept in $BACKUP"
    if [ -n "$moved" ]; then
      echo "config.json and prompt.txt: only their ops/$OLD_NAME/ paths were rewritten. The board was not touched."
      echo "If cron runs the loop, point it at the new path:  $DEST/loop.sh"
    else
      echo "config.json, prompt.txt and the board were not touched."
    fi
  fi
  # Things outside the repo that the old name owned. Reported, never moved:
  # one is a secrets file, and moving secrets is the owner's call.
  [ -e "$HOME/.config/$OLD_NAME/secrets.env" ] && echo "note: move $HOME/.config/$OLD_NAME/secrets.env to $HOME/.config/caretaker/secrets.env — the old path is no longer read."
  [ -d "${XDG_STATE_HOME:-$HOME/.local/state}/$OLD_NAME" ] && echo "note: archived runs under ${XDG_STATE_HOME:-$HOME/.local/state}/$OLD_NAME are no longer read; move them to .../caretaker to keep them."
  exit 0
fi

TARGET="${1:-}"
NAME="${2:-}"

if [ -z "$TARGET" ]; then
  echo "usage: bash install.sh /path/to/repo \"Project Name\""
  echo "       bash install.sh --upgrade /path/to/repo"
  exit 2
fi

[ -d "$TARGET" ] || { echo "no such directory: $TARGET"; exit 1; }
[ -d "$TARGET/.git" ] || echo "note: $TARGET is not a git repo — velocity and the commit log will be empty"

DEST="$TARGET/ops/caretaker"
if [ -e "$DEST" ]; then
  echo "REFUSING — $DEST already exists."
  echo "Copying over a live board is the one mistake here that loses work."
  exit 1
fi

NAME="${NAME:-$(basename "$TARGET")}"
mkdir -p "$DEST" "$TARGET/docs"

for f in $TOOLS; do
  cp "$HERE/bin/$f" "$DEST/$f" || { echo "FAILED copying $f"; exit 1; }
done
cp "$HERE/RULES.md" "$DEST/RULES.md"
cp "$HERE/prompt.example.txt" "$DEST/prompt.txt"
chmod +x "$DEST/loop.sh"

sed "s/\"name\": \"Project\"/\"name\": \"$NAME\"/" "$HERE/config.example.json" > "$DEST/config.json"

# A starter board with ONE REAL TASK, not a placeholder: the first thing anyone
# does is try to close it, which is also the first time they meet the gate
# refusing a builder who signs off their own work. That refusal is the product.
cat > "$TARGET/docs/board.json" <<JSON
{
  "meta": { "name": "$NAME" },
  "phases": [
    {
      "name": "Phase 1",
      "tasks": [
        {
          "id": "T-001",
          "title": "Replace this with the first real task",
          "owner": "you",
          "est": "30m",
          "status": "todo",
          "deps": [],
          "ac": "docs/board.json describes work this project is actually doing, and this task is gone",
          "note": "Try 'node ops/caretaker/board.mjs done T-001' before editing anything. The refusal you get is the point of the tool."
        }
      ]
    }
  ]
}
JSON

echo "installed into $DEST"
echo
( cd "$TARGET" && node ops/caretaker/dashboard.mjs ) || {
  echo "the dashboard did not run — check node is on PATH"; exit 1; }
echo
echo "next, from inside $TARGET:"
echo "  node ops/caretaker/board.mjs status      show the board"
echo "  node ops/caretaker/board.mjs done T-001  watch it refuse you"
echo "  node ops/caretaker/dashboard.mjs         rebuild docs/board.html"
echo
echo "unattended, once prompt.txt says what a pass means here:"
echo "  crontab -e  ->  */30 * * * * $TARGET/ops/caretaker/loop.sh"
