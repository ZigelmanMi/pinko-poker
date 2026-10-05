// Оценщик 5 из 7. Балл — целое, больше значит сильнее.
// Колесо (A2345) — стрит с высокой картой 5.

var HandEval = (function () {
  'use strict';

  const CATEGORY = {
    HIGH_CARD: 0,
    PAIR: 1,
    TWO_PAIR: 2,
    TRIPS: 3,
    STRAIGHT: 4,
    FLUSH: 5,
    FULL_HOUSE: 6,
    QUADS: 7,
    STRAIGHT_FLUSH: 8
  };

  const CATEGORY_NAME = [
    'high_card', 'pair', 'two_pair', 'trips', 'straight',
    'flush', 'full_house', 'quads', 'straight_flush'
  ];

  // Ранги: 2..14 (14 = туз). Бит i в масти-маске соответствует ранку i.
  const RANK_CHARS = '23456789TJQKA';
  const RANK_OF_CHAR = {};
  for (let i = 0; i < RANK_CHARS.length; i++) RANK_OF_CHAR[RANK_CHARS[i]] = i + 2;

  const SUIT_OF_CHAR = {
    s: 0, h: 1, d: 2, c: 3,
    '♠': 0, '♥': 1, '♦': 2, '♣': 3,
    spade: 0, spades: 0, heart: 1, hearts: 1,
    diamond: 2, diamonds: 2, club: 3, clubs: 3
  };

  const SUIT_CHARS = 'shdc';

  // Маска колеса: 5,4,3,2 + туз. Бит 14 отвечает за туз.
  const WHEEL_MASK = (1 << 5) | (1 << 4) | (1 << 3) | (1 << 2) | (1 << 14);

  const MAX_RANKS = 5; // максимум карт в тайбрейкере

  // Упаковка ранков по основанию 15. Значения рангов 2..14 — гарантированно
  // не переполняют «цифру» основания, поэтому целое сравнивается покомпонентно
  // от старшего ранга к младшему, то есть ровно как надо для кикеров.
  const POW15 = new Array(MAX_RANKS + 1);
  POW15[0] = 1;
  for (let i = 1; i <= MAX_RANKS; i++) POW15[i] = POW15[i - 1] * 15;

  // Категория обязана быть старшим разрядом балла, иначе кикеры перебьют
  // саму комбинацию (пара с хорошими кикерами «побеждала» бы сет).
  // 15^MAX_RANKS — самая большая возможная упаковка кикеров плюс запас.
  const CATEGORY_SCALE = POW15[MAX_RANKS];

  /**
   * Упаковать ранки (в порядке убывания значимости) в одно целое.
   * @param {number[]} ranks
   * @param {number} n сколько первых элементов учитывать
   * @returns {number}
   */
  function fit(ranks, n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 15 + ranks[i];
    return v;
  }

  /**
   * Разобрать карту в {rank, suit}, где rank — символ ('2'..'9','T','J','Q','K','A'),
   * а suit — один из 's','h','d','c'. Такой формат совпадает с тем, что отдают
   * парсер DOM и Python-зрение, поэтому карты можно передавать между модулями
   * без конвертации.
   * Принимает 'Ah', '10s', {rank:'A', suit:'h'}, 'A♥', 51 (код карты).
   */
  function parseCard(card) {
    if (card == null) return null;
    if (typeof card === 'object') {
      const rank = parseRank(card.rank != null ? card.rank : card.r);
      const suit = parseSuit(card.suit != null ? card.suit : card.s);
      if (rank && suit != null) return { rank: rankChar(rank), suit: SUIT_CHARS[suit] };
      if (typeof card.code === 'number') return fromCode(card.code);
      return null;
    }
    if (typeof card === 'number') return fromCode(card);
    const s = String(card).trim();
    if (!s) return null;
    const m = s.match(/^(10|[2-9TJQKA])([shdcSHDC♠♥♦♣])$/);
    if (!m) return null;
    const rank = parseRank(m[1]);
    const suit = parseSuit(m[2]);
    if (!rank || suit == null) return null;
    return { rank: rankChar(rank), suit: SUIT_CHARS[suit] };
  }

  function parseRank(r) {
    if (r == null) return 0;
    if (typeof r === 'number') {
      if (r === 10) return 10;
      if (r >= 2 && r <= 14) return r;
      if (r === 1) return 14; // туз как 1
      return 0;
    }
    const t = String(r).trim().toUpperCase();
    if (t === '10') return 10;
    return RANK_OF_CHAR[t] || 0;
  }

  function parseSuit(s) {
    if (s == null) return null;
    if (typeof s === 'number') return s >= 0 && s <= 3 ? s : null;
    const t = String(s).trim().toLowerCase();
    if (/^[0-3]$/.test(t)) return Number(t);
    const v = SUIT_OF_CHAR[t];
    return v === undefined ? null : v;
  }

  /** Код карты 0..51 -> {rank, suit}. Порядок мастей: s,h,d,c. */
  function fromCode(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0 || n > 51) return null;
    return { rank: RANK_CHARS[Math.floor(n / 4)], suit: SUIT_CHARS[n % 4] };
  }

  /**
   * Разобрать список карт (строку с разделителями, массив или одиночную карту)
   * в массив {rank, suit}.
   */
  function parseCards(input) {
    if (input == null) return [];
    if (typeof input === 'string') {
      const tokens = input.trim().split(/[\s,;|]+/).filter(Boolean);
      const out = [];
      for (let i = 0; i < tokens.length; i++) {
        const c = parseCard(tokens[i]);
        if (c) out.push(c);
        else if (tokens[i].length > 0) {
          // Склеенные карты без разделителей: "AhKd" -> Ah, Kd.
          const glued = tokens[i].match(/(?:10|[2-9TJQKA])[shdcSHDC]/g);
          if (glued) {
            for (let j = 0; j < glued.length; j++) {
              const g = parseCard(glued[j]);
              if (g) out.push(g);
            }
          }
        }
      }
      return out;
    }
    if (!Array.isArray(input)) {
      const single = parseCard(input);
      return single ? [single] : [];
    }
    const out = [];
    for (let i = 0; i < input.length; i++) {
      const c = parseCard(input[i]);
      if (c) out.push(c);
    }
    return out;
  }

  function rankChar(rank) {
    if (rank === 10) return 'T';
    return RANK_CHARS[rank - 2] || '?';
  }

  function cardToString(card) {
    const c = parseCard(card);
    if (!c) return '??';
    return rankChar(c.rank) + SUIT_CHARS[c.suit];
  }

  // Переиспользуемые буферы: горячий путь не должен аллоцировать.
  const rankCount = new Int32Array(15);
  const suitCount = new Int32Array(4);
  const suitMask = new Int32Array(4);
  const rankMaskByCount = [0, 0, 0, 0, 0]; // индекс = сколько раз встречается ранг
  const scratch = new Int32Array(7);

  /**
   * Старшая карта стрита в маске ранков (или 0, если стрита нет).
   * Маска: бит r установлен, если ранг r присутствует.
   */
  function straightHighOf(mask) {
    // Обычные стриты: ищем 5 подряд идущих битов, от старшего к младшему.
    for (let high = 14; high >= 6; high--) {
      const need = (1 << high) | (1 << (high - 1)) | (1 << (high - 2)) | (1 << (high - 3)) | (1 << (high - 4));
      if ((mask & need) === need) return high;
    }
    // Колесо A-2-3-4-5: высшая карта 5.
    if ((mask & WHEEL_MASK) === WHEEL_MASK) return 5;
    return 0;
  }

  /**
   * Оценить 5-7 карт.
   * @param {Array} cards карты в любом поддерживаемом формате
   * @param {object} [out] необязательный объект-приёмник результата
   * @returns {{value:number, category:number, categoryName:string, score:number, cards:Array}}
   */
  function evaluate(cards, out) {
    rankCount.fill(0);
    suitCount.fill(0);
    suitMask[0] = suitMask[1] = suitMask[2] = suitMask[3] = 0;
    rankMaskByCount[0] = rankMaskByCount[1] = rankMaskByCount[2] = 0;
    rankMaskByCount[3] = rankMaskByCount[4] = 0;

    // Разбираем вход один раз: поддерживаются строка, массив строк/объектов/кодов.
    const source = typeof cards === 'string' || !Array.isArray(cards) ? parseCards(cards) : cards;
    let n = 0;
    const list = [];
    for (let i = 0; i < source.length; i++) {
      const c = parseCard(source[i]);
      if (!c) continue;
      const rank = parseRank(c.rank);
      const suit = parseSuit(c.suit);
      if (!rank || suit == null) continue;
      list.push({ rank: rankChar(rank), suit: SUIT_CHARS[suit] });
      rankCount[rank]++;
      suitCount[suit]++;
      suitMask[suit] |= (1 << rank);
      n++;
    }

    const res = out || {};
    res.cards = list;
    if (n < 5) {
      res.value = -1;
      res.category = -1;
      res.categoryName = 'invalid';
      res.score = -1;
      return res;
    }

    // Гистограмма ранков по кратности.
    let rankMaskAll = 0;
    for (let r = 2; r <= 14; r++) {
      const c = rankCount[r];
      if (!c) continue;
      rankMaskAll |= (1 << r);
      rankMaskByCount[c] |= (1 << r);
    }

    const quadsMask = rankMaskByCount[4];
    const tripsMask = rankMaskByCount[3];
    const pairsMask = rankMaskByCount[2];

    // Флаш: ровно одна масть с 5+ картами.
    let flushSuit = -1;
    for (let s = 0; s < 4; s++) {
      if (suitCount[s] >= 5) { flushSuit = s; break; }
    }

    // Стрит-флеш.
    if (flushSuit >= 0) {
      const high = straightHighOf(suitMask[flushSuit]);
      if (high) {
        res.value = CATEGORY.STRAIGHT_FLUSH * CATEGORY_SCALE + fit([high], 1);
        res.category = CATEGORY.STRAIGHT_FLUSH;
        res.categoryName = high === 14 ? 'royal_flush' : 'straight_flush';
        res.score = res.value;
        return res;
      }
    }

    // Каре: ранг каре + старший кикер.
    if (quadsMask) {
      const quad = highestBit(quadsMask);
      const kicker = highestRankExcept(rankCount, quad);
      const v = CATEGORY.QUADS * CATEGORY_SCALE + fit([quad, kicker], 2);
      res.value = v;
      res.category = CATEGORY.QUADS;
      res.categoryName = CATEGORY_NAME[CATEGORY.QUADS];
      res.score = v;
      return res;
    }

    // Фулл-хаус: старший сет + старшая пара. Пару может дать и второй сет
    // (на 7 картах возможны две тройки, например 777 999 A K).
    if (tripsMask) {
      const tripHigh = highestBit(tripsMask);
      const pairHigh = highestRankWithMinCount(rankCount, 2, tripHigh);
      if (pairHigh) {
        res.value = CATEGORY.FULL_HOUSE * CATEGORY_SCALE + fit([tripHigh, pairHigh], 2);
        res.category = CATEGORY.FULL_HOUSE;
        res.categoryName = CATEGORY_NAME[CATEGORY.FULL_HOUSE];
        res.score = res.value;
        return res;
      }
    }

    // Флаш: 5 старших карт масти.
    if (flushSuit >= 0) {
      const mask = suitMask[flushSuit];
      const cnt = topRanks(mask, 5, scratch);
      res.value = CATEGORY.FLUSH * CATEGORY_SCALE + fit(scratch, cnt);
      res.category = CATEGORY.FLUSH;
      res.categoryName = CATEGORY_NAME[CATEGORY.FLUSH];
      res.score = res.value;
      return res;
    }

    // Стрит.
    const sHigh = straightHighOf(rankMaskAll);
    if (sHigh) {
      res.value = CATEGORY.STRAIGHT * CATEGORY_SCALE + fit([sHigh], 1);
      res.category = CATEGORY.STRAIGHT;
      res.categoryName = CATEGORY_NAME[CATEGORY.STRAIGHT];
      res.score = res.value;
      return res;
    }

    // Сет: ранг сета + два кикера.
    if (tripsMask) {
      const trip = highestBit(tripsMask);
      const cnt = topRanksExcept(rankCount, trip, 2, scratch);
      res.value = CATEGORY.TRIPS * CATEGORY_SCALE + fit([trip], 1) * POW15[2] + fit(scratch, cnt);
      res.category = CATEGORY.TRIPS;
      res.categoryName = CATEGORY_NAME[CATEGORY.TRIPS];
      res.score = res.value;
      return res;
    }

    // Две пары: две старшие пары + кикер. Пары ищутся по количеству карт,
    // поэтому сет тоже может выступить «парой» (777 99 A K).
    {
      const p1 = highestRankWithMinCount(rankCount, 2, 0);
      const p2 = p1 ? highestRankWithMinCount(rankCount, 2, p1) : 0;
      if (p1 && p2) {
        const kicker = highestRankExcept(rankCount, p1, p2);
        res.value = CATEGORY.TWO_PAIR * CATEGORY_SCALE + fit([p1, p2], 2) * POW15[1] + fit([kicker], 1);
        res.category = CATEGORY.TWO_PAIR;
        res.categoryName = CATEGORY_NAME[CATEGORY.TWO_PAIR];
        res.score = res.value;
        return res;
      }
    }

    // Одна пара: ранг пары + три кикера.
    {
      const pair = highestRankWithMinCount(rankCount, 2, 0);
      if (pair) {
        const cnt = topRanksExcept(rankCount, pair, 3, scratch);
      res.value = CATEGORY.PAIR * CATEGORY_SCALE + fit([pair], 1) * POW15[3] + fit(scratch, cnt);
      res.category = CATEGORY.PAIR;
      res.categoryName = CATEGORY_NAME[CATEGORY.PAIR];
      res.score = res.value;
      return res;
      }
    }

    // Старшая карта: 5 старших ранков.
    {
      const cnt = topRanks(rankMaskAll, 5, scratch);
      res.value = CATEGORY.HIGH_CARD * CATEGORY_SCALE + fit(scratch, cnt);
      res.category = CATEGORY.HIGH_CARD;
      res.categoryName = CATEGORY_NAME[CATEGORY.HIGH_CARD];
      res.score = res.value;
      return res;
    }
  }

  /** Оценка 5-7 карт, возвращает только целочисленный балл (для сравнения). */
  function evaluateScore(cards) {
    return evaluate(cards).value;
  }

  /** Оценка хенда: 2 карты + борд. */
  function evaluateHand(holeCards, boardCards) {
    const all = parseCards(holeCards);
    const board = parseCards(boardCards);
    for (let i = 0; i < board.length; i++) all.push(board[i]);
    return evaluate(all);
  }

  function highestBit(mask) {
    for (let r = 14; r >= 2; r--) if (mask & (1 << r)) return r;
    return 0;
  }

  function countBits(mask) {
    let n = 0;
    while (mask) { mask &= mask - 1; n++; }
    return n;
  }

  /** Старший ранг, встречающийся не менее minCount раз, кроме исключённого. */
  function highestRankWithMinCount(rankCnt, minCount, except) {
    for (let r = 14; r >= 2; r--) {
      if (r === except) continue;
      if (rankCnt[r] >= minCount) return r;
    }
    return 0;
  }

  /** Старший ранг, не входящий в исключённые. */
  function highestRankExcept(rankCnt, ex1, ex2) {
    for (let r = 14; r >= 2; r--) {
      if (r === ex1 || r === ex2) continue;
      if (rankCnt[r]) return r;
    }
    return 0;
  }

  /** n старших ранков из маски, по убыванию. Возвращает количество. */
  function topRanks(mask, n, dst) {
    let cnt = 0;
    for (let r = 14; r >= 2 && cnt < n; r--) {
      if (mask & (1 << r)) dst[cnt++] = r;
    }
    return cnt;
  }

  /** n старших ранков, кроме исключённого ранка. */
  function topRanksExcept(rankCnt, ex, n, dst) {
    let cnt = 0;
    for (let r = 14; r >= 2 && cnt < n; r--) {
      if (r === ex) continue;
      if (rankCnt[r] > 0) dst[cnt++] = r;
    }
    return cnt;
  }

  /** Есть ли среди карт дубликат (для валидации ввода). */
  function hasDuplicates(cards) {
    const seen = {};
    for (let i = 0; i < cards.length; i++) {
      const c = parseCard(cards[i]);
      if (!c) continue;
      const k = c.rank + '_' + c.suit;
      if (seen[k]) return true;
      seen[k] = true;
    }
    return false;
  }

  const api = {
    CATEGORY: CATEGORY,
    CATEGORY_NAME: CATEGORY_NAME,
    evaluate: evaluate,
    evaluateScore: evaluateScore,
    evaluateHand: evaluateHand,
    parseCard: parseCard,
    parseCards: parseCards,
    parseRank: parseRank,
    parseSuit: parseSuit,
    cardToString: cardToString,
    rankChar: rankChar,
    fromCode: fromCode,
    hasDuplicates: hasDuplicates,
    straightHighOf: straightHighOf,
    RANK_CHARS: RANK_CHARS,
    SUIT_CHARS: SUIT_CHARS
  };

  // Явно выставляем API в глобальную область: monte_carlo.js, preflop_ranges.js
  // и postflop_ranges.js ищут именно self.HandEval. Без этой строки объявления
  // через var/const хватало не всегда (в частности при загрузке в изоляции).
  if (typeof self !== 'undefined') self.HandEval = api;
  if (typeof window !== 'undefined') window.HandEval = api;
  if (typeof globalThis !== 'undefined') globalThis.HandEval = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
