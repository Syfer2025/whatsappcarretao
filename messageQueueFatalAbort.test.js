const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureSchema } = require('./schema');
const {
  abortMessageQueues,
  sendOutboundMessage,
  waitForMessageQueueIdle
} = require('./messageSender');

test('fatal writer-lease abort discards pending work and stops active preparation before WhatsApp send', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  ensureSchema(db);
  db.prepare("INSERT INTO conversations (id, phone, contact_name, status) VALUES (1, 'fatal@c.us', 'Fatal', 'active')")
    .run();
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = 1').get();
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-fatal-abort-'));
  t.after(() => fs.rmSync(mediaRoot, { recursive: true, force: true }));

  let releasePreparation;
  let markPreparationStarted;
  const preparationStarted = new Promise(resolve => { markPreparationStarted = resolve; });
  const preparationGate = new Promise(resolve => { releasePreparation = resolve; });
  let sendCalls = 0;
  const whatsappClient = {
    info: { wid: 'bot@c.us' },
    sendMessage: async () => {
      sendCalls += 1;
      return { id: { _serialized: 'must-not-send' } };
    }
  };
  const common = {
    db,
    whatsappClient,
    conversation,
    user: { id: 1, role: 'admin', tenant_id: 91 },
    mediaRoot
  };

  const active = sendOutboundMessage({
    ...common,
    payload: {
      sendAsVoice: true,
      media: {
        mimetype: 'audio/webm',
        filename: 'voice.webm',
        data: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString('base64')
      }
    },
    prepareVoiceMediaForSend: async media => {
      markPreparationStarted();
      await preparationGate;
      return {
        ...media,
        mimetype: 'audio/ogg; codecs=opus',
        filename: 'voice.ogg',
        data: Buffer.from('OggSvoice').toString('base64')
      };
    }
  });
  await preparationStarted;
  const pending = sendOutboundMessage({ ...common, payload: { content: 'pending' } });

  assert.equal(abortMessageQueues('writer lease lost'), 1);
  releasePreparation();
  const [activeResult, pendingResult] = await Promise.all([active, pending]);
  await waitForMessageQueueIdle(500);

  assert.equal(sendCalls, 0);
  assert.equal(activeResult.delivery_status, 'failed');
  assert.equal(pendingResult.delivery_status, 'failed');
  assert.match(activeResult.delivery_error, /suspensa|removida/);
  assert.match(pendingResult.delivery_error, /writer lease lost/);
});
