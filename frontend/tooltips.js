/* global document, window, MutationObserver */

(function () {
  const TARGET_SELECTOR = [
    'button',
    '[role="button"]',
    '.app-nav-item',
    '.wp-nav-item',
    '.app-nav-status'
  ].join(',');

  const rules = [
    ['importBtn', 'Sincroniza conversas e mensagens antigas do WhatsApp em segundo plano.'],
    ['favoritesToggle', 'Alterna entre a lista normal de conversas e as mensagens favoritas.'],
    ['topbarAction', 'Abre o cadastro de um novo cliente.'],
    ['sendBtn', 'Envia a mensagem digitada e os anexos selecionados.'],
    ['recordBtn', 'Inicia a gravação de um áudio para enviar na conversa.'],
    ['stopRecordBtn', 'Para a gravação e prepara o áudio para envio.'],
    ['loadOlderBtn', 'Carrega mensagens mais antigas desta conversa.'],
    ['mediaFilter', 'Filtra a conversa por tipo de mídia.']
  ];

  const onclickTips = [
    ['requestNotificationPermission', 'Ativa alertas visuais e som para novas mensagens.'],
    ['syncCurrentConversation', 'Busca no WhatsApp as mensagens mais recentes da conversa aberta.'],
    ['performGlobalSearch', 'Busca conversas e mensagens pelo texto digitado.'],
    ['switchTab(\'conversations\'', 'Mostra conversas ainda não encaminhadas para vendedor.'],
    ['switchTab(\'forwarded\'', 'Mostra conversas que já foram encaminhadas.'],
    ['switchTab(\'favorites\'', 'Mostra mensagens marcadas como favoritas.'],
    ['switchTab(\'archived\'', 'Mostra conversas arquivadas e sincronizadas com o WhatsApp.'],
    ['toggleFavoritesView', 'Mostra ou oculta a lista de mensagens favoritas.'],
    ['openNewConversation', 'Inicia uma conversa usando um contato salvo ou telefone.'],
    ['openConversationProfile', 'Abre os dados do contato ou os participantes do grupo.'],
    ['toggleCurrentConversationArchive', 'Arquiva ou desarquiva esta conversa também no WhatsApp.'],
    ['setConversationArchived', 'Arquiva ou desarquiva esta conversa também no WhatsApp.'],
    ['loadOlderMessages', 'Carrega mensagens mais antigas desta conversa.'],
    ['cancelReply', 'Cancela a resposta citada antes do envio.'],
    ['fileInput', 'Anexa arquivos, fotos, vídeos ou documentos à resposta.'],
    ['toggleEmojiPicker', 'Abre ou fecha o seletor de emojis.'],
    ['startRecording', 'Começa a gravar um áudio.'],
    ['stopRecording', 'Encerra a gravação de áudio.'],
    ['sendMessage', 'Envia a resposta para o WhatsApp.'],
    ['toggleConversationPinned', 'Fixa ou desafixa esta conversa no topo da sua lista.'],
    ['markConversationUnread', 'Marca esta conversa como não lida para você.'],
    ['toggleStar', 'Adiciona ou remove esta mensagem das favoritas.'],
    ['replyToMessage', 'Prepara uma resposta citando esta mensagem.'],
    ['insertEmoji', 'Insere este emoji no campo de resposta.'],
    ['removeSelectedFile', 'Remove este anexo antes de enviar.'],
    ['cancelRecording', 'Cancela a gravação de áudio atual.'],
    ['openNewUser', 'Abre o formulário para criar um usuário.'],
    ['editUser', 'Edita dados, acesso e setor deste usuário.'],
    ['saveUser', 'Salva o usuário com os dados preenchidos.'],
    ['openNewSector', 'Abre o formulário para criar um setor.'],
    ['editSector', 'Edita o nome e o status deste setor.'],
    ['saveSector', 'Salva o setor com os dados preenchidos.'],
    ['connectMyWhatsApp', 'Tenta conectar ou reconectar o WhatsApp desta conta.'],
    ['disconnectMyWhatsApp', 'Desconecta esta sessão do WhatsApp.'],
    ['importHistory', 'Sincroniza o histórico do WhatsApp em segundo plano.'],
    ['startCheckout', 'Abre o pagamento da assinatura.'],
    ['openBillingPortal', 'Abre o portal para gerenciar pagamento e assinatura.'],
    ['openCreateModal', 'Abre o cadastro de um novo cliente.'],
    ['submitCreate', 'Cria o cliente com os dados preenchidos.'],
    ['openEditModal', 'Abre a edição deste cliente.'],
    ['submitEdit', 'Salva as alterações deste cliente.'],
    ['setBillingStatus', 'Altera o status de cobrança deste cliente.'],
    ['toggleComp', 'Ativa ou remove a cortesia deste cliente.'],
    ['resetDb', 'Limpa e reinicia o banco de dados deste cliente.'],
    ['deleteTenant', 'Exclui este cliente da plataforma.'],
    ['loadStripeOverview', 'Verifica novamente a configuração do Stripe.'],
    ['closeMediaPreview', 'Fecha a visualização da mídia aberta.'],
    ['closeModal', 'Fecha esta janela sem continuar.'],
    ['logout', 'Sai da sua conta neste navegador.']
  ];

  const textTips = new Map([
    ['Buscar', 'Busca conversas e mensagens pelo texto digitado.'],
    ['Reimportar histórico', 'Sincroniza conversas e mensagens antigas do WhatsApp em segundo plano.'],
    ['Notificações', 'Ativa alertas visuais e som para novas mensagens.'],
    ['Nova conversa', 'Inicia uma conversa usando um contato salvo ou telefone.'],
    ['Sincronizar mensagens', 'Busca no WhatsApp as mensagens mais recentes da conversa aberta.'],
    ['Não encaminhadas', 'Mostra conversas ainda não encaminhadas para vendedor.'],
    ['Encaminhadas', 'Mostra conversas que já foram encaminhadas.'],
    ['Favoritas', 'Mostra mensagens marcadas como favoritas.'],
    ['Arquivadas', 'Mostra conversas arquivadas e sincronizadas com o WhatsApp.'],
    ['Arquivar', 'Arquiva esta conversa também no WhatsApp.'],
    ['Desarquivar', 'Tira esta conversa do arquivo também no WhatsApp.'],
    ['Carregar antigas', 'Carrega mensagens mais antigas desta conversa.'],
    ['Enviar', 'Envia a resposta para o WhatsApp.'],
    ['Salvar', 'Salva os dados preenchidos.'],
    ['Cancelar', 'Cancela esta ação e fecha a janela.'],
    ['Remover', 'Remove este item antes de continuar.'],
    ['Cancelar áudio', 'Cancela a gravação de áudio atual.'],
    ['Conectar WhatsApp', 'Inicia a conexão do WhatsApp desta conta.'],
    ['Tentar novamente', 'Tenta conectar o WhatsApp novamente.'],
    ['Desconectar', 'Desconecta esta sessão do WhatsApp.'],
    ['Assinar / Pagar agora', 'Abre a página de pagamento da assinatura.'],
    ['Gerenciar forma de pagamento', 'Abre o portal para alterar pagamento e assinatura.'],
    ['+ Novo cliente', 'Abre o cadastro de um novo cliente.'],
    ['Já configurei, verificar de novo', 'Verifica novamente a configuração do Stripe.'],
    ['Criar', 'Cria o registro com os dados preenchidos.'],
    ['Ativar', 'Reativa a cobrança e o acesso deste cliente.'],
    ['Suspender', 'Suspende o acesso deste cliente.'],
    ['Tirar cortesia', 'Remove a cortesia deste cliente.'],
    ['Dar cortesia', 'Libera cortesia para este cliente.'],
    ['Editar', 'Abre a edição deste item.'],
    ['Resetar BD', 'Limpa e reinicia o banco de dados deste cliente.'],
    ['Excluir', 'Exclui este item definitivamente.'],
    ['Sair', 'Sai da sua conta neste navegador.']
  ]);

  const navTips = new Map([
    ['atendimento', 'Abre a fila de conversas e atendimento.'],
    ['users', 'Gerencia usuários e vendedores.'],
    ['sectors', 'Gerencia setores de atendimento.'],
    ['connection', 'Mostra e controla a conexão do WhatsApp.'],
    ['financeiro', 'Mostra assinatura, cobrança e pagamento.'],
    ['dashboard', 'Mostra o resumo geral da plataforma.'],
    ['clients', 'Gerencia os clientes da plataforma.'],
    ['audit', 'Mostra eventos de auditoria e segurança.'],
    ['stripe', 'Mostra o status da integração com Stripe.']
  ]);

  let tooltipEl = null;
  let activeTarget = null;

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function visibleText(element) {
    return normalizeText(element.textContent).replace(/[×✕]/g, '').trim();
  }

  function deriveTooltip(element) {
    const existing = element.getAttribute('data-tooltip');
    if (existing) return existing;

    const id = element.id || '';
    const idRule = rules.find(([ruleId]) => ruleId === id);
    if (idRule) return idRule[1];

    const section = element.getAttribute('data-section') || element.getAttribute('data-view');
    if (section && navTips.has(section)) return navTips.get(section);

    const onclick = element.getAttribute('onclick') || '';
    const onclickRule = onclickTips.find(([needle]) => onclick.includes(needle));
    if (onclickRule) return onclickRule[1];

    const text = visibleText(element);
    if (textTips.has(text)) return textTips.get(text);

    const title = element.getAttribute('title');
    if (title) return title;

    const aria = element.getAttribute('aria-label');
    if (aria) return aria;

    if (element.classList.contains('toast-close')) return 'Fecha este aviso.';
    if (element.classList.contains('media-preview-close')) return 'Fecha a visualização da mídia.';
    if (text.length === 1 && /[😀-🙏⭐★☆●↩📎☺🎙■]/u.test(text)) return 'Executa esta ação na conversa.';

    return '';
  }

  function ensureTooltipElement() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'uiButtonTooltip';
    tooltipEl.className = 'ui-tooltip';
    tooltipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function installStyles() {
    if (document.getElementById('uiTooltipStyles')) return;
    const style = document.createElement('style');
    style.id = 'uiTooltipStyles';
    style.textContent = `
      .ui-tooltip {
        position: fixed;
        left: 0;
        top: 0;
        z-index: 30000;
        max-width: min(280px, calc(100vw - 24px));
        padding: 8px 12px;
        border-radius: 8px;
        background: #111b21;
        color: #fff;
        font: 600 12.5px/1.35 Inter, -apple-system, BlinkMacSystemFont, sans-serif;
        box-shadow: 0 10px 25px rgba(0, 0, 0, .2);
        opacity: 0;
        transform: translate3d(-9999px, -9999px, 0);
        pointer-events: none;
        transition: opacity .25s ease-out;
        white-space: normal;
        letter-spacing: 0.2px;
      }
      .ui-tooltip.open { opacity: 1; }
      .ui-tooltip::after {
        content: '';
        position: absolute;
        left: var(--arrow-left, 50%);
        width: 10px;
        height: 10px;
        background: #111b21;
        transform: translateX(-50%) rotate(45deg);
        border-radius: 2px;
      }
      .ui-tooltip[data-placement="top"]::after { bottom: -4px; }
      .ui-tooltip[data-placement="bottom"]::after { top: -4px; }
    `;
    document.head.appendChild(style);
  }

  function annotateTarget(element) {
    if (!element || element.dataset.tooltipReady === '1') return;
    const text = deriveTooltip(element);
    if (!text) return;
    element.dataset.tooltip = text;
    element.dataset.tooltipReady = '1';
    if (!element.getAttribute('aria-label') && !visibleText(element)) {
      element.setAttribute('aria-label', text);
    }
    if (element.getAttribute('title')) {
      element.dataset.nativeTitle = element.getAttribute('title');
      element.removeAttribute('title');
    }
  }

  function annotateAll(root = document) {
    root.querySelectorAll(TARGET_SELECTOR).forEach(annotateTarget);
  }

  function positionTooltip(target) {
    const tooltip = ensureTooltipElement();
    const rect = target.getBoundingClientRect();
    tooltip.style.transform = 'translate3d(0, 0, 0)';
    const tipRect = tooltip.getBoundingClientRect();
    const margin = 8;
    const placement = rect.top >= tipRect.height + 14 ? 'top' : 'bottom';
    let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
    left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));
    const top = placement === 'top'
      ? rect.top - tipRect.height - 9
      : rect.bottom + 9;
    const arrowLeft = rect.left + (rect.width / 2) - left;
    tooltip.dataset.placement = placement;
    tooltip.style.setProperty('--arrow-left', `${Math.max(10, Math.min(arrowLeft, tipRect.width - 10))}px`);
    tooltip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  function showTooltip(target) {
    annotateTarget(target);
    const text = target?.dataset?.tooltip;
    if (!text || target.disabled) return;
    activeTarget = target;
    const tooltip = ensureTooltipElement();
    tooltip.textContent = text;
    tooltip.classList.add('open');
    positionTooltip(target);
  }

  function hideTooltip() {
    if (!tooltipEl) return;
    tooltipEl.classList.remove('open');
    tooltipEl.style.transform = 'translate3d(-9999px, -9999px, 0)';
    activeTarget = null;
  }

  function findTarget(event) {
    return event.target?.closest?.(TARGET_SELECTOR);
  }

  function init() {
    installStyles();
    annotateAll();
    document.addEventListener('pointerover', event => {
      const target = findTarget(event);
      if (!target || target === activeTarget) return;
      showTooltip(target);
    });
    document.addEventListener('pointerout', event => {
      if (!activeTarget) return;
      const next = event.relatedTarget;
      if (!next || !activeTarget.contains(next)) hideTooltip();
    });
    document.addEventListener('focusin', event => {
      const target = findTarget(event);
      if (target) showTooltip(target);
    });
    document.addEventListener('focusout', event => {
      if (activeTarget && event.target === activeTarget) hideTooltip();
    });
    document.addEventListener('click', hideTooltip, true);
    window.addEventListener('scroll', hideTooltip, true);
    window.addEventListener('resize', () => {
      if (activeTarget) positionTooltip(activeTarget);
    });

    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.(TARGET_SELECTOR)) annotateTarget(node);
          annotateAll(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}());
