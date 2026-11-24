#!/usr/bin/env bash
# Готовит приложение Android к сборке: общие библиотеки из ui/, списки фильтров, ядра VPN.
#   bash tools/android-prepare.sh [arm64-v8a|x86_64]   (x86_64 — только для проверки на эмуляторе)
set -euo pipefail
ABI="${1:-arm64-v8a}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/android/app/src/main"
EXT="$APP/assets/netloom"
TMP="$(mktemp -d)"
step() { echo; echo "==> $*"; }

step "Общие библиотеки (те же, что на компьютере)"
mkdir -p "$EXT/lib" "$EXT/filters"
cp "$ROOT/ui/nlui/content/lib/filters.js" "$ROOT/ui/nlui/content/lib/links.js" "$EXT/lib/"
cp "$ROOT/ui/nlui/content/lib/netloom-rules.txt" "$EXT/filters/netloom-rules.txt"

step "Списки фильтров"
fetch_list() {
  local id="$1"; shift
  for u in "$@"; do
    if curl -fsSL --retry 3 -o "$EXT/filters/$id.txt" "$u"; then echo "    $id"; return 0; fi
  done
  echo "    $id: не скачан (приложение скачает само)"; rm -f "$EXT/filters/$id.txt"
}
fetch_list easylist https://easylist.to/easylist/easylist.txt https://easylist-downloads.adblockplus.org/easylist.txt
fetch_list easyprivacy https://easylist.to/easylist/easyprivacy.txt https://easylist-downloads.adblockplus.org/easyprivacy.txt
fetch_list ruadlist https://easylist-downloads.adblockplus.org/advblock.txt
fetch_list rucounters https://easylist-downloads.adblockplus.org/cntblock.txt
fetch_list adguard-base https://filters.adtidy.org/extension/ublock/filters/2_without_easylist.txt
fetch_list adguard-russian https://filters.adtidy.org/extension/ublock/filters/1.txt
fetch_list adguard-tracking https://filters.adtidy.org/extension/ublock/filters/3.txt
fetch_list urlhaus https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt https://curbengh.github.io/malware-filter/urlhaus-filter-online.txt
fetch_list phishing https://malware-filter.gitlab.io/malware-filter/phishing-filter.txt https://curbengh.github.io/malware-filter/phishing-filter.txt
fetch_list pup https://malware-filter.gitlab.io/malware-filter/pup-filter.txt https://curbengh.github.io/malware-filter/pup-filter.txt

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

step "Ядра VPN для Android ($ABI)"
LIBS="$APP/jniLibs/$ABI"
rm -rf "$APP/jniLibs"; mkdir -p "$LIBS"
case "$ABI" in
  arm64-v8a) XP='Xray-android-arm64-v8a\.zip'; SP='sing-box-[0-9.]+-android-arm64\.tar\.gz' ;;
  x86_64)    XP='Xray-android-amd64\.zip';     SP='sing-box-[0-9.]+-android-amd64\.tar\.gz' ;;
  *) echo "Неизвестная архитектура $ABI"; exit 2 ;;
esac
# для эмулятора ядра не обязательны: проверяется интерфейс, блокировка и защита
optional() { [ "$ABI" = x86_64 ] && { echo "    $1 для $ABI не найдено — пропускаю"; return 0; }; exit 1; }
if XRAY_TAG="$(release_asset XTLS/Xray-core "$XP" "$TMP/xray.zip")"; then
  unzip -q "$TMP/xray.zip" -d "$TMP/xray"
  cp "$TMP/xray/xray" "$LIBS/libxray.so"
else optional Xray; fi
if SB_TAG="$(release_asset SagerNet/sing-box "$SP" "$TMP/sb.tgz")"; then
  mkdir -p "$TMP/sb"; tar -xzf "$TMP/sb.tgz" -C "$TMP/sb"
  cp "$TMP"/sb/*/sing-box "$LIBS/libsingbox.so"
else optional sing-box; fi
chmod 755 "$LIBS"/*.so 2>/dev/null || true
file "$LIBS"/*.so 2>/dev/null || true
echo "    Xray-core ${XRAY_TAG:-—}, sing-box ${SB_TAG:-—}"
rm -rf "$TMP"
