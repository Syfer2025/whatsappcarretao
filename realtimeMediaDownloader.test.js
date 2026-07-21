const test = require('node:test');
const assert = require('node:assert/strict');

const { downloadRealtimeMediaWithRetry } = require('./realtimeMediaDownloader');

test('downloads realtime media immediately when the event object is ready', async () => {
  const media = { mimetype: 'image/webp', data: 'UklGRg==' };
  let lookups = 0;
  const result = await downloadRealtimeMediaWithRetry({
    message: { downloadMedia: async () => media },
    client: { getMessageById: async () => { lookups += 1; } },
    externalId: 'sticker-1',
    sleepFn: async () => {}
  });

  assert.equal(result.media, media);
  assert.equal(result.attempts, 1);
  assert.equal(lookups, 0);
});

test('refreshes a just-created sticker by external id before retrying', async () => {
  const delays = [];
  let initialDownloads = 0;
  let lookups = 0;
  const readyMedia = { mimetype: 'image/webp', data: 'UklGRg==' };
  const freshMessage = {
    type: 'sticker',
    downloadMedia: async () => readyMedia
  };

  const result = await downloadRealtimeMediaWithRetry({
    message: {
      type: 'sticker',
      downloadMedia: async () => {
        initialDownloads += 1;
        return null;
      }
    },
    client: {
      getMessageById: async externalId => {
        lookups += 1;
        assert.equal(externalId, 'sticker-delayed');
        return freshMessage;
      }
    },
    externalId: 'sticker-delayed',
    attempts: 4,
    baseDelayMs: 250,
    sleepFn: async delay => delays.push(delay)
  });

  assert.equal(result.media, readyMedia);
  assert.equal(result.message, freshMessage);
  assert.equal(result.attempts, 2);
  assert.equal(initialDownloads, 1);
  assert.equal(lookups, 1);
  assert.deepEqual(delays, [250]);
});

test('uses bounded exponential backoff and reports exhaustion without throwing', async () => {
  const delays = [];
  const failures = [];
  let downloads = 0;
  const message = {
    downloadMedia: async () => {
      downloads += 1;
      throw new Error('not ready');
    }
  };

  const result = await downloadRealtimeMediaWithRetry({
    message,
    client: { getMessageById: async () => message },
    externalId: 'sticker-missing',
    attempts: 4,
    baseDelayMs: 100,
    sleepFn: async delay => delays.push(delay),
    onAttemptFailure: (_err, context) => failures.push(context.attempt)
  });

  assert.equal(result.media, null);
  assert.equal(result.attempts, 4);
  assert.match(result.lastError.message, /not ready/);
  assert.equal(downloads, 4);
  assert.deepEqual(delays, [100, 200, 400]);
  assert.deepEqual(failures, [1, 2, 3, 4]);
});

test('does not overlap another Chromium download after the first one times out', async () => {
  let downloads = 0;
  let lookups = 0;
  const result = await downloadRealtimeMediaWithRetry({
    message: {
      downloadMedia: () => {
        downloads += 1;
        return new Promise(() => {});
      }
    },
    client: {
      getMessageById: async () => {
        lookups += 1;
        return null;
      }
    },
    externalId: 'sticker-timeout',
    attempts: 4,
    baseDelayMs: 0,
    downloadTimeoutMs: 5,
    sleepFn: async () => {}
  });

  assert.equal(result.media, null);
  assert.equal(result.attempts, 1);
  assert.equal(result.lastError.code, 'OPERATION_TIMEOUT');
  assert.equal(downloads, 1);
  assert.equal(lookups, 0);
});
