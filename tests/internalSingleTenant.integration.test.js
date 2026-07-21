'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const PROJECT_ROOT = path.resolve(__dirname, '..');
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

async function waitForServer(baseUrl, child, logs) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Servidor interno encerrou antes de iniciar:\n${logs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health/live`);
      if (response.ok) return;
    } catch {
      // A porta ainda não abriu.
    }
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Servidor interno não ficou disponível:\n${logs()}`);
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

test('modo interno provisiona somente a empresa padrão e permite administrar agentes sem SaaS', {
  timeout: 45000
}, async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'whatscarretao-internal-'));
  const dataDir = path.join(sandbox, 'data');
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerUsername = 'owner-internal@example.test';
  const ownerPassword = 'Internal-Owner-Password-123';
  const agentUsername = 'agent-internal@example.test';
  const agentPassword = 'Internal-Agent-Password-123';
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DATA_DIR: dataDir,
    MEDIA_ROOT: path.join(sandbox, 'media'),
    WA_AUTH_DIR: path.join(sandbox, 'whatsapp-auth'),
    DISABLE_WHATSAPP_BOOTSTRAP: 'true',
    WA_START_DEFAULT_SESSION: 'false',
    INTERNAL_SINGLE_TENANT: 'true',
    BILLING_REQUIRED: 'false',
    COOKIE_SECURE: 'false',
    CORS_ORIGIN: baseUrl,
    APP_URL: baseUrl,
    APP_NAME: 'WhatsCarretao Teste',
    APP_COMPANY: 'Empresa Interna Teste',
    TENANT_NAME: 'Empresa Interna Teste',
    ADMIN_USERNAME: ownerUsername,
    ADMIN_PASSWORD: ownerPassword,
    SUPERADMIN_TOTP_SECRET: '',
    TURNSTILE_ENABLED: 'false',
    JWT_SECRET: 'internal-mode-integration-secret-32-bytes',
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

  async function request(urlPath, {
    method = 'GET',
    jar = new Map(),
    json,
    rawBody,
    headers = {},
    csrf = true,
    redirect = 'follow'
  } = {}) {
    const upperMethod = method.toUpperCase();
    const requestHeaders = { ...headers };
    const cookies = cookieHeader(jar);
    if (cookies) requestHeaders.Cookie = cookies;
    if (json !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (csrf && MUTATING_METHODS.has(upperMethod) && jar.get('csrf_token')) {
      requestHeaders['X-CSRF-Token'] = jar.get('csrf_token');
    }
    const response = await fetch(`${baseUrl}${urlPath}`, {
      method: upperMethod,
      headers: requestHeaders,
      body: json === undefined ? rawBody : JSON.stringify(json),
      redirect
    });
    captureCookies(response.headers, jar);
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
    return { response, body };
  }

  const ownerJar = new Map();
  const agentJar = new Map();

  try {
    await waitForServer(baseUrl, child, () => output.slice(-12000));

    const root = await request('/', { redirect: 'manual' });
    assert.equal(root.response.status, 302);
    assert.equal(root.response.headers.get('location'), '/login.html');

    for (const page of [
      '/index.html',
      '/register.html',
      '/superadmin.html',
      '/forgot-password.html',
      '/settings.html',
      '/setup.html'
    ]) {
      const blockedPage = await request(page, { redirect: 'manual' });
      assert.equal(blockedPage.response.status, 404, `${page} deve ficar indisponível no modo interno`);
    }

    const blockedSignup = await request('/api/register', {
      method: 'POST',
      json: {
        companyName: 'Empresa que não deve existir',
        adminName: 'Cadastro Público',
        email: 'signup-must-be-blocked@example.test',
        password: 'Blocked-Signup-Password-123',
        plan: 'basico'
      }
    });
    assert.equal(blockedSignup.response.status, 404, JSON.stringify(blockedSignup.body));
    assert.equal(blockedSignup.body.code, 'INTERNAL_MODE');
    assert.equal(typeof blockedSignup.body.error, 'string');
    assert.ok(blockedSignup.body.error.length > 0);

    const masterPath = path.join(dataDir, 'master.db');
    const platformPath = path.join(dataDir, 'data.db');
    const master = new Database(masterPath, { readonly: true, fileMustExist: true });
    const tenants = master.prepare(`
      SELECT id, name, slug, status, billing_status, trial_ends_at,
             stripe_customer_id, stripe_subscription_id, stripe_checkout_session_id
      FROM tenants
      ORDER BY id
    `).all();
    assert.equal(tenants.length, 1);
    assert.equal(tenants[0].slug, 'default');
    assert.equal(tenants[0].status, 'active');
    assert.equal(tenants[0].billing_status, 'active');
    assert.equal(tenants[0].trial_ends_at, null);
    assert.equal(tenants[0].stripe_customer_id, null);
    assert.equal(tenants[0].stripe_subscription_id, null);
    assert.equal(tenants[0].stripe_checkout_session_id, null);
    const tenantId = Number(tenants[0].id);
    const ownerDirectory = master.prepare(`
      SELECT tenant_id, role
      FROM user_directory
      WHERE username = ? COLLATE NOCASE
    `).get(ownerUsername);
    assert.deepEqual(ownerDirectory, { tenant_id: tenantId, role: 'admin' });
    assert.equal(master.prepare('SELECT COUNT(*) AS total FROM tenants').get().total, 1);
    assert.equal(master.prepare(`
      SELECT COUNT(*) AS total FROM user_directory
      WHERE username = ? COLLATE NOCASE
    `).get('signup-must-be-blocked@example.test').total, 0);
    master.close();

    const platform = new Database(platformPath, { readonly: true, fileMustExist: true });
    assert.equal(platform.prepare(`
      SELECT COUNT(*) AS total FROM admins WHERE coalesce(super_admin, 0) = 1
    `).get().total, 0, 'modo interno não deve criar superadmin de plataforma');
    platform.close();

    const tenantPath = path.join(dataDir, `data_${tenantId}.db`);
    let tenant = new Database(tenantPath, { readonly: true, fileMustExist: true });
    const internalAdmins = tenant.prepare(`
      SELECT username, coalesce(super_admin, 0) AS super_admin
      FROM admins
      ORDER BY id
    `).all();
    assert.deepEqual(internalAdmins, [{ username: ownerUsername, super_admin: 0 }]);
    assert.deepEqual(tenant.prepare(`
      SELECT name, active FROM sectors ORDER BY id
    `).all(), [{ name: 'Atendimento', active: 1 }]);
    tenant.close();

    const ownerLogin = await request('/api/login', {
      method: 'POST',
      jar: ownerJar,
      json: { username: ownerUsername, password: ownerPassword }
    });
    assert.equal(ownerLogin.response.status, 200, JSON.stringify(ownerLogin.body));
    assert.equal(ownerLogin.body.role, 'admin');
    assert.equal(ownerLogin.body.super_admin, false);
    assert.ok(ownerJar.get('auth_token'));
    assert.ok(ownerJar.get('csrf_token'));

    const ownerMe = await request('/api/me', { jar: ownerJar });
    assert.equal(ownerMe.response.status, 200, JSON.stringify(ownerMe.body));
    assert.equal(ownerMe.body.username, ownerUsername);
    assert.equal(ownerMe.body.role, 'admin');
    assert.equal(ownerMe.body.super_admin, false);
    assert.equal(Number(ownerMe.body.tenant_id), tenantId);

    for (const blockedApi of [
      '/api/tenants',
      '/api/billing/status',
      '/api/billing/overview',
      '/api/admin/platform-config'
    ]) {
      const result = await request(blockedApi, { jar: ownerJar });
      assert.equal(result.response.status, 404, `${blockedApi} deve ficar indisponível`);
      assert.equal(result.body.code, 'INTERNAL_MODE');
    }
    const blockedCheckout = await request('/api/billing/checkout', {
      method: 'POST', jar: ownerJar, json: {}
    });
    assert.equal(blockedCheckout.response.status, 404, JSON.stringify(blockedCheckout.body));
    assert.equal(blockedCheckout.body.code, 'INTERNAL_MODE');
    const blockedStripeWebhook = await request('/api/webhooks/stripe', {
      method: 'POST',
      rawBody: '{}',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 'blocked-internal-mode' }
    });
    assert.equal(blockedStripeWebhook.response.status, 404, JSON.stringify(blockedStripeWebhook.body));
    assert.equal(blockedStripeWebhook.body.code, 'INTERNAL_MODE');

    const csrfRejected = await request('/api/sectors', {
      method: 'POST',
      jar: ownerJar,
      csrf: false,
      json: { name: 'Sem CSRF', active: true }
    });
    assert.equal(csrfRejected.response.status, 403, 'mutação autenticada sem cabeçalho CSRF deve falhar');

    const csrf = await request('/api/csrf-token', { jar: ownerJar });
    assert.equal(csrf.response.status, 200);
    assert.match(csrf.body.csrfToken, /^[a-f0-9]{64}$/);
    assert.equal(csrf.body.csrfToken, ownerJar.get('csrf_token'));

    const sector = await request('/api/sectors', {
      method: 'POST',
      jar: ownerJar,
      json: { name: 'Vendas Internas', active: true }
    });
    assert.equal(sector.response.status, 201, JSON.stringify(sector.body));
    assert.ok(Number.isInteger(Number(sector.body.id)));

    const agent = await request('/api/vendors', {
      method: 'POST',
      jar: ownerJar,
      json: {
        name: 'Agente Interno',
        username: agentUsername,
        password: agentPassword,
        sector_id: sector.body.id,
        active: true
      }
    });
    assert.equal(agent.response.status, 201, JSON.stringify(agent.body));
    assert.equal(agent.body.username, agentUsername);
    assert.equal(Number(agent.body.sector_id), Number(sector.body.id));
    assert.equal(Object.hasOwn(agent.body, 'password'), false, 'hash de senha não pode vazar pela API');

    const verificationMaster = new Database(masterPath, { readonly: true, fileMustExist: true });
    assert.deepEqual(verificationMaster.prepare(`
      SELECT tenant_id, role
      FROM user_directory
      WHERE username = ? COLLATE NOCASE
    `).get(agentUsername), { tenant_id: tenantId, role: 'vendor' });
    assert.equal(verificationMaster.prepare('SELECT COUNT(*) AS total FROM tenants').get().total, 1);
    verificationMaster.close();

    tenant = new Database(tenantPath, { readonly: true, fileMustExist: true });
    const persistedAgent = tenant.prepare(`
      SELECT username, sector_id, active
      FROM vendors
      WHERE username = ? COLLATE NOCASE
    `).get(agentUsername);
    assert.equal(persistedAgent.username, agentUsername);
    assert.equal(Number(persistedAgent.sector_id), Number(sector.body.id));
    assert.equal(Number(persistedAgent.active), 1);
    tenant.close();

    const agentLogin = await request('/api/login', {
      method: 'POST',
      jar: agentJar,
      json: { username: agentUsername, password: agentPassword }
    });
    assert.equal(agentLogin.response.status, 200, JSON.stringify(agentLogin.body));
    assert.equal(agentLogin.body.role, 'vendor');
    assert.equal(Number(agentLogin.body.sector_id), Number(sector.body.id));

    const agentMe = await request('/api/me', { jar: agentJar });
    assert.equal(agentMe.response.status, 200, JSON.stringify(agentMe.body));
    assert.equal(agentMe.body.username, agentUsername);
    assert.equal(agentMe.body.role, 'vendor');
    assert.equal(agentMe.body.super_admin, false);
    assert.equal(Number(agentMe.body.tenant_id), tenantId);
    assert.equal(Number(agentMe.body.sector_id), Number(sector.body.id));

    const agentConversations = await request('/api/conversations', { jar: agentJar });
    assert.equal(agentConversations.response.status, 200, JSON.stringify(agentConversations.body));
    assert.deepEqual(agentConversations.body, []);
  } finally {
    await stopChild(child);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
