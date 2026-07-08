function canAccessConversation(user, conversation) {
  if (!user || !conversation) return false;
  if (user.role === 'admin') return true;
  return user.role === 'vendor' && conversation.assigned_to === user.id;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, char => `\\${char}`);
}

function buildMessageFilters(filters = {}, user = null) {
  const where = [];
  const params = [];

  if (filters.starred) {
    where.push(userHasIdentity(user) ? 'ms.message_id IS NOT NULL' : 'm.starred = 1');
  }

  const query = typeof filters.q === 'string' ? filters.q.trim() : '';
  if (query) {
    where.push("(m.content LIKE ? ESCAPE '\\' OR m.media_filename LIKE ? ESCAPE '\\')");
    const escapedQuery = `%${escapeLike(query)}%`;
    params.push(escapedQuery, escapedQuery);
  }

  const mediaType = normalizeMediaType(filters.mediaType || filters.media_type);
  if (mediaType) {
    where.push('m.media_type = ?');
    params.push(mediaType);
  }

  return { where, params };
}

function normalizeMediaType(value) {
  const mediaType = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ['image', 'video', 'audio', 'document', 'sticker'].includes(mediaType) ? mediaType : '';
}

function userHasIdentity(user) {
  return Boolean(user?.role && user?.id !== undefined && user?.id !== null);
}

function messageSelectColumns(user) {
  if (userHasIdentity(user)) {
    return `
      m.id,
      m.id AS target_message_id,
      m.conversation_id,
      m.external_id,
      m.from_type,
      m.content,
      m.media_type,
      m.media_mimetype,
      m.media_filename,
      m.media_url,
      m.media_size,
      m.media_unavailable,
      m.delivery_status,
      m.delivery_error,
      m.sent_at,
      CASE WHEN ms.message_id IS NULL THEN 0 ELSE 1 END AS starred,
      ms.created_at AS starred_at,
      ms.user_id AS starred_by,
      ms.user_role AS starred_by_role,
      m.vendor_id,
      m.created_at,
      m.quoted_message_id,
      qm.content AS quoted_content,
      qm.media_type AS quoted_media_type,
      qm.media_filename AS quoted_media_filename,
      qm.media_url AS quoted_media_url,
      qm.from_type AS quoted_from_type,
      qv.name AS quoted_sender_name
    `;
  }

  return 'm.*';
}

function messageStarJoin(user, params) {
  if (!userHasIdentity(user)) return '';
  params.push(user.role, user.id);
  return `
    LEFT JOIN message_stars ms
      ON ms.message_id = m.id
     AND ms.user_role = ?
     AND ms.user_id = ?
  `;
}

function positiveInteger(value, fallback = null) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return number;
}

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function permanentMuteUntil() {
  return '9999-12-31 23:59:59';
}

function ensureConversationUserState({ db, conversationId, user }) {
  if (!userHasIdentity(user)) throw new Error('Usuario obrigatorio para estado da conversa');
  db.prepare(`
    INSERT OR IGNORE INTO conversation_user_state (
      conversation_id,
      user_role,
      user_id,
      marked_unread
    )
    VALUES (?, ?, ?, 0)
  `).run(conversationId, user.role, user.id);
}

function getConversationUserState({ db, conversationId, user }) {
  ensureConversationUserState({ db, conversationId, user });
  return db.prepare(`
    SELECT *
    FROM conversation_user_state
    WHERE conversation_id = ?
      AND user_role = ?
      AND user_id = ?
  `).get(conversationId, user.role, user.id);
}

function updateConversationUserState({ db, conversationId, user, patch = {} }) {
  ensureConversationUserState({ db, conversationId, user });
  const current = getConversationUserState({ db, conversationId, user });
  const hasPinned = Object.hasOwn(patch, 'pinned') && patch.pinned !== undefined;
  const hasMuted = Object.hasOwn(patch, 'muted') && patch.muted !== undefined;
  const hasMarkedUnread = Object.hasOwn(patch, 'markedUnread') && patch.markedUnread !== undefined;
  const hasDraftText = Object.hasOwn(patch, 'draftText') && patch.draftText !== undefined;
  const hasTyping = Object.hasOwn(patch, 'typing') && patch.typing !== undefined;
  const nextPinnedAt = hasPinned
    ? patch.pinned ? (current.pinned_at || nowSql()) : null
    : current.pinned_at;
  const nextMutedUntil = hasMuted
    ? patch.muted ? (patch.mutedUntil || permanentMuteUntil()) : null
    : current.muted_until;
  const nextMarkedUnread = hasMarkedUnread
    ? patch.markedUnread ? 1 : 0
    : Number(current.marked_unread || 0);
  const nextDraftText = hasDraftText
    ? String(patch.draftText || '')
    : current.draft_text;
  const nextTypingAt = hasTyping
    ? patch.typing ? nowSql() : null
    : current.typing_at;

  db.prepare(`
    UPDATE conversation_user_state
    SET pinned_at = ?,
        muted_until = ?,
        marked_unread = ?,
        draft_text = ?,
        draft_updated_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE draft_updated_at END,
        typing_at = ?
    WHERE conversation_id = ?
      AND user_role = ?
      AND user_id = ?
  `).run(
    nextPinnedAt,
    nextMutedUntil,
    nextMarkedUnread,
    nextDraftText,
    hasDraftText ? 1 : 0,
    nextTypingAt,
    conversationId,
    user.role,
    user.id
  );

  return getConversationUserState({ db, conversationId, user });
}

function isConversationMutedForUser({ db, conversationId, user }) {
  if (!userHasIdentity(user)) return false;
  const state = db.prepare(`
    SELECT muted_until
    FROM conversation_user_state
    WHERE conversation_id = ?
      AND user_role = ?
      AND user_id = ?
  `).get(conversationId, user.role, user.id);
  return Boolean(state?.muted_until && state.muted_until > nowSql());
}

function getConversationMessages({ db, user, conversationId, filters = {}, pagination = {} }) {
  const built = buildMessageFilters(filters, user);
  const where = ['m.conversation_id = ?', ...built.where];
  const joinParams = [];
  const starJoin = messageStarJoin(user, joinParams);
  const params = [...joinParams, conversationId, ...built.params];
  const limit = positiveInteger(pagination.limit);
  const beforeId = positiveInteger(pagination.beforeId);

  if (beforeId) {
    where.push('m.id < ?');
    params.push(beforeId);
  }

  const orderSql = limit ? 'ORDER BY m.id DESC LIMIT ?' : 'ORDER BY m.created_at ASC, m.id ASC';
  if (limit) params.push(Math.min(limit, 100));

  const messages = db.prepare(`
    SELECT ${messageSelectColumns(user)},
           v.name AS sender_vendor_name,
           CASE
             WHEN m.from_type = 'client' THEN 'Cliente'
             WHEN m.from_type = 'vendor' AND v.name IS NOT NULL THEN 'Vendedor ' || v.name
             WHEN m.from_type = 'vendor' AND m.vendor_id IS NULL THEN 'Admin'
             WHEN m.from_type = 'vendor' THEN 'Vendedor'
             ELSE m.from_type
           END AS sender_label
    FROM messages m
    ${starJoin}
    LEFT JOIN vendors v ON v.id = m.vendor_id
    LEFT JOIN messages qm ON qm.id = m.quoted_message_id
    LEFT JOIN vendors qv ON qv.id = qm.vendor_id
    WHERE ${where.join(' AND ')}
    ${orderSql}
  `).all(...params);

  return limit ? messages.reverse() : messages;
}

function getMessageWithConversation(db, messageId) {
  return db.prepare(`
    SELECT m.*, c.assigned_to, c.contact_name, c.phone, c.profile_pic_url
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = ?
  `).get(messageId);
}

function setMessageStarred({ db, messageId, user, starred }) {
  if (!userHasIdentity(user)) throw new Error('Usuario obrigatorio para favoritar mensagem');
  const value = starred ? 1 : 0;
  if (value) {
    db.prepare(`
      INSERT OR IGNORE INTO message_stars (message_id, user_role, user_id)
      VALUES (?, ?, ?)
    `).run(messageId, user.role, user.id);
  } else {
    db.prepare(`
      DELETE FROM message_stars
      WHERE message_id = ?
        AND user_role = ?
        AND user_id = ?
    `).run(messageId, user.role, user.id);
  }

  db.prepare(`
    UPDATE messages
    SET starred = CASE
          WHEN EXISTS (SELECT 1 FROM message_stars WHERE message_id = ?) THEN 1
          ELSE 0
        END,
        starred_at = (
          SELECT created_at
          FROM message_stars
          WHERE message_id = ?
          ORDER BY created_at DESC
          LIMIT 1
        ),
        starred_by = (
          SELECT user_id
          FROM message_stars
          WHERE message_id = ?
          ORDER BY created_at DESC
          LIMIT 1
        ),
        starred_by_role = (
          SELECT user_role
          FROM message_stars
          WHERE message_id = ?
          ORDER BY created_at DESC
          LIMIT 1
        )
    WHERE id = ?
  `).run(messageId, messageId, messageId, messageId, messageId);
  return { ...db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId), starred: value };
}

function getStarredMessages({ db, user, q = '' }) {
  if (!userHasIdentity(user)) return [];
  const built = buildMessageFilters({ q }, user);
  const where = ['ms.user_role = ?', 'ms.user_id = ?', ...built.where];
  const params = [user.role, user.id, ...built.params];

  if (user.role === 'vendor') {
    where.push('c.assigned_to = ?');
    params.push(user.id);
  }

  return db.prepare(`
    SELECT ${messageSelectColumns(user)},
           v.name AS sender_vendor_name,
           CASE
             WHEN m.from_type = 'client' THEN 'Cliente'
             WHEN m.from_type = 'vendor' AND v.name IS NOT NULL THEN 'Vendedor ' || v.name
             WHEN m.from_type = 'vendor' AND m.vendor_id IS NULL THEN 'Admin'
             WHEN m.from_type = 'vendor' THEN 'Vendedor'
             ELSE m.from_type
           END AS sender_label,
           c.phone,
           c.contact_name,
           c.profile_pic_url,
           c.assigned_to,
           m.id AS target_message_id
    FROM messages m
    JOIN message_stars ms
      ON ms.message_id = m.id
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN vendors v ON v.id = m.vendor_id
    LEFT JOIN messages qm ON qm.id = m.quoted_message_id
    LEFT JOIN vendors qv ON qv.id = qm.vendor_id
    WHERE ${where.join(' AND ')}
    ORDER BY ms.created_at DESC, m.created_at DESC, m.id DESC
  `).all(...params);
}

function getVisibleConversations({ db, user, queue = '' }) {
  if (!userHasIdentity(user)) return [];
  const where = [];
  const params = [user.role, user.id];

  if (user.role === 'vendor') {
    where.push('c.assigned_to = ?');
    params.push(user.id);
  } else if (queue === 'unassigned') {
    where.push('c.assigned_to IS NULL');
  } else if (queue === 'forwarded') {
    where.push('c.assigned_to IS NOT NULL');
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return db.prepare(`
    SELECT c.*,
           v.name AS vendor_name,
           s.name AS sector_name,
           (
             SELECT COALESCE(
               NULLIF(m.content, ''),
               m.media_filename,
               CASE WHEN m.media_url IS NOT NULL THEN 'Mídia' ELSE '' END
             )
             FROM messages m
             WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC, m.id DESC
             LIMIT 1
           ) AS last_message_preview,
           (
             SELECT m.created_at
             FROM messages m
             WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC, m.id DESC
             LIMIT 1
           ) AS last_message_at,
           cus.pinned_at,
           cus.muted_until,
           COALESCE(cus.marked_unread, 0) AS marked_unread,
           cus.draft_text,
           CASE
             WHEN COALESCE(cus.marked_unread, 0) = 1 THEN MAX(1, (
               SELECT COUNT(*)
               FROM messages m
               WHERE m.conversation_id = c.id
                 AND m.from_type = 'client'
                 AND (
                   cus.last_read_message_id IS NULL
                   OR m.id > cus.last_read_message_id
                 )
             ))
             ELSE (
               SELECT COUNT(*)
               FROM messages m
               WHERE m.conversation_id = c.id
                 AND m.from_type = 'client'
                 AND (
                   cus.last_read_message_id IS NULL
                   OR m.id > cus.last_read_message_id
                 )
             )
           END AS unread_count
    FROM conversations c
    LEFT JOIN vendors v ON c.assigned_to = v.id
    LEFT JOIN sectors s ON c.sector_id = s.id
    LEFT JOIN conversation_user_state cus
      ON cus.conversation_id = c.id
     AND cus.user_role = ?
     AND cus.user_id = ?
    ${whereSql}
    ORDER BY
      CASE WHEN cus.pinned_at IS NULL THEN 1 ELSE 0 END ASC,
      cus.pinned_at DESC,
      COALESCE(last_message_at, c.updated_at) DESC,
      c.id DESC
  `).all(...params);
}

function markConversationRead({ db, conversationId, user }) {
  if (!userHasIdentity(user)) throw new Error('Usuario obrigatorio para marcar conversa como lida');
  const latest = db.prepare(`
    SELECT MAX(id) AS id
    FROM messages
    WHERE conversation_id = ?
  `).get(conversationId);
  const latestMessageId = latest?.id || null;

  db.prepare(`
    INSERT INTO conversation_user_state (
      conversation_id,
      user_role,
      user_id,
      last_read_message_id,
      last_read_at,
      marked_unread
    )
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 0)
    ON CONFLICT(conversation_id, user_role, user_id) DO UPDATE SET
      last_read_message_id = excluded.last_read_message_id,
      last_read_at = CURRENT_TIMESTAMP,
      marked_unread = 0
  `).run(conversationId, user.role, user.id, latestMessageId);

  return db.prepare(`
    SELECT *
    FROM conversation_user_state
    WHERE conversation_id = ?
      AND user_role = ?
      AND user_id = ?
  `).get(conversationId, user.role, user.id);
}

function buildVisibleConversationWhere(user, params, alias = 'c') {
  const where = [];
  if (user.role === 'vendor') {
    where.push(`${alias}.assigned_to = ?`);
    params.push(user.id);
  }
  return where;
}

function searchVisibleContent({ db, user, q = '', mediaType = '', limit = 30 }) {
  if (!userHasIdentity(user)) return { conversations: [], messages: [] };
  const query = typeof q === 'string' ? q.trim() : '';
  const normalizedMediaType = normalizeMediaType(mediaType);
  if (!query && !normalizedMediaType) return { conversations: [], messages: [] };

  const cappedLimit = Math.min(positiveInteger(limit, 30), 100);
  const conversationParams = [user.role, user.id];
  const conversationWhere = buildVisibleConversationWhere(user, conversationParams);
  if (query) {
    const escapedQuery = `%${escapeLike(query)}%`;
    conversationWhere.push("(c.contact_name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR v.name LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')");
    conversationParams.push(escapedQuery, escapedQuery, escapedQuery, escapedQuery);
  } else {
    conversationWhere.push('0 = 1');
  }
  conversationParams.push(cappedLimit);

  const conversations = db.prepare(`
    SELECT c.*,
           v.name AS vendor_name,
           s.name AS sector_name,
           cus.pinned_at,
           cus.muted_until,
           COALESCE(cus.marked_unread, 0) AS marked_unread,
           cus.draft_text
    FROM conversations c
    LEFT JOIN vendors v ON c.assigned_to = v.id
    LEFT JOIN sectors s ON c.sector_id = s.id
    LEFT JOIN conversation_user_state cus
      ON cus.conversation_id = c.id
     AND cus.user_role = ?
     AND cus.user_id = ?
    ${conversationWhere.length ? `WHERE ${conversationWhere.join(' AND ')}` : ''}
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT ?
  `).all(...conversationParams);

  const messageJoinParams = [];
  const starJoin = messageStarJoin(user, messageJoinParams);
  const messageWhere = [];
  const messageParams = [...messageJoinParams];

  if (user.role === 'vendor') {
    messageWhere.push('c.assigned_to = ?');
    messageParams.push(user.id);
  }
  if (query) {
    const escapedQuery = `%${escapeLike(query)}%`;
    messageWhere.push("(m.content LIKE ? ESCAPE '\\' OR m.media_filename LIKE ? ESCAPE '\\' OR c.contact_name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\')");
    messageParams.push(escapedQuery, escapedQuery, escapedQuery, escapedQuery);
  }
  if (normalizedMediaType) {
    messageWhere.push('m.media_type = ?');
    messageParams.push(normalizedMediaType);
  }
  messageParams.push(cappedLimit);

  const messages = db.prepare(`
    SELECT ${messageSelectColumns(user)},
           c.phone,
           c.contact_name,
           c.profile_pic_url,
           c.assigned_to,
           v.name AS sender_vendor_name,
           CASE
             WHEN m.from_type = 'client' THEN 'Cliente'
             WHEN m.from_type = 'vendor' AND v.name IS NOT NULL THEN 'Vendedor ' || v.name
             WHEN m.from_type = 'vendor' AND m.vendor_id IS NULL THEN 'Admin'
             WHEN m.from_type = 'vendor' THEN 'Vendedor'
             ELSE m.from_type
           END AS sender_label
    FROM messages m
    ${starJoin}
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN vendors v ON v.id = m.vendor_id
    LEFT JOIN messages qm ON qm.id = m.quoted_message_id
    LEFT JOIN vendors qv ON qv.id = qm.vendor_id
    ${messageWhere.length ? `WHERE ${messageWhere.join(' AND ')}` : ''}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `).all(...messageParams);

  return { conversations, messages };
}

module.exports = {
  canAccessConversation,
  getVisibleConversations,
  getConversationMessages,
  getMessageWithConversation,
  getConversationUserState,
  updateConversationUserState,
  isConversationMutedForUser,
  searchVisibleContent,
  getStarredMessages,
  setMessageStarred,
  markConversationRead
};
