const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { applyMediaIdPatch, MARKER, TARGET } = require('./scripts/patch-wwebjs');

// Reproduz o final do objeto `message` do sendMessage do whatsapp-web.js, que e
// onde a correcao entra.
const UPSTREAM_SNIPPET = [
  '        const message = {',
  '            ...options,',
  '            id: newMsgKey,',
  '            ...mediaOptions,',
  '            ...extraOptions,',
  '        };',
  '',
  "        // Bot's won't reply if canonicalUrl is set (linking)",
  '        if (botOptions) {',
  '            delete message.canonicalUrl;',
  '        }',
  ''
].join('\n');

test('apaga __x_id antes de a mensagem virar modelo', () => {
  const { source, changed } = applyMediaIdPatch(UPSTREAM_SNIPPET);

  assert.equal(changed, true);
  assert.ok(source.includes(MARKER));
  // O `delete` precisa vir depois do objeto estar montado e antes de qualquer
  // outro uso de `message`, senao o campo interno volta a vencer o id real.
  assert.ok(source.indexOf('};') < source.indexOf(MARKER));
  assert.ok(source.indexOf(MARKER) < source.indexOf('delete message.canonicalUrl;'));
});

test('nao duplica a correcao quando roda de novo', () => {
  const primeira = applyMediaIdPatch(UPSTREAM_SNIPPET).source;
  const segunda = applyMediaIdPatch(primeira);

  assert.equal(segunda.changed, false);
  assert.equal(segunda.source, primeira);
  assert.equal(primeira.split(MARKER).length - 1, 1);
});

test('aborta quando o trecho esperado do fornecedor some', () => {
  assert.throws(
    () => applyMediaIdPatch('function sendMessage() { return null; }'),
    /trecho esperado do whatsapp-web\.js nao encontrado/
  );
});

// Guarda de versao: quando o whatsapp-web.js for atualizado — inclusive para a
// versao que corrigir isso no upstream — este teste quebra e obriga a revisar
// se a correcao local ainda e necessaria.
test('a copia instalada do whatsapp-web.js continua compativel com a correcao', () => {
  const instalado = fs.readFileSync(TARGET, 'utf8');
  if (instalado.includes(MARKER)) return;

  assert.doesNotThrow(() => applyMediaIdPatch(instalado));
});
