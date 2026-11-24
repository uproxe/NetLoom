#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Убирает слова Firefox и Mozilla из текстов интерфейса движка.

    python3 tools/debrand.py <папка> [<папка> ...]

Обрабатывает файлы локализации (.ftl, .properties, .dtd, .ini): меняет только
тексты (значения), идентификаторы и ссылки не трогает. Файлы мастера импорта
пропускаются: там «Firefox» — название другого браузера, из которого переносят данные.
"""
import re
import sys
from pathlib import Path

BRAND = "NetLoom"
EXTENSIONS = {".ftl", ".properties", ".dtd", ".ini"}
SKIP_PATH = re.compile(r"migration|/tests?/|/test_", re.I)
WORDS = re.compile(r"(?<![\w./@-])(Mozilla Firefox|Firefox|Mozilla)(?![\w@-]|\.(?:org|com|net)\b)")
DOUBLE = re.compile(r"\b" + BRAND + r"(\s+" + BRAND + r")+\b")
DTD_VALUE = re.compile(r'("[^"]*"|\'[^\']*\')')


def fix(text: str) -> str:
    text = WORDS.sub(BRAND, text)
    return DOUBLE.sub(BRAND, text)


def process_line(line: str, ext: str) -> str:
    stripped = line.lstrip()
    if not stripped or stripped.startswith("#"):
        return line
    if ext == ".dtd":
        return DTD_VALUE.sub(lambda m: fix(m.group(0)), line) if "<!ENTITY" in line or line.startswith((" ", "\t")) else line
    if ext in (".properties", ".ini"):
        if stripped.startswith(("!", ";", "[")):
            return line
        if "=" in line:
            key, value = line.split("=", 1)
            return key + "=" + fix(value)
        return line
    # .ftl: значение после первого «=», строки-продолжения целиком
    if "=" in line and not line.startswith((" ", "\t")):
        key, value = line.split("=", 1)
        return key + "=" + fix(value)
    if line.startswith((" ", "\t")):
        if re.match(r"\s*\.[\w-]+\s*=", line):
            key, value = line.split("=", 1)
            return key + "=" + fix(value)
        if re.match(r"\s*\*?\[[\w-]+\]", line):
            m = re.match(r"(\s*\*?\[[\w-]+\])(.*)", line, re.S)
            return m.group(1) + fix(m.group(2))
        return fix(line)
    return line


def process_file(path: Path) -> int:
    ext = path.suffix
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return 0
    lines = text.splitlines(keepends=True)
    out = [process_line(l, ext) for l in lines]
    changed = sum(1 for a, b in zip(lines, out) if a != b)
    if changed:
        path.write_text("".join(out), encoding="utf-8")
    return changed


def main(dirs):
    files = lines = 0
    for d in dirs:
        for path in Path(d).rglob("*"):
            if path.suffix not in EXTENSIONS or not path.is_file():
                continue
            if SKIP_PATH.search(path.as_posix()):
                continue
            n = process_file(path)
            if n:
                files += 1
                lines += n
    print(f"debrand: изменено строк {lines} в {files} файлах")


if __name__ == "__main__":
    main(sys.argv[1:])
