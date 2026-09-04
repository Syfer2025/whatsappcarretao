const {
  getChatId,
  isImportableChatId,
  getDisplayName,
  shouldReplaceDisplayName,
  toSqlDate,
  toSqlDateOrNull,
  getMessageExternalId,
  serializedMessageId,
  repairMessageId,
  getMessageContent,
  hasPotentialMedia
} = require('./whatsappUtils');
const {
  saveMessageMedia,
  unavailableMediaContent,
  assertKnownInboundMediaSize,
  removeStoredTenantMediaSync
} = require('./mediaStorage');
const { inboundMediaLimiter } = require('./inboundMediaLimiter');
const { getConversationProfile } = require('./conversationProfile');
const {
  contactDisplayName,
  contactPhone,
  createContactIndex
} = require('./whatsappDirectory');
const {
  findOpenConversationByIdentifiers,
  resolveWhatsAppIdentifierMap
} = require('./conversationIdentity');
const { sleep, withTimeout } = require('./runtimeUtils');

function serializedId(value) {
  if (typeof value === 'string') return value;
  if (typeof value?._serialized === 'string') return value._serialized;
  // IDs de mensagem (citada, protocolo) podem trazer o campo serializado sob
  // outro nome depois de um rebuild do WhatsApp Web — ver whatsappUtils.js.
  return serializedMessageId(value) || getChatId(value);
}

function safeProperty(object, property) {
  try {
    return object?.[property] ?? null;
  } catch {
    return null;
  }
}

function participantIdFromMessage(msg, externalId) {
  const direct = serializedId(msg?.author || msg?._data?.author);
  if (direct) return direct;
  const match = String(externalId || '').match(/_([^_]+@(?:lid|c\.us))$/i);
  return match?.[1] || null;
}

function createParticipantResolver({ whatsapp, contacts = [], timeoutMs = 2500 }) {
  const contactIndex = createContactIndex(contacts);
  const resolvedContacts = new Map();

  return async (msg, externalId, isGroup) => {
    if (!isGroup) return { participant_id: null, participant_phone: null, participant_name: null };
    const participantId = participantIdFromMessage(msg, externalId);
    if (!participantId) return { participant_id: null, participant_phone: null, participant_name: null };

    let contact = contactIndex.get(participantId) || null;
    if (!contact) {
      let contactPromise = resolvedContacts.get(participantId);
      if (!contactPromise) {
        contactPromise = (async () => {
          if (typeof msg?.getContact === 'function') {
            try {
              const loaded = await withTimeout(() => msg.getContact(), timeoutMs, 'getContact');
              if (loaded) return loaded;
            } catch {}
          }
          if (typeof whatsapp?.getContactById === 'function') {
            try {
              return await withTimeout(
                () => whatsapp.getContactById(participantId),
                timeoutMs,
                'getContactById'
              );
            } catch {}
          }
          return null;
        })();
        resolvedContacts.set(participantId, contactPromise);
      }
      contact = await contactPromise;
    }

    const phone = contactPhone(contact, participantId);
    const name = contactDisplayName(contact)
      || (typeof msg?._data?.notifyName === 'string' ? msg._data.notifyName.trim() : '')
      || phone
      || participantId.replace(/@(lid|c\.us)$/i, '');
    return {
      participant_id: participantId,
      participant_phone: phone || null,
      participant_name: name || null
    };
  };
}

async function loadDirectoryContacts(whatsapp, chats, timeoutMs) {
  const hasGroups = chats.some(chat => chat?.isGroup || getChatId(chat).endsWith('@g.us'));
  if (!hasGroups || typeof whatsapp?.getContacts !== 'function') return [];
  try {
    const contacts = await withTimeout(() => whatsapp.getContacts(), timeoutMs, 'getContacts');
    return Array.isArray(contacts) ? contacts : [];
  } catch {
    return [];
  }
}

function existingParticipantFields(message) {
  if (!message?.participant_id) return null;
  if (!message.participant_phone || !message.participant_name) return null;
  return {
    participant_id: message.participant_id,
    participant_phone: message.participant_phone,
    participant_name: message.participant_name
  };
}

async function buildMediaFields(msg, externalId, mediaRoot, logger, timeoutMs, namespace) {
  if (!hasPotentialMedia(msg) || typeof msg.downloadMedia !== 'function') {
    return { mediaFields: {}, mediaUnavailable: false };
  }

  try {
    const downloadAndSave = async () => {
      assertKnownInboundMediaSize(msg);
      // Sem isto a lib entrega um id undefined para dentro da pagina e o
      // download morre com excecao minificada — ver whatsappUtils.repairMessageId.
      repairMessageId(msg);
      const media = await withTimeout(msg.downloadMedia(), timeoutMs, 'downloadMedia');
      if (!media) {
        return { mediaFields: {}, mediaUnavailable: true };
      }

      const mediaFields = await saveMessageMedia({
        messageId: externalId,
        namespace,
        media,
        messageType: msg.type,
        mediaRoot,
        publicBasePath: '/media'
      });
      return { mediaFields: mediaFields || {}, mediaUnavailable: !mediaFields };
    };
    // Chamadas multi-tenant do servidor sempre possuem namespace. O fallback
    // preserva somente a API legada/fixtures sem tenant; no runtime real,
    // histórico e tempo real compartilham o mesmo teto de memória.
    return namespace == null
      ? await downloadAndSave()
      : await inboundMediaLimiter.run(namespace, downloadAndSave);
  } catch (err) {
    logger.error(`Erro ao baixar mídia ${externalId || ''}: ${err.message}`);
    return { mediaFields: {}, mediaUnavailable: true };
  }
}

function updateExistingMessage(
  updateMessage,
  existingMessage,
  externalId,
  content,
  mediaFields,
  mediaUnavailable,
  participantFields = {}
) {
  if (!externalId || !existingMessage) return 0;
  const placeholderContent = existingMessage.content === '(mídia)'
    || isUnavailableMediaContent(existingMessage.content);
  const improvesContent = placeholderContent && content !== existingMessage.content;
  const addsMedia = !existingMessage.media_url && Boolean(mediaFields.media_url);
  const changesAvailability = addsMedia
    ? Number(existingMessage.media_unavailable || 0) !== 0
    : Boolean(mediaUnavailable)
      && !existingMessage.media_url
      && Number(existingMessage.media_unavailable || 0) !== 1;
  const changesParticipant = [
    ['participant_id', participantFields.participant_id],
    ['participant_phone', participantFields.participant_phone],
    ['participant_name', participantFields.participant_name]
  ].some(([column, nextValue]) => nextValue && String(existingMessage[column] || '') !== String(nextValue));

  // Não execute UPDATE só porque uma mensagem de texto naturalmente não tem
  // media_url. Além do refresh desnecessário, SQLite contava a linha como
  // alterada em toda sincronização e fazia o painel recarregar sem parar.
  if (!improvesContent && !addsMedia && !changesAvailability && !changesParticipant) return 0;

  const result = updateMessage.run(
    content,
    mediaFields.media_type || null,
    mediaFields.media_mimetype || null,
    mediaFields.media_filename || null,
    mediaFields.media_url || null,
    mediaFields.media_size || null,
    mediaFields.media_sha256 || null,
    mediaUnavailable ? 1 : 0,
    mediaFields.media_url || null,
    participantFields.participant_id || null,
    participantFields.participant_phone || null,
    participantFields.participant_name || null,
    externalId
  );
  return result.changes;
}

function getImportContent(msg, mediaFields, mediaUnavailable) {
  const body = typeof msg?.body === 'string' ? msg.body.trim() : '';
  if (body) return body;
  if (mediaUnavailable) return unavailableMediaContent(msg.type);
  if (mediaFields.media_url) return '';
  return getMessageContent(msg);
}

function isUnavailableMediaContent(content) {
  return typeof content === 'string' && /^\(.+indisponível\)$/.test(content);
}

function removeUnreferencedImportedMedia({ db, mediaRoot, tenantId, mediaUrls, logger }) {
  for (const mediaUrl of new Set((mediaUrls || []).filter(Boolean))) {
    try {
      const referenced = db.prepare('SELECT 1 FROM messages WHERE media_url = ? LIMIT 1').get(mediaUrl);
      if (referenced) continue;
      removeStoredTenantMediaSync({
        mediaUrl,
        mediaRoot,
        namespace: tenantId,
        onError: error => logger?.error?.(`Erro ao remover mídia órfã ${mediaUrl}: ${error.message}`)
      });
    } catch (error) {
      logger?.error?.(`Erro ao verificar mídia órfã ${mediaUrl}: ${error.message}`);
    }
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function historicalDeliveryStatus(msg) {
  if (!msg?.fromMe) return 'received';
  const ack = Number(msg.ack);
  if (ack >= 3) return 'read';
  if (ack >= 2) return 'delivered';
  return 'sent';
}

function deliveryStatusRank(status) {
  return ({ pending: 0, unknown: 0, failed: 0, sent: 1, delivered: 2, read: 3 })[status] ?? 0;
}

function quotedExternalIdFromMessage(msg) {
  const quotedMessageId = serializedId(msg?._data?.quotedMsg?.id || msg?._data?.quotedMsg);
  if (quotedMessageId) return quotedMessageId;
  const context = msg?._data?.context_info || msg?._data?.contextInfo;
  return typeof context?.stanzaId === 'string' && context.stanzaId.trim()
    ? context.stanzaId.trim()
    : null;
}

async function resolveQuotedExternalId(msg, timeoutMs) {
  const embedded = serializedId(msg?._data?.quotedMsg?.id || msg?._data?.quotedMsg);
  if (embedded) return embedded;
  if (msg?.hasQuotedMsg && typeof msg?.getQuotedMessage === 'function') {
    try {
      const quotedMessage = await withTimeout(
        () => msg.getQuotedMessage(),
        positiveInteger(timeoutMs, 2500),
        'getQuotedMessage'
      );
      const loaded = getMessageExternalId(quotedMessage) || serializedId(quotedMessage?.id);
      if (loaded) return loaded;
    } catch {}
  }
  // context_info.stanzaId pode ser apenas o ID curto. Ele é mantido como
  // último fallback para versões do Store que não expõem quotedMsg completo.
  return quotedExternalIdFromMessage(msg);
}

function revokedExternalIdFromMessage(msg) {
  if (String(msg?.type || '').toLowerCase() !== 'revoked') return null;
  const protocolKey = msg?.protocolMessageKey || msg?._data?.protocolMessageKey;
  return serializedId(protocolKey)
    || serializedId(protocolKey?.id)
    || getMessageExternalId(msg);
}

function loadExistingMessageMap(db, externalIds) {
  const uniqueIds = [...new Set(externalIds.filter(Boolean))];
  const result = new Map();
  for (let index = 0; index < uniqueIds.length; index += 400) {
    const batch = uniqueIds.slice(index, index + 400);
    const placeholders = batch.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id,
             external_id,
             content,
             media_url,
             media_unavailable,
             participant_id,
             participant_phone,
             participant_name,
             quoted_message_id,
             delivery_status,
             edited_at,
             deleted_for_everyone
      FROM messages
      WHERE external_id IN (${placeholders})
    `).all(...batch);
    for (const row of rows) result.set(row.external_id, row);
  }
  return result;
}

function messageNeedsReconciliation(msg, existingMessage, { isGroup, retryUnavailableMedia, skipMediaDownload }) {
  if (!existingMessage) return true;
  if (Number(existingMessage.deleted_for_everyone || 0) === 1) return false;
  const hasMedia = hasPotentialMedia(msg);
  const missingMedia = hasMedia && !existingMessage.media_url && !skipMediaDownload;
  const mayRetryMedia = missingMedia && (
    retryUnavailableMedia
    || Number(existingMessage.media_unavailable || 0) !== 1
    || existingMessage.content === '(mídia)'
  );
  const missingParticipant = isGroup && (
    !existingMessage.participant_id
    || !existingMessage.participant_phone
    || !existingMessage.participant_name
  );
  const missingQuote = Boolean(msg?.hasQuotedMsg || quotedExternalIdFromMessage(msg))
    && !existingMessage.quoted_message_id;
  const edited = Boolean(msg?.latestEditSenderTimestampMs)
    && typeof msg?.body === 'string'
    && msg.body.trim() !== String(existingMessage.content || '').trim();
  const deliveryAdvanced = msg?.fromMe
    && deliveryStatusRank(historicalDeliveryStatus(msg)) > deliveryStatusRank(existingMessage.delivery_status);
  const placeholder = existingMessage.content === '(mídia)'
    || isUnavailableMediaContent(existingMessage.content);
  return mayRetryMedia || missingParticipant || missingQuote || edited || deliveryAdvanced || placeholder;
}

async function importExistingChats({
  whatsapp,
  db,
  limit = 20,
  mediaRoot = require('path').join(__dirname, 'media'),
  mediaDownloadTimeoutMs = 8000,
  profileFetchTimeoutMs = 2500,
  refreshProfiles = false,
  retryUnavailableMedia = false,
  chatImportDelayMs = 2000,
  chatFetchTimeoutMs = 15000,
  getChatsTimeoutMs = 15000,
  quoteFetchTimeoutMs = 2500,
  maxChats = null,
  adaptiveBackfill = false,
  maxFetchLimit = null,
  absoluteMaxFetchLimit = null,
  resumePersistentGap = true,
  skipMediaDownload = false,
  tenantId = null,
  onConversationImported = null,
  logger = console
}) {
  const importStartedAt = Date.now();
  const initialFetchLimit = positiveInteger(limit, 20);
  const regularMaximumFetchLimit = Math.max(
    initialFetchLimit,
    positiveInteger(maxFetchLimit, initialFetchLimit)
  );
  // O orçamento normal limita uma única primeira execução. Se uma lacuna
  // persistir, cada passagem seguinte pode dobrar o alcance até este teto
  // duro. Assim uma indisponibilidade longa não vira um buraco permanente,
  // sem permitir que um único ciclo carregue histórico ilimitado em memória.
  const absoluteMaximumFetchLimit = Math.max(
    regularMaximumFetchLimit,
    positiveInteger(absoluteMaxFetchLimit, regularMaximumFetchLimit)
  );
  const allChats = await withTimeout(
    () => whatsapp.getChats(),
    positiveInteger(getChatsTimeoutMs, 15000),
    'getChats'
  );
  if (!Array.isArray(allChats)) throw new Error('getChats retornou uma resposta inválida');
  const maxImportChats = Number(maxChats);
  const chats = Number.isInteger(maxImportChats) && maxImportChats > 0
    ? allChats
      .filter(chat => isImportableChatId(getChatId(chat)))
      .sort((a, b) => Number(b?.timestamp || 0) - Number(a?.timestamp || 0))
      .slice(0, maxImportChats)
    : allChats;
  const identifierMap = await resolveWhatsAppIdentifierMap(
    whatsapp,
    chats.map(chat => getChatId(chat)),
    Math.max(2500, profileFetchTimeoutMs)
  );
  // O import recente roda em intervalos curtos. getContacts() percorre todo o
  // Store do WhatsApp e não deve ser repetido a cada lote; o snapshot completo
  // é carregado no import integral, enquanto mensagens novas ainda podem usar
  // msg.getContact()/getContactById sob demanda.
  const directoryContacts = maxImportChats > 0
    ? []
    : await loadDirectoryContacts(
      whatsapp,
      chats,
      Math.max(profileFetchTimeoutMs, Math.min(chatFetchTimeoutMs, 10000))
    );
  const resolveParticipant = createParticipantResolver({
    whatsapp,
    contacts: directoryContacts,
    timeoutMs: profileFetchTimeoutMs
  });
  const stats = {
    totalChats: chats.length,
    skippedChats: 0,
    newConversations: 0,
    existingConversations: 0,
    conversationsUpdated: 0,
    messagesImported: 0,
    messagesUpdated: 0,
    mediaImported: 0,
    mediaUnavailable: 0,
    failedChats: 0,
    messagesFetched: 0,
    messagesSkippedKnown: 0,
    adaptiveFetches: 0,
    gapLimitReached: 0,
    durationMs: 0
  };

  const insertConversation = db.prepare(`
    INSERT INTO conversations (
      phone,
      contact_name,
      profile_pic_url,
      is_group,
      group_description,
      whatsapp_archived,
      status,
      last_activity_at,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateConversation = db.prepare(`
    UPDATE conversations
    SET contact_name = ?,
        profile_pic_url = COALESCE(?, profile_pic_url),
        is_group = ?,
        group_description = ?,
        whatsapp_archived = ?,
        archived_at = CASE
          WHEN ? = 1 THEN COALESCE(archived_at, CURRENT_TIMESTAMP)
          ELSE NULL
        END,
        archive_sync_state = 'synced',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const updateConversationActivity = db.prepare(`
    UPDATE conversations
    SET last_activity_at = ?,
        updated_at = CASE
          WHEN updated_at IS NULL OR updated_at < ? THEN ?
          ELSE updated_at
        END
    WHERE id = ?
      AND last_activity_at IS NOT ?
  `);
  const findLatestConversationMessage = db.prepare(`
    SELECT id, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);
  const deleteEmptyConversation = db.prepare(`
    DELETE FROM conversations
    WHERE id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM messages m
        WHERE m.conversation_id = conversations.id
      )
  `);
  const insertConversationIdentifier = db.prepare(`
    INSERT OR IGNORE INTO conversation_identifiers (identifier, conversation_id)
    VALUES (?, ?)
  `);
  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages (
      conversation_id,
      external_id,
      from_type,
      participant_id,
      participant_phone,
      participant_name,
      content,
      media_type,
      media_mimetype,
      media_filename,
      media_url,
      media_size,
      media_sha256,
      media_unavailable,
      delivery_status,
      sent_at,
      edited_at,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRevokedMessage = db.prepare(`
    INSERT OR IGNORE INTO messages (
      conversation_id,
      external_id,
      from_type,
      content,
      delivery_status,
      sent_at,
      deleted_for_everyone,
      deleted_for_everyone_at,
      created_at
    )
    VALUES (?, ?, ?, 'Mensagem apagada', 'revoked', ?, 1, CURRENT_TIMESTAMP, ?)
  `);
  const findLatestKnownExternalId = db.prepare(`
    SELECT external_id
    FROM messages
    WHERE conversation_id = ?
      AND external_id IS NOT NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);
  const getConversationSyncState = db.prepare(`
    SELECT *
    FROM conversation_sync_state
    WHERE conversation_id = ?
  `);
  const upsertSyncSuccess = db.prepare(`
    INSERT INTO conversation_sync_state (
      conversation_id,
      newest_external_id,
      newest_message_at,
      oldest_external_id,
      oldest_message_at,
      history_complete,
      gap_target_external_id,
      gap_fetch_limit,
      last_success_at,
      last_error,
      last_error_at,
      last_duration_ms,
      last_messages_fetched,
      last_messages_imported,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, NULL, NULL, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(conversation_id) DO UPDATE SET
      newest_external_id = CASE
        WHEN excluded.newest_message_at IS NOT NULL
          AND (conversation_sync_state.newest_message_at IS NULL
            OR excluded.newest_message_at >= conversation_sync_state.newest_message_at)
          THEN excluded.newest_external_id
        ELSE conversation_sync_state.newest_external_id
      END,
      newest_message_at = CASE
        WHEN excluded.newest_message_at IS NOT NULL
          AND (conversation_sync_state.newest_message_at IS NULL
            OR excluded.newest_message_at >= conversation_sync_state.newest_message_at)
          THEN excluded.newest_message_at
        ELSE conversation_sync_state.newest_message_at
      END,
      oldest_external_id = CASE
        WHEN excluded.oldest_message_at IS NOT NULL
          AND (conversation_sync_state.oldest_message_at IS NULL
            OR excluded.oldest_message_at <= conversation_sync_state.oldest_message_at)
          THEN excluded.oldest_external_id
        ELSE conversation_sync_state.oldest_external_id
      END,
      oldest_message_at = CASE
        WHEN excluded.oldest_message_at IS NOT NULL
          AND (conversation_sync_state.oldest_message_at IS NULL
            OR excluded.oldest_message_at <= conversation_sync_state.oldest_message_at)
          THEN excluded.oldest_message_at
        ELSE conversation_sync_state.oldest_message_at
      END,
      history_complete = MAX(conversation_sync_state.history_complete, excluded.history_complete),
      gap_target_external_id = excluded.gap_target_external_id,
      gap_fetch_limit = CASE
        WHEN excluded.gap_target_external_id IS NOT NULL
          AND excluded.gap_target_external_id = conversation_sync_state.gap_target_external_id
          THEN MAX(
            COALESCE(conversation_sync_state.gap_fetch_limit, 0),
            COALESCE(excluded.gap_fetch_limit, 0)
          )
        ELSE excluded.gap_fetch_limit
      END,
      last_success_at = CURRENT_TIMESTAMP,
      last_error = NULL,
      last_error_at = NULL,
      last_duration_ms = excluded.last_duration_ms,
      last_messages_fetched = excluded.last_messages_fetched,
      last_messages_imported = excluded.last_messages_imported,
      updated_at = CURRENT_TIMESTAMP
  `);
  const upsertSyncError = db.prepare(`
    INSERT INTO conversation_sync_state (
      conversation_id, last_error, last_error_at, updated_at
    ) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(conversation_id) DO UPDATE SET
      last_error = excluded.last_error,
      last_error_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `);
  const updateMessage = db.prepare(`
    UPDATE messages
    SET content = CASE
          WHEN content = '(mídia)' OR content LIKE '(%indisponível)' THEN ?
          ELSE content
        END,
        media_type = COALESCE(media_type, ?),
        media_mimetype = COALESCE(media_mimetype, ?),
        media_filename = COALESCE(media_filename, ?),
        media_url = COALESCE(media_url, ?),
        media_size = COALESCE(media_size, ?),
        media_sha256 = COALESCE(media_sha256, ?),
        media_unavailable = CASE
          WHEN ? THEN 1
          WHEN ? IS NOT NULL THEN 0
          ELSE COALESCE(media_unavailable, 0)
        END,
        participant_id = COALESCE(NULLIF(?, ''), participant_id),
        participant_phone = COALESCE(NULLIF(?, ''), participant_phone),
        participant_name = COALESCE(NULLIF(?, ''), participant_name)
    WHERE external_id = ?
  `);
  const updateEditedMessage = db.prepare(`
    UPDATE messages
    SET content = ?, edited_at = ?
    WHERE external_id = ?
      AND COALESCE(deleted_for_everyone, 0) = 0
      AND content IS NOT ?
  `);
  const updateDeliveryStatus = db.prepare(`
    UPDATE messages
    SET delivery_status = ?,
        sent_at = COALESCE(sent_at, created_at),
        delivery_error = NULL
    WHERE external_id = ?
      AND delivery_status IS NOT ?
  `);
  const updateRevokedMessage = db.prepare(`
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
    WHERE external_id = ?
      AND COALESCE(deleted_for_everyone, 0) = 0
  `);
  const updateQuotedMessage = db.prepare(`
    UPDATE messages
    SET quoted_message_id = (
      SELECT quoted.id
      FROM messages quoted
      WHERE quoted.external_id = ?
        AND quoted.conversation_id = messages.conversation_id
      LIMIT 1
    )
    WHERE external_id = ?
      AND quoted_message_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM messages quoted
        WHERE quoted.external_id = ?
          AND quoted.conversation_id = messages.conversation_id
      )
  `);

  logger.log(`Importando ${chats.length} conversas existentes...`);

  let chatIndex = 0;
  for (const chat of chats) {
    chatIndex++;

    // Delay aleatório entre chats para evitar rate limit do WhatsApp
    if (chatIndex > 1 && chatImportDelayMs > 0) {
      const delay = Math.round(chatImportDelayMs * (0.5 + Math.random()));
      await sleep(delay);
    }

    const phone = getChatId(chat);
    if (!isImportableChatId(phone)) {
      stats.skippedChats += 1;
      continue;
    }

    const chatDate = toSqlDateOrNull(chat.timestamp);
    const isGroup = Boolean(chat?.isGroup || phone.endsWith('@g.us'));
    const groupDescription = isGroup
      ? (typeof safeProperty(chat, 'description') === 'string'
        ? safeProperty(chat, 'description').trim() || null
        : null)
      : null;
    const whatsappArchived = chat?.archived ? 1 : 0;
    const chatIdentifiers = identifierMap.get(phone) || [phone];
    let conversation = findOpenConversationByIdentifiers(db, chatIdentifiers);
    let conversationCreated = false;
    let conversationMetadataUpdated = false;
    const shouldFetchProfile = !conversation || refreshProfiles;
    const profile = shouldFetchProfile
      ? await getConversationProfile({
        whatsapp,
        chat,
        chatId: phone,
        timeoutMs: profileFetchTimeoutMs
      })
      : {
        contactName: conversation.contact_name || getDisplayName(chat, phone),
        profilePicUrl: conversation.profile_pic_url || null
      };
    const contactName = profile.contactName || getDisplayName(chat, phone);

    const conversationCreatedAt = chatDate || toSqlDate(Date.now() / 1000);
    let nextContactName = contactName;
    let nextProfilePicUrl = profile.profilePicUrl || null;
    if (conversation) {
      nextContactName = (isGroup && contactName)
        || (shouldReplaceDisplayName(conversation.contact_name, contactName, phone)
        ? contactName
        : conversation.contact_name);
      nextProfilePicUrl = profile.profilePicUrl || conversation.profile_pic_url || null;
      conversationMetadataUpdated = nextContactName !== conversation.contact_name
        || nextProfilePicUrl !== (conversation.profile_pic_url || null)
        || Number(conversation.is_group || 0) !== (isGroup ? 1 : 0)
        || (conversation.group_description || null) !== groupDescription
        || Number(conversation.whatsapp_archived || 0) !== whatsappArchived;
      stats.existingConversations += 1;
    }

    const chatImportStartedAt = Date.now();
    const previousSyncState = conversation
      ? getConversationSyncState.get(conversation.id) || null
      : null;
    const newestKnown = conversation
      ? findLatestKnownExternalId.get(conversation.id)?.external_id || null
      : null;
    const persistentGapTarget = previousSyncState?.gap_target_external_id || null;
    const shouldResumePersistentGap = Boolean(resumePersistentGap && persistentGapTarget);
    const overlapTarget = shouldResumePersistentGap ? persistentGapTarget : newestKnown;
    let fetchLimit = shouldResumePersistentGap
      ? Math.min(
        absoluteMaximumFetchLimit,
        Math.max(initialFetchLimit, positiveInteger(previousSyncState.gap_fetch_limit, initialFetchLimit) * 2)
      )
      : initialFetchLimit;
    // Uma lacuna retomada recebe exatamente um degrau adicional nesta
    // execução. Sem lacuna anterior, o backfill adaptativo usa apenas o
    // orçamento normal. Isso mantém latência e memória previsíveis.
    const currentRunMaximumFetchLimit = shouldResumePersistentGap
      ? Math.max(regularMaximumFetchLimit, fetchLimit)
      : regularMaximumFetchLimit;
    let messages;
    let fetchedExternalIds = new Set();
    try {
      do {
        messages = await withTimeout(
          () => chat.fetchMessages({ limit: fetchLimit }),
          chatFetchTimeoutMs,
          'fetchMessages'
        );
        if (!Array.isArray(messages)) throw new Error('fetchMessages retornou uma resposta inválida');
        fetchedExternalIds = new Set(messages.flatMap(message => [
          getMessageExternalId(message),
          revokedExternalIdFromMessage(message)
        ]).filter(Boolean));
        const foundOverlap = !overlapTarget || fetchedExternalIds.has(overlapTarget);
        const reachedHistoryStart = messages.length < fetchLimit;
        if (!adaptiveBackfill || foundOverlap || reachedHistoryStart || fetchLimit >= currentRunMaximumFetchLimit) break;
        fetchLimit = Math.min(currentRunMaximumFetchLimit, fetchLimit * 2);
        stats.adaptiveFetches += 1;
      } while (true);
      stats.messagesFetched += messages.length;
    } catch (err) {
      stats.failedChats += 1;
      if (conversation?.id) {
        upsertSyncError.run(conversation.id, String(err.message || err).slice(0, 1000));
      }
      logger.error(`Erro ao importar mensagens de ${contactName}: ${err.message}`);
      continue;
    }

    const reachedHistoryStart = messages.length < fetchLimit;
    const foundOverlap = !overlapTarget || fetchedExternalIds.has(overlapTarget);
    const gapLimitReached = Boolean(
      adaptiveBackfill
      && overlapTarget
      && !foundOverlap
      && !reachedHistoryStart
      && fetchLimit >= currentRunMaximumFetchLimit
    );
    // O sync recente deve continuar rápido mesmo quando um import integral
    // deixou uma lacuna profunda. Ele reconcilia a janela nova usando
    // newestKnown, mas não pode apagar nem reduzir o cursor que o próximo
    // import integral retomará.
    const preservePersistentGap = Boolean(!resumePersistentGap && persistentGapTarget);
    const nextGapTarget = preservePersistentGap
      ? persistentGapTarget
      : gapLimitReached ? overlapTarget : null;
    const nextGapFetchLimit = preservePersistentGap
      ? previousSyncState.gap_fetch_limit
      : gapLimitReached ? fetchLimit : null;
    // whatsapp-web.js retorna fetchMessages do mais antigo para o mais novo.
    // Ordenar explicitamente torna a importação determinística mesmo com mocks
    // ou versões futuras da biblioteca e evita usar o ID do banco como relógio.
    const orderedMessages = [...messages].sort((left, right) => {
      const timestampDiff = Number(left?.timestamp || 0) - Number(right?.timestamp || 0);
      if (timestampDiff) return timestampDiff;
      // Array.sort é estável nas versões de Node suportadas. Em mensagens do
      // mesmo segundo preserve a ordem entregue pelo Store do WhatsApp; o ID
      // externo é aleatório e sua ordenação lexical embaralha a conversa.
      return 0;
    });

    const existingMessages = loadExistingMessageMap(
      db,
      orderedMessages.flatMap(message => [
        getMessageExternalId(message),
        revokedExternalIdFromMessage(message)
      ])
    );
    const messageMutations = [];
    let skippedKnownForChat = 0;
    let mediaImportedForChat = 0;
    let mediaUnavailableForChat = 0;

    for (const msg of orderedMessages) {
      const revokedExternalId = revokedExternalIdFromMessage(msg);
      const externalId = revokedExternalId || getMessageExternalId(msg);
      if (!externalId) continue;
      const messageDate = toSqlDateOrNull(msg.timestamp) || chatDate || toSqlDate(Date.now() / 1000);
      const existingMessage = existingMessages.get(externalId) || null;
      if (revokedExternalId) {
        if (Number(existingMessage?.deleted_for_everyone || 0) === 1) {
          skippedKnownForChat += 1;
          continue;
        }
        messageMutations.push({
          kind: 'revoked',
          existingMessage,
          externalId,
          fromType: msg.fromMe ? 'vendor' : 'client',
          sentAt: msg.fromMe ? messageDate : null,
          messageDate
        });
        continue;
      }
      if (!messageNeedsReconciliation(msg, existingMessage, {
        isGroup,
        retryUnavailableMedia,
        skipMediaDownload
      })) {
        skippedKnownForChat += 1;
        continue;
      }
      const alreadyMarkedUnavailable = Number(existingMessage?.media_unavailable) === 1
        || isUnavailableMediaContent(existingMessage?.content);
      const messageHasMedia = hasPotentialMedia(msg);
      const participantFields = existingParticipantFields(existingMessage)
        || await resolveParticipant(msg, externalId, isGroup);
      const skipUnavailableMediaRetry = messageHasMedia
        && alreadyMarkedUnavailable
        && !existingMessage?.media_url
        && !retryUnavailableMedia;

      const shouldDownloadMedia = !skipMediaDownload
        && !skipUnavailableMediaRetry
        && messageHasMedia
        && !existingMessage?.media_url;
      const { mediaFields, mediaUnavailable } = shouldDownloadMedia
        ? await buildMediaFields(msg, externalId, mediaRoot, logger, mediaDownloadTimeoutMs, tenantId)
        : { mediaFields: {}, mediaUnavailable: false };
      const content = skipUnavailableMediaRetry && existingMessage
        ? existingMessage.content
        : getImportContent(msg, mediaFields, mediaUnavailable);
      if (!content && !mediaFields.media_url && !existingMessage) continue;
      if (mediaFields.media_url) mediaImportedForChat += 1;
      if (mediaUnavailable) mediaUnavailableForChat += 1;
      const editedAt = msg?.latestEditSenderTimestampMs
        ? toSqlDateOrNull(Number(msg.latestEditSenderTimestampMs) / 1000) || messageDate
        : null;
      const editedContent = msg?.latestEditSenderTimestampMs && typeof msg?.body === 'string'
        ? msg.body.trim()
        : null;
      messageMutations.push({
        kind: 'message',
        existingMessage,
        externalId,
        fromType: msg.fromMe ? 'vendor' : 'client',
        participantFields,
        content,
        mediaFields,
        mediaUnavailable,
        deliveryStatus: historicalDeliveryStatus(msg),
        sentAt: msg.fromMe ? messageDate : null,
        editedAt,
        editedContent,
        messageDate,
        fromMe: Boolean(msg.fromMe),
        quotedExternalId: await resolveQuotedExternalId(msg, quoteFetchTimeoutMs)
      });
    }

    const fetchedBoundaries = orderedMessages
      .map(message => ({
        externalId: revokedExternalIdFromMessage(message) || getMessageExternalId(message),
        messageAt: toSqlDateOrNull(message?.timestamp)
      }))
      .filter(item => item.externalId && item.messageAt);
    const oldestFetched = fetchedBoundaries[0] || null;
    const newestFetched = fetchedBoundaries[fetchedBoundaries.length - 1] || null;

    // Toda I/O remota e de arquivos já terminou. Daqui até o retorno da
    // transação há apenas operações SQLite síncronas, garantindo um único
    // commit por chat e rollback integral em qualquer falha intermediária.
    const applyChatMutations = db.transaction(() => {
      let conversationId = conversation?.id || null;
      let created = false;
      if (!conversationId) {
        const result = insertConversation.run(
          phone,
          contactName,
          profile.profilePicUrl,
          isGroup ? 1 : 0,
          groupDescription,
          whatsappArchived,
          'unassigned',
          chatDate,
          conversationCreatedAt,
          conversationCreatedAt
        );
        conversationId = result.lastInsertRowid;
        created = true;
      } else if (conversationMetadataUpdated) {
        updateConversation.run(
          nextContactName,
          profile.profilePicUrl,
          isGroup ? 1 : 0,
          groupDescription,
          whatsappArchived,
          whatsappArchived,
          conversationId
        );
      }

      for (const identifier of chatIdentifiers) {
        insertConversationIdentifier.run(identifier, conversationId);
      }

      let importedMessages = 0;
      let updatedMessages = 0;
      for (const mutation of messageMutations) {
        if (mutation.kind === 'revoked') {
          if (mutation.existingMessage) {
            updatedMessages += updateRevokedMessage.run(mutation.externalId).changes;
          } else {
            const inserted = insertRevokedMessage.run(
              conversationId,
              mutation.externalId,
              mutation.fromType,
              mutation.sentAt,
              mutation.messageDate
            ).changes;
            importedMessages += inserted;
            // O lote pode conter a mensagem original e o evento de revogação.
            // Se a original acabou de ser inserida, o placeholder colide pelo
            // external_id e esta atualização aplica o estado final correto.
            if (!inserted) {
              updatedMessages += updateRevokedMessage.run(mutation.externalId).changes;
            }
          }
          continue;
        }
        if (!mutation.existingMessage) {
          const result = insertMessage.run(
            conversationId,
            mutation.externalId,
            mutation.fromType,
            mutation.participantFields.participant_id,
            mutation.participantFields.participant_phone,
            mutation.participantFields.participant_name,
            mutation.content,
            mutation.mediaFields.media_type || null,
            mutation.mediaFields.media_mimetype || null,
            mutation.mediaFields.media_filename || null,
            mutation.mediaFields.media_url || null,
            mutation.mediaFields.media_size || null,
            mutation.mediaFields.media_sha256 || null,
            mutation.mediaUnavailable ? 1 : 0,
            mutation.deliveryStatus,
            mutation.sentAt,
            mutation.editedAt,
            mutation.messageDate
          );
          importedMessages += result.changes;
          continue;
        }

        let updated = updateExistingMessage(
          updateMessage,
          mutation.existingMessage,
          mutation.externalId,
          mutation.content,
          mutation.mediaFields,
          mutation.mediaUnavailable,
          mutation.participantFields
        );
        if (
          mutation.editedContent
          && mutation.editedContent !== String(mutation.existingMessage.content || '').trim()
        ) {
          updated = Math.max(
            updated,
            updateEditedMessage.run(
              mutation.editedContent,
              mutation.editedAt,
              mutation.externalId,
              mutation.editedContent
            ).changes
          );
        }
        if (
          mutation.fromMe
          && deliveryStatusRank(mutation.deliveryStatus)
            > deliveryStatusRank(mutation.existingMessage.delivery_status)
        ) {
          updated = Math.max(
            updated,
            updateDeliveryStatus.run(
              mutation.deliveryStatus,
              mutation.externalId,
              mutation.deliveryStatus
            ).changes
          );
        }
        updatedMessages += updated;
      }

      for (const mutation of messageMutations) {
        if (!mutation.quotedExternalId) continue;
        updatedMessages += updateQuotedMessage.run(
          mutation.quotedExternalId,
          mutation.externalId,
          mutation.quotedExternalId
        ).changes;
      }

      // chat.timestamp pode representar reação, chamada, evento de grupo ou um
      // item que o sistema não persiste. A atividade aponta para a mensagem real.
      const latestMessage = findLatestConversationMessage.get(conversationId);
      const activityUpdated = latestMessage
        ? Boolean(updateConversationActivity.run(
          latestMessage.created_at,
          latestMessage.created_at,
          latestMessage.created_at,
          conversationId,
          latestMessage.created_at
        ).changes)
        : false;
      if (
        created
        && importedMessages === 0
        && updatedMessages === 0
        && deleteEmptyConversation.run(conversationId).changes
      ) {
        return {
          conversationId,
          created,
          deletedEmpty: true,
          metadataUpdated: false,
          importedMessages,
          updatedMessages,
          activityUpdated: false
        };
      }

      upsertSyncSuccess.run(
        conversationId,
        newestFetched?.externalId || null,
        newestFetched?.messageAt || null,
        oldestFetched?.externalId || null,
        oldestFetched?.messageAt || null,
        (
          (!preservePersistentGap && reachedHistoryStart)
          || Number(previousSyncState?.history_complete || 0) === 1
        ) ? 1 : 0,
        nextGapTarget,
        nextGapFetchLimit,
        Date.now() - chatImportStartedAt,
        messages.length,
        importedMessages
      );
      return {
        conversationId,
        created,
        deletedEmpty: false,
        metadataUpdated: !created && conversationMetadataUpdated,
        importedMessages,
        updatedMessages,
        activityUpdated
      };
    });

    let mutationResult;
    try {
      mutationResult = applyChatMutations();
    } catch (err) {
      // Media is intentionally written before the SQLite transaction so a slow
      // disk/antivirus never holds the write lock. If the transaction rolls
      // back, remove only files that no durable message references.
      removeUnreferencedImportedMedia({
        db,
        mediaRoot,
        tenantId,
        mediaUrls: messageMutations.map(mutation => mutation.mediaFields?.media_url),
        logger
      });
      stats.failedChats += 1;
      if (conversation?.id) {
        try {
          upsertSyncError.run(conversation.id, String(err.message || err).slice(0, 1000));
        } catch (syncError) {
          logger.error(`Erro ao registrar falha de sincronização de ${contactName}: ${syncError.message}`);
        }
      }
      logger.error(`Erro ao persistir mensagens de ${contactName}: ${err.message}`);
      continue;
    }

    // A batch may contain the original media followed by its revoke protocol
    // event. The transaction correctly clears media_url; release the matching
    // tenant file as well so deletion is durable and quotas do not leak.
    const revokedExternalIds = new Set(
      messageMutations
        .filter(mutation => mutation.kind === 'revoked')
        .map(mutation => mutation.externalId)
    );
    removeUnreferencedImportedMedia({
      db,
      mediaRoot,
      tenantId,
      mediaUrls: messageMutations.flatMap(mutation => {
        if (mutation.kind === 'revoked') return [mutation.existingMessage?.media_url];
        if (revokedExternalIds.has(mutation.externalId)) return [mutation.mediaFields?.media_url];
        return [];
      }),
      logger
    });

    stats.messagesSkippedKnown += skippedKnownForChat;
    stats.mediaImported += mediaImportedForChat;
    stats.mediaUnavailable += mediaUnavailableForChat;
    if (gapLimitReached) stats.gapLimitReached += 1;
    if (mutationResult.deletedEmpty) {
      stats.skippedChats += 1;
      continue;
    }

    conversationCreated = mutationResult.created;
    stats.newConversations += conversationCreated ? 1 : 0;
    stats.conversationsUpdated += mutationResult.metadataUpdated ? 1 : 0;
    stats.messagesImported += mutationResult.importedMessages;
    stats.messagesUpdated += mutationResult.updatedMessages;
    if (mutationResult.importedMessages > 0) {
      logger.log(`  Importado: ${contactName} (${mutationResult.importedMessages} msgs novas)`);
    }
    if (onConversationImported && (
      conversationCreated
      || mutationResult.metadataUpdated
      || mutationResult.activityUpdated
      || mutationResult.importedMessages > 0
      || mutationResult.updatedMessages > 0
    )) {
      try {
        onConversationImported(mutationResult.conversationId, {
          importedMessages: mutationResult.importedMessages,
          updatedMessages: mutationResult.updatedMessages,
          conversationCreated,
          activityUpdated: mutationResult.activityUpdated
        });
      } catch (err) {
        logger.error(`Erro ao notificar progresso da importacao: ${err.message}`);
      }
    }
  }

  stats.durationMs = Date.now() - importStartedAt;
  logger.log(`Importação concluída! ${stats.newConversations} conversas novas, ${stats.messagesImported} mensagens novas.`);
  return stats;
}

module.exports = {
  importExistingChats
};
