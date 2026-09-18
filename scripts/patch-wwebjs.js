'use strict';

// Correcao de fornecedor: whatsapp-web.js 1.34.7 quebrou o envio de anexos
// quando o WhatsApp Web passou da build 2.3000.10477xx (17/set/2026).
//
// Em `WWebJS.sendMessage`, o objeto da mensagem recebe `id: newMsgKey` e logo
// depois espalha `...mediaOptions`. Esse `mediaOptions` e um modelo do proprio
// WhatsApp Web e carrega o campo interno `__x_id`; ao construir a Msg, o
// modelo prefere `__x_id` ao `id` que montamos. O remetente passa a ser
// resolvido a partir de um id invalido e todo anexo falha com
// "Data passed to getter must include an id property (it's how we memoize)".
// Texto nao usa `mediaOptions`, por isso continuou funcionando.
//
// Enquanto o upstream nao publica a versao corrigida, apagamos o campo antes
// de a mensagem virar modelo. Ver wwebjs/whatsapp-web.js#201921 e #201923.
//
// O script roda no build da imagem (Dockerfile), depois do `npm ci`, porque
// `node_modules` nao vai para o git. E idempotente e aborta se o trecho
// esperado mudar — melhor o build falhar do que a correcao sumir em silencio.

const fs = require('fs');
const path = require('path');

const TARGET = path.join(
  __dirname,
  '..',
  'node_modules',
  'whatsapp-web.js',
  'src',
  'util',
  'Injected',
  'Utils.js'
);

const MARKER = 'delete message.__x_id;';

// Ancora estreita de proposito: e o primeiro trecho depois do objeto
// `message`, ja dentro do escopo certo, e some se o upstream reescrever o
// sendMessage — que e exatamente quando queremos revalidar a correcao.
const ANCHOR = [
  "        // Bot's won't reply if canonicalUrl is set (linking)",
  '        if (botOptions) {',
  '            delete message.canonicalUrl;',
  '        }'
].join('\n');

const REPLACEMENT = [
  '        // Patch local (ver scripts/patch-wwebjs.js): `...mediaOptions` traz',
  '        // o campo interno `__x_id` do modelo de midia e ele sobrepoe o id',
  '        // real da mensagem, derrubando todo envio de anexo.',
  '        delete message.__x_id;',
  '',
  ANCHOR
].join('\n');

function applyMediaIdPatch(source) {
  if (source.includes(MARKER)) {
    return { source, changed: false };
  }
  const occurrences = source.split(ANCHOR).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `trecho esperado do whatsapp-web.js nao encontrado (${occurrences} ocorrencias); `
        + 'revise scripts/patch-wwebjs.js contra a nova versao da dependencia'
    );
  }
  return { source: source.replace(ANCHOR, REPLACEMENT), changed: true };
}

function patchFile(targetPath = TARGET) {
  const original = fs.readFileSync(targetPath, 'utf8');
  const { source, changed } = applyMediaIdPatch(original);
  if (changed) {
    fs.writeFileSync(targetPath, source);
  }
  return changed;
}

module.exports = { applyMediaIdPatch, patchFile, MARKER, TARGET };

if (require.main === module) {
  try {
    const changed = patchFile();
    console.log(
      changed
        ? '==> whatsapp-web.js corrigido: envio de anexos (__x_id)'
        : '==> whatsapp-web.js ja estava corrigido'
    );
  } catch (error) {
    console.error(`ERRO ao corrigir whatsapp-web.js: ${error.message}`);
    process.exit(1);
  }
}
