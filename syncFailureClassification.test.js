'use strict';

// Timeout de sincronizacao nao pode reciclar a sessao do WhatsApp.
//
// Descoberto em 10/09/2026, depois de duas tentativas erradas de conserto: a
// sessao se reiniciava sozinha a cada ~90 s em rajadas, e eu tinha ajustado
// apenas o health check — sem efeito, porque existe um SEGUNDO gatilho.
//
// `recordSyncRuntimeFailure` conta falhas classificadas por
// `isBrowserContextSyncFailure` e, na terceira dentro de 2 minutos, chama
// `reportSessionRuntimeError` -> `scheduleReconnect`. A classificacao aceitava
// "excedeu Nms" — o texto de QUALQUER timeout nosso — como prova de contexto
// destruido. Com 3+ timeouts por minuto em producao, esse caminho reiniciava a
// sessao sozinho, e a recarga da pagina gerava mais timeouts: a rajada se
// alimentava.
//
// Pagina lenta e problema de vazao. Sessao travada de verdade continua sendo
// detectada pelo health check, que e a sonda dedicada.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('node:vm');

// A funcao vive dentro do server.js, que sobe um servidor ao ser carregado.
// Extrair e avaliar o trecho isolado e o mesmo recurso ja usado em
// serverStructure.test.js para testar comportamento sem inicializar o processo.
function carregarClassificador() {
  const source = fs.readFileSync(require.resolve('./server.js'), 'utf8');
  const inicio = source.indexOf('function isBrowserContextSyncFailure(');
  assert.notEqual(inicio, -1, 'isBrowserContextSyncFailure sumiu do server.js');
  const fim = source.indexOf('function recordSyncRuntimeFailure(', inicio);
  assert.notEqual(fim, -1, 'recordSyncRuntimeFailure sumiu do server.js');
  const contexto = { module: { exports: {} } };
  vm.createContext(contexto);
  vm.runInContext(`${source.slice(inicio, fim)}\nmodule.exports = isBrowserContextSyncFailure;`, contexto);
  return contexto.module.exports;
}

const ehFalhaDeContexto = carregarClassificador();

function timeout(operacao, ms) {
  // Mesmo formato produzido por withTimeout() em runtimeUtils.js.
  const erro = new Error(`${operacao} excedeu ${ms}ms`);
  erro.code = 'OPERATION_TIMEOUT';
  erro.operation = operacao;
  erro.timeoutMs = ms;
  return erro;
}

test('timeout de operacao em lote NAO conta como contexto destruido', () => {
  // Os tres que mais aparecem no log de producao.
  assert.equal(ehFalhaDeContexto(timeout('fetchMessages', 15000)), false);
  assert.equal(ehFalhaDeContexto(timeout('getChats', 15000)), false);
  assert.equal(ehFalhaDeContexto(timeout('getContacts', 30000)), false);
});

test('timeout continua sendo timeout mesmo embrulhado pelo importador', () => {
  // O importador prefixa o nome do contato antes de propagar.
  const erro = new Error('Erro ao importar mensagens de Ezequiel: fetchMessages excedeu 15000ms');
  assert.equal(ehFalhaDeContexto(erro), false);
});

test('contexto realmente destruido continua reciclando a sessao', () => {
  // Aqui recarregar a pagina e a acao certa: nao ha mais pagina.
  for (const mensagem of [
    "Attempted to use detached Frame '7ABF485BED221209F102E90'.",
    'Target closed',
    'Session closed',
    'Protocol error (Runtime.callFunctionOn): Target closed',
    'Execution context was destroyed',
    'Evaluation failed: r',
    'The browser has disconnected'
  ]) {
    assert.equal(ehFalhaDeContexto(new Error(mensagem)), true, mensagem);
  }
});

test('excecao minificada da pagina ainda e reconhecida pelo stack', () => {
  // Erro chamado so "r", vindo de dentro do WhatsApp Web: a mensagem nao diz
  // nada, e o stack atravessando a lib e a unica assinatura.
  const erro = new Error('r');
  erro.stack = 'Error: r\n    at Client.getChats (/app/node_modules/whatsapp-web.js/src/Client.js:1669:42)';
  assert.equal(ehFalhaDeContexto(erro), true);
});

test('bug do importador/banco nao recicla a sessao', () => {
  // Reciclar o navegador nao conserta um erro nosso de SQL ou de codigo.
  const erro = new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed');
  erro.stack = 'Error: SQLITE_CONSTRAINT\n    at /app/historyImporter.js:120:9';
  assert.equal(ehFalhaDeContexto(erro), false);
});

test('a ordem importa: o teste de timeout vem ANTES do de contexto', () => {
  // "fetchMessages excedeu 15000ms" casa com as duas listas. Se a verificacao
  // de contexto vier primeiro, a correcao e desfeita sem ninguem perceber.
  const source = fs.readFileSync(require.resolve('./server.js'), 'utf8');
  const corpo = source.slice(
    source.indexOf('function isBrowserContextSyncFailure('),
    source.indexOf('function recordSyncRuntimeFailure(')
  );
  const posTimeout = corpo.indexOf('OPERATION_TIMEOUT');
  const posContexto = corpo.indexOf('Target closed');
  assert.ok(posTimeout > -1 && posContexto > -1, 'trechos nao encontrados');
  assert.ok(posTimeout < posContexto, 'a saida por timeout precisa vir antes da lista de contexto');
});
