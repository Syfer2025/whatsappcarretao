const IMPORTABLE_SUFFIXES = ['@c.us', '@lid', '@g.us'];

function getChatId(chatOrMessage) {
  const rawId = chatOrMessage?.id?._serialized ?? chatOrMessage?.id ?? chatOrMessage;
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
  const seconds = Number(timestampSeconds);
  const date = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function getMessageExternalId(msg) {
  const id = msg?.id?._serialized ?? msg?.id;
  return typeof id === 'string' ? id : null;
}

function getMessageContent(msg) {
  const body = typeof msg?.body === 'string' ? msg.body.trim() : '';
  if (body) return body;
  return msg?.hasMedia ? '(mídia)' : '';
}

module.exports = {
  getChatId,
  isImportableChatId,
  getDisplayName,
  shouldReplaceDisplayName,
  getSendChatId,
  toSqlDate,
  getMessageExternalId,
  getMessageContent
};
