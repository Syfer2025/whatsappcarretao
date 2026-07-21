/* global window */
(function initChatAudioPlayer(root) {
  'use strict';

  const ALLOWED_RATES = Object.freeze([1, 2, 3]);
  const MAX_REMEMBERED_PLAYERS = 500;
  const playerState = new Map();
  const attachedDocuments = new WeakSet();

  function normalizeRate(value) {
    const rate = Number(value);
    return ALLOWED_RATES.includes(rate) ? rate : 1;
  }

  function escapeAttribute(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character]));
  }

  function remember(key, nextState) {
    if (!key) return;
    const normalizedKey = String(key);
    const current = playerState.get(normalizedKey) || {};
    playerState.delete(normalizedKey);
    playerState.set(normalizedKey, { ...current, ...nextState });
    while (playerState.size > MAX_REMEMBERED_PLAYERS) {
      playerState.delete(playerState.keys().next().value);
    }
  }

  function remembered(key) {
    return key ? playerState.get(String(key)) || null : null;
  }

  function playerKey(player) {
    return String(player?.dataset?.audioKey || '');
  }

  function updateButtons(player, rate) {
    const normalizedRate = normalizeRate(rate);
    for (const button of player.querySelectorAll('[data-audio-speed]')) {
      const active = normalizeRate(button.dataset.audioSpeed) === normalizedRate;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    player.dataset.playbackRate = String(normalizedRate);
  }

  function applyRate(player, value, { persist = true } = {}) {
    const rate = normalizeRate(value);
    const audio = player?.querySelector?.('audio');
    if (!audio) return 1;
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    if ('preservesPitch' in audio) audio.preservesPitch = true;
    if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = true;
    updateButtons(player, rate);
    if (persist) remember(playerKey(player), { rate });
    return rate;
  }

  function restorePlayer(player) {
    const audio = player?.querySelector?.('audio');
    if (!audio) return;
    const state = remembered(playerKey(player));
    applyRate(player, state?.rate || player.dataset.playbackRate || 1, { persist: false });
    if (state && Number.isFinite(state.currentTime) && state.currentTime > 0) {
      const duration = Number(audio.duration);
      const maximum = Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - 0.05) : state.currentTime;
      try { audio.currentTime = Math.min(state.currentTime, maximum); } catch {}
    }
  }

  function bindPlayer(player) {
    if (!player || player.dataset.audioPlayerBound === 'true') return player;
    const audio = player.querySelector('audio');
    if (!audio) return player;
    player.dataset.audioPlayerBound = 'true';

    player.addEventListener('click', event => event.stopPropagation());
    for (const button of player.querySelectorAll('[data-audio-speed]')) {
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        applyRate(player, button.dataset.audioSpeed);
      });
    }

    audio.addEventListener('loadedmetadata', () => restorePlayer(player));
    audio.addEventListener('timeupdate', () => {
      if (Number.isFinite(audio.currentTime)) remember(playerKey(player), { currentTime: audio.currentTime });
    });
    audio.addEventListener('ratechange', () => {
      const rate = normalizeRate(audio.playbackRate);
      updateButtons(player, rate);
      remember(playerKey(player), { rate });
    });
    restorePlayer(player);
    return player;
  }

  function scan(scope) {
    if (!scope) return;
    if (scope.matches?.('[data-audio-player]')) bindPlayer(scope);
    for (const player of scope.querySelectorAll?.('[data-audio-player]') || []) bindPlayer(player);
  }

  function attach(documentObject = root?.document) {
    if (!documentObject || attachedDocuments.has(documentObject)) return;
    attachedDocuments.add(documentObject);
    const start = () => {
      scan(documentObject);
      if (!root?.MutationObserver || !documentObject.documentElement) return;
      const observer = new root.MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes || []) {
            if (node?.nodeType === 1) scan(node);
          }
        }
      });
      observer.observe(documentObject.documentElement, { childList: true, subtree: true });
    };
    if (documentObject.readyState === 'loading') {
      documentObject.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }

  function render(source, { key = source, label = 'Mensagem de áudio' } = {}) {
    const safeSource = escapeAttribute(source);
    const safeKey = escapeAttribute(key);
    const safeLabel = escapeAttribute(label || 'Mensagem de áudio');
    const buttons = ALLOWED_RATES.map(rate => (
      `<button type="button" class="audio-speed-btn${rate === 1 ? ' active' : ''}" `
      + `data-audio-speed="${rate}" aria-pressed="${rate === 1 ? 'true' : 'false'}" `
      + `aria-label="Reproduzir em ${rate}x">${rate}x</button>`
    )).join('');
    return `<div class="media-block chat-audio-player" data-audio-player data-audio-key="${safeKey}" data-playback-rate="1">`
      + `<audio controls preload="metadata" src="${safeSource}" data-media-source="${safeSource}" aria-label="${safeLabel}"></audio>`
      + '<div class="audio-speed-control" role="group" aria-label="Velocidade de reprodução">'
      + '<span class="audio-speed-label">Velocidade</span>'
      + buttons
      + '</div></div>';
  }

  function createElement(documentObject, source, options) {
    const holder = documentObject.createElement('div');
    holder.innerHTML = render(source, options);
    const player = holder.firstElementChild;
    return bindPlayer(player);
  }

  const api = {
    ALLOWED_RATES,
    normalizeRate,
    render,
    createElement,
    bindPlayer,
    applyRate,
    attach,
    _remembered: remembered
  };

  if (root) {
    root.ChatAudioPlayer = api;
    attach(root.document);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
