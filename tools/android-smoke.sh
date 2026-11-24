#!/usr/bin/env bash
# Проверка NetLoom для Android на эмуляторе: запуск, страница сайта, меню, настройки,
# блокировка опасного сайта. Снимки экрана — в папку shots/.
#   bash tools/android-smoke.sh <apk> <папка снимков>
set -uo pipefail
APK="$1"; SHOTS="$2"
PKG=io.github.uproxe.netloom
mkdir -p "$SHOTS"
shot() { adb exec-out screencap -p > "$SHOTS/$1.png"; echo "снимок $1"; }

# найти элемент на экране по id или тексту и нажать в его центр
tap() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  adb pull /sdcard/ui.xml /tmp/ui.xml >/dev/null 2>&1
  python3 - "$1" <<'PY' | { read -r x y && [ -n "$x" ] && adb shell input tap "$x" "$y" && echo "нажато: $1"; } || echo "не найдено: $1"
import re, sys, xml.etree.ElementTree as ET
want = sys.argv[1]
for n in ET.parse("/tmp/ui.xml").iter("node"):
    if n.get("resource-id", "").endswith(":id/" + want) or n.get("text") == want or n.get("content-desc") == want:
        a, b, c, d = map(int, re.findall(r"\d+", n.get("bounds")))
        print((a + c) // 2, (b + d) // 2)
        break
PY
}

adb install -r "$APK" || exit 1
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null || true
adb logcat -c
adb shell am start -W -n $PKG/.MainActivity
sleep 25
shot 1-start

adb shell am start -W -a android.intent.action.VIEW -d "https://example.com/" -n $PKG/.MainActivity
sleep 15
shot 2-site

tap menu; sleep 2
shot 3-menu
tap "Настройки и VPN"; sleep 8
shot 4-settings
adb shell input swipe 500 1600 500 400 300; sleep 2
shot 5-settings-2

# опасный сайт из тестового списка (его добавляет проверка) — должна открыться страница предупреждения
adb shell am start -W -a android.intent.action.VIEW -d "https://danger-test.invalid/download/setup.exe" -n $PKG/.MainActivity
sleep 10
shot 6-site-2

tap vpn; sleep 4
shot 7-vpn

echo "── журнал приложения ──"
adb logcat -d | grep -E "NetLoom|GeckoConsole|JavaScript Error|E GeckoView|AndroidRuntime|FATAL" | grep -v "^--" | tail -80
adb shell pidof $PKG >/dev/null && echo "приложение работает" || { echo "::error::приложение закрылось"; exit 1; }
