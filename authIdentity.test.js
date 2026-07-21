const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateAuthenticatedPrincipal,
  isTenantPrincipal,
  samePrincipal
} = require('./authIdentity');

test('canonicalizes valid tenant and platform principals', () => {
  const tenant = validateAuthenticatedPrincipal({
    id: '1',
    role: 'vendor',
    tenant_id: '22',
    token_version: '3',
    session_id: 'browser-session_1'
  });
  assert.deepEqual(
    { id: tenant.id, tenant_id: tenant.tenant_id, super_admin: tenant.super_admin, token_version: tenant.token_version },
    { id: 1, tenant_id: 22, super_admin: false, token_version: 3 }
  );
  assert.equal(isTenantPrincipal(tenant), true);

  const platform = validateAuthenticatedPrincipal({
    id: 1,
    role: 'admin',
    tenant_id: null,
    super_admin: true,
    token_version: 0
  });
  assert.equal(platform.tenant_id, null);
  assert.equal(platform.super_admin, true);
  assert.equal(isTenantPrincipal(platform), false);
});

test('rejects mixed or tenantless JWT identities before database access', () => {
  for (const payload of [
    { id: 1, role: 'admin', tenant_id: null, super_admin: false },
    { id: 1, role: 'vendor', tenant_id: null },
    { id: 1, role: 'vendor', tenant_id: 4, super_admin: true },
    { id: 1, role: 'admin', tenant_id: 4, super_admin: true },
    { id: 1, role: 'unknown', tenant_id: 4 },
    { id: 1, role: 'vendor', tenant_id: '../4' },
    { id: 1, role: 'vendor', tenant_id: 4, session_id: 'bad/session' }
  ]) {
    assert.throws(() => validateAuthenticatedPrincipal(payload), /inválid|não pode pertencer|Papel/);
  }
});

test('principal equality includes tenant even when user ids collide', () => {
  const tenantA = validateAuthenticatedPrincipal({ id: 1, role: 'vendor', tenant_id: 10 });
  const tenantB = validateAuthenticatedPrincipal({ id: 1, role: 'vendor', tenant_id: 20 });
  assert.equal(samePrincipal(tenantA, tenantA), true);
  assert.equal(samePrincipal(tenantA, tenantB), false);
});
