const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('./schema');
const { getTenantStatistics } = require('./analytics');

test('statistics aggregate attendants and sectors without external tenant data', () => {
  const db = new Database(':memory:');
  ensureSchema(db);
  const sectorId = Number(db.prepare('INSERT INTO sectors (name) VALUES (?)').run('Vendas').lastInsertRowid);
  const vendorId = Number(db.prepare(`
    INSERT INTO vendors (name, username, password, sector_id) VALUES (?, ?, ?, ?)
  `).run('Ana', 'ana', 'hash', sectorId).lastInsertRowid);
  const conversationId = Number(db.prepare(`
    INSERT INTO conversations (phone, contact_name, assigned_to, sector_id, status)
    VALUES ('5511999999999@c.us', 'Cliente', ?, ?, 'active')
  `).run(vendorId, sectorId).lastInsertRowid);
  db.prepare(`
    INSERT INTO messages (conversation_id, from_type, content, vendor_id, created_at)
    VALUES (?, 'client', 'oi', NULL, '2026-07-09 10:00:00'),
           (?, 'vendor', 'olá', ?, '2026-07-09 10:01:00'),
           (?, 'vendor', 'posso ajudar?', ?, '2026-07-09 10:02:00')
  `).run(conversationId, conversationId, vendorId, conversationId, vendorId);

  const result = getTenantStatistics({
    db,
    days: 7,
    now: new Date('2026-07-10T12:00:00Z'),
    presence: [{ role: 'vendor', userId: vendorId, connectedAt: '2026-07-10T11:00:00.000Z', connectionCount: 2 }]
  });

  assert.equal(result.summary.attended_contacts, 1);
  assert.equal(result.summary.messages_received, 1);
  assert.equal(result.summary.messages_sent, 2);
  assert.equal(result.summary.average_first_response_seconds, 60);
  assert.equal(result.vendors[0].online, true);
  assert.equal(result.vendors[0].online_since, '2026-07-10T11:00:00.000Z');
  assert.equal(result.vendors[0].connection_count, 2);
  assert.equal(result.vendors[0].messages_sent, 2);
  assert.equal(result.vendors[0].assigned_open, 1);
  assert.equal(result.sectors[0].online_users, 1);
  assert.equal(result.sectors[0].messages_sent, 2);
  assert.equal(result.sectors[0].open_conversations, 1);
  assert.equal(result.summary.online_vendors, 1);
  assert.equal(result.summary.online_admins, 0);
  db.close();
});

test('sector statistics preserve the sector recorded when a vendor sent the message', () => {
  const db = new Database(':memory:');
  ensureSchema(db);
  const originalSector = Number(db.prepare('INSERT INTO sectors (name) VALUES (?)').run('Original').lastInsertRowid);
  const currentSector = Number(db.prepare('INSERT INTO sectors (name) VALUES (?)').run('Atual').lastInsertRowid);
  const vendorId = Number(db.prepare(`
    INSERT INTO vendors (name, username, password, sector_id) VALUES (?, ?, ?, ?)
  `).run('Vendedor', 'vendedor', 'hash', currentSector).lastInsertRowid);
  const conversationId = Number(db.prepare(`
    INSERT INTO conversations (phone, status) VALUES ('snapshot@lid', 'closed')
  `).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO messages (
      conversation_id, from_type, content, vendor_id, vendor_sector_id, created_at
    ) VALUES (?, 'vendor', 'historico', ?, ?, '2026-07-09 10:00:00')
  `).run(conversationId, vendorId, originalSector);

  const result = getTenantStatistics({ db, days: 7, now: new Date('2026-07-10T12:00:00Z') });
  const byName = new Map(result.sectors.map(sector => [sector.name, sector]));
  assert.equal(byName.get('Original').messages_sent, 1);
  assert.equal(byName.get('Original').attended_contacts, 1);
  assert.equal(byName.get('Atual').messages_sent, 0);
  db.close();
});

test('statistics clamp unsafe periods and return empty-safe values', () => {
  const db = new Database(':memory:');
  ensureSchema(db);
  const result = getTenantStatistics({ db, days: 9999, now: new Date('2026-07-10T12:00:00Z') });
  assert.equal(result.period_days, 365);
  assert.equal(result.summary.attended_contacts, 0);
  assert.equal(result.summary.average_first_response_seconds, null);
  db.close();
});

test('statistics expose tenant administrator presence without platform accounts', () => {
  const db = new Database(':memory:');
  ensureSchema(db);
  const tenantAdminId = Number(db.prepare(`
    INSERT INTO admins (name, username, password, super_admin)
    VALUES ('Gestora', 'gestora@tenant.test', 'hash', 0)
  `).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO admins (name, username, password, super_admin)
    VALUES ('Plataforma', 'root@platform.test', 'hash', 1)
  `).run();

  const result = getTenantStatistics({
    db,
    now: new Date('2026-07-10T12:00:00Z'),
    presence: [{
      role: 'admin',
      userId: tenantAdminId,
      connectedAt: '2026-07-10T11:30:00.000Z',
      connectionCount: 1
    }]
  });
  assert.equal(result.admins.length, 1);
  assert.equal(result.admins[0].name, 'Gestora');
  assert.equal(result.admins[0].online, true);
  assert.equal(result.summary.online_admins, 1);
  assert.equal(result.summary.online_users, 1);
  db.close();
});
