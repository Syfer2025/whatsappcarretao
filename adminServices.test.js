const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const { ensureSchema } = require('./schema');
const {
  createSector,
  updateSector,
  listSectors,
  createUser,
  updateUser,
  listUsers,
  assignConversation
} = require('./adminServices');

function createDb() {
  const db = new Database(':memory:');
  ensureSchema(db);
  return db;
}

test('creates and updates sectors with duplicate validation', () => {
  const db = createDb();

  const sector = createSector({ db, name: 'Financeiro' });
  assert.equal(sector.name, 'Financeiro');
  assert.equal(sector.active, 1);
  assert.throws(() => createSector({ db, name: 'Financeiro' }), /Setor ja existe/);

  const updated = updateSector({ db, id: sector.id, name: 'Financeiro Interno', active: false });
  assert.equal(updated.name, 'Financeiro Interno');
  assert.equal(updated.active, 0);
  assert.deepEqual(listSectors(db).map(item => item.name), ['Financeiro Interno']);

  db.close();
});

test('creates and updates users with sectors and hashed passwords', () => {
  const db = createDb();
  const sector = createSector({ db, name: 'Vendas' });

  const user = createUser({
    db,
    name: 'Jackson',
    username: 'jackson',
    password: 'senha123',
    sectorId: sector.id
  });
  assert.equal(user.name, 'Jackson');
  assert.equal(user.username, 'jackson');
  assert.equal(user.sector_id, sector.id);
  assert.equal(user.sector_name, 'Vendas');
  assert.equal(bcrypt.compareSync('senha123', db.prepare('SELECT password FROM vendors WHERE id = ?').get(user.id).password), true);
  assert.throws(() => createUser({ db, name: 'Outro', username: 'jackson', password: 'senha123' }), /Username ja existe/);

  const updated = updateUser({
    db,
    id: user.id,
    name: 'Jackson Silva',
    username: 'jackson.silva',
    password: 'nova123',
    active: false,
    sectorId: null
  });
  assert.equal(updated.name, 'Jackson Silva');
  assert.equal(updated.username, 'jackson.silva');
  assert.equal(updated.active, 0);
  assert.equal(updated.sector_id, null);
  assert.equal(bcrypt.compareSync('nova123', db.prepare('SELECT password FROM vendors WHERE id = ?').get(user.id).password), true);

  const users = listUsers(db);
  assert.equal(users.length, 1);
  assert.equal(users[0].name, 'Jackson Silva');

  db.close();
});

test('assigns conversations by direct user and sector without sector-based access', () => {
  const db = createDb();
  const sector = createSector({ db, name: 'Financeiro' });
  const activeUser = createUser({ db, name: 'Maria', username: 'maria', password: 'senha123', sectorId: sector.id });
  const inactiveUser = createUser({ db, name: 'Joao', username: 'joao', password: 'senha123', active: false, sectorId: sector.id });
  db.prepare("INSERT INTO conversations (id, phone, contact_name, status) VALUES (1, 'a@lid', 'Cliente A', 'unassigned')").run();

  const assigned = assignConversation({ db, conversationId: 1, vendorId: activeUser.id, sectorId: sector.id });
  assert.equal(assigned.assigned_to, activeUser.id);
  assert.equal(assigned.sector_id, sector.id);
  assert.equal(assigned.status, 'active');
  assert.equal(assigned.vendor_name, 'Maria');
  assert.equal(assigned.sector_name, 'Financeiro');

  assert.throws(
    () => assignConversation({ db, conversationId: 1, vendorId: inactiveUser.id, sectorId: sector.id }),
    /Usuario inativo/
  );

  const unassigned = assignConversation({ db, conversationId: 1, vendorId: null, sectorId: sector.id });
  assert.equal(unassigned.assigned_to, null);
  assert.equal(unassigned.sector_id, sector.id);
  assert.equal(unassigned.status, 'unassigned');

  db.close();
});
