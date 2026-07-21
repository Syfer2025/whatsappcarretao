const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const { applyPragmas } = require('./schema');
const { createSingleWriterLease } = require('./singleWriterLease');

let state = null;
const PRODUCTION_WRITER_LEASE_LOST_EVENT = 'whatsa:production-writer-lease-lost';

function notifyProductionWriterLeaseLost(error, processRef = process) {
  try { processRef.stderr?.write?.(`[fatal] ${error.message}\n`); } catch {}
  processRef.exitCode = 1;
  // The server subscribes to this event and can synchronously stop admissions
  // and discard outbound work before beginning fatal shutdown. Standalone
  // consumers retain SIGTERM as a fail-safe and still exit non-zero.
  const handled = Boolean(processRef.emit?.(PRODUCTION_WRITER_LEASE_LOST_EVENT, error));
  if (!handled) {
    try {
      processRef.kill(processRef.pid, 'SIGTERM');
    } catch {
      // exitCode=1 remains the final fallback when signals are unavailable.
    }
  }
  return handled;
}

function ensureProductionWriterLease({ dataDir } = {}) {
  if (process.env.NODE_ENV !== 'production') return null;
  if (state) return state;

  const resolvedDataDir = path.resolve(dataDir || process.env.DATA_DIR || path.join(__dirname, 'data'));
  fs.mkdirSync(resolvedDataDir, { recursive: true });
  const master = new Database(path.join(resolvedDataDir, 'master.db'));
  try {
    applyPragmas(master);
    const lease = createSingleWriterLease({
      db: master,
      ttlMs: process.env.SINGLE_WRITER_LEASE_TTL_MS || undefined,
      heartbeatMs: process.env.SINGLE_WRITER_LEASE_HEARTBEAT_MS || undefined,
      onLost: error => {
        notifyProductionWriterLeaseLost(error);
      }
    });
    const onProcessExit = () => {
      try { lease.release(); } catch {}
      try { master.close(); } catch {}
    };
    process.once('exit', onProcessExit);
    state = { dataDir: resolvedDataDir, master, lease, onProcessExit };
    return state;
  } catch (error) {
    try { master.close(); } catch {}
    throw error;
  }
}

function releaseProductionWriterLease() {
  if (!state) return false;
  const current = state;
  state = null;
  process.removeListener('exit', current.onProcessExit);
  let released = false;
  try { released = current.lease.release(); } catch {}
  try { current.master.close(); } catch {}
  return released;
}

function isProductionWriterLeaseHealthy() {
  if (process.env.NODE_ENV !== 'production') return true;
  return Boolean(
    state
    && !state.lease.isReleased()
    && !state.lease.isLost()
  );
}

module.exports = {
  ensureProductionWriterLease,
  releaseProductionWriterLease,
  isProductionWriterLeaseHealthy,
  PRODUCTION_WRITER_LEASE_LOST_EVENT,
  notifyProductionWriterLeaseLost
};
