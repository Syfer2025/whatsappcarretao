/* global window, document */

(function stickerLibraryBootstrap() {
  'use strict';

  const IDS = {
    style: 'stickerLibraryStyles',
    trigger: 'stickerLibraryButton',
    overlay: 'stickerLibraryOverlay',
    palette: 'stickerLibraryPalette',
    grid: 'stickerLibraryGrid',
    status: 'stickerLibraryStatus',
    close: 'stickerLibraryClose',
    upload: 'stickerLibraryUpload'
  };
  const state = {
    initialized: false,
    open: false,
    loading: false,
    sendingId: null,
    loadSequence: 0,
    stickers: [],
    previousFocus: null,
    config: {
      api: null,
      getCurrentConversationId: null,
      onSent: null,
      notify: null
    }
  };

  function createElement(tagName, options = {}, children = []) {
    const element = document.createElement(tagName);
    if (options.id) element.id = options.id;
    if (options.className) element.className = options.className;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.type) element.type = options.type;
    if (options.title) element.title = options.title;
    for (const [name, value] of Object.entries(options.attributes || {})) {
      element.setAttribute(name, value);
    }
    for (const child of children) {
      if (child) element.appendChild(child);
    }
    return element;
  }

  function injectStyles() {
    if (document.getElementById(IDS.style)) return;
    const style = document.createElement('style');
    style.id = IDS.style;
    style.textContent = `
      [hidden] { display: none !important; }
      .sticker-library-overlay {
        position: fixed; inset: 0; z-index: 1250; display: flex; align-items: flex-end;
        justify-content: center; padding: 18px; background: rgba(2, 8, 23, .28);
      }
      .sticker-library-palette {
        width: min(440px, 100%); max-height: min(560px, calc(100dvh - 36px));
        display: flex; flex-direction: column; overflow: hidden; border: 1px solid #dbe2e8;
        border-radius: 16px; background: #fff; color: #111b21;
        box-shadow: 0 22px 60px rgba(2, 8, 23, .32);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .sticker-library-header {
        flex: none; display: flex; align-items: center; justify-content: space-between;
        gap: 12px; padding: 14px 16px; border-bottom: 1px solid #e9edef;
      }
      .sticker-library-title { margin: 0; font-size: 15px; }
      .sticker-library-subtitle { margin: 3px 0 0; color: #667781; font-size: 11px; }
      .sticker-library-close {
        width: 34px; height: 34px; flex: none; border: 0; border-radius: 50%;
        background: #f0f2f5; color: #54656f; font-size: 21px; cursor: pointer;
      }
      .sticker-library-status {
        flex: none; min-height: 0; padding: 0 16px; color: #667781; font-size: 12px;
      }
      .sticker-library-status:not(:empty) { padding-top: 11px; }
      .sticker-library-status.error { color: #b91c1c; }
      .sticker-library-status.success { color: #15803d; }
      .sticker-library-grid {
        flex: 1; min-height: 160px; overflow: auto; display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr)); align-content: start;
        gap: 7px; padding: 14px 16px;
      }
      .sticker-library-grid[aria-busy="true"] { opacity: .65; }
      .sticker-library-empty {
        grid-column: 1 / -1; align-self: center; padding: 34px 16px;
        color: #667781; text-align: center; font-size: 12.5px; line-height: 1.45;
      }
      .sticker-library-item {
        aspect-ratio: 1; min-width: 0; display: flex; align-items: center; justify-content: center;
        padding: 5px; overflow: hidden; border: 1px solid transparent; border-radius: 10px;
        background: #f8fafc; cursor: pointer;
      }
      .sticker-library-item:hover, .sticker-library-item:focus-visible {
        border-color: #25d366; background: #ecfdf3; outline: none;
      }
      .sticker-library-item:disabled { cursor: wait; opacity: .5; }
      .sticker-library-item img { display: block; width: 100%; height: 100%; object-fit: contain; }
      .sticker-library-footer {
        flex: none; display: flex; justify-content: flex-end; padding: 11px 16px 14px;
        border-top: 1px solid #e9edef;
      }
      .sticker-library-upload {
        border: 0; border-radius: 9px; padding: 10px 14px; background: #128c7e;
        color: #fff; font-size: 12.5px; font-weight: 700; cursor: pointer;
      }
      [data-theme="dark"] .sticker-library-palette { border-color: rgba(255,255,255,.1); background: #111b21; color: #e9edef; }
      [data-theme="dark"] .sticker-library-header,
      [data-theme="dark"] .sticker-library-footer { border-color: rgba(255,255,255,.08); }
      [data-theme="dark"] .sticker-library-subtitle,
      [data-theme="dark"] .sticker-library-status,
      [data-theme="dark"] .sticker-library-empty { color: #8696a0; }
      [data-theme="dark"] .sticker-library-status.error { color: #fda4af; }
      [data-theme="dark"] .sticker-library-status.success { color: #7fe0a3; }
      [data-theme="dark"] .sticker-library-close,
      [data-theme="dark"] .sticker-library-item { background: #202c33; color: #e9edef; }
      [data-theme="dark"] .sticker-library-item:hover,
      [data-theme="dark"] .sticker-library-item:focus-visible { border-color: #25d366; background: #263f3a; }
      @media (max-width: 520px) {
        .sticker-library-overlay { padding: 0; }
        .sticker-library-palette { width: 100%; max-height: 78dvh; border-radius: 16px 16px 0 0; }
        .sticker-library-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
      }
    `;
    document.head.appendChild(style);
  }

  function buildPalette() {
    const title = createElement('h2', {
      id: 'stickerLibraryTitle',
      className: 'sticker-library-title',
      text: 'Figurinhas recentes'
    });
    const subtitle = createElement('p', {
      className: 'sticker-library-subtitle',
      text: 'Recebidas ou importadas nas conversas que você pode acessar'
    });
    const heading = createElement('div', {}, [title, subtitle]);
    const closeButton = createElement('button', {
      id: IDS.close,
      className: 'sticker-library-close',
      type: 'button',
      text: '×',
      attributes: { 'aria-label': 'Fechar biblioteca de figurinhas' }
    });
    const header = createElement('header', { className: 'sticker-library-header' }, [heading, closeButton]);
    const status = createElement('div', {
      id: IDS.status,
      className: 'sticker-library-status',
      attributes: { role: 'status', 'aria-live': 'polite' }
    });
    const grid = createElement('div', {
      id: IDS.grid,
      className: 'sticker-library-grid',
      attributes: { 'aria-label': 'Figurinhas recentes', 'aria-busy': 'false' }
    });
    const uploadButton = createElement('button', {
      id: IDS.upload,
      className: 'sticker-library-upload',
      type: 'button',
      text: 'Enviar nova imagem'
    });
    const footer = createElement('footer', { className: 'sticker-library-footer' }, [uploadButton]);
    const palette = createElement('section', {
      id: IDS.palette,
      className: 'sticker-library-palette',
      attributes: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'stickerLibraryTitle'
      }
    }, [header, status, grid, footer]);
    const overlay = createElement('div', {
      id: IDS.overlay,
      className: 'sticker-library-overlay',
      attributes: { role: 'presentation' }
    }, [palette]);
    overlay.hidden = true;
    return overlay;
  }

  function setStatus(message, kind = '') {
    const status = document.getElementById(IDS.status);
    if (!status) return;
    status.textContent = message || '';
    status.className = `sticker-library-status${kind ? ` ${kind}` : ''}`;
  }

  function safeStickerUrl(value) {
    try {
      const url = new URL(String(value || ''), window.location.origin);
      if (url.origin !== window.location.origin || !url.pathname.startsWith('/media/')) return '';
      return `${url.pathname}${url.search}`;
    } catch {
      return '';
    }
  }

  function responseMessage(status, data, fallback) {
    if (status === 401) return 'Sua sessão expirou. Entre novamente.';
    if (status === 403) return 'Você não tem acesso a esta biblioteca.';
    return data?.error || fallback;
  }

  function getApi() {
    const request = state.config.api || window.api;
    return typeof request === 'function' ? request : null;
  }

  function currentConversationId() {
    const value = typeof state.config.getCurrentConversationId === 'function'
      ? state.config.getCurrentConversationId()
      : null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  function notify(message, type = 'error') {
    if (typeof state.config.notify === 'function') state.config.notify(message, type);
  }

  function setGridBusy(busy) {
    const grid = document.getElementById(IDS.grid);
    if (!grid) return;
    grid.setAttribute('aria-busy', busy ? 'true' : 'false');
    grid.querySelectorAll('button').forEach(button => {
      button.disabled = Boolean(busy) || button.dataset.unavailable === 'true';
    });
  }

  function renderState(message) {
    const grid = document.getElementById(IDS.grid);
    if (!grid) return;
    const empty = createElement('div', {
      className: 'sticker-library-empty',
      text: message
    });
    grid.replaceChildren(empty);
  }

  function stickerButton(sticker) {
    const url = safeStickerUrl(sticker.media_url);
    if (!url) return null;
    const image = createElement('img', {
      attributes: {
        src: url,
        alt: sticker.media_filename || 'Figurinha'
      }
    });
    const button = createElement('button', {
      className: 'sticker-library-item',
      type: 'button',
      title: 'Enviar esta figurinha',
      attributes: {
        'aria-label': `Enviar figurinha ${sticker.media_filename || ''}`.trim()
      }
    }, [image]);
    button.addEventListener('click', () => sendSticker(sticker, button));
    image.addEventListener('error', () => {
      button.dataset.unavailable = 'true';
      button.disabled = true;
      button.title = 'Figurinha indisponível';
      button.replaceChildren(createElement('span', { text: 'Indisponível' }));
    }, { once: true });
    return button;
  }

  function renderStickers() {
    const grid = document.getElementById(IDS.grid);
    if (!grid) return;
    const buttons = state.stickers.map(stickerButton).filter(Boolean);
    if (!buttons.length) {
      renderState('Nenhuma figurinha recente encontrada. Você ainda pode enviar uma nova imagem.');
      return;
    }
    grid.replaceChildren(...buttons);
  }

  async function loadStickers() {
    const request = getApi();
    if (!request) {
      setStatus('A biblioteca não conseguiu acessar a API desta página.', 'error');
      renderState('Não foi possível carregar as figurinhas.');
      return false;
    }
    const sequence = ++state.loadSequence;
    state.loading = true;
    setStatus('');
    setGridBusy(true);
    renderState('Carregando figurinhas…');
    try {
      const response = await request('/api/stickers/recent?limit=48');
      const data = await response.json().catch(() => ({}));
      if (sequence !== state.loadSequence) return false;
      if (!response.ok) {
        state.stickers = [];
        setStatus(responseMessage(response.status, data, 'Não foi possível carregar as figurinhas.'), 'error');
        renderState('Biblioteca indisponível no momento.');
        return false;
      }
      const stickers = Array.isArray(data) ? data : (Array.isArray(data.stickers) ? data.stickers : []);
      state.stickers = stickers.filter(sticker => Number(sticker?.id) > 0 && safeStickerUrl(sticker.media_url));
      setStatus('');
      renderStickers();
      return true;
    } catch {
      if (sequence !== state.loadSequence) return false;
      state.stickers = [];
      setStatus('Sem conexão para carregar as figurinhas.', 'error');
      renderState('Verifique sua internet e tente abrir novamente.');
      return false;
    } finally {
      if (sequence === state.loadSequence) {
        state.loading = false;
        setGridBusy(false);
      }
    }
  }

  async function sendSticker(sticker, button) {
    if (state.sendingId) return;
    const conversationId = currentConversationId();
    if (!conversationId) {
      setStatus('Selecione uma conversa antes de enviar uma figurinha.', 'error');
      notify('Selecione uma conversa antes de enviar uma figurinha.');
      return;
    }
    const messageId = Number(sticker?.id);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return;
    const request = getApi();
    if (!request) {
      setStatus('Não foi possível acessar a API desta página.', 'error');
      return;
    }

    state.sendingId = messageId;
    setGridBusy(true);
    setStatus('Enviando figurinha…');
    button?.setAttribute('aria-busy', 'true');
    try {
      const response = await request(`/api/messages/${messageId}/forward`, {
        method: 'POST',
        body: JSON.stringify({ conversation_id: conversationId })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(responseMessage(response.status, data, 'Não foi possível enviar a figurinha.'));
      }
      setStatus('Figurinha enviada.', 'success');
      notify('Figurinha enviada.', 'success');
      if (typeof state.config.onSent === 'function') {
        try {
          await state.config.onSent({ sticker, conversationId, response: data });
        } catch {
          // O WhatsApp já aceitou o envio. O socket reconciliará a interface
          // mesmo que um refresh local falhe neste instante.
        }
      }
    } catch (error) {
      const message = error?.message || 'Não foi possível enviar a figurinha.';
      setStatus(message, 'error');
      notify(message);
    } finally {
      state.sendingId = null;
      button?.removeAttribute('aria-busy');
      setGridBusy(false);
    }
  }

  function setTriggerExpanded(expanded) {
    document.getElementById(IDS.trigger)?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function open() {
    setup();
    const overlay = document.getElementById(IDS.overlay);
    if (!overlay) return;
    state.previousFocus = document.activeElement;
    state.open = true;
    overlay.hidden = false;
    setTriggerExpanded(true);
    document.getElementById(IDS.close)?.focus();
    loadStickers();
  }

  function close() {
    const overlay = document.getElementById(IDS.overlay);
    if (!overlay) return;
    state.open = false;
    overlay.hidden = true;
    setTriggerExpanded(false);
    if (state.previousFocus && typeof state.previousFocus.focus === 'function') state.previousFocus.focus();
    state.previousFocus = null;
  }

  function uploadNewImage() {
    close();
    document.getElementById('stickerInput')?.click();
  }

  function bindEvents() {
    const overlay = document.getElementById(IDS.overlay);
    document.getElementById(IDS.close)?.addEventListener('click', close);
    document.getElementById(IDS.upload)?.addEventListener('click', uploadNewImage);
    overlay?.addEventListener('click', event => {
      if (event.target === overlay) close();
    });
    document.addEventListener('keydown', event => {
      if (!state.open) return;
      if (event.key === 'Escape') {
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const palette = document.getElementById(IDS.palette);
      const focusable = [...(palette?.querySelectorAll('button:not(:disabled)') || [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  function configure(options = {}) {
    state.config = { ...state.config, ...options };
  }

  function setup() {
    if (state.initialized || !document.body) return;
    state.initialized = true;
    injectStyles();
    document.body.appendChild(buildPalette());
    bindEvents();
  }

  window.openStickerLibrary = open;
  window.closeStickerLibrary = close;
  window.StickerLibrary = Object.freeze({ open, close, refresh: loadStickers, configure });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true });
  else setup();
})();
