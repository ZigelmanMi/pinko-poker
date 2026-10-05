// =====================================================================
// frame_diff.js — сравнение кадров экрана до отправки на сервер зрения
//
// Зачем это нужно
// ---------------
// Расширение раз в ~2 секунды снимает вкладку (chrome.tabs.captureVisibleTab),
// кодирует PNG в base64 и шлёт JSON на http://127.0.0.1:8765/read. Даже если
// картинка на столе не изменилась, уходит несколько мегабайт. Здесь считается
// компактный «отпечаток» кадра (64 бита = 16 hex-символов), чтобы:
//   * не отправлять кадр, если он совпадает с предыдущим (isSame);
//   * уменьшать кадр перед отправкой (downscaleRgba) — серверу не нужны
//     полноразмерные 1600x900, ему хватает 320 px по большей стороне.
//
// Почему dhash, а не md5/sha1 или побайтовое сравнение
// ---------------------------------------------------
// Полное сравнение (md5) срабатывает только на бит-в-бит идентичных данных.
// PNG-сжатие, гамма, дрожание курсора, мигающий таймер, антиалиасинг и шум
// захвата дают каждый раз другой массив байт, хотя «смысл» кадра тот же —
// md5 менялся бы на каждом кадре и ничего не фильтровал. dhash сравнивает
// не байты, а *направление перепадов яркости* между соседними пикселями:
//   * устойчив к мелкому шуму (±2 по каждому пикселю не переворачивает биты);
//   * устойчив к пересжатию PNG и незначительному изменению контраста;
//   * при этом заметное изменение картинки (сдвиг, новая карта, другой стол)
//     переворачивает десятки бит, и hamming это сразу показывает.
//
// Формат 64-битного отпечатка
// ---------------------------
// Кадр уменьшается до сетки 9x8 и в каждой строке сравниваются соседние
// пиксели по горизонтали: bit = (g[i] > g[i+1]).
//   * биты 0..55  — 56 бит пространственного dhash (7 сравнений в каждой
//     из 8 строк; восьмое сравнение строки отдано под яркость, см. ниже);
//   * биты 56..63 — 8 бит грубой абсолютной яркости: средняя яркость
//     сравнивается с 8 фиксированными порогами.
// Зачем вторая группа: чистый dhash инвариантен к яркости, поэтому полностью
// белый и полностью чёрный кадры дали бы ОДИН И ТОТ ЖЕ хеш (все нули).
// Восемь независимых порогов это исправляют: белый кадр ставит все 8 бит,
// чёрный — ни одного (hamming 8, кадры считаются разными). Пороги разнесены
// на 32 уровня, поэтому шум ±2 может перевернуть не более одного бита, а не
// восемь, — устойчивость к шуму сохраняется.
//
// Модуль работает и в браузере (window.FrameDiff), и в Node
// (require('./frame_diff.js')). DOM API не используется вообще: только работа
// с массивами пикселей, поэтому всё тестируется в Node без canvas.
// =====================================================================

(function (root) {
  'use strict';

  // Сетка, к которой приводится кадр перед сравнением соседей.
  const HASH_W = 9;
  const HASH_H = 8;
  // Горизонтальных сравнений в строке (последняя колонка отдана под яркость).
  const SPATIAL_PER_ROW = HASH_W - 2; // 7
  const SPATIAL_BITS = SPATIAL_PER_ROW * HASH_H; // 56
  // Пороги абсолютной яркости (8 штук, шаг 32). Средняя яркость кадра
  // сравнивается с каждым порогом независимо — получается 8 стабильных бит.
  const BRIGHT_THRESHOLDS = [24, 56, 88, 120, 152, 184, 216, 248];
  const TOTAL_BITS = 64;
  const HEX_CHARS = '0123456789abcdef';
  // Число единичных бит в полубайте (popcount) — для быстрого hamming.
  const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
  // Значение hex-символа; -1 для посторонних символов.
  const HEX_VALUE = (function () {
    const t = new Int8Array(128).fill(-1);
    for (let i = 0; i < 16; i++) t[HEX_CHARS.charCodeAt(i)] = i;
    for (let i = 0; i < 6; i++) t['ABCDEF'.charCodeAt(i)] = 10 + i;
    return t;
  })();

  /** Проверка размеров изображения: дальше любая ошибка даёт мусорный хеш. */
  function assertSize(w, h) {
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      throw new Error('frame_diff: некорректный размер изображения ' + w + 'x' + h);
    }
  }

  /**
   * Границы блоков при уменьшении: len исходных пикселей -> n блоков.
   * Возвращает массив из n+1 индексов, blockBounds[i]..blockBounds[i+1).
   * Требует len >= n, иначе блоки были бы пустыми.
   */
  function blockBounds(len, n) {
    const b = new Int32Array(n + 1);
    for (let i = 0; i <= n; i++) b[i] = Math.floor((i * len) / n);
    // Страховка от вырожденных случаев (на всякий случай, границы монотонны).
    for (let i = 1; i <= n; i++) if (b[i] <= b[i - 1]) b[i] = b[i - 1] + 1;
    if (b[n] > len) b[n] = len;
    return b;
  }

  /**
   * RGBA -> яркость (Uint8Array, 0..255), порядок построчный.
   * Коэффициенты BT.601 (Rec.601) в целочисленном виде: сумма весов ровно 256,
   * поэтому деление — это сдвиг на 8 без потери точности.
   */
  function toGray(rgba, w, h) {
    assertSize(w, h);
    const n = w * h;
    if (!rgba || rgba.length < n * 4) {
      throw new Error('frame_diff: toGray ожидает RGBA-массив длиной ' + n * 4 + ', получено ' + (rgba ? rgba.length : 0));
    }
    const out = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      // 0.299/0.587/0.114 в целых: 77/150/29 (77+150+29 = 256).
      out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    }
    return out;
  }

  /**
   * Яркостный массив -> сетка tw x th усреднением блоков (box filter).
   * Без библиотек: усреднение по прямоугольному блоку исходных пикселей.
   */
  function reduceGray(gray, w, h, tw, th) {
    const out = new Uint8Array(tw * th);
    if (w === tw && h === th) {
      for (let i = 0; i < w * h; i++) out[i] = gray[i];
      return out;
    }
    const xs = blockBounds(w, tw);
    const ys = blockBounds(h, th);
    for (let y = 0; y < th; y++) {
      const y0 = ys[y], y1 = ys[y + 1];
      for (let x = 0; x < tw; x++) {
        const x0 = xs[x], x1 = xs[x + 1];
        let sum = 0;
        for (let sy = y0; sy < y1; sy++) {
          const row = sy * w;
          for (let sx = x0; sx < x1; sx++) sum += gray[row + sx];
        }
        // Среднее с округлением к ближайшему.
        out[y * tw + x] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
      }
    }
    return out;
  }

  /**
   * Уменьшение RGBA по большей стороне до maxSide (усреднение блоков).
   * Возвращает { data, w, h }. Если кадр и так не больше maxSide, исходный
   * массив возвращается как есть (без лишнего копирования).
   */
  function downscaleRgba(rgba, w, h, maxSide) {
    assertSize(w, h);
    if (!rgba || rgba.length < w * h * 4) {
      throw new Error('frame_diff: downscaleRgba ожидает RGBA-массив длиной ' + w * h * 4);
    }
    const long = Math.max(w, h);
    const limit = maxSide > 0 ? Math.floor(maxSide) : long;
    if (limit >= long) return { data: rgba, w: w, h: h };

    // Пропорции сохраняем, минимум 1 пиксель по каждой стороне.
    const scale = limit / long;
    const nw = Math.max(1, Math.round(w * scale));
    const nh = Math.max(1, Math.round(h * scale));
    const out = new Uint8ClampedArray(nw * nh * 4);
    const xs = blockBounds(w, nw);
    const ys = blockBounds(h, nh);
    for (let y = 0; y < nh; y++) {
      const y0 = ys[y], y1 = ys[y + 1];
      for (let x = 0; x < nw; x++) {
        const x0 = xs[x], x1 = xs[x + 1];
        let r = 0, g = 0, b = 0, a = 0, cnt = 0;
        for (let sy = y0; sy < y1; sy++) {
          let p = (sy * w + x0) * 4;
          for (let sx = x0; sx < x1; sx++, p += 4) {
            r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2]; a += rgba[p + 3];
            cnt++;
          }
        }
        // Uint8ClampedArray сам округлит и зажмёт в 0..255.
        const q = (y * nw + x) * 4;
        out[q] = r / cnt;
        out[q + 1] = g / cnt;
        out[q + 2] = b / cnt;
        out[q + 3] = a / cnt;
      }
    }
    return { data: out, w: nw, h: nh };
  }

  /** Массив 0/1 длиной 64 -> строка из 16 hex-символов (старший бит первый). */
  function bitsToHex(bits) {
    let s = '';
    for (let i = 0; i < TOTAL_BITS; i += 4) {
      const v = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
      s += HEX_CHARS[v];
    }
    return s;
  }

  /**
   * Difference hash по массиву яркостей (0..255, длина w*h, построчно).
   * Возвращает 16 hex-символов (64 бита), см. описание формата в шапке файла.
   */
  function dhash(gray, w, h) {
    assertSize(w, h);
    if (!gray || gray.length < w * h) {
      throw new Error('frame_diff: dhash ожидает массив яркостей длиной ' + w * h + ', получено ' + (gray ? gray.length : 0));
    }
    const g = reduceGray(gray, w, h, HASH_W, HASH_H);
    const bits = new Uint8Array(TOTAL_BITS);

    // 1. Пространственная часть: перепад яркости между соседними пикселями
    //    строки. Именно она ловит «картинка поменялась» (новая карта, сдвиг).
    let k = 0;
    for (let y = 0; y < HASH_H; y++) {
      const row = y * HASH_W;
      for (let x = 0; x < SPATIAL_PER_ROW; x++) {
        bits[k++] = g[row + x] > g[row + x + 1] ? 1 : 0;
      }
    }

    // 2. Часть абсолютной яркости: белый и чёрный кадры не должны совпасть.
    let sum = 0;
    for (let i = 0; i < g.length; i++) sum += g[i];
    const mean = sum / g.length;
    for (let i = 0; i < BRIGHT_THRESHOLDS.length; i++) {
      bits[k++] = mean > BRIGHT_THRESHOLDS[i] ? 1 : 0;
    }

    return bitsToHex(bits);
  }

  /**
   * Хеш кадра из RGBA с предварительным уменьшением по большей стороне.
   * opts = { downscale: 320 } — предел по большей стороне (по умолчанию 320).
   * Уменьшать нужно и ради скорости (в 20+ раз меньше пикселей), и ради
   * устойчивости: усреднение блоков само по себе давит мелкий шум.
   */
  function dhashFromRgba(rgba, w, h, opts) {
    assertSize(w, h);
    const o = opts || {};
    // null/undefined -> 320, явный 0 или отрицательное -> без уменьшения.
    const maxSide = o.downscale == null ? 320 : o.downscale;
    const small = maxSide > 0 ? downscaleRgba(rgba, w, h, maxSide) : { data: rgba, w: w, h: h };
    return dhash(toGray(small.data, small.w, small.h), small.w, small.h);
  }

  /**
   * Расстояние Хэмминга между двумя hex-хешами: сколько бит различается (0..64).
   */
  function hamming(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
      throw new Error('frame_diff: hamming ожидает две hex-строки');
    }
    if (a.length !== b.length) {
      throw new Error('frame_diff: хеши разной длины (' + a.length + ' и ' + b.length + ')');
    }
    let bits = 0;
    for (let i = 0; i < a.length; i++) {
      const ca = a.charCodeAt(i);
      const cb = b.charCodeAt(i);
      const va = ca < 128 ? HEX_VALUE[ca] : -1;
      const vb = cb < 128 ? HEX_VALUE[cb] : -1;
      if (va < 0 || vb < 0) throw new Error('frame_diff: не hex-символ в позиции ' + i);
      bits += POPCOUNT[va ^ vb];
    }
    return bits;
  }

  /**
   * Считаются ли кадры одинаковыми. threshold — допустимое число различающихся
   * бит (по умолчанию 4): шум и пересжатие дают 0..2 бита, реальное изменение
   * картинки — обычно десятки бит.
   */
  function isSame(a, b, threshold) {
    const limit = threshold == null ? 4 : threshold;
    return hamming(a, b) <= limit;
  }

  const FrameDiff = {
    dhash: dhash,
    dhashFromRgba: dhashFromRgba,
    hamming: hamming,
    isSame: isSame,
    downscaleRgba: downscaleRgba,
    toGray: toGray,
    // Константы полезны вызывающему коду и тестам.
    HASH_W: HASH_W,
    HASH_H: HASH_H,
    BITS: TOTAL_BITS,
    DEFAULT_THRESHOLD: 4,
    DEFAULT_DOWNSCALE: 320
  };

  root.FrameDiff = FrameDiff;
  if (typeof module !== 'undefined' && module.exports) module.exports = FrameDiff;
})(typeof self !== 'undefined' ? self : globalThis);
