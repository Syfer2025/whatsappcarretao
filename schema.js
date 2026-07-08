function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

function ensureColumn(db, table, column, definition) {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      token_version INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      token_version INTEGER DEFAULT 0,
      sector_id INTEGER REFERENCES sectors(id),
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS sectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      contact_name TEXT,
      profile_pic_url TEXT,
      assigned_to INTEGER REFERENCES vendors(id),
      sector_id INTEGER REFERENCES sectors(id),
      status TEXT DEFAULT 'unassigned',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER REFERENCES conversations(id),
      external_id TEXT,
      from_type TEXT NOT NULL,
      content TEXT NOT NULL,
      media_type TEXT,
      media_mimetype TEXT,
      media_filename TEXT,
      media_url TEXT,
      media_size INTEGER,
      media_unavailable INTEGER DEFAULT 0,
      delivery_status TEXT DEFAULT 'received',
      delivery_error TEXT,
      sent_at DATETIME,
      starred INTEGER DEFAULT 0,
      starred_at DATETIME,
      starred_by INTEGER,
      starred_by_role TEXT,
      vendor_id INTEGER REFERENCES vendors(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversation_user_state (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      user_role TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      last_read_message_id INTEGER REFERENCES messages(id),
      last_read_at DATETIME,
      PRIMARY KEY (conversation_id, user_role, user_id)
    );

    CREATE TABLE IF NOT EXISTS message_stars (
      message_id INTEGER NOT NULL REFERENCES messages(id),
      user_role TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, user_role, user_id)
    );
  `);

  ensureColumn(db, 'vendors', 'sector_id', 'INTEGER REFERENCES sectors(id)');
  ensureColumn(db, 'admins', 'token_version', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'vendors', 'token_version', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'conversations', 'profile_pic_url', 'TEXT');
  ensureColumn(db, 'conversations', 'sector_id', 'INTEGER REFERENCES sectors(id)');

  ensureColumn(db, 'messages', 'external_id', 'TEXT');
  ensureColumn(db, 'messages', 'media_type', 'TEXT');
  ensureColumn(db, 'messages', 'media_mimetype', 'TEXT');
  ensureColumn(db, 'messages', 'media_filename', 'TEXT');
  ensureColumn(db, 'messages', 'media_url', 'TEXT');
  ensureColumn(db, 'messages', 'media_size', 'INTEGER');
  ensureColumn(db, 'messages', 'media_unavailable', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'messages', 'delivery_status', "TEXT DEFAULT 'received'");
  ensureColumn(db, 'messages', 'delivery_error', 'TEXT');
  ensureColumn(db, 'messages', 'sent_at', 'DATETIME');
  ensureColumn(db, 'messages', 'starred', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'messages', 'starred_at', 'DATETIME');
  ensureColumn(db, 'messages', 'starred_by', 'INTEGER');
  ensureColumn(db, 'messages', 'starred_by_role', 'TEXT');
  ensureColumn(db, 'messages', 'quoted_message_id', 'INTEGER REFERENCES messages(id)');
  ensureColumn(db, 'conversation_user_state', 'pinned_at', 'DATETIME');
  ensureColumn(db, 'conversation_user_state', 'muted_until', 'DATETIME');
  ensureColumn(db, 'conversation_user_state', 'marked_unread', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'conversation_user_state', 'draft_text', 'TEXT');
  ensureColumn(db, 'conversation_user_state', 'draft_updated_at', 'DATETIME');
  ensureColumn(db, 'conversation_user_state', 'typing_at', 'DATETIME');

  db.exec(`
    INSERT OR IGNORE INTO message_stars (message_id, user_role, user_id, created_at)
    SELECT id, starred_by_role, starred_by, COALESCE(starred_at, CURRENT_TIMESTAMP)
    FROM messages
    WHERE starred = 1
      AND starred_by_role IS NOT NULL
      AND starred_by IS NOT NULL;
  `);

  db.exec(`
    UPDATE messages
    SET delivery_status = 'received'
    WHERE delivery_status IS NULL;

    UPDATE messages
    SET delivery_status = 'sent',
        sent_at = COALESCE(sent_at, created_at)
    WHERE from_type = 'vendor'
      AND delivery_status = 'received';
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone);
    CREATE INDEX IF NOT EXISTS idx_conversations_sector_id ON conversations(sector_id);
    CREATE INDEX IF NOT EXISTS idx_vendors_sector_id ON vendors(sector_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external_id
      ON messages(external_id)
      WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_conversation_user_state_user
      ON conversation_user_state(user_role, user_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_user_state_pinned
      ON conversation_user_state(user_role, user_id, pinned_at);
    CREATE INDEX IF NOT EXISTS idx_message_stars_user
      ON message_stars(user_role, user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_message_stars_message_id
      ON message_stars(message_id);
  `);
}

module.exports = {
  ensureSchema
};
