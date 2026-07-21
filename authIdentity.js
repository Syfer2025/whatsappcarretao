'use strict';

function authenticationError(message = 'Identidade de autenticação inválida') {
  const error = new Error(message);
  error.code = 'AUTH_IDENTITY_INVALID';
  return error;
}

function positiveInteger(value, label) {
  if (typeof value === 'boolean'
      || (typeof value === 'string' && !/^[1-9]\d*$/.test(value.trim()))) {
    throw authenticationError(`${label} inválido`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw authenticationError(`${label} inválido`);
  return number;
}

function tokenVersion(value) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) throw authenticationError('Versão de token inválida');
  return number;
}

function validateSessionId(value) {
  if (value === undefined || value === null || value === '') return null;
  const sessionId = String(value);
  if (sessionId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw authenticationError('Sessão de autenticação inválida');
  }
  return sessionId;
}

function validateAuthenticatedPrincipal(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw authenticationError();
  }
  if (!['admin', 'vendor'].includes(payload.role)) throw authenticationError('Papel inválido');

  const principal = {
    ...payload,
    id: positiveInteger(payload.id, 'Usuário'),
    token_version: tokenVersion(payload.token_version),
    session_id: validateSessionId(payload.session_id)
  };

  if (payload.super_admin === true) {
    if (payload.role !== 'admin' || (payload.tenant_id !== null && payload.tenant_id !== undefined)) {
      throw authenticationError('Super admin não pode pertencer a um tenant');
    }
    principal.super_admin = true;
    principal.tenant_id = null;
    return principal;
  }

  // Every non-platform identity must own exactly one positive tenant. Missing
  // tenant claims are rejected before any database proxy or WhatsApp call.
  principal.super_admin = false;
  principal.tenant_id = positiveInteger(payload.tenant_id, 'Tenant');
  return principal;
}

function isTenantPrincipal(user) {
  return Boolean(
    user
    && user.super_admin === false
    && ['admin', 'vendor'].includes(user.role)
    && Number.isSafeInteger(Number(user.tenant_id))
    && Number(user.tenant_id) > 0
  );
}

function samePrincipal(left, right) {
  if (!left || !right) return false;
  return Number(left.id) === Number(right.id)
    && left.role === right.role
    && Number(left.tenant_id || 0) === Number(right.tenant_id || 0)
    && Boolean(left.super_admin) === Boolean(right.super_admin);
}

module.exports = {
  validateAuthenticatedPrincipal,
  isTenantPrincipal,
  samePrincipal
};
