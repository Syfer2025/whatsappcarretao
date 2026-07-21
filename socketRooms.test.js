const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildUserRoom,
  buildIdentityRoom,
  buildSessionRoom,
  buildSupportTenantRoom
} = require('./socketRooms');

test('equal user ids are assigned to disjoint tenant rooms', () => {
  const user = { id: 1, role: 'vendor', session_id: 'browser-a' };
  assert.notEqual(buildUserRoom(user, 10), buildUserRoom(user, 20));
  assert.notEqual(buildIdentityRoom(user, 10), buildIdentityRoom(user, 20));
  assert.notEqual(buildSessionRoom(user, 10), buildSessionRoom(user, 20));
  assert.notEqual(buildSupportTenantRoom(10), buildSupportTenantRoom(20));
});

test('browser sessions are isolated without changing the user identity room', () => {
  const first = { id: 7, role: 'admin', session_id: 'first-browser' };
  const second = { id: 7, role: 'admin', session_id: 'second-browser' };
  assert.equal(buildIdentityRoom(first, 55), buildIdentityRoom(second, 55));
  assert.notEqual(buildSessionRoom(first, 55), buildSessionRoom(second, 55));
});

test('room builders reject missing tenants and injected identifiers', () => {
  assert.throws(() => buildUserRoom({ id: 1, role: 'vendor' }, null), /Tenant inválido/);
  assert.throws(() => buildUserRoom({ id: 1, role: 'vendor' }, '../2'), /Tenant inválido/);
  assert.throws(
    () => buildSessionRoom({ id: 1, role: 'vendor', session_id: 'bad:room' }, 2),
    /Sessão inválida/
  );
});
