#!/usr/bin/env bash
# Publish plugins.json to the orphan `data` branch as a single, always-amended
# commit, so the repo never accumulates a 1.7 MB blob per day.
set -euo pipefail

[ -f plugins.json ] || { echo "plugins.json missing"; exit 1; }

git config user.name  "openhub-bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

git fetch origin data --depth=1 2>/dev/null || true
OLD="$(git show origin/data:plugins.digest 2>/dev/null | tr -d '\r\n' || true)"
NEW="$(tr -d '\r\n' < plugins.digest)"

if [ "$OLD" = "$NEW" ]; then
  echo "catalog unchanged (digest ${NEW:0:12}); nothing to publish"
  exit 0
fi

PREV="$(git rev-parse --abbrev-ref HEAD)"
# The orphan checkout tracks these files, so leaving the branch deletes them.
BACKUP="$(mktemp -d)"; cp plugins.json plugins.digest "$BACKUP"/

git checkout --orphan "data-$(date +%s)" >/dev/null 2>&1
git rm -rf --cached . >/dev/null
git add -f plugins.json plugins.digest
git commit -q -m "catalog ${NEW:0:12}"
git push --force origin HEAD:data

TEMP="$(git rev-parse --abbrev-ref HEAD)"
git checkout -f "$PREV" >/dev/null 2>&1
cp "$BACKUP/plugins.json" "$BACKUP/plugins.digest" .
rm -rf "$BACKUP"
git branch -D "$TEMP" >/dev/null 2>&1 || true

echo "published digest ${NEW:0:12}"
