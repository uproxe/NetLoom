#!/usr/bin/env bash
# NetLoom — сборка движка (Gecko ESR) для одной платформы.
# Всё собирается на Linux (Ubuntu), как у Mozilla: Windows и macOS — кросс-сборкой.
#
#   bash engine/build.sh <платформа> [версия]
#     платформа: win64 | linux64 | mac-arm64 | mac-x64
#     версия:    например 153.8.0 (пусто — последняя ESR)
#
# Результат в out/:  netloom-engine-<версия>-<платформа>.(zip|tar.xz|dmg)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM="${1:?укажите платформу: win64 | linux64 | mac-arm64 | mac-x64}"
case "$PLATFORM" in win64|linux64|mac-arm64|mac-x64) ;; *) echo "Неизвестная платформа: $PLATFORM"; exit 2;; esac
WORK="${NETLOOM_WORK:-$ROOT/work}"
OUT="${NETLOOM_OUT:-$ROOT/out}"
CROSS="$HOME/win-cross"
MACCROSS="$HOME/mac-cross"
L10N_BASE="$HOME/.mozbuild/l10n-central"
VERSION="${2:-}"
[ -n "$VERSION" ] || VERSION="$(bash "$ROOT/engine/latest-version.sh")"

step() { echo; echo "==> $*"; }

step "Движок $VERSION для $PLATFORM"
mkdir -p "$WORK" "$OUT"
SRC="$WORK/src"

# ───────── 1. Исходники ─────────
step "1/7 Исходники Gecko ESR"
TARBALL="firefox-${VERSION}esr.source.tar.xz"
BASEURL="https://archive.mozilla.org/pub/firefox/releases/${VERSION}esr"
cd "$WORK"
if [ ! -f "$TARBALL" ]; then
  curl -fL --retry 5 --retry-delay 10 -o "$TARBALL.part" "$BASEURL/source/$TARBALL"
  mv "$TARBALL.part" "$TARBALL"
fi
curl -fsSL --retry 5 -o SHA512SUMS "$BASEURL/SHA512SUMS"
EXPECTED="$(awk -v f="source/$TARBALL" '$2 == f { print $1 }' SHA512SUMS)"
[ -n "$EXPECTED" ] || { echo "Нет контрольной суммы для $TARBALL"; exit 1; }
echo "$EXPECTED  $TARBALL" | sha512sum -c -
rm -rf "$SRC"
mkdir -p "$SRC"
tar -xJf "$TARBALL" -C "$SRC" --strip-components=1
rm -f "$TARBALL"   # место на диске CI ограничено

# ───────── 2. Бренд и правки ─────────
step "2/7 Бренд NetLoom и правки"
cp -a "$SRC/browser/branding/unofficial" "$SRC/browser/branding/netloom"
cp -a "$ROOT/engine/branding/." "$SRC/browser/branding/netloom/"
shopt -s nullglob
for p in "$ROOT"/engine/patches/*.patch; do
  echo "    патч: $(basename "$p")"
  patch -d "$SRC" -p1 --forward --no-backup-if-mismatch < "$p"
done
shopt -u nullglob
cat "$ROOT/engine/mozconfig.common" "$ROOT/engine/mozconfig.$PLATFORM" > "$SRC/mozconfig"

# никакого Mozilla в свойствах файлов (exe/dll), папке профиля и реестре
find "$SRC" -name module.ver -not -path '*/test*' -print0 | xargs -0 sed -i \
  -e 's/^WIN32_MODULE_COMPANYNAME=.*/WIN32_MODULE_COMPANYNAME=NetLoom/' \
  -e 's/^WIN32_MODULE_COPYRIGHT=.*/WIN32_MODULE_COPYRIGHT=NetLoom. MPL 2.0/' \
  -e 's/^WIN32_MODULE_TRADEMARKS=.*/WIN32_MODULE_TRADEMARKS=NetLoom/'
sed -i -e 's/"WIN32_MODULE_COMPANYNAME", "Mozilla Foundation"/"WIN32_MODULE_COMPANYNAME", "NetLoom"/' \
       -e 's/"WIN32_MODULE_TRADEMARKS", "Mozilla"/"WIN32_MODULE_TRADEMARKS", "NetLoom"/' "$SRC/config/create_rc.py"
sed -i 's/imply_option("MOZ_APP_VENDOR", "Mozilla")/imply_option("MOZ_APP_VENDOR", "NetLoom")/' "$SRC/browser/moz.configure"
grep -q 'imply_option("MOZ_APP_VENDOR", "NetLoom")' "$SRC/browser/moz.configure" || echo "::warning::не удалось сменить MOZ_APP_VENDOR"

# macOS: значок программы берётся из firefox.icns (наш), а не из каталога Assets.car (чужой)
python3 - "$SRC/browser/app/macbuild/Contents/Info.plist.in" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
s = re.sub(r"\s*<key>CFBundleIconName</key>\s*<string>AppIcon</string>", "", s)
open(p, "w", encoding="utf-8").write(s)
PY

# ───────── 3. Русский язык ─────────
step "3/7 Русская локализация"
L10N_REV="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['ru']['revision'])" "$SRC/browser/locales/l10n-changesets.json")"
echo "    firefox-l10n @ $L10N_REV"
rm -rf "$WORK/l10n" "$L10N_BASE/ru"
mkdir -p "$L10N_BASE"
git init -q "$WORK/l10n"
git -C "$WORK/l10n" remote add origin https://github.com/mozilla-l10n/firefox-l10n
git -C "$WORK/l10n" sparse-checkout set --no-cone /ru/
git -C "$WORK/l10n" fetch -q --depth 1 --filter=blob:none origin "$L10N_REV"
git -C "$WORK/l10n" checkout -q FETCH_HEAD
mv "$WORK/l10n/ru" "$L10N_BASE/ru"
rm -rf "$WORK/l10n"

# убрать слова Firefox и Mozilla из всех текстов интерфейса (английских и русских)
mapfile -t EN_DIRS < <(find "$SRC" -type d -path '*/locales/en-US' -not -path '*/test*' -not -path '*/third_party/*')
python3 "$ROOT/tools/debrand.py" "${EN_DIRS[@]}" "$L10N_BASE/ru"

# ───────── 4. Инструменты кросс-сборки ─────────
case "$PLATFORM" in
win64)
  step "4/7 Инструменты кросс-сборки (wine, Windows SDK)"
  mkdir -p "$CROSS"
  if [ ! -x "$CROSS/wine/bin/wine" ]; then
    curl -fL --retry 5 "https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/gecko.cache.level-3.toolchains.v3.linux64-wine.latest/artifacts/public/build/wine.tar.zst" \
      | tar --zstd -x -C "$CROSS"
  fi
  VS_YAML="$(cd "$SRC" && ls build/vs/vs20*.yaml | grep -v aarch64 | sort | tail -1)"
  VS_STAMP="$CROSS/vs/.netloom-$(basename "$VS_YAML" .yaml)-$(sha256sum "$SRC/$VS_YAML" | cut -c1-12)"
  if [ ! -f "$VS_STAMP" ]; then
    rm -rf "$CROSS/vs"
    (cd "$SRC" && ./mach python --virtualenv build taskcluster/scripts/misc/get_vs.py "$VS_YAML" "$CROSS/vs")
    touch "$VS_STAMP"
  fi
  chmod -R +x "$CROSS/vs" || true
  ;;
mac-*)
  step "4/7 Инструменты кросс-сборки (cctools, dmg)"
  if [ ! -x "$MACCROSS/cctools/bin/x86_64-apple-darwin-ld" ] || [ ! -x "$MACCROSS/dmg/dmg" ] || [ ! -x "$MACCROSS/hfsplus/newfs_hfs" ]; then
    rm -rf "$MACCROSS"; mkdir -p "$MACCROSS"
    (cd "$SRC" && ./mach artifact toolchain --from-build linux64-cctools-port linux64-libdmg linux64-hfsplus && mv cctools dmg hfsplus "$MACCROSS/")
  fi
  ls "$MACCROSS/cctools/bin" | head -3
  ;;
*)
  step "4/7 Кросс-инструменты не нужны"
  ;;
esac

# ───────── 5. Подготовка ─────────
step "5/7 Подготовка системы сборки"
cd "$SRC"
./mach --no-interactive bootstrap --application-choice browser
case "$PLATFORM" in
  win64)     RUST_TARGET=x86_64-pc-windows-msvc ;;
  mac-arm64) RUST_TARGET=aarch64-apple-darwin ;;
  mac-x64)   RUST_TARGET=x86_64-apple-darwin ;;
  *)         RUST_TARGET= ;;
esac
if [ -n "$RUST_TARGET" ] && command -v rustup >/dev/null 2>&1; then rustup target add "$RUST_TARGET"; fi

{
  echo
  echo "# добавлено engine/build.sh"
  case "$PLATFORM" in
  win64)
    REDIST="$(ls -d "$CROSS"/vs/VC/Redist/MSVC/14.*/x64/Microsoft.VC*.CRT 2>/dev/null | sort -V | tail -1 || true)"
    [ -n "$REDIST" ] && echo "export WIN32_REDIST_DIR=\"$REDIST\""
    CLANG_LIB="$(ls -d "$HOME"/.mozbuild/clang/lib/clang/*/lib/windows 2>/dev/null | tail -1 || true)"
    [ -n "$CLANG_LIB" ] && echo "export LIB=\"$CLANG_LIB\""
    ;;
  mac-*)
    echo "mk_add_options \"export PATH=$MACCROSS/cctools/bin:\$PATH\""
    echo "mk_add_options \"export LD_LIBRARY_PATH=$HOME/.mozbuild/clang/lib\""
    echo "export MKFSHFS=$MACCROSS/hfsplus/newfs_hfs"
    echo "export DMG_TOOL=$MACCROSS/dmg/dmg"
    echo "export HFS_TOOL=$MACCROSS/dmg/hfsplus"
    ;;
  esac
} >> "$SRC/mozconfig"
echo "    mozconfig:"; sed 's/^/      /' "$SRC/mozconfig" | tail -8

# ───────── 6. Сборка ─────────
step "6/7 Сборка (это долго)"
ulimit -n 4096 || true
if [ -n "${NETLOOM_BUILD_TIMEOUT:-}" ]; then
  # 124 = не уложились во время; кэш компиляции сохранится, следующий запуск продолжит
  timeout --signal=INT --kill-after=2m "$NETLOOM_BUILD_TIMEOUT" ./mach build
else
  ./mach build
fi

# ───────── 7. Пакет ─────────
step "7/7 Упаковка (английский + русский)"
DIST="$SRC/obj-netloom/dist"
if ./mach package-multi-locale --locales en-US ru; then
  echo "    многоязычный пакет собран"
else
  echo "::warning::Многоязычная упаковка не удалась — собираю английский пакет и отдельный языковой пакет"
  ./mach package
  ./mach build langpack-ru || true
fi
case "$PLATFORM" in
  win64)   PKG="$(ls -t "$DIST"/netloom-*.win64.zip | head -1)"; EXT=zip ;;
  linux64) PKG="$(ls -t "$DIST"/netloom-*.linux-x86_64.tar.* | head -1)"; EXT="tar.${PKG##*.tar.}" ;;
  mac-*)   PKG="$(ls -t "$DIST"/netloom-*.dmg | head -1)"; EXT=dmg ;;
esac
NAME="netloom-engine-${VERSION}-${PLATFORM}.${EXT}"
cp "$PKG" "$OUT/$NAME"
for x in "$DIST"/*.langpack.xpi "$DIST"/*/*.langpack.xpi; do
  [ -f "$x" ] && cp "$x" "$OUT/netloom-engine-${VERSION}-${PLATFORM}.ru.langpack.xpi"
done
ls -la "$OUT"
echo "$VERSION" > "$OUT/VERSION"
step "Готово: $OUT/$NAME"
