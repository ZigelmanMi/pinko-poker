'use strict';

const PreflopRanges = require('./preflop_ranges.js');
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
  check(name, actual === expected, 'получено ' + JSON.stringify(actual) + ', ожидалось ' + JSON.stringify(expected));
}


/** Ключ руки -> две конкретные карты (как их отдаёт парсер стола). */
function cardsOf(key) {
  if (key.length === 2) return [{ rank: key[0], suit: 's' }, { rank: key[1], suit: 'h' }];
  if (key[2] === 's') return [{ rank: key[0], suit: 's' }, { rank: key[1], suit: 's' }];
  return [{ rank: key[0], suit: 's' }, { rank: key[1], suit: 'h' }];
}

function act(handKey, overrides) {
  const input = Object.assign({
    holeCards: cardsOf(handKey),
    position: 'BTN',
    situation: 'unopened',
    potBB: 3,
    betToCallBB: 2.5,
    effectiveStackBB: 100,
    numPlayers: 6
  }, overrides || {});
  return PreflopRanges.getAction(input);
}

const POSITIONS = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
const RAISERS = ['UTG', 'MP', 'CO', 'BTN', 'SB'];
const SITUATIONS = ['unopened', 'vs_open', 'vs_3bet', 'in_bb_vs_open'];

console.log('\n1. Нормализация ключа руки (169-нотация)');

eq('AKs', PreflopRanges.normalizeHand('Ah', 'Kh'), 'AKs');
eq('AKo', PreflopRanges.normalizeHand('Ah', 'Kd'), 'AKo');
eq('пара TT', PreflopRanges.normalizeHand('Th', 'Td'), 'TT');
eq('A5s', PreflopRanges.normalizeHand('Ad', '5d'), 'A5s');
eq('72o', PreflopRanges.normalizeHand('7h', '2c'), '72o');
eq('порядок карт не важен (K,A)', PreflopRanges.normalizeHand('Kd', 'Ah'), 'AKo');
eq('десятка пишется как T: 10h+9d', PreflopRanges.normalizeHand('Th', '9d'), 'T9o');
eq('десятка пишется как T: 9d+Th', PreflopRanges.normalizeHand('9d', 'Th'), 'T9o');
eq('T9s одномастные', PreflopRanges.normalizeHand('Th', '9h'), 'T9s');
eq('объекты карт в стиле HandEval', PreflopRanges.normalizeHand({ rank: 'A', suit: 's' }, { rank: 'K', suit: 's' }), 'AKs');
eq('масть в верхнем регистре', PreflopRanges.normalizeHand('AH', 'KH'), 'AKs');

eq('все 169 ключей генерируются', PreflopRanges.allHandKeys().length, 169);
check('все 169 ключей уникальны', new Set(PreflopRanges.allHandKeys()).size === 169);

console.log('\n2. Разбор нотации диапазонов');

eq('22+ = 13 пар', PreflopRanges.parseRange('22+').length, 13);
eq('TT+ = 5 пар', PreflopRanges.parseRange('TT+').length, 5);
eq('A2s+ = 12 рук', PreflopRanges.parseRange('A2s+').length, 12);
eq('K9o+ = K9o..KQo = 4 руки', PreflopRanges.parseRange('K9o+').length, 4);
eq('A2s-A5s = 4 руки', PreflopRanges.parseRange('A2s-A5s').length, 4);
eq('22-99 = 8 пар', PreflopRanges.parseRange('22-99').length, 8);
eq('T9s-54s = 6 коннекторов', PreflopRanges.parseRange('T9s-54s').length, 6);
eq('перечисление без дублей', PreflopRanges.parseRange('AKs AKo TT AKs').length, 3);
check('нижний регистр понимается', PreflopRanges.parseRange('aks ako tt').join(',') === 'AKs,AKo,TT',
  PreflopRanges.parseRange('aks ako tt').join(','));
check('22-99 содержит 55, но не TT',
  PreflopRanges.parseRange('22-99').indexOf('55') >= 0 && PreflopRanges.parseRange('22-99').indexOf('TT') < 0);
check('A2s+ включает AKs, но не A2o',
  PreflopRanges.parseRange('A2s+').indexOf('AKs') >= 0 && PreflopRanges.parseRange('A2s+').indexOf('A2o') < 0);

let parseThrew = 0;
for (const bad of ['ZZ', 'AK', 'AKx', 'A2s-A5o', 'T9s-53s']) {
  try { PreflopRanges.parseRange(bad); } catch (e) { parseThrew++; }
}
eq('5 некорректных токенов отвергаются', parseThrew, 5);

// Комбо-счёт: 22+ = 13 пар * 6 = 78; A2s+ = 12 * 4 = 48.
eq('комбо в 22+', PreflopRanges.comboCount('22+'), 78);
eq('комбо в A2s+', PreflopRanges.comboCount('A2s+'), 48);
eq('комбо в AKo (12)', PreflopRanges.comboCount('AKo'), 12);

console.log('\n3. Целостность чартов');

const allKeys = new Set(PreflopRanges.allHandKeys());
let chartKeys = 0;
let chartErrors = 0;
for (const pos of POSITIONS) {
  for (const sit of SITUATIONS) {
    for (const raiser of RAISERS) {
      for (const action of ['raise', 'call', '3bet', '4bet', 'open', 'fold']) {
        try {
          const set = PreflopRanges.getRange(pos, sit, action, raiser);
          set.forEach((key) => {
            chartKeys++;
            if (!allKeys.has(key)) chartErrors++;
          });
        } catch (e) {
          chartErrors++;
          console.log('  ошибка в чарте ' + pos + '/' + sit + '/' + action + '/' + raiser + ': ' + e.message);
        }
      }
    }
  }
}
check('все руки в чартах — валидные ключи 169-нотации', chartErrors === 0, 'ошибок: ' + chartErrors);
check('чарты непустые (просмотрено рук: ' + chartKeys + ')', chartKeys > 300);

const btnOpen = PreflopRanges.getRange('BTN', 'unopened', 'raise');
const utgOpen = PreflopRanges.getRange('UTG', 'unopened', 'raise');
check('BTN open содержит AA и A2o (широкий стил)', btnOpen.has('AA') && btnOpen.has('A2o'));
check('UTG open содержит AA и не содержит A2o', utgOpen.has('AA') && !utgOpen.has('A2o'));
check('SB вообще не флэтит открытия', PreflopRanges.getRange('SB', 'vs_open', 'call').size === 0);
check('getRange отдаёт Set', btnOpen instanceof Set);
check('getRange по объекту-параметру работает',
  PreflopRanges.getRange({ position: 'BB', situation: 'in_bb_vs_open', action: 'call', raiserPosition: 'BTN' }).has('T9o'));

console.log('\n4. Инварианты решений');

// 4.1 AA — всегда RAISE (во всех позициях/ситуациях/против любого рейзера).
let aaBad = [];
for (const pos of POSITIONS) {
  for (const sit of SITUATIONS) {
    for (const raiser of RAISERS) {
      for (const bet of [0, 2.5, 10]) {
        const r = act('AA', { position: pos, situation: sit, raiserPosition: raiser, betToCallBB: bet });
        if (r.action !== 'RAISE') aaBad.push(pos + '/' + sit + '/' + raiser + '/bet=' + bet + ' -> ' + r.action);
      }
    }
  }
}
check('AA всегда RAISE (' + (POSITIONS.length * SITUATIONS.length * RAISERS.length * 3) + ' случаев)',
  aaBad.length === 0, aaBad.slice(0, 5).join('; '));

// 4.2 72o — всегда FOLD, когда нужно доставлять.
let trashBad = [];
for (const pos of POSITIONS) {
  for (const sit of SITUATIONS) {
    for (const raiser of RAISERS) {
      const r = act('72o', { position: pos, situation: sit, raiserPosition: raiser, betToCallBB: 2.5 });
      if (r.action !== 'FOLD') trashBad.push(pos + '/' + sit + '/' + raiser + ' -> ' + r.action);
    }
  }
}
check('72o всегда FOLD, когда есть что доставлять', trashBad.length === 0, trashBad.slice(0, 5).join('; '));

// 4.3 betToCallBB == 0 никогда не даёт CALL.
let callBad = [];
for (const pos of POSITIONS) {
  for (const sit of SITUATIONS) {
    for (const raiser of RAISERS) {
      for (const hk of ['AA', '72o', 'AKs', 'T9o', '22', 'KQs']) {
        const r = act(hk, { position: pos, situation: sit, raiserPosition: raiser, betToCallBB: 0 });
        if (r.action === 'CALL') callBad.push(pos + '/' + sit + '/' + raiser + '/' + hk);
      }
    }
  }
}
check('betToCallBB = 0 никогда не даёт CALL', callBad.length === 0, callBad.slice(0, 5).join('; '));

// 4.4 BB при betToCall == 0 и вне диапазона — CHECK, а не фолд.
eq('BB с 72o и без ставки — CHECK', act('72o', { position: 'BB', situation: 'unopened', betToCallBB: 0 }).action, 'CHECK');

// 4.5 Результат содержит все обязательные поля контракта.
const sample = act('AKs', { position: 'CO', situation: 'vs_open', raiserPosition: 'BTN', betToCallBB: 2.5 });
const requiredFields = ['action', 'sizingBB', 'handKey', 'inRange', 'rangeName', 'frequency', 'reason', 'source'];
check('результат содержит все поля контракта',
  requiredFields.every((f) => Object.prototype.hasOwnProperty.call(sample, f)),
  Object.keys(sample).join(','));
eq('source = ranges', sample.source, 'ranges');
eq('handKey нормализован', sample.handKey, 'AKs');
check('frequency = 1 для чистых решений', sample.frequency === 1);
check('reason — непустая строка по-русски', typeof sample.reason === 'string' && sample.reason.length > 5);
check('inRange = true для рейза из диапазона', sample.action === 'RAISE' && sample.inRange === true);

// Конкретные узнаваемые решения.
eq('BTN open с A2o', act('A2o', { position: 'BTN', situation: 'unopened', betToCallBB: 0 }).action, 'RAISE');
eq('UTG open с 72o (без ставки) — фолд', act('72o', { position: 'UTG', situation: 'unopened', betToCallBB: 0 }).action, 'FOLD');
eq('BB защита T9o против BTN — колл',
  act('T9o', { position: 'BB', situation: 'in_bb_vs_open', raiserPosition: 'BTN', betToCallBB: 2.5 }).action, 'CALL');
eq('UTG против 3-бета с 72o — фолд',
  act('72o', { position: 'UTG', situation: 'vs_3bet', raiserPosition: 'BTN', betToCallBB: 7.5 }).action, 'FOLD');
eq('BTN против 3-бета с AQs — колл',
  act('AQs', { position: 'BTN', situation: 'vs_3bet', raiserPosition: 'SB', betToCallBB: 7.5 }).action, 'CALL');
eq('SB против BTN с 72o — фолд',
  act('72o', { position: 'SB', situation: 'vs_open', raiserPosition: 'BTN', betToCallBB: 2.5 }).action, 'FOLD');

console.log('\n5. Заполненность диапазонов');
const RP = PreflopRanges.RANGE_PERCENT;
console.log('   UTG open ' + RP['UTG open'] + '% | MP ' + RP['MP open'] + '% | CO ' + RP['CO open'] +
  '% | BTN ' + RP['BTN open'] + '% | SB ' + RP['SB open'] + '%');
console.log('   3bet: vs UTG ' + RP['3bet vs UTG'] + '% | vs MP ' + RP['3bet vs MP'] +
  '% | vs CO ' + RP['3bet vs CO'] + '% | vs BTN ' + RP['3bet vs BTN'] + '%');
console.log('   BB колл: vs UTG ' + RP['BB call vs UTG'] + '% | vs MP ' + RP['BB call vs MP'] +
  '% | vs CO ' + RP['BB call vs CO'] + '% | vs BTN ' + RP['BB call vs BTN'] + '%');

function within(name, lo, hi) {
  const v = RP[name];
  check('диапазон «' + name + '» = ' + v + '% в пределах ' + lo + '-' + hi + '%',
    typeof v === 'number' && v >= lo && v <= hi);
}
within('UTG open', 13, 20);
within('MP open', 17, 23);
within('CO open', 22, 32);
within('BTN open', 35, 55);
within('SB open', 40, 60);
within('BB call vs BTN', 25, 50);
within('BB call vs UTG', 8, 20);
within('3bet vs UTG', 4, 9);
within('3bet vs BTN', 8, 16);

check('диапазон открытия BTN шире UTG', RP['BTN open'] > RP['UTG open'],
  RP['BTN open'] + '% vs ' + RP['UTG open'] + '%');
check('открытие монотонно растёт UTG < MP < CO < BTN',
  RP['UTG open'] < RP['MP open'] && RP['MP open'] < RP['CO open'] && RP['CO open'] < RP['BTN open']);
check('3-бет тайтовее против раннего рейзера (vs UTG < vs CO < vs BTN)',
  RP['3bet vs UTG'] < RP['3bet vs CO'] && RP['3bet vs CO'] < RP['3bet vs BTN']);
check('защита BB шире против позднего рейзера (vs UTG < vs BTN)',
  RP['BB call vs UTG'] < RP['BB call vs BTN']);
check('3-бет-диапазоны уже диапазона открытия BTN',
  RP['3bet vs BTN'] < RP['BTN open'] && RP['3bet vs UTG'] < RP['UTG open']);
check('RANGE_PERCENT посчитан для всех открытий',
  POSITIONS.every((p) => typeof RP[p + ' open'] === 'number'));

console.log('\n6. Короткий стек (пуш/фолд)');
// Симулятор инъектируется явно — тест не зависит от глобального состояния.
PreflopRanges.setSimulator(new MonteCarloSimulator({ seed: 20240607 }));

const aaShort = act('AA', { position: 'BTN', situation: 'unopened', betToCallBB: 0, effectiveStackBB: 10 });
eq('10 ББ с AA — RAISE (пуш)', aaShort.action, 'RAISE');
eq('10 ББ с AA — пуш на весь стек', aaShort.sizingBB, 10);
check('10 ББ с AA — эквити посчитано', typeof aaShort.equity === 'number' && aaShort.equity > 70,
  'эквити ' + aaShort.equity);

const trashShort = act('72o', { position: 'BTN', situation: 'unopened', betToCallBB: 0, effectiveStackBB: 10 });
eq('10 ББ с 72o — FOLD', trashShort.action, 'FOLD');

const trashShortFacing = act('72o', { position: 'BB', situation: 'in_bb_vs_open', raiserPosition: 'BTN', betToCallBB: 8, effectiveStackBB: 10 });
eq('10 ББ с 72o против ставки — FOLD', trashShortFacing.action, 'FOLD');

const aaShortFacing = act('AA', { position: 'BB', situation: 'in_bb_vs_open', raiserPosition: 'BTN', betToCallBB: 8, effectiveStackBB: 10 });
eq('10 ББ с AA против ставки — RAISE (пуш)', aaShortFacing.action, 'RAISE');
check('короткий стек: размер не превышает стек', aaShortFacing.sizingBB <= 10);

// На 14 ББ ещё короткий стек, на 15 ББ — уже чарты.
const at14 = act('72o', { position: 'UTG', situation: 'vs_open', raiserPosition: 'BTN', betToCallBB: 2.5, effectiveStackBB: 14 });
const at15 = act('72o', { position: 'UTG', situation: 'vs_open', raiserPosition: 'BTN', betToCallBB: 2.5, effectiveStackBB: 15 });
check('14 ББ идёт по короткому стеку (в reason есть эквити)', /Эквити/.test(at14.reason), at14.reason);
check('15 ББ идёт по чартам (в reason нет эквити)', !/Эквити/.test(at15.reason), at15.reason);

// Работает и без инъекции: модуль сам находит MonteCarloSimulator.
PreflopRanges.setSimulator(null);
const autoShort = act('AA', { position: 'CO', situation: 'unopened', betToCallBB: 0, effectiveStackBB: 10 });
eq('10 ББ с AA (симулятор найден автоматически) — RAISE', autoShort.action, 'RAISE');
check('автоматический путь тоже считает эквити', autoShort.equity > 70, 'эквити ' + autoShort.equity);

console.log('\n7. Размеры рейзов');

eq('открытие = 2.5 ББ', act('AA', { position: 'BTN', situation: 'unopened', betToCallBB: 0 }).sizingBB, 2.5);
eq('3-бет в позиции = 3 x 2.5 = 7.5 ББ',
  act('AA', { position: 'BTN', situation: 'vs_open', raiserPosition: 'CO', betToCallBB: 2.5 }).sizingBB, 7.5);
eq('3-бет без позиции = 4 x 2.5 = 10 ББ',
  act('AA', { position: 'BB', situation: 'in_bb_vs_open', raiserPosition: 'BTN', betToCallBB: 2.5 }).sizingBB, 10);
eq('3-бет из SB без позиции = 10 ББ',
  act('AA', { position: 'SB', situation: 'vs_open', raiserPosition: 'BTN', betToCallBB: 2.5 }).sizingBB, 10);
eq('4-бет в позиции ≈ 2.2 x 7.5 = 16.5 ББ',
  act('AA', { position: 'BTN', situation: 'vs_3bet', raiserPosition: 'SB', betToCallBB: 7.5 }).sizingBB, 16.5);
eq('4-бет без позиции ≈ 2.2 x 10 = 22 ББ',
  act('AA', { position: 'CO', situation: 'vs_3bet', raiserPosition: 'BTN', betToCallBB: 7.5 }).sizingBB, 22);
eq('4-бет упирается в стек (15 ББ)',
  act('AA', { position: 'BTN', situation: 'vs_3bet', raiserPosition: 'SB', betToCallBB: 7.5, effectiveStackBB: 15 }).sizingBB, 15);

let sizeBad = [];
for (const stack of [5, 10, 14, 15, 20, 30, 50, 100]) {
  for (const pos of POSITIONS) {
    for (const sit of SITUATIONS) {
      for (const raiser of RAISERS) {
        for (const hk of ['AA', 'AKs', '72o', 'A2o', 'T9o']) {
          const r = act(hk, {
            position: pos, situation: sit, raiserPosition: raiser,
            betToCallBB: 2.5, effectiveStackBB: stack
          });
          if (r.action === 'RAISE') {
            if (!(r.sizingBB > 0)) sizeBad.push('не положительный: ' + hk + ' ' + pos + '/' + sit + ' ' + r.sizingBB);
            if (r.sizingBB > stack) sizeBad.push('больше стека: ' + hk + ' ' + pos + '/' + sit + ' ' + r.sizingBB + ' > ' + stack);
          } else if (r.sizingBB != null) {
            sizeBad.push('размер при не-рейзе: ' + hk + ' ' + pos + '/' + sit + ' ' + r.action + ' ' + r.sizingBB);
          }
        }
      }
    }
  }
}
check('размеры рейзов всегда > 0 и <= стек, иначе null', sizeBad.length === 0, sizeBad.slice(0, 5).join('; '));

console.log('\n8. Валидация ввода и стабильность');

let inputThrew = 0;
try { PreflopRanges.getAction(null); } catch (e) { inputThrew++; }
try { PreflopRanges.getAction({}); } catch (e) { inputThrew++; }
try { PreflopRanges.getAction({ holeCards: ['As'] }); } catch (e) { inputThrew++; }
try { PreflopRanges.getAction({ holeCards: ['As', 'Ks'], position: 'XXX' }); } catch (e) { inputThrew++; }
try { PreflopRanges.normalizeHand('Zz', 'Ah'); } catch (e) { inputThrew++; }
eq('некорректный ввод отвергается (5 случаев)', inputThrew, 5);

// Алиасы позиций/ситуаций.
eq('алиас BU -> BTN', act('AA', { position: 'BU', situation: 'unopened' }).rangeName, 'BTN open');
eq('алиас HJ -> MP', act('AA', { position: 'HJ', situation: 'unopened' }).rangeName, 'MP open');
eq('алиас RFI -> unopened', act('AA', { position: 'CO', situation: 'RFI' }).rangeName, 'CO open');
eq('ситуация vs_open в BB автоматически становится защитой BB',
  act('AA', { position: 'BB', situation: 'vs_open', raiserPosition: 'BTN', betToCallBB: 2.5 }).rangeName, 'BB vs BTN 3bet');
eq('отсутствие ситуации = unopened', act('AA', { position: 'CO', situation: undefined }).rangeName, 'CO open');

// Миксы детерминированы: один и тот же спот -> один и тот же ответ.
let unstable = 0;
for (const hk of ['A5s', 'A4s', 'KJs', 'QTs', 'JTs', '76s', 'AJo', 'KQo', 'AA', '72o']) {
  const first = act(hk, { position: 'BTN', situation: 'vs_open', raiserPosition: 'CO', betToCallBB: 2.5 });
  for (let i = 0; i < 5; i++) {
    const again = act(hk, { position: 'BTN', situation: 'vs_open', raiserPosition: 'CO', betToCallBB: 2.5 });
    if (again.action !== first.action || again.sizingBB !== first.sizingBB) unstable++;
  }
}
check('миксы стабильны (повторный вызов даёт тот же ответ)', unstable === 0, 'расхождений: ' + unstable);

let freqBad = 0;
for (const hk of ['A5s', 'A4s', 'KJs', 'QTs', 'JTs', '76s', 'AJo', 'KQo']) {
  const r = act(hk, { position: 'BTN', situation: 'vs_open', raiserPosition: 'CO', betToCallBB: 2.5 });
  if (!(r.frequency > 0 && r.frequency <= 1)) freqBad++;
}
check('frequency всегда в (0, 1]', freqBad === 0, 'нарушений: ' + freqBad);

console.log('\n' + '='.repeat(58));
console.log('Пройдено: ' + passed + ', провалено: ' + failed);
if (failed) {
  console.log('\nПровалы:');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('='.repeat(58));
process.exit(failed ? 1 : 0);
