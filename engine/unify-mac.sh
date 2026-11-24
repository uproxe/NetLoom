#!/usr/bin/env bash
# NetLoom — объединяет движки macOS для Apple Silicon и Intel в один (Universal).
# Так же делает Mozilla: распаковать оба .dmg, склеить программы lipo, собрать новый .dmg.
#
#   bash engine/unify-mac.sh <версия> <движок-arm64.dmg> <движок-x64.dmg>
#
# Результат: out/netloom-engine-<версия>-mac-universal.dmg
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$1"
ARM="$(realpath "$2")"
X64="$(realpath "$3")"
WORK="${NETLOOM_WORK:-$ROOT/work}"
OUT="${NETLOOM_OUT:-$ROOT/out}"
SRC="$WORK/src"
step() { echo; echo "==> $*"; }
mkdir -p "$WORK" "$OUT"

step "Исходники Gecko ESR $VERSION (нужны инструменты Mozilla)"
TARBALL="firefox-${VERSION}esr.source.tar.xz"
BASEURL="https://archive.mozilla.org/pub/firefox/releases/${VERSION}esr"
cd "$WORK"
curl -fL --retry 5 --retry-delay 10 -o "$TARBALL" "$BASEURL/source/$TARBALL"
curl -fsSL --retry 5 -o SHA512SUMS "$BASEURL/SHA512SUMS"
EXPECTED="$(awk -v f="source/$TARBALL" '$2 == f { print $1 }' SHA512SUMS)"
echo "$EXPECTED  $TARBALL" | sha512sum -c -
rm -rf "$SRC"; mkdir -p "$SRC"
tar -xJf "$TARBALL" -C "$SRC" --strip-components=1
rm -f "$TARBALL"
cd "$SRC"

step "Инструмент lipo"
./mach artifact toolchain --from-build linux64-cctools-port
export LIPO="$SRC/cctools/bin/x86_64-apple-darwin-lipo"
[ -x "$LIPO" ] || { echo "нет $LIPO"; exit 1; }

step "Распаковка"
rm -rf "$WORK/x64" "$WORK/aarch64"
./mach python -m mozbuild.action.unpack_dmg "$X64" "$WORK/x64"
./mach python -m mozbuild.action.unpack_dmg "$ARM" "$WORK/aarch64"
ls "$WORK/x64" "$WORK/aarch64"

step "Объединение"
./mach python toolkit/mozapps/installer/unify.py "$WORK"/x64/*.app "$WORK"/aarch64/*.app

step "Образ .dmg"
NAME="netloom-engine-${VERSION}-mac-universal.dmg"
./mach python -m mozbuild.action.make_dmg --volume-name NetLoom "$WORK/x64" "$OUT/$NAME"
ls -la "$OUT"
step "Готово: $OUT/$NAME"
