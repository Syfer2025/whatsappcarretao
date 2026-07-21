/* global window, document, localStorage */
/*
 * theme.js — controlador de tema (claro/escuro) compartilhado por todas as páginas.
 *
 * Responsabilidades:
 *  - Aplicar o tema em <html data-theme="dark"> (ou remover o atributo no claro).
 *  - Persistir a escolha do usuário em localStorage (chave "theme"), a mesma em
 *    todas as páginas => a preferência vale para qualquer usuário/tela.
 *  - Respeitar prefers-color-scheme quando o usuário ainda não escolheu.
 *  - Sincronizar entre abas/páginas abertas (evento "storage") e reagir a mudanças
 *    do tema do sistema operacional.
 *  - Ligar automaticamente qualquer controle marcado com [data-theme-toggle] e,
 *    quando a página não tem um controle próprio, injetar um botão flutuante.
 *
 * Para evitar "flash" de tema errado, cada página também tem um pequeno snippet
 * inline no <head> que aplica o data-theme antes deste arquivo carregar.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'theme';
  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  var MOON = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
  var SUN = '<circle cx="12" cy="12" r="5"></circle>' +
    '<line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line>' +
    '<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>' +
    '<line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line>' +
    '<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';

  function stored() {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  }

  // Tema efetivo: escolha explícita do usuário ou, na ausência, o do sistema.
  function resolved() {
    var s = stored();
    if (s === 'dark' || s === 'light') return s;
    return (mql && mql.matches) ? 'dark' : 'light';
  }

  function apply(theme) {
    var root = document.documentElement;
    if (theme === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    syncControls(theme);
  }

  // Mantém rótulos e ícones de todos os controles coerentes com o tema atual.
  function syncControls(theme) {
    var isDark = theme === 'dark';
    var label = isDark ? 'Modo Claro' : 'Modo Escuro';
    var icon = isDark ? SUN : MOON;

    var labels = document.querySelectorAll('[data-theme-label], #themeBtnText');
    for (var i = 0; i < labels.length; i++) labels[i].textContent = label;

    var icons = document.querySelectorAll('.theme-icon, [data-theme-icon]');
    for (var j = 0; j < icons.length; j++) icons[j].innerHTML = icon;

    var fabs = document.querySelectorAll('.theme-fab');
    for (var k = 0; k < fabs.length; k++) {
      fabs[k].setAttribute('aria-label', label);
      fabs[k].setAttribute('title', label);
    }
  }

  function toggle() {
    var next = resolved() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(STORAGE_KEY, next); } catch {}
    apply(next);
  }

  // Exposto globalmente para compatibilidade com onclick="toggleTheme()" legado.
  window.toggleTheme = toggle;

  // Aplica o quanto antes (garante coerência mesmo se o snippet inline faltar).
  apply(resolved());

  // Sincroniza quando o tema muda em outra aba/página.
  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY) apply(resolved());
  });

  // Acompanha o tema do sistema enquanto não houver escolha explícita.
  if (mql) {
    var onSystemChange = function () { if (!stored()) apply(resolved()); };
    if (mql.addEventListener) mql.addEventListener('change', onSystemChange);
    else if (mql.addListener) mql.addListener(onSystemChange);
  }

  function injectFab() {
    // Não injeta se a página já tem um controle próprio ou pediu para não ter.
    if (document.querySelector('[data-theme-toggle]')) return;
    if (document.body && document.body.getAttribute('data-theme-fab') === 'off') return;

    var style = document.createElement('style');
    style.textContent =
      '.theme-fab{position:fixed;bottom:20px;right:20px;z-index:2147483000;width:46px;height:46px;' +
      'border-radius:50%;border:1px solid rgba(0,0,0,.12);background:#fff;color:#54656f;cursor:pointer;' +
      'display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.18);' +
      'transition:transform .2s,background .2s,color .2s,border-color .2s;}' +
      '.theme-fab:hover{transform:translateY(-2px) scale(1.05);color:#25d366;}' +
      '.theme-fab svg{width:20px;height:20px;}' +
      'html[data-theme="dark"] .theme-fab{background:#202c33;color:#e9edef;border-color:rgba(255,255,255,.14);' +
      'box-shadow:0 6px 20px rgba(0,0,0,.5);}' +
      'html[data-theme="dark"] .theme-fab:hover{color:#25d366;}';
    document.head.appendChild(style);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-fab';
    btn.setAttribute('data-theme-toggle', '');
    btn.innerHTML = '<svg class="theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></svg>';
    document.body.appendChild(btn);
  }

  function wire() {
    // Delegação: qualquer clique em [data-theme-toggle] alterna o tema.
    document.addEventListener('click', function (e) {
      var trigger = e.target && e.target.closest ? e.target.closest('[data-theme-toggle]') : null;
      if (trigger) { e.preventDefault(); toggle(); }
    });
    injectFab();
    syncControls(resolved());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
