const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { ensureSchema } = require('./schema');
const {
  createSector,
  updateSector,
  listSectors,
  createUser,
  updateUser,
  deactivateUser,
  listUsers,
  countActiveUsers,
  assignConversation
} = require('./adminServices');

function createDb() {
  const db = new Database(':memory:');
  ensureSchema(db);
  return db;
}

function createUserInChildProcess({ filename, sectorId, username, startAt }) {
  const worker = `
    const Database = require('better-sqlite3');
    const { createUser } = require(${JSON.stringify(path.join(__dirname, 'adminServices.js'))});
    const [filename, sectorId, username, startAt] = process.argv.slice(1);
    const db = new Database(filename);
    db.pragma('busy_timeout = 5000');
    setTimeout(() => {
      try {
        const user = createUser({
          db,
          name: username,
          username,
          password: 'senha12345',
          sectorId: Number(sectorId),
          userLimit: 1
        });
        process.stdout.write(JSON.stringify({ ok: true, id: user.id }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
      } finally {
        db.close();
      }
    }, Math.max(0, Number(startAt) - Date.now()));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', worker, filename, String(sectorId), username, String(startAt)], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`worker terminou com ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`resposta invalida do worker: ${stdout || stderr}`));
      }
    });
  });
}

test('creates and updates sectors with duplicate validation', () => {
  const db = createDb();

  const sector = createSector({ db, name: 'Financeiro' });
  assert.equal(sector.name, 'Financeiro');
  assert.equal(sector.active, 1);
  assert.equal(sector.row_version, 1);
  assert.throws(() => createSector({ db, name: 'financeiro' }), /Setor ja existe/);

  const updated = updateSector({ db, id: sector.id, name: 'Financeiro Interno', active: false });
  assert.equal(updated.name, 'Financeiro Interno');
  assert.equal(updated.active, 0);
  assert.equal(updated.row_version, 2);
  assert.deepEqual(listSectors(db).map(item => ({
    name: item.name,
    user_count: item.user_count,
    conversation_count: item.conversation_count
  })), [{ name: 'Financeiro Interno', user_count: 0, conversation_count: 0 }]);

  db.close();
});

test('creates and updates users with sectors and hashed passwords', () => {
  const db = createDb();
  const sector = createSector({ db, name: 'Vendas' });
  const supportSector = createSector({ db, name: 'Suporte' });
  const inactiveSector = createSector({ db, name: 'Inativo', active: false });

  assert.throws(
    () => createUser({ db, name: 'Sem setor', username: 'sem.setor', password: 'senha123456' }),
    /Setor obrigatorio/
  );
  assert.throws(
    () => createUser({ db, name: 'Setor inativo', username: 'setor.inativo', password: 'senha123456', sectorId: inactiveSector.id }),
    /Setor inativo/
  );

  const user = createUser({
    db,
    name: 'Jackson',
    username: '  JACKSON  ',
    password: 'senha123456',
    sectorId: sector.id
  });
  assert.equal(user.name, 'Jackson');
  assert.equal(user.username, 'jackson');
  assert.equal(user.row_version, 1);
  assert.equal(user.sector_id, sector.id);
  assert.equal(user.sector_name, 'Vendas');
  assert.equal(bcrypt.compareSync('senha123456', db.prepare('SELECT password FROM vendors WHERE id = ?').get(user.id).password), true);
  assert.throws(
    () => updateUser({
      db,
      id: user.id,
      name: 'Jackson',
      username: 'jackson',
      active: true,
      sectorId: null
    }),
    /Setor obrigatorio/
  );
  assert.throws(
    () => updateUser({
      db,
      id: user.id,
      name: 'Jackson',
      username: 'jackson',
      active: true,
      sectorId: inactiveSector.id
    }),
    /Setor inativo/
  );
  assert.throws(
    () => createUser({ db, name: 'Outro', username: 'jackson', password: 'senha123456', sectorId: sector.id }),
    /Usuario ja existe/
  );

  const updated = updateUser({
    db,
    id: user.id,
    name: 'Jackson Silva',
    username: 'jackson.silva',
    password: 'nova123456',
    active: false,
    sectorId: sector.id
  });
  assert.equal(updated.name, 'Jackson Silva');
  assert.equal(updated.username, 'jackson.silva');
  assert.equal(updated.active, 0);
  assert.equal(updated.sector_id, sector.id);
  assert.equal(updated.row_version, 2);
  assert.equal(bcrypt.compareSync('nova123456', db.prepare('SELECT password FROM vendors WHERE id = ?').get(user.id).password), true);

  const tokenVersionBeforeMove = db.prepare('SELECT token_version FROM vendors WHERE id = ?').get(user.id).token_version;
  const moved = updateUser({
    db,
    id: user.id,
    name: 'Jackson Silva',
    username: 'jackson.silva',
    active: true,
    sectorId: supportSector.id
  });
  assert.equal(moved.sector_id, supportSector.id);
  assert.equal(
    db.prepare('SELECT token_version FROM vendors WHERE id = ?').get(user.id).token_version,
    tokenVersionBeforeMove + 1
  );

  const users = listUsers(db);
  assert.equal(users.length, 1);
  assert.equal(users[0].name, 'Jackson Silva');

  db.close();
});

test('assigns conversations through the responsible user sector and rejects mismatches', () => {
  const db = createDb();
  const sector = createSector({ db, name: 'Financeiro' });
  const otherSector = createSector({ db, name: 'Vendas' });
  const activeUser = createUser({ db, name: 'Maria', username: 'maria', password: 'senha123456', sectorId: sector.id });
  const inactiveUser = createUser({ db, name: 'Joao', username: 'joao', password: 'senha123456', active: false, sectorId: sector.id });
  db.prepare("INSERT INTO conversations (id, phone, contact_name, status) VALUES (1, 'a@lid', 'Cliente A', 'unassigned')").run();

  const assigned = assignConversation({ db, conversationId: 1, vendorId: activeUser.id });
  assert.equal(assigned.assigned_to, activeUser.id);
  assert.equal(assigned.sector_id, sector.id);
  assert.equal(assigned.status, 'active');
  assert.equal(assigned.vendor_name, 'Maria');
  assert.equal(assigned.sector_name, 'Financeiro');

  assert.throws(
    () => assignConversation({ db, conversationId: 1, vendorId: activeUser.id, sectorId: otherSector.id }),
    /Usuario nao pertence ao setor informado/
  );

  assert.throws(
    () => assignConversation({ db, conversationId: 1, vendorId: inactiveUser.id, sectorId: sector.id }),
    /Usuario inativo/
  );

  const departmentQueue = assignConversation({ db, conversationId: 1, vendorId: null, sectorId: sector.id });
  assert.equal(departmentQueue.assigned_to, null);
  assert.equal(departmentQueue.sector_id, sector.id);
  assert.equal(departmentQueue.status, 'active');

  const counts = listSectors(db);
  assert.deepEqual(
    counts.map(item => [item.name, item.user_count, item.conversation_count]),
    [
      ['Financeiro', 2, 1],
      ['Vendas', 0, 0]
    ]
  );

  db.close();
});

test('sector moves reroute open assignments and deactivation releases them to the department queue', () => {
  const db = createDb();
  const sales = createSector({ db, name: 'Vendas' });
  const support = createSector({ db, name: 'Suporte' });
  const user = createUser({
    db,
    name: 'Marina',
    username: 'marina',
    password: 'senha12345',
    sectorId: sales.id
  });
  db.prepare(`
    INSERT INTO conversations (id, phone, assigned_to, sector_id, status)
    VALUES (1, 'open@c.us', ?, ?, 'active'),
           (2, 'closed@c.us', ?, ?, 'closed')
  `).run(user.id, sales.id, user.id, sales.id);

  const moved = updateUser({
    db,
    id: user.id,
    name: user.name,
    username: user.username,
    sectorId: support.id,
    active: true,
    expectedVersion: user.row_version
  });
  assert.deepEqual(
    db.prepare('SELECT assigned_to, sector_id, status FROM conversations WHERE id = 1').get(),
    { assigned_to: user.id, sector_id: support.id, status: 'active' }
  );
  assert.deepEqual(
    db.prepare('SELECT assigned_to, sector_id, status FROM conversations WHERE id = 2').get(),
    { assigned_to: user.id, sector_id: sales.id, status: 'closed' }
  );

  updateUser({
    db,
    id: user.id,
    name: user.name,
    username: user.username,
    sectorId: support.id,
    active: false,
    expectedVersion: moved.row_version
  });
  assert.deepEqual(
    db.prepare('SELECT assigned_to, sector_id, status FROM conversations WHERE id = 1').get(),
    { assigned_to: null, sector_id: support.id, status: 'active' }
  );
  db.close();
});

test('enforces active user seats atomically on creation and reactivation', () => {
  const db = createDb();
  const sector = createSector({ db, name: 'Comercial' });
  const first = createUser({
    db, name: 'Primeiro', username: 'primeiro', password: 'senha12345', sectorId: sector.id, userLimit: 1
  });
  assert.equal(countActiveUsers(db), 1);
  assert.throws(
    () => createUser({
      db, name: 'Segundo', username: 'segundo', password: 'senha12345', sectorId: sector.id, userLimit: 1
    }),
    /Limite de 1 usuarios ativos atingido/
  );

  const inactive = createUser({
    db, name: 'Inativo', username: 'inativo', password: 'senha12345', active: false, sectorId: sector.id, userLimit: 1
  });
  assert.equal(countActiveUsers(db), 1);
  assert.throws(
    () => updateUser({
      db,
      id: inactive.id,
      name: inactive.name,
      username: inactive.username,
      active: true,
      sectorId: sector.id,
      userLimit: 1
    }),
    /Limite de 1 usuarios ativos atingido/
  );

  updateUser({
    db,
    id: first.id,
    name: first.name,
    username: first.username,
    active: false,
    sectorId: sector.id,
    userLimit: 1
  });
  const reactivated = updateUser({
    db,
    id: inactive.id,
    name: inactive.name,
    username: inactive.username,
    active: true,
    sectorId: sector.id,
    userLimit: 1
  });
  assert.equal(reactivated.active, 1);
  assert.equal(countActiveUsers(db), 1);
  db.close();
});

test('two server processes cannot exceed the same active-user seat limit', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-seat-race-'));
  const filename = path.join(directory, 'tenant.db');
  const setupDb = new Database(filename);
  ensureSchema(setupDb);
  setupDb.pragma('journal_mode = WAL');
  setupDb.pragma('busy_timeout = 5000');
  const sector = createSector({ db: setupDb, name: 'Comercial' });
  setupDb.close();

  try {
    const startAt = Date.now() + 500;
    const results = await Promise.all([
      createUserInChildProcess({ filename, sectorId: sector.id, username: 'race.one', startAt }),
      createUserInChildProcess({ filename, sectorId: sector.id, username: 'race.two', startAt })
    ]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.deepEqual(
      results.filter(result => !result.ok).map(result => result.code),
      ['USER_LIMIT_REACHED']
    );
    const verifyDb = new Database(filename, { readonly: true });
    assert.equal(countActiveUsers(verifyDb), 1);
    verifyDb.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects stale writes and rolls back the tenant row when the global directory callback fails', () => {
  const db = createDb();
  const sector = createSector({ db, name: 'Comercial' });
  const user = createUser({
    db,
    name: 'Ana',
    username: 'ana.vendas',
    password: 'senha12345',
    sectorId: sector.id,
    onBeforeCommit: () => assert.equal(db.inTransaction, true)
  });

  const changed = updateUser({
    db,
    id: user.id,
    name: 'Ana Silva',
    username: user.username,
    sectorId: sector.id,
    active: true,
    expectedVersion: user.row_version
  });
  assert.equal(changed.row_version, 2);
  assert.throws(
    () => updateUser({
      db,
      id: user.id,
      name: 'Sobrescrita antiga',
      username: user.username,
      sectorId: sector.id,
      active: true,
      expectedVersion: user.row_version
    }),
    err => err.code === 'STALE_WRITE' && err.statusCode === 409
  );
  assert.equal(listUsers(db)[0].name, 'Ana Silva');

  assert.throws(
    () => updateUser({
      db,
      id: user.id,
      name: 'Nao deve persistir',
      username: 'ana.nova',
      sectorId: sector.id,
      active: true,
      expectedVersion: changed.row_version,
      onBeforeCommit: () => { throw new Error('diretorio indisponivel'); }
    }),
    /diretorio indisponivel/
  );
  const afterRollback = listUsers(db)[0];
  assert.equal(afterRollback.name, 'Ana Silva');
  assert.equal(afterRollback.username, 'ana.vendas');
  assert.equal(afterRollback.row_version, 2);
  db.close();
});

test('sector deactivation is guarded while active users exist and stale sector edits cannot overwrite', () => {
  const db = createDb();
  const sector = createSector({ db, name: 'Suporte' });
  const user = createUser({
    db, name: 'Bia', username: 'bia', password: 'senha12345', sectorId: sector.id
  });
  db.prepare(`
    INSERT INTO conversations (id, phone, assigned_to, sector_id, status)
    VALUES (1, 'open@c.us', ?, ?, 'active'),
           (2, 'closed@c.us', ?, ?, 'closed')
  `).run(user.id, sector.id, user.id, sector.id);

  assert.throws(
    () => updateSector({
      db,
      id: sector.id,
      name: sector.name,
      active: false,
      expectedVersion: sector.row_version
    }),
    err => err.code === 'SECTOR_HAS_ACTIVE_USERS' && err.activeUsers === 1
  );

  const inactiveUser = updateUser({
    db,
    id: user.id,
    name: user.name,
    username: user.username,
    sectorId: sector.id,
    active: false,
    expectedVersion: user.row_version
  });
  assert.equal(inactiveUser.active, 0);
  const inactiveSector = updateSector({
    db,
    id: sector.id,
    name: 'Suporte interno',
    active: false,
    expectedVersion: sector.row_version
  });
  assert.equal(inactiveSector.active, 0);
  assert.deepEqual(
    db.prepare('SELECT assigned_to, sector_id, status FROM conversations WHERE id = 1').get(),
    { assigned_to: null, sector_id: null, status: 'unassigned' }
  );
  assert.deepEqual(
    db.prepare('SELECT assigned_to, sector_id, status FROM conversations WHERE id = 2').get(),
    { assigned_to: user.id, sector_id: sector.id, status: 'closed' }
  );
  assert.throws(
    () => updateSector({
      db,
      id: sector.id,
      name: 'Edicao antiga',
      active: true,
      expectedVersion: sector.row_version
    }),
    err => err.code === 'STALE_WRITE'
  );
  db.close();
});

test('inactive users may be staged in inactive sectors but cannot be reactivated there', () => {
  const db = createDb();
  const sector = createSector({ db, name: 'Sazonal', active: false });
  const user = createUser({
    db,
    name: 'Temporario',
    username: 'temporario',
    password: 'senha12345',
    active: false,
    sectorId: sector.id
  });
  assert.equal(user.active, 0);
  assert.throws(
    () => updateUser({
      db,
      id: user.id,
      name: user.name,
      username: user.username,
      active: true,
      sectorId: sector.id,
      expectedVersion: user.row_version
    }),
    err => err.code === 'SECTOR_INACTIVE'
  );
  db.close();
});

test('deactivation revokes tokens, increments row version and returns 404 for unknown users', () => {
  const db = createDb();
  const sector = createSector({ db, name: 'Atendimento' });
  const user = createUser({
    db, name: 'Carlos', username: 'carlos', password: 'senha12345', sectorId: sector.id
  });
  db.prepare(`
    INSERT INTO conversations (phone, assigned_to, sector_id, status)
    VALUES ('assigned@c.us', ?, ?, 'active')
  `).run(user.id, sector.id);
  const before = db.prepare('SELECT token_version, row_version FROM vendors WHERE id = ?').get(user.id);
  const deactivated = deactivateUser({ db, id: user.id, expectedVersion: user.row_version });
  const after = db.prepare('SELECT active, token_version, row_version FROM vendors WHERE id = ?').get(user.id);
  assert.equal(deactivated.active, 0);
  assert.equal(after.token_version, before.token_version + 1);
  assert.equal(after.row_version, before.row_version + 1);
  assert.deepEqual(
    db.prepare('SELECT assigned_to, sector_id, status FROM conversations WHERE phone = ?').get('assigned@c.us'),
    { assigned_to: null, sector_id: sector.id, status: 'active' }
  );
  assert.throws(() => deactivateUser({ db, id: 999 }), err => err.statusCode === 404 && err.code === 'USER_NOT_FOUND');
  db.close();
});

test('validates booleans, usernames and bcrypt 72-byte password boundary', () => {
  const db = createDb();
  const sector = createSector({ db, name: 'Vendas' });
  assert.throws(
    () => createUser({
      db, name: 'String bool', username: 'string.bool', password: 'senha12345', active: 'false', sectorId: sector.id
    }),
    /Status ativo invalido/
  );
  assert.throws(
    () => createUser({
      db, name: 'Login ruim', username: 'login com espaco', password: 'senha12345', sectorId: sector.id
    }),
    /Usuario invalido/
  );
  assert.throws(
    () => createUser({
      db, name: 'Senha longa', username: 'senha.longa', password: 'á'.repeat(37), sectorId: sector.id
    }),
    /maximo 72 bytes/
  );
  assert.throws(
    () => createUser({
      db, name: 'Senha curta', username: 'senha.curta', password: '😀😀😀😀😀', sectorId: sector.id
    }),
    /minimo 10 caracteres/
  );
  const boundary = createUser({
    db, name: 'Senha limite', username: 'senha.limite', password: 'a'.repeat(72), sectorId: sector.id
  });
  assert.equal(boundary.active, 1);
  db.close();
});

test('two admin database connections cannot overwrite each other with stale revisions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-concurrency-'));
  const filename = path.join(directory, 'tenant.db');
  const firstDb = new Database(filename);
  ensureSchema(firstDb);
  const secondDb = new Database(filename);
  ensureSchema(secondDb);
  try {
    const sector = createSector({ db: firstDb, name: 'Concorrente' });
    const user = createUser({
      db: firstDb,
      name: 'Versao inicial',
      username: 'concorrente',
      password: 'senha12345',
      sectorId: sector.id
    });
    const snapshotFromOtherAdmin = listUsers(secondDb)[0];
    assert.equal(snapshotFromOtherAdmin.row_version, user.row_version);

    const firstWrite = updateUser({
      db: firstDb,
      id: user.id,
      name: 'Primeiro admin',
      username: user.username,
      active: true,
      sectorId: sector.id,
      expectedVersion: user.row_version
    });
    assert.equal(firstWrite.row_version, user.row_version + 1);

    assert.throws(
      () => updateUser({
        db: secondDb,
        id: snapshotFromOtherAdmin.id,
        name: 'Segundo admin atrasado',
        username: snapshotFromOtherAdmin.username,
        active: true,
        sectorId: sector.id,
        expectedVersion: snapshotFromOtherAdmin.row_version
      }),
      err => err.code === 'STALE_WRITE' && err.statusCode === 409
    );
    assert.equal(listUsers(secondDb)[0].name, 'Primeiro admin');
  } finally {
    secondDb.close();
    firstDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
