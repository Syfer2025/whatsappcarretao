/* global window */
'use strict';
/**
 * Desenha a localizacao de uma mensagem como mapa, no lugar do link cru.
 *
 * Os quadradinhos vem de /api/maps/tile (o proprio servidor busca e cacheia),
 * entao a CSP do painel segue permitindo imagem apenas de 'self' e o navegador
 * do atendente nunca contata servico de terceiro com a coordenada do cliente.
 *
 * Modulo compartilhado: admin.html e vendor.html usam o mesmo, para o
 * comportamento nao divergir entre o dono e os agentes.
 */
(function attachMessageLocation(window) {
  const document = window.document;

  const TILE = 256;
  const ZOOM = 16;      // detalhe de rua sem precisar de muitos tiles
  const LARGURA = 260;  // combina com o max-width das imagens em .media-block
  const ALTURA = 150;

  // Matematica padrao de mapa em tiles (slippy map). Feita no cliente para o
  // servidor nao precisar compor imagem nem carregar biblioteca grafica.
  function pixelsDoMundo(latitude, longitude, zoom) {
    const n = 2 ** zoom;
    const x = ((longitude + 180) / 360) * n * TILE;
    const radianos = (latitude * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(radianos) + 1 / Math.cos(radianos)) / Math.PI) / 2) * n * TILE;
    return { x, y, limite: n };
  }

  function escapar(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, caractere => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[caractere]));
  }

  function ensureStyles() {
    if (document.getElementById('messageLocationStyles')) return;
    const style = document.createElement('style');
    style.id = 'messageLocationStyles';
    // Tokens do painel: mesma borda, mesmo raio e mesmo verde dos outros blocos.
    style.textContent = `
      .location-block { margin-top: 8px; max-width: ${LARGURA}px; }
      .location-map {
        position: relative; width: 100%; height: ${ALTURA}px;
        border-radius: 8px 8px 0 0; overflow: hidden;
        background: var(--surface-hover, #f1f5f9);
        border: 1px solid var(--border, #e2e8f0); border-bottom: 0;
      }
      .location-map-layer { position: absolute; inset: 0; }
      .location-map-layer img {
        position: absolute; width: ${TILE}px; height: ${TILE}px;
        max-width: none; max-height: none; border-radius: 0; cursor: inherit;
        image-rendering: auto;
      }
      .location-pin {
        position: absolute; left: 50%; top: 50%;
        transform: translate(-50%, -100%);
        color: var(--danger, #ef4444);
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));
        pointer-events: none;
      }
      .location-credit {
        position: absolute; right: 0; bottom: 0;
        font-size: 9px; line-height: 1.4; padding: 1px 4px;
        background: rgba(255,255,255,0.82); color: var(--text-muted, #64748b);
      }
      .location-open {
        display: flex; align-items: center; justify-content: center; gap: 6px;
        padding: 9px 12px; border-radius: 0 0 8px 8px;
        border: 1px solid var(--border, #e2e8f0);
        background: #fff; color: var(--accent-dark, #16a34a);
        font-size: 13px; font-weight: 700; text-decoration: none;
      }
      .location-open:hover { background: var(--accent-light, #dcfce7); }
      .location-open:focus-visible { outline: 2px solid var(--accent, #25d366); outline-offset: 2px; }
      .location-fallback {
        padding: 10px 12px; border-radius: 8px;
        border: 1px solid var(--border, #e2e8f0); background: #fff;
        font-size: 13px; color: var(--text-muted, #64748b);
      }
    `;
    document.head.appendChild(style);
  }

  function coordenadasDe(mensagem) {
    const latitude = Number(mensagem?.location_latitude);
    const longitude = Number(mensagem?.location_longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
    return { latitude, longitude };
  }

  function tilesQueCobrem(latitude, longitude) {
    const { x, y, limite } = pixelsDoMundo(latitude, longitude, ZOOM);
    // Canto superior esquerdo da janela visivel, em pixels do mundo, de modo
    // que o ponto caia exatamente no centro da caixa.
    const esquerda = x - LARGURA / 2;
    const topo = y - ALTURA / 2;
    const primeiroX = Math.floor(esquerda / TILE);
    const primeiroY = Math.floor(topo / TILE);

    const imagens = [];
    for (let tx = primeiroX; tx * TILE < esquerda + LARGURA; tx += 1) {
      for (let ty = primeiroY; ty * TILE < topo + ALTURA; ty += 1) {
        // Fora do mundo em Y (polos) nao existe tile; em X o mapa da a volta.
        if (ty < 0 || ty >= limite) continue;
        const xNormalizado = ((tx % limite) + limite) % limite;
        imagens.push({
          z: ZOOM,
          x: xNormalizado,
          y: ty,
          left: Math.round(tx * TILE - esquerda),
          top: Math.round(ty * TILE - topo)
        });
      }
    }
    return imagens;
  }

  /**
   * @param {object} mensagem linha da mensagem vinda da API
   * @returns {string} HTML do bloco, ou '' quando nao ha coordenada
   */
  function render(mensagem) {
    const coordenadas = coordenadasDe(mensagem);
    if (!coordenadas) return '';
    ensureStyles();

    const { latitude, longitude } = coordenadas;
    const rotulo = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    const destino = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;

    const camadas = tilesQueCobrem(latitude, longitude).map(t => (
      `<img src="/api/maps/tile/${t.z}/${t.x}/${t.y}" alt="" loading="lazy" decoding="async"`
      + ` style="left:${t.left}px;top:${t.top}px"`
      // Mapa indisponivel (servico fora, sem rede) nao pode deixar um quadrado
      // quebrado: a caixa fica com o fundo neutro e o botao continua servindo.
      + ` onerror="this.style.display='none'">`
    )).join('');

    return `
      <div class="location-block media-block">
        <div class="location-map" role="img" aria-label="Mapa da localizacao em ${escapar(rotulo)}">
          <div class="location-map-layer">${camadas}</div>
          <svg class="location-pin" viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true">
            <path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/>
          </svg>
          <span class="location-credit">&copy; OpenStreetMap</span>
        </div>
        <a class="location-open" href="${escapar(destino)}" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <path d="M15 3h6v6"/><path d="M10 14 21 3"/>
          </svg>
          Abrir no mapa
        </a>
      </div>
    `;
  }

  window.MessageLocation = { render, coordenadasDe };
})(window);
