const test = require('node:test');
const assert = require('node:assert/strict');

const { createInboundMediaLimiter } = require('./inboundMediaLimiter');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

test('limits downloads globally and per tenant while releasing every slot', async () => {
  const limiter = createInboundMediaLimiter({
    globalConcurrency: 2,
    tenantConcurrency: 1,
    maxPending: 10,
    slotTimeoutMs: 1000
  });
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const started = [];
  let active = 0;
  let maxActive = 0;
  const tenantActive = new Map();
  const tenantMax = new Map();

  const operation = (tenantId, label, gate) => limiter.run(tenantId, async () => {
    started.push(label);
    active += 1;
    maxActive = Math.max(maxActive, active);
    tenantActive.set(tenantId, (tenantActive.get(tenantId) || 0) + 1);
    tenantMax.set(tenantId, Math.max(
      tenantMax.get(tenantId) || 0,
      tenantActive.get(tenantId)
    ));
    await gate.promise;
    active -= 1;
    tenantActive.set(tenantId, tenantActive.get(tenantId) - 1);
  });

  const jobs = [
    operation(1, '1a', gates[0]),
    operation(1, '1b', gates[1]),
    operation(2, '2a', gates[2]),
    operation(3, '3a', gates[3])
  ];
  await nextTurn();
  assert.deepEqual(started, ['1a', '2a']);
  assert.equal(limiter.getStats().active, 2);

  gates[0].resolve();
  await nextTurn();
  assert.deepEqual(started, ['1a', '2a', '1b']);
  gates[2].resolve();
  await nextTurn();
  assert.deepEqual(started, ['1a', '2a', '1b', '3a']);
  gates[1].resolve();
  gates[3].resolve();
  await Promise.all(jobs);

  assert.equal(maxActive, 2);
  assert.equal(tenantMax.get(1), 1);
  assert.equal(limiter.getStats().active, 0);
  assert.equal(limiter.getStats().pending, 0);
  assert.equal(await limiter.drain(50), true);
  limiter.close();
});

test('rotates busy tenants so a long import cannot starve another tenant', async () => {
  const limiter = createInboundMediaLimiter({
    globalConcurrency: 1,
    tenantConcurrency: 1,
    maxPending: 10,
    slotTimeoutMs: 1000
  });
  const gates = [deferred(), deferred(), deferred()];
  const started = [];
  const jobs = [
    limiter.run(1, async () => { started.push('1a'); await gates[0].promise; }),
    limiter.run(1, async () => { started.push('1b'); await gates[1].promise; }),
    limiter.run(1, async () => { started.push('1c'); }),
    limiter.run(2, async () => { started.push('2a'); await gates[2].promise; })
  ];
  await nextTurn();
  assert.deepEqual(started, ['1a']);

  gates[0].resolve();
  await nextTurn();
  assert.deepEqual(started, ['1a', '1b']);
  gates[1].resolve();
  await nextTurn();
  assert.deepEqual(started, ['1a', '1b', '2a']);
  gates[2].resolve();
  await Promise.all(jobs);
  assert.deepEqual(started, ['1a', '1b', '2a', '1c']);
});

test('applies queue backpressure and times out a waiting download', async () => {
  const limiter = createInboundMediaLimiter({
    globalConcurrency: 1,
    tenantConcurrency: 1,
    maxPending: 1,
    slotTimeoutMs: 20
  });
  const activeGate = deferred();
  const active = limiter.run(1, () => activeGate.promise);
  await nextTurn();

  const timedOut = assert.rejects(
    limiter.run(2, async () => {}),
    error => error.code === 'MEDIA_DOWNLOAD_SLOT_TIMEOUT'
  );
  await assert.rejects(
    limiter.run(3, async () => {}),
    error => error.code === 'MEDIA_DOWNLOAD_QUEUE_FULL'
  );
  // Keep a referenced timer alive; limiter wait timers are deliberately unref'd
  // so they never prevent a clean process shutdown.
  await new Promise(resolve => setTimeout(resolve, 30));
  await timedOut;

  activeGate.resolve();
  await active;
  assert.equal(await limiter.drain(50), true);
});

test('releases capacity after operation failure and rejects queued work on close', async () => {
  const limiter = createInboundMediaLimiter({
    globalConcurrency: 1,
    tenantConcurrency: 1,
    maxPending: 5,
    slotTimeoutMs: 1000
  });
  await assert.rejects(
    limiter.run(1, async () => { throw new Error('falha de download'); }),
    /falha de download/
  );
  assert.equal(limiter.getStats().active, 0);

  const gate = deferred();
  const active = limiter.run(1, () => gate.promise);
  await nextTurn();
  const queued = limiter.run(2, async () => {});
  limiter.close();
  await assert.rejects(queued, error => error.code === 'MEDIA_DOWNLOAD_LIMITER_CLOSED');
  gate.resolve();
  await active;
  assert.equal(await limiter.drain(50), true);
});
