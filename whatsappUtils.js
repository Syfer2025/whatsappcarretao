const IMPORTABLE_SUFFIXES = ['@c.us', '@lid', '@g.us'];

function getChatId(chatOrMessage) {
  const rawId = chatOrMessage?._serialized
    ?? chatOrMessage?.id?._serialized
    ?? chatOrMessage?.id
    ?? chatOrMessage;
  return typeof rawId === 'string' ? rawId : '';
}

function isImportableChatId(chatId) {
  if (typeof chatId !== 'string') return false;
  return IMPORTABLE_SUFFIXES.some(suffix => chatId.endsWith(suffix));
}

function cleanDisplayName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name || '';
}

function isPhoneLikeDisplayName(value) {
  const name = cleanDisplayName(value);
  if (!name) return false;
  const digits = name.replace(/\D/g, '');
  return digits.length >= 8 && /^[+\d\s().-]+$/.test(name);
}

function getFallbackDisplayName(chatId) {
  return String(chatId || '')
    .replace('@c.us', '')
    .replace('@lid', '')
    .replace('@g.us', '');
}

function getContactDisplayName(contact) {
  return cleanDisplayName(contact?.name)
    || cleanDisplayName(contact?.shortName)
    || cleanDisplayName(contact?.pushname)
    || cleanDisplayName(contact?.verifiedName);
}

function getDisplayName(chat, chatId, contact = null) {
  const chatName = cleanDisplayName(chat?.name) || cleanDisplayName(chat?.formattedTitle);
  const contactName = getContactDisplayName(contact) || cleanDisplayName(chat?.pushname);

  if (chat?.isGroup && chatName) return chatName;
  if (chatName && !isPhoneLikeDisplayName(chatName)) return chatName;
  if (contactName) return contactName;
  if (chatName) return chatName;
  return getFallbackDisplayName(chatId);
}

function shouldReplaceDisplayName(currentName, nextName, chatId) {
  const current = cleanDisplayName(currentName);
  const next = cleanDisplayName(nextName);
  if (!next) return false;
  if (!current) return true;
  if (current === next) return false;
  return current === chatId
    || current === getFallbackDisplayName(chatId)
    || isPhoneLikeDisplayName(current);
}

function getSendChatId(savedPhoneOrChatId) {
  if (!savedPhoneOrChatId) return '';
  if (String(savedPhoneOrChatId).includes('@')) return savedPhoneOrChatId;
  return `${savedPhoneOrChatId}@c.us`;
}

function toSqlDate(timestampSeconds) {
  return toSqlDateOrNull(timestampSeconds)
    || new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function toSqlDateOrNull(timestampSeconds) {
  const seconds = Number(timestampSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function getMessageExternalId(msg) {
  const id = msg?.id?._serialized ?? msg?.id;
  return typeof id === 'string' ? id : null;
}

function getWhatsAppMediaType(messageType) {
  const type = String(messageType || '').toLowerCase();
  if (type === 'image') return 'image';
  if (type === 'sticker') return 'sticker';
  if (type === 'audio' || type === 'ptt') return 'audio';
  if (type === 'video' || type === 'gif') return 'video';
  if (type === 'document') return 'document';
  return null;
}

function hasPotentialMedia(msg) {
  return Boolean(msg?.hasMedia || getWhatsAppMediaType(msg?.type));
}

function getMessageContent(msg) {
  const body = typeof msg?.body === 'string' ? msg.body.trim() : '';
  if (body) return body;
  return hasPotentialMedia(msg) ? '(mídia)' : '';
}

// whatsapp-web.js emite `message_create` para mensagens recebidas e enviadas;
// em seguida emite também `message` para as recebidas. Cada direção precisa de
// uma única fonte para não baixar mídia e persistir a mesma mensagem duas vezes.
function shouldProcessMessageEvent(msg, source) {
  if (source === 'message_create') return Boolean(msg?.fromMe);
  if (source === 'message') return !msg?.fromMe;
  return Boolean(msg);
}

module.exports = {
  getChatId,
  isImportableChatId,
  getDisplayName,
  shouldReplaceDisplayName,
  getSendChatId,
  toSqlDate,
  toSqlDateOrNull,
  getMessageExternalId,
  getMessageContent,
  shouldProcessMessageEvent,
  getWhatsAppMediaType,
  hasPotentialMedia
};
