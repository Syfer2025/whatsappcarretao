const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { ensureSchema } = require('./schema');
const {
  findOpenConversationByIdentifiers,
  linkConversationIdentifiers,
  getConversationIdentifiers,
  resolveWhatsAppIdentifierMap
} = require('./conversationIdentity');

test('maps lid and phone-number identifiers to the same open conversation', async () => {
  const db = new Database(':memory:');
  ensureSchema(db);
  const conversationId = db.prepare(`
    INSERT INTO conversations (phone, contact_name, status)
    VALUES ('5511999999999@c.us', 'Cliente', 'active')
  `).run().lastInsertRowid;

  const identifiers = await resolveWhatsAppIdentifierMap({
    getContactLidAndPhone: async ids => ids.map(() => ({
      lid: '123456789@lid',
      pn: '5511999999999@c.us'
    }))
  }, ['123456789@lid']);
  linkConversationIdentifiers(db, conversationId, identifiers.get('123456789@lid'));

  assert.equal(
    findOpenConversationByIdentifiers(db, ['123456789@lid']).id,
    conversationId
  );
  assert.deepEqual(
    getConversationIdentifiers(db, conversationId).sort(),
    ['123456789@lid', '5511999999999@c.us'].sort()
  );
  db.close();
});

test('does not reopen a closed conversation through an old identifier', () => {
  const db = new Database(':memory:');
  ensureSchema(db);
  const conversationId = db.prepare(`
    INSERT INTO conversations (phone, contact_name, status)
    VALUES ('old@lid', 'Encerrada', 'closed')
  `).run().lastInsertRowid;
  linkConversationIdentifiers(db, conversationId, ['old@lid', '5511888888888@c.us']);

  assert.equal(findOpenConversationByIdentifiers(db, ['5511888888888@c.us']), null);
  db.close();
});
