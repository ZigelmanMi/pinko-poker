#!/usr/bin/env python3
"""Нарисовать стол и проверить, как сервер делит карты на руку и борд.

  python tools/make_mock_table.py --scale 1.6

В npm test не входит: глифы здесь не те, что на столе.
Точность по настоящим кропам смотрит tools/check_vision_samples.py.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import urllib.request
from pathlib import Path

# Импорт vision_server не должен оставлять __pycache__ в папке расширения:
# Chrome отказывается загружать распакованное расширение, если рядом есть
# файлы или папки, начинающиеся с «_».
sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from PIL import Image, ImageDraw  # noqa: E402

import card_vision as cv  # noqa: E402

OUT = ROOT / 'mock_table.png'

# Ранк -> (масть, зона): борд = Kd Td 6d, рука героя = As Jc
DEAL = [
    ('K', 'd', 'board'),
    ('T', 'd', 'board'),
    ('6', 'd', 'board'),
    ('A', 's', 'hero'),
    ('J', 'c', 'hero'),
]

RED = (200, 30, 40)
BLACK = (25, 25, 30)
CARD_W, CARD_H = 62, 88


def draw_pip(draw: ImageDraw.ImageDraw, cx: float, cy: float, size: float, suit: str, color) -> None:
    """Нарисовать масть геометрически: пика, черва, бубна, трефа."""
    r = size / 2
    if suit == 'd':  # ромб
        draw.polygon([(cx, cy - r), (cx + r * 0.72, cy), (cx, cy + r), (cx - r * 0.72, cy)], fill=color)
        return
    if suit == 'h':  # сердце: два круга и треугольник
        draw.ellipse([cx - r, cy - r * 0.85, cx, cy + r * 0.15], fill=color)
        draw.ellipse([cx, cy - r * 0.85, cx + r, cy + r * 0.15], fill=color)
        draw.polygon([(cx - r * 0.98, cy - r * 0.15), (cx + r * 0.98, cy - r * 0.15), (cx, cy + r)], fill=color)
        return
    if suit == 's':  # пика: перевёрнутое сердце плюс ножка
        draw.ellipse([cx - r, cy - r * 0.15, cx, cy + r * 0.85], fill=color)
        draw.ellipse([cx, cy - r * 0.15, cx + r, cy + r * 0.85], fill=color)
        draw.polygon([(cx - r * 0.98, cy + r * 0.15), (cx + r * 0.98, cy + r * 0.15), (cx, cy - r)], fill=color)
        draw.polygon([(cx - r * 0.22, cy + r * 0.55), (cx + r * 0.22, cy + r * 0.55),
                      (cx + r * 0.38, cy + r), (cx - r * 0.38, cy + r)], fill=color)
        return
    # трефа: три круга и ножка
    draw.ellipse([cx - r * 0.55, cy - r, cx + r * 0.55, cy], fill=color)
    draw.ellipse([cx - r, cy - r * 0.1, cx, cy + r * 0.9], fill=color)
    draw.ellipse([cx, cy - r * 0.1, cx + r, cy + r * 0.9], fill=color)
    draw.polygon([(cx - r * 0.22, cy + r * 0.45), (cx + r * 0.22, cy + r * 0.45),
                  (cx + r * 0.38, cy + r), (cx - r * 0.38, cy + r)], fill=color)


def load_rank_glyph(rank: str) -> Image.Image | None:
    """Глиф ранка из шаблонов; для 10/T берём T.png."""
    key = 'T' if rank in ('T', '10') else rank
    path = ROOT / 'card_templates' / 'ranks' / (key + '.png')
    if not path.exists():
        path = ROOT / 'card_templates' / 'ranks' / (key + 'b.png')
    if not path.exists():
        return None
    g = Image.open(path).convert('L')
    # Шаблоны могут быть «белый глиф на чёрном» или наоборот — приводим к
    # виду «светлый фон, тёмный глиф», иначе карта выйдет вывернутой.
    import numpy as np
    a = np.array(g)
    if a.mean() < 96:          # в среднем темнее 96 -> глиф светлый на тёмном
        g = Image.fromarray(255 - a)
    return g


def draw_card(rank: str, suit: str, scale: float) -> Image.Image:
    """Карта, похожая на настоящую: крупный ранг в левом верхнем углу,
    мелкий пип под ним, крупный пип по центру, зеркальный ранг снизу."""
    w, h = int(CARD_W * scale), int(CARD_H * scale)
    card = Image.new('RGB', (w, h), (252, 252, 250))
    draw = ImageDraw.Draw(card)
    draw.rectangle([0, 0, w - 1, h - 1], outline=(200, 200, 196))

    color = RED if suit in ('h', 'd') else BLACK

    def paste_glyph(size_px: int, x: int, y: int) -> None:
        glyph = load_rank_glyph(rank)
        if glyph is None:
            draw.text((x, y), rank, fill=color)
            return
        gw = size_px
        gh = max(6, int(gw * glyph.height / glyph.width))
        g = glyph.resize((gw, gh), Image.LANCZOS)
        colored = Image.new('RGB', g.size, (255, 255, 255))
        colored.paste(Image.new('RGB', g.size, color), (0, 0), g)
        card.paste(colored, (x, y))

    # Верхний левый угол: ранг и масть под ним.
    paste_glyph(int(w * 0.40), int(w * 0.10), int(h * 0.05))
    draw_pip(draw, w * 0.30, h * 0.33, w * 0.25, suit, color)

    # Центр: крупная масть.
    draw_pip(draw, w * 0.58, h * 0.62, w * 0.42, suit, color)

    # Нижний правый угол: зеркальная копия угла.
    corner = card.crop((0, 0, int(w * 0.55), int(h * 0.45))).rotate(180)
    card.paste(corner, (w - corner.width, h - corner.height))
    return card


def build_table(scale: float) -> tuple[Image.Image, dict]:
    width, height = 900, 600
    table = Image.new('RGB', (width, height), (16, 88, 58))
    draw = ImageDraw.Draw(table)

    expected = {'myCards': [], 'communityCards': []}
    card_w, card_h = int(CARD_W * scale), int(CARD_H * scale)
    gap = int(card_w * 0.16)

    board_total = 3 * card_w + 2 * gap
    board_x = (width - board_total) // 2
    board_y = int(height * 0.28)

    hero_total = 2 * card_w + gap
    hero_x = (width - hero_total) // 2
    hero_y = int(height * 0.68)

    for rank, suit, zone in DEAL:
        card = draw_card(rank, suit, scale)
        if zone == 'board':
            x, y = board_x, board_y
            board_x += card_w + gap
            expected['communityCards'].append({'rank': rank, 'suit': suit})
        else:
            x, y = hero_x, hero_y
            hero_x += card_w + gap
            expected['myCards'].append({'rank': rank, 'suit': suit})
        draw.rectangle([x - 1, y - 1, x + card_w, y + card_h], outline=(215, 215, 210))
        table.paste(card, (x, y))
    return table, expected


def read_local(table: Image.Image) -> dict:
    """Локальный разбор тем же кодом, что и на сервере (vision_server.read_table)."""
    from vision_server import read_table
    return read_table(table)


def compare(got: dict, expected: dict) -> list:
    problems = []
    for key, label in (('myCards', 'карманные карты'), ('communityCards', 'борд')):
        want = sorted((c['rank'], c['suit']) for c in expected[key])
        have = sorted((c['rank'], c['suit']) for c in (got.get(key) or []))
        if want != have:
            problems.append('%s: ожидалось %s, получено %s' % (label, want, have))
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-http', action='store_true')
    ap.add_argument('--url', default='http://127.0.0.1:8765/read')
    ap.add_argument('--scale', type=float, default=1.0)
    args = ap.parse_args()

    table, expected = build_table(args.scale)
    table.save(OUT)
    print('картинка: %s (%dx%d), масштаб карты x%.2f' % (OUT, table.width, table.height, args.scale))
    print('ожидается: рука %s, борд %s'
          % ([c['rank'] + c['suit'] for c in expected['myCards']],
             [c['rank'] + c['suit'] for c in expected['communityCards']]))

    problems = []

    got_local = read_local(table)
    print('локально:  рука %s, борд %s'
          % ([c['rank'] + c['suit'] for c in got_local.get('myCards', [])],
             [c['rank'] + c['suit'] for c in got_local.get('communityCards', [])]))
    problems += ['локально: ' + p for p in compare(got_local, expected)]

    if not args.no_http:
        try:
            raw = base64.b64encode(OUT.read_bytes()).decode()
            body = json.dumps({'image': 'data:image/png;base64,' + raw}).encode()
            req = urllib.request.Request(args.url, data=body, headers={
                'Content-Type': 'application/json',
                'Origin': 'chrome-extension://' + 'a' * 32,
            })
            with urllib.request.urlopen(req, timeout=30) as resp:
                got = json.loads(resp.read())
            print('сервер:    рука %s, борд %s'
                  % ([c['rank'] + c['suit'] for c in got.get('myCards', [])],
                     [c['rank'] + c['suit'] for c in got.get('communityCards', [])]))
            problems += ['сервер: ' + p for p in compare(got, expected)]
        except Exception as e:
            problems.append('сервер недоступен (%s)' % e)

    print()
    print('=' * 58)
    if problems:
        # Ненулевой код возврата здесь не означает «сервер сломан»: синтетические
        # карты отличаются от настоящих. Смотрите также check_vision_samples.py.
        print('РАСХОЖДЕНИЯ (ожидаемо для синтетики, см. шапку файла):')
        for p in problems:
            print('  - ' + p)
    else:
        print('ВСЁ ВЕРНО: карты и зоны (рука/борд) определены правильно')
    print('=' * 58)
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
