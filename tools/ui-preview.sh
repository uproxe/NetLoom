#!/usr/bin/env bash
# Запускает движок с интерфейсом NetLoom в виртуальном экране и делает снимки.
#   bash tools/ui-preview.sh <папка движка> <папка для снимков>
set -uo pipefail
APP="$1"
OUT="$2"
BIN="$APP/firefox"
[ -x "$APP/netloom" ] && BIN="$APP/netloom"
mkdir -p "$OUT"
export DISPLAY=:99
Xvfb :99 -screen 0 1366x860x24 >/dev/null 2>&1 &
sleep 2
PROFILE="$(mktemp -d)"
cat > "$PROFILE/user.js" <<'PREFS'
user_pref("devtools.console.stdout.chrome", true);
user_pref("browser.dom.window.dump.enabled", true);
user_pref("netloom.primaryPassword.prompt", false);
user_pref("browser.startup.page", 1);
PREFS
"$BIN" --profile "$PROFILE" >"$OUT/console.txt" 2>&1 &
sleep 30
WID="$(xdotool search --onlyvisible --class "firefox|netloom|Navigator" 2>/dev/null | tail -1)"
if [ -n "$WID" ]; then
  xdotool windowmove "$WID" 0 0 windowsize "$WID" 1366 860 || true
  sleep 3
fi
shot() { import -window root "$OUT/$1.png"; echo "снимок $1"; }
shot 1-okno
open_tab() { "$BIN" --profile "$PROFILE" -new-tab "$1" >/dev/null 2>&1; sleep 7; }
open_tab "https://example.com/"
shot 2-sait
open_tab "chrome://netloom/content/settings.html"
shot 3-nastroiki
xdotool key --clearmodifiers End; sleep 1
shot 4-nastroiki-niz
open_tab "chrome://netloom/content/vpn.html"
shot 5-vpn
if [ -n "$WID" ]; then
  xdotool key --window "$WID" --clearmodifiers ctrl+t; sleep 4
  shot 6-novaya-vkladka
fi
pkill -f "$BIN" || true
sleep 2
echo "---- сообщения NetLoom и ошибки ----"
grep -aiE "netloom|error|exception" "$OUT/console.txt" | grep -v "^$" | head -80 || true
