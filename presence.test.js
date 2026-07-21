const test = require('node:test');
const assert = require('node:assert/strict');
const { createPresenceRegistry } = require('./presence');

test('presence is isolated by tenant and counts multiple browser tabs', () => {
  const registry = createPresenceRegistry();
  const user = { id: 1, role: 'vendor', name: 'Ana', sector_id: 2 };

  registry.connect({ tenantId: 10, user, socketId: 'a' });
  registry.connect({ tenantId: 10, user, socketId: 'b' });
  registry.connect({ tenantId: 20, user: { ...user, name: 'Outra Ana' }, socketId: 'c' });

  assert.equal(registry.list(10).length, 1);
  assert.equal(registry.list(10)[0].connectionCount, 2);
  assert.equal(registry.list(20)[0].name, 'Outra Ana');

  registry.disconnect({ tenantId: 10, user, socketId: 'a' });
  assert.equal(registry.isOnline(10, 'vendor', 1), true);
  registry.disconnect({ tenantId: 10, user, socketId: 'b' });
  assert.equal(registry.isOnline(10, 'vendor', 1), false);
  assert.equal(registry.isOnline(20, 'vendor', 1), true);
});

test('presence rejects missing tenant context instead of creating a shared room', () => {
  const registry = createPresenceRegistry();
  assert.equal(registry.connect({ tenantId: null, user: { id: 1, role: 'vendor' }, socketId: 'x' }), null);
  assert.deepEqual(registry.list(null), []);
});

test('presence reports the oldest currently connected tab and ignores unknown disconnects', () => {
  let notifications = 0;
  const registry = createPresenceRegistry({ onChange: () => { notifications += 1; } });
  const user = { id: 3, role: 'vendor', name: 'Bia', sector_id: 9 };
  registry.connect({ tenantId: 1, user, socketId: 'old', now: new Date('2026-07-10T10:00:00Z') });
  registry.connect({ tenantId: 1, user, socketId: 'new', now: new Date('2026-07-10T11:00:00Z') });
  assert.equal(registry.list(1)[0].connectedAt, '2026-07-10T10:00:00.000Z');
  assert.equal(registry.disconnect({ tenantId: 1, user, socketId: 'missing' }), false);
  assert.equal(notifications, 2);
  registry.disconnect({ tenantId: 1, user, socketId: 'old' });
  assert.equal(registry.list(1)[0].connectedAt, '2026-07-10T11:00:00.000Z');
  assert.equal(registry.list(1)[0].connectionCount, 1);
});
