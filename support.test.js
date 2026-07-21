const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  addSupportMessage,
  getOrCreateSupportThread,
  getSupportThreadByTenant,
  listSupportMessages,
  listSupportThreads,
  markSupportThreadRead
} = require('./support');

function createMaster() {
  const master = new Database(':memory:');
  master.pragma('foreign_keys = ON');
  master.exec(`
    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL
    );
    CREATE TABLE support_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'open',
      last_message_at TEXT,
      tenant_last_read_message_id INTEGER,
      super_last_read_message_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      sender_type TEXT NOT NULL,
      sender_id INTEGER,
      content TEXT NOT NULL DEFAULT '',
      media_type TEXT,
      media_mimetype TEXT,
      media_filename TEXT,
      media_url TEXT,
      media_size INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO tenants (id, name, slug) VALUES
      (1, 'Loja Um', 'loja-um'),
      (2, 'Loja Dois', 'loja-dois');
  `);
  return master;
}

test('persists one support thread per tenant and tracks unread replies', () => {
  const master = createMaster();
  const first = addSupportMessage({
    master,
    tenantId: 1,
    senderType: 'tenant',
    senderId: 10,
    content: 'Preciso de ajuda'
  });
  const reply = addSupportMessage({
    master,
    tenantId: 1,
    senderType: 'super_admin',
    senderId: 1,
    content: 'Claro, conte comigo'
  });

  const thread = getSupportThreadByTenant(master, 1);
  assert.equal(first.thread_id, reply.thread_id);
  assert.equal(thread.tenant_unread_count, 1);
  assert.equal(thread.super_unread_count, 0);
  assert.deepEqual(listSupportMessages(master, thread.id).map(message => message.content), [
    'Preciso de ajuda',
    'Claro, conte comigo'
  ]);

  const read = markSupportThreadRead(master, { threadId: thread.id, readerType: 'tenant' });
  assert.equal(read.tenant_unread_count, 0);
  master.close();
});

test('lists support inbox by latest activity without leaking tenant messages', () => {
  const master = createMaster();
  addSupportMessage({ master, tenantId: 1, senderType: 'tenant', content: 'Empresa um' });
  addSupportMessage({ master, tenantId: 2, senderType: 'tenant', content: 'Empresa dois' });

  const inbox = listSupportThreads(master);
  assert.equal(inbox.length, 2);
  assert.deepEqual(new Set(inbox.map(thread => thread.tenant_name)), new Set(['Loja Um', 'Loja Dois']));
  const threadOne = getOrCreateSupportThread(master, 1);
  assert.deepEqual(listSupportMessages(master, threadOne.id).map(message => message.content), ['Empresa um']);
  master.close();
});

test('accepts a support attachment without text and rejects empty messages', () => {
  const master = createMaster();
  const attachment = addSupportMessage({
    master,
    tenantId: 1,
    senderType: 'tenant',
    content: '',
    media: {
      media_type: 'image',
      media_mimetype: 'image/png',
      media_filename: 'print.png',
      media_url: '/support-media/print.png',
      media_size: 123
    }
  });
  assert.equal(attachment.media_type, 'image');
  assert.throws(() => addSupportMessage({
    master,
    tenantId: 1,
    senderType: 'tenant',
    content: '   '
  }), /Digite uma mensagem/);
  master.close();
});

test('paginates support history without gaps or cross-thread rows', () => {
  const master = createMaster();
  for (let index = 1; index <= 205; index += 1) {
    addSupportMessage({ master, tenantId: 1, senderType: 'tenant', content: `Mensagem ${index}` });
  }
  addSupportMessage({ master, tenantId: 2, senderType: 'tenant', content: 'Outro tenant' });
  const thread = getSupportThreadByTenant(master, 1);
  const newest = listSupportMessages(master, thread.id, { limit: 200 });
  assert.equal(newest.length, 200);
  assert.equal(newest[0].content, 'Mensagem 6');
  assert.equal(newest.at(-1).content, 'Mensagem 205');
  const older = listSupportMessages(master, thread.id, { limit: 200, beforeId: newest[0].id });
  assert.deepEqual(older.map(message => message.content), [
    'Mensagem 1', 'Mensagem 2', 'Mensagem 3', 'Mensagem 4', 'Mensagem 5'
  ]);
  master.close();
});
