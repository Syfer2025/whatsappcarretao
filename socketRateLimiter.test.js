const test = require('node:test');
const assert = require('node:assert/strict');

const { createSocketRateLimiter } = require('./socketRateLimiter');

test('limits socket auth attempts per key and resets after the window', () => {
  let currentTime = 1000;
  const attempts = new Map();
  const limiter = createSocketRateLimiter({
    attempts,
    windowMs: 100,
    maxAttempts: 2,
    now: () => currentTime
  });

  assert.equal(limiter.isLimited('ip-a'), false);
  assert.equal(limiter.isLimited('ip-a'), false);
  assert.equal(limiter.isLimited('ip-a'), true);
  assert.equal(attempts.get('ip-a').count, 3);

  currentTime = 1100;
  assert.equal(limiter.isLimited('ip-a'), false);
  assert.equal(attempts.get('ip-a').count, 1);
});

test('sweeps expired socket auth attempt records while checking new keys', () => {
  let currentTime = 0;
  const attempts = new Map();
  const limiter = createSocketRateLimiter({
    attempts,
    windowMs: 100,
    maxAttempts: 10,
    now: () => currentTime
  });

  limiter.isLimited('ip-a');
  limiter.isLimited('ip-b');
  assert.equal(attempts.size, 2);

  currentTime = 101;
  limiter.isLimited('ip-c');

  assert.equal(attempts.has('ip-a'), false);
  assert.equal(attempts.has('ip-b'), false);
  assert.equal(attempts.has('ip-c'), true);
  assert.equal(attempts.size, 1);
});
