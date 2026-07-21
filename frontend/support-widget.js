/* global window, document, fetch, FileReader */

(function supportWidgetBootstrap() {
  'use strict';

  const IDS = {
    style: 'supportWidgetStyles',
    trigger: 'supportWidgetTrigger',
    modal: 'supportWidgetModal',
    messages: 'supportWidgetMessages',
    feedback: 'supportWidgetFeedback',
    form: 'supportWidgetForm',
    input: 'supportWidgetInput',
    file: 'supportWidgetFile',
    fileName: 'supportWidgetFileName',
    attach: 'supportWidgetAttach',
    send: 'supportWidgetSend'
  };
  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
  const ALLOWED_ATTACHMENT_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf'
  ]);
  const state = {
    initialized: false,
    open: false,
    loading: false,
    sending: false,
    unavailable: false,
    thread: null,
    messages: [],
    hasMore: false,
    nextBeforeId: null,
    loadingOlder: false,
    socket: null,
    loadSequence: 0
  };

  function injectStyles() {
    if (document.getElementById(IDS.style)) return;
    const style = document.createElement('style');
    style.id = IDS.style;
    style.textContent = `
      [hidden] { display: none !important; }
      .support-widget-trigger {
        position: fixed; right: 22px; bottom: 22px; z-index: 1200;
        display: inline-flex; align-items: center; gap: 9px;
        border: 0; border-radius: 999px; padding: 12px 17px;
        color: #fff; background: #128c7e; box-shadow: 0 10px 30px rgba(15, 23, 42, .24);
        font: 700 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
      }
      .support-widget-trigger:hover { background: #075e54; }
      .support-widget-trigger-badge, .help-badge {
        min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px;
        align-items: center; justify-content: center; background: #ef4444; color: #fff;
        font-size: 10px; font-weight: 800;
      }
      .support-widget-trigger-badge { display: inline-flex; }
      .help-badge { display: inline-flex; }
      .support-widget-overlay {
        position: fixed; inset: 0; z-index: 1300; display: flex; align-items: center;
        justify-content: center; padding: 18px; background: rgba(2, 8, 23, .55);
      }
      .support-widget-dialog {
        width: min(480px, 100%); height: min(680px, calc(100dvh - 36px));
        display: flex; flex-direction: column; overflow: hidden; border-radius: 18px;
        border: 1px solid rgba(148, 163, 184, .28); background: #f8fafc;
        box-shadow: 0 28px 70px rgba(2, 8, 23, .35);
        color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .support-widget-header {
        flex: none; display: flex; align-items: center; justify-content: space-between;
        gap: 16px; padding: 17px 19px; background: #0f172a; color: #fff;
      }
      .support-widget-title { margin: 0; font-size: 16px; }
      .support-widget-subtitle { margin: 3px 0 0; color: #cbd5e1; font-size: 11.5px; }
      .support-widget-close {
        width: 34px; height: 34px; flex: none; border: 1px solid rgba(255,255,255,.16);
        border-radius: 50%; background: rgba(255,255,255,.06); color: #fff;
        font-size: 22px; line-height: 1; cursor: pointer;
      }
      .support-widget-messages {
        flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column;
        gap: 10px; padding: 18px; background: #efeae2;
      }
      .support-widget-empty { margin: auto; max-width: 290px; color: #64748b; text-align: center; font-size: 13px; }
      .support-widget-load-older { align-self:center; border:1px solid #cbd5e1; border-radius:999px; padding:7px 12px; background:#fff; color:#475569; cursor:pointer; font-size:11px; font-weight:700; }
      .support-widget-bubble {
        max-width: 84%; align-self: flex-start; padding: 9px 11px; border-radius: 11px;
        border-top-left-radius: 3px; background: #fff; color: #0f172a;
        box-shadow: 0 1px 2px rgba(15, 23, 42, .12); overflow-wrap: anywhere;
        white-space: pre-wrap; font-size: 13.5px; line-height: 1.45;
      }
      .support-widget-bubble.tenant {
        align-self: flex-end; border-top-left-radius: 11px; border-top-right-radius: 3px;
        background: #d9fdd3;
      }
      .support-widget-time { margin-top: 5px; color: #64748b; text-align: right; font-size: 9.5px; }
      .support-widget-media { display: block; margin-bottom: 6px; color: #075e54; font-weight: 700; text-decoration: none; }
      .support-widget-media img { display: block; max-width: 100%; max-height: 280px; border-radius: 8px; object-fit: contain; }
      .support-widget-feedback { flex: none; min-height: 0; padding: 0 14px; background: #fff; color: #b91c1c; font-size: 12px; }
      .support-widget-feedback:not(:empty) { padding-top: 9px; }
      .support-widget-file-name {
        flex: none; min-height: 0; padding: 0 14px; overflow: hidden; background: #fff;
        color: #475569; text-overflow: ellipsis; white-space: nowrap; font-size: 11px;
      }
      .support-widget-file-name:not(:empty) { padding-top: 8px; }
      .support-widget-form {
        flex: none; display: grid; grid-template-columns: 40px minmax(0, 1fr) auto;
        gap: 8px; align-items: end; padding: 11px 13px 13px; background: #fff;
        border-top: 1px solid #e2e8f0;
      }
      .support-widget-attach, .support-widget-send {
        height: 40px; border-radius: 9px; cursor: pointer; font-weight: 700;
      }
      .support-widget-attach { border: 1px solid #cbd5e1; background: #f8fafc; color: #475569; }
      .support-widget-send { border: 0; padding: 0 14px; background: #128c7e; color: #fff; }
      .support-widget-input {
        width: 100%; min-height: 40px; max-height: 120px; resize: vertical; padding: 9px 10px;
        border: 1px solid #cbd5e1; border-radius: 9px; outline: none; color: #0f172a;
        background: #fff; font: inherit;
      }
      .support-widget-input:focus { border-color: #25d366; box-shadow: 0 0 0 3px rgba(37,211,102,.14); }
      .support-widget-form :disabled { cursor: not-allowed; opacity: .55; }
      [data-theme="dark"] .support-widget-dialog { border-color: rgba(255,255,255,.1); background: #111b21; color: #e9edef; }
      [data-theme="dark"] .support-widget-messages { background: #0b141a; }
      [data-theme="dark"] .support-widget-bubble { background: #202c33; color: #e9edef; }
      [data-theme="dark"] .support-widget-bubble.tenant { background: #005c4b; }
      [data-theme="dark"] .support-widget-feedback,
      [data-theme="dark"] .support-widget-file-name,
      [data-theme="dark"] .support-widget-form { background: #111b21; }
      [data-theme="dark"] .support-widget-feedback { color: #fda4af; }
      [data-theme="dark"] .support-widget-file-name { color: #aebac1; }
      [data-theme="dark"] .support-widget-input,
      [data-theme="dark"] .support-widget-attach { background: #202c33; border-color: rgba(255,255,255,.14); color: #e9edef; }
      @media (max-width: 560px) {
        .support-widget-overlay { padding: 0; }
        .support-widget-dialog { width: 100%; height: 100dvh; border: 0; border-radius: 0; }
        .support-widget-trigger { right: 14px; bottom: 14px; }
      }
    `;
    document.head.appendChild(style);
  }

  function modalMarkup() {
    const overlay = document.createElement('div');
    overlay.id = IDS.modal;
    overlay.className = 'support-widget-overlay';
    overlay.hidden = true;
    overlay.setAttribute('role', 'presentation');
    overlay.innerHTML = `
      <section class="support-widget-dialog" role="dialog" aria-modal="true" aria-labelledby="supportWidgetTitle">
        <header class="support-widget-header">
          <div>
            <h2 class="support-widget-title" id="supportWidgetTitle">Suporte</h2>
            <p class="support-widget-subtitle">Conversa privada com o suporte da plataforma</p>
          </div>
          <button class="support-widget-close" type="button" aria-label="Fechar suporte">&times;</button>
        </header>
        <div class="support-widget-messages" id="${IDS.messages}" aria-live="polite"></div>
        <div class="support-widget-feedback" id="${IDS.feedback}" role="status" aria-live="polite"></div>
        <div class="support-widget-file-name" id="${IDS.fileName}"></div>
        <form class="support-widget-form" id="${IDS.form}">
          <input id="${IDS.file}" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden>
          <button class="support-widget-attach" id="${IDS.attach}" type="button" title="Anexar imagem ou PDF" aria-label="Anexar imagem ou PDF">📎</button>
          <textarea class="support-widget-input" id="${IDS.input}" rows="1" maxlength="5000" placeholder="Descreva como podemos ajudar" aria-label="Mensagem para o suporte"></textarea>
          <button class="support-widget-send" id="${IDS.send}" type="submit">Enviar</button>
        </form>
      </section>
    `;
    return overlay;
  }

  function floatingTriggerMarkup() {
    const button = document.createElement('button');
    button.id = IDS.trigger;
    button.className = 'support-widget-trigger';
    button.type = 'button';
    button.dataset.supportWidgetTrigger = 'true';
    button.innerHTML = `
      <span aria-hidden="true">💬</span>
      <span>Precisa de ajuda?</span>
      <span class="support-widget-trigger-badge" data-support-widget-badge hidden></span>
    `;
    return button;
  }

  function getModal() {
    return document.getElementById(IDS.modal);
  }

  function setFeedback(message, kind = 'error') {
    const feedback = document.getElementById(IDS.feedback);
    if (!feedback) return;
    feedback.textContent = message || '';
    feedback.dataset.kind = kind;
  }

  function setComposerDisabled(disabled) {
    for (const id of [IDS.input, IDS.file, IDS.attach, IDS.send]) {
      const element = document.getElementById(id);
      if (element) element.disabled = Boolean(disabled);
    }
  }

  function setUnreadBadge(value) {
    const count = Math.max(0, Number(value) || 0);
    const badges = document.querySelectorAll('.help-badge, [data-support-widget-badge]');
    for (const badge of badges) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.hidden = count === 0;
      badge.setAttribute('aria-label', `${count} mensagem(ns) de suporte não lida(s)`);
    }
  }

  function readCookie(name) {
    const prefix = `${name}=`;
    const item = String(document.cookie || '')
      .split(';')
      .map(part => part.trim())
      .find(part => part.startsWith(prefix));
    if (!item) return '';
    try {
      return decodeURIComponent(item.slice(prefix.length));
    } catch {
      return '';
    }
  }

  async function csrfToken() {
    const existing = readCookie('csrf_token');
    if (existing) return existing;
    const response = await fetch('/api/csrf-token', { credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.csrfToken) throw new Error('Não foi possível validar a sessão');
    return data.csrfToken;
  }

  async function request(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    const normalizedMethod = String(method).toUpperCase();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod)) {
      headers['X-CSRF-Token'] = await csrfToken();
    }
    return fetch(path, {
      method: normalizedMethod,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  async function responseData(response) {
    return response.json().catch(() => ({}));
  }

  function accessError(status, data) {
    if (status === 401) return 'Sua sessão expirou. Entre novamente para falar com o suporte.';
    if (status === 403) return 'Este canal está disponível para administradores da empresa.';
    return data?.error || 'Não foi possível carregar o suporte. Tente novamente.';
  }

  function parseDate(value) {
    if (!value) return null;
    const text = String(value);
    const date = new Date(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDateTime(value) {
    const date = parseDate(value);
    if (!date) return '';
    return date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function safeMediaUrl(value) {
    try {
      const url = new URL(String(value || ''), window.location.origin);
      if (url.origin !== window.location.origin || !url.pathname.startsWith('/support-media/')) return '';
      return `${url.pathname}${url.search}`;
    } catch {
      return '';
    }
  }

  function messageMedia(message) {
    const url = safeMediaUrl(message.media_url);
    if (!url) return null;
    if (message.media_type === 'audio' && window.ChatAudioPlayer) {
      return window.ChatAudioPlayer.createElement(document, url, {
        key: `support:${message.id || url}`,
        label: message.media_filename || 'Áudio do suporte'
      });
    }
    const link = document.createElement('a');
    link.className = 'support-widget-media';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    if (message.media_type === 'image') {
      const image = document.createElement('img');
      image.src = url;
      image.alt = message.media_filename || 'Imagem anexada';
      link.appendChild(image);
    } else {
      link.textContent = `📎 ${message.media_filename || 'Abrir anexo'}`;
    }
    return link;
  }

  function renderMessages({ scrollToBottom = true } = {}) {
    const container = document.getElementById(IDS.messages);
    if (!container) return;
    container.replaceChildren();
    if (state.loading && !state.messages.length) {
      const loading = document.createElement('div');
      loading.className = 'support-widget-empty';
      loading.textContent = 'Carregando conversa…';
      container.appendChild(loading);
      return;
    }
    if (!state.messages.length) {
      const empty = document.createElement('div');
      empty.className = 'support-widget-empty';
      empty.textContent = state.unavailable
        ? 'O suporte não está disponível para este perfil.'
        : 'Envie uma mensagem ou um print para iniciar o atendimento.';
      container.appendChild(empty);
      return;
    }
    if (state.hasMore) {
      const loadOlder = document.createElement('button');
      loadOlder.className = 'support-widget-load-older';
      loadOlder.type = 'button';
      loadOlder.dataset.supportLoadOlder = 'true';
      loadOlder.disabled = state.loadingOlder;
      loadOlder.textContent = state.loadingOlder ? 'Carregando…' : 'Carregar mensagens anteriores';
      container.appendChild(loadOlder);
    }
    for (const message of state.messages) {
      const bubble = document.createElement('article');
      bubble.className = `support-widget-bubble ${message.sender_type === 'tenant' ? 'tenant' : 'super-admin'}`;
      const media = messageMedia(message);
      if (media) bubble.appendChild(media);
      if (message.content) {
        const content = document.createElement('div');
        content.textContent = message.content;
        bubble.appendChild(content);
      }
      const time = document.createElement('div');
      time.className = 'support-widget-time';
      time.textContent = formatDateTime(message.created_at);
      bubble.appendChild(time);
      container.appendChild(bubble);
    }
    if (scrollToBottom) {
      window.requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
    }
  }

  async function markRead() {
    if (!state.thread || state.unavailable) return false;
    try {
      const response = await request('/api/support/thread/read', { method: 'PATCH' });
      const data = await responseData(response);
      if (!response.ok) {
        setFeedback(accessError(response.status, data));
        return false;
      }
      state.thread = data;
      setUnreadBadge(0);
      return true;
    } catch {
      setFeedback('A conversa abriu, mas não foi possível marcar as mensagens como lidas.');
      return false;
    }
  }

  async function loadThread({ markAsRead = state.open, silent = false } = {}) {
    const sequence = ++state.loadSequence;
    if (!silent) {
      state.loading = true;
      setFeedback('');
      renderMessages();
    }
    try {
      const response = await request('/api/support/thread');
      const data = await responseData(response);
      if (sequence !== state.loadSequence) return false;
      if (!response.ok) {
        state.loading = false;
        state.unavailable = response.status === 401 || response.status === 403;
        state.thread = null;
        state.messages = [];
        setUnreadBadge(0);
        setComposerDisabled(state.unavailable);
        setFeedback(accessError(response.status, data));
        renderMessages();
        return false;
      }
      state.unavailable = false;
      state.loading = false;
      state.thread = data.thread || null;
      state.messages = Array.isArray(data.messages) ? data.messages : [];
      state.hasMore = Boolean(data.has_more);
      state.nextBeforeId = data.next_before_id || null;
      setComposerDisabled(false);
      setUnreadBadge(state.thread?.tenant_unread_count || 0);
      setFeedback('');
      renderMessages();
      if (markAsRead && Number(state.thread?.tenant_unread_count || 0) > 0) await markRead();
      return true;
    } catch {
      if (sequence !== state.loadSequence) return false;
      state.loading = false;
      setFeedback('Sem conexão com o suporte. Verifique sua internet e tente novamente.');
      renderMessages();
      return false;
    } finally {
      if (sequence === state.loadSequence) state.loading = false;
    }
  }

  async function loadOlderMessages() {
    if (state.loadingOlder || !state.hasMore || !state.nextBeforeId) return;
    const container = document.getElementById(IDS.messages);
    const previousHeight = container?.scrollHeight || 0;
    state.loadingOlder = true;
    renderMessages({ scrollToBottom: false });
    try {
      const response = await request(`/api/support/thread?before_id=${encodeURIComponent(state.nextBeforeId)}`);
      const data = await responseData(response);
      if (!response.ok) throw new Error(accessError(response.status, data));
      const older = Array.isArray(data.messages) ? data.messages : [];
      const known = new Set(state.messages.map(message => Number(message.id)));
      state.messages = [...older.filter(message => !known.has(Number(message.id))), ...state.messages];
      state.hasMore = Boolean(data.has_more);
      state.nextBeforeId = data.next_before_id || null;
      renderMessages({ scrollToBottom: false });
      window.requestAnimationFrame(() => {
        if (container) container.scrollTop = Math.max(0, container.scrollHeight - previousHeight);
      });
    } catch (error) {
      setFeedback(error?.message || 'Não foi possível carregar mensagens anteriores.');
    } finally {
      state.loadingOlder = false;
      renderMessages({ scrollToBottom: false });
    }
  }

  function fileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = () => reject(reader.error || new Error('Não foi possível ler o anexo'));
      reader.readAsDataURL(file);
    });
  }

  function selectedFile() {
    return document.getElementById(IDS.file)?.files?.[0] || null;
  }

  function validateFile(file) {
    if (!file) return '';
    if (!ALLOWED_ATTACHMENT_TYPES.has(String(file.type || '').toLowerCase())) {
      return 'Envie uma imagem JPG, PNG, WEBP ou um PDF.';
    }
    if (file.size > MAX_ATTACHMENT_BYTES) return 'O anexo deve ter no máximo 10 MB.';
    return '';
  }

  function updateFileName() {
    const file = selectedFile();
    const label = document.getElementById(IDS.fileName);
    if (!label) return;
    label.textContent = file ? `Anexo: ${file.name}` : '';
    const error = validateFile(file);
    if (error) setFeedback(error);
    else if (!state.unavailable) setFeedback('');
  }

  async function sendMessage(event) {
    event?.preventDefault();
    if (state.sending || state.unavailable) return;
    const input = document.getElementById(IDS.input);
    const fileInput = document.getElementById(IDS.file);
    const content = String(input?.value || '').trim();
    const file = selectedFile();
    const fileError = validateFile(file);
    if (fileError) {
      setFeedback(fileError);
      return;
    }
    if (!content && !file) {
      setFeedback('Digite uma mensagem ou escolha um anexo.');
      input?.focus();
      return;
    }

    state.sending = true;
    setComposerDisabled(true);
    setFeedback('');
    const sendButton = document.getElementById(IDS.send);
    if (sendButton) sendButton.textContent = 'Enviando…';
    try {
      const body = { content };
      if (file) {
        body.media = {
          filename: file.name,
          mimetype: file.type,
          size: file.size,
          data: await fileAsBase64(file)
        };
      }
      const response = await request('/api/support/messages', { method: 'POST', body });
      const data = await responseData(response);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) state.unavailable = true;
        throw new Error(accessError(response.status, data));
      }
      if (input) input.value = '';
      if (fileInput) fileInput.value = '';
      updateFileName();
      await loadThread({ markAsRead: true, silent: true });
    } catch (error) {
      setFeedback(error?.message || 'Não foi possível enviar a mensagem.');
    } finally {
      state.sending = false;
      setComposerDisabled(state.unavailable);
      if (sendButton) sendButton.textContent = 'Enviar';
    }
  }

  function open() {
    setup();
    const modal = getModal();
    if (!modal) return;
    state.open = true;
    modal.hidden = false;
    loadThread({ markAsRead: true });
    window.setTimeout(() => document.getElementById(IDS.input)?.focus(), 0);
  }

  function close() {
    const modal = getModal();
    if (!modal) return;
    state.open = false;
    modal.hidden = true;
  }

  function supportEvent(event) {
    if (state.thread && event?.threadId && Number(event.threadId) !== Number(state.thread.id)) return;
    loadThread({ markAsRead: state.open, silent: true });
  }

  function attachSocket(socket) {
    if (!socket || typeof socket.on !== 'function' || state.socket === socket) return false;
    if (state.socket && typeof state.socket.off === 'function') {
      state.socket.off('support:new', supportEvent);
      state.socket.off('connect', socketConnected);
      state.socket.off('auth:session-replaced', sessionReplaced);
    }
    state.socket = socket;
    socket.on('support:new', supportEvent);
    socket.on('connect', socketConnected);
    socket.on('auth:session-replaced', sessionReplaced);
    return true;
  }

  function sessionReplaced() {
    window.location.replace('/login.html?session=replaced');
  }

  function socketConnected() {
    loadThread({ markAsRead: state.open, silent: true });
  }

  function bindEvents() {
    const modal = getModal();
    document.querySelectorAll('[data-support-widget-trigger]')
      .forEach(trigger => trigger.addEventListener('click', open));
    modal?.querySelector('.support-widget-close')?.addEventListener('click', close);
    modal?.addEventListener('click', event => {
      if (event.target === modal) close();
    });
    document.getElementById(IDS.attach)?.addEventListener('click', () => {
      document.getElementById(IDS.file)?.click();
    });
    document.getElementById(IDS.file)?.addEventListener('change', updateFileName);
    document.getElementById(IDS.form)?.addEventListener('submit', sendMessage);
    document.getElementById(IDS.messages)?.addEventListener('click', event => {
      if (event.target?.closest?.('[data-support-load-older]')) loadOlderMessages();
    });
    document.getElementById(IDS.input)?.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage(event);
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && state.open) close();
    });
  }

  function setup() {
    if (state.initialized || !document.body) return;
    state.initialized = true;
    injectStyles();
    const existingAdminTrigger = document.querySelector('.help-btn[onclick*="openHelpModal"]');
    if (!existingAdminTrigger) document.body.appendChild(floatingTriggerMarkup());
    document.body.appendChild(modalMarkup());
    setUnreadBadge(0);
    bindEvents();
    loadThread({ markAsRead: false, silent: true });
  }

  window.openHelpModal = open;
  window.closeHelpModal = close;
  window.SupportWidget = Object.freeze({
    open,
    close,
    refresh: () => loadThread({ markAsRead: state.open }),
    attachSocket
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true });
  else setup();
})();
