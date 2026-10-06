'use strict';

const HandEval = require('./hand_eval.js');
const MonteCarloSimulator = require('./monte_carlo.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ok    ' + name);
  } else {
    failed++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : ''));
  }
}
function checkNear(name, actual, expected, tol) {
  const ok = Math.abs(Number(actual) - expected) <= tol;
  check(name, ok, 'получено ' + actual + ', эталон ' + expected + ' ±' + tol);
}

const mc = new MonteCarloSimulator({ seed: 20240607 });
const ITERS = 20000;

const SUITS = ['s', 'h', 'd', 'c'];
const RANKS = '23456789TJQKA';
const DECK = [];
for (const s of SUITS) for (const r of RANKS) DECK.push(r + s);
const ALL_HANDS = [];
for (let i = 0; i < 52; i++) for (let j = i + 1; j < 52; j++) ALL_HANDS.push([DECK[i], DECK[j]]);

console.log('\n1. Базовые свойства движка диапазонов');

(function combos() {
  const p = mc.combosForHandKey('AA');
  check('пара AA = 6 комбинаций', p.length === 6, String(p.length));
  const s = mc.combosForHandKey('AKs');
  check('AKs = 4 комбинации', s.length === 4, String(s.length));
  const o = mc.combosForHandKey('AKo');
  check('AKo = 12 комбинаций', o.length === 12, String(o.length));
  check('некорректный ключ -> пусто', mc.combosForHandKey('XX').length === 0);
  check('комбинации не повторяются',
    new Set(p.map((c) => c.join('-'))).size === 6);
})();

(function uniformEqualsRandom() {
  // Диапазон «все руки» должен дать то же, что и против случайной руки.
  const all = {};
  for (let i = 0; i < ALL_HANDS.length; i++) {
    const c = HandEval.parseCards(ALL_HANDS[i]);
    const key = normalize(c[0], c[1]);
    all[key] = (all[key] || 0) + 1;
  }
  // Нормируем так, чтобы каждая рука весила 1 (как в случайной раздаче).
  const uniform = {};
  Object.keys(all).forEach((k) => { uniform[k] = 1; });

  const random = mc.computeWinRate(['As', 'Ah'], [], 1, ITERS).equity;
  const ranged = mc.computeWinRateVsRange(['As', 'Ah'], [], {
    range: uniform, opponents: 1, iterations: ITERS
  }).equity;
  checkNear('AA против «всех рук» = против случайной руки', ranged, random, 1.5);
})();

function normalize(c1, c2) {
  const order = '23456789TJQKA';
  const r1 = order.indexOf(c1.rank);
  const r2 = order.indexOf(c2.rank);
  const suited = c1.suit === c2.suit;
  let high, low;
  if (r1 >= r2) { high = c1.rank; low = c2.rank; } else { high = c2.rank; low = c1.rank; }
  if (high === low) return high + low;
  return high + low + (suited ? 's' : 'o');
}

console.log('\n2. Сверка с полным перебором (точные значения)');

/**
 * Точное эквити против диапазона: перебираем все комбинации диапазона
 * и все доски до конца.
 */
function exactVsRange(hero, board, range) {
  const heroKeys = new Set(HandEval.parseCards(hero).map((c) => c.rank + c.suit));
  const boardKeys = new Set(HandEval.parseCards(board).map((c) => c.rank + c.suit));
  const blocked = new Set([...heroKeys, ...boardKeys]);
  const boardNeed = 5 - HandEval.parseCards(board).length;

  let weightSum = 0, winSum = 0, tieSum = 0;
  const rest = DECK.filter((c) => !blocked.has(c));

  for (const key of Object.keys(range)) {
    const w = Number(range[key]);
    if (!(w > 0)) continue;
    const combos = mc.combosForHandKey(key);
    for (const combo of combos) {
      const c1 = codeToCard(combo[0]);
      const c2 = codeToCard(combo[1]);
      if (blocked.has(c1) || blocked.has(c2)) continue;
      const pool = rest.filter((c) => c !== c1 && c !== c2);
      let winLocal = 0, tieLocal = 0, n = 0;
      if (boardNeed === 0) {
        const hv = HandEval.evaluateHand(hero, board).value;
        const ov = HandEval.evaluateHand([c1, c2], board).value;
        n = 1;
        if (hv > ov) winLocal = 1; else if (hv === ov) tieLocal = 1;
      } else {
        for (let a = 0; a < pool.length; a++) {
          for (let b = a + 1; b < pool.length; b++) {
            if (boardNeed === 2) {
              const full = HandEval.parseCards(board).concat([pool[a], pool[b]]);
              const hv = HandEval.evaluateHand(hero, full).value;
              const ov = HandEval.evaluateHand([c1, c2], full).value;
              n++;
              if (hv > ov) winLocal++; else if (hv === ov) tieLocal++;
            }
          }
        }
      }
      weightSum += w;
      winSum += w * winLocal / n;
      tieSum += w * tieLocal / n;
    }
  }
  if (!weightSum) return null;
  // Итоговое эквити = доля побед + половина ничьих, взвешенно по комбинациям.
  return +(((winSum + tieSum / 2) / weightSum) * 100).toFixed(2);
}

function codeToCard(code) {
  return RANKS[Math.floor(code / 4)] + SUITS[code % 4];
}

// Флоп: герой с парой королей, на борде туз. Считаем против узкого диапазона.
(function exactFlop() {
  const hero = ['Ks', 'Kh'];
  const board = ['Ad', '7c', '2h'];
  const range = { AA: 1, AK: 1, AQ: 1, KK: 1, QQ: 1, JJ: 1, 'A5s': 1 };
  const exact = exactVsRange(hero, board, range);
  const mcRes = mc.computeWinRateVsRange(hero, board, { range: range, opponents: 1, iterations: 40000 });
  console.log('   точный перебор: ' + exact + '%, Монте-Карло: ' + mcRes.equity + '%');
  checkNear('KK на борде A-7-2 против узкого диапазона', mcRes.equity, exact, 1.5);
})();

// Ривер: борд полный, проверяем точное совпадение логики.
(function exactRiver() {
  const hero = ['As', 'Ah'];
  const board = ['Ad', '7c', '2h', '9s', '3d'];
  const range = { AK: 1, AQ: 1, '77': 1, '22': 1, '99': 1, '33': 1 };
  const exact = exactVsRange(hero, board, range);
  const mcRes = mc.computeWinRateVsRange(hero, board, { range: range, opponents: 1, iterations: 30000 });
  console.log('   ривер: точный ' + exact + '%, МК ' + mcRes.equity + '%');
  checkNear('сет тузов на ривере против диапазона сетов', mcRes.equity, exact, 1.5);
})();

console.log('\n3. Смысл: диапазон сильнее случайной руки');

(function tighterIsWorse() {
  const hero = ['7d', '2c'];
  const board = ['Ah', 'Kh', 'Qh'];
  const randomEq = mc.computeWinRate(hero, board, 1, ITERS).equity;
  const tight = mc.computeWinRateVsRange(hero, board, {
    range: { AA: 1, KK: 1, QQ: 1, AK: 1, AQ: 1, 'KQ': 1, JJ: 1, 'TT': 1 },
    opponents: 1, iterations: ITERS
  }).equity;
  console.log('   72o на A-K-Q одномастных: против случайной ' + randomEq + '%, против диапазона ' + tight + '%');
  check('против сильного диапазона эквити ниже, чем против случайной руки', tight < randomEq, tight + ' < ' + randomEq);
  check('72o на A-K-Q одномастных против диапазона — меньше 20%', tight < 20, String(tight));
})();

(function strongHandHolds() {
  const hero = ['7s', '7h'];
  const board = ['7d', 'Kc', '2h'];
  const eq = mc.computeWinRateVsRange(hero, board, {
    range: { AA: 1, KK: 1, 'KQ': 1, 'KJ': 1, '22': 1, 'AK': 1, QQ: 1 },
    opponents: 1, iterations: ITERS
  }).equity;
  console.log('   сет семёрок на 7-K-2 против диапазона: ' + eq + '%');
  check('сет семёрок против диапазона даёт > 80%', eq > 80, String(eq));
})();

(function rangeNarrowing() {
  const hero = ['Qs', 'Qh'];
  const board = ['Jd', '8c', '3h'];
  const wide = mc.computeWinRateVsRange(hero, board, {
    range: wideRange(), opponents: 1, iterations: ITERS
  }).equity;
  const narrow = mc.computeWinRateVsRange(hero, board, {
    range: { AA: 1, KK: 1, QQ: 1, JJ: 1, AK: 1, 'AJ': 1 },
    opponents: 1, iterations: ITERS
  }).equity;
  console.log('   QQ на J-8-3: против широкого ' + wide + '%, против узкого ' + narrow + '%');
  check('против узкого сильного диапазона эквити ниже', narrow < wide, narrow + ' < ' + wide);
})();

function wideRange() {
  const out = {};
  const order = '23456789TJQKA';
  for (let i = 0; i < order.length; i++) {
    for (let j = i; j < order.length; j++) {
      const hi = order[j], lo = order[i];
      if (hi === lo) { out[hi + lo] = 1; continue; }
      out[hi + lo + 's'] = 1;
      out[hi + lo + 'o'] = 1;
    }
  }
  return out;
}

console.log('\n4. Несколько соперников и веса');

(function multiOpponents() {
  const hero = ['As', 'Ah'];
  const range = wideRange();
  const one = mc.computeWinRateVsRange(hero, [], { range: range, opponents: 1, iterations: ITERS }).equity;
  const three = mc.computeWinRateVsRange(hero, [], { range: range, opponents: 3, iterations: ITERS }).equity;
  console.log('   AA против 1 / 3 рук из диапазона: ' + one + '% / ' + three + '%');
  check('AA: эквити падает с ростом числа соперников', three < one, three + ' < ' + one);
  check('AA против 3 рук из широкого диапазона > 55%', three > 55, String(three));
})();

(function weights() {
  // Диапазон только из AA должен давать эквити, совпадающее с точным AA vs AA.
  const vsAA = mc.computeWinRateVsRange(['Ks', 'Kh'], [], { range: { AA: 1 }, opponents: 1, iterations: 40000 }).equity;
  checkNear('KK против диапазона «только AA» = 18.1%', vsAA, 18.1, 1.5);
})();

(function combosAccounting() {
  const r = mc.computeWinRateVsRange(['As', 'Ah'], [], {
    range: { KK: 1, QQ: 1 }, opponents: 1, iterations: 2000
  });
  // KK и QQ — по 6 комбинаций, минус заблокированные тузами не блокируются.
  check('учёт комбинаций диапазона: KK+QQ = 12', r.combosInRange === 12, String(r.combosInRange));
  check('процент диапазона посчитан', r.rangePercent > 0 && r.rangePercent < 2, String(r.rangePercent));
})();

console.log('\n5. Устойчивость и валидация');

(function repeatability() {
  const range = { 'AKs': 1, 'QQ': 1, '77': 0.5 };
  const a = mc.computeWinRateVsRange(['As', 'Ks'], ['Qh', '7d', '2c'], { range: range, opponents: 1, iterations: 20000 }).equity;
  const b = mc.computeWinRateVsRange(['As', 'Ks'], ['Qh', '7d', '2c'], { range: range, opponents: 1, iterations: 20000 }).equity;
  check('разброс между прогонами < 2 п.п.', Math.abs(a - b) < 2, a + ' vs ' + b);
})();

(function blockedRange() {
  // Все руки диапазона заблокированы бордом и рукой героя.
  let threw = false;
  try {
    mc.computeWinRateVsRange(['As', 'Ah'], ['Ad', 'Ac', 'Kh'], {
      range: { AA: 1 }, opponents: 1, iterations: 1000
    });
  } catch (e) { threw = true; }
  check('полностью заблокированный диапазон -> исключение', threw);
})();

(function zeroWeights() {
  let threw = false;
  try {
    mc.computeWinRateVsRange(['As', 'Ah'], [], {
      range: { AA: 0, KK: 0 }, opponents: 1, iterations: 1000
    });
  } catch (e) { threw = true; }
  check('нулевые веса -> исключение', threw);
})();

(function invalidInput() {
  let threw = 0;
  try { mc.computeWinRateVsRange(['As'], [], { range: { KK: 1 }, iterations: 100 }); } catch (e) { threw++; }
  try { mc.computeWinRateVsRange(['As', 'Ah'], ['Ks'], { range: { KK: 1 }, iterations: 100 }); } catch (e) { threw++; }
  try { mc.computeWinRateVsRange(['As', 'Ah'], [], { range: { ZZ: 1 }, iterations: 100 }); } catch (e) { threw++; }
  check('некорректный ввод отвергается (3 случая)', threw === 3, 'перехвачено: ' + threw);
})();

(function boardDoesNotCollide() {
  // Карты диапазона не должны совпадать с бордом: иначе эквити уедет.
  const range = { AA: 1, KK: 1, QQ: 1, JJ: 1, TT: 1 };
  const eq = mc.computeWinRateVsRange(['As', 'Ks'], ['Ad', 'Kd', 'Qd'], {
    range: range, opponents: 1, iterations: 40000
  });
  // На борде A-K-Q: две пары героя (A и K) плюс дама на борде.
  // Против JJ и TT герой впереди, против AA/KK/QQ — позади.
  check('эквити в разумных границах (10..70%)', eq.equity > 10 && eq.equity < 70, String(eq.equity));
  check('учтено блокирование: комбинаций меньше исходных 30', eq.combosInRange < 30, String(eq.combosInRange));
})();

console.log('\n6. Производительность');
(function speed() {
  const range = wideRange();
  const t0 = Date.now();
  mc.computeWinRateVsRange(['As', 'Ks'], ['Qh', '7d', '2c'], { range: range, opponents: 1, iterations: 20000 });
  const ms = Date.now() - t0;
  console.log('  20 000 итераций против диапазона из 169 рук: ' + ms + ' мс');
  check('расчёт против диапазона укладывается в 3 секунды', ms < 3000, ms + ' мс');
})();

console.log('\n' + '='.repeat(58));
console.log('Пройдено: ' + passed + ', провалено: ' + failed);
if (failed) {
  console.log('\nПровалы:');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('='.repeat(58));
process.exit(failed ? 1 : 0);
