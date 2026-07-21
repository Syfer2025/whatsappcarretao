const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function runWorker({ operation, tenantId, sectorId, startAt, env }) {
  const worker = `
    const tenantManager = require(${JSON.stringify(path.join(__dirname, 'tenantManager.js'))});
    const { createUser } = require(${JSON.stringify(path.join(__dirname, 'adminServices.js'))});
    const [operation, tenantId, sectorId, startAt] = process.argv.slice(1);
    setTimeout(() => {
      try {
        let result;
        if (operation === 'reduce') {
          result = tenantManager.updateTenant(Number(tenantId), { plan: 'basico' });
        } else {
          result = tenantManager.withTenantCapacityLock(Number(tenantId), tenant => createUser({
            db: tenantManager.getTenantDb(Number(tenantId)),
            name: 'Sexto concorrente',
            username: 'capacity.sixth',
            password: 'senha12345',
            sectorId: Number(sectorId),
            userLimit: tenantManager.getTenantUserLimit(tenant),
            onBeforeCommit: user => tenantManager.registerDirectoryUser(
              user.username,
              Number(tenantId),
              'vendor'
            )
          }));
        }
        process.stdout.write(JSON.stringify({ ok: true, plan: result.plan, id: result.id }));
      } catch (error) {
        process.stdout.write(JSON.stringify({
          ok: false,
          code: error.code || null,
          statusCode: error.statusCode || null,
          message: error.message
        }));
      } finally {
        tenantManager.closeAllDbs();
      }
    }, Math.max(0, Number(startAt) - Date.now()));
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-e', worker, operation, String(tenantId), String(sectorId), String(startAt)],
      { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`worker terminou com ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`resposta invalida do worker: ${stdout || stderr}`));
      }
    });
  });
}

test('plan reduction and concurrent user creation never oversubscribe tenant capacity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-capacity-race-'));
  const env = {
    ...process.env,
    DATA_DIR: path.join(root, 'data'),
    WA_AUTH_DIR: path.join(root, 'auth'),
    MEDIA_ROOT: path.join(root, 'media'),
    NODE_ENV: 'test'
  };
  const previousEnv = {
    DATA_DIR: process.env.DATA_DIR,
    WA_AUTH_DIR: process.env.WA_AUTH_DIR,
    MEDIA_ROOT: process.env.MEDIA_ROOT,
    NODE_ENV: process.env.NODE_ENV
  };
  Object.assign(process.env, env);

  const tenantManager = require('./tenantManager');
  const { createSector, createUser, countActiveUsers } = require('./adminServices');
  const tenant = tenantManager.createTenant({
    name: 'Capacity Race',
    slug: 'capacity-race',
    plan: 'profissional'
  });
  const tenantDb = tenantManager.getTenantDb(tenant.id);
  const sector = createSector({ db: tenantDb, name: 'Comercial' });

  try {
    for (let index = 1; index <= 5; index += 1) {
      tenantManager.withTenantCapacityLock(tenant.id, lockedTenant => createUser({
        db: tenantDb,
        name: `Usuario ${index}`,
        username: `capacity.user${index}`,
        password: 'senha12345',
        sectorId: sector.id,
        userLimit: tenantManager.getTenantUserLimit(lockedTenant),
        onBeforeCommit: user => tenantManager.registerDirectoryUser(user.username, tenant.id, 'vendor')
      }));
    }
    assert.equal(countActiveUsers(tenantDb), 5);

    const startAt = Date.now() + 750;
    const results = await Promise.all([
      runWorker({ operation: 'reduce', tenantId: tenant.id, sectorId: sector.id, startAt, env }),
      runWorker({ operation: 'create', tenantId: tenant.id, sectorId: sector.id, startAt, env })
    ]);
    assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));

    const finalTenant = tenantManager.getTenant(tenant.id);
    const activeUsers = countActiveUsers(tenantDb);
    assert.notDeepEqual(
      { plan: finalTenant.plan, activeUsers },
      { plan: 'basico', activeUsers: 6 },
      'a reduced five-seat plan must never commit with six active users'
    );
    assert.ok(
      (finalTenant.plan === 'basico' && activeUsers === 5)
        || (finalTenant.plan === 'profissional' && activeUsers === 6),
      `estado linearizado inesperado: ${finalTenant.plan}/${activeUsers}`
    );
  } finally {
    await tenantManager.deleteTenant(tenant.id);
    tenantManager.closeAllDbs();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
