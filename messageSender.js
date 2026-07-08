const { MessageMedia } = require('whatsapp-web.js');
const { getSendChatId, getMessageExternalId, toSqlDate } = require('./whatsappUtils');
const { saveMessageMedia } = require('./mediaStorage');
const { prepareVoiceMediaForSend: defaultPrepareVoiceMediaForSend } = require('./audioTranscoder');
const { sleep } = require('./runtimeUtils');

// Rate limiter: garante um intervalo mínimo entre envios para evitar bloqueio do WhatsApp
const messageQueue = [];
let processingQueue = false;
let lastSendTime = 0;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function getMinSendIntervalMs() {
  return positiveInteger(process.env.MIN_SEND_INTERVAL_MS, 3000);
}

function getMaxMessageQueueSize() {
  return positiveInteger(process.env.MAX_MESSAGE_QUEUE_SIZE, 500);
}

function getMaxOutboundMediaBytes() {
  return positiveInteger(process.env.MAX_OUTBOUND_MEDIA_BYTES, 25 * 1024 * 1024);
}

function getMessageQueueLength() {
  return messageQueue.length;
}

function ensureQueueCapacity() {
  const maxQueueSize = getMaxMessageQueueSize();
  if (messageQueue.length >= maxQueueSize) {
    throw new Error(`Fila de envio cheia (${maxQueueSize})`);
  }
}

async function processMessageQueue() {
  if (processingQueue) return;
  processingQueue = true;

  while (messageQueue.length > 0) {
    const elapsed = Date.now() - lastSendTime;
    const minSendIntervalMs = getMinSendIntervalMs();
    if (elapsed < minSendIntervalMs) {
      await sleep(minSendIntervalMs - elapsed);
    }

    const task = messageQueue.shift();
    try {
      const result = await task.sendFn();
      task.resolve(result);
    } catch (err) {
      task.reject(err);
    }
    lastSendTime = Date.now();

    // Jitter pequeno pós-envio para não ficar um padrão exato
    if (messageQueue.length > 0) {
      await sleep(Math.round(Math.random() * 500));
    }
  }

  processingQueue = false;
}

function enqueueMessage(sendFn) {
  return new Promise((resolve, reject) => {
    try {
      ensureQueueCapacity();
    } catch (err) {
      reject(err);
      return;
    }
    messageQueue.push({ sendFn, resolve, reject });
    processMessageQueue();
  });
}

function waitForMessageQueueIdle(timeoutMs = 5000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!processingQueue && messageQueue.length === 0) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('Timeout aguardando fila de envio esvaziar'));
      setTimeout(check, 50);
    };
    check();
  });
}

function normalizeContent(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBase64(data) {
  const value = String(data || '');
  const match = value.match(/^data:[^;]+;base64,(.+)$/);
  return match ? match[1] : value;
}

function validatePayload(payload) {
  const content = normalizeContent(payload?.content);
  const media = payload?.media || null;
  if (!content && !media) {
    throw new Error('Mensagem ou anexo obrigatório');
  }
  if (media) {
    if (!media.mimetype || !media.data) {
      throw new Error('Anexo inválido');
    }
    const mediaSize = positiveInteger(media.size, Buffer.byteLength(normalizeBase64(media.data), 'base64'));
    const maxMediaSize = getMaxOutboundMediaBytes();
    if (mediaSize > maxMediaSize) {
      throw new Error(`Anexo excede o limite de ${maxMediaSize} bytes`);
    }
  }
  return { content, media };
}

function getMessageById(db, id) {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

function insertPendingMessage(db, { conversationId, content, vendorId, quotedMessageId }) {
  const result = db.prepare(`
    INSERT INTO messages (
      conversation_id,
      from_type,
      content,
      vendor_id,
      delivery_status,
      quoted_message_id
    )
    VALUES (?, 'vendor', ?, ?, 'pending', ?)
  `).run(conversationId, content, vendorId, quotedMessageId || null);
  return result.lastInsertRowid;
}

function updateMessageMedia(db, messageId, mediaFields) {
  db.prepare(`
    UPDATE messages
    SET media_type = ?,
        media_mimetype = ?,
        media_filename = ?,
        media_url = ?,
        media_size = ?
    WHERE id = ?
  `).run(
    mediaFields.media_type || null,
    mediaFields.media_mimetype || null,
    mediaFields.media_filename || null,
    mediaFields.media_url || null,
    mediaFields.media_size || null,
    messageId
  );
}

function markMessageSent(db, messageId, sentMessage) {
  const externalId = getMessageExternalId(sentMessage);
  const sentAt = sentMessage?.timestamp ? toSqlDate(sentMessage.timestamp) : toSqlDate(Date.now() / 1000);
  db.prepare(`
    UPDATE messages
    SET external_id = COALESCE(?, external_id),
        delivery_status = 'sent',
        delivery_error = NULL,
        sent_at = ?
    WHERE id = ?
  `).run(externalId, sentAt, messageId);
}

function markMessageFailed(db, messageId, err) {
  db.prepare(`
    UPDATE messages
    SET delivery_status = 'failed',
        delivery_error = ?
    WHERE id = ?
  `).run(err.message || String(err), messageId);
}

function getVendorDisplayName(db, user) {
  if (user?.role !== 'vendor') return '';
  const tokenName = normalizeContent(user.name);
  if (tokenName) return tokenName;
  const row = db.prepare('SELECT name FROM vendors WHERE id = ?').get(user.id);
  return normalizeContent(row?.name);
}

function buildWhatsAppContent(content, vendorName) {
  if (!content || !vendorName) return content;
  const label = /^vendedor\b/i.test(vendorName) ? vendorName : `Vendedor ${vendorName}`;
  return `${label}:\n${content}`;
}

function buildSendOptions(payload, content, mediaFields) {
  const options = { waitUntilMsgSent: !mediaFields };
  if (content && mediaFields) options.caption = content;
  if (payload?.sendAsVoice) options.sendAudioAsVoice = true;
  if (payload?.sendAsDocument || mediaFields?.media_type === 'document') options.sendMediaAsDocument = true;
  if (payload?.sendAsHd) options.sendMediaAsHd = true;
  if (payload?.sendVideoAsGif) options.sendVideoAsGif = true;
  if (payload?.quotedMessageId) options.quotedMessageId = payload.quotedMessageId;
  return options;
}

function isTransientWhatsAppSendError(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return [
    'detached frame',
    'execution context was destroyed',
    'cannot find context with specified id',
    'target closed',
    'frame got detached'
  ].some(fragment => message.includes(fragment));
}

async function sendWithTransientRetry(sendFn, { maxAttempts = 2, retryDelayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await sendFn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isTransientWhatsAppSendError(err)) {
        throw err;
      }
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
  throw lastError;
}

async function sendOutboundMessage({
  db,
  whatsappClient,
  conversation,
  user,
  payload,
  mediaRoot,
  prepareVoiceMediaForSend = defaultPrepareVoiceMediaForSend,
  sendRetryDelayMs,
  sendMaxAttempts,
  MessageMediaCtor = MessageMedia
}) {
  const { content, media } = validatePayload(payload);
  ensureQueueCapacity();
  const vendorId = user?.role === 'vendor' ? user.id : null;

  let quotedMessageId = null;
  let quotedMessageExternalId = null;
  if (payload?.quoted_message_id) {
    const quoted = db.prepare('SELECT id, external_id FROM messages WHERE id = ?').get(payload.quoted_message_id);
    if (quoted) {
      quotedMessageId = quoted.id;
      quotedMessageExternalId = quoted.external_id;
    } else {
      logger.warn({ quotedMessageId: payload.quoted_message_id }, 'Mensagem citada não encontrada no DB — enviando sem quote');
    }
  }

  const messageId = insertPendingMessage(db, {
    conversationId: conversation.id,
    content,
    vendorId,
    quotedMessageId
  });

  let mediaFields = null;
  const whatsAppContent = buildWhatsAppContent(content, getVendorDisplayName(db, user));
  let sendContent = whatsAppContent;

  try {
    if (media) {
      let normalizedMedia = {
        mimetype: media.mimetype,
        filename: media.filename || null,
        data: normalizeBase64(media.data),
        size: media.size || null
      };
      if (payload?.sendAsVoice) {
        normalizedMedia = await prepareVoiceMediaForSend(normalizedMedia, { mediaRoot });
      }
      mediaFields = await saveMessageMedia({
        messageId: `out-${messageId}`,
        media: normalizedMedia,
        messageType: media.messageType || '',
        mediaRoot,
        publicBasePath: '/media'
      });
      updateMessageMedia(db, messageId, mediaFields);
      sendContent = new MessageMediaCtor(
        normalizedMedia.mimetype,
        normalizedMedia.data,
        normalizedMedia.filename,
        normalizedMedia.size || media.size || null
      );
    }

    if (!whatsappClient?.info?.wid || typeof whatsappClient.sendMessage !== 'function') {
      throw new Error('WhatsApp ainda não está conectado');
    }

    const sendOptions = media
      ? buildSendOptions({ ...payload, quotedMessageId: quotedMessageExternalId }, whatsAppContent, mediaFields)
      : { waitUntilMsgSent: true, ...(quotedMessageExternalId ? { quotedMessageId: quotedMessageExternalId } : {}) };

    // Envia via fila com rate limiting para evitar bloqueio
    const sentMessage = await enqueueMessage(() =>
      sendWithTransientRetry(
        () => whatsappClient.sendMessage(
          getSendChatId(conversation.phone),
          sendContent,
          sendOptions
        ),
        {
          maxAttempts: sendMaxAttempts,
          retryDelayMs: sendRetryDelayMs
        }
      )
    );
    markMessageSent(db, messageId, sentMessage);
  } catch (err) {
    markMessageFailed(db, messageId, err);
  }

  db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversation.id);
  return getMessageById(db, messageId);
}

module.exports = {
  getMessageQueueLength,
  waitForMessageQueueIdle,
  sendOutboundMessage
};
