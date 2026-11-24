#!/usr/bin/env bash
# NetLoom — сборка движка (Gecko ESR) для Windows x64.
# Работает на Linux (Ubuntu): так же собирает Mozilla в своей инфраструктуре.
#
#   bash engine/build.sh [версия]      например: bash engine/build.sh 153.7.0
#
# Результат: out/netloom-engine-<версия>-win64.zip
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${NETLOOM_WORK:-$ROOT/work}"
OUT="${NETLOOM_OUT:-$ROOT/out}"
CROSS="$HOME/win-cross"
L10N_BASE="$HOME/.mozbuild/l10n-central"
VERSION="${1:-}"
[ -n "$VERSION" ] || VERSION="$(bash "$ROOT/engine/latest-version.sh")"

step() { echo; echo "==> $*"; }

step "Версия движка: $VERSION"
mkdir -p "$WORK" "$OUT" "$CROSS"
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
cp "$ROOT/engine/mozconfig" "$SRC/mozconfig"

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

# ───────── 4. Инструменты кросс-сборки ─────────
step "4/7 Инструменты кросс-сборки (wine, Windows SDK)"
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

# ───────── 5. Подготовка ─────────
step "5/7 Подготовка системы сборки"
cd "$SRC"
./mach --no-interactive bootstrap --application-choice browser
if command -v rustup >/dev/null 2>&1; then rustup target add x86_64-pc-windows-msvc; fi

{
  echo
  echo "# добавлено engine/build.sh"
  REDIST="$(ls -d "$CROSS"/vs/VC/Redist/MSVC/14.*/x64/Microsoft.VC*.CRT 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$REDIST" ] && echo "export WIN32_REDIST_DIR=\"$REDIST\""
  CLANG_LIB="$(ls -d "$HOME"/.mozbuild/clang/lib/clang/*/lib/windows 2>/dev/null | tail -1 || true)"
  [ -n "$CLANG_LIB" ] && echo "export LIB=\"$CLANG_LIB\""
} >> "$SRC/mozconfig"
echo "    mozconfig:"; sed 's/^/      /' "$SRC/mozconfig" | tail -8

# ───────── 6. Сборка ─────────
step "6/7 Сборка (это долго)"
ulimit -n 4096 || true
./mach build

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
PKG="$(ls -t "$DIST"/netloom-*.win64.zip | head -1)"
cp "$PKG" "$OUT/netloom-engine-${VERSION}-win64.zip"
find "$DIST" -maxdepth 2 -name '*.langpack.xpi' -exec cp {} "$OUT/" \; || true
ls -la "$OUT"
echo "$VERSION" > "$OUT/VERSION"
step "Готово: $OUT/netloom-engine-${VERSION}-win64.zip"
