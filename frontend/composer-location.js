/* global window */
'use strict';
/**
 * Envio da localizacao atual do atendente para a conversa aberta.
 *
 * Modulo compartilhado: admin.html e vendor.html carregam o mesmo arquivo, para
 * o comportamento nao divergir entre o dono e os agentes.
 *
 * Confirma antes de enviar de proposito. Compartilhar posicao fisica e uma
 * acao com consequencia e nao da para desfazer depois que o cliente recebeu,
 * entao o atendente ve a precisao e decide.
 */
(function attachComposerLocation(window) {

  const TEMPO_LIMITE_MS = 15000;

  function mensagemDeErro(codigo) {
    // Mensagens especificas por causa: "erro ao obter localizacao" nao diz ao
    // atendente se o problema e permissao, sinal ou navegador.
    if (codigo === 1) {
      return 'Permissao de localizacao negada. Libere o acesso ao local nas configuracoes do navegador para este site.';
    }
    if (codigo === 2) {
      return 'Nao foi possivel determinar sua localizacao. Verifique se o GPS ou a rede estao disponiveis.';
    }
    if (codigo === 3) {
      return 'A localizacao demorou demais para responder. Tente novamente.';
    }
    return 'Nao foi possivel obter sua localizacao.';
  }

  function posicaoAtual() {
    return new Promise((resolve, reject) => {
      if (!window.navigator?.geolocation) {
        reject(new Error('Este navegador nao oferece localizacao.'));
        return;
      }
      window.navigator.geolocation.getCurrentPosition(
        resolve,
        erro => reject(new Error(mensagemDeErro(erro?.code))),
        { enableHighAccuracy: true, timeout: TEMPO_LIMITE_MS, maximumAge: 0 }
      );
    });
  }

  function identificadorDeRequisicao() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `loc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * @param {object} opcoes
   * @param {() => (number|string|null)} opcoes.conversationId conversa aberta
   * @param {(url: string, init?: object) => Promise<Response>} opcoes.api
   * @param {(mensagem: string, tipo?: string) => void} opcoes.notify
   * @param {() => void} [opcoes.onSent] refresh da conversa
   * @param {HTMLButtonElement} [opcoes.button] para estado de carregando
   */
  async function sendCurrentLocation(opcoes) {
    const { api, notify, onSent, button } = opcoes;
    const conversationId = opcoes.conversationId?.();
    if (!conversationId) {
      notify?.('Abra uma conversa antes de enviar a localizacao.');
      return;
    }

    // Estado de carregando: obter posicao pode levar segundos e sem retorno
    // visual o atendente clica de novo e envia duas vezes.
    const rotuloOriginal = button?.getAttribute('title') || '';
    if (button) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.setAttribute('title', 'Obtendo localizacao...');
    }

    try {
      const posicao = await posicaoAtual();
      const latitude = posicao.coords.latitude;
      const longitude = posicao.coords.longitude;
      const precisao = Number.isFinite(posicao.coords.accuracy)
        ? Math.round(posicao.coords.accuracy)
        : null;

      const detalhePrecisao = precisao
        ? `\n\nPrecisao aproximada: ${precisao} metros.`
        : '';
      const confirmado = window.confirm(
        `Enviar sua localizacao atual para esta conversa?${detalhePrecisao}\n\nO cliente vera o ponto no mapa.`
      );
      if (!confirmado) return;

      const resposta = await api(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          client_request_id: identificadorDeRequisicao(),
          location: { latitude, longitude }
        })
      });
      const dados = await resposta.json().catch(() => ({}));
      if (!resposta.ok) throw new Error(dados.error || 'Nao foi possivel enviar a localizacao.');

      notify?.('Localizacao enviada.', 'success');
      onSent?.();
    } catch (erro) {
      notify?.(erro?.message || 'Nao foi possivel enviar a localizacao.');
    } finally {
      if (button) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        if (rotuloOriginal) button.setAttribute('title', rotuloOriginal);
      }
    }
  }

  window.ComposerLocation = { sendCurrentLocation };
})(window);
