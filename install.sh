#!/bin/bash
# Install foreman into a repo.
#
#     bash install.sh /path/to/repo "Project Name"
#
# Puts board.mjs, dashboard.mjs, run.mjs and loop.sh into <repo>/ops/foreman/,
# writes a config pointing at that repo's paths, drops a starter board, and
# renders the page once so you can see it worked.
#
# IT REFUSES TO OVERWRITE. If ops/foreman already exists in the target, this
# stops. Copying over a live board is the one mistake here that loses work, and
# a --force flag would exist only to be used in a hurry.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-}"
NAME="${2:-}"

if [ -z "$TARGET" ]; then
  echo "usage: bash install.sh /path/to/repo \"Project Name\""
  exit 2
fi

[ -d "$TARGET" ] || { echo "no such directory: $TARGET"; exit 1; }
[ -d "$TARGET/.git" ] || echo "note: $TARGET is not a git repo — velocity and the commit log will be empty"

DEST="$TARGET/ops/foreman"
if [ -e "$DEST" ]; then
  echo "REFUSING — $DEST already exists."
  echo "Copying over a live board is the one mistake here that loses work."
  exit 1
fi

NAME="${NAME:-$(basename "$TARGET")}"
mkdir -p "$DEST" "$TARGET/docs"

for f in board.mjs dashboard.mjs run.mjs loop.sh; do
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
          "note": "Try 'node ops/foreman/board.mjs done T-001' before editing anything. The refusal you get is the point of the tool."
        }
      ]
    }
  ]
}
JSON

echo "installed into $DEST"
echo
( cd "$TARGET" && node ops/foreman/dashboard.mjs ) || {
  echo "the dashboard did not run — check node is on PATH"; exit 1; }
echo
echo "next, from inside $TARGET:"
echo "  node ops/foreman/board.mjs status      show the board"
echo "  node ops/foreman/board.mjs done T-001  watch it refuse you"
echo "  node ops/foreman/dashboard.mjs         rebuild docs/board.html"
echo
echo "unattended, once prompt.txt says what a pass means here:"
echo "  crontab -e  ->  */30 * * * * $TARGET/ops/foreman/loop.sh"
