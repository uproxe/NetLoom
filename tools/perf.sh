#!/usr/bin/env bash
# Замер скорости: сколько процессора и памяти тратит браузер на одних и тех же сайтах.
#   bash tools/perf.sh <папка движка Linux> <папка результата> <вариант>=<папка ui или «-»> …
# Вариант с «-» — чистый движок без NetLoom (для сравнения).
# Нужны xvfb и python3. Результат — таблица в <папка результата>/perf.md
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="$(cd "$1" && pwd)"; OUT="$2"; shift 2
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
SITES=(https://lenta.ru/ https://ria.ru/ https://www.rbc.ru/ https://mail.ru/ https://dzen.ru/
       https://habr.com/ru/articles/ https://www.youtube.com/ https://ru.wikipedia.org/wiki/Москва)
LISTS="$OUT/lists"

# списки фильтров — один раз для всех вариантов
mkdir -p "$LISTS"
get() { [ -s "$LISTS/$1.txt" ] || curl -fsSL --retry 3 -o "$LISTS/$1.txt" "$2" || rm -f "$LISTS/$1.txt"; }
get easylist https://easylist.to/easylist/easylist.txt
get easyprivacy https://easylist.to/easylist/easyprivacy.txt
get ruadlist https://easylist-downloads.adblockplus.org/advblock.txt
get rucounters https://easylist-downloads.adblockplus.org/cntblock.txt
get adguard-base https://filters.adtidy.org/extension/ublock/filters/2_without_easylist.txt
get adguard-russian https://filters.adtidy.org/extension/ublock/filters/1.txt
get adguard-tracking https://filters.adtidy.org/extension/ublock/filters/3.txt
get urlhaus https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt
get phishing https://malware-filter.gitlab.io/malware-filter/phishing-filter.txt

measure() {  # <папка программы> → «процессор_сек память_МБ процессов»
  python3 - "$1" <<'PY'
import os, sys
app = os.path.realpath(sys.argv[1])
tick = os.sysconf("SC_CLK_TCK")
cpu = 0.0; pss = 0; n = 0
for pid in filter(str.isdigit, os.listdir("/proc")):
    try:
        if not os.path.realpath(f"/proc/{pid}/exe").startswith(app):
            continue
        st = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
        cpu += (int(st[11]) + int(st[12])) / tick
        for line in open(f"/proc/{pid}/smaps_rollup"):
            if line.startswith("Pss:"):
                pss += int(line.split()[1])
        n += 1
    except Exception:
        pass
print(f"{cpu:.1f} {pss // 1024} {n}")
PY
}

echo "| Вариант | Запуск и загрузка 8 сайтов, сек процессора | Простой 30 с, % процессора | Память (PSS), МБ | Процессов |" > "$OUT/perf.md"
echo "|---|---|---|---|---|" >> "$OUT/perf.md"

for spec in "$@"; do
  name="${spec%%=*}"; ui="${spec#*=}"
  APP="$OUT/app-$name"; PROF="$OUT/profile-$name"
  rm -rf "$APP" "$PROF"; cp -a "$ENGINE" "$APP"; mkdir -p "$PROF/netloom"
  if [ "$ui" != "-" ]; then
    UI_SRC="$ui" bash "$ROOT/tools/apply-ui.sh" "$APP" >/dev/null
    mkdir -p "$APP/nlui/filters"; cp "$LISTS"/*.txt "$APP/nlui/filters/"
  fi
  cat > "$PROF/user.js" <<'JS'
user_pref("netloom.primaryPassword.prompt", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("toolkit.startup.max_resumed_crashes", -1);
user_pref("browser.tabs.warnOnClose", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("browser.tabs.loadInBackground", true);
user_pref("netloom.debug", true);
user_pref("browser.dom.window.dump.enabled", true);
JS
  BIN="$APP/netloom"; [ -x "$BIN" ] || BIN="$APP/firefox"
  Xvfb :91 -screen 0 1366x860x24 >/dev/null 2>&1 & XV=$!
  sleep 1
  DISPLAY=:91 "$BIN" -profile "$PROF" -no-remote "${SITES[@]}" > "$OUT/log-$name.txt" 2>&1 &
  sleep 60
  read -r c1 m1 n1 <<<"$(measure "$APP")"
  sleep 30
  read -r c2 m2 n2 <<<"$(measure "$APP")"
  idle=$(python3 -c "print(round(($c2 - $c1) / 30 * 100))")
  echo "| $name | $c1 | $idle | $m2 | $n2 |" >> "$OUT/perf.md"
  echo "$name: процессор $c1 с, простой $idle %, память $m2 МБ, процессов $n2"
  pkill -f "$APP/" 2>/dev/null; sleep 3; pkill -9 -f "$APP/" 2>/dev/null
  kill $XV 2>/dev/null; wait $XV 2>/dev/null
  grep -E "NetLoom: (фильтры|защита)" "$OUT/log-$name.txt" | sed "s/^/    /" || true
  echo "    страниц со скрытием рекламы: $(grep -c "NetLoom: скрытие рекламы" "$OUT/log-$name.txt")"
done
cat "$OUT/perf.md"
