const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureSchema } = require('./schema');
const {
  getMessageQueueLength,
  sendOutboundMessage,
  waitForMessageQueueIdle
} = require('./messageSender');

function createDb() {
  const db = new Database(':memory:');
  ensureSchema(db);
  return db;
}

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

test('prefixes vendor name in the real whatsapp text without changing stored content', async () => {
  const db = createDb();
  db.prepare("INSERT INTO vendors (id, name, username, password) VALUES (7, 'Jackson', 'jackson', 'hash')")
    .run();
  db.prepare("INSERT INTO conversations (phone, contact_name, status) VALUES (?, ?, 'active')")
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
    user: { id: 7, role: 'vendor', name: 'Jackson' },
    payload: { content: 'Oi cliente' },
    mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-prefix-'))
  });

  assert.equal(sentContent, 'Vendedor Jackson:\nOi cliente');
  assert.equal(result.content, 'Oi cliente');
  assert.equal(result.vendor_id, 7);

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
        data: Buffer.from('png-data').toString('base64')
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
        data: Buffer.from('png-data').toString('base64')
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
        data: Buffer.from('webm-data').toString('base64')
      }
    },
    mediaRoot,
    prepareVoiceMediaForSend: async media => ({
      ...media,
      mimetype: 'audio/ogg; codecs=opus',
      filename: 'audio.ogg',
      data: Buffer.from('ogg-data').toString('base64'),
      size: 8
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
  assert.equal(sentContent.data, Buffer.from('ogg-data').toString('base64'));
  assert.equal(sentOptions.sendAudioAsVoice, true);
  assert.equal(sentOptions.waitUntilMsgSent, false);
  assert.equal(result.delivery_status, 'sent');
  assert.equal(result.media_mimetype, 'audio/ogg; codecs=opus');
  assert.equal(result.media_filename, 'audio.ogg');
  assert.equal(fs.existsSync(path.join(mediaRoot, 'out-1.ogg')), true);

  db.close();
});

test('retries transient whatsapp frame errors before marking media as failed', async () => {
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
        if (calls === 1) throw new Error("Attempted to use detached Frame 'abc'.");
        return { id: { _serialized: 'after-retry' }, timestamp: 1700000400 };
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
        data: Buffer.from('ogg-data').toString('base64')
      }
    },
    mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-outbound-retry-')),
    sendRetryDelayMs: 0,
    MessageMediaCtor: class FakeMessageMedia {
      constructor(mimetype, data, filename, filesize) {
        this.mimetype = mimetype;
        this.data = data;
        this.filename = filename;
        this.filesize = filesize;
      }
    }
  });

  assert.equal(calls, 2);
  assert.equal(result.delivery_status, 'sent');
  assert.equal(result.external_id, 'after-retry');

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
        data: Buffer.from('webm-data').toString('base64')
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
