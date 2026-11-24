#!/usr/bin/env python3
"""Генерирует все изображения брендинга движка из branding/*.svg.

Запуск: python3 tools/make_branding.py   (нужны rsvg-convert и Pillow)
Результат: engine/branding/ — накладывается поверх browser/branding/unofficial при сборке.
"""
import io
import shutil
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "branding"
OUT = ROOT / "engine" / "branding"
BG = (11, 18, 32)  # #0B1220


def render(svg: Path, size: int) -> Image.Image:
    png = subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), str(svg)],
                         check=True, capture_output=True).stdout
    return Image.open(io.BytesIO(png)).convert("RGBA")


def icon(size: int, private: bool = False) -> Image.Image:
    if private:
        return render(SRC / "icon-private.svg", size)
    return render(SRC / ("icon-small.svg" if size <= 24 else "icon.svg"), size)


def save_png(rel: str, size: int, private: bool = False):
    p = OUT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    icon(size, private).save(p)


def save_ico(rel: str, sizes, private: bool = False):
    p = OUT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    imgs = [icon(s, private) for s in sizes]
    imgs[-1].save(p, format="ICO", sizes=[(s, s) for s in sizes], append_images=imgs[:-1], bitmap_format="bmp")


def save_icns(rel: str, private: bool = False):
    """Значок macOS (.icns) из PNG-частей — формат, который понимает macOS 10.7+."""
    parts = [(b"icp4", 16), (b"icp5", 32), (b"ic07", 128), (b"ic08", 256), (b"ic09", 512),
             (b"ic10", 1024), (b"ic11", 32), (b"ic12", 64), (b"ic13", 256), (b"ic14", 512)]
    body = b""
    for kind, size in parts:
        buf = io.BytesIO()
        icon(size, private).save(buf, format="PNG")
        data = buf.getvalue()
        body += kind + (len(data) + 8).to_bytes(4, "big") + data
    p = OUT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"icns" + (len(body) + 8).to_bytes(4, "big") + body)


def canvas(w: int, h: int, logo: int, private: bool = False) -> Image.Image:
    im = Image.new("RGBA", (w, h), BG + (255,))
    ic = icon(logo, private)
    im.alpha_composite(ic, ((w - logo) // 2, (h - logo) // 2))
    return im


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    for s in (16, 22, 24, 32, 48, 64, 128, 256):
        save_png(f"default{s}.png", s)
    save_ico("firefox.ico", [16, 24, 32, 48, 64, 128, 256])
    save_ico("firefox64.ico", [16, 24, 32, 48, 64])
    save_ico("document.ico", [16, 32, 48, 256])
    save_ico("document_pdf.ico", [16, 32, 48, 256])
    save_ico("newtab.ico", [16, 32])
    save_ico("newwindow.ico", [16, 32])
    save_ico("pbmode.ico", [16, 32, 48, 256], private=True)

    for s, n in ((300, 150), (142, 70)):
        save_png(f"VisualElements_{n}.png", s)
        save_png(f"PrivateBrowsing_{n}.png", s, private=True)

    save_png("content/about-logo.png", 192)
    save_png("content/about-logo@2x.png", 384)
    save_png("content/about-logo-private.png", 192, private=True)
    save_png("content/about-logo-private@2x.png", 384, private=True)
    canvas(300, 236, 160).save(OUT / "content/about.png")
    shutil.copy(SRC / "icon.svg", OUT / "content/about-logo.svg")
    shutil.copy(SRC / "icon.svg", OUT / "content/document_pdf.svg")
    shutil.copy(SRC / "wordmark.svg", OUT / "content/about-wordmark.svg")
    shutil.copy(SRC / "wordmark.svg", OUT / "content/firefox-wordmark.svg")

    # установщик (NSIS) и прочие платформенные картинки
    canvas(150, 57, 44).convert("RGB").save(OUT / "wizHeader.bmp")
    canvas(150, 57, 44).convert("RGB").save(OUT / "wizHeaderRTL.bmp")
    canvas(164, 314, 120).convert("RGB").save(OUT / "wizWatermark.bmp")
    (OUT / "stubinstaller").mkdir(exist_ok=True)
    canvas(1344, 822, 256).convert("RGB").save(OUT / "stubinstaller/bgstub.jpg", quality=90)
    # фон окна установки macOS (.dmg): значки программы и «Программы» рисует сама система
    Image.new("RGBA", (1440, 880), BG + (255,)).save(OUT / "background.png")
    for name in ("firefox.icns", "document.icns", "disk.icns"):
        save_icns(name)

    msix = {
        "Document44x44.png": 44, "LargeTile.scale-200.png": 620, "MedTile.scale-200.png": 300,
        "SmallTile.scale-200.png": 142, "Square150x150Logo.scale-200.png": 300,
        "Square44x44Logo.altform-lightunplated_targetsize-256.png": 256,
        "Square44x44Logo.altform-unplated_targetsize-256.png": 256,
        "Square44x44Logo.scale-200.png": 88, "Square44x44Logo.targetsize-256.png": 256,
        "StoreLogo.scale-200.png": 100,
    }
    for name, s in msix.items():
        save_png(f"msix/Assets/{name}", s)
    canvas(620, 300, 220).save(OUT / "msix/Assets/Wide310x150Logo.scale-200.png")
    print("готово:", sum(1 for _ in OUT.rglob("*") if _.is_file()), "файлов в", OUT)


if __name__ == "__main__":
    main()
