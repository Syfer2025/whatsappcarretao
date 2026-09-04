const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureSchema } = require('./schema');
const {
  discardTenantMessageQueue,
  getMessageQueueLength,
  recoverInterruptedOutboundMessages,
  sendOutboundMessage,
  waitForMessageQueueIdle
} = require('./messageSender');

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString('base64');
const OGG_BASE64 = Buffer.from('OggSvalid-audio').toString('base64');
const WEBM_BASE64 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]).toString('base64');
const WEBP_BASE64 = Buffer.from('RIFFxxxxWEBP', 'ascii').toString('base64');

function createDb() {
  const db = new Database(':memory:');
  ensureSchema(db);
  return db;
}

// Recurso pedido em 04/set/2026: enviar a localizacao atual do atendente.
test('localizacao e um tipo valido de mensagem e a coordenada e validada', () => {
  const { normalizeLocationPayload, locationHistoryText } = require('./messageSender');

  const ok = normalizeLocationPayload({ latitude: '-23.5505', longitude: '-46.6333', description: '  Loja  ' });
  assert.equal(ok.latitude, -23.5505);
  assert.equal(ok.longitude, -46.6333);
  assert.equal(ok.description, 'Loja', 'descricao deve vir aparada');

  assert.equal(normalizeLocationPayload(null), null, 'ausencia nao e erro: a maioria das mensagens nao tem local');

  // Coordenada invalida barrada no servidor, nao so no navegador: o WhatsApp
  // recusaria a mensagem inteira e o atendente veria falha sem motivo.
  assert.throws(() => normalizeLocationPayload({ latitude: 91, longitude: 0 }), /latitude fora da faixa/);
  assert.throws(() => normalizeLocationPayload({ latitude: -91, longitude: 0 }), /latitude fora da faixa/);
  assert.throws(() => normalizeLocationPayload({ latitude: 0, longitude: 181 }), /longitude fora da faixa/);
  assert.throws(() => normalizeLocationPayload({ latitude: 'norte', longitude: 0 }), /precisam ser numeros/);

  // O historico precisa de texto legivel: o WhatsApp entrega localizacao como
  // tipo proprio e a conversa apareceria em branco.
  const texto = locationHistoryText({ latitude: -23.5505, longitude: -46.6333, description: '' });
  assert.match(texto, /^Localizacao: https:\/\/www\.google\.com\/maps/);
  assert.match(texto, /-23\.550500,-46\.633300/);
  assert.match(
    locationHistoryText({ latitude: 1, longitude: 2, description: 'Deposito' }),
    /^Localizacao: Deposito - https/
  );
});

test('sends text with emojis and marks message as sent', async () => {
  const db = createDb();
  db.prepare("INSERT INTO vendors (id, name, username, password) VALUES (7, 'Vendedor', 'vend', 'hash')")
    .run();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511999999999@c.us', 'Cliente');
  const conversation = db.prepare('SELECT * FROM conversations').get();

  const sent = [];
  const result = await sendOutboundMessage({
    db,
    whatsappClient: {
      info: { wid: 'bot@c.us' },
      sendMessage: async (chatId, content, options) => {
        sent.push({ chatId, content, options });
        return { id: { _serialized: 'outbound-1' }, timestamp: 1700000100 };
      }
    },
    conversation,
    user: { id: 7, role: 'vendor' },
    payload: { content: 'Oi 😀' },
    mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-text-'))
  });

  assert.equal(sent[0].chatId, '5511999999999@c.us');
  assert.equal(sent[0].content, 'Vendedor:\nOi 😀');
  assert.equal(result.delivery_status, 'sent');
  assert.equal(result.external_id, 'outbound-1');
  assert.equal(result.vendor_id, 7);

  db.close();
});

test('bounds retained outbound queue memory per tenant before creating another outbox row', async (t) => {
  const previousTenantLimit = process.env.MAX_MESSAGE_QUEUE_BYTES;
  const previousGlobalLimit = process.env.MAX_GLOBAL_MESSAGE_QUEUE_BYTES;
  const previousInterval = process.env.MIN_SEND_INTERVAL_MS;
  process.env.MAX_MESSAGE_QUEUE_BYTES = '5000';
  process.env.MAX_GLOBAL_MESSAGE_QUEUE_BYTES = '10000';
  process.env.MIN_SEND_INTERVAL_MS = '1';
  t.after(() => {
    if (previousTenantLimit === undefined) delete process.env.MAX_MESSAGE_QUEUE_BYTES;
    else process.env.MAX_MESSAGE_QUEUE_BYTES = previousTenantLimit;
    if (previousGlobalLimit === undefined) delete process.env.MAX_GLOBAL_MESSAGE_QUEUE_BYTES;
    else process.env.MAX_GLOBAL_MESSAGE_QUEUE_BYTES = previousGlobalLimit;
    if (previousInterval === undefined) delete process.env.MIN_SEND_INTERVAL_MS;
    else process.env.MIN_SEND_INTERVAL_MS = previousInterval;
  });

  const db = createDb();
  t.after(() => db.close());
  db.prepare("INSERT INTO conversations (id, phone, contact_name, status) VALUES (1, 'queue@c.us', 'Fila', 'active')")
    .run();
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = 1').get();
  let releaseFirstSend;
  const firstSendStarted = new Promise(resolve => {
    releaseFirstSend = resolve;
  });
  let markFirstSendStarted;
  const firstSendEntered = new Promise(resolve => {
    markFirstSendStarted = resolve;
  });
  const whatsappClient = {
    info: { wid: 'bot@c.us' },
    sendMessage: async () => {
      markFirstSendStarted();
      await firstSendStarted;
      return { id: { _serialized: 'bounded-queue-1' }, timestamp: 1700000100 };
    }
  };

  const first = sendOutboundMessage({
    db,
    whatsappClient,
    conversation,
    user: { id: 1, role: 'admin', tenant_id: 88001 },
    payload: { content: 'primeira', client_request_id: 'bounded-queue-first' },
    mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-bounded-queue-'))
  });
  await firstSendEntered;

  await assert.rejects(
    sendOutboundMessage({
      db,
      whatsappClient,
      conversation,
      user: { id: 1, role: 'admin', tenant_id: 88001 },
      payload: { content: 'segunda', client_request_id: 'bounded-queue-second' },
      mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-bounded-queue-'))
    }),
    /sem memória disponível/
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM messages WHERE client_request_id = 'bounded-queue-second'").get().count,
    0
  );

  releaseFirstSend();
  assert.equal((await first).delivery_status, 'sent');
});

test('revalida a autorização ao sair da fila e não envia após transferência de setor', async (t) => {
  const previousInterval = process.env.MIN_SEND_INTERVAL_MS;
  process.env.MIN_SEND_INTERVAL_MS = '1';
  t.after(() => {
    if (previousInterval === undefined) delete process.env.MIN_SEND_INTERVAL_MS;
    else process.env.MIN_SEND_INTERVAL_MS = previousInterval;
  });

  const db = createDb();
  t.after(() => db.close());
  db.exec(`
    INSERT INTO sectors (id, name, active) VALUES
      (1, 'Vendas', 1),
      (2, 'Suporte', 1);
    INSERT INTO vendors (
      id, name, username, password, sector_id, active, token_version
    ) VALUES (7, 'Vendedor', 'vend-fila', 'hash', 1, 1, 0);
    INSERT INTO conversations (id, phone, contact_name, sector_id, status) VALUES
      (1, 'primeira@c.us', 'Primeira', 1, 'active'),
      (2, 'transferida@c.us', 'Transferida', 1, 'active');
  `);
  const firstConversation = db.prepare('SELECT * FROM conversations WHERE id = 1').get();
  const transferredConversation = db.prepare('SELECT * FROM conversations WHERE id = 2').get();
  const user = {
    id: 7,
    role: 'vendor',
    sector_id: 1,
    tenant_id: 771337,
    token_version: 0
  };

  let releaseFirst;
  let markFirstStarted;
  const firstCanFinish = new Promise(resolve => { releaseFirst = resolve; });
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  let sendCalls = 0;
  const whatsappClient = {
    info: { wid: 'bot@c.us' },
    sendMessage: async () => {
      sendCalls += 1;
      if (sendCalls === 1) {
        markFirstStarted();
        await firstCanFinish;
      }
      return {
        id: { _serialized: `authorization-queue-${sendCalls}` },
        timestamp: 1700000100 + sendCalls
      };
    }
  };
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-authorization-queue-'));

  const first = sendOutboundMessage({
    db,
    whatsappClient,
    conversation: firstConversation,
    user,
    payload: { content: 'primeira', client_request_id: 'authorization-first' },
    mediaRoot
  });
  await firstStarted;

  const queued = sendOutboundMessage({
    db,
    whatsappClient,
    conversation: transferredConversation,
    user,
    payload: { content: 'não pode sair', client_request_id: 'authorization-transferred' },
    mediaRoot
  });
  assert.equal(getMessageQueueLength(), 1);

  db.prepare('UPDATE conversations SET sector_id = 2 WHERE id = 2').run();
  releaseFirst();

  const [firstResult, queuedResult] = await Promise.all([first, queued]);
  assert.equal(firstResult.delivery_status, 'sent');
  assert.equal(queuedResult.delivery_status, 'failed');
  assert.match(queuedResult.delivery_error, /conversa.*transferida/i);
  assert.equal(sendCalls, 1);
  await waitForMessageQueueIdle(1000);
});

test('interrompe item ativo se o tenant for suspenso durante a preparação de mídia', async (t) => {
  const tenantId = 771338;
  const db = createDb();
  t.after(() => db.close());
  db.prepare("INSERT INTO admins (id, username, password, token_version) VALUES (1, 'admin-fila', 'hash', 0)")
    .run();
  db.prepare("INSERT INTO conversations (id, phone, contact_name, status) VALUES (1, 'suspensa@c.us', 'Suspensa', 'active')")
    .run();
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = 1').get();
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-suspended-active-'));
  t.after(() => fs.rmSync(mediaRoot, { recursive: true, force: true }));

  let releasePreparation;
  let markPreparationStarted;
  const preparationCanFinish = new Promise(resolve => { releasePreparation = resolve; });
  const preparationStarted = new Promise(resolve => { markPreparationStarted = resolve; });
  let sendCalls = 0;
  const sending = sendOutboundMessage({
    db,
    whatsappClient: {
      info: { wid: 'bot@c.us' },
      sendMessage: async () => {
        sendCalls += 1;
        return { id: { _serialized: 'must-not-send-after-suspension' } };
      }
    },
    conversation,
    user: { id: 1, role: 'admin', tenant_id: tenantId, token_version: 0 },
    payload: {
      sendAsVoice: true,
      media: {
        mimetype: 'audio/webm;codecs=opus',
        filename: 'audio.webm',
        data: WEBM_BASE64
      }
    },
    mediaRoot,
    prepareVoiceMediaForSend: async media => {
      markPreparationStarted();
      await preparationCanFinish;
      return {
        ...media,
        mimetype: 'audio/ogg; codecs=opus',
        filename: 'audio.ogg',
        data: OGG_BASE64,
        size: Buffer.byteLength(OGG_BASE64, 'base64')
      };
    },
    MessageMediaCtor: class FakeMessageMedia {}
  });

  await preparationStarted;
  discardTenantMessageQueue(tenantId, { permanent: false });
  releasePreparation();

  const result = await sending;
  assert.equal(result.delivery_status, 'failed');
  assert.match(result.delivery_error, /suspensa ou removida/i);
  assert.equal(sendCalls, 0);
  await waitForMessageQueueIdle(1000);
});

test('encaminhamento revalida também a conversa de origem ao sair da fila', async (t) => {
  const previousInterval = process.env.MIN_SEND_INTERVAL_MS;
  process.env.MIN_SEND_INTERVAL_MS = '1';
  t.after(() => {
    if (previousInterval === undefined) delete process.env.MIN_SEND_INTERVAL_MS;
    else process.env.MIN_SEND_INTERVAL_MS = previousInterval;
  });

  const db = createDb();
  t.after(() => db.close());
  db.exec(`
    INSERT INTO sectors (id, name, active) VALUES
      (1, 'Comercial', 1),
      (2, 'Financeiro', 1);
    INSERT INTO vendors (
      id, name, username, password, sector_id, active, token_version
    ) VALUES (8, 'Agente', 'agente-forward', 'hash', 1, 1, 0);
    INSERT INTO conversations (id, phone, contact_name, sector_id, status) VALUES
      (10, 'destino@c.us', 'Destino', 1, 'active'),
      (11, 'origem@c.us', 'Origem', 1, 'active');
  `);
  const target = db.prepare('SELECT * FROM conversations WHERE id = 10').get();
  const user = {
    id: 8,
    role: 'vendor',
    sector_id: 1,
    tenant_id: 771339,
    token_version: 0
  };
  let releaseFirst;
  let markFirstStarted;
  const firstCanFinish = new Promise(resolve => { releaseFirst = resolve; });
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  let sendCalls = 0;
  const whatsappClient = {
    info: { wid: 'bot@c.us' },
    sendMessage: async () => {
      sendCalls += 1;
      if (sendCalls === 1) {
        markFirstStarted();
        await firstCanFinish;
      }
      return { id: { _serialized: `forward-auth-${sendCalls}` }, timestamp: 1700000200 + sendCalls };
    }
  };
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-forward-authorization-'));
  t.after(() => fs.rmSync(mediaRoot, { recursive: true, force: true }));

  const blocker = sendOutboundMessage({
    db,
    whatsappClient,
    conversation: target,
    user,
    payload: { content: 'bloqueio da fila', client_request_id: 'forward-auth-blocker' },
    mediaRoot
  });
  await firstStarted;
  const forwarded = sendOutboundMessage({
    db,
    whatsappClient,
    conversation: target,
    user,
    requiredConversationIds: [11],
    payload: { content: 'conteúdo da origem', client_request_id: 'forward-auth-source' },
    mediaRoot
  });
  assert.equal(getMessageQueueLength(), 1);

  db.prepare('UPDATE conversations SET sector_id = 2 WHERE id = 11').run();
  releaseFirst();

  const [, result] = await Promise.all([blocker, forwarded]);
  assert.equal(result.delivery_status, 'failed');
  assert.match(result.delivery_error, /conversa envolvida foi transferida/i);
  assert.equal(sendCalls, 1);
  await waitForMessageQueueIdle(1000);
});

test('rejects a quoted message from an inaccessible conversation in another sector', async () => {
  const db = createDb();
  db.prepare("INSERT INTO sectors (id, name) VALUES (1, 'Vendas'), (2, 'Suporte')").run();
  db.prepare("INSERT INTO vendors (id, name, username, password, sector_id) VALUES (7, 'Vendedor', 'vend-quote', 'hash', 1)")
    .run();
  db.prepare(`
    INSERT INTO conversations (id, phone, contact_name, sector_id, status)
    VALUES
      (1, '5511000000001@c.us', 'Cliente vendas', 1, 'active'),
      (2, '5511000000002@c.us', 'Cliente suporte', 2, 'active')
  `).run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, external_id, from_type, content)
    VALUES (20, 2, 'quote-other-sector', 'client', 'Conteúdo restrito')
  `).run();
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = 1').get();
  let sendCalled = false;

  await assert.rejects(
    sendOutboundMessage({
      db,
      whatsappClient: {
        info: { wid: 'bot@c.us' },
        sendMessage: async () => {
          sendCalled = true;
          return { id: { _serialized: 'must-not-send' } };
        }
      },
      conversation,
      user: { id: 7, role: 'vendor', sector_id: 1, tenant_id: 701 },
      payload: { content: 'Resposta', quoted_message_id: 20 },
      mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-quote-sector-'))
    }),
    /Mensagem citada não pertence a esta conversa/
  );

  assert.equal(sendCalled, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = 1').get().count, 0);
  db.close();
});

test('rejects a quote from another conversation even when the user can access both', async () => {
  const db = createDb();
  db.prepare("INSERT INTO sectors (id, name) VALUES (1, 'Vendas')").run();
  db.prepare(`
    INSERT INTO conversations (id, phone, contact_name, sector_id, status)
    VALUES
      (1, '5511000000011@c.us', 'Cliente um', 1, 'active'),
      (2, '5511000000012@c.us', 'Cliente dois', 1, 'active')
  `).run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, external_id, from_type, content)
    VALUES (21, 2, 'quote-other-conversation', 'client', 'Outra conversa')
  `).run();
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = 1').get();

  await assert.rejects(
    sendOutboundMessage({
      db,
      whatsappClient: {
        info: { wid: 'bot@c.us' },
        sendMessage: async () => ({ id: { _serialized: 'must-not-send' } })
      },
      conversation,
      user: { id: 1, role: 'admin', tenant_id: 702 },
      payload: { content: 'Resposta', quoted_message_id: 21 },
      mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-quote-conversation-'))
    }),
    /Mensagem citada não pertence a esta conversa/
  );

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = 1').get().count, 0);
  db.close();
});

test('prefixes vendor name in the real whatsapp text without changing stored content', async () => {
  const db = createDb();
  db.prepare("INSERT INTO sectors (id, name) VALUES (1, 'Vendas')").run();
  db.prepare("INSERT INTO vendors (id, name, username, password, sector_id) VALUES (7, 'Jackson', 'jackson', 'hash', 1)")
    .run();
  db.prepare("INSERT INTO conversations (phone, contact_name, sector_id, status) VALUES (?, ?, 1, 'active')")
    .run('5511999999999@c.us', 'Cliente');
  const conversation = db.prepare('SELECT * FROM conversations').get();

  let sentContent;
  const result = await sendOutboundMessage({
    db,
    whatsappClient: {
      info: { wid: 'bot@c.us' },
      sendMessage: async (_chatId, content) => {
        sentContent = content;
        return { id: { _serialized: 'outbound-vendor-prefix' }, timestamp: 1700000100 };
      }
    },
    conversation,
    user: { id: 7, role: 'vendor', name: 'Jackson', sector_id: 1 },
    payload: { content: 'Oi cliente' },
    mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-prefix-'))
  });

  assert.equal(sentContent, 'Vendedor Jackson:\nOi cliente');
  assert.equal(result.content, 'Oi cliente');
  assert.equal(result.vendor_id, 7);
  assert.equal(result.vendor_sector_id, 1);

  db.close();
});

test('sends media with caption and stores local attachment', async () => {
  const db = createDb();
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-media-'));
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('abc@lid', 'Cliente');
  const conversation = db.prepare('SELECT * FROM conversations').get();

  let sentContent;
  let sentOptions;
  const result = await sendOutboundMessage({
    db,
    whatsappClient: {
      info: { wid: 'bot@c.us' },
      sendMessage: async (_chatId, content, options) => {
        sentContent = content;
        sentOptions = options;
        return { id: { _serialized: 'outbound-media-1' }, timestamp: 1700000200 };
      }
    },
    conversation,
    user: { id: 1, role: 'admin' },
    payload: {
      content: 'Segue foto',
      media: {
        mimetype: 'image/png',
        filename: 'foto.png',
        data: PNG_BASE64
      }
    },
    mediaRoot,
    MessageMediaCtor: class FakeMessageMedia {
      constructor(mimetype, data, filename, filesize) {
        this.mimetype = mimetype;
        this.data = data;
        this.filename = filename;
        this.filesize = filesize;
      }
    }
  });

  assert.equal(sentContent.mimetype, 'image/png');
  assert.equal(sentContent.filename, 'foto.png');
  assert.equal(sentOptions.caption, 'Segue foto');
  assert.equal(sentOptions.waitUntilMsgSent, false);
  assert.equal(result.delivery_status, 'sent');
  assert.equal(result.media_type, 'image');
  assert.equal(result.media_filename, 'foto.png');
  assert.equal(fs.existsSync(path.join(mediaRoot, 'out-1.png')), true);

  db.close();
});

test('materializes a locally forwarded sticker before returning it to the chat', async () => {
  const db = createDb();
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-sticker-'));
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('sticker-target@lid', 'Cliente');
  const conversation = db.prepare('SELECT * FROM conversations').get();
  let sentOptions;

  const result = await sendOutboundMessage({
    db,
    whatsappClient: {
      info: { wid: 'bot@c.us' },
      sendMessage: async (_chatId, _content, options) => {
        sentOptions = options;
        return { id: { _serialized: 'forwarded-sticker-1' }, timestamp: 1700000250 };
      }
    },
    conversation,
    user: { id: 1, role: 'admin', tenant_id: 9901 },
    payload: {
      content: '',
      sendAsSticker: true,
      media: {
        mimetype: 'image/webp',
        filename: 'sticker.webp',
        messageType: 'sticker',
        data: WEBP_BASE64
      }
    },
    mediaRoot,
    MessageMediaCtor: class FakeMessageMedia {
      constructor(mimetype, data, filename) {
        this.mimetype = mimetype;
        this.data = data;
        this.filename = filename;
      }
    }
  });

  assert.equal(sentOptions.sendMediaAsSticker, true);
  assert.equal(result.media_type, 'sticker');
  assert.equal(result.media_url, '/media/t9901-out-1.webp');
  assert.equal(fs.existsSync(path.join(mediaRoot, 't9901-out-1.webp')), true);
  assert.equal(result.delivery_status, 'sent');
  db.close();
});

test('prefixes vendor name in whatsapp media captions', async () => {
  const db = createDb();
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-media-prefix-'));
  db.prepare("INSERT INTO vendors (id, name, username, password) VALUES (8, 'Jackson', 'jackson8', 'hash')")
    .run();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511999999999@c.us', 'Cliente');
  const conversation = db.prepare('SELECT * FROM conversations').get();

  let sentOptions;
  const result = await sendOutboundMessage({
    db,
    whatsappClient: {
      info: { wid: 'bot@c.us' },
      sendMessage: async (_chatId, _content, options) => {
        sentOptions = options;
        return { id: { _serialized: 'outbound-media-prefix' }, timestamp: 1700000210 };
      }
    },
    conversation,
    user: { id: 8, role: 'vendor', name: 'Jackson' },
    payload: {
      content: 'Segue foto',
      media: {
        mimetype: 'image/png',
        filename: 'foto.png',
        data: PNG_BASE64
      }
    },
    mediaRoot,
    MessageMediaCtor: class FakeMessageMedia {
      constructor(mimetype, data, filename, filesize) {
        this.mimetype = mimetype;
        this.data = data;
        this.filename = filename;
        this.filesize = filesize;
      }
    }
  });

  assert.equal(sentOptions.caption, 'Vendedor Jackson:\nSegue foto');
  assert.equal(result.content, 'Segue foto');

  db.close();
});

test('converts recorded webm voice notes to ogg before sending to whatsapp', async () => {
  const db = createDb();
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-voice-'));
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511999999999@c.us', 'Cliente');
  const conversation = db.prepare('SELECT * FROM conversations').get();

  let sentContent;
  let sentOptions;
  const result = await sendOutboundMessage({
    db,
    whatsappClient: {
      info: { wid: 'bot@c.us' },
      sendMessage: async (_chatId, content, options) => {
        sentContent = content;
        sentOptions = options;
        return { id: { _serialized: 'voice-1' }, timestamp: 1700000300 };
      }
    },
    conversation,
    user: { id: 1, role: 'admin' },
    payload: {
      content: '',
      sendAsVoice: true,
      media: {
        mimetype: 'audio/webm;codecs=opus',
        filename: 'audio.webm',
        data: WEBM_BASE64
      }
    },
    mediaRoot,
    prepareVoiceMediaForSend: async media => ({
      ...media,
      mimetype: 'audio/ogg; codecs=opus',
      filename: 'audio.ogg',
      data: OGG_BASE64,
      size: Buffer.byteLength(OGG_BASE64, 'base64')
    }),
    MessageMediaCtor: class FakeMessageMedia {
      constructor(mimetype, data, filename, filesize) {
        this.mimetype = mimetype;
        this.data = data;
        this.filename = filename;
        this.filesize = filesize;
      }
    }
  });

  assert.equal(sentContent.mimetype, 'audio/ogg; codecs=opus');
  assert.equal(sentContent.filename, 'audio.ogg');
  assert.equal(sentContent.data, OGG_BASE64);
  assert.equal(sentOptions.sendAudioAsVoice, true);
  assert.equal(sentOptions.waitUntilMsgSent, false);
  assert.equal(result.delivery_status, 'sent');
  assert.equal(result.media_mimetype, 'audio/ogg; codecs=opus');
  assert.equal(result.media_filename, 'audio.ogg');
  assert.equal(fs.existsSync(path.join(mediaRoot, 'out-1.ogg')), true);

  db.close();
});

test('does not blindly resend media after an ambiguous whatsapp frame error', async () => {
  const db = createDb();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511999999999@c.us', 'Cliente');
  const conversation = db.prepare('SELECT * FROM conversations').get();

  let calls = 0;
  const result = await sendOutboundMessage({
    db,
    whatsappClient: {
      info: { wid: 'bot@c.us' },
      sendMessage: async () => {
        calls += 1;
        throw new Error("Attempted to use detached Frame 'abc'.");
      }
    },
    conversation,
    user: { id: 1, role: 'admin', tenant_id: 8800 },
    payload: {
      content: '',
      sendAsVoice: true,
      media: {
        mimetype: 'audio/ogg; codecs=opus',
        filename: 'audio.ogg',
        data: OGG_BASE64
      }
    },
    mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-retry-')),
    sendRetryDelayMs: 0,
    sendMaxAttempts: 3,
    MessageMediaCtor: class FakeMessageMedia {
      constructor(mimetype, data, filename, filesize) {
        this.mimetype = mimetype;
        this.data = data;
        this.filename = filename;
        this.filesize = filesize;
      }
    }
  });

  assert.equal(calls, 1);
  assert.equal(result.delivery_status, 'unknown');
  assert.match(result.delivery_error, /Envio sem confirmação/);
  assert.equal(result.external_id, null);

  db.close();
});

test('does not blindly resend text after an ambiguous whatsapp frame error', async () => {
  const db = createDb();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511999999998@c.us', 'Cliente texto ambiguo');
  const conversation = db.prepare('SELECT * FROM conversations').get();
  let calls = 0;

  const result = await sendOutboundMessage({
    db,
    whatsappClient: {
      info: { wid: 'bot@c.us' },
      sendMessage: async () => {
        calls += 1;
        throw new Error('Execution context was destroyed after dispatch');
      }
    },
    conversation,
    user: { id: 1, role: 'admin', tenant_id: 8801 },
    payload: { content: 'Mensagem sem duplicidade' },
    mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-text-ambiguous-')),
    sendRetryDelayMs: 0,
    sendMaxAttempts: 5
  });

  assert.equal(calls, 1);
  assert.equal(result.delivery_status, 'unknown');
  assert.match(result.delivery_error, /Envio sem confirmação/);
  assert.equal(result.external_id, null);
  db.close();
});

test('send timeout does not freeze the tenant queue or blindly retry an ambiguous send', async () => {
  const db = createDb();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511999999999@c.us', 'Cliente timeout');
  const conversation = db.prepare('SELECT * FROM conversations').get();
  let calls = 0;
  const result = await sendOutboundMessage({
    db,
    whatsappClient: {
      info: { wid: 'bot@c.us' },
      sendMessage: () => {
        calls += 1;
        return new Promise(() => {});
      }
    },
    conversation,
    user: { id: 1, role: 'admin', tenant_id: 9999 },
    payload: { content: 'Mensagem com timeout' },
    mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-timeout-')),
    sendTimeoutMs: 10,
    sendMaxAttempts: 3
  });
  assert.equal(calls, 1);
  assert.equal(result.delivery_status, 'unknown');
  assert.match(result.delivery_error, /sem confirmação/);
  await waitForMessageQueueIdle(200);
  db.close();
});

test('startup recovery converts stale pending outbox rows to an ambiguous durable state', () => {
  const db = createDb();
  db.prepare("INSERT INTO conversations (id, phone, status) VALUES (1, '5511888888888@c.us', 'active')").run();
  db.prepare(`
    INSERT INTO messages (conversation_id, from_type, content, delivery_status, created_at)
    VALUES (1, 'vendor', 'antiga', 'pending', datetime('now', '-10 minutes')),
           (1, 'vendor', 'recente', 'pending', datetime('now'))
  `).run();
  assert.equal(recoverInterruptedOutboundMessages(db, { staleMinutes: 2 }), 1);
  assert.equal(db.prepare("SELECT delivery_status FROM messages WHERE content = 'antiga'").get().delivery_status, 'unknown');
  assert.equal(db.prepare("SELECT delivery_status FROM messages WHERE content = 'recente'").get().delivery_status, 'pending');
  assert.equal(recoverInterruptedOutboundMessages(db, { staleMinutes: 0 }), 1);
  assert.equal(db.prepare("SELECT delivery_status FROM messages WHERE content = 'recente'").get().delivery_status, 'unknown');
  db.close();
});

test('uses a rolling hourly window and refuses before creating an orphan outbox row', async t => {
  const previousMaximum = process.env.MAX_MESSAGES_PER_HOUR;
  const previousInterval = process.env.MIN_SEND_INTERVAL_MS;
  process.env.MAX_MESSAGES_PER_HOUR = '2';
  process.env.MIN_SEND_INTERVAL_MS = '1';
  t.after(() => {
    if (previousMaximum === undefined) delete process.env.MAX_MESSAGES_PER_HOUR;
    else process.env.MAX_MESSAGES_PER_HOUR = previousMaximum;
    if (previousInterval === undefined) delete process.env.MIN_SEND_INTERVAL_MS;
    else process.env.MIN_SEND_INTERVAL_MS = previousInterval;
  });

  const db = createDb();
  t.after(() => db.close());
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES ('rate@c.us', 'Rate', 'active')").run();
  const conversation = db.prepare('SELECT * FROM conversations').get();
  let calls = 0;
  const send = content => sendOutboundMessage({
    db,
    whatsappClient: {
      info: { wid: 'bot@c.us' },
      sendMessage: async () => {
        calls += 1;
        return { id: { _serialized: `rolling-${calls}` }, timestamp: 1700000000 + calls };
      }
    },
    conversation,
    user: { id: 1, role: 'admin', tenant_id: 424242 },
    payload: { content },
    mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-rolling-'))
  });

  await send('primeira');
  await send('segunda');
  await assert.rejects(send('terceira'), /Limite de 2 mensagens por hora/);
  assert.equal(calls, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 2);
});

test('reconciles an outbound media echo that persisted before sendMessage resolves', async () => {
  const db = createDb();
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-echo-'));
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511999999999@c.us', 'Cliente');
  const conversation = db.prepare('SELECT * FROM conversations').get();

  const result = await sendOutboundMessage({
    db,
    whatsappClient: {
      info: { wid: 'bot@c.us' },
      sendMessage: async () => {
        db.prepare(`
          INSERT INTO messages (
            conversation_id, external_id, from_type, content, media_type,
            media_mimetype, media_filename, media_url, media_size,
            delivery_status, sent_at, created_at
          )
          VALUES (?, ?, 'vendor', '(mídia)', 'audio', ?, ?, ?, ?, 'delivered', ?, ?)
        `).run(
          conversation.id,
          'voice-echo-1',
          'audio/ogg; codecs=opus',
          'echo.ogg',
          '/media/echo.ogg',
          Buffer.byteLength(OGG_BASE64, 'base64'),
          '2023-11-14 22:18:20',
          '2023-11-14 22:18:20'
        );
        return { id: { _serialized: 'voice-echo-1' }, timestamp: 1700000300 };
      }
    },
    conversation,
    user: { id: 1, role: 'admin' },
    payload: {
      content: '',
      sendAsVoice: true,
      media: {
        mimetype: 'audio/ogg; codecs=opus',
        filename: 'audio.ogg',
        data: OGG_BASE64
      }
    },
    mediaRoot,
    MessageMediaCtor: class FakeMessageMedia {
      constructor(mimetype, data, filename, filesize) {
        this.mimetype = mimetype;
        this.data = data;
        this.filename = filename;
        this.filesize = filesize;
      }
    }
  });

  const rows = db.prepare('SELECT * FROM messages ORDER BY id').all();
  assert.equal(rows.length, 1);
  assert.equal(result.id, rows[0].id);
  assert.equal(result.external_id, 'voice-echo-1');
  assert.equal(result.delivery_status, 'delivered');
  assert.equal(result.delivery_error, null);
  assert.match(result.media_url, /out-1\.ogg$/);

  db.close();
});

test('reuses an existing outbound row for the same client_request_id when supported by schema', async () => {
  const db = createDb();
  if (!db.prepare('PRAGMA table_info(messages)').all().some(row => row.name === 'client_request_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN client_request_id TEXT;');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_request_id
    ON messages(client_request_id)
    WHERE client_request_id IS NOT NULL;
  `);
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511999999999@c.us', 'Cliente');
  const conversation = db.prepare('SELECT * FROM conversations').get();
  let calls = 0;
  let releaseSend;
  const sendCanFinish = new Promise(resolve => { releaseSend = resolve; });
  const options = {
    db,
    whatsappClient: {
      info: { wid: 'bot@c.us' },
      sendMessage: async () => {
        calls += 1;
        await sendCanFinish;
        return { id: { _serialized: 'idempotent-1' }, timestamp: 1700000400 };
      }
    },
    conversation,
    user: { id: 1, role: 'admin' },
    payload: { content: 'uma vez', client_request_id: 'request-123' },
    mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-idempotent-'))
  };

  const firstPromise = sendOutboundMessage(options);
  const duplicateWhileSending = await sendOutboundMessage(options);
  assert.equal(duplicateWhileSending.delivery_status, 'pending');
  releaseSend();
  const first = await firstPromise;
  const duplicateAfterSending = await sendOutboundMessage(options);

  assert.equal(calls, 1);
  assert.equal(duplicateWhileSending.id, first.id);
  assert.equal(duplicateAfterSending.id, first.id);
  assert.equal(duplicateAfterSending.external_id, 'idempotent-1');
  assert.equal(duplicateAfterSending.client_request_id, 'request-123');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 1);

  db.close();
});

test('marks voice message as failed when audio conversion fails', async () => {
  const db = createDb();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511999999999@c.us', 'Cliente');
  const conversation = db.prepare('SELECT * FROM conversations').get();

  let sendCalled = false;
  const result = await sendOutboundMessage({
    db,
    whatsappClient: {
      info: { wid: 'bot@c.us' },
      sendMessage: async () => {
        sendCalled = true;
      }
    },
    conversation,
    user: { id: 1, role: 'admin' },
    payload: {
      sendAsVoice: true,
      media: {
        mimetype: 'audio/webm;codecs=opus',
        filename: 'audio.webm',
        data: WEBM_BASE64
      }
    },
    mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-voice-failed-')),
    prepareVoiceMediaForSend: async () => {
      throw new Error('ffmpeg failed');
    }
  });

  assert.equal(sendCalled, false);
  assert.equal(result.delivery_status, 'failed');
  assert.match(result.delivery_error, /ffmpeg failed/);

  db.close();
});

test('marks outbound message as failed when whatsapp send fails', async () => {
  const db = createDb();
  db.prepare("INSERT INTO vendors (id, name, username, password) VALUES (3, 'Vendedor', 'vend3', 'hash')")
    .run();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511999999999@c.us', 'Cliente');
  const conversation = db.prepare('SELECT * FROM conversations').get();

  const result = await sendOutboundMessage({
    db,
    whatsappClient: {
      info: { wid: 'bot@c.us' },
      sendMessage: async () => {
        throw new Error('network down');
      }
    },
    conversation,
    user: { id: 3, role: 'vendor' },
    payload: { content: 'Oi' },
    mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-failed-'))
  });

  assert.equal(result.delivery_status, 'failed');
  assert.match(result.delivery_error, /network down/);
  assert.equal(result.external_id, null);

  db.close();
});

test('rejects media larger than configured outbound media limit before inserting a message', async () => {
  const previousLimit = process.env.MAX_OUTBOUND_MEDIA_BYTES;
  process.env.MAX_OUTBOUND_MEDIA_BYTES = '4';

  const db = createDb();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511999999999@c.us', 'Cliente');
  const conversation = db.prepare('SELECT * FROM conversations').get();

  await assert.rejects(
    sendOutboundMessage({
      db,
      whatsappClient: {
        info: { wid: 'bot@c.us' },
        sendMessage: async () => ({ id: { _serialized: 'never' } })
      },
      conversation,
      user: { id: 1, role: 'admin' },
      payload: {
        media: {
          mimetype: 'image/png',
          filename: 'big.png',
          size: 1,
          data: Buffer.from('too-large').toString('base64')
        }
      },
      mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-too-large-'))
    }),
    /Anexo excede o limite/
  );

  const count = db.prepare('SELECT COUNT(*) AS count FROM messages').get().count;
  assert.equal(count, 0);

  if (previousLimit === undefined) delete process.env.MAX_OUTBOUND_MEDIA_BYTES;
  else process.env.MAX_OUTBOUND_MEDIA_BYTES = previousLimit;
  db.close();
});

test('rejects oversized text before creating an outbox row', async () => {
  const db = createDb();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511888877777@c.us', 'Texto excessivo');
  const conversation = db.prepare('SELECT * FROM conversations').get();

  await assert.rejects(
    sendOutboundMessage({
      db,
      whatsappClient: {
        info: { wid: 'bot@c.us' },
        sendMessage: async () => ({ id: { _serialized: 'never' } })
      },
      conversation,
      user: { id: 1, role: 'admin', tenant_id: 8890 },
      payload: { content: 'a'.repeat(10001) },
      mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-text-too-large-'))
    }),
    /Mensagem excede o limite de 10000 caracteres/
  );

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);
  db.close();
});

test('rejects outbound sends when the in-memory queue reaches its configured limit', async () => {
  const previousQueueLimit = process.env.MAX_MESSAGE_QUEUE_SIZE;
  const previousInterval = process.env.MIN_SEND_INTERVAL_MS;
  process.env.MAX_MESSAGE_QUEUE_SIZE = '1';
  process.env.MIN_SEND_INTERVAL_MS = '1';

  const db = createDb();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511999999999@c.us', 'Cliente');
  const conversation = db.prepare('SELECT * FROM conversations').get();
  let releaseFirstSend;
  const firstSendStarted = new Promise(resolve => {
    releaseFirstSend = resolve;
  });

  const whatsappClient = {
    info: { wid: 'bot@c.us' },
    sendMessage: async () => {
      await firstSendStarted;
      return { id: { _serialized: `sent-${Date.now()}` }, timestamp: 1700000500 };
    }
  };

  const sendOne = payload => sendOutboundMessage({
    db,
    whatsappClient,
    conversation,
    user: { id: 1, role: 'admin' },
    payload,
    mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-queue-')),
    sendRetryDelayMs: 0
  });

  const first = sendOne({ content: 'primeira' });
  const second = sendOne({ content: 'segunda' });
  await assert.rejects(sendOne({ content: 'terceira' }), /Fila de envio cheia/);
  assert.equal(getMessageQueueLength(), 1);

  releaseFirstSend();
  await Promise.all([first, second]);
  await waitForMessageQueueIdle(1000);
  assert.equal(getMessageQueueLength(), 0);

  if (previousQueueLimit === undefined) delete process.env.MAX_MESSAGE_QUEUE_SIZE;
  else process.env.MAX_MESSAGE_QUEUE_SIZE = previousQueueLimit;
  if (previousInterval === undefined) delete process.env.MIN_SEND_INTERVAL_MS;
  else process.env.MIN_SEND_INTERVAL_MS = previousInterval;
  db.close();
});

test('circuit breaker abre após N falhas consecutivas e rejeita envios', async () => {
  const previousThreshold = process.env.CIRCUIT_BREAKER_THRESHOLD;
  const previousCooldown = process.env.CIRCUIT_BREAKER_COOLDOWN_MS;
  process.env.CIRCUIT_BREAKER_THRESHOLD = '3';
  process.env.CIRCUIT_BREAKER_COOLDOWN_MS = '60000';
  delete require.cache[require.resolve('./messageSender')];
  const {
    sendOutboundMessage: sendMsg,
    drainMessageQueues: drain,
    waitForMessageQueueIdle: waitIdle
  } = require('./messageSender');

  const db = createDb();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511999999999@c.us', 'Circuito');
  const conversation = db.prepare('SELECT * FROM conversations').get();
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-circuit-'));
  let failCount = 0;
  const alwaysFailClient = {
    info: { wid: 'bot@c.us' },
    sendMessage: async () => { failCount += 1; throw new Error('whatsapp offline'); }
  };

  const opts = {
    db, whatsappClient: alwaysFailClient, conversation, user: { id: 1, role: 'admin' },
    payload: { content: 'teste' }, mediaRoot
  };

  // As primeiras 3 falham com o erro original (delivery_error contém a causa)
  for (let i = 0; i < 3; i++) {
    const msg = await sendMsg(opts);
    assert.equal(msg.delivery_status, 'failed');
    assert.match(msg.delivery_error, /whatsapp offline/);
  }

  // A 4ª deve ser rejeitada pelo circuit breaker antes de tentar enviar
  const msg = await sendMsg(opts);
  assert.equal(msg.delivery_status, 'failed');
  assert.match(msg.delivery_error, /Circuito de envio aberto/);
  assert.equal(failCount, 3); // nenhuma tentativa adicional foi feita

  await drain(200);
  await waitIdle(200);

  if (previousThreshold === undefined) delete process.env.CIRCUIT_BREAKER_THRESHOLD;
  else process.env.CIRCUIT_BREAKER_THRESHOLD = previousThreshold;
  if (previousCooldown === undefined) delete process.env.CIRCUIT_BREAKER_COOLDOWN_MS;
  else process.env.CIRCUIT_BREAKER_COOLDOWN_MS = previousCooldown;
  delete require.cache[require.resolve('./messageSender')];
  db.close();
});

test('circuit breaker reseta após um envio bem-sucedido', async () => {
  const previousThreshold = process.env.CIRCUIT_BREAKER_THRESHOLD;
  const previousCooldown = process.env.CIRCUIT_BREAKER_COOLDOWN_MS;
  process.env.CIRCUIT_BREAKER_THRESHOLD = '3';
  process.env.CIRCUIT_BREAKER_COOLDOWN_MS = '60000';
  delete require.cache[require.resolve('./messageSender')];
  const {
    sendOutboundMessage: sendMsg,
    drainMessageQueues: drain,
    waitForMessageQueueIdle: waitIdle
  } = require('./messageSender');

  const db = createDb();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511999999999@c.us', 'CircuitoReset');
  const conversation = db.prepare('SELECT * FROM conversations').get();
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-circuit-reset-'));
  let callIndex = 0;
  const flakyClient = {
    info: { wid: 'bot@c.us' },
    sendMessage: async () => {
      callIndex += 1;
      if (callIndex <= 2) throw new Error('recoverable');
      return { id: { _serialized: 'ok-after-retry' }, timestamp: 1700000600 };
    }
  };

  const opts = {
    db, whatsappClient: flakyClient, conversation, user: { id: 1, role: 'admin' },
    payload: { content: 'teste' }, mediaRoot
  };

  // Duas falham (delivery_error) e uma passa — circuito nunca abre
  let msg = await sendMsg(opts);
  assert.match(msg.delivery_error, /recoverable/);
  msg = await sendMsg(opts);
  assert.match(msg.delivery_error, /recoverable/);
  const result = await sendMsg(opts);
  assert.equal(result.external_id, 'ok-after-retry');

  // Após o sucesso, a próxima falha é tratada normalmente (não rejeitada pelo breaker)
  callIndex = 0;
  msg = await sendMsg(opts);
  assert.match(msg.delivery_error, /recoverable/);
  assert.equal(callIndex, 1); // foi realmente tentado

  await drain(200);
  await waitIdle(200);

  if (previousThreshold === undefined) delete process.env.CIRCUIT_BREAKER_THRESHOLD;
  else process.env.CIRCUIT_BREAKER_THRESHOLD = previousThreshold;
  if (previousCooldown === undefined) delete process.env.CIRCUIT_BREAKER_COOLDOWN_MS;
  else process.env.CIRCUIT_BREAKER_COOLDOWN_MS = previousCooldown;
  delete require.cache[require.resolve('./messageSender')];
  db.close();
});

test('drainMessageQueues rejeita filas pendentes no timeout', async () => {
  const previousInterval = process.env.MIN_SEND_INTERVAL_MS;
  process.env.MIN_SEND_INTERVAL_MS = '100000';
  delete require.cache[require.resolve('./messageSender')];
  const {
    sendOutboundMessage: sendMsg,
    drainMessageQueues: drain,
    waitForMessageQueueIdle: waitIdle,
    getMessageQueueLength: queueLen
  } = require('./messageSender');

  const db = createDb();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('5511999999999@c.us', 'DrainTest');
  const conversation = db.prepare('SELECT * FROM conversations').get();
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-drain-'));
  let release;
  const holdPromise = new Promise(r => { release = r; });
  const slowClient = {
    info: { wid: 'bot@c.us' },
    sendMessage: async () => {
      await holdPromise;
      return { id: { _serialized: 'slow' }, timestamp: 1700000700 };
    }
  };

  const opts = {
    db, whatsappClient: slowClient, conversation, user: { id: 1, role: 'admin' },
    payload: { content: 'lento' }, mediaRoot
  };

  // Enfileira 3 mensagens (a primeira trava, as outras 2 ficam na fila)
  const p1 = sendMsg(opts);
  const p2 = sendMsg(opts);
  const p3 = sendMsg(opts);

  // Drena com timeout curto — as pendentes devem ser marcadas como failed
  await drain(50);
  const msg2 = await p2;
  const msg3 = await p3;
  assert.equal(msg2.delivery_status, 'failed');
  assert.match(msg2.delivery_error, /Shutdown em andamento/);
  assert.match(msg3.delivery_error, /Shutdown em andamento/);

  // Libera a primeira para não vazar handle
  release();
  const msg1 = await p1;
  assert.equal(msg1.external_id, 'slow');
  assert.equal(queueLen(), 0);

  await waitIdle(200);

  if (previousInterval === undefined) delete process.env.MIN_SEND_INTERVAL_MS;
  else process.env.MIN_SEND_INTERVAL_MS = previousInterval;
  delete require.cache[require.resolve('./messageSender')];
  db.close();
});

test('deleted tenant queue cannot be recreated by a late request with colliding user ids', async () => {
  const db = createDb();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
    .run('deleted@c.us', 'Deleted');
  const conversation = db.prepare('SELECT * FROM conversations').get();
  let calls = 0;
  const tenantId = 880088;

  assert.equal(discardTenantMessageQueue(tenantId), 0);
  const result = await sendOutboundMessage({
    db,
    whatsappClient: {
      info: { wid: 'bot@c.us' },
      sendMessage: async () => {
        calls += 1;
        return { id: { _serialized: 'must-not-send' } };
      }
    },
    conversation,
    user: { id: 1, role: 'admin', tenant_id: tenantId },
    payload: { content: 'late event' },
    mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-deleted-tenant-'))
  });

  assert.equal(calls, 0);
  assert.equal(result.delivery_status, 'failed');
  assert.match(result.delivery_error, /Empresa removida/);
  db.close();
});
