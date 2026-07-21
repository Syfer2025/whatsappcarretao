const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  classifyMedia,
  extensionForMime,
  getSafeMediaFilename,
  isTenantMediaFilename,
  knownWhatsAppMediaSize,
  assertKnownInboundMediaSize,
  saveMessageMedia,
  resolveStoredTenantMediaPath,
  removeStoredTenantMediaSync
} = require('./mediaStorage');
const { validateMediaForStorage } = require('./mediaSecurity');

test('classifies common WhatsApp media mimetypes', () => {
  assert.equal(classifyMedia('image/jpeg'), 'image');
  assert.equal(classifyMedia('audio/ogg; codecs=opus'), 'audio');
  assert.equal(classifyMedia('video/mp4'), 'video');
  assert.equal(classifyMedia('application/pdf'), 'document');
  assert.equal(classifyMedia('image/webp', 'sticker'), 'sticker');
});

test('rejects known oversized WhatsApp media before download/base64 allocation', () => {
  let downloadCalls = 0;
  const message = {
    _data: { size: 2049 },
    downloadMedia: async () => { downloadCalls += 1; }
  };
  assert.equal(knownWhatsAppMediaSize(message), 2049);
  assert.throws(
    () => assertKnownInboundMediaSize(message, {
      maxInboundBytes: 2048,
      tenantQuotaBytes: 4096,
      globalQuotaBytes: 8192,
      minFreeBytes: 4096
    }),
    error => error.code === 'MEDIA_TOO_LARGE' && error.statusCode === 507
  );
  assert.equal(downloadCalls, 0);
  assert.equal(knownWhatsAppMediaSize({ _data: { size: 'desconhecido' } }), null);
});

test('builds safe media filenames with useful extensions', () => {
  assert.equal(extensionForMime('image/jpeg'), 'jpg');
  assert.equal(extensionForMime('audio/ogg; codecs=opus'), 'ogg');
  assert.equal(extensionForMime('application/pdf'), 'pdf');

  assert.equal(getSafeMediaFilename('abc/123@lid', 'image/jpeg'), 'abc-123-lid.jpg');
  assert.equal(getSafeMediaFilename('same-id', 'image/jpeg', 11), 't11-same-id.jpg');
  assert.equal(isTenantMediaFilename('t11-same-id.jpg', 11), true);
  assert.equal(isTenantMediaFilename('t11-same-id.jpg', 12), false);
  assert.throws(
    () => getSafeMediaFilename('same-id', 'image/jpeg', '../11'),
    /Namespace de tenant invalido/
  );
});

test('equal whatsapp message ids from different tenants cannot overwrite each other', async t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-media-tenants-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const [tenantA, tenantB] = await Promise.all([
    saveMessageMedia({
      messageId: 'same-whatsapp-id',
      namespace: 101,
      media: {
        mimetype: 'text/plain',
        filename: 'a.txt',
        data: Buffer.from('tenant-a').toString('base64')
      },
      messageType: 'document',
      mediaRoot: tmpDir
    }),
    saveMessageMedia({
      messageId: 'same-whatsapp-id',
      namespace: 202,
      media: {
        mimetype: 'text/plain',
        filename: 'b.txt',
        data: Buffer.from('tenant-b').toString('base64')
      },
      messageType: 'document',
      mediaRoot: tmpDir
    })
  ]);

  assert.equal(tenantA.media_url, '/media/t101-same-whatsapp-id.txt');
  assert.equal(tenantB.media_url, '/media/t202-same-whatsapp-id.txt');
  assert.equal(fs.readFileSync(path.join(tmpDir, 't101-same-whatsapp-id.txt'), 'utf8'), 'tenant-a');
  assert.equal(fs.readFileSync(path.join(tmpDir, 't202-same-whatsapp-id.txt'), 'utf8'), 'tenant-b');
});

test('saves base64 media and returns public metadata', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-media-'));
  const result = await saveMessageMedia({
    messageId: 'msg-1@c.us',
    media: {
      mimetype: 'text/plain',
      filename: 'nota.txt',
      data: Buffer.from('hello').toString('base64')
    },
    messageType: 'document',
    mediaRoot: tmpDir,
    publicBasePath: '/media'
  });

  assert.equal(result.media_type, 'document');
  assert.equal(result.media_mimetype, 'text/plain');
  assert.equal(result.media_filename, 'nota.txt');
  assert.equal(result.media_url, '/media/msg-1-c.us.txt');
  assert.equal(result.media_size, 5);
  assert.equal(fs.readFileSync(path.join(tmpDir, 'msg-1-c.us.txt'), 'utf8'), 'hello');
});

test('concurrent saves for the same message only expose one complete file', async t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-media-race-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const buffers = Array.from({ length: 16 }, (_, index) => Buffer.from(
    `writer-${index}:` + String.fromCharCode(65 + index).repeat(512 * 1024 + index * 997)
  ));

  await Promise.all(buffers.map((buffer, index) => saveMessageMedia({
    messageId: 'same-message',
    media: {
      mimetype: 'text/plain',
      filename: `writer-${index}.txt`,
      data: buffer.toString('base64')
    },
    messageType: 'document',
    mediaRoot: tmpDir
  })));

  const stored = fs.readFileSync(path.join(tmpDir, 'same-message.txt'));
  assert.ok(buffers.some(buffer => buffer.equals(stored)), 'stored file must match one complete writer');
  assert.deepEqual(fs.readdirSync(tmpDir), ['same-message.txt']);
});

test('cleans its temporary file and preserves the destination when rename fails', async t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-media-cleanup-'));
  const destination = path.join(tmpDir, 'cleanup-message.txt');
  const previousContent = 'previous complete content';
  const replacementContent = 'replacement complete content';
  const originalRename = fsPromises.rename;
  let tempPath;

  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  fs.writeFileSync(destination, previousContent);

  fsPromises.rename = async (source, target) => {
    tempPath = source;
    assert.equal(target, destination);
    assert.equal(path.dirname(source), tmpDir);
    assert.match(path.basename(source), /^\.cleanup-message\.txt\..+\.tmp$/);
    assert.equal(fs.readFileSync(source, 'utf8'), replacementContent);

    const error = new Error('simulated rename failure');
    error.code = 'EIO';
    throw error;
  };

  try {
    await assert.rejects(
      () => saveMessageMedia({
        messageId: 'cleanup-message',
        media: {
          mimetype: 'text/plain',
          filename: 'cleanup-message.txt',
          data: Buffer.from(replacementContent).toString('base64')
        },
        messageType: 'document',
        mediaRoot: tmpDir
      }),
      /simulated rename failure/
    );
  } finally {
    fsPromises.rename = originalRename;
  }

  assert.ok(tempPath, 'rename must receive the temporary file');
  assert.equal(fs.existsSync(tempPath), false);
  assert.equal(fs.readFileSync(destination, 'utf8'), previousContent);
  assert.deepEqual(fs.readdirSync(tmpDir), ['cleanup-message.txt']);
});

test('rejects executable html uploaded as media', () => {
  assert.throws(
    () => validateMediaForStorage({
      mimetype: 'text/html',
      filename: 'x.html',
      data: Buffer.from('<script>alert(1)</script>').toString('base64')
    }),
    /Tipo de arquivo nao permitido/
  );
});

test('rejects media with a spoofed mimetype', () => {
  assert.throws(
    () => validateMediaForStorage({
      mimetype: 'image/png',
      filename: 'foto.png',
      data: Buffer.from('<html>fake png</html>').toString('base64')
    }),
    /Assinatura de arquivo invalida/
  );
});

test('saveMessageMedia validates attachments before writing them', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-media-blocked-'));

  await assert.rejects(
    () => saveMessageMedia({
      messageId: 'bad-1',
      media: {
        mimetype: 'image/png',
        filename: 'bad.png',
        data: Buffer.from('<svg onload=alert(1)>').toString('base64')
      },
      messageType: 'image',
      mediaRoot: tmpDir
    }),
    /Assinatura de arquivo invalida/
  );
  assert.equal(fs.readdirSync(tmpDir).length, 0);
});

test('rejects oversized inbound media before writing it', async t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-media-size-limit-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  await assert.rejects(
    () => saveMessageMedia({
      messageId: 'oversized',
      namespace: 1,
      media: {
        mimetype: 'text/plain',
        filename: 'oversized.txt',
        data: Buffer.from('12345').toString('base64')
      },
      messageType: 'document',
      mediaRoot: tmpDir,
      storageLimits: {
        maxInboundBytes: 4,
        tenantQuotaBytes: 1024,
        globalQuotaBytes: 2048,
        minFreeBytes: 1
      }
    }),
    error => error.code === 'MEDIA_TOO_LARGE' && error.statusCode === 507
  );
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

test('enforces per-tenant and global media quotas without leaving partial files', async t => {
  const tenantRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-media-tenant-quota-'));
  const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-media-global-quota-'));
  t.after(() => fs.rmSync(tenantRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(globalRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tenantRoot, 't7-existing.txt'), '1234567890');
  fs.writeFileSync(path.join(globalRoot, 't8-existing.txt'), '1234567890');

  const media = {
    mimetype: 'text/plain',
    filename: 'next.txt',
    data: Buffer.from('x').toString('base64')
  };
  await assert.rejects(
    () => saveMessageMedia({
      messageId: 'tenant-next',
      namespace: 7,
      media,
      messageType: 'document',
      mediaRoot: tenantRoot,
      storageLimits: {
        maxInboundBytes: 100,
        tenantQuotaBytes: 10,
        globalQuotaBytes: 100,
        minFreeBytes: 1
      }
    }),
    error => error.code === 'TENANT_MEDIA_QUOTA_REACHED'
  );
  await assert.rejects(
    () => saveMessageMedia({
      messageId: 'global-next',
      namespace: 8,
      media,
      messageType: 'document',
      mediaRoot: globalRoot,
      storageLimits: {
        maxInboundBytes: 100,
        tenantQuotaBytes: 100,
        globalQuotaBytes: 10,
        minFreeBytes: 1
      }
    }),
    error => error.code === 'MEDIA_GLOBAL_QUOTA_REACHED'
  );
  assert.deepEqual(fs.readdirSync(tenantRoot), ['t7-existing.txt']);
  assert.deepEqual(fs.readdirSync(globalRoot), ['t8-existing.txt']);
});

test('preserves the configured disk reserve when storing media', async t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-media-disk-reserve-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  await assert.rejects(
    () => saveMessageMedia({
      messageId: 'no-space',
      namespace: 9,
      media: {
        mimetype: 'text/plain',
        filename: 'no-space.txt',
        data: Buffer.from('safe').toString('base64')
      },
      messageType: 'document',
      mediaRoot: tmpDir,
      storageLimits: {
        maxInboundBytes: 100,
        tenantQuotaBytes: 100,
        globalQuotaBytes: 100,
        minFreeBytes: Number.MAX_SAFE_INTEGER
      }
    }),
    error => error.code === 'MEDIA_DISK_RESERVE_REACHED'
  );
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

test('removes only a proven tenant media file and rejects traversal or cross-tenant cleanup', t => {
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-media-remove-'));
  t.after(() => fs.rmSync(mediaRoot, { recursive: true, force: true }));
  const ownFilename = 't41-message-1.webp';
  const otherFilename = 't42-message-1.webp';
  fs.writeFileSync(path.join(mediaRoot, ownFilename), 'own');
  fs.writeFileSync(path.join(mediaRoot, otherFilename), 'other');

  assert.equal(
    resolveStoredTenantMediaPath({ mediaUrl: `/media/${ownFilename}`, mediaRoot, namespace: 41 }).filename,
    ownFilename
  );
  assert.equal(
    resolveStoredTenantMediaPath({ mediaUrl: `/media/${otherFilename}`, mediaRoot, namespace: 41 }),
    null
  );
  assert.equal(
    removeStoredTenantMediaSync({ mediaUrl: '/media/../outside.webp', mediaRoot, namespace: 41 }),
    false
  );
  assert.equal(
    removeStoredTenantMediaSync({ mediaUrl: `/media/${otherFilename}`, mediaRoot, namespace: 41 }),
    false
  );
  assert.equal(
    removeStoredTenantMediaSync({ mediaUrl: `/media/${ownFilename}`, mediaRoot, namespace: 41 }),
    true
  );
  assert.equal(fs.existsSync(path.join(mediaRoot, ownFilename)), false);
  assert.equal(fs.readFileSync(path.join(mediaRoot, otherFilename), 'utf8'), 'other');
});
