#!/usr/bin/env python3
"""Собрать чистую папку extension/ для Chrome.

Python, тесты и __pycache__ в неё не попадают. Chrome грузит именно её,
а не корень репозитория.

  python tools/pack_extension.py
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / 'extension'

# Файлы, которые service worker тянет через importScripts или окно виджета.
# В manifest.json их нет, но без них расширение молча ломается.
EXTRA = [
    'hud.html',
    'hud.js',
    'overlay.css',
    'hand_eval.js',
    'monte_carlo.js',
    'preflop_ranges.js',
    'postflop_ranges.js',
    'frame_diff.js',
]


def manifest_files(manifest: dict) -> list[str]:
    refs = []
    for cs in manifest.get('content_scripts', []):
        refs.extend(cs.get('js', []))
    bg = manifest.get('background', {})
    if bg.get('service_worker'):
        refs.append(bg['service_worker'])
    refs.extend((manifest.get('icons') or {}).values())
    refs.extend(((manifest.get('action') or {}).get('default_icon') or {}).values())
    for war in manifest.get('web_accessible_resources', []):
        refs.extend(war.get('resources', []))
    return refs


def main() -> int:
    manifest_path = ROOT / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    names = ['manifest.json', *manifest_files(manifest), *EXTRA]
    missing = [n for n in names if not (ROOT / n).is_file()]
    if missing:
        print('Нет файлов для сборки: ' + ', '.join(missing), file=sys.stderr)
        return 1

    if DEST.exists():
        shutil.rmtree(DEST)
    DEST.mkdir()

    copied = []
    for name in names:
        src = ROOT / name
        if not src.is_file():
            continue
        if any(part.startswith('_') for part in Path(name).parts):
            print('Пропущен файл с именем на «_»: ' + name, file=sys.stderr)
            return 1
        target = DEST / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
        copied.append(name)

    print('Собрано файлов: %d' % len(copied))
    print(DEST)
    return 0


if __name__ == '__main__':
    sys.exit(main())
