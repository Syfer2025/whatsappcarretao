// Gerenciador multi-sessão WhatsApp.
//
// Cada tenant tem seu próprio número, diretório de autenticação e processo de
// navegador. Compartilhar navegador entre tenants é deliberadamente proibido:
// economizar RAM não pode reduzir a fronteira de isolamento entre clientes.

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fsPromises = require('fs/promises');
const { withTimeout } = require('./runtimeUtils');

const AUTH_ROOT = path.resolve(process.env.WA_AUTH_DIR || path.join(__dirname, '.wwebjs_auth'));

function positiveEnvNumber(name, fallback, { integer = false } = {}) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    return fallback;
  }
  return value;
}

const RECONNECT_BASE_MS = positiveEnvNumber('WA_RECONNECT_BASE_MS', 5000);
const RECONNECT_MAX_MS = positiveEnvNumber('WA_RECONNECT_MAX_MS', 60000);
// Mantém compatibilidade com o nome antigo da variável. O valor agora limita
// apenas os degraus do backoff; nunca limita o total de reconexões.
const RECONNECT_BACKOFF_STEPS = positiveEnvNumber('WA_RECONNECT_MAX_ATTEMPTS', 5, { integer: true });
const WHATSAPP_INIT_TIMEOUT_MS = positiveEnvNumber('WHATSAPP_INIT_TIMEOUT_MS', 60000);
const HEALTH_CHECK_INTERVAL_MS = positiveEnvNumber('WA_HEALTH_CHECK_INTERVAL_MS', 30000);
const STATE_STUCK_TIMEOUT_MS = positiveEnvNumber('WA_STATE_STUCK_TIMEOUT_MS', 120000);
const DEGRADED_RECONNECT_GRACE_MS = positiveEnvNumber('WA_DEGRADED_RECONNECT_GRACE_MS', 30000);
const HEALTH_CHECK_TIMEOUT_MS = positiveEnvNumber('WA_HEALTH_CHECK_TIMEOUT_MS', 10000);
const HEALTH_CHECK_MAX_FAILURES = positiveEnvNumber('WA_HEALTH_CHECK_MAX_FAILURES', 2, { integer: true });
const FALLBACK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const GUARDED_ASYNC_LISTENER = Symbol('guardedAsyncListener');
const AUTH_STATE_MARKERS = Object.freeze({
  ready: '.ready',
  unpaired: '.unpaired'
});
// Somente caches descartáveis do Chromium. Cookies, Local Storage e IndexedDB
// (que sustentam a autenticação do WhatsApp) nunca entram nesta lista.
const DISPOSABLE_AUTH_CACHE_PATHS = Object.freeze([
  ['session', 'Default', 'Cache'],
  ['session', 'Default', 'Code Cache'],
  ['session', 'Default', 'GPUCache'],
  ['session', 'Default', 'DawnGraphiteCache'],
  ['session', 'Default', 'DawnWebGPUCache'],
  ['session', 'Default', 'Service Worker', 'CacheStorage'],
  ['session', 'Default', 'blob_storage'],
  ['session', 'GraphiteDawnCache'],
  ['session', 'component_crx_cache'],
  // Locks de instância única do Chrome. Um container recriado herda os locks do
  // hostname anterior e o Chromium recusa abrir o perfil ("profile appears to
  // be in use by another Chromium process ... on another computer"), travando a
  // reconexão para sempre. Remover aqui é seguro: o manager garante que nunca
  // há outro Chromium vivo usando este diretório quando o client é criado.
  ['session', 'SingletonLock'],
  ['session', 'SingletonSocket'],
  ['session', 'SingletonCookie']
]);

const sessions = new Map();
const pendingSessions = new Map();
const capacityReservations = new Set();
// Um novo Chromium nunca deve abrir o mesmo diretório LocalAuth enquanto o
// cliente anterior ainda está encerrando ou removendo credenciais. A barreira
// é por tenant: não reduz o paralelismo entre clientes diferentes.
const teardownBarriers = new Map();
const authMarkerTails = new Map();
// Logout explícito invalida qualquer rotina automática de recuperação que já
// tenha começado. Sem esse epoch, um reconnect em voo poderia recriar a sessão
// logo depois que o operador pediu para desconectá-la.
const lifecycleEpochs = new Map();

let ClientConstructor = Client;
let LocalAuthConstructor = LocalAuth;
let logger = null;
let maxSessions = 5;
let onStatusChange = null;
let realUserAgent = null;
let healthCheckTimer = null;
let drainingSessionQueue = false;
let shuttingDown = false;

function browserMode() {
  return String(process.env.WA_BROWSER_MODE || 'isolated').trim().toLowerCase();
}

function validatedBrowserMode() {
  const mode = browserMode();
  if (!['isolated', 'per-tenant'].includes(mode)) {
    throw new Error('WA_BROWSER_MODE deve ser isolated ou per-tenant; navegador compartilhado entre clientes é proibido');
  }
  return mode;
}

function isIsolatedBrowserMode() {
  return ['isolated', 'per-tenant'].includes(validatedBrowserMode());
}

function getTenantAuthPath(tenantId, authRoot = AUTH_ROOT) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  return path.join(authRoot, `tenant_${normalizedTenantId}`);
}

function getAuthStateMarkerPaths(tenantId, authRoot = AUTH_ROOT) {
  const authPath = getTenantAuthPath(tenantId, authRoot);
  return {
    authPath,
    ready: path.join(authPath, AUTH_STATE_MARKERS.ready),
    unpaired: path.join(authPath, AUTH_STATE_MARKERS.unpaired)
  };
}

async function cleanupDisposableAuthCaches(tenantId, { authRoot = AUTH_ROOT } = {}) {
  const authPath = getTenantAuthPath(tenantId, authRoot);
  let removed = 0;
  for (const segments of DISPOSABLE_AUTH_CACHE_PATHS) {
    const target = path.join(authPath, ...segments);
    try {
      await fsPromises.rm(target, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      error.message = `Falha ao limpar cache descartavel ${segments.join('/')}: ${error.message}`;
      throw error;
    }
  }
  return { tenantId: normalizeTenantId(tenantId), removed };
}

function normalizeTenantId(tenantId) {
  const normalizedTenantId = Number(tenantId);
  if (!Number.isSafeInteger(normalizedTenantId) || normalizedTenantId <= 0) {
    throw new Error('tenantId inválido');
  }
  return normalizedTenantId;
}

function normalizeMaxSessions(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error('maxConcurrent deve ser um inteiro positivo');
  }
  return normalized;
}

function capacityInUse() {
  return sessions.size + capacityReservations.size;
}

function hasSessionCapacity() {
  return capacityInUse() < maxSessions;
}

function queuePosition(tenantId) {
  return [...pendingSessions.keys()].indexOf(tenantId) + 1;
}

function registerTenantTeardown(tenantId, operation) {
  const previous = teardownBarriers.get(tenantId);
  let operationPromise;
  if (previous) {
    operationPromise = previous.catch(() => {}).then(operation);
  } else {
    try {
      // Executa a parte síncrona imediatamente. Assim, a sessão é destacada e
      // client.destroy() começa antes que outra chamada possa criar o tenant.
      operationPromise = Promise.resolve(operation());
    } catch (err) {
      operationPromise = Promise.reject(err);
    }
  }

  let trackedPromise;
  trackedPromise = operationPromise.finally(() => {
    if (teardownBarriers.get(tenantId) === trackedPromise) {
      teardownBarriers.delete(tenantId);
    }
  });
  teardownBarriers.set(tenantId, trackedPromise);
  return trackedPromise;
}

async function waitForTenantTeardown(tenantId) {
  const barrier = teardownBarriers.get(tenantId);
  if (barrier) await barrier;
}

function persistAuthStateMarker(tenantId, state, { authRoot = AUTH_ROOT } = {}) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  if (!Object.hasOwn(AUTH_STATE_MARKERS, state)) {
    return Promise.reject(new Error('Estado de autenticação inválido'));
  }

  const previous = authMarkerTails.get(normalizedTenantId);
  const operation = (previous ? previous.catch(() => {}) : Promise.resolve()).then(async () => {
    const markers = getAuthStateMarkerPaths(normalizedTenantId, authRoot);
    const selected = markers[state];
    const obsolete = state === 'ready' ? markers.unpaired : markers.ready;
    await fsPromises.mkdir(markers.authPath, { recursive: true });
    // Criar o novo marcador antes de remover o anterior torna a transição
    // conservadora: se o processo cair entre as operações, `ready` prevalece.
    await fsPromises.writeFile(selected, `${new Date().toISOString()}\n`, { mode: 0o600 });
    await fsPromises.rm(obsolete, { force: true });
  });

  let trackedPromise;
  trackedPromise = operation.finally(() => {
    if (authMarkerTails.get(normalizedTenantId) === trackedPromise) {
      authMarkerTails.delete(normalizedTenantId);
    }
  });
  authMarkerTails.set(normalizedTenantId, trackedPromise);
  return trackedPromise;
}

async function waitForAuthMarkerWrites(tenantId) {
  const markerWrite = authMarkerTails.get(normalizeTenantId(tenantId));
  if (markerWrite) await markerWrite;
}

async function hasRestorableSession(tenantId) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  await waitForAuthMarkerWrites(normalizedTenantId);
  const markers = getAuthStateMarkerPaths(normalizedTenantId);
  let entries;
  try {
    entries = await fsPromises.readdir(markers.authPath);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return false;
    throw err;
  }

  const names = new Set(entries);
  if (names.has(AUTH_STATE_MARKERS.ready)) return true;
  if (names.has(AUTH_STATE_MARKERS.unpaired)) return false;
  // Compatibilidade de rollout: diretórios antigos e não vazios recebem uma
  // tentativa. Se ela chegar ao QR, o evento gravará `unpaired`; se conectar,
  // gravará `ready`, eliminando a ambiguidade nos próximos boots.
  return entries.length > 0;
}

function recordAuthState(tenantId, state) {
  persistAuthStateMarker(tenantId, state).catch(err => {
    logger?.warn({ err, tenantId, state }, 'Falha ao persistir estado de autenticação WhatsApp');
  });
}

function currentLifecycleEpoch(tenantId) {
  return lifecycleEpochs.get(tenantId) || 0;
}

function invalidateAutomaticRecovery(tenantId) {
  const nextEpoch = currentLifecycleEpoch(tenantId) + 1;
  lifecycleEpochs.set(tenantId, nextEpoch);
  return nextEpoch;
}

function mergeSessionOptions(current = {}, next = {}) {
  return {
    proxyServer: next.proxyServer ?? current.proxyServer ?? null,
    onMessage: next.onMessage || current.onMessage || null,
    onAck: next.onAck || current.onAck || null,
    onArchive: next.onArchive || current.onArchive || null,
    onMessageEdit: next.onMessageEdit || current.onMessageEdit || null,
    onMessageRevoke: next.onMessageRevoke || current.onMessageRevoke || null,
    onSyncNeeded: next.onSyncNeeded || current.onSyncNeeded || null
  };
}

function calculateReconnectDelay(attempt, random = Math.random) {
  const normalizedAttempt = Math.max(1, Number(attempt) || 1);
  const backoffStep = Math.min(normalizedAttempt, RECONNECT_BACKOFF_STEPS);
  const exponentialDelay = Math.min(
    RECONNECT_BASE_MS * 2 ** (backoffStep - 1),
    RECONNECT_MAX_MS
  );
  // +/- 20% evita que muitas sessões derrubadas juntas reconectem no mesmo ms.
  const jitterFactor = 0.8 + (Math.max(0, Math.min(1, Number(random()) || 0)) * 0.4);
  return Math.max(1, Math.min(RECONNECT_MAX_MS, Math.round(exponentialDelay * jitterFactor)));
}

function blockAutomaticReconnect(session) {
  if (!session) return;
  session.autoReconnectBlocked = true;
  session.nextReconnectAt = null;
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
}

function shouldDisableChromiumSandbox() {
  return process.env.NODE_ENV !== 'production' || process.env.WA_NO_SANDBOX === 'true';
}

// O LOGOUT do WhatsApp Web destrói o frame enquanto o whatsapp-web.js ainda
// está injetando (Client.inject). A rejeição escapa como unhandledRejection e,
// sem casar aqui, derruba o servidor inteiro em vez de só reconectar a sessão.
function isRetryableInitializationError(err) {
  const message = String(err?.message || err || '');
  return /Target closed|Protocol error|Session closed|browser has disconnected|Connection closed|WebSocket is not open|ECONNRESET|ECONNREFUSED|Failed to launch|Chrome|Chromium|detached Frame|Execution context was destroyed|Execution context is not available|Target crashed|Navigating frame was detached/i.test(message);
}

function isAlreadyClosedBrowserError(err) {
  return /not open|already closed|Target closed|browser has disconnected|Connection closed|Session closed/i
    .test(String(err?.message || err || ''));
}

async function forceKillBrowserProcess(client, timeoutMs = 3000) {
  let child = null;
  try { child = client?.pupBrowser?.process?.() || null; } catch {}
  if (!child || typeof child.kill !== 'function') return false;
  if (child.exitCode !== null && child.exitCode !== undefined) return true;
  if (typeof child.once !== 'function') return false;

  let onExit;
  const exited = new Promise(resolve => {
    onExit = () => resolve(true);
    child.once('exit', onExit);
    child.once('close', onExit);
  });
  try {
    const signalSent = child.kill('SIGKILL');
    if (signalSent === false && !child.killed) return false;
    await withTimeout(exited, timeoutMs, 'Encerramento forçado do Chromium');
    return true;
  } catch {
    return false;
  } finally {
    child.off?.('exit', onExit);
    child.off?.('close', onExit);
  }
}

async function terminateClientBrowser(client, {
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
  forceKillTimeoutMs = Math.min(3000, HEALTH_CHECK_TIMEOUT_MS)
} = {}) {
  if (typeof client?.destroy !== 'function') return { graceful: true, forced: false };
  try {
    await withTimeout(client.destroy(), timeoutMs, 'Destruir sessão WhatsApp');
    return { graceful: true, forced: false };
  } catch (error) {
    if (isAlreadyClosedBrowserError(error)) {
      return { graceful: false, forced: false, alreadyClosed: true };
    }
    if (await forceKillBrowserProcess(client, forceKillTimeoutMs)) {
      logger?.warn({ err: error }, 'Chromium não encerrou graciosamente e recebeu SIGKILL');
      return { graceful: false, forced: true };
    }
    const teardownError = new Error(
      `Não foi possível confirmar o encerramento do Chromium: ${error.message || error}`
    );
    teardownError.code = 'WA_TEARDOWN_UNCONFIRMED';
    teardownError.cause = error;
    throw teardownError;
  }
}

function guardAsyncListener(listener, onError) {
  const guarded = (...args) => {
    Promise.resolve()
      .then(() => listener(...args))
      .catch(err => {
        try {
          onError(err);
        } catch (handlerErr) {
          logger?.error({ err: handlerErr }, 'Falha ao tratar erro assíncrono do WhatsApp Web');
        }
      });
  };
  guarded[GUARDED_ASYNC_LISTENER] = true;
  return guarded;
}

function handleSessionRuntimeError(tenantId, session, err) {
  if (sessions.get(tenantId) !== session) return false;
  session.ready = false;
  session.status = 'runtime_error';
  session.state = 'runtime_error';
  session.error = String(err?.message || err || 'Erro interno do WhatsApp Web');
  session.lastTransitionAt = new Date().toISOString();
  logger?.warn({ err, tenantId }, 'Contexto do WhatsApp Web reiniciado — recuperando sessão');
  notifyStatus(tenantId);
  scheduleReconnect(tenantId, session);
  return true;
}

// Ponte explícita para reconciliadores externos sinalizarem que o contexto
// Puppeteer ficou inutilizável (por exemplo, timeouts consecutivos). Quando o
// client esperado é informado, um erro atrasado nunca derruba a sessão nova.
function reportSessionRuntimeError(tenantId, err, expectedClient = null) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const session = sessions.get(normalizedTenantId);
  if (
    shuttingDown
    || !session
    || session.autoReconnectBlocked
    || (expectedClient && session.client !== expectedClient)
  ) return false;
  if (session.reconnectTimer) return true;
  return handleSessionRuntimeError(normalizedTenantId, session, err);
}

function installPageNavigationGuard(tenantId, session, client) {
  const page = client?.pupPage;
  if (!page || typeof page.listeners !== 'function' || typeof page.on !== 'function') return 0;
  const listeners = page.listeners('framenavigated');
  let guardedCount = 0;
  for (const listener of listeners) {
    if (listener?.[GUARDED_ASYNC_LISTENER]) continue;
    page.removeListener?.('framenavigated', listener);
    page.on('framenavigated', guardAsyncListener(
      listener,
      err => handleSessionRuntimeError(tenantId, session, err)
    ));
    guardedCount += 1;
  }
  return guardedCount;
}

function recoverUnhandledRuntimeError(err) {
  if (!isRetryableInitializationError(err)) return false;
  const recoverableStatuses = new Set([
    'initializing', 'initialize_failed', 'runtime_error', 'health_check_failed',
    'state_stuck', 'disconnected', 'conflict', 'timeout'
  ]);
  const recovering = [...sessions.entries()].filter(([, session]) => (
    session.reconnectTimer || recoverableStatuses.has(session.status)
  ));
  if (!recovering.length) {
    // Janela de recriação: destroySession já tirou a sessão do mapa e
    // createSession ainda não registrou a nova, então `sessions` está vazio.
    // Uma rejeição atrasada do Puppeteer (o Chromium acabou de ser morto de
    // propósito) caía aqui sem ninguém para absorvê-la e derrubava o processo
    // inteiro — 02/set/2026, 243ms depois de "Sessão WhatsApp travada —
    // recriando". A reserva de capacidade é mantida durante toda a recriação
    // (ver recreateStuckSession), então serve de sinal de que há uma troca de
    // sessão em andamento.
    if (!capacityReservations.size) return false;
    logger?.warn(
      { err, reserved: capacityReservations.size },
      'Rejeição transitória do WhatsApp Web absorvida durante recriação de sessão'
    );
    return true;
  }

  for (const [tenantId, session] of recovering) {
    if (!session.reconnectTimer) handleSessionRuntimeError(tenantId, session, err);
  }
  logger?.warn(
    { err, tenantIds: recovering.map(([tenantId]) => tenantId) },
    'Rejeição transitória do WhatsApp Web absorvida durante reconexão'
  );
  return true;
}

// Quando o WhatsApp Web publica uma versão que quebra o whatsapp-web.js
// instalado (sintoma: exceções minificadas tipo "r"/"t" em getChats — ver
// https://github.com/pedroslopez/whatsapp-web.js/issues/5733), o operador pina
// a última versão sabidamente boa com WA_WEB_VERSION=2.3000.x. O HTML precisa
// existir em .wwebjs_cache/ (o LocalWebCache guarda cada versão já servida).
// strict:false → sem o arquivo em cache, a sessão sobe na versão corrente em
// vez de falhar: o pin nunca pode impedir uma reconexão.
function buildWebVersionPin() {
  const pinned = String(process.env.WA_WEB_VERSION || '').trim();
  if (!pinned) return {};
  if (!/^\d+\.\d+\.\d+$/.test(pinned)) {
    logger?.warn({ pinned }, 'WA_WEB_VERSION invalido; ignorando pin de versao do WhatsApp Web');
    return {};
  }
  return {
    webVersion: pinned,
    webVersionCache: { type: 'local', strict: false }
  };
}

function buildChromiumLaunchArgs({ proxyServer } = {}) {
  const disableSandbox = shouldDisableChromiumSandbox();
  const launchArgs = [
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    `--disk-cache-size=${positiveEnvNumber('WA_DISK_CACHE_BYTES', 64 * 1024 * 1024, { integer: true })}`,
    `--media-cache-size=${positiveEnvNumber('WA_MEDIA_CACHE_BYTES', 32 * 1024 * 1024, { integer: true })}`,
    '--lang=pt-BR',
    '--window-size=1920,1080'
  ];

  if (disableSandbox) {
    if (process.env.NODE_ENV === 'production' && process.env.WA_NO_SANDBOX === 'true') {
      logger?.warn('Chrome rodando com --no-sandbox em producao. Configure o sandbox corretamente para maior seguranca.');
    }
    launchArgs.unshift('--no-sandbox', '--disable-setuid-sandbox');
  }

  const globalProxy = process.env.WA_PROXY_SERVER || process.env.WHATSAPP_PROXY;
  const selectedProxy = proxyServer || globalProxy;
  if (selectedProxy) {
    launchArgs.push(`--proxy-server=${selectedProxy}`);
  }

  return launchArgs;
}

function detectSystemChrome() {
  const envPath = process.env.CHROME_EXECUTABLE_PATH;
  if (envPath) return envPath;
  const paths = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ],
    linux: [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser', '/usr/bin/chromium'
    ],
    win32: [
      'C:\\Program Files\\Google Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    ]
  };
  const candidates = paths[process.platform] || paths.linux;
  for (const p of candidates) {
    try { require('fs').accessSync(p); return p; } catch {}
  }
  return undefined;
}

function buildClientPuppeteerOptions({ isolated, proxyServer } = {}) {
  if (!isolated) {
    throw new Error('Sessão WhatsApp sem isolamento de navegador foi recusada');
  }

  return {
    headless: process.env.WHATSAPP_HEADLESS !== 'false' ? 'new' : false,
    executablePath: detectSystemChrome(),
    defaultViewport: { width: 1920, height: 1080 },
    args: buildChromiumLaunchArgs({ proxyServer })
  };
}

function notifyStatus(tenantId) {
  if (onStatusChange) {
    try {
      onStatusChange(tenantId, getStatus(tenantId));
    } catch (err) {
      logger?.error({ err, tenantId }, 'Falha no callback de status do WhatsApp');
    }
  }
}

// O WhatsApp vem entregando chats em formatos novos (ex.: identidades @lid)
// que o whatsapp-web.js 1.34.7 ainda não serializa; o getChats injetado usa
// Promise.all, então UM chat incompatível rejeitava a lista inteira com uma
// exceção minificada ("r") e derrubava toda a sincronização (upstream
// #201833/#201834, 14-15/jul/2026). Até a lib absorver o formato novo, este
// override troca Promise.all por allSettled: chats saudáveis continuam
// sincronizando e os incompatíveis ficam de fora, com a contagem exposta em
// window.__wwebjsSkippedChats para diagnóstico.
/* global window */ // o callback do page.evaluate abaixo roda dentro do navegador
async function applyResilientGetChatsPatch(tenantId, session, client) {
  const page = client?.pupPage;
  if (!page || typeof page.evaluate !== 'function') return false;
  try {
    const applied = await page.evaluate(() => {
      if (!window.WWebJS || typeof window.WWebJS.getChats !== 'function') return false;
      if (window.WWebJS.getChats.__resilient) return true;
      const resilientGetChats = async () => {
        const chats = window.require('WAWebCollections').Chat.getModelsArray();
        const settled = await Promise.allSettled(
          chats.map(chat => window.WWebJS.getChatModel(chat))
        );
        const models = [];
        let skipped = 0;
        for (const result of settled) {
          if (result.status === 'fulfilled' && result.value) models.push(result.value);
          else skipped += 1;
        }
        window.__wwebjsSkippedChats = skipped;
        return models;
      };
      resilientGetChats.__resilient = true;
      window.WWebJS.getChats = resilientGetChats;
      return true;
    });
    if (sessions.get(tenantId) !== session) return false;
    if (applied) {
      logger?.info({ tenantId }, 'Patch resiliente de getChats aplicado à página do WhatsApp');
    } else {
      logger?.warn({ tenantId }, 'Patch resiliente de getChats indisponível (WWebJS ausente na página)');
    }
    return Boolean(applied);
  } catch (err) {
    if (sessions.get(tenantId) === session) {
      logger?.warn({ err, tenantId }, 'Falha ao aplicar patch resiliente de getChats');
    }
    return false;
  }
}

function markSessionReady(tenantId, session, { recovered = false } = {}) {
  if (sessions.get(tenantId) !== session) return false;
  session.ready = true;
  session.hasBeenReady = true;
  session.status = 'ready';
  session.state = 'CONNECTED';
  session.qr = null;
  session.error = null;
  session.reconnectAttempts = 0;
  session.healthFailures = 0;
  session.nonConnectedSince = null;
  session.nextReconnectAt = null;
  session.autoReconnectBlocked = false;
  session.loadingPercent = 100;
  session.loadingMessage = null;
  session.lastProgressAt = Date.now();
  session.lastReadyAt = new Date().toISOString();
  session.lastTransitionAt = session.lastReadyAt;
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  recordAuthState(tenantId, 'ready');
  logger?.info(
    { tenantId, recovered },
    recovered ? 'Sessão WhatsApp recuperou CONNECTED sem recriação' : 'WhatsApp conectado'
  );
  // Reaplicado a cada ready: reload/reinjeção da página restaura o getChats
  // original (frágil) do whatsapp-web.js. O evaluate é idempotente.
  applyResilientGetChatsPatch(tenantId, session, session.client)
    .catch(() => {});
  notifyStatus(tenantId);
  return true;
}

async function init({ logger: log, maxConcurrent = 5, onStatusChange: statusCb = null }) {
  logger = log;
  maxSessions = normalizeMaxSessions(maxConcurrent);
  onStatusChange = statusCb;
  shuttingDown = false;

  const mode = validatedBrowserMode();
  logger?.info({ maxSessions, browserMode: mode }, 'Iniciando gerenciador WhatsApp com isolamento por tenant');

  realUserAgent = process.env.WHATSAPP_USER_AGENT || FALLBACK_USER_AGENT;
  if (process.env.WHATSAPP_USER_AGENT) {
    logger?.info({ userAgent: realUserAgent }, 'User-Agent via WHATSAPP_USER_AGENT');
  } else {
    logger?.info({ userAgent: realUserAgent }, 'User-Agent configurado para sessões WhatsApp');
  }

  startHealthCheck();
  drainSessionQueue();
}

function getSession(tenantId) {
  return sessions.get(normalizeTenantId(tenantId)) || null;
}

function getStatus(tenantId) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const s = sessions.get(normalizedTenantId);
  if (s) {
    return {
      ready: s.ready,
      status: s.status,
      state: s.state,
      qr: s.qr,
      error: s.error,
      lastTransitionAt: s.lastTransitionAt,
      reconnectAttempts: s.reconnectAttempts || 0,
      reconnectTotal: s.reconnectTotal || 0,
      nextReconnectAt: s.nextReconnectAt || null,
      healthFailures: s.healthFailures || 0,
      lastHandlerError: s.lastHandlerError || null,
      loadingPercent: s.loadingPercent ?? null,
      loadingMessage: s.loadingMessage || null,
      lastProgressAt: s.lastProgressAt ? new Date(s.lastProgressAt).toISOString() : null,
      lastReadyAt: s.lastReadyAt || null,
      requiresManualAction: Boolean(s.autoReconnectBlocked),
      capacity: { active: sessions.size, queued: pendingSessions.size, max: maxSessions }
    };
  }

  const queued = pendingSessions.get(normalizedTenantId);
  if (queued) {
    return {
      ready: false,
      status: 'queued_capacity',
      state: 'queued_capacity',
      qr: null,
      error: `Capacidade de ${maxSessions} sessões atingida; inicialização aguardando vaga`,
      queuedAt: queued.enqueuedAt,
      queuePosition: queuePosition(normalizedTenantId),
      capacity: { active: sessions.size, queued: pendingSessions.size, max: maxSessions }
    };
  }

  return {
    ready: false,
    status: 'disconnected',
    state: 'disconnected',
    qr: null,
    error: null,
    capacity: { active: sessions.size, queued: pendingSessions.size, max: maxSessions }
  };
}

function getReadyClient(tenantId) {
  const s = sessions.get(normalizeTenantId(tenantId));
  return s && s.ready && s.client ? s.client : null;
}

async function getClient(tenantId, options = {}) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  let s = sessions.get(normalizedTenantId);
  if (s) {
    return s.client;
  }

  if (pendingSessions.has(normalizedTenantId)) {
    enqueueSession(normalizedTenantId, options);
    return null;
  }

  await createSession(normalizedTenantId, options);
  s = sessions.get(normalizedTenantId);
  return s?.client || null;
}

function enqueueSession(tenantId, options = {}) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const previous = pendingSessions.get(normalizedTenantId);
  const queued = {
    tenantId: normalizedTenantId,
    options: mergeSessionOptions(previous?.options, options),
    enqueuedAt: previous?.enqueuedAt || new Date().toISOString()
  };
  pendingSessions.set(normalizedTenantId, queued);
  if (!previous) {
    logger?.warn(
      {
        tenantId: normalizedTenantId,
        active: sessions.size,
        queued: pendingSessions.size,
        maxSessions
      },
      'Capacidade de sessões WhatsApp atingida; tenant colocado na fila FIFO'
    );
    notifyStatus(normalizedTenantId);
  }
  return queued;
}

function drainSessionQueue() {
  if (drainingSessionQueue || shuttingDown || !hasSessionCapacity() || pendingSessions.size === 0) return;
  drainingSessionQueue = true;
  try {
    while (!shuttingDown && hasSessionCapacity() && pendingSessions.size > 0) {
      const [tenantId, queued] = pendingSessions.entries().next().value;
      pendingSessions.delete(tenantId);
      logger?.info(
        { tenantId, queuedForMs: Date.now() - Date.parse(queued.enqueuedAt) },
        'Vaga disponível; inicializando sessão WhatsApp que aguardava na fila'
      );
      // createSession registra a sessão no Map antes do primeiro await. Assim,
      // o laço nunca ultrapassa maxSessions mesmo inicializando vagas em paralelo.
      createSession(tenantId, { ...queued.options, __fromCapacityQueue: true })
        .catch(err => logger?.error({ err, tenantId }, 'Falha ao iniciar sessão retirada da fila'))
        .finally(() => drainSessionQueue());
    }
  } finally {
    drainingSessionQueue = false;
  }
}

function dispatchArchiveEvent(session, chat, currState, prevState) {
  if (!session?.ready || !session.archiveHandler) return false;
  invokeSessionHandler(
    session.tenantId,
    session,
    'archive',
    session.archiveHandler,
    chat,
    currState,
    prevState,
    session.client
  );
  return true;
}

function invokeSessionHandler(tenantId, session, handlerName, handler, ...args) {
  if (typeof handler !== 'function') return false;
  try {
    Promise.resolve(handler(...args)).catch(err => {
      if (sessions.get(tenantId) !== session) return;
      session.lastHandlerError = `${handlerName}: ${String(err?.message || err)}`;
      logger?.error({ err, tenantId, handler: handlerName }, 'Falha em handler da sessão WhatsApp');
    });
  } catch (err) {
    if (sessions.get(tenantId) === session) {
      session.lastHandlerError = `${handlerName}: ${String(err?.message || err)}`;
    }
    logger?.error({ err, tenantId, handler: handlerName }, 'Falha em handler da sessão WhatsApp');
  }
  return true;
}

async function createSession(tenantId, options = {}) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const teardown = teardownBarriers.get(normalizedTenantId);
  if (teardown) await teardown;
  if (shuttingDown) throw new Error('Gerenciador WhatsApp está encerrando');
  if (sessions.has(normalizedTenantId)) return sessions.get(normalizedTenantId).client;

  const hasReservation = capacityReservations.has(normalizedTenantId);
  if (!hasReservation && !hasSessionCapacity()) {
    enqueueSession(normalizedTenantId, options);
    return null;
  }
  pendingSessions.delete(normalizedTenantId);

  const authPath = getTenantAuthPath(normalizedTenantId);
  const proxyServer = options.proxyServer || null;
  const isolated = isIsolatedBrowserMode();
  const s = {
    tenantId: normalizedTenantId,
    client: null,
    status: 'initializing',
    qr: null,
    ready: false,
    state: 'init',
    error: null,
    // Registra handlers ANTES de initialize(). O evento ready e mensagens
    // represadas podem chegar antes de a Promise de inicialização resolver.
    msgHandler: options.onMessage || null,
    ackHandler: options.onAck || null,
    archiveHandler: options.onArchive || null,
    editHandler: options.onMessageEdit || null,
    revokeHandler: options.onMessageRevoke || null,
    syncHandler: options.onSyncNeeded || null,
    proxyServer,
    isolated,
    createdAt: Date.now(),
    lastTransitionAt: new Date().toISOString(),
    healthFailures: 0,
    healthCheckInFlight: false,
    nonConnectedSince: null,
    reconnectAttempts: Number(options.reconnectAttempts || 0),
    reconnectTotal: Number(options.reconnectTotal || 0),
    reconnectTimer: null,
    nextReconnectAt: null,
    lastHandlerError: null,
    autoReconnectBlocked: false,
    hasBeenReady: false,
    loadingPercent: null,
    loadingMessage: null,
    lastProgressAt: Date.now(),
    lastReadyAt: null,
    lifecycleEpoch: currentLifecycleEpoch(normalizedTenantId)
  };
  // A reserva de capacidade precisa existir antes do primeiro await. Além de
  // impedir dois createSession simultâneos para o mesmo tenant, isso evita que
  // o dreno FIFO admita mais Chromiums enquanto a limpeza de cache está em I/O.
  sessions.set(normalizedTenantId, s);
  notifyStatus(normalizedTenantId);

  try {
    // Neste ponto qualquer navegador anterior já atravessou a teardown barrier.
    // Blob URLs e caches HTTP/service-worker não sobrevivem a um novo processo;
    // removê-los aqui limita crescimento sem tocar credenciais ou IndexedDB.
    await cleanupDisposableAuthCaches(normalizedTenantId);
  } catch (err) {
    if (sessions.get(normalizedTenantId) !== s) return null;
    s.error = String(err?.message || err);
    s.status = 'initialize_failed';
    s.state = 'initialize_failed';
    s.lastTransitionAt = new Date().toISOString();
    logger?.error({ err, tenantId: normalizedTenantId }, 'Falha ao preparar cache da sessão WhatsApp');
    notifyStatus(normalizedTenantId);
    scheduleReconnect(normalizedTenantId, s);
    return null;
  }

  // Logout, suspensão ou shutdown podem remover a reserva enquanto a limpeza
  // assíncrona está em andamento. Nunca ressuscite o cliente depois disso.
  if (shuttingDown || sessions.get(normalizedTenantId) !== s) return null;

  let client;
  try {
    client = new ClientConstructor({
      authStrategy: new LocalAuthConstructor({ dataPath: authPath }),
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
      userAgent: realUserAgent || FALLBACK_USER_AGENT,
      puppeteer: buildClientPuppeteerOptions({ isolated, proxyServer }),
      ...buildWebVersionPin()
    });
  } catch (err) {
    s.error = String(err?.message || err);
    s.status = 'initialize_failed';
    s.state = 'initialize_failed';
    s.lastTransitionAt = new Date().toISOString();
    logger?.error({ err, tenantId: normalizedTenantId }, 'Falha ao construir cliente WhatsApp');
    notifyStatus(normalizedTenantId);
    scheduleReconnect(normalizedTenantId, s);
    return null;
  }

  s.client = client;

  client.on('qr', qr => {
    if (sessions.get(normalizedTenantId) !== s) return;
    s.qr = qr;
    s.status = 'qr';
    s.state = 'qr';
    s.autoReconnectBlocked = false;
    s.lastTransitionAt = new Date().toISOString();
    recordAuthState(normalizedTenantId, 'unpaired');
    // QR permite tomar controle da conta. Nunca o escreva nos logs de produção.
    if (process.env.NODE_ENV !== 'production' && process.env.WA_PRINT_QR_TO_TERMINAL === 'true') {
      qrcode.generate(qr, { small: true });
    }
    logger?.info({ tenantId: normalizedTenantId }, 'QR code disponível');
    notifyStatus(normalizedTenantId);
  });

  client.on('ready', () => {
    markSessionReady(normalizedTenantId, s);
  });

  client.on('loading_screen', (percent, message) => {
    if (sessions.get(normalizedTenantId) !== s || s.ready) return;
    const numericPercent = Number(percent);
    const nextPercent = Number.isFinite(numericPercent)
      ? Math.max(0, Math.min(100, Math.round(numericPercent)))
      : s.loadingPercent;
    const nextMessage = typeof message === 'string' ? message.trim().slice(0, 200) : '';
    const progressed = nextPercent !== s.loadingPercent || (nextMessage && nextMessage !== s.loadingMessage);
    // Mesmo percentual repetido é um heartbeat legítimo do carregamento.
    // Evita recriar uma sessão grande que continua trabalhando sem mudar a UI.
    s.lastProgressAt = Date.now();
    s.loadingPercent = nextPercent;
    s.loadingMessage = nextMessage || s.loadingMessage;
    s.status = 'syncing';
    s.state = 'syncing';
    if (progressed) {
      s.lastTransitionAt = new Date().toISOString();
      notifyStatus(normalizedTenantId);
    }
  });

  client.on('authenticated', () => {
    if (sessions.get(normalizedTenantId) !== s) return;
    s.status = 'authenticated';
    s.state = 'authenticated';
    s.qr = null;
    s.autoReconnectBlocked = false;
    s.lastProgressAt = Date.now();
    s.lastTransitionAt = new Date().toISOString();
    logger?.info({ tenantId: normalizedTenantId }, 'WhatsApp autenticado');
    notifyStatus(normalizedTenantId);
  });

  client.on('auth_failure', msg => {
    if (sessions.get(normalizedTenantId) !== s) return;
    const msgStr = String(msg?.message || msg || '');
    const isBanned = /ban|blocked|spam|restricted|violat/i.test(msgStr);
    s.error = msgStr;
    s.status = isBanned ? 'banned' : 'auth_failure';
    s.state = s.status;
    s.ready = false;
    blockAutomaticReconnect(s);
    s.lastTransitionAt = new Date().toISOString();
    logger?.error({ tenantId: normalizedTenantId, msg: msgStr, banned: isBanned }, isBanned
      ? 'CONTA BANIDA — ação manual necessária'
      : 'Falha de autenticação WhatsApp');
    notifyStatus(normalizedTenantId);
  });

  client.on('change_state', state => {
    if (sessions.get(normalizedTenantId) !== s) return;
    s.state = state;
    s.lastTransitionAt = new Date().toISOString();
    if (state === 'CONNECTED' && s.hasBeenReady) {
      if (!s.ready || s.reconnectTimer || s.status !== 'ready') {
        markSessionReady(normalizedTenantId, s, { recovered: true });
      }
      return;
    }
    if (state && state !== 'CONNECTED' && s.ready) {
      s.ready = false;
      s.status = 'degraded';
      s.error = `Estado WhatsApp: ${state}`;
      s.nonConnectedSince ||= Date.now();
      notifyStatus(normalizedTenantId);
    }
    const warnStates = [
      'DEPRECATED_VERSION', 'CONFLICT', 'UNPAIRED', 'UNPAIRED_IDLE',
      'PROXYBLOCK', 'TIMEOUT', 'TOS_BLOCK', 'SMB_TOS_BLOCK'
    ];
    if (warnStates.includes(state)) {
      const reconnectableStates = ['CONFLICT', 'UNPAIRED', 'UNPAIRED_IDLE', 'TIMEOUT'];
      const terminalStates = ['DEPRECATED_VERSION', 'PROXYBLOCK', 'TOS_BLOCK', 'SMB_TOS_BLOCK'];
      if (reconnectableStates.includes(state)) {
        s.ready = false;
        s.status = String(state).toLowerCase();
        s.error = state;
        scheduleReconnect(normalizedTenantId, s);
      } else if (terminalStates.includes(state)) {
        s.ready = false;
        blockAutomaticReconnect(s);
        s.status = String(state).toLowerCase();
        s.error = `${state}: intervenção operacional necessária`;
      }
      logger?.warn({ tenantId: normalizedTenantId, state }, `Estado WhatsApp preocupante: ${state}`);
      notifyStatus(normalizedTenantId);
    }
  });

  client.on('disconnected', reason => {
    if (sessions.get(normalizedTenantId) !== s) return;
    s.ready = false;
    s.status = 'disconnected';
    s.state = 'disconnected';
    s.error = String(reason?.message || reason || 'desconectado');
    s.lastTransitionAt = new Date().toISOString();
    logger?.warn({ tenantId: normalizedTenantId, reason }, 'WhatsApp desconectado');
    notifyStatus(normalizedTenantId);
    scheduleReconnect(normalizedTenantId, s);
  });

  client.on('message', msg => {
    if (sessions.get(normalizedTenantId) !== s) return;
    // Durante initialize o Store republica um grande lote histórico. Ele será
    // reconciliado de forma idempotente após ready; tratá-lo como tempo real
    // causaria centenas de inserts/refreshes e esgotaria o rate limit da UI.
    if (!s.ready) return;
    invokeSessionHandler(normalizedTenantId, s, 'message', s.msgHandler, msg, s.client, 'message');
  });

  client.on('message_create', msg => {
    if (sessions.get(normalizedTenantId) !== s) return;
    if (!s.ready) return;
    // A biblioteca também emite message_create para mensagens recebidas e logo
    // depois emite message. Aqui ficam apenas as enviadas por este número.
    if (!msg?.fromMe) return;
    invokeSessionHandler(normalizedTenantId, s, 'message_create', s.msgHandler, msg, s.client, 'message_create');
  });

  client.on('message_ack', (msg, ack) => {
    if (sessions.get(normalizedTenantId) !== s) return;
    invokeSessionHandler(normalizedTenantId, s, 'message_ack', s.ackHandler, msg, ack);
  });

  client.on('message_edit', (msg, newBody, previousBody) => {
    if (sessions.get(normalizedTenantId) !== s || !s.ready) return;
    invokeSessionHandler(
      normalizedTenantId,
      s,
      'message_edit',
      s.editHandler,
      msg,
      newBody,
      previousBody,
      s.client
    );
  });

  client.on('message_revoke_everyone', (msg, revokedMsg) => {
    if (sessions.get(normalizedTenantId) !== s || !s.ready) return;
    invokeSessionHandler(
      normalizedTenantId,
      s,
      'message_revoke_everyone',
      s.revokeHandler,
      msg,
      revokedMsg,
      s.client
    );
  });

  client.on('message_ciphertext_failed', msg => {
    if (sessions.get(normalizedTenantId) !== s || !s.ready) return;
    invokeSessionHandler(
      normalizedTenantId,
      s,
      'message_ciphertext_failed',
      s.syncHandler,
      'message_ciphertext_failed',
      msg,
      s.client
    );
  });

  client.on('chat_archived', (chat, currState, prevState) => {
    if (sessions.get(normalizedTenantId) !== s) return;
    // O Store pode republicar mudanças enquanto a sessão ainda inicializa.
    // O reconciliador pós-ready é responsável por esse estado inicial; aqui
    // encaminhamos somente alterações realmente ocorridas em tempo real.
    if (!s.ready) return;
    dispatchArchiveEvent(s, chat, currState, prevState);
  });

  startVerificationMonitor(normalizedTenantId, s, client);

  try {
    await withTimeout(client.initialize(), WHATSAPP_INIT_TIMEOUT_MS, 'Inicializacao WhatsApp');
    // destroy/logout podem interromper uma inicialização em andamento. Não
    // instale novos listeners em um cliente que já deixou de ser o do tenant.
    if (sessions.get(normalizedTenantId) !== s) return null;
    installPageNavigationGuard(normalizedTenantId, s, client);
  } catch (err) {
    if (sessions.get(normalizedTenantId) !== s) return null;
    s.error = String(err?.message || err);
    s.status = 'initialize_failed';
    s.state = 'initialize_failed';
    s.ready = false;
    s.lastTransitionAt = new Date().toISOString();
    logger?.error(
      { err, tenantId: normalizedTenantId, retryableSignature: isRetryableInitializationError(err) },
      'Falha ao inicializar WhatsApp; reconexão automática permanecerá ativa'
    );
    notifyStatus(normalizedTenantId);
    // Erros desconhecidos também podem ser transitórios (mudança no WhatsApp
    // Web, DNS, disco ou processo Chromium). Só estados explicitamente terminais
    // tratados pelos eventos acima exigem intervenção manual.
    scheduleReconnect(normalizedTenantId, s);
  }
  return client;
}

async function readPageUrl(page) {
  if (!page || typeof page.url !== 'function') return '';
  // Puppeteer currently returns a string synchronously, while some fakes and
  // compatible implementations return a Promise. Normalizing both avoids the
  // old `page.url().then(...)` TypeError that silently disabled this monitor.
  return String(await Promise.resolve(page.url()) || '');
}

function startVerificationMonitor(tenantId, s, client) {
  const checkInterval = setInterval(() => {
    if (sessions.get(tenantId) !== s) {
      clearInterval(checkInterval);
      return;
    }
    try {
      const page = client.pupPage;
      if (!page || page.isClosed()) {
        clearInterval(checkInterval);
        return;
      }
      readPageUrl(page).then(url => {
        if (/blocked|verify|captcha|challenge|checkpoint|login|two-factor|2fa/i.test(url)) {
          logger?.error({ tenantId, url }, 'TELA DE VERIFICAÇÃO/BLOQUEIO detectada no WhatsApp Web');
          s.status = 'verification_required';
          s.state = 'verification_required';
          s.ready = false;
          blockAutomaticReconnect(s);
          s.error = `Tela de verificação: ${url}`;
          s.lastTransitionAt = new Date().toISOString();
          notifyStatus(tenantId);
          clearInterval(checkInterval);
        }
      }).catch(err => {
        logger?.debug?.({ err, tenantId }, 'Falha transitória ao inspecionar URL do WhatsApp Web');
      });
    } catch {}
  }, 10000);
  checkInterval.unref?.();

  const cleanup = (() => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      clearInterval(checkInterval);
    };
  })();

  client.on('ready', cleanup);
  client.on('disconnected', cleanup);
  client.on('auth_failure', cleanup);
}

function detachSession(tenantId, session) {
  if (!session) return;
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  session.nextReconnectAt = null;
  session.msgHandler = null;
  session.ackHandler = null;
  session.archiveHandler = null;
  session.editHandler = null;
  session.revokeHandler = null;
  session.syncHandler = null;
  if (sessions.get(tenantId) === session) sessions.delete(tenantId);
}

function retainFailedTeardownSession(tenantId, session, error) {
  if (!session || shuttingDown) return;
  session.ready = false;
  session.status = 'teardown_failed';
  session.state = 'teardown_failed';
  session.error = String(error?.message || error || 'Falha ao encerrar Chromium');
  session.lastTransitionAt = new Date().toISOString();
  blockAutomaticReconnect(session);
  sessions.set(tenantId, session);
}

async function destroySession(tenantId, { drainQueue = true } = {}) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const s = sessions.get(normalizedTenantId);
  if (!s) return teardownBarriers.get(normalizedTenantId);
  detachSession(normalizedTenantId, s);
  try {
    await registerTenantTeardown(normalizedTenantId, async () => {
      await terminateClientBrowser(s.client);
    });
  } catch (err) {
    retainFailedTeardownSession(normalizedTenantId, s, err);
    logger?.error({ err, tenantId: normalizedTenantId }, 'Erro ao destruir sessão; tenant mantido bloqueado');
    throw err;
  } finally {
    notifyStatus(normalizedTenantId);
    if (drainQueue) drainSessionQueue();
  }
}

async function logoutTenantSessionResources(tenantId, session, { authRoot = AUTH_ROOT } = {}) {
  const client = session?.client;
  if (typeof client?.logout === 'function') {
    try {
      await withTimeout(client.logout(), HEALTH_CHECK_TIMEOUT_MS, 'Logout remoto WhatsApp');
    } catch (err) {
      logger?.warn({ err, tenantId }, 'Falha no logout remoto do WhatsApp; removendo credenciais locais');
    }
  }

  if (typeof client?.destroy === 'function') {
    await terminateClientBrowser(client);
  }

  await fsPromises.rm(getTenantAuthPath(tenantId, authRoot), {
    recursive: true,
    force: true
  });
}

function scheduleReconnect(tenantId, deadSession) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  if (
    shuttingDown
    || sessions.get(normalizedTenantId) !== deadSession
    || deadSession.reconnectTimer
    || deadSession.autoReconnectBlocked
  ) return false;
  const attempts = (deadSession.reconnectAttempts || 0) + 1;
  deadSession.reconnectAttempts = attempts;
  deadSession.reconnectTotal = (deadSession.reconnectTotal || 0) + 1;
  const delay = calculateReconnectDelay(attempts);
  deadSession.status = 'reconnect_scheduled';
  deadSession.state = 'reconnect_scheduled';
  deadSession.nextReconnectAt = new Date(Date.now() + delay).toISOString();
  deadSession.lastTransitionAt = new Date().toISOString();
  logger?.warn(
    {
      tenantId: normalizedTenantId,
      consecutiveAttempt: attempts,
      totalAttempts: deadSession.reconnectTotal,
      delay,
      nextReconnectAt: deadSession.nextReconnectAt
    },
    'Agendando reconexão automática persistente da sessão WhatsApp'
  );
  notifyStatus(normalizedTenantId);
  deadSession.reconnectTimer = setTimeout(async () => {
    if (shuttingDown || sessions.get(normalizedTenantId) !== deadSession) return;
    deadSession.reconnectTimer = null;
    deadSession.nextReconnectAt = null;
    const handler = deadSession.msgHandler;
    const ackHandler = deadSession.ackHandler;
    const archiveHandler = deadSession.archiveHandler;
    const editHandler = deadSession.editHandler;
    const revokeHandler = deadSession.revokeHandler;
    const syncHandler = deadSession.syncHandler;
    const proxyServer = deadSession.proxyServer || undefined;
    const lifecycleEpoch = deadSession.lifecycleEpoch ?? currentLifecycleEpoch(normalizedTenantId);
    capacityReservations.add(normalizedTenantId);
    try {
      await destroySession(normalizedTenantId, { drainQueue: false });
      if (shuttingDown || currentLifecycleEpoch(normalizedTenantId) !== lifecycleEpoch) return;
      await createSession(normalizedTenantId, {
        proxyServer,
        onMessage: handler,
        onAck: ackHandler,
        onArchive: archiveHandler,
        onMessageEdit: editHandler,
        onMessageRevoke: revokeHandler,
        onSyncNeeded: syncHandler,
        reconnectAttempts: attempts,
        reconnectTotal: deadSession.reconnectTotal
      });
    } catch (err) {
      logger?.error({ err, tenantId: normalizedTenantId }, 'Falha na reconexão automática');
      const current = sessions.get(normalizedTenantId);
      if (current && !current.reconnectTimer) scheduleReconnect(normalizedTenantId, current);
    } finally {
      capacityReservations.delete(normalizedTenantId);
      drainSessionQueue();
    }
  }, delay);
  deadSession.reconnectTimer.unref?.();
  return true;
}

function setMessageHandler(tenantId, handler) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const s = sessions.get(normalizedTenantId);
  if (s) s.msgHandler = handler;
  const queued = pendingSessions.get(normalizedTenantId);
  if (queued) queued.options.onMessage = handler;
}

function setAckHandler(tenantId, handler) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const s = sessions.get(normalizedTenantId);
  if (s) s.ackHandler = handler;
  const queued = pendingSessions.get(normalizedTenantId);
  if (queued) queued.options.onAck = handler;
}

function setArchiveHandler(tenantId, handler) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const s = sessions.get(normalizedTenantId);
  if (s) s.archiveHandler = handler;
  const queued = pendingSessions.get(normalizedTenantId);
  if (queued) queued.options.onArchive = handler;
}

function setMessageEditHandler(tenantId, handler) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const s = sessions.get(normalizedTenantId);
  if (s) s.editHandler = handler;
  const queued = pendingSessions.get(normalizedTenantId);
  if (queued) queued.options.onMessageEdit = handler;
}

function setMessageRevokeHandler(tenantId, handler) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const s = sessions.get(normalizedTenantId);
  if (s) s.revokeHandler = handler;
  const queued = pendingSessions.get(normalizedTenantId);
  if (queued) queued.options.onMessageRevoke = handler;
}

function setSyncNeededHandler(tenantId, handler) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const s = sessions.get(normalizedTenantId);
  if (s) s.syncHandler = handler;
  const queued = pendingSessions.get(normalizedTenantId);
  if (queued) queued.options.onSyncNeeded = handler;
}

async function startSession(tenantId, {
  onMessage,
  onAck,
  onArchive,
  onMessageEdit,
  onMessageRevoke,
  onSyncNeeded,
  proxyServer
} = {}) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const s = sessions.get(normalizedTenantId);
  if (s) {
    if (onMessage) setMessageHandler(normalizedTenantId, onMessage);
    if (onAck) setAckHandler(normalizedTenantId, onAck);
    if (onArchive) setArchiveHandler(normalizedTenantId, onArchive);
    if (onMessageEdit) setMessageEditHandler(normalizedTenantId, onMessageEdit);
    if (onMessageRevoke) setMessageRevokeHandler(normalizedTenantId, onMessageRevoke);
    if (onSyncNeeded) setSyncNeededHandler(normalizedTenantId, onSyncNeeded);
    if (s.ready) return s.client;
  }
  await getClient(normalizedTenantId, {
    proxyServer,
    onMessage,
    onAck,
    onArchive,
    onMessageEdit,
    onMessageRevoke,
    onSyncNeeded
  });
  return sessions.get(normalizedTenantId)?.client || null;
}

async function logoutSession(tenantId) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  invalidateAutomaticRecovery(normalizedTenantId);
  const s = sessions.get(normalizedTenantId) || null;
  pendingSessions.delete(normalizedTenantId);
  capacityReservations.delete(normalizedTenantId);
  if (s) detachSession(normalizedTenantId, s);
  try {
    await registerTenantTeardown(
      normalizedTenantId,
      async () => {
        try {
          await waitForAuthMarkerWrites(normalizedTenantId);
        } catch (err) {
          logger?.warn({ err, tenantId: normalizedTenantId }, 'Falha pendente de marcador antes do logout');
        }
        await logoutTenantSessionResources(normalizedTenantId, s);
      }
    );
  } catch (err) {
    retainFailedTeardownSession(normalizedTenantId, s, err);
    throw err;
  } finally {
    notifyStatus(normalizedTenantId);
    drainSessionQueue();
  }
}

function listSessions() {
  const result = [];
  for (const [tenantId, s] of sessions) {
    result.push({
      tenantId,
      status: s.status,
      state: s.state,
      ready: s.ready,
      qr: s.qr,
      error: s.error,
      isolated: s.isolated,
      proxyConfigured: Boolean(s.proxyServer),
      reconnectAttempts: s.reconnectAttempts || 0,
      reconnectTotal: s.reconnectTotal || 0,
      nextReconnectAt: s.nextReconnectAt || null,
      lastTransitionAt: s.lastTransitionAt,
      healthFailures: s.healthFailures || 0,
      lastHandlerError: s.lastHandlerError || null,
      loadingPercent: s.loadingPercent ?? null,
      loadingMessage: s.loadingMessage || null,
      lastProgressAt: s.lastProgressAt ? new Date(s.lastProgressAt).toISOString() : null,
      lastReadyAt: s.lastReadyAt || null,
      requiresManualAction: Boolean(s.autoReconnectBlocked)
    });
  }
  for (const [tenantId, queued] of pendingSessions) {
    result.push({
      tenantId,
      status: 'queued_capacity',
      state: 'queued_capacity',
      ready: false,
      qr: null,
      error: `Capacidade de ${maxSessions} sessões atingida`,
      isolated: true,
      proxyConfigured: Boolean(queued.options.proxyServer),
      queuedAt: queued.enqueuedAt,
      queuePosition: queuePosition(tenantId)
    });
  }
  return result;
}

async function recreateStuckSession(tenantId, s, reason) {
  logger?.warn({ tenantId, status: s.status, reason }, 'Sessão WhatsApp travada — recriando');
  const handler = s.msgHandler;
  const ackHandler = s.ackHandler;
  const archiveHandler = s.archiveHandler;
  const editHandler = s.editHandler;
  const revokeHandler = s.revokeHandler;
  const syncHandler = s.syncHandler;
  const proxyServer = s.proxyServer || undefined;
  const lifecycleEpoch = s.lifecycleEpoch ?? currentLifecycleEpoch(tenantId);
  capacityReservations.add(tenantId);
  try {
    await destroySession(tenantId, { drainQueue: false });
    if (shuttingDown || currentLifecycleEpoch(tenantId) !== lifecycleEpoch) return;
    await createSession(tenantId, {
      proxyServer,
      onMessage: handler,
      onAck: ackHandler,
      onArchive: archiveHandler,
      onMessageEdit: editHandler,
      onMessageRevoke: revokeHandler,
      onSyncNeeded: syncHandler,
      reconnectAttempts: s.reconnectAttempts || 0,
      reconnectTotal: s.reconnectTotal || 0
    });
  } finally {
    capacityReservations.delete(tenantId);
    drainSessionQueue();
  }
}

function startHealthCheck() {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(() => {
    for (const [tenantId, s] of sessions) {
      const transitionAt = Date.parse(s.lastTransitionAt || '') || s.createdAt || Date.now();
      const progressAgeMs = Date.now() - (s.lastProgressAt || transitionAt);
      if (
        !s.ready
        && ['initializing', 'authenticated', 'syncing'].includes(s.status)
        && progressAgeMs > STATE_STUCK_TIMEOUT_MS
      ) {
        recreateStuckSession(tenantId, s, `${s.status}_timeout`)
          .catch(err => logger?.error({ err, tenantId }, 'Falha ao recriar sessão travada'));
        continue;
      }

      if (
        (!s.ready && s.status !== 'degraded')
        || s.healthCheckInFlight
        || typeof s.client?.getState !== 'function'
      ) continue;
      s.healthCheckInFlight = true;

      withTimeout(s.client.getState(), HEALTH_CHECK_TIMEOUT_MS, 'Health check WhatsApp')
        .then(state => {
          if (sessions.get(tenantId) !== s) return;
          s.healthFailures = 0;
          if (state) s.state = state;
          if (state !== 'CONNECTED') {
            s.nonConnectedSince ||= Date.now();
            if (s.ready || s.status !== 'degraded') {
              s.ready = false;
              s.status = 'degraded';
              s.error = `Estado WhatsApp: ${state || 'UNKNOWN'}`;
              s.lastTransitionAt = new Date().toISOString();
            }
            logger?.warn({ tenantId, state: state || 'UNKNOWN' }, 'Health check detectou sessão fora de CONNECTED');
            notifyStatus(tenantId);
            if (Date.now() - s.nonConnectedSince >= DEGRADED_RECONNECT_GRACE_MS) {
              s.ready = false;
              s.status = 'state_stuck';
              s.error = `Estado persistente: ${state || 'UNKNOWN'}`;
              s.lastTransitionAt = new Date().toISOString();
              notifyStatus(tenantId);
              scheduleReconnect(tenantId, s);
            }
          } else if (state === 'CONNECTED') {
            s.nonConnectedSince = null;
            if (!s.ready && s.hasBeenReady) markSessionReady(tenantId, s, { recovered: true });
          }
        })
        .catch(err => {
          if (sessions.get(tenantId) !== s) return;
          s.healthFailures = (s.healthFailures || 0) + 1;
          s.error = err.message;
          logger?.warn({ err, tenantId, failures: s.healthFailures }, 'Falha no health check da sessão WhatsApp');
          if (s.healthFailures >= HEALTH_CHECK_MAX_FAILURES) {
            s.ready = false;
            s.status = 'health_check_failed';
            s.state = 'health_check_failed';
            s.lastTransitionAt = new Date().toISOString();
            notifyStatus(tenantId);
            scheduleReconnect(tenantId, s);
          }
        })
        .finally(() => {
          if (sessions.get(tenantId) === s) s.healthCheckInFlight = false;
        });
    }
  }, HEALTH_CHECK_INTERVAL_MS);
  healthCheckTimer.unref?.();
}

function stopHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

async function shutdown() {
  shuttingDown = true;
  stopHealthCheck();
  pendingSessions.clear();
  capacityReservations.clear();
  // Encerra Chromiums em paralelo: sequencialmente, N sessões travadas fariam
  // o processo ultrapassar com facilidade a janela de graceful shutdown da VPS.
  const tenantIds = new Set([...sessions.keys(), ...teardownBarriers.keys()]);
  await Promise.allSettled(
    [...tenantIds].map(tenantId => destroySession(tenantId, { drainQueue: false }))
  );
  await Promise.allSettled([...authMarkerTails.values()]);
  sessions.clear();
  teardownBarriers.clear();
  authMarkerTails.clear();
  lifecycleEpochs.clear();
  drainingSessionQueue = false;
}

module.exports = {
  init,
  shutdown,
  getSession,
  getStatus,
  getReadyClient,
  getClient,
  createSession,
  destroySession,
  setMessageHandler,
  setAckHandler,
  setArchiveHandler,
  setMessageEditHandler,
  setMessageRevokeHandler,
  setSyncNeededHandler,
  startSession,
  logoutSession,
  listSessions,
  hasRestorableSession,
  reportSessionRuntimeError,
  recoverUnhandledRuntimeError,
  __test: {
    browserMode,
    validatedBrowserMode,
    buildWebVersionPin,
    applyResilientGetChatsPatch,
    getTenantAuthPath,
    getAuthStateMarkerPaths,
    cleanupDisposableAuthCaches,
    persistAuthStateMarker,
    waitForAuthMarkerWrites,
    logoutTenantSessionResources,
    dispatchArchiveEvent,
    guardAsyncListener,
    installPageNavigationGuard,
    readPageUrl,
    forceKillBrowserProcess,
    terminateClientBrowser,
    isRetryableInitializationError,
    normalizeTenantId,
    normalizeMaxSessions,
    calculateReconnectDelay,
    mergeSessionOptions,
    blockAutomaticReconnect,
    invokeSessionHandler,
    waitForTenantTeardown,
    recreateStuckSession,
    setClientConstructors({ Client: ClientOverride = Client, LocalAuth: LocalAuthOverride = LocalAuth } = {}) {
      ClientConstructor = ClientOverride;
      LocalAuthConstructor = LocalAuthOverride;
    },
    getCapacitySnapshot: () => ({
      active: sessions.size,
      queued: pendingSessions.size,
      reserved: capacityReservations.size,
      tearingDown: teardownBarriers.size,
      max: maxSessions
    })
  }
};
