const { removeStoredTenantMediaSync } = require('./mediaStorage');

function requireUser(user) {
  if (!user?.role || user.id == null) throw new Error('Usuário obrigatório');
}

function ensureMessageUserState(db, messageId, user) {
  requireUser(user);
  db.prepare(`
    INSERT OR IGNORE INTO message_user_state (message_id, user_role, user_id)
    VALUES (?, ?, ?)
  `).run(messageId, user.role, user.id);
}

function setMessagePinned({ db, messageId, user, pinned }) {
  ensureMessageUserState(db, messageId, user);
  db.prepare(`
    UPDATE message_user_state
    SET pinned_at = CASE WHEN ? = 1 THEN COALESCE(pinned_at, CURRENT_TIMESTAMP) ELSE NULL END
    WHERE message_id = ? AND user_role = ? AND user_id = ?
  `).run(pinned ? 1 : 0, messageId, user.role, user.id);
  return db.prepare(`
    SELECT message_id, pinned_at, hidden_at
    FROM message_user_state
    WHERE message_id = ? AND user_role = ? AND user_id = ?
  `).get(messageId, user.role, user.id);
}

function hideMessageForUser({ db, messageId, user }) {
  ensureMessageUserState(db, messageId, user);
  db.prepare(`
    UPDATE message_user_state
    SET hidden_at = CURRENT_TIMESTAMP
    WHERE message_id = ? AND user_role = ? AND user_id = ?
  `).run(messageId, user.role, user.id);
  return { message_id: messageId, hidden: true };
}

function markMessageDeletedForEveryone({ db, messageId, mediaRoot = null, tenantId = null }) {
  const previous = db.prepare('SELECT media_url FROM messages WHERE id = ?').get(messageId) || null;
  db.prepare(`
    UPDATE messages
    SET content = 'Mensagem apagada',
        media_type = NULL,
        media_mimetype = NULL,
        media_filename = NULL,
        media_url = NULL,
        media_size = NULL,
        media_unavailable = 0,
        deleted_for_everyone = 1,
        deleted_for_everyone_at = CURRENT_TIMESTAMP,
        delivery_status = 'revoked',
        delivery_error = NULL
    WHERE id = ?
  `).run(messageId);
  const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) || null;
  if (updated && previous?.media_url && mediaRoot) {
    // The durable revoked state wins even if best-effort filesystem cleanup is
    // unavailable. A later integrity sweep can retry; never re-expose the URL.
    removeStoredTenantMediaSync({
      mediaUrl: previous.media_url,
      mediaRoot,
      namespace: tenantId
    });
  }
  return updated;
}

module.exports = {
  hideMessageForUser,
  markMessageDeletedForEveryone,
  setMessagePinned
};
