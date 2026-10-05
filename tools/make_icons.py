#!/usr/bin/env python3
"""Генератор иконок расширения.

  python tools/make_icons.py

Раньше icons/*.png были сплошной заливкой одного цвета (16384 пикселя одного
RGB), то есть заглушкой. Этот скрипт рисует простую узнаваемую иконку:
тёмно-зелёный стол, белая карта и красная масть. Запускать нужно только если
захочется поменять вид иконки — готовые PNG уже лежат в icons/.
"""
from __future__ import annotations

import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'icons')

FELT = (21, 94, 60)
FELT_EDGE = (12, 62, 40)
CARD = (250, 250, 245)
CARD_EDGE = (200, 200, 195)
RED = (200, 40, 40)
BLACK = (35, 35, 40)


def draw_spade(draw, cx, cy, size, color):
    """Простая масть «пики» из кругов и треугольника — без шрифтов."""
    r = size * 0.30
    draw.ellipse([cx - r - size * 0.16, cy - r * 0.75, cx - size * 0.16 + r, cy + r * 0.55], fill=color)
    draw.ellipse([cx + size * 0.16 - r, cy - r * 0.75, cx + r + size * 0.16, cy + r * 0.55], fill=color)
    draw.polygon(
        [(cx, cy - size * 0.55), (cx + size * 0.42, cy + size * 0.28), (cx - size * 0.42, cy + size * 0.28)],
        fill=color
    )
    # Ножка
    draw.polygon(
        [(cx - size * 0.10, cy + size * 0.10), (cx + size * 0.10, cy + size * 0.10),
         (cx + size * 0.22, cy + size * 0.50), (cx - size * 0.22, cy + size * 0.50)],
        fill=color
    )


def make_icon(size: int) -> Image.Image:
    scale = 8  # рисуем крупнее и уменьшаем — так края выходят гладкими
    s = size * scale
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Скруглённый «стол».
    radius = int(s * 0.22)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=FELT, outline=FELT_EDGE,
                        width=max(1, int(s * 0.035)))

    # Карта по центру.
    cw, ch = int(s * 0.46), int(s * 0.62)
    x0, y0 = (s - cw) // 2, (s - ch) // 2
    d.rounded_rectangle([x0, y0, x0 + cw, y0 + ch], radius=int(cw * 0.16), fill=CARD,
                        outline=CARD_EDGE, width=max(1, int(s * 0.02)))

    # Масть: на большом размере — пики, на маленьком читается как «две масти».
    draw_spade(d, x0 + cw * 0.34, y0 + ch * 0.36, cw * 0.55, BLACK)
    draw_spade(d, x0 + cw * 0.70, y0 + ch * 0.70, cw * 0.42, RED)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 48, 128):
        path = os.path.join(OUT_DIR, f'icon{size}.png')
        make_icon(size).save(path)
        print(f'{path} ({os.path.getsize(path)} байт)')


if __name__ == '__main__':
    main()
