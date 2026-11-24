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

# скачать файл последнего выпуска с GitHub и проверить его SHA-256
release_asset() {
  python3 - "$1" "$2" "$3" <<'PY'
import hashlib, json, os, re, sys, urllib.request
repo, pattern, out = sys.argv[1:4]
headers = {"Accept": "application/vnd.github+json", "User-Agent": "NetLoom-build"}
if os.environ.get("GH_TOKEN"):
    headers["Authorization"] = "Bearer " + os.environ["GH_TOKEN"]
rel = json.load(urllib.request.urlopen(urllib.request.Request(
    f"https://api.github.com/repos/{repo}/releases/latest", headers=headers)))
asset = next(a for a in rel["assets"] if re.fullmatch(pattern, a["name"]))
data = urllib.request.urlopen(urllib.request.Request(asset["browser_download_url"], headers={"User-Agent": "NetLoom-build"})).read()
digest = asset.get("digest") or ""
if digest.startswith("sha256:") and hashlib.sha256(data).hexdigest() != digest[7:]:
    sys.exit("контрольная сумма не совпала: " + asset["name"])
open(out, "wb").write(data)
print(rel["tag_name"])
PY
}

step "Ядра VPN"
XRAY_TAG="$(release_asset XTLS/Xray-core 'Xray-windows-64\.zip' "$STAGE/xray.zip")"
echo "    Xray-core $XRAY_TAG"
mkdir -p "$APP/cores/xray"
unzip -q "$STAGE/xray.zip" -d "$APP/cores/xray"
SB_TAG="$(release_asset SagerNet/sing-box 'sing-box-[0-9.]+-windows-amd64\.zip' "$STAGE/sing-box.zip")"
echo "    sing-box $SB_TAG"
mkdir -p "$STAGE/sb" "$APP/cores/sing-box"
unzip -q "$STAGE/sing-box.zip" -d "$STAGE/sb"
cp -r "$STAGE"/sb/*/. "$APP/cores/sing-box/"
[ -f "$APP/cores/sing-box/sing-box.exe" ] || { echo "В архиве sing-box нет sing-box.exe"; exit 1; }

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
- Xray-core $XRAY_TAG, MPL-2.0 — https://github.com/XTLS/Xray-core
- sing-box $SB_TAG, GPL-3.0-or-later — https://github.com/SagerNet/sing-box
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
