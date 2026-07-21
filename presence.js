function positiveTenantId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function userKey(user) {
  if (!user?.role || !Number.isSafeInteger(Number(user.id))) return null;
  return `${user.role}:${Number(user.id)}`;
}

function createPresenceRegistry({ onChange = null } = {}) {
  const tenants = new Map();

  function publicEntry(entry) {
    const connectedTimes = [...entry.sockets.values()].sort();
    return {
      userId: entry.userId,
      role: entry.role,
      name: entry.name,
      sectorId: entry.sectorId,
      connectedAt: connectedTimes[0] || null,
      connectionCount: entry.sockets.size,
      online: entry.sockets.size > 0
    };
  }

  function notify(tenantId) {
    if (typeof onChange === 'function') onChange(tenantId, list(tenantId));
  }

  function connect({ tenantId: rawTenantId, user, socketId, now = new Date() }) {
    const tenantId = positiveTenantId(rawTenantId);
    const key = userKey(user);
    if (!tenantId || !key || !socketId) return null;

    let tenant = tenants.get(tenantId);
    if (!tenant) {
      tenant = new Map();
      tenants.set(tenantId, tenant);
    }

    let entry = tenant.get(key);
    if (!entry) {
      entry = {
        userId: Number(user.id),
        role: user.role,
        name: user.name || user.username || (user.role === 'admin' ? 'Administrador' : 'Usuário'),
        sectorId: user.sector_id ? Number(user.sector_id) : null,
        sockets: new Map()
      };
      tenant.set(key, entry);
    }
    entry.name = user.name || user.username || entry.name;
    entry.sectorId = user.sector_id ? Number(user.sector_id) : null;
    entry.sockets.set(String(socketId), new Date(now).toISOString());
    notify(tenantId);
    return publicEntry(entry);
  }

  function disconnect({ tenantId: rawTenantId, user, socketId }) {
    const tenantId = positiveTenantId(rawTenantId);
    const key = userKey(user);
    const tenant = tenantId ? tenants.get(tenantId) : null;
    const entry = tenant?.get(key);
    if (!entry) return false;

    if (!entry.sockets.delete(String(socketId))) return false;
    if (!entry.sockets.size) tenant.delete(key);
    if (!tenant.size) tenants.delete(tenantId);
    notify(tenantId);
    return true;
  }

  function list(rawTenantId) {
    const tenantId = positiveTenantId(rawTenantId);
    const tenant = tenantId ? tenants.get(tenantId) : null;
    if (!tenant) return [];
    return [...tenant.values()]
      .map(publicEntry)
      .sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
  }

  function isOnline(rawTenantId, role, userId) {
    const tenantId = positiveTenantId(rawTenantId);
    return Boolean(tenantId && tenants.get(tenantId)?.get(`${role}:${Number(userId)}`)?.sockets.size);
  }

  function clearTenant(rawTenantId) {
    const tenantId = positiveTenantId(rawTenantId);
    if (!tenantId) return;
    tenants.delete(tenantId);
    notify(tenantId);
  }

  return { connect, disconnect, list, isOnline, clearTenant };
}

module.exports = { createPresenceRegistry };
