'use strict';

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

class PartitionedWorkQueue {
  constructor({ concurrency = 2, maxPending = 500, onTaskError = null } = {}) {
    this.concurrency = positiveInteger(concurrency, 2);
    this.maxPending = positiveInteger(maxPending, 500);
    this.onTaskError = typeof onTaskError === 'function' ? onTaskError : null;
    this.partitions = new Map();
    this.blockedPartitions = new Set();
    this.closed = false;
    this.drainWaiters = new Set();
  }

  getPartition(key) {
    let state = this.partitions.get(key);
    if (!state) {
      state = {
        active: 0,
        pending: [],
        dedupeKeys: new Set(),
        discarded: false,
        processed: 0,
        failed: 0,
        rejected: 0
      };
      this.partitions.set(key, state);
    }
    return state;
  }

  enqueue(partitionKey, dedupeKey, task, metadata = null) {
    if (this.closed || this.blockedPartitions.has(partitionKey) || typeof task !== 'function') return false;
    const state = this.getPartition(partitionKey);
    if (state.discarded) return false;
    const normalizedDedupeKey = dedupeKey == null ? null : String(dedupeKey);
    if (normalizedDedupeKey && state.dedupeKeys.has(normalizedDedupeKey)) return false;
    if (state.pending.length >= this.maxPending) {
      state.rejected += 1;
      return false;
    }
    if (normalizedDedupeKey) state.dedupeKeys.add(normalizedDedupeKey);
    state.pending.push({ task, dedupeKey: normalizedDedupeKey, metadata });
    this.pump(partitionKey, state);
    return true;
  }

  pump(partitionKey, state) {
    // `closed` impede novas entradas, mas tarefas já aceitas continuam quando
    // close({ discardPending: false }) é usado.
    while (!state.discarded && state.active < this.concurrency && state.pending.length) {
      const item = state.pending.shift();
      state.active += 1;
      Promise.resolve()
        .then(item.task)
        .then(() => {
          state.processed += 1;
        })
        .catch(err => {
          state.failed += 1;
          try {
            this.onTaskError?.(err, {
              partitionKey,
              dedupeKey: item.dedupeKey,
              metadata: item.metadata
            });
          } catch {}
        })
        .finally(() => {
          state.active -= 1;
          if (item.dedupeKey) state.dedupeKeys.delete(item.dedupeKey);
          if (state.discarded && state.active === 0) this.partitions.delete(partitionKey);
          this.pump(partitionKey, state);
          this.notifyDrainWaiters();
        });
    }
  }

  getStats(partitionKey = null) {
    const summarize = state => ({
      active: state?.active || 0,
      pending: state?.pending.length || 0,
      processed: state?.processed || 0,
      failed: state?.failed || 0,
      rejected: state?.rejected || 0
    });
    if (partitionKey != null) return summarize(this.partitions.get(partitionKey));
    const total = { active: 0, pending: 0, processed: 0, failed: 0, rejected: 0 };
    for (const state of this.partitions.values()) {
      const stats = summarize(state);
      for (const field of Object.keys(total)) total[field] += stats[field];
    }
    return total;
  }

  isIdle() {
    const stats = this.getStats();
    return stats.active === 0 && stats.pending === 0;
  }

  notifyDrainWaiters() {
    if (!this.isIdle()) return;
    for (const resolve of this.drainWaiters) resolve(true);
    this.drainWaiters.clear();
  }

  async drain(timeoutMs = 10000) {
    if (this.isIdle()) return true;
    let timeout;
    let waiter;
    const drained = new Promise(resolve => {
      waiter = resolve;
      this.drainWaiters.add(resolve);
    });
    const timedOut = new Promise(resolve => {
      timeout = setTimeout(() => resolve(false), Math.max(1, Number(timeoutMs) || 10000));
      timeout.unref?.();
    });
    try {
      return await Promise.race([drained, timedOut]);
    } finally {
      clearTimeout(timeout);
      this.drainWaiters.delete(waiter);
    }
  }

  discardPartition(partitionKey, { permanent = true } = {}) {
    if (permanent) this.blockedPartitions.add(partitionKey);
    const state = this.partitions.get(partitionKey);
    if (!state) return 0;
    state.discarded = true;
    const discarded = state.pending.length;
    for (const item of state.pending) {
      if (item.dedupeKey) state.dedupeKeys.delete(item.dedupeKey);
    }
    state.pending.length = 0;
    if (state.active === 0) this.partitions.delete(partitionKey);
    this.notifyDrainWaiters();
    return discarded;
  }

  close({ discardPending = false } = {}) {
    this.closed = true;
    if (discardPending) {
      for (const [partitionKey, state] of this.partitions) {
        state.discarded = true;
        state.pending.length = 0;
        state.dedupeKeys.clear();
        if (state.active === 0) this.partitions.delete(partitionKey);
      }
      this.notifyDrainWaiters();
    } else {
      for (const [partitionKey, state] of this.partitions) {
        this.pump(partitionKey, state);
      }
    }
    this.blockedPartitions.clear();
  }
}

module.exports = { PartitionedWorkQueue };
