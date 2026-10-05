// =====================================================================
// test_dom_e2e.js — E2E-проверка парсера стола на мок-странице
//
// Запуск:  node test_dom_e2e.js
//
// Что здесь происходит: строится синтетический DOM, повторяющий разметку
// игрового стола казино (места игроков, банк, ставка, карты с SVG-фонами),
// и через НАСТОЯЩИЙ card_parser.js получается состояние стола. Это
// единственная проверка, которая соединяет вместе парсер, определение
// позиций и расчёт эквити — то есть весь путь «страница → совет».
// =====================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
function eq(name, actual, expected) {
  check(name, actual === expected, 'получено ' + JSON.stringify(actual) + ', ожидалось ' + JSON.stringify(expected));
}

const DIR = __dirname;

// ------------------------------------------------------------------ мок-DOM
function cardSvgUri(rank, suitSym) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>' + rank + suitSym + '</text></svg>';
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

const RECTS = new Map(); // элемент -> прямоугольник

/** Сопоставить элемент простому селектору: .класс, [class*="x"], тег. */
function matchesSelector(el, sel) {
  sel = sel.trim();
  if (!sel) return false;
  if (sel.charAt(0) === '.') {
    return el.className.split(/\s+/).indexOf(sel.slice(1)) !== -1;
  }
  const attr = sel.match(/^\[class\*="([^"]+)"\]$/);
  if (attr) return (el.className || '').indexOf(attr[1]) !== -1;
  return el.tagName === sel.toUpperCase();
}

function makeElement(tag, className, text) {
  const el = {
    tagName: tag.toUpperCase(),
    className: className || '',
    textContent: text == null ? '' : String(text),
    innerText: text == null ? '' : String(text),
    children: [],
    parentElement: null,
    style: {},
    dataset: {},
    attrs: {},
    id: '',
    getAttribute(name) { return this.attrs[name] != null ? this.attrs[name] : null; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
    getBoundingClientRect() { return RECTS.get(this) || { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; },
    /** Первый потомок, подходящий под селектор (плоский список, без вложенности селекторов). */
    querySelector(sel) {
      const found = this.querySelectorAll(sel);
      return found.length ? found[0] : null;
    },
    querySelectorAll(sel) {
      const list = sel.split(',').map((s) => s.trim()).filter((s) => s && s.indexOf(':scope') === -1);
      const found = [];
      const walk = (node) => {
        node.children.forEach((child) => {
          if (list.some((s) => matchesSelector(child, s))) found.push(child);
          walk(child);
        });
      };
      walk(this);
      return found;
    },
    remove() {}
  };
  Object.defineProperty(el, 'backgroundImage', {
    get() { return this.style.backgroundImage || ''; },
    enumerable: true
  });
  return el;
}

function rect(x, y, w, h) {
  return { x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h };
}

// ------------------------------------------------------------------ сцена
const VIEW_W = 1600;
const VIEW_H = 900;

const body = makeElement('body');
const documentElement = makeElement('html');
documentElement.appendChild(body);

// Банк и ставка в тексте страницы.
body.innerText = [
  'Lucky Chip Hold\'em',
  'Банк: $ 12.50',
  'Колл: $ 4.00',
  'Ставки: $ 1 / $ 2'
].join('\n');

// --- места игроков ---
function addSeat(name, cash, top, className) {
  const seat = makeElement('div', className || 'r-seat');
  const nameEl = makeElement('div', 'player-name', name);
  nameEl.attrs.class = 'player-name';
  nameEl.setAttribute('class', 'player-name');
  const cashEl = makeElement('div', 'player-cash', cash);
  seat.appendChild(nameEl);
  seat.appendChild(cashEl);
  body.appendChild(seat);
  RECTS.set(nameEl, rect(700, top, 120, 24));
  RECTS.set(cashEl, rect(700, top + 26, 120, 20));
  RECTS.set(seat, rect(660, top - 6, 200, 80));
  return { seat, nameEl, cashEl };
}

// Герой — самое нижнее место на экране.
const heroSeat = addSeat('HeroPlayer', '$ 150.00', 820, 'r-seat hero');
const villainSeat = addSeat('VillainOne', '$ 190.00', 200, 'r-seat player-bar');
addSeat('ThirdGuy', '$ 95.00', 380, 'r-seat player-box');

// --- карты: фон-картинка с SVG data URI ---
function addCard(rank, suitSym, x, y) {
  const el = makeElement('div', 'r-card', '');
  el.style.backgroundImage = 'url("' + cardSvgUri(rank, suitSym) + '")';
  body.appendChild(el);
  RECTS.set(el, rect(x, y, 60, 84));
  return el;
}

// Доска на флопе: A♠ K♥ 7♦ (середина экрана).
addCard('A', '♠', 620, 300);
addCard('K', '♥', 700, 300);
addCard('7', '♦', 780, 300);
// Карманные карты героя внизу: 7♣ 7♠ — то есть сет семёрок.
addCard('7', '♣', 730, 700);
addCard('7', '♠', 800, 700);
// Карты соперника не читаются (рубашкой вниз).
const faceDown = makeElement('div', 'r-card card-back', '');
body.appendChild(faceDown);
RECTS.set(faceDown, rect(300, 200, 60, 84));

// --- окружение ---
const allElements = [];
(function collect(el) {
  allElements.push(el);
  el.children.forEach(collect);
})(body);

const listeners = {};
const window = {
  innerWidth: VIEW_W,
  innerHeight: VIEW_H,
  location: { hostname: 'pu-web2.e5t.online', href: 'https://pu-web2.e5t.online/game' },
  addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  postMessage() {},
  dispatch(type, event) { (listeners[type] || []).forEach((fn) => fn(event)); }
};
window.window = window;
window.top = window;
window.self = window;
window.__paShotStats = { captures: 3, pyAnswers: 1, localAnswers: 1, bridgeSkips: 7, cacheHits: 2 };
window.PokerVision = { readDataUrl: () => Promise.resolve({ myCards: [], communityCards: [] }) };
window.chrome = {
  runtime: {
    id: 'test',
    lastError: null,
    sendMessage() {},
    onMessage: { addListener() {} },
    getURL: (p) => 'chrome-extension://test/' + p
  }
};

const document = {
  body: body,
  documentElement: documentElement,
  readyState: 'complete',
  activeElement: { tagName: 'BODY' },
  listeners: {},
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
  removeEventListener() {},
  createElement(tag) { return makeElement(tag); },
  getElementById() { return null; },
  querySelector(sel) {
    if (sel === 'canvas') return null;
    if (sel === '.PixiComponent, .r-scene-container, .poker-game') return null;
    return null;
  },
  querySelectorAll(sel) {
    // Поддерживаем только те селекторы, которые реально спрашивает парсер.
    if (sel === 'iframe') return [];
    if (sel === '[class*="player-name"], .bar-text.top-line') {
      return allElements.filter((el) => el.className.split(/\s+/).indexOf('player-name') !== -1);
    }
    if (sel === '.r-card') return allElements.filter((el) => el.className.split(/\s+/).indexOf('r-card') !== -1);
    if (sel === 'button, [class*="action"], [class*="btn"]') return [];
    if (sel === 'div, span, p, label') return [];
    if (sel === '[class*="player-cash"], .bar-text.bottom-line') {
      return allElements.filter((el) => el.className.split(/\s+/).indexOf('player-cash') !== -1);
    }
    if (sel === '[class*="player-bet"]') return [];
    const parts = sel.split(',').map((s) => s.trim());
    return allElements.filter((el) => parts.some((p) => {
      if (p === '[style*="svg+xml"]') return (el.style.backgroundImage || '').indexOf('svg+xml') !== -1;
      if (p === '.r-card' || p === '.card' || p === '[class*="r-card"]') {
        const cls = el.className.split(/\s+/);
        return cls.indexOf('r-card') !== -1 || cls.indexOf('card') !== -1;
      }
      if (p === '[data-card]' || p === '[data-rank]') return false;
      if (p.endsWith(' *')) {
        return el.parentElement && (el.parentElement.className || '').indexOf(p.slice(0, -2).replace('.', '')) !== -1;
      }
      if (p === 'svg' || p === 'img') return el.tagName === p.toUpperCase();
      return false;
    }));
  }
};

const sandbox = {
  window: window,
  document: document,
  console: console,
  TextDecoder: TextDecoder,
  Uint8Array: Uint8Array,
  Uint8ClampedArray: Uint8ClampedArray,
  Int32Array: Int32Array,
  Float32Array: Float32Array,
  WeakSet: WeakSet,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  getComputedStyle: () => ({ opacity: '1', visibility: 'visible', filter: 'none', backgroundImage: '' }),
  MutationObserver: function () { this.observe = function () {}; this.disconnect = function () {}; },
  location: window.location,
  Promise: Promise,
  JSON: JSON,
  Math: Math,
  Date: Date,
  WeakMap: WeakMap,
  Map: Map,
  Set: Set,
  Object: Object,
  Array: Array,
  String: String,
  Number: Number,
  Error: Error,
  parseInt: parseInt,
  parseFloat: parseFloat,
  isFinite: isFinite,
  isNaN: isNaN
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// Загружаем настоящие модули: парсер карт и оценщик.
vm.runInContext(fs.readFileSync(path.join(DIR, 'card_parser.js'), 'utf8'), sandbox, { filename: 'card_parser.js' });
// hand_eval.js сам выставляет себя в self/window — именно это и проверяем,
// повторяя путь service worker, где модули грузятся через importScripts.
vm.runInContext(fs.readFileSync(path.join(DIR, 'hand_eval.js'), 'utf8'), sandbox, { filename: 'hand_eval.js' });
vm.runInContext(fs.readFileSync(path.join(DIR, 'monte_carlo.js'), 'utf8'), sandbox, { filename: 'monte_carlo.js' });

// ------------------------------------------------------------------ проверки
console.log('\n1. Парсер карт загрузился');
const ParserCore = sandbox.window.PokerCardParserCore;
check('PokerCardParserCore доступен (это и был сломанный класс)', typeof ParserCore === 'function');
if (typeof ParserCore !== 'function') {
  console.log('\nДальше проверять нечего: парсер не загрузился.');
  process.exit(1);
}

console.log('\n2. Чтение состояния стола');
const parser = new ParserCore();
const state = parser.getState();
console.log('   распознанные игроки: ' + JSON.stringify(
  (state._raw.players || []).slice(0, 4).map((p) => ({ name: p.name, cash: p.cash, status: p.status }))
));

eq('карманные карты героя — 7♣ и 7♠', JSON.stringify(state.myCards.map((c) => c.rank + c.suit)), JSON.stringify(['7c', '7s']));
eq('борд — A♠ K♥ 7♦', JSON.stringify(state.communityCards.map((c) => c.rank + c.suit)), JSON.stringify(['As', 'Kh', '7d']));
eq('улица — флоп', state.stage, 'flop');
eq('банк прочитан', state.pot, 12.5);
eq('ставка к коллу прочитана', state.betToCall, 4);
eq('большой блайнд прочитан', state.bigBlind, 2);
eq('игроков в игре — 3', state.numPlayers, 3);
eq('за столом — 3', state.numSeated, 3);
eq('стек героя — 150', state.heroStack, 150);
eq('имя героя прочитано', state.heroName, 'HeroPlayer');
check('рубашка вниз не попала в карты', state.myCards.length === 2 && state.communityCards.length === 3);

console.log('\n3. Телеметрия экономии трафика');
check('телеметрия попала в состояние', !!state._raw.shotStats, String(state._raw.shotStats));
if (state._raw.shotStats) {
  eq('кадров без съёмки (мост)', state._raw.shotStats.bridgeSkips, 7);
  eq('кадров отдано из кэша', state._raw.shotStats.cacheHits, 2);
}

console.log('\n4. Эквити и решение на прочитанном состоянии');
const HandEval = vm.runInContext('HandEval', sandbox);
check('HandEval загружен', !!HandEval);
const heroNoBoard = state.myCards.concat(state.communityCards);
const evalResult = HandEval.evaluate(heroNoBoard);
eq('комбинация героя — сет семёрок', evalResult.categoryName, 'trips');

const mc = new (vm.runInContext('MonteCarloSimulator', sandbox))({ seed: 1 });
const eqRes = mc.computeWinRate(state.myCards, state.communityCards, state.numPlayers - 1, 20000);
check('эквити сета семёрок на A-K-7 > 70%', eqRes.equity > 70, String(eqRes.equity));
console.log('   эквити против ' + (state.numPlayers - 1) + ' случайных рук: ' + eqRes.equity + '%');

console.log('\n5. Против диапазона на реальном борде');
const range = { AA: 1, KK: 1, AK: 1, AQ: 1, '77': 1, 'KQ': 1 };
const rangeRes = mc.computeWinRateVsRange(state.myCards, state.communityCards, {
  range: range, opponents: 1, iterations: 20000
});
check('эквити против диапазона посчитано', rangeRes.equity > 0 && rangeRes.equity < 100, String(rangeRes.equity));
check('эквити против сильного диапазона ниже, чем против случайных рук',
  rangeRes.equity < eqRes.equity, rangeRes.equity + ' < ' + eqRes.equity);
console.log('   эквити против диапазона: ' + rangeRes.equity + '%  (' + rangeRes.rangePercent + '% рук)');

console.log('\n6. Защита от ложного покера');
// Страница без признаков игры не должна считаться столом.
(function noPoker() {
  const plainBody = makeElement('body');
  plainBody.innerText = 'Обычный сайт';
  const plainDoc = Object.assign({}, document, { body: plainBody });
  const window2 = Object.assign({}, window, {
    innerHeight: 800,
    innerWidth: 1200,
    // Чужой домен — главный признак, по которому скрипт должен отказаться работать.
    location: { hostname: 'example.com', href: 'https://example.com/' }
  });
  const sb2 = Object.assign({}, sandbox, { document: plainDoc, window: window2 });
  sb2.self = sb2;
  sb2.globalThis = sb2;
  sb2.location = window2.location;
  vm.createContext(sb2);
  let threw = false;
  try {
    vm.runInContext(fs.readFileSync(path.join(DIR, 'content_iframe.js'), 'utf8'), sb2, { filename: 'content_iframe.js' });
  } catch (e) { threw = true; }
  const initialized = vm.runInContext('typeof window.__pokerAssistantInitialized', sb2) === 'boolean';
  check('на чужом домене скрипт не инициализируется', !initialized && !threw,
    'initialized=' + initialized + ', threw=' + threw);
})();

console.log('\n7. Экономия: мост отдал карты — скриншот не нужен');
(function bridgePriority() {
  const messages = [];
  const window2 = Object.assign({}, window, {
    location: { hostname: 'pu-web2.e5t.online', href: 'https://pu-web2.e5t.online/game' }
  });
  window2.chrome = {
    runtime: {
      id: 'test',
      lastError: null,
      sendMessage(msg) { messages.push(msg); },
      onMessage: { addListener() {} },
      getURL: (p) => 'chrome-extension://test/' + p
    }
  };
  window2.PokerVision = { readDataUrl: () => Promise.resolve({ myCards: [], communityCards: [] }) };
  // Свежие карты, прочитанные прямо из canvas страницы.
  window2.__paBridgeCards = {
    myCards: [{ rank: 'A', suit: 's' }, { rank: 'A', suit: 'h' }],
    communityCards: [],
    source: 'cv',
    at: Date.now()
  };
  const gameBody = makeElement('body');
  gameBody.className = 'r-scene-container';
  const doc2 = Object.assign({}, document, { body: gameBody });
  const sb2 = Object.assign({}, sandbox, { document: doc2, window: window2 });
  sb2.self = sb2;
  sb2.globalThis = sb2;
  sb2.location = window2.location;
  sb2.chrome = window2.chrome;
  vm.createContext(sb2);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'content_iframe.js'), 'utf8'), sb2, { filename: 'content_iframe.js' });
  const initialized = vm.runInContext('typeof window.__pokerAssistantInitialized', sb2) === 'boolean';
  check('на домене игры скрипт инициализируется', initialized);
  // Даём отработать стартовым вызовам.
  const askedForShot = messages.some((m) => m && m.action === 'captureTable');
  check('при свежих картах от моста скриншот не запрашивается', !askedForShot,
    'запросов captureTable: ' + messages.filter((m) => m && m.action === 'captureTable').length);
  const stats = vm.runInContext('window.__paShotStats', sb2);
  check('счётчик «без съёмки» увеличился', stats && stats.bridgeSkips > 0, JSON.stringify(stats));
})();

// ------------------------------------------------------------------ итог
console.log('\n' + '='.repeat(58));
console.log('Пройдено: ' + passed + ', провалено: ' + failed);
if (failed) {
  console.log('\nПровалы:');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('='.repeat(58));
process.exit(failed ? 1 : 0);
