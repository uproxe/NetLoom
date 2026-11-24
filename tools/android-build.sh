#!/usr/bin/env bash
# Сборка APK: bash tools/android-build.sh <arm64-v8a|x86_64> <gv> <agp> <sdk_major> <sdk_minor>
# Результат: android/app/build/outputs/apk/release/app-release.apk
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ABI="$1"; GV="$2"; AGP="$3"; MAJOR="$4"; MINOR="$5"
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null 2>&1 || true
bash "$ROOT/tools/android-prepare.sh" "$ABI"
gradle -p "$ROOT/android" --no-daemon assembleRelease -Pabi="$ABI" \
  -PgeckoviewVersion="$GV" -PagpVersion="$AGP" -PcompileSdkMajor="$MAJOR" -PcompileSdkMinor="$MINOR"
