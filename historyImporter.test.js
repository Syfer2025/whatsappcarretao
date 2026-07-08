const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureSchema } = require('./schema');
const { importExistingChats } = require('./historyImporter');

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

  const stats = await importExistingChats({
    whatsapp: { getChats: async () => chats },
    db,
    limit: 50,
    logger: { log() {}, error() {} }
  });

  assert.equal(stats.totalChats, 4);
  assert.equal(stats.skippedChats, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE from_type = 'vendor'").get().count, 1);
  assert.equal(db.prepare("SELECT delivery_status FROM messages WHERE external_id = 'msg-1'").get().delivery_status, 'received');
  assert.equal(db.prepare("SELECT delivery_status FROM messages WHERE external_id = 'msg-2'").get().delivery_status, 'sent');

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
  await importExistingChats(importerArgs);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 2);

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
          data: Buffer.from('jpeg-data').toString('base64')
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
          data: Buffer.from('png-data').toString('base64')
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
  assert.equal(updated.media_size, 9);
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
            data: Buffer.from('jpeg-data').toString('base64')
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
