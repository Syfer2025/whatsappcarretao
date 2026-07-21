const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { createBackup } = require('./scripts/backup');
const { prepareRestore } = require('./scripts/prepare-restore');
const { verifyBackup } = require('./scripts/verify-backup');

function createDatabase(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const database = new Database(filename);
  database.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  database.prepare('INSERT INTO records (value) VALUES (?)').run(value);
  database.close();
}

test('prepares and independently verifies a complete restore payload without touching the source', async (t) => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-restore-source-'));
  const destinationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-restore-ready-'));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(destinationRoot, { recursive: true, force: true }));

  createDatabase(path.join(sourceRoot, 'data', 'master.db'), 'master');
  createDatabase(path.join(sourceRoot, 'data', 'data_7.db'), 'tenant');
  createDatabase(path.join(sourceRoot, 'legacy.db'), 'legacy-root');
  fs.mkdirSync(path.join(sourceRoot, 'media'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'media', 'photo.jpg'), 'photo');
  fs.mkdirSync(path.join(sourceRoot, '.wwebjs_auth', 'tenant_7'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, '.wwebjs_auth', 'tenant_7', 'session.json'), 'credential');

  const backup = await createBackup({
    rootDir: sourceRoot,
    retention: 1,
    freeMarginMb: 0,
    getAvailableBytes: async () => Number.MAX_SAFE_INTEGER,
    logger: null,
  });
  const sourceManifestBefore = fs.readFileSync(path.join(backup.path, 'manifest.json'));

  const prepared = await prepareRestore({
    snapshotPath: backup.path,
    destinationRoot,
    logger: null,
  });

  assert.equal(path.basename(prepared.path), path.basename(backup.path));
  assert.equal((await verifyBackup(prepared.path)).databases, 3);
  assert.equal(fs.readFileSync(path.join(prepared.path, 'media', 'photo.jpg'), 'utf8'), 'photo');
  assert.equal(
    fs.readFileSync(path.join(prepared.path, '.wwebjs_auth', 'tenant_7', 'session.json'), 'utf8'),
    'credential',
  );
  const legacy = new Database(path.join(prepared.path, 'legacy.db'), {
    readonly: true,
    fileMustExist: true,
  });
  assert.equal(legacy.prepare('SELECT value FROM records').get().value, 'legacy-root');
  legacy.close();
  assert.deepEqual(fs.readFileSync(path.join(backup.path, 'manifest.json')), sourceManifestBefore);
  assert.equal(fs.statSync(prepared.path).mode & 0o077, 0);

  await assert.rejects(
    prepareRestore({ snapshotPath: backup.path, destinationRoot, logger: null }),
    /Destino de restore ja existe/,
  );
});

test('refuses corrupt snapshots and overlapping restore destinations', async (t) => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-restore-refuse-'));
  const destinationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-restore-refuse-ready-'));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(destinationRoot, { recursive: true, force: true }));
  createDatabase(path.join(sourceRoot, 'legacy.db'), 'clean');
  const backup = await createBackup({
    rootDir: sourceRoot,
    retention: 1,
    freeMarginMb: 0,
    getAvailableBytes: async () => Number.MAX_SAFE_INTEGER,
    logger: null,
  });

  await assert.rejects(
    prepareRestore({
      snapshotPath: backup.path,
      destinationRoot: path.join(backup.path, 'restore-here'),
      logger: null,
    }),
    /nao pode conter nem ficar dentro/,
  );

  fs.appendFileSync(path.join(backup.path, 'legacy.db'), 'corruption');
  await assert.rejects(
    prepareRestore({ snapshotPath: backup.path, destinationRoot, logger: null }),
    /Tamanho ou tipo inválido|SHA-256 invalido|integrity_check falhou/,
  );
  assert.equal(fs.readdirSync(destinationRoot).length, 0);
});
