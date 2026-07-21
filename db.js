const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const { ensureSchema, applyPragmas } = require('./schema');
const { createTenantScopedProxy } = require('./tenantDbProxy');
const { normalizeUsername } = require('./userDirectoryIntegrity');
const { ensureProductionWriterLease } = require('./productionWriterBootstrap');
const { isInternalEdition } = require('./internalEdition');
const bcrypt = require('bcryptjs');

const INTERNAL_EDITION = isInternalEdition();

// Contexto de tenant para requisições — permite que o mesmo `db.prepare(...)`
// aponte automaticamente pro banco do tenant sem alterar o código existente.
const tenantCtx = new AsyncLocalStorage();

// Banco padrão (fallback quando não há tenant, ex: login). Fica em data/
// (volume persistido) junto com os -wal/-shm — ver comentário em tenantManager.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
// Deve acontecer antes de abrir/migrar data.db ou criar o superadmin. Assim,
// uma segunda réplica de produção falha sem produzir nenhuma escrita lateral.
const productionWriterBootstrap = ensureProductionWriterLease({ dataDir: DATA_DIR });
const defaultDb = new Database(path.join(DATA_DIR, 'data.db'));
applyPragmas(defaultDb);
ensureSchema(defaultDb);

// O .env é a fonte declarativa da única identidade superadmin da plataforma.
// Alterar usuário/senha rotaciona a credencial e revoga tokens anteriores;
// identidades antigas nunca ficam ativas silenciosamente.
const initialAdminUsername = normalizeUsername(process.env.ADMIN_USERNAME || 'admin');
const initialAdminPassword = process.env.ADMIN_PASSWORD || process.env.ADMIN_INITIAL_PASSWORD || '';
if (!initialAdminUsername) throw new Error('ADMIN_USERNAME invalido');
if (initialAdminPassword) {
  const passwordBytes = Buffer.byteLength(initialAdminPassword, 'utf8');
  if (Array.from(initialAdminPassword).length < 10 || passwordBytes > 72) {
    throw new Error('ADMIN_PASSWORD deve ter entre 10 caracteres e 72 bytes UTF-8');
  }
}
if (productionWriterBootstrap && !INTERNAL_EDITION) {
  const hasDirectory = productionWriterBootstrap.master.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_directory'
  `).get();
  const tenantIdentity = hasDirectory
    ? productionWriterBootstrap.master.prepare(`
        SELECT 1 FROM user_directory WHERE username = ? COLLATE NOCASE
      `).get(initialAdminUsername)
    : null;
  if (tenantIdentity) {
    throw new Error('ADMIN_USERNAME colide com uma identidade de tenant existente');
  }
}

if (INTERNAL_EDITION) {
  // A edição interna não possui identidade de plataforma. O único proprietário
  // é criado como admin do tenant `default` pelo tenantManager, para que todas
  // as operações continuem presas ao contexto/DB da empresa.
  defaultDb.transaction(() => {
    defaultDb.prepare('DELETE FROM admins').run();
  }).immediate();
} else {
  defaultDb.transaction(() => {
    const superAdmins = defaultDb.prepare(`
    SELECT * FROM admins WHERE coalesce(super_admin, 0) = 1 ORDER BY id
  `).all();
    const targetRow = defaultDb.prepare(`
    SELECT * FROM admins WHERE username = ? COLLATE NOCASE
  `).get(initialAdminUsername);
    let selected = superAdmins.find(admin => Number(admin.id) === Number(targetRow?.id)) || superAdmins[0] || null;

  if (!selected) {
    if (targetRow) {
      throw new Error('ADMIN_USERNAME ja pertence a uma conta nao-superadmin no banco da plataforma');
    }
    if (!initialAdminPassword) {
      throw new Error('ADMIN_PASSWORD obrigatorio para criar o primeiro admin');
    }
    const created = defaultDb.prepare(`
      INSERT INTO admins (name, username, password, super_admin)
      VALUES (?, ?, ?, 1)
    `).run(initialAdminUsername, initialAdminUsername, bcrypt.hashSync(initialAdminPassword, 10));
    selected = { id: Number(created.lastInsertRowid), username: initialAdminUsername };
  } else {
    if (targetRow && Number(targetRow.id) !== Number(selected.id)) {
      throw new Error('ADMIN_USERNAME ja pertence a outra conta no banco da plataforma');
    }
    const usernameChanged = normalizeUsername(selected.username) !== initialAdminUsername;
    const passwordChanged = initialAdminPassword
      ? !bcrypt.compareSync(initialAdminPassword, selected.password)
      : false;
    if (usernameChanged || passwordChanged) {
      const nextHash = passwordChanged
        ? bcrypt.hashSync(initialAdminPassword, 10)
        : selected.password;
      defaultDb.prepare(`
        UPDATE admins
        SET name = ?, username = ?, password = ?, token_version = token_version + 1
        WHERE id = ?
      `).run(initialAdminUsername, initialAdminUsername, nextHash, selected.id);
    }
  }

  // Corrige legado criado por mudanças sucessivas de ADMIN_USERNAME: apenas a
  // identidade declarada permanece privilegiada e todas as sessões antigas
  // são invalidadas.
  defaultDb.prepare(`
    UPDATE admins
    SET super_admin = 0, token_version = token_version + 1
    WHERE coalesce(super_admin, 0) = 1 AND id <> ?
  `).run(selected.id);
  }).immediate();
}

// Fail closed: chamadas genéricas sem AsyncLocalStorage nunca caem no banco
// padrão. Operações da plataforma devem usar db.defaultDb explicitamente.
const db = createTenantScopedProxy(defaultDb, tenantCtx);

db.tenantCtx = tenantCtx;
db.defaultDb = defaultDb;
db.createDb = (dbPath) => {
  const d = new Database(dbPath);
  applyPragmas(d);
  ensureSchema(d);
  return d;
};

module.exports = db;
