const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSingleWriterLease, MIN_TTL_MS } = require('./singleWriterLease');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'single-writer-lease-'));
  const filename = path.join(directory, 'master.db');
  const firstDb = new Database(filename);
  firstDb.pragma('busy_timeout = 5000');
  const secondDb = new Database(filename);
  secondDb.pragma('busy_timeout = 5000');
  return {
    directory,
    firstDb,
    secondDb,
    close() {
      firstDb.close();
      secondDb.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('only one production writer can hold a live lease', () => {
  const state = fixture();
  try {
    const first = createSingleWriterLease({
      db: state.firstDb,
      owner: 'instance-a',
      ttlMs: MIN_TTL_MS,
      heartbeatMs: 10_000,
      startHeartbeat: false
    });
    assert.throws(
      () => createSingleWriterLease({
        db: state.secondDb,
        owner: 'instance-b',
        ttlMs: MIN_TTL_MS,
        heartbeatMs: 10_000,
        startHeartbeat: false
      }),
      error => error.code === 'SINGLE_WRITER_LEASE_HELD' && /Outra instancia/.test(error.message)
    );
    assert.equal(first.release(), true);
  } finally {
    state.close();
  }
});

test('a new writer can take over only after the previous lease expires', () => {
  const state = fixture();
  try {
    const first = createSingleWriterLease({
      db: state.firstDb,
      owner: 'expired-instance',
      ttlMs: MIN_TTL_MS,
      heartbeatMs: 10_000,
      startHeartbeat: false
    });
    state.firstDb.prepare(`
      UPDATE runtime_leases SET expires_at_ms = 0 WHERE name = ? AND owner = ?
    `).run(first.name, first.owner);
    const replacement = createSingleWriterLease({
      db: state.secondDb,
      owner: 'replacement-instance',
      ttlMs: MIN_TTL_MS,
      heartbeatMs: 10_000,
      startHeartbeat: false
    });
    assert.equal(replacement.owner, 'replacement-instance');
    assert.equal(first.heartbeat(), false);
    assert.equal(first.isLost(), true);
    assert.equal(first.release(), false);
    assert.equal(replacement.release(), true);
  } finally {
    state.close();
  }
});

test('graceful release immediately makes the lease available', () => {
  const state = fixture();
  try {
    const first = createSingleWriterLease({
      db: state.firstDb,
      owner: 'graceful-instance',
      ttlMs: MIN_TTL_MS,
      heartbeatMs: 10_000,
      startHeartbeat: false
    });
    assert.equal(first.release(), true);
    assert.equal(first.release(), false);
    const second = createSingleWriterLease({
      db: state.secondDb,
      owner: 'next-instance',
      ttlMs: MIN_TTL_MS,
      heartbeatMs: 10_000,
      startHeartbeat: false
    });
    assert.equal(second.release(), true);
  } finally {
    state.close();
  }
});

test('lease is disabled outside production without touching the database', () => {
  const db = new Database(':memory:');
  assert.equal(createSingleWriterLease({ db, enabled: false }), null);
  assert.equal(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_leases'").get(),
    undefined
  );
  db.close();
});
