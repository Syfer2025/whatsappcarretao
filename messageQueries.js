/**
 * Quem enxerga e quem age numa conversa.
 *
 * REGRA: o vendedor so ve a conversa que foi ATRIBUIDA a ele. Setor nao da
 * acesso a nada. O admin recebe tudo e decide para quem vai cada conversa.
 *
 * Antes, pertencer ao setor bastava — e como assigned_to so era preenchido pela
 * rota de atribuicao do admin, na pratica nenhuma conversa tinha dono e todo
 * vendedor via e respondia a conversa de todos.
 *
 * Quebrou de verdade em 04/09/2026 com o cliente 554391070374: Jackson atendeu
 * e passou preco (R$ 235,00); quase uma hora depois Lauriane entrou na MESMA
 * conversa, cumprimentou do zero, perguntou "ja te deram atencao ai?" e mandou
 * o cliente falar com um terceiro vendedor.
 *
 * Esta funcao e a regra unica: quem lista, quem busca, quem envia e quem recebe
 * evento em tempo real passam por ela ou por um SQL que a espelha.
 */
function canAccessConversation(user, conversation) {
  if (!user || !conversation) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'vendor') return false;

  const userId = positiveInteger(user.id);
  const assignedTo = positiveInteger(conversation.assigned_to);
  return Boolean(userId && assignedTo === userId);
}

/** Dono atual da conversa, para a mensagem de recusa dizer com quem ela esta. */
function conversationOwner(db, conversationId) {
  const id = positiveInteger(conversationId);
  if (!id) return null;
  return db.prepare(`
    SELECT v.id, v.name
    FROM conversations c
    JOIN vendors v ON v.id = c.assigned_to
    WHERE c.id = ?
  `).get(id) || null;
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
      m.edited_at,
      COALESCE(m.deleted_for_everyone, 0) AS deleted_for_everyone,
      CASE WHEN ms.message_id IS NULL THEN 0 ELSE 1 END AS starred,
      CASE WHEN mus.pinned_at IS NULL THEN 0 ELSE 1 END AS pinned,
      mus.pinned_at AS pinned_at,
      ms.created_at AS starred_at,
      ms.user_id AS starred_by,
      ms.user_role AS starred_by_role,
      m.vendor_id,
      m.participant_id,
      m.participant_phone,
      m.participant_name,
      m.created_at,
      qm.id AS quoted_message_id,
      qm.content AS quoted_content,
      qm.media_type AS quoted_media_type,
      qm.media_filename AS quoted_media_filename,
      qm.media_url AS quoted_media_url,
      qm.from_type AS quoted_from_type,
      qm.participant_id AS quoted_participant_id,
      qm.participant_phone AS quoted_participant_phone,
      qm.participant_name AS quoted_participant_name,
      CASE
        WHEN qm.from_type = 'client' AND COALESCE(c.is_group, 0) = 1
          THEN COALESCE(
            NULLIF(qm.participant_name, ''),
            NULLIF(qm.participant_phone, ''),
            NULLIF(qm.participant_id, ''),
            'Participante'
          )
        WHEN qm.from_type = 'client' THEN 'Cliente'
        WHEN qm.from_type = 'vendor' AND qv.name IS NOT NULL THEN qv.name
        WHEN qm.from_type = 'vendor' THEN 'Vendedor'
        ELSE qm.from_type
      END AS quoted_sender_name,
      COALESCE(c.is_group, 0) AS is_group
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

function messageUserStateJoin(user, params) {
  if (!userHasIdentity(user)) return '';
  params.push(user.role, user.id);
  return `
    LEFT JOIN message_user_state mus
      ON mus.message_id = m.id
     AND mus.user_role = ?
     AND mus.user_id = ?
  `;
}

function positiveInteger(value, fallback = null) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return number;
}

function normalizeConversationPageLimit(value) {
  if (value === undefined || value === null || value === '') return 200;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    const error = new Error('Limite de conversas invalido');
    error.statusCode = 400;
    throw error;
  }
  return Math.min(number, 200);
}

function normalizeConversationPageOffset(value) {
  if (value === undefined || value === null || value === '') return 0;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    const error = new Error('Offset de conversas invalido');
    error.statusCode = 400;
    throw error;
  }
  return number;
}

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function permanentMuteUntil() {
  return '9999-12-31 23:59:59';
}

function conversationStateInputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'INVALID_CONVERSATION_STATE';
  return error;
}

function normalizeStateBoolean(value, label) {
  if (value === true || value === false) return value;
  throw conversationStateInputError(`${label} deve ser booleano`);
}

function normalizeDraftText(value) {
  const draft = String(value || '');
  if (Array.from(draft).length > 10000 || Buffer.byteLength(draft, 'utf8') > 40000) {
    throw conversationStateInputError('Rascunho excede o limite de 10000 caracteres');
  }
  return draft;
}

function normalizeMutedUntil(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 32
      || !/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z?)?$/.test(text)) {
    throw conversationStateInputError('Data de silenciamento inválida');
  }
  const timestamp = Date.parse(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
  if (!Number.isFinite(timestamp)) throw conversationStateInputError('Data de silenciamento inválida');
  return new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');
}

function appendVendorVisibility(where, params, user, alias = 'c') {
  if (user?.role !== 'vendor') return;
  // Espelha canAccessConversation. Mudar so a funcao JS nao adianta: as
  // listagens montam o SQL aqui e continuariam trazendo a conversa dos colegas.
  where.push(`${alias}.assigned_to = ?`);
  params.push(user.id);
}

function senderLabelSql(messageAlias = 'm', conversationAlias = 'c', vendorAlias = 'v') {
  return `CASE
    WHEN ${messageAlias}.from_type = 'client' AND COALESCE(${conversationAlias}.is_group, 0) = 1
      THEN COALESCE(
        NULLIF(${messageAlias}.participant_name, ''),
        NULLIF(${messageAlias}.participant_phone, ''),
        NULLIF(${messageAlias}.participant_id, ''),
        'Participante'
      )
    WHEN ${messageAlias}.from_type = 'client' THEN 'Cliente'
    WHEN ${messageAlias}.from_type = 'vendor' AND ${vendorAlias}.name IS NOT NULL THEN 'Vendedor ' || ${vendorAlias}.name
    WHEN ${messageAlias}.from_type = 'vendor' AND ${messageAlias}.vendor_id IS NULL THEN 'Admin'
    WHEN ${messageAlias}.from_type = 'vendor' THEN 'Vendedor'
    ELSE ${messageAlias}.from_type
  END`;
}

function messagePreviewSql(messageAlias = 'm') {
  return `CASE
    WHEN NULLIF(TRIM(${messageAlias}.content), '') IS NOT NULL
      AND TRIM(${messageAlias}.content) <> '(mídia)'
      THEN ${messageAlias}.content
    WHEN ${messageAlias}.media_type = 'audio' THEN 'Áudio'
    WHEN ${messageAlias}.media_type = 'image' THEN 'Foto'
    WHEN ${messageAlias}.media_type = 'video' THEN 'Vídeo'
    WHEN ${messageAlias}.media_type = 'sticker' THEN 'Figurinha'
    WHEN ${messageAlias}.media_type = 'document' THEN 'Documento'
    WHEN ${messageAlias}.media_url IS NOT NULL OR ${messageAlias}.media_filename IS NOT NULL THEN 'Mídia'
    ELSE NULLIF(TRIM(${messageAlias}.content), '')
  END`;
}

function getUserInboxBaseline(db, user) {
  if (!userHasIdentity(user)) throw new Error('Usuario obrigatorio para baseline da caixa de entrada');
  const table = user.role === 'vendor' ? 'vendors' : 'admins';
  const row = db.prepare(`
    SELECT inbox_baseline_at, inbox_baseline_message_id
    FROM ${table}
    WHERE id = ?
    LIMIT 1
  `).get(user.id);

  if (row?.inbox_baseline_at) {
    return {
      at: row.inbox_baseline_at,
      messageId: Number(row.inbox_baseline_message_id || 0)
    };
  }

  // Fail-safe para bases de teste/legado inconsistentes: nao transforme todo o
  // historico em notificacao. Usuarios autenticados reais sempre possuem linha.
  return db.prepare(`
    SELECT strftime('%Y-%m-%d %H:%M:%f', 'now') AS at,
           COALESCE(MAX(id), 0) AS messageId
    FROM messages
  `).get();
}

function inboxBaselinePredicate(messageAlias = 'm') {
  return `(
    ${messageAlias}.created_at < ?
    OR (
      ${messageAlias}.created_at = ?
      AND ${messageAlias}.id <= ?
    )
  )`;
}

function ensureConversationUserState({ db, conversationId, user }) {
  if (!userHasIdentity(user)) throw new Error('Usuario obrigatorio para estado da conversa');
  const baseline = getUserInboxBaseline(db, user);
  db.prepare(`
    INSERT OR IGNORE INTO conversation_user_state (
      conversation_id,
      user_role,
      user_id,
      last_read_message_id,
      last_read_message_at,
      last_read_at,
      marked_unread
    )
    SELECT ?, ?, ?, latest.id, latest.created_at, CURRENT_TIMESTAMP, 0
    FROM (SELECT 1) AS seed
    LEFT JOIN messages latest
      ON latest.id = (
        SELECT m.id
        FROM messages m
        WHERE m.conversation_id = ?
          AND ${inboxBaselinePredicate('m')}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      )
  `).run(
    conversationId,
    user.role,
    user.id,
    conversationId,
    baseline.at,
    baseline.at,
    baseline.messageId
  );
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
    ? normalizeStateBoolean(patch.pinned, 'Fixação') ? (current.pinned_at || nowSql()) : null
    : current.pinned_at;
  const nextMutedUntil = hasMuted
    ? normalizeStateBoolean(patch.muted, 'Silenciamento')
      ? (patch.mutedUntil ? normalizeMutedUntil(patch.mutedUntil) : permanentMuteUntil())
      : null
    : current.muted_until;
  const nextMarkedUnread = hasMarkedUnread
    ? normalizeStateBoolean(patch.markedUnread, 'Marcação de não lida') ? 1 : 0
    : Number(current.marked_unread || 0);
  const nextDraftText = hasDraftText
    ? normalizeDraftText(patch.draftText)
    : current.draft_text;
  const nextTypingAt = hasTyping
    ? normalizeStateBoolean(patch.typing, 'Digitação') ? nowSql() : null
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
  const userStateJoin = messageUserStateJoin(user, joinParams);
  if (userHasIdentity(user)) where.push('mus.hidden_at IS NULL');
  const params = [...joinParams, conversationId, ...built.params];
  const limit = positiveInteger(pagination.limit);
  const beforeId = positiveInteger(pagination.beforeId);
  const aroundId = positiveInteger(pagination.aroundId);

  if (aroundId) {
    const aroundLimit = Math.min(limit || 50, 100);
    const rowsBeforeTarget = Math.floor((aroundLimit - 1) / 2);
    const rows = db.prepare(`
      WITH ranked AS (
        SELECT ${messageSelectColumns(user)},
               v.name AS sender_vendor_name,
               ${senderLabelSql()} AS sender_label,
               ROW_NUMBER() OVER (ORDER BY m.created_at ASC, m.id ASC) AS _chronological_row,
               COUNT(*) OVER () AS _total_rows
        FROM messages m
        ${starJoin}
        ${userStateJoin}
        JOIN conversations c ON c.id = m.conversation_id
        LEFT JOIN vendors v ON v.id = m.vendor_id
        LEFT JOIN messages qm
          ON qm.id = m.quoted_message_id
         AND qm.conversation_id = m.conversation_id
        LEFT JOIN vendors qv ON qv.id = qm.vendor_id
        WHERE ${where.join(' AND ')}
      ),
      target AS (
        SELECT _chronological_row AS target_row, _total_rows AS total_rows
        FROM ranked
        WHERE id = ?
      ),
      bounds AS (
        SELECT MIN(
                 MAX(1, target_row - ?),
                 MAX(1, total_rows - ? + 1)
               ) AS start_row,
               total_rows
        FROM target
      )
      SELECT ranked.*
      FROM ranked
      JOIN bounds
        ON ranked._chronological_row BETWEEN bounds.start_row
          AND MIN(bounds.total_rows, bounds.start_row + ? - 1)
      ORDER BY ranked._chronological_row ASC
    `).all(...params, aroundId, rowsBeforeTarget, aroundLimit, aroundLimit);

    return rows.map(row => {
      const message = { ...row };
      delete message._chronological_row;
      delete message._total_rows;
      return message;
    });
  }

  if (beforeId) {
    // IDs refletem a ordem de INSERT, não necessariamente a ordem do WhatsApp.
    // Downloads de mídia e importações de histórico podem terminar fora de
    // ordem, então o cursor precisa usar o mesmo relógio da renderização.
    const cursor = db.prepare(`
      SELECT created_at, id
      FROM messages
      WHERE conversation_id = ?
        AND id = ?
    `).get(conversationId, beforeId);
    if (!cursor) return [];
    where.push('(m.created_at < ? OR (m.created_at = ? AND m.id < ?))');
    params.push(cursor.created_at, cursor.created_at, cursor.id);
  }

  const orderSql = limit
    ? 'ORDER BY m.created_at DESC, m.id DESC LIMIT ?'
    : 'ORDER BY m.created_at ASC, m.id ASC';
  if (limit) params.push(Math.min(limit, 100));

  const messages = db.prepare(`
    SELECT ${messageSelectColumns(user)},
           v.name AS sender_vendor_name,
           ${senderLabelSql()} AS sender_label
    FROM messages m
    ${starJoin}
    ${userStateJoin}
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN vendors v ON v.id = m.vendor_id
    LEFT JOIN messages qm
      ON qm.id = m.quoted_message_id
     AND qm.conversation_id = m.conversation_id
    LEFT JOIN vendors qv ON qv.id = qm.vendor_id
    WHERE ${where.join(' AND ')}
    ${orderSql}
  `).all(...params);

  return limit ? messages.reverse() : messages;
}

function getMessageWithConversation(db, messageId) {
  return db.prepare(`
    SELECT m.*,
           c.assigned_to,
           c.sector_id,
           c.contact_name,
           c.phone,
           c.profile_pic_url,
           c.is_group,
           c.whatsapp_archived,
           c.manually_started
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
  const userStateParams = [];
  const userStateJoin = messageUserStateJoin(user, userStateParams);
  const params = [...userStateParams, user.role, user.id, ...built.params];
  where.push('mus.hidden_at IS NULL');
  where.push('COALESCE(c.whatsapp_archived, 0) = 0');
  appendVendorVisibility(where, params, user);

  return db.prepare(`
    SELECT ${messageSelectColumns(user)},
           v.name AS sender_vendor_name,
           ${senderLabelSql()} AS sender_label,
           c.phone,
           c.contact_name,
           c.profile_pic_url,
           c.assigned_to,
           m.id AS target_message_id
    FROM messages m
    ${userStateJoin}
    JOIN message_stars ms
      ON ms.message_id = m.id
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN vendors v ON v.id = m.vendor_id
    LEFT JOIN messages qm
      ON qm.id = m.quoted_message_id
     AND qm.conversation_id = m.conversation_id
    LEFT JOIN vendors qv ON qv.id = qm.vendor_id
    WHERE ${where.join(' AND ')}
    ORDER BY ms.created_at DESC, m.created_at DESC, m.id DESC
  `).all(...params);
}

function getVisibleConversations({ db, user, queue = '', limit, offset }) {
  if (!userHasIdentity(user)) return [];
  const pageLimit = normalizeConversationPageLimit(limit);
  const pageOffset = normalizeConversationPageOffset(offset);
  const baseline = getUserInboxBaseline(db, user);
  const where = [`(
    EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
    OR COALESCE(c.manually_started, 0) = 1
  )`];
  const params = [];

  appendVendorVisibility(where, params, user);

  if (queue === 'archived') {
    where.push('COALESCE(c.whatsapp_archived, 0) = 1');
  } else {
    where.push('COALESCE(c.whatsapp_archived, 0) = 0');
  }

  // Para o admin, "nao atribuida" e o que ainda precisa ser distribuido. Antes
  // exigia tambem sector_id NULL, entao conversa que caiu num setor mas nao tem
  // vendedor sumia da fila de novas e ia para "encaminhadas" — ficava sem dono
  // sem ninguem perceber. Com o vendedor enxergando apenas o que lhe foi
  // atribuido, essa conversa nao apareceria para NINGUEM.
  if (user.role !== 'vendor' && queue === 'unassigned') {
    where.push('c.assigned_to IS NULL');
  } else if (user.role !== 'vendor' && queue === 'forwarded') {
    where.push('c.assigned_to IS NOT NULL');
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return db.prepare(`
    WITH inbox_baseline(baseline_at, baseline_message_id) AS (VALUES (?, ?))
    SELECT c.*,
           v.name AS vendor_name,
           s.name AS sector_name,
           ${messagePreviewSql('latest')} AS last_message_preview,
           latest.id AS last_message_id,
           latest.created_at AS last_message_at,
           COALESCE(latest.created_at, c.last_activity_at, c.updated_at) AS last_activity_at,
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
                   m.created_at > COALESCE(cus.last_read_message_at, inbox_baseline.baseline_at)
                   OR (
                     m.created_at = COALESCE(cus.last_read_message_at, inbox_baseline.baseline_at)
                     AND m.id > CASE
                       WHEN cus.last_read_message_at IS NULL
                         THEN inbox_baseline.baseline_message_id
                       ELSE COALESCE(cus.last_read_message_id, 0)
                     END
                   )
                 )
             ))
             ELSE (
               SELECT COUNT(*)
               FROM messages m
               WHERE m.conversation_id = c.id
                 AND m.from_type = 'client'
                 AND (
                   m.created_at > COALESCE(cus.last_read_message_at, inbox_baseline.baseline_at)
                   OR (
                     m.created_at = COALESCE(cus.last_read_message_at, inbox_baseline.baseline_at)
                     AND m.id > CASE
                       WHEN cus.last_read_message_at IS NULL
                         THEN inbox_baseline.baseline_message_id
                       ELSE COALESCE(cus.last_read_message_id, 0)
                     END
                   )
                 )
             )
           END AS unread_count
    FROM conversations c
    CROSS JOIN inbox_baseline
    LEFT JOIN vendors v ON c.assigned_to = v.id
    LEFT JOIN sectors s ON c.sector_id = s.id
    LEFT JOIN conversation_user_state cus
      ON cus.conversation_id = c.id
     AND cus.user_role = ?
     AND cus.user_id = ?
    LEFT JOIN messages latest
      ON latest.id = (
        SELECT m.id
        FROM messages m
        WHERE m.conversation_id = c.id
          AND NOT EXISTS (
            SELECT 1
            FROM message_user_state hidden
            WHERE hidden.message_id = m.id
              AND hidden.user_role = ?
              AND hidden.user_id = ?
              AND hidden.hidden_at IS NOT NULL
          )
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1
      )
    ${whereSql}
    ORDER BY
      CASE WHEN cus.pinned_at IS NULL THEN 1 ELSE 0 END ASC,
      cus.pinned_at DESC,
      COALESCE(latest.created_at, c.last_activity_at, c.updated_at) DESC,
      c.id DESC
    LIMIT ? OFFSET ?
  `).all(
    baseline.at,
    baseline.messageId,
    user.role,
    user.id,
    user.role,
    user.id,
    ...params,
    pageLimit,
    pageOffset
  );
}

function markConversationRead({ db, conversationId, user, throughMessageId = null }) {
  if (!userHasIdentity(user)) throw new Error('Usuario obrigatorio para marcar conversa como lida');
  const requestedMessageId = positiveInteger(throughMessageId);
  const latest = requestedMessageId ? db.prepare(`
    SELECT id, created_at
    FROM messages
    WHERE conversation_id = ? AND id = ?
    LIMIT 1
  `).get(conversationId, requestedMessageId) : db.prepare(`
    SELECT id, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(conversationId);
  if (requestedMessageId && !latest) throw new Error('Mensagem de leitura inválida');
  const latestMessageId = latest?.id || null;
  const latestMessageAt = latest?.created_at || null;

  db.prepare(`
    INSERT INTO conversation_user_state (
      conversation_id,
      user_role,
      user_id,
      last_read_message_id,
      last_read_message_at,
      last_read_at,
      marked_unread
    )
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 0)
    ON CONFLICT(conversation_id, user_role, user_id) DO UPDATE SET
      last_read_message_id = CASE
        WHEN conversation_user_state.last_read_message_at IS NULL
          OR conversation_user_state.last_read_message_at < excluded.last_read_message_at
          OR (
            conversation_user_state.last_read_message_at = excluded.last_read_message_at
            AND COALESCE(conversation_user_state.last_read_message_id, 0) < COALESCE(excluded.last_read_message_id, 0)
          )
        THEN excluded.last_read_message_id
        ELSE conversation_user_state.last_read_message_id
      END,
      last_read_message_at = CASE
        WHEN conversation_user_state.last_read_message_at IS NULL
          OR conversation_user_state.last_read_message_at < excluded.last_read_message_at
          OR (
            conversation_user_state.last_read_message_at = excluded.last_read_message_at
            AND COALESCE(conversation_user_state.last_read_message_id, 0) < COALESCE(excluded.last_read_message_id, 0)
          )
        THEN excluded.last_read_message_at
        ELSE conversation_user_state.last_read_message_at
      END,
      last_read_at = CURRENT_TIMESTAMP,
      marked_unread = 0
  `).run(conversationId, user.role, user.id, latestMessageId, latestMessageAt);

  return db.prepare(`
    SELECT *
    FROM conversation_user_state
    WHERE conversation_id = ?
      AND user_role = ?
      AND user_id = ?
  `).get(conversationId, user.role, user.id);
}

function buildVisibleConversationWhere(user, params, alias = 'c') {
  const where = [`(
    EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = ${alias}.id)
    OR COALESCE(${alias}.manually_started, 0) = 1
  )`];
  where.push(`COALESCE(${alias}.whatsapp_archived, 0) = 0`);
  appendVendorVisibility(where, params, user, alias);
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
    ORDER BY COALESCE(c.last_activity_at, c.updated_at) DESC, c.id DESC
    LIMIT ?
  `).all(...conversationParams);

  const messageJoinParams = [];
  const starJoin = messageStarJoin(user, messageJoinParams);
  const userStateJoin = messageUserStateJoin(user, messageJoinParams);
  const messageWhere = [];
  const messageParams = [...messageJoinParams];

  messageWhere.push('COALESCE(c.whatsapp_archived, 0) = 0');
  messageWhere.push('mus.hidden_at IS NULL');
  appendVendorVisibility(messageWhere, messageParams, user);
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
           ${senderLabelSql()} AS sender_label
    FROM messages m
    ${starJoin}
    ${userStateJoin}
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN vendors v ON v.id = m.vendor_id
    LEFT JOIN messages qm
      ON qm.id = m.quoted_message_id
     AND qm.conversation_id = m.conversation_id
    LEFT JOIN vendors qv ON qv.id = qm.vendor_id
    ${messageWhere.length ? `WHERE ${messageWhere.join(' AND ')}` : ''}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `).all(...messageParams);

  return { conversations, messages };
}

module.exports = {
  canAccessConversation,
  conversationOwner,
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
