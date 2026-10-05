// =====================================================================
// test_postflop_ranges.js — проверка постфлоп-модели диапазонов
//
// Запуск:  node test_postflop_ranges.js
//
// Что проверяем:
//   1. разбор нотации диапазонов и целостность чартов (4 типа банка);
//   2. эквити против ДИАПАЗОНА ниже, чем против случайной руки
//      (главный смысл модуля);
//   3. заведомо слабые/сильные руки на конкретных бордах;
//   4. сужение диапазона по борду и агрессии реально меняет веса;
//   5. решения getAction: FOLD / CHECK / CALL / RAISE, запрет CALL без
//      ставки, сайзинги положительные и не больше эффективного стека;
//   6. поведение без HandEval / MonteCarloSimulator (модуль понятно падает,
//      а чистые функции диапазонов продолжают работать) — проверяется
//      прогоном модуля в изолированном vm-контексте без зависимостей.
// =====================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PostflopRanges = require('./postflop_ranges.js');
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

function eq(name, actual, expected) {
  check(name, actual === expected,
    'получено ' + JSON.stringify(actual) + ', ожидалось ' + JSON.stringify(expected));
}

/** 'As Ks Qs' -> ['As','Ks','Qs']; '7d2c' -> ['7d','2c']. */
function C(str) {
  return String(str).match(/(?:10|[2-9TJQKA])[shdc]/g) || [];
}

const POT_TYPES = ['srp_pfr', 'srp_caller', 'threebet', 'bb_defend'];

/** Эквити против диапазона (обёртка над публичным API). */
function equity(hole, board, potType, aggression, iterations) {
  return PostflopRanges.getEquity({
    holeCards: C(hole),
    board: C(board),
    potType: potType,
    aggression: aggression || 'bet',
    opponents: 1,
    iterations: iterations || 6000
  });
}

/** Действие (обёртка над публичным API). */
function action(hole, board, overrides) {
  const input = Object.assign({
    holeCards: C(hole),
    board: C(board),
    potType: 'srp_pfr',
    aggression: 'bet',
    potBB: 10,
    betToCallBB: 5,
    effectiveStackBB: 100,
    position: 'BTN',
    numPlayers: 2,
    iterations: 4000
  }, overrides || {});
  return PostflopRanges.getAction(input);
}

// ---------------------------------------------------------------- 1. диапазоны
console.log('\n1. Разбор нотации и целостность диапазонов');

eq('22+ = 13 пар', PostflopRanges.parseRange('22+').size, 13);
eq('TT+ = 5 пар', PostflopRanges.parseRange('TT+').size, 5);
eq('A2s+ = 12 рук', PostflopRanges.parseRange('A2s+').size, 12);
eq('K9o+ = K9o..KQo = 4 руки', PostflopRanges.parseRange('K9o+').size, 4);
eq('A2s-A5s = 4 руки', PostflopRanges.parseRange('A2s-A5s').size, 4);
eq('22-99 = 8 пар', PostflopRanges.parseRange('22-99').size, 8);
eq('T9s-54s = 6 коннекторов', PostflopRanges.parseRange('T9s-54s').size, 6);
eq('перечисление без дублей', PostflopRanges.parseRange('AKs AKo TT AKs').size, 3);
check('нижний регистр понимается',
  Array.from(PostflopRanges.parseRange('aks ako tt')).sort().join(',') === 'AKo,AKs,TT');

let parseThrew = 0;
for (const bad of ['ZZ', 'AK', 'AKx', 'A2s-A5o', 'T9s-53s']) {
  try { PostflopRanges.parseRange(bad); } catch (e) { parseThrew++; }
}
eq('5 некорректных токенов отвергаются', parseThrew, 5);

eq('комбо в 22+ (13*6)', PostflopRanges.comboCount('22+'), 78);
eq('комбо в A2s+ (12*4)', PostflopRanges.comboCount('A2s+'), 48);
eq('комбо в AKo (12)', PostflopRanges.comboCount('AKo'), 12);

eq('POT_TYPES — ровно 4 типа банка', PostflopRanges.POT_TYPES.length, 4);
check('POT_TYPES совпадает с ожидаемым списком',
  PostflopRanges.POT_TYPES.join(',') === POT_TYPES.join(','),
  PostflopRanges.POT_TYPES.join(','));

const threebetRange = PostflopRanges.getRange('threebet');
check('threebet содержит AA и AKs', threebetRange.has('AA') && threebetRange.has('AKs'));
check('threebet не содержит 72o и 22', !threebetRange.has('72o') && !threebetRange.has('22'));
check('srp_caller содержит JJ, но не AA (флэт без премиумов)',
  PostflopRanges.getRange('srp_caller').has('JJ') && !PostflopRanges.getRange('srp_caller').has('AA'));

// getRange отдаёт копию: портить чарты снаружи нельзя.
const mutable = PostflopRanges.getRange('srp_pfr');
mutable.add('72o');
check('getRange отдаёт копию (мутация не влияет на чарт)',
  !PostflopRanges.getRange('srp_pfr').has('72o'));

let rangeBad = 0;
for (const t of POT_TYPES) {
  const r = PostflopRanges.getRange(t);
  if (!(r instanceof Set) || r.size < 10) rangeBad++;
  if (!(PostflopRanges.RANGE_PERCENT[t] > 0)) rangeBad++;
}
check('у каждого типа банка непустой диапазон и процент > 0', rangeBad === 0, 'проблем: ' + rangeBad);
check('threebet уже (по проценту) srp_pfr, а bb_defend шире srp_pfr',
  PostflopRanges.RANGE_PERCENT.threebet < PostflopRanges.RANGE_PERCENT.srp_pfr &&
  PostflopRanges.RANGE_PERCENT.srp_pfr < PostflopRanges.RANGE_PERCENT.bb_defend,
  JSON.stringify(PostflopRanges.RANGE_PERCENT));
eq('алиас 3bet -> threebet', PostflopRanges.normalizePotType('3bet'), 'threebet');
eq('алиас bb_defend по умолчанию', PostflopRanges.normalizePotType('defend'), 'bb_defend');

let potTypeThrew = 0;
try { PostflopRanges.getRange('нет-такого'); } catch (e) { potTypeThrew++; }
try { equity('AhKd', 'As 7c 2d', 'нет-такого', 'bet'); } catch (e) { potTypeThrew++; }
eq('неизвестный potType отвергается (2 случая)', potTypeThrew, 2);

// ---------------------------------------------------------------- 2. эквити против диапазона
console.log('\n2. Эквити против диапазона');

const shape = equity('AhKd', 'As 7c 2d', 'srp_pfr', 'bet', 3000);
check('getEquity отдаёт equity числом 0..100',
  typeof shape.equity === 'number' && shape.equity >= 0 && shape.equity <= 100, JSON.stringify(shape.equity));
check('getEquity отдаёт combosInRange > 0', shape.combosInRange > 0, String(shape.combosInRange));
check('getEquity отдаёт rangePercent > 0 и < 100',
  shape.rangePercent > 0 && shape.rangePercent < 100, String(shape.rangePercent));
check('getEquity отдаёт непустой rangeName', typeof shape.rangeName === 'string' && shape.rangeName.length > 0,
  String(shape.rangeName));
eq('iterations в ответе равно запрошенному', shape.iterations, 3000);

// Главное: диапазон сильнее случайной руки, значит эквити НИЖЕ.
const mc = new MonteCarloSimulator({ seed: 424242 });
const versusRandom = [
  ['AhKd', 'As 7c 2d'],
  ['8h8d', 'Ks 7c 2d'],
  ['QhJh', 'Ts 9d 2c'],
  ['Th9h', '8s 5d 2c']
];
let lowerCount = 0;
const lowerDetails = [];
for (const [h, b] of versusRandom) {
  const rnd = mc.computeWinRate(C(h), C(b), 1, 8000).equity;
  for (const pt of POT_TYPES) {
    const rng = equity(h, b, pt, 'bet', 8000).equity;
    if (rng < rnd) lowerCount++;
    else lowerDetails.push(h + ' ' + b + ' ' + pt + ': диапазон ' + rng + ' >= случайная ' + rnd);
  }
}
eq('эквити против диапазона ниже, чем против случайной руки (4 руки x 4 типа = 16)',
  lowerCount, 16);
check('детали сравнения пусты', lowerDetails.length === 0, lowerDetails.slice(0, 3).join('; '));

// 7d2c на одномастном A-K-Q: против диапазона совсем мало.
let weakMax = 0;
const weakLine = [];
for (const pt of POT_TYPES) {
  const e = equity('7d2c', 'As Ks Qs', pt, 'bet', 8000).equity;
  weakLine.push(pt + '=' + e);
  if (e > weakMax) weakMax = e;
}
check('7d2c на As Ks Qs: эквити против диапазона < 20% для всех типов банка',
  weakMax < 20, weakLine.join(' '));

// Готовый сет: эквити высокое при любом типе банка.
let setMin = 100;
const setLine = [];
for (const pt of POT_TYPES) {
  const e = equity('7s7h', '7d Kc 2h', pt, 'bet', 8000).equity;
  setLine.push(pt + '=' + e);
  if (e < setMin) setMin = e;
}
check('7s7h на 7d Kc 2h: эквити > 80% для всех типов банка', setMin > 80, setLine.join(' '));

let riverMin = 100;
for (const pt of POT_TYPES) {
  const e = equity('7s7h', '7d Kc 2h 3s 9d', pt, 'bet', 6000).equity;
  if (e < riverMin) riverMin = e;
}
check('сет на ривере: эквити > 80% (борд из 5 карт тоже считается)', riverMin > 80,
  'минимум ' + riverMin);

// Сужение по «силе линии»: threebet всегда сильнее, чем колл-диапазон.
let narrowingBad = [];
for (const [h, b] of [['8h8d', 'Ks 7c 2d'], ['9h9d', 'Ks 8c 3d'], ['AhQd', 'Jc 6s 2h']]) {
  const caller = equity(h, b, 'srp_caller', 'bet', 8000).equity;
  const three = equity(h, b, 'threebet', 'bet', 8000).equity;
  if (!(three < caller)) narrowingBad.push(h + ' ' + b + ': threebet ' + three + ' >= caller ' + caller);
}
check('эквити против threebet ниже, чем против srp_caller (3 борда)', narrowingBad.length === 0,
  narrowingBad.join('; '));

// Кэш не должен менять ответ и вообще должен работать.
const again = equity('AhKd', 'As 7c 2d', 'srp_pfr', 'bet', 3000);
eq('повторный вызов даёт тот же результат (кэш)', again.equity, shape.equity);

// Карты можно передавать объектами {rank, suit} — как их отдаёт парсер стола.
const objCards = PostflopRanges.getEquity({
  holeCards: [{ rank: 'A', suit: 'h' }, { rank: 'K', suit: 'd' }],
  board: [{ rank: 'A', suit: 's' }, { rank: '7', suit: 'c' }, { rank: '2', suit: 'd' }],
  potType: 'srp_pfr', aggression: 'bet', opponents: 1, iterations: 3000
});
eq('карты-объекты принимаются и дают тот же результат', objCards.equity, shape.equity);
eq('карты "10h" в строке понимаются как T', PostflopRanges.normalizeHand('10h', '9d'), 'T9o');

let inputThrew = 0;
try { PostflopRanges.getEquity(null); } catch (e) { inputThrew++; }
try { PostflopRanges.getEquity({}); } catch (e) { inputThrew++; }
try { PostflopRanges.getEquity({ holeCards: ['Ah'], board: C('As 7c 2d') }); } catch (e) { inputThrew++; }
try { PostflopRanges.getEquity({ holeCards: C('Ah Ad'), board: C('Ah 7c 2d') }); } catch (e) { inputThrew++; }
try { PostflopRanges.getEquity({ holeCards: C('AhKd'), board: [] }); } catch (e) { inputThrew++; }
try { PostflopRanges.getEquity({ holeCards: C('AhKd'), board: C('As Ah 7c') }); } catch (e) { inputThrew++; }
eq('некорректный ввод отвергается (6 случаев)', inputThrew, 6);

// ---------------------------------------------------------------- 3. решения getAction
console.log('\n3. Решения getAction');

const strong = action('7s7h', '7d Kc 2h', { potBB: 10, betToCallBB: 5 });
eq('сильный сет против ставки -> RAISE', strong.action, 'RAISE');
eq('источник решения', strong.source, 'postflop_ranges');
check('сайзинг рейза положительный и <= стек', strong.sizingBB > 0 && strong.sizingBB <= 100,
  String(strong.sizingBB));
check('amountFactor ~60-75% банка', strong.amountFactor >= 0.6 && strong.amountFactor <= 0.8,
  String(strong.amountFactor));
check('в reason есть эквити', /эквити/i.test(strong.reason), strong.reason);

const weakFold = action('7d2c', 'As Ks Qs', { potBB: 10, betToCallBB: 8 });
eq('мусор 7d2c против большой ставки на A-K-Q -> FOLD', weakFold.action, 'FOLD');
eq('при фолде сайзинга нет', weakFold.sizingBB, null);
check('potOdds посчитаны', weakFold.potOdds > 40 && weakFold.potOdds < 50, String(weakFold.potOdds));

const callSpot = action('QhJh', 'Ts 9d 2c', { potType: 'bb_defend', potBB: 10, betToCallBB: 5 });
eq('средняя рука с запасом по цене -> CALL', callSpot.action, 'CALL');
check('CALL: сайзинга нет', callSpot.sizingBB === null);
check('CALL: эквити выше pot odds с запасом', callSpot.equity >= callSpot.potOdds + 6,
  'эквити ' + callSpot.equity + ', pot odds ' + callSpot.potOdds);

// Ставки нет: CALL невозможен в принципе.
let zeroBetBad = [];
let zeroBetCalls = 0;
for (const h of ['7s7h', 'QhJh', '7d2c']) {
  for (const pt of POT_TYPES) {
    for (const ag of ['check', 'bet', 'raise', 'call']) {
      const r = action(h, 'Ks 8c 3d', {
        potType: pt, aggression: ag, potBB: 12, betToCallBB: 0, iterations: 1500
      });
      zeroBetCalls++;
      if (r.action === 'CALL' || (r.action !== 'RAISE' && r.action !== 'CHECK')) {
        zeroBetBad.push(h + '/' + pt + '/' + ag + ' -> ' + r.action);
      }
      if (r.potOdds !== 0) zeroBetBad.push(h + '/' + pt + '/' + ag + ' potOdds=' + r.potOdds);
    }
  }
}
eq('betToCallBB == 0: просмотрено 48 спотов', zeroBetCalls, 48);
check('betToCallBB == 0 никогда не даёт CALL и potOdds == 0', zeroBetBad.length === 0,
  zeroBetBad.slice(0, 3).join('; '));

const setCheckSpot = action('7s7h', '7d Kc 2h', { potBB: 20, betToCallBB: 0, aggression: 'check' });
eq('сильная рука без ставки -> RAISE (бет), а не CHECK', setCheckSpot.action, 'RAISE');
const weakCheckSpot = action('7d2c', 'As Ks Qs', { potBB: 20, betToCallBB: 0, aggression: 'check' });
eq('слабая рука без ставки -> CHECK', weakCheckSpot.action, 'CHECK');

// Сайзинги: положительные, не больше стека, null при не-рейзе.
let sizingBad = [];
let raiseSeen = 0;
const sizingStacks = [3, 8, 25, 100];
const sizingHands = ['7s7h', 'QhJh', '9c2s'];
const sizingBoards = ['7d Kc 2h', 'As Ks Qs'];
for (const h of sizingHands) {
  for (const b of sizingBoards) {
    for (const pt of POT_TYPES) {
      for (const stk of sizingStacks) {
        for (const bet of [0, 5]) {
          const r = action(h, b, {
            potType: pt, potBB: 10, betToCallBB: bet, effectiveStackBB: stk, iterations: 1500
          });
          if (r.action === 'RAISE') {
            raiseSeen++;
            if (!(r.sizingBB > 0)) sizingBad.push('не положительный сайзинг: ' + h + '/' + b + '/' + pt);
            if (r.sizingBB > stk) sizingBad.push('сайзинг больше стека: ' + r.sizingBB + ' > ' + stk);
            if (!(r.amountFactor > 0)) sizingBad.push('amountFactor <= 0: ' + r.amountFactor);
          } else if (r.sizingBB !== null || r.amountFactor !== null) {
            sizingBad.push('сайзинг при ' + r.action + ': ' + h + '/' + b + '/' + pt);
          }
          if (!['FOLD', 'CHECK', 'CALL', 'RAISE'].includes(r.action)) {
            sizingBad.push('неизвестное действие ' + r.action);
          }
          if (r.source !== 'postflop_ranges') sizingBad.push('неверный source ' + r.source);
        }
      }
    }
  }
}
check('матрица сайзингов: рейзы встречались', raiseSeen > 0, 'рейзов: ' + raiseSeen);
check('сайзинги всегда > 0, <= стек, null при не-рейзе (240 спотов)', sizingBad.length === 0,
  sizingBad.slice(0, 4).join('; '));

const shortStack = action('7s7h', '7d Kc 2h', { potBB: 10, betToCallBB: 5, effectiveStackBB: 3 });
check('короткий стек: рейз ограничен стеком', shortStack.sizingBB <= 3 && shortStack.sizingBB > 0,
  String(shortStack.sizingBB));

const oop = action('7s7h', '7d Kc 2h', { position: 'BB', potBB: 10, betToCallBB: 5 });
eq('без позиции решение всё ещё RAISE с сетом', oop.action, 'RAISE');

let actionInputThrew = 0;
try { action('7d2c', 'As Ks Qs', { effectiveStackBB: 0 }); } catch (e) { actionInputThrew++; }
try { action('7d2c', 'As Ks Qs', { effectiveStackBB: -5 }); } catch (e) { actionInputThrew++; }
eq('некорректный стек отвергается (2 случая)', actionInputThrew, 2);

// ---------------------------------------------------------------- 4. сужение диапазона
console.log('\n4. Сужение диапазона по борду и агрессии');

const flushBoard = PostflopRanges.getWeightedRange({
  holeCards: C('TdTh'), board: C('9s 5s 2d'), potType: 'srp_pfr', aggression: 'raise'
});
check('дро-борд + рейз: AQs (флеш-дро) весит больше, чем AQo',
  flushBoard.range.AQs > flushBoard.range.AQo,
  'AQs ' + flushBoard.range.AQs + ' vs AQo ' + flushBoard.range.AQo);
check('дро-борд + рейз: диапазон реально сузился по сравнению с базовым',
  flushBoard.rangePercent < flushBoard.basePercent,
  flushBoard.rangePercent + '% против базовых ' + flushBoard.basePercent + '%');
check('текстура борда распознана (флеш возможен, борд не спарен)',
  flushBoard.texture.flushPossible === true && flushBoard.texture.paired === false,
  JSON.stringify(flushBoard.texture));

const pairedBoard = PostflopRanges.getWeightedRange({
  holeCards: C('TdTh'), board: C('9s 9d 2c'), potType: 'srp_pfr', aggression: 'bet'
});
check('спаренный борд: сет 22 весит больше двух пар TT, а TT — больше воздуха AKs',
  pairedBoard.range['22'] > pairedBoard.range.TT && pairedBoard.range.TT > pairedBoard.range.AKs,
  '22=' + pairedBoard.range['22'] + ' TT=' + pairedBoard.range.TT + ' AKs=' + pairedBoard.range.AKs);
check('спаренность борда распознана', pairedBoard.texture.paired === true,
  JSON.stringify(pairedBoard.texture));

const raiseAggr = PostflopRanges.getWeightedRange({
  holeCards: C('TdTh'), board: C('9s 5s 2d'), potType: 'srp_pfr', aggression: 'raise'
});
const checkAggr = PostflopRanges.getWeightedRange({
  holeCards: C('TdTh'), board: C('9s 5s 2d'), potType: 'srp_pfr', aggression: 'check'
});
check('агрессия меняет веса: воздух AQo при чеке весит больше, чем при рейзе',
  checkAggr.range.AQo > raiseAggr.range.AQo,
  'check ' + checkAggr.range.AQo + ' vs raise ' + raiseAggr.range.AQo);

let weightBad = [];
for (const [name, wr] of [['flushBoard', flushBoard], ['pairedBoard', pairedBoard],
  ['raiseAggr', raiseAggr], ['checkAggr', checkAggr]]) {
  for (const k of Object.keys(wr.range)) {
    if (!(wr.range[k] > 0)) weightBad.push(name + ' ' + k + '=' + wr.range[k]);
  }
}
check('все веса строго положительные', weightBad.length === 0, weightBad.slice(0, 3).join('; '));
check('взвешенный диапазон не пуст и ключи в 169-нотации',
  Object.keys(flushBoard.range).length > 30 && flushBoard.range.AKs > 0,
  'ключей: ' + Object.keys(flushBoard.range).length);

// ---------------------------------------------------------------- 5. без зависимостей
console.log('\n5. Поведение без HandEval / MonteCarloSimulator');

const source = fs.readFileSync(path.join(__dirname, 'postflop_ranges.js'), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'postflop_ranges.js' });
const isolated = sandbox.PostflopRanges;

check('изолированный модуль публикует PostflopRanges',
  isolated && typeof isolated.getEquity === 'function');
eq('без зависимостей parseRange всё ещё работает', isolated.parseRange('A2s+').size, 12);
eq('без зависимостей getRange всё ещё работает', isolated.getRange('threebet').size, 13);
check('без зависимостей RANGE_PERCENT на месте',
  isolated.RANGE_PERCENT && isolated.RANGE_PERCENT.bb_defend > 0,
  JSON.stringify(isolated.RANGE_PERCENT));

let isoError = null;
try {
  isolated.getEquity({ holeCards: C('AhKd'), board: C('As 7c 2d'), potType: 'srp_pfr', aggression: 'bet' });
} catch (e) { isoError = e.message; }
check('без MonteCarloSimulator getEquity падает с понятной ошибкой',
  isoError && /MonteCarloSimulator/.test(isoError), String(isoError));

let isoActionError = null;
try {
  isolated.getAction({ holeCards: C('AhKd'), board: C('As 7c 2d'), potType: 'srp_pfr', potBB: 10, betToCallBB: 5 });
} catch (e) { isoActionError = e.message; }
check('без MonteCarloSimulator getAction тоже падает понятно',
  isoActionError && /MonteCarloSimulator/.test(isoActionError), String(isoActionError));

let isoWeightError = null;
try {
  isolated.getWeightedRange({ holeCards: C('AhKd'), board: C('As 7c 2d'), potType: 'srp_pfr' });
} catch (e) { isoWeightError = e.message; }
check('без HandEval getWeightedRange падает с ошибкой про HandEval',
  isoWeightError && /HandEval/.test(isoWeightError), String(isoWeightError));

// Явное отключение симулятора в основном модуле — тот же понятный провал.
PostflopRanges.setSimulator(false);
let disabledError = null;
try {
  equity('AhKd', 'As 7c 2d', 'srp_pfr', 'bet', 1000);
} catch (e) { disabledError = e.message; }
check('setSimulator(false) отключает расчёт с понятной ошибкой',
  disabledError && /MonteCarloSimulator/.test(disabledError), String(disabledError));
PostflopRanges.setSimulator(null);
check('setSimulator(null) возвращает автоопределение',
  equity('AhKd', 'As 7c 2d', 'srp_pfr', 'bet', 3000).equity > 0);

// ---------------------------------------------------------------- 6. браузерная загрузка
console.log('\n6. Браузерная загрузка (self/root, без require)');

const browserSandbox = {};
vm.createContext(browserSandbox);
for (const f of ['hand_eval.js', 'monte_carlo.js', 'postflop_ranges.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), browserSandbox, { filename: f });
}
const browserApi = browserSandbox.PostflopRanges;
check('в браузерном контексте модуль публикуется в root',
  browserApi && typeof browserApi.getEquity === 'function' && typeof browserSandbox.PostflopRanges === 'object');
check('в браузерном контексте зависимости подхватились из root',
  !!browserSandbox.HandEval && !!browserSandbox.MonteCarloSimulator);
const browserEquity = browserApi.getEquity({
  holeCards: C('AhKd'), board: C('As 7c 2d'), potType: 'threebet', aggression: 'raise',
  opponents: 1, iterations: 4000
});
check('в браузерном контексте эквити считается против диапазона',
  browserEquity.equity > 0 && browserEquity.equity < 100 && browserEquity.combosInRange > 0,
  JSON.stringify(browserEquity.equity));
eq('в браузерном контексте диапазон threebet сужен рейзом',
  browserEquity.rangePercent < browserEquity.baseRangePercent, true);
const browserAction = browserApi.getAction({
  holeCards: C('7s7h'), board: C('7d Kc 2h'), potType: 'srp_pfr', aggression: 'bet',
  potBB: 10, betToCallBB: 5, effectiveStackBB: 100, position: 'BTN', iterations: 4000
});
eq('в браузерном контексте сет рейзит', browserAction.action, 'RAISE');
eq('в браузерном контексте source тот же', browserAction.source, 'postflop_ranges');

// ---------------------------------------------------------------- итог
console.log('\n' + '='.repeat(58));
console.log('Пройдено: ' + passed + ', провалено: ' + failed);
if (failed) {
  console.log('\nПровалы:');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('='.repeat(58));
process.exit(failed ? 1 : 0);
