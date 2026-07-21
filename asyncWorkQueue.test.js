const test = require('node:test');
const assert = require('node:assert/strict');

const { PartitionedWorkQueue } = require('./asyncWorkQueue');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('limits concurrency independently for each partition', async () => {
  const queue = new PartitionedWorkQueue({ concurrency: 2, maxPending: 10 });
  const gate = deferred();
  const active = new Map();
  const maximumActive = new Map();
  let maximumTotalActive = 0;

  const taskFor = partition => async () => {
    active.set(partition, (active.get(partition) || 0) + 1);
    maximumActive.set(
      partition,
      Math.max(maximumActive.get(partition) || 0, active.get(partition))
    );
    maximumTotalActive = Math.max(
      maximumTotalActive,
      [...active.values()].reduce((sum, value) => sum + value, 0)
    );
    await gate.promise;
    active.set(partition, active.get(partition) - 1);
  };

  for (let index = 0; index < 3; index += 1) {
    assert.equal(queue.enqueue('tenant-a', `a-${index}`, taskFor('tenant-a')), true);
    assert.equal(queue.enqueue('tenant-b', `b-${index}`, taskFor('tenant-b')), true);
  }

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.getStats('tenant-a').active, 2);
  assert.equal(queue.getStats('tenant-b').active, 2);
  assert.equal(maximumTotalActive, 4);

  gate.resolve();
  assert.equal(await queue.drain(500), true);
  assert.deepEqual(maximumActive, new Map([
    ['tenant-a', 2],
    ['tenant-b', 2]
  ]));
  assert.deepEqual(queue.getStats(), {
    active: 0,
    pending: 0,
    processed: 6,
    failed: 0,
    rejected: 0
  });
});

test('deduplicates work while a key is pending or active and accepts it again afterwards', async () => {
  const queue = new PartitionedWorkQueue({ concurrency: 1 });
  const gate = deferred();
  let executions = 0;
  const task = async () => {
    executions += 1;
    await gate.promise;
  };

  assert.equal(queue.enqueue('tenant-a', 'message-1', task), true);
  assert.equal(queue.enqueue('tenant-a', 'message-1', task), false);
  gate.resolve();
  assert.equal(await queue.drain(500), true);

  assert.equal(queue.enqueue('tenant-a', 'message-1', async () => {
    executions += 1;
  }), true);
  assert.equal(await queue.drain(500), true);
  assert.equal(executions, 2);
  assert.equal(queue.getStats('tenant-a').processed, 2);
});

test('rejects overflow without dropping work already accepted', async () => {
  const queue = new PartitionedWorkQueue({ concurrency: 1, maxPending: 2 });
  const gate = deferred();
  const completed = [];

  assert.equal(queue.enqueue('tenant-a', 'active', async () => {
    await gate.promise;
    completed.push('active');
  }), true);
  assert.equal(queue.enqueue('tenant-a', 'pending-1', async () => {
    completed.push('pending-1');
  }), true);
  assert.equal(queue.enqueue('tenant-a', 'pending-2', async () => {
    completed.push('pending-2');
  }), true);
  assert.equal(queue.enqueue('tenant-a', 'rejected', async () => {
    completed.push('rejected');
  }), false);

  assert.deepEqual(queue.getStats('tenant-a'), {
    active: 1,
    pending: 2,
    processed: 0,
    failed: 0,
    rejected: 1
  });
  gate.resolve();
  assert.equal(await queue.drain(500), true);
  assert.deepEqual(completed, ['active', 'pending-1', 'pending-2']);
  assert.equal(queue.getStats('tenant-a').processed, 3);
});

test('contains task failures, reports their context, and continues the partition', async () => {
  const errors = [];
  const queue = new PartitionedWorkQueue({
    concurrency: 1,
    onTaskError: (error, context) => errors.push({ error, context })
  });
  let followingTaskRan = false;

  assert.equal(queue.enqueue('tenant-a', 'bad-message', async () => {
    throw new Error('falha controlada');
  }, { conversationId: 91 }), true);
  assert.equal(queue.enqueue('tenant-a', 'good-message', async () => {
    followingTaskRan = true;
  }), true);

  assert.equal(await queue.drain(500), true);
  assert.equal(followingTaskRan, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error.message, /falha controlada/);
  assert.deepEqual(errors[0].context, {
    partitionKey: 'tenant-a',
    dedupeKey: 'bad-message',
    metadata: { conversationId: 91 }
  });
  assert.deepEqual(queue.getStats('tenant-a'), {
    active: 0,
    pending: 0,
    processed: 1,
    failed: 1,
    rejected: 0
  });
});

test('drain distinguishes timeout from a queue that became idle', async () => {
  const queue = new PartitionedWorkQueue({ concurrency: 1 });
  assert.equal(queue.enqueue('tenant-a', 'slow', async () => {
    await delay(40);
  }), true);

  assert.equal(await queue.drain(5), false);
  assert.equal(queue.isIdle(), false);
  assert.equal(await queue.drain(500), true);
  assert.equal(queue.isIdle(), true);
});

test('discarding a deleted tenant cancels pending work and permanently blocks resurrection', async () => {
  const queue = new PartitionedWorkQueue({ concurrency: 1 });
  const gate = deferred();
  const completed = [];

  assert.equal(queue.enqueue(11, 'active', async () => {
    await gate.promise;
    completed.push('tenant-11-active');
  }), true);
  assert.equal(queue.enqueue(11, 'pending', async () => completed.push('tenant-11-pending')), true);
  assert.equal(queue.enqueue(22, 'same-id', async () => completed.push('tenant-22')), true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(queue.discardPartition(11), 1);
  assert.equal(queue.enqueue(11, 'late-event', async () => completed.push('tenant-11-late')), false);
  gate.resolve();
  assert.equal(await queue.drain(500), true);

  assert.deepEqual(new Set(completed), new Set(['tenant-11-active', 'tenant-22']));
  assert.deepEqual(queue.getStats(11), {
    active: 0,
    pending: 0,
    processed: 0,
    failed: 0,
    rejected: 0
  });
});

test('close stops admission but drains accepted work unless discard is requested', async () => {
  const queue = new PartitionedWorkQueue({ concurrency: 1 });
  const gate = deferred();
  const completed = [];

  assert.equal(queue.enqueue('tenant-a', 'active', async () => {
    await gate.promise;
    completed.push('active');
  }), true);
  assert.equal(queue.enqueue('tenant-a', 'pending', async () => {
    completed.push('pending');
  }), true);
  queue.close();
  assert.equal(queue.enqueue('tenant-a', 'late', async () => {}), false);
  gate.resolve();
  assert.equal(await queue.drain(500), true);
  assert.deepEqual(completed, ['active', 'pending']);

  const discardedQueue = new PartitionedWorkQueue({ concurrency: 1 });
  const secondGate = deferred();
  assert.equal(discardedQueue.enqueue('tenant-b', 'active', () => secondGate.promise), true);
  assert.equal(discardedQueue.enqueue('tenant-b', 'pending', async () => {}), true);
  discardedQueue.close({ discardPending: true });
  assert.equal(discardedQueue.getStats().pending, 0);
  secondGate.resolve();
  assert.equal(await discardedQueue.drain(500), true);
});
