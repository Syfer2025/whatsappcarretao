const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const previousAuthDir = process.env.WA_AUTH_DIR;
const managerAuthRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-manager-auth-'));
process.env.WA_AUTH_DIR = managerAuthRoot;
const waManager = require('./whatsappManager');
const { __test } = waManager;

const src = fs.readFileSync('./whatsappManager.js', 'utf-8');

test.after(async () => {
  await waManager.shutdown();
  fs.rmSync(managerAuthRoot, { recursive: true, force: true });
  if (previousAuthDir === undefined) delete process.env.WA_AUTH_DIR;
  else process.env.WA_AUTH_DIR = previousAuthDir;
});

test('whatsapp manager isolates tenants with dedicated browser mode', () => {
  assert.match(src, /WA_BROWSER_MODE/);
  assert.match(src, /function isIsolatedBrowserMode\(\)/);
  assert.match(src, /new LocalAuthConstructor\(\{ dataPath: authPath \}\)/);
  assert.match(src, /buildClientPuppeteerOptions\(\{ isolated, proxyServer \}\)/);
  assert.match(src, /const isolated = isIsolatedBrowserMode\(\)/);
  assert.match(src, /if \(!isolated\) \{[\s\S]*Sessão WhatsApp sem isolamento de navegador foi recusada/);
  assert.doesNotMatch(src, /browserWSEndpoint|sharedBrowser/);
});

test('whatsapp manager defaults to isolated and rejects shared mode in every environment', { concurrency: false }, () => {
  const previousMode = process.env.WA_BROWSER_MODE;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.WA_BROWSER_MODE;
    process.env.NODE_ENV = 'development';
    assert.equal(__test.browserMode(), 'isolated');

    process.env.WA_BROWSER_MODE = 'shared';
    assert.throws(
      () => __test.validatedBrowserMode(),
      /navegador compartilhado entre clientes é proibido/
    );

    process.env.NODE_ENV = 'production';
    assert.throws(() => __test.validatedBrowserMode(), /compartilhado/);

    process.env.WA_BROWSER_MODE = 'isolated';
    assert.equal(__test.validatedBrowserMode(), 'isolated');
    process.env.WA_BROWSER_MODE = 'per-tenant';
    assert.equal(__test.validatedBrowserMode(), 'per-tenant');
  } finally {
    if (previousMode === undefined) delete process.env.WA_BROWSER_MODE;
    else process.env.WA_BROWSER_MODE = previousMode;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('web version pin is opt-in, validated and never strict', { concurrency: false }, () => {
  const previousPin = process.env.WA_WEB_VERSION;
  try {
    delete process.env.WA_WEB_VERSION;
    assert.deepEqual(__test.buildWebVersionPin(), {});

    process.env.WA_WEB_VERSION = '2.3000.1043126001';
    assert.deepEqual(__test.buildWebVersionPin(), {
      webVersion: '2.3000.1043126001',
      // strict:false é obrigatório: sem o HTML em cache a sessão precisa subir
      // na versão corrente — o pin nunca pode bloquear uma reconexão.
      webVersionCache: { type: 'local', strict: false }
    });

    process.env.WA_WEB_VERSION = 'latest; rm -rf /';
    assert.deepEqual(__test.buildWebVersionPin(), {});
  } finally {
    if (previousPin === undefined) delete process.env.WA_WEB_VERSION;
    else process.env.WA_WEB_VERSION = previousPin;
  }
});

test('client construction applies the optional web version pin', () => {
  assert.match(src, /puppeteer: buildClientPuppeteerOptions\(\{ isolated, proxyServer \}\),\s*\.\.\.buildWebVersionPin\(\)/);
});

test('resilient getChats patch skips unserializable chats instead of rejecting the whole list', { concurrency: false }, async () => {
  const windowMock = {
    require(name) {
      assert.equal(name, 'WAWebCollections');
      return { Chat: { getModelsArray: () => ['boa-1', 'venenosa-lid', 'boa-2'] } };
    },
    WWebJS: {
      // Comportamento upstream: Promise.all rejeita a lista inteira.
      getChats: async () => { throw new Error('r'); },
      getChatModel: async chat => {
        if (chat === 'venenosa-lid') throw new Error('r');
        return { id: chat };
      }
    }
  };
  const fakeClient = { pupPage: { evaluate: fn => Promise.resolve(fn()) } };
  const previousWindow = globalThis.window;
  globalThis.window = windowMock;
  try {
    await __test.applyResilientGetChatsPatch(999, {}, fakeClient);
    assert.equal(windowMock.WWebJS.getChats.__resilient, true);

    const chats = await windowMock.WWebJS.getChats();
    assert.deepEqual(chats, [{ id: 'boa-1' }, { id: 'boa-2' }]);
    assert.equal(windowMock.__wwebjsSkippedChats, 1);

    // Idempotente: reaplicar não re-embrulha a função já protegida.
    const patched = windowMock.WWebJS.getChats;
    await __test.applyResilientGetChatsPatch(999, {}, fakeClient);
    assert.equal(windowMock.WWebJS.getChats, patched);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('session ready reapplies the resilient getChats patch after page reinjection', () => {
  assert.match(src, /applyResilientGetChatsPatch\(tenantId,\s*session,\s*session\.client\)/);
});

test('logout removes only the target tenant credentials after logging out and destroying its client', async () => {
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-auth-logout-'));
  const targetPath = path.join(authRoot, 'tenant_1', 'session');
  const otherPath = path.join(authRoot, 'tenant_2', 'session');
  fs.mkdirSync(targetPath, { recursive: true });
  fs.mkdirSync(otherPath, { recursive: true });
  fs.writeFileSync(path.join(targetPath, 'credential.json'), 'tenant-one');
  fs.writeFileSync(path.join(otherPath, 'credential.json'), 'tenant-two');
  const calls = [];

  await __test.logoutTenantSessionResources(1, {
    client: {
      logout: async () => calls.push('logout'),
      destroy: async () => calls.push('destroy')
    }
  }, { authRoot });

  assert.deepEqual(calls, ['logout', 'destroy']);
  assert.equal(fs.existsSync(path.join(authRoot, 'tenant_1')), false);
  assert.equal(fs.existsSync(path.join(otherPath, 'credential.json')), true);
  assert.equal(fs.readFileSync(path.join(otherPath, 'credential.json'), 'utf8'), 'tenant-two');

  const destroyBody = src.match(/async function destroySession\(tenantId, \{ drainQueue = true \} = \{\}\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.doesNotMatch(destroyBody, /logoutTenantSessionResources|fsPromises\.rm|\.logout\(/);
  assert.match(src, /async function logoutSession\(tenantId\)[\s\S]*logoutTenantSessionResources\(normalizedTenantId, s\)/);
  fs.rmSync(authRoot, { recursive: true, force: true });
});

test('cache cleanup preserves WhatsApp credentials and tenant isolation', async t => {
  const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-auth-cache-cleanup-'));
  t.after(() => fs.rmSync(authRoot, { recursive: true, force: true }));
  const target = path.join(authRoot, 'tenant_31', 'session', 'Default');
  const other = path.join(authRoot, 'tenant_32', 'session', 'Default');
  for (const root of [target, other]) {
    fs.mkdirSync(path.join(root, 'Cache'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Code Cache'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Service Worker', 'CacheStorage'), { recursive: true });
    fs.mkdirSync(path.join(root, 'IndexedDB'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Cache', 'cache.bin'), 'discardable');
    fs.writeFileSync(path.join(root, 'Code Cache', 'code.bin'), 'discardable');
    fs.writeFileSync(path.join(root, 'Service Worker', 'CacheStorage', 'sw.bin'), 'discardable');
    fs.writeFileSync(path.join(root, 'IndexedDB', 'credentials.leveldb'), 'keep');
    fs.writeFileSync(path.join(root, 'Cookies'), 'keep');
  }

  await __test.cleanupDisposableAuthCaches(31, { authRoot });

  assert.equal(fs.existsSync(path.join(target, 'Cache')), false);
  assert.equal(fs.existsSync(path.join(target, 'Code Cache')), false);
  assert.equal(fs.existsSync(path.join(target, 'Service Worker', 'CacheStorage')), false);
  assert.equal(fs.readFileSync(path.join(target, 'IndexedDB', 'credentials.leveldb'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(target, 'Cookies'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(other, 'Cache', 'cache.bin')), true);
  assert.equal(fs.readFileSync(path.join(other, 'IndexedDB', 'credentials.leveldb'), 'utf8'), 'keep');
});

test('auth markers restore legacy and ready sessions but permanently skip an unpaired QR', { concurrency: false }, async () => {
  class FakeLocalAuth {}
  class FakeClient extends EventEmitter {
    async initialize() {}
    async destroy() {}
  }
  const log = { info() {}, warn() {}, error() {} };
  const legacyTenantId = 900000420;
  const emptyTenantId = 900000421;
  const markedTenantId = 900000422;

  try {
    await waManager.shutdown();
    __test.setClientConstructors({ Client: FakeClient, LocalAuth: FakeLocalAuth });
    await waManager.init({ logger: log, maxConcurrent: 1 });

    const legacyPath = __test.getTenantAuthPath(legacyTenantId);
    fs.mkdirSync(path.join(legacyPath, 'session'), { recursive: true });
    fs.writeFileSync(path.join(legacyPath, 'session', 'legacy.json'), '{}');
    fs.mkdirSync(__test.getTenantAuthPath(emptyTenantId), { recursive: true });
    assert.equal(await waManager.hasRestorableSession(legacyTenantId), true);
    assert.equal(await waManager.hasRestorableSession(emptyTenantId), false);
    assert.equal(await waManager.hasRestorableSession(900000499), false);

    await __test.persistAuthStateMarker(markedTenantId, 'ready');
    const client = await waManager.createSession(markedTenantId);
    const markers = __test.getAuthStateMarkerPaths(markedTenantId);
    client.emit('qr', 'qr-test');
    await __test.waitForAuthMarkerWrites(markedTenantId);
    assert.equal(fs.existsSync(markers.ready), false);
    assert.equal(fs.existsSync(markers.unpaired), true);
    assert.equal(await waManager.hasRestorableSession(markedTenantId), false);

    client.emit('ready');
    await __test.waitForAuthMarkerWrites(markedTenantId);
    assert.equal(fs.existsSync(markers.ready), true);
    assert.equal(fs.existsSync(markers.unpaired), false);
    assert.equal(await waManager.hasRestorableSession(markedTenantId), true);

    // Se um crash deixar os dois marcadores, o último ready conhecido prevalece.
    fs.writeFileSync(markers.unpaired, 'crash-window');
    assert.equal(await waManager.hasRestorableSession(markedTenantId), true);

    await waManager.logoutSession(markedTenantId);
    assert.equal(fs.existsSync(markers.authPath), false);
  } finally {
    await waManager.shutdown();
    __test.setClientConstructors();
  }
});

test('whatsapp manager supports per-tenant proxy without global credential leakage', () => {
  assert.match(src, /function buildChromiumLaunchArgs\(\{ proxyServer \} = \{\}\)/);
  assert.match(src, /const selectedProxy = proxyServer \|\| globalProxy/);
  assert.match(src, /--proxy-server=\$\{selectedProxy\}/);
  assert.match(src, /const proxyServer = deadSession\.proxyServer \|\| undefined/);
  assert.match(src, /proxyServer: next\.proxyServer \?\? current\.proxyServer \?\? null/);
  assert.match(src, /proxyConfigured: Boolean\(s\.proxyServer\)/);
});

test('whatsapp manager keeps chromium sandbox on in production unless explicitly disabled', () => {
  assert.match(src, /function shouldDisableChromiumSandbox\(\)/);
  assert.match(src, /process\.env\.NODE_ENV !== 'production' \|\| process\.env\.WA_NO_SANDBOX === 'true'/);
  assert.match(src, /args: buildChromiumLaunchArgs\(\{ proxyServer \}\)/);
  assert.doesNotMatch(src, /args:\s*\['--no-sandbox'/);
});

test('whatsapp manager monitors session health and reconnects stuck sessions', () => {
  assert.match(src, /function startHealthCheck\(\)/);
  assert.match(src, /for \(const \[tenantId, s\] of sessions\)/);
  assert.match(src, /client\.getState\(\)/);
  assert.match(src, /HEALTH_CHECK_MAX_FAILURES/);
  assert.match(src, /scheduleReconnect\(tenantId,\s*s\)/);
  assert.match(src, /Date\.now\(\) - s\.nonConnectedSince >= DEGRADED_RECONNECT_GRACE_MS/);
  assert.match(src, /s\.status = 'state_stuck'/);
  assert.match(src, /\['initializing', 'authenticated', 'syncing'\]\.includes\(s\.status\)/);
  assert.match(src, /client\.on\('loading_screen'/);
  assert.match(src, /lastProgressAt/);
  assert.match(src, /s\.healthCheckInFlight/);
});

test('whatsapp manager treats bad states as not ready and listens to message_create', () => {
  assert.match(src, /client\.on\('message_create'/);
  assert.match(src, /client\.on\('message'[\s\S]*if \(!s\.ready\) return/);
  assert.match(src, /client\.on\('message_create'[\s\S]*if \(!s\.ready\) return/);
  assert.match(src, /if \(!msg\?\.fromMe\) return/);
  assert.match(src, /invokeSessionHandler\(normalizedTenantId, s, 'message_create', s\.msgHandler, msg, s\.client, 'message_create'\)/);
  assert.match(src, /const reconnectableStates = \['CONFLICT', 'UNPAIRED', 'UNPAIRED_IDLE', 'TIMEOUT'\]/);
  assert.match(src, /s\.ready = false/);
});

test('whatsapp manager forwards archive changes only after the tenant session is ready', () => {
  const chat = { id: { _serialized: '120363000000@g.us' } };
  const client = { id: 'tenant-client' };
  const calls = [];
  const session = {
    ready: false,
    client,
    archiveHandler: (...args) => calls.push(args)
  };

  assert.equal(__test.dispatchArchiveEvent(session, chat, true, false), false);
  assert.deepEqual(calls, []);

  session.ready = true;
  assert.equal(__test.dispatchArchiveEvent(session, chat, true, false), true);
  assert.deepEqual(calls, [[chat, true, false, client]]);

  session.archiveHandler = null;
  assert.equal(__test.dispatchArchiveEvent(session, chat, false, true), false);
  assert.equal(calls.length, 1);
});

test('whatsapp manager registers and preserves archive handlers across every recreation path', () => {
  assert.match(src, /archiveHandler:\s*options\.onArchive \|\| null/);
  assert.match(src, /client\.on\('chat_archived', \(chat, currState, prevState\) => \{[\s\S]*if \(!s\.ready\) return;[\s\S]*dispatchArchiveEvent\(s, chat, currState, prevState\)/);
  assert.match(src, /const archiveHandler = deadSession\.archiveHandler;[\s\S]*onArchive:\s*archiveHandler/);
  assert.match(src, /function setArchiveHandler\(tenantId, handler\)/);
  assert.match(src, /async function startSession\(tenantId, \{/);
  assert.match(src, /if \(onArchive\) setArchiveHandler\(normalizedTenantId, onArchive\)/);
  assert.match(src, /const archiveHandler = s\.archiveHandler;[\s\S]*onArchive:\s*archiveHandler/);
  assert.match(src, /onArchive: next\.onArchive \|\| current\.onArchive \|\| null/);
  assert.match(src, /session\.archiveHandler = null/);
});

test('whatsapp manager preserves edit, revoke and urgent sync handlers across recreation paths', () => {
  assert.match(src, /editHandler:\s*options\.onMessageEdit \|\| null/);
  assert.match(src, /revokeHandler:\s*options\.onMessageRevoke \|\| null/);
  assert.match(src, /syncHandler:\s*options\.onSyncNeeded \|\| null/);
  assert.match(src, /const editHandler = deadSession\.editHandler;[\s\S]*onMessageEdit:\s*editHandler/);
  assert.match(src, /const revokeHandler = deadSession\.revokeHandler;[\s\S]*onMessageRevoke:\s*revokeHandler/);
  assert.match(src, /const syncHandler = deadSession\.syncHandler;[\s\S]*onSyncNeeded:\s*syncHandler/);
  assert.match(src, /const editHandler = s\.editHandler;[\s\S]*onMessageEdit:\s*editHandler/);
  assert.match(src, /const revokeHandler = s\.revokeHandler;[\s\S]*onMessageRevoke:\s*revokeHandler/);
  assert.match(src, /const syncHandler = s\.syncHandler;[\s\S]*onSyncNeeded:\s*syncHandler/);
  assert.match(src, /session\.editHandler = null/);
  assert.match(src, /session\.revokeHandler = null/);
  assert.match(src, /session\.syncHandler = null/);
});

test('whatsapp manager installs message handlers before client initialization and reconnection', () => {
  assert.match(src, /msgHandler:\s*options\.onMessage \|\| null/);
  assert.match(src, /ackHandler:\s*options\.onAck \|\| null/);
  assert.match(src, /archiveHandler:\s*options\.onArchive \|\| null/);
  assert.match(src, /createSession\(normalizedTenantId,\s*\{[\s\S]*onMessage:\s*handler,[\s\S]*onAck:\s*ackHandler/);
});

test('whatsapp manager retries browser initialization failures without QR reset', () => {
  assert.match(src, /function isRetryableInitializationError\(err\)/);
  assert.match(src, /Target closed\|Protocol error/);
  assert.match(src, /s\.status = 'initialize_failed'/);
  assert.match(src, /retryableSignature: isRetryableInitializationError\(err\)[\s\S]*scheduleReconnect\(normalizedTenantId, s\)/);
  assert.match(src, /deadSession\.reconnectTimer/);
});

test('tenant identifiers are canonical and cannot escape their auth directory', () => {
  assert.equal(__test.normalizeTenantId('7'), 7);
  assert.throws(() => __test.normalizeTenantId('../2'), /tenantId inválido/);
  assert.throws(() => __test.normalizeTenantId(0), /tenantId inválido/);
  assert.throws(() => __test.normalizeTenantId(1.5), /tenantId inválido/);
});

test('session capacity is validated and enforced through an observable FIFO queue', () => {
  assert.equal(__test.normalizeMaxSessions(5), 5);
  assert.throws(() => __test.normalizeMaxSessions(0), /inteiro positivo/);
  assert.throws(() => __test.normalizeMaxSessions(2.5), /inteiro positivo/);
  assert.match(src, /if \(!hasReservation && !hasSessionCapacity\(\)\) \{[\s\S]*enqueueSession\(normalizedTenantId, options\)/);
  assert.match(src, /function drainSessionQueue\(\)/);
  assert.match(src, /pendingSessions\.entries\(\)\.next\(\)\.value/);
  assert.match(src, /sessions\.set\(normalizedTenantId, s\);[\s\S]*await cleanupDisposableAuthCaches\(normalizedTenantId\)/);
  assert.match(src, /status: 'queued_capacity'/);
  assert.doesNotMatch(src, /Sessões WhatsApp acima do limite recomendado/);
});

test('capacity queue admits the next tenant only after a real slot is released', { concurrency: false }, async () => {
  const previousMode = process.env.WA_BROWSER_MODE;
  const created = [];
  class FakeLocalAuth {
    constructor(options) { this.options = options; }
  }
  class FakeClient extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      created.push(this);
    }

    async initialize() { this.emit('ready'); }
    async destroy() { this.destroyed = true; }
  }
  const log = { info() {}, warn() {}, error() {} };

  try {
    process.env.WA_BROWSER_MODE = 'isolated';
    await waManager.shutdown();
    __test.setClientConstructors({ Client: FakeClient, LocalAuth: FakeLocalAuth });
    await waManager.init({ logger: log, maxConcurrent: 1 });

    assert.ok(await waManager.createSession(101));
    assert.equal(await waManager.createSession(202), null);
    assert.equal(waManager.getStatus(202).status, 'queued_capacity');
    assert.equal(waManager.getStatus(202).queuePosition, 1);
    assert.deepEqual(__test.getCapacitySnapshot(), {
      active: 1,
      queued: 1,
      reserved: 0,
      tearingDown: 0,
      max: 1
    });

    await waManager.destroySession(101);
    // A vaga fica reservada de forma síncrona, antes da limpeza assíncrona do
    // cache. A prontidão real pode levar alguns ciclos de I/O e deve ser
    // observada por estado, não por um único setImmediate arbitrário.
    assert.ok(waManager.getSession(202));
    const readyDeadline = Date.now() + 1000;
    while (!waManager.getStatus(202).ready && Date.now() < readyDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(waManager.getStatus(202).ready, true);
    assert.deepEqual(__test.getCapacitySnapshot(), {
      active: 1,
      queued: 0,
      reserved: 0,
      tearingDown: 0,
      max: 1
    });
    assert.equal(created.length, 2);
  } finally {
    await waManager.shutdown();
    __test.setClientConstructors();
    if (previousMode === undefined) delete process.env.WA_BROWSER_MODE;
    else process.env.WA_BROWSER_MODE = previousMode;
  }
});

test('reconnection never exhausts and uses capped exponential backoff with jitter', () => {
  const first = __test.calculateReconnectDelay(1, () => 0.5);
  const veryLate = __test.calculateReconnectDelay(10_000, () => 0.5);
  const lowJitter = __test.calculateReconnectDelay(10_000, () => 0);
  const highJitter = __test.calculateReconnectDelay(10_000, () => 1);

  assert.equal(first, 5000);
  assert.ok(veryLate <= 60000);
  assert.ok(lowJitter < highJitter);
  assert.ok(highJitter <= 60000);
  assert.match(src, /nunca limita o total de reconexões/);
  assert.match(src, /deadSession\.reconnectTotal = \(deadSession\.reconnectTotal \|\| 0\) \+ 1/);
  assert.doesNotMatch(src, /attempts > RECONNECT_MAX_ATTEMPTS/);
});

test('high-attempt reconnect remains scheduled but terminal account states cancel it', { concurrency: false }, async () => {
  const previousMode = process.env.WA_BROWSER_MODE;
  class FakeLocalAuth {}
  class FakeClient extends EventEmitter {
    async initialize() { this.emit('ready'); }
    async destroy() {}
  }
  const log = { info() {}, warn() {}, error() {} };

  try {
    process.env.WA_BROWSER_MODE = 'isolated';
    await waManager.shutdown();
    __test.setClientConstructors({ Client: FakeClient, LocalAuth: FakeLocalAuth });
    await waManager.init({ logger: log, maxConcurrent: 1 });
    const client = await waManager.createSession(303);
    const session = waManager.getSession(303);
    session.reconnectAttempts = 10_000;

    client.emit('disconnected', 'network failure');
    let status = waManager.getStatus(303);
    assert.equal(status.status, 'reconnect_scheduled');
    assert.equal(status.reconnectAttempts, 10_001);
    assert.ok(status.nextReconnectAt);
    assert.equal(status.requiresManualAction, false);

    client.emit('change_state', 'TOS_BLOCK');
    status = waManager.getStatus(303);
    assert.equal(status.status, 'tos_block');
    assert.equal(status.nextReconnectAt, null);
    assert.equal(status.requiresManualAction, true);
  } finally {
    await waManager.shutdown();
    __test.setClientConstructors();
    if (previousMode === undefined) delete process.env.WA_BROWSER_MODE;
    else process.env.WA_BROWSER_MODE = previousMode;
  }
});

test('a previously ready session cancels reconnect when the same client recovers CONNECTED', { concurrency: false }, async () => {
  const previousMode = process.env.WA_BROWSER_MODE;
  let destroyCalls = 0;
  class FakeLocalAuth {}
  class FakeClient extends EventEmitter {
    async initialize() { this.emit('ready'); }
    async destroy() { destroyCalls += 1; }
  }
  const log = { info() {}, warn() {}, error() {} };

  try {
    process.env.WA_BROWSER_MODE = 'isolated';
    await waManager.shutdown();
    __test.setClientConstructors({ Client: FakeClient, LocalAuth: FakeLocalAuth });
    await waManager.init({ logger: log, maxConcurrent: 1 });
    const client = await waManager.createSession(404);

    client.emit('change_state', 'CONFLICT');
    assert.equal(waManager.getStatus(404).ready, false);
    assert.ok(waManager.getStatus(404).nextReconnectAt);

    client.emit('change_state', 'CONNECTED');
    const recovered = waManager.getStatus(404);
    assert.equal(recovered.ready, true);
    assert.equal(recovered.status, 'ready');
    assert.equal(recovered.nextReconnectAt, null);
    assert.equal(waManager.getReadyClient(404), client);
    assert.equal(destroyCalls, 0);
  } finally {
    await waManager.shutdown();
    __test.setClientConstructors();
    if (previousMode === undefined) delete process.env.WA_BROWSER_MODE;
    else process.env.WA_BROWSER_MODE = previousMode;
  }
});

test('repeated CONNECTED while already ready does not emit a false recovery', { concurrency: false }, async () => {
  const previousMode = process.env.WA_BROWSER_MODE;
  class FakeLocalAuth {}
  class FakeClient extends EventEmitter {
    async initialize() { this.emit('ready'); }
    async destroy() {}
  }
  const statusEvents = [];
  const infoMessages = [];
  const log = {
    info(_context, message) { infoMessages.push(message); },
    warn() {},
    error() {}
  };

  try {
    process.env.WA_BROWSER_MODE = 'isolated';
    await waManager.shutdown();
    __test.setClientConstructors({ Client: FakeClient, LocalAuth: FakeLocalAuth });
    await waManager.init({
      logger: log,
      maxConcurrent: 1,
      onStatusChange: (tenantId, status) => statusEvents.push({ tenantId, status })
    });
    const client = await waManager.createSession(410);
    const readyAt = waManager.getStatus(410).lastReadyAt;
    const eventCount = statusEvents.length;
    const recoveryLogCount = infoMessages.filter(message => /recuperou CONNECTED/.test(message || '')).length;

    await new Promise(resolve => setTimeout(resolve, 5));
    client.emit('change_state', 'CONNECTED');
    client.emit('change_state', 'CONNECTED');

    assert.equal(waManager.getStatus(410).lastReadyAt, readyAt);
    assert.equal(statusEvents.length, eventCount);
    assert.equal(
      infoMessages.filter(message => /recuperou CONNECTED/.test(message || '')).length,
      recoveryLogCount
    );
  } finally {
    await waManager.shutdown();
    __test.setClientConstructors();
    if (previousMode === undefined) delete process.env.WA_BROWSER_MODE;
    else process.env.WA_BROWSER_MODE = previousMode;
  }
});

test('loading progress keeps an authenticated session observable as syncing', { concurrency: false }, async () => {
  const previousMode = process.env.WA_BROWSER_MODE;
  class FakeLocalAuth {}
  class FakeClient extends EventEmitter {
    async initialize() {}
    async destroy() {}
  }
  const log = { info() {}, warn() {}, error() {} };

  try {
    process.env.WA_BROWSER_MODE = 'isolated';
    await waManager.shutdown();
    __test.setClientConstructors({ Client: FakeClient, LocalAuth: FakeLocalAuth });
    await waManager.init({ logger: log, maxConcurrent: 1 });
    const client = await waManager.createSession(405);
    client.emit('authenticated');
    client.emit('loading_screen', 20, 'Sincronizando mensagens');
    const first = waManager.getStatus(405);
    client.emit('loading_screen', 80, 'Sincronizando mensagens');
    const second = waManager.getStatus(405);

    assert.equal(second.ready, false);
    assert.equal(second.status, 'syncing');
    assert.equal(second.loadingPercent, 80);
    assert.equal(second.loadingMessage, 'Sincronizando mensagens');
    assert.ok(Date.parse(second.lastProgressAt) >= Date.parse(first.lastProgressAt));

    await new Promise(resolve => setTimeout(resolve, 5));
    client.emit('loading_screen', 80, 'Sincronizando mensagens');
    const heartbeat = waManager.getStatus(405);
    assert.ok(Date.parse(heartbeat.lastProgressAt) > Date.parse(second.lastProgressAt));
  } finally {
    await waManager.shutdown();
    __test.setClientConstructors();
    if (previousMode === undefined) delete process.env.WA_BROWSER_MODE;
    else process.env.WA_BROWSER_MODE = previousMode;
  }
});

test('edit, revoke and ciphertext failure events reach the isolated tenant handlers', { concurrency: false }, async () => {
  const previousMode = process.env.WA_BROWSER_MODE;
  class FakeLocalAuth {}
  class FakeClient extends EventEmitter {
    async initialize() { this.emit('ready'); }
    async destroy() {}
  }
  const calls = [];
  const log = { info() {}, warn() {}, error() {} };

  try {
    process.env.WA_BROWSER_MODE = 'isolated';
    await waManager.shutdown();
    __test.setClientConstructors({ Client: FakeClient, LocalAuth: FakeLocalAuth });
    await waManager.init({ logger: log, maxConcurrent: 1 });
    const client = await waManager.createSession(406, {
      onMessageEdit: (...args) => calls.push(['edit', ...args]),
      onMessageRevoke: (...args) => calls.push(['revoke', ...args]),
      onSyncNeeded: (...args) => calls.push(['sync', ...args])
    });
    const edited = { id: 'edited' };
    const revoked = { id: 'revoked' };
    const original = { id: 'original' };
    const ciphertext = { id: 'ciphertext' };

    client.emit('message_edit', edited, 'novo', 'antigo');
    client.emit('message_revoke_everyone', revoked, original);
    client.emit('message_ciphertext_failed', ciphertext);

    assert.deepEqual(calls, [
      ['edit', edited, 'novo', 'antigo', client],
      ['revoke', revoked, original, client],
      ['sync', 'message_ciphertext_failed', ciphertext, client]
    ]);
  } finally {
    await waManager.shutdown();
    __test.setClientConstructors();
    if (previousMode === undefined) delete process.env.WA_BROWSER_MODE;
    else process.env.WA_BROWSER_MODE = previousMode;
  }
});

test('a replacement client waits for the previous tenant teardown', { concurrency: false }, async () => {
  const previousMode = process.env.WA_BROWSER_MODE;
  let releaseDestroy;
  const destroyGate = new Promise(resolve => { releaseDestroy = resolve; });
  const clients = [];
  class FakeLocalAuth {}
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      clients.push(this);
    }

    async initialize() { this.emit('ready'); }
    async destroy() { await destroyGate; }
  }
  const log = { info() {}, warn() {}, error() {} };

  try {
    process.env.WA_BROWSER_MODE = 'isolated';
    await waManager.shutdown();
    __test.setClientConstructors({ Client: FakeClient, LocalAuth: FakeLocalAuth });
    await waManager.init({ logger: log, maxConcurrent: 1 });
    await waManager.createSession(407);

    const destroying = waManager.destroySession(407, { drainQueue: false });
    const replacing = waManager.createSession(407);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(clients.length, 1);
    assert.equal(__test.getCapacitySnapshot().tearingDown, 1);

    releaseDestroy();
    await destroying;
    const replacement = await replacing;
    assert.equal(clients.length, 2);
    assert.equal(replacement, clients[1]);
    assert.equal(waManager.getReadyClient(407), clients[1]);
    assert.equal(__test.getCapacitySnapshot().tearingDown, 0);
  } finally {
    releaseDestroy();
    await waManager.shutdown();
    __test.setClientConstructors();
    if (previousMode === undefined) delete process.env.WA_BROWSER_MODE;
    else process.env.WA_BROWSER_MODE = previousMode;
  }
});

test('teardown force-kills Chromium after a graceful destroy timeout', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = signal => {
    assert.equal(signal, 'SIGKILL');
    child.killed = true;
    setImmediate(() => child.emit('exit', null, signal));
    return true;
  };
  const result = await __test.terminateClientBrowser({
    destroy: () => new Promise(() => {}),
    pupBrowser: { process: () => child }
  }, { timeoutMs: 5, forceKillTimeoutMs: 50 });

  assert.deepEqual(result, { graceful: false, forced: true });
  assert.equal(child.killed, true);
});

test('teardown fails closed when Chromium termination cannot be confirmed', async () => {
  await assert.rejects(
    __test.terminateClientBrowser({
      destroy: () => new Promise(() => {})
    }, { timeoutMs: 5, forceKillTimeoutMs: 5 }),
    error => error.code === 'WA_TEARDOWN_UNCONFIRMED'
      && error.cause?.code === 'OPERATION_TIMEOUT'
  );
});

test('explicit logout cancels an automatic recreation already in flight', { concurrency: false }, async () => {
  const previousMode = process.env.WA_BROWSER_MODE;
  let releaseDestroy;
  const destroyGate = new Promise(resolve => { releaseDestroy = resolve; });
  const clients = [];
  class FakeLocalAuth {}
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      clients.push(this);
    }

    async initialize() { this.emit('ready'); }
    async destroy() { await destroyGate; }
  }
  const log = { info() {}, warn() {}, error() {} };
  const tenantId = 900000408;

  try {
    process.env.WA_BROWSER_MODE = 'isolated';
    await waManager.shutdown();
    __test.setClientConstructors({ Client: FakeClient, LocalAuth: FakeLocalAuth });
    await waManager.init({ logger: log, maxConcurrent: 1 });
    await waManager.createSession(tenantId);
    const staleSession = waManager.getSession(tenantId);

    const recreating = __test.recreateStuckSession(tenantId, staleSession, 'test');
    const loggingOut = waManager.logoutSession(tenantId);
    releaseDestroy();
    await Promise.all([recreating, loggingOut]);

    assert.equal(clients.length, 1);
    assert.equal(waManager.getSession(tenantId), null);
    assert.equal(waManager.getStatus(tenantId).status, 'disconnected');
  } finally {
    releaseDestroy();
    await waManager.shutdown();
    __test.setClientConstructors();
    if (previousMode === undefined) delete process.env.WA_BROWSER_MODE;
    else process.env.WA_BROWSER_MODE = previousMode;
  }
});

test('reported runtime failure restarts only the exact active client', { concurrency: false }, async () => {
  const previousMode = process.env.WA_BROWSER_MODE;
  class FakeLocalAuth {}
  class FakeClient extends EventEmitter {
    async initialize() { this.emit('ready'); }
    async destroy() {}
  }
  const log = { info() {}, warn() {}, error() {} };
  const tenantId = 900000409;

  try {
    process.env.WA_BROWSER_MODE = 'isolated';
    await waManager.shutdown();
    __test.setClientConstructors({ Client: FakeClient, LocalAuth: FakeLocalAuth });
    await waManager.init({ logger: log, maxConcurrent: 1 });
    const client = await waManager.createSession(tenantId);

    assert.equal(
      waManager.reportSessionRuntimeError(tenantId, new Error('timeout antigo'), {}),
      false
    );
    assert.equal(waManager.getStatus(tenantId).ready, true);

    assert.equal(
      waManager.reportSessionRuntimeError(tenantId, new Error('getChats timeout'), client),
      true
    );
    const recovering = waManager.getStatus(tenantId);
    assert.equal(recovering.ready, false);
    assert.equal(recovering.status, 'reconnect_scheduled');
    assert.equal(recovering.error, 'getChats timeout');
    assert.ok(recovering.nextReconnectAt);

    // Relato repetido é idempotente e mantém o timer de recuperação existente.
    const scheduledAt = recovering.nextReconnectAt;
    assert.equal(waManager.reportSessionRuntimeError(tenantId, new Error('repetido'), client), true);
    assert.equal(waManager.getStatus(tenantId).nextReconnectAt, scheduledAt);
  } finally {
    await waManager.shutdown();
    __test.setClientConstructors();
    if (previousMode === undefined) delete process.env.WA_BROWSER_MODE;
    else process.env.WA_BROWSER_MODE = previousMode;
  }
});

test('session option updates preserve every tenant handler while queued', () => {
  const one = () => 1;
  const two = () => 2;
  const merged = __test.mergeSessionOptions(
    { proxyServer: 'http://old', onMessage: one, onAck: one },
    { onMessage: two }
  );
  assert.equal(merged.proxyServer, 'http://old');
  assert.equal(merged.onMessage, two);
  assert.equal(merged.onAck, one);
  assert.equal(merged.onArchive, null);
  assert.equal(merged.onMessageEdit, null);
  assert.equal(merged.onMessageRevoke, null);
  assert.equal(merged.onSyncNeeded, null);
});

test('rejected async business handlers are contained', async () => {
  const expected = new Error('handler failure');
  assert.equal(__test.invokeSessionHandler(999, {}, 'message', async () => {
    throw expected;
  }), true);
  await new Promise(resolve => setImmediate(resolve));
});

test('whatsapp manager contains rejected async navigation listeners', async () => {
  const expected = new Error('Protocol error (Runtime.callFunctionOn): Execution context was destroyed.');
  let handled = null;
  const guarded = __test.guardAsyncListener(async () => {
    throw expected;
  }, err => {
    handled = err;
  });

  assert.equal(guarded(), undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handled, expected);
  assert.equal(__test.isRetryableInitializationError(expected), true);
});

test('whatsapp manager replaces page navigation listeners with guarded wrappers', () => {
  const original = async () => {};
  const listeners = [original];
  const page = {
    listeners: event => event === 'framenavigated' ? [...listeners] : [],
    removeListener: (_event, listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    on: (_event, listener) => listeners.push(listener)
  };

  assert.equal(__test.installPageNavigationGuard(3, {}, { pupPage: page }), 1);
  assert.equal(listeners.length, 1);
  assert.notEqual(listeners[0], original);
  assert.equal(__test.installPageNavigationGuard(3, {}, { pupPage: page }), 0);
});

test('verification monitor reads both synchronous Puppeteer URLs and async-compatible URLs', async () => {
  assert.equal(
    await __test.readPageUrl({ url: () => 'https://web.whatsapp.com/checkpoint' }),
    'https://web.whatsapp.com/checkpoint'
  );
  assert.equal(
    await __test.readPageUrl({ url: async () => 'https://web.whatsapp.com/' }),
    'https://web.whatsapp.com/'
  );
});

test('whatsapp manager does not spoof browser fingerprints in application code', () => {
  assert.doesNotMatch(src, /function hashString/);
  assert.doesNotMatch(src, /function seededRandom/);
  assert.doesNotMatch(src, /function randomizeUA/);
  assert.doesNotMatch(src, /HTMLCanvasElement/);
  assert.doesNotMatch(src, /WebGLRenderingContext/);
  assert.doesNotMatch(src, /AudioContext/);
});

test('whatsapp pairing QR is never printed into production logs', () => {
  assert.match(src, /process\.env\.NODE_ENV !== 'production' && process\.env\.WA_PRINT_QR_TO_TERMINAL === 'true'/);
  assert.match(src, /qrcode\.generate\(qr, \{ small: true \}\)/);
});
