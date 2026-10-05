#!/usr/bin/env python3
"""Локальный сервер чтения карт для расширения.

  python vision_server.py

http://127.0.0.1:8765
  GET  /health
  POST /read   JSON { "image": "data:image/png;base64,..." }

Чужой Origin не принимается, тело запроса ограничено, запросы реже 0.4 с отсекаются.
"""
from __future__ import annotations

import base64
import io
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image

from card_vision import detect_card_regions, read_card

HOST = '127.0.0.1'
PORT = 8765

# Максимальный размер тела запроса: 8 МБ. PNG-скриншот стола в base64
# укладывается в ~2–4 МБ, так что запас есть, а флуд отсекается.
MAX_BODY_BYTES = 8 * 1024 * 1024
# Не чаще одного запроса в 0.4 с: расширение и так шлёт раз в ~2 с.
MIN_INTERVAL_SEC = 0.4

# Допустимые источники запроса: страница расширения и локальные страницы.
ALLOWED_ORIGIN_RE = re.compile(
    r'^(chrome-extension://[a-p]{32}|moz-extension://[0-9a-f-]+|'
    r'https?://(localhost|127\.0\.0\.1)(:\d+)?)$'
)

_last_request_at = 0.0
_rate_lock = threading.Lock()


def pack_stamp() -> str:
    path = Path(__file__).parent / '.pack-stamp'
    try:
        return path.read_text(encoding='utf-8').strip()
    except OSError:
        return ''


def decode_image(data_url: str) -> Image.Image:
    raw = data_url.split(',', 1)[-1]
    return Image.open(io.BytesIO(base64.b64decode(raw))).convert('RGB')


def read_table(img: Image.Image) -> dict:
    w, h = img.size
    regions = detect_card_regions(img)
    cards = []
    for r in regions:
        got = read_card(img, r)
        if not (got.get('read') and got.get('rank') and got.get('suit')):
            continue
        cards.append({
            'rank': got['rank'],
            'suit': got['suit'],
            'conf': float(got.get('conf') or 0),
            'x': r['x'], 'y': r['y'], 'w': r['w'], 'h': r['h'],
        })

    bottom = [c for c in cards if c['y'] > h * 0.55]
    if len(bottom) < 2:
        bottom = sorted(cards, key=lambda c: -c['y'])[:4]
    hero = sorted(bottom, key=lambda c: c['x'])[:2]
    used = {(c['rank'], c['suit']) for c in hero}

    board = [
        c for c in cards
        if (c['rank'], c['suit']) not in used and h * 0.18 <= c['y'] <= h * 0.58
    ]
    if len(board) >= 2:
        board.sort(key=lambda c: c['y'])
        med = board[len(board) // 2]['y']
        board = [c for c in board if abs(c['y'] - med) < max(36, 0.06 * h)]
    board = sorted(board, key=lambda c: c['x'])[:5]

    return {
        'myCards': [{'rank': c['rank'], 'suit': c['suit']} for c in hero],
        'communityCards': [{'rank': c['rank'], 'suit': c['suit']} for c in board],
        'boxes': len(regions),
        'reads': len(cards),
        'source': 'py',
        'size': [w, h],
    }


class Handler(BaseHTTPRequestHandler):
    # Размер строки запроса тоже ограничиваем.
    max_header_size = 16384

    def _origin(self) -> str:
        return self.headers.get('Origin') or ''

    def _origin_allowed(self) -> bool:
        origin = self._origin()
        if not origin:
            # Запросы без Origin (curl, локальные скрипты) разрешаем.
            return True
        return bool(ALLOWED_ORIGIN_RE.match(origin))

    def _cors(self) -> None:
        origin = self._origin()
        if origin and ALLOWED_ORIGIN_RE.match(origin):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        # Private Network Access: отвечаем только если запрос действительно
        # пришёл из разрешённого источника.
        if self._origin_allowed():
            self.send_header('Access-Control-Allow-Private-Network', 'true')

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _reject(self, status: int, message: str) -> None:
        self._send_json(status, {'error': message, 'myCards': [], 'communityCards': []})

    def do_OPTIONS(self) -> None:
        if not self._origin_allowed():
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path.split('?', 1)[0] != '/health':
            self.send_response(404)
            self.end_headers()
            return
        self._send_json(200, {'ok': True, 'engine': 'card_vision', 'build': pack_stamp()})

    def do_POST(self) -> None:
        if self.path.split('?', 1)[0] != '/read':
            self.send_response(404)
            self.end_headers()
            return
        if not self._origin_allowed():
            self._reject(403, 'origin not allowed')
            return

        try:
            length = int(self.headers.get('Content-Length') or '0')
        except ValueError:
            self._reject(400, 'bad content-length')
            return
        if length <= 0:
            self._reject(400, 'empty body')
            return
        if length > MAX_BODY_BYTES:
            self._reject(413, 'body too large (max %d bytes)' % MAX_BODY_BYTES)
            return

        # Лимит частоты: лишние запросы не обрабатываем.
        global _last_request_at
        with _rate_lock:
            now = time.monotonic()
            if now - _last_request_at < MIN_INTERVAL_SEC:
                self._reject(429, 'too many requests')
                return
            _last_request_at = now

        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except Exception as e:
            self._reject(400, 'bad json: %s' % e)
            return

        try:
            img = decode_image(body.get('image') or '')
            result = read_table(img)
            self._send_json(200, result)
        except Exception as e:
            self._reject(500, str(e))

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write('[vision-server] ' + (fmt % args) + '\n')


if __name__ == '__main__':
    print(f'Poker card vision: http://{HOST}:{PORT}/read', flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
