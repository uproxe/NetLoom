#!/usr/bin/env bash
# Собирает готовый NetLoom для Windows: движок + интерфейс + ядро VPN + фильтры.
#   bash tools/package.sh <zip движка> [папка результата]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_ZIP="$1"
OUT="${2:-$ROOT/dist}"
VER="$(cat "$ROOT/VERSION")"
STAGE="$(mktemp -d)"
step() { echo; echo "==> $*"; }

step "Движок"
unzip -q "$ENGINE_ZIP" -d "$STAGE"
APP="$STAGE/netloom"
[ -f "$APP/netloom.exe" ] || { echo "В архиве движка нет netloom/netloom.exe"; exit 1; }

step "Интерфейс"
bash "$ROOT/tools/apply-ui.sh" "$APP"
shopt -s nullglob
for xpi in "$(dirname "$ENGINE_ZIP")"/*.langpack.xpi; do
  mkdir -p "$APP/distribution/extensions"
  cp "$xpi" "$APP/distribution/extensions/langpack-ru@firefox.mozilla.org.xpi"
done
shopt -u nullglob

step "Ядро VPN (Xray-core)"
REL="$(curl -fsSL -H "Accept: application/vnd.github+json" ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} https://api.github.com/repos/XTLS/Xray-core/releases/latest)"
TAG="$(echo "$REL" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')"
echo "    $TAG"
BASE="https://github.com/XTLS/Xray-core/releases/download/$TAG"
curl -fsSL -o "$STAGE/xray.zip" "$BASE/Xray-windows-64.zip"
curl -fsSL -o "$STAGE/xray.dgst" "$BASE/Xray-windows-64.zip.dgst"
EXPECTED="$(grep -oiE 'SHA2-256=\s*[0-9a-f]{64}' "$STAGE/xray.dgst" | grep -oiE '[0-9a-f]{64}' | head -1)"
ACTUAL="$(sha256sum "$STAGE/xray.zip" | cut -d' ' -f1)"
[ "${EXPECTED,,}" = "${ACTUAL,,}" ] || { echo "Контрольная сумма ядра VPN не совпала"; exit 1; }
mkdir -p "$APP/cores/xray"
unzip -q "$STAGE/xray.zip" -d "$APP/cores/xray"

step "Списки фильтров"
mkdir -p "$APP/nlui/filters"
fetch_list() {
  local id="$1"; shift
  for u in "$@"; do
    if curl -fsSL --retry 3 -o "$APP/nlui/filters/$id.txt" "$u"; then echo "    $id"; return 0; fi
  done
  echo "    $id: не скачан (браузер скачает сам)"
  rm -f "$APP/nlui/filters/$id.txt"
}
fetch_list easylist https://easylist.to/easylist/easylist.txt https://easylist-downloads.adblockplus.org/easylist.txt
fetch_list easyprivacy https://easylist.to/easylist/easyprivacy.txt https://easylist-downloads.adblockplus.org/easyprivacy.txt
fetch_list ruadlist https://easylist-downloads.adblockplus.org/advblock.txt
fetch_list rucounters https://easylist-downloads.adblockplus.org/cntblock.txt
cp "$ROOT/ui/nlui/content/lib/netloom-rules.txt" "$APP/nlui/filters/netloom-rules.txt"

step "Лицензии"
cp "$ROOT/LICENSE" "$APP/LICENSE.txt"
cat > "$APP/THIRD-PARTY.txt" <<TXT
NetLoom использует:
- движок Gecko (Mozilla), MPL-2.0 — https://www.mozilla.org/MPL/2.0/
- Xray-core $TAG, MPL-2.0 — https://github.com/XTLS/Xray-core
- списки фильтров EasyList, EasyPrivacy, RU AdList — лицензии в заголовках списков
TXT

step "Архив"
ENGINE_VER="$(basename "$ENGINE_ZIP" | sed -E 's/netloom-engine-([0-9.]+)-win64\.zip/\1/')"
mkdir -p "$OUT"
NAME="NetLoom-$VER-win64"
rm -f "$OUT/$NAME.zip"
mv "$APP" "$STAGE/NetLoom"
(cd "$STAGE" && zip -qr9 "$OUT/$NAME.zip" NetLoom)
echo "$ENGINE_VER" > "$OUT/ENGINE_VERSION"
ls -la "$OUT"
