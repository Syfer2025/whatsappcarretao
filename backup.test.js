const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { createBackup, sha256File } = require('./scripts/backup');
const { verifyBackup } = require('./scripts/verify-backup');
const { ensureSchema } = require('./schema');

function createWalDatabase(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO records (value) VALUES (?)').run(value);
  return db;
}

function createApplicationFixture(rootDir, { liveLease = false, directoryMismatch = false } = {}) {
  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const master = new Database(path.join(dataDir, 'master.db'));
  master.pragma('foreign_keys = ON');
  master.exec(`
    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE
    );
    CREATE TABLE user_directory (
      username TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      role TEXT NOT NULL
    );
    CREATE TABLE support_threads (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id)
    );
    CREATE TABLE support_messages (
      id INTEGER PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES support_threads(id),
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      media_url TEXT
    );
    CREATE TABLE runtime_leases (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      heartbeat_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
    INSERT INTO tenants (id, name, slug) VALUES (7, 'Tenant Seven', 'tenant-seven');
    INSERT INTO support_threads (id, tenant_id) VALUES (10, 7);
    INSERT INTO support_messages (id, thread_id, tenant_id, media_url)
    VALUES (11, 10, 7, '/support-media/t7-support.pdf');
  `);
  master
    .prepare('INSERT INTO user_directory (username, tenant_id, role) VALUES (?, 7, ?)')
    .run(directoryMismatch ? 'missing-admin@example.test' : 'admin7@example.test', 'admin');
  if (liveLease) {
    master
      .prepare('INSERT INTO runtime_leases (name, owner, heartbeat_at_ms, expires_at_ms) VALUES (?, ?, ?, ?)')
      .run('whatsa-production-writer', 'test-runtime-owner', Date.now(), Date.now() + 90_000);
  }
  master.close();

  const platform = new Database(path.join(dataDir, 'data.db'));
  ensureSchema(platform);
  platform
    .prepare('INSERT INTO admins (name, username, password, super_admin) VALUES (?, ?, ?, 1)')
    .run('Platform', 'platform@example.test', 'hash');
  platform.close();

  const tenant = new Database(path.join(dataDir, 'data_7.db'));
  ensureSchema(tenant);
  tenant
    .prepare('INSERT INTO admins (name, username, password) VALUES (?, ?, ?)')
    .run('Admin Seven', 'admin7@example.test', 'hash');
  const messageMedia = Buffer.from('tenant-photo');
  tenant
    .prepare(
      "INSERT INTO messages (from_type, content, media_url, media_size, media_sha256) VALUES ('contact', 'photo', '/media/t7-message.jpg', ?, ?)",
    )
    .run(messageMedia.length, crypto.createHash('sha256').update(messageMedia).digest('hex'));
  tenant.close();

  fs.mkdirSync(path.join(rootDir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'media', 't7-message.jpg'), 'tenant-photo');
  fs.writeFileSync(path.join(rootDir, 'media', 't7-support.pdf'), 'support-document');
  fs.mkdirSync(path.join(rootDir, '.wwebjs_auth', 'tenant_7'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.wwebjs_auth', 'tenant_7', 'session.json'), 'auth-state');
}

function addSecondApplicationTenant(rootDir) {
  const master = new Database(path.join(rootDir, 'data', 'master.db'));
  master.exec(`
    INSERT INTO tenants (id, name, slug) VALUES (8, 'Tenant Eight', 'tenant-eight');
    INSERT INTO user_directory (username, tenant_id, role)
    VALUES ('admin8@example.test', 8, 'admin');
  `);
  master.close();
  const tenant = new Database(path.join(rootDir, 'data', 'data_8.db'));
  ensureSchema(tenant);
  tenant
    .prepare('INSERT INTO admins (name, username, password) VALUES (?, ?, ?)')
    .run('Admin Eight', 'admin8@example.test', 'hash');
  tenant.close();
}

test('creates consistent SQLite backups, copies tenant assets and enforces retention without secrets', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-backup-source-'));
  const backupRoot = path.join(rootDir, 'backups');
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const openDatabases = [
    createWalDatabase(path.join(rootDir, 'data', 'master.db'), 'master-row'),
    createWalDatabase(path.join(rootDir, 'data', 'data_7.db'), 'tenant-row'),
    createWalDatabase(path.join(rootDir, 'legacy.db'), 'legacy-row'),
  ];
  t.after(() => openDatabases.forEach((db) => db.close()));

  fs.mkdirSync(path.join(rootDir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'media', 'photo.jpg'), 'media-content');
  fs.mkdirSync(path.join(rootDir, '.wwebjs_auth', 'tenant_7', 'session'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.wwebjs_auth', 'tenant_7', 'session', 'credential.json'), 'wa-secret');
  fs.symlinkSync('runtime-lock-target', path.join(rootDir, '.wwebjs_auth', 'tenant_7', 'session', 'SingletonLock'));
  fs.writeFileSync(path.join(rootDir, '.env'), 'JWT_SECRET=super-secret\n');

  const first = await createBackup({
    rootDir,
    backupRoot,
    retention: 2,
    now: () => new Date('2026-07-10T10:00:00.000Z'),
    randomUUID: () => '11111111-1111-1111-1111-111111111111',
    logger: null,
  });

  assert.equal(first.manifest.databases.length, 3);
  assert.deepEqual(first.manifest.databases.map((database) => database.path).sort(), [
    'data/data_7.db',
    'data/master.db',
    'legacy.db',
  ]);
  for (const database of first.manifest.databases) {
    assert.match(database.sha256, /^[a-f0-9]{64}$/);
    const backupDb = new Database(path.join(first.path, database.path), { readonly: true });
    assert.equal(backupDb.prepare('SELECT COUNT(*) AS count FROM records').get().count, 1);
    backupDb.close();
  }
  assert.equal(fs.readFileSync(path.join(first.path, 'media', 'photo.jpg'), 'utf8'), 'media-content');
  assert.equal(
    fs.readFileSync(path.join(first.path, '.wwebjs_auth', 'tenant_7', 'session', 'credential.json'), 'utf8'),
    'wa-secret',
  );
  assert.equal(fs.existsSync(path.join(first.path, '.env')), false);
  const manifestText = fs.readFileSync(path.join(first.path, 'manifest.json'), 'utf8');
  assert.doesNotMatch(manifestText, /super-secret|wa-secret|JWT_SECRET/);
  assert.match(first.manifest.consistency.databases, /better-sqlite3/);
  assert.equal(first.manifest.consistency.global.quiesced, false);
  assert.equal(first.manifest.consistency.global.relationalIntegrity, 'not-applicable');
  assert.match(first.manifest.assets.media.sha256, /^[a-f0-9]{64}$/);
  assert.match(first.manifest.assets.whatsappAuth.sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.manifest.assets.whatsappAuth.sourceSkippedSpecialFiles, 1);
  assert.equal(fs.existsSync(path.join(first.path, '.wwebjs_auth', 'tenant_7', 'session', 'SingletonLock')), false);
  assert.equal(first.manifest.formatVersion, 2);
  assert.equal((await verifyBackup(first.path)).databases, 3);

  fs.appendFileSync(path.join(first.path, 'media', 'photo.jpg'), '-corrupted');
  await assert.rejects(verifyBackup(first.path), /Verificação de media falhou/);
  fs.writeFileSync(path.join(first.path, 'media', 'photo.jpg'), 'media-content');
  assert.equal((await verifyBackup(first.path)).databases, 3);

  fs.writeFileSync(path.join(first.path, 'data', 'master.db-wal'), 'unmanifested-sidecar');
  await assert.rejects(verifyBackup(first.path), /sidecar SQLite nao manifestado/);
  fs.rmSync(path.join(first.path, 'data', 'master.db-wal'));
  assert.equal((await verifyBackup(first.path)).databases, 3);

  const second = await createBackup({
    rootDir,
    backupRoot,
    retention: 2,
    now: () => new Date('2026-07-10T11:00:00.000Z'),
    randomUUID: () => '22222222-2222-2222-2222-222222222222',
    logger: null,
  });
  const third = await createBackup({
    rootDir,
    backupRoot,
    retention: 2,
    now: () => new Date('2026-07-10T12:00:00.000Z'),
    randomUUID: () => '33333333-3333-3333-3333-333333333333',
    logger: null,
  });

  assert.equal(fs.existsSync(first.path), false);
  assert.equal(fs.existsSync(second.path), true);
  assert.equal(fs.existsSync(third.path), true);
  assert.deepEqual(third.removed, [path.basename(first.path)]);
});

test('recovers a stale lock conservatively and rejects unsafe backup destinations', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-backup-lock-'));
  const backupRoot = path.join(rootDir, 'backups');
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const database = createWalDatabase(path.join(rootDir, 'data', 'master.db'), 'row');
  database.close();
  fs.mkdirSync(backupRoot, { recursive: true });
  const lockPath = path.join(backupRoot, '.backup.lock');
  fs.writeFileSync(lockPath, '{"pid":999999}\n');
  fs.utimesSync(lockPath, new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-01T00:00:00.000Z'));
  const staleStaging = path.join(backupRoot, '.backup-20260701T000000000Z-deadbeefcafe.tmp');
  fs.mkdirSync(staleStaging);
  fs.writeFileSync(path.join(staleStaging, 'partial'), 'incomplete');
  fs.utimesSync(staleStaging, new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-01T00:00:00.000Z'));

  const result = await createBackup({
    rootDir,
    backupRoot,
    lockStaleMs: 60_000,
    now: () => new Date('2026-07-10T13:00:00.000Z'),
    randomUUID: () => '44444444-4444-4444-4444-444444444444',
    logger: null,
  });
  assert.equal((await verifyBackup(result.path)).databases, 1);
  assert.deepEqual(result.removedStaging, [path.basename(staleStaging)]);
  assert.equal(fs.existsSync(staleStaging), false);

  fs.mkdirSync(path.join(rootDir, 'media'), { recursive: true });
  fs.symlinkSync('/tmp', path.join(rootDir, 'media', 'unexpected-link'));
  await assert.rejects(
    createBackup({
      rootDir,
      backupRoot,
      now: () => new Date('2026-07-10T13:30:00.000Z'),
      randomUUID: () => '66666666-6666-6666-6666-666666666666',
      logger: null,
    }),
    /media\/ contém links simbólicos/,
  );

  await assert.rejects(
    createBackup({ rootDir, backupRoot: path.join(rootDir, 'data', 'backups'), logger: null }),
    /BACKUP_DIR deve ficar fora/,
  );

  fs.rmSync(path.join(rootDir, 'media', 'unexpected-link'));
  fs.mkdirSync(path.join(rootDir, '.wwebjs_auth'), { recursive: true });
  fs.symlinkSync('/tmp', path.join(rootDir, '.wwebjs_auth', 'credential-link'));
  await assert.rejects(
    createBackup({ rootDir, backupRoot, logger: null }),
    /\.wwebjs_auth\/ contem link simbolico inesperado/,
  );
  fs.rmSync(path.join(rootDir, '.wwebjs_auth', 'credential-link'));

  const realBackupRoot = path.join(rootDir, 'real-backups');
  fs.mkdirSync(realBackupRoot);
  const linkedBackupRoot = path.join(rootDir, 'linked-backups');
  fs.symlinkSync(realBackupRoot, linkedBackupRoot);
  await assert.rejects(
    createBackup({ rootDir, backupRoot: linkedBackupRoot, logger: null }),
    /BACKUP_DIR deve ser um diretorio real/,
  );
});

test('heartbeats a long-running backup lock so another process cannot steal it', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-backup-heartbeat-'));
  const backupRoot = path.join(rootDir, 'backups');
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const database = createWalDatabase(path.join(rootDir, 'legacy.db'), 'row');
  database.close();

  let releaseCapacityCheck;
  const capacityGate = new Promise((resolve) => {
    releaseCapacityCheck = resolve;
  });
  const first = createBackup({
    rootDir,
    backupRoot,
    lockStaleMs: 300,
    freeMarginMb: 0,
    getAvailableBytes: async () => {
      await capacityGate;
      return Number.MAX_SAFE_INTEGER;
    },
    logger: null,
  });

  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    await assert.rejects(
      createBackup({
        rootDir,
        backupRoot,
        lockStaleMs: 300,
        freeMarginMb: 0,
        getAvailableBytes: async () => Number.MAX_SAFE_INTEGER,
        logger: null,
      }),
      /Outro backup já está em andamento/,
    );
  } finally {
    releaseCapacityCheck();
  }
  const result = await first;
  assert.equal((await verifyBackup(result.path)).databases, 1);
});

test('verifies an empty first-install snapshot without inventing database state', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-backup-empty-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const result = await createBackup({
    rootDir,
    retention: 1,
    now: () => new Date('2026-07-10T14:00:00.000Z'),
    randomUUID: () => '55555555-5555-5555-5555-555555555555',
    logger: null,
  });
  assert.equal(result.manifest.databases.length, 0);
  assert.equal((await verifyBackup(result.path)).databases, 0);
});

test('creates and independently verifies a globally consistent quiescent application snapshot', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-global-backup-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  createApplicationFixture(rootDir);

  const result = await createBackup({
    rootDir,
    retention: 1,
    quiesced: true,
    requireQuiesced: true,
    requireNoLiveLease: true,
    requireGlobalConsistency: true,
    freeMarginMb: 0,
    getAvailableBytes: async () => Number.MAX_SAFE_INTEGER,
    now: () => new Date('2026-07-13T15:00:00.000Z'),
    randomUUID: () => '77777777-7777-7777-7777-777777777777',
    logger: null,
  });

  assert.deepEqual(result.manifest.consistency.global, {
    mode: 'single-node-quiesced',
    quiesced: true,
    noLiveRuntimeLease: true,
    runtimeLeaseTablePresent: true,
    runtimeLeaseChecks: 2,
    relationalIntegrity: 'ok',
    checks: [
      'master-tenants-to-data_N',
      'user-directory-to-accounts',
      'support-ownership',
      'media-references-and-prefixes',
    ],
    summary: result.manifest.consistency.global.summary,
  });
  assert.equal(result.manifest.consistency.global.summary.tenantsChecked, 1);
  assert.equal(result.manifest.consistency.global.summary.directoryEntriesChecked, 1);
  assert.equal(result.manifest.consistency.global.summary.supportMessagesChecked, 1);
  assert.equal(result.manifest.consistency.global.summary.mediaReferencesChecked, 2);
  const verification = await verifyBackup(result.path);
  assert.equal(verification.globalConsistency, 'ok');
  assert.equal(verification.quiesced, true);

  const tenantSnapshotPath = path.join(result.path, 'data', 'data_7.db');
  const tenantSnapshot = new Database(tenantSnapshotPath);
  tenantSnapshot.pragma('journal_mode = DELETE');
  tenantSnapshot
    .prepare('INSERT INTO vendors (name, username, password) VALUES (?, ?, ?)')
    .run('Undeclared Vendor', 'undeclared@example.test', 'hash');
  tenantSnapshot.close();
  const manifestPath = path.join(result.path, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const tenantManifest = manifest.databases.find((database) => database.path === 'data/data_7.db');
  tenantManifest.bytes = fs.statSync(tenantSnapshotPath).size;
  tenantManifest.sha256 = await sha256File(tenantSnapshotPath);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(verifyBackup(result.path), /Consistencia relacional global falhou.*nao esta indexado/);
});

test('strict quiescent backup rejects live runtime leases and relational drift', async (t) => {
  const leaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-live-lease-backup-'));
  const driftRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-relational-backup-'));
  t.after(() => fs.rmSync(leaseRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(driftRoot, { recursive: true, force: true }));
  createApplicationFixture(leaseRoot, { liveLease: true });
  createApplicationFixture(driftRoot, { directoryMismatch: true });

  const strictOptions = {
    retention: 1,
    quiesced: true,
    requireQuiesced: true,
    requireNoLiveLease: true,
    requireGlobalConsistency: true,
    freeMarginMb: 0,
    getAvailableBytes: async () => Number.MAX_SAFE_INTEGER,
    logger: null,
  };
  await assert.rejects(createBackup({ ...strictOptions, rootDir: leaseRoot }), /existe runtime lease vivo/);
  await assert.rejects(createBackup({ ...strictOptions, rootDir: driftRoot }), /Fonte global inconsistente.*diretorio/);
});

test('strict global validation rejects missing tenant databases, crossed support and media ownership', async (t) => {
  const missingDbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-missing-db-backup-'));
  const supportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-support-owner-backup-'));
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-media-owner-backup-'));
  for (const directory of [missingDbRoot, supportRoot, mediaRoot]) {
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    createApplicationFixture(directory);
  }

  fs.rmSync(path.join(missingDbRoot, 'data', 'data_7.db'));

  addSecondApplicationTenant(supportRoot);
  const supportMaster = new Database(path.join(supportRoot, 'data', 'master.db'));
  supportMaster.prepare('UPDATE support_messages SET tenant_id = 8 WHERE id = 11').run();
  supportMaster.close();

  const mediaTenant = new Database(path.join(mediaRoot, 'data', 'data_7.db'));
  mediaTenant.prepare("UPDATE messages SET media_url = '/media/t8-message.jpg'").run();
  mediaTenant.close();
  fs.writeFileSync(path.join(mediaRoot, 'media', 't8-message.jpg'), 'crossed-photo');

  const strictOptions = {
    retention: 1,
    quiesced: true,
    requireQuiesced: true,
    requireNoLiveLease: true,
    requireGlobalConsistency: true,
    freeMarginMb: 0,
    getAvailableBytes: async () => Number.MAX_SAFE_INTEGER,
    logger: null,
  };
  await assert.rejects(
    createBackup({ ...strictOptions, rootDir: missingDbRoot }),
    /Fonte global inconsistente.*data_7\.db ausente/,
  );
  await assert.rejects(
    createBackup({ ...strictOptions, rootDir: supportRoot }),
    /Fonte global inconsistente.*suporte.*tenant diferente/,
  );
  await assert.rejects(
    createBackup({ ...strictOptions, rootDir: mediaRoot }),
    /Fonte global inconsistente.*midia pertence a outro namespace/,
  );
});

test('strict backup refuses media that was corrupted before the snapshot', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-corrupt-source-media-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  createApplicationFixture(rootDir);
  fs.appendFileSync(path.join(rootDir, 'media', 't7-message.jpg'), '-silent-corruption');

  await assert.rejects(
    createBackup({
      rootDir,
      retention: 1,
      quiesced: true,
      requireQuiesced: true,
      requireNoLiveLease: true,
      requireGlobalConsistency: true,
      freeMarginMb: 0,
      getAvailableBytes: async () => Number.MAX_SAFE_INTEGER,
      logger: null,
    }),
    /Fonte global inconsistente.*(?:tamanho|SHA-256).*diverge do banco/,
  );
});

test('capacity preflight preserves the last known-good backup when a new snapshot cannot fit', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-capacity-backup-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const database = createWalDatabase(path.join(rootDir, 'data', 'master.db'), 'row');
  database.close();

  const first = await createBackup({
    rootDir,
    retention: 1,
    freeMarginMb: 0,
    getAvailableBytes: async () => Number.MAX_SAFE_INTEGER,
    now: () => new Date('2026-07-13T16:00:00.000Z'),
    randomUUID: () => '88888888-8888-8888-8888-888888888888',
    logger: null,
  });
  await assert.rejects(
    createBackup({
      rootDir,
      retention: 1,
      freeMarginMb: 1,
      getAvailableBytes: async () => 0,
      now: () => new Date('2026-07-13T17:00:00.000Z'),
      randomUUID: () => '99999999-9999-9999-9999-999999999999',
      logger: null,
    }),
    /Espaco insuficiente no destino/,
  );
  assert.equal(fs.existsSync(first.path), true);
  const completedSnapshots = fs.readdirSync(path.join(rootDir, 'backups')).filter((name) => name.startsWith('backup-'));
  assert.deepEqual(completedSnapshots, [path.basename(first.path)]);
});

test('pre-snapshot retention verifies and preserves the last known-good snapshot', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-known-good-backup-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const database = createWalDatabase(path.join(rootDir, 'data', 'master.db'), 'row');
  database.close();
  fs.mkdirSync(path.join(rootDir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'media', 'photo.jpg'), 'clean');

  const common = {
    rootDir,
    retention: 3,
    freeMarginMb: 0,
    getAvailableBytes: async () => Number.MAX_SAFE_INTEGER,
    logger: null,
  };
  const first = await createBackup({
    ...common,
    now: () => new Date('2026-07-13T18:00:00.000Z'),
    randomUUID: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });
  const second = await createBackup({
    ...common,
    now: () => new Date('2026-07-13T19:00:00.000Z'),
    randomUUID: () => 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  });
  fs.appendFileSync(path.join(second.path, 'media', 'photo.jpg'), '-corrupted');

  const third = await createBackup({
    ...common,
    retention: 2,
    now: () => new Date('2026-07-13T20:00:00.000Z'),
    randomUUID: () => 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  });
  assert.equal(fs.existsSync(first.path), true);
  assert.equal(fs.existsSync(second.path), false);
  assert.equal(fs.existsSync(third.path), true);
  assert.ok(third.removed.includes(path.basename(second.path)));
  assert.equal((await verifyBackup(first.path)).backupId, path.basename(first.path));
  assert.equal((await verifyBackup(third.path)).backupId, path.basename(third.path));
});

test('rejects logically corrupt SQLite snapshots with foreign-key violations', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-backup-foreign-key-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const legacyPath = path.join(rootDir, 'legacy.db');
  const database = new Database(legacyPath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE parents (id INTEGER PRIMARY KEY);
    CREATE TABLE children (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parents(id)
    );
    INSERT INTO parents (id) VALUES (1);
    INSERT INTO children (id, parent_id) VALUES (1, 1);
  `);
  database.close();

  const result = await createBackup({
    rootDir,
    retention: 1,
    freeMarginMb: 0,
    getAvailableBytes: async () => Number.MAX_SAFE_INTEGER,
    logger: null,
  });
  const snapshotDatabasePath = path.join(result.path, 'legacy.db');
  const snapshotDatabase = new Database(snapshotDatabasePath);
  snapshotDatabase.pragma('foreign_keys = OFF');
  snapshotDatabase.prepare('INSERT INTO children (id, parent_id) VALUES (2, 999)').run();
  snapshotDatabase.close();

  const manifestPath = path.join(result.path, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entry = manifest.databases.find((item) => item.path === 'legacy.db');
  entry.bytes = fs.statSync(snapshotDatabasePath).size;
  entry.sha256 = await sha256File(snapshotDatabasePath);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(verifyBackup(result.path), /foreign_key_check falhou/);
});
