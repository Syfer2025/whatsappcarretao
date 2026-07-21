const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  PRODUCTION_WRITER_LEASE_LOST_EVENT,
  notifyProductionWriterLeaseLost
} = require('./productionWriterBootstrap');

function fakeProcess() {
  const processRef = new EventEmitter();
  processRef.pid = 4242;
  processRef.exitCode = 0;
  processRef.stderr = { write() {} };
  processRef.kills = [];
  processRef.kill = (pid, signal) => processRef.kills.push({ pid, signal });
  return processRef;
}

test('writer lease loss invokes the fatal server hook and never signals a graceful exit', () => {
  const processRef = fakeProcess();
  const expected = new Error('lease lost');
  let received = null;
  processRef.once(PRODUCTION_WRITER_LEASE_LOST_EVENT, error => { received = error; });

  assert.equal(notifyProductionWriterLeaseLost(expected, processRef), true);
  assert.equal(received, expected);
  assert.equal(processRef.exitCode, 1);
  assert.deepEqual(processRef.kills, []);
});

test('standalone lease holder falls back to SIGTERM but preserves non-zero exit code', () => {
  const processRef = fakeProcess();
  assert.equal(notifyProductionWriterLeaseLost(new Error('lease lost'), processRef), false);
  assert.equal(processRef.exitCode, 1);
  assert.deepEqual(processRef.kills, [{ pid: 4242, signal: 'SIGTERM' }]);
});
