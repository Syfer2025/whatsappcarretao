'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { auditDirectoryEntries, normalizeUsername } = require('../userDirectoryIntegrity');
const { isTenantMediaFilename } = require('../mediaStorage');

function exists(filename) {
  try {
    fs.accessSync(filename, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function tableExists(database, table) {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function columnExists(database, table, column) {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

function listTenantDatabaseFiles(dataDir) {
  if (!exists(dataDir)) return [];
  return fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^data_[1-9]\d*\.db$/.test(entry.name))
    .map((entry) => ({
      id: Number(entry.name.match(/^data_(\d+)\.db$/)[1]),
      name: entry.name,
      path: path.join(dataDir, entry.name),
    }))
    .sort((left, right) => left.id - right.id);
}

function walkRegularFiles(directory, callback, relativeDirectory = '') {
  if (!exists(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkRegularFiles(filename, callback, relativePath);
    } else if (entry.isFile()) {
      callback(filename, relativePath);
    }
  }
}

function auditDatabase(filename, label, { expectedSchema, errors, summary }) {
  let database;
  try {
    database = new Database(filename, { readonly: true, fileMustExist: true });
    const quickCheck = database.pragma('quick_check');
    if (quickCheck.length !== 1 || quickCheck[0].quick_check !== 'ok') {
      errors.push(`${label}: quick_check falhou`);
    }
    const foreignKeys = database.pragma('foreign_key_check');
    if (foreignKeys.length > 0) {
      errors.push(`${label}: ${foreignKeys.length} violacao(oes) de chave estrangeira`);
    }
    if (expectedSchema !== null && expectedSchema !== undefined) {
      const version = database.pragma('user_version', { simple: true });
      if (version !== expectedSchema) {
        errors.push(`${label}: schema ${version}, esperado ${expectedSchema}`);
      }
    }
    summary.databasesChecked += 1;
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Mantem a causa original da falha de leitura.
    }
    errors.push(`${label}: ${error.message}`);
    return null;
  }
}

function sha256FileSync(filename) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function mediaReferenceFilename({
  mediaUrl,
  expectedBasePath,
  tenantId,
  label,
  mediaDir,
  errors,
  expectedBytes = null,
  expectedSha256 = null,
  hashCache = null,
}) {
  const rawUrl = String(mediaUrl || '');
  const prefix = `${expectedBasePath}/`;
  if (!rawUrl.startsWith(prefix)) {
    errors.push(`${label}: URL de midia fora do namespace privado`);
    return null;
  }
  const filename = rawUrl.slice(prefix.length);
  if (!filename || filename.includes('/') || filename.includes('\\')) {
    errors.push(`${label}: caminho de midia invalido`);
    return null;
  }
  if (!isTenantMediaFilename(filename, tenantId)) {
    errors.push(`${label}: arquivo de midia pertence a outro namespace`);
    return null;
  }
  const mediaPath = path.join(mediaDir, filename);
  if (!exists(mediaPath) || !fs.statSync(mediaPath).isFile()) {
    errors.push(`${label}: arquivo de midia referenciado esta ausente`);
    return filename;
  }
  const stats = fs.statSync(mediaPath);
  if (expectedBytes !== null && expectedBytes !== undefined && expectedBytes !== '') {
    const bytes = Number(expectedBytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      errors.push(`${label}: tamanho de midia invalido no banco`);
    } else if (stats.size !== bytes) {
      errors.push(`${label}: tamanho do arquivo de midia diverge do banco (${filename})`);
    }
  }
  if (expectedSha256 !== null && expectedSha256 !== undefined && expectedSha256 !== '') {
    const declaredHash = String(expectedSha256).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(declaredHash)) {
      errors.push(`${label}: SHA-256 de midia invalido no banco`);
    } else {
      let actualHash = hashCache?.get(mediaPath);
      if (!actualHash) {
        actualHash = sha256FileSync(mediaPath);
        hashCache?.set(mediaPath, actualHash);
      }
      if (actualHash !== declaredHash) {
        errors.push(`${label}: SHA-256 do arquivo de midia diverge do banco (${filename})`);
      }
    }
  }
  return filename;
}

function auditGlobalIntegrity({
  rootDir = process.cwd(),
  dataDir = path.join(rootDir, 'data'),
  mediaDir = path.join(rootDir, 'media'),
  authDir = path.join(rootDir, '.wwebjs_auth'),
  expectedSchema = null,
  requireApplicationLayout = false,
  allowFirstInstall = true,
  strictOrphanDatabases = true,
} = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedData = path.resolve(dataDir);
  const resolvedMedia = path.resolve(mediaDir);
  const resolvedAuth = path.resolve(authDir);
  const errors = [];
  const warnings = [];
  const summary = {
    databasesChecked: 0,
    tenantsChecked: 0,
    directoryEntriesChecked: 0,
    accountIdentitiesChecked: 0,
    supportThreadsChecked: 0,
    supportMessagesChecked: 0,
    mediaReferencesChecked: 0,
    mediaFilesChecked: 0,
    whatsappAuthTenantsChecked: 0,
    orphanDatabases: 0,
  };
  const masterPath = path.join(resolvedData, 'master.db');
  const platformPath = path.join(resolvedData, 'data.db');
  const tenantDatabaseFiles = listTenantDatabaseFiles(resolvedData);

  if (!exists(resolvedData)) {
    if (allowFirstInstall) {
      return {
        ok: true,
        applicable: true,
        firstInstall: true,
        rootDir: resolvedRoot,
        summary,
        warnings,
        errors,
      };
    }
    errors.push('diretorio data ausente');
  }

  if (!exists(masterPath)) {
    const emptyInstall = tenantDatabaseFiles.length === 0 && !exists(platformPath);
    if (emptyInstall && allowFirstInstall) {
      return {
        ok: true,
        applicable: true,
        firstInstall: true,
        rootDir: resolvedRoot,
        summary,
        warnings,
        errors,
      };
    }
    errors.push('master.db ausente');
    return {
      ok: false,
      applicable: true,
      firstInstall: false,
      rootDir: resolvedRoot,
      summary,
      warnings,
      errors,
    };
  }

  const master = auditDatabase(masterPath, 'master.db', {
    expectedSchema: null,
    errors,
    summary,
  });
  if (!master) {
    return {
      ok: false,
      applicable: true,
      firstInstall: false,
      rootDir: resolvedRoot,
      summary,
      warnings,
      errors,
    };
  }

  if (!tableExists(master, 'tenants')) {
    master.close();
    if (requireApplicationLayout) {
      errors.push('master.db nao contem a tabela tenants da aplicacao');
    } else {
      warnings.push('snapshot SQLite generico: validacao relacional da aplicacao nao se aplica');
    }
    return {
      ok: errors.length === 0,
      applicable: false,
      firstInstall: false,
      rootDir: resolvedRoot,
      summary,
      warnings,
      errors,
    };
  }

  let platform;
  try {
    if (!exists(platformPath)) {
      errors.push('data.db da plataforma ausente');
    } else {
      platform = auditDatabase(platformPath, 'data.db', {
        expectedSchema,
        errors,
        summary,
      });
    }

    const tenants = master.prepare('SELECT id, slug FROM tenants ORDER BY id').all();
    const tenantIds = new Set(tenants.map((tenant) => Number(tenant.id)));
    const accounts = [];
    const mediaOwners = new Map();
    const mediaHashCache = new Map();

    for (const tenant of tenants) {
      const tenantId = Number(tenant.id);
      if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
        errors.push('master.db contem tenant com identificador invalido');
        continue;
      }
      const tenantPath = path.join(resolvedData, `data_${tenantId}.db`);
      if (!exists(tenantPath)) {
        errors.push(`tenant ${tenantId}: banco data_${tenantId}.db ausente`);
        continue;
      }
      const tenantDb = auditDatabase(tenantPath, `tenant ${tenantId}`, {
        expectedSchema,
        errors,
        summary,
      });
      if (!tenantDb) continue;
      summary.tenantsChecked += 1;
      try {
        for (const requiredTable of ['admins', 'vendors', 'messages']) {
          if (!tableExists(tenantDb, requiredTable)) {
            errors.push(`tenant ${tenantId}: tabela ${requiredTable} ausente`);
          }
        }
        if (!tableExists(tenantDb, 'admins') || !tableExists(tenantDb, 'vendors')) continue;
        const tenantAdmins = tenantDb.prepare('SELECT username FROM admins').all();
        if (String(tenant.slug || '') !== 'default' && tenantAdmins.length === 0) {
          errors.push(`tenant ${tenantId}: empresa sem administrador`);
        }
        for (const row of tenantAdmins) {
          accounts.push({ username: normalizeUsername(row.username), tenantId, role: 'admin' });
        }
        for (const row of tenantDb.prepare('SELECT username FROM vendors').all()) {
          accounts.push({ username: normalizeUsername(row.username), tenantId, role: 'vendor' });
        }
        if (!tableExists(tenantDb, 'messages')) continue;
        for (const row of tenantDb
          .prepare("SELECT DISTINCT media_url, media_size, media_sha256 FROM messages WHERE media_url IS NOT NULL AND media_url <> ''")
          .all()) {
          summary.mediaReferencesChecked += 1;
          const filename = mediaReferenceFilename({
            mediaUrl: row.media_url,
            expectedBasePath: '/media',
            tenantId,
            label: `tenant ${tenantId}`,
            mediaDir: resolvedMedia,
            errors,
            expectedBytes: row.media_size,
            expectedSha256: row.media_sha256,
            hashCache: mediaHashCache,
          });
          if (!filename) continue;
          const owners = mediaOwners.get(filename) || new Set();
          owners.add(tenantId);
          mediaOwners.set(filename, owners);
        }
      } catch (error) {
        errors.push(`tenant ${tenantId}: falha na validacao relacional (${error.message})`);
      } finally {
        tenantDb.close();
      }
    }

    for (const tenantDatabase of tenantDatabaseFiles) {
      if (tenantIds.has(tenantDatabase.id)) continue;
      summary.orphanDatabases += 1;
      if (strictOrphanDatabases) {
        if (strictOrphanDatabases === 'nonempty') {
          let orphan;
          try {
            orphan = new Database(tenantDatabase.path, { readonly: true, fileMustExist: true });
            let rowCount = 0;
            for (const table of ['admins', 'vendors', 'sectors', 'conversations', 'messages']) {
              if (tableExists(orphan, table)) {
                rowCount += Number(orphan.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
              }
            }
            if (rowCount > 0) {
              errors.push(`${tenantDatabase.name}: banco orfao contem ${rowCount} registro(s)`);
            } else {
              warnings.push(`${tenantDatabase.name}: banco orfao vazio`);
            }
          } catch (error) {
            errors.push(`${tenantDatabase.name}: falha ao inspecionar banco orfao (${error.message})`);
          } finally {
            orphan?.close();
          }
        } else {
          errors.push(`${tenantDatabase.name}: banco sem tenant correspondente no master.db`);
        }
      } else {
        warnings.push(`${tenantDatabase.name}: banco sem tenant correspondente no master.db`);
      }
    }

    for (const [filename, owners] of mediaOwners) {
      if (owners.size > 1) errors.push(`midia compartilhada por tenants distintos: ${filename}`);
    }

    let platformUsernames = [];
    if (platform && tableExists(platform, 'admins')) {
      const superAdminFilter = columnExists(platform, 'admins', 'super_admin')
        ? 'WHERE coalesce(super_admin, 0) = 1'
        : '';
      platformUsernames = platform
        .prepare(`SELECT username FROM admins ${superAdminFilter}`)
        .all()
        .map((row) => normalizeUsername(row.username))
        .filter(Boolean);
    } else if (platform) {
      errors.push('data.db da plataforma: tabela admins ausente');
    }

    if (!tableExists(master, 'user_directory')) {
      errors.push('master.db: tabela user_directory ausente');
    } else {
      const directoryEntries = master
        .prepare('SELECT username, tenant_id, role FROM user_directory')
        .all();
      summary.directoryEntriesChecked = directoryEntries.length;
      summary.accountIdentitiesChecked = accounts.length;
      errors.push(
        ...auditDirectoryEntries({
          accounts,
          directoryEntries,
          tenantIds,
          platformUsernames,
        }),
      );
    }

    const hasSupportThreads = tableExists(master, 'support_threads');
    const hasSupportMessages = tableExists(master, 'support_messages');
    if (!hasSupportThreads || !hasSupportMessages) {
      errors.push('master.db: tabelas de suporte incompletas');
    } else {
      const threadRows = master.prepare(`
        SELECT st.id, st.tenant_id, t.id AS existing_tenant_id
        FROM support_threads st
        LEFT JOIN tenants t ON t.id = st.tenant_id
      `).all();
      summary.supportThreadsChecked = threadRows.length;
      for (const row of threadRows) {
        if (row.existing_tenant_id === null) {
          errors.push(`suporte: conversa ${row.id} aponta para tenant inexistente`);
        }
      }

      const messageRows = master.prepare(`
        SELECT sm.id, sm.tenant_id, sm.thread_id, sm.media_url,
               st.tenant_id AS thread_tenant_id
        FROM support_messages sm
        LEFT JOIN support_threads st ON st.id = sm.thread_id
      `).all();
      summary.supportMessagesChecked = messageRows.length;
      for (const row of messageRows) {
        const tenantId = Number(row.tenant_id);
        if (row.thread_tenant_id === null) {
          errors.push(`suporte: mensagem ${row.id} aponta para conversa inexistente`);
        } else if (tenantId !== Number(row.thread_tenant_id)) {
          errors.push(`suporte: mensagem ${row.id} pertence a tenant diferente da conversa`);
        }
        if (row.media_url === null || row.media_url === '') continue;
        summary.mediaReferencesChecked += 1;
        mediaReferenceFilename({
          mediaUrl: row.media_url,
          expectedBasePath: '/support-media',
          tenantId,
          label: `suporte do tenant ${tenantId}`,
          mediaDir: resolvedMedia,
          errors,
        });
      }
    }

    walkRegularFiles(resolvedMedia, (_filename, relativePath) => {
      summary.mediaFilesChecked += 1;
      if (relativePath.includes(path.sep)) {
        errors.push(`media: arquivo fora da raiz plana (${relativePath})`);
        return;
      }
      const match = /^t([1-9]\d*)-/.exec(relativePath);
      if (!match) {
        errors.push(`media: arquivo sem prefixo de tenant (${relativePath})`);
        return;
      }
      const ownerId = Number(match[1]);
      if (!tenantIds.has(ownerId) || !isTenantMediaFilename(relativePath, ownerId)) {
        errors.push(`media: arquivo com tenant inexistente ou prefixo invalido (${relativePath})`);
      }
    });

    if (exists(resolvedAuth)) {
      for (const entry of fs.readdirSync(resolvedAuth, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const match = /^tenant_([1-9]\d*)$/.exec(entry.name);
        if (!match) {
          errors.push(`WhatsApp auth: diretorio de sessao invalido (${entry.name})`);
          continue;
        }
        summary.whatsappAuthTenantsChecked += 1;
        if (!tenantIds.has(Number(match[1]))) {
          errors.push(`WhatsApp auth: sessao sem tenant correspondente (${entry.name})`);
        }
      }
    }
  } catch (error) {
    errors.push(`master.db: falha na validacao relacional (${error.message})`);
  } finally {
    try {
      platform?.close();
    } catch {
      // O erro de fechamento nao substitui achados de integridade.
    }
    master.close();
  }

  return {
    ok: errors.length === 0,
    applicable: true,
    firstInstall: false,
    rootDir: resolvedRoot,
    summary,
    warnings,
    errors: [...new Set(errors)],
  };
}

module.exports = {
  auditGlobalIntegrity,
  listTenantDatabaseFiles,
  tableExists,
};
