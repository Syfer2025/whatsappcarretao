function positiveInteger(value, label = 'id') {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    const error = new Error(`${label} inválido`);
    error.statusCode = 400;
    throw error;
  }
  return number;
}

function normalizeContent(value) {
  const content = typeof value === 'string' ? value.trim() : '';
  if (content.length > 5000) {
    const error = new Error('A mensagem de suporte excede 5000 caracteres');
    error.statusCode = 400;
    throw error;
  }
  return content;
}

function ensureTenant(master, tenantId) {
  const tenant = master.prepare('SELECT id, name, slug FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant) {
    const error = new Error('Empresa não encontrada');
    error.statusCode = 404;
    throw error;
  }
  return tenant;
}

function getOrCreateSupportThread(master, tenantIdValue) {
  const tenantId = positiveInteger(tenantIdValue, 'empresa');
  ensureTenant(master, tenantId);
  master.prepare(`
    INSERT OR IGNORE INTO support_threads (tenant_id)
    VALUES (?)
  `).run(tenantId);
  return getSupportThreadByTenant(master, tenantId);
}

function supportThreadSelect() {
  return `
    SELECT st.*,
           t.name AS tenant_name,
           t.slug AS tenant_slug,
           lm.content AS last_message_content,
           lm.media_type AS last_message_media_type,
           lm.media_filename AS last_message_media_filename,
           lm.sender_type AS last_message_sender_type,
           (
             SELECT COUNT(*)
             FROM support_messages sm
             WHERE sm.thread_id = st.id
               AND sm.sender_type = 'tenant'
               AND sm.id > COALESCE(st.super_last_read_message_id, 0)
           ) AS super_unread_count,
           (
             SELECT COUNT(*)
             FROM support_messages sm
             WHERE sm.thread_id = st.id
               AND sm.sender_type = 'super_admin'
               AND sm.id > COALESCE(st.tenant_last_read_message_id, 0)
           ) AS tenant_unread_count
    FROM support_threads st
    JOIN tenants t ON t.id = st.tenant_id
    LEFT JOIN support_messages lm ON lm.id = (
      SELECT sm.id
      FROM support_messages sm
      WHERE sm.thread_id = st.id
      ORDER BY sm.created_at DESC, sm.id DESC
      LIMIT 1
    )
  `;
}

function getSupportThreadByTenant(master, tenantIdValue) {
  const tenantId = positiveInteger(tenantIdValue, 'empresa');
  return master.prepare(`${supportThreadSelect()} WHERE st.tenant_id = ?`).get(tenantId) || null;
}

function getSupportThread(master, threadIdValue) {
  const threadId = positiveInteger(threadIdValue, 'conversa de suporte');
  return master.prepare(`${supportThreadSelect()} WHERE st.id = ?`).get(threadId) || null;
}

function listSupportThreads(master) {
  return master.prepare(`
    ${supportThreadSelect()}
    WHERE EXISTS (
      SELECT 1 FROM support_messages sm WHERE sm.thread_id = st.id
    )
    ORDER BY COALESCE(st.last_message_at, st.updated_at, st.created_at) DESC, st.id DESC
  `).all();
}

function listSupportMessages(master, threadIdValue, { limit = 200, beforeId = null } = {}) {
  const threadId = positiveInteger(threadIdValue, 'conversa de suporte');
  const cappedLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const before = beforeId ? positiveInteger(beforeId, 'cursor') : null;
  const messages = master.prepare(`
    SELECT *
    FROM support_messages
    WHERE thread_id = ?
      AND (? IS NULL OR id < ?)
    ORDER BY id DESC
    LIMIT ?
  `).all(threadId, before, before, cappedLimit);
  return messages.reverse();
}

function addSupportMessage({
  master,
  tenantId: tenantIdValue,
  senderType,
  senderId = null,
  content: rawContent,
  media = null
}) {
  const tenantId = positiveInteger(tenantIdValue, 'empresa');
  if (!['tenant', 'super_admin'].includes(senderType)) {
    const error = new Error('Remetente de suporte inválido');
    error.statusCode = 400;
    throw error;
  }
  const content = normalizeContent(rawContent);
  if (!content && !media?.media_url) {
    const error = new Error('Digite uma mensagem ou envie um anexo');
    error.statusCode = 400;
    throw error;
  }
  const thread = getOrCreateSupportThread(master, tenantId);

  const insert = master.transaction(() => {
    const result = master.prepare(`
      INSERT INTO support_messages (
        thread_id, tenant_id, sender_type, sender_id, content,
        media_type, media_mimetype, media_filename, media_url, media_size
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      thread.id,
      tenantId,
      senderType,
      senderId || null,
      content,
      media?.media_type || null,
      media?.media_mimetype || null,
      media?.media_filename || null,
      media?.media_url || null,
      media?.media_size || null
    );
    const messageId = Number(result.lastInsertRowid);
    master.prepare(`
      UPDATE support_threads
      SET last_message_at = (SELECT created_at FROM support_messages WHERE id = ?),
          updated_at = datetime('now'),
          tenant_last_read_message_id = CASE
            WHEN ? = 'tenant' THEN ? ELSE tenant_last_read_message_id END,
          super_last_read_message_id = CASE
            WHEN ? = 'super_admin' THEN ? ELSE super_last_read_message_id END,
          status = 'open'
      WHERE id = ?
    `).run(messageId, senderType, messageId, senderType, messageId, thread.id);
    return messageId;
  });

  const messageId = insert();
  return master.prepare('SELECT * FROM support_messages WHERE id = ?').get(messageId);
}

function markSupportThreadRead(master, { threadId: threadIdValue, readerType }) {
  const threadId = positiveInteger(threadIdValue, 'conversa de suporte');
  if (!['tenant', 'super_admin'].includes(readerType)) {
    const error = new Error('Leitor de suporte inválido');
    error.statusCode = 400;
    throw error;
  }
  const latest = master.prepare(`
    SELECT id
    FROM support_messages
    WHERE thread_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(threadId);
  const column = readerType === 'tenant'
    ? 'tenant_last_read_message_id'
    : 'super_last_read_message_id';
  master.prepare(`UPDATE support_threads SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(latest?.id || null, threadId);
  return getSupportThread(master, threadId);
}

function getSupportMediaMessage(master, mediaUrl) {
  return master.prepare(`
    SELECT sm.*, st.tenant_id AS owner_tenant_id
    FROM support_messages sm
    JOIN support_threads st ON st.id = sm.thread_id
    WHERE sm.media_url = ?
    ORDER BY sm.id DESC
    LIMIT 1
  `).get(mediaUrl) || null;
}

module.exports = {
  addSupportMessage,
  getOrCreateSupportThread,
  getSupportMediaMessage,
  getSupportThread,
  getSupportThreadByTenant,
  listSupportMessages,
  listSupportThreads,
  markSupportThreadRead
};
