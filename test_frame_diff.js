'use strict';

const FrameDiff = require('./frame_diff.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : ''));
  }
}

function eq(name, actual, expected, tol) {
  const ok = tol != null ? Math.abs(actual - expected) <= tol : actual === expected;
  check(name, ok, 'получено ' + actual + ', ожидалось ' + expected + (tol != null ? ' ±' + tol : ''));
}

/** Сплошная заливка RGBA размером w x h. */
function solid(w, h, r, g, b, a) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    out[p] = r; out[p + 1] = g; out[p + 2] = b; out[p + 3] = a == null ? 255 : a;
  }
  return out;
}

/** Детерминированный ГПСЧ (mulberry32) — тесты не должны «мигать». */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * «Кадр стола»: крупные блоки случайной яркости (имитация стола, карт и
 * текста) плюс лёгкая подсветка. Крупные блоки нужны, чтобы сдвиг на 5%
 * реально менял содержимое блоков усреднения 9x8, как в настоящем скриншоте.
 */
function tableLike(w, h, cellW, cellH, seed) {
  const rnd = rng(seed);
  const out = new Uint8ClampedArray(w * h * 4);
  const cols = Math.ceil(w / cellW) + 1;
  const rows = Math.ceil(h / cellH) + 1;
  const cells = new Float64Array(cols * rows);
  for (let i = 0; i < cells.length; i++) cells[i] = 40 + Math.round(rnd() * 175);
  for (let y = 0; y < h; y++) {
    const cy = Math.floor(y / cellH);
    for (let x = 0; x < w; x++) {
      const cx = Math.floor(x / cellW);
      const v = cells[cy * cols + cx];
      const p = (y * w + x) * 4;
      out[p] = v;
      out[p + 1] = Math.min(255, v + (x % 7));
      out[p + 2] = Math.max(0, v - (y % 5));
      out[p + 3] = 255;
    }
  }
  return out;
}

/** Шум ±amp к каждому каналу, детерминированный. */
function addNoise(rgba, amp, seed) {
  const rnd = rng(seed);
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const d = Math.round((rnd() * 2 - 1) * amp);
    out[i] = rgba[i] + d;
    out[i + 1] = rgba[i + 1] + d;
    out[i + 2] = rgba[i + 2] + d;
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

/** Сдвиг по горизонтали с заворотом (чтобы средняя яркость не менялась). */
function shiftX(rgba, w, h, dx) {
  const out = new Uint8ClampedArray(rgba.length);
  const s = ((dx % w) + w) % w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + ((x + s) % w)) * 4;
      const dst = (y * w + x) * 4;
      out[dst] = rgba[src];
      out[dst + 1] = rgba[src + 1];
      out[dst + 2] = rgba[src + 2];
      out[dst + 3] = rgba[src + 3];
    }
  }
  return out;
}

/** Градиент по горизонтали: 0 -> 255 либо 255 -> 0. */
function gradient(w, h, reverse) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = reverse ? 1 - x / (w - 1) : x / (w - 1);
      const v = Math.round(t * 255);
      const p = (y * w + x) * 4;
      rgba[p] = v; rgba[p + 1] = v; rgba[p + 2] = v; rgba[p + 3] = 255;
    }
  }
  return rgba;
}

/** Все цветовые каналы буфера RGBA равны value (альфа не проверяется). */
function rgbAllEqual(data, value) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== value || data[i + 1] !== value || data[i + 2] !== value) return false;
  }
  return true;
}

/** Все значения альфы равны value. */
function alphaAllEqual(data, value) {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== value) return false;
  }
  return true;
}

const W = 800;
const H = 450;const base = tableLike(W, H, 80, 60, 12345);
const baseHash = FrameDiff.dhashFromRgba(base, W, H, { downscale: 320 });

console.log('\n1. Одинаковые кадры');
{
  const copy = new Uint8ClampedArray(base); // побайтовая копия того же кадра
  const h2 = FrameDiff.dhashFromRgba(copy, W, H, { downscale: 320 });
  eq('хеш того же кадра совпадает', h2, baseHash);
  eq('hamming одинаковых кадров = 0', FrameDiff.hamming(baseHash, h2), 0);
  check('isSame одинаковых кадров', FrameDiff.isSame(baseHash, h2) === true);
  // И то же самое напрямую по массиву яркостей (без RGBA-пути).
  // Отличие возможно на 1 бит: RGBA-путь сначала усредняет цвет, а потом
  // считает яркость, «серый» путь — наоборот; порядок округлений разный.
  const gray = FrameDiff.toGray(base, W, H);
  const grayHash = FrameDiff.dhash(gray, W, H);
  const grayDiff = FrameDiff.hamming(grayHash, baseHash);
  console.log('  hamming(хеш из RGBA, хеш из серого) = ' + grayDiff);
  eq('dhash по яркостям детерминирован', FrameDiff.dhash(gray, W, H), grayHash);
  check('RGBA-путь и серый путь дают один хеш (±1 бит округления)', grayDiff <= 1, 'hamming ' + grayDiff);
  check('оба пути считают кадры одинаковыми', FrameDiff.isSame(grayHash, baseHash) === true, 'hamming ' + grayDiff);
}

console.log('\n2. Шум ±2 на каждый пиксель');
{
  const noisy = addNoise(base, 2, 777);
  const h = FrameDiff.dhashFromRgba(noisy, W, H, { downscale: 320 });
  const d = FrameDiff.hamming(baseHash, h);
  console.log('  hamming(кадр, кадр+шум±2) = ' + d);
  check('шум ±2: hamming <= 2', d <= 2, 'hamming ' + d);
  check('шум ±2: isSame === true', FrameDiff.isSame(baseHash, h) === true, 'hamming ' + d);
  // Даже заметно более сильный шум ±4 не должен ломать отпечаток.
  const noisy4 = addNoise(base, 4, 778);
  const d4 = FrameDiff.hamming(baseHash, FrameDiff.dhashFromRgba(noisy4, W, H, { downscale: 320 }));
  console.log('  hamming(кадр, кадр+шум±4) = ' + d4);
  check('шум ±4: isSame === true', FrameDiff.isSame(baseHash, FrameDiff.dhashFromRgba(noisy4, W, H, { downscale: 320 })) === true, 'hamming ' + d4);
}

console.log('\n3. Сдвиг кадра на 5% по горизонтали');
{
  const shifted = shiftX(base, W, H, Math.round(W * 0.05));
  const h = FrameDiff.dhashFromRgba(shifted, W, H, { downscale: 320 });
  const d = FrameDiff.hamming(baseHash, h);
  console.log('  hamming(кадр, сдвиг 5%) = ' + d + ' из 64');
  check('сдвиг 5%: хеш заметно изменился (hamming > 8)', d > 8, 'hamming ' + d);
  check('сдвиг 5%: isSame === false', FrameDiff.isSame(baseHash, h) === false, 'hamming ' + d);
  // Совсем другой кадр (другой стол) должен отличаться ещё сильнее.
  const other = tableLike(W, H, 80, 60, 999);
  const dOther = FrameDiff.hamming(baseHash, FrameDiff.dhashFromRgba(other, W, H, { downscale: 320 }));
  console.log('  hamming(кадр, другой стол) = ' + dOther + ' из 64');
  check('другой кадр: isSame === false', FrameDiff.isSame(baseHash, FrameDiff.dhashFromRgba(other, W, H, { downscale: 320 })) === false, 'hamming ' + dOther);
}

console.log('\n4. Полностью белый и полностью чёрный кадры');
{
  const white = FrameDiff.dhashFromRgba(solid(400, 300, 255, 255, 255), 400, 300, { downscale: 320 });
  const black = FrameDiff.dhashFromRgba(solid(400, 300, 0, 0, 0), 400, 300, { downscale: 320 });
  const d = FrameDiff.hamming(white, black);
  console.log('  hash(белый) = ' + white + ', hash(чёрный) = ' + black + ', hamming = ' + d);
  check('белый и чёрный: хеши различаются', white !== black);
  check('белый и чёрный: hamming >= 4', d >= 4, 'hamming ' + d);
  check('белый и чёрный: isSame === false', FrameDiff.isSame(white, black) === false, 'hamming ' + d);
}

console.log('\n5. Градиент слева-направо против справа-налево');
{
  const lr = FrameDiff.dhashFromRgba(gradient(400, 300, false), 400, 300, { downscale: 320 });
  const rl = FrameDiff.dhashFromRgba(gradient(400, 300, true), 400, 300, { downscale: 320 });
  const d = FrameDiff.hamming(lr, rl);
  console.log('  hash(->) = ' + lr + ', hash(<-) = ' + rl + ', hamming = ' + d);
  check('направление градиента различается', lr !== rl);
  check('направление градиента: isSame === false', FrameDiff.isSame(lr, rl) === false, 'hamming ' + d);
}

console.log('\n6. Уменьшение кадра (downscaleRgba)');
{
  const big = solid(1600, 900, 255, 255, 255);
  const small = FrameDiff.downscaleRgba(big, 1600, 900, 320);
  eq('ширина 1600 -> 320', small.w, 320);
  eq('высота 900 -> 180', small.h, 180);
  check('буфер уменьшился', small.data.length === 320 * 180 * 4, 'длина ' + small.data.length);
  check('белое осталось белым после усреднения', rgbAllEqual(small.data, 255));
  const black = FrameDiff.downscaleRgba(solid(1600, 900, 0, 0, 0), 1600, 900, 320);
  check('чёрное осталось чёрным после усреднения', rgbAllEqual(black.data, 0));
  check('альфа не потерялась при уменьшении', alphaAllEqual(small.data, 255));
  // Половина белая, половина чёрная: среднее по границе не должно «уехать».
  const half = new Uint8ClampedArray(1600 * 900 * 4);
  for (let y = 0; y < 900; y++) {
    for (let x = 0; x < 1600; x++) {
      const p = (y * 1600 + x) * 4;
      const v = x < 800 ? 255 : 0;
      half[p] = v; half[p + 1] = v; half[p + 2] = v; half[p + 3] = 255;
    }
  }
  const halfSmall = FrameDiff.downscaleRgba(half, 1600, 900, 320);
  check('левая половина усреднённого кадра белая', halfSmall.data[0] === 255 && halfSmall.data[(90 * 320) * 4] === 255);
  check('правая половина усреднённого кадра чёрная', halfSmall.data[319 * 4] === 0 && halfSmall.data[(90 * 320 + 319) * 4] === 0);
  // Кадр меньше предела не уменьшается и не портится.
  const tiny = solid(100, 50, 10, 20, 30);
  const same = FrameDiff.downscaleRgba(tiny, 100, 50, 320);
  eq('маленький кадр: ширина без изменений', same.w, 100);
  eq('маленький кадр: высота без изменений', same.h, 50);
  check('маленький кадр: данные не изменились', same.data === tiny);
  // Непропорциональный размер (высота не делится нацело).
  const odd = FrameDiff.downscaleRgba(solid(101, 37, 128, 128, 128), 101, 37, 10);
  check('непропорциональный кадр: ширина 10', odd.w === 10, 'w=' + odd.w);
  check('непропорциональный кадр: высота >= 1 и < 37', odd.h >= 1 && odd.h < 37, 'h=' + odd.h);
  check('непропорциональный кадр: серый остался серым', odd.data[0] === 128 && odd.data[odd.data.length - 4] === 128);
}

console.log('\n7. Яркость (toGray)');
{
  const gRed = FrameDiff.toGray(solid(8, 8, 255, 0, 0), 8, 8);
  const gGreen = FrameDiff.toGray(solid(8, 8, 0, 255, 0), 8, 8);
  const gBlue = FrameDiff.toGray(solid(8, 8, 0, 0, 255), 8, 8);
  console.log('  яркость R=' + gRed[0] + ', G=' + gGreen[0] + ', B=' + gBlue[0]);
  eq('красный -> ~76', gRed[0], 76, 1);
  eq('зелёный -> ~149', gGreen[0], 149, 1);
  eq('синий -> ~28', gBlue[0], 28, 1);
  check('зелёный ярче красного, красный ярче синего', gGreen[0] > gRed[0] && gRed[0] > gBlue[0]);
  eq('белый -> 255', FrameDiff.toGray(solid(4, 4, 255, 255, 255), 4, 4)[0], 255);
  eq('чёрный -> 0', FrameDiff.toGray(solid(4, 4, 0, 0, 0), 4, 4)[0], 0);
}

console.log('\n8. Детерминированность хеша');
{
  let same = true;
  const first = FrameDiff.dhashFromRgba(base, W, H, { downscale: 320 });
  for (let i = 0; i < 10; i++) {
    if (FrameDiff.dhashFromRgba(base, W, H, { downscale: 320 }) !== first) same = false;
  }
  check('10 прогонов дают один и тот же хеш', same);
  check('длина хеша 16 hex-символов', /^[0-9a-f]{16}$/.test(first), first);
  // Результат не зависит от того, куда мы смотрели раньше (нет общего состояния).
  const other = tableLike(W, H, 80, 60, 4242);
  FrameDiff.dhashFromRgba(other, W, H, { downscale: 320 });
  eq('хеш не зависит от предыдущих вызовов', FrameDiff.dhashFromRgba(base, W, H, { downscale: 320 }), first);
  // hamming симметричен и ограничен 64.
  const hOther = FrameDiff.dhashFromRgba(other, W, H, { downscale: 320 });
  eq('hamming симметричен', FrameDiff.hamming(first, hOther), FrameDiff.hamming(hOther, first));
  check('hamming <= 64', FrameDiff.hamming(first, hOther) <= 64);
  eq('hamming с самим собой = 0', FrameDiff.hamming(first, first), 0);
}

console.log('\n9. Производительность');
{
  const frame = tableLike(1600, 900, 80, 60, 31337);
  const N = 5;
  let best = Infinity;
  let last = '';
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    last = FrameDiff.dhashFromRgba(frame, 1600, 900, { downscale: 320 });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
  }
  console.log('  dhashFromRgba 1600x900 (downscale 320): ' + best.toFixed(2) + ' мс (лучшее из ' + N + '), hash = ' + last);
  check('1600x900 укладывается в 50 мс', best < 50, best.toFixed(2) + ' мс');
  // Полный размер без уменьшения — тоже должно быть быстро.
  const t1 = process.hrtime.bigint();
  FrameDiff.dhashFromRgba(frame, 1600, 900, { downscale: 0 });
  const ms1 = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log('  dhashFromRgba 1600x900 (без уменьшения): ' + ms1.toFixed(2) + ' мс');
  check('1600x900 без уменьшения укладывается в 200 мс', ms1 < 200, ms1.toFixed(2) + ' мс');
}

console.log('\n' + '='.repeat(58));
console.log('Пройдено: ' + passed + ', провалено: ' + failed);
if (failed) {
  console.log('\nПровалы:');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('='.repeat(58));
process.exit(failed ? 1 : 0);
