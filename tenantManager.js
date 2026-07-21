const Database = require('better-sqlite3');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { ensureSchema, applyPragmas } = require('./schema');
const {
  ensureProductionWriterLease,
  releaseProductionWriterLease
} = require('./productionWriterBootstrap');
const { encryptSecret, decryptSecret, maskSecret } = require('./secretVault');
const { getInternalAgentLimit, isInternalEdition } = require('./internalEdition');
const {
  normalizeUsername,
  collectTenantAccounts,
  findIdentityConflicts,
  auditDirectoryEntries
} = require('./userDirectoryIntegrity');

const TRIAL_DAYS = 3;
const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;
const DEFAULT_PLAN = 'basico';
const PLAN_USER_LIMITS = Object.freeze({
  basico: 5,
  profissional: 10
});
const TENANT_NAME_MAX_LENGTH = 160;
const TENANT_KEY_MAX_LENGTH = 63;
const INTERNAL_EDITION = isInternalEdition();

function inputError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function conflictError(message) {
  const err = new Error(message);
  err.statusCode = 409;
  return err;
}

function notFoundError(message = 'Tenant nao encontrado') {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function normalizeTenantName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw inputError('Nome da empresa obrigatorio');
  if (name.length > TENANT_NAME_MAX_LENGTH) {
    throw inputError(`Nome da empresa deve ter no maximo ${TENANT_NAME_MAX_LENGTH} caracteres`);
  }
  if (/\p{Cc}/u.test(name)) throw inputError('Nome da empresa invalido');
  return name;
}

function normalizeTenantKey(value, label = 'Slug') {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!key || key.length > TENANT_KEY_MAX_LENGTH || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(key)) {
    throw inputError(`${label} invalido`);
  }
  return key;
}

function tenantSlugBase(value) {
  const normalized = normalizeTenantName(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TENANT_KEY_MAX_LENGTH)
    .replace(/-+$/g, '');
  return normalized || 'empresa';
}

function uniqueTenantKey(base) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const prefix = base.slice(0, TENANT_KEY_MAX_LENGTH - suffix.length - 1).replace(/-+$/g, '') || 'empresa';
  return `${prefix}-${suffix}`;
}

function normalizeTenantId(value) {
  if (typeof value === 'boolean') throw inputError('Tenant invalido');
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value.trim())) {
    throw inputError('Tenant invalido');
  }
  const tenantId = Number(value);
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
    throw inputError('Tenant invalido');
  }
  return tenantId;
}

function normalizePlan(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const plan = !raw || raw === 'padrao' ? DEFAULT_PLAN : raw;
  if (!Object.hasOwn(PLAN_USER_LIMITS, plan)) {
    throw inputError('Plano invalido. Use basico ou profissional');
  }
  return plan;
}

function normalizeUserLimitOverride(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw inputError('Limite de usuarios deve ser um inteiro positivo');
  }
  return limit;
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
// master.db e os bancos por tenant ficam DENTRO de data/ (montado como volume).
// Em modo WAL, os arquivos -wal/-shm precisam estar no mesmo volume persistido;
// montar master.db como arquivo único perdia o WAL a cada restart do container.
const MASTER_PATH = path.join(DATA_DIR, 'master.db');
const AUTH_DIR = path.resolve(process.env.WA_AUTH_DIR || path.join(__dirname, '.wwebjs_auth'));
const MEDIA_DIR = path.resolve(process.env.MEDIA_ROOT || path.join(__dirname, 'media'));

// ============ MASTER DATABASE ============

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const productionWriterBootstrap = ensureProductionWriterLease({ dataDir: DATA_DIR });
const master = productionWriterBootstrap?.master || new Database(MASTER_PATH);
if (!productionWriterBootstrap) applyPragmas(master);
// O runtime atual mantém sessão WhatsApp, presença Socket.IO e SQLite locais;
// portanto produção é deliberadamente single-writer. Este lease evita
// split-brain entre duas réplicas apontando para o mesmo volume. Escala
// horizontal exigirá um coordenador externo para esses três componentes.
master.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    slug          TEXT    NOT NULL UNIQUE,
    subdomain     TEXT    NOT NULL UNIQUE,
    status        TEXT    DEFAULT 'active',
    settings      TEXT    DEFAULT '{}',
    created_at    TEXT    DEFAULT (datetime('now'))
  )
`);

function ensureMasterColumn(table, column, definition) {
  const has = master.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
  if (!has) master.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

// ============ COBRANÇA (Stripe) ============
ensureMasterColumn('tenants', 'billing_status', "TEXT DEFAULT 'trialing'");
ensureMasterColumn('tenants', 'trial_ends_at', 'TEXT');
ensureMasterColumn('tenants', 'stripe_customer_id', 'TEXT');
ensureMasterColumn('tenants', 'stripe_subscription_id', 'TEXT');
ensureMasterColumn('tenants', 'stripe_checkout_session_id', 'TEXT');
// Prazo local da reserva operacional criada junto com o Checkout. Uma sessao
// aberta ainda nao e receita, mas precisa reservar uma vaga para que o cliente
// nunca conclua o Checkout e descubra depois que nao ha capacidade. O prazo
// torna essa reserva finita e permite recuperar cadastros abandonados.
ensureMasterColumn('tenants', 'checkout_expires_at', 'TEXT');
ensureMasterColumn('tenants', 'stripe_price_id', 'TEXT');
ensureMasterColumn('tenants', 'stripe_last_event_created', 'INTEGER DEFAULT 0');
ensureMasterColumn('tenants', 'stripe_last_event_id', 'TEXT');
ensureMasterColumn('tenants', 'plan', "TEXT DEFAULT 'basico'");
ensureMasterColumn('tenants', 'plan_price_cents', 'INTEGER');
ensureMasterColumn('tenants', 'user_limit_override', 'INTEGER');
ensureMasterColumn('tenants', 'comp', 'INTEGER DEFAULT 0');
ensureMasterColumn('tenants', 'trial_notified_at', 'TEXT');
ensureMasterColumn('tenants', 'billing_block_reason', 'TEXT');
// Guarda o estado que a Stripe pretendia aplicar quando um downgrade deixou
// mais assentos ativos do que o novo plano permite. Sem isso, o cliente ficava
// suspenso para sempre mesmo depois de desativar os assentos excedentes.
ensureMasterColumn('tenants', 'billing_resume_status', 'TEXT');

// Identificadores de tenant e vínculos Stripe são globais. As restrições
// abaixo fazem o banco rejeitar qualquer ambiguidade em vez de deixar a
// aplicação escolher silenciosamente o cliente errado.
master.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_slug_nocase
    ON tenants(slug COLLATE NOCASE);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_subdomain_nocase
    ON tenants(subdomain COLLATE NOCASE);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_stripe_customer
    ON tenants(stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL AND stripe_customer_id <> '';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_stripe_subscription
    ON tenants(stripe_subscription_id)
    WHERE stripe_subscription_id IS NOT NULL AND stripe_subscription_id <> '';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_stripe_checkout
    ON tenants(stripe_checkout_session_id)
    WHERE stripe_checkout_session_id IS NOT NULL AND stripe_checkout_session_id <> '';
`);

// Converte os rotulos legados para os dois planos efetivamente suportados.
master.exec(`
  UPDATE tenants
  SET plan = 'basico'
  WHERE plan IS NULL OR lower(trim(plan)) NOT IN ('basico', 'profissional');

  UPDATE tenants
  SET plan = lower(trim(plan))
  WHERE plan IS NOT NULL;

  UPDATE tenants
  SET status = 'active'
  WHERE status IS NULL OR status NOT IN ('active', 'suspended', 'provisioning');

  -- Trials criados antes da politica de tres dias nunca podem ser prorrogados.
  -- Assinaturas ja existentes ficam sob a fonte da verdade da Stripe.
  UPDATE tenants
  SET trial_ends_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+3 days')
  WHERE billing_status = 'trialing'
    AND coalesce(stripe_subscription_id, '') = ''
    AND (
      trial_ends_at IS NULL
      OR julianday(trial_ends_at) > julianday(created_at, '+3 days')
    );
`);

// Registro duravel dos webhooks permite idempotencia inclusive entre restarts.
master.exec(`
  CREATE TABLE IF NOT EXISTS stripe_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    event_created INTEGER NOT NULL,
    tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
    processing_status TEXT NOT NULL DEFAULT 'processing'
      CHECK(processing_status IN ('processing', 'processed', 'ignored', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 1,
    detail TEXT,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_stripe_events_tenant_created
    ON stripe_events(tenant_id, event_created DESC);
  CREATE INDEX IF NOT EXISTS idx_stripe_events_status
    ON stripe_events(processing_status, updated_at);

  CREATE TABLE IF NOT EXISTS tenant_deletion_cleanup (
    deletion_id TEXT PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    artifacts TEXT NOT NULL DEFAULT '[]',
    media_files TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'processed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tenant_deletion_cleanup_pending
    ON tenant_deletion_cleanup(status, created_at);

  CREATE TABLE IF NOT EXISTS tenant_deletion_restore (
    deletion_id TEXT PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    previous_status TEXT NOT NULL,
    entries TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'restored')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    restored_at TEXT
  );

  CREATE TABLE IF NOT EXISTS password_reset_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    admin_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'resolved')),
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolved_by TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_one_pending
    ON password_reset_requests(tenant_id, admin_id)
    WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS idx_password_reset_pending
    ON password_reset_requests(status, requested_at, id);
`);

// Migrações aditivas das sagas. `forward_only` é gravado antes de qualquer
// compensação externa irreversível; depois dele o boot sempre conclui a
// exclusão e nunca restaura uma assinatura já cancelada.
ensureMasterColumn('tenant_deletion_restore', 'commit_state', "TEXT NOT NULL DEFAULT 'reversible'");
ensureMasterColumn('tenant_deletion_restore', 'media_files', "TEXT NOT NULL DEFAULT '[]'");
ensureMasterColumn('password_reset_requests', 'resolution_hash', 'TEXT');
ensureMasterColumn('password_reset_requests', 'resolution_started_at', 'TEXT');
ensureMasterColumn('password_reset_requests', 'resolution_resolver', 'TEXT');
ensureMasterColumn('password_reset_requests', 'resolution_target_at', 'TEXT');
master.exec(`
  CREATE INDEX IF NOT EXISTS idx_tenant_deletion_restore_forward
    ON tenant_deletion_restore(status, commit_state, created_at);
`);

// ============ AUDITORIA ============

master.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor       TEXT    NOT NULL,
    action      TEXT    NOT NULL,
    tenant_id   INTEGER,
    detail      TEXT,
    created_at  TEXT    DEFAULT (datetime('now'))
  )
`);

// ============ CONFIGURAÇÃO DA PLATAFORMA (Stripe / Turnstile) ============
// Chaves que antes só existiam como variáveis de ambiente agora podem ser
// preenchidas pelo super admin em runtime e ficam no master.db. Segredos são
// criptografados em repouso (secretVault, chave derivada do JWT_SECRET); chaves
// públicas (site key do Turnstile, price ids) ficam em texto puro.
master.exec(`
  CREATE TABLE IF NOT EXISTS platform_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    is_secret  INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const PLATFORM_SECRET_KEYS = new Set([
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'TURNSTILE_SECRET_KEY'
]);
const PLATFORM_PUBLIC_KEYS = new Set([
  'STRIPE_PRICE_ID',
  'STRIPE_PRICE_ID_BASIC',
  'STRIPE_PRICE_ID_PRO',
  'TURNSTILE_SITE_KEY'
]);
const PLATFORM_KEYS = new Set([...PLATFORM_SECRET_KEYS, ...PLATFORM_PUBLIC_KEYS]);

const selectAllPlatformSettingsStmt = master.prepare(
  'SELECT key, value, is_secret FROM platform_settings'
);
const upsertPlatformSettingStmt = master.prepare(`
  INSERT INTO platform_settings (key, value, is_secret, updated_at)
  VALUES (@key, @value, @is_secret, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    is_secret = excluded.is_secret,
    updated_at = datetime('now')
`);
const deletePlatformSettingStmt = master.prepare('DELETE FROM platform_settings WHERE key = ?');

// Cache em memória do env resolvido. better-sqlite3 é síncrono, então recarregar
// é barato; o cache evita descriptografar a cada leitura de billing/webhook.
let resolvedPlatformEnvCache = null;

function loadResolvedPlatformEnv() {
  const out = {};
  for (const row of selectAllPlatformSettingsStmt.all()) {
    if (!PLATFORM_KEYS.has(row.key)) continue;
    let value = row.value;
    if (row.is_secret) {
      try {
        value = decryptSecret(row.value);
      } catch {
        // JWT_SECRET trocado ou blob corrompido: trata como não configurado em
        // vez de derrubar o processo. O super admin reconfigura pelo painel.
        value = '';
      }
    }
    if (value) out[row.key] = value;
  }
  return out;
}

function getResolvedPlatformEnv() {
  if (!resolvedPlatformEnvCache) resolvedPlatformEnvCache = loadResolvedPlatformEnv();
  return { ...resolvedPlatformEnvCache };
}

function invalidatePlatformEnvCache() {
  resolvedPlatformEnvCache = null;
}

function getPlatformSetting(key) {
  return getResolvedPlatformEnv()[key] || '';
}

// Aplica um lote de atualizações. Valor vazio remove a chave (limpar); valor não
// vazio grava (criptografando se for segredo). Só chaves da allowlist são aceitas.
// A rota decide o que incluir — segredos só entram quando o operador digita um
// valor novo, nunca a máscara exibida.
function setPlatformConfig(updates = {}) {
  const applied = [];
  const tx = master.transaction((entries) => {
    for (const [key, rawValue] of entries) {
      if (!PLATFORM_KEYS.has(key)) continue;
      const value = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();
      const isSecret = PLATFORM_SECRET_KEYS.has(key);
      if (value === '') {
        deletePlatformSettingStmt.run(key);
      } else {
        upsertPlatformSettingStmt.run({
          key,
          value: isSecret ? encryptSecret(value) : value,
          is_secret: isSecret ? 1 : 0
        });
      }
      applied.push(key);
    }
  });
  tx(Object.entries(updates));
  invalidatePlatformEnvCache();
  return applied;
}

// Status para o painel: nunca devolve segredos crus, apenas se estão configurados
// e uma máscara. Chaves públicas voltam inteiras para exibição/edição.
function getPlatformConfigStatus() {
  const resolved = getResolvedPlatformEnv();
  const status = {};
  for (const key of PLATFORM_KEYS) {
    const value = resolved[key] || '';
    const isSecret = PLATFORM_SECRET_KEYS.has(key);
    status[key] = {
      configured: Boolean(value),
      secret: isSecret,
      value: isSecret ? '' : value,
      masked: isSecret ? maskSecret(value) : value
    };
  }
  return status;
}

// ============ SUPORTE ENTRE CLIENTE E SUPER ADMIN ============
// O suporte pertence à plataforma, não ao banco isolado de um tenant. Guardá-lo
// no master permite que o super admin veja e responda todas as empresas sem
// misturar o histórico operacional de WhatsApp de cada uma.
master.exec(`
  CREATE TABLE IF NOT EXISTS support_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'open',
    last_message_at TEXT,
    tenant_last_read_message_id INTEGER,
    super_last_read_message_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sender_type TEXT NOT NULL CHECK(sender_type IN ('tenant', 'super_admin')),
    sender_id INTEGER,
    content TEXT NOT NULL DEFAULT '',
    media_type TEXT,
    media_mimetype TEXT,
    media_filename TEXT,
    media_url TEXT,
    media_size INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_support_threads_activity
    ON support_threads(last_message_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_support_messages_thread
    ON support_messages(thread_id, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_support_messages_tenant
    ON support_messages(tenant_id, id);
`);

function logAudit(actor, action, tenantId, detail) {
  master.prepare(
    'INSERT INTO audit_log (actor, action, tenant_id, detail) VALUES (?, ?, ?, ?)'
  ).run(actor || 'system', action, tenantId || null, detail ? JSON.stringify(detail) : null);
}

function listAuditLog(limit = 200) {
  return master.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

// ============ DIRETÓRIO GLOBAL DE USUÁRIOS ============
// Mapeia username -> tenant, para permitir login por um único domínio
// (sem depender de subdomínio) e garantir username único em toda a plataforma.

master.exec(`
  CREATE TABLE IF NOT EXISTS user_directory (
    username   TEXT    PRIMARY KEY,
    tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
    role       TEXT    NOT NULL
  )
`);

// Identidades de login sao case-insensitive. Se uma base legada tiver Foo e
// foo para pessoas diferentes, a inicializacao falha em vez de escolher um
// tenant ambiguamente (o que seria uma falha de isolamento/autenticacao).
master.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_user_directory_username_nocase
    ON user_directory(username COLLATE NOCASE);
  UPDATE user_directory SET username = lower(trim(username));
`);

function findDirectoryUser(username) {
  const normalized = normalizeUsername(username);
  if (!normalized) return undefined;
  return master.prepare('SELECT * FROM user_directory WHERE username = ? COLLATE NOCASE').get(normalized);
}

function listPlatformSuperAdminUsernames() {
  const platformPath = path.join(DATA_DIR, 'data.db');
  if (!fs.existsSync(platformPath)) return [];
  let platformDb;
  try {
    platformDb = new Database(platformPath, { readonly: true, fileMustExist: true });
    const hasAdmins = platformDb.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'admins'"
    ).get();
    if (!hasAdmins) return [];
    return platformDb.prepare('SELECT username FROM admins WHERE super_admin = 1').all()
      .map(row => normalizeUsername(row.username))
      .filter(Boolean);
  } finally {
    try { platformDb?.close(); } catch {}
  }
}

function registerDirectoryUser(username, tenantId, role) {
  const normalized = normalizeUsername(username);
  if (!normalized || normalized.length > 254 || /\p{Cc}/u.test(normalized)) {
    throw inputError('Usuario invalido');
  }
  if (!['admin', 'vendor'].includes(role)) throw inputError('Papel de usuario invalido');
  const id = normalizeTenantId(tenantId);
  if (listPlatformSuperAdminUsernames().includes(normalized)) {
    throw conflictError('Usuário reservado pelo super admin da plataforma');
  }
  return master.transaction(() => {
    // DO NOTHING é intencional: um UPSERT que atualizasse o owner permitiria
    // que dois cadastros concorrentes transferissem o login entre tenants.
    master.prepare(`
      INSERT INTO user_directory (username, tenant_id, role)
      VALUES (?, ?, ?)
      ON CONFLICT(username) DO NOTHING
    `).run(normalized, id, role);
    const persisted = findDirectoryUser(normalized);
    if (!persisted || Number(persisted.tenant_id) !== id || persisted.role !== role) {
      throw conflictError('Usuário já cadastrado em outra empresa');
    }
    return persisted;
  })();
}

function renameDirectoryUser(oldUsername, newUsername, tenantId, role) {
  const oldNormalized = normalizeUsername(oldUsername);
  const newNormalized = normalizeUsername(newUsername);
  if (oldNormalized === newNormalized) {
    return registerDirectoryUser(newNormalized, tenantId, role);
  }
  const id = normalizeTenantId(tenantId);
  return master.transaction(() => {
    const previous = findDirectoryUser(oldNormalized);
    if (previous && (Number(previous.tenant_id) !== id || previous.role !== role)) {
      throw conflictError('Usuário anterior pertence a outra empresa');
    }
    const existing = findDirectoryUser(newNormalized);
    if (existing) throw conflictError('Usuário já cadastrado em outra empresa');
    registerDirectoryUser(newNormalized, id, role);
    master.prepare(`
      DELETE FROM user_directory
      WHERE username = ? COLLATE NOCASE AND tenant_id = ? AND role = ?
    `).run(oldNormalized, id, role);
    return findDirectoryUser(newNormalized);
  })();
}

// ============ PER-TENANT DATABASES ============

const tenantDbs = new Map();
const tenantDbLeases = new Map();
const tenantsBeingDeleted = new Set();

function getTenantDbPath(tenantId) {
  const id = normalizeTenantId(tenantId);
  return path.join(DATA_DIR, `data_${id}.db`);
}

function getTenantAuthPath(tenantId) {
  const id = normalizeTenantId(tenantId);
  return path.join(AUTH_DIR, `tenant_${id}`);
}

function openTenantDb(tenantId, { create = false } = {}) {
  const id = normalizeTenantId(tenantId);
  const dbPath = getTenantDbPath(id);
  const db = new Database(dbPath, create ? {} : { fileMustExist: true });
  applyPragmas(db);
  ensureSchema(db);
  return db;
}

// Marca do último acesso por tenant, para fechar handles ociosos e não manter
// 50+ conexões SQLite abertas para sempre (consome file descriptors e memória).
const tenantDbLastAccess = new Map();
const TENANT_DB_IDLE_MS = Number(process.env.TENANT_DB_IDLE_MS || 10 * 60 * 1000);
const TENANT_DB_SWEEP_MS = Number(process.env.TENANT_DB_SWEEP_MS || 60 * 1000);

function getTenantDb(tenantId) {
  const id = normalizeTenantId(tenantId);
  const durableDeletion = master.prepare(`
    SELECT deletion_id, commit_state
    FROM tenant_deletion_restore
    WHERE tenant_id = ? AND status = 'pending'
    LIMIT 1
  `).get(id);
  if (tenantsBeingDeleted.has(id) || durableDeletion) {
    const err = new Error('Tenant em processo de exclusao');
    err.statusCode = 409;
    err.code = 'TENANT_DELETION_PENDING';
    throw err;
  }
  if (!master.prepare('SELECT 1 FROM tenants WHERE id = ?').get(id)) {
    const err = new Error('Tenant nao encontrado');
    err.statusCode = 404;
    throw err;
  }
  if (!tenantDbs.has(id)) {
    const dbPath = getTenantDbPath(id);
    if (!fs.existsSync(dbPath)) {
      const err = new Error('Banco do tenant ausente');
      err.statusCode = 503;
      err.code = 'TENANT_DB_MISSING';
      throw err;
    }
    const db = openTenantDb(id);
    tenantDbs.set(id, db);
  }
  tenantDbLastAccess.set(id, Date.now());
  return tenantDbs.get(id);
}

function closeTenantDb(tenantId) {
  const id = normalizeTenantId(tenantId);
  const db = tenantDbs.get(id);
  if (db) {
    db.close();
    tenantDbs.delete(id);
  }
  tenantDbLastAccess.delete(id);
}

function acquireTenantDbLease(tenantId) {
  const id = normalizeTenantId(tenantId);
  if (tenantsBeingDeleted.has(id)) {
    const err = new Error('Tenant em processo de exclusao');
    err.statusCode = 409;
    throw err;
  }
  const tenantDb = getTenantDb(id);
  tenantDbLeases.set(id, (tenantDbLeases.get(id) || 0) + 1);
  return tenantDb;
}

function releaseTenantDbLease(tenantId) {
  const id = normalizeTenantId(tenantId);
  const next = (tenantDbLeases.get(id) || 0) - 1;
  if (next > 0) tenantDbLeases.set(id, next);
  else tenantDbLeases.delete(id);
  tenantDbLastAccess.set(id, Date.now());
}

// Fecha bancos parados há mais que TENANT_DB_IDLE_MS. O timeout é longo o
// suficiente para nunca fechar um handle no meio de uma requisição (requests
// não duram minutos), e reabrir é barato (schema pula via user_version).
function sweepIdleTenantDbs() {
  const now = Date.now();
  for (const [tenantId, last] of tenantDbLastAccess) {
    if ((tenantDbLeases.get(tenantId) || 0) > 0) continue;
    if (now - last > TENANT_DB_IDLE_MS) {
      closeTenantDb(tenantId);
    }
  }
}

const tenantDbSweeper = setInterval(sweepIdleTenantDbs, TENANT_DB_SWEEP_MS);
if (tenantDbSweeper.unref) tenantDbSweeper.unref();

// ============ TENANT CRUD ============

function listTenants() {
  return master.prepare('SELECT * FROM tenants ORDER BY name').all();
}

function getTenant(id) {
  return master.prepare('SELECT * FROM tenants WHERE id = ?').get(normalizeTenantId(id));
}

function getTenantBySubdomain(subdomain) {
  const key = typeof subdomain === 'string' ? subdomain.trim().toLowerCase() : '';
  if (!key) return undefined;
  return master.prepare('SELECT * FROM tenants WHERE subdomain = ? COLLATE NOCASE AND status = ?').get(key, 'active');
}

function getTenantBySlug(slug) {
  const key = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
  if (!key) return undefined;
  return master.prepare('SELECT * FROM tenants WHERE slug = ? COLLATE NOCASE').get(key);
}

function isUniqueConstraintError(error) {
  return String(error?.code || '').startsWith('SQLITE_CONSTRAINT')
    || /UNIQUE constraint failed/i.test(String(error?.message || ''));
}

function removeTenantStorageArtifacts(tenantId) {
  if (!tenantId) return;
  const dbPath = getTenantDbPath(tenantId);
  for (const filename of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.rmSync(filename, { force: true }); } catch {}
  }
  try { fs.rmSync(getTenantAuthPath(tenantId), { recursive: true, force: true }); } catch {}
}

function initializeTenantStorage(tenantId) {
  const authPath = getTenantAuthPath(tenantId);
  fs.mkdirSync(authPath, { recursive: true });
  const tenantDb = openTenantDb(tenantId, { create: true });
  tenantDb.close();
}

function createTenant({
  name,
  slug,
  subdomain,
  settings,
  plan = DEFAULT_PLAN,
  uniqueSlug = false,
  deferActivation = false,
  runtimeTenantLimit = null
}) {
  const cleanName = normalizeTenantName(name);
  const baseSlug = normalizeTenantKey(slug || tenantSlugBase(cleanName));
  const requestedSubdomain = subdomain == null || subdomain === '' ? baseSlug : normalizeTenantKey(subdomain, 'Subdominio');
  const normalizedPlan = normalizePlan(plan);
  if (typeof deferActivation !== 'boolean') {
    throw inputError('Estado de provisionamento invalido');
  }
  const normalizedRuntimeTenantLimit = runtimeTenantLimit == null
    ? null
    : Number(runtimeTenantLimit);
  if (normalizedRuntimeTenantLimit !== null
      && (!Number.isSafeInteger(normalizedRuntimeTenantLimit) || normalizedRuntimeTenantLimit <= 0)) {
    throw inputError('Capacidade comercial do runtime invalida');
  }
  const initialStatus = deferActivation ? 'provisioning' : 'active';
  const trialEndsAt = new Date(Date.now() + TRIAL_MS).toISOString();
  const cleanSettings = settings == null ? {} : settings;
  if (typeof cleanSettings !== 'object' || Array.isArray(cleanSettings)) {
    throw inputError('Configuracoes do tenant invalidas');
  }
  const serializedSettings = JSON.stringify(cleanSettings);
  if (Buffer.byteLength(serializedSettings, 'utf8') > 64 * 1024) {
    throw inputError('Configuracoes do tenant excedem o limite permitido');
  }

  let lastConflict = null;
  for (let attempt = 0; attempt < (uniqueSlug ? 5 : 1); attempt += 1) {
    const candidateSlug = attempt === 0 ? baseSlug : uniqueTenantKey(baseSlug);
    const candidateSubdomain = subdomain == null || subdomain === '' || uniqueSlug
      ? candidateSlug
      : requestedSubdomain;
    let tenantId = null;
    try {
      master.transaction(() => {
        if (normalizedRuntimeTenantLimit !== null) {
          const commercialTenants = Number(master.prepare(`
            SELECT COUNT(*) AS total
            FROM tenants
            WHERE lower(slug) <> 'default'
              AND status IN ('active', 'provisioning')
          `).get()?.total || 0);
          if (commercialTenants >= normalizedRuntimeTenantLimit) {
            const capacityError = new Error(
              `Capacidade operacional de ${normalizedRuntimeTenantLimit} empresas atingida; amplie a infraestrutura antes de vender outro acesso`
            );
            capacityError.statusCode = 503;
            capacityError.code = 'TENANT_RUNTIME_CAPACITY_REACHED';
            throw capacityError;
          }
        }
        const result = master.prepare(`
          INSERT INTO tenants
            (name, slug, subdomain, status, settings, billing_status, trial_ends_at, plan)
          VALUES (?, ?, ?, ?, ?, 'trialing', ?, ?)
        `).run(
          cleanName,
          candidateSlug,
          candidateSubdomain,
          initialStatus,
          serializedSettings,
          trialEndsAt,
          normalizedPlan
        );
        tenantId = Number(result.lastInsertRowid);
        // O registro mestre só é confirmado depois que banco e diretório de
        // autenticação existem. Uma falha de disco reverte o INSERT.
        initializeTenantStorage(tenantId);
      }).immediate();
      return getTenant(tenantId);
    } catch (error) {
      removeTenantStorageArtifacts(tenantId);
      if (isUniqueConstraintError(error)) {
        lastConflict = error;
        if (uniqueSlug) continue;
        throw conflictError('Tenant com este slug ou subdominio ja existe');
      }
      throw error;
    }
  }
  const error = conflictError('Nao foi possivel gerar um identificador unico para a empresa');
  error.cause = lastConflict;
  throw error;
}

function updateTenantUnlocked(id, fields) {
  const tenantId = normalizeTenantId(id);
  const current = getTenant(tenantId);
  if (!current) throw notFoundError();
  const pendingDeletion = master.prepare(`
    SELECT 1
    FROM tenant_deletion_restore
    WHERE tenant_id = ? AND status = 'pending'
    LIMIT 1
  `).get(tenantId);
  if (pendingDeletion) throw conflictError('Tenant esta em processo de exclusao');
  const sets = [];
  const vals = [];
  if (fields.name !== undefined) {
    sets.push('name = ?');
    vals.push(normalizeTenantName(fields.name));
  }
  if (fields.slug !== undefined) {
    sets.push('slug = ?');
    vals.push(normalizeTenantKey(fields.slug));
  }
  if (fields.subdomain !== undefined) {
    sets.push('subdomain = ?');
    vals.push(normalizeTenantKey(fields.subdomain, 'Subdominio'));
  }
  if (fields.status !== undefined) {
    const status = String(fields.status || '').trim().toLowerCase();
    if (!['active', 'suspended'].includes(status)) throw inputError('Status do tenant invalido');
    sets.push('status = ?');
    vals.push(status);
  }
  if (fields.plan_price_cents !== undefined) {
    const cents = fields.plan_price_cents === null ? null : Number(fields.plan_price_cents);
    if (cents !== null && (!Number.isSafeInteger(cents) || cents < 0)) {
      throw inputError('Preco do plano invalido');
    }
    sets.push('plan_price_cents = ?');
    vals.push(cents);
  }
  const nextPlan = fields.plan === undefined ? normalizePlan(current.plan) : normalizePlan(fields.plan);
  const nextOverride = fields.user_limit_override === undefined
    ? normalizeUserLimitOverride(current.user_limit_override)
    : normalizeUserLimitOverride(fields.user_limit_override);
  if (fields.plan !== undefined) {
    sets.push('plan = ?');
    vals.push(nextPlan);
  }
  if (fields.user_limit_override !== undefined) {
    sets.push('user_limit_override = ?');
    vals.push(nextOverride);
  }
  if (fields.settings !== undefined) {
    if (!fields.settings || typeof fields.settings !== 'object' || Array.isArray(fields.settings)) {
      throw inputError('Configuracoes do tenant invalidas');
    }
    const serialized = JSON.stringify(fields.settings);
    if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
      throw inputError('Configuracoes do tenant excedem o limite permitido');
    }
    sets.push('settings = ?');
    vals.push(serialized);
  }

  if (fields.plan !== undefined || fields.user_limit_override !== undefined) {
    const proposedLimit = nextOverride || PLAN_USER_LIMITS[nextPlan];
    const activeUsers = Number(
      getTenantDb(tenantId).prepare('SELECT COUNT(*) AS total FROM vendors WHERE active = 1').get()?.total || 0
    );
    if (activeUsers > proposedLimit) {
      throw conflictError(
        `Nao e possivel reduzir o limite para ${proposedLimit}: existem ${activeUsers} usuarios ativos`
      );
    }
  }
  if (sets.length === 0) return current;
  vals.push(tenantId);
  try {
    const result = master.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    if (!result.changes) throw notFoundError();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflictError('Tenant com este slug ou subdominio ja existe');
    }
    throw error;
  }
  return getTenant(tenantId);
}

// Toda alteração de plano/override segura o mesmo write lock global usado na
// criação/reativação de vendedores. A ordem única master -> tenant impede que
// dois processos aprovem simultaneamente estados que ultrapassem o limite.
function updateTenant(id, fields) {
  return master.transaction(() => updateTenantUnlocked(id, fields)).immediate();
}

function withTenantCapacityLock(tenantId, operation) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  if (typeof operation !== 'function') throw inputError('Operacao de capacidade invalida');
  return master.transaction(() => {
    const tenant = getTenant(normalizedTenantId);
    if (!tenant) throw notFoundError();
    if (tenant.status !== 'active') {
      throw conflictError('Tenant nao esta ativo para gerenciar usuarios');
    }
    const pendingDeletion = master.prepare(`
      SELECT 1
      FROM tenant_deletion_restore
      WHERE tenant_id = ? AND status = 'pending'
      LIMIT 1
    `).get(normalizedTenantId);
    if (pendingDeletion) throw conflictError('Tenant esta em processo de exclusao');
    return operation(tenant);
  }).immediate();
}

function activateTenant(id) {
  const tenantId = normalizeTenantId(id);
  return master.transaction(() => {
    const tenant = getTenant(tenantId);
    if (!tenant) throw notFoundError();
    if (tenant.status === 'active') return tenant;
    if (tenant.status !== 'provisioning') {
      throw conflictError('Tenant nao esta aguardando provisionamento');
    }
    const admins = getTenantDb(tenantId).prepare(`
      SELECT username
      FROM admins
      WHERE coalesce(super_admin, 0) = 0
      ORDER BY id
    `).all();
    const hasRegisteredOwner = admins.some(admin => {
      const owner = findDirectoryUser(admin.username);
      return owner
        && Number(owner.tenant_id) === tenantId
        && owner.role === 'admin';
    });
    if (!hasRegisteredOwner) {
      const error = conflictError('Provisionamento incompleto: administrador principal nao registrado');
      error.code = 'PROVISIONING_OWNER_MISSING';
      throw error;
    }
    const activated = master.prepare(`
      UPDATE tenants
      SET status = 'active'
      WHERE id = ? AND status = 'provisioning'
    `).run(tenantId);
    if (!activated.changes) throw conflictError('Estado de provisionamento foi alterado');
    return getTenant(tenantId);
  }).immediate();
}

function listStaleProvisioningTenants(staleAfterMs = 15 * 60 * 1000) {
  const ageMs = Number(staleAfterMs);
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    throw inputError('Janela de provisionamento invalida');
  }
  const ageSeconds = Math.max(1, Math.ceil(ageMs / 1000));
  return master.prepare(`
    SELECT *
    FROM tenants
    WHERE status = 'provisioning'
      AND created_at <= datetime('now', ?)
    ORDER BY created_at, id
    LIMIT 100
  `).all(`-${ageSeconds} seconds`);
}

function listExpiredCheckoutReservations({
  now = Date.now(),
  legacyStaleAfterMs = 24 * 60 * 60 * 1000,
  limit = 100
} = {}) {
  const nowMs = Number(now);
  const legacyAgeMs = Number(legacyStaleAfterMs);
  const rowLimit = Number(limit);
  if (!Number.isFinite(nowMs) || nowMs <= 0
      || !Number.isFinite(legacyAgeMs) || legacyAgeMs < 0
      || !Number.isSafeInteger(rowLimit) || rowLimit <= 0 || rowLimit > 1000) {
    throw inputError('Parametros de expiracao de Checkout invalidos');
  }
  const nowIso = new Date(nowMs).toISOString();
  const legacyCutoffIso = new Date(nowMs - legacyAgeMs).toISOString();
  return master.prepare(`
    SELECT *
    FROM tenants
    WHERE lower(slug) <> 'default'
      AND status IN ('active', 'provisioning')
      AND billing_status = 'checkout_pending'
      AND coalesce(stripe_subscription_id, '') = ''
      AND coalesce(stripe_checkout_session_id, '') <> ''
      AND (
        (checkout_expires_at IS NOT NULL AND checkout_expires_at <= ?)
        OR (
          checkout_expires_at IS NULL
          AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) <= ?
        )
      )
    ORDER BY coalesce(checkout_expires_at, created_at), id
    LIMIT ?
  `).all(nowIso, legacyCutoffIso, rowLimit);
}

function getTenantUserLimit(tenantOrId) {
  const tenant = typeof tenantOrId === 'object' && tenantOrId !== null
    ? tenantOrId
    : getTenant(tenantOrId);
  if (!tenant) {
    const err = new Error('Tenant nao encontrado');
    err.statusCode = 404;
    throw err;
  }
  const override = normalizeUserLimitOverride(tenant.user_limit_override);
  return override || PLAN_USER_LIMITS[normalizePlan(tenant.plan)];
}

function setComp(id, comp) {
  const tenantId = normalizeTenantId(id);
  const result = master.prepare('UPDATE tenants SET comp = ? WHERE id = ?').run(comp ? 1 : 0, tenantId);
  if (!result.changes) throw notFoundError();
  return getTenant(tenantId);
}

function markTrialNotified(id) {
  const result = master.prepare('UPDATE tenants SET trial_notified_at = ? WHERE id = ?')
    .run(new Date().toISOString(), normalizeTenantId(id));
  if (!result.changes) throw notFoundError();
}

// ============ COBRANÇA (Stripe) ============

function normalizeBillingStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (!['trialing', 'active', 'suspended', 'checkout_pending'].includes(status)) {
    throw inputError('Status de cobranca invalido');
  }
  return status;
}

function setBillingFields(tenantId, fields) {
  const id = normalizeTenantId(tenantId);
  const sets = [];
  const vals = [];
  for (const k of [
    'billing_status',
    'trial_ends_at',
    'stripe_customer_id',
    'stripe_subscription_id',
    'stripe_checkout_session_id',
    'checkout_expires_at',
    'stripe_price_id',
    'stripe_last_event_created',
    'stripe_last_event_id',
    'plan',
    'billing_block_reason',
    'billing_resume_status'
  ]) {
    if (fields[k] !== undefined) {
      let value = fields[k];
      if (k === 'billing_status') {
        value = normalizeBillingStatus(value);
      } else if (k === 'plan') {
        value = normalizePlan(value);
      } else if (k === 'billing_block_reason') {
        value = value == null || value === '' ? null : String(value).trim().toLowerCase();
        if (value !== null && (!/^[a-z0-9_]{1,64}$/.test(value))) {
          throw inputError('Motivo de bloqueio de cobranca invalido');
        }
      } else if (k === 'billing_resume_status') {
        value = value == null || value === '' ? null : normalizeBillingStatus(value);
        if (value !== null && !['active', 'trialing'].includes(value)) {
          throw inputError('Status de retomada de cobranca invalido');
        }
      } else if (k === 'stripe_last_event_created') {
        value = normalizeStripeEventCreated(value);
      } else if (k.startsWith('stripe_') && value !== null) {
        value = String(value || '').trim();
        if (!value || value.length > 255) throw inputError('Identificador Stripe invalido');
      } else if (['trial_ends_at', 'checkout_expires_at'].includes(k) && value !== null) {
        const timestamp = new Date(value).getTime();
        if (!Number.isFinite(timestamp)) {
          throw inputError(k === 'trial_ends_at' ? 'Fim do trial invalido' : 'Expiracao do Checkout invalida');
        }
        value = new Date(timestamp).toISOString();
      }
      sets.push(`${k} = ?`);
      vals.push(value);
    }
  }
  const current = getTenant(id);
  if (!current) throw notFoundError();
  if (!sets.length) return current;
  vals.push(id);
  const result = master.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  if (!result.changes) throw notFoundError();
  return getTenant(id);
}

function normalizeStripeEventCreated(value) {
  const created = Number(value);
  if (!Number.isSafeInteger(created) || created < 0) {
    throw inputError('Data do evento Stripe invalida');
  }
  return created;
}

function setBillingFieldsFromStripe(tenantId, fields, { eventCreated, eventId } = {}) {
  const id = normalizeTenantId(tenantId);
  const created = normalizeStripeEventCreated(eventCreated);
  const cleanEventId = String(eventId || '').trim();
  if (!cleanEventId) throw inputError('ID do evento Stripe obrigatorio');

  return master.transaction(() => {
    const current = getTenant(id);
    if (!current) {
      const err = new Error('Tenant nao encontrado');
      err.statusCode = 404;
      throw err;
    }
    if (created < Number(current.stripe_last_event_created || 0)) {
      return { applied: false, stale: true, tenant: current };
    }
    const sameSecond = created === Number(current.stripe_last_event_created || 0);
    const incomingStatus = fields.billing_status === undefined
      ? null
      : normalizeBillingStatus(fields.billing_status);
    if (sameSecond
        && current.billing_status === 'suspended'
        && current.billing_block_reason !== 'plan_capacity'
        && incomingStatus
        && incomingStatus !== 'suspended') {
      // Stripe timestampa eventos em segundos e não garante ordem no mesmo
      // segundo. Suspensão/cancelamento vence o empate independentemente da
      // chegada, evitando reativação por invoice.paid/update atrasado.
      return { applied: false, stale: true, tieBlocked: true, tenant: current };
    }
    const safeFields = { ...fields };
    let capacityBlocked = false;
    if (safeFields.plan !== undefined) {
      const nextPlan = normalizePlan(safeFields.plan);
      const proposedLimit = normalizeUserLimitOverride(current.user_limit_override)
        || PLAN_USER_LIMITS[nextPlan];
      const activeUsers = Number(
        getTenantDb(id).prepare('SELECT COUNT(*) AS total FROM vendors WHERE active = 1').get()?.total || 0
      );
      const intendedStatus = incomingStatus || (
        current.billing_block_reason === 'plan_capacity'
          ? current.billing_resume_status
          : current.billing_status
      );
      safeFields.plan = nextPlan;
      if (activeUsers > proposedLimit && ['active', 'trialing'].includes(intendedStatus)) {
        safeFields.billing_status = 'suspended';
        safeFields.billing_block_reason = 'plan_capacity';
        safeFields.billing_resume_status = intendedStatus;
        capacityBlocked = true;
      } else {
        if (current.billing_block_reason === 'plan_capacity'
            && activeUsers <= proposedLimit
            && ['active', 'trialing'].includes(intendedStatus)) {
          safeFields.billing_status = intendedStatus;
          safeFields.billing_block_reason = null;
          safeFields.billing_resume_status = null;
        } else if (incomingStatus === 'suspended') {
          if (safeFields.billing_block_reason === undefined) {
            safeFields.billing_block_reason = null;
          }
          safeFields.billing_resume_status = null;
        }
      }
    } else if (incomingStatus === 'suspended') {
      if (safeFields.billing_block_reason === undefined) {
        safeFields.billing_block_reason = null;
      }
      safeFields.billing_resume_status = null;
    }
    const tenant = setBillingFields(id, {
      ...safeFields,
      stripe_last_event_created: created,
      stripe_last_event_id: cleanEventId
    });
    return { applied: true, stale: false, capacityBlocked, tenant };
  }).immediate();
}

function recoverPlanCapacityBlock(tenantId) {
  const id = normalizeTenantId(tenantId);
  return master.transaction(() => {
    const current = getTenant(id);
    if (!current) throw notFoundError();
    if (current.billing_block_reason !== 'plan_capacity') {
      return { recovered: false, overCapacity: false, tenant: current };
    }

    const activeUsers = Number(
      getTenantDb(id).prepare('SELECT COUNT(*) AS total FROM vendors WHERE active = 1').get()?.total || 0
    );
    const limit = getTenantUserLimit(current);
    if (activeUsers > limit) {
      return { recovered: false, overCapacity: true, activeUsers, limit, tenant: current };
    }

    const resumeStatus = ['active', 'trialing'].includes(current.billing_resume_status)
      ? current.billing_resume_status
      : 'active';
    master.prepare(`
      UPDATE tenants
      SET billing_status = ?,
          billing_block_reason = NULL,
          billing_resume_status = NULL
      WHERE id = ?
        AND billing_block_reason = 'plan_capacity'
    `).run(resumeStatus, id);
    return {
      recovered: true,
      overCapacity: false,
      activeUsers,
      limit,
      tenant: getTenant(id)
    };
  }).immediate();
}

function beginStripeEvent(event) {
  const eventId = String(event?.id || '').trim();
  const eventType = String(event?.type || '').trim();
  const eventCreated = normalizeStripeEventCreated(event?.created);
  if (!eventId || !eventType) throw inputError('Evento Stripe invalido');

  return master.transaction(() => {
    const existing = master.prepare('SELECT * FROM stripe_events WHERE event_id = ?').get(eventId);
    if (existing && ['processed', 'ignored'].includes(existing.processing_status)) {
      return { shouldProcess: false, duplicate: true, record: existing };
    }
    if (existing?.processing_status === 'processing') {
      const leaseSeconds = Math.max(
        30,
        Math.min(3600, Number(process.env.STRIPE_EVENT_LEASE_SECONDS || 300) || 300)
      );
      const leaseIsCurrent = master.prepare(`
        SELECT datetime(updated_at) > datetime('now', ?) AS current
        FROM stripe_events
        WHERE event_id = ?
      `).get(`-${leaseSeconds} seconds`, eventId)?.current;
      if (leaseIsCurrent) {
        return {
          shouldProcess: false,
          duplicate: true,
          inProgress: true,
          record: existing
        };
      }
    }
    if (existing) {
      master.prepare(`
        UPDATE stripe_events
        SET processing_status = 'processing',
            attempts = attempts + 1,
            detail = NULL,
            updated_at = datetime('now')
        WHERE event_id = ?
      `).run(eventId);
    } else {
      master.prepare(`
        INSERT INTO stripe_events (event_id, event_type, event_created)
        VALUES (?, ?, ?)
      `).run(eventId, eventType, eventCreated);
    }
    return {
      shouldProcess: true,
      duplicate: false,
      record: master.prepare('SELECT * FROM stripe_events WHERE event_id = ?').get(eventId)
    };
  })();
}

function finishStripeEvent(eventId, { tenantId = null, status = 'processed', detail = null } = {}) {
  const id = String(eventId || '').trim();
  if (!id) throw inputError('ID do evento Stripe obrigatorio');
  if (!['processed', 'ignored'].includes(status)) throw inputError('Status do evento Stripe invalido');
  const ownerId = tenantId == null ? null : normalizeTenantId(tenantId);
  const result = master.prepare(`
    UPDATE stripe_events
    SET tenant_id = ?,
        processing_status = ?,
        detail = ?,
        processed_at = datetime('now'),
        updated_at = datetime('now')
    WHERE event_id = ?
  `).run(ownerId, status, detail == null ? null : JSON.stringify(detail), id);
  if (!result.changes) throw new Error('Evento Stripe nao registrado');
  return master.prepare('SELECT * FROM stripe_events WHERE event_id = ?').get(id);
}

function failStripeEvent(eventId, error) {
  const id = String(eventId || '').trim();
  if (!id) return null;
  master.prepare(`
    UPDATE stripe_events
    SET processing_status = 'failed',
        detail = ?,
        updated_at = datetime('now')
    WHERE event_id = ?
  `).run(JSON.stringify({ error: String(error?.message || error || 'Erro desconhecido').slice(0, 1000) }), id);
  return master.prepare('SELECT * FROM stripe_events WHERE event_id = ?').get(id) || null;
}

// Status "de fato" do tenant: rebaixa trial vencido para 'suspended'
// automaticamente (sem depender de cron), e sempre libera clientes em cortesia.
function getEffectiveBillingStatus(tenant) {
  if (!tenant) return 'suspended';
  if (INTERNAL_EDITION && String(tenant.slug).toLowerCase() === 'default') return 'active';
  if (tenant.comp) return 'active';
  const billingRequired = process.env.NODE_ENV === 'production' && process.env.BILLING_REQUIRED !== 'false';
  if (billingRequired
      && tenant.slug !== 'default'
      && ['active', 'trialing'].includes(tenant.billing_status)
      && !tenant.stripe_subscription_id) {
    // Acesso de producao requer uma assinatura real na Stripe, ainda que ela
    // esteja nos tres dias gratuitos. Liberacao local sem `comp` nao contorna
    // a cobranca; o tenant `default` e a conta operacional da plataforma.
    setBillingFields(tenant.id, { billing_status: 'checkout_pending' });
    return 'checkout_pending';
  }
  if (tenant.billing_status === 'trialing' && tenant.trial_ends_at && new Date(tenant.trial_ends_at) <= new Date()) {
    setBillingFields(tenant.id, { billing_status: 'suspended' });
    return 'suspended';
  }
  return tenant.billing_status || 'trialing';
}

function collectTenantMediaFiles(tenantId) {
  const expectedPrefix = `t${tenantId}-`;
  const filenames = new Set();
  const addUrl = value => {
    const mediaUrl = String(value || '');
    if (!mediaUrl.startsWith('/media/') && !mediaUrl.startsWith('/support-media/')) return;
    const filename = path.basename(mediaUrl);
    if (filename.startsWith(expectedPrefix)) filenames.add(filename);
  };

  const dbPath = getTenantDbPath(tenantId);
  if (fs.existsSync(dbPath)) {
    let tenantDb = tenantDbs.get(tenantId);
    let temporaryDb = false;
    try {
      if (!tenantDb) {
        tenantDb = new Database(dbPath, { readonly: true, fileMustExist: true });
        temporaryDb = true;
      }
      for (const row of tenantDb.prepare(`
        SELECT DISTINCT media_url
        FROM messages
        WHERE media_url IS NOT NULL AND media_url <> ''
      `).all()) addUrl(row.media_url);
    } finally {
      if (temporaryDb) {
        try { tenantDb.close(); } catch {}
      }
    }
  }

  for (const row of master.prepare(`
    SELECT DISTINCT media_url
    FROM support_messages
    WHERE tenant_id = ? AND media_url IS NOT NULL AND media_url <> ''
  `).all(tenantId)) addUrl(row.media_url);
  return filenames;
}

function buildTenantQuarantineEntries(tenantId, deletionId) {
  const dbPath = getTenantDbPath(tenantId);
  const authPath = getTenantAuthPath(tenantId);
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, authPath]
    .filter(source => fs.existsSync(source))
    .map(source => ({ source, target: `${source}.deleting-${deletionId}` }));
}

function quarantineTenantStorage(entries) {
  const moved = [];
  try {
    for (const entry of entries) {
      if (!fs.existsSync(entry.source)) continue;
      fs.renameSync(entry.source, entry.target);
      moved.push(entry);
    }
    return moved;
  } catch (error) {
    for (const entry of [...moved].reverse()) {
      try {
        if (fs.existsSync(entry.target) && !fs.existsSync(entry.source)) {
          fs.renameSync(entry.target, entry.source);
        }
      } catch {}
    }
    throw error;
  }
}

function restoreQuarantinedTenantStorage(entries) {
  const failures = [];
  for (const entry of [...entries].reverse()) {
    try {
      if (fs.existsSync(entry.target) && !fs.existsSync(entry.source)) {
        fs.renameSync(entry.target, entry.source);
      }
    } catch (error) {
      failures.push({ path: entry.target, error: String(error?.message || error) });
    }
  }
  return failures;
}

function isSafeRestoreEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const source = path.resolve(String(entry.source || ''));
  const target = path.resolve(String(entry.target || ''));
  const sourceAllowed = source.startsWith(`${DATA_DIR}${path.sep}`)
    || source.startsWith(`${AUTH_DIR}${path.sep}`);
  const suffix = target.slice(`${source}.deleting-`.length);
  return sourceAllowed
    && target.startsWith(`${source}.deleting-`)
    && Boolean(suffix)
    && !suffix.includes(path.sep);
}

function beginTenantDeletionIntent(deletionId, tenant, entries, mediaFiles) {
  return master.transaction(() => {
    const current = getTenant(tenant.id);
    if (!current) throw notFoundError();
    const existingIntent = master.prepare(`
      SELECT deletion_id
      FROM tenant_deletion_restore
      WHERE tenant_id = ? AND status = 'pending'
      LIMIT 1
    `).get(current.id);
    if (existingIntent) throw conflictError('Tenant ja esta em processo de exclusao');
    master.prepare(`
      INSERT INTO tenant_deletion_restore
        (deletion_id, tenant_id, previous_status, entries, media_files, commit_state, last_error)
      VALUES (?, ?, ?, ?, ?, 'reversible', ?)
      ON CONFLICT(deletion_id) DO UPDATE SET
        entries = excluded.entries,
        media_files = excluded.media_files,
        commit_state = 'reversible',
        last_error = NULL,
        status = 'pending'
    `).run(
      deletionId,
      current.id,
      ['active', 'suspended', 'provisioning'].includes(current.status) ? current.status : 'suspended',
      JSON.stringify(entries),
      JSON.stringify([...mediaFiles]),
      null
    );
    master.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").run(current.id);
    logAudit('system', 'tenant_deletion_started', current.id, { deletionId });
    return current;
  }).immediate();
}

function processTenantDeletionRestores(deletionId = null) {
  const jobs = deletionId
    ? master.prepare(`
        SELECT * FROM tenant_deletion_restore
        WHERE deletion_id = ? AND status = 'pending'
          AND coalesce(commit_state, 'reversible') = 'reversible'
      `).all(String(deletionId))
    : master.prepare(`
        SELECT * FROM tenant_deletion_restore
        WHERE status = 'pending'
          AND coalesce(commit_state, 'reversible') = 'reversible'
        ORDER BY created_at, deletion_id
        LIMIT 100
      `).all();
  const results = [];
  for (const job of jobs) {
    let entries = [];
    const failures = [];
    try { entries = JSON.parse(job.entries || '[]'); } catch (error) {
      failures.push({ path: 'entries', error: String(error.message) });
    }
    if (!Array.isArray(entries)) {
      failures.push({ path: 'entries', error: 'Lista de restauracao invalida' });
      entries = [];
    }
    for (const entry of [...entries].reverse()) {
      if (!isSafeRestoreEntry(entry)) {
        failures.push({ path: String(entry?.target || ''), error: 'Caminho de restauracao invalido' });
        continue;
      }
      try {
        const sourceExists = fs.existsSync(entry.source);
        const targetExists = fs.existsSync(entry.target);
        if (sourceExists && targetExists) throw new Error('Origem e quarentena existem simultaneamente');
        if (!sourceExists && targetExists) fs.renameSync(entry.target, entry.source);
        // SQLite pode remover WAL/SHM normalmente durante close/checkpoint,
        // depois de o intent já ter registrado os caminhos. A ausência dos
        // sidecars é segura; banco principal e autenticação continuam sendo
        // obrigatórios para considerar a restauração concluída.
        const optionalSqliteSidecar = /-(?:wal|shm)$/.test(String(entry.source));
        if (!fs.existsSync(entry.source) && !optionalSqliteSidecar) {
          throw new Error('Artefato nao encontrado para restauracao');
        }
      } catch (error) {
        failures.push({ path: entry.target, error: String(error?.message || error) });
      }
    }
    if (failures.length) {
      master.prepare(`
        UPDATE tenant_deletion_restore
        SET attempts = attempts + 1, last_error = ?
        WHERE deletion_id = ?
      `).run(JSON.stringify(failures).slice(0, 10000), job.deletion_id);
    } else {
      master.transaction(() => {
        master.prepare(`
          UPDATE tenant_deletion_restore
          SET status = 'restored', attempts = attempts + 1,
              last_error = NULL, restored_at = datetime('now')
          WHERE deletion_id = ?
        `).run(job.deletion_id);
        master.prepare('UPDATE tenants SET status = ? WHERE id = ?')
          .run(job.previous_status, job.tenant_id);
        logAudit('system', 'tenant_deletion_restored', job.tenant_id, { deletionId: job.deletion_id });
      })();
    }
    results.push({ deletionId: job.deletion_id, restored: failures.length === 0, failures });
  }
  return results;
}

function markTenantDeletionForwardOnly(deletionId) {
  return master.transaction(() => {
    const result = master.prepare(`
      UPDATE tenant_deletion_restore
      SET commit_state = 'forward_only',
          attempts = attempts + 1,
          last_error = NULL
      WHERE deletion_id = ?
        AND status = 'pending'
        AND coalesce(commit_state, 'reversible') = 'reversible'
    `).run(String(deletionId));
    if (!result.changes) throw conflictError('Intent de exclusao nao esta mais reversivel');
    return master.prepare('SELECT * FROM tenant_deletion_restore WHERE deletion_id = ?')
      .get(String(deletionId));
  }).immediate();
}

function recordForwardDeletionFailure(deletionId, error) {
  master.prepare(`
    UPDATE tenant_deletion_restore
    SET attempts = attempts + 1,
        last_error = ?
    WHERE deletion_id = ?
      AND status = 'pending'
      AND commit_state = 'forward_only'
  `).run(String(error?.message || error).slice(0, 10000), String(deletionId));
}

function parseForwardDeletionJob(job) {
  let entries;
  let mediaFiles;
  try { entries = JSON.parse(job.entries || '[]'); } catch {
    throw new Error('Intent de exclusao possui lista de artefatos invalida');
  }
  try { mediaFiles = JSON.parse(job.media_files || '[]'); } catch {
    throw new Error('Intent de exclusao possui lista de midias invalida');
  }
  if (!Array.isArray(entries) || entries.some(entry => !isSafeRestoreEntry(entry))) {
    throw new Error('Intent de exclusao possui caminho de quarentena invalido');
  }
  if (!Array.isArray(mediaFiles)) throw new Error('Intent de exclusao possui lista de midias invalida');
  return { entries, mediaFiles };
}

function commitForwardTenantDeletion(job, entries, mediaFiles) {
  return master.transaction(() => {
    const currentJob = master.prepare(`
      SELECT status, commit_state
      FROM tenant_deletion_restore
      WHERE deletion_id = ?
    `).get(job.deletion_id);
    if (!currentJob || currentJob.status !== 'pending' || currentJob.commit_state !== 'forward_only') {
      return false;
    }
    master.prepare(`
      INSERT INTO tenant_deletion_cleanup
        (deletion_id, tenant_id, artifacts, media_files)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(deletion_id) DO NOTHING
    `).run(
      job.deletion_id,
      job.tenant_id,
      JSON.stringify(entries.map(entry => entry.target)),
      JSON.stringify(mediaFiles)
    );
    master.prepare(`
      UPDATE tenant_deletion_restore
      SET status = 'restored',
          attempts = attempts + 1,
          last_error = 'deletion_committed',
          restored_at = datetime('now')
      WHERE deletion_id = ?
    `).run(job.deletion_id);
    master.prepare('DELETE FROM user_directory WHERE tenant_id = ?').run(job.tenant_id);
    master.prepare('DELETE FROM tenants WHERE id = ?').run(job.tenant_id);
    logAudit('system', 'tenant_deletion_committed', job.tenant_id, { deletionId: job.deletion_id });
    return true;
  }).immediate();
}

const forwardDeletionJobsInFlight = new Set();

async function processForwardTenantDeletions(afterQuarantine, deletionId = null) {
  if (typeof afterQuarantine !== 'function') {
    throw inputError('Compensacao externa de exclusao obrigatoria');
  }
  const jobs = deletionId
    ? master.prepare(`
        SELECT * FROM tenant_deletion_restore
        WHERE deletion_id = ? AND status = 'pending' AND commit_state = 'forward_only'
      `).all(String(deletionId))
    : master.prepare(`
        SELECT * FROM tenant_deletion_restore
        WHERE status = 'pending' AND commit_state = 'forward_only'
        ORDER BY created_at, deletion_id
        LIMIT 100
      `).all();
  const results = [];
  for (const job of jobs) {
    if (forwardDeletionJobsInFlight.has(job.deletion_id)) continue;
    forwardDeletionJobsInFlight.add(job.deletion_id);
    try {
      const { entries, mediaFiles } = parseForwardDeletionJob(job);
      const tenant = getTenant(job.tenant_id);
      // A chamada é idempotente: recursos Stripe ausentes contam como
      // removidos. O marco forward_only já impede qualquer restauração.
      if (tenant) await afterQuarantine(tenant);
      const committed = commitForwardTenantDeletion(job, entries, mediaFiles);
      const cleanup = processTenantDeletionCleanup(job.deletion_id)[0] || null;
      results.push({
        deletionId: job.deletion_id,
        tenantId: Number(job.tenant_id),
        committed,
        cleanup,
        error: null
      });
    } catch (error) {
      recordForwardDeletionFailure(job.deletion_id, error);
      results.push({
        deletionId: job.deletion_id,
        tenantId: Number(job.tenant_id),
        committed: false,
        cleanup: null,
        error
      });
    } finally {
      forwardDeletionJobsInFlight.delete(job.deletion_id);
    }
  }
  return results;
}

function isSafeDeletionArtifact(artifact) {
  const resolved = path.resolve(String(artifact || ''));
  const underData = resolved.startsWith(`${DATA_DIR}${path.sep}`);
  const underAuth = resolved.startsWith(`${AUTH_DIR}${path.sep}`);
  return (underData || underAuth) && path.basename(resolved).includes('.deleting-');
}

function processTenantDeletionCleanup(deletionId = null) {
  const jobs = deletionId
    ? master.prepare(`
        SELECT * FROM tenant_deletion_cleanup
        WHERE deletion_id = ? AND status = 'pending'
      `).all(String(deletionId))
    : master.prepare(`
        SELECT * FROM tenant_deletion_cleanup
        WHERE status = 'pending'
        ORDER BY created_at, deletion_id
        LIMIT 100
      `).all();
  const results = [];
  for (const job of jobs) {
    let artifacts = [];
    let mediaFiles = [];
    const failures = [];
    try { artifacts = JSON.parse(job.artifacts || '[]'); } catch (error) {
      failures.push({ path: 'artifacts', error: String(error.message) });
    }
    try { mediaFiles = JSON.parse(job.media_files || '[]'); } catch (error) {
      failures.push({ path: 'media_files', error: String(error.message) });
    }
    if (!Array.isArray(artifacts)) {
      failures.push({ path: 'artifacts', error: 'Lista de artefatos invalida' });
      artifacts = [];
    }
    if (!Array.isArray(mediaFiles)) {
      failures.push({ path: 'media_files', error: 'Lista de midias invalida' });
      mediaFiles = [];
    }

    for (const artifact of artifacts) {
      if (!isSafeDeletionArtifact(artifact)) {
        failures.push({ path: String(artifact), error: 'Caminho de limpeza invalido' });
        continue;
      }
      try { fs.rmSync(artifact, { recursive: true, force: true }); } catch (error) {
        failures.push({ path: artifact, error: String(error?.message || error) });
      }
    }
    const expectedPrefix = `t${job.tenant_id}-`;
    for (const filename of mediaFiles) {
      if (path.basename(filename) !== filename || !filename.startsWith(expectedPrefix)) {
        failures.push({ path: String(filename), error: 'Arquivo de midia invalido' });
        continue;
      }
      try { fs.rmSync(path.join(MEDIA_DIR, filename), { force: true }); } catch (error) {
        failures.push({ path: filename, error: String(error?.message || error) });
      }
    }

    if (failures.length) {
      master.prepare(`
        UPDATE tenant_deletion_cleanup
        SET attempts = attempts + 1,
            last_error = ?
        WHERE deletion_id = ?
      `).run(JSON.stringify(failures).slice(0, 10000), job.deletion_id);
    } else {
      master.prepare(`
        UPDATE tenant_deletion_cleanup
        SET status = 'processed',
            attempts = attempts + 1,
            last_error = NULL,
            completed_at = datetime('now')
        WHERE deletion_id = ?
      `).run(job.deletion_id);
    }
    results.push({
      deletionId: job.deletion_id,
      tenantId: Number(job.tenant_id),
      processed: failures.length === 0,
      failures,
      mediaFiles: mediaFiles.length
    });
  }
  return results;
}

async function deleteTenant(id, {
  drainTimeoutMs = 10000,
  beforeDelete = null,
  afterQuarantine = null,
  allowDefault = false
} = {}) {
  const tenantId = normalizeTenantId(id);
  const initialTenant = getTenant(tenantId);
  if (!initialTenant) throw notFoundError();
  if (!allowDefault && initialTenant.slug === 'default') {
    throw conflictError('O tenant operacional padrao nao pode ser excluido');
  }
  if (tenantsBeingDeleted.has(tenantId)) {
    throw conflictError('Tenant ja esta em processo de exclusao');
  }

  tenantsBeingDeleted.add(tenantId);
  let completed = false;
  try {
    const deadline = Date.now() + Math.max(100, Number(drainTimeoutMs) || 10000);
    while ((tenantDbLeases.get(tenantId) || 0) > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if ((tenantDbLeases.get(tenantId) || 0) > 0) {
      throw conflictError('Tenant possui operacoes em andamento; tente novamente');
    }

    const mediaFiles = collectTenantMediaFiles(tenantId);
    const deletionId = crypto.randomUUID();
    const quarantineEntries = buildTenantQuarantineEntries(tenantId, deletionId);
    // O intent e o status suspenso são confirmados ANTES do primeiro rename
    // ou efeito externo. Se o processo cair em qualquer linha seguinte, o
    // boot restaura os caminhos determinísticos antes de abrir bancos tenant.
    const deletionTenant = beginTenantDeletionIntent(
      deletionId,
      initialTenant,
      quarantineEntries,
      mediaFiles
    );
    let forwardOnly = false;
    try {
      if (typeof beforeDelete === 'function') await beforeDelete(deletionTenant);
      closeTenantDb(tenantId);
      quarantineTenantStorage(quarantineEntries);
      // A partir deste commit nunca restauramos: o próximo passo pode apagar
      // customer/subscription na Stripe. Em crash ou erro, boot/timer repete a
      // compensação idempotente e conclui o DELETE local.
      markTenantDeletionForwardOnly(deletionId);
      forwardOnly = true;
      if (typeof afterQuarantine === 'function') await afterQuarantine(deletionTenant);
      const forwardJob = master.prepare(`
        SELECT * FROM tenant_deletion_restore WHERE deletion_id = ?
      `).get(deletionId);
      if (!commitForwardTenantDeletion(forwardJob, quarantineEntries, [...mediaFiles])) {
        throw conflictError('Exclusao ja foi concluida por outro processo');
      }
    } catch (error) {
      if (forwardOnly) {
        recordForwardDeletionFailure(deletionId, error);
        error.deletionPending = true;
        error.deletionId = deletionId;
        throw error;
      }
      const restoreFailures = restoreQuarantinedTenantStorage(quarantineEntries);
      const recovery = processTenantDeletionRestores(deletionId)[0];
      const allRestoreFailures = [
        ...restoreFailures,
        ...(recovery?.failures || [])
      ];
      if (allRestoreFailures.length) error.restoreFailures = allRestoreFailures;
      throw error;
    }
    const cleanup = processTenantDeletionCleanup(deletionId)[0] || {
      deletionId,
      tenantId,
      processed: false,
      failures: [{ error: 'Job de limpeza nao encontrado' }],
      mediaFiles: mediaFiles.size
    };
    completed = true;
    return { tenantId, cleanup };
  } finally {
    // On a timeout, allow the tenant to resume normally. On success the ID no
    // longer exists, but removing the marker also avoids an unbounded Set.
    tenantsBeingDeleted.delete(tenantId);
    if (!completed) tenantDbLastAccess.set(tenantId, Date.now());
  }
}

// Retenta resíduos de exclusões anteriores após crash ou indisponibilidade
// transitória do filesystem. O registro durável impede limpeza silenciosamente
// incompleta.
processTenantDeletionRestores();
processTenantDeletionCleanup();
const tenantDeletionCleanupTimer = setInterval(
  () => {
    processTenantDeletionRestores();
    processTenantDeletionCleanup();
  },
  Number(process.env.TENANT_DELETION_CLEANUP_INTERVAL_MS || 5 * 60 * 1000)
);
tenantDeletionCleanupTimer.unref?.();

// ============ SETUP: criar tenant padrão se vazio ============

if (master.prepare('SELECT COUNT(*) as c FROM tenants').get().c === 0) {
  const defaultSlug = 'default';
  const defaultSubdomain = process.env.TENANT_SUBDOMAIN || 'app';
  const defaultTenant = createTenant({
    name: process.env.TENANT_NAME || 'WhatsApp AI',
    slug: defaultSlug,
    subdomain: defaultSubdomain,
    settings: { appName: process.env.APP_NAME || 'WhatsApp AI', appCompany: process.env.APP_COMPANY || '' }
  });
  // Tenant padrão é a instância do próprio dono da plataforma — não cobra dele.
  setBillingFields(defaultTenant.id, { billing_status: 'active' });
}

function ensureInternalEditionTenant() {
  if (!INTERNAL_EDITION) return null;

  const tenants = listTenants();
  if (tenants.length !== 1 || String(tenants[0].slug).toLowerCase() !== 'default') {
    throw new Error('APP_MODE=internal exige exatamente um tenant com slug default');
  }

  const tenant = tenants[0];
  const ownerUsername = normalizeUsername(process.env.ADMIN_USERNAME);
  const ownerPassword = process.env.ADMIN_PASSWORD || process.env.ADMIN_INITIAL_PASSWORD || '';
  const ownerName = String(process.env.INTERNAL_ADMIN_NAME || 'Super Admin').trim();
  const companyName = normalizeTenantName(process.env.TENANT_NAME || 'Auto Peças Carretão');
  const subdomain = normalizeTenantKey(process.env.TENANT_SUBDOMAIN || 'carretao', 'Subdominio');
  const agentLimit = getInternalAgentLimit();

  if (!ownerUsername || ownerUsername.length > 254 || /\p{Cc}/u.test(ownerUsername)) {
    throw new Error('ADMIN_USERNAME invalido para a edicao interna');
  }
  const passwordBytes = Buffer.byteLength(ownerPassword, 'utf8');
  if (Array.from(ownerPassword).length < 10 || passwordBytes > 72) {
    throw new Error('ADMIN_PASSWORD deve ter entre 10 caracteres e 72 bytes UTF-8');
  }
  if (!ownerName || ownerName.length > 160 || /\p{Cc}/u.test(ownerName)) {
    throw new Error('INTERNAL_ADMIN_NAME invalido');
  }

  const tenantDb = getTenantDb(tenant.id);
  const vendorCollision = tenantDb.prepare(`
    SELECT 1 FROM vendors WHERE username = ? COLLATE NOCASE LIMIT 1
  `).get(ownerUsername);
  if (vendorCollision) {
    throw new Error('ADMIN_USERNAME colide com um agente da edicao interna');
  }

  let settings = {};
  try {
    const parsed = JSON.parse(tenant.settings || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed;
  } catch {}
  settings.appName = process.env.APP_NAME || 'WhatsCarretao';
  settings.appCompany = process.env.APP_COMPANY || companyName;

  master.transaction(() => {
    master.prepare(`
      UPDATE tenants
      SET name = ?,
          subdomain = ?,
          status = 'active',
          settings = ?,
          billing_status = 'active',
          trial_ends_at = NULL,
          stripe_customer_id = NULL,
          stripe_subscription_id = NULL,
          stripe_checkout_session_id = NULL,
          checkout_expires_at = NULL,
          stripe_price_id = NULL,
          plan_price_cents = NULL,
          user_limit_override = ?,
          comp = 1,
          trial_notified_at = NULL,
          billing_block_reason = NULL,
          billing_resume_status = NULL
      WHERE id = ?
    `).run(companyName, subdomain, JSON.stringify(settings), agentLimit, tenant.id);

    tenantDb.transaction(() => {
      const admins = tenantDb.prepare('SELECT * FROM admins ORDER BY id').all();
      let selected = admins.find(admin => normalizeUsername(admin.username) === ownerUsername)
        || admins[0]
        || null;

      if (!selected) {
        const created = tenantDb.prepare(`
          INSERT INTO admins (name, username, password, super_admin)
          VALUES (?, ?, ?, 0)
        `).run(ownerName, ownerUsername, bcrypt.hashSync(ownerPassword, 10));
        selected = { id: Number(created.lastInsertRowid) };
      } else {
        tenantDb.prepare('DELETE FROM admins WHERE id <> ?').run(selected.id);
        let passwordChanged = true;
        try {
          passwordChanged = !bcrypt.compareSync(ownerPassword, selected.password);
        } catch {}
        const usernameChanged = normalizeUsername(selected.username) !== ownerUsername;
        const nextPassword = passwordChanged
          ? bcrypt.hashSync(ownerPassword, 10)
          : selected.password;
        tenantDb.prepare(`
          UPDATE admins
          SET name = ?,
              username = ?,
              password = ?,
              super_admin = 0,
              token_version = token_version + ?
          WHERE id = ?
        `).run(ownerName, ownerUsername, nextPassword, usernameChanged || passwordChanged ? 1 : 0, selected.id);
      }

      tenantDb.prepare(`
        INSERT INTO sectors (name, active)
        VALUES ('Atendimento', 1)
        ON CONFLICT(name) DO UPDATE SET active = 1
      `).run();
    }).immediate();

    // user_directory é derivado. Recriá-lo aqui também remove o login antigo
    // quando o proprietário é rotacionado pelo .env.
    master.prepare(`
      DELETE FROM user_directory WHERE tenant_id = ? AND role = 'admin'
    `).run(tenant.id);
    master.prepare('DELETE FROM user_directory WHERE username = ? COLLATE NOCASE').run(ownerUsername);
    master.prepare(`
      INSERT INTO user_directory (username, tenant_id, role) VALUES (?, ?, 'admin')
    `).run(ownerUsername, tenant.id);
  }).immediate();

  return getTenant(tenant.id);
}

ensureInternalEditionTenant();

// ============ MIGRAÇÃO: preencher diretório global a partir dos dados existentes ============
// Antes do login ser resolvido pelo diretório, admins/vendedores já podiam existir
// nos bancos dos tenants (ex: cadastros via /api/register). Preenche o índice
// para que essas contas continuem/passem a funcionar, sem precisar recriar nada.

function backfillDirectory() {
  return master.transaction(() => {
    const tenants = listTenants();
    const pendingDeletionIds = new Set(master.prepare(`
      SELECT tenant_id FROM tenant_deletion_restore WHERE status = 'pending'
    `).all().map(row => Number(row.tenant_id)));
    // Um forward_only fica propositalmente sem DB no caminho original. Tentar
    // abri-lo durante o backfill recriaria um banco vazio e deixaria resíduo
    // após o cleanup. Esses owners permanecem intocados até o DELETE retomar.
    const stableTenants = tenants.filter(tenant => !pendingDeletionIds.has(Number(tenant.id)));
    const accounts = collectTenantAccounts({ tenants: stableTenants, getTenantDb });
    const platformUsernames = listPlatformSuperAdminUsernames();
    const conflicts = findIdentityConflicts(accounts, platformUsernames);
    if (conflicts.length) {
      throw new Error(`Diretorio de usuarios inconsistente: ${conflicts.join('; ')}`);
    }

    const expected = new Set(accounts.map(account => normalizeUsername(account.username)));
    const validTenantIds = new Set(tenants.map(tenant => Number(tenant.id)));
    const directoryEntries = master.prepare(`
      SELECT username, tenant_id, role FROM user_directory
    `).all();
    for (const entry of directoryEntries) {
      const username = normalizeUsername(entry.username);
      if (pendingDeletionIds.has(Number(entry.tenant_id))) continue;
      if (expected.has(username)) continue;

      // user_directory é um índice derivado. Só removemos uma entrada órfã
      // depois de provar, sob o lock master -> tenant, que a tabela indicada
      // realmente não contém aquela identidade. Owner/role divergente de uma
      // conta existente continua sendo erro fatal no audit abaixo.
      let accountStillExists = false;
      const tenantId = Number(entry.tenant_id);
      if (validTenantIds.has(tenantId) && ['admin', 'vendor'].includes(entry.role)) {
        const table = entry.role === 'admin' ? 'admins' : 'vendors';
        accountStillExists = Boolean(getTenantDb(tenantId).prepare(`
          SELECT 1 FROM ${table} WHERE username = ? COLLATE NOCASE LIMIT 1
        `).get(username));
      }
      if (accountStillExists) continue;
      const removed = master.prepare(`
        DELETE FROM user_directory
        WHERE username = ? COLLATE NOCASE AND tenant_id = ? AND role = ?
      `).run(username, tenantId, entry.role);
      if (removed.changes) {
        logAudit('system', 'directory_orphan_reconciled', validTenantIds.has(tenantId) ? tenantId : null, {
          username,
          previousTenantId: tenantId,
          previousRole: entry.role
        });
      }
    }

    // Migra identidades ausentes e conclui operações interrompidas depois do
    // commit do tenant. Colisões nunca são engolidas: escolher um owner pela
    // ordem de iteração poderia abrir a empresa errada no login.
    for (const account of accounts) {
      registerDirectoryUser(account.username, account.tenantId, account.role);
    }

    const errors = auditDirectoryEntries({
      accounts,
      directoryEntries: master.prepare('SELECT username, tenant_id, role FROM user_directory').all()
        .filter(entry => !pendingDeletionIds.has(Number(entry.tenant_id))),
      tenantIds: stableTenants.map(tenant => tenant.id),
      platformUsernames
    });
    if (errors.length) {
      throw new Error(`Diretorio de usuarios inconsistente: ${errors.join('; ')}`);
    }
  }).immediate();
}

function auditUserDirectoryIntegrity() {
  const tenants = listTenants();
  const pendingDeletionIds = new Set(master.prepare(`
    SELECT tenant_id FROM tenant_deletion_restore WHERE status = 'pending'
  `).all().map(row => Number(row.tenant_id)));
  const stableTenants = tenants.filter(tenant => !pendingDeletionIds.has(Number(tenant.id)));
  const accounts = collectTenantAccounts({ tenants: stableTenants, getTenantDb });
  const directoryEntries = master.prepare('SELECT username, tenant_id, role FROM user_directory').all()
    .filter(entry => !pendingDeletionIds.has(Number(entry.tenant_id)));
  const directoryEntriesChecked = directoryEntries.length;
  const errors = auditDirectoryEntries({
    accounts,
    directoryEntries,
    tenantIds: stableTenants.map(tenant => tenant.id),
    platformUsernames: listPlatformSuperAdminUsernames()
  });
  return {
    ok: errors.length === 0,
    accountsChecked: accounts.length,
    directoryEntriesChecked,
    tenantsPendingDeletion: pendingDeletionIds.size,
    errors
  };
}

backfillDirectory();

function closeAllDbs() {
  clearInterval(tenantDbSweeper);
  clearInterval(tenantDeletionCleanupTimer);
  for (const [tenantId] of tenantDbs) {
    closeTenantDb(tenantId);
  }
  if (productionWriterBootstrap) releaseProductionWriterLease();
  else try { master.close(); } catch {}
}

// ============ EXPORTS ============

module.exports = {
  TRIAL_DAYS,
  PLAN_USER_LIMITS,
  TENANT_NAME_MAX_LENGTH,
  TENANT_KEY_MAX_LENGTH,
  normalizeTenantId,
  normalizeTenantName,
  normalizeTenantKey,
  tenantSlugBase,
  normalizePlan,
  getTenantUserLimit,
  master,
  PLATFORM_KEYS,
  PLATFORM_SECRET_KEYS,
  PLATFORM_PUBLIC_KEYS,
  getResolvedPlatformEnv,
  getPlatformSetting,
  setPlatformConfig,
  getPlatformConfigStatus,
  invalidatePlatformEnvCache,
  getTenantDbPath,
  getTenantDb,
  acquireTenantDbLease,
  releaseTenantDbLease,
  closeTenantDb,
  closeAllDbs,
  listTenants,
  getTenant,
  getTenantBySubdomain,
  getTenantBySlug,
  createTenant,
  activateTenant,
  listStaleProvisioningTenants,
  listExpiredCheckoutReservations,
  updateTenant,
  withTenantCapacityLock,
  deleteTenant,
  processTenantDeletionCleanup,
  processTenantDeletionRestores,
  processForwardTenantDeletions,
  getTenantAuthPath,
  auditUserDirectoryIntegrity,
  findDirectoryUser,
  registerDirectoryUser,
  renameDirectoryUser,
  setBillingFields,
  setBillingFieldsFromStripe,
  recoverPlanCapacityBlock,
  beginStripeEvent,
  finishStripeEvent,
  failStripeEvent,
  getEffectiveBillingStatus,
  setComp,
  markTrialNotified,
  logAudit,
  listAuditLog
};
