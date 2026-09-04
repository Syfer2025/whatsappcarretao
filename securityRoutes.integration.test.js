'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

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

async function waitForServer(baseUrl, child, logs) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Servidor encerrou antes de iniciar:\n${logs()}`);
    try {
      const response = await fetch(`${baseUrl}/health/live`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Servidor de teste não iniciou:\n${logs()}`);
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

// Regressao 04/set/2026: o handshake do socket.io recusava requisicao sem
// header Origin, e navegador nao envia Origin em GET same-origin — que e
// exatamente o transporte polling. Resultado: 403 em toda conexao e ZERO
// tempo real em producao, com o frontend engolindo o connect_error.
test('handshake do socket aceita same-origin sem header Origin e recusa host estranho', () => {
  const source = require('node:fs').readFileSync(require.resolve('./server.js'), 'utf8');
  const inicio = source.indexOf('function isSocketOriginAllowed');
  const trecho = source.slice(inicio, inicio + 700);

  // Origem ausente nao pode mais cair direto em "proibido" por NODE_ENV.
  assert.ok(
    !/if \(!normalizedOrigin\) return process\.env\.NODE_ENV !== 'production';/.test(trecho),
    'origem ausente nao deve ser recusada apenas por estar em producao'
  );
  // Precisa validar pelo Host, que o navegador nao deixa forjar.
  assert.match(trecho, /allowedHosts/);
  assert.match(source, /isSocketOriginAllowed\(request\.headers\?\.origin, request\.headers\?\.host\)/);

  // E a lista de hosts tem de sair das origens configuradas, nao ser fixa.
  const hosts = source.slice(source.indexOf('const allowedHosts'), source.indexOf('const allowedHosts') + 260);
  assert.match(hosts, /allowedOrigins/);
  assert.match(hosts, /new URL\(origin\)/);
});

test('rotas sensíveis respeitam autoria, papel e origem em execução real', { timeout: 45000 }, async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-security-routes-'));
  const dataDir = path.join(sandbox, 'data');
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DATA_DIR: dataDir,
    MEDIA_ROOT: path.join(sandbox, 'media'),
    WA_AUTH_DIR: path.join(sandbox, 'auth'),
    DISABLE_WHATSAPP_BOOTSTRAP: 'true',
    BILLING_REQUIRED: 'false',
    COOKIE_SECURE: 'false',
    CORS_ORIGIN: baseUrl,
    APP_URL: baseUrl,
    JWT_SECRET: 'security-routes-integration-secret-32-bytes',
    ADMIN_USERNAME: 'platform-security@test.local',
    ADMIN_PASSWORD: 'Platform-Security-Password-123',
    // Edicao fixada de proposito. O servidor filho carrega o .env do projeto, e
    // na edicao interna /superadmin.html e escondido por decisao de produto
    // (ver internalEdition.js). Sem fixar aqui, o teste passava ou falhava
    // conforme o .env da maquina — e passou a barrar o deploy sem nenhuma
    // mudanca de codigo. As rotas verificadas abaixo sao as da edicao completa.
    APP_MODE: '',
    INTERNAL_SINGLE_TENANT: '',
    LOG_LEVEL: 'fatal'
  };
  let output = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  async function request(urlPath, { method = 'GET', jar = new Map(), json, headers = {} } = {}) {
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
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    return { response, body };
  }

  async function openPollingSocket(jar) {
    const headers = { Origin: baseUrl };
    const cookies = cookieHeader(jar);
    if (cookies) headers.Cookie = cookies;
    const handshake = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`, { headers });
    assert.equal(handshake.status, 200);
    const openPacket = await handshake.text();
    const session = JSON.parse(openPacket.slice(1));
    const socketUrl = `${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(session.sid)}`;
    const connected = await fetch(socketUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: '40'
    });
    assert.equal(connected.status, 200);
    await connected.text();
    const initialEvents = await fetch(socketUrl, { headers });
    assert.equal(initialEvents.status, 200);
    const initialPayload = await initialEvents.text();
    assert.match(initialPayload, /(?:^|\x1e)40(?:\{|$)/);
    assert.match(initialPayload, /connection:status/);
    return { socketUrl, headers };
  }

  async function pollSocket(socket) {
    const response = await fetch(socket.socketUrl, { headers: socket.headers });
    assert.equal(response.status, 200);
    return response.text();
  }

  async function pollSocketUntilTimeout(socket, timeoutMs = 500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(socket.socketUrl, {
        headers: socket.headers,
        signal: controller.signal
      });
      return await response.text();
    } catch (error) {
      if (error.name === 'AbortError') return null;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const adminJar = new Map();
  const vendorOneJar = new Map();
  const vendorTwoJar = new Map();
  const vendorThreeJar = new Map();

  try {
    await waitForServer(baseUrl, child, () => output.slice(-12000));

    for (const htmlPath of ['/', '/admin.html', '/vendor.html', '/superadmin.html']) {
      const shell = await request(htmlPath);
      assert.equal(shell.response.status, 200, `${htmlPath} deveria existir`);
      assert.match(
        shell.response.headers.get('cache-control') || '',
        /\bno-store\b/,
        `${htmlPath} não pode ser restaurado do cache após troca de conta`
      );
    }

    for (const apiPath of ['/api/branding', '/api/csrf-token', '/api/me']) {
      const apiResponse = await request(apiPath);
      assert.match(
        apiResponse.response.headers.get('cache-control') || '',
        /\bno-store\b/,
        `${apiPath} não pode ser armazenado por navegador ou proxy`
      );
    }

    const invalidWebhook = await request('/api/webhooks/stripe', {
      method: 'POST',
      json: {}
    });
    assert.equal(invalidWebhook.response.status, 400);
    assert.match(invalidWebhook.response.headers.get('cache-control') || '', /\bno-store\b/);

    const maliciousHandshake = await request('/socket.io/?EIO=4&transport=polling', {
      headers: { Origin: 'https://malicious.example' }
    });
    assert.ok(
      [400, 403].includes(maliciousHandshake.response.status),
      `origem maliciosa deveria ser rejeitada, recebeu ${maliciousHandshake.response.status}`
    );
    assert.doesNotMatch(String(maliciousHandshake.body), /^0\{/);

    const allowedHandshake = await request('/socket.io/?EIO=4&transport=polling', {
      headers: { Origin: baseUrl }
    });
    assert.equal(allowedHandshake.response.status, 200);
    assert.match(String(allowedHandshake.body), /^0\{/);

    const nullRegistration = await request('/api/register', {
      method: 'POST',
      json: null
    });
    assert.equal(nullRegistration.response.status, 400, JSON.stringify(nullRegistration.body));

    const malformedRegistration = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{'
    });
    assert.equal(malformedRegistration.status, 400);
    assert.deepEqual(await malformedRegistration.json(), {
      error: 'Corpo JSON inválido',
      code: 'INVALID_JSON'
    });

    const registration = await request('/api/register', {
      method: 'POST',
      jar: adminJar,
      json: {
        companyName: 'Empresa Segurança',
        adminName: 'Admin Segurança',
        email: 'admin-security@test.local',
        password: 'Admin-Security-Password-123',
        plan: 'basico'
      }
    });
    assert.equal(registration.response.status, 201, JSON.stringify(registration.body));
    await request('/api/csrf-token', { jar: adminJar });

    const master = new Database(path.join(dataDir, 'master.db'), { readonly: true });
    const tenantId = Number(master.prepare(
      'SELECT tenant_id FROM user_directory WHERE username = ? COLLATE NOCASE'
    ).get('admin-security@test.local').tenant_id);
    master.close();

    const sector = await request('/api/sectors', {
      method: 'POST', jar: adminJar, json: { name: 'Mesmo Setor', active: true }
    });
    assert.equal(sector.response.status, 201, JSON.stringify(sector.body));
    const otherSector = await request('/api/sectors', {
      method: 'POST', jar: adminJar, json: { name: 'Setor Sem Acesso', active: true }
    });
    assert.equal(otherSector.response.status, 201, JSON.stringify(otherSector.body));

    async function createVendor(number, sectorId = sector.body.id) {
      return request('/api/vendors', {
        method: 'POST',
        jar: adminJar,
        json: {
          name: `Vendedor ${number}`,
          username: `vendor-${number}-security@test.local`,
          password: `Vendor-${number}-Security-Password-123`,
          sector_id: sectorId,
          active: true
        }
      });
    }

    const vendorOne = await createVendor(1);
    const vendorTwo = await createVendor(2);
    const vendorThree = await createVendor(3, otherSector.body.id);
    assert.equal(vendorOne.response.status, 201, JSON.stringify(vendorOne.body));
    assert.equal(vendorTwo.response.status, 201, JSON.stringify(vendorTwo.body));
    assert.equal(vendorThree.response.status, 201, JSON.stringify(vendorThree.body));

    async function loginVendor(number, jar) {
      const login = await request('/api/login', {
        method: 'POST',
        jar,
        json: {
          username: `vendor-${number}-security@test.local`,
          password: `Vendor-${number}-Security-Password-123`
        }
      });
      assert.equal(login.response.status, 200, JSON.stringify(login.body));
      await request('/api/csrf-token', { jar });
    }

    await loginVendor(1, vendorOneJar);
    await loginVendor(2, vendorTwoJar);
    await loginVendor(3, vendorThreeJar);

    const tenantDb = new Database(path.join(dataDir, `data_${tenantId}.db`));
    const conversationId = Number(tenantDb.prepare(`
      INSERT INTO conversations (phone, contact_name, status, assigned_to, sector_id, last_activity_at)
      VALUES (?, ?, 'assigned', ?, ?, CURRENT_TIMESTAMP)
    `).run('5511999999999@c.us', 'Cliente Compartilhado', vendorOne.body.id, sector.body.id).lastInsertRowid);
    const messageId = Number(tenantDb.prepare(`
      INSERT INTO messages (conversation_id, external_id, from_type, vendor_id, content, delivery_status)
      VALUES (?, ?, 'vendor', ?, ?, 'sent')
    `).run(conversationId, 'outbound-owned-by-vendor-one', vendorOne.body.id, 'Mensagem do vendedor um').lastInsertRowid);
    tenantDb.close();

    const vendorOneSocket = await openPollingSocket(vendorOneJar);
    const vendorTwoSocket = await openPollingSocket(vendorTwoJar);
    const vendorThreeSocket = await openPollingSocket(vendorThreeJar);
    const assignment = await request(`/api/conversations/${conversationId}/assign`, {
      method: 'POST',
      jar: adminJar,
      json: { vendor_id: vendorOne.body.id, sector_id: sector.body.id }
    });
    assert.equal(assignment.response.status, 200, JSON.stringify(assignment.body));
    // Tempo real chega SO para o vendedor atribuido.
    const scopedRealtimeEvent = await pollSocket(vendorOneSocket);
    assert.match(scopedRealtimeEvent, /conversation:updated/);
    assert.match(scopedRealtimeEvent, new RegExp(`"conversationId":${conversationId}(?:[,}])`));
    assert.equal(
      await pollSocketUntilTimeout(vendorTwoSocket),
      null,
      'vendedor do mesmo setor não pode receber a conversa de outro vendedor'
    );
    assert.equal(
      await pollSocketUntilTimeout(vendorThreeSocket),
      null,
      'vendedor de outro setor não pode receber nem metadados da conversa'
    );

    // Vendedor do mesmo setor nao le a conversa de outro vendedor.
    const visibleToSecondVendor = await request(`/api/conversations/${conversationId}/messages`, {
      jar: vendorTwoJar
    });
    assert.equal(visibleToSecondVendor.response.status, 403, JSON.stringify(visibleToSecondVendor.body));

    // E o dono le normalmente.
    const visibleToOwner = await request(`/api/conversations/${conversationId}/messages`, {
      jar: vendorOneJar
    });
    assert.equal(visibleToOwner.response.status, 200, JSON.stringify(visibleToOwner.body));
    assert.equal(visibleToOwner.body.at(-1).id, messageId);

    // Apagar mensagem de outro vendedor para para no controle de acesso antes
    // mesmo da regra de autoria.
    const foreignDelete = await request(`/api/messages/${messageId}?scope=everyone`, {
      method: 'DELETE', jar: vendorTwoJar
    });
    assert.equal(foreignDelete.response.status, 403, JSON.stringify(foreignDelete.body));
    assert.match(foreignDelete.body.error, /não é sua/i);

    const ownerDeleteWithoutWhatsApp = await request(`/api/messages/${messageId}?scope=everyone`, {
      method: 'DELETE', jar: vendorOneJar
    });
    assert.equal(ownerDeleteWithoutWhatsApp.response.status, 409, JSON.stringify(ownerDeleteWithoutWhatsApp.body));

    const adminDeleteWithoutWhatsApp = await request(`/api/messages/${messageId}?scope=everyone`, {
      method: 'DELETE', jar: adminJar
    });
    assert.equal(adminDeleteWithoutWhatsApp.response.status, 409, JSON.stringify(adminDeleteWithoutWhatsApp.body));

    const adminSupport = await request('/api/support/messages', {
      method: 'POST', jar: adminJar, json: { content: 'Mensagem administrativa' }
    });
    assert.equal(adminSupport.response.status, 201, JSON.stringify(adminSupport.body));

    for (const attempt of [
      await request('/api/support/thread', { jar: vendorTwoJar }),
      await request('/api/support/messages', {
        method: 'POST', jar: vendorTwoJar, json: { content: 'Tentativa do vendedor' }
      }),
      await request('/api/support/thread/read', {
        method: 'PATCH', jar: vendorTwoJar, json: {}
      }),
      await request('/support-media/arquivo-inexistente.png', { jar: vendorTwoJar })
    ]) {
      assert.equal(attempt.response.status, 403, JSON.stringify(attempt.body));
    }
  } finally {
    await stopChild(child);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
