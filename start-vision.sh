#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Не создавать __pycache__: Chrome не загружает распакованное расширение,
# если в папке есть файлы или папки, начинающиеся с «_».
export PYTHONDONTWRITEBYTECODE=1

exec python3 vision_server.py
