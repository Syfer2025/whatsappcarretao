/* global window, document, localStorage */
(function initChatShell() {
  'use strict';

  const NAV_STORAGE_KEY = 'chatNavCollapsed';

  function nav() {
    return document.querySelector('.app-nav');
  }

  function setNavCollapsed(collapsed, { persist = true } = {}) {
    nav()?.classList.toggle('collapsed', Boolean(collapsed));
    if (!persist) return;
    try { localStorage.setItem(NAV_STORAGE_KEY, collapsed ? '1' : '0'); } catch {}
  }

  function toggleNav() {
    const navigation = nav();
    if (navigation) setNavCollapsed(!navigation.classList.contains('collapsed'));
  }

  function openConversation() {
    document.body.classList.add('chat-open');
  }

  function closeConversation() {
    document.body.classList.remove('chat-open');
  }

  // A troca de login no mesmo perfil não pode deixar o DOM de uma empresa no
  // back/forward cache. Apague o conteúdo antes que o navegador congele a
  // página e, se ela for restaurada, force uma nova autenticação/carregamento.
  function clearSensitiveDom() {
    const selectors = [
      '.conv-list',
      '#messagesList',
      '#chatAvatarSlot',
      '#chatName',
      '#chatPhone',
      '#forwardDestinationList',
      '#filePreview',
      '#replyPreview',
      '#recordStatus',
      '#conversationProfileContent',
      '#contactDirectoryResults',
      '#supportWidgetMessages',
      '#supportWidgetFeedback',
      '#supportWidgetFileName'
    ];
    for (const element of document.querySelectorAll(selectors.join(','))) {
      element.replaceChildren();
    }
    for (const field of document.querySelectorAll('input[type="search"], input[type="text"], input[type="tel"], textarea')) {
      field.value = '';
    }
    document.body.classList.remove('chat-open');
  }

  function reloadRestoredSession(event) {
    if (event.persisted) window.location.reload();
  }

  function bind() {
    try { setNavCollapsed(localStorage.getItem(NAV_STORAGE_KEY) === '1', { persist: false }); } catch {}
    document.addEventListener('click', event => {
      if (event.target.closest('[data-chat-nav-toggle]')) {
        event.preventDefault();
        toggleNav();
      }
      if (event.target.closest('[data-chat-mobile-back]')) {
        event.preventDefault();
        closeConversation();
      }
    });
  }

  window.ChatShell = { setNavCollapsed, toggleNav, openConversation, closeConversation };
  window.addEventListener('pagehide', clearSensitiveDom);
  window.addEventListener('pageshow', reloadRestoredSession);
  window.ChatShell.clearSensitiveDom = clearSensitiveDom;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
