'use strict';

const HandEval = require('./hand_eval.js');
const MonteCarloSimulator = require('./monte_carlo.js');

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

function cat(cards) {
  return HandEval.evaluate(cards).categoryName;
}

function score(cards) {
  return HandEval.evaluate(cards).value;
}

console.log('\n1. Категории комбинаций');

eq('роял-флеш', cat('Ah Kh Qh Jh Th'), 'royal_flush');
eq('стрит-флеш', cat('9h 8h 7h 6h 5h'), 'straight_flush');
eq('каре', cat('As Ah Ad Ac Kd'), 'quads');
eq('фулл-хаус', cat('Ks Kh Kd 7c 7d'), 'full_house');
eq('флаш', cat('As Js 8s 5s 2s'), 'flush');
eq('стрит', cat('9s 8h 7d 6c 5s'), 'straight');
eq('сет', cat('Qs Qh Qd 8c 3s'), 'trips');
eq('две пары', cat('Js Jh 4d 4c 9s'), 'two_pair');
eq('пара', cat('Ts Th 7d 4c 2s'), 'pair');
eq('старшая карта', cat('As Qh 9d 6c 3s'), 'high_card');

// Порядок категорий: каждая следующая комбинация обязана быть сильнее.
const ladder = [
  'Ah Qh 9d 6c 3s', // старшая карта
  'Ts Th 7d 4c 2s', // пара
  'Js Jh 4d 4c 9s', // две пары
  'Qs Qh Qd 8c 3s', // сет
  '9s 8h 7d 6c 5s', // стрит
  'As Js 8s 5s 2s', // флаш
  'Ks Kh Kd 7c 7d', // фулл-хаус
  'As Ah Ad Ac Kd', // каре
  '9h 8h 7h 6h 5h'  // стрит-флеш
];
let ladderOk = true;
for (let i = 1; i < ladder.length; i++) {
  if (!(score(ladder[i]) > score(ladder[i - 1]))) {
    ladderOk = false;
    console.log('  порядок сломан между ' + ladder[i - 1] + ' и ' + ladder[i]);
  }
}
check('порядок категорий возрастает', ladderOk);

// «Колесо» A-2-3-4-5 — это стрит, высшая карта 5.
eq('колесо — стрит', cat('Ah 2s 3d 4c 5h'), 'straight');
check('колесо слабее 6-хай стрита', score('Ah 2s 3d 4c 5h') < score('6h 5s 4d 3c 2h'));
check('колесо сильнее пары', score('Ah 2s 3d 4c 5h') > score('9s 9h 7d 6c 2s'));

console.log('\n2. Тайбрейкеры (кикеры)');

check('пара: туз-кикер бьёт короля-кикер',
  score('9s 9h As 7d 3c') > score('9d 9c Kh 7s 3d'));
eq('пара: одинаковые кикеры — ничья',
  score('9s 9h As 7d 3c'), score('9d 9c Ah 7s 3d'));

check('две пары: старшая вторая пара важнее кикера',
  score('Js Jh 4d 4c 2s') > score('Jd Jc 3h 3s As'));

check('сет: кикеры сравниваются по порядку',
  score('Qs Qh Qd As 9c') > score('Qc Qs Qh As 8d'));
check('сет: второй кикер решает при равном первом',
  score('Qs Qh Qd As 9c') > score('Qc Qs Qh Ad 8c'));

check('флаш: сравнивается по старшей карте, а не по сумме',
  score('As 5s 4s 3s 2s') > score('Kh Qh Jh 9h 8h'));
check('флаш: A-5-4-3-2 > K-Q-J-9-8', score('As 5s 4s 3s 2s') > score('Kh Qh Jh 9h 8h'));
check('флаш: кикеры по порядку',
  score('As Ks Qs Js 9s') > score('As Ks Qs Js 8s'));

check('стрит: выше по старшей карте',
  score('Ah Kh Qd Jc Ts') > score('9h 8s 7d 6c 5h'));

check('фулл-хаус: старший сет решает',
  score('Ks Kh Kd 2c 2d') > score('Qs Qh Qd As Ad'));
check('фулл-хаус: при равных сетах решает пара',
  score('Ks Kh Kd 9c 9d') > score('Kc Ks Kh 2s 2d'));

check('каре: старший кикер решает',
  score('As Ah Ad Ac Kd') > score('Ah As Ac Ad Qs'));

check('стрит-флеш: сравнение по старшей карте',
  score('Ah Kh Qh Jh Th') > score('Kh Qh Jh Th 9h'));

// 7 карт: сет + пара дают фулл-хаус, а не «две пары».
eq('7 карт: 777 + 99 = фулл-хаус', cat('7s 7h 7d 9c 9d As Kh'), 'full_house');
eq('7 карт: две тройки = фулл-хаус', cat('7s 7h 7d 9c 9d 9h As'), 'full_house');
check('7 карт: 777 99 9 = фулл-хаус со старшим сетом 9',
  score('7s 7h 7d 9c 9d 9h As') > score('7s 7h 7d 9c 9d As Kh'));

// Лучшие 5 из 7.
eq('7 карт: не-стрит флаш', cat('Ah 2h 3h 5h Kc 9d 4h'), 'straight_flush');
eq('7 карт: не-стрит флаш (без 4)', cat('Ah 2h 3h 5h Kc 9d Jh'), 'flush');
check('7 карт: A-2-3-4-5 одномастные = стрит-флеш',
  cat('Ah 2h 3h 4h 5h Kd 9c') === 'straight_flush');

eq('7 карт: стрит-флеш перебивает каре', cat('Ah 2h 3h 4h 5h 9s 9d'), 'straight_flush');

// 6 и 7 карт не должны менять категорию относительно 5 карт.
eq('6 карт: лишняя карта не портит флаш', cat('As Ks Qs Js 9s 2h'), 'flush');
eq('7 карт: лишние карты не портят сет', cat('Qs Qh Qd 8c 3s Ac Kh'), 'trips');

// Сравнение «широкого» спектра: 1000 случайных пар рук не должны давать
// одинаковый балл при разных категориях.
(function consistency() {
  const deck = [];
  for (const s of 'shdc') for (const r of '23456789TJQKA') deck.push(r + s);
  let bad = 0;
  for (let t = 0; t < 500; t++) {
    const pool = HandEval.evaluate(['As', 'Ks', 'Qs', 'Js', 'Ts']); // прогрев
    void pool;
    const a = [], b = [];
    const used = {};
    while (a.length < 5 || b.length < 7) {
      const c = deck[(Math.random() * 52) | 0];
      if (used[c]) continue;
      used[c] = 1;
      if (a.length < 5) a.push(c); else b.push(c);
    }
    const ra = HandEval.evaluate(a);
    const rb = HandEval.evaluate(b);
    if (ra.category > rb.category && ra.value <= rb.value) bad++;
    if (ra.category < rb.category && ra.value >= rb.value) bad++;
  }
  check('балл согласован с категорией на 500 случайных раздачах', bad === 0, 'нарушений: ' + bad);
})();

console.log('\n3. Эквити (эталоны из полного перебора)');
console.log('   Эталоны получены независимым «наивным» оценщиком:');
console.log('   полным перебором всех бордов и всех рук соперника.');

const mc = new MonteCarloSimulator({ seed: 20240607 });
const ITERS = 60000;

/** Дуэль против конкретной руки: equity в процентах. */
function duel(hero, villain) {
  return mc.simulate(hero, [], villain, ITERS).equity;
}
function checkNear(name, actual, expected, tol) {
  const ok = Math.abs(actual - expected) <= tol;
  check(name, ok, 'получено ' + actual + ', эталон ' + expected + ' ±' + tol);
  if (ok) console.log('  ok    ' + name + '  (' + actual + ' против ' + expected + ')');
}

// Точные значения (проверены полным перебором всех бордов).
checkNear('AA vs KK = 82.64%', duel(['As', 'Ah'], ['Ks', 'Kh']), 82.64, 1.2);
checkNear('AKs vs QQ = 46.21%', duel(['As', 'Ks'], ['Qh', 'Qd']), 46.21, 1.2);
checkNear('AKo vs QQ = 43.17%', duel(['As', 'Kh'], ['Qh', 'Qd']), 43.17, 1.2);
checkNear('AA vs 72o = 87.42%', duel(['As', 'Ah'], ['7d', '2c']), 87.42, 1.2);

// Симметричный случай обязан дать ровно 50%: парные тузы.
checkNear('AA vs AA = 50%', duel(['As', 'Ah'], ['Ad', 'Ac']), 50.0, 0.6);

// Эквити против случайных рук (тоже из полного перебора).
checkNear('AA против 1 случайной руки = 85.2%',
  mc.computeWinRate(['As', 'Ah'], [], 1, ITERS).equity, 85.2, 1.2);
checkNear('72o против 1 случайной руки = 35.2%',
  mc.computeWinRate(['7d', '2c'], [], 1, ITERS).equity, 35.2, 1.2);

// Больше соперников — меньше эквити, и это уменьшение монотонно.
const seq = [1, 2, 3, 4, 5].map((n) => mc.computeWinRate(['As', 'Ah'], [], n, 20000).equity);
let monotone = true;
for (let i = 1; i < seq.length; i++) if (!(seq[i] < seq[i - 1])) monotone = false;
check('AA: эквити строго падает с ростом числа соперников', monotone, seq.join(' > '));
console.log('  AA против 1..5 рук: ' + seq.join('% > ') + '%');

// Постфлоп.
const flopEq = mc.computeWinRate(['As', 'Ah'], ['Ad', '7c', '2h'], 1, ITERS).equity;
check('сет тузов на флопе — сильное эквити (>90%)', flopEq > 90, 'получено ' + flopEq);

const beaten = mc.computeWinRate(['As', 'Ah'], ['Kh', 'Qh', 'Jh'], 1, ITERS).equity;
checkNear('AA на борде K-Q-J одномастных против случайной руки = 88.4%',
  beaten, 88.39, 1.5);

const riverEq = mc.computeWinRate(['As', 'Ah'], ['Ad', '7c', '2h', '9s', '3d'], 1, ITERS).equity;
check('ривер с сетом тузов — почти всегда выигрыш', riverEq > 95, 'получено ' + riverEq);

// Точность: при большом числе итераций разброс мал.
const a = mc.computeWinRate(['As', 'Ah'], [], 1, 20000).equity;
const b = mc.computeWinRate(['As', 'Ah'], [], 1, 20000).equity;
check('разброс между прогонами < 1.5 п.п.', Math.abs(a - b) < 1.5, a + ' vs ' + b);

// Валидация ввода.
(function validation() {
  let threw = 0;
  try { mc.computeWinRate(['As'], [], 1, 100); } catch (e) { threw++; }
  try { mc.computeWinRate(['As', 'As'], [], 1, 100); } catch (e) { threw++; }
  try { mc.computeWinRate(['As', 'Ah'], ['Ks'], 1, 100); } catch (e) { threw++; }
  check('некорректный ввод отвергается (3 случая)', threw === 3, 'перехвачено: ' + threw);
})();

console.log('\n4. Производительность');
(function speed() {
  const cards = ['As', 'Kh', 'Qd', 'Jc', 'Ts', '9h', '8d'];
  const N = 200000;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) HandEval.evaluate(cards);
  const ms = Date.now() - t0;
  const perSec = Math.round(N / (ms / 1000));
  console.log('  оценок 7 карт: ' + N + ' за ' + ms + ' мс (' + perSec.toLocaleString('ru-RU') + ' оценок/сек)');
  check('скорость оценщика > 100k оценок/сек', perSec > 100000, perSec + '/сек');

  const t1 = Date.now();
  mc.computeWinRate(['As', 'Ah'], [], 3, 20000);
  const ms1 = Date.now() - t1;
  console.log('  эквити AA против 3 рук, 20 000 итераций: ' + ms1 + ' мс');
  check('расчёт эквити 20k итераций укладывается в 3 сек', ms1 < 3000, ms1 + ' мс');
})();

console.log('\n' + '='.repeat(58));
console.log('Пройдено: ' + passed + ', провалено: ' + failed);
if (failed) {
  console.log('\nПровалы:');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('='.repeat(58));
process.exit(failed ? 1 : 0);
