const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  classifyMedia,
  extensionForMime,
  getSafeMediaFilename,
  saveMessageMedia
} = require('./mediaStorage');

test('classifies common WhatsApp media mimetypes', () => {
  assert.equal(classifyMedia('image/jpeg'), 'image');
  assert.equal(classifyMedia('audio/ogg; codecs=opus'), 'audio');
  assert.equal(classifyMedia('video/mp4'), 'video');
  assert.equal(classifyMedia('application/pdf'), 'document');
  assert.equal(classifyMedia('image/webp', 'sticker'), 'sticker');
});

test('builds safe media filenames with useful extensions', () => {
  assert.equal(extensionForMime('image/jpeg'), 'jpg');
  assert.equal(extensionForMime('audio/ogg; codecs=opus'), 'ogg');
  assert.equal(extensionForMime('application/pdf'), 'pdf');

  assert.equal(getSafeMediaFilename('abc/123@lid', 'image/jpeg'), 'abc-123-lid.jpg');
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
