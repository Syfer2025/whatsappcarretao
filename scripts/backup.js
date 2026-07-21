'use strict';

const crypto = require('crypto');
const { createReadStream } = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { auditGlobalIntegrity } = require('./global-integrity');

const BACKUP_FORMAT_VERSION = 2;
const DEFAULT_RETENTION = 4;
const DEFAULT_LOCK_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FREE_MARGIN_MB = 2048;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Inteiro nao negativo invalido: ${String(value)}`);
  }
  return parsed;
}

function booleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw new Error(`Opcao booleana invalida: ${String(value)}`);
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function assertPlainDirectory(directory, label, { optional = true } = {}) {
  let stats;
  try {
    stats = await fs.lstat(directory);
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return false;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} deve ser um diretorio real, nao um link simbolico`);
  }
  return true;
}

async function validateWhatsappAuthTree(directory) {
  if (!(await pathExists(directory))) return;
  const allowedRuntimeLinks = new Set(['RunningChromeVersion', 'SingletonCookie', 'SingletonLock', 'SingletonSocket']);
  async function inspect(entryPath) {
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink()) {
      if (!allowedRuntimeLinks.has(path.basename(entryPath))) {
        throw new Error('.wwebjs_auth/ contem link simbolico inesperado');
      }
      return;
    }
    if (stats.isFile()) return;
    if (!stats.isDirectory()) {
      throw new Error('.wwebjs_auth/ contem arquivo especial inesperado');
    }
    for (const name of await fs.readdir(entryPath)) await inspect(path.join(entryPath, name));
  }
  await inspect(directory);
}

async function walkDatabaseFiles(directory, files = []) {
  if (!(await pathExists(directory))) return files;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkDatabaseFiles(entryPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.db')) {
      files.push(entryPath);
    }
  }
  return files;
}

async function listDatabaseFiles(rootDir) {
  const databases = [];
  const rootEntries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name.endsWith('.db')) {
      databases.push(path.join(rootDir, entry.name));
    }
  }
  await walkDatabaseFiles(path.join(rootDir, 'data'), databases);
  return databases.sort((a, b) => a.localeCompare(b));
}

async function sha256File(filename) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filename);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function syncFile(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryTree(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) await syncDirectoryTree(path.join(directory, entry.name));
  }
  await syncDirectory(directory);
}

async function backupDatabase(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await database.backup(destination);
  } finally {
    database.close();
  }
  // Um snapshot deve ser autocontido. O backup API pode preservar WAL como
  // journal_mode; convertemos a copia para DELETE e removemos sidecars vazios
  // antes de calcular o hash.
  const verification = new Database(destination, { fileMustExist: true });
  try {
    verification.pragma('wal_checkpoint(TRUNCATE)');
    verification.pragma('journal_mode = DELETE');
    const result = verification.pragma('integrity_check');
    if (result.length !== 1 || result[0].integrity_check !== 'ok') {
      throw new Error(`Falha no integrity_check do snapshot SQLite: ${destination}`);
    }
    const foreignKeyViolations = verification.pragma('foreign_key_check');
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        `Falha no foreign_key_check do snapshot SQLite: ${destination} (${foreignKeyViolations.length} violacao(oes))`,
      );
    }
  } finally {
    verification.close();
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    await fs.rm(`${destination}${suffix}`, { force: true });
  }
  await fs.chmod(destination, 0o600);
  await syncFile(destination);
  const stats = await fs.stat(destination);
  return {
    bytes: stats.size,
    sha256: await sha256File(destination),
    integrityCheck: 'ok',
  };
}

async function copySnapshotTree(source, destination) {
  const summary = {
    files: 0,
    bytes: 0,
    skippedSpecialFiles: 0,
    sourceSkippedSpecialFiles: 0,
    sha256: crypto.createHash('sha256').digest('hex'),
  };
  if (!(await pathExists(source))) return summary;
  const treeHash = crypto.createHash('sha256');

  async function copyEntry(sourcePath, destinationPath) {
    const stats = await fs.lstat(sourcePath);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
      summary.sourceSkippedSpecialFiles += 1;
      return;
    }
    if (stats.isDirectory()) {
      await fs.mkdir(destinationPath, { recursive: true, mode: 0o700 });
      const entries = await fs.readdir(sourcePath);
      for (const name of entries.sort()) {
        await copyEntry(path.join(sourcePath, name), path.join(destinationPath, name));
      }
      return;
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    await fs.copyFile(sourcePath, destinationPath);
    await fs.chmod(destinationPath, 0o600);
    await syncFile(destinationPath);
    const destinationStats = await fs.stat(destinationPath);
    const relativePath = path.relative(source, sourcePath).split(path.sep).join('/');
    const fileSha256 = await sha256File(destinationPath);
    treeHash.update(`${relativePath}\0${destinationStats.size}\0${fileSha256}\n`);
    summary.files += 1;
    summary.bytes += destinationStats.size;
  }

  await copyEntry(source, destination);
  summary.sha256 = treeHash.digest('hex');
  return summary;
}

async function summarizeSnapshotTree(source) {
  const summary = {
    files: 0,
    bytes: 0,
    skippedSpecialFiles: 0,
    sha256: crypto.createHash('sha256').digest('hex'),
  };
  if (!(await pathExists(source))) return summary;
  const treeHash = crypto.createHash('sha256');

  async function inspectEntry(entryPath) {
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
      summary.skippedSpecialFiles += 1;
      return;
    }
    if (stats.isDirectory()) {
      const entries = await fs.readdir(entryPath);
      for (const name of entries.sort()) await inspectEntry(path.join(entryPath, name));
      return;
    }
    const relativePath = path.relative(source, entryPath).split(path.sep).join('/');
    const fileSha256 = await sha256File(entryPath);
    treeHash.update(`${relativePath}\0${stats.size}\0${fileSha256}\n`);
    summary.files += 1;
    summary.bytes += stats.size;
  }

  await inspectEntry(source);
  summary.sha256 = treeHash.digest('hex');
  return summary;
}

function backupDirectoryName(date, randomUUID = crypto.randomUUID) {
  const timestamp = date.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
  return `backup-${timestamp}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

async function applyRetention(backupRoot, retention, protectedName = null) {
  const entries = await fs.readdir(backupRoot, { withFileTypes: true });
  const snapshots = entries
    .filter((entry) => entry.isDirectory() && /^backup-\d{8}T\d{6}\d*Z-[a-f0-9]+$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  if (protectedName && snapshots.includes(protectedName)) {
    snapshots.splice(snapshots.indexOf(protectedName), 1);
    snapshots.unshift(protectedName);
  }
  const removed = [];
  for (const name of snapshots.slice(retention)) {
    await fs.rm(path.join(backupRoot, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

async function applyPreSnapshotRetention(backupRoot, retention, { verifySnapshot = null } = {}) {
  const entries = await fs.readdir(backupRoot, { withFileTypes: true });
  const snapshots = entries
    .filter((entry) => entry.isDirectory() && /^backup-\d{8}T\d{6}\d*Z-[a-f0-9]+$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  // Mesmo com retenção 1, nunca apaga o último backup bom antes de concluir
  // seu substituto. Para retenções maiores, abre uma vaga antes da cópia.
  const keepBeforeSnapshot = Math.max(1, retention - 1);
  if (snapshots.length <= keepBeforeSnapshot) return [];
  const invalid = new Set();
  let lastKnownGood = null;
  if (typeof verifySnapshot === 'function') {
    for (const name of snapshots) {
      try {
        await verifySnapshot(path.join(backupRoot, name));
        lastKnownGood = name;
        break;
      } catch {
        invalid.add(name);
      }
    }
    // Sem ao menos um snapshot verificado, nao fazemos limpeza destrutiva
    // antes de concluir o novo backup.
    if (!lastKnownGood) return [];
  } else {
    lastKnownGood = snapshots[0];
  }

  const preserved = new Set([lastKnownGood]);
  for (const name of snapshots) {
    if (preserved.size >= keepBeforeSnapshot) break;
    if (!invalid.has(name)) preserved.add(name);
  }
  const removed = [];
  for (const name of snapshots) {
    if (preserved.has(name)) continue;
    await fs.rm(path.join(backupRoot, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function cleanupStaleStaging(backupRoot, { createdAt, staleAfterMs }) {
  const entries = await fs.readdir(backupRoot, { withFileTypes: true });
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\.backup-\d{8}T\d{6}\d*Z-[a-f0-9]+\.tmp$/i.test(entry.name)) continue;
    const target = path.join(backupRoot, entry.name);
    const stats = await fs.stat(target);
    if (createdAt.getTime() - stats.mtimeMs <= staleAfterMs) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

async function acquireBackupLock(lockPath, { createdAt, staleAfterMs }) {
  try {
    return await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  let stats;
  try {
    stats = await fs.stat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return fs.open(lockPath, 'wx', 0o600);
    throw error;
  }
  if (createdAt.getTime() - stats.mtimeMs <= staleAfterMs) {
    throw new Error('Outro backup já está em andamento');
  }

  await fs.rm(lockPath, { force: true });
  try {
    return await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Outro backup já está em andamento');
    throw error;
  }
}

function startBackupLockHeartbeat(lock, lockPath, staleAfterMs) {
  let failure = null;
  let pending = null;
  const intervalMs = Math.max(50, Math.min(60_000, Math.floor(staleAfterMs / 3)));
  const timer = setInterval(() => {
    if (pending || failure) return;
    pending = (async () => {
      try {
        const [heldStats, pathStats] = await Promise.all([lock.stat(), fs.lstat(lockPath)]);
        if (heldStats.dev !== pathStats.dev || heldStats.ino !== pathStats.ino) {
          throw new Error('Lock de backup foi substituido durante a execucao');
        }
        const now = new Date();
        await lock.utimes(now, now);
      } catch (error) {
        failure = error;
      }
    })().finally(() => {
      pending = null;
    });
  }, intervalMs);
  timer.unref?.();
  return {
    assertHealthy() {
      if (failure) throw failure;
    },
    async stop() {
      clearInterval(timer);
      await pending;
    },
  };
}

async function releaseBackupLock(lock, lockPath) {
  try {
    const [heldStats, pathStats] = await Promise.all([lock.stat(), fs.lstat(lockPath)]);
    if (heldStats.dev === pathStats.dev && heldStats.ino === pathStats.ino) {
      await fs.rm(lockPath, { force: true });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  } finally {
    await lock.close().catch(() => {});
  }
}

function inspectRuntimeLeases(masterPath, { referenceTimeMs = null } = {}) {
  if (!require('fs').existsSync(masterPath)) {
    return { masterPresent: false, tablePresent: false, live: false, liveCount: 0, checkedAtMs: null };
  }
  const database = new Database(masterPath, { readonly: true, fileMustExist: true });
  try {
    const tablePresent = Boolean(
      database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_leases'").get(),
    );
    if (!tablePresent) {
      return { masterPresent: true, tablePresent: false, live: false, liveCount: 0, checkedAtMs: null };
    }
    const checkedAtMs =
      referenceTimeMs === null
        ? Number(
            database.prepare("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms").get()
              .now_ms,
          )
        : Number(referenceTimeMs);
    const liveCount = Number(
      database.prepare('SELECT COUNT(*) AS count FROM runtime_leases WHERE expires_at_ms > ?').get(checkedAtMs).count,
    );
    return {
      masterPresent: true,
      tablePresent: true,
      live: liveCount > 0,
      liveCount,
      checkedAtMs,
    };
  } finally {
    database.close();
  }
}

async function regularTreeBytes(directory) {
  if (!(await pathExists(directory))) return 0;
  let bytes = 0;
  async function inspect(entryPath) {
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) return;
    if (stats.isFile()) {
      bytes += stats.size;
      return;
    }
    const entries = await fs.readdir(entryPath);
    for (const name of entries) await inspect(path.join(entryPath, name));
  }
  await inspect(directory);
  return bytes;
}

async function estimateSnapshotBytes(sourceRoot, databaseFiles) {
  let bytes = 0;
  for (const filename of databaseFiles) {
    bytes += (await fs.stat(filename)).size;
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${filename}${suffix}`;
      if (await pathExists(sidecar)) bytes += (await fs.stat(sidecar)).size;
    }
  }
  bytes += await regularTreeBytes(path.join(sourceRoot, 'media'));
  bytes += await regularTreeBytes(path.join(sourceRoot, '.wwebjs_auth'));
  return bytes;
}

async function availableFilesystemBytes(directory) {
  const stats = await fs.statfs(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function createBackup({
  rootDir = process.cwd(),
  backupRoot = process.env.BACKUP_DIR || path.join(rootDir, 'backups'),
  retention = positiveInteger(process.env.BACKUP_RETENTION, DEFAULT_RETENTION),
  lockStaleMs = positiveInteger(process.env.BACKUP_LOCK_STALE_MS, DEFAULT_LOCK_STALE_MS),
  now = () => new Date(),
  randomUUID = crypto.randomUUID,
  logger = console,
  quiesced = process.env.BACKUP_QUIESCED,
  requireQuiesced = process.env.BACKUP_REQUIRE_QUIESCED,
  requireNoLiveLease = process.env.BACKUP_REQUIRE_NO_LIVE_LEASE,
  requireGlobalConsistency = process.env.BACKUP_REQUIRE_GLOBAL_CONSISTENCY,
  freeMarginMb = process.env.BACKUP_FREE_MARGIN_MB,
  getAvailableBytes = availableFilesystemBytes,
} = {}) {
  const sourceRoot = path.resolve(rootDir);
  const destinationRoot = path.resolve(backupRoot);
  const keep = positiveInteger(retention, DEFAULT_RETENTION);
  const staleAfterMs = positiveInteger(lockStaleMs, DEFAULT_LOCK_STALE_MS);
  const isQuiesced = booleanOption(quiesced, false);
  const mustBeQuiesced = booleanOption(requireQuiesced, false);
  const mustHaveNoLiveLease = booleanOption(requireNoLiveLease, false);
  const mustHaveGlobalConsistency = booleanOption(requireGlobalConsistency, false);
  const marginBytes = nonNegativeInteger(freeMarginMb, DEFAULT_FREE_MARGIN_MB) * 1024 * 1024;
  if ((mustBeQuiesced || mustHaveNoLiveLease) && !isQuiesced) {
    throw new Error('Backup estrito exige BACKUP_QUIESCED=true apos parada graciosa do runtime');
  }
  const protectedSources = [
    sourceRoot,
    path.join(sourceRoot, 'data'),
    path.join(sourceRoot, 'media'),
    path.join(sourceRoot, '.wwebjs_auth'),
  ];
  if (
    destinationRoot === sourceRoot ||
    protectedSources
      .slice(1)
      .some((directory) => destinationRoot === directory || isWithin(directory, destinationRoot)) ||
    isWithin(destinationRoot, sourceRoot)
  ) {
    throw new Error('BACKUP_DIR deve ficar fora de data/, media/ e .wwebjs_auth/');
  }
  await fs.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  await assertPlainDirectory(destinationRoot, 'BACKUP_DIR', { optional: false });
  await fs.chmod(destinationRoot, 0o700);

  const lockPath = path.join(destinationRoot, '.backup.lock');
  const createdAt = now();
  const backupName = backupDirectoryName(createdAt, randomUUID);
  const stagingPath = path.join(destinationRoot, `.${backupName}.tmp`);
  const finalPath = path.join(destinationRoot, backupName);
  const lock = await acquireBackupLock(lockPath, { createdAt, staleAfterMs });
  let lockHeartbeat = null;
  let removedStaging = [];
  let removedBefore = [];

  try {
    removedStaging = await cleanupStaleStaging(destinationRoot, { createdAt, staleAfterMs });
    await lock.writeFile(
      `${JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: createdAt.toISOString(),
      })}\n`,
    );
    await syncFile(lockPath);
    lockHeartbeat = startBackupLockHeartbeat(lock, lockPath, staleAfterMs);
    await fs.mkdir(stagingPath, { mode: 0o700 });

    await assertPlainDirectory(path.join(sourceRoot, 'data'), 'data/', { optional: true });
    await assertPlainDirectory(path.join(sourceRoot, 'media'), 'media/', { optional: true });
    await assertPlainDirectory(path.join(sourceRoot, '.wwebjs_auth'), '.wwebjs_auth/', { optional: true });
    await validateWhatsappAuthTree(path.join(sourceRoot, '.wwebjs_auth'));
    const databaseFiles = await listDatabaseFiles(sourceRoot);
    const leaseBefore = inspectRuntimeLeases(path.join(sourceRoot, 'data', 'master.db'));
    if (mustHaveNoLiveLease && leaseBefore.live) {
      throw new Error('Backup quiescente recusado: existe runtime lease vivo no master.db');
    }
    if (mustHaveGlobalConsistency) {
      const sourceAudit = auditGlobalIntegrity({
        rootDir: sourceRoot,
        requireApplicationLayout: true,
        allowFirstInstall: true,
        strictOrphanDatabases: true,
      });
      if (!sourceAudit.ok) {
        throw new Error(`Fonte global inconsistente: ${sourceAudit.errors[0]}`);
      }
    }
    removedBefore = await applyPreSnapshotRetention(destinationRoot, keep, {
      verifySnapshot: async (snapshotPath) => {
        // Import tardio evita um ciclo de inicializacao: verify-backup reutiliza
        // as funcoes de hash deste modulo.
        const { verifyBackup } = require('./verify-backup');
        await verifyBackup(snapshotPath);
      },
    });
    const estimatedBytes = await estimateSnapshotBytes(sourceRoot, databaseFiles);
    const availableBytes = Number(await getAvailableBytes(destinationRoot));
    if (!Number.isFinite(availableBytes) || availableBytes < estimatedBytes + marginBytes) {
      throw new Error(
        `Espaco insuficiente no destino: necessario ${estimatedBytes + marginBytes} bytes, disponivel ${availableBytes} bytes`,
      );
    }
    const databases = [];
    for (const source of databaseFiles) {
      const relativePath = path.relative(sourceRoot, source);
      const destination = path.join(stagingPath, relativePath);
      const details = await backupDatabase(source, destination);
      databases.push({ path: relativePath, ...details });
    }

    const media = await copySnapshotTree(path.join(sourceRoot, 'media'), path.join(stagingPath, 'media'));
    if (media.sourceSkippedSpecialFiles > 0) {
      throw new Error('media/ contém links simbólicos ou arquivos especiais e não pode ser copiado com segurança');
    }
    const whatsappAuth = await copySnapshotTree(
      path.join(sourceRoot, '.wwebjs_auth'),
      path.join(stagingPath, '.wwebjs_auth'),
    );

    const leaseAfter = inspectRuntimeLeases(path.join(sourceRoot, 'data', 'master.db'));
    if (mustHaveNoLiveLease && leaseAfter.live) {
      throw new Error('Backup quiescente recusado: runtime lease ficou vivo durante a copia');
    }
    const globalAudit = auditGlobalIntegrity({
      rootDir: stagingPath,
      requireApplicationLayout: mustHaveGlobalConsistency,
      allowFirstInstall: true,
      strictOrphanDatabases: true,
    });
    if (!globalAudit.ok) {
      throw new Error(`Snapshot global inconsistente: ${globalAudit.errors[0]}`);
    }
    const relationalIntegrity = globalAudit.firstInstall
      ? 'first-install'
      : globalAudit.applicable
        ? 'ok'
        : 'not-applicable';

    const manifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      backupId: backupName,
      createdAt: createdAt.toISOString(),
      consistency: {
        databases: 'better-sqlite3 online backup API',
        assets: isQuiesced ? 'quiesced file-tree snapshot' : 'file-by-file snapshot',
        global: {
          mode: isQuiesced ? 'single-node-quiesced' : 'independent-online-snapshots',
          quiesced: isQuiesced,
          noLiveRuntimeLease: !leaseBefore.live && !leaseAfter.live,
          runtimeLeaseTablePresent: leaseBefore.tablePresent || leaseAfter.tablePresent,
          runtimeLeaseChecks: 2,
          relationalIntegrity,
          checks: [
            'master-tenants-to-data_N',
            'user-directory-to-accounts',
            'support-ownership',
            'media-references-and-prefixes',
          ],
          summary: globalAudit.summary,
        },
      },
      databases,
      assets: { media, whatsappAuth },
      retention: { keep },
      capacity: {
        estimatedSnapshotBytes: estimatedBytes,
        freeMarginBytes: marginBytes,
      },
      excluded: ['.env', '.env.*', '.wwebjs_cache', 'database WAL/SHM sidecars'],
    };
    const manifestPath = path.join(stagingPath, 'manifest.json');
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await syncFile(manifestPath);
    // fsync dos arquivos não torna duráveis as entradas de diretório. Só
    // publique o snapshot depois de persistir toda a árvore e, após o rename,
    // persista também a entrada criada no diretório de backups.
    await syncDirectoryTree(stagingPath);
    lockHeartbeat.assertHealthy();
    await fs.rename(stagingPath, finalPath);
    await syncDirectory(destinationRoot);
    const removedAfter = await applyRetention(destinationRoot, keep, backupName);
    await syncDirectory(destinationRoot);
    const removed = [...new Set([...removedBefore, ...removedAfter])];

    logger?.info?.(
      {
        backup: backupName,
        databases: databases.length,
        removed: removed.length,
        removedStaging: removedStaging.length,
      },
      'Backup concluído',
    );
    return { path: finalPath, manifest, removed, removedStaging };
  } catch (error) {
    await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await lockHeartbeat?.stop();
    await releaseBackupLock(lock, lockPath).catch(() => {});
  }
}

if (require.main === module) {
  createBackup({
    rootDir: process.env.BACKUP_SOURCE_ROOT || process.cwd(),
    logger: null,
  })
    .then(({ path: backupPath, manifest }) => {
      process.stdout.write(`Backup criado: ${path.basename(backupPath)} (${manifest.databases.length} bancos)\n`);
    })
    .catch((error) => {
      process.stderr.write(`Falha no backup: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  applyRetention,
  applyPreSnapshotRetention,
  assertPlainDirectory,
  availableFilesystemBytes,
  backupDatabase,
  booleanOption,
  cleanupStaleStaging,
  copySnapshotTree,
  createBackup,
  estimateSnapshotBytes,
  inspectRuntimeLeases,
  listDatabaseFiles,
  sha256File,
  syncDirectory,
  syncDirectoryTree,
  syncFile,
  summarizeSnapshotTree,
  validateWhatsappAuthTree,
};
