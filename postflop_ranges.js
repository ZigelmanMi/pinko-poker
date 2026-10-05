// Постфлоп: эквити против диапазона, не против случайных рук.
// srp_pfr / srp_caller / threebet / bb_defend.
// Сужение по борду — множители, не частоты солвера.
// В мультивее один и тот же диапазон на каждого.

(function (root) {
  'use strict';

  // ------------------------------------------------------------------
  // 0. Зависимости и утилиты
  // ------------------------------------------------------------------

  /** Пробуем require, но не падаем, если модуль не рядом (браузер). */
  function tryRequire(path) {
    try {
      return (typeof require === 'function') ? require(path) : null;
    } catch (e) {
      return null;
    }
  }

  const HandEval = root.HandEval || tryRequire('./hand_eval.js');
  const RANKS = (HandEval && HandEval.RANK_CHARS) || '23456789TJQKA';
  const SUITS = (HandEval && HandEval.SUIT_CHARS) || 'shdc';
  const ALL_COMBOS = 1326; // C(52,2) — знаменатель процентов

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function num(value, fallback) {
    return (typeof value === 'number' && isFinite(value)) ? value : fallback;
  }
  function rankIndex(rank) { return RANKS.indexOf(rank); }
  function roundToHalf(x) { return Math.round(x * 2) / 2; }

  // ------------------------------------------------------------------
  // 1. Карты и 169-нотация
  // ------------------------------------------------------------------

  /** Приводит карту ('Ah' или {rank:'A',suit:'h'}) к {rank:'A',suit:'h'}. */
  function cardParts(card) {
    if (card == null) throw new Error('PostflopRanges: пустая карта');
    if (typeof card === 'string') {
      const m = /^\s*(10|[2-9TJQKA])\s*([shdc])\s*$/i.exec(card);
      if (!m) throw new Error('PostflopRanges: не разобрать карту "' + card + '"');
      const rank = (m[1].toUpperCase() === '10') ? 'T' : m[1].toUpperCase();
      return { rank: rank, suit: m[2].toLowerCase() };
    }
    if (typeof card === 'object' && card.rank != null && card.suit != null) {
      let rank = String(card.rank).toUpperCase();
      if (rank === '10') rank = 'T';
      const suit = String(card.suit).toLowerCase();
      if (rankIndex(rank) < 0) throw new Error('PostflopRanges: неизвестный ранг "' + card.rank + '"');
      if (SUITS.indexOf(suit) < 0) throw new Error('PostflopRanges: неизвестная масть "' + card.suit + '"');
      return { rank: rank, suit: suit };
    }
    throw new Error('PostflopRanges: не разобрать карту ' + JSON.stringify(card));
  }

  /** Карта -> строка 'As' (единый алфавит для сравнений). */
  function cardToString(card) {
    const p = cardParts(card);
    return p.rank + p.suit;
  }

  /** Нормализованный ключ руки: 'TT', 'AKs', 'AKo' (десятка — 'T'). */
  function normalizeHand(card1, card2) {
    const a = cardParts(card1);
    const b = cardParts(card2);
    if (a.rank === b.rank) return a.rank + b.rank;
    const hi = rankIndex(a.rank) > rankIndex(b.rank) ? a : b;
    const lo = hi === a ? b : a;
    return hi.rank + lo.rank + (a.suit === b.suit ? 's' : 'o');
  }

  /** Ключ руки -> 'AKs'/'AKo'/'TT' (принимает и 'AhKh'). */
  function normalizeHandKey(value) {
    if (typeof value === 'string') {
      const compact = value.replace(/[\s,]+/g, '');
      const m = /^(10|[2-9TJQKA])([shdc])(10|[2-9TJQKA])([shdc])$/i.exec(compact);
      if (m) return normalizeHand(m[1] + m[2], m[3] + m[4]);
      const k = compact.toUpperCase();
      if (k.length === 2 && k[0] === k[1] && rankIndex(k[0]) >= 0) return k;
      const sm = /^([2-9TJQKA])([2-9TJQKA])([SO])$/.exec(k);
      if (sm) {
        if (rankIndex(sm[1]) <= rankIndex(sm[2])) {
          throw new Error('PostflopRanges: в "' + value + '" старший ранг должен быть первым');
        }
        return sm[1] + sm[2] + sm[3].toLowerCase();
      }
      throw new Error('PostflopRanges: не понимаю руку "' + value + '"');
    }
    if (Array.isArray(value) && value.length === 2) return normalizeHand(value[0], value[1]);
    throw new Error('PostflopRanges: не понимаю руку ' + JSON.stringify(value));
  }

  // ------------------------------------------------------------------
  // 2. Разбор нотации диапазонов
  // ------------------------------------------------------------------
  // Поддерживаем (как preflop_ranges.js):
  //   'AA' | 'TT+' | 'A2s+' | 'K9o+' | '22-99' | 'A2s-A5s' | 'T9s-54s'
  // Формат выбран специально: строку видно глазами и правится руками.

  const TOKEN_PAIR = /^([2-9TJQKA])\1$/;
  const TOKEN_PAIR_PLUS = /^([2-9TJQKA])\1\+$/;
  const TOKEN_PAIR_DASH = /^([2-9TJQKA])\1-([2-9TJQKA])\2$/;
  const TOKEN_NONPAIR = /^([2-9TJQKA])([2-9TJQKA])([SO])$/;
  const TOKEN_NONPAIR_PLUS = /^([2-9TJQKA])([2-9TJQKA])([SO])\+$/;
  const TOKEN_NONPAIR_DASH = /^([2-9TJQKA])([2-9TJQKA])([SO])-([2-9TJQKA])([2-9TJQKA])([SO])$/;

  function nonPairKey(hi, lo, suited) {
    if (rankIndex(hi) <= rankIndex(lo)) {
      throw new Error('PostflopRanges: в "' + hi + lo + suited + '" старший ранг должен быть первым');
    }
    return hi + lo + suited;
  }

  /** Строка диапазона -> Set уникальных ключей рук (как требует API). */
  function parseRange(str) {
    if (str == null) return new Set();
    if (Array.isArray(str)) {
      const set = new Set();
      for (const k of str) set.add(normalizeHandKey(k));
      return set;
    }
    const out = [];
    const push = (key) => { if (out.indexOf(key) < 0) out.push(key); };
    const tokens = String(str).trim().split(/[\s,]+/).filter(Boolean);

    for (const raw of tokens) {
      const tok = String(raw).toUpperCase();
      let m;
      if ((m = TOKEN_PAIR.exec(tok))) {
        push(m[1] + m[1]);
      } else if ((m = TOKEN_PAIR_PLUS.exec(tok))) {
        for (let i = rankIndex(m[1]); i < RANKS.length; i++) push(RANKS[i] + RANKS[i]);
      } else if ((m = TOKEN_NONPAIR_PLUS.exec(tok))) {
        const hi = m[1], lo = m[2], suited = m[3].toLowerCase();
        for (let i = rankIndex(lo); i < rankIndex(hi); i++) push(nonPairKey(hi, RANKS[i], suited));
      } else if ((m = TOKEN_NONPAIR.exec(tok))) {
        push(nonPairKey(m[1], m[2], m[3].toLowerCase()));
      } else if ((m = TOKEN_PAIR_DASH.exec(tok))) {
        const from = rankIndex(m[1]), to = rankIndex(m[2]);
        const step = to >= from ? 1 : -1;
        for (let i = from; step > 0 ? i <= to : i >= to; i += step) push(RANKS[i] + RANKS[i]);
      } else if ((m = TOKEN_NONPAIR_DASH.exec(tok))) {
        const hi1 = m[1], lo1 = m[2], s1 = m[3].toLowerCase();
        const hi2 = m[4], lo2 = m[5], s2 = m[6].toLowerCase();
        if (s1 !== s2) throw new Error('PostflopRanges: "' + raw + '" — в диапазоне разные типы рук');
        if (hi1 === hi2) {
          const from = rankIndex(lo1), to = rankIndex(lo2);
          const step = to >= from ? 1 : -1;
          for (let i = from; step > 0 ? i <= to : i >= to; i += step) push(nonPairKey(hi1, RANKS[i], s1));
        } else {
          const gap1 = rankIndex(hi1) - rankIndex(lo1);
          const gap2 = rankIndex(hi2) - rankIndex(lo2);
          if (gap1 !== gap2) {
            throw new Error('PostflopRanges: "' + raw + '" — у рук разный разрыв между рангами');
          }
          const from = rankIndex(hi1), to = rankIndex(hi2);
          const step = to >= from ? 1 : -1;
          for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
            push(nonPairKey(RANKS[i], RANKS[i - gap1], s1));
          }
        }
      } else {
        throw new Error('PostflopRanges.parseRange: не понимаю токен "' + raw + '"');
      }
    }
    return new Set(out);
  }

  /** Число комбо в диапазоне: пара 6, одномастная 4, разномастная 12. */
  function comboCount(range) {
    const keys = range instanceof Set ? Array.from(range) : parseRange(range);
    let combos = 0;
    for (const k of keys) combos += (k.length === 2 ? 6 : (k[2] === 's' ? 4 : 12));
    return combos;
  }

  /** Процент заполненности диапазона (от всех 1326 комбо). */
  function rangePercent(range) {
    return +(comboCount(range) / ALL_COMBOS * 100).toFixed(1);
  }

  /** Все конкретные комбо ключа: массив пар строк ['As','Ks']. */
  function combosForHandKey(key) {
    const k = String(key || '').toUpperCase();
    const out = [];
    if (k.length === 2 && k[0] === k[1] && rankIndex(k[0]) >= 0) {
      for (let a = 0; a < 4; a++) {
        for (let b = a + 1; b < 4; b++) out.push([k[0] + SUITS[a], k[0] + SUITS[b]]);
      }
      return out;
    }
    const m = /^([2-9TJQKA])([2-9TJQKA])([SO])$/.exec(k);
    if (!m) return [];
    const hi = m[1], lo = m[2], suited = m[3] === 'S';
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) {
        if (suited ? a !== b : a === b) continue;
        out.push([hi + SUITS[a], lo + SUITS[b]]);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------
  // 3. ДИАПАЗОНЫ СОПЕРНИКА по типам банка (169-нотация)
  // ------------------------------------------------------------------
  // Это «с чем соперник реально продолжает/ставит», а не его префлоп-рфи.

  const RANGES = {
    // Соперник открыл префлоп и теперь агрессор в SRP. Диапазон ставки —
    // примерно его диапазон открытия из средней позиции.
    srp_pfr: '22+ A2s+ KTs+ QTs+ JTs T9s 98s 87s 76s 65s 54s ATo+ KJo+ QJo',

    // Соперник коллировал префлоп и играет без инициативы: нет AA/KK/QQ,
    // зато больше спекулятивных одномастных рук и средних пар.
    srp_caller: '22-JJ A2s-ATs K9s+ Q9s+ J9s+ T8s+ 97s+ 86s+ 75s+ 64s+ 53s+ ' +
                'AJo+ KQo KJo QJo JTo',

    // Соперник 3-бетил префлоп: узкий линейный диапазон вэлью + блефовые
    // одномастные тузы.
    threebet: 'JJ+ AQs+ AKo A5s-A2s KQs AQo',

    // Соперник защищал BB коллом: широкий диапазон (там вложен 1 ББ).
    bb_defend: '22-TT A2s+ KTs+ QTs+ JTs T9s 98s 87s 76s 65s 54s ' +
               'A2o-AQo K9o+ Q9o+ J9o+ T9o 98o'
  };

  const POT_TYPES = ['srp_pfr', 'srp_caller', 'threebet', 'bb_defend'];

  const POT_TYPE_ALIASES = {
    SRP_PFR: 'srp_pfr', PFR: 'srp_pfr', SRP: 'srp_pfr', AGGRESSOR: 'srp_pfr',
    SRP_CALLER: 'srp_caller', CALLER: 'srp_caller', FLAT: 'srp_caller',
    THREEBET: 'threebet', '3BET': 'threebet', '3-BET': 'threebet', THREE_BET: 'threebet',
    BB_DEFEND: 'bb_defend', BBDEFEND: 'bb_defend', BB: 'bb_defend', DEFEND: 'bb_defend'
  };

  function normalizePotType(value) {
    if (value == null) return 'srp_pfr';
    if (POT_TYPES.indexOf(value) >= 0) return value;
    const key = String(value).toUpperCase().replace(/[\s-]+/g, '_');
    return POT_TYPE_ALIASES[key] || null;
  }

  const AGGRESSION_TYPES = ['check', 'bet', 'raise', 'call'];
  const AGGRESSION_ALIASES = {
    CHECK: 'check', X: 'check', CHECKING: 'check', PASSIVE: 'check',
    BET: 'bet', B: 'bet', LEAD: 'bet', CB: 'bet', C_BET: 'bet',
    RAISE: 'raise', R: 'raise', RAISING: 'raise', CHECKRAISE: 'raise',
    CALL: 'call', C: 'call', CALLING: 'call'
  };

  function normalizeAggression(value) {
    if (value == null) return 'bet';
    if (AGGRESSION_TYPES.indexOf(value) >= 0) return value;
    const key = String(value).toUpperCase().replace(/[\s_-]+/g, '');
    return AGGRESSION_ALIASES[key] || 'bet';
  }

  // ------------------------------------------------------------------
  // 4. Текстура борда и классификация комбо
  // ------------------------------------------------------------------

  /** Простое описание борда: спаренность, масти, связанность. */
  function analyzeBoard(board) {
    const rankCount = {};
    const suitCount = {};
    for (const c of board) {
      rankCount[c[0]] = (rankCount[c[0]] || 0) + 1;
      suitCount[c[1]] = (suitCount[c[1]] || 0) + 1;
    }
    let paired = false;
    let tripsOnBoard = false;
    let maxSuit = 0;
    for (const r in rankCount) {
      if (rankCount[r] >= 2) paired = true;
      if (rankCount[r] >= 3) tripsOnBoard = true;
    }
    for (const s in suitCount) if (suitCount[s] > maxSuit) maxSuit = suitCount[s];

    // Связанность: три и более разных ранга укладываются в окно из 5.
    const ranks = Object.keys(rankCount).map(rankIndex).sort((a, b) => a - b);
    let straighty = false;
    for (let i = 0; i + 2 < ranks.length; i++) {
      if (ranks[i + 2] - ranks[i] <= 4) straighty = true;
    }

    return {
      paired: paired,
      tripsOnBoard: tripsOnBoard,
      flushPossible: maxSuit >= 2,   // есть флеш-дро (двухмастный или монотонный)
      monotone: maxSuit >= 3,        // борд одномастный — флеш уже возможен
      straighty: straighty,
      maxSuit: maxSuit
    };
  }

  /** Старшая карта стрита по маске рангов (бит rankIndex), 0 — стрита нет. */
  function straightHigh(mask) {
    for (let hi = 12; hi >= 4; hi--) {
      let need = 0;
      for (let k = 0; k < 5; k++) need |= 1 << (hi - k);
      if ((mask & need) === need) return hi;
    }
    const wheel = (1 << 12) | (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3);
    if ((mask & wheel) === wheel) return 4;
    return 0;
  }

  const CAT_HIGH_CARD = 0;
  const CAT_PAIR = 1;
  const CAT_TWO_PAIR = 2;
  const CAT_TRIPS = 3;
  const CAT_STRAIGHT = 4;
  const CAT_FLUSH = 5;

  /** HandEval обязателен для оценки готовой руки — падаем понятно. */
  function requireHandEval() {
    if (!HandEval || typeof HandEval.evaluateHand !== 'function') {
      throw new Error('PostflopRanges: не загружен HandEval — нужен hand_eval.js ' +
        '(или вызов setSimulator/подключение модулей до postflop_ranges.js)');
    }
    return HandEval;
  }

  /**
   * Класс конкретного комбо на данном борде: категория готовой руки плюс
   * флаги дро. Стрит-дро определяется честно и просто: если добавление
   * ОДНОЙ недостающей карты даёт стрит — это стрит-дро (OESD и гатшот
   * здесь не разделяются).
   */
  function classifyCombo(cards, board) {
    const he = requireHandEval();
    const cat = he.evaluateHand(cards, board).category;
    const all = cards.concat(board);

    const suitCount = {};
    for (const c of all) suitCount[c[1]] = (suitCount[c[1]] || 0) + 1;
    let maxSuit = 0;
    for (const s in suitCount) if (suitCount[s] > maxSuit) maxSuit = suitCount[s];
    const flush = cat >= CAT_FLUSH;
    const flushDraw = !flush && maxSuit >= 4;

    let straightDraw = false;
    if (cat < CAT_STRAIGHT && all.length < 7) {
      let mask = 0;
      for (const c of all) mask |= 1 << rankIndex(c[0]);
      for (let r = 0; r < RANKS.length; r++) {
        if (mask & (1 << r)) continue;
        if (straightHigh(mask | (1 << r))) { straightDraw = true; break; }
      }
    }

    return {
      cat: cat,
      monster: (cat >= CAT_STRAIGHT) || cat === CAT_TRIPS,
      twoPair: cat === CAT_TWO_PAIR,
      pair: cat === CAT_PAIR,
      air: cat === CAT_HIGH_CARD,
      flush: flush,
      flushDraw: flushDraw,
      straightDraw: straightDraw
    };
  }

  /** Множитель веса комбо: борд + агрессия. Эвристика, не солвер. */
  function comboMultiplier(cls, tex, aggression) {
    let m = 1;
    const aggressive = (aggression === 'bet' || aggression === 'raise');

    // Спаренный борд: сеты/фулл-хаусы и две пары тяжелее, воздух легче.
    if (tex.paired) {
      if (cls.monster) m *= 1.5;
      else if (cls.twoPair) m *= 1.2;
      else if (cls.air) m *= 0.6;
    }

    // На борде возможно флеш-дро: дро-руки и готовые флеши тяжелее,
    // особенно когда соперник агрессивен.
    if (tex.flushPossible) {
      if (cls.flushDraw || cls.flush) {
        m *= aggressive ? (aggression === 'raise' ? 1.7 : 1.45) : 1.2;
      } else if (tex.monotone) {
        // Одномастный борд без масти в руке — заметно хуже.
        m *= 0.8;
      }
    }

    // Связанный борд: стрит-дро тяжелее при агрессии.
    if (tex.straighty && cls.straightDraw) {
      m *= aggressive ? 1.4 : 1.15;
    }

    // Само действие: бет/рейз поляризует диапазон (вэлью + дро), чек/колл
    // смещает его к средним рукам.
    if (aggression === 'bet') {
      if (cls.monster) m *= 1.25;
      else if (cls.twoPair) m *= 1.15;
      else if (cls.pair) m *= 0.9;
      else if (cls.air && !cls.flushDraw && !cls.straightDraw) m *= 0.75;
    } else if (aggression === 'raise') {
      if (cls.monster) m *= 1.4;
      else if (cls.twoPair) m *= 1.2;
      else if (cls.pair) m *= 0.85;
      else if (cls.air && !cls.flushDraw && !cls.straightDraw) m *= 0.55;
    } else if (aggression === 'check') {
      if (cls.monster && !cls.flushDraw) m *= 0.8; // чек-рейндж обычно капнут
      else if (cls.pair) m *= 1.15;
      else if (cls.air) m *= 1.15;
    } else if (aggression === 'call') {
      if (cls.monster) m *= 1.1;
      else if (cls.twoPair) m *= 1.15;
      else if (cls.pair) m *= 1.2;
      else if (cls.air && !cls.flushDraw && !cls.straightDraw) m *= 0.8;
    }
    return m;
  }

  // ------------------------------------------------------------------
  // 5. Взвешенный диапазон: сужение по борду и агрессии
  // ------------------------------------------------------------------

  /** Убираем из диапазона комбо, пересекающиеся с картами героя и борда. */
  function blockedCards(holeCards, board) {
    const blocked = Object.create(null);
    for (const c of holeCards) blocked[c] = true;
    for (const c of board) blocked[c] = true;
    return blocked;
  }

  /**
   * {@code getWeightedRange}-ядро: превращает строку диапазона в объект
   * { 'AKs': 1.4, ... }, пригодный для computeWinRateVsRange.
   * Вес ключа = средний множитель по его незаблокированным комбо.
   */
  function buildWeightedRange(holeCards, board, potType, aggression) {
    const keys = parseRange(RANGES[potType]);
    const tex = analyzeBoard(board);
    const blocked = blockedCards(holeCards, board);
    const range = {};
    let combosInRange = 0;
    let keysUsed = 0;

    for (const key of keys) {
      const combos = combosForHandKey(key).filter((c) => !blocked[c[0]] && !blocked[c[1]]);
      if (!combos.length) continue;
      let sum = 0;
      for (const c of combos) sum += comboMultiplier(classifyCombo(c, board), tex, aggression);
      const w = sum / combos.length;
      if (w > 0) {
        range[key] = +w.toFixed(4);
        combosInRange += combos.length * w;
        keysUsed++;
      }
    }

    return {
      range: range,
      keysUsed: keysUsed,
      combosInRange: combosInRange,
      rangePercent: +(combosInRange / ALL_COMBOS * 100).toFixed(1),
      basePercent: rangePercent(RANGES[potType]),
      texture: tex
    };
  }

  // ------------------------------------------------------------------
  // 6. Симулятор (ленивое подключение + возможность подмены)
  // ------------------------------------------------------------------

  let injectedSimulator = null;
  let autoSimulator = null;
  let simulatorDisabled = false;

  /**
   * setSimulator(sim):
   *   sim — объект с computeWinRateVsRange (в т.ч. MonteCarloSimulator);
   *   вызвать без аргументов или с null — вернуться к автоопределению;
   *   false — намеренно отключить симулятор (диагностика/тесты).
   */
  function setSimulator(sim) {
    if (arguments.length === 0 || sim == null) {
      injectedSimulator = null;
      simulatorDisabled = false;
      autoSimulator = null;
      CACHE.clear();
      return api;
    }
    if (sim === false) {
      injectedSimulator = null;
      simulatorDisabled = true;
      CACHE.clear();
      return api;
    }
    injectedSimulator = sim;
    simulatorDisabled = false;
    CACHE.clear();
    return api;
  }

  function resolveSimulator() {
    if (simulatorDisabled) return null;
    if (injectedSimulator) return injectedSimulator;
    if (autoSimulator) return autoSimulator;
    let MC = root.MonteCarloSimulator;
    if (!MC) {
      const mod = tryRequire('./monte_carlo.js');
      MC = mod && (mod.MonteCarloSimulator || mod);
    }
    if (MC && typeof MC === 'function') {
      try { autoSimulator = new MC({ seed: 20240607 }); } catch (e) { autoSimulator = null; }
    }
    return autoSimulator;
  }

  function requireSimulator(where) {
    const sim = resolveSimulator();
    if (!sim || typeof sim.computeWinRateVsRange !== 'function') {
      throw new Error('PostflopRanges.' + where + ': не загружен MonteCarloSimulator ' +
        '(нужны monte_carlo.js и hand_eval.js либо setSimulator(sim))');
    }
    return sim;
  }

  // ------------------------------------------------------------------
  // 7. Валидация и подготовка входа
  // ------------------------------------------------------------------

  const DEFAULT_ITERATIONS = 5000;
  const MIN_ITERATIONS = 500;
  const MAX_ITERATIONS = 200000;

  function normalizeIterations(value) {
    const it = Math.round(num(value, DEFAULT_ITERATIONS));
    return clamp(it, MIN_ITERATIONS, MAX_ITERATIONS);
  }

  function prepareInput(input, where) {
    if (!input || typeof input !== 'object') {
      throw new Error('PostflopRanges.' + where + ': нужен объект с параметрами');
    }
    if (!Array.isArray(input.holeCards) || input.holeCards.length !== 2) {
      throw new Error('PostflopRanges.' + where + ': holeCards должен содержать ровно 2 карты');
    }
    const hole = input.holeCards.map(cardToString);
    if (hole[0] === hole[1]) {
      throw new Error('PostflopRanges.' + where + ': одинаковые карманные карты');
    }

    const rawBoard = (input.board == null) ? [] : input.board;
    if (!Array.isArray(rawBoard)) {
      throw new Error('PostflopRanges.' + where + ': board должен быть массивом карт');
    }
    const board = rawBoard.map(cardToString);
    if (board.length !== 3 && board.length !== 4 && board.length !== 5) {
      throw new Error('PostflopRanges.' + where + ': борд должен содержать 3, 4 или 5 карт (постфлоп)');
    }
    const seen = Object.create(null);
    for (const c of hole.concat(board)) {
      if (seen[c]) throw new Error('PostflopRanges.' + where + ': повторяющаяся карта ' + c);
      seen[c] = true;
    }

    const potType = normalizePotType(input.potType);
    if (!potType) {
      throw new Error('PostflopRanges.' + where + ': не понимаю potType "' + input.potType +
        '" (ожидаю ' + POT_TYPES.join('/') + ')');
    }

    const opponents = clamp(Math.round(num(input.opponents, 1)) || 1, 1, 5);
    return {
      hole: hole,
      board: board,
      potType: potType,
      aggression: normalizeAggression(input.aggression),
      opponents: opponents,
      iterations: normalizeIterations(input.iterations)
    };
  }

  // ------------------------------------------------------------------
  // 8. getEquity
  // ------------------------------------------------------------------

  // Кэш по «споту»: один и тот же борд/рука/тип банка/агрессия считаются
  // один раз — background.js вызывает подсказку многократно на том же столе.
  const CACHE = new Map();
  const CACHE_LIMIT = 512;

  function cacheKeyOf(ctx) {
    return ctx.hole.join('') + '|' + ctx.board.join('') + '|' + ctx.potType + '|' +
      ctx.aggression + '|' + ctx.opponents + '|' + ctx.iterations;
  }

  /**
   * { holeCards, board, potType, aggression, opponents, iterations }
   * -> { equity, rangePercent, combosInRange, rangeName, iterations, ... }
   */
  function getEquity(input) {
    const ctx = prepareInput(input, 'getEquity');
    const sim = requireSimulator('getEquity');
    const key = cacheKeyOf(ctx);
    if (CACHE.has(key)) return Object.assign({}, CACHE.get(key));

    const wr = buildWeightedRange(ctx.hole, ctx.board, ctx.potType, ctx.aggression);
    if (wr.keysUsed === 0) {
      throw new Error('PostflopRanges.getEquity: диапазон "' + ctx.potType +
        '" полностью заблокирован картами героя и борда');
    }

    let raw;
    try {
      raw = sim.computeWinRateVsRange(ctx.hole, ctx.board, {
        range: wr.range,
        opponents: ctx.opponents,
        iterations: ctx.iterations
      });
    } catch (e) {
      throw new Error('PostflopRanges.getEquity: симуляция не удалась (' + e.message + ')');
    }

    const rangeName = ctx.potType + ' (' + ctx.aggression + ')';
    const result = {
      equity: raw.equity,
      rangePercent: raw.rangePercent != null ? raw.rangePercent : wr.rangePercent,
      combosInRange: raw.combosInRange != null ? raw.combosInRange : Math.round(wr.combosInRange),
      rangeName: rangeName,
      iterations: raw.iterations != null ? raw.iterations : ctx.iterations,
      // дополнительные поля — удобно для отладки и HUD
      winRate: raw.winRate,
      tieRate: raw.tieRate,
      loseRate: raw.loseRate,
      baseRangePercent: wr.basePercent,
      potType: ctx.potType,
      aggression: ctx.aggression
    };

    if (CACHE.size >= CACHE_LIMIT) CACHE.clear();
    CACHE.set(key, result);
    return Object.assign({}, result);
  }

  /** Взвешенный диапазон наружу (для отладки и тестов сужения). */
  function getWeightedRange(input) {
    const ctx = prepareInput(input, 'getWeightedRange');
    requireHandEval();
    const wr = buildWeightedRange(ctx.hole, ctx.board, ctx.potType, ctx.aggression);
    return {
      range: Object.assign({}, wr.range),
      keysUsed: wr.keysUsed,
      combosInRange: Math.round(wr.combosInRange),
      rangePercent: wr.rangePercent,
      basePercent: wr.basePercent,
      rangeName: ctx.potType + ' (' + ctx.aggression + ')',
      texture: wr.texture
    };
  }

  // ------------------------------------------------------------------
  // 9. getAction: решение по эквити против диапазона
  // ------------------------------------------------------------------
  // Пороги (проценты эквити):
  //   RAISE_EDGE = 25 — «сильно выше pot odds» -> рейз;
  //   CALL_MARGIN = 6 — запас на рейк и недонейтрализацию эквити;
  //   RAISE_MIN_EQUITY = 45 — не рейзим совсем слабыми руками даже при
  //      дешёвом входе (защита от «рейза ради рейза»);
  //   BET_NO_CALL_EQUITY = 55 — порог ставки, когда доставлять нечего.
  // Без позиции (SB/BB/OOP) запас увеличивается на OOP_PENALTY.
  const RAISE_EDGE = 25;
  const CALL_MARGIN = 6;
  const RAISE_MIN_EQUITY = 45;
  const BET_NO_CALL_EQUITY = 55;
  const OOP_PENALTY = 2;
  const RAISE_POT_FRACTION = 0.66; // ~60-75% банка
  const MIN_BET_BB = 1;

  const OOP_POSITIONS = ['SB', 'BB', 'OOP'];

  function isOutOfPosition(position) {
    if (position == null) return false;
    return OOP_POSITIONS.indexOf(String(position).toUpperCase()) >= 0;
  }

  /** Сайзинг рейза: доля банка, но не меньше 1 ББ и не больше стека. */
  function raiseSizing(potBB, effectiveStackBB) {
    const pot = Math.max(potBB, MIN_BET_BB); // банк меньше 1 ББ — считаем от 1 ББ
    let s = roundToHalf(Math.max(MIN_BET_BB, RAISE_POT_FRACTION * pot));
    if (s > effectiveStackBB) s = effectiveStackBB; // остаток стека = олл-ин
    if (!(s > 0)) s = effectiveStackBB;
    return s;
  }

  /**
   * { holeCards, board, potType, aggression, potBB, betToCallBB,
   *   effectiveStackBB, position, numPlayers, iterations }
   * -> { action, sizingBB, amountFactor, equity, potOdds, rangeName, reason,
   *      source: 'postflop_ranges' }
   */
  function getAction(input) {
    const ctx = prepareInput(input, 'getAction');

    const potBB = Math.max(0, num(input.potBB, 0));
    const betToCallBB = Math.max(0, num(input.betToCallBB, 0));
    const stackRaw = num(input.effectiveStackBB, 100);
    if (!(stackRaw > 0)) {
      throw new Error('PostflopRanges.getAction: эффективный стек должен быть положительным числом');
    }
    const effectiveStackBB = stackRaw;
    const oop = isOutOfPosition(input.position);

    const eqRes = getEquity({
      holeCards: input.holeCards,
      board: input.board,
      potType: ctx.potType,
      aggression: ctx.aggression,
      opponents: input.opponents,
      iterations: input.iterations
    });
    const equity = eqRes.equity;
    const potOdds = betToCallBB > 0 ? +((betToCallBB / (potBB + betToCallBB)) * 100).toFixed(1) : 0;

    const base = {
      equity: equity,
      potOdds: potOdds,
      rangeName: eqRes.rangeName,
      source: 'postflop_ranges',
      potType: ctx.potType,
      aggression: ctx.aggression
    };

    // Ставки нет: CALL физически невозможен — только RAISE или CHECK.
    if (betToCallBB === 0) {
      const threshold = BET_NO_CALL_EQUITY + (oop ? OOP_PENALTY : 0);
      if (equity >= threshold) {
        const sizingBB = raiseSizing(potBB, effectiveStackBB);
        return Object.assign(base, {
          action: 'RAISE',
          sizingBB: sizingBB,
          amountFactor: +(sizingBB / Math.max(potBB, MIN_BET_BB)).toFixed(2),
          reason: 'Доставлять нечего, эквити ' + equity + '% против диапазона ' + eqRes.rangeName +
            ' >= порога ставки ' + threshold.toFixed(1) + '% — ставим ' + sizingBB + ' ББ.'
        });
      }
      return Object.assign(base, {
        action: 'CHECK',
        sizingBB: null,
        amountFactor: null,
        reason: 'Доставлять нечего, эквити ' + equity + '% ниже порога ставки ' +
          threshold.toFixed(1) + '% — играем чек (колла без ставки не бывает).'
      });
    }

    const raiseNeed = potOdds + RAISE_EDGE + (oop ? OOP_PENALTY : 0);
    const callNeed = potOdds + CALL_MARGIN + (oop ? OOP_PENALTY : 0);

    if (equity >= raiseNeed && equity >= RAISE_MIN_EQUITY) {
      const sizingBB = raiseSizing(potBB, effectiveStackBB);
      return Object.assign(base, {
        action: 'RAISE',
        sizingBB: sizingBB,
        amountFactor: +(sizingBB / Math.max(potBB, MIN_BET_BB)).toFixed(2),
        reason: 'Эквити ' + equity + '% сильно выше pot odds ' + potOdds + '% (порог рейза ' +
          raiseNeed.toFixed(1) + '%) против диапазона ' + eqRes.rangeName + ' — рейзим ' +
          sizingBB + ' ББ (вэлью + фолд-эквити).'
      });
    }

    if (equity >= callNeed) {
      return Object.assign(base, {
        action: 'CALL',
        sizingBB: null,
        amountFactor: null,
        reason: 'Эквити ' + equity + '% выше pot odds ' + potOdds + '% с запасом (порог колла ' +
          callNeed.toFixed(1) + '%, учтены рейк/implied odds) против диапазона ' + eqRes.rangeName +
          ' — коллируем ' + betToCallBB + ' ББ.'
      });
    }

    return Object.assign(base, {
      action: 'FOLD',
      sizingBB: null,
      amountFactor: null,
      reason: 'Эквити ' + equity + '% ниже pot odds ' + potOdds + '% с запасом (порог колла ' +
        callNeed.toFixed(1) + '%) против диапазона ' + eqRes.rangeName + ' — фолд.'
    });
  }

  // ------------------------------------------------------------------
  // 10. Проценты заполненности (для тестов и отладки)
  // ------------------------------------------------------------------

  const RANGE_PERCENT = (function buildPercent() {
    const out = {};
    for (const t of POT_TYPES) out[t] = rangePercent(RANGES[t]);
    return out;
  })();

  // ------------------------------------------------------------------
  // 11. Публичный API
  // ------------------------------------------------------------------

  const api = {
    getEquity: getEquity,
    getAction: getAction,
    getWeightedRange: getWeightedRange,
    parseRange: parseRange,
    getRange: function (potType) {
      const t = normalizePotType(potType);
      if (!t) throw new Error('PostflopRanges.getRange: не понимаю potType "' + potType + '"');
      return new Set(parseRange(RANGES[t]));
    },
    normalizeHand: normalizeHand,
    normalizeHandKey: normalizeHandKey,
    normalizePotType: normalizePotType,
    combosForHandKey: combosForHandKey,
    comboCount: comboCount,
    rangePercent: rangePercent,
    setSimulator: setSimulator,
    RANGES: RANGES,
    POT_TYPES: POT_TYPES,
    RANGE_PERCENT: RANGE_PERCENT,
    DEFAULT_ITERATIONS: DEFAULT_ITERATIONS,
    RAISE_POT_FRACTION: RAISE_POT_FRACTION
  };

  root.PostflopRanges = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
