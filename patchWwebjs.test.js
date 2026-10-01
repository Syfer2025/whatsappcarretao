const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PATCHES, WWEBJS_ROOT, applyPatch, patchAll } = require('./scripts/patch-wwebjs');

function patchByDescription(fragment) {
  const patch = PATCHES.find(item => item.description.includes(fragment));
  assert.ok(patch, `correcao "${fragment}" nao encontrada`);
  return patch;
}

const envioAnexo = patchByDescription('__x_id');
const downloadMidia = patchByDescription('mimetype');

// Final do objeto `message` do sendMessage do whatsapp-web.js, onde entra a
// correcao de envio.
const SEND_SNIPPET = [
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

// Trecho do downloadMedia do whatsapp-web.js 1.34.7. Inclui de proposito o
// objeto de retorno, que JA tem `mimetype: msg.mimetype` — a armadilha que faria
// uma checagem ingenua dar a correcao por aplicada sem aplicar nada.
const DOWNLOAD_SNIPPET = [
  '                const decryptedMedia = await window',
  "                    .require('WAWebDownloadManager')",
  '                    .downloadManager.downloadAndMaybeDecrypt({',
  '                        directPath: msg.directPath,',
  '                        mediaKey: msg.mediaKey,',
  '                        type: msg.type,',
  '                        signal: new AbortController().signal,',
  '                        downloadQpl: mockQpl,',
  '                    });',
  '',
  '                return {',
  '                    data,',
  '                    mimetype: msg.mimetype,',
  '                    filename: msg.filename,',
  '                };',
  ''
].join('\n');

test('envio: apaga __x_id depois de montar a mensagem e antes de qualquer uso', () => {
  const { source, changed } = applyPatch(SEND_SNIPPET, envioAnexo);

  assert.equal(changed, true);
  const posDelete = source.indexOf('delete message.__x_id;');
  assert.ok(source.indexOf('};') < posDelete);
  assert.ok(posDelete < source.indexOf('delete message.canonicalUrl;'));
});

test('download: o mimetype entra no argumento do downloadAndMaybeDecrypt', () => {
  assert.equal(downloadMidia.isApplied(DOWNLOAD_SNIPPET), false,
    'o mimetype do objeto de retorno nao pode contar como correcao aplicada');

  const { source, changed } = applyPatch(DOWNLOAD_SNIPPET, downloadMidia);

  assert.equal(changed, true);
  const chamada = source.slice(
    source.indexOf('downloadAndMaybeDecrypt({'),
    source.indexOf('});')
  );
  assert.match(chamada, /mimetype: msg\.mimetype,/);
  // O retorno continua intacto, com o seu proprio mimetype.
  assert.equal(source.split('mimetype: msg.mimetype,').length - 1, 2);
});

// Quando o upstream corrigir por conta propria, nao podemos inserir de novo
// nem quebrar o build: a correcao deles conta como aplicada.
test('download: reconhece a correcao vinda do upstream, sem o nosso comentario', () => {
  const corrigidoUpstream = DOWNLOAD_SNIPPET.replace(
    '                        type: msg.type,\n',
    '                        type: msg.type,\n                        mimetype: msg.mimetype,\n'
  );
  const { source, changed } = applyPatch(corrigidoUpstream, downloadMidia);

  assert.equal(changed, false);
  assert.equal(source, corrigidoUpstream);
});

test('nenhuma correcao se duplica quando o script roda de novo', () => {
  for (const [patch, snippet] of [[envioAnexo, SEND_SNIPPET], [downloadMidia, DOWNLOAD_SNIPPET]]) {
    const primeira = applyPatch(snippet, patch).source;
    const segunda = applyPatch(primeira, patch);

    assert.equal(segunda.changed, false, patch.description);
    assert.equal(segunda.source, primeira, patch.description);
  }
});

test('aborta quando o trecho esperado do fornecedor some', () => {
  for (const patch of PATCHES) {
    assert.throws(
      () => applyPatch('function qualquerCoisa() { return null; }', patch),
      /trecho esperado do whatsapp-web\.js nao encontrado/,
      patch.description
    );
  }
});

// Uma correcao que nao encaixa nao pode deixar as outras gravadas pela metade:
// o build falharia, mas uma copia local ficaria num estado que ninguem testou.
test('tudo ou nada: se uma correcao falha, nenhum arquivo e gravado', () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-patch-'));
  for (const patch of PATCHES) {
    fs.mkdirSync(path.dirname(path.join(raiz, patch.file)), { recursive: true });
  }
  const envioPath = path.join(raiz, envioAnexo.file);
  const downloadPath = path.join(raiz, downloadMidia.file);
  fs.writeFileSync(envioPath, SEND_SNIPPET);
  fs.writeFileSync(downloadPath, 'conteudo que nao tem o trecho esperado');

  assert.throws(() => patchAll({ root: raiz }), /download de midia recebida/);
  assert.equal(fs.readFileSync(envioPath, 'utf8'), SEND_SNIPPET, 'a correcao de envio nao pode ter sido gravada');

  fs.rmSync(raiz, { recursive: true, force: true });
});

// Guarda de versao: quando o whatsapp-web.js for atualizado, este teste quebra
// se algum trecho mudar e obriga a revisar se cada correcao ainda e necessaria
// — e a apaga-la quando a versao oficial trouxer o conserto.
test('a copia instalada do whatsapp-web.js continua compativel com as correcoes', () => {
  for (const patch of PATCHES) {
    const instalado = fs.readFileSync(path.join(WWEBJS_ROOT, patch.file), 'utf8');
    if (patch.isApplied(instalado)) continue;
    assert.doesNotThrow(() => applyPatch(instalado, patch), patch.description);
  }
});
