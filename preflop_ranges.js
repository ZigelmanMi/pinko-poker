// Префлоп 6-max: открытия, 3-беты, колл, защита BB.
// Нотация 169 рук. Стек короче 15 ББ — пуш/фолд по эквити.
// SB открытия не коллирует. Чарт учебный, не выгрузка солвера.

(function (root) {
  'use strict';

  // hand_eval нужен для алфавита рангов. Без него модуль разбирает карту сам.
  function tryRequire(path) {
    try {
      return (typeof require === 'function') ? require(path) : null;
    } catch (e) {
      return null;
    }
  }
  const HandEval = root.HandEval || tryRequire('./hand_eval.js');
  const RANKS = (HandEval && HandEval.RANK_CHARS) || '23456789TJQKA'; // 2..A
  const ALL_COMBOS = 1326; // C(52,2) — знаменатель для процентов

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function num(value, fallback) {
    return (typeof value === 'number' && isFinite(value)) ? value : fallback;
  }
  function rankIndex(rank) { return RANKS.indexOf(rank); }

  // Карты и ключ руки (169-нотация)

  /** Приводит карту ('Ah' или {rank:'A',suit:'h'}) к {rank:'A',suit:'h'}. */
  function cardParts(card) {
    if (card == null) throw new Error('PreflopRanges: пустая карта');
    if (typeof card === 'string') {
      const m = /^\s*([2-9TJQKA])\s*([shdc])\s*$/i.exec(card);
      if (!m) throw new Error('PreflopRanges: не разобрать карту "' + card + '"');
      return { rank: m[1].toUpperCase(), suit: m[2].toLowerCase() };
    }
    if (typeof card === 'object' && card.rank != null && card.suit != null) {
      const rank = String(card.rank).toUpperCase();
      const suit = String(card.suit).toLowerCase();
      if (rankIndex(rank) < 0) throw new Error('PreflopRanges: неизвестный ранг "' + card.rank + '"');
      if ('shdc'.indexOf(suit) < 0) throw new Error('PreflopRanges: неизвестная масть "' + card.suit + '"');
      return { rank: rank, suit: suit };
    }
    throw new Error('PreflopRanges: не разобрать карту ' + JSON.stringify(card));
  }

  /**
   * Нормализованный ключ руки: старший ранг всегда первым,
   * пары — 'TT', не-пары — 'AKs' (одномастные) / 'AKo' (разномастные).
   * Десятка записывается как 'T': 10h + 9d -> 'T9o'.
   */
  function normalizeHand(card1, card2) {
    const a = cardParts(card1);
    const b = cardParts(card2);
    if (a.rank === b.rank) return a.rank + b.rank;
    const hi = rankIndex(a.rank) > rankIndex(b.rank) ? a : b;
    const lo = hi === a ? b : a;
    return hi.rank + lo.rank + (a.suit === b.suit ? 's' : 'o');
  }

  /** Все 169 ключей рук — используется в тестах и для валидации чартов. */
  function allHandKeys() {
    const keys = [];
    for (let i = 0; i < RANKS.length; i++) {
      keys.push(RANKS[i] + RANKS[i]); // пары
      for (let j = 0; j < i; j++) {   // не-пары: старший ранг первым
        keys.push(RANKS[i] + RANKS[j] + 's');
        keys.push(RANKS[i] + RANKS[j] + 'o');
      }
    }
    return keys;
  }

  /** Детерминированные конкретные карты для ключа ('AKs' -> ['As','Ks']). */
  function cardsForHandKey(key) {
    if (key.length === 2) return [key[0] + 's', key[1] + 'h'];
    if (key[2] === 's') return [key[0] + 's', key[1] + 's'];
    return [key[0] + 's', key[1] + 'h'];
  }

  // Разбор нотации диапазонов
  // Поддерживаемые формы (регистр не важен):
  //   'AA'             — одна рука
  //   'TT+'            — все пары от TT и выше
  //   'A2s+'           — A2s, A3s, ... AKs (фиксирован старший ранг)
  //   'KJo+'           — KJo, KQo
  //   '22-99'          — пары от 22 до 99
  //   'A2s-A5s'        — A2s, A3s, A4s, A5s
  //   'T9s-54s'        — коннекторы с одинаковым гэпом: T9s...54s

  const TOKEN_PAIR = /^([2-9TJQKA])\1$/;
  const TOKEN_PAIR_PLUS = /^([2-9TJQKA])\1\+$/;
  const TOKEN_SUITED = /^([2-9TJQKA])([2-9TJQKA])([SO])$/;
  const TOKEN_SUITED_PLUS = /^([2-9TJQKA])([2-9TJQKA])([SO])\+$/;
  const TOKEN_PAIR_DASH = /^([2-9TJQKA])\1-([2-9TJQKA])\2$/;
  const TOKEN_SUITED_DASH = /^([2-9TJQKA])([2-9TJQKA])([SO])-([2-9TJQKA])([2-9TJQKA])([SO])$/;

  /**
   * 'aks' -> 'AKS', 'a2s+' -> 'A2S+'. Приводим токен к верхнему регистру
   * целиком: суффикс 's'/'o' распознаётся как 'S'/'O', а в ключи рук
   * возвращается уже в нижнем регистре.
   */
  function normalizeToken(token) {
    return String(token).toUpperCase();
  }

  function pairKey(rank) { return rank + rank; }
  function nonPairKey(hi, lo, suited) {
    if (rankIndex(hi) <= rankIndex(lo)) {
      throw new Error('PreflopRanges: в "' + hi + lo + suited + '" старший ранг должен быть первым');
    }
    return hi + lo + suited;
  }

  /**
   * Разворачивает строку диапазона в массив уникальных ключей рук.
   * Возвращает именно МАССИВ (упорядоченный), чтобы в тестах было удобно
   * проверять .length; getRange() отдаёт Set.
   */
  function parseRange(str) {
    if (str == null) return [];
    if (Array.isArray(str)) return uniqueKeys(str.map((s) => normalizeHandKey(s)));
    const out = [];
    const push = (key) => { if (out.indexOf(key) < 0) out.push(key); };
    const tokens = String(str).trim().split(/[\s,]+/).filter(Boolean);

    for (const raw of tokens) {
      const tok = normalizeToken(raw);
      let m;
      if ((m = TOKEN_PAIR.exec(tok))) {
        push(pairKey(m[1]));
      } else if ((m = TOKEN_PAIR_PLUS.exec(tok))) {
        for (let i = rankIndex(m[1]); i < RANKS.length; i++) push(pairKey(RANKS[i]));
      } else if ((m = TOKEN_SUITED_PLUS.exec(tok))) {
        const hi = m[1], lo = m[2], suited = m[3].toLowerCase();
        for (let i = rankIndex(lo); i < rankIndex(hi); i++) push(nonPairKey(hi, RANKS[i], suited));
      } else if ((m = TOKEN_SUITED.exec(tok))) {
        push(nonPairKey(m[1], m[2], m[3].toLowerCase()));
      } else if ((m = TOKEN_PAIR_DASH.exec(tok))) {
        const from = rankIndex(m[1]), to = rankIndex(m[2]);
        const step = to >= from ? 1 : -1;
        for (let i = from; step > 0 ? i <= to : i >= to; i += step) push(pairKey(RANKS[i]));
      } else if ((m = TOKEN_SUITED_DASH.exec(tok))) {
        const hi1 = m[1], lo1 = m[2], s1 = m[3].toLowerCase();
        const hi2 = m[4], lo2 = m[5], s2 = m[6].toLowerCase();
        if (s1 !== s2) throw new Error('PreflopRanges: "' + raw + '" — в диапазоне разные типы рук');
        if (hi1 === hi2) {
          const from = rankIndex(lo1), to = rankIndex(lo2);
          const step = to >= from ? 1 : -1;
          for (let i = from; step > 0 ? i <= to : i >= to; i += step) push(nonPairKey(hi1, RANKS[i], s1));
        } else {
          const gap1 = rankIndex(hi1) - rankIndex(lo1);
          const gap2 = rankIndex(hi2) - rankIndex(lo2);
          if (gap1 !== gap2) {
            throw new Error('PreflopRanges: "' + raw + '" — у рук разный разрыв между рангами');
          }
          const from = rankIndex(hi1), to = rankIndex(hi2);
          const step = to >= from ? 1 : -1;
          for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
            push(nonPairKey(RANKS[i], RANKS[i - gap1], s1));
          }
        }
      } else {
        throw new Error('PreflopRanges.parseRange: не понимаю токен "' + raw + '"');
      }
    }
    return out;
  }

  /** Ключ руки -> 'AKs'/'AKo'/'TT' (принимает и строку 'AhKh'). */
  function normalizeHandKey(value) {
    if (typeof value === 'string') {
      const compact = value.replace(/[\s,]+/g, '');
      const m = /^([2-9TJQKA])([shdc])([2-9TJQKA])([shdc])$/i.exec(compact);
      if (m) return normalizeHand(m[1] + m[2], m[3] + m[4]);
      const k = normalizeToken(compact);
      if (pairKey(k[0]) === k) return k;
      const sm = TOKEN_SUITED.exec(k);
      if (sm) return nonPairKey(sm[1], sm[2], sm[3].toLowerCase());
      throw new Error('PreflopRanges: не понимаю руку "' + value + '"');
    }
    if (Array.isArray(value) && value.length === 2) return normalizeHand(value[0], value[1]);
    throw new Error('PreflopRanges: не понимаю руку ' + JSON.stringify(value));
  }

  function uniqueKeys(keys) {
    const out = [];
    for (const k of keys) if (out.indexOf(k) < 0) out.push(k);
    return out;
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

  // ЧАРТЫ (169-нотация). Все проценты считаются кодом -> RANGE_PERCENT
  // Позиции: UTG, MP, CO, BTN, SB, BB.
  // '22+' = все пары, 'A2s+' = A2s..AKs, 'K9o+' = K9o..KQo.

  // 3.1 Открытие (RFI), когда все до нас спасовали.
  //     Ориентиры: UTG ~15%, MP ~19%, CO ~27%, BTN ~45%, SB ~50%.
  const OPEN_RANGES = {
    UTG: '66+ ATs+ KTs+ QTs+ JTs T9s 98s 87s 76s 65s ATo+ KJo+ QJo',
    MP: '55+ A2s+ KTs+ QTs+ JTs T9s 98s 87s 76s 65s 54s A9o+ KJo+ QJo',
    CO: '22+ A2s+ K9s+ Q9s+ J9s+ T8s+ 97s+ 86s+ 75s+ 64s+ 53s+ 43s A9o+ KTo+ QTo+ JTo',
    BTN: '22+ A2s+ K5s+ Q5s+ J6s+ T6s+ 96s+ 85s+ 74s+ 63s+ 52s+ 42s ' +
         'A2o+ K8o+ Q8o+ J9o+ T9o 98o',
    SB: '22+ A2s+ K5s+ Q5s+ J6s+ T6s+ 96s+ 85s+ 74s+ 63s+ 52s+ 42s ' +
        'A2o+ K5o+ Q8o+ J9o+ T9o 98o 87o 76o 65o',
    // BB в ситуации 'unopened' на практике не бывает (SB ходит раньше),
    // но диапазон задан, чтобы API не возвращал мусор на кривом вводе.
    BB: '22+ A2s+ K2s+ Q4s+ J5s+ T6s+ 96s+ 85s+ 75s+ 64s+ 53s+ 43s ' +
        'A2o+ K8o+ Q9o+ J9o+ T9o 98o 87o'
  };

  // 3.2 3-бет против открытия. Ключ — ПОЗИЦИЯ РЕЙЗЕРА (а не наша):
  //     чем раньше открылся соперник, тем тайтовее наш 3-бет.
  //     Ориентиры: vs UTG ~6-7%, vs BTN ~11-12%.
  const THREE_BET_VS = {
    UTG: 'QQ+ AKs AKo AQs AQo JJ A5s A4s KQs A3s A2s AJo',
    MP: 'QQ+ AKs AKo AQs AQo JJ TT A5s A4s A3s A2s KQs AJo KQo',
    CO: '99+ ATs+ AJo+ KQs KQo A2s-A5s KJs QJs JTs',
    BTN: '88+ ATs+ A9s AJo+ A2s-A5s KQs KQo KJs KTs QJs QTs JTs',
    SB: '77+ A9s+ ATo+ A2s-A5s KQs KQo KJs KTs QJs QTs JTs 76s 65s'
  };

  // 3.3 Колл (флэт) открытия. Ключ — ПОЗИЦИЯ РЕЙЗЕРА; используется для
  //     наших позиций CO/BTN/MP. SB не флэтит вообще: 3-бет или фолд.
  const FLAT_CALL_VS = {
    UTG: '22-99 AQs AJs ATs KQs KJs QJs JTs T9s 98s 87s 76s 65s AQo',
    MP: '22-99 ATs+ KTs+ QTs+ JTs T9s 98s 87s 76s 65s AQo AJo KQo',
    CO: '22-JJ A2s-AJs K9s+ Q9s+ J9s+ T8s+ 97s+ 86s+ 75s+ 64s+ AJo+ KQo KJo QJo',
    BTN: '22-TT A2s-ATs K8s+ Q9s+ J9s+ T8s+ 97s+ 86s+ 75s+ 65s A9o+ KJo+ QJo JTo',
    SB: '' // стил SB: без коллов
  };

  // 3.4 BB против открытия: там уже вложен 1 ББ, цена колла лучше,
  //     поэтому диапазон защиты заметно шире, чем у остальных позиций.
  //     Ориентир: колл vs BTN ~35%, vs UTG ~13%.
  const BB_CALL_VS = {
    UTG: '22-99 A2s-A9s KTs+ QTs+ JTs T9s 98s 87s 76s 65s AJo+ KQo',
    MP: '22-99 A2s-ATs KTs+ Q9s+ J9s+ T8s+ 97s+ 86s+ 75s+ 65s ATo+ KJo+ QJo',
    CO: '22-99 A2s-AJs K7s+ Q8s+ J8s+ T7s+ 96s+ 85s+ 75s+ 64s+ 53s 43s ' +
        'A2o-AJo KTo+ QTo+ JTo',
    BTN: '22-99 A2s-A9s K5s+ Q6s+ J7s+ T7s+ 96s+ 86s+ 75s+ 64s+ 53s+ 43s ' +
         'A2o-A9o K9o+ Q9o+ J9o+ T9o 98o',
    SB: '22-99 A2s-A9s K5s+ Q6s+ J7s+ T7s+ 96s+ 86s+ 75s+ 64s+ 53s+ 43s ' +
        'A2o-A9o K9o+ Q9o+ J9o+ T9o 98o'
  };

  // 3.5 Мы открыли, нас 3-бетят. fourBet — 4-бет (в т.ч. блефовые
  //     одномастные тузы), call — защита коллом. Чем позже мы открывали,
  //     тем шире защищаемся (мы шире открывались -> у соперника шире 3-бет).
  const VS_3BET = {
    UTG: { fourBet: 'QQ+ AKs AKo A5s', call: '99-JJ AQs AJs ATs KQs AQo' },
    MP: { fourBet: 'QQ+ AKs AKo A5s', call: '99-JJ AQs AJs ATs KQs KJs AQo' },
    CO: { fourBet: 'QQ+ AKs AKo A5s A4s', call: '88-JJ AQs AJs ATs KQs KJs QJs AQo AJo' },
    BTN: {
      fourBet: 'QQ+ AKs AKo A5s A4s A3s',
      call: '66-JJ A9s+ A2s-A5s KTs+ QTs+ JTs T9s ATo+ AJo KQo'
    },
    SB: { fourBet: 'QQ+ AKs AKo A5s', call: '77-JJ AQs AJs ATs KQs AQo' },
    BB: { fourBet: 'QQ+ AKs AKo A5s', call: '77-JJ AQs AJs ATs KQs AQo' }
  };

  // 3.6 Миксы: доля рейза для «пограничных» рук. Решение стабильно
  //     (детерминированный хэш от ключа руки), поэтому подсказка не
  //     «мигает» при повторном вызове на том же споте.
  const MIX_RAISE_FREQUENCY = {
    A5s: 0.6, A4s: 0.6, A3s: 0.5, A2s: 0.5,
    KJs: 0.5, KTs: 0.5, QJs: 0.5, QTs: 0.5, JTs: 0.5,
    '76s': 0.5, '65s': 0.5, AJo: 0.7, KQo: 0.7
  };

  // Служебное: позиции, ситуации, размеры

  // Постфлоп-порядок действий (кто ходит раньше). Последний — в позиции.
  const POSTFLOP_ORDER = ['SB', 'BB', 'UTG', 'MP', 'CO', 'BTN'];

  const POSITION_ALIASES = {
    UTG: 'UTG', 'UTG+1': 'MP', EP: 'UTG', MP1: 'MP', MP2: 'MP', MP: 'MP', HJ: 'MP',
    CO: 'CO', BU: 'BTN', BTN: 'BTN', BUTTON: 'BTN', D: 'BTN',
    SB: 'SB', SMALLBLIND: 'SB', BB: 'BB', BIGBLIND: 'BB'
  };

  const SITUATIONS = ['unopened', 'vs_open', 'vs_3bet', 'in_bb_vs_open'];
  const SITUATION_ALIASES = {
    OPEN: 'unopened', RFI: 'unopened', UNOPENED: 'unopened',
    VS_OPEN: 'vs_open', VSOPEN: 'vs_open', VS_RAISE: 'vs_open',
    VS_3BET: 'vs_3bet', VS3BET: 'vs_3bet',
    IN_BB_VS_OPEN: 'in_bb_vs_open', BB_VS_OPEN: 'in_bb_vs_open'
  };

  function normalizePosition(value) {
    if (value == null) return null;
    const key = String(value).toUpperCase().replace(/[\s_-]+/g, '');
    return POSITION_ALIASES[key] || null;
  }

  function normalizeSituation(value) {
    if (value == null) return 'unopened';
    const key = String(value).toUpperCase().replace(/[\s-]+/g, '_');
    return SITUATION_ALIASES[key] || (SITUATIONS.indexOf(value) >= 0 ? value : 'unopened');
  }

  /** Мы в позиции относительно рейзера? (постфлоп-порядок) */
  function isInPosition(hero, villain) {
    const h = POSTFLOP_ORDER.indexOf(hero);
    const v = POSTFLOP_ORDER.indexOf(villain);
    if (h < 0 || v < 0) return false;
    return h > v;
  }

  function roundToHalf(x) { return Math.round(x * 2) / 2; }

  const OPEN_SIZE_BB = 2.5;          // размер открытия
  const THREE_BET_IP_MULT = 3;       // 3-бет в позиции = 3x открытия
  const THREE_BET_OOP_MULT = 4;      // 3-бет без позиции = 4x открытия
  const FOUR_BET_MULT = 2.2;         // 4-бет ~2.2x 3-бета

  /**
   * Итоговый размер рейза в ББ. Никогда не превышает эффективный стек
   * (если расчётный размер больше — это просто олл-ин на весь стек).
   */
  function finalizeSizing(sizing, effectiveStackBB) {
    if (!(sizing > 0)) return null;
    let s = roundToHalf(sizing);
    if (s > effectiveStackBB) s = effectiveStackBB; // остаток стека = олл-ин
    return s > 0 ? s : null;
  }

  // стек < 15бб: пуш/фолд по эквити против одной случайной руки.
  // порог от глубины и числа игроков сзади, против ставки ещё от цены колла.
  // симулятор только здесь, кэш по ключу руки.

  const SHORT_STACK_BB = 15;
  const SHORT_STACK_ITERS = 4000;
  const SHORT_STACK_BASE = [
    { maxBB: 5, equity: 52 },
    { maxBB: 8, equity: 55 },
    { maxBB: 10, equity: 58 },
    { maxBB: 12, equity: 62 },
    { maxBB: Infinity, equity: 65 }
  ];
  const EQUITY_CACHE = new Map();
  let injectedSimulator = null;   // через PreflopRanges.setSimulator(...)
  let defaultSimulator = null;    // ленивый MonteCarloSimulator с фиксированным seed

  function setSimulator(simulator) {
    injectedSimulator = simulator || null;
    EQUITY_CACHE.clear();
    return api;
  }

  function resolveSimulator() {
    if (injectedSimulator) return injectedSimulator;
    if (defaultSimulator) return defaultSimulator;
    let MC = root.MonteCarloSimulator;
    if (!MC) {
      const mod = tryRequire('./monte_carlo.js');
      MC = mod && (mod.MonteCarloSimulator || mod);
    }
    if (MC && typeof MC === 'function') {
      try { defaultSimulator = new MC({ seed: 20240607 }); } catch (e) { defaultSimulator = null; }
    }
    return defaultSimulator;
  }

  function basePushEquity(stackBB) {
    for (const row of SHORT_STACK_BASE) if (stackBB <= row.maxBB) return row.equity;
    return SHORT_STACK_BASE[SHORT_STACK_BASE.length - 1].equity;
  }

  /**
   * Порог эквити (в %) против одной случайной руки.
   * opponents — сколько соперников ещё может войти/уже вошло.
   */
  function shortStackThreshold(stackBB, opponents, facingBet, potOddsPct) {
    const base = basePushEquity(stackBB);
    const oppAdj = Math.max(0, opponents - 1) * 3;
    if (!facingBet) return clamp(base + oppAdj, 40, 92);
    // Колл олл-ина: нужно покрыть цену банка + запас на то, что диапазон
    // соперника сильнее случайной руки. Сверху ограничиваем 72%, чтобы
    // премиум-руки (AA ~85%) никогда не превращались в фолд из-за кривой
    // цены на входе.
    return clamp(Math.max(potOddsPct + 8, base - 10 + oppAdj * 0.5), 38, 72);
  }

  /**
   * Грубая оценка эквити против одной случайной руки, если симулятора
   * рядом нет (страховка, а не основной путь). Формула подогнана под
   * известные значения: AA=85%, AKs=67%, AKo=66%, 72o=35%.
   */
  function fallbackEquity(handKey) {
    if (handKey.length === 2) {
      const PAIR_EQ = [50.3, 54.2, 57.3, 60.3, 63.3, 66.1, 69.1, 72.1, 75.0, 77.5, 79.9, 82.4, 85.2];
      return PAIR_EQ[rankIndex(handKey[0])];
    }
    const hi = rankIndex(handKey[0]);
    const lo = rankIndex(handKey[1]);
    const suited = handKey[2] === 's';
    let eq = 0.5 + (hi - 7) * 0.035 + (lo - 4) * 0.012 + (suited ? 0.035 : 0);
    if (hi - lo === 1) eq += 0.01; // коннекторы чуть лучше «дырявых»
    return +clamp(eq * 100, 28, 87).toFixed(1);
  }

  /** Эквити против одной случайной руки (в процентах), с кэшем. */
  function allInEquity(handKey, simulator) {
    if (EQUITY_CACHE.has(handKey)) return EQUITY_CACHE.get(handKey);
    let equity = null;
    const sim = simulator || resolveSimulator();
    if (sim && typeof sim.computeWinRate === 'function') {
      try {
        equity = sim.computeWinRate(cardsForHandKey(handKey), [], 1, SHORT_STACK_ITERS).equity;
      } catch (e) {
        equity = null;
      }
    }
    if (typeof equity !== 'number' || !isFinite(equity)) equity = fallbackEquity(handKey);
    EQUITY_CACHE.set(handKey, equity);
    return equity;
  }

  // Резолвер диапазонов

  function toSet(range) {
    return new Set(parseRange(range));
  }

  const _setCache = new Map();
  function cachedSet(name, range) {
    if (!_setCache.has(name)) _setCache.set(name, toSet(range));
    return _setCache.get(name);
  }

  function defaultRaiserFor(hero, situation) {
    if (situation === 'vs_3bet') return isInPosition(hero, 'BTN') ? 'BTN' : 'CO';
    return 'BTN'; // самый частый случай: против стила с BTN
  }

  /**
   * Множество рук для конкретной ячейки чартов (внутренний вызов,
   * отдаёт закэшированный Set — наружу его отдавать нельзя).
   * position/situation/action, action: 'raise'|'call'|'fold' (для 'fold'
   * возвращается пустое множество), а также синонимы 'open', '3bet', '4bet'.
   */
  function rangeFor(position, situation, action, raiserPosition) {
    let hero = normalizePosition(position) || 'BTN';
    let sit = normalizeSituation(situation);
    let raiser = normalizePosition(raiserPosition);
    if (typeof position === 'object' && position !== null) {
      const o = position;
      hero = normalizePosition(o.position) || hero;
      sit = normalizeSituation(o.situation);
      raiser = normalizePosition(o.raiserPosition) || raiser;
      action = o.action != null ? o.action : action;
    }
    const act = String(action || 'raise').toLowerCase();
    if (sit === 'in_bb_vs_open') hero = 'BB';
    if (!raiser || raiser === hero) raiser = defaultRaiserFor(hero, sit);

    if (sit === 'unopened') {
      if (act === 'raise' || act === 'open') return cachedSet('open:' + hero, OPEN_RANGES[hero]);
      return new Set();
    }

    if (sit === 'vs_open' || sit === 'in_bb_vs_open') {
      if (act === 'raise' || act === '3bet') {
        return cachedSet('3bet:' + raiser, THREE_BET_VS[raiser] || '');
      }
      if (act === 'call') {
        // SB не флэтит открытия вообще — только 3-бет или фолд.
        if (sit === 'vs_open' && hero === 'SB') return new Set();
        return sit === 'in_bb_vs_open'
          ? cachedSet('bbcall:' + raiser, BB_CALL_VS[raiser] || '')
          : cachedSet('flat:' + raiser, FLAT_CALL_VS[raiser] || '');
      }
      return new Set();
    }

    if (sit === 'vs_3bet') {
      const entry = VS_3BET[hero] || VS_3BET.BTN;
      if (act === 'raise' || act === '4bet') return cachedSet('4bet:' + hero, entry.fourBet);
      if (act === 'call') return cachedSet('call3bet:' + hero, entry.call);
      return new Set();
    }

    return new Set();
  }

  /**
   * Публичная версия: отдаёт КОПИЮ множества, чтобы вызывающий код не мог
   * случайно испортить закэшированные чарты.
   * getRange(position, situation, action, raiserPosition?)
   */
  function getRange(position, situation, action, raiserPosition) {
    return new Set(rangeFor(position, situation, action, raiserPosition));
  }

  // Проценты заполненности (для тестов и отладки)

  const RANGE_PERCENT = (function buildPercent() {
    const out = {};
    for (const pos of Object.keys(OPEN_RANGES)) out[pos + ' open'] = rangePercent(OPEN_RANGES[pos]);
    for (const pos of Object.keys(THREE_BET_VS)) out['3bet vs ' + pos] = rangePercent(THREE_BET_VS[pos]);
    for (const pos of Object.keys(BB_CALL_VS)) out['BB call vs ' + pos] = rangePercent(BB_CALL_VS[pos]);
    for (const pos of Object.keys(FLAT_CALL_VS)) out['flat vs ' + pos] = rangePercent(FLAT_CALL_VS[pos]);
    for (const pos of Object.keys(VS_3BET)) {
      out['4bet from ' + pos] = rangePercent(VS_3BET[pos].fourBet);
      out['call vs 3bet from ' + pos] = rangePercent(VS_3BET[pos].call);
    }
    return out;
  })();

  // Основная логика принятия решения

  /** Стабильный хэш строки -> [0,1): миксы не «дрожат» между вызовами. */
  function stableRandom(key) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return (h >>> 0) / 4294967296;
  }

  function makeResult(fields) {
    return {
      action: fields.action,
      sizingBB: fields.sizingBB != null ? fields.sizingBB : null,
      handKey: fields.handKey,
      inRange: !!fields.inRange,
      rangeName: fields.rangeName,
      frequency: fields.frequency != null ? fields.frequency : 1,
      reason: fields.reason,
      source: 'ranges',
      equity: fields.equity != null ? fields.equity : null
    };
  }

  function getAction(input) {
    if (!input || typeof input !== 'object') {
      throw new Error('PreflopRanges.getAction: нужен объект с параметрами');
    }
    const hole = input.holeCards;
    if (!Array.isArray(hole) || hole.length !== 2) {
      throw new Error('PreflopRanges.getAction: holeCards должен содержать ровно 2 карты');
    }

    const handKey = normalizeHand(hole[0], hole[1]);
    const position = normalizePosition(input.position);
    let situation = normalizeSituation(input.situation);
    let raiserPosition = normalizePosition(input.raiserPosition);

    const numPlayers = clamp(Math.round(num(input.numPlayers, 6)), 2, 9);
    const rawStack = num(input.effectiveStackBB, 100);
    const effectiveStackBB = rawStack > 0 ? rawStack : 100;
    const betToCallBB = Math.max(0, num(input.betToCallBB, 0));
    const potBB = Math.max(0, num(input.potBB, 1.5));

    if (!position) throw new Error('PreflopRanges.getAction: не понимаю позицию "' + input.position + '"');
    if (situation === 'in_bb_vs_open' || (situation === 'vs_open' && position === 'BB')) {
      situation = 'in_bb_vs_open';
    }
    if (!raiserPosition || (raiserPosition === position && situation !== 'vs_3bet')) {
      raiserPosition = defaultRaiserFor(situation === 'in_bb_vs_open' ? 'BB' : position, situation);
    }
    if (situation === 'in_bb_vs_open') {
      if (raiserPosition === 'BB') raiserPosition = 'BTN';
    }

    const opponents = Math.max(1, Math.min(5, numPlayers - 1));
    const ctx = {
      handKey, position, situation, raiserPosition, opponents,
      betToCallBB, potBB, effectiveStackBB,
      simulator: input.simulator || (input.options && input.options.simulator) || null
    };

    let result = (effectiveStackBB < SHORT_STACK_BB)
      ? decideShortStack(ctx)
      : decideFullStack(ctx);

    // Жёсткая защита контракта: CALL невозможен, если доставлять нечего.
    if (result.action === 'CALL' && betToCallBB === 0) {
      const fixed = (position === 'BB') ? 'CHECK' : 'FOLD';
      result = makeResult(Object.assign({}, result, {
        action: fixed,
        sizingBB: null,
        inRange: false,
        rangeName: result.rangeName + ' (нечего доставлять)',
        reason: 'Доставлять нечего — колла быть не может, играем ' + fixed + '.'
      }));
    }
    return result;
  }

  /** Полный стек (>= 15 ББ): решаем по чартам. */
  function decideFullStack(ctx) {
    const { handKey, position, situation, raiserPosition } = ctx;

    if (situation === 'unopened') {
      const range = cachedSet('open:' + position, OPEN_RANGES[position]);
      const rangeName = position + ' open';
      if (range.has(handKey)) {
        return raise(ctx, OPEN_SIZE_BB, rangeName, 'Открываем рейзом ' + OPEN_SIZE_BB + ' ББ: рука в диапазоне открытия ' + position + '.');
      }
      return noBetBranch(ctx, rangeName, 'Рука не входит в диапазон открытия ' + position + '.');
    }

    if (situation === 'in_bb_vs_open') {
      const threeBet = cachedSet('3bet:' + raiserPosition, THREE_BET_VS[raiserPosition] || '');
      const callRange = cachedSet('bbcall:' + raiserPosition, BB_CALL_VS[raiserPosition] || '');
      const rangeName3 = 'BB vs ' + raiserPosition + ' 3bet';
      const rangeNameC = 'BB vs ' + raiserPosition + ' call';
      if (threeBet.has(handKey)) return raise3BetOr4Bet(ctx, rangeName3, true);
      if (callRange.has(handKey)) {
        return call(ctx, rangeNameC,
          'Защищаем BB коллом: 1 ББ уже вложен, цена колла лучше, рука в диапазоне защиты против ' + raiserPosition + '.');
      }
      return fold(ctx, 'BB vs ' + raiserPosition,
        'Рука вне диапазона защиты BB против ' + raiserPosition + '.');
    }

    if (situation === 'vs_open') {
      const threeBet = cachedSet('3bet:' + raiserPosition, THREE_BET_VS[raiserPosition] || '');
      const flat = cachedSet('flat:' + raiserPosition, FLAT_CALL_VS[raiserPosition] || '');
      const rangeName3 = position + ' 3bet vs ' + raiserPosition;
      if (threeBet.has(handKey)) return raise3BetOr4Bet(ctx, rangeName3, true);
      if (position !== 'SB' && flat.has(handKey)) {
        return call(ctx, position + ' call vs ' + raiserPosition,
          'Колл открытия: рука в диапазоне флэта ' + position + ' против ' + raiserPosition + '.');
      }
      if (position === 'SB') {
        return fold(ctx, 'SB vs ' + raiserPosition,
          'SB не флэтит открытия: только 3-бет или фолд.');
      }
      return fold(ctx, position + ' vs ' + raiserPosition,
        'Рука вне диапазонов 3-бета и колла против ' + raiserPosition + '.');
    }

    if (situation === 'vs_3bet') {
      const entry = VS_3BET[position] || VS_3BET.BTN;
      const fourBet = cachedSet('4bet:' + position, entry.fourBet);
      const callRange = cachedSet('call3bet:' + position, entry.call);
      if (fourBet.has(handKey)) {
        return raise3BetOr4Bet(ctx, position + ' 4bet vs ' + raiserPosition, false);
      }
      if (callRange.has(handKey)) {
        return call(ctx, position + ' call vs 3bet',
          'Защищаемся коллом против 3-бета: рука слишком сильна для фолда, но слабовата для 4-бета.');
      }
      return fold(ctx, position + ' vs 3bet',
        'Рука вне диапазона защиты против 3-бета от ' + raiserPosition + '.');
    }

    return fold(ctx, 'неизвестная ситуация', 'Неизвестная ситуация — безопасный фолд.');
  }

  /** Короткий стек (< 15 ББ): пуш/фолд по эквити. */
  function decideShortStack(ctx) {
    const { handKey, betToCallBB, potBB, effectiveStackBB, opponents } = ctx;
    const equity = allInEquity(handKey, ctx.simulator);
    const facingBet = betToCallBB > 0;
    const potOddsPct = facingBet ? (betToCallBB / (potBB + betToCallBB)) * 100 : 0;
    const threshold = shortStackThreshold(effectiveStackBB, opponents, facingBet, potOddsPct);
    const rangeName = 'короткий стек ' + effectiveStackBB + ' ББ: пуш/фолд';
    const reasonBase = 'Эквити ' + equity + '% против случайной руки, порог ' + threshold.toFixed(1) + '%';

    if (equity >= threshold) {
      return makeResult({
        action: 'RAISE',
        sizingBB: effectiveStackBB, // пуш на весь стек
        handKey,
        inRange: true,
        rangeName,
        frequency: 1,
        equity,
        reason: reasonBase + ' — рука достаточно сильна для олл-ина на коротком стеке.'
      });
    }
    return noBetBranch(
      ctx,
      rangeName,
      reasonBase + ' — рука слабее порога, играем фолд/чек.',
      equity
    );
  }

  function noBetBranch(ctx, rangeName, reason, equity) {
    if (ctx.betToCallBB === 0) {
      if (ctx.position === 'BB') {
        return makeResult({
          action: 'CHECK', sizingBB: null, handKey: ctx.handKey, inRange: false,
          rangeName, frequency: 1, equity,
          reason: 'Доставлять нечего (мы в BB) — чек; рука вне агрессивного диапазона.'
        });
      }
      return makeResult({
        action: 'FOLD', sizingBB: null, handKey: ctx.handKey, inRange: false,
        rangeName, frequency: 1, equity,
        reason: reason + ' Доставлять нечего, но фолд лучше пассивного входа.'
      });
    }
    return makeResult({
      action: 'FOLD', sizingBB: null, handKey: ctx.handKey, inRange: false,
      rangeName, frequency: 1, equity,
      reason
    });
  }

  /**
   * Рейз по чарту. Для 3-бетов/4-бетов учитываем миксы: часть
   * «пограничных» рук рейзится не всегда, остаток уходит в колл/фолд.
   */
  function raise3BetOr4Bet(ctx, rangeName, allowThreeBetSize) {
    const mixFreq = MIX_RAISE_FREQUENCY[ctx.handKey];
    if (mixFreq != null && stableRandom(ctx.handKey + '|' + rangeName) >= mixFreq) {
      const fallback = allowThreeBetSize ? findCallFallback(ctx) : findCallVs3Bet(ctx);
      if (fallback) {
        return makeResult(Object.assign({}, fallback, {
          frequency: 1 - mixFreq,
          reason: fallback.reason + ' Микс: ' + Math.round(mixFreq * 100) + '% рейза, остальное — колл.'
        }));
      }
      return makeResult({
        action: ctx.betToCallBB === 0 ? (ctx.position === 'BB' ? 'CHECK' : 'FOLD') : 'FOLD',
        sizingBB: null, handKey: ctx.handKey, inRange: false, rangeName,
        frequency: 1 - mixFreq,
        reason: 'Микс: ' + Math.round(mixFreq * 100) + '% рейза, остальное — фолд.'
      });
    }
    const rawSizing = allowThreeBetSize
      ? threeBetSize(ctx.position, ctx.raiserPosition)
      : fourBetSize(ctx.position, ctx.raiserPosition);
    const sizing = finalizeSizing(rawSizing, ctx.effectiveStackBB);
    return makeResult({
      action: 'RAISE',
      sizingBB: sizing,
      handKey: ctx.handKey,
      inRange: true,
      rangeName,
      frequency: mixFreq != null ? mixFreq : 1,
      reason: (allowThreeBetSize ? '3-бет ' : '4-бет ') + sizing + ' ББ: рука в диапазоне ' +
        (allowThreeBetSize ? '3-бета' : '4-бета') + ' (' + rangeName + ')' +
        (sizing < rawSizing ? ' — расчётный размер ' + rawSizing + ' ББ превышает стек, играем олл-ин.' : '.')
    });
  }

  function findCallFallback(ctx) {
    const src = ctx.situation === 'in_bb_vs_open' ? BB_CALL_VS : FLAT_CALL_VS;
    if (ctx.position === 'SB' && ctx.situation !== 'in_bb_vs_open') return null;
    const range = cachedSet(src === BB_CALL_VS ? 'bbcall:' + ctx.raiserPosition : 'flat:' + ctx.raiserPosition,
      src[ctx.raiserPosition] || '');
    if (!range.has(ctx.handKey)) return null;
    return {
      action: 'CALL', sizingBB: null, handKey: ctx.handKey, inRange: true,
      rangeName: (src === BB_CALL_VS ? 'BB' : ctx.position) + ' call vs ' + ctx.raiserPosition,
      frequency: 1, equity: null,
      reason: 'Колл: рука в диапазоне защиты против ' + ctx.raiserPosition + '.'
    };
  }

  function findCallVs3Bet(ctx) {
    const entry = VS_3BET[ctx.position] || VS_3BET.BTN;
    const range = cachedSet('call3bet:' + ctx.position, entry.call);
    if (!range.has(ctx.handKey)) return null;
    return {
      action: 'CALL', sizingBB: null, handKey: ctx.handKey, inRange: true,
      rangeName: ctx.position + ' call vs 3bet', frequency: 1, equity: null,
      reason: 'Колл 3-бета: рука в диапазоне защиты.'
    };
  }

  function raise(ctx, sizingBB, rangeName, reason) {
    const sizing = finalizeSizing(sizingBB, ctx.effectiveStackBB);
    return makeResult({
      action: 'RAISE', sizingBB: sizing, handKey: ctx.handKey, inRange: true,
      rangeName, frequency: 1, reason: reason + (ctx.effectiveStackBB <= sizing ? ' (олл-ин на весь стек)' : '')
    });
  }

  function call(ctx, rangeName, reason) {
    if (ctx.betToCallBB === 0) {
      // Контракт: колл без ставки невозможен.
      return makeResult({
        action: ctx.position === 'BB' ? 'CHECK' : 'FOLD',
        sizingBB: null, handKey: ctx.handKey, inRange: false, rangeName,
        frequency: 1,
        reason: 'Доставлять нечего — колл невозможен.'
      });
    }
    return makeResult({
      action: 'CALL', sizingBB: null, handKey: ctx.handKey, inRange: true,
      rangeName, frequency: 1, reason
    });
  }

  function fold(ctx, rangeName, reason) {
    return noBetBranch(ctx, rangeName, reason);
  }

  /** 3-бет = 3x открытия в позиции и 4x без позиции, округление до 0.5 ББ. */
  function threeBetSize(hero, raiser) {
    const mult = isInPosition(hero, raiser) ? THREE_BET_IP_MULT : THREE_BET_OOP_MULT;
    return roundToHalf(OPEN_SIZE_BB * mult);
  }

  /** 4-бет ~2.2x от предполагаемого 3-бета (3x открытия = 7.5 ББ). */
  function fourBetSize(hero, raiser) {
    const assumedThreeBet = OPEN_SIZE_BB * (isInPosition(hero, raiser) ? THREE_BET_IP_MULT : THREE_BET_OOP_MULT);
    return roundToHalf(assumedThreeBet * FOUR_BET_MULT);
  }

  // Публичный API

  const api = {
    getAction,
    normalizeHand,
    normalizeHandKey,
    parseRange,
    getRange,
    comboCount,
    rangePercent,
    allHandKeys,
    setSimulator,
    RANGE_PERCENT,
    // справочники (только чтение — не менять на месте)
    OPEN_RANGES,
    THREE_BET_VS,
    FLAT_CALL_VS,
    BB_CALL_VS,
    VS_3BET,
    MIX_RAISE_FREQUENCY,
    POSITIONS: ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'],
    SITUATIONS,
    SHORT_STACK_BB,
    OPEN_SIZE_BB
  };

  root.PreflopRanges = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
