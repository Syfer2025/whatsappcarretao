'use strict';

// Cobre a medicao de memoria adicionada apos a auditoria de 09/09/2026 (W-01).
//
// O ponto sensivel nao e o valor devolvido — e a rota de saude nunca cair por
// causa dele. Em Windows, macOS ou fora de container os arquivos de cgroup nao
// existem; se a leitura lancasse, /health/ready passaria a responder 500 em todo
// ambiente que nao fosse Linux conteinerizado.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getContainerMemory } = require('./containerMemory');

test('nunca lanca, mesmo sem cgroup disponivel', () => {
  assert.doesNotThrow(() => getContainerMemory());
});

test('sempre reporta a memoria do processo Node', () => {
  const memoria = getContainerMemory();
  for (const campo of ['rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes']) {
    assert.equal(typeof memoria.node[campo], 'number', `node.${campo} precisa ser numero`);
    assert.ok(memoria.node[campo] > 0, `node.${campo} precisa ser positivo`);
  }
});

test('declara explicitamente quando o cgroup nao pode ser lido', () => {
  const memoria = getContainerMemory();
  assert.equal(typeof memoria.available, 'boolean');
  if (!memoria.available) {
    // Fora de container o resultado nao pode fingir um limite que nao existe.
    assert.equal(memoria.usedBytes, undefined);
    assert.equal(memoria.limitBytes, undefined);
    return;
  }
  assert.equal(typeof memoria.usedBytes, 'number');
  assert.ok(memoria.usedBytes > 0);
  assert.ok([1, 2].includes(memoria.version));
  // Sem limite configurado o campo e null — nunca o inteiro gigante que o
  // kernel devolve nesse caso, que passaria por "limite" em qualquer grafico.
  if (memoria.limitBytes !== null) {
    assert.ok(memoria.limitBytes > 0);
    assert.ok(memoria.limitBytes < Number.MAX_SAFE_INTEGER / 2);
  }
});
