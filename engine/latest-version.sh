#!/usr/bin/env bash
# Печатает последнюю версию Gecko ESR нужной ветки (например 153.7.0).
set -euo pipefail
MAJOR="${1:-$(cat "$(dirname "$0")/ESR_MAJOR")}"
git ls-remote --tags https://github.com/mozilla-firefox/firefox "refs/tags/FIREFOX_${MAJOR}_*esr_RELEASE" \
  | sed -E 's#.*/FIREFOX_([0-9_]+)esr_RELEASE$#\1#' | tr '_' '.' | sort -V | tail -1
