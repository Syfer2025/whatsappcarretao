/* global window, File */
'use strict';
/**
 * Arrastar-e-soltar e colar (Ctrl+V) de imagens direto na conversa.
 *
 * Nao reimplementa envio: alimenta o MESMO pipeline do botao de anexo
 * (selectedFiles -> renderFilePreview -> envio), entao qualquer regra de
 * validacao, previa ou limite ja existente continua valendo. Modulo unico e
 * compartilhado de proposito: admin.html e vendor.html carregam o mesmo
 * arquivo, e o comportamento nao pode divergir entre o dono e os agentes.
 */
(function attachComposerAttachments(window) {
  const document = window.document;
  let config = null;
  let overlay = null;
  let dragDepth = 0;

  // Estilos derivados dos tokens do painel (--accent, --border, --text-*).
  // Nenhuma cor nova: o aviso de soltar precisa parecer parte da tela, nao um
  // enxerto.
  function ensureStyles() {
    if (document.getElementById('composerAttachmentsStyles')) return;
    const style = document.createElement('style');
    style.id = 'composerAttachmentsStyles';
    style.textContent = `
      .drop-hint {
        position: absolute; inset: 0; z-index: 40;
        display: none; align-items: center; justify-content: center;
        background: rgba(255,255,255,0.92);
        -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
      }
      .drop-hint[data-visible="true"] { display: flex; }
      .drop-hint-card {
        display: flex; flex-direction: column; align-items: center; gap: 10px;
        padding: 26px 34px; border-radius: 14px;
        border: 2px dashed var(--accent, #25d366);
        background: var(--accent-light, #dcfce7);
        color: var(--text-main, #0f172a);
        font-size: 14px; font-weight: 700; text-align: center;
      }
      .drop-hint-card small {
        font-size: 12px; font-weight: 600;
        color: var(--text-muted, #64748b);
      }
      .drop-hint-card svg { color: var(--accent-dark, #16a34a); }
      @media (prefers-reduced-motion: no-preference) {
        .drop-hint[data-visible="true"] .drop-hint-card { animation: dropHintIn 160ms ease-out; }
        @keyframes dropHintIn { from { transform: scale(0.97); opacity: 0.6; } to { transform: none; opacity: 1; } }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureOverlay(container) {
    if (overlay && overlay.isConnected) return overlay;
    ensureStyles();
    overlay = document.createElement('div');
    overlay.className = 'drop-hint';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
      <div class="drop-hint-card">
        <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <path d="M17 8l-5-5-5 5"/>
          <path d="M12 3v12"/>
        </svg>
        <span>Solte para anexar</span>
        <small>Tambem funciona colar com Ctrl+V</small>
      </div>
    `;
    // O container precisa ser referencia de posicionamento para o inset:0.
    if (window.getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(overlay);
    return overlay;
  }

  function mostrarAviso(visivel) {
    if (!overlay) return;
    overlay.dataset.visible = visivel ? 'true' : 'false';
  }

  // Um drag de texto dentro da propria pagina nao deve piscar o aviso.
  function carregaArquivo(dataTransfer) {
    if (!dataTransfer) return false;
    const tipos = Array.from(dataTransfer.types || []);
    return tipos.includes('Files');
  }

  function entregarArquivos(arquivos, origem) {
    const lista = Array.from(arquivos || []).filter(Boolean);
    if (!lista.length) return;

    if (config.isBusy && config.isBusy()) {
      config.notify?.('Pare a gravacao antes de anexar um arquivo.');
      return;
    }
    config.onFiles(lista, origem);
  }

  function init(options) {
    config = options || {};
    const container = config.container;
    if (!container || container.dataset.composerAttachments === 'on') return;
    container.dataset.composerAttachments = 'on';

    ensureOverlay(container);

    // dragenter/dragleave disparam para cada filho: contador evita o aviso
    // piscando enquanto o cursor atravessa mensagens.
    container.addEventListener('dragenter', event => {
      if (!carregaArquivo(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth += 1;
      mostrarAviso(true);
    });

    container.addEventListener('dragover', event => {
      if (!carregaArquivo(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });

    container.addEventListener('dragleave', event => {
      if (!carregaArquivo(event.dataTransfer)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) mostrarAviso(false);
    });

    container.addEventListener('drop', event => {
      if (!carregaArquivo(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth = 0;
      mostrarAviso(false);
      entregarArquivos(event.dataTransfer.files, 'drop');
    });

    // Soltar fora da area: o navegador abriria o arquivo e o atendente perderia
    // a conversa da tela.
    window.addEventListener('dragover', event => {
      if (carregaArquivo(event.dataTransfer)) event.preventDefault();
    });
    window.addEventListener('drop', event => {
      if (!carregaArquivo(event.dataTransfer)) return;
      if (!container.contains(event.target)) {
        event.preventDefault();
        dragDepth = 0;
        mostrarAviso(false);
      }
    });

    // Colar: imagem da area de transferencia (print, foto copiada do
    // navegador). Ignorado quando o foco esta num campo de texto que nao seja
    // o compositor, para nao roubar um Ctrl+V legitimo.
    document.addEventListener('paste', event => {
      if (!container.isConnected || container.offsetParent === null) return;
      const ativo = document.activeElement;
      const emCampoAlheio = ativo
        && ativo !== config.composer
        && (ativo.tagName === 'INPUT' || ativo.tagName === 'TEXTAREA' || ativo.isContentEditable);
      if (emCampoAlheio) return;

      const itens = Array.from(event.clipboardData?.items || []);
      const arquivos = itens
        .filter(item => item.kind === 'file' && /^image\//i.test(item.type))
        .map(item => item.getAsFile())
        .filter(Boolean);
      if (!arquivos.length) return;

      // Print de tela vem sem nome util; nomear ajuda na previa e no historico.
      const renomeados = arquivos.map((arquivo, indice) => {
        if (arquivo.name && arquivo.name !== 'image.png') return arquivo;
        const extensao = (arquivo.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const selo = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
        return new File([arquivo], `colado-${selo}${arquivos.length > 1 ? `-${indice + 1}` : ''}.${extensao}`, {
          type: arquivo.type,
          lastModified: arquivo.lastModified
        });
      });

      event.preventDefault();
      entregarArquivos(renomeados, 'paste');
    });
  }

  window.ComposerAttachments = { init };
})(window);
