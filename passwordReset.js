const bcrypt = require('bcryptjs');
const { normalizeUsername } = require('./userDirectoryIntegrity');

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_BYTES = 72;
const GENERIC_REQUEST_RESULT = Object.freeze({ accepted: true });

function domainError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw domainError(`${label} invalido`, 400);
  }
  return number;
}

function isoNow(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw domainError('Data invalida', 400);
  return date.toISOString();
}

function validateNewPassword(password) {
  if (typeof password !== 'string' || Array.from(password).length < MIN_PASSWORD_LENGTH || !password.trim()) {
    throw domainError(`Senha deve ter no minimo ${MIN_PASSWORD_LENGTH} caracteres`, 400);
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw domainError(`Senha deve ter no maximo ${MAX_PASSWORD_BYTES} bytes UTF-8`, 400);
  }
  return password;
}

function createPasswordResetRequest({
  email,
  masterDb,
  findDirectoryUser,
  getTenantDb,
  now = Date.now,
  onCreated = null
}) {
  const cleanEmail = typeof email === 'string' ? normalizeUsername(email) : '';
  if (!cleanEmail) return GENERIC_REQUEST_RESULT;

  const entry = findDirectoryUser(cleanEmail);
  if (!entry || entry.role !== 'admin') return GENERIC_REQUEST_RESULT;

  const tenantId = Number(entry.tenant_id);
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) return GENERIC_REQUEST_RESULT;
  let tenantDb;
  try {
    tenantDb = getTenantDb(tenantId);
  } catch (error) {
    // Diretório obsoleto ou tenant sendo removido não deve permitir enumerar
    // contas. Falhas reais de infraestrutura continuam sendo reportadas.
    if ([404, 409].includes(Number(error?.statusCode))) return GENERIC_REQUEST_RESULT;
    throw error;
  }
  const admin = tenantDb
    .prepare('SELECT id, username FROM admins WHERE username = ? COLLATE NOCASE AND coalesce(super_admin, 0) = 0')
    .get(cleanEmail);
  if (!admin) return GENERIC_REQUEST_RESULT;

  const created = masterDb.transaction(() => {
    const result = masterDb.prepare(`
      INSERT INTO password_reset_requests
        (tenant_id, admin_id, email, status, requested_at)
      VALUES (?, ?, ?, 'pending', ?)
      ON CONFLICT(tenant_id, admin_id) WHERE status = 'pending' DO NOTHING
    `).run(tenantId, admin.id, cleanEmail, isoNow(now));
    if (!result.changes) return null;
    return { id: Number(result.lastInsertRowid), tenantId, adminId: Number(admin.id), email: cleanEmail };
  })();

  if (created && typeof onCreated === 'function') {
    try { onCreated(created); } catch {}
  }

  // A resposta e deliberadamente identica para admin, vendedor e conta ausente.
  return GENERIC_REQUEST_RESULT;
}

function listPendingPasswordResetRequests({ masterDb, limit = 100 }) {
  const safeLimit = Number(limit);
  if (!Number.isSafeInteger(safeLimit) || safeLimit <= 0 || safeLimit > 500) {
    throw domainError('Limite invalido', 400);
  }
  return masterDb.prepare(`
    SELECT r.id,
           r.tenant_id,
           t.name AS tenant_name,
           r.admin_id,
           r.email,
           r.status,
           r.requested_at,
           r.resolved_at,
           r.resolved_by
    FROM password_reset_requests r
    JOIN tenants t ON t.id = r.tenant_id
    WHERE r.status = 'pending'
    ORDER BY r.requested_at ASC, r.id ASC
    LIMIT ?
  `).all(safeLimit);
}

function isPasswordResetInFlight({ masterDb, tenantId, adminId }) {
  return Boolean(masterDb.prepare(`
    SELECT 1
    FROM password_reset_requests
    WHERE tenant_id = ?
      AND admin_id = ?
      AND status = 'pending'
      AND resolution_hash IS NOT NULL
    LIMIT 1
  `).get(positiveInteger(tenantId, 'Tenant'), positiveInteger(adminId, 'Administrador')));
}

function claimPasswordResetResolution({ id, passwordHash, resolver, resolvedAt, masterDb }) {
  return masterDb.transaction(() => {
    const request = masterDb.prepare(`
      SELECT * FROM password_reset_requests WHERE id = ? AND status = 'pending'
    `).get(id);
    if (!request) throw domainError('Solicitacao pendente nao encontrada', 404);
    if (request.resolution_hash) {
      const error = domainError('Solicitacao ja esta em recuperacao; aguarde a conclusao', 409);
      error.code = 'PASSWORD_RESET_IN_PROGRESS';
      throw error;
    }
    const claimed = masterDb.prepare(`
      UPDATE password_reset_requests
      SET resolution_hash = ?,
          resolution_started_at = ?,
          resolution_resolver = ?,
          resolution_target_at = ?
      WHERE id = ? AND status = 'pending' AND resolution_hash IS NULL
    `).run(passwordHash, resolvedAt, resolver, resolvedAt, id);
    if (!claimed.changes) throw domainError('Solicitacao ja esta sendo resolvida', 409);
    return masterDb.prepare(`
      SELECT * FROM password_reset_requests WHERE id = ? AND status = 'pending'
    `).get(id);
  }).immediate();
}

function clearPasswordResetClaim(masterDb, request) {
  masterDb.transaction(() => {
    masterDb.prepare(`
      UPDATE password_reset_requests
      SET resolution_hash = NULL,
          resolution_started_at = NULL,
          resolution_resolver = NULL,
          resolution_target_at = NULL
      WHERE id = ? AND status = 'pending' AND resolution_hash = ?
    `).run(request.id, request.resolution_hash);
  }).immediate();
}

function applyPasswordResetToTenant(request, getTenantDb) {
  const tenantDb = getTenantDb(positiveInteger(request.tenant_id, 'Tenant'));
  return tenantDb.transaction(() => {
    const existing = tenantDb.prepare(`
      SELECT admin_id, password_hash
      FROM password_reset_applications
      WHERE request_id = ?
    `).get(request.id);
    if (existing) {
      if (Number(existing.admin_id) !== Number(request.admin_id)
          || existing.password_hash !== request.resolution_hash) {
        throw new Error('Marcador de recuperacao de senha inconsistente');
      }
      return false;
    }
    const changed = tenantDb.prepare(`
      UPDATE admins
      SET password = ?, token_version = token_version + 1
      WHERE id = ? AND username = ? COLLATE NOCASE AND coalesce(super_admin, 0) = 0
    `).run(request.resolution_hash, request.admin_id, request.email);
    if (!changed.changes) {
      const error = domainError('Administrador da solicitacao nao encontrado', 404);
      error.code = 'PASSWORD_RESET_TARGET_MISSING';
      throw error;
    }
    tenantDb.prepare(`
      INSERT INTO password_reset_applications (request_id, admin_id, password_hash)
      VALUES (?, ?, ?)
    `).run(request.id, request.admin_id, request.resolution_hash);
    return true;
  })();
}

function finalizePasswordResetResolution(request, masterDb) {
  return masterDb.transaction(() => {
    const resolution = masterDb.prepare(`
      UPDATE password_reset_requests
      SET status = 'resolved',
          resolved_at = resolution_target_at,
          resolved_by = resolution_resolver,
          resolution_hash = NULL
      WHERE id = ? AND status = 'pending' AND resolution_hash = ?
    `).run(request.id, request.resolution_hash);
    if (!resolution.changes) {
      const current = masterDb.prepare(`
        SELECT id, tenant_id, admin_id, email, status, requested_at, resolved_at, resolved_by
        FROM password_reset_requests WHERE id = ?
      `).get(request.id);
      if (current?.status === 'resolved') return current;
      throw domainError('Solicitacao ja foi resolvida', 409);
    }
    return masterDb.prepare(`
      SELECT id, tenant_id, admin_id, email, status, requested_at, resolved_at, resolved_by
      FROM password_reset_requests
      WHERE id = ?
    `).get(request.id);
  }).immediate();
}

function completeClaimedPasswordReset(request, { masterDb, getTenantDb, afterTenantApplied = null }) {
  const applied = applyPasswordResetToTenant(request, getTenantDb);
  if (typeof afterTenantApplied === 'function') afterTenantApplied({ request, applied });
  return finalizePasswordResetResolution(request, masterDb);
}

function resolvePasswordResetRequest({
  requestId,
  newPassword,
  resolvedBy,
  masterDb,
  getTenantDb,
  now = Date.now,
  bcryptCost = 10,
  afterTenantApplied = null
}) {
  const id = positiveInteger(requestId, 'Solicitacao');
  const password = validateNewPassword(newPassword);
  const resolver = String(resolvedBy ?? '').trim();
  if (!resolver) throw domainError('Super admin responsavel obrigatorio', 400);
  const request = claimPasswordResetResolution({
    id,
    passwordHash: bcrypt.hashSync(password, bcryptCost),
    resolver,
    resolvedAt: isoNow(now),
    masterDb
  });
  try {
    return completeClaimedPasswordReset(request, { masterDb, getTenantDb, afterTenantApplied });
  } catch (error) {
    // Alvo comprovadamente inexistente é um erro de domínio, não uma operação
    // em voo. Libera o claim para correção manual. Erro de I/O/crash mantém o
    // hash durável para o boot repetir exatamente a mesma mutação.
    if (error.code === 'PASSWORD_RESET_TARGET_MISSING') {
      clearPasswordResetClaim(masterDb, request);
    }
    throw error;
  }
}

function recoverInFlightPasswordResetResolutions({ masterDb, getTenantDb, limit = 100 }) {
  const safeLimit = positiveInteger(limit, 'Limite');
  if (safeLimit > 500) throw domainError('Limite invalido', 400);
  const requests = masterDb.prepare(`
    SELECT *
    FROM password_reset_requests
    WHERE status = 'pending' AND resolution_hash IS NOT NULL
    ORDER BY resolution_started_at, id
    LIMIT ?
  `).all(safeLimit);
  return requests.map(request => {
    try {
      const resolved = completeClaimedPasswordReset(request, { masterDb, getTenantDb });
      return { requestId: Number(request.id), recovered: true, resolved, error: null };
    } catch (error) {
      if (error.code === 'PASSWORD_RESET_TARGET_MISSING') {
        clearPasswordResetClaim(masterDb, request);
      }
      return { requestId: Number(request.id), recovered: false, resolved: null, error };
    }
  });
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  createPasswordResetRequest,
  listPendingPasswordResetRequests,
  isPasswordResetInFlight,
  resolvePasswordResetRequest,
  recoverInFlightPasswordResetResolutions
};
