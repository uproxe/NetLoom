#!/usr/bin/env bash
# Обновляет описание релиза и публикует его, когда готовы Windows, Linux и macOS.
#   bash tools/release-finish.sh <тег>
set -euo pipefail
TAG="$1"
VER="${TAG#v}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$ROOT/tools/release-notes.sh" "$TAG" > /tmp/notes.md
gh release edit "$TAG" --notes-file /tmp/notes.md
NAMES="$(gh api "repos/$GITHUB_REPOSITORY/releases?per_page=100" --jq ".[] | select(.tag_name == \"$TAG\") | .assets[].name")"
if grep -qx "NetLoom-$VER-windows-x64-setup.exe" <<<"$NAMES" && grep -qx "netloom_${VER}_amd64.deb" <<<"$NAMES" \
   && grep -qx "NetLoom-$VER-macos-universal.dmg" <<<"$NAMES"; then
  gh release edit "$TAG" --draft=false --latest
  echo "Релиз $TAG опубликован"
else
  echo "Пока не все платформы готовы — релиз остаётся черновиком"
fi
