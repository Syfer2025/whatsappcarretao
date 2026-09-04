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

// O bundle do WhatsApp Web é minificado e o nome do campo serializado muda
// entre builds: em 08/2026 o ID de mensagem saiu de `_serialized` para `$1`,
// mas o whatsapp-web.js 1.34.7 só lê o nome antigo (upstream #5733). Ler
// apenas `_serialized` fazia getMessageExternalId devolver null para TODA
// mensagem, e o importador descarta mensagem sem ID externo
// (historyImporter.js: `if (!externalId) continue`) — 100% das mensagens
// sumiam mesmo com o conteúdo presente na página.
//
// A ordem abaixo sobrevive ao próximo rename: primeiro o valor que o próprio
// WhatsApp expõe (qualquer nome que ele use), e só então a remontagem a partir
// de fromMe/remote/id, que são nomes semânticos e não são minificados.
const SERIALIZED_MESSAGE_ID = /^(?:true|false)_[^_]+@[a-z.]+_.+/i;

function serializedMessageId(rawId) {
  if (typeof rawId === 'string') return rawId || null;
  if (!rawId || typeof rawId !== 'object') return null;
  if (typeof rawId._serialized === 'string' && rawId._serialized) return rawId._serialized;
  // Só aceita valores com a forma de ID de mensagem: `remote` também é string
  // e casaria com um teste mais frouxo, devolvendo o ID do chat por engano.
  for (const value of Object.values(rawId)) {
    if (typeof value === 'string' && SERIALIZED_MESSAGE_ID.test(value)) return value;
  }
  const { fromMe, remote, id: local, participant } = rawId;
  if (typeof local !== 'string' || !local) return null;
  if (typeof remote !== 'string' || !remote) return null;
  const base = `${Boolean(fromMe)}_${remote}_${local}`;
  const participantId = typeof participant === 'string'
    ? participant
    : (typeof participant?._serialized === 'string' ? participant._serialized : '');
  return participantId ? `${base}_${participantId}` : base;
}

// A whatsapp-web.js entrega `msg.id._serialized` para dentro da pagina em
// Message.downloadMedia() (structures/Message.js: `}, this.id._serialized)`).
// Com o campo renomeado pelo WhatsApp Web esse valor vai undefined, o
// Msg.getMessagesById([undefined]) estoura no IndexedDB e o erro chega
// minificado — era o "r"/"t" em "Erro ao baixar midia". Medido na sessao real
// em 04/set/2026: sem o reparo, 0 de 5 midias recebidas baixavam; com ele, 3
// de 5. Preenche o campo a partir das partes semanticas antes da chamada.
function repairMessageId(msg) {
  const id = msg?.id;
  if (!id || typeof id !== 'object') return false;
  if (typeof id._serialized === 'string' && id._serialized) return false;
  const resolved = serializedMessageId(id);
  if (!resolved) return false;
  try {
    id._serialized = resolved;
    // Modulo CommonJS roda em modo nao-estrito: atribuir em objeto congelado
    // falha em SILENCIO, sem lancar. Confirmar que gravou e o que separa
    // "reparado" de "nao deu" — sem isso a funcao mentia devolvendo true.
    return id._serialized === resolved;
  } catch {
    return false;
  }
}

function getMessageExternalId(msg) {
  return serializedMessageId(msg?.id ?? msg);
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
  serializedMessageId,
  repairMessageId,
  getMessageContent,
  shouldProcessMessageEvent,
  getWhatsAppMediaType,
  hasPotentialMedia
};
