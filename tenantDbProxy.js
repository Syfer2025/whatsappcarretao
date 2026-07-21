const CONTEXT_ERROR = 'Contexto de tenant obrigatório para acessar o banco';

function sameTenantContext(owner, current) {
  if (!owner?.db || !current?.db || owner.db !== current.db) return false;
  const ownerTenantId = Number(owner.tenantId);
  const currentTenantId = Number(current.tenantId);
  return Number.isSafeInteger(ownerTenantId)
    && ownerTenantId > 0
    && ownerTenantId === currentTenantId;
}

function assertTenantContext(contextStorage, owner) {
  if (!sameTenantContext(owner, contextStorage.getStore())) {
    throw new Error(CONTEXT_ERROR);
  }
}

function guardIterator(iterator, contextStorage, owner) {
  return new Proxy(iterator, {
    get(target, prop, receiver) {
      assertTenantContext(contextStorage, owner);
      if (prop === Symbol.iterator) {
        return () => {
          assertTenantContext(contextStorage, owner);
          return receiver;
        };
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        assertTenantContext(contextStorage, owner);
        return value.apply(target, args);
      };
    }
  });
}

function guardStatement(statement, contextStorage, owner) {
  return new Proxy(statement, {
    get(target, prop, receiver) {
      assertTenantContext(contextStorage, owner);
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        assertTenantContext(contextStorage, owner);
        const result = value.apply(target, args);
        // Preserve fluent APIs such as statement.safeIntegers().all().
        if (result === target) return receiver;
        if (prop === 'iterate' && result && typeof result.next === 'function') {
          return guardIterator(result, contextStorage, owner);
        }
        return result;
      };
    }
  });
}

function guardTransaction(transaction, contextStorage, owner) {
  const invoke = (...args) => {
    assertTenantContext(contextStorage, owner);
    return transaction(...args);
  };
  for (const mode of ['deferred', 'immediate', 'exclusive']) {
    if (typeof transaction[mode] === 'function') {
      invoke[mode] = (...args) => {
        assertTenantContext(contextStorage, owner);
        return transaction[mode](...args);
      };
    }
  }
  return invoke;
}

function guardDatabaseResult(prop, result, contextStorage, owner) {
  if (prop === 'prepare' && result && typeof result === 'object') {
    return guardStatement(result, contextStorage, owner);
  }
  if (prop === 'transaction' && typeof result === 'function') {
    return guardTransaction(result, contextStorage, owner);
  }
  return result;
}

function createTenantScopedProxy(defaultDatabase, contextStorage) {
  const safeMetaProperties = new Set(['tenantCtx', 'defaultDb', 'createDb', 'createTenantScopedProxy']);
  return new Proxy(defaultDatabase, {
    get(target, prop) {
      // These properties describe the proxy/root database itself. Resolving
      // them against a tenant SQLite handle would turn them into undefined
      // inside AsyncLocalStorage and break tenant propagation.
      if (safeMetaProperties.has(prop) || typeof prop === 'symbol') return target[prop];
      const owner = contextStorage.getStore();
      if (owner?.db) {
        const tenantValue = owner.db[prop];
        if (typeof tenantValue !== 'function') return tenantValue;
        // Never expose a function permanently bound to the tenant that happened
        // to be active while the property was read. Every invocation validates
        // the current AsyncLocalStorage owner again, including prepared
        // statements and transaction functions returned by better-sqlite3.
        return (...args) => {
          assertTenantContext(contextStorage, owner);
          const current = contextStorage.getStore();
          const result = current.db[prop](...args);
          return guardDatabaseResult(prop, result, contextStorage, owner);
        };
      }
      const value = target[prop];
      if (typeof value === 'function') {
        return () => {
          throw new Error(CONTEXT_ERROR);
        };
      }
      return undefined;
    }
  });
}

module.exports = { createTenantScopedProxy };
