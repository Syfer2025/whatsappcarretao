/* global window, document, Notification */
(function initChatNotifications(global) {
  'use strict';

  let audioContext = null;
  let soundEnabled = true;
  const activeSystemNotifications = new Set();

  function ensureStyles() {
    if (document.getElementById('chatNotificationStyles')) return;
    const style = document.createElement('style');
    style.id = 'chatNotificationStyles';
    style.textContent = `
      .chat-notification-stack{position:fixed;right:22px;top:22px;z-index:12000;display:flex;flex-direction:column;gap:10px;width:min(360px,calc(100vw - 32px));pointer-events:none}
      .chat-notification-card{pointer-events:auto;background:#fff;border:1px solid #dfe7e2;border-left:4px solid #25d366;border-radius:12px;padding:13px 14px;box-shadow:0 16px 42px rgba(15,23,42,.18);display:grid;grid-template-columns:38px 1fr 24px;gap:11px;align-items:center;cursor:pointer;transform:translateY(-16px);opacity:0;transition:.22s ease;color:#111b21}
      .chat-notification-card.show{transform:translateY(0);opacity:1}
      .chat-notification-avatar{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#dcfce7;color:#166534;font-weight:800;font-size:14px;overflow:hidden}
      .chat-notification-avatar img{width:100%;height:100%;object-fit:cover}
      .chat-notification-copy{min-width:0}.chat-notification-title{font-size:13px;font-weight:750;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.chat-notification-body{margin-top:3px;color:#667781;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .chat-notification-close{border:0;background:transparent;color:#8696a0;font-size:20px;cursor:pointer;line-height:1;padding:2px}
    `;
    document.head.appendChild(style);
  }

  function ensureStack() {
    ensureStyles();
    let stack = document.getElementById('chatNotificationStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'chatNotificationStack';
      stack.className = 'chat-notification-stack';
      document.body.appendChild(stack);
    }
    return stack;
  }

  function getAudioContext() {
    if (!audioContext) {
      const AudioContextClass = global.AudioContext || global.webkitAudioContext;
      if (AudioContextClass) audioContext = new AudioContextClass();
    }
    return audioContext;
  }

  async function unlockSound() {
    try {
      const context = getAudioContext();
      if (context?.state === 'suspended') await context.resume();
    } catch {}
  }

  function playSound() {
    if (!soundEnabled) return;
    try {
      const context = getAudioContext();
      if (!context || context.state !== 'running') return;
      const now = context.currentTime;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
      gain.connect(context.destination);
      [880, 1174].forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        oscillator.connect(gain);
        oscillator.start(now + index * 0.09);
        oscillator.stop(now + 0.24 + index * 0.09);
      });
    } catch {}
  }

  function removeCard(card) {
    card.classList.remove('show');
    window.setTimeout(() => card.remove(), 220);
  }

  function clear() {
    for (const notification of activeSystemNotifications) {
      try { notification.close(); } catch {}
    }
    activeSystemNotifications.clear();
    document.getElementById('chatNotificationStack')?.replaceChildren();
  }

  function showInApp(event, onOpen) {
    const stack = ensureStack();
    const card = document.createElement('div');
    card.className = 'chat-notification-card';
    const title = String(event?.title || 'Nova mensagem');
    const body = String(event?.body || 'Você recebeu uma nova mensagem');
    const initials = title.trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || 'WA';

    const avatar = document.createElement('div');
    avatar.className = 'chat-notification-avatar';
    if (event?.profilePicUrl) {
      const image = document.createElement('img');
      image.src = event.profilePicUrl;
      image.alt = '';
      image.addEventListener('error', () => { avatar.textContent = initials; }, { once: true });
      avatar.appendChild(image);
    } else {
      avatar.textContent = initials;
    }

    const copy = document.createElement('div');
    copy.className = 'chat-notification-copy';
    const heading = document.createElement('div');
    heading.className = 'chat-notification-title';
    heading.textContent = title;
    const preview = document.createElement('div');
    preview.className = 'chat-notification-body';
    preview.textContent = body;
    copy.append(heading, preview);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'chat-notification-close';
    close.setAttribute('aria-label', 'Fechar notificação');
    close.textContent = '×';
    close.addEventListener('click', clickEvent => {
      clickEvent.stopPropagation();
      removeCard(card);
    });

    card.append(avatar, copy, close);
    card.addEventListener('click', () => {
      if (typeof onOpen === 'function') onOpen(event);
      removeCard(card);
    });
    stack.prepend(card);
    while (stack.children.length > 4) stack.lastElementChild.remove();
    window.requestAnimationFrame(() => card.classList.add('show'));
    window.setTimeout(() => removeCard(card), 7000);
  }

  async function requestPermission() {
    soundEnabled = true;
    await unlockSound();
    if ('Notification' in global && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch {}
    }
  }

  function show(event, options = {}) {
    const isCurrentConversation = Number(options.currentConversationId) === Number(event?.conversationId);
    const isActivelyViewing = document.visibilityState === 'visible' && isCurrentConversation;
    showInApp(event, options.onOpen);
    if (!isActivelyViewing) playSound();

    if (!('Notification' in global) || Notification.permission !== 'granted' || isActivelyViewing) return;
    const notification = new Notification(event?.title || 'Nova mensagem', {
      body: event?.body || '',
      icon: event?.profilePicUrl || undefined,
      tag: `conversation-${event?.conversationId || 'new'}`
    });
    activeSystemNotifications.add(notification);
    notification.onclose = () => activeSystemNotifications.delete(notification);
    notification.onclick = () => {
      global.focus();
      if (typeof options.onOpen === 'function') options.onOpen(event);
      activeSystemNotifications.delete(notification);
      notification.close();
    };
  }

  document.addEventListener('pointerdown', unlockSound, { once: true, passive: true });
  global.addEventListener('pagehide', clear);
  global.addEventListener('beforeunload', clear);

  global.ChatNotifications = {
    requestPermission,
    show,
    clear,
    setSoundEnabled(value) { soundEnabled = Boolean(value); }
  };
})(window);
