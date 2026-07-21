const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const { ensureSchema } = require('./schema');
const {
  createPasswordResetRequest,
  isPasswordResetInFlight,
  listPendingPasswordResetRequests,
  resolvePasswordResetRequest,
  recoverInFlightPasswordResetResolutions
} = require('./passwordReset');

function createFixture() {
  const masterDb = new Database(':memory:');
  masterDb.pragma('foreign_keys = ON');
  masterDb.exec(`
    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE password_reset_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      admin_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'resolved')),
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_hash TEXT,
      resolution_started_at TEXT,
      resolution_resolver TEXT,
      resolution_target_at TEXT
    );
    CREATE UNIQUE INDEX idx_password_reset_one_pending
      ON password_reset_requests(tenant_id, admin_id)
      WHERE status = 'pending';
    INSERT INTO tenants (id, name) VALUES (42, 'Tenant Teste');
  `);
  const tenantDb = new Database(':memory:');
  ensureSchema(tenantDb);
  tenantDb.prepare('INSERT INTO admins (username, password, super_admin) VALUES (?, ?, 0)')
    .run('admin@tenant.test', bcrypt.hashSync('senha-antiga', 10));
  tenantDb.prepare('INSERT INTO vendors (name, username, password) VALUES (?, ?, ?)')
    .run('Vendedor', 'vendor@tenant.test', bcrypt.hashSync('senha-antiga', 10));

  const directory = new Map([
    ['admin@tenant.test', { username: 'admin@tenant.test', tenant_id: 42, role: 'admin' }],
    ['vendor@tenant.test', { username: 'vendor@tenant.test', tenant_id: 42, role: 'vendor' }]
  ]);
  return {
    masterDb,
    tenantDb,
    findDirectoryUser: username => directory.get(username) || null,
    getTenantDb: tenantId => {
      assert.equal(tenantId, 42);
      return tenantDb;
    },
    close() {
      masterDb.close();
      tenantDb.close();
    }
  };
}

test('creates one durable pending request for a tenant admin with a generic response', () => {
  const fixture = createFixture();
  const args = {
    email: 'admin@tenant.test',
    masterDb: fixture.masterDb,
    findDirectoryUser: fixture.findDirectoryUser,
    getTenantDb: fixture.getTenantDb,
    now: () => Date.UTC(2026, 6, 10, 12, 0, 0)
  };

  assert.deepEqual(createPasswordResetRequest(args), { accepted: true });
  assert.deepEqual(createPasswordResetRequest(args), { accepted: true });

  const requests = listPendingPasswordResetRequests({ masterDb: fixture.masterDb });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tenant_id, 42);
  assert.equal(requests[0].tenant_name, 'Tenant Teste');
  assert.equal(requests[0].email, 'admin@tenant.test');
  assert.equal(requests[0].status, 'pending');
  assert.equal(requests[0].requested_at, '2026-07-10T12:00:00.000Z');

  const columns = fixture.masterDb.prepare('PRAGMA table_info(password_reset_requests)').all().map(row => row.name);
  assert.equal(columns.includes('password'), false);
  assert.equal(columns.includes('token'), false);
  fixture.close();
});

test('vendors and unknown users receive the same response without creating a request', () => {
  const fixture = createFixture();
  for (const email of ['vendor@tenant.test', 'missing@tenant.test']) {
    assert.deepEqual(createPasswordResetRequest({
      email,
      masterDb: fixture.masterDb,
      findDirectoryUser: fixture.findDirectoryUser,
      getTenantDb: fixture.getTenantDb
    }), { accepted: true });
  }
  assert.deepEqual(listPendingPasswordResetRequests({ masterDb: fixture.masterDb }), []);
  fixture.close();
});

test('super admin resolves a request, stores only the hash and revokes existing sessions', () => {
  const fixture = createFixture();
  createPasswordResetRequest({
    email: 'admin@tenant.test',
    masterDb: fixture.masterDb,
    findDirectoryUser: fixture.findDirectoryUser,
    getTenantDb: fixture.getTenantDb,
    now: () => Date.UTC(2026, 6, 10, 12, 0, 0)
  });
  const request = listPendingPasswordResetRequests({ masterDb: fixture.masterDb })[0];
  const before = fixture.tenantDb.prepare('SELECT password, token_version FROM admins WHERE id = ?').get(request.admin_id);

  const resolved = resolvePasswordResetRequest({
    requestId: request.id,
    newPassword: 'senha-nova-segura',
    resolvedBy: 'super-admin:1',
    masterDb: fixture.masterDb,
    getTenantDb: fixture.getTenantDb,
    now: () => Date.UTC(2026, 6, 10, 13, 0, 0)
  });

  const after = fixture.tenantDb.prepare('SELECT password, token_version FROM admins WHERE id = ?').get(request.admin_id);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolved_by, 'super-admin:1');
  assert.equal(resolved.resolved_at, '2026-07-10T13:00:00.000Z');
  assert.equal(after.password.includes('senha-nova-segura'), false);
  assert.equal(bcrypt.compareSync('senha-nova-segura', after.password), true);
  assert.equal(after.token_version, before.token_version + 1);
  assert.deepEqual(listPendingPasswordResetRequests({ masterDb: fixture.masterDb }), []);
  assert.throws(() => resolvePasswordResetRequest({
    requestId: request.id,
    newPassword: 'outra-senha-segura',
    resolvedBy: 'super-admin:1',
    masterDb: fixture.masterDb,
    getTenantDb: fixture.getTenantDb
  }), err => err.statusCode === 404);
  fixture.close();
});

test('boot recovery completes a crash between tenant password commit and master resolution exactly once', () => {
  const fixture = createFixture();
  createPasswordResetRequest({
    email: 'admin@tenant.test',
    masterDb: fixture.masterDb,
    findDirectoryUser: fixture.findDirectoryUser,
    getTenantDb: fixture.getTenantDb
  });
  const request = listPendingPasswordResetRequests({ masterDb: fixture.masterDb })[0];
  const before = fixture.tenantDb.prepare(`
    SELECT password, token_version FROM admins WHERE id = ?
  `).get(request.admin_id);

  assert.throws(() => resolvePasswordResetRequest({
    requestId: request.id,
    newPassword: 'senha-crash-segura',
    resolvedBy: 'super-admin:1',
    masterDb: fixture.masterDb,
    getTenantDb: fixture.getTenantDb,
    now: () => Date.UTC(2026, 6, 10, 13, 0, 0),
    afterTenantApplied() {
      throw new Error('SIGKILL simulado antes do commit master');
    }
  }), /SIGKILL simulado/);

  const afterCrash = fixture.tenantDb.prepare(`
    SELECT password, token_version FROM admins WHERE id = ?
  `).get(request.admin_id);
  const inFlight = fixture.masterDb.prepare(`
    SELECT status, resolution_hash FROM password_reset_requests WHERE id = ?
  `).get(request.id);
  assert.equal(bcrypt.compareSync('senha-crash-segura', afterCrash.password), true);
  assert.equal(afterCrash.token_version, before.token_version + 1);
  assert.equal(inFlight.status, 'pending');
  assert.ok(inFlight.resolution_hash);
  assert.equal(isPasswordResetInFlight({
    masterDb: fixture.masterDb,
    tenantId: 42,
    adminId: request.admin_id
  }), true);

  assert.throws(() => resolvePasswordResetRequest({
    requestId: request.id,
    newPassword: 'senha-diferente-segura',
    resolvedBy: 'outro-super-admin',
    masterDb: fixture.masterDb,
    getTenantDb: fixture.getTenantDb
  }), error => error.statusCode === 409 && error.code === 'PASSWORD_RESET_IN_PROGRESS');

  const recovery = recoverInFlightPasswordResetResolutions({
    masterDb: fixture.masterDb,
    getTenantDb: fixture.getTenantDb
  });
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].recovered, true);
  const afterRecovery = fixture.tenantDb.prepare(`
    SELECT password, token_version FROM admins WHERE id = ?
  `).get(request.admin_id);
  const completed = fixture.masterDb.prepare(`
    SELECT status, resolution_hash, resolved_by FROM password_reset_requests WHERE id = ?
  `).get(request.id);
  assert.equal(afterRecovery.token_version, before.token_version + 1);
  assert.equal(afterRecovery.password, afterCrash.password);
  assert.equal(completed.status, 'resolved');
  assert.equal(completed.resolution_hash, null);
  assert.equal(completed.resolved_by, 'super-admin:1');
  assert.equal(isPasswordResetInFlight({
    masterDb: fixture.masterDb,
    tenantId: 42,
    adminId: request.admin_id
  }), false);
  fixture.close();
});

test('rejects weak replacement passwords without resolving the request', () => {
  const fixture = createFixture();
  createPasswordResetRequest({
    email: 'admin@tenant.test',
    masterDb: fixture.masterDb,
    findDirectoryUser: fixture.findDirectoryUser,
    getTenantDb: fixture.getTenantDb
  });
  const request = listPendingPasswordResetRequests({ masterDb: fixture.masterDb })[0];
  assert.throws(() => resolvePasswordResetRequest({
    requestId: request.id,
    newPassword: 'curta',
    resolvedBy: 'super-admin:1',
    masterDb: fixture.masterDb,
    getTenantDb: fixture.getTenantDb
  }), err => err.statusCode === 400 && /10 caracteres/.test(err.message));
  assert.equal(listPendingPasswordResetRequests({ masterDb: fixture.masterDb }).length, 1);
  fixture.close();
});

test('rejects bcrypt-truncated multibyte passwords above 72 UTF-8 bytes', () => {
  const fixture = createFixture();
  createPasswordResetRequest({
    email: 'admin@tenant.test',
    masterDb: fixture.masterDb,
    findDirectoryUser: fixture.findDirectoryUser,
    getTenantDb: fixture.getTenantDb
  });
  const request = listPendingPasswordResetRequests({ masterDb: fixture.masterDb })[0];
  const oversized = '🔐'.repeat(19); // 76 bytes UTF-8, apesar de apenas 38 code units.
  assert.throws(() => resolvePasswordResetRequest({
    requestId: request.id,
    newPassword: oversized,
    resolvedBy: 'super-admin:1',
    masterDb: fixture.masterDb,
    getTenantDb: fixture.getTenantDb
  }), err => err.statusCode === 400 && /72 bytes/.test(err.message));
  assert.equal(listPendingPasswordResetRequests({ masterDb: fixture.masterDb }).length, 1);
  fixture.close();
});

test('failed tenant password mutation rolls back the master resolution claim', () => {
  const fixture = createFixture();
  createPasswordResetRequest({
    email: 'admin@tenant.test',
    masterDb: fixture.masterDb,
    findDirectoryUser: fixture.findDirectoryUser,
    getTenantDb: fixture.getTenantDb
  });
  const request = listPendingPasswordResetRequests({ masterDb: fixture.masterDb })[0];
  fixture.tenantDb.prepare('DELETE FROM admins WHERE id = ?').run(request.admin_id);

  assert.throws(() => resolvePasswordResetRequest({
    requestId: request.id,
    newPassword: 'senha-nova-segura',
    resolvedBy: 'super-admin:1',
    masterDb: fixture.masterDb,
    getTenantDb: fixture.getTenantDb
  }), err => err.statusCode === 404 && /Administrador/.test(err.message));
  assert.equal(listPendingPasswordResetRequests({ masterDb: fixture.masterDb }).length, 1);
  fixture.close();
});
