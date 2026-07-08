const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { ensureSchema } = require('./schema');
const {
  canAccessConversation,
  getVisibleConversations,
  getConversationMessages,
  searchVisibleContent,
  setMessageStarred,
  getStarredMessages,
  markConversationRead,
  updateConversationUserState,
  getConversationUserState,
  isConversationMutedForUser
} = require('./messageQueries');

function createDb() {
  const db = new Database(':memory:');
  ensureSchema(db);
  db.prepare("INSERT INTO sectors (id, name) VALUES (4, 'Vendas')").run();
  db.prepare("INSERT INTO vendors (id, name, username, password, sector_id) VALUES (9, 'Jackson', 'jackson', 'hash', 4)").run();
  db.prepare("INSERT INTO vendors (id, name, username, password, sector_id) VALUES (8, 'Maria', 'maria', 'hash', 4)").run();
  db.prepare("INSERT INTO conversations (id, phone, contact_name, assigned_to, sector_id, status) VALUES (1, 'a@lid', 'A', 9, 4, 'active')").run();
  db.prepare("INSERT INTO conversations (id, phone, contact_name, assigned_to, sector_id, status) VALUES (2, 'b@lid', 'B', NULL, 4, 'unassigned')").run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, vendor_id, delivery_status, media_type, media_filename, created_at)
    VALUES
      (1, 1, 'client', 'pedido importante', NULL, 'received', NULL, NULL, '2026-07-07 10:00:00'),
      (2, 1, 'vendor', 'resposta com foto', 9, 'sent', 'image', 'foto.png', '2026-07-07 10:01:00'),
      (3, 2, 'client', 'outra conversa', NULL, 'received', 'audio', 'audio.ogg', '2026-07-07 10:02:00'),
      (4, 1, 'vendor', 'resposta admin', NULL, 'sent', 'document', 'proposta.pdf', '2026-07-07 10:03:00')
  `).run();
  return db;
}

test('checks conversation access for admin and assigned vendor', () => {
  assert.equal(canAccessConversation({ role: 'admin', id: 1 }, { assigned_to: null }), true);
  assert.equal(canAccessConversation({ role: 'vendor', id: 9 }, { assigned_to: 9 }), true);
  assert.equal(canAccessConversation({ role: 'vendor', id: 8 }, { assigned_to: 9 }), false);
  assert.equal(canAccessConversation({ role: 'vendor', id: 8, sector_id: 4 }, { assigned_to: 9, sector_id: 4 }), false);
});

test('filters conversation messages by starred and text query', () => {
  const db = createDb();
  setMessageStarred({ db, messageId: 1, user: { role: 'admin', id: 1 }, starred: true });

  const messages = getConversationMessages({
    db,
    user: { role: 'admin', id: 1 },
    conversationId: 1,
    filters: { starred: true, q: 'pedido' }
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 1);
  assert.equal(messages[0].starred, 1);

  db.close();
});

test('treats LIKE wildcard characters as literal text in message search', () => {
  const db = createDb();

  const messages = getConversationMessages({
    db,
    user: { role: 'admin', id: 1 },
    conversationId: 1,
    filters: { q: '%' }
  });

  assert.equal(messages.length, 0);

  db.close();
});

test('adds readable sender labels to conversation messages', () => {
  const db = createDb();

  const messages = getConversationMessages({
    user: { role: 'admin', id: 1 },
    db,
    conversationId: 1
  });

  assert.deepEqual(messages.map(message => message.sender_label), [
    'Cliente',
    'Vendedor Jackson',
    'Admin'
  ]);

  db.close();
});

test('paginates conversation messages from newest history windows', () => {
  const db = createDb();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, delivery_status, created_at)
    VALUES
      (5, 1, 'client', 'mensagem cinco', 'received', '2026-07-07 10:04:00'),
      (6, 1, 'client', 'mensagem seis', 'received', '2026-07-07 10:05:00')
  `).run();

  const latestPage = getConversationMessages({
    db,
    user: { role: 'admin', id: 1 },
    conversationId: 1,
    pagination: { limit: 2 }
  });
  const previousPage = getConversationMessages({
    db,
    user: { role: 'admin', id: 1 },
    conversationId: 1,
    pagination: { limit: 2, beforeId: 5 }
  });

  assert.deepEqual(latestPage.map(message => message.id), [5, 6]);
  assert.deepEqual(previousPage.map(message => message.id), [2, 4]);

  db.close();
});

test('filters conversation messages by media type', () => {
  const db = createDb();

  const images = getConversationMessages({
    db,
    user: { role: 'admin', id: 1 },
    conversationId: 1,
    filters: { mediaType: 'image' }
  });
  const documents = getConversationMessages({
    db,
    user: { role: 'admin', id: 1 },
    conversationId: 1,
    filters: { mediaType: 'document' }
  });

  assert.deepEqual(images.map(message => message.id), [2]);
  assert.deepEqual(documents.map(message => message.id), [4]);

  db.close();
});

test('returns only starred messages visible to assigned vendor', () => {
  const db = createDb();
  setMessageStarred({ db, messageId: 1, user: { role: 'vendor', id: 9 }, starred: true });
  setMessageStarred({ db, messageId: 3, user: { role: 'admin', id: 1 }, starred: true });

  const messages = getStarredMessages({
    db,
    user: { role: 'vendor', id: 9 },
    q: ''
  });

  assert.deepEqual(messages.map(message => message.id), [1]);
  assert.equal(messages[0].contact_name, 'A');
  assert.equal(messages[0].sender_label, 'Cliente');

  db.close();
});

test('keeps starred messages separate for each user', () => {
  const db = createDb();
  setMessageStarred({ db, messageId: 1, user: { role: 'admin', id: 1 }, starred: true });
  setMessageStarred({ db, messageId: 2, user: { role: 'vendor', id: 9 }, starred: true });

  const adminMessages = getConversationMessages({
    db,
    user: { role: 'admin', id: 1 },
    conversationId: 1
  });
  const vendorMessages = getConversationMessages({
    db,
    user: { role: 'vendor', id: 9 },
    conversationId: 1
  });

  assert.deepEqual(adminMessages.map(message => [message.id, message.starred]), [
    [1, 1],
    [2, 0],
    [4, 0]
  ]);
  assert.deepEqual(vendorMessages.map(message => [message.id, message.starred]), [
    [1, 0],
    [2, 1],
    [4, 0]
  ]);
  assert.deepEqual(getStarredMessages({ db, user: { role: 'admin', id: 1 } }).map(message => message.id), [1]);
  assert.deepEqual(getStarredMessages({ db, user: { role: 'vendor', id: 9 } }).map(message => message.id), [2]);

  db.close();
});

test('returns exact target metadata for starred messages', () => {
  const db = createDb();
  setMessageStarred({ db, messageId: 2, user: { role: 'admin', id: 1 }, starred: true });

  const messages = getStarredMessages({ db, user: { role: 'admin', id: 1 } });

  assert.equal(messages[0].id, 2);
  assert.equal(messages[0].target_message_id, 2);
  assert.equal(messages[0].conversation_id, 1);
  assert.equal(messages[0].media_type, 'image');

  db.close();
});

test('tracks unread conversation counts separately for each user', () => {
  const db = createDb();
  markConversationRead({ db, conversationId: 1, user: { role: 'admin', id: 1 } });
  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, delivery_status, created_at)
    VALUES (5, 1, 'client', 'nova mensagem', 'received', '2026-07-07 10:04:00')
  `).run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, delivery_status, created_at)
    VALUES (6, 2, 'client', 'mensagem mais nova', 'received', '2026-07-07 10:05:00')
  `).run();

  const adminConversations = getVisibleConversations({ db, user: { role: 'admin', id: 1 } });
  const vendorConversations = getVisibleConversations({ db, user: { role: 'vendor', id: 9 } });

  assert.deepEqual(adminConversations.map(conversation => conversation.id), [2, 1]);
  assert.equal(adminConversations.find(conversation => conversation.id === 1).unread_count, 1);
  assert.equal(adminConversations.find(conversation => conversation.id === 2).unread_count, 2);
  assert.deepEqual(vendorConversations.map(conversation => conversation.id), [1]);
  assert.equal(vendorConversations[0].unread_count, 2);

  markConversationRead({ db, conversationId: 1, user: { role: 'vendor', id: 9 } });
  const updatedVendorConversations = getVisibleConversations({ db, user: { role: 'vendor', id: 9 } });
  assert.equal(updatedVendorConversations[0].unread_count, 0);

  db.close();
});

test('stores pinned unread muted and draft conversation state per user', () => {
  const db = createDb();

  updateConversationUserState({
    db,
    conversationId: 1,
    user: { role: 'admin', id: 1 },
    patch: { pinned: true, markedUnread: true, muted: true, draftText: 'responder depois' }
  });
  updateConversationUserState({
    db,
    conversationId: 1,
    user: { role: 'vendor', id: 9 },
    patch: { pinned: false, markedUnread: false, muted: false, draftText: 'rascunho vendedor' }
  });

  const adminState = getConversationUserState({ db, conversationId: 1, user: { role: 'admin', id: 1 } });
  const vendorState = getConversationUserState({ db, conversationId: 1, user: { role: 'vendor', id: 9 } });

  assert.ok(adminState.pinned_at);
  assert.ok(adminState.muted_until);
  assert.equal(adminState.marked_unread, 1);
  assert.equal(adminState.draft_text, 'responder depois');
  assert.equal(vendorState.pinned_at, null);
  assert.equal(vendorState.muted_until, null);
  assert.equal(vendorState.marked_unread, 0);
  assert.equal(vendorState.draft_text, 'rascunho vendedor');
  assert.equal(isConversationMutedForUser({ db, conversationId: 1, user: { role: 'admin', id: 1 } }), true);
  assert.equal(isConversationMutedForUser({ db, conversationId: 1, user: { role: 'vendor', id: 9 } }), false);

  db.close();
});

test('orders pinned conversations first without leaking pin state to other users', () => {
  const db = createDb();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, delivery_status, created_at)
    VALUES
      (5, 1, 'client', 'antiga fixada', 'received', '2026-07-07 09:00:00'),
      (6, 2, 'client', 'mais nova sem fixar', 'received', '2026-07-07 11:00:00')
  `).run();
  updateConversationUserState({
    db,
    conversationId: 1,
    user: { role: 'admin', id: 1 },
    patch: { pinned: true }
  });

  const adminConversations = getVisibleConversations({ db, user: { role: 'admin', id: 1 } });
  const vendorConversations = getVisibleConversations({ db, user: { role: 'vendor', id: 9 } });

  assert.deepEqual(adminConversations.map(conversation => [conversation.id, Boolean(conversation.pinned_at)]), [
    [1, true],
    [2, false]
  ]);
  assert.deepEqual(vendorConversations.map(conversation => [conversation.id, Boolean(conversation.pinned_at)]), [
    [1, false]
  ]);

  db.close();
});

test('mark unread is personal and resets when the same user reads the conversation', () => {
  const db = createDb();
  markConversationRead({ db, conversationId: 1, user: { role: 'admin', id: 1 } });
  updateConversationUserState({
    db,
    conversationId: 1,
    user: { role: 'admin', id: 1 },
    patch: { markedUnread: true }
  });

  const marked = getVisibleConversations({ db, user: { role: 'admin', id: 1 } }).find(conversation => conversation.id === 1);
  assert.equal(marked.marked_unread, 1);
  assert.equal(marked.unread_count, 1);

  markConversationRead({ db, conversationId: 1, user: { role: 'admin', id: 1 } });
  const read = getVisibleConversations({ db, user: { role: 'admin', id: 1 } }).find(conversation => conversation.id === 1);
  assert.equal(read.marked_unread, 0);
  assert.equal(read.unread_count, 0);

  db.close();
});

test('searches visible conversations and messages without leaking assigned conversations', () => {
  const db = createDb();

  const adminResults = searchVisibleContent({
    db,
    user: { role: 'admin', id: 1 },
    q: 'pedido'
  });
  const otherVendorResults = searchVisibleContent({
    db,
    user: { role: 'vendor', id: 8 },
    q: 'pedido'
  });

  assert.deepEqual(adminResults.messages.map(message => message.id), [1]);
  assert.deepEqual(adminResults.conversations.map(conversation => conversation.id), []);
  assert.deepEqual(otherVendorResults.messages, []);
  assert.deepEqual(otherVendorResults.conversations, []);

  db.close();
});

test('search media filter returns visible matching attachments', () => {
  const db = createDb();

  const results = searchVisibleContent({
    db,
    user: { role: 'admin', id: 1 },
    q: '',
    mediaType: 'audio'
  });

  assert.deepEqual(results.messages.map(message => message.id), [3]);
  assert.equal(results.messages[0].media_filename, 'audio.ogg');

  db.close();
});

test('separates admin new queue from forwarded conversations', () => {
  const db = createDb();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, delivery_status, created_at)
    VALUES
      (5, 1, 'client', 'resposta depois do encaminhamento', 'received', '2026-07-07 10:04:00'),
      (6, 2, 'client', 'cliente novo', 'received', '2026-07-07 10:05:00')
  `).run();

  const unassignedQueue = getVisibleConversations({
    db,
    user: { role: 'admin', id: 1 },
    queue: 'unassigned'
  });
  const forwardedQueue = getVisibleConversations({
    db,
    user: { role: 'admin', id: 1 },
    queue: 'forwarded'
  });
  const vendorQueue = getVisibleConversations({
    db,
    user: { role: 'vendor', id: 9 },
    queue: 'unassigned'
  });

  assert.deepEqual(unassignedQueue.map(conversation => conversation.id), [2]);
  assert.deepEqual(forwardedQueue.map(conversation => conversation.id), [1]);
  assert.deepEqual(vendorQueue.map(conversation => conversation.id), [1]);

  db.close();
});

test('marks imported out-of-order history as read by message id watermark', () => {
  const db = createDb();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, delivery_status, created_at)
    VALUES (20, 1, 'client', 'mensagem antiga importada depois', 'received', '2026-07-07 09:00:00')
  `).run();

  const state = markConversationRead({ db, conversationId: 1, user: { role: 'admin', id: 1 } });
  const conversations = getVisibleConversations({ db, user: { role: 'admin', id: 1 } });

  assert.equal(state.last_read_message_id, 20);
  assert.equal(conversations.find(conversation => conversation.id === 1).unread_count, 0);

  db.close();
});
