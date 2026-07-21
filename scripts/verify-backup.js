'use strict';

const fs = require('fs/promises');
const path = require('path');
const Database = require('better-sqlite3');
const { inspectRuntimeLeases, listDatabaseFiles, sha256File, summarizeSnapshotTree } = require('./backup');
const { auditGlobalIntegrity } = require('./global-integrity');

function safeSnapshotPath(snapshotRoot, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`Caminho inválido no manifesto: ${relativePath}`);
  const resolved = path.resolve(snapshotRoot, relativePath);
  const prefix = `${snapshotRoot}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error(`Caminho fora do snapshot: ${relativePath}`);
  return resolved;
}

function verifySqliteIntegrity(filename) {
  const database = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const result = database.pragma('integrity_check');
    if (result.length !== 1 || result[0].integrity_check !== 'ok') {
      throw new Error(`integrity_check falhou: ${filename}`);
    }
    const foreignKeyViolations = database.pragma('foreign_key_check');
    if (foreignKeyViolations.length > 0) {
      throw new Error(`foreign_key_check falhou: ${filename} (${foreignKeyViolations.length} violacao(oes))`);
    }
  } finally {
    database.close();
  }
}

async function verifyDatabaseSidecars(filename, { strict }) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${filename}${suffix}`;
    let stats;
    try {
      stats = await fs.lstat(sidecar);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('Snapshot contem sidecar SQLite de tipo invalido');
    }
    if (strict) throw new Error('Snapshot contem sidecar SQLite nao manifestado');
    // Backups formato 2 antigos abriam o snapshot em WAL durante o proprio
    // integrity_check, deixando WAL/journal vazios e um indice SHM de 32 KiB.
    // Eles nao carregam paginas de dados e podem ser ignorados com seguranca.
    const safeLegacySidecar = suffix === '-shm' ? stats.size === 0 || stats.size === 32 * 1024 : stats.size === 0;
    if (!safeLegacySidecar) {
      throw new Error('Backup legado contem sidecar SQLite com dados nao manifestados');
    }
  }
}

async function verifyAssetTree(snapshotRoot, directory, expected) {
  if (!expected || typeof expected !== 'object') throw new Error(`Resumo ausente para ${directory}`);
  const actual = await summarizeSnapshotTree(path.join(snapshotRoot, directory));
  for (const field of ['files', 'bytes', 'skippedSpecialFiles', 'sha256']) {
    if (actual[field] !== expected[field]) throw new Error(`Verificação de ${directory} falhou no campo ${field}`);
  }
  if (actual.skippedSpecialFiles !== 0) throw new Error(`${directory} contém arquivos especiais ou links simbólicos`);
  return actual;
}

async function verifyBackup(snapshotPath) {
  const snapshotRoot = path.resolve(snapshotPath);
  const manifestPath = path.join(snapshotRoot, 'manifest.json');
  const manifestStats = await fs.lstat(manifestPath);
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || manifestStats.size > 10 * 1024 * 1024) {
    throw new Error('manifest.json inválido ou grande demais');
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.formatVersion !== 2) {
    throw new Error(`Formato de backup não suportado: ${manifest.formatVersion}`);
  }
  if (manifest.backupId !== path.basename(snapshotRoot)) {
    throw new Error('backupId do manifesto não corresponde ao diretório');
  }
  if (!Array.isArray(manifest.databases)) throw new Error('Lista de bancos SQLite ausente no manifesto');
  if (!Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('createdAt invalido no manifesto');

  const expectedDatabasePaths = new Set();
  const hasGlobalDeclaration = manifest.consistency?.global !== undefined;
  for (const database of manifest.databases) {
    const filename = safeSnapshotPath(snapshotRoot, database.path);
    const normalizedPath = path.relative(snapshotRoot, filename).split(path.sep).join('/');
    if (expectedDatabasePaths.has(normalizedPath)) throw new Error(`Banco duplicado no manifesto: ${database.path}`);
    expectedDatabasePaths.add(normalizedPath);
    const stats = await fs.lstat(filename);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== database.bytes) {
      throw new Error(`Tamanho ou tipo inválido: ${database.path}`);
    }
    const realFilename = await fs.realpath(filename);
    const realSnapshotRoot = await fs.realpath(snapshotRoot);
    if (!realFilename.startsWith(`${realSnapshotRoot}${path.sep}`)) {
      throw new Error(`Banco resolve para fora do snapshot: ${database.path}`);
    }
    if ((await sha256File(filename)) !== database.sha256) throw new Error(`SHA-256 inválido: ${database.path}`);
    await verifyDatabaseSidecars(filename, { strict: hasGlobalDeclaration });
    verifySqliteIntegrity(filename);
  }

  const actualDatabasePaths = new Set(
    (await listDatabaseFiles(snapshotRoot)).map((filename) =>
      path.relative(snapshotRoot, filename).split(path.sep).join('/'),
    ),
  );
  if (
    actualDatabasePaths.size !== expectedDatabasePaths.size ||
    [...actualDatabasePaths].some((filename) => !expectedDatabasePaths.has(filename))
  ) {
    throw new Error('Conjunto de bancos SQLite diverge do manifesto');
  }

  await verifyAssetTree(snapshotRoot, 'media', manifest.assets?.media);
  await verifyAssetTree(snapshotRoot, '.wwebjs_auth', manifest.assets?.whatsappAuth);

  const globalAudit = auditGlobalIntegrity({
    rootDir: snapshotRoot,
    requireApplicationLayout: false,
    allowFirstInstall: true,
    strictOrphanDatabases: hasGlobalDeclaration ? true : 'nonempty',
  });
  if (!globalAudit.ok) {
    throw new Error(`Consistencia relacional global falhou: ${globalAudit.errors[0]}`);
  }
  const actualRelationalIntegrity = globalAudit.firstInstall
    ? 'first-install'
    : globalAudit.applicable
      ? 'ok'
      : 'not-applicable';
  const declaredGlobal = manifest.consistency?.global;
  if (declaredGlobal !== undefined) {
    if (!declaredGlobal || typeof declaredGlobal !== 'object') {
      throw new Error('Declaracao de consistencia global invalida');
    }
    if (declaredGlobal.relationalIntegrity !== actualRelationalIntegrity) {
      throw new Error('Declaracao relacional do manifesto diverge do snapshot');
    }
    if (!declaredGlobal.summary || typeof declaredGlobal.summary !== 'object') {
      throw new Error('Resumo da consistencia global ausente no manifesto');
    }
    for (const [field, value] of Object.entries(globalAudit.summary)) {
      if (declaredGlobal.summary[field] !== value) {
        throw new Error(`Resumo global diverge no campo ${field}`);
      }
    }
    const requiredChecks = [
      'master-tenants-to-data_N',
      'user-directory-to-accounts',
      'support-ownership',
      'media-references-and-prefixes',
    ];
    if (
      !Array.isArray(declaredGlobal.checks) ||
      requiredChecks.some((check) => !declaredGlobal.checks.includes(check))
    ) {
      throw new Error('Manifesto nao declara todas as validacoes relacionais globais');
    }
    if (declaredGlobal.quiesced === true) {
      if (
        declaredGlobal.mode !== 'single-node-quiesced' ||
        declaredGlobal.noLiveRuntimeLease !== true ||
        declaredGlobal.runtimeLeaseChecks !== 2
      ) {
        throw new Error('Manifesto nao comprova a janela quiescente de producao');
      }
      const createdAtMs = Date.parse(manifest.createdAt);
      if (!Number.isFinite(createdAtMs)) throw new Error('createdAt invalido no manifesto');
      const leaseState = inspectRuntimeLeases(path.join(snapshotRoot, 'data', 'master.db'), {
        referenceTimeMs: createdAtMs,
      });
      if (leaseState.live) {
        throw new Error('Snapshot declarado quiescente contem runtime lease vivo');
      }
    } else if (declaredGlobal.mode === 'single-node-quiesced') {
      throw new Error('Modo quiescente contradiz o campo quiesced do manifesto');
    }
  }
  return {
    backupId: manifest.backupId,
    databases: manifest.databases.length,
    createdAt: manifest.createdAt,
    globalConsistency: actualRelationalIntegrity,
    quiesced: declaredGlobal?.quiesced === true,
  };
}

if (require.main === module) {
  const snapshotPath = process.argv[2];
  if (!snapshotPath) {
    process.stderr.write('Uso: npm run backup:verify -- backups/backup-<timestamp>-<id>\n');
    process.exitCode = 2;
  } else {
    verifyBackup(snapshotPath)
      .then((result) => {
        process.stdout.write(`Backup verificado: ${result.backupId} (${result.databases} bancos)\n`);
      })
      .catch((error) => {
        process.stderr.write(`Backup inválido: ${error.message}\n`);
        process.exitCode = 1;
      });
  }
}

module.exports = { safeSnapshotPath, verifyBackup, verifySqliteIntegrity };
