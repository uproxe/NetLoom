#!/usr/bin/env bash
# Версии для сборки Android: последний GeckoView (движок), какая Android SDK ему нужна,
# последние стабильные Android Gradle Plugin 9.x и Gradle 9.x. Печатает строки ключ=значение.
set -euo pipefail
GV="$(curl -fsSL https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/maven-metadata.xml | grep -oP '(?<=<release>)[^<]+')"
TMP="$(mktemp -d)"
curl -fsSL -o "$TMP/gv.aar" "https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/$GV/geckoview-$GV.aar"
META="$(unzip -p "$TMP/gv.aar" META-INF/com/android/build/gradle/aar-metadata.properties 2>/dev/null | tr -d '\r' || true)"
rm -rf "$TMP"
AGP="$(curl -fsSL https://dl.google.com/dl/android/maven2/com/android/tools/build/gradle/maven-metadata.xml \
  | grep -oP '(?<=<version>)9\.[0-9]+\.[0-9]+(?=</version>)' | sort -V | tail -1)"
GRADLE="$(curl -fsSL https://services.gradle.org/versions/all | python3 -c "
import json, sys
v = [x['version'] for x in json.load(sys.stdin)
     if x['version'].startswith('9.') and not (x['snapshot'] or x['nightly'] or x['releaseNightly'] or x['broken'] or x['rcFor'] or x['milestoneFor'])]
print(sorted(v, key=lambda s: [int(p) for p in s.split('.')])[-1])")"
echo "gv=$GV"
echo "sdk_major=$(sed -n 's/^minCompileSdk=//p' <<<"$META" | grep . || echo 36)"
echo "sdk_minor=$(sed -n 's/^minCompileMinorSdk=//p' <<<"$META" | grep . || echo 0)"
echo "agp=$AGP"
echo "gradle=$GRADLE"
