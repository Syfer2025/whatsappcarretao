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
  db.prepare("INSERT INTO admins (id, name, username, password) VALUES (1, 'Admin', 'admin', 'hash')").run();
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
  db.prepare(`
    UPDATE admins
    SET inbox_baseline_at = '2026-07-07 10:03:30',
        inbox_baseline_message_id = 4
    WHERE id = 1
  `).run();
  db.prepare(`
    UPDATE vendors
    SET inbox_baseline_at = '2026-07-07 10:03:30',
        inbox_baseline_message_id = 4
  `).run();
  return db;
}

test('checks conversation access for admin, assigned vendor and sector members', () => {
  assert.equal(canAccessConversation({ role: 'admin', id: 1 }, { assigned_to: null }), true);
  assert.equal(canAccessConversation({ role: 'vendor', id: 9 }, { assigned_to: 9 }), true);
  assert.equal(canAccessConversation({ role: 'vendor', id: 8 }, { assigned_to: 9 }), false);
  assert.equal(canAccessConversation({ role: 'vendor', id: 8, sector_id: 4 }, { assigned_to: 9, sector_id: 4 }), true);
  assert.equal(canAccessConversation({ role: 'vendor', id: 8, sector_id: 5 }, { assigned_to: 9, sector_id: 4 }), false);
  assert.equal(canAccessConversation({ role: 'vendor', id: 8, sector_id: 5 }, { assigned_to: 8, sector_id: 4 }), true);
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

test('identifies group participants in messages and quoted-message labels', () => {
  const db = createDb();
  db.prepare('UPDATE conversations SET is_group = 1 WHERE id = 2').run();
  db.prepare(`
    UPDATE messages
    SET participant_id = 'ana@lid',
        participant_phone = '5511999999999',
        participant_name = 'Ana'
    WHERE id = 3
  `).run();
  db.prepare(`
    INSERT INTO messages (
      id,
      conversation_id,
      from_type,
      content,
      vendor_id,
      quoted_message_id,
      delivery_status,
      created_at
    )
    VALUES (5, 2, 'vendor', 'Vou verificar', 9, 3, 'sent', '2026-07-07 10:03:00')
  `).run();
  db.prepare(`
    INSERT INTO messages (
      id,
      conversation_id,
      from_type,
      content,
      participant_id,
      participant_phone,
      delivery_status,
      created_at
    )
    VALUES (6, 2, 'client', 'Sem nome salvo', 'bia@lid', '5511888888888', 'received', '2026-07-07 10:04:00')
  `).run();

  const messages = getConversationMessages({
    db,
    user: { role: 'admin', id: 1 },
    conversationId: 2
  });

  assert.equal(messages[0].sender_label, 'Ana');
  assert.equal(messages[0].participant_name, 'Ana');
  assert.equal(messages[0].participant_phone, '5511999999999');
  assert.equal(messages[1].quoted_sender_name, 'Ana');
  assert.equal(messages[1].quoted_participant_id, 'ana@lid');
  assert.equal(messages[1].quoted_participant_phone, '5511999999999');
  assert.equal(messages[2].sender_label, '5511888888888');

  db.close();
});

test('does not expose a corrupted quote reference from another sector or conversation', () => {
  const db = createDb();
  db.prepare("INSERT INTO sectors (id, name) VALUES (5, 'Suporte')").run();
  db.prepare('UPDATE conversations SET sector_id = 5 WHERE id = 2').run();
  db.prepare('UPDATE messages SET quoted_message_id = 3 WHERE id = 1').run();
  const user = { role: 'vendor', id: 9, sector_id: 4 };
  setMessageStarred({ db, messageId: 1, user, starred: true });

  const direct = getConversationMessages({ db, user, conversationId: 1 })
    .find(message => message.id === 1);
  const starred = getStarredMessages({ db, user })
    .find(message => message.id === 1);
  const searched = searchVisibleContent({ db, user, q: 'pedido' }).messages
    .find(message => message.id === 1);

  for (const message of [direct, starred, searched]) {
    assert.ok(message);
    assert.equal(message.quoted_message_id, null);
    assert.equal(message.quoted_content, null);
    assert.equal(message.quoted_media_url, null);
    assert.equal(message.quoted_sender_name, null);
  }

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

test('paginates by whatsapp timestamp when old history receives newer database ids', () => {
  const db = createDb();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, delivery_status, created_at)
    VALUES
      (20, 1, 'client', 'historico antigo importado depois', 'received', '2026-07-07 09:00:00'),
      (21, 1, 'client', 'mensagem realmente mais nova', 'received', '2026-07-07 10:04:00')
  `).run();

  const latestPage = getConversationMessages({
    db,
    user: { role: 'admin', id: 1 },
    conversationId: 1,
    pagination: { limit: 3 }
  });
  const previousPage = getConversationMessages({
    db,
    user: { role: 'admin', id: 1 },
    conversationId: 1,
    pagination: { limit: 3, beforeId: latestPage[0].id }
  });

  assert.deepEqual(latestPage.map(message => message.id), [2, 4, 21]);
  assert.deepEqual(previousPage.map(message => message.id), [20, 1]);
  assert.deepEqual(
    [...previousPage, ...latestPage].map(message => message.created_at),
    [
      '2026-07-07 09:00:00',
      '2026-07-07 10:00:00',
      '2026-07-07 10:01:00',
      '2026-07-07 10:03:00',
      '2026-07-07 10:04:00'
    ]
  );

  db.close();
});

test('loads a stable chronological window around a target message', () => {
  const db = createDb();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, delivery_status, created_at)
    VALUES
      (5, 1, 'client', 'mensagem cinco', 'received', '2026-07-07 10:04:00'),
      (6, 1, 'client', 'mensagem seis', 'received', '2026-07-07 10:05:00')
  `).run();

  const centered = getConversationMessages({
    db,
    user: { role: 'admin', id: 1 },
    conversationId: 1,
    pagination: { limit: 3, aroundId: 4 }
  });
  const nearStart = getConversationMessages({
    db,
    user: { role: 'admin', id: 1 },
    conversationId: 1,
    pagination: { limit: 3, aroundId: 1 }
  });
  const nearEnd = getConversationMessages({
    db,
    user: { role: 'admin', id: 1 },
    conversationId: 1,
    pagination: { limit: 3, aroundId: 6 }
  });

  assert.deepEqual(centered.map(message => message.id), [2, 4, 5]);
  assert.deepEqual(nearStart.map(message => message.id), [1, 2, 4]);
  assert.deepEqual(nearEnd.map(message => message.id), [4, 5, 6]);
  assert.equal(Object.hasOwn(centered[0], '_chronological_row'), false);
  assert.equal(Object.hasOwn(centered[0], '_total_rows'), false);

  db.close();
});

test('uses message id only as the deterministic tie breaker for equal timestamps', () => {
  const db = createDb();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, delivery_status, created_at)
    VALUES
      (20, 1, 'client', 'mesmo segundo a', 'received', '2026-07-07 10:04:00'),
      (21, 1, 'client', 'mesmo segundo b', 'received', '2026-07-07 10:04:00')
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
    pagination: { limit: 10, beforeId: latestPage[0].id }
  });

  assert.deepEqual(latestPage.map(message => message.id), [20, 21]);
  assert.deepEqual(previousPage.map(message => message.id), [1, 2, 4]);

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
    user: { role: 'vendor', id: 9, sector_id: 4 },
    q: ''
  });

  assert.deepEqual(messages.map(message => message.id), [1]);
  assert.equal(messages[0].contact_name, 'A');
  assert.equal(messages[0].sender_label, 'Cliente');

  db.close();
});

test('applies sector visibility consistently to lists search and favorites', () => {
  const db = createDb();
  const sectorUser = { role: 'vendor', id: 8, sector_id: 4 };
  setMessageStarred({ db, messageId: 1, user: sectorUser, starred: true });

  const conversations = getVisibleConversations({ db, user: sectorUser });
  const search = searchVisibleContent({ db, user: sectorUser, q: 'pedido' });
  const starred = getStarredMessages({ db, user: sectorUser });

  assert.deepEqual(conversations.map(conversation => conversation.id), [1, 2]);
  assert.deepEqual(search.messages.map(message => message.id), [1]);
  assert.deepEqual(starred.map(message => message.id), [1]);

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
  const admin = { role: 'admin', id: 1 };
  const vendor = { role: 'vendor', id: 9 };

  // A primeira listagem cria o watermark sem promover o histórico existente a
  // mensagens novas para nenhum dos dois usuários.
  assert.ok(getVisibleConversations({ db, user: admin }).every(conversation => conversation.unread_count === 0));
  assert.ok(getVisibleConversations({ db, user: vendor }).every(conversation => conversation.unread_count === 0));

  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, delivery_status, created_at)
    VALUES (5, 1, 'client', 'nova mensagem', 'received', '2026-07-07 10:04:00')
  `).run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, delivery_status, created_at)
    VALUES (6, 2, 'client', 'mensagem mais nova', 'received', '2026-07-07 10:05:00')
  `).run();

  const adminConversations = getVisibleConversations({ db, user: admin });
  const vendorConversations = getVisibleConversations({ db, user: vendor });

  assert.deepEqual(adminConversations.map(conversation => conversation.id), [2, 1]);
  assert.equal(adminConversations.find(conversation => conversation.id === 1).unread_count, 1);
  assert.equal(adminConversations.find(conversation => conversation.id === 2).unread_count, 1);
  assert.deepEqual(vendorConversations.map(conversation => conversation.id), [1]);
  assert.equal(vendorConversations[0].unread_count, 1);

  markConversationRead({ db, conversationId: 1, user: vendor });
  const updatedVendorConversations = getVisibleConversations({ db, user: vendor });
  assert.equal(updatedVendorConversations[0].unread_count, 0);

  db.close();
});

test('uses the identity baseline without writing every conversation during list reads', () => {
  const db = createDb();
  db.prepare(`
    INSERT INTO conversation_user_state (
      conversation_id,
      user_role,
      user_id,
      marked_unread
    )
    VALUES (1, 'admin', 1, 0)
  `).run();

  const conversations = getVisibleConversations({ db, user: { role: 'admin', id: 1 } });
  const firstState = db.prepare(`
    SELECT * FROM conversation_user_state
    WHERE conversation_id = 1 AND user_role = 'admin' AND user_id = 1
  `).get();
  const secondState = db.prepare(`
    SELECT * FROM conversation_user_state
    WHERE conversation_id = 2 AND user_role = 'admin' AND user_id = 1
  `).get();

  assert.ok(conversations.every(conversation => conversation.unread_count === 0));
  assert.equal(firstState.last_read_message_id, null);
  assert.equal(firstState.last_read_message_at, null);
  assert.equal(secondState, undefined);

  db.close();
});

test('bounds and paginates the conversation list', () => {
  const db = createDb();
  for (let id = 3; id <= 205; id += 1) {
    db.prepare(`
      INSERT INTO conversations (id, phone, contact_name, status, manually_started, updated_at)
      VALUES (?, ?, ?, 'unassigned', 1, ?)
    `).run(id, `${id}@c.us`, `Contato ${id}`, `2026-07-08 10:${String(id % 60).padStart(2, '0')}:00`);
  }

  const firstPage = getVisibleConversations({
    db,
    user: { role: 'admin', id: 1 },
    limit: 200
  });
  const secondPage = getVisibleConversations({
    db,
    user: { role: 'admin', id: 1 },
    limit: 200,
    offset: 200
  });

  assert.equal(firstPage.length, 200);
  assert.equal(secondPage.length, 5);
  assert.equal(new Set([...firstPage, ...secondPage].map(row => row.id)).size, 205);
  assert.throws(
    () => getVisibleConversations({ db, user: { role: 'admin', id: 1 }, limit: -1 }),
    /Limite de conversas invalido/
  );
  db.close();
});

test('keeps a message received before the first list view unread', () => {
  const db = createDb();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, delivery_status, created_at)
    VALUES (5, 1, 'client', 'chegou offline', 'received', '2026-07-07 10:04:00')
  `).run();

  const conversations = getVisibleConversations({ db, user: { role: 'vendor', id: 9 } });

  assert.equal(conversations.find(conversation => conversation.id === 1).unread_count, 1);
  const state = getConversationUserState({
    db,
    conversationId: 1,
    user: { role: 'vendor', id: 9 }
  });
  assert.equal(state.last_read_message_id, 4);
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

test('rejects oversized or malformed conversation state without growing sqlite', () => {
  const db = createDb();
  const user = { role: 'admin', id: 1 };

  assert.throws(
    () => updateConversationUserState({
      db,
      conversationId: 1,
      user,
      patch: { draftText: 'a'.repeat(10001) }
    }),
    error => error.statusCode === 400 && /Rascunho excede/.test(error.message)
  );
  assert.throws(
    () => updateConversationUserState({
      db,
      conversationId: 1,
      user,
      patch: { muted: true, mutedUntil: 'x'.repeat(100000) }
    }),
    error => error.statusCode === 400 && /silenciamento inválida/.test(error.message)
  );
  assert.throws(
    () => updateConversationUserState({
      db,
      conversationId: 1,
      user,
      patch: { pinned: 'true' }
    }),
    error => error.statusCode === 400 && /booleano/.test(error.message)
  );

  const state = getConversationUserState({ db, conversationId: 1, user });
  assert.equal(state.draft_text, null);
  assert.equal(state.muted_until, null);
  assert.equal(state.pinned_at, null);
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

test('orders conversations by the latest persisted message instead of stale activity or metadata', () => {
  const db = createDb();
  db.prepare(`
    UPDATE conversations
    SET last_activity_at = CASE id
      WHEN 1 THEN '2026-07-07 10:03:00'
      WHEN 2 THEN '2026-07-07 10:05:00'
    END,
    updated_at = CASE id
      WHEN 1 THEN '2030-01-01 00:00:00'
      WHEN 2 THEN '2026-07-07 10:05:00'
    END
    WHERE id IN (1, 2)
  `).run();

  const conversations = getVisibleConversations({ db, user: { role: 'admin', id: 1 } });

  assert.deepEqual(conversations.map(conversation => conversation.id), [1, 2]);
  assert.equal(conversations[0].last_activity_at, '2026-07-07 10:03:00');
  assert.equal(conversations[1].last_activity_at, '2026-07-07 10:02:00');

  db.close();
});

test('uses human media labels in conversation previews', () => {
  const db = createDb();
  db.prepare("UPDATE messages SET content = '', media_url = '/media/generated-audio.ogg', media_filename = 't3-false_LONG_CODE.ogg' WHERE id = 3").run();
  const media = [
    [3, 'foto@lid', 'Foto', 'image', 't3-false_IMAGE_CODE.jpg'],
    [4, 'video@lid', 'Vídeo', 'video', 't3-false_VIDEO_CODE.mp4'],
    [5, 'sticker@lid', 'Figurinha', 'sticker', 't3-false_STICKER_CODE.webp'],
    [6, 'document@lid', 'Documento', 'document', 't3-false_DOCUMENT_CODE.pdf']
  ];
  for (const [conversationId, phone, , mediaType, filename] of media) {
    db.prepare(`
      INSERT INTO conversations (id, phone, contact_name, status)
      VALUES (?, ?, ?, 'unassigned')
    `).run(conversationId, phone, phone);
    db.prepare(`
      INSERT INTO messages (
        conversation_id,
        external_id,
        from_type,
        content,
        media_type,
        media_filename,
        media_url,
        created_at
      )
      VALUES (?, ?, 'client', '', ?, ?, ?, ?)
    `).run(
      conversationId,
      `media-${conversationId}`,
      mediaType,
      filename,
      `/media/${filename}`,
      `2026-07-07 10:0${conversationId}:00`
    );
  }

  const conversations = getVisibleConversations({ db, user: { role: 'admin', id: 1 } });
  const previews = new Map(conversations.map(conversation => [conversation.id, conversation.last_message_preview]));

  assert.equal(previews.get(2), 'Áudio');
  for (const [conversationId, , label] of media) {
    assert.equal(previews.get(conversationId), label);
  }

  db.close();
});

test('does not list empty imported conversations as active chats', () => {
  const db = createDb();
  db.prepare(`
    INSERT INTO conversations (id, phone, contact_name, status, last_activity_at, updated_at)
    VALUES (3, 'empty@lid', 'Sem mensagens', 'unassigned', '2030-01-01 00:00:00', '2030-01-01 00:00:00')
  `).run();

  const conversations = getVisibleConversations({ db, user: { role: 'admin', id: 1 } });

  assert.deepEqual(conversations.map(conversation => conversation.id), [1, 2]);

  db.close();
});

test('lists an empty conversation only when it was manually started', () => {
  const db = createDb();
  db.prepare(`
    INSERT INTO conversations (
      id,
      phone,
      contact_name,
      status,
      manually_started,
      last_activity_at,
      updated_at
    )
    VALUES (3, 'new@c.us', 'Novo contato', 'unassigned', 1, '2030-01-01 00:00:00', '2030-01-01 00:00:00')
  `).run();

  const conversations = getVisibleConversations({ db, user: { role: 'admin', id: 1 } });

  assert.deepEqual(conversations.map(conversation => conversation.id), [3, 1, 2]);

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

test('hides archived conversations from default lists search and favorites', () => {
  const db = createDb();
  setMessageStarred({ db, messageId: 1, user: { role: 'admin', id: 1 }, starred: true });
  db.prepare("UPDATE conversations SET whatsapp_archived = 1, archived_at = CURRENT_TIMESTAMP WHERE id = 1").run();

  const active = getVisibleConversations({ db, user: { role: 'admin', id: 1 } });
  const archived = getVisibleConversations({ db, user: { role: 'admin', id: 1 }, queue: 'archived' });
  const search = searchVisibleContent({ db, user: { role: 'admin', id: 1 }, q: 'pedido' });
  const starred = getStarredMessages({ db, user: { role: 'admin', id: 1 } });

  assert.deepEqual(active.map(conversation => conversation.id), [2]);
  assert.deepEqual(archived.map(conversation => conversation.id), [1]);
  assert.deepEqual(search.messages, []);
  assert.deepEqual(starred, []);

  db.close();
});

test('separates admin new queue from forwarded conversations', () => {
  const db = createDb();
  db.prepare("INSERT INTO conversations (id, phone, contact_name, status) VALUES (3, 'c@lid', 'C', 'unassigned')").run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, delivery_status, created_at)
    VALUES
      (5, 1, 'client', 'resposta depois do encaminhamento', 'received', '2026-07-07 10:04:00'),
      (6, 2, 'client', 'cliente do departamento', 'received', '2026-07-07 10:05:00'),
      (7, 3, 'client', 'cliente novo', 'received', '2026-07-07 10:06:00')
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
    user: { role: 'vendor', id: 9, sector_id: 4 },
    queue: 'unassigned'
  });

  assert.deepEqual(unassignedQueue.map(conversation => conversation.id), [3]);
  assert.deepEqual(forwardedQueue.map(conversation => conversation.id), [2, 1]);
  assert.deepEqual(vendorQueue.map(conversation => conversation.id), [2, 1]);

  db.close();
});

test('keeps old history read when it is imported after the chronological watermark', () => {
  const db = createDb();
  markConversationRead({ db, conversationId: 1, user: { role: 'admin', id: 1 } });
  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, delivery_status, created_at)
    VALUES (20, 1, 'client', 'mensagem antiga importada depois', 'received', '2026-07-07 09:00:00')
  `).run();

  const state = getConversationUserState({ db, conversationId: 1, user: { role: 'admin', id: 1 } });
  const conversations = getVisibleConversations({ db, user: { role: 'admin', id: 1 } });

  assert.equal(state.last_read_message_id, 4);
  assert.equal(state.last_read_message_at, '2026-07-07 10:03:00');
  assert.equal(conversations.find(conversation => conversation.id === 1).unread_count, 0);

  db.close();
});
