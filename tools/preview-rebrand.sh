#!/usr/bin/env bash
# Для предпросмотра: накладывает бренд NetLoom на официальный движок Linux —
# те же имя, иконки и тексты без «Firefox/Mozilla», что и в нашей сборке.
#   bash tools/preview-rebrand.sh <папка движка>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$1"
BR="$ROOT/engine/branding"
TMP="$(mktemp -d)"

rebrand_omni() {
  local omni="$1" dir="$TMP/$(basename "$(dirname "$omni")")-omni"
  mkdir -p "$dir"
  (cd "$dir" && unzip -q -o "$omni" 2>/dev/null || true)
  # строки бренда
  while IFS= read -r f; do cp "$BR/locales/en-US/brand.ftl" "$f"; done < <(find "$dir" -name brand.ftl)
  while IFS= read -r f; do cp "$BR/locales/en-US/brand.properties" "$f"; done < <(find "$dir" -name brand.properties)
  # иконки и логотипы бренда
  while IFS= read -r b; do
    for s in 16 32 48 64 128; do [ -f "$b/icon$s.png" ] && cp "$BR/default$s.png" "$b/icon$s.png"; done
    for f in about-logo.png about-logo@2x.png about-logo.svg about-wordmark.svg firefox-wordmark.svg about.png aboutDialog.css; do
      [ -f "$BR/content/$f" ] && cp "$BR/content/$f" "$b/$f"
    done
  done < <(find "$dir" -type d -path '*/content/branding')
  python3 "$ROOT/tools/debrand.py" "$dir"
  rm -f "$omni"
  (cd "$dir" && zip -qr0 -X "$omni" .)
}

for omni in "$APP/omni.ja" "$APP/browser/omni.ja"; do
  [ -f "$omni" ] && rebrand_omni "$(cd "$(dirname "$omni")" && pwd)/$(basename "$omni")"
done
# значки окон
if [ -d "$APP/browser/chrome/icons/default" ]; then
  for s in 16 32 48 64 128; do cp "$BR/default$s.png" "$APP/browser/chrome/icons/default/default$s.png"; done
fi
rm -rf "$TMP"
echo "Бренд NetLoom наложен на движок предпросмотра"
