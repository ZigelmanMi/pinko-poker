'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) passed++;
  else {
    failed++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : ''));
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, 'получено ' + JSON.stringify(actual) + ', ожидалось ' + JSON.stringify(expected));
}
function checkNear(name, actual, expected, tol) {
  const ok = Math.abs(Number(actual) - expected) <= tol;
  check(name, ok, 'получено ' + actual + ', ожидалось ' + expected + ' ±' + tol);
}

const dir = __dirname;
function read(name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

function makeSandbox() {
  const listeners = { message: [], storage: [], tabsUpdated: [], nav: [], removed: [] };
  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    URL: URL,
    TextDecoder: TextDecoder,
    Uint8Array: Uint8Array,
    Uint8ClampedArray: Uint8ClampedArray,
    Int32Array: Int32Array,
    Float32Array: Float32Array,
    WeakSet: WeakSet,
    Promise: Promise,
    JSON: JSON,
    Math: Math,
    Date: Date,
    Number: Number,
    String: String,
    Array: Array,
    Object: Object,
    Error: Error,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isFinite: isFinite,
    isNaN: isNaN
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  sandbox.chrome = {
    storage: {
      onChanged: { addListener: (fn) => listeners.storage.push(fn) },
      local: { set: () => Promise.resolve(), get: () => Promise.resolve({}) }
    },
    runtime: {
      id: 'test-extension',
      lastError: null,
      getURL: (p) => 'chrome-extension://test/' + p,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      sendMessage: () => {}
    },
    tabs: {
      onUpdated: { addListener: (fn) => listeners.tabsUpdated.push(fn) },
      captureVisibleTab: () => {},
      sendMessage: () => {}
    },
    webNavigation: {
      getAllFrames: () => Promise.resolve([]),
      onCompleted: { addListener: (fn) => listeners.nav.push(fn) }
    },
    windows: {
      getAll: () => Promise.resolve([]),
      getLastFocused: () => Promise.resolve(null),
      create: () => Promise.resolve({ id: 1 }),
      update: () => Promise.resolve(),
      onRemoved: { addListener: (fn) => listeners.removed.push(fn) }
    },
    scripting: { executeScript: () => Promise.resolve([]) },
    action: {
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
      onClicked: { addListener: () => {} }
    }
  };

  vm.createContext(sandbox);
  sandbox.importScripts = function () {
    for (let i = 0; i < arguments.length; i++) {
      const name = arguments[i];
      vm.runInContext(read(name), sandbox, { filename: name });
    }
  };
  return { sandbox, listeners };
}

// background.js грузится целиком, со своими зависимостями.
function loadBackground() {
  const { sandbox } = makeSandbox();
  sandbox.fetch = () => Promise.reject(new Error('нет сети'));
  vm.runInContext(read('background.js') + '\nthis.__bg = { buildFallbackDecision, computeEquity, detectStreet, normalizeHandCards, toBB, detectPositions, buildPreflopRangeDecision, buildPostflopRangeDecision, inferPotContext, analyzeHand };',
    sandbox, { filename: 'background.js' });
  return sandbox.__bg;
}

// грузим скрипты как service worker: один упавший модуль — расширение мёртвое.
console.log('\n0. Загрузка цепочки модулей (как в service worker)');
(function moduleChain() {
  const { sandbox } = makeSandbox();
  sandbox.fetch = () => Promise.reject(new Error('нет сети'));
  let error = null;
  try {
    // importScripts внутри background.js подтянет всё сам.
    vm.runInContext(read('background.js'), sandbox, { filename: 'background.js' });
  } catch (e) {
    error = e;
  }
  check('background.js загружается со всеми importScripts', !error, error && (error.message || String(error)));

  const globals = {
    HandEval: 'оценщик комбинаций',
    MonteCarloSimulator: 'симулятор',
    PreflopRanges: 'префлоп-диапазоны',
    PostflopRanges: 'постфлоп-диапазоны',
    FrameDiff: 'сравнение кадров'
  };
  for (const [name, what] of Object.entries(globals)) {
    const present = vm.runInContext('typeof ' + name, sandbox);
    check(name + ' доступен (' + what + ')', present !== 'undefined', present);
  }

  // Проверяем, что ключевые функции действительно вызываются.
  const evalOk = vm.runInContext('typeof HandEval.evaluate === "function"', sandbox);
  check('HandEval.evaluate — функция', evalOk === true);
  const mcOk = vm.runInContext('typeof MonteCarloSimulator.prototype.computeWinRateVsRange === "function"', sandbox);
  check('MonteCarloSimulator умеет считать против диапазона', mcOk === true);
  const pfOk = vm.runInContext('typeof PreflopRanges.getAction === "function"', sandbox);
  check('PreflopRanges.getAction — функция', pfOk === true);
  const postOk = vm.runInContext('typeof PostflopRanges.getEquity === "function"', sandbox);
  check('PostflopRanges.getEquity — функция', postOk === true);
  const diffOk = vm.runInContext('typeof FrameDiff.dhashFromRgba === "function"', sandbox);
  check('FrameDiff.dhashFromRgba — функция', diffOk === true);
})();

const bg = loadBackground();

function state(over) {
  return Object.assign({
    myCards: [{ rank: 'A', suit: 's' }, { rank: 'A', suit: 'h' }],
    communityCards: [], pot: 10, betToCall: 0, numPlayers: 2,
    heroStack: 200, villainStack: 200, bigBlind: 2, stage: 'preflop'
  }, over || {});
}

console.log('\n4. Математический фолбэк (buildFallbackDecision)');

(function fallbackMath() {
  const strong = bg.buildFallbackDecision(state({
    myCards: [{ rank: 'A', suit: 's' }, { rank: 'A', suit: 'h' }],
    communityCards: [{ rank: 'A', suit: 'd' }, { rank: '7', suit: 'c' }, { rank: '2', suit: 'h' }],
    pot: 20, betToCall: 0
  }));
  eq('сет тузов без ставки -> ставка', strong.action, 'RAISE');
  check('размер ставки положительный', strong.amount > 0, 'amount=' + strong.amount);

  const weak = bg.buildFallbackDecision(state({
    myCards: [{ rank: '7', suit: 'd' }, { rank: '2', suit: 'c' }],
    communityCards: [{ rank: 'K', suit: 'd' }, { rank: 'Q', suit: 'c' }, { rank: '9', suit: 'h' }],
    pot: 100, betToCall: 60
  }));
  eq('слабейшая рука против большой ставки -> фолд', weak.action, 'FOLD');

  const nuts = bg.buildFallbackDecision(state({
    myCards: [{ rank: 'A', suit: 's' }, { rank: 'A', suit: 'h' }],
    communityCards: [{ rank: 'A', suit: 'd' }, { rank: 'A', suit: 'c' }, { rank: '2', suit: 'h' }],
    pot: 100, betToCall: 50
  }));
  eq('каре тузов против ставки -> рейз', nuts.action, 'RAISE');
})();

console.log('\n5. Расчёт эквити (computeEquity)');

(function equity() {
  const aaPre = bg.computeEquity(state({ pot: 3 }));
  check('префлоп AA против 1 руки: 80-90%', aaPre.equity > 80 && aaPre.equity < 90, 'получено ' + aaPre.equity);
  eq('источник эквити', aaPre.source, 'MonteCarlo');

  const junkPre = bg.computeEquity(state({ myCards: [{ rank: '7', suit: 'd' }, { rank: '2', suit: 'c' }] }));
  check('префлоп 72o: 30-40%', junkPre.equity > 30 && junkPre.equity < 40, 'получено ' + junkPre.equity);

  const quadsPost = bg.computeEquity(state({
    myCards: [{ rank: 'A', suit: 's' }, { rank: 'A', suit: 'h' }],
    communityCards: [{ rank: 'A', suit: 'd' }, { rank: 'A', suit: 'c' }, { rank: '2', suit: 'h' }]
  }));
  check('постфлоп каре тузов: >97%', quadsPost.equity > 97, 'получено ' + quadsPost.equity);

  const noCards = bg.computeEquity(state({ myCards: [] }));
  eq('без карт эквити 0', noCards.equity, 0);
  eq('без карт источник none', noCards.source, 'none');
})();

console.log('\n6. Определение улицы (detectStreet)');
eq('префлоп', bg.detectStreet({ communityCards: [] }), 'preflop');
eq('флоп', bg.detectStreet({ communityCards: [1, 2, 3] }), 'flop');
eq('терн', bg.detectStreet({ communityCards: [1, 2, 3, 4] }), 'turn');
eq('ривер', bg.detectStreet({ communityCards: [1, 2, 3, 4, 5] }), 'river');
eq('по stage', bg.detectStreet({ communityCards: [], stage: 'turn' }), 'turn');

console.log('\n7. Нормализация карманных карт');
eq('AKs', bg.normalizeHandCards({ rank: 'A', suit: 's' }, { rank: 'K', suit: 's' }), 'AKs');
eq('AKo', bg.normalizeHandCards({ rank: 'K', suit: 'h' }, { rank: 'A', suit: 's' }), 'AKo');
eq('пара TT', bg.normalizeHandCards({ rank: 'T', suit: 'h' }, { rank: 'T', suit: 's' }), 'TT');

console.log('\n8. Определение позиций (detectPositions)');

eq('хедз-ап, банк блайндов, без ставки -> герой BTN',
  bg.detectPositions(state({ numPlayers: 2, betToCall: 0, pot: 3 })).heroPosition, 'BTN');
eq('хедз-ап, банк блайндов -> unopened',
  bg.detectPositions(state({ numPlayers: 2, betToCall: 0, pot: 3 })).situation, 'unopened');
eq('хедз-ап против открытия -> герой BB',
  bg.detectPositions(state({ numPlayers: 2, betToCall: 6, pot: 8 })).heroPosition, 'BB');
eq('хедз-ап против открытия -> защита BB',
  bg.detectPositions(state({ numPlayers: 2, betToCall: 6, pot: 8 })).situation, 'in_bb_vs_open');
eq('соперник в неоткрытом хедз-апе — BB',
  bg.detectPositions(state({ numPlayers: 2, betToCall: 0, pot: 3 })).villainPosition, 'BB');
check('позиция героя всегда из допустимого набора',
  ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'].indexOf(bg.detectPositions(state({ numPlayers: 5, betToCall: 2, pot: 3 })).heroPosition) !== -1);
check('позиция соперника отличается от позиции героя для 6-max',
  bg.detectPositions(state({ numPlayers: 6, betToCall: 0, pot: 3 })).heroPosition !==
  bg.detectPositions(state({ numPlayers: 6, betToCall: 0, pot: 3 })).villainPosition);
eq('6-max, банк блайндов, без ставки -> UTG, не кнопка',
  bg.detectPositions(state({ numPlayers: 6, betToCall: 0, pot: 3 })).heroPosition, 'UTG');
eq('6-max добор ~2.5 ББ -> CO против открытия',
  bg.detectPositions(state({ numPlayers: 6, betToCall: 5, pot: 8 })).heroPosition, 'CO');
eq('6-max добор ~2.5 ББ -> vs_open',
  bg.detectPositions(state({ numPlayers: 6, betToCall: 5, pot: 8 })).situation, 'vs_open');
eq('6-max добор ~1.5 ББ -> герой BB',
  bg.detectPositions(state({ numPlayers: 6, betToCall: 3, pot: 6 })).heroPosition, 'BB');
eq('6-max добор ~8 ББ -> vs_3bet',
  bg.detectPositions(state({ numPlayers: 6, betToCall: 16, pot: 24 })).situation, 'vs_3bet');
eq('3-max, банк блайндов -> герой BTN',
  bg.detectPositions(state({ numPlayers: 3, betToCall: 0, pot: 3 })).heroPosition, 'BTN');
eq('5-max, банк блайндов -> герой MP',
  bg.detectPositions(state({ numPlayers: 5, betToCall: 0, pot: 3 })).heroPosition, 'MP');

console.log('\n9. Префлоп-решение по диапазонам');

(function preflopRanges() {
  const aa = bg.buildPreflopRangeDecision(state({
    myCards: [{ rank: 'A', suit: 's' }, { rank: 'A', suit: 'h' }],
    numPlayers: 6, betToCall: 0, pot: 3, bigBlind: 2, heroStack: 200
  }));
  check('AA на префлопе даёт решение по диапазонам', aa != null, 'null');
  if (aa) {
    eq('AA -> RAISE', aa.decision.action, 'RAISE');
    eq('источник = ranges', aa.decision.source, 'ranges');
    eq('ключ руки распознан', aa.hand, 'AA');
    check('размер рейза в деньгах положительный', aa.decision.amount > 0, 'amount=' + aa.decision.amount);
    check('в причине указан диапазон', /open|диапазон/i.test(aa.decision.reason), aa.decision.reason);
  }

  const junk = bg.buildPreflopRangeDecision(state({
    myCards: [{ rank: '7', suit: 'd' }, { rank: '2', suit: 'c' }],
    numPlayers: 6, betToCall: 4, pot: 8, bigBlind: 2, heroStack: 200
  }));
  check('72o против открытия -> FOLD', junk && junk.decision.action === 'FOLD', junk && junk.decision.action);

  const btn = bg.buildPreflopRangeDecision(state({
    myCards: [{ rank: 'K', suit: 's' }, { rank: '9', suit: 's' }],
    numPlayers: 4, betToCall: 0, pot: 3, bigBlind: 2, heroStack: 200
  }));
  check('K9s с CO в 4-max -> RAISE', btn && btn.decision.action === 'RAISE', btn && btn.decision.action);

  const early = bg.buildPreflopRangeDecision(state({
    myCards: [{ rank: 'K', suit: 's' }, { rank: '9', suit: 's' }],
    numPlayers: 6, betToCall: 0, pot: 3, bigBlind: 2, heroStack: 200
  }));
  check('K9s с UTG в 6-max -> FOLD', early && early.decision.action === 'FOLD', early && early.decision.action);

  const bbCall = bg.buildPreflopRangeDecision(state({
    myCards: [{ rank: 'T', suit: 'h' }, { rank: '9', suit: 'd' }],
    numPlayers: 6, betToCall: 3, pot: 6, bigBlind: 2, heroStack: 200
  }));
  check('T9o на BB против открытия -> CALL', bbCall && bbCall.decision.action === 'CALL', bbCall && bbCall.decision.action);

  const vs3bet = bg.buildPreflopRangeDecision(state({
    myCards: [{ rank: '7', suit: 'd' }, { rank: '2', suit: 'c' }],
    numPlayers: 6, betToCall: 16, pot: 24, bigBlind: 2, heroStack: 200
  }));
  check('72o против 3-бета -> FOLD', vs3bet && vs3bet.decision.action === 'FOLD', vs3bet && vs3bet.decision.action);

  const fourBet = bg.buildPreflopRangeDecision(state({
    myCards: [{ rank: 'A', suit: 's' }, { rank: 'A', suit: 'h' }],
    numPlayers: 6, betToCall: 16, pot: 24, bigBlind: 2, heroStack: 200
  }));
  check('AA против 3-бета -> RAISE', fourBet && fourBet.decision.action === 'RAISE', fourBet && fourBet.decision.action);
})();

// Полный проход анализа на префлопе: решение должно приходить без сети.
// Важно: analyzeHand асинхронная, поэтому итог печатается
// и выход происходит после того, как очередь событий опустеет.
bg.analyzeHand(state({
  myCards: [{ rank: 'A', suit: 's' }, { rank: 'A', suit: 'h' }],
  communityCards: [], pot: 3, betToCall: 0, numPlayers: 6, bigBlind: 2, heroStack: 200
})).then((res) => {
  eq('analyzeHand: улица preflop', res.street, 'preflop');
  eq('analyzeHand: источник ranges', res.decision.source, 'ranges');
  check('analyzeHand: id руки присвоен', typeof res.hand_id === 'number' && res.hand_id > 0, String(res.hand_id));
  check('analyzeHand: состояние приложено', res.state && res.state.myCards.length === 2);
}).catch((e) => {
  check('analyzeHand без исключений', false, String(e && e.message));
});

console.log('\n10. Постфлоп: эквити против диапазона');

(function postflopRanges() {
  const flopStrong = state({
    myCards: [{ rank: '7', suit: 's' }, { rank: '7', suit: 'h' }],
    communityCards: [{ rank: '7', suit: 'd' }, { rank: 'K', suit: 'c' }, { rank: '2', suit: 'h' }],
    pot: 30, betToCall: 10, heroStack: 200, bigBlind: 2
  });
  const eqInfo = bg.computeEquity(flopStrong);
  eq('постфлоп: источник эквити = range', eqInfo.source, 'range');
  check('сет семёрок: эквити против диапазона > 70%', eqInfo.equity > 70, 'получено ' + eqInfo.equity);
  check('эквити против диапазона ниже, чем против случайных рук',
    eqInfo.equity < 97, 'получено ' + eqInfo.equity);

  const decision = bg.buildPostflopRangeDecision(flopStrong);
  check('постфлоп-решение получено', decision != null, 'null');
  if (decision) {
    eq('источник решения = ranges', decision.decision.source, 'ranges');
    check('с сетом против ставки — RAISE', decision.decision.action === 'RAISE', decision.decision.action);
    check('размер ставки положительный и не больше стека',
      decision.decision.amount > 0 && decision.decision.amount <= 200, String(decision.decision.amount));
    check('указан названный диапазон', !!decision.rangeName, decision.rangeName);
  }

  const junk = state({
    myCards: [{ rank: '7', suit: 'd' }, { rank: '2', suit: 'c' }],
    communityCards: [{ rank: 'A', suit: 's' }, { rank: 'K', suit: 's' }, { rank: 'Q', suit: 's' }],
    pot: 80, betToCall: 60, heroStack: 200, bigBlind: 2
  });
  const junkEq = bg.computeEquity(junk);
  check('72o на A-K-Q одномастных: эквити против диапазона < 20%', junkEq.equity < 20, 'получено ' + junkEq.equity);
  const junkDecision = bg.buildPostflopRangeDecision(junk);
  check('72o против большой ставки — FOLD', junkDecision && junkDecision.decision.action === 'FOLD',
    junkDecision && junkDecision.decision.action);

  // Префлоп не должен попадать в постфлоп-ветку.
  const pre = bg.buildPostflopRangeDecision(state({ communityCards: [] }));
  eq('без борда постфлоп-решение не выдаётся', pre, null);
})();

(function potContext() {
  eq('большой банк -> threebet',
    bg.inferPotContext(state({ pot: 30, betToCall: 10, bigBlind: 2 })).potType, 'threebet');
  eq('ставка в обычном банке -> диапазон агрессора',
    bg.inferPotContext(state({ pot: 10, betToCall: 4, bigBlind: 2 })).potType, 'srp_pfr');
  eq('чек в обычном банке -> диапазон коллера',
    bg.inferPotContext(state({ pot: 10, betToCall: 0, bigBlind: 2 })).potType, 'srp_caller');
  eq('есть ставка -> агрессия bet',
    bg.inferPotContext(state({ pot: 10, betToCall: 4, bigBlind: 2 })).aggression, 'bet');
  eq('нет ставки -> агрессия check',
    bg.inferPotContext(state({ pot: 10, betToCall: 0, bigBlind: 2 })).aggression, 'check');
})();

// Полный проход анализа на постфлопе (без сети, через диапазоны).
bg.analyzeHand(state({
  myCards: [{ rank: '7', suit: 's' }, { rank: '7', suit: 'h' }],
  communityCards: [{ rank: '7', suit: 'd' }, { rank: 'K', suit: 'c' }, { rank: '2', suit: 'h' }],
  pot: 30, betToCall: 10, numPlayers: 2, bigBlind: 2, heroStack: 200
})).then((res) => {
  eq('analyze на флопе: улица flop', res.street, 'flop');
  eq('analyze на флопе: источник ranges', res.decision.source, 'ranges');
  eq('analyze на флопе: эквити из диапазона', res.equity_source, 'range');
}).catch((e) => {
  check('analyze на флопе без исключений', false, String(e && e.message));
});

// Ждём завершения асинхронных проверок, затем печатаем итог.
setImmediate(function finish() {
  console.log('\n' + '='.repeat(58));
  console.log('Пройдено: ' + passed + ', провалено: ' + failed);
  if (failed) {
    console.log('\nПровалы:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  console.log('='.repeat(58));
  process.exit(failed ? 1 : 0);
});
