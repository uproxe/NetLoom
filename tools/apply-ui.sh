#!/usr/bin/env bash
# Накладывает интерфейс и настройки NetLoom на папку движка.
#   bash tools/apply-ui.sh <папка движка>   (где лежит netloom.exe / firefox)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$1"
[ -d "$DEST" ] || { echo "Нет папки $DEST"; exit 1; }
mkdir -p "$DEST/defaults/pref" "$DEST/distribution"
cp "$ROOT/ui/defaults/pref/autoconfig.js" "$DEST/defaults/pref/autoconfig.js"
cp "$ROOT/ui/netloom.cfg" "$DEST/netloom.cfg"
cp "$ROOT/ui/distribution/policies.json" "$DEST/distribution/policies.json"
rm -rf "$DEST/nlui"
cp -r "$ROOT/ui/nlui" "$DEST/nlui"
echo "Интерфейс NetLoom наложен на $DEST"
