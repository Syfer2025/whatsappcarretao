const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const Database = require('better-sqlite3');

const { createTenantScopedProxy } = require('./tenantDbProxy');

test('database proxy fails closed without a tenant context and preserves safe metadata', () => {
  const storage = new AsyncLocalStorage();
  const fallback = {
    prepare: () => 'default',
    tenantCtx: storage,
    defaultDb: { name: 'master' }
  };
  const proxy = createTenantScopedProxy(fallback, storage);

  assert.throws(() => proxy.prepare('SELECT 1'), /Contexto de tenant obrigatório/);
  const tenantDb = { prepare: () => 'tenant-a' };
  const result = storage.run({ tenantId: 101, db: tenantDb }, () => ({
    query: proxy.prepare('SELECT 1'),
    tenantCtx: proxy.tenantCtx,
    defaultDb: proxy.defaultDb
  }));
  assert.equal(result.query, 'tenant-a');
  assert.equal(result.tenantCtx, storage);
  assert.deepEqual(result.defaultDb, { name: 'master' });
  assert.throws(
    () => storage.run({ db: tenantDb }, () => proxy.prepare('SELECT 1')),
    /Contexto de tenant obrigatório/
  );
});

function tenantDatabase(label) {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  database.prepare('INSERT INTO records (id, value) VALUES (1, ?)').run(label);
  return database;
}

test('database proxy preserves tenant ownership through awaits and simultaneous equal ids', async t => {
  const storage = new AsyncLocalStorage();
  const fallback = tenantDatabase('platform');
  const tenantA = tenantDatabase('tenant-a');
  const tenantB = tenantDatabase('tenant-b');
  const proxy = createTenantScopedProxy(fallback, storage);
  t.after(() => {
    fallback.close();
    tenantA.close();
    tenantB.close();
  });

  const readRepeatedly = (tenantId, database, expected, delayMs) => storage.run(
    { tenantId, db: database },
    async () => {
      const preparedBeforeAwait = proxy.prepare('SELECT value FROM records WHERE id = ?');
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, delayMs));
      const values = [];
      for (let index = 0; index < 25; index += 1) {
        await new Promise(resolve => setImmediate(resolve));
        values.push(proxy.prepare('SELECT value FROM records WHERE id = 1').get().value);
      }
      values.push(preparedBeforeAwait.get(1).value);
      proxy.transaction(() => {
        assert.equal(proxy.prepare('SELECT value FROM records WHERE id = 1').get().value, expected);
      })();
      return values;
    }
  );

  const [valuesA, valuesB] = await Promise.all([
    readRepeatedly(101, tenantA, 'tenant-a', 5),
    readRepeatedly(202, tenantB, 'tenant-b', 0)
  ]);

  assert.deepEqual(new Set(valuesA), new Set(['tenant-a']));
  assert.deepEqual(new Set(valuesB), new Set(['tenant-b']));
  assert.equal(fallback.prepare('SELECT value FROM records WHERE id = 1').get().value, 'platform');
});

test('captured database methods, statements and transactions cannot cross tenant contexts', () => {
  const storage = new AsyncLocalStorage();
  const fallback = tenantDatabase('platform');
  const tenantA = tenantDatabase('tenant-a');
  const tenantB = tenantDatabase('tenant-b');
  const proxy = createTenantScopedProxy(fallback, storage);

  let capturedPrepare;
  let capturedStatement;
  let capturedTransaction;
  let capturedIterator;
  storage.run({ tenantId: 101, db: tenantA }, () => {
    capturedPrepare = proxy.prepare;
    capturedStatement = proxy.prepare('SELECT value FROM records WHERE id = 1');
    capturedTransaction = proxy.transaction(() => proxy.prepare('SELECT 1').get());
    assert.equal(capturedStatement.get().value, 'tenant-a');
    assert.equal(proxy.prepare('SELECT value FROM records').pluck().get(), 'tenant-a');
    capturedIterator = proxy.prepare('SELECT value FROM records').iterate();
  });

  assert.throws(() => capturedPrepare('SELECT 1'), /Contexto de tenant obrigatório/);
  assert.throws(() => capturedStatement.get(), /Contexto de tenant obrigatório/);
  assert.throws(() => capturedTransaction(), /Contexto de tenant obrigatório/);
  assert.throws(() => capturedIterator.next(), /Contexto de tenant obrigatório/);

  storage.run({ tenantId: 202, db: tenantB }, () => {
    assert.throws(() => capturedPrepare('SELECT 1'), /Contexto de tenant obrigatório/);
    assert.throws(() => capturedStatement.get(), /Contexto de tenant obrigatório/);
    assert.throws(() => capturedTransaction(), /Contexto de tenant obrigatório/);
    assert.throws(() => capturedIterator.next(), /Contexto de tenant obrigatório/);
    assert.equal(proxy.prepare('SELECT value FROM records WHERE id = 1').get().value, 'tenant-b');
  });

  storage.run({ tenantId: 101, db: tenantA }, () => capturedIterator.return());
  fallback.close();
  tenantA.close();
  tenantB.close();
});
