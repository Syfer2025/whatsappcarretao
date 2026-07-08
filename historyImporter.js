const {
  getChatId,
  isImportableChatId,
  getDisplayName,
  shouldReplaceDisplayName,
  toSqlDate,
  getMessageExternalId,
  getMessageContent
} = require('./whatsappUtils');
const { saveMessageMedia, unavailableMediaContent } = require('./mediaStorage');
const { getConversationProfile } = require('./conversationProfile');
const { sleep, withTimeout } = require('./runtimeUtils');

async function buildMediaFields(msg, externalId, mediaRoot, logger, timeoutMs) {
  if (!msg?.hasMedia || typeof msg.downloadMedia !== 'function') {
    return { mediaFields: {}, mediaUnavailable: false };
  }

  try {
    const media = await withTimeout(msg.downloadMedia(), timeoutMs, 'downloadMedia');
    if (!media) {
      return { mediaFields: {}, mediaUnavailable: true };
    }

    const mediaFields = await saveMessageMedia({
      messageId: externalId,
      media,
      messageType: msg.type,
      mediaRoot,
      publicBasePath: '/media'
    });

    return { mediaFields: mediaFields || {}, mediaUnavailable: !mediaFields };
  } catch (err) {
    logger.error(`Erro ao baixar mídia ${externalId || ''}: ${err.message}`);
    return { mediaFields: {}, mediaUnavailable: true };
  }
}

function updateExistingMessage(updateMessage, externalId, content, mediaFields, mediaUnavailable) {
  if (!externalId) return 0;
  const result = updateMessage.run(
    content,
    mediaFields.media_type || null,
    mediaFields.media_mimetype || null,
    mediaFields.media_filename || null,
    mediaFields.media_url || null,
    mediaFields.media_size || null,
    mediaUnavailable ? 1 : 0,
    mediaFields.media_url || null,
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
  logger = console
}) {
  const chats = await whatsapp.getChats();
  const stats = {
    totalChats: chats.length,
    skippedChats: 0,
    newConversations: 0,
    existingConversations: 0,
    messagesImported: 0,
    messagesUpdated: 0,
    mediaImported: 0,
    mediaUnavailable: 0,
    failedChats: 0
  };

  const findConversation = db.prepare('SELECT id, contact_name, profile_pic_url FROM conversations WHERE phone = ? ORDER BY id DESC LIMIT 1');
  const insertConversation = db.prepare(`
    INSERT INTO conversations (phone, contact_name, profile_pic_url, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updateConversation = db.prepare(`
    UPDATE conversations
    SET contact_name = ?,
        profile_pic_url = COALESCE(?, profile_pic_url),
        updated_at = ?
    WHERE id = ?
  `);
  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages (
      conversation_id,
      external_id,
      from_type,
      content,
      media_type,
      media_mimetype,
      media_filename,
      media_url,
      media_size,
      media_unavailable,
      delivery_status,
      sent_at,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const findMessageByExternalId = db.prepare('SELECT id, content, media_url, media_unavailable FROM messages WHERE external_id = ? LIMIT 1');
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
        media_unavailable = CASE
          WHEN ? THEN 1
          WHEN ? IS NOT NULL THEN 0
          ELSE COALESCE(media_unavailable, 0)
        END
    WHERE external_id = ?
      AND (
        media_url IS NULL
        OR content = '(mídia)'
        OR content LIKE '(%indisponível)'
        OR media_unavailable = 1
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

    const chatDate = toSqlDate(chat.timestamp);
    let conversation = findConversation.get(phone);
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

    if (!conversation) {
      const result = insertConversation.run(phone, contactName, profile.profilePicUrl, 'unassigned', chatDate, chatDate);
      conversation = { id: result.lastInsertRowid, contact_name: contactName, profile_pic_url: profile.profilePicUrl };
      stats.newConversations += 1;
    } else {
      const nextContactName = shouldReplaceDisplayName(conversation.contact_name, contactName, phone)
        ? contactName
        : conversation.contact_name;
      updateConversation.run(nextContactName, profile.profilePicUrl, chatDate, conversation.id);
      conversation = { ...conversation, contact_name: nextContactName, profile_pic_url: profile.profilePicUrl || conversation.profile_pic_url };
      stats.existingConversations += 1;
    }

    let messages;
    try {
      messages = await chat.fetchMessages({ limit });
    } catch (err) {
      stats.failedChats += 1;
      logger.error(`Erro ao importar mensagens de ${contactName}: ${err.message}`);
      continue;
    }

    let importedForChat = 0;

    for (const msg of [...messages].reverse()) {
      const externalId = getMessageExternalId(msg);
      const existingMessage = externalId ? findMessageByExternalId.get(externalId) : null;
      const alreadyMarkedUnavailable = Number(existingMessage?.media_unavailable) === 1
        || isUnavailableMediaContent(existingMessage?.content);
      if (msg.hasMedia && alreadyMarkedUnavailable && !existingMessage?.media_url && !retryUnavailableMedia) {
        continue;
      }

      const shouldDownloadMedia = msg.hasMedia && !existingMessage?.media_url;
      const { mediaFields, mediaUnavailable } = shouldDownloadMedia
        ? await buildMediaFields(msg, externalId, mediaRoot, logger, mediaDownloadTimeoutMs)
        : { mediaFields: {}, mediaUnavailable: false };
      const content = getImportContent(msg, mediaFields, mediaUnavailable);
      if (!content && !mediaFields.media_url) continue;
      if (mediaFields.media_url) stats.mediaImported += 1;
      if (mediaUnavailable) stats.mediaUnavailable += 1;

      const result = insertMessage.run(
        conversation.id,
        externalId,
        msg.fromMe ? 'vendor' : 'client',
        content,
        mediaFields.media_type || null,
        mediaFields.media_mimetype || null,
        mediaFields.media_filename || null,
        mediaFields.media_url || null,
        mediaFields.media_size || null,
        mediaUnavailable ? 1 : 0,
        msg.fromMe ? 'sent' : 'received',
        msg.fromMe ? toSqlDate(msg.timestamp) : null,
        toSqlDate(msg.timestamp)
      );

      if (result.changes) {
        importedForChat += result.changes;
        stats.messagesImported += result.changes;
      } else {
        const updated = updateExistingMessage(updateMessage, externalId, content, mediaFields, mediaUnavailable);
        stats.messagesUpdated += updated;
      }
    }

    if (importedForChat > 0) {
      logger.log(`  Importado: ${contactName} (${importedForChat} msgs novas)`);
    }
  }

  logger.log(`Importação concluída! ${stats.newConversations} conversas novas, ${stats.messagesImported} mensagens novas.`);
  return stats;
}

module.exports = {
  importExistingChats
};
