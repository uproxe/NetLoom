#!/usr/bin/env bash
# Описание релиза на русском: что скачать и как установить. Перечисляет только то, что уже собрано.
#   bash tools/release-notes.sh <тег релиза>
set -euo pipefail
TAG="$1"
REPO="${GITHUB_REPOSITORY:-uproxe/NetLoom}"
# черновики не видны по адресу …/releases/tags/<тег>, поэтому ищем в общем списке
ASSETS="$(gh api "repos/$REPO/releases?per_page=100" --jq ".[] | select(.tag_name == \"$TAG\") | .assets[] | \"\\(.name)\\t\\(.label)\\t\\(.size)\"")"
has() { grep -Eq "^$1	" <<<"$ASSETS"; }
size() { awk -F'\t' -v n="$1" '$1 == n { printf "%.0f МБ", $3 / 1048576 }' <<<"$ASSETS"; }
engine() { awk -F'\t' -v n="$1" '$1 == n { if (match($2, /движок [0-9.]+/)) print substr($2, RSTART + 7, RLENGTH - 7) }' <<<"$ASSETS"; }
link() { echo "https://github.com/$REPO/releases/download/$TAG/$1"; }
VER="${TAG#v}"

WIN="NetLoom-$VER-windows-x64-setup.exe"; WINZIP="NetLoom-$VER-windows-x64.zip"
DEB="netloom_${VER}_amd64.deb"; DMG="NetLoom-$VER-macos-universal.dmg"
APK="NetLoom-$VER-android-arm64.apk"; APK32="NetLoom-$VER-android-arm32.apk"
EV=""
for f in "$WIN" "$DEB" "$DMG"; do [ -n "$EV" ] || EV="$(engine "$f")"; done

cat <<TXT
Приватный браузер со своим интерфейсом, встроенной блокировкой рекламы и VPN.
Без аккаунтов и телеметрии.${EV:+ Движок Gecko ESR $EV.}

## Скачать

| Система | Файл | Размер |
|---|---|---|
TXT
has "$WIN"    && echo "| Windows 10 и 11 (64 бит) | [Установщик]($(link "$WIN")) | $(size "$WIN") |"
has "$WINZIP" && echo "| Windows без установки | [Архив .zip]($(link "$WINZIP")) | $(size "$WINZIP") |"
has "$DEB"    && echo "| Linux: Ubuntu, Debian, Mint, elementary OS | [Пакет .deb]($(link "$DEB")) | $(size "$DEB") |"
has "$DMG"    && echo "| macOS 10.15 и новее (Apple M1–M4 и Intel) | [Образ .dmg]($(link "$DMG")) | $(size "$DMG") |"
has "$APK"    && echo "| Android 8 и новее (64 бит) | [Приложение .apk]($(link "$APK")) | $(size "$APK") |"
has "$APK32"  && echo "| Android, старые 32-битные телефоны | [Приложение .apk]($(link "$APK32")) | $(size "$APK32") |"

cat <<'TXT'

## Как установить

**Windows.** Запустите установщик — права администратора не нужны. Если Windows
покажет окно «Система Windows защитила ваш компьютер», нажмите «Подробнее» →
«Выполнить в любом случае» (у NetLoom пока нет платной цифровой подписи).
Чтобы сделать NetLoom браузером по умолчанию: «Настройки» NetLoom → «Основное».

**Linux.** Откройте файл .deb двойным щелчком (Центр приложений) или в терминале:
`sudo apt install ./netloom_*_amd64.deb`

**macOS.** Откройте образ и перетащите NetLoom в «Программы». При первом запуске
macOS предупредит, что не может проверить программу (у NetLoom нет платного
сертификата Apple): откройте «Системные настройки» → «Конфиденциальность и
безопасность» → «Всё равно открыть». Это нужно один раз. Подробнее — в файле
«Как открыть» внутри образа.

**Android.** Скачайте файл .apk на телефон и откройте его. Телефон попросит
разрешить установку из этого источника — разрешите.

## Что внутри

- Блокировка рекламы и счётчиков: базы AdGuard и EasyList, включая русские.
- VPN и прокси: VLESS, VMess, Trojan, Shadowsocks, Hysteria2, TUIC, WireGuard,
  AnyTLS, SSH, SOCKS5, HTTP, подписки. Российские сайты можно открывать напрямую,
  для любого сайта можно выбрать: через VPN или напрямую.
- Защита от опасных сайтов без Google: списки проверяются на самом устройстве,
  адреса никуда не отправляются.
- Главный пароль для сохранённых паролей, импорт закладок из Яндекс Браузера,
  Chrome, Safari и Firefox, экспорт закладок и паролей.
- Обновляется только движок — исправлениями безопасности.
TXT
