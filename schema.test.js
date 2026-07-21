const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { ensureSchema } = require('./schema');

test('creates base tables and message media support', () => {
  const db = new Database(':memory:');

  ensureSchema(db);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, [
    'admins',
    'contacts',
    'conversation_identifiers',
    'conversation_sync_state',
    'conversation_user_state',
    'conversations',
    'group_participants',
    'message_stars',
    'message_user_state',
    'messages',
    'password_reset_applications',
    'sectors',
    'sqlite_sequence',
    'vendors',
  ]);

  const messageColumns = db
    .prepare('PRAGMA table_info(messages)')
    .all()
    .map((row) => row.name);
  const conversationColumns = db
    .prepare('PRAGMA table_info(conversations)')
    .all()
    .map((row) => row.name);
  const adminColumns = db
    .prepare('PRAGMA table_info(admins)')
    .all()
    .map((row) => row.name);
  const vendorColumns = db
    .prepare('PRAGMA table_info(vendors)')
    .all()
    .map((row) => row.name);
  const sectorColumns = db
    .prepare('PRAGMA table_info(sectors)')
    .all()
    .map((row) => row.name);
  const stateColumns = db
    .prepare('PRAGMA table_info(conversation_user_state)')
    .all()
    .map((row) => row.name);
  const starColumns = db
    .prepare('PRAGMA table_info(message_stars)')
    .all()
    .map((row) => row.name);
  const messageStateColumns = db
    .prepare('PRAGMA table_info(message_user_state)')
    .all()
    .map((row) => row.name);
  const contactColumns = db
    .prepare('PRAGMA table_info(contacts)')
    .all()
    .map((row) => row.name);
  const participantColumns = db
    .prepare('PRAGMA table_info(group_participants)')
    .all()
    .map((row) => row.name);
  assert.equal(conversationColumns.includes('profile_pic_url'), true);
  assert.equal(conversationColumns.includes('sector_id'), true);
  assert.equal(conversationColumns.includes('last_activity_at'), true);
  assert.deepEqual(
    [
      'is_group',
      'group_description',
      'group_owner',
      'group_created_at',
      'profile_about',
      'whatsapp_archived',
      'archived_at',
      'archive_sync_state',
      'manually_started',
    ].every((column) => conversationColumns.includes(column)),
    true,
  );
  assert.equal(adminColumns.includes('token_version'), true);
  assert.equal(adminColumns.includes('inbox_baseline_at'), true);
  assert.equal(adminColumns.includes('inbox_baseline_message_id'), true);
  assert.equal(vendorColumns.includes('sector_id'), true);
  assert.equal(vendorColumns.includes('token_version'), true);
  assert.equal(vendorColumns.includes('row_version'), true);
  assert.equal(vendorColumns.includes('inbox_baseline_at'), true);
  assert.equal(vendorColumns.includes('inbox_baseline_message_id'), true);
  assert.deepEqual(
    ['id', 'name', 'active', 'row_version', 'created_at', 'updated_at'].every((column) =>
      sectorColumns.includes(column),
    ),
    true,
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
  assert.equal(messageColumns.includes('edited_at'), true);
  assert.equal(messageColumns.includes('vendor_sector_id'), true);
  assert.deepEqual(
    ['client_request_id', 'media_sha256', 'deleted_for_everyone', 'deleted_for_everyone_at'].every((column) =>
      messageColumns.includes(column),
    ),
    true,
  );
  assert.equal(messageColumns.includes('starred'), true);
  assert.equal(messageColumns.includes('starred_at'), true);
  assert.equal(messageColumns.includes('starred_by'), true);
  assert.equal(messageColumns.includes('starred_by_role'), true);
  assert.deepEqual(
    ['participant_id', 'participant_phone', 'participant_name'].every((column) => messageColumns.includes(column)),
    true,
  );
  assert.deepEqual(
    ['conversation_id', 'user_role', 'user_id', 'last_read_message_id', 'last_read_message_at', 'last_read_at'].every(
      (column) => stateColumns.includes(column),
    ),
    true,
  );
  assert.deepEqual(
    ['pinned_at', 'muted_until', 'marked_unread', 'draft_text', 'draft_updated_at', 'typing_at'].every((column) =>
      stateColumns.includes(column),
    ),
    true,
  );
  assert.deepEqual(
    ['message_id', 'user_role', 'user_id', 'created_at'].every((column) => starColumns.includes(column)),
    true,
  );
  assert.deepEqual(
    ['message_id', 'user_role', 'user_id', 'pinned_at', 'hidden_at'].every((column) =>
      messageStateColumns.includes(column),
    ),
    true,
  );
  assert.deepEqual(
    ['id', 'whatsapp_id', 'phone', 'name', 'push_name', 'profile_pic_url', 'is_saved', 'synced_at'].every((column) =>
      contactColumns.includes(column),
    ),
    true,
  );
  assert.deepEqual(
    [
      'conversation_id',
      'contact_id',
      'participant_id',
      'phone',
      'name',
      'is_admin',
      'is_super_admin',
      'synced_at',
    ].every((column) => participantColumns.includes(column)),
    true,
  );

  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => row.name);
  assert.equal(indexes.includes('idx_messages_external_id'), true);
  assert.equal(indexes.includes('idx_messages_conversation_created_id'), true);
  assert.equal(indexes.includes('idx_conversations_phone'), true);
  assert.equal(indexes.includes('idx_conversation_identifiers_identifier'), true);
  assert.equal(indexes.includes('idx_vendors_sector_id'), true);
  assert.equal(indexes.includes('idx_conversations_sector_id'), true);
  assert.equal(indexes.includes('idx_conversations_last_activity_at'), true);
  assert.equal(indexes.includes('idx_conversations_archived_activity'), true);
  assert.equal(indexes.includes('idx_conversation_user_state_user'), true);
  assert.equal(indexes.includes('idx_message_stars_user'), true);
  assert.equal(indexes.includes('idx_message_stars_message_id'), true);
  assert.equal(indexes.includes('idx_messages_client_request_id'), true);
  assert.equal(indexes.includes('idx_message_user_state_user'), true);
  assert.equal(indexes.includes('idx_contacts_phone'), true);
  assert.equal(indexes.includes('idx_group_participants_conversation'), true);
  assert.equal(indexes.includes('idx_messages_participant_id'), true);
  assert.equal(indexes.includes('idx_sectors_name_nocase'), true);
  assert.equal(indexes.includes('idx_messages_vendor_sector_created'), true);

  db.prepare("INSERT INTO conversations (id, phone) VALUES (1, 'baseline@c.us')").run();
  db.prepare(
    "INSERT INTO messages (id, conversation_id, from_type, content) VALUES (9, 1, 'client', 'historico')",
  ).run();
  db.prepare("INSERT INTO admins (id, username, password) VALUES (1, 'baseline-admin', 'hash')").run();
  const baseline = db
    .prepare(
      `
    SELECT inbox_baseline_at, inbox_baseline_message_id
    FROM admins
    WHERE id = 1
  `,
    )
    .get();
  assert.ok(baseline.inbox_baseline_at);
  assert.equal(baseline.inbox_baseline_message_id, 9);

  db.close();
});

test('adds production presence columns and analytics indexes', () => {
  const db = new Database(':memory:');
  ensureSchema(db);

  const adminColumns = db
    .prepare('PRAGMA table_info(admins)')
    .all()
    .map((row) => row.name);
  const vendorColumns = db
    .prepare('PRAGMA table_info(vendors)')
    .all()
    .map((row) => row.name);
  const messageIndexes = db
    .prepare('PRAGMA index_list(messages)')
    .all()
    .map((row) => row.name);

  assert.ok(adminColumns.includes('last_login_at'));
  assert.ok(adminColumns.includes('last_seen_at'));
  assert.ok(vendorColumns.includes('last_login_at'));
  assert.ok(vendorColumns.includes('last_seen_at'));
  assert.ok(messageIndexes.includes('idx_messages_created_at'));
  assert.ok(messageIndexes.includes('idx_messages_vendor_created'));
  assert.equal(db.pragma('user_version', { simple: true }), 13);
  db.close();
});

test('migrates a version 2 read watermark and creates the chronological message index', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      status TEXT DEFAULT 'unassigned',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER,
      from_type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE conversation_user_state (
      conversation_id INTEGER NOT NULL,
      user_role TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      last_read_message_id INTEGER,
      last_read_at DATETIME,
      PRIMARY KEY (conversation_id, user_role, user_id)
    );
    INSERT INTO conversations (id, phone) VALUES (1, 'legacy@lid');
    INSERT INTO messages (id, conversation_id, from_type, content, created_at)
    VALUES (7, 1, 'client', 'lida', '2026-07-07 10:05:00');
    INSERT INTO conversation_user_state (
      conversation_id, user_role, user_id, last_read_message_id, last_read_at
    ) VALUES (1, 'admin', 1, 7, '2026-07-07 10:06:00');
    PRAGMA user_version = 2;
  `);

  ensureSchema(db);

  const state = db.prepare('SELECT * FROM conversation_user_state').get();
  const index = db
    .prepare(
      `
    SELECT name
    FROM sqlite_master
    WHERE type = 'index'
      AND name = 'idx_messages_conversation_created_id'
  `,
    )
    .get();
  assert.equal(state.last_read_message_at, '2026-07-07 10:05:00');
  assert.equal(index.name, 'idx_messages_conversation_created_id');
  assert.equal(db.pragma('user_version', { simple: true }), 13);

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
  db.prepare(
    `
    INSERT INTO messages (id, conversation_id, from_type, content, starred, starred_at, starred_by, starred_by_role)
    VALUES (1, 1, 'client', 'favorita antiga', 1, '2026-07-07 10:00:00', 9, 'vendor')
  `,
  ).run();

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
  db.prepare(
    `
    INSERT INTO messages (conversation_id, from_type, content, created_at)
    VALUES
      (1, 'vendor', 'mensagem enviada antiga', '2026-07-07 10:00:00'),
      (1, 'client', 'mensagem recebida antiga', '2026-07-07 10:01:00')
  `,
  ).run();

  ensureSchema(db);
  ensureSchema(db);

  const messageColumns = db
    .prepare('PRAGMA table_info(messages)')
    .all()
    .map((row) => row.name);
  assert.equal(messageColumns.filter((name) => name === 'external_id').length, 1);
  assert.equal(messageColumns.filter((name) => name === 'media_type').length, 1);
  assert.equal(messageColumns.filter((name) => name === 'media_url').length, 1);
  assert.equal(messageColumns.filter((name) => name === 'media_unavailable').length, 1);
  assert.equal(messageColumns.filter((name) => name === 'delivery_status').length, 1);
  assert.equal(messageColumns.filter((name) => name === 'starred').length, 1);
  assert.equal(
    db.prepare("SELECT delivery_status FROM messages WHERE from_type = 'vendor'").get().delivery_status,
    'sent',
  );
  assert.equal(
    db.prepare("SELECT sent_at FROM messages WHERE from_type = 'vendor'").get().sent_at,
    '2026-07-07 10:00:00',
  );
  assert.equal(
    db.prepare("SELECT delivery_status FROM messages WHERE from_type = 'client'").get().delivery_status,
    'received',
  );

  db.close();
});

test('backfills conversation last activity from latest message', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      contact_name TEXT,
      status TEXT DEFAULT 'unassigned',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER,
      from_type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME
    );
  `);
  db.prepare(
    `
    INSERT INTO conversations (id, phone, contact_name, updated_at)
    VALUES
      (1, 'a@lid', 'A', '2030-01-01 00:00:00'),
      (2, 'b@lid', 'B', '2026-07-07 09:00:00')
  `,
  ).run();
  db.prepare(
    `
    INSERT INTO messages (conversation_id, from_type, content, created_at)
    VALUES
      (1, 'client', 'antiga', '2026-07-07 10:00:00'),
      (1, 'client', 'nova', '2026-07-07 10:05:00')
  `,
  ).run();

  ensureSchema(db);

  assert.equal(
    db.prepare('SELECT last_activity_at FROM conversations WHERE id = 1').get().last_activity_at,
    '2026-07-07 10:05:00',
  );
  assert.equal(
    db.prepare('SELECT last_activity_at FROM conversations WHERE id = 2').get().last_activity_at,
    '2026-07-07 09:00:00',
  );

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

  const conversationColumns = db
    .prepare('PRAGMA table_info(conversations)')
    .all()
    .map((row) => row.name);
  assert.equal(conversationColumns.filter((name) => name === 'profile_pic_url').length, 1);
  assert.equal(conversationColumns.filter((name) => name === 'sector_id').length, 1);
  assert.equal(conversationColumns.filter((name) => name === 'last_activity_at').length, 1);

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

  const vendorColumns = db
    .prepare('PRAGMA table_info(vendors)')
    .all()
    .map((row) => row.name);
  const conversationColumns = db
    .prepare('PRAGMA table_info(conversations)')
    .all()
    .map((row) => row.name);
  assert.equal(vendorColumns.filter((name) => name === 'sector_id').length, 1);
  assert.equal(conversationColumns.filter((name) => name === 'sector_id').length, 1);
  assert.equal(conversationColumns.filter((name) => name === 'last_activity_at').length, 1);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sectors'").get().name,
    'sectors',
  );

  db.close();
});

test('migrates version 4 tenants with group, contact and archive support', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      contact_name TEXT,
      status TEXT DEFAULT 'unassigned',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO conversations (id, phone, contact_name)
    VALUES (1, '120363000000000000@g.us', 'Grupo legado');
    PRAGMA user_version = 4;
  `);

  ensureSchema(db);

  const conversation = db.prepare('SELECT * FROM conversations WHERE id = 1').get();
  assert.equal(conversation.is_group, 1);
  assert.equal(conversation.whatsapp_archived, 0);
  assert.equal(conversation.manually_started, 0);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contacts'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='group_participants'").get());
  assert.equal(db.pragma('user_version', { simple: true }), 13);

  db.close();
});

test('version 10 migration snapshots the current vendor sector for legacy messages', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      token_version INTEGER DEFAULT 0,
      sector_id INTEGER,
      active INTEGER DEFAULT 1
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER,
      from_type TEXT NOT NULL,
      content TEXT NOT NULL,
      vendor_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO sectors (id, name) VALUES (4, 'Legado');
    INSERT INTO vendors (id, name, username, password, sector_id)
    VALUES (7, 'Vendedor legado', 'legado', 'hash', 4);
    INSERT INTO messages (id, conversation_id, from_type, content, vendor_id)
    VALUES (11, 1, 'vendor', 'mensagem antiga', 7);
    PRAGMA user_version = 10;
  `);

  ensureSchema(db);
  const message = db.prepare('SELECT vendor_sector_id FROM messages WHERE id = 11').get();
  const vendor = db
    .prepare(
      `
    SELECT inbox_baseline_at, inbox_baseline_message_id
    FROM vendors
    WHERE id = 7
  `,
    )
    .get();
  assert.equal(message.vendor_sector_id, 4);
  assert.ok(vendor.inbox_baseline_at);
  assert.equal(vendor.inbox_baseline_message_id, 11);
  assert.equal(db.pragma('user_version', { simple: true }), 13);
  db.close();
});

test('never downgrades a database created by a newer application image', () => {
  const db = new Database(':memory:');
  ensureSchema(db);
  db.exec(`
    CREATE TABLE future_release_marker (id INTEGER PRIMARY KEY);
    PRAGMA user_version = 99;
  `);

  ensureSchema(db);

  assert.equal(db.pragma('user_version', { simple: true }), 99);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'future_release_marker'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get());
  db.close();
});

test('rejects a bogus newer user_version that does not contain the compatible base schema', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE future_release_marker (id INTEGER PRIMARY KEY);
    PRAGMA user_version = 99;
  `);
  assert.throws(() => ensureSchema(db), /faltam tabelas compativeis/);
  assert.equal(db.pragma('user_version', { simple: true }), 99);
  db.close();
});

test('rolls back the whole schema migration when a late DDL statement fails', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );
    INSERT INTO admins (username, password) VALUES ('Case@Test', 'hash');
    INSERT INTO admins (username, password) VALUES ('case@test', 'hash');
    PRAGMA user_version = 12;
  `);
  const columnsBefore = db
    .prepare('PRAGMA table_info(admins)')
    .all()
    .map((row) => row.name);

  assert.throws(() => ensureSchema(db), /UNIQUE constraint failed/i);

  assert.equal(db.pragma('user_version', { simple: true }), 12);
  assert.deepEqual(
    db
      .prepare('PRAGMA table_info(admins)')
      .all()
      .map((row) => row.name),
    columnsBefore,
  );
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get(), undefined);
  assert.equal(db.inTransaction, false);
  db.close();
});
