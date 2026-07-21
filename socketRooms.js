'use strict';

function positiveInteger(value, label) {
  if (typeof value === 'boolean'
      || (typeof value === 'string' && !/^[1-9]\d*$/.test(value.trim()))) {
    throw new Error(`${label} inválido para sala em tempo real`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} inválido para sala em tempo real`);
  }
  return number;
}

function identityParts(user) {
  if (!user || !['admin', 'vendor'].includes(user.role)) {
    throw new Error('Identidade inválida para sala em tempo real');
  }
  return { role: user.role, userId: positiveInteger(user.id, 'Usuário') };
}

function buildUserRoom(user, tenantId) {
  const { role, userId } = identityParts(user);
  return `user:${positiveInteger(tenantId, 'Tenant')}:${role}:${userId}`;
}

function buildIdentityRoom(user, tenantId) {
  const { role, userId } = identityParts(user);
  const tenantPart = tenantId == null ? 'platform' : positiveInteger(tenantId, 'Tenant');
  return `identity:${tenantPart}:${role}:${userId}`;
}

function buildSessionRoom(user, tenantId) {
  const { role, userId } = identityParts(user);
  const tenantPart = tenantId == null ? 'platform' : positiveInteger(tenantId, 'Tenant');
  const sessionPart = user.session_id || `legacy-${Math.max(0, Number(user.iat || 0))}`;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(sessionPart))) {
    throw new Error('Sessão inválida para sala em tempo real');
  }
  return `session:${tenantPart}:${role}:${userId}:${sessionPart}`;
}

function buildSupportTenantRoom(tenantId) {
  return `support-tenant:${positiveInteger(tenantId, 'Tenant')}`;
}

module.exports = {
  buildUserRoom,
  buildIdentityRoom,
  buildSessionRoom,
  buildSupportTenantRoom
};
