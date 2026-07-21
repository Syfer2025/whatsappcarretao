const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  normalizePhoneInput,
  syncContacts,
  listContacts,
  searchContacts,
  syncConversationProfile,
  backfillGroupMessageParticipants
} = require('./whatsappDirectory');

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      contact_name TEXT,
      profile_pic_url TEXT,
      is_group INTEGER DEFAULT 0,
      group_description TEXT,
      group_owner TEXT,
      group_created_at DATETIME,
      profile_about TEXT,
      whatsapp_archived INTEGER DEFAULT 0,
      archived_at DATETIME,
      archive_sync_state TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      whatsapp_id TEXT NOT NULL UNIQUE,
      phone TEXT,
      name TEXT,
      push_name TEXT,
      short_name TEXT,
      verified_name TEXT,
      profile_pic_url TEXT,
      is_saved INTEGER DEFAULT 0,
      is_business INTEGER DEFAULT 0,
      is_blocked INTEGER DEFAULT 0,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE group_participants (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES contacts(id),
      participant_id TEXT NOT NULL,
      phone TEXT,
      name TEXT,
      profile_pic_url TEXT,
      is_admin INTEGER DEFAULT 0,
      is_super_admin INTEGER DEFAULT 0,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (conversation_id, participant_id)
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      external_id TEXT,
      from_type TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      participant_id TEXT,
      participant_phone TEXT,
      participant_name TEXT
    );
  `);
  return db;
}

function contact(id, overrides = {}) {
  return {
    id: { _serialized: id },
    number: id.split('@')[0],
    isUser: true,
    isWAContact: true,
    isMyContact: true,
    ...overrides
  };
}

test('normalizes formatted international phone input without guessing a country code', () => {
  assert.equal(normalizePhoneInput('+55 (11) 99999-9999'), '5511999999999');
  assert.equal(normalizePhoneInput('5511988887777@c.us'), '5511988887777');
  assert.throws(() => normalizePhoneInput('Maria 5511999999999'), /Telefone inválido/);
  assert.throws(() => normalizePhoneInput('123'), /8 a 15 dígitos/);
});

test('syncs the WhatsApp contact directory and supports saved-contact search', async () => {
  const db = createDb();
  const client = {
    getContacts: async () => [
      contact('5511999999999@c.us', { name: 'Maria Silva', isBusiness: true }),
      contact('5511888888888@c.us', { name: 'João Souza', isMyContact: false }),
      contact('120363000000000000@g.us', { name: 'Grupo', isGroup: true }),
      contact('5511777777777@c.us', { name: 'Eu', isMe: true })
    ]
  };

  const stats = await syncContacts(client, db);

  assert.deepEqual(stats, { total: 2, inserted: 2, updated: 0, saved: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contacts').get().count, 2);
  assert.equal(db.prepare("SELECT is_business FROM contacts WHERE whatsapp_id = '5511999999999@c.us'").get().is_business, 1);
  assert.deepEqual(
    listContacts(db).map(row => row.display_name),
    ['Maria Silva']
  );
  assert.deepEqual(
    searchContacts(db, '551199').map(row => row.whatsapp_id),
    ['5511999999999@c.us']
  );
  assert.deepEqual(searchContacts(db, '%'), []);

  client.getContacts = async () => [
    contact('5511999999999@c.us', { name: 'Maria Atualizada' })
  ];
  const second = await syncContacts(client, db);
  assert.equal(second.updated, 1);
  assert.equal(listContacts(db)[0].display_name, 'Maria Atualizada');
  db.close();
});

test('exposes the real getContacts completion after timeout so callers can prevent overlap', async () => {
  const db = createDb();
  let settleContacts;
  const contactsWork = new Promise(resolve => {
    settleContacts = resolve;
  });
  const client = { getContacts: () => contactsWork };

  let timeoutError;
  await assert.rejects(
    syncContacts(client, db, { timeoutMs: 5 }),
    error => {
      timeoutError = error;
      return error.code === 'OPERATION_TIMEOUT';
    }
  );

  assert.ok(timeoutError.pendingOperation instanceof Promise);
  assert.equal(Object.keys(timeoutError).includes('pendingOperation'), false);
  settleContacts([]);
  await timeoutError.pendingOperation;
  assert.equal(db.prepare('SELECT COUNT(*) count FROM contacts').get().count, 0);
  db.close();
});

test('syncs an individual profile with about, saved contact and archive state', async () => {
  const db = createDb();
  const conversationId = db.prepare(`
    INSERT INTO conversations (phone, contact_name)
    VALUES ('5511999999999@c.us', '5511999999999')
  `).run().lastInsertRowid;
  const maria = contact('5511999999999@c.us', {
    name: 'Maria',
    getAbout: async () => 'Atendimento comercial',
    getProfilePicUrl: async () => 'https://example.test/maria.jpg'
  });
  const chat = {
    id: { _serialized: '5511999999999@c.us' },
    name: '5511999999999',
    isGroup: false,
    archived: true,
    getContact: async () => maria
  };

  const result = await syncConversationProfile(
    {},
    db,
    { id: conversationId, phone: '5511999999999@c.us' },
    chat
  );

  assert.equal(result.isGroup, false);
  assert.equal(result.conversation.contact_name, 'Maria');
  assert.equal(result.conversation.profile_about, 'Atendimento comercial');
  assert.equal(result.conversation.profile_pic_url, 'https://example.test/maria.jpg');
  assert.equal(result.conversation.whatsapp_archived, 1);
  assert.ok(result.conversation.archived_at);
  assert.equal(result.contact.is_saved, 1);
  db.close();
});

test('syncs group metadata and replaces its current participant directory', async () => {
  const db = createDb();
  const conversationId = db.prepare(`
    INSERT INTO conversations (phone, contact_name)
    VALUES ('120363000000000000@g.us', 'Grupo antigo')
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO group_participants (conversation_id, participant_id, name)
    VALUES (?, 'old@lid', 'Participante removido')
  `).run(conversationId);

  const alice = contact('5511999999999@c.us', { name: 'Alice' });
  const client = {
    getContacts: async () => [alice],
    getContactById: async id => contact(id, {
      number: '5511888888888',
      name: 'Bruno',
      isMyContact: false
    }),
    getProfilePicUrl: async () => 'https://example.test/group.jpg'
  };
  const chat = {
    id: { _serialized: '120363000000000000@g.us' },
    name: 'Equipe Comercial',
    isGroup: true,
    archived: false,
    description: 'Grupo oficial de vendas',
    owner: { _serialized: '5511999999999@c.us' },
    createdAt: new Date('2024-01-02T03:04:05Z'),
    participants: [
      { id: { _serialized: '5511999999999@c.us' }, isAdmin: true, isSuperAdmin: true },
      { id: { _serialized: '222222222222@lid' }, isAdmin: false, isSuperAdmin: false }
    ]
  };

  const result = await syncConversationProfile(
    client,
    db,
    { id: conversationId, phone: '120363000000000000@g.us' },
    chat
  );

  assert.equal(result.isGroup, true);
  assert.equal(result.conversation.contact_name, 'Equipe Comercial');
  assert.equal(result.conversation.group_description, 'Grupo oficial de vendas');
  assert.equal(result.conversation.group_owner, '5511999999999@c.us');
  assert.equal(result.conversation.group_created_at, '2024-01-02 03:04:05');
  assert.equal(result.conversation.profile_pic_url, 'https://example.test/group.jpg');
  assert.deepEqual(
    db.prepare('SELECT participant_id, phone, name, is_admin FROM group_participants ORDER BY name').all(),
    [
      { participant_id: '5511999999999@c.us', phone: '5511999999999', name: 'Alice', is_admin: 1 },
      { participant_id: '222222222222@lid', phone: '5511888888888', name: 'Bruno', is_admin: 0 }
    ]
  );
  assert.equal(db.prepare("SELECT COUNT(*) count FROM group_participants WHERE participant_id = 'old@lid'").get().count, 0);
  db.close();
});

test('resolves group participant LIDs to phone contacts in one batch and backfills old messages', async () => {
  const db = createDb();
  const conversationId = db.prepare(`
    INSERT INTO conversations (phone, contact_name, is_group)
    VALUES ('120363000000000001@g.us', 'Equipe LID', 1)
  `).run().lastInsertRowid;
  const lid = '987654321012345@lid';
  const phoneId = '5511987654321@c.us';
  db.prepare(`
    INSERT INTO messages (conversation_id, external_id, from_type, content)
    VALUES (?, ?, 'client', 'Mensagem antiga')
  `).run(conversationId, `false_120363000000000001@g.us_ABC123_${lid}`);

  let lidBatchCalls = 0;
  let contactByIdCalls = 0;
  const alice = contact(phoneId, { name: 'Alice Telefônica' });
  const client = {
    getContacts: async () => [alice],
    getContactLidAndPhone: async ids => {
      lidBatchCalls += 1;
      assert.deepEqual(ids, [lid]);
      return [{ lid, pn: phoneId }];
    },
    getContactById: async () => {
      contactByIdCalls += 1;
      return null;
    }
  };
  const chat = {
    id: { _serialized: '120363000000000001@g.us' },
    name: 'Equipe LID',
    isGroup: true,
    participants: [{ id: { _serialized: lid }, isAdmin: true }]
  };

  const result = await syncConversationProfile(
    client,
    db,
    { id: conversationId, phone: '120363000000000001@g.us' },
    chat
  );

  assert.equal(lidBatchCalls, 1);
  assert.equal(contactByIdCalls, 0);
  assert.deepEqual(result.participants.map(row => ({
    participant_id: row.participant_id,
    phone: row.phone,
    name: row.name
  })), [{
    participant_id: lid,
    phone: '5511987654321',
    name: 'Alice Telefônica'
  }]);
  const participant = db.prepare(`
    SELECT gp.participant_id, gp.phone, gp.name, c.whatsapp_id
    FROM group_participants gp
    JOIN contacts c ON c.id = gp.contact_id
  `).get();
  assert.deepEqual(participant, {
    participant_id: lid,
    phone: '5511987654321',
    name: 'Alice Telefônica',
    whatsapp_id: phoneId
  });
  assert.deepEqual(
    db.prepare('SELECT participant_id, participant_phone, participant_name FROM messages').get(),
    {
      participant_id: lid,
      participant_phone: '5511987654321',
      participant_name: 'Alice Telefônica'
    }
  );
  db.close();
});

test('keeps LID resolution failures safe instead of presenting the LID as a phone', async () => {
  const db = createDb();
  const conversationId = db.prepare(`
    INSERT INTO conversations (phone, contact_name, is_group)
    VALUES ('120363000000000002@g.us', 'Fallback', 1)
  `).run().lastInsertRowid;
  const lid = '123456789012345@lid';
  const client = {
    getContacts: async () => [],
    getContactLidAndPhone: async () => { throw new Error('Store indisponível'); },
    getContactById: async id => contact(id, {
      number: '123456789012345',
      name: 'Nome do LID',
      isMyContact: false
    })
  };
  const chat = {
    id: { _serialized: '120363000000000002@g.us' },
    name: 'Fallback',
    isGroup: true,
    participants: [{ id: { _serialized: lid } }]
  };

  const result = await syncConversationProfile(
    client,
    db,
    { id: conversationId, phone: '120363000000000002@g.us' },
    chat
  );

  assert.equal(result.participants[0].participant_id, lid);
  assert.equal(result.participants[0].phone, null);
  assert.equal(result.participants[0].name, 'Nome do LID');
  db.close();
});

test('backfills group message authors without replacing better existing identity data', () => {
  const db = createDb();
  const conversationId = db.prepare(`
    INSERT INTO conversations (phone, contact_name, is_group)
    VALUES ('120363000000000003@g.us', 'Backfill', 1)
  `).run().lastInsertRowid;
  const lid = '555555555555555@lid';
  const savedContactId = db.prepare(`
    INSERT INTO contacts (whatsapp_id, phone, name, is_saved)
    VALUES ('5511977777777@c.us', '5511977777777', 'Carla Correta', 1)
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO group_participants (
      conversation_id, contact_id, participant_id, phone, name
    ) VALUES (?, ?, ?, '5511977777777', 'Carla Correta')
  `).run(conversationId, savedContactId, lid);
  const insert = db.prepare(`
    INSERT INTO messages (
      conversation_id, external_id, from_type, content,
      participant_id, participant_phone, participant_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const externalId = `false_120363000000000003@g.us_MSG_${lid}`;
  insert.run(conversationId, externalId, 'client', 'Sem dados', null, null, null);
  insert.run(conversationId, externalId, 'client', 'Dados fracos', lid, '555555555555555', '555555555555555');
  insert.run(conversationId, externalId, 'client', 'Dados melhores', lid, '5511966666666', 'Nome Histórico Melhor');
  insert.run(conversationId, externalId, 'vendor', 'Saída', null, null, null);

  const stats = backfillGroupMessageParticipants(db, conversationId);
  const rows = db.prepare(`
    SELECT content, participant_id, participant_phone, participant_name
    FROM messages
    ORDER BY id
  `).all();

  assert.deepEqual(stats, { scanned: 3, updated: 2 });
  assert.deepEqual(rows, [
    {
      content: 'Sem dados',
      participant_id: lid,
      participant_phone: '5511977777777',
      participant_name: 'Carla Correta'
    },
    {
      content: 'Dados fracos',
      participant_id: lid,
      participant_phone: '5511977777777',
      participant_name: 'Carla Correta'
    },
    {
      content: 'Dados melhores',
      participant_id: lid,
      participant_phone: '5511966666666',
      participant_name: 'Nome Histórico Melhor'
    },
    {
      content: 'Saída',
      participant_id: null,
      participant_phone: null,
      participant_name: null
    }
  ]);
  db.close();
});
