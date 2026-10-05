#!/usr/bin/env python3
"""Проверка распознавания карт на образцах из репозитория.

  python tools/check_vision_samples.py

Смысл: в папке card_templates/cards лежат 8 настоящих вырезок карт из игры
(2h, 3s, 4h, 6d, 6h, Jc, Kd, Td). Прогоняем каждую через detect_card_regions
и read_card — то есть через тот же путь, что и в бою, — и сверяем с именем
файла. Это единственная проверка точности зрения, доступная без запуска игры.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from PIL import Image  # noqa: E402

import card_vision as cv  # noqa: E402

SAMPLES = ROOT / 'card_templates' / 'cards'


def main() -> int:
    print('шрифты для шаблонов ранков найдены: %d из %d'
          % (sum(1 for p in cv.FONT_PATHS if Path(p).exists()), len(cv.FONT_PATHS)))
    tpls = cv._load_templates()
    by_rank = {}
    for rank, src, _ in tpls:
        by_rank.setdefault(rank, []).append(src)
    print('шаблонов ранков загружено: %d, различных ранков: %d' % (len(tpls), len(by_rank)))
    missing = [r for r in cv.RANKS if r not in by_rank]
    print('ранки без шаблона: %s' % (', '.join(missing) if missing else 'нет'))
    print()

    files = sorted(SAMPLES.glob('*.png'))
    if not files:
        print('нет образцов в %s' % SAMPLES)
        return 1

    ok = 0
    problems = []
    for f in files:
        expect_rank = f.stem[0].upper()
        expect_suit = f.stem[1].lower()
        if f.stem.upper().startswith('10'):
            expect_rank, expect_suit = 'T', f.stem[2].lower()

        img = Image.open(f).convert('RGB')
        regions = cv.detect_card_regions(img)
        got = None
        for r in regions:
            res = cv.read_card(img, r)
            if res.get('read') and res.get('rank') and res.get('suit'):
                got = res
                break
        if got is None and regions:
            # Попробуем весь кадр как одну карту.
            got = cv.read_card(img, {'x': 0, 'y': 0, 'w': img.width, 'h': img.height})

        if got and got.get('rank') == expect_rank and got.get('suit') == expect_suit:
            ok += 1
            print('  ok    %-4s -> %s%s (conf %.2f), областей: %d'
                  % (f.stem, got['rank'], got['suit'], got.get('conf') or 0, len(regions)))
        else:
            actual = ('%s%s' % (got['rank'], got['suit'])) if got else 'не прочитано'
            problems.append('%s: ожидалось %s%s, получено %s' % (f.stem, expect_rank, expect_suit, actual))
            print('  FAIL  %-4s -> %s (областей: %d)' % (f.stem, actual, len(regions)))

    print()
    print('=' * 56)
    print('Распознано верно: %d из %d' % (ok, len(files)))
    if problems:
        print('Проблемы:')
        for p in problems:
            print('  - ' + p)
    print('=' * 56)
    return 0 if ok == len(files) else 1


if __name__ == '__main__':
    sys.exit(main())
