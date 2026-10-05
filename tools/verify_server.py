#!/usr/bin/env python3
"""Проверка HTTP-слоя vision_server без установленных зависимостей зрения.

  python tools/verify_server.py

Зачем: обычный запуск сервера требует cv2 (OpenCV). Эта проверка подставляет
заглушку вместо card_vision и убеждается, что ограничения безопасности
работают: разрешённый Origin, посторонний Origin, лимит размера тела,
корректный /health и обработка ошибок.
"""
from __future__ import annotations

import io
import json
import os
import sys
import threading
import time
import types
import urllib.error
import urllib.request
import uuid

# Проверка не должна оставлять __pycache__ в папке расширения: Chrome отказывается
# загружать распакованное расширение с файлами, начинающимися с «_».
sys.dont_write_bytecode = True

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# --- заглушка вместо карточного зрения ---
fake = types.ModuleType('card_vision')
fake.detect_card_regions = lambda img: [{'x': 10, 'y': 10, 'w': 30, 'h': 40}]
fake.read_card = lambda img, region: {'read': True, 'rank': 'A', 'suit': 's', 'conf': 0.9}
sys.modules['card_vision'] = fake

# Свой порт, чтобы не конфликтовать с рабочим сервером.
PORT = 8791
import vision_server  # noqa: E402

vision_server.PORT = PORT
from http.server import ThreadingHTTPServer  # noqa: E402

passed = 0
failed = 0


def check(name: str, condition: bool, detail: str = '') -> None:
    global passed, failed
    if condition:
        passed += 1
        print('  ok    ' + name)
    else:
        failed += 1
        print('  FAIL  ' + name + (('  [' + detail + ']') if detail else ''))


def _png_data_url() -> str:
    """Собрать настоящий PNG в виде data URL — чтобы проверить полный путь."""
    import base64
    from PIL import Image
    buf = io.BytesIO()
    Image.new('RGB', (120, 90), (240, 240, 240)).save(buf, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


def request(method: str, path: str, body: bytes | None = None, origin: str | None = None,
            content_length: str | None = None):
    url = 'http://127.0.0.1:%d%s' % (PORT, path)
    req = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        req.add_header('Content-Type', 'application/json')
    if origin:
        req.add_header('Origin', origin)
    if content_length is not None:
        req.add_header('Content-Length', content_length)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def main() -> int:
    server = ThreadingHTTPServer(('127.0.0.1', PORT), vision_server.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    ext_origin = 'chrome-extension://' + 'a' * 32

    print('\n1. Базовые ответы')
    status, headers, body = request('GET', '/health')
    check('GET /health отдаёт 200', status == 200, str(status))
    check('/health содержит ok:true', b'"ok": true' in body or b'"ok":true' in body, body[:80].decode('utf-8', 'replace'))
    check('/health помечен как JSON', 'application/json' in headers.get('Content-Type', ''))

    status, _, _ = request('GET', '/nope')
    check('неизвестный путь -> 404', status == 404, str(status))

    print('\n2. Контроль Origin')
    status, headers, _ = request('OPTIONS', '/read', origin=ext_origin)
    check('OPTIONS с Origin расширения -> 204', status == 204, str(status))
    check('ACAO равен источнику запроса, а не *',
          headers.get('Access-Control-Allow-Origin') == ext_origin,
          str(headers.get('Access-Control-Allow-Origin')))

    status, headers, _ = request('OPTIONS', '/read', origin='https://evil.example.com')
    check('OPTIONS с посторонним Origin -> 403', status == 403, str(status))
    check('постороннему Origin не выдан ACAO',
          headers.get('Access-Control-Allow-Origin') != 'https://evil.example.com')

    body_json = json.dumps({'image': 'x'}).encode()
    status, _, _ = request('POST', '/read', body=body_json, origin='https://evil.example.com')
    check('POST с посторонним Origin -> 403', status == 403, str(status))

    print('\n3. Ограничения тела запроса')
    status, _, _ = request('POST', '/read', body=b'', origin=ext_origin)
    check('пустое тело -> 400', status == 400, str(status))

    status, _, _ = request('POST', '/read', body=b'{}', origin=ext_origin,
                           content_length=str(vision_server.MAX_BODY_BYTES + 1))
    check('слишком большое тело -> 413', status == 413, str(status))

    status, _, _ = request('POST', '/read', body=b'not-json', origin=ext_origin)
    check('невалидный JSON -> 400', status == 400, str(status))

    print('\n4. Обработка изображения (с заглушкой зрения)')
    # Лимит частоты сбрасывается сам со временем, поэтому ждём перед запросом.
    time.sleep(vision_server.MIN_INTERVAL_SEC + 0.15)
    payload = json.dumps({'image': _png_data_url()}).encode()
    status, _, body = request('POST', '/read', body=payload, origin=ext_origin)
    check('корректный PNG обработан с кодом 200', status == 200, str(status))
    check('ответ содержит поля карт', b'myCards' in body and b'communityCards' in body,
          body[:80].decode('utf-8', 'replace'))
    check('заглушка зрения вернула туза пик', b'"rank": "A"' in body or b'"rank":"A"' in body,
          body[:200].decode('utf-8', 'replace'))

    # Мусор вместо картинки не должен ронять сервер.
    time.sleep(vision_server.MIN_INTERVAL_SEC + 0.15)
    bad = json.dumps({'image': 'data:image/png;base64,AAAA'}).encode()
    status, _, _ = request('POST', '/read', body=bad, origin=ext_origin)
    check('битые данные -> 500, сервер жив', status == 500, str(status))

    print('\n5. Лимит частоты')
    # Сразу после предыдущего запроса следующие подряд должны получить 429.
    payload2 = json.dumps({'image': 'data:image/png;base64,AAAA'}).encode()
    codes = []
    for _ in range(3):
        status, _, _ = request('POST', '/read', body=payload2, origin=ext_origin)
        codes.append(status)
    check('частые запросы подряд отсекаются (429)', 429 in codes, str(codes))

    # После паузы запрос снова проходит — значит лимит не «залипает».
    time.sleep(vision_server.MIN_INTERVAL_SEC + 0.15)
    status, _, _ = request('POST', '/read', body=payload2, origin=ext_origin)
    check('после паузы запрос снова проходит', status in (200, 500), str(status))

    server.shutdown()
    print('\n' + '=' * 56)
    print('Пройдено: %d, провалено: %d' % (passed, failed))
    print('=' * 56)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
