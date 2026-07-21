const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensureSchema } = require('./schema');
const {
  normalizeUsername,
  collectTenantAccounts,
  findIdentityConflicts,
  auditDirectoryEntries
} = require('./userDirectoryIntegrity');

test('username normalization collapses equivalent Unicode forms', () => {
  assert.equal(normalizeUsername('  Ａdmin＠Example.test  '), 'admin@example.test');
  assert.equal(normalizeUsername('Cafe\u0301@Example.test'), 'café@example.test');
  const conflicts = findIdentityConflicts([
    { username: 'Ａdmin＠Example.test', tenantId: 1, role: 'admin' },
    { username: 'admin@example.test', tenantId: 2, role: 'admin' }
  ]);
  assert.equal(conflicts.length, 1);
});

function accountDb(accounts) {
  const database = new Database(':memory:');
  ensureSchema(database);
  for (const account of accounts) {
    const table = account.role === 'admin' ? 'admins' : 'vendors';
    if (table === 'admins') {
      database.prepare('INSERT INTO admins (username, password, super_admin) VALUES (?, ?, 0)')
        .run(account.username, 'hash');
    } else {
      database.prepare('INSERT INTO vendors (name, username, password, active) VALUES (?, ?, ?, ?)')
        .run(account.username, account.username, 'hash', account.active === false ? 0 : 1);
    }
  }
  return database;
}

test('directory audit rejects equal identities across tenants, roles and the platform', () => {
  const tenantA = accountDb([{ username: 'shared@example.test', role: 'admin' }]);
  const tenantB = accountDb([
    { username: 'SHARED@example.test', role: 'vendor', active: false },
    { username: 'platform@example.test', role: 'admin' }
  ]);
  const databases = new Map([[11, tenantA], [22, tenantB]]);
  const accounts = collectTenantAccounts({
    tenants: [{ id: 11 }, { id: 22 }],
    getTenantDb: tenantId => databases.get(tenantId)
  });

  const conflicts = findIdentityConflicts(accounts, ['PLATFORM@example.test']);
  assert.ok(conflicts.some(error => error.includes('simultaneamente')));
  assert.ok(conflicts.some(error => error.includes('super admin')));

  tenantA.close();
  tenantB.close();
});

test('directory audit is bidirectional and detects missing, orphan and role-mismatched entries', () => {
  const accounts = [
    { username: 'admin@a.test', tenantId: 1, role: 'admin' },
    { username: 'vendor@b.test', tenantId: 2, role: 'vendor' }
  ];
  const errors = auditDirectoryEntries({
    accounts,
    tenantIds: [1, 2],
    directoryEntries: [
      { username: 'admin@a.test', tenant_id: 1, role: 'vendor' },
      { username: 'orphan@b.test', tenant_id: 2, role: 'vendor' },
      { username: 'gone@test', tenant_id: 999, role: 'admin' }
    ]
  });

  assert.ok(errors.some(error => error.includes('esperado admin do tenant 1')));
  assert.ok(errors.some(error => error.includes('identidade orfa "orphan@b.test"')));
  assert.ok(errors.some(error => error.includes('tenant inexistente 999')));
  assert.ok(errors.some(error => error.includes('vendor do tenant 2 "vendor@b.test" nao esta indexado')));
});

test('tenant manager fails boot instead of choosing a duplicate login owner during backfill', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-directory-conflict-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    WA_AUTH_DIR: path.join(dataDir, 'auth'),
    NODE_ENV: 'test'
  };
  const setup = spawnSync(process.execPath, ['-e', `
    const tm = require('./tenantManager');
    const a = tm.createTenant({ name: 'A', slug: 'a', subdomain: 'a' });
    const b = tm.createTenant({ name: 'B', slug: 'b', subdomain: 'b' });
    tm.getTenantDb(a.id).prepare("INSERT INTO admins (username, password) VALUES ('same@example.test', 'hash')").run();
    tm.getTenantDb(b.id).prepare("INSERT INTO vendors (name, username, password) VALUES ('Same', 'SAME@example.test', 'hash')").run();
    tm.closeAllDbs();
  `], { cwd: __dirname, env, encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stderr);

  const boot = spawnSync(process.execPath, ['-e', "require('./tenantManager')"], {
    cwd: __dirname,
    env,
    encoding: 'utf8'
  });
  assert.notEqual(boot.status, 0);
  assert.match(`${boot.stdout}\n${boot.stderr}`, /Diretorio de usuarios inconsistente/);
  assert.match(`${boot.stdout}\n${boot.stderr}`, /same@example\.test/);
});

test('tenant manager converges a proven orphan after a crash between tenant and directory commits', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-directory-recovery-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    WA_AUTH_DIR: path.join(dataDir, 'auth'),
    NODE_ENV: 'test'
  };
  const setup = spawnSync(process.execPath, ['-e', `
    const tm = require('./tenantManager');
    const tenant = tm.createTenant({ name: 'Recovery', slug: 'recovery', subdomain: 'recovery' });
    const db = tm.getTenantDb(tenant.id);
    db.prepare("INSERT INTO vendors (name, username, password) VALUES ('Recover', 'old@example.test', 'hash')").run();
    tm.registerDirectoryUser('old@example.test', tenant.id, 'vendor');
    // Simula SIGKILL depois do commit do tenant e antes do commit master.
    db.prepare("UPDATE vendors SET username = 'new@example.test' WHERE username = 'old@example.test'").run();
    tm.closeAllDbs();
  `], { cwd: __dirname, env, encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stderr);

  const boot = spawnSync(process.execPath, ['-e', `
    const tm = require('./tenantManager');
    process.stdout.write(JSON.stringify({
      old: tm.findDirectoryUser('old@example.test') || null,
      current: tm.findDirectoryUser('new@example.test') || null,
      audit: tm.auditUserDirectoryIntegrity()
    }));
    tm.closeAllDbs();
  `], { cwd: __dirname, env, encoding: 'utf8' });
  assert.equal(boot.status, 0, boot.stderr);
  const recovered = JSON.parse(boot.stdout);
  assert.equal(recovered.old, null);
  assert.equal(recovered.current.role, 'vendor');
  assert.equal(recovered.audit.ok, true);
});
