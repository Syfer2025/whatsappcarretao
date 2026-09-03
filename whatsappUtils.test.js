const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getChatId,
  isImportableChatId,
  getDisplayName,
  getSendChatId,
  toSqlDate,
  toSqlDateOrNull,
  getMessageExternalId,
  serializedMessageId,
  getMessageContent,
  shouldProcessMessageEvent,
  getWhatsAppMediaType,
  hasPotentialMedia
} = require('./whatsappUtils');

test('reads serialized WhatsApp ids returned directly by getNumberId', () => {
  assert.equal(getChatId({ _serialized: '5511999999999@c.us' }), '5511999999999@c.us');
});

test('accepts WhatsApp user, lid, and group chat ids for import', () => {
  assert.equal(isImportableChatId('5511999999999@c.us'), true);
  assert.equal(isImportableChatId('1234567890@lid'), true);
  assert.equal(isImportableChatId('120363000000000000@g.us'), true);
});

test('rejects broadcast/status and malformed chat ids', () => {
  assert.equal(isImportableChatId('status@broadcast'), false);
  assert.equal(isImportableChatId('newsletter:123'), false);
  assert.equal(isImportableChatId('5511999999999'), false);
  assert.equal(isImportableChatId(null), false);
});

test('extracts serialized chat id from whatsapp-web.js objects', () => {
  assert.equal(getChatId({ id: { _serialized: 'abc@lid' } }), 'abc@lid');
  assert.equal(getChatId({ id: '5511999999999@c.us' }), '5511999999999@c.us');
});

test('keeps saved whatsapp ids intact when sending messages', () => {
  assert.equal(getSendChatId('abc@lid'), 'abc@lid');
  assert.equal(getSendChatId('120363000000000000@g.us'), '120363000000000000@g.us');
  assert.equal(getSendChatId('5511999999999'), '5511999999999@c.us');
});

test('builds a readable display name from chat name or id', () => {
  assert.equal(getDisplayName({ name: 'Cliente Teste' }, 'abc@lid'), 'Cliente Teste');
  assert.equal(getDisplayName({}, '5511999999999@c.us'), '5511999999999');
  assert.equal(getDisplayName({}, '120363000000000000@g.us'), '120363000000000000');
});

test('prefers contact names when chat name is only a phone number', () => {
  const chat = { name: '+55 41 9999-9999' };
  const contact = { name: '', shortName: 'Maria', pushname: 'Maria Silva' };
  assert.equal(getDisplayName(chat, '5541999999999@c.us', contact), 'Maria');
});

test('keeps group chat title before contact pushname', () => {
  const chat = { name: 'Grupo Comercial', isGroup: true };
  const contact = { pushname: 'Pessoa do Grupo' };
  assert.equal(getDisplayName(chat, '120363000000000000@g.us', contact), 'Grupo Comercial');
});

test('converts whatsapp unix seconds to sqlite datetime text', () => {
  assert.equal(toSqlDate(1700000000), '2023-11-14 22:13:20');
  assert.equal(toSqlDateOrNull(0), null);
  assert.equal(toSqlDateOrNull(undefined), null);
});

// Regressao 02/set/2026: o build do WhatsApp Web renomeou o campo serializado
// de `_serialized` para `$1` e o importador passou a descartar 100% das
// mensagens (ID externo nulo). Ver whatsappUtils.js.
test('resolve o id da mensagem quando o WhatsApp renomeia o campo serializado', () => {
  const idRenomeado = {
    fromMe: true,
    remote: '212987512123587@lid',
    id: 'A5CA7787B8F91456E0911DA5104271FB',
    $1: 'true_212987512123587@lid_A5CA7787B8F91456E0911DA5104271FB'
  };
  assert.equal(
    getMessageExternalId({ id: idRenomeado }),
    'true_212987512123587@lid_A5CA7787B8F91456E0911DA5104271FB'
  );
});

test('remonta o id da mensagem quando nenhum campo serializado sobra', () => {
  assert.equal(
    getMessageExternalId({ id: { fromMe: false, remote: '554499887766@c.us', id: 'ABC123' } }),
    'false_554499887766@c.us_ABC123'
  );
  assert.equal(
    getMessageExternalId({
      id: { fromMe: false, remote: '55449988@g.us', id: 'ABC123', participant: '554411@c.us' }
    }),
    'false_55449988@g.us_ABC123_554411@c.us'
  );
});

test('nao confunde o id do chat com o id da mensagem', () => {
  // `remote` tambem e string e casaria com um teste mais frouxo de sufixo.
  assert.equal(
    serializedMessageId({ fromMe: true, remote: '212987512123587@lid', id: 'XYZ' }),
    'true_212987512123587@lid_XYZ'
  );
  assert.equal(serializedMessageId({ remote: '554499887766@c.us' }), null);
  assert.equal(serializedMessageId({}), null);
  assert.equal(serializedMessageId(null), null);
});

test('o campo serializado do proprio WhatsApp tem prioridade sobre a remontagem', () => {
  assert.equal(
    serializedMessageId({
      _serialized: 'true_x@c.us_AUTORIDADE',
      fromMe: true,
      remote: 'y@c.us',
      id: 'REMONTADO'
    }),
    'true_x@c.us_AUTORIDADE'
  );
});

test('extracts stable message id and media fallback content', () => {
  assert.equal(getMessageExternalId({ id: { _serialized: 'msg-1' } }), 'msg-1');
  assert.equal(getMessageContent({ body: '  Oi  ' }), 'Oi');
  assert.equal(getMessageContent({ body: '', hasMedia: true }), '(mídia)');
  assert.equal(getMessageContent({ body: '', hasMedia: false, type: 'image' }), '(mídia)');
  assert.equal(getMessageContent({ body: '' }), '');
});

test('recognizes whatsapp media types even before directPath becomes available', () => {
  assert.equal(getWhatsAppMediaType('ptt'), 'audio');
  assert.equal(getWhatsAppMediaType('sticker'), 'sticker');
  assert.equal(getWhatsAppMediaType('chat'), null);
  assert.equal(hasPotentialMedia({ hasMedia: false, type: 'image' }), true);
});

test('processes each whatsapp direction from exactly one event source', () => {
  assert.equal(shouldProcessMessageEvent({ fromMe: false }, 'message'), true);
  assert.equal(shouldProcessMessageEvent({ fromMe: false }, 'message_create'), false);
  assert.equal(shouldProcessMessageEvent({ fromMe: true }, 'message'), false);
  assert.equal(shouldProcessMessageEvent({ fromMe: true }, 'message_create'), true);
});
