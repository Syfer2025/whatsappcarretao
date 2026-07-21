const test = require('node:test');
const assert = require('node:assert/strict');

const { createAudioTranscodeLimiter } = require('./audioTranscoder');

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('globally bounds ffmpeg work and drains queued conversions in FIFO order', async () => {
  const limiter = createAudioTranscodeLimiter({ concurrency: 2, maxPending: 4, waitTimeoutMs: 1000 });
  const gate = deferred();
  let active = 0;
  let maximumActive = 0;
  const started = [];

  const jobs = [1, 2, 3, 4].map(id => limiter.run(async () => {
    started.push(id);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await gate.promise;
    active -= 1;
    return id;
  }));

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(limiter.getStats(), {
    active: 2,
    pending: 2,
    concurrency: 2,
    maxPending: 4
  });
  gate.resolve();
  assert.deepEqual(await Promise.all(jobs), [1, 2, 3, 4]);
  assert.equal(maximumActive, 2);
  assert.deepEqual(started, [1, 2, 3, 4]);
});

test('ffmpeg limiter applies queue backpressure and times out a waiting conversion', async () => {
  const limiter = createAudioTranscodeLimiter({ concurrency: 1, maxPending: 1, waitTimeoutMs: 10 });
  const gate = deferred();
  const active = limiter.run(() => gate.promise);
  const waiting = limiter.run(async () => 'never');
  await assert.rejects(
    limiter.run(async () => 'overflow'),
    error => error.code === 'AUDIO_TRANSCODE_QUEUE_FULL'
  );
  await assert.rejects(waiting, error => error.code === 'AUDIO_TRANSCODE_SLOT_TIMEOUT');
  gate.resolve();
  await active;
});
