'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { decodeBase32, hotp } = require('./totp');

const PROJECT_ROOT = __dirname;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function captureCookies(headers, jar) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  for (const value of values) {
    const match = String(value).match(/^([^=;,\s]+)=([^;]*)/);
    if (match) jar.set(match[1], match[2]);
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function waitForServer(url, child, logs) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Servidor de teste encerrou antes de iniciar:\n${logs()}`);
    }
    try {
      const response = await fetch(`${url}/health/live`);
      if (response.ok) return;
    } catch {
      // O socket ainda não abriu; tenta novamente dentro do prazo.
    }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Servidor de teste não ficou disponível:\n${logs()}`);
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve();
    };
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      finish();
    }, 8000);
    child.once('exit', finish);
    child.kill('SIGTERM');
  });
}

test('HTTP real mantém contas, dados, mídia e limites isolados entre tenants', { timeout: 45000 }, async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-http-isolation-'));
  const dataDir = path.join(sandbox, 'data');
  const mediaDir = path.join(sandbox, 'media');
  const authDir = path.join(sandbox, 'auth');
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DATA_DIR: dataDir,
    MEDIA_ROOT: mediaDir,
    WA_AUTH_DIR: authDir,
    DISABLE_WHATSAPP_BOOTSTRAP: 'true',
    BILLING_REQUIRED: 'false',
    COOKIE_SECURE: 'false',
    CORS_ORIGIN: baseUrl,
    APP_URL: baseUrl,
    JWT_SECRET: 'integration-test-jwt-secret-32-bytes-minimum',
    ADMIN_USERNAME: 'owner@platform.test',
    ADMIN_PASSWORD: 'Platform-Password-123',
    SUPERADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    LOG_LEVEL: 'fatal',
    SQLITE_SYNCHRONOUS: 'NORMAL'
  };
  let output = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  const jarA = new Map();
  const jarB = new Map();
  const superJar = new Map();

  async function request(urlPath, {
    method = 'GET',
    jar = new Map(),
    json,
    headers = {}
  } = {}) {
    const upperMethod = method.toUpperCase();
    const requestHeaders = { ...headers };
    const cookies = cookieHeader(jar);
    if (cookies) requestHeaders.Cookie = cookies;
    if (json !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (MUTATING_METHODS.has(upperMethod) && jar.get('csrf_token')) {
      requestHeaders['X-CSRF-Token'] = jar.get('csrf_token');
    }
    const response = await fetch(`${baseUrl}${urlPath}`, {
      method: upperMethod,
      headers: requestHeaders,
      body: json === undefined ? undefined : JSON.stringify(json)
    });
    captureCookies(response.headers, jar);
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
    return { response, body };
  }

  try {
    await waitForServer(baseUrl, child, () => output.slice(-12000));

    const registrationA = await request('/api/register', {
      method: 'POST',
      jar: jarA,
      json: {
        companyName: 'Empresa Alpha',
        adminName: 'Admin Alpha',
        email: 'admin@alpha.test',
        password: 'Alpha-Password-123',
        plan: 'basico'
      }
    });
    const registrationB = await request('/api/register', {
      method: 'POST',
      jar: jarB,
      json: {
        // Mesmo nome de outra empresa: o cadastro público precisa gerar um
        // slug exclusivo sem obrigar o cliente a conhecer identificadores.
        companyName: 'Empresa Alpha',
        adminName: 'Admin Beta',
        email: 'admin@beta.test',
        password: 'Beta-Password-123',
        plan: 'basico'
      }
    });
    assert.equal(registrationA.response.status, 201, JSON.stringify(registrationA.body));
    assert.equal(registrationB.response.status, 201, JSON.stringify(registrationB.body));
    assert.equal(registrationA.response.headers.get('clear-site-data'), '"cache"');
    assert.equal(registrationB.response.headers.get('clear-site-data'), '"cache"');
    assert.notEqual(registrationA.body.tenant.slug, registrationB.body.tenant.slug);

    const reservedPlatformIdentity = await request('/api/register', {
      method: 'POST',
      json: {
        companyName: 'Tentativa Reservada',
        adminName: 'Conta Reservada',
        email: env.ADMIN_USERNAME,
        password: 'Reserved-Password-123',
        plan: 'basico'
      }
    });
    assert.equal(reservedPlatformIdentity.response.status, 409);
    const unicodeReservedPlatformIdentity = await request('/api/register', {
      method: 'POST',
      json: {
        companyName: 'Tentativa Unicode',
        adminName: 'Conta Reservada Unicode',
        email: 'ｏｗｎｅｒ＠ｐｌａｔｆｏｒｍ．ｔｅｓｔ',
        password: 'Reserved-Password-123',
        plan: 'basico'
      }
    });
    assert.equal(unicodeReservedPlatformIdentity.response.status, 409);

    const firstCsrfA = await request('/api/csrf-token', { jar: jarA });
    await request('/api/csrf-token', { jar: jarB });
    assert.match(jarA.get('csrf_token') || '', /^[a-f0-9]{64}$/);
    assert.match(jarB.get('csrf_token') || '', /^[a-f0-9]{64}$/);
    const csrfA = jarA.get('csrf_token');
    const repeatedCsrfA = await request('/api/csrf-token', { jar: jarA });
    assert.equal(firstCsrfA.body.csrfToken, csrfA);
    assert.equal(repeatedCsrfA.body.csrfToken, csrfA);
    assert.equal(jarA.get('csrf_token'), csrfA);

    const masterPath = path.join(dataDir, 'master.db');
    const master = new Database(masterPath);
    master.pragma('busy_timeout = 5000');
    const directoryA = master.prepare(
      'SELECT tenant_id FROM user_directory WHERE username = ? COLLATE NOCASE'
    ).get('admin@alpha.test');
    const directoryB = master.prepare(
      'SELECT tenant_id FROM user_directory WHERE username = ? COLLATE NOCASE'
    ).get('admin@beta.test');
    assert.ok(directoryA?.tenant_id);
    assert.ok(directoryB?.tenant_id);
    assert.notEqual(Number(directoryA.tenant_id), Number(directoryB.tenant_id));
    assert.equal(master.prepare('SELECT COUNT(*) AS total FROM tenants').get().total, 3);
    const tenantAId = Number(directoryA.tenant_id);
    const tenantBId = Number(directoryB.tenant_id);
    master.close();

    fs.mkdirSync(mediaDir, { recursive: true });
    const fixtures = [
      { tenantId: tenantAId, label: 'ALPHA', phone: '551100000001@c.us' },
      { tenantId: tenantBId, label: 'BETA', phone: '551100000002@c.us' }
    ];
    for (const fixture of fixtures) {
      const tenantDb = new Database(path.join(dataDir, `data_${fixture.tenantId}.db`));
      tenantDb.pragma('foreign_keys = ON');
      const conversationId = Number(tenantDb.prepare(`
        INSERT INTO conversations (phone, contact_name, status, last_activity_at)
        VALUES (?, ?, 'unassigned', CURRENT_TIMESTAMP)
      `).run(fixture.phone, `Cliente ${fixture.label}`).lastInsertRowid);
      const filename = `t${fixture.tenantId}-integration-secret.txt`;
      fs.writeFileSync(path.join(mediaDir, filename), `arquivo-${fixture.label}`);
      tenantDb.prepare(`
        INSERT INTO messages (
          conversation_id, external_id, from_type, content,
          media_type, media_mimetype, media_filename, media_url, media_size
        ) VALUES (?, ?, 'client', ?, 'document', 'text/plain', ?, ?, ?)
      `).run(
        conversationId,
        `integration-${fixture.label}`,
        `mensagem-${fixture.label}`,
        filename,
        `/media/${filename}`,
        Buffer.byteLength(`arquivo-${fixture.label}`)
      );
      tenantDb.close();
      fixture.conversationId = conversationId;
      fixture.filename = filename;
    }

    const [conversationsA, conversationsB] = await Promise.all([
      request('/api/conversations', { jar: jarA }),
      request('/api/conversations', { jar: jarB })
    ]);
    assert.equal(conversationsA.response.status, 200);
    assert.equal(conversationsB.response.status, 200);
    assert.deepEqual(conversationsA.body.map(row => row.contact_name), ['Cliente ALPHA']);
    assert.deepEqual(conversationsB.body.map(row => row.contact_name), ['Cliente BETA']);

    const [messagesA, messagesB] = await Promise.all([
      request(`/api/conversations/${fixtures[0].conversationId}/messages`, { jar: jarA }),
      request(`/api/conversations/${fixtures[1].conversationId}/messages`, { jar: jarB })
    ]);
    assert.equal(messagesA.response.status, 200);
    assert.equal(messagesB.response.status, 200);
    assert.deepEqual(messagesA.body.map(row => row.content), ['mensagem-ALPHA']);
    assert.deepEqual(messagesB.body.map(row => row.content), ['mensagem-BETA']);

    const ownMedia = await request(`/media/${fixtures[0].filename}`, { jar: jarA });
    const foreignMedia = await request(`/media/${fixtures[0].filename}`, { jar: jarB });
    assert.equal(ownMedia.response.status, 200);
    assert.equal(ownMedia.body, 'arquivo-ALPHA');
    assert.match(ownMedia.response.headers.get('cache-control') || '', /\bno-store\b/);
    // Não confirma sequer a existência do arquivo de outro tenant.
    assert.equal(foreignMedia.response.status, 404);

    const starA = await request('/api/messages/1/star', {
      method: 'PATCH',
      jar: jarA,
      json: { starred: true }
    });
    assert.equal(starA.response.status, 200, JSON.stringify(starA.body));
    const [starsA, starsB] = await Promise.all([
      request('/api/messages/starred', { jar: jarA }),
      request('/api/messages/starred', { jar: jarB })
    ]);
    assert.equal(starsA.body.length, 1);
    assert.equal(starsA.body[0].content, 'mensagem-ALPHA');
    assert.deepEqual(starsB.body, []);

    const [supportA, supportB] = await Promise.all([
      request('/api/support/messages', {
        method: 'POST', jar: jarA, json: { content: 'suporte-alpha' }
      }),
      request('/api/support/messages', {
        method: 'POST', jar: jarB, json: { content: 'suporte-beta' }
      })
    ]);
    assert.equal(supportA.response.status, 201, JSON.stringify(supportA.body));
    assert.equal(supportB.response.status, 201, JSON.stringify(supportB.body));
    const [threadA, threadB] = await Promise.all([
      request('/api/support/thread', { jar: jarA }),
      request('/api/support/thread', { jar: jarB })
    ]);
    assert.deepEqual(threadA.body.messages.map(row => row.content), ['suporte-alpha']);
    assert.deepEqual(threadB.body.messages.map(row => row.content), ['suporte-beta']);

    const [sectorAResult, sectorBResult] = await Promise.all([
      request('/api/sectors', {
        method: 'POST', jar: jarA, json: { name: 'Equipe Alpha', active: true }
      }),
      request('/api/sectors', {
        method: 'POST', jar: jarB, json: { name: 'Equipe Beta', active: true }
      })
    ]);
    assert.equal(sectorAResult.response.status, 201, JSON.stringify(sectorAResult.body));
    assert.equal(sectorBResult.response.status, 201, JSON.stringify(sectorBResult.body));

    const sharedPayload = (name, sectorId) => ({
      name,
      username: 'shared.agent@test.local',
      password: 'Shared-Password-123',
      sector_id: sectorId,
      active: true
    });
    const sharedAttempts = await Promise.all([
      request('/api/vendors', {
        method: 'POST', jar: jarA, json: sharedPayload('Compartilhado A', sectorAResult.body.id)
      }),
      request('/api/vendors', {
        method: 'POST', jar: jarB, json: sharedPayload('Compartilhado B', sectorBResult.body.id)
      })
    ]);
    assert.deepEqual(sharedAttempts.map(result => result.response.status).sort(), [201, 409]);

    let dbA = new Database(path.join(dataDir, `data_${tenantAId}.db`), { readonly: true });
    let dbB = new Database(path.join(dataDir, `data_${tenantBId}.db`), { readonly: true });
    const sharedInA = Number(dbA.prepare(
      'SELECT COUNT(*) AS total FROM vendors WHERE username = ? COLLATE NOCASE'
    ).get('shared.agent@test.local').total);
    const sharedInB = Number(dbB.prepare(
      'SELECT COUNT(*) AS total FROM vendors WHERE username = ? COLLATE NOCASE'
    ).get('shared.agent@test.local').total);
    assert.equal(sharedInA + sharedInB, 1);
    const initialActiveB = Number(dbB.prepare(
      'SELECT COUNT(*) AS total FROM vendors WHERE active = 1'
    ).get().total);
    dbA.close();
    dbB.close();

    const seatAttempts = await Promise.all(Array.from({ length: 6 }, (_, index) => request('/api/vendors', {
      method: 'POST',
      jar: jarB,
      json: {
        name: `Vendedor Beta ${index + 1}`,
        username: `beta.seat.${index + 1}@test.local`,
        password: 'Seat-Password-123',
        sector_id: sectorBResult.body.id,
        active: true
      }
    })));
    const successfulSeats = seatAttempts.filter(result => result.response.status === 201).length;
    assert.equal(successfulSeats, Math.max(0, 5 - initialActiveB));
    assert.ok(seatAttempts.some(result => (
      result.response.status === 409 && result.body.code === 'USER_LIMIT_REACHED'
    )));
    dbB = new Database(path.join(dataDir, `data_${tenantBId}.db`), { readonly: true });
    assert.equal(dbB.prepare('SELECT COUNT(*) AS total FROM vendors WHERE active = 1').get().total, 5);
    dbB.close();

    const crossConnection = await request('/api/admin/connections/start', {
      method: 'POST',
      jar: jarB,
      json: { tenantId: tenantAId }
    });
    assert.equal(crossConnection.response.status, 403);

    const rejectedMfa = await request('/api/login', {
      method: 'POST',
      json: { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, totp_code: '000000' }
    });
    assert.equal(rejectedMfa.response.status, 401);
    const rejectedSuperPassword = await request('/api/login', {
      method: 'POST',
      json: { username: env.ADMIN_USERNAME, password: 'senha-incorreta', totp_code: '000000' }
    });
    const rejectedUnknownUser = await request('/api/login', {
      method: 'POST',
      json: { username: 'nao-existe@platform.test', password: 'senha-incorreta', totp_code: '000000' }
    });
    for (const rejected of [rejectedSuperPassword, rejectedUnknownUser]) {
      assert.equal(rejected.response.status, 401);
      assert.deepEqual(
        rejected.body,
        rejectedMfa.body,
        'falhas de senha, usuário e MFA não podem revelar qual credencial estava correta'
      );
    }
    const totpCode = hotp(
      decodeBase32(env.SUPERADMIN_TOTP_SECRET),
      Math.floor(Date.now() / 1000 / 30)
    );
    const superLogin = await request('/api/login', {
      method: 'POST',
      jar: superJar,
      json: { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, totp_code: totpCode }
    });
    assert.equal(superLogin.response.status, 200, JSON.stringify(superLogin.body));
    await request('/api/csrf-token', { jar: superJar });
    const forbiddenOperationalRoute = await request('/api/conversations', { jar: superJar });
    assert.equal(forbiddenOperationalRoute.response.status, 403);
    const tenantOverview = await request('/api/tenants', { jar: superJar });
    assert.equal(tenantOverview.response.status, 200);
    assert.ok(tenantOverview.body.items.some(row => Number(row.id) === tenantAId));
    assert.ok(tenantOverview.body.items.some(row => Number(row.id) === tenantBId));
    assert.ok(tenantOverview.body.pagination.total >= 2);

    const suspended = await request(`/api/tenants/${tenantBId}/status`, {
      method: 'POST',
      jar: superJar,
      json: { status: 'suspended' }
    });
    assert.equal(suspended.response.status, 200, JSON.stringify(suspended.body));
    assert.equal(suspended.body.status, 'suspended');
    const blockedExistingSession = await request('/api/conversations', { jar: jarB });
    assert.equal(blockedExistingSession.response.status, 401);
    const blockedLogin = await request('/api/login', {
      method: 'POST',
      json: { username: 'admin@beta.test', password: 'Beta-Password-123' }
    });
    assert.equal(blockedLogin.response.status, 401);

    const reactivated = await request(`/api/tenants/${tenantBId}/status`, {
      method: 'POST',
      jar: superJar,
      json: { status: 'active' }
    });
    assert.equal(reactivated.response.status, 200, JSON.stringify(reactivated.body));
    assert.equal(reactivated.body.status, 'active');

    // Reativar a empresa não ressuscita cookies emitidos antes da suspensão.
    const staleAfterReactivation = await request('/api/conversations', { jar: jarB });
    assert.equal(staleAfterReactivation.response.status, 401);
    const freshTenantBJar = new Map();
    const freshLogin = await request('/api/login', {
      method: 'POST',
      jar: freshTenantBJar,
      json: { username: 'admin@beta.test', password: 'Beta-Password-123' }
    });
    assert.equal(freshLogin.response.status, 200, JSON.stringify(freshLogin.body));
    const freshConversations = await request('/api/conversations', { jar: freshTenantBJar });
    assert.equal(freshConversations.response.status, 200);
    assert.deepEqual(freshConversations.body.map(row => row.contact_name), ['Cliente BETA']);

    const audit = spawnSync(process.execPath, ['scripts/audit-integrity.js'], {
      cwd: PROJECT_ROOT,
      env,
      encoding: 'utf8'
    });
    assert.equal(audit.status, 0, `${audit.stdout}\n${audit.stderr}`);
    const auditResult = JSON.parse(audit.stdout.trim());
    assert.equal(auditResult.ok, true, JSON.stringify(auditResult));
    assert.equal(auditResult.summary.accountIdentitiesChecked >= 2, true);
  } finally {
    await stopChild(child);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
