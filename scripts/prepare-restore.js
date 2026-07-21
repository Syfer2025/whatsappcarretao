'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { assertPlainDirectory, copySnapshotTree, syncDirectory, syncDirectoryTree, syncFile } = require('./backup');
const { safeSnapshotPath, verifyBackup } = require('./verify-backup');

function isSameOrWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function exists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

async function copyDeclaredDatabase(snapshotRoot, restoreRoot, relativePath) {
  const source = safeSnapshotPath(snapshotRoot, relativePath);
  const destination = safeSnapshotPath(restoreRoot, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  await fs.chmod(destination, 0o600);
  await syncFile(destination);
}

async function prepareRestore({ snapshotPath, destinationRoot, logger = console } = {}) {
  if (!snapshotPath || !destinationRoot) {
    throw new Error('Snapshot e diretorio de destino sao obrigatorios');
  }
  const snapshotRoot = path.resolve(snapshotPath);
  const restoreParent = path.resolve(destinationRoot);
  if (isSameOrWithin(snapshotRoot, restoreParent) || isSameOrWithin(restoreParent, snapshotRoot)) {
    throw new Error('Destino de restore nao pode conter nem ficar dentro do snapshot de origem');
  }

  // Verifique antes de copiar para nunca materializar um snapshot já conhecido
  // como corrompido. A segunda verificação abaixo cobre a própria transferência.
  const sourceVerification = await verifyBackup(snapshotRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(snapshotRoot, 'manifest.json'), 'utf8'));

  await fs.mkdir(restoreParent, { recursive: true, mode: 0o700 });
  await assertPlainDirectory(restoreParent, 'Diretorio de restore', { optional: false });
  await fs.chmod(restoreParent, 0o700);
  const finalPath = path.join(restoreParent, manifest.backupId);
  if (await exists(finalPath)) {
    throw new Error(`Destino de restore ja existe: ${finalPath}`);
  }

  const stagingParent = path.join(restoreParent, `.restore-${crypto.randomUUID()}.tmp`);
  const stagingPath = path.join(stagingParent, manifest.backupId);
  await fs.mkdir(stagingPath, { recursive: true, mode: 0o700 });

  try {
    for (const database of manifest.databases) {
      await copyDeclaredDatabase(snapshotRoot, stagingPath, database.path);
    }
    await copySnapshotTree(path.join(snapshotRoot, 'media'), path.join(stagingPath, 'media'));
    await copySnapshotTree(path.join(snapshotRoot, '.wwebjs_auth'), path.join(stagingPath, '.wwebjs_auth'));
    const manifestDestination = path.join(stagingPath, 'manifest.json');
    await fs.copyFile(path.join(snapshotRoot, 'manifest.json'), manifestDestination, fs.constants.COPYFILE_EXCL);
    await fs.chmod(manifestDestination, 0o600);
    await syncFile(manifestDestination);
    await syncDirectoryTree(stagingPath);
    await syncDirectory(stagingParent);

    const copiedVerification = await verifyBackup(stagingPath);
    await fs.rename(stagingPath, finalPath);
    await syncDirectory(restoreParent);
    await fs.rm(stagingParent, { recursive: true, force: true });
    await syncDirectory(restoreParent);

    logger?.info?.(
      {
        backupId: copiedVerification.backupId,
        databases: copiedVerification.databases,
        quiesced: copiedVerification.quiesced,
        destination: finalPath,
      },
      'Payload de restore preparado e verificado',
    );
    return { path: finalPath, sourceVerification, verification: copiedVerification };
  } catch (error) {
    await fs.rm(stagingParent, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

if (require.main === module) {
  const [snapshotPath, destinationRoot] = process.argv.slice(2);
  if (!snapshotPath || !destinationRoot || process.argv.length !== 4) {
    process.stderr.write('Uso: npm run restore:prepare -- backups/backup-<timestamp>-<id> /caminho/restore-ready\n');
    process.exitCode = 2;
  } else {
    prepareRestore({ snapshotPath, destinationRoot, logger: null })
      .then((result) => {
        process.stdout.write(
          `Restore preparado: ${result.path} (${result.verification.databases} bancos, quiescente=${result.verification.quiesced})\n`,
        );
      })
      .catch((error) => {
        process.stderr.write(`Falha ao preparar restore: ${error.message}\n`);
        process.exitCode = 1;
      });
  }
}

module.exports = { prepareRestore };
