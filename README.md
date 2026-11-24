# NetLoom

NetLoom — the web, woven for you.

Приватный браузер на движке Gecko со своим интерфейсом, встроенной блокировкой
рекламы и VPN. Без аккаунтов, без телеметрии, без лишнего: вкладки, адресная
строка и панель закладок.

> Версия 1.0.0: Windows, Linux (.deb), macOS (Universal) и Android.
> Готовые файлы — в разделе [Releases](../../releases). Снимки интерфейса — в ветке [`preview`](../../tree/preview).

## Как устроено

| Часть | Папка | Что это |
|---|---|---|
| Движок | `engine/` | Gecko ESR, собранный из исходников Mozilla с брендом NetLoom: своё имя, иконки, `netloom.exe`. Обновляется только исправлениями безопасности |
| Бренд | `branding/` | Иконка (SVG) и надпись. `tools/make_branding.py` делает из них все картинки для движка |
| Интерфейс | `ui/nlui/` | Свой интерфейс поверх движка: вкладки, адрес, закладки, меню, `about:settings`, панель VPN, новая вкладка `about:start` |
| Служба | `ui/nlui/content/NetLoomService.sys.mjs` | Блокировка рекламы (свой движок фильтров), VPN/прокси с kill switch и правилами сайтов, запуск ядер |
| Ядра VPN | — | Xray-core (VLESS, VMess, Trojan, Shadowsocks, SOCKS5, HTTP) и sing-box (Hysteria2, TUIC, WireGuard, AnyTLS, SSH) — скачиваются при сборке пакета |
| Android | `android/` | Своё приложение на GeckoView: вкладки, адресная строка, закладки, кнопка VPN; блокировка рекламы, защита и VPN — встроенный модуль на тех же библиотеках `ui/nlui/content/lib/` |
| Пакеты | `tools/` | `package.sh` (Windows: установщик и архив, Linux: .deb, macOS: .dmg), `windows/netloom.nsi`, `linux/`, `macos/` |

Сборка идёт в GitHub Actions: движок собирается на Linux для Linux, а для Windows x64
и macOS (Apple Silicon и Intel) — кросс-компиляцией, так же как это делает Mozilla.
Две сборки macOS затем склеиваются в одну Universal.

## Сборка

* **Движок** — workflow «Движок» (`.github/workflows/engine.yml`): Windows, Linux,
  macOS arm64 и x64 параллельно, затем macOS Universal. Запускается вручную или сам
  раз в сутки, если вышла новая версия ESR. Первая сборка идёт 3–5 часов, следующие
  быстрее за счёт кэша.
* **Пакеты** — workflow «Сборка NetLoom»: последний движок + интерфейс + ядра VPN +
  фильтры → установщик и архив для Windows, `.deb` для Linux, `.dmg` для macOS.
* **Android** — workflow «Android»: приложение на последнем GeckoView, раз в неделю
  проверяет новую версию движка.
* Релиз публикуется, когда готовы Windows, Linux и macOS; до этого он черновик.
* **Предпросмотр** — workflow «Предпросмотр интерфейса»: при каждом изменении `ui/`
  запускает тот же Gecko ESR на Linux с интерфейсом NetLoom и кладёт снимки в ветку `preview`.
* Локально на Linux: `bash engine/build.sh linux64` (или `win64`, `mac-arm64`, `mac-x64`;
  нужно ~40 ГБ диска и 16 ГБ памяти).
* Тесты логики: `node tests/test.js`.

## Иконка

Исходник — `branding/icon.svg` (для мелких размеров `branding/icon-small.svg`).
После правки: `python3 tools/make_branding.py` и коммит `engine/branding/`.

## План

- [x] Бренд движка: имя, иконки, файлы
- [x] Сборка движка в GitHub Actions
- [x] Интерфейс: вкладки, адресная строка, закладки, своё меню
- [x] Блокировка рекламы, VPN (VLESS, VMess, Trojan, Shadowsocks, Hysteria2, TUIC, WireGuard, AnyTLS, SSH, SOCKS5, HTTP), подписки
- [x] Настройки: мастер-пароль, cookies, защита от отпечатков, правила сайтов для VPN
- [x] Импорт: Chrome, Firefox, Safari (из файлов), закладки Яндекс Браузера
- [x] Проверка сайтов на вирусы без Google (свои списки, проверка на устройстве)
- [x] Установщик Windows (ярлыки, «браузер по умолчанию»), пакет .deb, образ .dmg
- [x] Android: своё приложение на GeckoView
- [ ] Пароли из Яндекс Браузера
- [ ] Android: сохранение паролей, синхронизация закладок с компьютером
- [ ] Подпись Apple и Microsoft (без неё система предупреждает при первом запуске)

## Лицензия

MPL-2.0, как и движок Gecko.
