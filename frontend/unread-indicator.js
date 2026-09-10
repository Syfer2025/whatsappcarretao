/* global window, document */
//
// Aviso permanente de mensagem não lida — para o admin e para os atendentes.
//
// O painel já mostrava um toast a cada mensagem nova, mas ele some em 7 segundos.
// Quem estava com a aba em segundo plano, em outra tela do sistema ou almoçando
// não tinha como saber que havia conversa esperando: era preciso olhar a lista
// item por item. Este módulo mantém o número à vista o tempo todo, em dois
// lugares que sobrevivem a isso:
//
//   1. no título da aba do navegador — visível mesmo com o painel em segundo
//      plano, que é justamente quando o toast não ajuda;
//   2. em qualquer elemento marcado com [data-unread-badge] — cada painel decide
//      onde quer o número, e este arquivo não precisa conhecer o HTML dos dois.
//
// O total vem do servidor (/api/conversations/unread-count) e não da soma da
// lista carregada: a lista é paginada, então somá-la travaria o número no
// tamanho da página bem na hora em que há mais coisa acumulada. O servidor
// aplica a mesma visibilidade da listagem — o atendente conta só o que lhe foi
// atribuído, o admin conta tudo.
(function initUnreadIndicator(global) {
  'use strict';

  const TITLE_PREFIX = /^\(\d+\+?\)\s*/;

  let fetcher = null;
  let running = false;
  let queued = false;
  let lastTotals = { conversations: 0, messages: 0 };

  // O título é reescrito pelo branding depois que a página carrega, então o
  // texto base é sempre relido do documento — guardar uma cópia faria o nome do
  // sistema voltar ao valor antigo na primeira atualização do contador.
  // O estilo do badge mora aqui, e não no CSS de cada painel, para o admin e o
  // atendente não divergirem com o tempo.
  function ensureStyles() {
    if (document.getElementById('unreadIndicatorStyles')) return;
    const style = document.createElement('style');
    style.id = 'unreadIndicatorStyles';
    style.textContent = `
      [data-unread-badge]{margin-left:auto;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:#25d366;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;line-height:1;flex-shrink:0}
      .app-nav.collapsed [data-unread-badge]{margin-left:0;position:absolute;top:6px;right:6px;min-width:16px;height:16px;padding:0 4px;font-size:10px}
      .app-nav.collapsed .app-nav-item{position:relative}
    `;
    document.head.appendChild(style);
  }

  function baseTitle() {
    return String(document.title || '').replace(TITLE_PREFIX, '');
  }

  function asLabel(count) {
    return count > 99 ? '99+' : String(count);
  }

  function applyTitle(count) {
    const base = baseTitle();
    document.title = count > 0 ? `(${asLabel(count)}) ${base}` : base;
  }

  function applyBadges(count) {
    for (const node of document.querySelectorAll('[data-unread-badge]')) {
      node.textContent = asLabel(count);
      // display direto, e não o atributo `hidden`: os badges herdam
      // display:inline-flex do CSS dos painéis, que venceria o `hidden`.
      node.style.display = count > 0 ? '' : 'none';
      if (count > 0) {
        node.setAttribute('aria-label', count === 1
          ? '1 mensagem não lida'
          : `${count} mensagens não lidas`);
      } else {
        node.removeAttribute('aria-label');
      }
    }
  }

  function apply(totals) {
    lastTotals = {
      conversations: Number(totals?.conversations || 0),
      messages: Number(totals?.messages || 0)
    };
    applyTitle(lastTotals.messages);
    applyBadges(lastTotals.messages);
  }

  async function run() {
    if (!fetcher) return;
    try {
      const response = await fetcher('/api/conversations/unread-count');
      if (!response?.ok) return;
      apply(await response.json());
    } catch {
      // Sem rede ou sessão expirada: manter o último número conhecido é melhor
      // do que zerar e dar a impressão de que não há nada para ler.
    }
  }

  // Os eventos de tempo real chegam em rajada (mensagem nova, conversa
  // atualizada, notificação — tudo junto). Sem esta serialização, uma única
  // mensagem dispararia três consultas concorrentes ao servidor.
  async function refresh() {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      await run();
      while (queued) {
        queued = false;
        await run();
      }
    } finally {
      running = false;
    }
  }

  function configure(options = {}) {
    ensureStyles();
    if (typeof options.api === 'function') fetcher = options.api;
    refresh();
  }

  // Voltar para a aba é o momento em que o número precisa estar certo: enquanto
  // ela esteve escondida o navegador pode ter suspendido timers e sockets.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  global.UnreadIndicator = {
    configure,
    refresh,
    clear() { apply({ conversations: 0, messages: 0 }); },
    getTotals() { return { ...lastTotals }; }
  };
})(window);
