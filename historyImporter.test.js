const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureSchema } = require('./schema');
const { importExistingChats } = require('./historyImporter');

const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]).toString('base64');
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString('base64');

function createDb() {
  const db = new Database(':memory:');
  ensureSchema(db);
  return db;
}

function fakeChat(id, name, messages, overrides = {}) {
  return {
    id: { _serialized: id },
    name,
    timestamp: 1700000000,
    fetchMessages: async options => {
      assert.equal(options.limit, 50);
      return messages;
    },
    ...overrides
  };
}

test('imports lid, c.us, and group chats with their recent messages', async () => {
  const db = createDb();
  const chats = [
    fakeChat('abc@lid', 'Cliente LID', [
      { id: { _serialized: 'msg-1' }, body: 'Oi', fromMe: false, timestamp: 1700000001 },
      { id: { _serialized: 'msg-2' }, body: 'Resposta', fromMe: true, timestamp: 1700000002 }
    ]),
    fakeChat('5511999999999@c.us', 'Cliente Phone', [
      { id: { _serialized: 'msg-3' }, body: 'Telefone', fromMe: false, timestamp: 1700000003 }
    ]),
    fakeChat('120363000000000000@g.us', 'Grupo', [
      { id: { _serialized: 'msg-4' }, body: 'Grupo msg', fromMe: false, timestamp: 1700000004 }
    ]),
    fakeChat('status@broadcast', 'Status', [
      { id: { _serialized: 'skip-1' }, body: 'Skip', fromMe: false, timestamp: 1700000005 }
    ])
  ];
  const progress = [];

  const stats = await importExistingChats({
    whatsapp: { getChats: async () => chats },
    db,
    limit: 50,
    onConversationImported: (conversationId, detail) => progress.push({ conversationId, detail }),
    logger: { log() {}, error() {} }
  });

  assert.equal(stats.totalChats, 4);
  assert.equal(stats.skippedChats, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE from_type = 'vendor'").get().count, 1);
  assert.equal(db.prepare("SELECT delivery_status FROM messages WHERE external_id = 'msg-1'").get().delivery_status, 'received');
  assert.equal(db.prepare("SELECT delivery_status FROM messages WHERE external_id = 'msg-2'").get().delivery_status, 'sent');
  assert.equal(
    db.prepare("SELECT last_activity_at FROM conversations WHERE phone = 'abc@lid'").get().last_activity_at,
    '2023-11-14 22:13:22'
  );
  assert.equal(progress.length, 3);
  assert.deepEqual(progress.map(item => item.detail.importedMessages), [2, 1, 1]);

  db.close();
});

test('repairs stale chat activity from the latest persisted message', async () => {
  const db = createDb();
  const conversationId = db.prepare(`
    INSERT INTO conversations (
      phone,
      contact_name,
      status,
      last_activity_at,
      created_at,
      updated_at
    )
    VALUES ('stale@lid', 'Stale', 'unassigned', '2030-01-01 00:00:00', '2023-11-14 22:13:21', '2030-01-01 00:00:00')
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO messages (
      conversation_id,
      external_id,
      from_type,
      content,
      delivery_status,
      created_at
    )
    VALUES (?, 'stale-message', 'client', 'Mensagem real', 'received', '2023-11-14 22:13:21')
  `).run(conversationId);
  const progress = [];
  const chat = fakeChat('stale@lid', 'Stale', [
    {
      id: { _serialized: 'stale-message' },
      body: 'Mensagem real',
      fromMe: false,
      timestamp: 1700000001
    }
  ], {
    // A atividade do objeto Chat pode apontar para um evento que o sistema não
    // persiste como mensagem e não deve comandar a fila.
    timestamp: 1893456000
  });

  const stats = await importExistingChats({
    whatsapp: { getChats: async () => [chat] },
    db,
    limit: 50,
    onConversationImported: (id, detail) => progress.push({ id, detail }),
    logger: { log() {}, error() {} }
  });

  const conversation = db.prepare('SELECT last_activity_at FROM conversations WHERE id = ?').get(conversationId);
  assert.equal(conversation.last_activity_at, '2023-11-14 22:13:21');
  assert.equal(stats.messagesImported, 0);
  assert.equal(stats.messagesUpdated, 0);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].detail.activityUpdated, true);

  db.close();
});

test('stores fetched history in chronological order even when the source array is reversed', async () => {
  const db = createDb();
  const chats = [
    fakeChat('ordered@lid', 'Ordenado', [
      { id: { _serialized: 'msg-new' }, body: 'Nova', fromMe: false, timestamp: 1700000003 },
      { id: { _serialized: 'msg-old' }, body: 'Antiga', fromMe: false, timestamp: 1700000001 },
      { id: { _serialized: 'msg-mid' }, body: 'Meio', fromMe: false, timestamp: 1700000002 }
    ])
  ];

  await importExistingChats({
    whatsapp: { getChats: async () => chats },
    db,
    limit: 50,
    logger: { log() {}, error() {} }
  });

  const rows = db.prepare('SELECT external_id, created_at FROM messages ORDER BY id').all();
  assert.deepEqual(rows.map(row => row.external_id), ['msg-old', 'msg-mid', 'msg-new']);
  assert.deepEqual(rows.map(row => row.created_at), [
    '2023-11-14 22:13:21',
    '2023-11-14 22:13:22',
    '2023-11-14 22:13:23'
  ]);

  db.close();
});

test('opens a new conversation when only a closed conversation exists for the same chat', async () => {
  const db = createDb();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'closed')")
    .run('reopened@lid', 'Encerrada');

  const chats = [
    fakeChat('reopened@lid', 'Reaberta', [
      { id: { _serialized: 'new-after-close' }, body: 'Voltei', fromMe: false, timestamp: 1700000004 }
    ])
  ];

  await importExistingChats({
    whatsapp: { getChats: async () => chats },
    db,
    limit: 50,
    logger: { log() {}, error() {} }
  });

  const conversations = db.prepare('SELECT status FROM conversations WHERE phone = ? ORDER BY id').all('reopened@lid');
  assert.deepEqual(conversations.map(row => row.status), ['closed', 'unassigned']);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM messages WHERE external_id = 'new-after-close'").get().count, 1);

  db.close();
});

test('reuses one conversation when whatsapp alternates between phone and lid identifiers', async () => {
  const db = createDb();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511999999999@c.us', 'Cliente');

  const chats = [
    fakeChat('123456789@lid', 'Cliente', [
      { id: { _serialized: 'lid-message' }, body: 'Cheguei pelo LID', fromMe: false, timestamp: 1700000005 }
    ])
  ];
  await importExistingChats({
    whatsapp: {
      getChats: async () => chats,
      getContactLidAndPhone: async () => [{
        lid: '123456789@lid',
        pn: '5511999999999@c.us'
      }]
    },
    db,
    limit: 50,
    logger: { log() {}, error() {} }
  });

  assert.equal(db.prepare('SELECT COUNT(*) count FROM conversations').get().count, 1);
  assert.equal(
    db.prepare("SELECT conversation_id FROM messages WHERE external_id = 'lid-message'").get().conversation_id,
    db.prepare("SELECT id FROM conversations WHERE phone = '5511999999999@c.us'").get().id
  );
  db.close();
});

test('backfills existing conversations without duplicating messages', async () => {
  const db = createDb();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'unassigned')")
    .run('abc@lid', 'Existing');

  const chats = [
    fakeChat('abc@lid', 'Cliente LID', [
      { id: { _serialized: 'msg-1' }, body: 'Oi', fromMe: false, timestamp: 1700000001 },
      { id: { _serialized: 'msg-2' }, body: 'Resposta', fromMe: true, timestamp: 1700000002 }
    ])
  ];

  const importerArgs = {
    whatsapp: { getChats: async () => chats },
    db,
    limit: 50,
    logger: { log() {}, error() {} }
  };

  await importExistingChats(importerArgs);
  const secondStats = await importExistingChats(importerArgs);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 2);
  assert.equal(secondStats.messagesImported, 0);
  assert.equal(secondStats.messagesUpdated, 0);
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'messages'").get().seq, 2);

  db.close();
});

test('does not keep new conversations that imported no messages', async () => {
  const db = createDb();
  const chats = [
    fakeChat('empty@lid', 'Chat Vazio', [])
  ];

  const stats = await importExistingChats({
    whatsapp: { getChats: async () => chats },
    db,
    limit: 50,
    logger: { log() {}, error() {} }
  });

  assert.equal(stats.newConversations, 0);
  assert.equal(stats.skippedChats, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 0);

  db.close();
});

test('recent sync imports only newest chats without downloading media', async () => {
  const db = createDb();
  let downloadCalls = 0;
  const chats = [
    fakeChat('old@lid', 'Antigo', [
      { id: { _serialized: 'old-1' }, body: 'antiga', fromMe: false, timestamp: 1700000001 }
    ], { timestamp: 1700000001 }),
    fakeChat('new@lid', 'Novo', [
      {
        id: { _serialized: 'new-1' },
        body: '',
        fromMe: false,
        timestamp: 1700000010,
        hasMedia: true,
        type: 'image',
        downloadMedia: async () => {
          downloadCalls += 1;
          return { mimetype: 'image/jpeg', data: JPEG_BASE64 };
        }
      }
    ], { timestamp: 1700000010 })
  ];

  const stats = await importExistingChats({
    whatsapp: { getChats: async () => chats },
    db,
    limit: 50,
    maxChats: 1,
    skipMediaDownload: true,
    logger: { log() {}, error() {} }
  });

  assert.equal(stats.totalChats, 1);
  assert.equal(stats.messagesImported, 1);
  assert.equal(downloadCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 1);
  assert.equal(db.prepare('SELECT phone FROM conversations').get().phone, 'new@lid');
  assert.equal(db.prepare('SELECT media_url FROM messages').get().media_url, null);

  db.close();
});

test('updates contact name and profile picture from WhatsApp contact data', async () => {
  const db = createDb();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'unassigned')")
    .run('5541999999999@c.us', '+55 41 9999-9999');

  const chats = [
    fakeChat('5541999999999@c.us', '+55 41 9999-9999', [
      { id: { _serialized: 'msg-profile-1' }, body: 'Oi', fromMe: false, timestamp: 1700000001 }
    ], {
      getContact: async () => ({
        id: { _serialized: '5541999999999@c.us' },
        name: '',
        shortName: 'Maria',
        pushname: 'Maria Silva',
        getProfilePicUrl: async () => 'https://example.com/profile.jpg'
      })
    })
  ];

  await importExistingChats({
    whatsapp: { getChats: async () => chats },
    db,
    limit: 50,
    refreshProfiles: true,
    logger: { log() {}, error() {} }
  });

  const conversation = db.prepare('SELECT contact_name, profile_pic_url FROM conversations WHERE phone = ?')
    .get('5541999999999@c.us');
  assert.equal(conversation.contact_name, 'Maria');
  assert.equal(conversation.profile_pic_url, 'https://example.com/profile.jpg');

  db.close();
});

test('downloads media and backfills existing placeholder messages', async () => {
  const db = createDb();
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-import-media-'));

  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'unassigned')")
    .run('abc@lid', 'Existing');
  const conv = db.prepare('SELECT id FROM conversations WHERE phone = ?').get('abc@lid');
  db.prepare(`
    INSERT INTO messages (conversation_id, external_id, from_type, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(conv.id, 'media-1', 'client', '(mídia)', '2023-11-14 22:13:21');

  const chats = [
    fakeChat('abc@lid', 'Cliente LID', [
      {
        id: { _serialized: 'media-1' },
        body: 'Legenda da foto',
        fromMe: false,
        timestamp: 1700000001,
        hasMedia: true,
        type: 'image',
        downloadMedia: async () => ({
          mimetype: 'image/jpeg',
          filename: 'foto cliente.jpg',
          data: JPEG_BASE64
        })
      },
      {
        id: { _serialized: 'media-2' },
        body: '',
        fromMe: false,
        timestamp: 1700000002,
        hasMedia: true,
        type: 'audio',
        downloadMedia: async () => null
      },
      {
        id: { _serialized: 'media-3' },
        body: '',
        fromMe: false,
        timestamp: 1700000003,
        hasMedia: true,
        type: 'image',
        downloadMedia: async () => ({
          mimetype: 'image/png',
          data: PNG_BASE64
        })
      }
    ])
  ];

  const stats = await importExistingChats({
    whatsapp: { getChats: async () => chats },
    db,
    limit: 50,
    mediaRoot,
    logger: { log() {}, error() {} }
  });

  assert.equal(stats.messagesImported, 2);
  assert.equal(stats.messagesUpdated, 1);
  assert.equal(stats.mediaImported, 2);
  assert.equal(stats.mediaUnavailable, 1);

  const updated = db.prepare('SELECT * FROM messages WHERE external_id = ?').get('media-1');
  assert.equal(updated.content, 'Legenda da foto');
  assert.equal(updated.media_type, 'image');
  assert.equal(updated.media_mimetype, 'image/jpeg');
  assert.equal(updated.media_filename, 'foto cliente.jpg');
  assert.equal(updated.media_url, '/media/media-1.jpg');
  assert.equal(updated.media_size, Buffer.byteLength(JPEG_BASE64, 'base64'));
  assert.equal(fs.existsSync(path.join(mediaRoot, 'media-1.jpg')), true);

  const unavailable = db.prepare('SELECT * FROM messages WHERE external_id = ?').get('media-2');
  assert.equal(unavailable.content, '(áudio indisponível)');
  assert.equal(unavailable.media_url, null);
  assert.equal(unavailable.media_unavailable, 1);

  const imageWithoutCaption = db.prepare('SELECT * FROM messages WHERE external_id = ?').get('media-3');
  assert.equal(imageWithoutCaption.content, '');
  assert.equal(imageWithoutCaption.media_type, 'image');
  assert.equal(imageWithoutCaption.media_url, '/media/media-3.png');
  assert.equal(imageWithoutCaption.media_unavailable, 0);
  assert.equal(fs.existsSync(path.join(mediaRoot, 'media-3.png')), true);

  db.close();
});

test('continues importing other chats when one chat cannot fetch messages', async () => {
  const db = createDb();
  const logs = [];
  const chats = [
    fakeChat('abc@lid', 'Cliente LID', [
      { id: { _serialized: 'msg-1' }, body: 'Oi', fromMe: false, timestamp: 1700000001 }
    ]),
    {
      id: { _serialized: '5511999999999@c.us' },
      name: 'Cliente Falha',
      timestamp: 1700000000,
      fetchMessages: async () => {
        throw new Error('detached frame');
      }
    },
    fakeChat('120363000000000000@g.us', 'Grupo', [
      { id: { _serialized: 'msg-2' }, body: 'Grupo msg', fromMe: false, timestamp: 1700000002 }
    ])
  ];

  const stats = await importExistingChats({
    whatsapp: { getChats: async () => chats },
    db,
    limit: 50,
    logger: { log() {}, error(message) { logs.push(message); } }
  });

  assert.equal(stats.failedChats, 1);
  assert.equal(stats.messagesImported, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 2);
  assert.match(logs[0], /Erro ao importar mensagens de Cliente Falha/);

  db.close();
});

test('does not download media again when message already has a media url', async () => {
  const db = createDb();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'unassigned')")
    .run('abc@lid', 'Existing');
  const conv = db.prepare('SELECT id FROM conversations WHERE phone = ?').get('abc@lid');
  db.prepare(`
    INSERT INTO messages (
      conversation_id,
      external_id,
      from_type,
      content,
      media_type,
      media_url,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(conv.id, 'media-1', 'client', 'Legenda', 'image', '/media/media-1.jpg', '2023-11-14 22:13:21');

  let downloadCalls = 0;
  const chats = [
    fakeChat('abc@lid', 'Cliente LID', [
      {
        id: { _serialized: 'media-1' },
        body: 'Legenda',
        fromMe: false,
        timestamp: 1700000001,
        hasMedia: true,
        type: 'image',
        downloadMedia: async () => {
          downloadCalls += 1;
          return null;
        }
      }
    ])
  ];

  await importExistingChats({
    whatsapp: { getChats: async () => chats },
    db,
    limit: 50,
    logger: { log() {}, error() {} }
  });

  assert.equal(downloadCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 1);

  db.close();
});

test('skips unavailable media unless retry is requested', async () => {
  const db = createDb();
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-retry-media-'));
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'unassigned')")
    .run('abc@lid', 'Existing');
  const conv = db.prepare('SELECT id FROM conversations WHERE phone = ?').get('abc@lid');
  db.prepare(`
    INSERT INTO messages (conversation_id, external_id, from_type, content, media_unavailable, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(conv.id, 'media-1', 'client', 'Legenda antiga', 1, '2023-11-14 22:13:21');

  let downloadCalls = 0;
  const chats = [
    fakeChat('abc@lid', 'Cliente LID', [
      {
        id: { _serialized: 'media-1' },
        body: '',
        fromMe: false,
        timestamp: 1700000001,
        hasMedia: true,
        type: 'image',
        downloadMedia: async () => {
          downloadCalls += 1;
          return {
            mimetype: 'image/jpeg',
            data: JPEG_BASE64
          };
        }
      }
    ])
  ];
  const importerArgs = {
    whatsapp: { getChats: async () => chats },
    db,
    limit: 50,
    mediaRoot,
    logger: { log() {}, error() {} }
  };

  await importExistingChats(importerArgs);
  assert.equal(downloadCalls, 0);
  assert.equal(db.prepare('SELECT media_url FROM messages WHERE external_id = ?').get('media-1').media_url, null);

  await importExistingChats({ ...importerArgs, retryUnavailableMedia: true });
  assert.equal(downloadCalls, 1);

  const retried = db.prepare('SELECT content, media_url, media_unavailable FROM messages WHERE external_id = ?').get('media-1');
  assert.equal(retried.content, 'Legenda antiga');
  assert.equal(retried.media_url, '/media/media-1.jpg');
  assert.equal(retried.media_unavailable, 0);

  db.close();
});

test('persists group metadata and identifies each incoming participant', async () => {
  const db = createDb();
  const groupMessage = {
    id: { _serialized: 'false_120363000000000000@g.us_GROUPMSG_5511999999999@c.us' },
    author: '5511999999999@c.us',
    body: 'Mensagem da Alice',
    fromMe: false,
    timestamp: 1700000001
  };
  const chat = fakeChat('120363000000000000@g.us', 'Equipe Comercial', [groupMessage], {
    isGroup: true,
    description: 'Grupo oficial de vendas',
    archived: true
  });
  const alice = {
    id: { _serialized: '5511999999999@c.us' },
    number: '5511999999999',
    name: 'Alice Souza',
    isUser: true,
    isWAContact: true,
    isMyContact: true
  };

  await importExistingChats({
    whatsapp: {
      getChats: async () => [chat],
      getContacts: async () => [alice]
    },
    db,
    limit: 50,
    chatImportDelayMs: 0,
    logger: { log() {}, error() {} }
  });

  const conversation = db.prepare(`
    SELECT is_group, group_description, whatsapp_archived
    FROM conversations
  `).get();
  const message = db.prepare(`
    SELECT participant_id, participant_phone, participant_name
    FROM messages
  `).get();
  assert.deepEqual(conversation, {
    is_group: 1,
    group_description: 'Grupo oficial de vendas',
    whatsapp_archived: 1
  });
  assert.deepEqual(message, {
    participant_id: '5511999999999@c.us',
    participant_phone: '5511999999999',
    participant_name: 'Alice Souza'
  });
  db.close();
});

test('enriches an existing group message through getContactById without repeated updates', async () => {
  const db = createDb();
  const conversationId = db.prepare(`
    INSERT INTO conversations (phone, contact_name, is_group, status)
    VALUES ('120363000000000000@g.us', 'Equipe', 1, 'unassigned')
  `).run().lastInsertRowid;
  const externalId = 'false_120363000000000000@g.us_GROUPMSG_123456789@lid';
  db.prepare(`
    INSERT INTO messages (conversation_id, external_id, from_type, content, created_at)
    VALUES (?, ?, 'client', 'Oi', '2023-11-14 22:13:21')
  `).run(conversationId, externalId);
  const message = {
    id: { _serialized: externalId },
    author: '123456789@lid',
    body: 'Oi',
    fromMe: false,
    timestamp: 1700000001
  };
  const chat = fakeChat('120363000000000000@g.us', 'Equipe', [message], { isGroup: true });
  let contactLookups = 0;
  const args = {
    whatsapp: {
      getChats: async () => [chat],
      getContactById: async id => {
        contactLookups += 1;
        assert.equal(id, '123456789@lid');
        return {
          id: { _serialized: '5511888888888@c.us' },
          number: '5511888888888',
          pushname: 'Bruno Lima'
        };
      }
    },
    db,
    limit: 50,
    chatImportDelayMs: 0,
    logger: { log() {}, error() {} }
  };

  const first = await importExistingChats(args);
  const second = await importExistingChats(args);

  assert.equal(first.messagesUpdated, 1);
  assert.equal(second.messagesUpdated, 0);
  assert.equal(contactLookups, 1);
  assert.deepEqual(
    db.prepare('SELECT participant_id, participant_phone, participant_name FROM messages WHERE external_id = ?').get(externalId),
    {
      participant_id: '123456789@lid',
      participant_phone: '5511888888888',
      participant_name: 'Bruno Lima'
    }
  );
  db.close();
});

test('times out a stalled getChats call and allows a later import to run', async () => {
  const db = createDb();
  const startedAt = Date.now();

  await assert.rejects(
    importExistingChats({
      whatsapp: { getChats: async () => new Promise(() => {}) },
      db,
      getChatsTimeoutMs: 20,
      logger: { log() {}, error() {} }
    }),
    /getChats excedeu 20ms/
  );

  assert.ok(Date.now() - startedAt < 500, 'o timeout deve liberar o chamador rapidamente');
  const nextStats = await importExistingChats({
    whatsapp: { getChats: async () => [] },
    db,
    getChatsTimeoutMs: 20,
    logger: { log() {}, error() {} }
  });
  assert.equal(nextStats.totalChats, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 0);
  db.close();
});

test('adaptively expands a recent fetch until it overlaps history after a gap larger than 50', async () => {
  const db = createDb();
  const conversationId = db.prepare(`
    INSERT INTO conversations (phone, contact_name, status)
    VALUES ('adaptive@lid', 'Adaptativo', 'unassigned')
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO messages (
      conversation_id, external_id, from_type, content, delivery_status, created_at
    ) VALUES (?, 'known-0', 'client', 'já conhecida', 'received', '2023-11-14 22:13:20')
  `).run(conversationId);

  const messages = [
    { id: { _serialized: 'known-0' }, body: 'já conhecida', fromMe: false, timestamp: 1700000000 },
    ...Array.from({ length: 80 }, (_, index) => ({
      id: { _serialized: `adaptive-${index + 1}` },
      body: `mensagem ${index + 1}`,
      fromMe: false,
      timestamp: 1700000000 + index + 1
    }))
  ];
  const requestedLimits = [];
  const chat = fakeChat('adaptive@lid', 'Adaptativo', messages, {
    timestamp: 1700000080,
    fetchMessages: async ({ limit }) => {
      requestedLimits.push(limit);
      return messages.slice(-limit);
    }
  });

  const stats = await importExistingChats({
    whatsapp: { getChats: async () => [chat] },
    db,
    limit: 50,
    adaptiveBackfill: true,
    maxFetchLimit: 200,
    chatImportDelayMs: 0,
    logger: { log() {}, error() {} }
  });

  assert.deepEqual(requestedLimits, [50, 100]);
  assert.equal(stats.adaptiveFetches, 1);
  assert.equal(stats.gapLimitReached, 0);
  assert.equal(stats.messagesFetched, 81);
  assert.equal(stats.messagesImported, 80);
  assert.equal(stats.messagesSkippedKnown, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 81);
  assert.deepEqual(
    db.prepare(`
      SELECT gap_target_external_id, gap_fetch_limit, history_complete
      FROM conversation_sync_state
      WHERE conversation_id = ?
    `).get(conversationId),
    { gap_target_external_id: null, gap_fetch_limit: null, history_complete: 1 }
  );
  db.close();
});

test('persists an unresolved overlap and increases its fetch budget on the next run', async () => {
  const db = createDb();
  const conversationId = db.prepare(`
    INSERT INTO conversations (phone, contact_name, status)
    VALUES ('persistent-gap@lid', 'Lacuna', 'unassigned')
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO messages (
      conversation_id, external_id, from_type, content, delivery_status, created_at
    ) VALUES (?, 'gap-known-0', 'client', 'âncora', 'received', '2023-11-14 22:13:20')
  `).run(conversationId);

  const messages = [
    { id: { _serialized: 'gap-known-0' }, body: 'âncora', fromMe: false, timestamp: 1700000000 },
    ...Array.from({ length: 150 }, (_, index) => ({
      id: { _serialized: `gap-${index + 1}` },
      body: `lacuna ${index + 1}`,
      fromMe: false,
      timestamp: 1700000000 + index + 1
    }))
  ];
  const requestedLimits = [];
  const chat = fakeChat('persistent-gap@lid', 'Lacuna', messages, {
    timestamp: 1700000150,
    fetchMessages: async ({ limit }) => {
      requestedLimits.push(limit);
      return messages.slice(-limit);
    }
  });
  const importerArgs = {
    whatsapp: { getChats: async () => [chat] },
    db,
    limit: 50,
    adaptiveBackfill: true,
    maxFetchLimit: 100,
    absoluteMaxFetchLimit: 400,
    chatImportDelayMs: 0,
    logger: { log() {}, error() {} }
  };

  const firstStats = await importExistingChats({
    ...importerArgs,
    // Sem cursor anterior, até o sync recente deve detectar e persistir a lacuna.
    resumePersistentGap: false
  });
  const afterFirst = db.prepare(`
    SELECT gap_target_external_id, gap_fetch_limit, history_complete
    FROM conversation_sync_state
    WHERE conversation_id = ?
  `).get(conversationId);

  assert.deepEqual(requestedLimits, [50, 100]);
  assert.equal(firstStats.gapLimitReached, 1);
  assert.deepEqual(afterFirst, {
    gap_target_external_id: 'gap-known-0',
    gap_fetch_limit: 100,
    history_complete: 0
  });

  const secondStats = await importExistingChats(importerArgs);
  const afterSecond = db.prepare(`
    SELECT gap_target_external_id, gap_fetch_limit, history_complete
    FROM conversation_sync_state
    WHERE conversation_id = ?
  `).get(conversationId);

  assert.deepEqual(requestedLimits, [50, 100, 200]);
  assert.equal(secondStats.gapLimitReached, 0);
  assert.equal(secondStats.messagesImported, 50);
  assert.deepEqual(afterSecond, {
    gap_target_external_id: null,
    gap_fetch_limit: null,
    history_complete: 1
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 151);
  db.close();
});

test('never expands a persistent gap beyond the configured absolute fetch limit', async () => {
  const db = createDb();
  const conversationId = db.prepare(`
    INSERT INTO conversations (phone, contact_name, status)
    VALUES ('capped-gap@lid', 'Lacuna limitada', 'unassigned')
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO messages (
      conversation_id, external_id, from_type, content, delivery_status, created_at
    ) VALUES (?, 'cap-known-0', 'client', 'âncora distante', 'received', '2023-11-14 22:13:20')
  `).run(conversationId);
  db.prepare(`
    INSERT INTO conversation_sync_state (
      conversation_id, gap_target_external_id, gap_fetch_limit, updated_at
    ) VALUES (?, 'cap-known-0', 200, CURRENT_TIMESTAMP)
  `).run(conversationId);

  const messages = [
    { id: { _serialized: 'cap-known-0' }, body: 'âncora distante', fromMe: false, timestamp: 1700000000 },
    ...Array.from({ length: 500 }, (_, index) => ({
      id: { _serialized: `capped-${index + 1}` },
      body: `mensagem limitada ${index + 1}`,
      fromMe: false,
      timestamp: 1700000000 + index + 1
    }))
  ];
  const requestedLimits = [];
  const chat = fakeChat('capped-gap@lid', 'Lacuna limitada', messages, {
    timestamp: 1700000500,
    fetchMessages: async ({ limit }) => {
      requestedLimits.push(limit);
      return messages.slice(-limit);
    }
  });
  const importerArgs = {
    whatsapp: { getChats: async () => [chat] },
    db,
    limit: 50,
    adaptiveBackfill: true,
    maxFetchLimit: 100,
    absoluteMaxFetchLimit: 250,
    chatImportDelayMs: 0,
    logger: { log() {}, error() {} }
  };

  const firstStats = await importExistingChats(importerArgs);
  const secondStats = await importExistingChats(importerArgs);

  assert.deepEqual(requestedLimits, [250, 250]);
  assert.equal(firstStats.gapLimitReached, 1);
  assert.equal(secondStats.gapLimitReached, 1);
  assert.deepEqual(
    db.prepare(`
      SELECT gap_target_external_id, gap_fetch_limit
      FROM conversation_sync_state
      WHERE conversation_id = ?
    `).get(conversationId),
    { gap_target_external_id: 'cap-known-0', gap_fetch_limit: 250 }
  );
  db.close();
});

test('recent sync starts from its small window without erasing a deep persistent gap', async () => {
  const db = createDb();
  const conversationId = db.prepare(`
    INSERT INTO conversations (phone, contact_name, status)
    VALUES ('recent-gap@lid', 'Gap recente', 'unassigned')
  `).run().lastInsertRowid;
  const insertKnown = db.prepare(`
    INSERT INTO messages (
      conversation_id, external_id, from_type, content, delivery_status, created_at
    ) VALUES (?, ?, 'client', ?, 'received', ?)
  `);
  insertKnown.run(
    conversationId,
    'deep-gap-anchor',
    'âncora profunda',
    '2023-11-14 22:13:20'
  );
  insertKnown.run(
    conversationId,
    'recent-known',
    'última conhecida',
    '2023-11-14 22:15:00'
  );
  db.prepare(`
    INSERT INTO conversation_sync_state (
      conversation_id, gap_target_external_id, gap_fetch_limit, history_complete, updated_at
    ) VALUES (?, 'deep-gap-anchor', 2000, 0, CURRENT_TIMESTAMP)
  `).run(conversationId);

  const messages = [
    {
      id: { _serialized: 'recent-known' },
      body: 'última conhecida',
      fromMe: false,
      timestamp: 1700000100
    },
    ...Array.from({ length: 49 }, (_, index) => ({
      id: { _serialized: `recent-after-gap-${index + 1}` },
      body: `nova recente ${index + 1}`,
      fromMe: false,
      timestamp: 1700000101 + index
    }))
  ];
  const requestedLimits = [];
  const chat = fakeChat('recent-gap@lid', 'Gap recente', messages, {
    timestamp: 1700000149,
    fetchMessages: async ({ limit }) => {
      requestedLimits.push(limit);
      return messages.slice(-limit);
    }
  });

  const stats = await importExistingChats({
    whatsapp: { getChats: async () => [chat] },
    db,
    limit: 50,
    adaptiveBackfill: true,
    maxFetchLimit: 500,
    absoluteMaxFetchLimit: 5000,
    resumePersistentGap: false,
    chatImportDelayMs: 0,
    logger: { log() {}, error() {} }
  });

  assert.deepEqual(requestedLimits, [50]);
  assert.equal(stats.messagesImported, 49);
  assert.deepEqual(
    db.prepare(`
      SELECT gap_target_external_id, gap_fetch_limit, history_complete,
             last_messages_fetched
      FROM conversation_sync_state
      WHERE conversation_id = ?
    `).get(conversationId),
    {
      gap_target_external_id: 'deep-gap-anchor',
      gap_fetch_limit: 2000,
      history_complete: 0,
      last_messages_fetched: 50
    }
  );
  db.close();
});

test('skips fully known messages without redownloading their media', async () => {
  const db = createDb();
  const conversationId = db.prepare(`
    INSERT INTO conversations (phone, contact_name, status)
    VALUES ('known@lid', 'Conhecida', 'unassigned')
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO messages (
      conversation_id, external_id, from_type, content, media_type, media_url,
      media_unavailable, delivery_status, created_at
    ) VALUES (?, 'known-media', 'client', 'legenda', 'image', '/media/known.jpg', 0, 'received', '2023-11-14 22:13:21')
  `).run(conversationId);
  let downloadCalls = 0;
  const message = {
    id: { _serialized: 'known-media' },
    body: 'legenda',
    fromMe: false,
    timestamp: 1700000001,
    hasMedia: true,
    type: 'image',
    downloadMedia: async () => {
      downloadCalls += 1;
      return { mimetype: 'image/jpeg', data: JPEG_BASE64 };
    }
  };

  const stats = await importExistingChats({
    whatsapp: { getChats: async () => [fakeChat('known@lid', 'Conhecida', [message])] },
    db,
    limit: 50,
    logger: { log() {}, error() {} }
  });

  assert.equal(stats.messagesFetched, 1);
  assert.equal(stats.messagesSkippedKnown, 1);
  assert.equal(stats.messagesImported, 0);
  assert.equal(stats.messagesUpdated, 0);
  assert.equal(downloadCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 1);
  db.close();
});

test('reconciles quoted references, edits, and advanced outbound ACK state', async () => {
  const db = createDb();
  const conversationId = db.prepare(`
    INSERT INTO conversations (phone, contact_name, status)
    VALUES ('reconcile@lid', 'Reconciliação', 'unassigned')
  `).run().lastInsertRowid;
  const insertExisting = db.prepare(`
    INSERT INTO messages (
      conversation_id, external_id, from_type, content, delivery_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertExisting.run(conversationId, 'quoted-1', 'client', 'pergunta', 'received', '2023-11-14 22:13:21');
  insertExisting.run(conversationId, 'outbound-1', 'vendor', 'respondendo', 'sent', '2023-11-14 22:13:22');
  insertExisting.run(conversationId, 'edited-1', 'client', 'texto antigo', 'received', '2023-11-14 22:13:23');

  const messages = [
    { id: { _serialized: 'quoted-1' }, body: 'pergunta', fromMe: false, timestamp: 1700000001 },
    { id: { _serialized: 'outbound-1' }, body: 'respondendo', fromMe: true, ack: 3, timestamp: 1700000002 },
    {
      id: { _serialized: 'edited-1' },
      body: 'texto corrigido',
      fromMe: false,
      timestamp: 1700000003,
      latestEditSenderTimestampMs: 1700000010000
    },
    {
      id: { _serialized: 'reply-1' },
      body: 'resposta citando',
      fromMe: false,
      timestamp: 1700000004,
      hasQuotedMsg: true,
      _data: { quotedMsg: { id: { _serialized: 'quoted-1' } } }
    }
  ];

  const stats = await importExistingChats({
    whatsapp: { getChats: async () => [fakeChat('reconcile@lid', 'Reconciliação', messages)] },
    db,
    limit: 50,
    logger: { log() {}, error() {} }
  });

  assert.equal(stats.messagesImported, 1);
  assert.equal(stats.messagesUpdated, 3);
  assert.equal(stats.messagesSkippedKnown, 1);
  assert.deepEqual(
    db.prepare('SELECT content, edited_at FROM messages WHERE external_id = ?').get('edited-1'),
    { content: 'texto corrigido', edited_at: '2023-11-14 22:13:30' }
  );
  assert.deepEqual(
    db.prepare('SELECT delivery_status, sent_at FROM messages WHERE external_id = ?').get('outbound-1'),
    { delivery_status: 'read', sent_at: '2023-11-14 22:13:22' }
  );
  assert.equal(
    db.prepare(`
      SELECT quoted.external_id
      FROM messages reply
      JOIN messages quoted ON quoted.id = reply.quoted_message_id
      WHERE reply.external_id = 'reply-1'
    `).get().external_id,
    'quoted-1'
  );
  db.close();
});

test('recovers a quoted message id through getQuotedMessage when raw metadata is absent', async () => {
  const db = createDb();
  const conversationId = db.prepare(`
    INSERT INTO conversations (phone, contact_name, status)
    VALUES ('quote-fallback@lid', 'Citação fallback', 'unassigned')
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO messages (
      conversation_id, external_id, from_type, content, delivery_status, created_at
    ) VALUES (?, 'fallback-quoted', 'client', 'mensagem original', 'received', '2023-11-14 22:13:21')
  `).run(conversationId);
  let quotedLookups = 0;
  const reply = {
    id: { _serialized: 'fallback-reply' },
    body: 'resposta',
    fromMe: false,
    timestamp: 1700000002,
    hasQuotedMsg: true,
    getQuotedMessage: async () => {
      quotedLookups += 1;
      return { id: { _serialized: 'fallback-quoted' } };
    }
  };

  await importExistingChats({
    whatsapp: {
      getChats: async () => [fakeChat('quote-fallback@lid', 'Citação fallback', [reply])]
    },
    db,
    limit: 50,
    quoteFetchTimeoutMs: 50,
    logger: { log() {}, error() {} }
  });

  assert.equal(quotedLookups, 1);
  assert.equal(
    db.prepare(`
      SELECT quoted.external_id
      FROM messages reply
      JOIN messages quoted ON quoted.id = reply.quoted_message_id
      WHERE reply.external_id = 'fallback-reply'
    `).get().external_id,
    'fallback-quoted'
  );
  db.close();
});

test('reconciles offline revoked messages and creates a revoked placeholder when needed', async t => {
  const db = createDb();
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-history-revoked-media-'));
  t.after(() => fs.rmSync(mediaRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(mediaRoot, 't74-removida.jpg'), 'revoked-media');
  const conversationId = db.prepare(`
    INSERT INTO conversations (phone, contact_name, status)
    VALUES ('revoked@lid', 'Revogações', 'unassigned')
  `).run().lastInsertRowid;
  db.prepare(`
    INSERT INTO messages (
      conversation_id, external_id, from_type, content, media_type, media_url,
      delivery_status, created_at
    ) VALUES (?, 'revoked-existing', 'client', 'conteúdo removido', 'image', '/media/t74-removida.jpg', 'received', '2023-11-14 22:13:21')
  `).run(conversationId);
  const messages = [
    {
      id: { _serialized: 'revocation-event-1' },
      type: 'revoked',
      protocolMessageKey: { _serialized: 'revoked-existing' },
      fromMe: false,
      timestamp: 1700000002
    },
    {
      id: { _serialized: 'revocation-event-2' },
      type: 'revoked',
      _data: { protocolMessageKey: { id: { _serialized: 'revoked-missing' } } },
      fromMe: true,
      timestamp: 1700000003
    },
    {
      id: { _serialized: 'revoked-fallback-id' },
      type: 'revoked',
      fromMe: false,
      timestamp: 1700000004
    }
  ];

  const stats = await importExistingChats({
    whatsapp: {
      getChats: async () => [fakeChat('revoked@lid', 'Revogações', messages)]
    },
    db,
    limit: 50,
    tenantId: 74,
    mediaRoot,
    logger: { log() {}, error() {} }
  });

  assert.equal(stats.messagesUpdated, 1);
  assert.equal(stats.messagesImported, 2);
  assert.deepEqual(
    db.prepare(`
      SELECT external_id, content, media_type, media_url, deleted_for_everyone,
             delivery_status
      FROM messages
      ORDER BY created_at, id
    `).all(),
    [
      {
        external_id: 'revoked-existing',
        content: 'Mensagem apagada',
        media_type: null,
        media_url: null,
        deleted_for_everyone: 1,
        delivery_status: 'revoked'
      },
      {
        external_id: 'revoked-missing',
        content: 'Mensagem apagada',
        media_type: null,
        media_url: null,
        deleted_for_everyone: 1,
        delivery_status: 'revoked'
      },
      {
        external_id: 'revoked-fallback-id',
        content: 'Mensagem apagada',
        media_type: null,
        media_url: null,
        deleted_for_everyone: 1,
        delivery_status: 'revoked'
      }
    ]
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM messages WHERE external_id LIKE 'revocation-event-%'").get().count,
    0
  );
  assert.equal(fs.existsSync(path.join(mediaRoot, 't74-removida.jpg')), false);
  db.close();
});

test('applies every database mutation for one chat through a single transaction', async () => {
  const db = createDb();
  const nativeTransaction = db.transaction.bind(db);
  let transactionExecutions = 0;
  db.transaction = callback => {
    const execute = nativeTransaction(callback);
    return (...args) => {
      transactionExecutions += 1;
      return execute(...args);
    };
  };
  const messages = Array.from({ length: 25 }, (_, index) => ({
    id: { _serialized: `transaction-${index + 1}` },
    body: `mensagem ${index + 1}`,
    fromMe: index % 2 === 0,
    ack: 3,
    timestamp: 1700000000 + index
  }));

  const stats = await importExistingChats({
    whatsapp: {
      getChats: async () => [fakeChat('transaction@lid', 'Transacional', messages)]
    },
    db,
    limit: 50,
    chatImportDelayMs: 0,
    logger: { log() {}, error() {} }
  });

  assert.equal(transactionExecutions, 1);
  assert.equal(stats.messagesImported, 25);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 25);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversation_sync_state').get().count, 1);
  db.close();
});

test('rolls back the complete chat when a database mutation fails midway', async t => {
  const db = createDb();
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-history-rollback-media-'));
  t.after(() => fs.rmSync(mediaRoot, { recursive: true, force: true }));
  db.exec(`
    CREATE TRIGGER force_history_import_failure
    BEFORE INSERT ON messages
    WHEN NEW.external_id = 'atomic-fail'
    BEGIN
      SELECT RAISE(ABORT, 'falha atômica controlada');
    END;
  `);
  const progress = [];
  const errors = [];
  const messages = [
    {
      id: { _serialized: 'atomic-ok' },
      body: 'esta inserção deve ser revertida',
      fromMe: false,
      timestamp: 1700000001,
      hasMedia: true,
      type: 'image',
      downloadMedia: async () => ({
        mimetype: 'image/jpeg',
        filename: 'rollback.jpg',
        data: JPEG_BASE64
      })
    },
    {
      id: { _serialized: 'atomic-fail' },
      body: 'esta inserção força o rollback',
      fromMe: false,
      timestamp: 1700000002
    }
  ];

  const stats = await importExistingChats({
    whatsapp: {
      getChats: async () => [fakeChat('atomic@lid', 'Rollback', messages)]
    },
    db,
    limit: 50,
    chatImportDelayMs: 0,
    tenantId: 73,
    mediaRoot,
    onConversationImported: (...args) => progress.push(args),
    logger: { log() {}, error(message) { errors.push(message); } }
  });

  assert.equal(stats.failedChats, 1);
  assert.equal(stats.newConversations, 0);
  assert.equal(stats.messagesImported, 0);
  assert.equal(progress.length, 0);
  assert.match(errors.at(-1), /Erro ao persistir mensagens de Rollback: falha atômica controlada/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversation_identifiers').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversation_sync_state').get().count, 0);
  assert.deepEqual(fs.readdirSync(mediaRoot), []);
  db.close();
});
