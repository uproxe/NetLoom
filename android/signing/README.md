# Подпись приложения Android

`netloom.jks` — открытый ключ сборки: им подписываются APK, собранные в GitHub Actions,
пока в настройках репозитория не задан свой секретный ключ. Пароль: `netloom-public`.

Чтобы подписывать своим ключом, добавьте в Settings → Secrets and variables → Actions:

* `ANDROID_KEYSTORE_BASE64` — файл .jks в base64;
* `ANDROID_KEYSTORE_PASSWORD` — пароль хранилища;
* `ANDROID_KEY_ALIAS` — имя ключа (необязательно, по умолчанию `netloom`).

Внимание: после смены ключа установленный NetLoom не обновится поверх — его нужно
удалить и установить заново.
