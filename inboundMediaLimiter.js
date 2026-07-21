'use strict';

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function limiterError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 503;
  return error;
}

/**
 * Semaphore shared by realtime delivery and history imports.
 *
 * whatsapp-web.js returns media as base64. A single large attachment can
 * temporarily occupy substantially more heap than the decoded file, so a
 * per-tenant work queue is not enough: N tenants could all decode at once.
 * This limiter enforces both a process-wide ceiling and tenant fairness.
 */
function createInboundMediaLimiter({
  globalConcurrency = 2,
  tenantConcurrency = 1,
  maxPending = 100,
  slotTimeoutMs = 120000
} = {}) {
  const globalLimit = positiveInteger(globalConcurrency, 2);
  const tenantLimit = Math.min(
    positiveInteger(tenantConcurrency, 1),
    globalLimit
  );
  const pendingLimit = positiveInteger(maxPending, 100);
  const waitTimeoutMs = positiveInteger(slotTimeoutMs, 120000);
  const queues = new Map();
  const activeByTenant = new Map();
  const tenantOrder = [];
  const tenantsInOrder = new Set();
  let active = 0;
  let pending = 0;
  let closed = false;
  const drainWaiters = new Set();

  function notifyDrainWaiters() {
    if (active || pending) return;
    for (const resolve of drainWaiters) resolve(true);
    drainWaiters.clear();
  }

  function normalizeTenantId(tenantId) {
    const normalized = Number(tenantId);
    if (!Number.isSafeInteger(normalized) || normalized <= 0) {
      throw limiterError('INVALID_TENANT', 'Tenant inválido para download de mídia');
    }
    return normalized;
  }

  function enqueueTenant(tenantId) {
    if (tenantsInOrder.has(tenantId)) return;
    tenantsInOrder.add(tenantId);
    tenantOrder.push(tenantId);
  }

  function removePendingItem(item) {
    const queue = queues.get(item.tenantId);
    if (!queue) return false;
    const index = queue.indexOf(item);
    if (index === -1) return false;
    queue.splice(index, 1);
    pending -= 1;
    if (!queue.length) queues.delete(item.tenantId);
    return true;
  }

  function release(tenantId) {
    if (active <= 0) return;
    active -= 1;
    const tenantActive = Math.max(0, (activeByTenant.get(tenantId) || 1) - 1);
    if (tenantActive) activeByTenant.set(tenantId, tenantActive);
    else activeByTenant.delete(tenantId);
    notifyDrainWaiters();
    pump();
  }

  function grant(item) {
    if (item.cancelled) return;
    clearTimeout(item.timer);
    pending -= 1;
    active += 1;
    activeByTenant.set(item.tenantId, (activeByTenant.get(item.tenantId) || 0) + 1);
    let released = false;
    item.resolve(() => {
      if (released) return;
      released = true;
      release(item.tenantId);
    });
  }

  function pump() {
    if (closed) return;
    // Each scan rotates the tenant to the end of the order. This avoids a
    // large history import starving newly arrived stickers from another tenant.
    let scansWithoutGrant = 0;
    while (active < globalLimit && tenantOrder.length) {
      const tenantId = tenantOrder.shift();
      tenantsInOrder.delete(tenantId);
      const queue = queues.get(tenantId);
      if (!queue?.length) {
        queues.delete(tenantId);
        continue;
      }

      if ((activeByTenant.get(tenantId) || 0) >= tenantLimit) {
        enqueueTenant(tenantId);
        scansWithoutGrant += 1;
        if (scansWithoutGrant >= tenantOrder.length) break;
        continue;
      }

      scansWithoutGrant = 0;
      const item = queue.shift();
      if (queue.length) enqueueTenant(tenantId);
      else queues.delete(tenantId);
      grant(item);
    }
  }

  function acquire(tenantId) {
    let normalizedTenantId;
    try {
      normalizedTenantId = normalizeTenantId(tenantId);
    } catch (error) {
      return Promise.reject(error);
    }
    if (closed) {
      return Promise.reject(limiterError('MEDIA_DOWNLOAD_LIMITER_CLOSED', 'Downloads de mídia encerrados'));
    }
    if (pending >= pendingLimit) {
      return Promise.reject(limiterError(
        'MEDIA_DOWNLOAD_QUEUE_FULL',
        'Fila global de download de mídia temporariamente cheia'
      ));
    }

    return new Promise((resolve, reject) => {
      const item = {
        tenantId: normalizedTenantId,
        resolve,
        reject,
        cancelled: false,
        timer: null
      };
      item.timer = setTimeout(() => {
        if (!removePendingItem(item)) return;
        item.cancelled = true;
        reject(limiterError(
          'MEDIA_DOWNLOAD_SLOT_TIMEOUT',
          'Tempo excedido aguardando capacidade para baixar mídia'
        ));
        notifyDrainWaiters();
        pump();
      }, waitTimeoutMs);
      item.timer.unref?.();

      const queue = queues.get(normalizedTenantId) || [];
      queue.push(item);
      queues.set(normalizedTenantId, queue);
      pending += 1;
      enqueueTenant(normalizedTenantId);
      pump();
    });
  }

  async function run(tenantId, operation) {
    if (typeof operation !== 'function') throw new TypeError('Operação de mídia inválida');
    const releaseSlot = await acquire(tenantId);
    try {
      return await operation();
    } finally {
      releaseSlot();
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const queue of queues.values()) {
      for (const item of queue) {
        clearTimeout(item.timer);
        item.cancelled = true;
        item.reject(limiterError('MEDIA_DOWNLOAD_LIMITER_CLOSED', 'Downloads de mídia encerrados'));
      }
    }
    queues.clear();
    tenantOrder.length = 0;
    tenantsInOrder.clear();
    pending = 0;
    notifyDrainWaiters();
  }

  async function drain(timeoutMs = 10000) {
    if (!active && !pending) return true;
    let waiter;
    let timer;
    const drained = new Promise(resolve => {
      waiter = resolve;
      drainWaiters.add(resolve);
    });
    const timedOut = new Promise(resolve => {
      timer = setTimeout(() => resolve(false), positiveInteger(timeoutMs, 10000));
      timer.unref?.();
    });
    try {
      return await Promise.race([drained, timedOut]);
    } finally {
      clearTimeout(timer);
      drainWaiters.delete(waiter);
    }
  }

  function getStats() {
    return {
      active,
      pending,
      tenantsPending: queues.size,
      globalConcurrency: globalLimit,
      tenantConcurrency: tenantLimit,
      maxPending: pendingLimit,
      closed
    };
  }

  return { acquire, run, drain, close, getStats };
}

const inboundMediaLimiter = createInboundMediaLimiter({
  globalConcurrency: process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY,
  tenantConcurrency: process.env.INBOUND_MEDIA_TENANT_CONCURRENCY,
  maxPending: process.env.INBOUND_MEDIA_MAX_PENDING,
  slotTimeoutMs: process.env.INBOUND_MEDIA_SLOT_TIMEOUT_MS
});

module.exports = {
  createInboundMediaLimiter,
  inboundMediaLimiter
};
