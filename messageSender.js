const { MessageMedia } = require('whatsapp-web.js');
const { getSendChatId, getMessageExternalId, toSqlDate } = require('./whatsappUtils');
const { saveMessageMedia } = require('./mediaStorage');
const { prepareVoiceMediaForSend: defaultPrepareVoiceMediaForSend } = require('./audioTranscoder');
const { sleep, withTimeout } = require('./runtimeUtils');
const { canAccessConversation } = require('./messageQueries');

// Rate limiter POR TENANT: cada número de WhatsApp tem sua própria fila e seu
// próprio intervalo mínimo entre envios. Bloqueios do WhatsApp são por número,
// então uma empresa movimentada não pode atrasar nem encher a fila das outras.
//
// Além do intervalo entre mensagens (MIN_SEND_INTERVAL_MS), há um limite
// MÁXIMO POR HORA (MAX_MESSAGES_PER_HOUR) para evitar bloqueio por excesso.
//
// Circuit breaker: se a fila acumular N falhas CONSECUTIVAS, o circuito abre
// e rejeita novos envios por um período, evitando loop infinito de retentativas
// quando o WhatsApp está offline ou banido.
const CIRCUIT_BREAKER_THRESHOLD = Number(process.env.CIRCUIT_BREAKER_THRESHOLD || 5);
const CIRCUIT_BREAKER_COOLDOWN_MS = Number(process.env.CIRCUIT_BREAKER_COOLDOWN_MS || 30000);
const MAX_OUTBOUND_TEXT_CHARACTERS = 10000;
const MAX_OUTBOUND_TEXT_BYTES = 40000;

const tenantQueues = new Map(); // key -> { queue, processing, retainedBytes, lastSendTime, sendTimestamps, circuitBreaker }
const blockedTenantQueues = new Set();
let queuesClosed = false;
let globalRetainedQueueBytes = 0;
const messageColumnCache = new WeakMap();

function queueKey(tenantId) {
  if (tenantId == null) return 0;
  const normalized = Number(tenantId);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error('Tenant inválido para fila de envio');
  }
  return normalized;
}

function getQueueState(key) {
  let state = tenantQueues.get(key);
  if (!state) {
    state = {
      queue: [],
      processing: false,
      retainedBytes: 0,
      lastSendTime: 0,
      sendTimestamps: [],
      discarded: false,
      circuitBreaker: { consecutiveFailures: 0, openedAt: 0 }
    };
    tenantQueues.set(key, state);
  }
  return state;
}

function isCircuitOpen(state) {
  const cb = state.circuitBreaker;
  if (!cb.openedAt) return false;
  if (Date.now() - cb.openedAt >= CIRCUIT_BREAKER_COOLDOWN_MS) {
    cb.openedAt = 0;
    cb.consecutiveFailures = 0;
    return false;
  }
  return true;
}

function recordCircuitSuccess(state) {
  state.circuitBreaker.consecutiveFailures = 0;
  state.circuitBreaker.openedAt = 0;
}

function recordCircuitFailure(state) {
  state.circuitBreaker.consecutiveFailures += 1;
  if (state.circuitBreaker.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    state.circuitBreaker.openedAt = Date.now();
  }
}

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

function getMaxMessageQueueBytes() {
  return positiveInteger(process.env.MAX_MESSAGE_QUEUE_BYTES, 64 * 1024 * 1024);
}

function getMaxGlobalMessageQueueBytes() {
  return positiveInteger(process.env.MAX_GLOBAL_MESSAGE_QUEUE_BYTES, 256 * 1024 * 1024);
}

function getMaxOutboundMediaBytes() {
  return positiveInteger(process.env.MAX_OUTBOUND_MEDIA_BYTES, 25 * 1024 * 1024);
}

function getMaxMessagesPerHour() {
  return positiveInteger(process.env.MAX_MESSAGES_PER_HOUR, 250);
}

function getOutboundSendTimeoutMs() {
  return positiveInteger(process.env.OUTBOUND_SEND_TIMEOUT_MS, 30000);
}

function checkHourlyRate(state) {
  const now = Date.now();
  const cutoff = now - 3600000;
  state.sendTimestamps = (state.sendTimestamps || []).filter(timestamp => timestamp > cutoff);
  const maximum = getMaxMessagesPerHour();
  if (state.sendTimestamps.length >= maximum) {
    throw new Error(`Limite de ${maximum} mensagens por hora atingido.`);
  }
}

function recordSendAttempt(state) {
  const now = Date.now();
  const cutoff = now - 3600000;
  state.sendTimestamps = (state.sendTimestamps || []).filter(timestamp => timestamp > cutoff);
  state.sendTimestamps.push(now);
}

// Soma de todas as filas (usado por testes e drain no shutdown).
function getMessageQueueLength() {
  let total = 0;
  for (const state of tenantQueues.values()) total += state.queue.length;
  return total;
}

function estimatePayloadQueueBytes(payload) {
  let bytes = 4096;
  bytes += Buffer.byteLength(String(payload?.content || ''), 'utf8');
  if (payload?.media) {
    // O corpo base64 permanece referenciado pela closure enquanto aguarda e
    // costuma ocupar mais heap do que o anexo binário original.
    bytes += Buffer.byteLength(String(payload.media.data || ''), 'utf8');
    bytes += Buffer.byteLength(String(payload.media.filename || ''), 'utf8');
    bytes += Buffer.byteLength(String(payload.media.mimetype || ''), 'utf8');
  }
  return bytes;
}

function ensureQueueCapacity(key, estimatedBytes = 0) {
  const maxQueueSize = getMaxMessageQueueSize();
  const state = getQueueState(key);
  if (state.queue.length >= maxQueueSize) {
    throw new Error(`Fila de envio cheia (${maxQueueSize})`);
  }
  const bytes = positiveInteger(estimatedBytes, 0);
  const tenantByteLimit = getMaxMessageQueueBytes();
  const globalByteLimit = getMaxGlobalMessageQueueBytes();
  if (bytes > tenantByteLimit || state.retainedBytes + bytes > tenantByteLimit) {
    throw new Error('Fila de envio sem memória disponível para este anexo');
  }
  if (bytes > globalByteLimit || globalRetainedQueueBytes + bytes > globalByteLimit) {
    throw new Error('Capacidade global de memória da fila de envio atingida');
  }
}

function assertQueueAccepting(key, estimatedBytes = 0) {
  if (queuesClosed) throw new Error('Fila de envio encerrada para shutdown');
  if (blockedTenantQueues.has(key)) throw new Error('Empresa removida; fila de envio encerrada');
  const state = getQueueState(key);
  if (state.discarded) throw new Error('Fila de envio em encerramento');
  if (isCircuitOpen(state)) {
    throw new Error('Circuito de envio aberto — tente novamente mais tarde');
  }
  ensureQueueCapacity(key, estimatedBytes);
  checkHourlyRate(state);
  return state;
}

function assertQueuePreflight(key, estimatedBytes = 0) {
  if (queuesClosed) throw new Error('Fila de envio encerrada para shutdown');
  const state = getQueueState(key);
  ensureQueueCapacity(key, estimatedBytes);
  checkHourlyRate(state);
}

function assertTenantQueueStillActive(key) {
  const state = tenantQueues.get(key);
  if (blockedTenantQueues.has(key) || state?.discarded) {
    throw new Error('Empresa suspensa ou removida; mensagem não enviada');
  }
}

function retainTaskBytes(state, task) {
  state.retainedBytes += task.estimatedBytes;
  globalRetainedQueueBytes += task.estimatedBytes;
}

function releaseTaskBytes(state, task) {
  if (!task || task.bytesReleased) return;
  task.bytesReleased = true;
  state.retainedBytes = Math.max(0, state.retainedBytes - task.estimatedBytes);
  globalRetainedQueueBytes = Math.max(0, globalRetainedQueueBytes - task.estimatedBytes);
}

function rejectQueuedTask(state, task, error) {
  releaseTaskBytes(state, task);
  task.reject(error);
}

async function processMessageQueue(key) {
  const state = getQueueState(key);
  if (state.processing) return;
  state.processing = true;

  try {
    while (!state.discarded && state.queue.length > 0) {
    // Circuit breaker — se o circuito está aberto, rejeita a fila inteira
    if (isCircuitOpen(state)) {
      while (state.queue.length > 0) {
        const failed = state.queue.shift();
        rejectQueuedTask(state, failed, new Error('Circuito de envio aberto — muitas falhas consecutivas'));
      }
      break;
    }

    const elapsed = Date.now() - state.lastSendTime;
    const minSendIntervalMs = getMinSendIntervalMs();
    if (elapsed < minSendIntervalMs) {
      await sleep(minSendIntervalMs - elapsed);
    }
    if (state.discarded) break;

      try {
        checkHourlyRate(state);
      } catch (err) {
        while (state.queue.length > 0) rejectQueuedTask(state, state.queue.shift(), err);
        break;
      }

      const task = state.queue.shift();
      if (!task) break;
      try {
        const result = await task.sendFn();
        recordCircuitSuccess(state);
        task.resolve(result);
      } catch (err) {
        recordCircuitFailure(state);
        if (['WA_SEND_TIMEOUT', 'WA_SEND_AMBIGUOUS'].includes(err?.code)) {
          state.circuitBreaker.consecutiveFailures = CIRCUIT_BREAKER_THRESHOLD;
          state.circuitBreaker.openedAt = Date.now();
        }
        task.reject(err);
        if (['WA_SEND_TIMEOUT', 'WA_SEND_AMBIGUOUS'].includes(err?.code)) {
          while (state.queue.length > 0) {
            rejectQueuedTask(
              state,
              state.queue.shift(),
              new Error('Fila pausada após resultado ambíguo do WhatsApp')
            );
          }
          break;
        }
      } finally {
        releaseTaskBytes(state, task);
      }
      state.lastSendTime = Date.now();
      recordSendAttempt(state);

      // Jitter pequeno pós-envio para não ficar um padrão exato
      if (state.queue.length > 0) {
        await sleep(Math.round(Math.random() * 500));
      }
    }
  } finally {
    state.processing = false;
    if (state.discarded) tenantQueues.delete(key);
    else if (state.queue.length > 0) {
      // Defesa contra lost wakeups caso uma implementação futura acrescente
      // um await entre a observação da fila vazia e este finally.
      queueMicrotask(() => processMessageQueue(key));
    }
  }
}

function enqueueMessage(key, sendFn, { estimatedBytes = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let state;
    try {
      state = assertQueueAccepting(key, estimatedBytes);
    } catch (err) {
      reject(err);
      return;
    }
    const task = {
      sendFn,
      resolve,
      reject,
      estimatedBytes: positiveInteger(estimatedBytes, 0),
      bytesReleased: false
    };
    retainTaskBytes(state, task);
    state.queue.push(task);
    processMessageQueue(key);
  });
}

function allQueuesIdle() {
  return [...tenantQueues.values()].every(s => !s.processing && s.queue.length === 0);
}

function waitForMessageQueueIdle(timeoutMs = 5000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (allQueuesIdle()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('Timeout aguardando fila de envio esvaziar'));
      setTimeout(check, 50);
    };
    check();
  });
}

async function drainMessageQueues(timeoutMs = 10000, { shutdown = false } = {}) {
  if (shutdown) queuesClosed = true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (allQueuesIdle()) return;
    await sleep(100);
  }
  // Timeout: rejeita o que sobrou para não travar o shutdown
  abortMessageQueues('Shutdown em andamento', { close: shutdown });
}

function abortMessageQueues(reason = 'Fila de envio interrompida', { close = true } = {}) {
  if (close) queuesClosed = true;
  let discarded = 0;
  for (const [key, state] of tenantQueues) {
    state.discarded = true;
    while (state.queue.length > 0) {
      const task = state.queue.shift();
      discarded += 1;
      rejectQueuedTask(state, task, new Error(reason));
    }
    if (!state.processing) tenantQueues.delete(key);
  }
  return discarded;
}

function discardTenantMessageQueue(tenantId, { permanent = true } = {}) {
  const key = queueKey(tenantId);
  if (permanent) blockedTenantQueues.add(key);
  else blockedTenantQueues.delete(key);
  const state = tenantQueues.get(key);
  if (!state) return 0;
  state.discarded = true;
  const discarded = state.queue.length;
  while (state.queue.length > 0) {
    rejectQueuedTask(
      state,
      state.queue.shift(),
      new Error('Empresa removida; fila de envio encerrada')
    );
  }
  if (!state.processing) tenantQueues.delete(key);
  return discarded;
}

function normalizeContent(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeClientRequestId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('client_request_id inválido');
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error('client_request_id inválido');
  }
  return normalized;
}

function messagesHaveColumn(db, column) {
  let columns = messageColumnCache.get(db);
  if (!columns) {
    columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(row => row.name));
    messageColumnCache.set(db, columns);
  }
  return columns.has(column);
}

function findMessageByClientRequestId(db, clientRequestId) {
  if (!clientRequestId) return null;
  return db.prepare('SELECT * FROM messages WHERE client_request_id = ? LIMIT 1')
    .get(clientRequestId) || null;
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
  if (Array.from(content).length > MAX_OUTBOUND_TEXT_CHARACTERS
      || Buffer.byteLength(content, 'utf8') > MAX_OUTBOUND_TEXT_BYTES) {
    throw new Error(`Mensagem excede o limite de ${MAX_OUTBOUND_TEXT_CHARACTERS} caracteres`);
  }
  if (media) {
    if (!media.mimetype || !media.data) {
      throw new Error('Anexo inválido');
    }
    // O tamanho declarado vem do navegador e não é confiável. Sempre limite o
    // buffer real para impedir anexos grandes disfarçados com `size` pequeno.
    const mediaSize = Buffer.byteLength(normalizeBase64(media.data), 'base64');
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

function getQuotedMessageForSend(db, { quotedMessageId, conversation, user }) {
  const id = positiveInteger(quotedMessageId, null);
  if (!id) throw new Error('Mensagem citada inválida');

  const quoted = db.prepare(`
    SELECT m.id,
           m.external_id,
           m.conversation_id,
           c.assigned_to,
           c.sector_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = ?
  `).get(id);

  if (!quoted
      || Number(quoted.conversation_id) !== Number(conversation?.id)
      || !canAccessConversation(user, quoted)) {
    throw new Error('Mensagem citada não pertence a esta conversa');
  }

  return quoted;
}

function insertPendingMessage(db, {
  conversationId,
  content,
  vendorId,
  quotedMessageId,
  clientRequestId,
  hasClientRequestIdColumn
}) {
  try {
    const result = hasClientRequestIdColumn
      ? db.prepare(`
          INSERT INTO messages (
            conversation_id,
            from_type,
            content,
            vendor_id,
            vendor_sector_id,
            delivery_status,
            quoted_message_id,
            client_request_id
          )
          VALUES (?, 'vendor', ?, ?, (SELECT sector_id FROM vendors WHERE id = ?), 'pending', ?, ?)
        `).run(conversationId, content, vendorId, vendorId, quotedMessageId || null, clientRequestId)
      : db.prepare(`
          INSERT INTO messages (
            conversation_id,
            from_type,
            content,
            vendor_id,
            vendor_sector_id,
            delivery_status,
            quoted_message_id
          )
          VALUES (?, 'vendor', ?, ?, (SELECT sector_id FROM vendors WHERE id = ?), 'pending', ?)
        `).run(conversationId, content, vendorId, vendorId, quotedMessageId || null);
    return { messageId: result.lastInsertRowid, reused: false };
  } catch (err) {
    // Em mais de um processo, duas requisições iguais podem passar pela leitura
    // inicial ao mesmo tempo. O índice único da migração decide o vencedor.
    if (hasClientRequestIdColumn && clientRequestId && String(err?.code || '').startsWith('SQLITE_CONSTRAINT')) {
      const existing = findMessageByClientRequestId(db, clientRequestId);
      if (existing) return { messageId: existing.id, reused: true };
    }
    throw err;
  }
}

function updateMessageMedia(db, messageId, mediaFields) {
  db.prepare(`
    UPDATE messages
    SET media_type = ?,
        media_mimetype = ?,
        media_filename = ?,
        media_url = ?,
        media_size = ?,
        media_sha256 = ?
    WHERE id = ?
  `).run(
    mediaFields.media_type || null,
    mediaFields.media_mimetype || null,
    mediaFields.media_filename || null,
    mediaFields.media_url || null,
    mediaFields.media_size || null,
    mediaFields.media_sha256 || null,
    messageId
  );
}

function deliveryStatusRank(status) {
  return { sent: 1, delivered: 2, read: 3 }[status] || 0;
}

function strongestSentStatus(...statuses) {
  return statuses.reduce((strongest, status) => (
    deliveryStatusRank(status) > deliveryStatusRank(strongest) ? status : strongest
  ), 'sent');
}

function mergeEchoIntoPending(db, pendingMessage, echoMessage) {
  if (!echoMessage || echoMessage.id === pendingMessage.id) return;
  if (Number(echoMessage.conversation_id) !== Number(pendingMessage.conversation_id)) {
    throw new Error('external_id retornado pelo WhatsApp pertence a outra conversa');
  }

  // O `message_create` pode persistir o eco antes de sendMessage() resolver.
  // Preserve o id local/outbox e migre referências que a UI possa ter criado no
  // curto intervalo entre o evento de socket e esta reconciliação.
  db.prepare(`
    UPDATE messages
    SET quoted_message_id = ?
    WHERE quoted_message_id = ?
      AND id != ?
  `).run(pendingMessage.id, echoMessage.id, pendingMessage.id);
  db.prepare(`
    UPDATE messages
    SET quoted_message_id = NULL
    WHERE id = ?
      AND quoted_message_id = ?
  `).run(pendingMessage.id, echoMessage.id);
  db.prepare(`
    UPDATE conversation_user_state
    SET last_read_message_id = ?
    WHERE last_read_message_id = ?
  `).run(pendingMessage.id, echoMessage.id);
  db.prepare(`
    INSERT OR IGNORE INTO message_stars (message_id, user_role, user_id, created_at)
    SELECT ?, user_role, user_id, created_at
    FROM message_stars
    WHERE message_id = ?
  `).run(pendingMessage.id, echoMessage.id);
  db.prepare('DELETE FROM message_stars WHERE message_id = ?').run(echoMessage.id);
  db.prepare(`
    INSERT OR IGNORE INTO message_user_state (
      message_id, user_role, user_id, pinned_at, hidden_at
    )
    SELECT ?, user_role, user_id, pinned_at, hidden_at
    FROM message_user_state
    WHERE message_id = ?
  `).run(pendingMessage.id, echoMessage.id);
  db.prepare(`
    UPDATE message_user_state
    SET pinned_at = COALESCE(pinned_at, (
          SELECT echo.pinned_at
          FROM message_user_state echo
          WHERE echo.message_id = ?
            AND echo.user_role = message_user_state.user_role
            AND echo.user_id = message_user_state.user_id
        )),
        hidden_at = COALESCE(hidden_at, (
          SELECT echo.hidden_at
          FROM message_user_state echo
          WHERE echo.message_id = ?
            AND echo.user_role = message_user_state.user_role
            AND echo.user_id = message_user_state.user_id
        ))
    WHERE message_id = ?
  `).run(echoMessage.id, echoMessage.id, pendingMessage.id);
  db.prepare('DELETE FROM message_user_state WHERE message_id = ?').run(echoMessage.id);

  const echoContent = normalizeContent(echoMessage.content);
  const usefulEchoContent = echoContent && echoContent !== '(mídia)' ? echoContent : null;
  db.prepare(`
    UPDATE messages
    SET content = CASE
          WHEN (content IS NULL OR content = '' OR content = '(mídia)') AND ? IS NOT NULL THEN ?
          ELSE content
        END,
        media_type = COALESCE(media_type, ?),
        media_mimetype = COALESCE(media_mimetype, ?),
        media_filename = COALESCE(media_filename, ?),
        media_url = COALESCE(media_url, ?),
        media_size = COALESCE(media_size, ?),
        media_sha256 = COALESCE(media_sha256, ?),
        quoted_message_id = COALESCE(quoted_message_id, ?),
        participant_id = COALESCE(participant_id, ?),
        participant_phone = COALESCE(participant_phone, ?),
        participant_name = COALESCE(participant_name, ?),
        starred = CASE WHEN COALESCE(starred, 0) = 1 OR COALESCE(?, 0) = 1 THEN 1 ELSE 0 END,
        starred_at = COALESCE(starred_at, ?),
        starred_by = COALESCE(starred_by, ?),
        starred_by_role = COALESCE(starred_by_role, ?)
    WHERE id = ?
  `).run(
    usefulEchoContent,
    usefulEchoContent,
    echoMessage.media_type || null,
    echoMessage.media_mimetype || null,
    echoMessage.media_filename || null,
    echoMessage.media_url || null,
    echoMessage.media_size || null,
    echoMessage.media_sha256 || null,
    echoMessage.quoted_message_id || null,
    echoMessage.participant_id || null,
    echoMessage.participant_phone || null,
    echoMessage.participant_name || null,
    echoMessage.starred || 0,
    echoMessage.starred_at || null,
    echoMessage.starred_by || null,
    echoMessage.starred_by_role || null,
    pendingMessage.id
  );
  db.prepare('DELETE FROM messages WHERE id = ?').run(echoMessage.id);
}

function markMessageSent(db, messageId, sentMessage) {
  const externalId = getMessageExternalId(sentMessage);
  const sentAt = sentMessage?.timestamp ? toSqlDate(sentMessage.timestamp) : toSqlDate(Date.now() / 1000);
  db.transaction(() => {
    const pendingMessage = getMessageById(db, messageId);
    if (!pendingMessage) throw new Error('Mensagem pendente não encontrada');
    const echoMessage = externalId
      ? db.prepare('SELECT * FROM messages WHERE external_id = ? LIMIT 1').get(externalId)
      : null;
    mergeEchoIntoPending(db, pendingMessage, echoMessage);
    const deliveryStatus = strongestSentStatus(
      pendingMessage.delivery_status,
      echoMessage?.delivery_status
    );
    db.prepare(`
      UPDATE messages
      SET external_id = COALESCE(?, external_id),
          delivery_status = ?,
          delivery_error = NULL,
          sent_at = ?,
          created_at = ?
      WHERE id = ?
    `).run(externalId, deliveryStatus, sentAt, sentAt, messageId);
  })();
  return sentAt;
}

function markMessageFailed(db, messageId, err) {
  db.prepare(`
    UPDATE messages
    SET delivery_status = 'failed',
        delivery_error = ?
    WHERE id = ?
  `).run(err.message || String(err), messageId);
}

function markMessageUncertain(db, messageId, err) {
  db.prepare(`
    UPDATE messages
    SET delivery_status = 'unknown',
        delivery_error = ?
    WHERE id = ?
  `).run(`Envio sem confirmação do WhatsApp: ${err.message || String(err)}`, messageId);
}

function recoverInterruptedOutboundMessages(db, { staleMinutes = 2 } = {}) {
  const parsedMinutes = Number(staleMinutes);
  const minutes = Number.isSafeInteger(parsedMinutes) && parsedMinutes >= 0 ? parsedMinutes : 2;
  return db.prepare(`
    UPDATE messages
    SET delivery_status = 'unknown',
        delivery_error = 'Processo interrompido antes da confirmação do WhatsApp'
    WHERE from_type = 'vendor'
      AND delivery_status = 'pending'
      AND external_id IS NULL
      AND created_at <= datetime('now', ?)
  `).run(`-${minutes} minutes`).changes;
}

function getVendorDisplayName(db, user) {
  if (user?.role !== 'vendor') return '';
  const tokenName = normalizeContent(user.name);
  if (tokenName) return tokenName;
  const row = db.prepare('SELECT name FROM vendors WHERE id = ?').get(user.id);
  return normalizeContent(row?.name);
}

function outboundAuthorizationError(message = 'A autorização para enviar esta mensagem foi revogada') {
  const error = new Error(message);
  error.code = 'OUTBOUND_AUTHORIZATION_REVOKED';
  error.statusCode = 403;
  return error;
}

// Uma requisição pode permanecer alguns segundos na fila do número enquanto
// outra mensagem termina. Nesse intervalo o administrador pode desativar o
// vendedor ou transferir a conversa para outro setor. A autorização conferida
// pela rota não é um passe permanente: identidades JWT reais sempre carregam
// token_version, então revalidamos usuário e conversa no banco imediatamente
// antes de preparar/enviar cada item da outbox.
//
// Chamadores internos/testes legados sem token_version continuam suportados;
// eles não representam uma sessão autenticada emitida pelo servidor.
function assertCurrentOutboundAuthorization(db, user, conversationId, requiredConversationIds = []) {
  if (!user || !Object.hasOwn(user, 'token_version')) return;

  let effectiveUser = user;
  if (user.role === 'vendor') {
    const vendor = db.prepare(`
      SELECT v.id, v.sector_id, v.token_version
      FROM vendors v
      JOIN sectors s ON s.id = v.sector_id AND s.active = 1
      WHERE v.id = ? AND v.active = 1
    `).get(user.id);
    if (!vendor || Number(vendor.token_version || 0) !== Number(user.token_version || 0)) {
      throw outboundAuthorizationError('Seu acesso foi alterado antes do envio; a mensagem não foi enviada');
    }
    effectiveUser = { ...user, sector_id: vendor.sector_id };
  } else if (user.role === 'admin') {
    const admin = db.prepare('SELECT token_version FROM admins WHERE id = ?').get(user.id);
    if (!admin || Number(admin.token_version || 0) !== Number(user.token_version || 0)) {
      throw outboundAuthorizationError('Sua sessão foi alterada antes do envio; a mensagem não foi enviada');
    }
  } else {
    throw outboundAuthorizationError();
  }

  if (!Array.isArray(requiredConversationIds)) throw outboundAuthorizationError();
  const rawConversationIds = [conversationId, ...requiredConversationIds].map(Number);
  if (rawConversationIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw outboundAuthorizationError();
  }
  const conversationIds = [...new Set(rawConversationIds)];
  for (const id of conversationIds) {
    const currentConversation = db.prepare(`
      SELECT id, assigned_to, sector_id
      FROM conversations
      WHERE id = ?
    `).get(id);
    if (!currentConversation || !canAccessConversation(effectiveUser, currentConversation)) {
      throw outboundAuthorizationError('Uma conversa envolvida foi transferida antes do envio; a mensagem não foi enviada');
    }
  }
}

function buildWhatsAppContent(content, vendorName) {
  if (!content || !vendorName) return content;
  const normalizedName = Array.from(String(vendorName).trim()).slice(0, 64).join('');
  if (!normalizedName) return content;
  const label = /^vendedor\b/i.test(normalizedName) ? normalizedName : `Vendedor ${normalizedName}`;
  return `${label}:\n${content}`;
}

function buildSendOptions(payload, content, mediaFields) {
  const options = {};
  if (mediaFields) options.waitUntilMsgSent = false;
  if (content && mediaFields) options.caption = content;
  if (payload?.sendAsVoice) options.sendAudioAsVoice = true;
  if (payload?.sendAsSticker) {
    options.sendMediaAsSticker = true;
    if (payload.stickerName) options.stickerName = String(payload.stickerName).slice(0, 64);
    if (payload.stickerAuthor) options.stickerAuthor = String(payload.stickerAuthor).slice(0, 64);
  }
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

async function sendOutboundMessage({
  db,
  whatsappClient,
  conversation,
  user,
  payload,
  mediaRoot,
  prepareVoiceMediaForSend = defaultPrepareVoiceMediaForSend,
  sendTimeoutMs = getOutboundSendTimeoutMs(),
  requiredConversationIds = [],
  MessageMediaCtor = MessageMedia
}) {
  const clientRequestId = normalizeClientRequestId(payload?.client_request_id);
  const hasClientRequestIdColumn = Boolean(clientRequestId)
    && messagesHaveColumn(db, 'client_request_id');
  if (hasClientRequestIdColumn) {
    const existing = findMessageByClientRequestId(db, clientRequestId);
    if (existing) {
      if (Number(existing.conversation_id) !== Number(conversation.id)) {
        throw new Error('client_request_id já utilizado em outra conversa');
      }
      return existing;
    }
  }

  const { content, media } = validatePayload(payload);
  const tenantKey = queueKey(user?.tenant_id);
  const estimatedQueueBytes = estimatePayloadQueueBytes({ content, media });
  // Faça todas as recusas determinísticas antes de criar a linha durável. Se
  // houver crash depois da inserção, o boot marca o pending como unknown — ele
  // nunca fica silenciosamente preso fora da fila.
  assertQueuePreflight(tenantKey, estimatedQueueBytes);
  const vendorId = user?.role === 'vendor' ? user.id : null;

  let quotedMessageId = null;
  let quotedMessageExternalId = null;
  const hasQuotedMessageId = payload?.quoted_message_id !== undefined
    && payload?.quoted_message_id !== null
    && payload?.quoted_message_id !== '';
  if (hasQuotedMessageId) {
    const quoted = getQuotedMessageForSend(db, {
      quotedMessageId: payload.quoted_message_id,
      conversation,
      user
    });
    quotedMessageId = quoted.id;
    quotedMessageExternalId = quoted.external_id;
  }

  const pendingInsert = insertPendingMessage(db, {
    conversationId: conversation.id,
    content,
    vendorId,
    quotedMessageId,
    clientRequestId,
    hasClientRequestIdColumn
  });
  const messageId = pendingInsert.messageId;
  if (pendingInsert.reused) {
    const existing = getMessageById(db, messageId);
    if (Number(existing?.conversation_id) !== Number(conversation.id)) {
      throw new Error('client_request_id já utilizado em outra conversa');
    }
    return existing;
  }
  let activityAt = getMessageById(db, messageId)?.created_at || toSqlDate(Date.now() / 1000);

  let mediaFields = null;
  const whatsAppContent = buildWhatsAppContent(content, getVendorDisplayName(db, user));
  let sendContent = whatsAppContent;

  try {
    // Toda a preparação entra na mesma fila do envio. Assim um texto posterior
    // não ultrapassa um áudio ainda sendo convertido, preservando a ordem em que
    // os atendentes acionaram o envio para este número de WhatsApp.
    const sentMessage = await enqueueMessage(tenantKey, async () => {
      assertTenantQueueStillActive(tenantKey);
      assertCurrentOutboundAuthorization(db, user, conversation.id, requiredConversationIds);
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
          namespace: user?.tenant_id,
          media: normalizedMedia,
          messageType: payload?.sendAsSticker ? 'sticker' : (media.messageType || ''),
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

      // Conversão de áudio, antivírus e persistência de mídia são assíncronos.
      // Revalide de novo para não enviar caso a permissão mude durante essa
      // preparação, especialmente em anexos grandes.
      assertTenantQueueStillActive(tenantKey);
      assertCurrentOutboundAuthorization(db, user, conversation.id, requiredConversationIds);

      if (!whatsappClient?.info?.wid || typeof whatsappClient.sendMessage !== 'function') {
        throw new Error('WhatsApp ainda não está conectado');
      }

      const sendOptions = media
        ? buildSendOptions({ ...payload, quotedMessageId: quotedMessageExternalId }, whatsAppContent, mediaFields)
        : { ...(quotedMessageExternalId ? { quotedMessageId: quotedMessageExternalId } : {}) };

      // `sendMessage()` não oferece chave idempotente. Erros de frame/contexto
      // e timeout podem acontecer depois que o Chromium já entregou o comando
      // ao WhatsApp; repetir automaticamente até mesmo texto pode criar uma
      // segunda mensagem real. Faça uma única tentativa e exponha o resultado
      // como ambíguo para reconciliação pelo eco/histórico.
      try {
        return await withTimeout(
          () => whatsappClient.sendMessage(
            getSendChatId(conversation.phone),
            sendContent,
            sendOptions
          ),
          sendTimeoutMs,
          'Envio WhatsApp'
        );
      } catch (err) {
        if (/^Envio WhatsApp excedeu /.test(String(err?.message || ''))) {
          err.code = 'WA_SEND_TIMEOUT';
        } else if (isTransientWhatsAppSendError(err)) {
          err.code = 'WA_SEND_AMBIGUOUS';
        }
        throw err;
      }
    }, { estimatedBytes: estimatedQueueBytes });
    activityAt = markMessageSent(db, messageId, sentMessage);
  } catch (err) {
    if (['WA_SEND_TIMEOUT', 'WA_SEND_AMBIGUOUS'].includes(err?.code)) {
      markMessageUncertain(db, messageId, err);
    } else {
      markMessageFailed(db, messageId, err);
    }
  }

  db.prepare(`
    UPDATE conversations
    SET last_activity_at = CASE
          WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ?
          ELSE last_activity_at
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(activityAt, activityAt, conversation.id);
  return getMessageById(db, messageId);
}

module.exports = {
  estimatePayloadQueueBytes,
  getMaxGlobalMessageQueueBytes,
  getMaxMessageQueueBytes,
  getMaxOutboundMediaBytes,
  getMessageQueueLength,
  waitForMessageQueueIdle,
  drainMessageQueues,
  abortMessageQueues,
  discardTenantMessageQueue,
  recoverInterruptedOutboundMessages,
  sendOutboundMessage
};
