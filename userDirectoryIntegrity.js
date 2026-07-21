'use strict';

function normalizeUsername(value) {
  // NFKC evita duas chaves de login visualmente equivalentes com bytes
  // diferentes (largura cheia ou forma composta/decomposta, por exemplo).
  return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function describeAccount(account) {
  return `${account.role} do tenant ${account.tenantId}`;
}

function collectTenantAccounts({ tenants, getTenantDb }) {
  const accounts = [];
  for (const tenant of tenants) {
    const tenantId = Number(tenant?.id);
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
      throw new Error('Diretorio de usuarios: tenant invalido');
    }
    let tenantDb;
    try {
      tenantDb = getTenantDb(tenantId);
      for (const row of tenantDb.prepare('SELECT username FROM admins').all()) {
        accounts.push({ username: normalizeUsername(row.username), tenantId, role: 'admin' });
      }
      // Inactive vendors remain identities and must keep a unique directory
      // owner; otherwise reactivation could silently take another account.
      for (const row of tenantDb.prepare('SELECT username FROM vendors').all()) {
        accounts.push({ username: normalizeUsername(row.username), tenantId, role: 'vendor' });
      }
    } catch (error) {
      throw new Error(`Diretorio de usuarios: falha ao ler tenant ${tenantId}: ${error.message}`);
    }
  }
  return accounts;
}

function findIdentityConflicts(accounts, platformUsernames = []) {
  const errors = [];
  const platform = new Set(platformUsernames.map(normalizeUsername).filter(Boolean));
  const owners = new Map();

  for (const account of accounts) {
    const normalizedAccount = { ...account, username: normalizeUsername(account.username) };
    if (!normalizedAccount.username) {
      errors.push(`identidade vazia em ${describeAccount(account)}`);
      continue;
    }
    if (platform.has(normalizedAccount.username)) {
      errors.push(`identidade "${normalizedAccount.username}" colide com super admin da plataforma`);
    }
    const previous = owners.get(normalizedAccount.username);
    if (previous && (
      previous.tenantId !== normalizedAccount.tenantId
      || previous.role !== normalizedAccount.role
    )) {
      errors.push(
        `identidade "${normalizedAccount.username}" pertence simultaneamente a ${describeAccount(previous)} e ${describeAccount(normalizedAccount)}`
      );
    } else if (!previous) {
      owners.set(normalizedAccount.username, normalizedAccount);
    }
  }

  return errors;
}

function auditDirectoryEntries({ accounts, directoryEntries, tenantIds, platformUsernames = [] }) {
  const errors = findIdentityConflicts(accounts, platformUsernames);
  const validTenantIds = new Set([...tenantIds].map(Number));
  const normalizedAccounts = accounts.map(account => ({
    ...account,
    username: normalizeUsername(account.username)
  }));
  const expected = new Map(
    normalizedAccounts.filter(account => account.username).map(account => [account.username, account])
  );
  const actual = new Map();

  for (const entry of directoryEntries) {
    const username = normalizeUsername(entry.username);
    const tenantId = Number(entry.tenant_id ?? entry.tenantId);
    const role = entry.role;
    if (!username) {
      errors.push('diretorio contem username vazio');
      continue;
    }
    if (actual.has(username)) {
      errors.push(`diretorio contem identidade duplicada "${username}"`);
      continue;
    }
    actual.set(username, { username, tenantId, role });
    if (!validTenantIds.has(tenantId)) {
      errors.push(`diretorio: identidade "${username}" aponta para tenant inexistente ${tenantId}`);
      continue;
    }
    if (!['admin', 'vendor'].includes(role)) {
      errors.push(`diretorio: identidade "${username}" possui papel invalido`);
      continue;
    }
    const owner = expected.get(username);
    if (!owner) {
      errors.push(`diretorio: identidade orfa "${username}"`);
      continue;
    }
    if (owner.tenantId !== tenantId || owner.role !== role) {
      errors.push(
        `diretorio: identidade "${username}" aponta para ${role} do tenant ${tenantId}, esperado ${describeAccount(owner)}`
      );
    }
  }

  for (const account of normalizedAccounts) {
    if (!account.username) continue;
    const entry = actual.get(account.username);
    if (!entry) {
      errors.push(`diretorio: ${describeAccount(account)} "${account.username}" nao esta indexado`);
    }
  }

  return [...new Set(errors)];
}

module.exports = {
  normalizeUsername,
  collectTenantAccounts,
  findIdentityConflicts,
  auditDirectoryEntries
};
