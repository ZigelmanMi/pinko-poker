// Скрипт внутри iframe стола.
(function () {
  'use strict';
  if (window.__pokerAssistantInitialized) return;

  var isGame = /e5t\.online/i.test(location.hostname) ||
    !!(document.querySelector('.r-scene-container, .r-table-cards, .PixiComponent, .poker-game, canvas'));
  if (!isGame) return;

  window.__pokerAssistantInitialized = true;
  try { document.documentElement.setAttribute('data-pa-loaded', '3.5.0'); } catch (e) { /* ignore */ }

  window.addEventListener('message', function (e) {
    if (!e.data) return;
    if (e.data.source === 'PA_BRIDGE') window.__paBridgeCards = e.data.data || null;
    if (e.data.source === 'PA_SHOT' && e.data.data) window.__paShotCards = e.data.data;
  });

  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg) return;
      if (msg.action === 'shotCards' && msg.data) {
        window.__paShotCards = msg.data;
      }
      if (msg.action === 'tableShot' && msg.dataUrl && window.PokerVision) {
        if (window.__paShotCards && window.__paShotCards.source === 'py') return;
        window.PokerVision.readDataUrl(msg.dataUrl).then(function (cards) {
          if (window.__paShotCards && window.__paShotCards.source === 'py') return;
          window.__paShotCards = cards;
        }).catch(function () { /* ignore */ });
      }
    });
  } catch (e) { /* ignore */ }

  var lastShotAt = 0;
  // Телеметрия: видно, сколько раз удалось обойтись без скриншота.
  var shotStats = { captures: 0, pyAnswers: 0, localAnswers: 0, bridgeSkips: 0, cacheHits: 0 };
  // Отдаём статистику парсеру, чтобы она попала в состояние и в виджет.
  window.__paShotStats = shotStats;
  // Источники, при которых карты уже прочитаны прямо из страницы (canvas,
  // React, Pixi). В этом случае скриншот вкладки и поход на локальный сервер
  // зрения не нужны — это экономит мегабайты трафика и CPU.
  var BRIDGE_SOURCES = { cv: 1, react: 1, pixi: 1 };
  function bridgeHasFreshCards() {
    var br = window.__paBridgeCards;
    if (!br || !br.at) return false;
    if (!BRIDGE_SOURCES[br.source]) return false;
    if (!br.myCards || br.myCards.length < 2) return false;
    // Данные считаем свежими 6 секунд: если мост замолчал, вернёмся к скриншотам.
    return (Date.now() - br.at) < 6000;
  }

  function grabTableShot() {
    var now = Date.now();
    if (now - lastShotAt < 1800) return;
    lastShotAt = now;
    if (!paRuntimeOk() || !window.PokerVision) return;
    if (bridgeHasFreshCards()) {
      // Мост отдал карты — сервер зрения не беспокоим.
      shotStats.bridgeSkips++;
      window.__paShotSource = 'bridge';
      return;
    }
    try {
      chrome.runtime.sendMessage({ action: 'captureTable' }, function (res) {
        if (!paRuntimeOk()) return;
        if (chrome.runtime.lastError) {
          window.__paShotCards = window.__paShotCards || { myCards: [], communityCards: [], error: chrome.runtime.lastError.message };
          return;
        }
        shotStats.captures++;
        if (res && res.cached) shotStats.cacheHits++;
        if (res && res.cards && res.cards.source === 'py') {
          shotStats.pyAnswers++;
          window.__paShotCards = res.cards;
          return;
        }
        if (!res || !res.dataUrl) {
          if (res && res.error) window.__paShotCards = { myCards: [], communityCards: [], error: res.error };
          return;
        }
        window.PokerVision.readDataUrl(res.dataUrl).then(function (cards) {
          if (window.__paShotCards && window.__paShotCards.source === 'py') return;
          shotStats.localAnswers++;
          window.__paShotCards = cards;
        }).catch(function (err) {
          if (window.__paShotCards && window.__paShotCards.source === 'py') return;
          window.__paShotCards = { myCards: [], communityCards: [], error: String(err) };
        });
      });
    } catch (e) { /* ignore */ }
  }

  function paRuntimeOk() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function PokerAssistantIframe() {
    this.parser = new window.PokerCardParserCore();
    this.observer = null;
    this.pollTimer = null;
    this.lastState = null;
    this.lastGoodState = null;
    this.lastGoodTime = 0;
    this.lastAnalysisTime = 0;
    this.lastScanTime = 0;
    this.lastDecision = null;
    this.dead = false;
    this.init();
  }

  PokerAssistantIframe.prototype.init = function () {
    try {
      var old = document.getElementById('poker-assistant-panel');
      if (old) old.remove();
      var ov = document.getElementById('poker-assistant-overlay');
      if (ov) ov.remove();
    } catch (e) { /* ignore */ }
    this.initializeObserver();
    this.startAutoDetection();
  };

  PokerAssistantIframe.prototype.markDead = function () {
    if (this.dead) return;
    this.dead = true;
    try { if (this.observer) this.observer.disconnect(); } catch (e) { /* ignore */ }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this._pendingScan) {
      clearTimeout(this._pendingScan);
      this._pendingScan = null;
    }
    try { chrome.runtime.sendMessage({ action: 'hudUpdate', data: { dead: true } }); } catch (e) { /* ignore */ }
  };

  PokerAssistantIframe.prototype.initializeObserver = function () {
    var self = this;
    // Игра постоянно перерисовывает DOM. Без задержки observer вызывал бы
    // полный разбор стола на каждое изменение атрибутов. Откладываем разбор
    // на 250 мс и не даём ему запускаться чаще одного раза в 1.5 с.
    var lastRun = 0;
    var MIN_GAP_MS = 1500;
    this._pendingScan = null;
    this._scheduleScan = function () {
      if (self._pendingScan || self.dead) return;
      var now = Date.now();
      var delay = Math.max(250, MIN_GAP_MS - (now - lastRun));
      self._pendingScan = setTimeout(function () {
        self._pendingScan = null;
        lastRun = Date.now();
        self.detectGameState();
      }, delay);
    };
    try {
      this.observer = new MutationObserver(function () { self._scheduleScan(); });
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'src', 'data', 'style']
      });
    } catch (e) { /* ignore */ }
  };

  PokerAssistantIframe.prototype.startAutoDetection = function () {
    var self = this;
    if (window._pokerStateReader) {
      try { window._pokerStateReader.start(); } catch (e) { /* ignore */ }
    }
    this.pollTimer = setInterval(function () {
      grabTableShot();
      self.detectGameState();
    }, 2000);
    grabTableShot();
    this.detectGameState();
  };

  PokerAssistantIframe.prototype.detectGameState = function () {
    if (this.dead) return;
    if (!paRuntimeOk()) {
      this.markDead();
      return;
    }
    var now = Date.now();
    if (now - this.lastScanTime < 1500) return;
    this.lastScanTime = now;

    var state = this.parser.getState();

    if (state && state.myCards && state.myCards.length >= 2) {
      this.lastGoodState = state;
      this.lastGoodTime = now;
    } else if (this.lastGoodState && now - this.lastGoodTime < 8000) {
      state = Object.assign({}, this.lastGoodState, {
        pot: (state && state.pot) || this.lastGoodState.pot,
        betToCall: (state && state.betToCall) || this.lastGoodState.betToCall,
        heroStack: (state && state.heroStack) || this.lastGoodState.heroStack
      });
    }

    try {
      chrome.runtime.sendMessage({ action: 'hudUpdate', data: { state: state } });
    } catch (e) { /* ignore */ }

    var haveCards = state && state.myCards && state.myCards.length >= 2;
    var stale = !this.lastDecision || (now - this.lastAnalysisTime > 12000);
    if (haveCards && now - this.lastAnalysisTime >= 3000 && (this.hasStateChanged(state) || stale)) {
      this.lastState = state;
      this.lastAnalysisTime = now;
      this.sendToBackground(state);
    }
  };

  PokerAssistantIframe.prototype.hasStateChanged = function (newState) {
    if (!this.lastState) return true;
    return JSON.stringify(newState.myCards) !== JSON.stringify(this.lastState.myCards) ||
           JSON.stringify(newState.communityCards) !== JSON.stringify(this.lastState.communityCards) ||
           newState.stage !== this.lastState.stage ||
           newState.betToCall !== this.lastState.betToCall ||
           newState.pot !== this.lastState.pot;
  };

  PokerAssistantIframe.prototype.sendToBackground = function (state) {
    if (!paRuntimeOk()) {
      this.markDead();
      return;
    }
    var self = this;
    try {
      chrome.runtime.sendMessage({ action: 'analyzeHand', hand: state }, function (response) {
        if (!paRuntimeOk()) {
          self.markDead();
          return;
        }
        if (chrome.runtime.lastError) {
          var msg = chrome.runtime.lastError.message || '';
          if (/invalidated|context/i.test(msg)) self.markDead();
          return;
        }
        if (response && response.decision) {
          self.lastDecision = response;
          response.state = response.state || {
            myCards: state.myCards,
            communityCards: state.communityCards,
            pot: state.pot,
            betToCall: state.betToCall,
            numPlayers: state.numPlayers,
            heroStack: state.heroStack,
            heroName: state.heroName
          };
          try {
            chrome.runtime.sendMessage({ action: 'hudUpdate', data: { state: response.state, response: response } });
          } catch (e) { /* ignore */ }
        }
      });
    } catch (e) {
      this.markDead();
    }
  };

  try {
    var s = document.createElement('script');
    s.src = chrome.runtime.getURL('page_bridge.js');
    s.onload = function () { s.remove(); };
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* ignore */ }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    try { chrome.runtime.sendMessage({ action: 'hudFocus' }); } catch (err) { /* ignore */ }
  });

  window._pokerAssistantIframe = new PokerAssistantIframe();
})();
