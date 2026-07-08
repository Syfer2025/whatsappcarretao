const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { ensureSchema } = require('./schema');

test('creates base tables and message media support', () => {
  const db = new Database(':memory:');

  ensureSchema(db);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
  assert.deepEqual(tables, [
    'admins',
    'conversation_user_state',
    'conversations',
    'message_stars',
    'messages',
    'sectors',
    'sqlite_sequence',
    'vendors'
  ]);

  const messageColumns = db.prepare('PRAGMA table_info(messages)').all().map(row => row.name);
  const conversationColumns = db.prepare('PRAGMA table_info(conversations)').all().map(row => row.name);
  const adminColumns = db.prepare('PRAGMA table_info(admins)').all().map(row => row.name);
  const vendorColumns = db.prepare('PRAGMA table_info(vendors)').all().map(row => row.name);
  const sectorColumns = db.prepare('PRAGMA table_info(sectors)').all().map(row => row.name);
  const stateColumns = db.prepare('PRAGMA table_info(conversation_user_state)').all().map(row => row.name);
  const starColumns = db.prepare('PRAGMA table_info(message_stars)').all().map(row => row.name);
  assert.equal(conversationColumns.includes('profile_pic_url'), true);
  assert.equal(conversationColumns.includes('sector_id'), true);
  assert.equal(adminColumns.includes('token_version'), true);
  assert.equal(vendorColumns.includes('sector_id'), true);
  assert.equal(vendorColumns.includes('token_version'), true);
  assert.deepEqual(
    ['id', 'name', 'active', 'created_at', 'updated_at'].every(column => sectorColumns.includes(column)),
    true
  );
  assert.equal(messageColumns.includes('external_id'), true);
  assert.equal(messageColumns.includes('media_type'), true);
  assert.equal(messageColumns.includes('media_mimetype'), true);
  assert.equal(messageColumns.includes('media_filename'), true);
  assert.equal(messageColumns.includes('media_url'), true);
  assert.equal(messageColumns.includes('media_size'), true);
  assert.equal(messageColumns.includes('media_unavailable'), true);
  assert.equal(messageColumns.includes('delivery_status'), true);
  assert.equal(messageColumns.includes('delivery_error'), true);
  assert.equal(messageColumns.includes('sent_at'), true);
  assert.equal(messageColumns.includes('starred'), true);
  assert.equal(messageColumns.includes('starred_at'), true);
  assert.equal(messageColumns.includes('starred_by'), true);
  assert.equal(messageColumns.includes('starred_by_role'), true);
  assert.deepEqual(
    ['conversation_id', 'user_role', 'user_id', 'last_read_message_id', 'last_read_at'].every(column => stateColumns.includes(column)),
    true
  );
  assert.deepEqual(
    ['pinned_at', 'muted_until', 'marked_unread', 'draft_text', 'draft_updated_at', 'typing_at'].every(column => stateColumns.includes(column)),
    true
  );
  assert.deepEqual(
    ['message_id', 'user_role', 'user_id', 'created_at'].every(column => starColumns.includes(column)),
    true
  );

  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name);
  assert.equal(indexes.includes('idx_messages_external_id'), true);
  assert.equal(indexes.includes('idx_conversations_phone'), true);
  assert.equal(indexes.includes('idx_vendors_sector_id'), true);
  assert.equal(indexes.includes('idx_conversations_sector_id'), true);
  assert.equal(indexes.includes('idx_conversation_user_state_user'), true);
  assert.equal(indexes.includes('idx_message_stars_user'), true);
  assert.equal(indexes.includes('idx_message_stars_message_id'), true);

  db.close();
});

test('migrates legacy starred messages to per-user message stars', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER,
      from_type TEXT NOT NULL,
      content TEXT NOT NULL,
      starred INTEGER DEFAULT 0,
      starred_at DATETIME,
      starred_by INTEGER,
      starred_by_role TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, starred, starred_at, starred_by, starred_by_role)
    VALUES (1, 1, 'client', 'favorita antiga', 1, '2026-07-07 10:00:00', 9, 'vendor')
  `).run();

  ensureSchema(db);
  ensureSchema(db);

  const star = db.prepare('SELECT * FROM message_stars WHERE message_id = ?').get(1);
  assert.equal(star.user_role, 'vendor');
  assert.equal(star.user_id, 9);
  assert.equal(star.created_at, '2026-07-07 10:00:00');

  db.close();
});

test('adds media columns to an existing messages table', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER,
      from_type TEXT NOT NULL,
      content TEXT NOT NULL,
      vendor_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare(`
    INSERT INTO messages (conversation_id, from_type, content, created_at)
    VALUES
      (1, 'vendor', 'mensagem enviada antiga', '2026-07-07 10:00:00'),
      (1, 'client', 'mensagem recebida antiga', '2026-07-07 10:01:00')
  `).run();

  ensureSchema(db);
  ensureSchema(db);

  const messageColumns = db.prepare('PRAGMA table_info(messages)').all().map(row => row.name);
  assert.equal(messageColumns.filter(name => name === 'external_id').length, 1);
  assert.equal(messageColumns.filter(name => name === 'media_type').length, 1);
  assert.equal(messageColumns.filter(name => name === 'media_url').length, 1);
  assert.equal(messageColumns.filter(name => name === 'media_unavailable').length, 1);
  assert.equal(messageColumns.filter(name => name === 'delivery_status').length, 1);
  assert.equal(messageColumns.filter(name => name === 'starred').length, 1);
  assert.equal(db.prepare("SELECT delivery_status FROM messages WHERE from_type = 'vendor'").get().delivery_status, 'sent');
  assert.equal(db.prepare("SELECT sent_at FROM messages WHERE from_type = 'vendor'").get().sent_at, '2026-07-07 10:00:00');
  assert.equal(db.prepare("SELECT delivery_status FROM messages WHERE from_type = 'client'").get().delivery_status, 'received');

  db.close();
});

test('adds profile picture support to an existing conversations table', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      contact_name TEXT,
      assigned_to INTEGER,
      status TEXT DEFAULT 'unassigned',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  ensureSchema(db);
  ensureSchema(db);

  const conversationColumns = db.prepare('PRAGMA table_info(conversations)').all().map(row => row.name);
  assert.equal(conversationColumns.filter(name => name === 'profile_pic_url').length, 1);
  assert.equal(conversationColumns.filter(name => name === 'sector_id').length, 1);

  db.close();
});

test('adds sector support to existing vendors and conversations tables', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      contact_name TEXT,
      assigned_to INTEGER,
      status TEXT DEFAULT 'unassigned',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  ensureSchema(db);
  ensureSchema(db);

  const vendorColumns = db.prepare('PRAGMA table_info(vendors)').all().map(row => row.name);
  const conversationColumns = db.prepare('PRAGMA table_info(conversations)').all().map(row => row.name);
  assert.equal(vendorColumns.filter(name => name === 'sector_id').length, 1);
  assert.equal(conversationColumns.filter(name => name === 'sector_id').length, 1);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sectors'").get().name, 'sectors');

  db.close();
});
