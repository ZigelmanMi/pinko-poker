// Service worker: разбор руки и связь со страницей.

// Порядок важен: hand_eval → monte_carlo → ranges, потому что оба модуля
// диапазонов опционально используют симулятор и оценщик.
importScripts(
  'hand_eval.js',
  'monte_carlo.js',
  'preflop_ranges.js',
  'postflop_ranges.js',
  'frame_diff.js'
);

let handCounter = 0;
// Кэш последнего распознавания: снимок + его dhash + результат зрения.
// Если картинка стола не изменилась, повторно ничего не отправляем.
let visionCache = { at: 0, cards: null, dataUrl: null, hash: null, payload: null };
const PY_VISION = 'http://127.0.0.1:8765/read';

/**
 * Посчитать perceptual hash кадра (dhash через frame_diff.js).
 * Возвращает null, если окружение не позволяет (нет OffscreenCanvas и т. п.) —
 * тогда просто отправляем кадр как раньше.
 */
async function computeFrameHash(dataUrl) {
  if (typeof FrameDiff === 'undefined' || !FrameDiff || !FrameDiff.dhashFromRgba) return null;
  try {
    const blob = await fetch(dataUrl).then((r) => r.blob());
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const hash = FrameDiff.dhashFromRgba(img.data, bitmap.width, bitmap.height, { downscale: 320 });
    if (typeof bitmap.close === 'function') bitmap.close();
    return hash;
  } catch (e) {
    console.warn('[PokerAssistant] dhash недоступен:', (e && e.message) || e);
    return null;
  }
}

// Domains hosting the poker game iframe
const IFRAME_URL_PATTERNS = ['pu-web2.e5t.online', '.e5t.online'];

// ===== AUTO-INJECTION (fallback if manifest content_scripts fail) =====

// Hostnames where the poker game appears
const GAME_FRAME_RE = /e5t\.online|pu-web2/i;

function isHttpTab(url) {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch (e) {
    return false;
  }
}

function hostMatches(url) {
  return isHttpTab(url);
}

function isGameFrameUrl(url) {
  return GAME_FRAME_RE.test(url || '');
}

function broadcastToTab(tabId, message) {
  chrome.webNavigation.getAllFrames({ tabId: tabId }).then((frames) => {
    (frames || []).forEach((f) => {
      try {
        chrome.tabs.sendMessage(tabId, message, { frameId: f.frameId }, function () {
          void chrome.runtime.lastError;
        });
      } catch (e) { /* ignore */ }
    });
  }).catch(() => {});
}

function broadcastShot(tabId, dataUrl) {
  broadcastToTab(tabId, { action: 'tableShot', dataUrl: dataUrl });
}

function broadcastCards(tabId, cards) {
  broadcastToTab(tabId, { action: 'shotCards', data: cards });
}

let hudWindowId = null;
let hudDismissed = false;
let lastHud = { state: null, extra: {}, response: null, dead: false };

function findHudWindow() {
  return chrome.windows.getAll({ populate: true, windowTypes: ['popup'] }).then((wins) => {
    for (const w of wins || []) {
      const tab = (w.tabs || [])[0];
      if (tab && tab.url && tab.url.indexOf('hud.html') !== -1) return w.id;
    }
    return null;
  }).catch(() => null);
}

function fanoutHud() {
  // Версию берём из манифеста — единственное место, где она должна меняться.
  let version = '';
  try {
    version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
  } catch (e) { /* ignore */ }
  chrome.runtime.sendMessage({ action: 'hudRender', hud: lastHud, version: version }, function () {
    void chrome.runtime.lastError;
  });
}

function applyHud(partial) {
  if (!partial) return;
  if (partial.state) lastHud.state = partial.state;
  if (partial.extra) lastHud.extra = partial.extra;
  if (partial.response !== undefined) lastHud.response = partial.response;
  if (partial.dead) lastHud.dead = true;
  else if (partial.state) lastHud.dead = false;
  fanoutHud();
}

async function openHudWindow(focus) {
  if (hudDismissed && !focus) return;
  if (focus) hudDismissed = false;
  const existing = hudWindowId || await findHudWindow();
  if (existing) {
    hudWindowId = existing;
    if (focus) {
      try { await chrome.windows.update(existing, { focused: true }); } catch (e) { /* ignore */ }
    }
    fanoutHud();
    return;
  }
  let left = 40;
  let top = 80;
  try {
    const win = await chrome.windows.getLastFocused();
    if (win) {
      left = (win.left || 0) + (win.width || 0) + 12;
      top = (win.top || 0) + 48;
      if (left > 1500) left = Math.max(8, (win.left || 0) - 372);
    }
  } catch (e) { /* ignore */ }
  try {
    const created = await chrome.windows.create({
      url: chrome.runtime.getURL('hud.html'),
      type: 'popup',
      focused: !!focus,
      width: 360,
      height: 580,
      left: left,
      top: top
    });
    hudWindowId = created && created.id;
  } catch (e) {
    console.warn('[PokerAssistant] hud window:', (e && e.message) || e);
  }
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === hudWindowId) {
    hudWindowId = null;
    hudDismissed = true;
  }
});

function pyCardsUseful(cards) {
  if (!cards) return false;
  return (cards.myCards && cards.myCards.length >= 2) ||
    (cards.communityCards && cards.communityCards.length > 0);
}

function readWithPython(dataUrl) {
  return fetch(PY_VISION, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl })
  }).then((res) => {
    if (!res.ok) throw new Error('py vision ' + res.status);
    return res.json();
  }).then((data) => {
    if (data && data.error && !pyCardsUseful(data)) throw new Error(data.error);
    if (data) data.source = 'py';
    return data;
  });
}

// Inject assistant scripts into every frame when a casino page finishes loading.
// Does not depend on manifest content_scripts — works even if they are blocked.
// Retries with delays because game iframes can appear/navigate after page load.
// Set a badge on the toolbar icon to show assistant status for a tab
function setBadge(tabId, text, color) {
  try {
    if (chrome.action && chrome.action.setBadgeText) {
      chrome.action.setBadgeText({ tabId: tabId, text: text });
    }
    if (chrome.action && chrome.action.setBadgeBackgroundColor) {
      chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: color });
    }
  } catch (e) {
    /* ignore badge errors */
  }
}

function scheduleInjection(tabId) {
  const run = () => {
    injectIntoMatchingFrames(tabId).then((n) => {
      if (n) {
        console.log(`[PokerAssistant] Injected into ${n} game frame(s) of tab ${tabId}`);
        setBadge(tabId, 'ON', '#4caf50');
        openHudWindow(false);
      }
    }).catch((err) => {
      console.error(`[PokerAssistant] Injection failed for tab ${tabId}:`, (err && err.message) || err);
      setBadge(tabId, '!', '#f44336');
    });
  };
  run();
  setTimeout(run, 2500);
  setTimeout(run, 7000);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab || !tab.url || !isHttpTab(tab.url)) return;
  scheduleInjection(tabId);
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (isGameFrameUrl(details.url) || (details.frameId === 0 && isHttpTab(details.url))) {
    scheduleInjection(details.tabId);
  }
});

// Manual trigger: clicking the extension icon grants activeTab access to the
// current page — works even if the site access setting blocks host permissions.
// Guarded: chrome.action may be undefined when the manifest has no "action" key.
if (typeof chrome.action !== 'undefined' && chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    console.log(`[PokerAssistant] Extension icon clicked on: ${tab && tab.url}`);
    if (tab && tab.id) {
      scheduleInjection(tab.id);
      openHudWindow(true);
    }
  });
} else {
  console.log('[PokerAssistant] chrome.action unavailable — icon click trigger disabled');
}

// ===== MESSAGING =====

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Content script requests injection into iframes
  if (request.action === 'injectIntoIframes' && sender.tab) {
    console.log('[PokerAssistant] Received inject request from content script');
    injectIntoMatchingFrames(sender.tab.id).then(() => {
      openHudWindow(false);
      sendResponse({ injected: true });
    }).catch((err) => {
      console.error('[PokerAssistant] Frame injection failed:', err);
      sendResponse({ injected: false, error: String((err && err.message) || err) });
    });
    return true; // Keep message channel open for async
  }

  if (request.action === 'captureTable') {
    const tabId = sender.tab && sender.tab.id;
    const windowId = sender.tab ? sender.tab.windowId : undefined;
    const now = Date.now();

    const useCache = (reason) => {
      sendResponse({
        dataUrl: visionCache.dataUrl,
        cached: true,
        cacheReason: reason,
        cards: visionCache.cards || null,
        py: pyCardsUseful(visionCache.cards)
      });
      if (tabId != null) {
        if (pyCardsUseful(visionCache.cards)) broadcastCards(tabId, visionCache.cards);
        else if (visionCache.dataUrl) broadcastShot(tabId, visionCache.dataUrl);
      }
    };

    // Совсем недавно уже снимали — отдаём то же самое.
    if (visionCache.dataUrl && now - visionCache.at < 1400) {
      useCache('fresh');
      return true;
    }

    try {
      chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message || 'capture failed' });
          return;
        }

        // Кадр снят, но отправлять его на сервер имеет смысл только если
        // картинка изменилась. dhash устойчив к пересжатию PNG и мелкому шуму,
        // поэтому одинаковые столы дают одинаковый хеш.
        computeFrameHash(dataUrl).then((hash) => {
          const unchanged = hash && visionCache.hash && hash === visionCache.hash;
          if (unchanged && visionCache.cards) {
            visionCache.at = Date.now();
            visionCache.dataUrl = dataUrl;
            useCache('hash');
            return;
          }
          visionCache.at = Date.now();
          visionCache.hash = hash;
          visionCache.dataUrl = dataUrl;

          readWithPython(dataUrl).then((cards) => {
            visionCache.cards = cards || null;
            const good = pyCardsUseful(cards);
            sendResponse({ dataUrl: dataUrl, cards: cards || null, py: good, hash: hash });
            if (tabId == null) return;
            if (good) broadcastCards(tabId, cards);
            else broadcastShot(tabId, dataUrl);
          }).catch((err) => {
            sendResponse({ dataUrl: dataUrl, cards: null, py: false, pyError: String((err && err.message) || err) });
            if (tabId != null) broadcastShot(tabId, dataUrl);
          });
        }).catch(() => {
          // Если хеш посчитать не удалось — работаем как раньше, без кэша.
          readWithPython(dataUrl).then((cards) => {
            visionCache = { at: Date.now(), cards: cards || null, dataUrl: dataUrl, hash: null, payload: null };
            const good = pyCardsUseful(cards);
            sendResponse({ dataUrl: dataUrl, cards: cards || null, py: good });
            if (tabId == null) return;
            if (good) broadcastCards(tabId, cards);
            else broadcastShot(tabId, dataUrl);
          }).catch((err) => {
            sendResponse({ dataUrl: dataUrl, cards: null, py: false, pyError: String((err && err.message) || err) });
            if (tabId != null) broadcastShot(tabId, dataUrl);
          });
        });
      });
    } catch (e) {
      sendResponse({ error: String((e && e.message) || e) });
    }
    return true;
  }

  if (request.action === 'publishShot' && sender.tab) {
    broadcastCards(sender.tab.id, request.cards || {});
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'hudHello') {
    let version = '';
    try {
      version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
    } catch (e) { /* ignore */ }
    sendResponse(Object.assign({ version: version }, lastHud));
    return true;
  }

  if (request.action === 'hudFocus') {
    openHudWindow(true);
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'hudUpdate') {
    applyHud(request.data || {});
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'analyzeHand') {
    const handState = request.hand || {};
    analyzeHand(handState).then((result) => {
      applyHud({
        state: (result && result.state) || responseState(handState),
        extra: { street: result && result.street, warning: result && result.readingWarning },
        response: result
      });
      openHudWindow(false);
      sendResponse(result);
    }).catch((error) => {
      console.error('Analysis error:', error);
      const street = detectStreet(handState);
      const decision = buildFallbackDecision(handState);
      const result = {
        error: (error && error.message) || 'Failed to analyze hand',
        street,
        decision,
        state: responseState(handState),
        readingWarning: cardsWarning(handState)
      };
      applyHud({ state: result.state, extra: { street, warning: result.error }, response: result });
      sendResponse(result);
    });

    return true;
  }

  return true;
});

// ===== FRAME INJECTION =====

/**
 * Inject assistant scripts into every frame of the tab.
 * Scripts self-guard against double initialization.
 * Content scripts from the manifest may already run — safe to re-inject.
 */
async function injectIntoMatchingFrames(tabId) {
  let frames = [];
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId: tabId }) || [];
  } catch (e) {
    return 0;
  }
  const game = frames.filter(f => isGameFrameUrl(f.url));
  if (!game.length) return 0;
  const frameIds = game.map(f => f.frameId);
  const target = { tabId: tabId, frameIds: frameIds };

  try {
    await chrome.scripting.executeScript({
      target: target,
      world: 'MAIN',
      files: ['page_bridge.js']
    });
  } catch (e) {
    console.warn('[PokerAssistant] page_bridge:', (e && e.message) || e);
  }
  const results = await chrome.scripting.executeScript({
    target: target,
    files: ['vision.js', 'card_parser.js', 'content_iframe.js']
  });
  const ok = (results || []).filter(r => !r.error).length;
  return ok;
}

// ===== HELPERS =====

function detectStreet(handState) {
  const cc = (handState.communityCards || []).length;
  if (cc >= 5) return 'river';
  if (cc === 4) return 'turn';
  if (cc === 3) return 'flop';
  const stage = handState.stage || '';
  if (stage === 'river' || stage === 'showdown') return 'river';
  if (stage === 'turn') return 'turn';
  if (stage === 'flop') return 'flop';
  return 'preflop';
}

function cardsWarning(handState) {
  const my = (handState.myCards || []).filter(c => c && c.rank);
  if (my.length < 2) return 'Карты не прочитаны — нажмите Tab для ручного ввода';
  return null;
}

function responseState(handState) {
  return {
    myCards: (handState.myCards || []).filter(c => c && c.rank).slice(0, 2),
    communityCards: (handState.communityCards || []).filter(c => c && c.rank).slice(0, 5),
    pot: handState.pot,
    betToCall: handState.betToCall,
    numPlayers: handState.numPlayers,
    numSeated: handState.numSeated,
    heroStack: handState.heroStack,
    heroName: handState.heroName,
    bigBlind: handState.bigBlind
  };
}

/** Convert money value to big blinds */
function toBB(value, bigBlind) {
  const bb = Number(bigBlind) || 0;
  const v = Number(value) || 0;
  if (bb > 0 && v > 0) return +(v / bb).toFixed(2);
  return v;
}

/** Normalize two hole cards to hand key: "AKs", "AJo", "TT" */
function normalizeHandCards(c1, c2) {
  if (!c1 || !c2 || !c1.rank || !c2.rank) return '';
  const rankOrder = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const r1 = rankOrder.indexOf(String(c1.rank).toUpperCase());
  const r2 = rankOrder.indexOf(String(c2.rank).toUpperCase());
  const suited = String(c1.suit).toLowerCase() === String(c2.suit).toLowerCase();
  let high, low;
  if (r1 >= r2) { high = String(c1.rank).toUpperCase(); low = String(c2.rank).toUpperCase(); }
  else { high = String(c2.rank).toUpperCase(); low = String(c1.rank).toUpperCase(); }
  if (high === low) return high + low;
  return high + low + (suited ? 's' : 'o');
}

/**
 * Сколько игроков в раздаче, в пределах 2..6.
 */
function tableSize(handState) {
  return Math.min(Math.max(parseInt(handState.numPlayers, 10) || 2, 2), 6);
}

/**
 * Самая ранняя позиция для этого размера стола.
 * 6-max → UTG, 5 → MP, 4 → CO, 3 → BTN. Фишки дилера в HTML нет,
 * поэтому неизвестное открытие берём отсюда, а не с широкого чарта кнопки.
 */
function earliestSeat(numPlayers) {
  const ORDER = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
  if (numPlayers <= 2) return 'BTN';
  return ORDER[ORDER.length - numPlayers];
}

/**
 * Префлоп-ситуация по размеру ставки и банка, в больших блайндах.
 *
 * Кнопка Call на неоткрытом банке часто отсутствует, поэтому «ставки нет»
 * не значит «мы на кнопке». Границы:
 *   * добор до ~1.2 ББ и банк ещё блайнды — никто не открывался;
 *   * добор 1.2–2 ББ — большой блайнд закрывает открытие (1 ББ уже вложен);
 *   * добор 2–6 ББ — обычное открытие, герой не блайнд;
 *   * добор от 6 ББ, либо от 4 ББ при уже большом банке — против нас 3-бет.
 * Без известного блайнда положительная ставка считается обычным открытием:
 * отличить 3-бет от рейза в фишках нельзя.
 */
function inferPreflopSpot(handState) {
  const numPlayers = tableSize(handState);
  const bet = Number(handState.betToCall) || 0;
  const pot = Number(handState.pot) || 0;
  const bb = Number(handState.bigBlind) || 0;
  const betBB = bb > 0 ? bet / bb : 0;
  const potBB = bb > 0 ? pot / bb : 0;

  let situation;
  if (bb > 0) {
    if (betBB >= 6 || (betBB >= 4 && potBB >= 8)) situation = 'vs_3bet';
    else if (betBB > 1.2 && betBB <= 2) situation = 'in_bb_vs_open';
    else if (betBB > 2) situation = 'vs_open';
    else if (potBB >= 4) situation = 'in_bb_vs_open';
    else situation = 'unopened';
  } else {
    situation = bet > 0 ? 'vs_open' : 'unopened';
  }

  if (numPlayers === 2) {
    if (situation === 'vs_3bet') {
      return { heroPosition: 'BTN', villainPosition: 'BB', situation: 'vs_3bet' };
    }
    if (situation === 'unopened') {
      return { heroPosition: 'BTN', villainPosition: 'BB', situation: 'unopened' };
    }
    return { heroPosition: 'BB', villainPosition: 'BTN', situation: 'in_bb_vs_open' };
  }

  if (situation === 'unopened') {
    return { heroPosition: earliestSeat(numPlayers), villainPosition: 'BB', situation: situation };
  }
  if (situation === 'in_bb_vs_open') {
    return { heroPosition: 'BB', villainPosition: 'BTN', situation: situation };
  }
  if (situation === 'vs_3bet') {
    return { heroPosition: 'CO', villainPosition: 'BTN', situation: situation };
  }
  return { heroPosition: 'CO', villainPosition: 'MP', situation: 'vs_open' };
}

/**
 * Позиция героя и соперника.
 *
 * На префлопе — inferPreflopSpot. На постфлопе фишки дилера по-прежнему нет:
 * хедз-ап со ставкой считаем большим блайндом (без позиции), в мультивее
 * не назначаем BB по размеру контбета, иначе маленькая ставка получает
 * штраф аут-оф-позишн.
 */
function detectPositions(handState) {
  if (detectStreet(handState) === 'preflop') return inferPreflopSpot(handState);

  const numPlayers = tableSize(handState);
  const bet = Number(handState.betToCall) || 0;
  if (numPlayers === 2) {
    if (bet > 0) return { heroPosition: 'BB', villainPosition: 'BTN', situation: 'postflop' };
    return { heroPosition: 'BTN', villainPosition: 'BB', situation: 'postflop' };
  }
  const hero = earliestSeat(numPlayers);
  return {
    heroPosition: hero,
    villainPosition: hero === 'BB' ? 'BTN' : 'BB',
    situation: 'postflop'
  };
}

/**
 * Префлоп по чартам позиции. null, если модуль недоступен.
 */
function buildPreflopRangeDecision(handState) {
  if (typeof PreflopRanges === 'undefined' || !PreflopRanges || !PreflopRanges.getAction) return null;
  const hole = (handState.myCards || []).filter((c) => c && c.rank).slice(0, 2);
  if (hole.length < 2) return null;

  const bigBlind = Number(handState.bigBlind) || 0;
  const pot = Number(handState.pot) || 0;
  const betToCall = Number(handState.betToCall) || 0;
  const heroStack = Number(handState.heroStack) > 0 ? Number(handState.heroStack) : 0;
  const spot = detectPositions(handState);
  const heroPosition = spot.heroPosition;
  const villainPosition = spot.villainPosition;
  const situation = spot.situation || 'unopened';

  const toBB = (value) => (bigBlind > 0 ? value / bigBlind : value);

  let result;
  try {
    result = PreflopRanges.getAction({
      holeCards: hole,
      position: heroPosition,
      situation: situation,
      raiserPosition: villainPosition,
      potBB: toBB(pot),
      betToCallBB: toBB(betToCall),
      effectiveStackBB: toBB(heroStack) || 100,
      numPlayers: parseInt(handState.numPlayers, 10) || 2
    });
  } catch (e) {
    console.warn('[PokerAssistant] Префлоп-диапазоны:', (e && e.message) || e);
    return null;
  }
  if (!result || !result.action) return null;

  let amount = 0;
  if (result.action === 'RAISE' && result.sizingBB) {
    amount = Number(result.sizingBB) * (bigBlind > 0 ? bigBlind : 1);
    if (heroStack > 0 && amount > heroStack) amount = heroStack;
    amount = Math.round(amount * 100) / 100;
  }

  const equityInfo = computeEquity(handState);
  const totalPot = pot + betToCall;
  const potOdds = totalPot > 0 ? (betToCall / totalPot * 100) : 0;

  return {
    hand_id: null, // проставит вызывающий код
    street: 'preflop',
    decision: {
      action: result.action,
      amount: amount,
      reason: (result.reason || '') + ' [' + (result.rangeName || 'диапазон') + ']',
      winRate: Number(equityInfo.equity).toFixed(1),
      potOdds: potOdds.toFixed(1),
      source: 'ranges'
    },
    equity: Number(equityInfo.equity).toFixed(1),
    equity_source: equityInfo.source,
    hand: result.handKey || '',
    rangeName: result.rangeName || '',
    position: heroPosition
  };
}

/**
 * Эквити Монте-Карло. На постфлопе — против диапазона, если он посчитался.
 */
function computeEquity(handState) {
  const hole = (handState.myCards || []).filter(c => c && c.rank).slice(0, 2);
  const board = (handState.communityCards || []).filter(c => c && c.rank).slice(0, 5);
  const n = Math.min(Math.max(parseInt(handState.numPlayers, 10) || 2, 2), 6);

  if (hole.length < 2) return { equity: 0, source: 'none' };

  try {
    // Постфлоп считаем против ДИАПАЗОНА соперника, а не против случайных рук:
    // против случайных рук эквити систематически завышено. Если модуль
    // диапазонов недоступен — откатываемся на прежний расчёт.
    if (board.length >= 3 && typeof PostflopRanges !== 'undefined' && PostflopRanges && PostflopRanges.getEquity) {
      const { potType, aggression } = inferPotContext(handState);
      const r = PostflopRanges.getEquity({
        holeCards: hole,
        board: board,
        potType: potType,
        aggression: aggression,
        opponents: n - 1,
        iterations: 6000
      });
      if (r && typeof r.equity === 'number') {
        return {
          equity: r.equity,
          source: 'range',
          hand: normalizeHandCards(hole[0], hole[1]),
          rangeName: r.rangeName || ''
        };
      }
    }

    const mc = new MonteCarloSimulator();
    const iters = board.length === 0 ? 3000 : 6000;
    const res = mc.computeWinRate(hole, board, n - 1, iters);
    return {
      equity: Number(res.equity),
      source: 'MonteCarlo',
      hand: normalizeHandCards(hole[0], hole[1])
    };
  } catch (e) {
    console.warn('[PokerAssistant] Monte Carlo failed:', e);
    return { equity: 0, source: 'none' };
  }
}

/**
 * Прикинуть контекст банка для постфлоп-диапазонов.
 *
 * Истории ставок в HTML нет. Большой банк (~12 ББ и больше) — 3-бет.
 * В обычном банке ставку в героя считаем контбетом префлоп-агрессора
 * (srp_pfr): коллёр так ставит реже. Чек до героя — диапазон коллера
 * (srp_caller), который играл без инициативы.
 */
function inferPotContext(handState) {
  const bigBlind = Number(handState.bigBlind) || 0;
  const pot = Number(handState.pot) || 0;
  const betToCall = Number(handState.betToCall) || 0;
  const potBB = bigBlind > 0 ? pot / bigBlind : pot;

  let potType;
  if (potBB >= 12) potType = 'threebet';
  else if (betToCall > 0) potType = 'srp_pfr';
  else potType = 'srp_caller';

  const aggression = betToCall > 0 ? 'bet' : 'check';
  return { potType: potType, aggression: aggression };
}

/**
 * Постфлоп-решение по диапазонам (postflop_ranges.js).
 * Возвращает null, если модуль недоступен.
 */
function buildPostflopRangeDecision(handState) {
  if (typeof PostflopRanges === 'undefined' || !PostflopRanges || !PostflopRanges.getAction) return null;
  const hole = (handState.myCards || []).filter((c) => c && c.rank).slice(0, 2);
  const board = (handState.communityCards || []).filter((c) => c && c.rank).slice(0, 5);
  if (hole.length < 2 || board.length < 3) return null;

  const bigBlind = Number(handState.bigBlind) || 0;
  const pot = Number(handState.pot) || 0;
  const betToCall = Number(handState.betToCall) || 0;
  const heroStack = Number(handState.heroStack) > 0 ? Number(handState.heroStack) : 0;
  const { potType, aggression } = inferPotContext(handState);
  const { heroPosition } = detectPositions(handState);

  const toBB = (value) => (bigBlind > 0 ? value / bigBlind : value);

  let result;
  try {
    result = PostflopRanges.getAction({
      holeCards: hole,
      board: board,
      potType: potType,
      aggression: aggression,
      potBB: toBB(pot),
      betToCallBB: toBB(betToCall),
      effectiveStackBB: toBB(heroStack) || 100,
      position: heroPosition,
      numPlayers: parseInt(handState.numPlayers, 10) || 2,
      iterations: 6000
    });
  } catch (e) {
    console.warn('[PokerAssistant] Постфлоп-диапазоны:', (e && e.message) || e);
    return null;
  }
  if (!result || !result.action) return null;

  let amount = 0;
  if (result.action === 'RAISE') {
    if (result.amountFactor) amount = pot * result.amountFactor;
    else if (result.sizingBB) amount = Number(result.sizingBB) * (bigBlind > 0 ? bigBlind : 1);
    if (amount <= 0) amount = Math.max(pot * 0.6, betToCall * 2, 1);
    if (heroStack > 0 && amount > heroStack) amount = heroStack;
    amount = Math.round(amount * 100) / 100;
  }

  const totalPot = pot + betToCall;
  const potOdds = totalPot > 0 ? (betToCall / totalPot * 100) : 0;
  const equity = Number(result.equity) || 0;

  return {
    hand_id: null,
    street: detectStreet(handState),
    decision: {
      action: result.action,
      amount: amount,
      reason: (result.reason || '') + (result.rangeName ? ' [' + result.rangeName + ']' : ''),
      winRate: equity.toFixed(1),
      potOdds: potOdds.toFixed(1),
      source: 'ranges'
    },
    equity: equity.toFixed(1),
    equity_source: 'range',
    hand: normalizeHandCards(hole[0], hole[1]),
    rangeName: result.rangeName || '',
    position: heroPosition
  };
}

// ===== MAIN ANALYSIS =====

/**
 * Решение только локальное: префлоп-чарты, постфлоп против диапазона,
 * а если карт не хватает — Монте-Карло и pot odds.
 */
async function analyzeHand(handState) {
  const street = detectStreet(handState);

  const pot = Number(handState.pot) || 0;
  const betToCall = Number(handState.betToCall) || 0;
  const totalPot = pot + betToCall;
  const potOdds = totalPot > 0 ? (betToCall / totalPot * 100) : 0;

  const { equity, source, hand } = computeEquity(handState);
  const handId = ++handCounter;

  if (street === 'preflop') {
    const rangeDecision = buildPreflopRangeDecision(handState);
    if (rangeDecision) {
      rangeDecision.hand_id = handId;
      rangeDecision.state = responseState(handState);
      rangeDecision.readingWarning = cardsWarning(handState);
      console.log(`[PokerAssistant] Префлоп по диапазонам: ${rangeDecision.hand} ${rangeDecision.position} → ${rangeDecision.decision.action}`);
      return rangeDecision;
    }
  } else {
    const postflopDecision = buildPostflopRangeDecision(handState);
    if (postflopDecision) {
      postflopDecision.hand_id = handId;
      postflopDecision.state = responseState(handState);
      postflopDecision.readingWarning = cardsWarning(handState);
      console.log(`[PokerAssistant] Постфлоп по диапазонам: эквити ${postflopDecision.equity}% → ${postflopDecision.decision.action}`);
      return postflopDecision;
    }
  }

  const decision = buildFallbackDecision(handState);
  return {
    hand_id: handId,
    street,
    decision,
    potOdds: potOdds.toFixed(1),
    equity: equity.toFixed(1),
    equity_source: source,
    hand: hand || '',
    state: responseState(handState),
    readingWarning: cardsWarning(handState)
  };
}

/**
 * Резерв, когда диапазоны не сработали: эквити и pot odds, без сети.
 */
function buildFallbackDecision(handState) {
  const street = detectStreet(handState);
  const pot = Number(handState.pot) || 0;
  const betToCall = Number(handState.betToCall) || 0;
  const numPlayers = Math.min(Math.max(parseInt(handState.numPlayers, 10) || 2, 2), 6);
  // Итоговый банк и цена колла. Если доставлять нечего, pot odds = 0.
  const totalPot = pot + betToCall;
  const potOdds = totalPot > 0 ? (betToCall / totalPot * 100) : 0;
  const { equity } = computeEquity(handState);
  const heroStack = Number(handState.heroStack) > 0 ? Number(handState.heroStack) : 0;

  let action, amount = 0, reason;

  if (betToCall === 0) {
    // Никто не ставил: решаем между ставкой и чеком.
    if (equity >= 60) {
      action = 'RAISE';
      amount = Math.max(pot * 0.75, 1);
      reason = `Сильная рука (${equity.toFixed(1)}%) — ставка для велью`;
    } else if (equity >= 45) {
      action = 'RAISE';
      amount = Math.max(pot * 0.5, 1);
      reason = `Средняя рука (${equity.toFixed(1)}%) — небольшая ставка`;
    } else {
      action = 'CHECK';
      reason = `Эквити ${equity.toFixed(1)}% — чек, контроль банка`;
    }
  } else {
    if (equity >= potOdds + 20) {
      action = 'RAISE';
      amount = Math.max(betToCall * 2.5, pot * 0.75, 1);
      reason = `Эквити ${equity.toFixed(1)}% >> pot odds ${potOdds.toFixed(1)}% — рейз`;
    } else if (equity >= potOdds * 0.75) {
      action = 'CALL';
      reason = `Эквити ${equity.toFixed(1)}% vs pot odds ${potOdds.toFixed(1)}% — колл`;
    } else {
      action = 'FOLD';
      reason = `Эквити ${equity.toFixed(1)}% < pot odds ${potOdds.toFixed(1)}% — фолд`;
    }
  }

  // Нельзя ставить больше стека.
  if (action === 'RAISE') {
    if (heroStack > 0 && amount > heroStack) amount = heroStack;
    amount = Math.round(amount * 100) / 100;
  } else {
    amount = 0;
  }

  return {
    action: action,
    amount: amount,
    reason: reason + ` (${numPlayers} игроков, ${street})`,
    winRate: (action === 'FOLD' ? Math.min(equity, 30) : equity).toFixed(1),
    potOdds: potOdds.toFixed(1),
    source: 'fallback'
  };
}

function rememberPack(build) {
  if (!build || !chrome.storage || !chrome.storage.local || !chrome.runtime || !chrome.runtime.reload) return;
  chrome.storage.local.get('pack').then((stored) => {
    if (stored && stored.pack === build) return;
    return chrome.storage.local.set({ pack: build }).then(() => chrome.runtime.reload());
  }).catch(() => {});
}

function watchPack() {
  if (typeof fetch !== 'function') return;
  fetch('http://127.0.0.1:8765/health').then((res) => {
    if (!res.ok) throw new Error('health');
    return res.json();
  }).then((data) => {
    if (data && data.ok) rememberPack(data.build || '');
  }).catch(() => {});
}

watchPack();
if (chrome.alarms && chrome.alarms.create && chrome.alarms.onAlarm) {
  chrome.alarms.create('pinpok-pack', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === 'pinpok-pack') watchPack();
  });
}

console.log('pin-pok: фоновый скрипт загружен');
