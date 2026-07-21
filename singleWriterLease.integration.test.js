const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function waitForReady(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error(`timeout aguardando lease: ${stderr}`)), timeoutMs);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('READY')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => {
      if (!stdout.includes('READY')) {
        clearTimeout(timeout);
        reject(new Error(`holder encerrou antes de adquirir lease (${code}): ${stderr}`));
      }
    });
  });
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timeout = setTimeout(() => reject(new Error('timeout aguardando release do lease')), timeoutMs);
    child.once('exit', code => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

test('production bootstrap rejects a second writer before data.db and closeAllDbs releases the lease', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-production-lease-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DATA_DIR: path.join(root, 'data'),
    WA_AUTH_DIR: path.join(root, 'auth'),
    MEDIA_ROOT: path.join(root, 'media'),
    SINGLE_WRITER_LEASE_TTL_MS: '60000',
    SINGLE_WRITER_LEASE_HEARTBEAT_MS: '10000',
    ADMIN_USERNAME: 'owner@example.test',
    ADMIN_PASSWORD: 'very-strong-production-password'
  };
  const holder = spawn(process.execPath, ['-e', `
    const tm = require('./tenantManager');
    process.stdout.write('READY\\n');
    process.stdin.once('data', () => {
      tm.closeAllDbs();
      process.exit(0);
    });
    process.stdin.resume();
  `], { cwd: __dirname, env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => {
    if (holder.exitCode === null) holder.kill('SIGKILL');
  });
  await waitForReady(holder);

  const contender = spawnSync(process.execPath, ['-e', "require('./db')"], {
    cwd: __dirname,
    env,
    encoding: 'utf8'
  });
  assert.notEqual(contender.status, 0);
  assert.match(`${contender.stdout}\n${contender.stderr}`, /Outra instancia de producao ja possui o lease/);
  assert.equal(
    fs.existsSync(path.join(env.DATA_DIR, 'data.db')),
    false,
    'the rejected contender must not migrate data.db or create a platform credential'
  );

  holder.stdin.end('release');
  assert.equal(await waitForExit(holder), 0);

  const replacement = spawnSync(process.execPath, ['-e', `
    const db = require('./db');
    const tm = require('./tenantManager');
    if (!db.defaultDb.prepare('SELECT 1 FROM admins WHERE super_admin = 1').get()) {
      throw new Error('superadmin nao foi criado sob o lease');
    }
    tm.closeAllDbs();
    db.defaultDb.close();
  `], { cwd: __dirname, env, encoding: 'utf8' });
  assert.equal(replacement.status, 0, replacement.stderr);
});
