#!/usr/bin/env python3
"""Проверка, что папку можно загрузить в Chrome как распакованное расширение.

  python tools/preflight.py

Зачем: Chrome отказывается загружать расширение, если в папке есть файлы или
папки, имена которых начинаются с «_». Типичный виновник — `__pycache__`,
который Python создаёт при запуске сервера зрения. Ошибка выглядит так:

  Cannot load extension with file or directory name __pycache__.
  Filenames starting with "_" are reserved for use by the system.

Этот скрипт ловит проблему ДО попытки загрузки. Запускать после любого запуска
Python-скриптов в папке проекта. Ненулевой код возврата = Chrome не загрузит.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Папки, которые расширению не нужны и не должны попадать в сборку.
IGNORED_DIRS = {'.git', 'node_modules', 'card_samples', 'poker_bot'}


def main() -> int:
    root = ROOT
    if len(sys.argv) > 1:
        candidate = Path(sys.argv[1])
        root = candidate.resolve() if candidate.is_absolute() else (ROOT / candidate).resolve()
    if not root.is_dir():
        print('Нет папки: %s' % root)
        return 1

    problems = []

    # 1) Имена, начинающиеся с «_» — прямая причина отказа Chrome.
    reserved = []
    for p in sorted(root.rglob('*')):
        rel = p.relative_to(root)
        if any(part in IGNORED_DIRS for part in rel.parts):
            continue
        if p.name.startswith('_'):
            reserved.append(rel.as_posix())
    if reserved:
        problems.append(
            'имена, начинающиеся с «_» (Chrome откажется загружать):\n    '
            + '\n    '.join(reserved)
        )

    # 2) Манифест.
    print('папка: %s' % root)
    manifest_path = root / 'manifest.json'
    if not manifest_path.exists():
        problems.append('нет manifest.json')
    else:
        try:
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        except Exception as e:
            problems.append('manifest.json не разбирается: %s' % e)
            manifest = None
        if manifest:
            print('манифест: %s v%s' % (manifest.get('name'), manifest.get('version')))
            # 3) Все файлы, на которые ссылается манифест, должны существовать.
            refs = set()
            for cs in manifest.get('content_scripts', []):
                refs.update(cs.get('js', []))
            bg = manifest.get('background', {})
            if bg.get('service_worker'):
                refs.add(bg['service_worker'])
            refs.update((manifest.get('icons') or {}).values())
            refs.update(((manifest.get('action') or {}).get('default_icon') or {}).values())
            for war in manifest.get('web_accessible_resources', []):
                refs.update(war.get('resources', []))
            missing = [r for r in sorted(refs) if not (root / r).exists()]
            if missing:
                problems.append('манифест ссылается на отсутствующие файлы: ' + ', '.join(missing))
            print('файлов по ссылкам манифеста: %d, отсутствует: %d' % (len(refs), len(missing)))

            # 4) Размер: Chrome не любит гигабайты, но 500 МБ — уже перебор.
            total = sum(f.stat().st_size for f in root.rglob('*') if f.is_file()
                        and not any(part in IGNORED_DIRS for part in f.relative_to(root).parts))
            print('размер папки: %.1f МБ' % (total / 1024 / 1024))

    print()
    print('=' * 58)
    if problems:
        print('CHROME НЕ ЗАГРУЗИТ ЭТУ ПАПКУ:')
        for p in problems:
            print('  - ' + p)
        print()
        print('Что делать: удалить перечисленные файлы/папки. Для __pycache__:')
        print('  Remove-Item -Recurse -Force __pycache__')
        print('и запускать сервер через start-vision.ps1 (он запрещает байт-код).')
    else:
        print('ОК: папку можно загружать в Chrome как распакованное расширение')
        print('chrome://extensions -> Режим разработчика -> Загрузить распакованное')
    print('=' * 58)
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
