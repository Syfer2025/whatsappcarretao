const crypto = require('node:crypto');

const MIN_TTL_MS = 60_000;
const DEFAULT_TTL_MS = 90_000;
const DEFAULT_HEARTBEAT_MS = 20_000;

function leaseError(message, code = 'SINGLE_WRITER_LEASE_HELD', detail = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

function positiveInteger(value, fallback, label) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw leaseError(`${label} deve ser um inteiro positivo`, 'SINGLE_WRITER_LEASE_CONFIG_INVALID');
  }
  return number;
}

function sqliteNowMs(db) {
  return Number(db.prepare(`
    SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms
  `).get().now_ms);
}

function ensureLeaseSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_leases (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      heartbeat_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
  `);
}

function createSingleWriterLease({
  db,
  enabled = true,
  name = 'whatsa-production-writer',
  owner = crypto.randomUUID(),
  ttlMs = DEFAULT_TTL_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  onLost = null,
  startHeartbeat = true
}) {
  if (!enabled) return null;
  if (!db?.prepare || !db?.transaction) {
    throw leaseError('Banco mestre obrigatorio para o lease', 'SINGLE_WRITER_LEASE_CONFIG_INVALID');
  }
  const cleanName = String(name || '').trim();
  const cleanOwner = String(owner || '').trim();
  if (!cleanName || !cleanOwner) {
    throw leaseError('Nome e owner do lease sao obrigatorios', 'SINGLE_WRITER_LEASE_CONFIG_INVALID');
  }
  const leaseTtlMs = positiveInteger(ttlMs, DEFAULT_TTL_MS, 'TTL do lease');
  const leaseHeartbeatMs = positiveInteger(heartbeatMs, DEFAULT_HEARTBEAT_MS, 'Heartbeat do lease');
  if (leaseTtlMs < MIN_TTL_MS) {
    throw leaseError(
      `TTL do lease deve ser de pelo menos ${MIN_TTL_MS} ms`,
      'SINGLE_WRITER_LEASE_CONFIG_INVALID'
    );
  }
  if (leaseHeartbeatMs >= leaseTtlMs / 2) {
    throw leaseError(
      'Heartbeat do lease deve ser menor que metade do TTL',
      'SINGLE_WRITER_LEASE_CONFIG_INVALID'
    );
  }

  ensureLeaseSchema(db);
  const acquire = db.transaction(() => {
    const now = sqliteNowMs(db);
    const existing = db.prepare('SELECT * FROM runtime_leases WHERE name = ?').get(cleanName);
    if (existing && existing.owner !== cleanOwner && Number(existing.expires_at_ms) > now) {
      throw leaseError(
        `Outra instancia de producao ja possui o lease de escrita ate ${new Date(Number(existing.expires_at_ms)).toISOString()}`,
        'SINGLE_WRITER_LEASE_HELD',
        { expiresAtMs: Number(existing.expires_at_ms) }
      );
    }
    db.prepare(`
      INSERT INTO runtime_leases (name, owner, heartbeat_at_ms, expires_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        owner = excluded.owner,
        heartbeat_at_ms = excluded.heartbeat_at_ms,
        expires_at_ms = excluded.expires_at_ms
    `).run(cleanName, cleanOwner, now, now + leaseTtlMs);
    return { acquiredAtMs: now, expiresAtMs: now + leaseTtlMs };
  });
  const acquired = acquire.immediate();
  let released = false;
  let lost = false;
  let heartbeatTimer = null;

  function heartbeat() {
    if (released || lost) return false;
    try {
      const renewed = db.transaction(() => {
        const now = sqliteNowMs(db);
        const result = db.prepare(`
          UPDATE runtime_leases
          SET heartbeat_at_ms = ?, expires_at_ms = ?
          WHERE name = ?
            AND owner = ?
            AND expires_at_ms > ?
        `).run(now, now + leaseTtlMs, cleanName, cleanOwner, now);
        return result.changes === 1;
      }).immediate();
      if (renewed) return true;
      throw leaseError(
        'O lease exclusivo de escrita expirou ou foi assumido por outra instancia',
        'SINGLE_WRITER_LEASE_LOST'
      );
    } catch (error) {
      lost = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      const normalized = error.code
        ? error
        : leaseError(`Falha ao renovar lease exclusivo: ${error.message}`, 'SINGLE_WRITER_LEASE_LOST');
      if (typeof onLost === 'function') onLost(normalized);
      return false;
    }
  }

  function release() {
    if (released) return false;
    released = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (lost) return false;
    try {
      return db.transaction(() => db.prepare(`
        DELETE FROM runtime_leases WHERE name = ? AND owner = ?
      `).run(cleanName, cleanOwner).changes === 1).immediate();
    } catch (error) {
      if (/not open/i.test(String(error?.message || ''))) return false;
      throw error;
    }
  }

  if (startHeartbeat) {
    heartbeatTimer = setInterval(heartbeat, leaseHeartbeatMs);
    heartbeatTimer.unref?.();
  }

  return {
    name: cleanName,
    owner: cleanOwner,
    acquiredAtMs: acquired.acquiredAtMs,
    expiresAtMs: acquired.expiresAtMs,
    ttlMs: leaseTtlMs,
    heartbeatMs: leaseHeartbeatMs,
    heartbeat,
    release,
    isReleased: () => released,
    isLost: () => lost
  };
}

module.exports = {
  MIN_TTL_MS,
  DEFAULT_TTL_MS,
  DEFAULT_HEARTBEAT_MS,
  sqliteNowMs,
  createSingleWriterLease
};
