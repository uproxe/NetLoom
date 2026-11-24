#!/usr/bin/env bash
# Собирает готовый NetLoom: движок + интерфейс + ядра VPN + фильтры → файлы для людей.
#
#   bash tools/package.sh <платформа> <файл движка> [папка результата]
#     win64    (на Linux)  → NetLoom-<v>-windows-x64-setup.exe и NetLoom-<v>-windows-x64.zip
#     linux64  (на Linux)  → netloom_<v>_amd64.deb
#     mac      (на Linux или macOS) → NetLoom-<v>-macos-universal.dmg
#
# Скрипт совместим со старым bash 3.2 из macOS.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM="$1"
ENGINE="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
OUT="${3:-$ROOT/dist}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
VER="$(cat "$ROOT/VERSION")"
STAGE="$(mktemp -d)"
step() { echo; echo "==> $*"; }
ENGINE_VER="$(basename "$ENGINE" | sed -E 's/^netloom-engine-([0-9.]+)-.*/\1/')"

# ───────── Движок ─────────
step "Движок $ENGINE_VER ($PLATFORM)"
case "$PLATFORM" in
win64)
  unzip -q "$ENGINE" -d "$STAGE"
  APP="$STAGE/netloom"; RES="$APP"
  [ -f "$APP/netloom.exe" ] || { echo "В архиве движка нет netloom/netloom.exe"; exit 1; }
  ;;
linux64)
  tar -xf "$ENGINE" -C "$STAGE"
  APP="$STAGE/netloom"; RES="$APP"
  [ -x "$APP/netloom" ] || { echo "В архиве движка нет netloom/netloom"; exit 1; }
  ;;
mac)
  if [ "$(uname)" = Darwin ]; then
    MNT="$STAGE/mnt"; mkdir -p "$MNT"
    hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$ENGINE" >/dev/null
    BUNDLE="$(cd "$MNT" && ls -d *.app | head -1)"
    cp -R "$MNT/$BUNDLE" "$STAGE/NetLoom.app"
    hdiutil detach "$MNT" >/dev/null
    LIPO=lipo
  else
    # на Linux — инструменты Mozilla для образов macOS (как в её собственной сборке) и rcodesign для подписи
    MT="${NETLOOM_MAC_TOOLS:-$HOME/mac-tools}"
    TC="https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/gecko.cache.level-3.toolchains.v3"
    mkdir -p "$MT"
    [ -x "$MT/dmg/dmg" ] || curl -fsSL --retry 5 "$TC.linux64-libdmg.latest/artifacts/public/build/dmg.tar.zst" | tar --zstd -x -C "$MT"
    [ -x "$MT/hfsplus/newfs_hfs" ] || curl -fsSL --retry 5 "$TC.linux64-hfsplus.latest/artifacts/public/build/hfsplus.tar.zst" | tar --zstd -x -C "$MT"
    [ -x "$MT/cctools/bin/x86_64-apple-darwin-lipo" ] || curl -fsSL --retry 5 "$TC.linux64-cctools-port.latest/artifacts/public/build/cctools.tar.zst" | tar --zstd -x -C "$MT"
    if [ ! -x "$MT/rcodesign" ]; then
      python3 - "$MT/rcodesign.tgz" <<'PY'
import json, os, re, sys, urllib.request
h = {"Accept": "application/vnd.github+json", "User-Agent": "NetLoom-build"}
if os.environ.get("GH_TOKEN"):
    h["Authorization"] = "Bearer " + os.environ["GH_TOKEN"]
rels = json.load(urllib.request.urlopen(urllib.request.Request(
    "https://api.github.com/repos/indygreg/apple-platform-rs/releases?per_page=50", headers=h)))
for r in rels:
    if r["tag_name"].startswith("apple-codesign/") and not r["prerelease"]:
        a = next((a for a in r["assets"] if re.search(r"x86_64-unknown-linux-musl\.tar\.gz$", a["name"])), None)
        if a:
            open(sys.argv[1], "wb").write(urllib.request.urlopen(urllib.request.Request(a["browser_download_url"], headers={"User-Agent": "NetLoom-build"})).read())
            print("rcodesign", r["tag_name"])
            break
else:
    sys.exit("rcodesign не найден")
PY
      tar -xzf "$MT/rcodesign.tgz" -C "$MT" && mv "$MT"/apple-codesign-*/rcodesign "$MT/rcodesign" && rm -rf "$MT"/apple-codesign-* "$MT/rcodesign.tgz"
    fi
    "$MT/dmg/dmg" extract "$ENGINE" "$STAGE/engine.hfs" >/dev/null
    mkdir -p "$STAGE/img"
    "$MT/dmg/hfsplus" "$STAGE/engine.hfs" extractall / "$STAGE/img" >/dev/null
    rm -f "$STAGE/engine.hfs"
    BUNDLE="$(cd "$STAGE/img" && ls -d *.app | head -1)"
    mv "$STAGE/img/$BUNDLE" "$STAGE/NetLoom.app"
    rm -rf "$STAGE/img"
    LIPO="$MT/cctools/bin/x86_64-apple-darwin-lipo"
  fi
  APP="$STAGE/NetLoom.app"; RES="$APP/Contents/Resources"
  [ -f "$APP/Contents/MacOS/netloom" ] || { echo "В образе движка нет Contents/MacOS/netloom"; exit 1; }
  ;;
*) echo "Неизвестная платформа: $PLATFORM"; exit 2 ;;
esac

# ───────── Интерфейс ─────────
step "Интерфейс"
bash "$ROOT/tools/apply-ui.sh" "$RES"
for xpi in "$(dirname "$ENGINE")"/*.langpack.xpi; do
  [ -f "$xpi" ] || continue
  # пакет языка нужен только если движок собран без русского внутри
  if [ ! -d "$RES/browser/localization/ru" ] && ! unzip -l "$RES/browser/omni.ja" 2>/dev/null | grep -q "localization/ru/"; then
    mkdir -p "$RES/distribution/extensions"
    cp "$xpi" "$RES/distribution/extensions/langpack-ru@firefox.mozilla.org.xpi"
  fi
done

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

# xray: zip-архив; sing-box: zip (Windows) или tar.gz (остальные) с папкой внутри
get_xray() {   # <шаблон> <папка>
  local d="$STAGE/x-$RANDOM"; mkdir -p "$d" "$2"
  XRAY_TAG="$(release_asset XTLS/Xray-core "$1" "$d/x.zip")"
  unzip -qo "$d/x.zip" -d "$2"
}
get_singbox() {   # <шаблон> <папка>
  local d="$STAGE/s-$RANDOM"; mkdir -p "$d/u" "$2"
  case "$1" in *zip*) SB_TAG="$(release_asset SagerNet/sing-box "$1" "$d/s.zip")"; unzip -q "$d/s.zip" -d "$d/u" ;;
               *)     SB_TAG="$(release_asset SagerNet/sing-box "$1" "$d/s.tgz")"; tar -xzf "$d/s.tgz" -C "$d/u" ;; esac
  cp -R "$d"/u/*/. "$2/"
}

step "Ядра VPN"
CORES="$RES/cores"
rm -rf "$CORES"; mkdir -p "$CORES/xray" "$CORES/sing-box"
case "$PLATFORM" in
win64)
  get_xray 'Xray-windows-64\.zip' "$CORES/xray"
  get_singbox 'sing-box-[0-9.]+-windows-amd64\.zip' "$CORES/sing-box"
  [ -f "$CORES/sing-box/sing-box.exe" ] && [ -f "$CORES/xray/xray.exe" ] || { echo "Нет ядер VPN"; exit 1; }
  ;;
linux64)
  get_xray 'Xray-linux-64\.zip' "$CORES/xray"
  get_singbox 'sing-box-[0-9.]+-linux-amd64\.tar\.gz' "$CORES/sing-box"
  chmod 755 "$CORES/xray/xray" "$CORES/sing-box/sing-box"
  ;;
mac)
  # по ядру на каждую архитектуру, затем склеить в одно (Universal)
  get_xray 'Xray-macos-arm64-v8a\.zip' "$STAGE/xa"
  get_xray 'Xray-macos-64\.zip' "$STAGE/xi"
  cp "$STAGE/xa/geoip.dat" "$STAGE/xa/geosite.dat" "$CORES/xray/" 2>/dev/null || true
  "$LIPO" -create "$STAGE/xa/xray" "$STAGE/xi/xray" -output "$CORES/xray/xray"
  get_singbox 'sing-box-[0-9.]+-darwin-arm64\.tar\.gz' "$STAGE/sa"
  get_singbox 'sing-box-[0-9.]+-darwin-amd64\.tar\.gz' "$STAGE/si"
  "$LIPO" -create "$STAGE/sa/sing-box" "$STAGE/si/sing-box" -output "$CORES/sing-box/sing-box"
  cp "$STAGE/xa/LICENSE" "$CORES/xray/" 2>/dev/null || true
  cp "$STAGE/sa/LICENSE" "$CORES/sing-box/" 2>/dev/null || true
  chmod 755 "$CORES/xray/xray" "$CORES/sing-box/sing-box"
  "$LIPO" -info "$CORES/xray/xray" "$CORES/sing-box/sing-box"
  ;;
esac
echo "    Xray-core $XRAY_TAG, sing-box $SB_TAG"

# ───────── Фильтры ─────────
step "Списки фильтров"
mkdir -p "$RES/nlui/filters"
fetch_list() {
  local id="$1"; shift
  for u in "$@"; do
    if curl -fsSL --retry 3 -o "$RES/nlui/filters/$id.txt" "$u"; then echo "    $id"; return 0; fi
  done
  echo "    $id: не скачан (браузер скачает сам)"
  rm -f "$RES/nlui/filters/$id.txt"
}
fetch_list easylist https://easylist.to/easylist/easylist.txt https://easylist-downloads.adblockplus.org/easylist.txt
fetch_list easyprivacy https://easylist.to/easylist/easyprivacy.txt https://easylist-downloads.adblockplus.org/easyprivacy.txt
fetch_list ruadlist https://easylist-downloads.adblockplus.org/advblock.txt
fetch_list rucounters https://easylist-downloads.adblockplus.org/cntblock.txt
fetch_list adguard-base https://filters.adtidy.org/extension/ublock/filters/2_without_easylist.txt
fetch_list adguard-russian https://filters.adtidy.org/extension/ublock/filters/1.txt
fetch_list adguard-tracking https://filters.adtidy.org/extension/ublock/filters/3.txt
cp "$ROOT/ui/nlui/content/lib/netloom-rules.txt" "$RES/nlui/filters/netloom-rules.txt"

step "Списки опасных сайтов"
fetch_list urlhaus https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt https://curbengh.github.io/malware-filter/urlhaus-filter-online.txt
fetch_list phishing https://malware-filter.gitlab.io/malware-filter/phishing-filter.txt https://curbengh.github.io/malware-filter/phishing-filter.txt

step "Лицензии"
cp "$ROOT/LICENSE" "$RES/LICENSE.txt"
cat > "$RES/THIRD-PARTY.txt" <<TXT
NetLoom $VER использует:
- движок Gecko ESR $ENGINE_VER (Mozilla), MPL-2.0 — https://www.mozilla.org/MPL/2.0/
- Xray-core $XRAY_TAG, MPL-2.0 — https://github.com/XTLS/Xray-core
- sing-box $SB_TAG, GPL-3.0-or-later — https://github.com/SagerNet/sing-box
- списки фильтров EasyList, EasyPrivacy, RU AdList, AdGuard Base/Russian/Tracking Protection — лицензии в заголовках списков
- списки опасных сайтов malware-filter (URLhaus от abuse.ch, фишинг, нежелательные программы), CC0/CC BY-SA
Исходный код NetLoom: https://github.com/uproxe/NetLoom
TXT
echo "$ENGINE_VER" > "$OUT/ENGINE_VERSION"

# ───────── Упаковка ─────────
case "$PLATFORM" in
win64)
  step "Windows: архив и установщик"
  NAME="NetLoom-$VER-windows-x64"
  mv "$APP" "$STAGE/NetLoom"; APP="$STAGE/NetLoom"
  rm -f "$OUT/$NAME.zip"
  (cd "$STAGE" && zip -qr9 "$OUT/$NAME.zip" NetLoom)
  makensis -V2 -INPUTCHARSET UTF8 \
    -DVERSION="$VER" -DSRCDIR="$APP" -DBRANDING="$ROOT/engine/branding" \
    -DOUTFILE="$OUT/$NAME-setup.exe" "$ROOT/tools/windows/netloom.nsi"
  ;;
linux64)
  step "Linux: пакет .deb"
  PKG="$STAGE/deb"
  mkdir -p "$PKG/DEBIAN" "$PKG/usr/lib" "$PKG/usr/bin" "$PKG/usr/share/applications"
  mv "$APP" "$PKG/usr/lib/netloom"
  ln -s ../lib/netloom/netloom "$PKG/usr/bin/netloom"
  cp "$ROOT/tools/linux/netloom.desktop" "$PKG/usr/share/applications/netloom.desktop"
  for s in 16 22 24 32 48 64 128 256; do
    mkdir -p "$PKG/usr/share/icons/hicolor/${s}x${s}/apps"
    cp "$ROOT/engine/branding/default$s.png" "$PKG/usr/share/icons/hicolor/${s}x${s}/apps/netloom.png"
  done
  mkdir -p "$PKG/usr/share/icons/hicolor/scalable/apps"
  cp "$ROOT/branding/icon.svg" "$PKG/usr/share/icons/hicolor/scalable/apps/netloom.svg"
  mkdir -p "$PKG/usr/share/doc/netloom"
  cp "$PKG/usr/lib/netloom/THIRD-PARTY.txt" "$PKG/usr/share/doc/netloom/THIRD-PARTY.txt"
  SIZE="$(du -sk "$PKG/usr" | cut -f1)"
  sed -e "s/@VERSION@/$VER/" -e "s/@SIZE@/$SIZE/" "$ROOT/tools/linux/control" > "$PKG/DEBIAN/control"
  install -m 755 "$ROOT/tools/linux/postinst" "$PKG/DEBIAN/postinst"
  install -m 755 "$ROOT/tools/linux/prerm" "$PKG/DEBIAN/prerm"
  find "$PKG" -type d -exec chmod 755 {} +
  dpkg-deb --root-owner-group -Zxz --build "$PKG" "$OUT/netloom_${VER}_amd64.deb"
  dpkg-deb --info "$OUT/netloom_${VER}_amd64.deb"
  ;;
mac)
  step "macOS: значок, подпись и образ .dmg"
  cp "$ROOT/engine/branding/firefox.icns" "$RES/firefox.icns"
  cp "$ROOT/engine/branding/document.icns" "$RES/document.icns"
  NAME="NetLoom-$VER-macos-universal.dmg"
  rm -f "$OUT/$NAME"
  if [ "$(uname)" = Darwin ]; then
    # каталог значков macOS (Assets.car) из нашего значка
    ICON="$STAGE/icon"; mkdir -p "$ICON/Assets.xcassets/AppIcon.appiconset" "$ICON/out"
    python3 - "$ICON/Assets.xcassets/AppIcon.appiconset" <<'PY'
import json, sys
d = sys.argv[1]
images = []
for pt in (16, 32, 128, 256, 512):
    for scale in (1, 2):
        images.append({"idiom": "mac", "size": f"{pt}x{pt}", "scale": f"{scale}x", "filename": f"icon_{pt}x{pt}@{scale}x.png"})
json.dump({"images": images, "info": {"version": 1, "author": "xcode"}}, open(d + "/Contents.json", "w"), indent=1)
json.dump({"info": {"version": 1, "author": "xcode"}}, open(d + "/../Contents.json", "w"))
PY
    for pt in 16 32 128 256 512; do
      for scale in 1 2; do
        px=$((pt * scale))
        rsvg-convert -w $px -h $px "$ROOT/branding/$([ $px -le 24 ] && echo icon-small || echo icon).svg" \
          -o "$ICON/Assets.xcassets/AppIcon.appiconset/icon_${pt}x${pt}@${scale}x.png"
      done
    done
    if xcrun actool --compile "$ICON/out" --platform macosx --minimum-deployment-target 10.15 \
         --app-icon AppIcon --output-partial-info-plist "$ICON/partial.plist" \
         "$ICON/Assets.xcassets" >/dev/null && [ -f "$ICON/out/Assets.car" ]; then
      cp "$ICON/out/Assets.car" "$RES/Assets.car"
      /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$APP/Contents/Info.plist" 2>/dev/null || true
      /usr/libexec/PlistBuddy -c "Add :CFBundleIconName string AppIcon" "$APP/Contents/Info.plist"
    fi
    # своя подпись без сертификата Apple (ad-hoc): без неё программа не запустится на Apple Silicon
    xattr -cr "$APP"
    codesign --force --deep --sign - --timestamp=none "$APP"
    codesign --verify --deep --strict "$APP" && echo "    подпись в порядке"
    DMGROOT="$STAGE/dmg"; mkdir -p "$DMGROOT"
    mv "$APP" "$DMGROOT/NetLoom.app"
    ln -s /Applications "$DMGROOT/ "
    cp "$ROOT/tools/macos/README.txt" "$DMGROOT/README.txt"
    hdiutil create -volname "NetLoom" -srcfolder "$DMGROOT" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$OUT/$NAME"
  else
    # значок берётся из firefox.icns: чужой каталог Assets.car убираем
    rm -f "$RES/Assets.car"
    python3 - "$APP/Contents/Info.plist" <<'PY'
import plistlib, sys
p = sys.argv[1]
d = plistlib.load(open(p, "rb"))
d.pop("CFBundleIconName", None)
d["CFBundleIconFile"] = "firefox.icns"
plistlib.dump(d, open(p, "wb"))
PY
    # своя подпись без сертификата Apple (ad-hoc): без неё программа не запустится на Apple Silicon
    "$MT/rcodesign" sign "$APP" >/dev/null
    "$MT/rcodesign" verify "$APP/Contents/MacOS/netloom" >/dev/null 2>&1 && echo "    подпись в порядке" || echo "    (проверка подписи rcodesign недоступна)"
    DMGROOT="$STAGE/dmg"; mkdir -p "$DMGROOT"
    mv "$APP" "$DMGROOT/NetLoom.app"
    cp "$ROOT/tools/macos/README.txt" "$DMGROOT/README.txt"
    chmod -R a+rX,a-st,u+w,go-w "$DMGROOT"
    HFS="$STAGE/staged.hfs"
    SIZE=$(( $(du -s -k "$DMGROOT" | cut -f1) / 1000 * 102 / 100 + 16 ))
    dd if=/dev/zero of="$HFS" bs=1M count=$SIZE status=none
    "$MT/hfsplus/newfs_hfs" -v NetLoom "$HFS"
    "$MT/dmg/hfsplus" "$HFS" addall "$DMGROOT" >/dev/null
    "$MT/dmg/hfsplus" "$HFS" symlink "/ " /Applications
    "$MT/dmg/dmg" build "$HFS" "$OUT/$NAME" >/dev/null
    rm -f "$HFS"
  fi
  ls -la "$OUT/$NAME"
  ;;
esac
rm -rf "$STAGE"
ls -la "$OUT"
