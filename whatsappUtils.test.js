const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getChatId,
  isImportableChatId,
  getDisplayName,
  getSendChatId,
  toSqlDate,
  getMessageExternalId,
  getMessageContent
} = require('./whatsappUtils');

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
});

test('extracts stable message id and media fallback content', () => {
  assert.equal(getMessageExternalId({ id: { _serialized: 'msg-1' } }), 'msg-1');
  assert.equal(getMessageContent({ body: '  Oi  ' }), 'Oi');
  assert.equal(getMessageContent({ body: '', hasMedia: true }), '(mídia)');
  assert.equal(getMessageContent({ body: '' }), '');
});
