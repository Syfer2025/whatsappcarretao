'use strict';

// Correcoes de fornecedor sobre o whatsapp-web.js 1.34.7.
//
// O whatsapp-web.js opera uma copia do WhatsApp Web e quebra toda vez que o
// WhatsApp muda o codigo interno da pagina. Enquanto o upstream nao publica
// versao corrigida, aplicamos aqui o minimo necessario. Cada correcao abaixo
// registra sintoma, causa e relato publico — e deve ser APAGADA quando a
// dependencia trouxer a correcao oficial.
//
// O script roda no build da imagem (Dockerfile), depois do `npm ci`, porque
// `node_modules` nao vai para o git. E idempotente e aborta se o trecho
// esperado mudar — melhor o build falhar do que a correcao sumir em silencio.

const fs = require('fs');
const path = require('path');

const WWEBJS_ROOT = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');

const PATCHES = [
  {
    // 17/set/2026, WhatsApp Web 2.3000.10477xx: todo anexo enviado falhava com
    // "Data passed to getter must include an id property (it's how we
    // memoize)"; texto seguia normal. Em `WWebJS.sendMessage`, o objeto da
    // mensagem recebe `id: newMsgKey` e logo depois espalha `...mediaOptions`,
    // um modelo do proprio WhatsApp Web que carrega o campo interno `__x_id`.
    // Ao construir a Msg, o modelo prefere `__x_id` ao id montado e o envio
    // morre. Ver wwebjs/whatsapp-web.js#201921 e #201923.
    description: 'envio de anexos (__x_id)',
    file: path.join('src', 'util', 'Injected', 'Utils.js'),
    isApplied: source => source.includes('delete message.__x_id;'),
    // Ancora estreita de proposito: e o primeiro trecho depois do objeto
    // `message`, ja dentro do escopo certo, e some se o upstream reescrever o
    // sendMessage — que e exatamente quando queremos revalidar a correcao.
    anchor: [
      "        // Bot's won't reply if canonicalUrl is set (linking)",
      '        if (botOptions) {',
      '            delete message.canonicalUrl;',
      '        }'
    ].join('\n'),
    replacement: [
      '        // Patch local (ver scripts/patch-wwebjs.js): `...mediaOptions` traz',
      '        // o campo interno `__x_id` do modelo de midia e ele sobrepoe o id',
      '        // real da mensagem, derrubando todo envio de anexo.',
      '        delete message.__x_id;',
      '',
      "        // Bot's won't reply if canonicalUrl is set (linking)",
      '        if (botOptions) {',
      '            delete message.canonicalUrl;',
      '        }'
    ].join('\n')
  },
  {
    // 28/set/2026, WhatsApp Web 2.3000.10486xx: toda midia RECEBIDA (audio,
    // foto, documento, video) passou a chegar como indisponivel, com o erro
    // minificado "t". `Message#downloadMedia()` chama
    // `downloadAndMaybeDecrypt()` sem `mimetype`; o WhatsApp Web passou a
    // assumir application/octet-stream na falta dele e recusa o arquivo como
    // InvalidMediaFileType. Ver rmyndharis/OpenWA#1739 e #1750.
    description: 'download de midia recebida (mimetype)',
    file: path.join('src', 'structures', 'Message.js'),
    // Nao basta procurar `mimetype: msg.mimetype` no arquivo: a mesma linha ja
    // existe no objeto de retorno do downloadMedia, mais abaixo, e faria o
    // script achar que a correcao esta aplicada quando nao esta. O que importa
    // e o `mimetype` dentro do argumento do downloadAndMaybeDecrypt — e assim
    // a checagem tambem reconhece a correcao quando ela vier do upstream.
    isApplied: source => /downloadAndMaybeDecrypt\(\{[^}]*\bmimetype\s*:/.test(source),
    anchor: [
      '                        type: msg.type,',
      '                        signal: new AbortController().signal,'
    ].join('\n'),
    replacement: [
      '                        type: msg.type,',
      '                        // Patch local (ver scripts/patch-wwebjs.js): sem o tipo,',
      '                        // o WhatsApp Web assume application/octet-stream e',
      '                        // recusa o download de toda midia recebida.',
      '                        mimetype: msg.mimetype,',
      '                        signal: new AbortController().signal,'
    ].join('\n')
  }
];

function applyPatch(source, patch) {
  if (patch.isApplied(source)) {
    return { source, changed: false };
  }
  const occurrences = source.split(patch.anchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${patch.description}: trecho esperado do whatsapp-web.js nao encontrado `
        + `(${occurrences} ocorrencias); revise scripts/patch-wwebjs.js contra a nova versao da dependencia`
    );
  }
  const patched = source.replace(patch.anchor, patch.replacement);
  if (!patch.isApplied(patched)) {
    throw new Error(`${patch.description}: correcao inserida mas nao reconhecida; revise o script`);
  }
  return { source: patched, changed: true };
}

// Tudo ou nada: aplica todas as correcoes em memoria e so grava depois que
// todas passaram. Uma correcao que nao encaixa nao deixa as outras pela metade.
function patchAll({ root = WWEBJS_ROOT, patches = PATCHES } = {}) {
  const sources = new Map();
  const results = [];
  for (const patch of patches) {
    const target = path.join(root, patch.file);
    if (!sources.has(target)) {
      sources.set(target, { original: fs.readFileSync(target, 'utf8') });
    }
    const entry = sources.get(target);
    const current = entry.patched ?? entry.original;
    const { source, changed } = applyPatch(current, patch);
    entry.patched = source;
    results.push({ description: patch.description, changed });
  }
  for (const [target, entry] of sources) {
    if (entry.patched !== entry.original) {
      fs.writeFileSync(target, entry.patched);
    }
  }
  return results;
}

module.exports = { PATCHES, WWEBJS_ROOT, applyPatch, patchAll };

if (require.main === module) {
  try {
    for (const { description, changed } of patchAll()) {
      console.log(`==> whatsapp-web.js: ${description} — ${changed ? 'corrigido' : 'ja estava corrigido'}`);
    }
  } catch (error) {
    console.error(`ERRO ao corrigir whatsapp-web.js: ${error.message}`);
    process.exit(1);
  }
}
