// Эквити Монте-Карло. Считает через hand_eval.js, его надо загрузить раньше.

(function (root) {
  'use strict';

  const HandEval = root.HandEval || (typeof require !== 'undefined' ? require('./hand_eval.js') : null);
  if (!HandEval) throw new Error('monte_carlo.js requires hand_eval.js to be loaded first');

  const SUITS = HandEval.SUIT_CHARS; // 'shdc'
  const RANKS = HandEval.RANK_CHARS; // '23456789TJQKA'
  const DECK_SIZE = 52;

  // Код карты: (позиция ранка 0..12) * 4 + (позиция масти 0..3), то есть 0..51.
  // тот же порядок мастей, что в hand_eval: один индекс на колоду.
  const cardRank = new Int32Array(DECK_SIZE);
  const cardSuit = new Int32Array(DECK_SIZE);
  for (let i = 0; i < DECK_SIZE; i++) {
    cardRank[i] = HandEval.parseRank(RANKS[i >> 2]);
    cardSuit[i] = i & 3;
  }

  /**
   * Уникальный ключ карты для отметки использованных: всегда 0..51.
   * Важно: ранг здесь сдвигается на 2 (двойка = 0), иначе индекс выходит
   * за пределы массива на 52 элемента и карты не исключаются из колоды.
   */
  function cardId(card) {
    const rank = HandEval.parseRank(card.rank);
    const suit = HandEval.parseSuit(card.suit);
    if (!rank || suit == null) return -1;
    return (rank - 2) * 4 + suit;
  }

  /** Код карты из уже разобранного объекта {rank, suit}; -1 при ошибке. */
  function cardCode(card) {
    return cardId(card);
  }

  /** Детерминированный ГПСЧ (mulberry32) — для воспроизводимых прогонов. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function normalizeCards(cards) {
    return HandEval.parseCards(cards);
  }

  class MonteCarloSimulator {
    constructor(opts) {
      opts = opts || {};
      this.seed = typeof opts.seed === 'number' ? opts.seed : null;
      this.random = this.seed == null ? Math.random : mulberry32(this.seed);
      // Рабочие буферы (переиспользуются между итерациями).
      this._deck = new Int32Array(DECK_SIZE);
      this._evalA = {};
      this._evalB = {};
      this._hole = [];
      this._board = [];
      this._boardBuf = [];
      this._oppBuf = [];    }

    createDeck() {
      const deck = [];
      for (let s = 0; s < 4; s++) {
        for (let r = 0; r < 13; r++) deck.push({ rank: RANKS[r], suit: SUITS[s] });
      }
      return deck;
    }

    removeKnownCards(deck, knownCards) {
      const used = new Uint8Array(DECK_SIZE);
      const known = normalizeCards(knownCards);
      for (let i = 0; i < known.length; i++) {
        const id = cardId(known[i]);
        if (id >= 0) used[id] = 1;
      }
      return deck.filter((card) => {
        const c = HandEval.parseCard(card);
        const id = c ? cardId(c) : -1;
        return id >= 0 && !used[id];
      });
    }

    /** Полный шафл (оставлен для совместимости и тестов). */
    shuffle(array) {
      const arr = array.slice();
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    }

    /**
     * Заполнить буфер колоды картами, которых нет среди известных.
     * @returns {number} количество доступных карт
     */
    _buildAvailable(knownList) {
      const used = new Uint8Array(DECK_SIZE);
      for (let i = 0; i < knownList.length; i++) {
        const c = HandEval.parseCard(knownList[i]);
        const id = c ? cardId(c) : -1;
        if (id >= 0) used[id] = 1;
      }
      let n = 0;
      for (let i = 0; i < DECK_SIZE; i++) {
        if (!used[i]) this._deck[n++] = i;
      }
      return n;
    }

    /** Взять случайную карту из доступных: частичный шафл + сокращение пула. */
    _draw(avail) {
      const idx = (this.random() * avail) | 0;
      const pick = this._deck[idx];
      this._deck[idx] = this._deck[avail - 1];
      return { rank: cardRank[pick], suit: cardSuit[pick], avail: avail - 1 };
    }

    /**
     * Эквити против N случайных рук.
     * @param {Array} holeCards 2 карты героя
     * @param {Array} communityCards 0/3/4/5 карт борда
     * @param {number} numOpponents число соперников
     * @param {number} iterations число симуляций
     * @returns {{winRate:string, tieRate:string, loseRate:string, equity:number,
     *            win:number, tie:number, iterations:number}}
     */
    computeWinRate(holeCards, communityCards, numOpponents, iterations) {
      return this._computeWinRateInternal(holeCards, communityCards, {
        opponents: numOpponents,
        iterations: iterations
      });
    }

    /**
     * Общий движок: считает эквити либо против случайных рук, либо против
     * диапазона. Раздача одна и та же (борд общий), меняется только то, откуда
     * берутся карты соперников.
     */
    _computeWinRateInternal(holeCards, communityCards, opts) {
      opts = opts || {};
      const iters = Math.max(1, Math.floor(opts.iterations || 2000));
      const hole = normalizeCards(holeCards);
      const board = normalizeCards(communityCards);
      const oppCount = Math.max(1, Math.min(9, Math.floor(opts.opponents) || 1));

      if (hole.length !== 2) {
        throw new Error('computeWinRate: нужны ровно 2 карманные карты');
      }
      if (board.length !== 0 && board.length !== 3 && board.length !== 4 && board.length !== 5) {
        throw new Error('computeWinRate: борд должен содержать 0, 3, 4 или 5 карт');
      }
      if (HandEval.hasDuplicates(hole.concat(board))) {
        throw new Error('computeWinRate: повторяющиеся карты во входных данных');
      }
      const boardNeed = 5 - board.length;
      if (boardNeed + oppCount * 2 > 52 - hole.length - board.length) {
        throw new Error('computeWinRate: не хватает карт в колоде');
      }

      // Готовим диапазон (если он передан): убираем заблокированные карты и
      // строим таблицу взвешенного выбора.
      let rangeTable = null;
      let combosInRange = 0;
      const baseBlocked = new Uint8Array(52);
      const blocked = new Uint8Array(52);
      for (let i = 0; i < hole.length; i++) baseBlocked[cardCode(hole[i])] = 1;
      for (let i = 0; i < board.length; i++) baseBlocked[cardCode(board[i])] = 1;

      if (opts.range) {
        const entries = [];
        const keys = Object.keys(opts.range);
        for (let i = 0; i < keys.length; i++) {
          const weight = Number(opts.range[keys[i]]);
          if (!(weight > 0)) continue;
          const combos = this.combosForHandKey(keys[i]).filter(
            (c) => !baseBlocked[c[0]] && !baseBlocked[c[1]]
          );
          if (!combos.length) continue;
          combosInRange += combos.length * weight;
          entries.push({ key: keys[i], combos: combos, weight: weight });
        }
        if (!entries.length) {
          throw new Error('computeWinRateVsRange: диапазон пуст или полностью заблокирован бордом');
        }
        const table = this._weightedTable(entries.map((e) => ({ key: e.key, weight: e.weight })));
        // Быстрый поиск комбинаций по ключу.
        const combosByKey = {};
        for (let i = 0; i < entries.length; i++) combosByKey[entries[i].key] = entries[i].combos;
        rangeTable = { cum: table.cum, keys: table.keys, combosByKey: combosByKey };
      }

      let wins = 0;
      let ties = 0;

      for (let it = 0; it < iters; it++) {
        // Метки «карта уже раздана» сбрасываются на каждой итерации.
        blocked.set(baseBlocked);

        const fullBoard = this._boardBuf;
        let avail;
        let villainDrawn = false;

        if (rangeTable) {
          // Соперник получает карты ПЕРВЫМ, борд — из остатка. Иначе карта
          // соперника могла попасть ещё и на борд: раньше борд раздавался из
          // пула, где карты диапазона ещё присутствовали, и одна и та же карта
          // учитывалась дважды (это занижало эквити героя примерно на 3 п.п.).
          avail = this._buildAvailable(hole.concat(board));
          const cards = this._drawFromRange(rangeTable, blocked, avail);
          if (cards) {
            villainDrawn = true;
            this._oppBuf[0] = { rank: cardRank[cards[0]], suit: cardSuit[cards[0]] };
            this._oppBuf[1] = { rank: cardRank[cards[1]], suit: cardSuit[cards[1]] };
            // Пересобираем колоду, исключая и руку героя, и карты соперника.
            avail = this._buildAvailable(hole.concat(board, this._oppBuf));
          }
        } else {
          avail = this._buildAvailable(hole.concat(board));
        }

        // Добираем борд.
        fullBoard.length = 0;
        for (let b = 0; b < board.length; b++) fullBoard.push(board[b]);
        for (let b = 0; b < boardNeed; b++) {
          const d = this._draw(avail);
          avail = d.avail;
          fullBoard.push({ rank: d.rank, suit: d.suit });
        }

        const myScore = HandEval.evaluateHand(hole, fullBoard).value;
        let best = -1;
        let alive = false;

        for (let o = 0; o < oppCount; o++) {
          if (rangeTable) {
            if (o === 0 && villainDrawn) {
              // Первого соперника уже раздали выше.
              alive = true;
            } else {
              const cards = this._drawFromRange(rangeTable, blocked, avail);
              if (!cards) continue; // все комбинации перекрыты — пропускаем
              this._oppBuf[0] = { rank: cardRank[cards[0]], suit: cardSuit[cards[0]] };
              this._oppBuf[1] = { rank: cardRank[cards[1]], suit: cardSuit[cards[1]] };
              alive = true;
            }
          } else {
            const d1 = this._draw(avail); avail = d1.avail;
            const d2 = this._draw(avail); avail = d2.avail;
            this._oppBuf[0] = { rank: d1.rank, suit: d1.suit };
            this._oppBuf[1] = { rank: d2.rank, suit: d2.suit };
            alive = true;
          }
          const s = HandEval.evaluateHand(this._oppBuf, fullBoard).value;
          if (s > best) best = s;
        }

        if (!alive) continue; // раздача не состоялась — не портим статистику
        if (myScore > best) wins++;
        else if (myScore === best) ties++;
      }

      const equity = (wins + ties / 2) / iters * 100;
      const result = {
        winRate: (wins / iters * 100).toFixed(1),
        tieRate: (ties / iters * 100).toFixed(1),
        loseRate: ((iters - wins - ties) / iters * 100).toFixed(1),
        equity: +equity.toFixed(1),
        win: wins,
        tie: ties,
        iterations: iters
      };
      if (rangeTable) {
        result.combosInRange = Math.round(combosInRange);
        result.rangePercent = +(combosInRange / 1326 * 100).toFixed(1);
      }
      return result;
    }

    /**
     * Выбрать комбинацию из диапазона с учётом весов, пропуская те, что
     * пересекаются с уже известными картами (борд, рука героя, ранее
     * разданные карты соперников).
     */
    _drawFromRange(rangeTable, blocked, avail) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const pick = this.random();
        let idx = 0;
        while (idx < rangeTable.cum.length - 1 && pick > rangeTable.cum[idx]) idx++;
        const key = rangeTable.keys[idx];
        const combos = rangeTable.combosByKey[key];
        if (!combos || !combos.length) continue;
        const combo = combos[(this.random() * combos.length) | 0];
        const a = combo[0];
        const b = combo[1];
        if (blocked[a] || blocked[b]) continue;
        if (!this._inAvailable(a, avail) || !this._inAvailable(b, avail)) continue;
        blocked[a] = 1;
        blocked[b] = 1;
        return combo;
      }
      return null;
    }

    /** Есть ли код карты среди доступных (первые avail элементов пула). */
    _inAvailable(code, avail) {
      for (let i = 0; i < avail; i++) {
        if (this._deck[i] === code) return true;
      }
      return false;
    }

    /**
     * Все конкретные комбинации (2 карты) для ключа вида 'AKs', 'AKo', 'TT'.
     * Возвращает массив пар кодов карт 0..51.
     * @param {string} key
     * @returns {number[][]}
     */
    combosForHandKey(key) {
      const k = String(key || '').trim().toUpperCase().replace(/^10/, 'T');
      const m = k.match(/^([2-9TJQKA])([2-9TJQKA])([SO])?$/);
      if (!m) return [];
      const r1 = HandEval.parseRank(m[1]);
      const r2 = HandEval.parseRank(m[2]);
      if (!r1 || !r2) return [];
      const suffix = m[3] || '';
      const out = [];
      if (r1 === r2) {
        // Пара: любые две масти из четырёх.
        const base = (r1 - 2) * 4;
        for (let a = 0; a < 4; a++) {
          for (let b = a + 1; b < 4; b++) out.push([base + a, base + b]);
        }
        return out;
      }
      const base1 = (r1 - 2) * 4;
      const base2 = (r2 - 2) * 4;
      for (let s1 = 0; s1 < 4; s1++) {
        for (let s2 = 0; s2 < 4; s2++) {
          if (suffix === 'S' && s1 !== s2) continue;
          if (suffix === 'O' && s1 === s2) continue;
          out.push([base1 + s1, base2 + s2]);
        }
      }
      return out;
    }

    /**
     * Кумулятивная таблица для взвешенного выбора ключа руки.
     * @param {Array<{key:string,weight:number}>} entries
     * @returns {{cum:Float64Array, total:number, keys:string[]}}
     */
    _weightedTable(entries) {
      const keys = [];
      const cumRaw = [];
      let total = 0;
      for (let i = 0; i < entries.length; i++) {
        const w = Number(entries[i].weight);
        if (!(w > 0)) continue;
        total += w;
        keys.push(entries[i].key);
        cumRaw.push(total);
      }
      const cum = new Float64Array(cumRaw.length);
      for (let i = 0; i < cumRaw.length; i++) cum[i] = cumRaw[i] / total;
      return { cum: cum, total: total, keys: keys };
    }

    // эквити против диапазона. range: { 'AKs': 1, 'QQ': 0.5 } — вес это доля комбо.
    computeWinRateVsRange(holeCards, communityCards, opts) {
      opts = opts || {};
      return this._computeWinRateInternal(holeCards, communityCards, {
        range: opts.range,
        opponents: opts.opponents,
        iterations: opts.iterations
      });
    }

    /**
     * Симуляция против известных карт соперника (для тестов и разборов).
     */
    simulate(holeCards, communityCards, opponentCards, iterations) {
      const iters = Math.max(1, Math.floor(iterations || 1000));
      const hole = normalizeCards(holeCards);
      const board = normalizeCards(communityCards);
      const opp = normalizeCards(opponentCards);
      if (hole.length !== 2 || opp.length !== 2) {
        throw new Error('simulate: нужны по 2 карты героя и соперника');
      }
      const boardNeed = 5 - board.length;
      let wins = 0, ties = 0;

      for (let it = 0; it < iters; it++) {
        let avail = this._buildAvailable(hole.concat(board, opp));
        const fullBoard = this._boardBuf;
        fullBoard.length = 0;
        for (let b = 0; b < board.length; b++) fullBoard.push(board[b]);
        for (let b = 0; b < boardNeed; b++) {
          const d = this._draw(avail);
          avail = d.avail;
          fullBoard.push({ rank: d.rank, suit: d.suit });
        }
        const a = HandEval.evaluateHand(hole, fullBoard).value;
        const bScore = HandEval.evaluateHand(opp, fullBoard).value;
        if (a > bScore) wins++;
        else if (a === bScore) ties++;
      }

      return {
        winRate: (wins / iters * 100).toFixed(1),
        tieRate: (ties / iters * 100).toFixed(1),
        loseRate: ((iters - wins - ties) / iters * 100).toFixed(1),
        equity: +((wins + ties / 2) / iters * 100).toFixed(1),
        win: wins,
        tie: ties,
        iterations: iters
      };
    }
  }

  root.MonteCarloSimulator = MonteCarloSimulator;

  if (typeof module !== 'undefined' && module.exports) module.exports = MonteCarloSimulator;
})(typeof self !== 'undefined' ? self : globalThis);
