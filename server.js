require('dotenv').config();

// Arquivos de banco, sessao do WhatsApp, midia e logs podem conter dados
// sensiveis. Falha fechada por padrao: somente o usuario do processo pode ler
// arquivos novos, inclusive quando a aplicacao e iniciada fora do Docker.
process.umask(0o077);

const {
  isInternalBlockedApiPath,
  isInternalEdition,
  isInternalHtmlPath
} = require('./internalEdition');
const INTERNAL_EDITION = isInternalEdition();

// Em produção, nenhuma migração, lease, criação de credencial ou inicialização
// do WhatsApp pode acontecer antes da validação completa do ambiente. O
// deploy.sh já faz esta checagem, mas o servidor também precisa ser seguro
// quando iniciado diretamente pelo Docker/operador.
if (process.env.NODE_ENV === 'production') {
  const { validateProductionEnv } = require('./scripts/validate-production-env');
  const productionConfigErrors = validateProductionEnv(process.env);
  if (productionConfigErrors.length) {
    throw new Error(`Configuracao de producao invalida: ${productionConfigErrors.join('; ')}`);
  }
}

// ============ ANTI-DETECÇÃO WHATSAPP ============
// O whatsapp-web.js usa Puppeteer internamente para automatizar o WhatsApp Web.
// O Meta/Facebook detecta automação através de vários fingerprintings:
//   - navigator.webdriver, navigator.plugins, chrome.runtime, WebGL, canvas, etc.
//
// Usamos puppeteer-extra + stealth plugin para camuflar todas essas detecções.
// Além disso, interceptamos o require('puppeteer') do whatsapp-web.js para que
// ele use nossa instância camuflada em vez do Puppeteer padrão.
//
// Evasões incluídas (16):
//   chrome.app, chrome.csi, chrome.loadTimes, chrome.runtime, defaultArgs,
//   iframe.contentWindow, media.codecs, navigator.hardwareConcurrency,
//   navigator.languages, navigator.permissions, navigator.plugins,
//   navigator.webdriver, sourceurl, user-agent-override, webgl.vendor,
//   window.outerdimensions
let PuppeteerExtra;
const startupWarnings = [];
try {
  PuppeteerExtra = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  // enable all evasions explicitly — garante que nenhuma fique desabilitada por
  // mudança de default na versão do plugin
  PuppeteerExtra.use(StealthPlugin({
    enabledEvasions: [
      'chrome.app', 'chrome.csi', 'chrome.loadTimes', 'chrome.runtime',
      'defaultArgs', 'iframe.contentWindow', 'media.codecs',
      'navigator.hardwareConcurrency', 'navigator.languages',
      'navigator.permissions', 'navigator.plugins', 'navigator.webdriver',
      'sourceurl', 'user-agent-override', 'webgl.vendor',
      'window.outerdimensions'
    ]
  }));
} catch {
  startupWarnings.push('puppeteer-extra ou stealth plugin não disponíveis. Fallback para Puppeteer padrão.');
}
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'puppeteer' && PuppeteerExtra) return PuppeteerExtra;
  return originalRequire.apply(this, arguments);
};
// ================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createServer } = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const pino = require('pino');
const pinoHttp = require('pino-http');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { verifyTotp } = require('./totp');
const db = require('./db');
const { createCsrfMiddleware, issueCsrfToken, readCsrfToken } = require('./csrf');
const { normalizeMime, sleep, withTimeout } = require('./runtimeUtils');
const { PartitionedWorkQueue } = require('./asyncWorkQueue');
const { createSocketRateLimiter } = require('./socketRateLimiter');
const {
  validateAuthenticatedPrincipal,
  isTenantPrincipal,
  samePrincipal
} = require('./authIdentity');
const {
  buildUserRoom,
  buildIdentityRoom,
  buildSessionRoom,
  buildSupportTenantRoom
} = require('./socketRooms');
const {
  createPasswordResetRequest,
  listPendingPasswordResetRequests,
  isPasswordResetInFlight,
  resolvePasswordResetRequest,
  recoverInFlightPasswordResetResolutions
} = require('./passwordReset');
const { createPresenceRegistry } = require('./presence');
const { getTenantStatistics } = require('./analytics');
const { normalizeUsername: normalizeDirectoryUsername } = require('./userDirectoryIntegrity');
const { getTurnstileConfigurationStatus, verifyTurnstileToken } = require('./signupProtection');
const { importExistingChats } = require('./historyImporter');
const {
  isImportableChatId,
  getChatId,
  getDisplayName,
  shouldReplaceDisplayName,
  getMessageExternalId,
  serializedMessageId,
  getMessageContent,
  toSqlDate,
  shouldProcessMessageEvent,
  getWhatsAppMediaType,
  hasPotentialMedia
} = require('./whatsappUtils');
const {
  saveMessageMedia,
  isTenantMediaFilename,
  unavailableMediaContent,
  assertKnownInboundMediaSize,
  removeStoredTenantMediaSync
} = require('./mediaStorage');
const { downloadRealtimeMediaWithRetry } = require('./realtimeMediaDownloader');
const { inboundMediaLimiter } = require('./inboundMediaLimiter');
const { getConversationProfile } = require('./conversationProfile');
const {
  normalizePhoneInput,
  syncContacts,
  listContacts,
  syncConversationProfile,
  contactDisplayName,
  contactPhone
} = require('./whatsappDirectory');
const {
  uniqueIdentifiers,
  findOpenConversationByIdentifiers,
  linkConversationIdentifiers,
  getConversationIdentifiers,
  resolveWhatsAppIdentifierMap,
  resolveWhatsAppIdentifiers
} = require('./conversationIdentity');
const {
  sendOutboundMessage,
  getMaxOutboundMediaBytes,
  drainMessageQueues,
  abortMessageQueues,
  discardTenantMessageQueue,
  recoverInterruptedOutboundMessages
} = require('./messageSender');
const {
  hideMessageForUser,
  markMessageDeletedForEveryone,
  setMessagePinned
} = require('./messageActions');
const {
  addSupportMessage,
  getOrCreateSupportThread,
  getSupportMediaMessage,
  getSupportThread,
  listSupportMessages,
  listSupportThreads,
  markSupportThreadRead
} = require('./support');
const {
  canAccessConversation,
  getVisibleConversations,
  getConversationMessages,
  getMessageWithConversation,
  updateConversationUserState,
  isConversationMutedForUser,
  searchVisibleContent,
  getStarredMessages,
  setMessageStarred,
  markConversationRead
} = require('./messageQueries');
const {
  createSector,
  updateSector,
  listSectors,
  normalizeUsername,
  createUser,
  updateUser,
  deactivateUser,
  listUsers,
  countActiveUsers,
  assignConversation
} = require('./adminServices');

const app = express();
app.disable('x-powered-by');
const REDACTED_LOG_VALUE = '[Redacted]';
const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]'
    ],
    censor: REDACTED_LOG_VALUE
  }
});
startupWarnings.forEach(message => logger.warn(message));

function sanitizeHttpResponse(res) {
  if (res?.headers?.["set-cookie"]) {
    return {
      ...res,
      headers: {
        ...res.headers,
        "set-cookie": REDACTED_LOG_VALUE
      }
    };
  }
  return res;
}

function parseTrustProxy(value) {
  if (!value || value === 'false' || value === '0') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

const trustProxy = parseTrustProxy(process.env.TRUST_PROXY || '');
if (trustProxy) {
  app.set('trust proxy', trustProxy);
}

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : crypto.randomBytes(32).toString('hex'));
const corsOriginConfig = String(process.env.CORS_ORIGIN || '').trim();
const HISTORY_IMPORT_LIMIT = Number(process.env.HISTORY_IMPORT_LIMIT || 50);
const MEDIA_DOWNLOAD_TIMEOUT_MS = Number(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS || 8000);
const AUTO_IMPORT_DELAY_MS = Number(process.env.AUTO_IMPORT_DELAY_MS || 2000);
const AUTO_IMPORT_MAX_ATTEMPTS = Number(process.env.AUTO_IMPORT_MAX_ATTEMPTS || 8);
const CHAT_IMPORT_DELAY_MS = Number(process.env.CHAT_IMPORT_DELAY_MS || 250);
const RECENT_SYNC_INTERVAL_MS = Number(process.env.RECENT_SYNC_INTERVAL_MS || 10000);
const RECENT_SYNC_CHAT_LIMIT = Number(process.env.RECENT_SYNC_CHAT_LIMIT || 35);
const RECENT_SYNC_MESSAGE_LIMIT = Number(process.env.RECENT_SYNC_MESSAGE_LIMIT || 50);
const RECENT_SYNC_MAX_FETCH_LIMIT = Number(process.env.RECENT_SYNC_MAX_FETCH_LIMIT || 500);
const FULL_SYNC_MAX_FETCH_LIMIT = Number(process.env.FULL_SYNC_MAX_FETCH_LIMIT || 2000);
const FULL_SYNC_ABSOLUTE_MAX_FETCH_LIMIT = Number(
  process.env.FULL_SYNC_ABSOLUTE_MAX_FETCH_LIMIT || 20000
);
const FULL_RECONCILE_INTERVAL_MS = Number(process.env.FULL_RECONCILE_INTERVAL_MS || 15 * 60 * 1000);
const HISTORY_IMPORT_LOCK_WAIT_MS = Number(process.env.HISTORY_IMPORT_LOCK_WAIT_MS || 30000);
const HISTORY_CHAT_FETCH_TIMEOUT_MS = Number(process.env.HISTORY_CHAT_FETCH_TIMEOUT_MS || 60000);
const GET_CHATS_TIMEOUT_MS = Number(process.env.GET_CHATS_TIMEOUT_MS || 15000);
const CONTACT_SYNC_INTERVAL_MS = Number(process.env.CONTACT_SYNC_INTERVAL_MS || 6 * 60 * 60 * 1000);
const CONTACT_SYNC_START_DELAY_MS = Number(process.env.CONTACT_SYNC_START_DELAY_MS || 1000);
const CONTACT_SYNC_MANUAL_COOLDOWN_MS = Number(process.env.CONTACT_SYNC_MANUAL_COOLDOWN_MS || 30000);
const CONVERSATION_SYNC_MESSAGE_LIMIT = Number(process.env.CONVERSATION_SYNC_MESSAGE_LIMIT || 150);
const CONVERSATION_SYNC_TIMEOUT_MS = Number(process.env.CONVERSATION_SYNC_TIMEOUT_MS || 15000);
const CONVERSATION_SYNC_SETTLE_MS = Number(process.env.CONVERSATION_SYNC_SETTLE_MS || 2500);
const CONVERSATION_SYNC_COOLDOWN_MS = Number(process.env.CONVERSATION_SYNC_COOLDOWN_MS || 5000);
const OLDER_SYNC_MAX_FETCH_LIMIT = Number(process.env.OLDER_SYNC_MAX_FETCH_LIMIT || 20000);
const OLDER_SYNC_TIMEOUT_MS = Number(process.env.OLDER_SYNC_TIMEOUT_MS || 60000);
// Jitter humano antes de baixar mídia (anti-detecção). Configurável; 0 desliga.
const MEDIA_DOWNLOAD_JITTER_MS = Number(process.env.MEDIA_DOWNLOAD_JITTER_MS ?? 600);
const REALTIME_MESSAGE_MAX_AGE_MS = Number(process.env.REALTIME_MESSAGE_MAX_AGE_MS || 2 * 60 * 1000);
const PROFILE_FETCH_TIMEOUT_MS = Number(process.env.PROFILE_FETCH_TIMEOUT_MS || 2500);
const INCOMING_ENRICHMENT_CONCURRENCY = Number(process.env.INCOMING_ENRICHMENT_CONCURRENCY || 2);
const INCOMING_ENRICHMENT_MAX_PENDING = Number(process.env.INCOMING_ENRICHMENT_MAX_PENDING || 500);
const REALTIME_MEDIA_DOWNLOAD_ATTEMPTS = Number(process.env.REALTIME_MEDIA_DOWNLOAD_ATTEMPTS || 4);
const REALTIME_MEDIA_RETRY_BASE_DELAY_MS = Number(process.env.REALTIME_MEDIA_RETRY_BASE_DELAY_MS || 750);
const REALTIME_MEDIA_REPAIR_MAX_ATTEMPTS = Number(process.env.REALTIME_MEDIA_REPAIR_MAX_ATTEMPTS || 5);
const REALTIME_MEDIA_REPAIR_LOOKBACK_HOURS = Number(process.env.REALTIME_MEDIA_REPAIR_LOOKBACK_HOURS || 24);
const REALTIME_MEDIA_REPAIR_BATCH_LIMIT = Number(process.env.REALTIME_MEDIA_REPAIR_BATCH_LIMIT || 100);
const SOCKET_RATE_LIMIT_WINDOW_MS = Number(process.env.SOCKET_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const SOCKET_RATE_LIMIT_MAX = Number(process.env.SOCKET_RATE_LIMIT_MAX || 60);
const SHUTDOWN_DRAIN_TIMEOUT_MS = Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS || 5000);
const SHUTDOWN_HTTP_TIMEOUT_MS = Number(process.env.SHUTDOWN_HTTP_TIMEOUT_MS || 5000);
const SHUTDOWN_WHATSAPP_TIMEOUT_MS = Number(process.env.SHUTDOWN_WHATSAPP_TIMEOUT_MS || 10000);
const DATA_ROOT = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || path.join(__dirname, 'media'));
const WA_AUTH_ROOT = path.resolve(process.env.WA_AUTH_DIR || path.join(__dirname, '.wwebjs_auth'));
const MIN_RUNTIME_FREE_DISK_BYTES = Number(process.env.MIN_RUNTIME_FREE_DISK_MB
  || (process.env.NODE_ENV === 'production' ? 1024 : 64)) * 1024 * 1024;

function validateRuntimeConfig() {
  const production = process.env.NODE_ENV === 'production';
  const missing = [];
  if (production && (!JWT_SECRET || JWT_SECRET.length < 32)) missing.push('JWT_SECRET (mínimo 32 caracteres)');
  if (production && !corsOriginConfig) missing.push('CORS_ORIGIN');
  if (production && !process.env.APP_URL) missing.push('APP_URL');
  // As chaves do Stripe deixaram de ser obrigatórias no boot: o super admin as
  // configura em runtime pela aba Stripe (guardadas criptografadas no master.db).
  // Enquanto não configuradas, o produto sobe e os tenants seguem em trial; o
  // checkout só fica disponível depois que as chaves são preenchidas no painel.
  if (production && !INTERNAL_EDITION && process.env.TRIAL_DAYS && Number(process.env.TRIAL_DAYS) !== 3) {
    throw new Error('TRIAL_DAYS deve ser exatamente 3 em produção');
  }
  if (production && !INTERNAL_EDITION && process.env.BILLING_REQUIRED === 'false') {
    throw new Error('BILLING_REQUIRED nao pode ser desativado em produção');
  }
  if (production && INTERNAL_EDITION && process.env.BILLING_REQUIRED !== 'false') {
    throw new Error('BILLING_REQUIRED deve ser false na edicao interna');
  }
  if (production && INTERNAL_EDITION && Number(process.env.WA_MAX_CONCURRENT_SESSIONS || 1) !== 1) {
    throw new Error('WA_MAX_CONCURRENT_SESSIONS deve ser 1 na edicao interna');
  }
  if (production && process.env.COOKIE_SECURE === 'false') {
    throw new Error('COOKIE_SECURE nao pode ser desativado em produção');
  }
  if (production && !['isolated', 'per-tenant'].includes(String(process.env.WA_BROWSER_MODE || 'isolated').toLowerCase())) {
    throw new Error('WA_BROWSER_MODE deve manter isolamento por tenant em produção');
  }
  if (production && !INTERNAL_EDITION && process.env.STRIPE_SECRET_KEY && !String(process.env.STRIPE_SECRET_KEY).startsWith('sk_live_')) {
    throw new Error('STRIPE_SECRET_KEY deve ser uma chave live em produção');
  }
  if (production && process.env.APP_URL) {
    let appOrigin;
    try {
      const appUrl = new URL(process.env.APP_URL);
      if (appUrl.protocol !== 'https:' || appUrl.origin + '/' !== appUrl.href.replace(/\/?$/, '/')) throw new Error();
      appOrigin = appUrl.origin;
    } catch {
      throw new Error('APP_URL deve ser uma origem HTTPS sem caminho em produção');
    }
    const configuredOrigins = corsOriginConfig.split(',').map(value => value.trim()).filter(Boolean);
    if (configuredOrigins.length !== 1 || configuredOrigins[0] !== appOrigin) {
      throw new Error('CORS_ORIGIN deve ser exatamente APP_URL em produção');
    }
  }
  if (missing.length) throw new Error(`Configuração obrigatória ausente: ${missing.join(', ')}`);
  if (!process.env.JWT_SECRET) {
    logger.warn('JWT_SECRET nao configurado; usando segredo temporario de desenvolvimento');
  }
  if (production && !INTERNAL_EDITION && !process.env.SUPERADMIN_TOTP_SECRET) {
    logger.warn(
      'SUPERADMIN_TOTP_SECRET ausente: super admin opera SEM segundo fator em produção '
      + '(decisão do operador em 15/jul/2026; para reativar, defina o segredo e recrie o container)'
    );
  }
}

validateRuntimeConfig();

const allowedOrigins = corsOriginConfig
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const corsOptions = {
  origin(origin, callback) {
    if (!origin || !allowedOrigins.length || allowedOrigins.includes(origin)) return callback(null, true);
    const err = new Error('Origem nao permitida pelo CORS');
    err.statusCode = 403;
    return callback(err);
  },
  credentials: true
};

// Hosts derivados das origens configuradas, para validar requisicao sem Origin.
const allowedHosts = allowedOrigins
  .map(origin => { try { return new URL(origin).host.toLowerCase(); } catch { return null; } })
  .filter(Boolean);

// Navegador NAO envia Origin em GET/HEAD same-origin — e o transporte polling
// do socket.io e exatamente isso. Tratar a ausencia como proibida derrubava
// TODO o tempo real em producao: o painel recebia 403 em cada tentativa de
// conexao (1.570 no log do nginx em poucas horas), o frontend engolia o
// connect_error, e a conversa so atualizava quando algum refresh por HTTP
// acontecia — ao enviar mensagem ou recarregar a pagina.
//
// Um pedido cross-site feito por navegador SEMPRE carrega Origin, entao a
// ausencia dele indica same-origin (seguro) ou cliente fora do navegador, onde
// o JWT do handshake e que barra. Confirmamos pelo Host, que o navegador nao
// permite forjar. O CORS de HTTP nesta mesma app ja aceitava origem ausente
// (corsOptions acima); o socket estava mais restritivo por acidente, nao por
// decisao.
function isSocketOriginAllowed(origin, host) {
  const normalizedOrigin = String(origin || '').trim();
  if (!normalizedOrigin) {
    if (!allowedHosts.length) return process.env.NODE_ENV !== 'production';
    return allowedHosts.includes(String(host || '').trim().toLowerCase());
  }
  if (!allowedOrigins.length) return process.env.NODE_ENV !== 'production';
  return allowedOrigins.includes(normalizedOrigin);
}
const loginLimiter = rateLimit({
  windowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  limit: Number(process.env.LOGIN_RATE_LIMIT_MAX || 20),
  standardHeaders: 'draft-8',
  legacyHeaders: false
});
const apiLimiter = rateLimit({
  windowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60 * 1000),
  limit: Number(process.env.API_RATE_LIMIT_MAX || 240),
  // Depois do login, cada identidade recebe seu próprio orçamento. Limitar
  // somente pelo IP derrubava todos os vendedores de um escritório/NAT quando
  // uma única tela movimentada fazia muitos refreshes.
  keyGenerator(req) {
    const token = getAuthToken(req);
    if (token) {
      try {
        const principal = validateAuthenticatedPrincipal(jwt.verify(token, JWT_SECRET));
        return `principal:${principal.tenant_id || 'platform'}:${principal.role}:${principal.id}`;
      } catch {
        // Token inválido continua no orçamento do IP e será recusado pelo auth.
      }
    }
    return `ip:${rateLimit.ipKeyGenerator(req.ip)}`;
  },
  standardHeaders: 'draft-8',
  legacyHeaders: false
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.REGISTER_RATE_LIMIT_MAX || 5),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de registro. Tente novamente mais tarde.' }
});
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente mais tarde.' }
});
const csrfMiddleware = createCsrfMiddleware({
  exemptPaths: [
    '/login',
    '/register',
    '/forgot-password',
    '/webhooks/stripe'
  ]
});
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: corsOptions,
  allowRequest(request, callback) {
    callback(null, isSocketOriginAllowed(request.headers?.origin, request.headers?.host));
  }
});
const presenceRegistry = createPresenceRegistry({
  onChange: (tenantId, users) => {
    if (tenantId && isTenantOperational(tenantId)) {
      io.to(tenantAdminRoom(tenantId)).emit('presence:changed', { users });
    }
  }
});
const socketAuthAttempts = new Map();
const socketAuthRateLimiter = createSocketRateLimiter({
  attempts: socketAuthAttempts,
  windowMs: SOCKET_RATE_LIMIT_WINDOW_MS,
  maxAttempts: SOCKET_RATE_LIMIT_MAX
});

app.use(cors(corsOptions));
app.use(pinoHttp({
  logger,
  serializers: {
    res: sanitizeHttpResponse
  }
}));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://challenges.cloudflare.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://pps.whatsapp.net'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      frameSrc: ['https://challenges.cloudflare.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null
    }
  },
  hsts: process.env.NODE_ENV === 'production'
}));

function setNoStoreHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

// A autenticação é baseada em cookies. Nenhuma resposta de API pode ser
// reutilizada por navegador, BFCache ou proxy entre sessões/contas distintas.
// Este middleware precisa permanecer antes do webhook, que também é /api.
app.use('/api', (_req, res, next) => {
  setNoStoreHeaders(res);
  next();
});

// A edição exclusiva não expõe nenhuma superfície SaaS, nem mesmo quando uma
// URL é chamada diretamente. O bloqueio fica antes do webhook, dos parsers e
// dos arquivos estáticos para não inicializar integrações comerciais.
app.use((req, res, next) => {
  if (!INTERNAL_EDITION) return next();
  if (isInternalBlockedApiPath(req.path)) {
    return res.status(404).json({
      error: 'Recurso indisponível na edição interna',
      code: 'INTERNAL_MODE'
    });
  }
  if (isInternalHtmlPath(req.path) || req.path.startsWith('/support-media/')) {
    setNoStoreHeaders(res);
    return res.status(404).type('text/plain').send('Página não encontrada');
  }
  return next();
});

// Webhook do Stripe precisa do corpo bruto (raw) para validar a assinatura,
// então é registrado ANTES do parser JSON global.
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const { getStripe, handleWebhookEvent } = require('./billing');
  // O signing secret pode vir do painel (master.db) ou de variável de ambiente.
  const webhookSecret = require('./tenantManager').getResolvedPlatformEnv().STRIPE_WEBHOOK_SECRET
    || process.env.STRIPE_WEBHOOK_SECRET
    || '';
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
  } catch (err) {
    logger.warn({ err }, 'Assinatura de webhook do Stripe inválida');
    return res.status(400).json({ error: 'Assinatura inválida' });
  }
  try {
    const result = handleWebhookEvent(event, logger);
    if (result?.tenantId) {
      if (isTenantOperational(result.tenantId)) resumeTenantRuntimeAfterBilling(result.tenantId, { force: true });
      else pauseTenantRuntimeForBilling(result.tenantId);
    }
    return res.json({ received: true });
  } catch (err) {
    logger.error({ err, eventType: event.type }, 'Erro ao processar webhook do Stripe');
    // A Stripe somente tenta novamente quando recebe um status nao-2xx.
    return res.status(500).json({ error: 'Falha temporaria ao processar webhook' });
  }
});

app.use('/api/login', loginLimiter);
app.use('/api/', apiLimiter);
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '50mb' }));
app.use(express.static(path.join(__dirname, 'frontend'), {
  index: INTERNAL_EDITION ? false : 'index.html',
  setHeaders(res, filePath) {
    if (path.extname(filePath).toLowerCase() === '.html') setNoStoreHeaders(res);
  }
}));

// Rotas PÚBLICAS (precisam vir ANTES do tenant middleware)
app.get('/', (_req, res) => {
  setNoStoreHeaders(res);
  if (INTERNAL_EDITION) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

app.get('/health/live', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

function readinessChecks() {
  let database = false;
  let masterDatabase = false;
  const storageChecks = {
    dataStorage: false,
    mediaStorage: false,
    whatsappStorage: false
  };
  try {
    database = db.defaultDb.prepare('SELECT 1 AS ok').get()?.ok === 1;
  } catch {}
  try {
    masterDatabase = master.prepare('SELECT 1 AS ok').get()?.ok === 1;
  } catch {}
  for (const [name, directory] of [
    ['dataStorage', DATA_ROOT],
    ['mediaStorage', MEDIA_ROOT],
    ['whatsappStorage', WA_AUTH_ROOT]
  ]) {
    try {
      const target = fs.existsSync(directory) ? directory : path.dirname(directory);
      const stats = fs.statfsSync(target);
      const available = Number(stats.bavail || 0) * Number(stats.bsize || 0);
      storageChecks[name] = Number.isFinite(available)
        && available >= MIN_RUNTIME_FREE_DISK_BYTES;
    } catch {}
  }
  const writerLease = require('./productionWriterBootstrap').isProductionWriterLeaseHealthy();
  // A prontidão do billing não depende mais das chaves estarem preenchidas —
  // elas são configuradas pelo super admin em runtime. O subsistema está pronto
  // desde que o master.db responda (já coberto por masterDatabase). Se as chaves
  // estão de fato configuradas é reportado à parte, em `billingConfigured`, sem
  // derrubar o /health/ready no primeiro boot após o deploy.
  const billing = true;
  return {
    database,
    masterDatabase,
    writerLease,
    storage: Object.values(storageChecks).every(Boolean),
    ...storageChecks,
    billing,
    whatsappManager: Boolean(waManagerReady)
  };
}

function isBillingConfigured() {
  if (INTERNAL_EDITION) return false;
  const resolved = require('./tenantManager').getResolvedPlatformEnv();
  const effective = { ...process.env, ...resolved };
  return require('./billing').getBillingConfigurationStatus(effective).configured;
}

function getSignupChallengeConfiguration() {
  const resolved = require('./tenantManager').getResolvedPlatformEnv();
  const effective = { ...process.env, ...resolved };
  return {
    effective,
    status: getTurnstileConfigurationStatus(effective)
  };
}

function isPublicSignupConfigured() {
  if (INTERNAL_EDITION) return false;
  if (process.env.NODE_ENV !== 'production') return true;
  const challenge = getSignupChallengeConfiguration().status;
  return isBillingConfigured() && (challenge.configured || challenge.reason === 'disabled');
}

function sendReadiness(_req, res) {
  const checks = readinessChecks();
  const ok = Object.values(checks).every(Boolean);
  const whatsappSessions = waManagerReady ? waManager.listSessions() : [];
  res.status(ok ? 200 : 503).json({
    ok,
    checks,
    // Informativo: o billing pode estar pronto (subsistema ok) mas ainda não
    // configurado pelo super admin. Não entra em `checks` para não bloquear.
    billingConfigured: isBillingConfigured(),
    whatsapp: {
      activeSessions: whatsappSessions.filter(session => session.status !== 'queued_capacity').length,
      readySessions: whatsappSessions.filter(session => session.ready).length,
      queuedSessions: whatsappSessions.filter(session => session.status === 'queued_capacity').length,
      manualActionRequired: whatsappSessions.filter(session => session.requiresManualAction).length
    },
    synchronization: {
      tenantsWithConsecutiveRuntimeFailures: syncRuntimeFailureCounts.size,
      enrichmentQueue: incomingEnrichmentQueue.getStats(),
      inboundMedia: inboundMediaLimiter.getStats()
    },
    defaultConnectionState: lastClientState,
    uptime: process.uptime()
  });
}

app.get('/health', sendReadiness);
app.get('/health/ready', sendReadiness);

app.get('/api/csrf-token', (req, res) => {
  const csrfToken = readCsrfToken(req)
    || issueCsrfToken(res, { secure: isSecureCookie(req) });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ csrfToken });
});

app.use('/api', csrfMiddleware);

// ============ MULTI-TENANT ============
// Um único domínio serve todos os clientes. O tenant não é resolvido pela URL
// (subdomínio) — é resolvido pelo usuário autenticado: o login localiza a
// empresa do usuário no diretório global e o token JWT carrega o tenant_id;
// authMiddleware() usa esse tenant_id para apontar `db` para o banco certo.
const {
  master,
  getTenantBySlug,
  getTenantDb,
  getTenantUserLimit,
  withTenantCapacityLock,
  findDirectoryUser,
  registerDirectoryUser,
  renameDirectoryUser,
  acquireTenantDbLease,
  releaseTenantDbLease,
  setPlatformConfig,
  getPlatformConfigStatus
} = require('./tenantManager');
const QRCode = require('qrcode');

app.post('/api/qrcode', authMiddleware(['admin']), async (req, res) => {
  const data = String(req.body?.data || '');
  if (!data) return res.status(400).json({ error: 'Parametro data obrigatorio' });
  if (data.length > 4096) return res.status(400).json({ error: 'Parametro data muito grande' });
  try {
    const qrSvg = await QRCode.toString(data, { type: 'svg', margin: 1, width: 240 });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-store');
    res.send(qrSvg);
  } catch (err) {
    logger.error({ err }, 'Erro ao gerar QR code');
    res.status(500).json({ error: 'Erro ao gerar QR code' });
  }
});

app.get('/api/branding', (_req, res) => {
  if (INTERNAL_EDITION) {
    return res.json({
      appName: process.env.APP_NAME || 'WhatsCarretao',
      appCompany: process.env.APP_COMPANY || 'Auto Peças Carretão',
      logoUrl: '/assets/carretao-logo.svg',
      internalEdition: true,
      signupBillingConfigured: false,
      signupConfigured: false,
      turnstileSiteKey: ''
    });
  }
  const challenge = getSignupChallengeConfiguration();
  res.json({
    appName: process.env.APP_NAME || 'WhatsApp AI',
    appCompany: process.env.APP_COMPANY || '',
    // Evita que o visitante preencha todo o formulário quando o Checkout não
    // pode ser criado. Nenhuma chave ou detalhe sensível é exposto.
    signupBillingConfigured: process.env.NODE_ENV !== 'production' || isBillingConfigured(),
    signupConfigured: isPublicSignupConfigured(),
    // A site key é pública por definição; a secret key nunca sai do backend. Vem
    // do painel (master.db) ou do ambiente. Vazia = captcha desligado no front.
    turnstileSiteKey: challenge.status.configured ? challenge.effective.TURNSTILE_SITE_KEY : ''
  });
});

function validateBcryptPassword(password) {
  if (typeof password !== 'string' || Array.from(password).length < 10 || !password.trim()) {
    const error = new Error('Senha deve ter no mínimo 10 caracteres');
    error.statusCode = 400;
    throw error;
  }
  if (Buffer.byteLength(password, 'utf8') > 72) {
    const error = new Error('Senha deve ter no máximo 72 bytes UTF-8');
    error.statusCode = 400;
    throw error;
  }
  return password;
}

function isPlatformAdminUsername(username) {
  const normalized = normalizeDirectoryUsername(username);
  if (!normalized) return false;
  return Boolean(db.defaultDb.prepare(`
    SELECT 1
    FROM admins
    WHERE username = ? COLLATE NOCASE AND coalesce(super_admin, 0) = 1
  `).get(normalized));
}

app.post('/api/register', registerLimiter, async (req, res) => {
  let createdTenant = null;
  let compensationEligible = false;
  let billingCheckoutStarted = false;
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const companyName = String(body.companyName || '').trim();
    const adminName = String(body.adminName || '').trim();
    const email = normalizeDirectoryUsername(body.email);
    const password = String(body.password || '');
    const plan = body.plan;
    if (!companyName || !adminName || !email || !password) {
      return res.status(400).json({ error: 'Preencha todos os campos' });
    }
    if (companyName.length > 160 || adminName.length > 160 || email.length > 254
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Dados de cadastro invalidos' });
    }
    validateBcryptPassword(password);
    const billingRequired = process.env.NODE_ENV === 'production' && process.env.BILLING_REQUIRED !== 'false';
    if (billingRequired && !isBillingConfigured()) {
      logger.warn('Cadastro recusado porque a cobrança Stripe ainda não está configurada');
      return res.status(503).json({
        error: 'Cadastros temporariamente indisponíveis. Tente novamente mais tarde.',
        code: 'BILLING_NOT_CONFIGURED'
      });
    }
    // O captcha só é exigido quando o Turnstile está configurado (painel ou
    // ambiente). Sem a secret key, o cadastro segue sem a verificação até o
    // super admin ligar a proteção pela aba de configuração.
    const challenge = getSignupChallengeConfiguration();
    if (!challenge.status.configured && challenge.status.reason !== 'disabled') {
      logger.error({ reason: challenge.status.reason }, 'Cadastro recusado por configuração Turnstile inválida');
      return res.status(503).json({
        error: 'Cadastros temporariamente indisponíveis. Tente novamente mais tarde.',
        code: 'SIGNUP_CONFIGURATION_INVALID'
      });
    }
    if (challenge.status.configured) {
      await verifyTurnstileToken({
        token: body.turnstileToken,
        remoteIp: req.ip,
        secretKey: challenge.effective.TURNSTILE_SECRET_KEY,
        expectedHostname: process.env.APP_URL ? new URL(process.env.APP_URL).hostname : req.hostname
      });
    }
    if (findDirectoryUser(email) || isPlatformAdminUsername(email)) {
      return res.status(409).json({ error: 'Este e-mail já está cadastrado' });
    }
    const {
      createTenant,
      activateTenant,
      setBillingFields,
      tenantSlugBase
    } = require('./tenantManager');
    const tenant = createTenant({
      name: companyName,
      slug: tenantSlugBase(companyName),
      plan,
      uniqueSlug: true,
      runtimeTenantLimit: process.env.NODE_ENV === 'production'
        ? Number(process.env.WA_MAX_CONCURRENT_SESSIONS || 5)
        : null,
      // O tenant só aceita login depois que banco, admin, diretório global e
      // vínculo inicial de cobrança terminaram de forma durável.
      deferActivation: true
    });
    createdTenant = tenant;
    compensationEligible = true;
    const tenantId = tenant.id;
    const tenantDb = getTenantDb(tenantId);
    const hash = bcrypt.hashSync(password, 10);
    tenantDb.prepare('INSERT INTO admins (name, username, password, super_admin) VALUES (?, ?, ?, 0)')
      .run(adminName, email, hash);
    registerDirectoryUser(email, tenantId, 'admin');

    let checkoutUrl = null;
    if (billingRequired) {
      // Nenhum tenant de producao usa o sistema antes de vincular a assinatura.
      // O Checkout carrega o fim do trial imutavel criado com o tenant.
      setBillingFields(tenantId, { billing_status: 'checkout_pending' });
      const pendingTenant = require('./tenantManager').getTenant(tenantId);
      const { createCheckoutSession } = require('./billing');
      const appUrl = String(process.env.APP_URL).replace(/\/$/, '');
      billingCheckoutStarted = true;
      const session = await createCheckoutSession(pendingTenant, email, {
        successUrl: `${appUrl}/admin.html?tab=financeiro&billing=success`,
        cancelUrl: `${appUrl}/admin.html?tab=financeiro&billing=cancelled`
      });
      checkoutUrl = session.url;
      if (!checkoutUrl) throw new Error('Stripe nao retornou a URL do Checkout');
    }

    const activeTenant = activateTenant(tenantId);
    // Depois deste ponto a conta está completa e pertence ao cliente. Falhas
    // de auditoria/notificação/resposta jamais podem disparar compensação
    // destrutiva de um tenant já ativo.
    compensationEligible = false;

    const admin = tenantDb.prepare('SELECT id, name, token_version FROM admins WHERE username = ?').get(email);
    issueAuthenticatedSession(req, res, {
      id: admin.id,
      username: email,
      name: admin.name || adminName,
      role: 'admin',
      tenant_id: tenantId,
      super_admin: false,
      token_version: admin.token_version || 0
    });
    require('./tenantManager').logAudit('signup', 'tenant_created', tenantId, { companyName, email });
    require('./notifications').notifyNewSignup({ companyName, email }, logger).catch(() => {});
    logger.info({ tenantId, slug: tenant.slug, email }, 'Novo tenant registrado');
    res.status(201).json({
      success: true,
      checkout_url: checkoutUrl,
      tenant: {
        slug: activeTenant.slug,
        name: companyName,
        plan: activeTenant.plan,
        trial_ends_at: activeTenant.trial_ends_at
      }
    });
  } catch (err) {
    if (createdTenant && compensationEligible) {
      try {
        const { deleteTenant } = require('./tenantManager');
        await deleteTenant(createdTenant.id, {
          afterQuarantine: current => require('./billing').deleteTenantBilling(current)
        });
      } catch (cleanupError) {
        logger.error({ err: cleanupError, tenantId: createdTenant.id }, 'Falha ao desfazer cadastro incompleto');
      }
    }
    logger.error({ err }, 'Erro no registro');
    if (err.code === 'SIGNUP_CHALLENGE_UNAVAILABLE') {
      return res.status(503).json({
        error: 'Verificação anti-robô temporariamente indisponível. Tente novamente mais tarde.',
        code: err.code
      });
    }
    if (err.code === 'TENANT_RUNTIME_CAPACITY_REACHED') {
      return res.status(503).json({
        error: 'Cadastros temporariamente indisponíveis. Tente novamente mais tarde.',
        code: err.code
      });
    }
    if (billingCheckoutStarted) {
      return res.status(503).json({
        error: 'Cobrança temporariamente indisponível. Tente novamente mais tarde.',
        code: 'BILLING_UNAVAILABLE'
      });
    }
    sendRouteError(res, err);
  }
});
// ==================================================

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return '';
  const match = cookieHeader
    .split(';')
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(`${name}=`));
  if (!match) return '';
  return decodeURIComponent(match.slice(name.length + 1));
}

function getAuthToken(req) {
  return getCookie(req, 'auth_token');
}

function isSecureCookie(req) {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return Boolean(req?.secure || forwardedProto === 'https');
}

function setAuthCookie(req, res, token) {
  res.cookie('auth_token', token, {
    path: '/',
    // Lax permite o retorno top-level do Checkout Stripe. Requisicoes de
    // mutacao continuam protegidas pelo token CSRF de cookie duplo.
    sameSite: 'lax',
    secure: isSecureCookie(req),
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function issueAuthenticatedSession(req, res, claims) {
  const principal = validateAuthenticatedPrincipal({
    ...claims,
    // A sala da sessão é deliberadamente diferente em cada login. Assim,
    // trocar de empresa no mesmo navegador encerra apenas o socket preso ao
    // cookie anterior, sem derrubar outros dispositivos do mesmo usuário.
    session_id: crypto.randomUUID()
  });
  disconnectPreviousBrowserSession(req, principal);
  const token = jwt.sign(principal, JWT_SECRET, { expiresIn: '7d' });
  setAuthCookie(req, res, token);
  // Um perfil de navegador pode ser reutilizado por pessoas/empresas
  // diferentes. Limpar o cache na troca de sessão impede que uma resposta de
  // mídia autenticada da conta anterior seja reaproveitada pelo navegador.
  res.setHeader('Clear-Site-Data', '"cache"');
  // Trocar de conta no mesmo navegador invalida mutações pendentes de abas
  // antigas. A nova página recebe um token CSRF próprio da sessão recém-criada.
  issueCsrfToken(res, { secure: isSecureCookie(req) });
  return principal;
}

function sendInternalError(res) {
  return res.status(500).json({ error: 'Erro interno do servidor' });
}

function parsePositiveInt(value, label = 'id') {
  if (typeof value === 'boolean'
      || (typeof value === 'string' && !/^[1-9]\d*$/.test(value.trim()))) {
    const err = new Error(`${label} inválido`);
    err.statusCode = 400;
    throw err;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    const err = new Error(`${label} inválido`);
    err.statusCode = 400;
    throw err;
  }
  return number;
}

function parseOptionalPositiveInt(value, label = 'id') {
  if (value === undefined || value === null || value === '') return null;
  return parsePositiveInt(value, label);
}

function parseExpectedRowVersion(value) {
  if (value === undefined || value === null || value === '') {
    const err = new Error('Versao do registro obrigatoria; recarregue os dados');
    err.statusCode = 428;
    err.code = 'VERSION_REQUIRED';
    throw err;
  }
  return parsePositiveInt(value, 'versao do registro');
}

function auditSecurityEvent(req, action, detail = {}) {
  try {
    const { logAudit } = require('./tenantManager');
    const safeDetail = { ...detail };
    delete safeDetail.password;
    delete safeDetail.token;
    delete safeDetail.adminPassword;
    delete safeDetail.actorOverride;
    safeDetail.ip = req.ip;
    // Em rotas autenticadas, o ator é sempre quem fez a requisição. Campos
    // como detail.username normalmente descrevem o usuário-alvo da ação e
    // nunca podem falsificar a autoria do log.
    const actor = req.user
      ? (req.user.username || `${req.user.role}:${req.user.id}`)
      : (detail.actorOverride || detail.username || 'anonymous');
    const tenantId = Object.hasOwn(detail, 'tenantId') ? detail.tenantId : req.user?.tenant_id;
    logAudit(actor, action, tenantId || null, safeDetail);
  } catch (err) {
    logger.warn({ err, action }, 'Falha ao gravar auditoria de segurança');
  }
}

function sendRouteError(res, err) {
  if (err.statusCode && err.statusCode >= 400 && (err.statusCode < 500 || err.statusCode === 507)) {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(Number.isSafeInteger(err.currentVersion) ? { current_version: err.currentVersion } : {})
    });
  }
  return sendInternalError(res);
}

// Super admin (dono da plataforma) vive no banco padrão (data.db), fora de
// qualquer tenant. Admin de empresa e vendedor vivem no banco do tenant —
// por isso dependem do contexto de tenant já estar setado (ver authMiddleware).
function getCurrentTokenVersion(user) {
  if (user.super_admin) {
    return db.defaultDb.prepare('SELECT token_version FROM admins WHERE id = ?').get(user.id)?.token_version;
  }
  if (user.role === 'admin') {
    return db.prepare('SELECT token_version FROM admins WHERE id = ?').get(user.id)?.token_version;
  }
  if (user.role === 'vendor') {
    return db.prepare(`
      SELECT v.token_version
      FROM vendors v
      JOIN sectors s ON s.id = v.sector_id AND s.active = 1
      WHERE v.id = ? AND v.active = 1
    `).get(user.id)?.token_version;
  }
  return null;
}

function isTokenVersionCurrent(user) {
  const currentVersion = getCurrentTokenVersion(user);
  return currentVersion !== undefined && currentVersion !== null && Number(user.token_version || 0) === Number(currentVersion);
}

function incrementTokenVersion(user) {
  if (user.super_admin) {
    return db.defaultDb.prepare('UPDATE admins SET token_version = token_version + 1 WHERE id = ?').run(user.id);
  }
  if (user.role === 'admin') {
    return db.prepare('UPDATE admins SET token_version = token_version + 1 WHERE id = ?').run(user.id);
  }
  if (user.role === 'vendor') {
    return db.prepare('UPDATE vendors SET token_version = token_version + 1 WHERE id = ?').run(user.id);
  }
  return { changes: 0 };
}

function revokeAllTenantSessions(tenantId) {
  const normalizedTenantId = parsePositiveInt(tenantId, 'tenant');
  const tenantDb = acquireTenantDbLease(normalizedTenantId);
  try {
    return tenantDb.transaction(() => {
      const admins = tenantDb.prepare('UPDATE admins SET token_version = token_version + 1').run().changes;
      const vendors = tenantDb.prepare('UPDATE vendors SET token_version = token_version + 1').run().changes;
      return { admins, vendors };
    })();
  } finally {
    releaseTenantDbLease(normalizedTenantId);
  }
}

function disconnectUserSockets(user) {
  if (!user?.role || user.id == null) return;
  io.in(identityRoom(user, user.tenant_id)).disconnectSockets(true);
}

function disconnectPreviousBrowserSession(req, nextUser) {
  const previousToken = getAuthToken(req);
  if (!previousToken) return false;
  try {
    const previousUser = validateAuthenticatedPrincipal(jwt.verify(previousToken, JWT_SECRET));
    if (samePrincipal(previousUser, nextUser)) return false;
    const previousSessionRoom = sessionRoom(previousUser, previousUser.tenant_id);
    io.to(previousSessionRoom).emit('auth:session-replaced');
    io.in(previousSessionRoom).disconnectSockets(true);
    return true;
  } catch {
    return false;
  }
}

function disconnectTenantSockets(tenantId, { includeRestricted = false } = {}) {
  const id = Number(tenantId);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  io.in(tenantOperationalRoom(id)).disconnectSockets(true);
  if (includeRestricted) io.in(supportTenantRoom(id)).disconnectSockets(true);
  presenceRegistry.clearTenant(id);
}

function isBillingRecoveryRequest(req, user, blocked = null) {
  if (user?.role !== 'admin' || user.super_admin) return false;
  const pathname = String(req.path || req.originalUrl || '').split('?')[0];
  const standardRecovery = pathname === '/api/me'
    || pathname === '/api/logout'
    || pathname.startsWith('/api/billing/')
    || pathname.startsWith('/api/support/')
    || pathname.startsWith('/support-media/');
  if (standardRecovery) return true;

  // Um downgrade 10 -> 5 pode deixar a conta acima da capacidade. O admin
  // precisa enxergar os usuários e desativar o excedente para a conta se
  // recuperar; nenhuma outra operação normal é liberada durante o bloqueio.
  if (blocked?.billing_block_reason !== 'plan_capacity') return false;
  if (req.method === 'GET') {
    return pathname === '/api/vendors'
      || pathname === '/api/sectors'
      || pathname === '/api/admin/user-limit';
  }
  return req.method === 'DELETE' && /^\/api\/vendors\/[1-9]\d*$/.test(pathname);
}

// Resolve o tenant a partir do token (não da URL) e roda o resto da
// requisição com `db` apontando para o banco daquele tenant.
function authMiddleware(roles = []) {
  return (req, res, next) => {
    const token = getAuthToken(req);
    if (!token) return res.status(401).json({ error: 'Token ausente' });

    let decoded;
    try {
      decoded = validateAuthenticatedPrincipal(jwt.verify(token, JWT_SECRET));
    } catch {
      return res.status(401).json({ error: 'Token inválido' });
    }

    if (roles.length && !roles.includes(decoded.role)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    req.user = decoded;

    const proceed = () => {
      if (!isTokenVersionCurrent(decoded)) {
        return res.status(401).json({ error: 'Token revogado' });
      }
      if (decoded.tenant_id) {
        const blocked = checkBillingBlock(decoded.tenant_id);
        if (blocked && !isBillingRecoveryRequest(req, decoded, blocked)) return res.status(402).json(blocked);
      }
      next();
    };

    if (decoded.tenant_id) {
      try {
        // Verifica que o tenant ainda existe ANTES de abrir o banco — senão um
        // token de tenant excluído "ressuscitaria" o arquivo .db vazio.
        const { getTenant } = require('./tenantManager');
        const tenant = getTenant(decoded.tenant_id);
        if (!tenant || tenant.status !== 'active') {
          return res.status(401).json({ error: 'Empresa não encontrada ou desativada' });
        }
        const tenantDb = acquireTenantDbLease(decoded.tenant_id);
        let tenantLeaseReleased = false;
        const releaseLease = () => {
          if (tenantLeaseReleased) return;
          tenantLeaseReleased = true;
          releaseTenantDbLease(decoded.tenant_id);
        };
        res.once('finish', releaseLease);
        res.once('close', releaseLease);
        req.tenant = { id: decoded.tenant_id, db: tenantDb };
        db.tenantCtx.run({ db: tenantDb, tenantId: decoded.tenant_id }, proceed);
      } catch (err) {
        logger.error({ err, tenantId: decoded.tenant_id }, 'Erro ao resolver tenant do token');
        res.status(500).json({ error: 'Erro ao resolver tenant' });
      }
    } else {
      proceed();
    }
  };
}

function tenantAuthMiddleware(roles = []) {
  const authenticate = authMiddleware(roles);
  return (req, res, next) => authenticate(req, res, () => {
    if (!isTenantPrincipal(req.user)
        || !req.tenant
        || Number(req.tenant.id) !== Number(req.user.tenant_id)) {
      return res.status(403).json({ error: 'Esta operação exige uma conta de empresa' });
    }
    return next();
  });
}

function findMediaConversation(filename) {
  return db.prepare(`
    SELECT c.*, m.media_mimetype
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.media_url = ?
    ORDER BY m.id DESC
    LIMIT 1
  `).get(`/media/${filename}`);
}

function safeHeaderFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160) || 'media';
}

app.get('/media/:filename', tenantAuthMiddleware(), (req, res, next) => {
  const filename = path.basename(String(req.params.filename || ''));
  if (!filename || filename !== req.params.filename) {
    return res.status(400).json({ error: 'Arquivo inválido' });
  }
  if (!req.user.tenant_id || !isTenantMediaFilename(filename, req.user.tenant_id)) {
    return res.status(404).json({ error: 'Mídia não encontrada' });
  }

  const conversation = findMediaConversation(filename);
  if (!conversation) return res.status(404).json({ error: 'Mídia não encontrada' });
  if (!canAccessConversation(req.user, conversation)) {
    return res.status(403).json({ error: 'Sem permissão para acessar essa mídia' });
  }

  const mediaMime = normalizeMime(conversation.media_mimetype);
  if (/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(mediaMime)) {
    res.type(mediaMime);
  }
  res.setHeader('Content-Disposition', `inline; filename="${safeHeaderFilename(filename)}"`);
  // `private` ainda permite cache compartilhado entre logins no mesmo perfil.
  // Mídia autenticada nunca deve sobreviver a uma troca de conta/tenant.
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.sendFile(path.join(MEDIA_ROOT, filename), err => {
    if (!err) return;
    if (res.headersSent) return next(err);
    if (err.statusCode === 404 || err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Mídia não encontrada' });
    }
    return next(err);
  });
});

app.get('/support-media/:filename', authMiddleware(['admin']), (req, res, next) => {
  const filename = path.basename(String(req.params.filename || ''));
  if (!filename || filename !== req.params.filename) {
    return res.status(400).json({ error: 'Arquivo inválido' });
  }
  const message = getSupportMediaMessage(master, `/support-media/${filename}`);
  if (!message) return res.status(404).json({ error: 'Anexo de suporte não encontrado' });
  if (!isTenantMediaFilename(filename, message.owner_tenant_id)) {
    return res.status(404).json({ error: 'Anexo de suporte não encontrado' });
  }
  if (!req.user.super_admin && Number(req.user.tenant_id) !== Number(message.owner_tenant_id)) {
    return res.status(403).json({ error: 'Sem permissão para acessar esse anexo' });
  }
  const mediaMime = normalizeMime(message.media_mimetype);
  if (/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(mediaMime)) {
    res.type(mediaMime);
  }
  res.setHeader('Content-Disposition', `inline; filename="${safeHeaderFilename(filename)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.sendFile(path.join(MEDIA_ROOT, filename), err => {
    if (!err) return;
    if (res.headersSent) return next(err);
    if (err.statusCode === 404 || err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Anexo de suporte não encontrado' });
    }
    return next(err);
  });
});

// ============ AUTH ============

// Bloqueia o login se a assinatura do tenant não estiver em dia
// (trial vencido, pagamento falhou ou assinatura cancelada).
function checkBillingBlock(tenantId) {
  const { getTenant, getEffectiveBillingStatus } = require('./tenantManager');
  const tenant = getTenant(tenantId);
  const status = getEffectiveBillingStatus(tenant);
  if (status === 'active' || status === 'trialing') return null;
  return {
    error: tenant.billing_block_reason === 'plan_capacity'
      ? 'O plano foi reduzido e há usuários ativos acima do limite. Desative o excedente para reativar a conta.'
      : 'Assinatura inativa. Regularize o pagamento para continuar.',
    billing_status: status,
    billing_block_reason: tenant.billing_block_reason || null
  };
}

function hasInFlightAdminPasswordReset(tenantId, adminId) {
  return isPasswordResetInFlight({ masterDb: master, tenantId, adminId });
}

function isTenantOperational(tenantId) {
  try {
    const { getTenant, getEffectiveBillingStatus } = require('./tenantManager');
    const tenant = getTenant(tenantId);
    const status = getEffectiveBillingStatus(tenant);
    return Boolean(tenant && tenant.status === 'active' && ['active', 'trialing'].includes(status));
  } catch {
    return false;
  }
}

const billingPausedTenantRuntimes = new Set();

function pauseTenantRuntimeForBilling(tenantId) {
  const normalizedTenantId = Number(tenantId);
  if (billingPausedTenantRuntimes.has(normalizedTenantId)) return;
  disconnectTenantSockets(tenantId);
  clearTenantRuntimeState(tenantId);
  billingPausedTenantRuntimes.add(normalizedTenantId);
  if (waManagerReady) {
    waManager.destroySession(tenantId)
      .catch(err => logger.warn({ err, tenantId }, 'Falha ao pausar WhatsApp de tenant bloqueado'));
  }
}

function resumeTenantRuntimeAfterBilling(tenantId, { force = false } = {}) {
  const normalizedTenantId = Number(tenantId);
  if (!force && !billingPausedTenantRuntimes.has(normalizedTenantId)) return;
  if (!waManagerReady) {
    billingPausedTenantRuntimes.add(normalizedTenantId);
    return;
  }
  billingPausedTenantRuntimes.delete(normalizedTenantId);
  const currentClient = waManager.getReadyClient(normalizedTenantId);
  if (currentClient) {
    maybeScheduleTenantAutoImport(normalizedTenantId);
    return;
  }
  waManager.hasRestorableSession(normalizedTenantId)
    .then(restorable => (restorable ? startTenantWaSession(normalizedTenantId) : null))
    .then(client => {
      if (client) maybeScheduleTenantAutoImport(normalizedTenantId);
    })
    .catch(err => {
      billingPausedTenantRuntimes.add(normalizedTenantId);
      logger.warn({ err, tenantId: normalizedTenantId }, 'Falha ao restaurar WhatsApp após regularização');
    });
}

function sweepBlockedTenantSockets() {
  try {
    const { listTenants } = require('./tenantManager');
    for (const tenant of listTenants()) {
      if (!isTenantOperational(tenant.id)) pauseTenantRuntimeForBilling(tenant.id);
      else resumeTenantRuntimeAfterBilling(tenant.id);
    }
  } catch (err) {
    logger.warn({ err }, 'Falha ao revisar sessoes de cobranca');
  }
}

const billingSessionSweepTimer = INTERNAL_EDITION
  ? null
  : setInterval(
    sweepBlockedTenantSockets,
    Number(process.env.BILLING_SESSION_SWEEP_MS || 30000)
  );
billingSessionSweepTimer?.unref?.();
let trialCheckStartTimer = null;
let trialCheckInterval = null;
let provisioningRecoveryStartTimer = null;
let provisioningRecoveryInterval = null;
let provisioningRecoveryRunning = false;

app.post('/api/login', (req, res) => {
  const username = normalizeDirectoryUsername(req.body?.username);
  const password = req.body?.password;
  if (!username || typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 72) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }

  // 1) Super admin (dono da plataforma) — banco padrão, sem tenant.
  const superAdmin = db.defaultDb.prepare('SELECT * FROM admins WHERE username = ? COLLATE NOCASE AND super_admin = 1').get(username);
  if (superAdmin && bcrypt.compareSync(password, superAdmin.password)) {
    // 2FA do super admin é ligado pela PRESENÇA do segredo no ambiente.
    // Decisão do dono da plataforma (15/jul/2026): sem SUPERADMIN_TOTP_SECRET,
    // o login exige apenas e-mail e senha — inclusive em produção. Para
    // reativar: definir o segredo no .env e recriar o container.
    const totpRequired = Boolean(process.env.SUPERADMIN_TOTP_SECRET);
    let totpValid = !totpRequired;
    if (totpRequired) {
      try {
        totpValid = verifyTotp(req.body?.totp_code, process.env.SUPERADMIN_TOTP_SECRET);
      } catch (error) {
        logger.error({ err: error }, 'Configuracao TOTP do superadmin invalida');
        totpValid = false;
      }
    }
    if (!totpValid) {
      auditSecurityEvent(req, 'login_failed_mfa', {
        username,
        role: 'admin',
        tenantId: null,
        super_admin: true
      });
      // Deliberadamente idêntico às demais falhas: a resposta nunca revela se
      // a senha estava correta (ver multiTenant.integration.test.js). O
      // operador diagnostica pelo audit_log (action = login_failed_mfa).
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }
    db.defaultDb.prepare('UPDATE admins SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(superAdmin.id);
    issueAuthenticatedSession(req, res, {
      id: superAdmin.id,
      username: superAdmin.username,
      name: superAdmin.name || superAdmin.username,
      role: 'admin',
      tenant_id: null,
      super_admin: true,
      token_version: superAdmin.token_version || 0
    });
    auditSecurityEvent(req, 'login_success', { username, role: 'admin', tenantId: null, super_admin: true });
    return res.json({ role: 'admin', super_admin: true });
  }

  // 2) Admin ou vendedor de algum tenant — descoberto pelo diretório global.
  const entry = findDirectoryUser(username);
  if (entry) {
    let tenantDb;
    try {
      const tenant = require('./tenantManager').getTenant(entry.tenant_id);
      if (!tenant || tenant.status !== 'active') {
        auditSecurityEvent(req, 'login_failed', { username });
        return res.status(401).json({ error: 'Usuário ou senha inválidos' });
      }
      tenantDb = getTenantDb(entry.tenant_id);
    } catch (error) {
      logger.warn({ err: error, tenantId: entry.tenant_id }, 'Entrada obsoleta no diretório de usuários');
      auditSecurityEvent(req, 'login_failed', { username });
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }

    if (entry.role === 'admin') {
      const admin = tenantDb.prepare('SELECT * FROM admins WHERE username = ? COLLATE NOCASE').get(username);
      if (admin && hasInFlightAdminPasswordReset(entry.tenant_id, admin.id)) {
        auditSecurityEvent(req, 'login_blocked_password_reset_in_progress', {
          username,
          tenantId: entry.tenant_id
        });
        return res.status(401).json({ error: 'Usuário ou senha inválidos' });
      }
      if (admin && bcrypt.compareSync(password, admin.password)) {
        const blocked = checkBillingBlock(entry.tenant_id);
        tenantDb.prepare('UPDATE admins SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(admin.id);
        issueAuthenticatedSession(req, res, {
          id: admin.id,
          username: admin.username,
          name: admin.name || admin.username,
          role: 'admin',
          tenant_id: entry.tenant_id,
          super_admin: false,
          token_version: admin.token_version || 0
        });
        auditSecurityEvent(req, 'login_success', { username, role: 'admin', tenantId: entry.tenant_id });
        return res.json({
          role: 'admin',
          super_admin: false,
          billing_required: Boolean(blocked),
          billing_status: blocked?.billing_status || null
        });
      }
    } else if (entry.role === 'vendor') {
      const vendor = tenantDb.prepare(`
        SELECT v.*, s.name AS sector_name
        FROM vendors v
        JOIN sectors s ON s.id = v.sector_id AND s.active = 1
        WHERE v.username = ? COLLATE NOCASE AND v.active = 1
      `).get(username);
      if (vendor && bcrypt.compareSync(password, vendor.password)) {
        const blocked = checkBillingBlock(entry.tenant_id);
        if (blocked) return res.status(402).json(blocked);
        tenantDb.prepare('UPDATE vendors SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(vendor.id);
        issueAuthenticatedSession(req, res, {
          id: vendor.id,
          role: 'vendor',
          tenant_id: entry.tenant_id,
          super_admin: false,
          name: vendor.name,
          username: vendor.username,
          sector_id: vendor.sector_id || null,
          sector_name: vendor.sector_name || null,
          token_version: vendor.token_version || 0
        });
        auditSecurityEvent(req, 'login_success', { username, role: 'vendor', tenantId: entry.tenant_id });
        return res.json({ role: 'vendor', name: vendor.name, sector_id: vendor.sector_id || null, sector_name: vendor.sector_name || null });
      }
    }
  }

  auditSecurityEvent(req, 'login_failed', { username });
  res.status(401).json({ error: 'Usuário ou senha inválidos' });
});

app.get('/api/me', authMiddleware(), (req, res) => {
  res.json(req.user);
});

app.post('/api/logout', authMiddleware(), (req, res) => {
  auditSecurityEvent(req, 'logout');
  incrementTokenVersion(req.user);
  disconnectUserSockets(req.user);
  res.clearCookie('auth_token', { path: '/', sameSite: 'lax', secure: isSecureCookie(req) });
  res.clearCookie('csrf_token', { path: '/', sameSite: 'strict', secure: isSecureCookie(req) });
  res.setHeader('Clear-Site-Data', '"cache"');
  res.json({ success: true });
});

// ============ SUPORTE CLIENTE <-> SUPER ADMIN ============

function requireTenantMember(req, res) {
  if (!['admin', 'vendor'].includes(req.user?.role) || req.user?.super_admin || !req.user?.tenant_id) {
    res.status(403).json({ error: 'Apenas usuários autenticados da empresa' });
    return false;
  }
  return true;
}

function requirePlatformSuperAdmin(req, res) {
  if (!req.user?.super_admin) {
    res.status(403).json({ error: 'Apenas super admin' });
    return false;
  }
  return true;
}

function requireTenantAdmin(req, res) {
  if (req.user?.role !== 'admin'
      || req.user?.super_admin
      || !req.user?.tenant_id
      || Number(req.tenant?.id) !== Number(req.user.tenant_id)) {
    res.status(403).json({ error: 'Apenas administradores da propria empresa' });
    return false;
  }
  return true;
}

async function saveSupportAttachment(tenantId, payload) {
  const media = payload?.media;
  if (!media) return null;
  if (!media.mimetype || !media.data) {
    const error = new Error('Anexo de suporte inválido');
    error.statusCode = 400;
    throw error;
  }
  const encoded = String(media.data || '').replace(/^data:[^;]+;base64,/, '');
  if (Buffer.byteLength(encoded, 'base64') > 10 * 1024 * 1024) {
    const error = new Error('O anexo de suporte excede 10 MB');
    error.statusCode = 400;
    throw error;
  }
  try {
    return await saveMessageMedia({
      messageId: `support-${crypto.randomUUID()}`,
      namespace: tenantId,
      media: { ...media, data: encoded },
      messageType: media.messageType || '',
      mediaRoot: MEDIA_ROOT,
      publicBasePath: '/support-media'
    });
  } catch (err) {
    if (/^(Tipo|Extensao|Assinatura|Anexo)|bloqueado por antivirus/i.test(String(err.message || ''))) {
      err.statusCode = 400;
    }
    throw err;
  }
}

async function removeSupportAttachment(media, tenantId) {
  if (!media?.media_url || !String(media.media_url).startsWith('/support-media/')) return;
  const filename = path.basename(String(media.media_url));
  if (!filename || !isTenantMediaFilename(filename, tenantId)) return;
  try {
    await fsPromises.rm(path.join(MEDIA_ROOT, filename), { force: true });
  } catch (err) {
    logger.warn({ err, filename }, 'Falha ao limpar anexo de suporte orfao');
  }
}

function emitSupportMessage(message) {
  const event = {
    threadId: Number(message.thread_id),
    tenantId: Number(message.tenant_id),
    messageId: Number(message.id),
    senderType: message.sender_type,
    createdAt: message.created_at
  };
  io.to(supportTenantRoom(message.tenant_id)).emit('support:new', event);
  io.to('super-admins').emit('support:new', event);
}

function getSupportMessagePage(threadId, beforeId = null) {
  const pageSize = 200;
  const rows = listSupportMessages(master, threadId, {
    limit: pageSize + 1,
    beforeId: beforeId == null || beforeId === '' ? null : parsePositiveInt(beforeId, 'cursor')
  });
  const hasMore = rows.length > pageSize;
  const messages = hasMore ? rows.slice(1) : rows;
  return {
    messages,
    has_more: hasMore,
    next_before_id: hasMore && messages.length ? Number(messages[0].id) : null
  };
}

app.get('/api/support/thread', tenantAuthMiddleware(['admin']), (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  const thread = getOrCreateSupportThread(master, req.user.tenant_id);
  res.json({ thread, ...getSupportMessagePage(thread.id, req.query.before_id) });
});

app.post('/api/support/messages', tenantAuthMiddleware(['admin']), async (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  let media = null;
  try {
    media = await saveSupportAttachment(req.user.tenant_id, req.body);
    const message = addSupportMessage({
      master,
      tenantId: req.user.tenant_id,
      senderType: 'tenant',
      senderId: req.user.id,
      content: req.body.content,
      media
    });
    emitSupportMessage(message);
    res.status(201).json(message);
  } catch (err) {
    await removeSupportAttachment(media, req.user.tenant_id);
    if (err.statusCode && (err.statusCode < 500 || err.statusCode === 507)) {
      return res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    logger.error({ err, tenantId: req.user.tenant_id }, 'Erro interno ao enviar mensagem de suporte');
    return res.status(500).json({ error: 'Não foi possível enviar a mensagem' });
  }
});

app.patch('/api/support/thread/read', tenantAuthMiddleware(['admin']), (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  const thread = getOrCreateSupportThread(master, req.user.tenant_id);
  res.json(markSupportThreadRead(master, { threadId: thread.id, readerType: 'tenant' }));
});

app.get('/api/support/threads', authMiddleware(['admin']), (req, res) => {
  if (!requirePlatformSuperAdmin(req, res)) return;
  res.json(listSupportThreads(master));
});

app.get('/api/support/threads/:id/messages', authMiddleware(['admin']), (req, res) => {
  if (!requirePlatformSuperAdmin(req, res)) return;
  const thread = getSupportThread(master, parsePositiveInt(req.params.id, 'conversa de suporte'));
  if (!thread) return res.status(404).json({ error: 'Conversa de suporte não encontrada' });
  res.json({ thread, ...getSupportMessagePage(thread.id, req.query.before_id) });
});

app.post('/api/support/threads/:id/messages', authMiddleware(['admin']), async (req, res) => {
  if (!requirePlatformSuperAdmin(req, res)) return;
  const thread = getSupportThread(master, parsePositiveInt(req.params.id, 'conversa de suporte'));
  if (!thread) return res.status(404).json({ error: 'Conversa de suporte não encontrada' });
  let media = null;
  try {
    media = await saveSupportAttachment(thread.tenant_id, req.body);
    const message = addSupportMessage({
      master,
      tenantId: thread.tenant_id,
      senderType: 'super_admin',
      senderId: req.user.id,
      content: req.body.content,
      media
    });
    emitSupportMessage(message);
    res.status(201).json(message);
  } catch (err) {
    await removeSupportAttachment(media, thread.tenant_id);
    if (err.statusCode && (err.statusCode < 500 || err.statusCode === 507)) {
      return res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    logger.error({ err, tenantId: thread.tenant_id }, 'Erro interno ao responder suporte');
    return res.status(500).json({ error: 'Não foi possível enviar a resposta' });
  }
});

app.patch('/api/support/threads/:id/read', authMiddleware(['admin']), (req, res) => {
  if (!requirePlatformSuperAdmin(req, res)) return;
  const thread = getSupportThread(master, parsePositiveInt(req.params.id, 'conversa de suporte'));
  if (!thread) return res.status(404).json({ error: 'Conversa de suporte não encontrada' });
  res.json(markSupportThreadRead(master, { threadId: thread.id, readerType: 'super_admin' }));
});

// ============ SUPER ADMIN: TENANT MANAGEMENT ============

app.get('/api/tenants', authMiddleware(['admin']), (req, res) => {
  if (!req.user.super_admin) return res.status(403).json({ error: 'Apenas super admin' });
  try {
    const { listTenants, getEffectiveBillingStatus, getTenantUserLimit } = require('./tenantManager');
    const Database = require('better-sqlite3');
    const page = parsePositiveInt(req.query.page || 1, 'pagina');
    const requestedPageSize = parsePositiveInt(req.query.page_size || 25, 'tamanho da pagina');
    const pageSize = Math.min(requestedPageSize, 50);
    const query = String(req.query.q || '').trim().toLocaleLowerCase('pt-BR');
    if (query.length > 100) return res.status(400).json({ error: 'Busca muito longa' });
    const allTenants = listTenants();
    const tenants = query
      ? allTenants.filter(tenant => [tenant.name, tenant.slug, tenant.subdomain]
        .some(value => String(value || '').toLocaleLowerCase('pt-BR').includes(query)))
      : allTenants;
    const offset = (page - 1) * pageSize;
    const pageTenants = tenants.slice(offset, offset + pageSize);
    const enriched = pageTenants.map(t => {
      const dbPath = path.join(DATA_ROOT, `data_${t.id}.db`);
      const exists = require('fs').existsSync(dbPath);
      let vendorCount = null;
      let conversationCount = null;
      let dbHealthy = false;
      let dbHealth = exists ? 'unavailable' : 'missing';
      if (exists) {
        let tenantDb = null;
        try {
          // O painel nao deve abrir/cachear todos os bancos nem rodar quick_check
          // sincronamente em cada refresh. Integridade completa pertence ao job
          // de auditoria; aqui usamos uma conexao read-only curta e paginada.
          tenantDb = new Database(dbPath, { readonly: true, fileMustExist: true });
          tenantDb.pragma('query_only = ON');
          tenantDb.pragma('busy_timeout = 250');
          vendorCount = tenantDb.prepare('SELECT COUNT(*) AS c FROM vendors WHERE active = 1').get().c;
          conversationCount = tenantDb.prepare('SELECT COUNT(*) AS c FROM conversations').get().c;
          dbHealthy = true;
          dbHealth = 'ok';
        } catch (error) {
          logger.error({ err: error, tenantId: t.id, dbPath }, 'Banco do tenant indisponivel no painel superadmin');
          dbHealth = 'unavailable';
        } finally {
          try { tenantDb?.close(); } catch {}
        }
      }
      return {
        ...t,
        db_exists: exists,
        db_healthy: dbHealthy,
        db_health: dbHealth,
        billing_status: getEffectiveBillingStatus(t),
        vendor_count: vendorCount,
        user_count: vendorCount,
        user_limit: getTenantUserLimit(t),
        conversation_count: conversationCount
      };
    });
    const billingCounts = allTenants.reduce((counts, tenant) => {
      const status = getEffectiveBillingStatus(tenant);
      counts[status] = Number(counts[status] || 0) + 1;
      return counts;
    }, {});
    res.json({
      items: enriched,
      pagination: {
        page,
        page_size: pageSize,
        total: tenants.length,
        total_pages: Math.max(1, Math.ceil(tenants.length / pageSize)),
        has_previous: page > 1,
        has_next: offset + enriched.length < tenants.length
      },
      summary: {
        total: allTenants.length,
        operational: allTenants.filter(tenant => tenant.status === 'active').length,
        active: Number(billingCounts.active || 0),
        trialing: Number(billingCounts.trialing || 0),
        suspended: Number(billingCounts.suspended || 0),
        checkout_pending: Number(billingCounts.checkout_pending || 0)
      },
      tenant_directory: allTenants.map(tenant => ({ id: tenant.id, name: tenant.name }))
    });
  } catch (err) {
    logger.error({ err }, 'Erro ao listar tenants');
    sendInternalError(res);
  }
});

app.post('/api/tenants', authMiddleware(['admin']), async (req, res) => {
  if (!req.user.super_admin) return res.status(403).json({ error: 'Apenas super admin' });
  let createdTenant = null;
  let compensationEligible = false;
  try {
    const {
      createTenant,
      setBillingFields,
      activateTenant,
      registerDirectoryUser,
      findDirectoryUser: findDirUser,
      logAudit
    } = require('./tenantManager');
    const companyName = String(req.body.companyName || '').trim();
    const adminEmail = normalizeDirectoryUsername(req.body.adminEmail);
    const adminPassword = String(req.body.adminPassword || '');
    const plan = req.body.plan;
    if (!companyName || !adminEmail || !adminPassword) {
      return res.status(400).json({ error: 'Preencha empresa, e-mail e senha do admin' });
    }
    if (companyName.length > 160 || adminEmail.length > 254) {
      return res.status(400).json({ error: 'Dados da empresa invalidos' });
    }
    validateBcryptPassword(adminPassword);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) return res.status(400).json({ error: 'E-mail invalido' });
    if (findDirUser(adminEmail) || isPlatformAdminUsername(adminEmail)) {
      return res.status(409).json({ error: 'Este e-mail já está cadastrado' });
    }
    const hasExplicitSlug = typeof req.body.slug === 'string' && req.body.slug.trim();
    const { tenantSlugBase } = require('./tenantManager');
    const slug = hasExplicitSlug ? req.body.slug : tenantSlugBase(companyName);
      const tenant = createTenant({
      name: companyName,
      slug,
      subdomain: hasExplicitSlug ? slug : undefined,
      plan,
      uniqueSlug: !hasExplicitSlug,
      deferActivation: true
    });
    createdTenant = tenant;
    compensationEligible = true;
    const tenantDb = getTenantDb(tenant.id);
    const hash = bcrypt.hashSync(adminPassword, 10);
    tenantDb.prepare('INSERT INTO admins (name, username, password, super_admin) VALUES (?, ?, ?, 0)')
      .run(adminEmail, adminEmail, hash);
    registerDirectoryUser(adminEmail, tenant.id, 'admin');
    if (process.env.NODE_ENV === 'production' && process.env.BILLING_REQUIRED !== 'false') {
      setBillingFields(tenant.id, { billing_status: 'checkout_pending' });
    }
    const activeTenant = activateTenant(tenant.id);
    compensationEligible = false;
    logAudit(req.user.username || 'super_admin', 'tenant_created', tenant.id, { companyName, adminEmail, manual: true });
    res.status(201).json(activeTenant);
  } catch (err) {
    if (createdTenant && compensationEligible) {
      try { await require('./tenantManager').deleteTenant(createdTenant.id); } catch (cleanupError) {
        logger.error({ err: cleanupError, tenantId: createdTenant.id }, 'Falha ao desfazer tenant manual incompleto');
      }
    }
    if (err.message && err.message.includes('já existe')) return res.status(409).json({ error: err.message });
    logger.error({ err }, 'Erro ao criar tenant');
    sendRouteError(res, err);
  }
});

app.put('/api/tenants/:id', authMiddleware(['admin']), (req, res) => {
  if (!req.user.super_admin) return res.status(403).json({ error: 'Apenas super admin' });
  try {
    const { getTenant, normalizePlan, updateTenant, logAudit } = require('./tenantManager');
    const tenantId = parsePositiveInt(req.params.id, 'tenant');
    const { name, slug, plan } = req.body;
    const userLimitOverride = Object.hasOwn(req.body, 'user_limit_override')
      ? req.body.user_limit_override
      : undefined;
    const current = getTenant(tenantId);
    if (!current) return res.status(404).json({ error: 'Tenant nao encontrado' });
    if (plan !== undefined
        && current.stripe_subscription_id
        && normalizePlan(plan) !== normalizePlan(current.plan)) {
      return res.status(409).json({
        error: 'O plano de uma assinatura ativa deve ser alterado pelo fluxo de cobranca da Stripe'
      });
    }
    const tenant = master.transaction(() => {
      const updated = updateTenant(tenantId, {
        name,
        slug,
        subdomain: slug,
        plan,
        runtimeTenantLimit: process.env.NODE_ENV === 'production'
          ? Number(process.env.WA_MAX_CONCURRENT_SESSIONS || 5)
          : null,
        user_limit_override: userLimitOverride
      });
      logAudit(req.user.username || 'super_admin', 'tenant_updated', tenantId, {
        name,
        slug,
        plan,
        user_limit_override: userLimitOverride
      });
      return updated;
    }).immediate();
    res.json(tenant);
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.delete('/api/tenants/:id', authMiddleware(['admin']), async (req, res) => {
  if (!req.user.super_admin) return res.status(403).json({ error: 'Apenas super admin' });
  try {
    const { deleteTenant, getTenant, logAudit } = require('./tenantManager');
    const tenantId = parsePositiveInt(req.params.id, 'tenant');
    const tenant = getTenant(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant nao encontrado' });
    if (tenant.slug === 'default') {
      return res.status(409).json({ error: 'O tenant operacional padrao nao pode ser excluido' });
    }
    disconnectTenantSockets(tenantId, { includeRestricted: true });
    clearTenantRuntimeState(tenantId);
    const deletion = await deleteTenant(tenantId, {
      beforeDelete: async () => {
        // Preserve credentials until the durable deletion commits. If Stripe
        // cleanup fails and storage is restored, the tenant can reconnect
        // without scanning a new QR code.
        if (waManagerReady) await waManager.destroySession(tenantId);
        // Ainda não bloqueia permanentemente as filas: Stripe pode falhar
        // depois da quarentena e o armazenamento será restaurado.
        clearTenantRuntimeState(tenantId);
      },
      afterQuarantine: async current => {
        await require('./billing').deleteTenantBilling(current);
      }
    });
    // Só depois do DELETE durável o ID deixa de poder reaparecer. Nesse ponto
    // callbacks atrasados também ficam impedidos de recriar partições de fila.
    clearTenantRuntimeState(tenantId, { final: true });
    try {
      logAudit(req.user.username || 'super_admin', 'tenant_deleted', tenantId, {
        cleanupPending: !deletion.cleanup.processed
      });
    } catch (auditError) {
      logger.error({ err: auditError, tenantId }, 'Tenant excluido, mas a auditoria duravel falhou');
    }
    if (!deletion.cleanup.processed) {
      logger.error({ tenantId, failures: deletion.cleanup.failures }, 'Limpeza fisica do tenant ficou pendente para retentativa');
    }
    res.status(deletion.cleanup.processed ? 200 : 202).json({
      success: true,
      cleanup_pending: !deletion.cleanup.processed,
      media_files_removed: deletion.cleanup.processed ? deletion.cleanup.mediaFiles : 0
    });
  } catch (err) {
    if (err.deletionPending) {
      const tenantId = parsePositiveInt(req.params.id, 'tenant');
      clearTenantRuntimeState(tenantId, { final: true });
      logger.error(
        { err, tenantId, deletionId: err.deletionId },
        'Exclusao entrou em fase irreversivel e sera concluida automaticamente'
      );
      return res.status(202).json({
        success: true,
        deletion_pending: true,
        cleanup_pending: true
      });
    }
    try {
      const tenantId = parsePositiveInt(req.params.id, 'tenant');
      const tenant = require('./tenantManager').getTenant(tenantId);
      if (tenant && isTenantOperational(tenantId) && waManagerReady) {
        startTenantWaSession(tenantId)
          .then(() => maybeScheduleTenantAutoImport(tenantId))
          .catch(restartError => logger.error({ err: restartError, tenantId }, 'Falha ao restaurar sessão após exclusão abortada'));
      }
    } catch {}
    logger.error({ err }, 'Erro ao excluir tenant');
    sendRouteError(res, err);
  }
});

app.post('/api/tenants/:id/status', authMiddleware(['admin']), (req, res) => {
  if (!req.user.super_admin) return res.status(403).json({ error: 'Apenas super admin' });
  try {
    const { getTenant, updateTenant, logAudit } = require('./tenantManager');
    const tenantId = parsePositiveInt(req.params.id, 'tenant');
    const status = String(req.body.status || '').trim().toLowerCase();
    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: 'Status da conta invalido' });
    }
    const current = getTenant(tenantId);
    if (!current) return res.status(404).json({ error: 'Tenant nao encontrado' });
    if (current.status === 'provisioning') {
      return res.status(409).json({ error: 'Tenant ainda esta em provisionamento' });
    }
    if (current.slug === 'default' && status === 'suspended') {
      return res.status(409).json({ error: 'O tenant operacional padrao nao pode ser suspenso' });
    }
    const result = master.transaction(() => {
      const lockedCurrent = getTenant(tenantId);
      if (!lockedCurrent) {
        const error = new Error('Tenant nao encontrado');
        error.statusCode = 404;
        throw error;
      }
      let revoked = null;
      // Revoga antes da transição, ainda sob a ordem global master -> tenant.
      // Inclusive ao reativar: nenhum JWT emitido antes da suspensão pode
      // voltar a funcionar quando a conta fica operacional novamente.
      if (lockedCurrent.status !== status) revoked = revokeAllTenantSessions(tenantId);
      const updated = updateTenant(tenantId, { status });
      logAudit(req.user.username || 'super_admin', `tenant_${status}`, tenantId, {
        previousStatus: lockedCurrent.status
      });
      if (revoked) {
        logAudit(req.user.username || 'super_admin', 'tenant_sessions_revoked', tenantId, {
          ...revoked,
          transition: `${lockedCurrent.status}->${status}`
        });
      }
      return { tenant: updated, changed: lockedCurrent.status !== status };
    }).immediate();
    const tenant = result.tenant;
    if (status === 'suspended') {
      pauseTenantRuntimeForBilling(tenantId);
      disconnectTenantSockets(tenantId, { includeRestricted: true });
    } else if (isTenantOperational(tenantId)) {
      if (result.changed) disconnectTenantSockets(tenantId, { includeRestricted: true });
      resumeTenantRuntimeAfterBilling(tenantId, { force: true });
    } else pauseTenantRuntimeForBilling(tenantId);
    res.json(tenant);
  } catch (err) {
    logger.error({ err }, 'Erro ao atualizar status operacional do tenant');
    sendRouteError(res, err);
  }
});

app.post('/api/tenants/:id/billing-status', authMiddleware(['admin']), async (req, res) => {
  if (!req.user.super_admin) return res.status(403).json({ error: 'Apenas super admin' });
  try {
    const { getTenant, setBillingFields, updateTenant, logAudit } = require('./tenantManager');
    const tenantId = parsePositiveInt(req.params.id, 'tenant');
    const status = String(req.body.billing_status || '');
    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: 'Status inválido' });
    }
    let fields = { billing_status: status };
    if (status === 'active') {
      const verified = await require('./billing').verifyTenantSubscriptionAccess(getTenant(tenantId));
      updateTenant(tenantId, { plan: verified.plan });
      fields = {
        billing_status: verified.status,
        billing_block_reason: null,
        stripe_customer_id: verified.customerId,
        stripe_subscription_id: verified.subscriptionId,
        stripe_price_id: verified.priceId,
        ...(verified.trialEndsAt ? { trial_ends_at: verified.trialEndsAt } : {})
      };
    }
    const tenant = setBillingFields(tenantId, fields);
    if (isTenantOperational(tenantId)) resumeTenantRuntimeAfterBilling(tenantId, { force: true });
    else pauseTenantRuntimeForBilling(tenantId);
    logAudit('super_admin', `billing_${tenant.billing_status}`, tenantId, { manual: true, requestedStatus: status });
    res.json(tenant);
  } catch (err) {
    logger.error({ err }, 'Erro ao atualizar status de cobrança');
    sendRouteError(res, err);
  }
});

app.post('/api/tenants/:id/comp', authMiddleware(['admin']), (req, res) => {
  if (!req.user.super_admin) return res.status(403).json({ error: 'Apenas super admin' });
  try {
    const { setComp, getEffectiveBillingStatus, logAudit } = require('./tenantManager');
    const tenantId = parsePositiveInt(req.params.id, 'tenant');
    const tenant = setComp(tenantId, Boolean(req.body.comp));
    if (tenant.comp || ['active', 'trialing'].includes(getEffectiveBillingStatus(tenant))) {
      resumeTenantRuntimeAfterBilling(tenantId, { force: true });
    } else pauseTenantRuntimeForBilling(tenantId);
    logAudit('super_admin', req.body.comp ? 'comp_enabled' : 'comp_disabled', tenantId, {});
    res.json(tenant);
  } catch (err) {
    logger.error({ err }, 'Erro ao atualizar cortesia do tenant');
    sendRouteError(res, err);
  }
});

app.get('/api/audit-log', authMiddleware(['admin']), (req, res) => {
  if (!req.user.super_admin) return res.status(403).json({ error: 'Apenas super admin' });
  try {
    const { listAuditLog } = require('./tenantManager');
    res.json(listAuditLog(200));
  } catch (err) {
    logger.error({ err }, 'Erro ao listar auditoria');
    sendInternalError(res);
  }
});

app.get('/api/billing/overview', authMiddleware(['admin']), async (req, res) => {
  if (!req.user.super_admin) return res.status(403).json({ error: 'Apenas super admin' });
  try {
    const { getBillingOverview } = require('./billing');
    res.json(await getBillingOverview());
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar overview do Stripe');
    sendInternalError(res);
  }
});

// ============ CONFIGURAÇÃO DA PLATAFORMA (Stripe / Turnstile) ============
// O super admin preenche as chaves em runtime. Segredos são gravados
// criptografados no master.db e nunca voltam crus: o GET devolve só uma máscara.
const PLATFORM_CONFIG_RULES = {
  STRIPE_SECRET_KEY: { re: /^sk_(live|test)_[A-Za-z0-9]+$/, msg: 'Chave secreta deve começar com sk_live_ ou sk_test_' },
  STRIPE_WEBHOOK_SECRET: { re: /^whsec_[A-Za-z0-9]+$/, msg: 'Webhook secret deve começar com whsec_' },
  STRIPE_PRICE_ID: { re: /^price_[A-Za-z0-9]+$/, msg: 'Price ID deve começar com price_' },
  STRIPE_PRICE_ID_BASIC: { re: /^price_[A-Za-z0-9]+$/, msg: 'Price ID (básico) deve começar com price_' },
  STRIPE_PRICE_ID_PRO: { re: /^price_[A-Za-z0-9]+$/, msg: 'Price ID (pro) deve começar com price_' },
  TURNSTILE_SITE_KEY: { re: /^[A-Za-z0-9_-]{20,100}$/, msg: 'Site key do Turnstile inválida' },
  TURNSTILE_SECRET_KEY: { re: /^[A-Za-z0-9_-]{20,100}$/, msg: 'Secret key do Turnstile inválida' }
};

const STRIPE_PLATFORM_KEYS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_ID',
  'STRIPE_PRICE_ID_BASIC',
  'STRIPE_PRICE_ID_PRO'
];
const TURNSTILE_PLATFORM_KEYS = ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'];

function effectivePlatformConfigAfter(updates = {}) {
  const resolved = require('./tenantManager').getResolvedPlatformEnv();
  const effective = { ...process.env, ...resolved };
  for (const key of [...STRIPE_PLATFORM_KEYS, ...TURNSTILE_PLATFORM_KEYS]) {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    // Valor vazio remove a configuração do banco. Se houver fallback no
    // ambiente, ele volta a ser a fonte efetiva depois da remoção.
    effective[key] = updates[key] || process.env[key] || '';
  }
  return effective;
}

function validatePlatformConfigSet(updates) {
  const errors = [];
  const effective = effectivePlatformConfigAfter(updates);
  if (STRIPE_PLATFORM_KEYS.some(key => Object.prototype.hasOwnProperty.call(updates, key))) {
    const hasAnyStripeValue = STRIPE_PLATFORM_KEYS.some(key => Boolean(effective[key]));
    if (hasAnyStripeValue) {
      const status = require('./billing').getBillingConfigurationStatus(effective);
      const messages = {
        missing_secret_key: 'Informe a chave secreta da Stripe',
        secret_key_not_live: 'Em produção, a chave Stripe deve começar com sk_live_',
        invalid_secret_key: 'Chave secreta Stripe inválida',
        missing_or_invalid_webhook_secret: 'Informe um webhook secret válido iniciado por whsec_',
        invalid_fallback_price: 'Price ID único inválido',
        mixed_price_strategies: 'Use um Price ID único ou os dois preços por plano, nunca os dois formatos juntos',
        missing_or_invalid_plan_prices: 'Informe Price IDs válidos para os planos Básico e Profissional',
        duplicate_plan_prices: 'Os planos Básico e Profissional precisam usar Price IDs diferentes'
      };
      if (!status.configured) errors.push(messages[status.reason] || 'Configuração Stripe inválida');
    }
  }

  if (TURNSTILE_PLATFORM_KEYS.some(key => Object.prototype.hasOwnProperty.call(updates, key))) {
    const status = getTurnstileConfigurationStatus(effective);
    const messages = {
      partial_configuration: 'Informe juntas a Site Key e a Secret Key do Turnstile, ou deixe ambas vazias',
      invalid_key: 'As chaves do Turnstile são inválidas',
      test_key_in_production: 'Chaves de teste do Turnstile não são permitidas em produção'
    };
    if (!status.configured && status.reason !== 'disabled') {
      errors.push(messages[status.reason] || 'Configuração Turnstile inválida');
    }
  }
  return errors;
}

function effectivePlatformConfigChanged(updates, effective, keys) {
  const current = effectivePlatformConfigAfter();
  return keys.some(key => Object.prototype.hasOwnProperty.call(updates, key)
    && String(effective[key] || '') !== String(current[key] || ''));
}

function validateStripeSecretRotation(updates, effective) {
  if (!Object.prototype.hasOwnProperty.call(updates, 'STRIPE_SECRET_KEY')) return [];
  const current = effectivePlatformConfigAfter();
  if (String(current.STRIPE_SECRET_KEY || '') === String(effective.STRIPE_SECRET_KEY || '')) return [];
  const hasExternalBindings = require('./tenantManager').listTenants().some(tenant => (
    tenant.stripe_customer_id
      || tenant.stripe_subscription_id
      || tenant.stripe_checkout_session_id
  ));
  return hasExternalBindings
    ? ['A chave secreta Stripe não pode ser trocada enquanto existirem clientes vinculados; faça uma migração de conta assistida']
    : [];
}

app.get('/api/admin/platform-config', authMiddleware(['admin']), (req, res) => {
  if (!req.user.super_admin) return res.status(403).json({ error: 'Apenas super admin' });
  try {
    res.json({ config: getPlatformConfigStatus(), billingConfigured: isBillingConfigured() });
  } catch (err) {
    logger.error({ err }, 'Erro ao ler configuração da plataforma');
    sendInternalError(res);
  }
});

app.put('/api/admin/platform-config', authMiddleware(['admin']), async (req, res) => {
  if (!req.user.super_admin) return res.status(403).json({ error: 'Apenas super admin' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const updates = {};
  const errors = [];
  for (const key of Object.keys(PLATFORM_CONFIG_RULES)) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const value = body[key] === null || body[key] === undefined ? '' : String(body[key]).trim();
    updates[key] = value; // string vazia limpa a chave
    if (value && !PLATFORM_CONFIG_RULES[key].re.test(value)) errors.push(PLATFORM_CONFIG_RULES[key].msg);
  }
  errors.push(...validatePlatformConfigSet(updates));
  const effective = effectivePlatformConfigAfter(updates);
  errors.push(...validateStripeSecretRotation(updates, effective));
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nada para atualizar' });
  try {
    const stripeChanged = effectivePlatformConfigChanged(updates, effective, STRIPE_PLATFORM_KEYS);
    const stripeStatus = require('./billing').getBillingConfigurationStatus(effective);
    if (stripeChanged && stripeStatus.configured) {
      await require('./billing').validateStripeConfigurationConnectivity(effective);
    }
    const applied = setPlatformConfig(updates);
    // A troca de chave precisa valer imediatamente, sem reiniciar o processo.
    require('./billing').resetStripeClient();
    try {
      require('./tenantManager').logAudit(req.user.username || 'super_admin', 'platform_config_updated', null, {
        keys: applied
      });
    } catch (auditErr) {
      logger.warn({ err: auditErr }, 'Falha ao auditar mudança de configuração da plataforma');
    }
    res.json({ ok: true, applied, config: getPlatformConfigStatus(), billingConfigured: isBillingConfigured() });
  } catch (err) {
    if (err.code === 'STRIPE_CONFIGURATION_INVALID') {
      logger.warn({ reason: err.reason }, 'Configuração Stripe rejeitada antes de persistir');
      return res.status(400).json({ error: err.message, code: err.code });
    }
    if (err.code === 'STRIPE_CONFIGURATION_UNAVAILABLE') {
      logger.warn({ reason: err.reason }, 'Stripe indisponível durante validação de configuração');
      return res.status(503).json({
        error: 'Não foi possível validar a configuração diretamente na Stripe. Tente novamente.',
        code: err.code
      });
    }
    logger.error({ err }, 'Erro ao salvar configuração da plataforma');
    sendInternalError(res);
  }
});

app.post('/api/tenants/:id/reset-db', authMiddleware(['admin']), (_req, res) => {
  res.status(409).json({
    error: 'Reset destrutivo desativado em produção. Exporte ou exclua a empresa pelo fluxo auditado.'
  });
});

// ============ TENANT SETTINGS ============

app.get('/api/tenant/settings', tenantAuthMiddleware(['admin']), (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId) return res.status(400).json({ error: 'Sem tenant' });
  try {
    const { getTenant } = require('./tenantManager');
    const tenant = getTenant(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant nao encontrado' });
    let settings = {};
    try { settings = JSON.parse(tenant.settings || '{}'); } catch {}
    // Proxy/egress é configuração operacional privilegiada. Nunca devolva o
    // destino ao tenant nem permita que um cliente transforme o Chromium em
    // ponte para a rede privada do container/VPS.
    const publicSettings = { ...settings };
    delete publicSettings.proxy_server;
    res.json({ name: tenant.name, slug: tenant.slug, ...publicSettings });
  } catch (err) {
    logger.error({ err }, 'Erro ao buscar configuracoes do tenant');
    sendInternalError(res);
  }
});

app.put('/api/tenant/settings', tenantAuthMiddleware(['admin']), (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId) return res.status(400).json({ error: 'Sem tenant' });
  try {
    const { name, appName, appCompany } = req.body;
    const { getTenant, updateTenant } = require('./tenantManager');
    const tenant = getTenant(tenantId);
    let currentSettings = {};
    try { currentSettings = JSON.parse(tenant?.settings || '{}'); } catch {}
    const settings = {
      ...currentSettings,
      appName: appName || '',
      appCompany: appCompany || ''
    };
    updateTenant(tenantId, { name, settings });
    auditSecurityEvent(req, 'tenant_settings_updated', { tenantId });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Erro ao salvar configuracoes do tenant');
    sendRouteError(res, err);
  }
});

// ============ COBRANÇA (Stripe) ============

app.get('/api/billing/status', tenantAuthMiddleware(['admin']), (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId) return res.status(400).json({ error: 'Sem tenant' });
  const { getTenant, getEffectiveBillingStatus } = require('./tenantManager');
  const tenant = getTenant(tenantId);
  if (!tenant) return res.status(404).json({ error: 'Tenant nao encontrado' });
  res.json({
    billing_status: getEffectiveBillingStatus(tenant),
    trial_ends_at: tenant.trial_ends_at,
    comp: Boolean(tenant.comp),
    has_stripe_customer: Boolean(tenant.stripe_customer_id),
    has_stripe_subscription: Boolean(tenant.stripe_subscription_id)
  });
});

app.get('/api/billing/invoices', tenantAuthMiddleware(['admin']), async (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId) return res.status(400).json({ error: 'Sem tenant' });
  try {
    const { getTenant } = require('./tenantManager');
    const { listTenantInvoices } = require('./billing');
    const tenant = getTenant(tenantId);
    res.json(await listTenantInvoices(tenant));
  } catch (err) {
    logger.error({ err }, 'Erro ao listar faturas do tenant');
    sendInternalError(res);
  }
});

app.post('/api/billing/checkout', tenantAuthMiddleware(['admin']), async (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId) return res.status(400).json({ error: 'Sem tenant' });
  try {
    const { getTenant } = require('./tenantManager');
    const { createCheckoutSession } = require('./billing');
    const tenant = getTenant(tenantId);
    const admin = db.prepare('SELECT username FROM admins WHERE id = ?').get(req.user.id);
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const session = await createCheckoutSession(tenant, admin?.username, {
      successUrl: `${appUrl}/admin.html?tab=financeiro&billing=success`,
      cancelUrl: `${appUrl}/admin.html?tab=financeiro&billing=cancelled`
    });
    res.json({ url: session.url });
  } catch (err) {
    logger.error({ err }, 'Erro ao criar sessão de checkout');
    sendRouteError(res, err);
  }
});

app.post('/api/billing/portal', tenantAuthMiddleware(['admin']), async (req, res) => {
  const tenantId = req.tenant?.id;
  if (!tenantId) return res.status(400).json({ error: 'Sem tenant' });
  try {
    const { getTenant } = require('./tenantManager');
    const { createPortalSession } = require('./billing');
    const tenant = getTenant(tenantId);
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const session = await createPortalSession(tenant, `${appUrl}/admin.html?tab=financeiro`);
    res.json({ url: session.url });
  } catch (err) {
    logger.error({ err }, 'Erro ao criar sessão do portal de cobrança');
    sendInternalError(res);
  }
});

// ============ PASSWORD RECOVERY ============

app.post('/api/forgot-password', passwordResetLimiter, async (req, res) => {
  const email = normalizeDirectoryUsername(req.body?.email);
  let internalError = null;
  try {
    createPasswordResetRequest({
      email,
      masterDb: master,
      findDirectoryUser,
      getTenantDb,
      onCreated: request => {
        const tenant = require('./tenantManager').getTenant(request.tenantId);
        io.to('super-admins').emit('password-reset:new', { refresh: true });
        require('./notifications').notifyPasswordResetRequested({
          companyName: tenant?.name || `Tenant ${request.tenantId}`,
          email: request.email
        }, logger).catch(() => {});
      }
    });
    auditSecurityEvent(req, 'password_reset_requested', { username: email || 'anonymous' });
  } catch (err) {
    logger.error({ err }, 'Erro ao registrar solicitacao de recuperacao de senha');
    internalError = err;
  }
  // Uniformiza o tempo observavel entre conta inexistente, vendedor e admin.
  await sleep(crypto.randomInt(180, 261));
  if (internalError) return sendInternalError(res);
  return res.json({
    success: true,
    message: 'Se a conta puder ser recuperada, a solicitação foi enviada ao responsável.'
  });
});

app.get('/api/password-reset-requests', authMiddleware(['admin']), (req, res) => {
  if (!req.user.super_admin) return res.status(403).json({ error: 'Apenas super admin' });
  try {
    res.json(listPendingPasswordResetRequests({ masterDb: master, limit: 200 }));
  } catch (err) {
    logger.error({ err }, 'Erro ao listar solicitacoes de recuperacao');
    sendRouteError(res, err);
  }
});

app.post('/api/password-reset-requests/:id/resolve', authMiddleware(['admin']), (req, res) => {
  if (!req.user.super_admin) return res.status(403).json({ error: 'Apenas super admin' });
  try {
    const result = resolvePasswordResetRequest({
      requestId: parsePositiveInt(req.params.id, 'solicitacao'),
      newPassword: req.body?.newPassword,
      resolvedBy: req.user.username || `super-admin:${req.user.id}`,
      masterDb: master,
      getTenantDb
    });
    disconnectUserSockets({ id: result.admin_id, role: 'admin', tenant_id: result.tenant_id });
    auditSecurityEvent(req, 'password_reset_resolved', {
      tenantId: result.tenant_id,
      requestId: result.id,
      targetAdminId: result.admin_id
    });
    res.json(result);
  } catch (err) {
    logger.warn({ err, requestId: req.params.id }, 'Falha ao resolver solicitacao de senha');
    sendRouteError(res, err);
  }
});

// ============ USERS AND SECTORS (admin) ============

app.get('/api/sectors', tenantAuthMiddleware(['admin']), (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  res.json(listSectors(db));
});

app.post('/api/sectors', tenantAuthMiddleware(['admin']), (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  try {
    const sector = createSector({
      db,
      name: req.body.name,
      active: req.body.active
    });
    auditSecurityEvent(req, 'sector_created', {
      sectorId: sector.id,
      name: sector.name,
      active: Boolean(sector.active)
    });
    res.status(201).json(sector);
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.put('/api/sectors/:id', tenantAuthMiddleware(['admin']), (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  try {
    const sectorId = parsePositiveInt(req.params.id, 'setor');
    const sector = updateSector({
      db,
      id: sectorId,
      name: req.body.name,
      active: req.body.active,
      expectedVersion: parseExpectedRowVersion(req.body.row_version)
    });
    auditSecurityEvent(req, 'sector_updated', {
      sectorId,
      name: sector.name,
      active: Boolean(sector.active),
      rowVersion: sector.row_version
    });
    res.json(sector);
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.get('/api/vendors', tenantAuthMiddleware(['admin']), (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  const onlineByUser = new Map(
    presenceRegistry.list(req.user.tenant_id)
      .filter(item => item.role === 'vendor')
      .map(item => [Number(item.userId), item])
  );
  res.json(listUsers(db).map(user => {
    const presence = onlineByUser.get(Number(user.id));
    return {
      ...user,
      online: Boolean(presence),
      online_since: presence?.connectedAt || null,
      connection_count: Number(presence?.connectionCount || 0)
    };
  }));
});

app.get('/api/admin/user-limit', tenantAuthMiddleware(['admin']), (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  const { getTenant, getTenantUserLimit } = require('./tenantManager');
  const used = countActiveUsers(db);
  const tenant = getTenant(req.user.tenant_id);
  const limit = getTenantUserLimit(tenant);
  res.json({
    used,
    limit,
    available: Math.max(0, limit - used),
    plan: tenant.plan,
    overridden: tenant.user_limit_override != null
  });
});

app.post('/api/vendors', tenantAuthMiddleware(['admin']), (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  const tenantId = req.user.tenant_id;
  let username = '';
  let directoryRegistered = false;
  let tenantUserInserted = false;
  try {
    username = normalizeUsername(req.body.username);
    if (db.defaultDb.prepare(`
      SELECT 1 FROM admins WHERE username = ? COLLATE NOCASE AND coalesce(super_admin, 0) = 1
    `).get(username)) {
      return res.status(409).json({ error: 'Usuario reservado pela administracao da plataforma', code: 'USERNAME_RESERVED' });
    }
    const existing = findDirectoryUser(username);
    if (existing) return res.status(409).json({ error: 'Usuario ja cadastrado', code: 'USERNAME_ALREADY_EXISTS' });

    // Ordem global de locks: master -> tenant. A alteração de plano/override
    // usa a mesma ordem, impedindo criar ou reativar um sexto usuário enquanto
    // o super admin reduz o limite para cinco.
    const user = withTenantCapacityLock(tenantId, tenant => createUser({
      db,
      name: req.body.name,
      username,
      password: req.body.password,
      active: req.body.active,
      sectorId: req.body.sector_id,
      userLimit: getTenantUserLimit(tenant),
      onBeforeCommit: created => {
        tenantUserInserted = true;
        registerDirectoryUser(created.username, tenantId, 'vendor');
        directoryRegistered = true;
      }
    }));
    auditSecurityEvent(req, 'vendor_created', {
      vendorId: user.id,
      username: user.username,
      sectorId: user.sector_id,
      active: Boolean(user.active)
    });
    res.status(201).json(user);
  } catch (err) {
    let localUser = null;
    let directoryEntry = null;
    let rollbackStateVerified = false;
    try {
      localUser = db.prepare('SELECT id FROM vendors WHERE username = ? COLLATE NOCASE').get(username) || null;
      directoryEntry = findDirectoryUser(username) || null;
      rollbackStateVerified = true;
    } catch (verificationError) {
      logger.error({ err: verificationError, tenantId, username }, 'Falha ao verificar rollback de usuario');
    }
    const directoryOwnsUser = Number(directoryEntry?.tenant_id) === Number(tenantId)
      && directoryEntry?.role === 'vendor';
    if (rollbackStateVerified && tenantUserInserted && localUser && !directoryOwnsUser) {
      try {
        db.prepare('DELETE FROM vendors WHERE id = ? AND username = ? COLLATE NOCASE')
          .run(localUser.id, username);
      } catch (cleanupError) {
        logger.error({ err: cleanupError, tenantId, username }, 'Falha ao desfazer usuario sem diretorio');
      }
    } else if (rollbackStateVerified && directoryRegistered && !localUser && directoryOwnsUser) {
      try {
        master.prepare(`
          DELETE FROM user_directory
          WHERE username = ? COLLATE NOCASE AND tenant_id = ? AND role = 'vendor'
        `).run(username, tenantId);
      } catch (cleanupError) {
        logger.error({ err: cleanupError, tenantId, username }, 'Falha ao desfazer reserva de usuario');
      }
    }
    sendRouteError(res, err);
  }
});

app.put('/api/vendors/:id', tenantAuthMiddleware(['admin']), (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  const tenantId = req.user.tenant_id;
  let previous = null;
  let username = '';
  let directoryRenamed = false;
  let tenantUserUpdated = false;
  try {
    const vendorId = parsePositiveInt(req.params.id, 'usuario');
    previous = db.prepare('SELECT username FROM vendors WHERE id = ?').get(vendorId);
    if (!previous) return res.status(404).json({ error: 'Usuario nao encontrado', code: 'USER_NOT_FOUND' });
    username = normalizeUsername(req.body.username);
    if (db.defaultDb.prepare(`
      SELECT 1 FROM admins WHERE username = ? COLLATE NOCASE AND coalesce(super_admin, 0) = 1
    `).get(username)) {
      return res.status(409).json({ error: 'Usuario reservado pela administracao da plataforma', code: 'USERNAME_RESERVED' });
    }
    const directoryEntry = findDirectoryUser(username);
    if (directoryEntry && (
      String(previous.username).toLowerCase() !== username
      || Number(directoryEntry.tenant_id) !== Number(tenantId)
      || directoryEntry.role !== 'vendor'
    )) {
      return res.status(409).json({ error: 'Usuario ja cadastrado', code: 'USERNAME_ALREADY_EXISTS' });
    }

    const user = withTenantCapacityLock(tenantId, tenant => updateUser({
      db,
      id: vendorId,
      name: req.body.name,
      username,
      password: req.body.password,
      active: req.body.active,
      sectorId: req.body.sector_id,
      userLimit: getTenantUserLimit(tenant),
      expectedVersion: parseExpectedRowVersion(req.body.row_version),
      onBeforeCommit: (updated, existing) => {
        tenantUserUpdated = true;
        renameDirectoryUser(existing.username, updated.username, tenantId, 'vendor');
        directoryRenamed = String(existing.username).toLowerCase() !== updated.username;
      }
    }));
    disconnectUserSockets({ id: vendorId, role: 'vendor', tenant_id: tenantId });
    auditSecurityEvent(req, 'vendor_updated', {
      vendorId,
      username: user.username,
      usernameChanged: String(previous.username).toLowerCase() !== user.username,
      passwordChanged: typeof req.body.password === 'string' && req.body.password.length > 0,
      sectorId: user.sector_id,
      active: Boolean(user.active),
      rowVersion: user.row_version
    });
    res.json(user);
  } catch (err) {
    let recovered = null;
    if (tenantUserUpdated && previous?.username) {
      let persisted = null;
      try {
        persisted = listUsers(db).find(item => Number(item.id) === Number(req.params.id)) || null;
      } catch (verificationError) {
        logger.error({ err: verificationError, tenantId, username }, 'Falha ao verificar rollback de renomeacao');
      }
      if (persisted && String(persisted.username).toLowerCase() === username) {
        try {
          const entry = findDirectoryUser(username);
          if (!entry || Number(entry.tenant_id) !== Number(tenantId) || entry.role !== 'vendor') {
            renameDirectoryUser(previous.username, username, tenantId, 'vendor');
          }
          recovered = persisted;
        } catch (cleanupError) {
          logger.error({ err: cleanupError, tenantId, username }, 'Falha ao concluir diretorio apos commit do usuario');
        }
      } else if (directoryRenamed && persisted
          && String(persisted.username).toLowerCase() === String(previous.username).toLowerCase()) {
        try {
          renameDirectoryUser(username, previous.username, tenantId, 'vendor');
        } catch (cleanupError) {
          logger.error({ err: cleanupError, tenantId, username }, 'Falha ao desfazer renomeacao de usuario');
        }
      }
    }
    if (recovered && !res.headersSent) {
      disconnectUserSockets({ id: recovered.id, role: 'vendor', tenant_id: tenantId });
      auditSecurityEvent(req, 'vendor_update_recovered', {
        vendorId: recovered.id,
        username: recovered.username,
        originalError: err.code || err.message
      });
      return res.json(recovered);
    }
    sendRouteError(res, err);
  }
});

app.delete('/api/vendors/:id', tenantAuthMiddleware(['admin']), (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  try {
    const vendorId = parsePositiveInt(req.params.id, 'usuario');
    const user = deactivateUser({
      db,
      id: vendorId,
      expectedVersion: parseExpectedRowVersion(req.body?.row_version ?? req.query.row_version)
    });
    const { recoverPlanCapacityBlock } = require('./tenantManager');
    const capacityRecovery = recoverPlanCapacityBlock(req.user.tenant_id);
    if (capacityRecovery.recovered) {
      resumeTenantRuntimeAfterBilling(req.user.tenant_id, { force: true });
    }
    disconnectUserSockets({ id: vendorId, role: 'vendor', tenant_id: req.user.tenant_id });
    auditSecurityEvent(req, 'vendor_deactivated', {
      vendorId,
      username: user.username,
      rowVersion: user.row_version
    });
    res.json({ success: true, user, capacity_recovery: capacityRecovery });
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.get('/api/admin/statistics', tenantAuthMiddleware(['admin']), (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  try {
    res.json(getTenantStatistics({
      db,
      days: req.query.days,
      presence: presenceRegistry.list(req.user.tenant_id)
    }));
  } catch (err) {
    logger.error({ err, tenantId: req.user.tenant_id }, 'Erro ao gerar estatísticas do tenant');
    sendInternalError(res);
  }
});

app.get('/api/search', tenantAuthMiddleware(), (req, res) => {
  const results = searchVisibleContent({
    db,
    user: req.user,
    q: req.query.q || '',
    mediaType: req.query.media_type || ''
  });
  results.contacts = req.query.q
    ? listContacts(db, { q: req.query.q, limit: 30, savedOnly: true })
    : [];
  res.json(results);
});

app.get('/api/contacts', tenantAuthMiddleware(), (req, res) => {
  res.json(listContacts(db, {
    q: req.query.q || '',
    limit: req.query.limit || 100,
    savedOnly: req.query.all !== '1'
  }));
});

app.post('/api/contacts/sync', tenantAuthMiddleware(['vendor', 'admin']), async (req, res) => {
  try {
    const key = importKey(req.user.tenant_id);
    const client = waManagerReady ? waManager.getReadyClient(key) : null;
    if (!client) return res.status(409).json({ error: 'WhatsApp da sua empresa não está conectado' });

    const activeSync = contactSyncRunning.get(key);
    if (activeSync?.client === client) {
      const timedOut = Boolean(activeSync.timedOut);
      res.set('Retry-After', String(Math.max(1, Math.ceil(CONTACT_SYNC_MANUAL_COOLDOWN_MS / 1000))));
      return res.status(timedOut ? 503 : 202).json({
        ok: false,
        syncing: !timedOut,
        code: timedOut ? 'CONTACT_SYNC_QUARANTINED' : 'CONTACT_SYNC_IN_PROGRESS',
        error: timedOut
          ? 'A sincronização anterior não encerrou no WhatsApp. Reconecte a sessão para tentar novamente.'
          : 'A sincronização de contatos já está em andamento'
      });
    }

    const elapsed = Date.now() - (contactSyncLastStartedAt.get(key) || 0);
    const cooldownRemainingMs = CONTACT_SYNC_MANUAL_COOLDOWN_MS - elapsed;
    if (cooldownRemainingMs > 0) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(cooldownRemainingMs / 1000))));
      return res.status(429).json({
        error: 'Aguarde alguns segundos antes de sincronizar os contatos novamente',
        code: 'CONTACT_SYNC_COOLDOWN',
        retry_after_ms: cooldownRemainingMs
      });
    }

    const result = await runTenantContactsSync(key, { client, throwOnError: true, source: 'manual' });
    if (!result.started) {
      return res.status(202).json({ ok: false, syncing: true, code: 'CONTACT_SYNC_IN_PROGRESS' });
    }
    return res.json({ ok: true, stats: result.stats });
  } catch (err) {
    logger.warn({ err, tenantId: req.user.tenant_id }, 'Falha ao sincronizar contatos sob demanda');
    if (err.code === 'OPERATION_TIMEOUT') {
      res.set('Retry-After', String(Math.max(1, Math.ceil(CONTACT_SYNC_MANUAL_COOLDOWN_MS / 1000))));
      return res.status(503).json({
        error: 'O WhatsApp não concluiu a sincronização de contatos no prazo. Reconecte a sessão antes de tentar novamente.',
        code: 'CONTACT_SYNC_TIMEOUT'
      });
    }
    return sendRouteError(res, err);
  }
});

// ============ CONVERSATIONS ============

app.get('/api/conversations', tenantAuthMiddleware(), (req, res) => {
  try {
    res.json(getVisibleConversations({
      db,
      user: req.user,
      queue: req.query.queue || '',
      limit: req.query.limit,
      offset: req.query.offset
    }));
  } catch (err) {
    sendRouteError(res, err);
  }
});

function getCachedConversationProfile(conversationId) {
  const conversation = db.prepare(`
    SELECT c.*, v.name AS vendor_name, s.name AS sector_name
    FROM conversations c
    LEFT JOIN vendors v ON v.id = c.assigned_to
    LEFT JOIN sectors s ON s.id = c.sector_id
    WHERE c.id = ?
  `).get(conversationId);
  if (!conversation) return null;

  const identifiers = getConversationIdentifiers(db, conversationId);
  let contact = null;
  if (identifiers.length) {
    const placeholders = identifiers.map(() => '?').join(', ');
    contact = db.prepare(`
      SELECT *
      FROM contacts
      WHERE whatsapp_id IN (${placeholders})
      ORDER BY is_saved DESC, synced_at DESC
      LIMIT 1
    `).get(...identifiers) || null;
  }

  const participants = Number(conversation.is_group) === 1
    ? db.prepare(`
        SELECT participant_id, phone, name, profile_pic_url, is_admin, is_super_admin
        FROM group_participants
        WHERE conversation_id = ?
        ORDER BY is_super_admin DESC, is_admin DESC,
                 COALESCE(NULLIF(name, ''), NULLIF(phone, ''), participant_id) COLLATE NOCASE
      `).all(conversationId)
    : [];

  return {
    ...conversation,
    is_saved: Number(contact?.is_saved || 0),
    is_business: Number(contact?.is_business || 0),
    is_blocked: Number(contact?.is_blocked || 0),
    participants
  };
}

app.get('/api/conversations/:id/profile', tenantAuthMiddleware(), async (req, res) => {
  const conversationId = parsePositiveInt(req.params.id, 'conversa');
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada' });
  if (!canAccessConversation(req.user, conversation)) {
    return res.status(403).json({ error: 'Essa conversa não pertence ao seu departamento' });
  }

  if (req.query.refresh === '1') {
    const client = waManagerReady ? waManager.getReadyClient(req.user.tenant_id) : null;
    if (client) {
      try {
        const chat = await getWhatsAppChatById(client, conversation.phone, getConversationIdentifiers(db, conversationId));
        if (chat) {
          await syncConversationProfile(client, db, conversation, chat, { timeoutMs: 12000 });
          linkConversationIdentifiers(db, conversationId, [conversation.phone, getChatId(chat)]);
          emitConversationUpdate(conversationId);
        }
      } catch (err) {
        logger.warn({ err, conversationId, tenantId: req.user.tenant_id }, 'Perfil ao vivo indisponível; usando cache local');
      }
    }
  }

  res.json(getCachedConversationProfile(conversationId));
});

async function getLiveConversationContact(client, conversation) {
  const identifiers = uniqueIdentifiers([
    conversation.phone,
    ...getConversationIdentifiers(db, conversation.id)
  ]);
  const chat = await getWhatsAppChatById(client, conversation.phone, identifiers);
  if (typeof chat?.getContact === 'function') {
    try {
      const contact = await withTimeout(chat.getContact(), 8000, 'getContact');
      if (contact) return contact;
    } catch {}
  }
  if (typeof client?.getContactById === 'function') {
    for (const identifier of identifiers) {
      try {
        const contact = await withTimeout(client.getContactById(identifier), 5000, 'getContactById');
        if (contact) return contact;
      } catch {}
    }
  }
  return null;
}

app.patch('/api/conversations/:id/block', tenantAuthMiddleware(['vendor', 'admin']), async (req, res) => {
  const conversationId = parsePositiveInt(req.params.id, 'conversa');
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada' });
  if (!canAccessConversation(req.user, conversation)) {
    return res.status(403).json({ error: 'Essa conversa não é sua' });
  }
  if (Number(conversation.is_group) === 1 || String(conversation.phone).endsWith('@g.us')) {
    return res.status(400).json({ error: 'Grupos não podem ser bloqueados' });
  }
  const client = waManagerReady ? waManager.getReadyClient(req.user.tenant_id) : null;
  if (!client) return res.status(409).json({ error: 'WhatsApp desconectado' });
  const blocked = Boolean(req.body.blocked);
  try {
    const contact = await getLiveConversationContact(client, conversation);
    const action = blocked ? contact?.block : contact?.unblock;
    if (typeof action !== 'function') {
      return res.status(404).json({ error: 'Contato não encontrado no WhatsApp' });
    }
    const changed = await withTimeout(action.call(contact), 15000, blocked ? 'blockContact' : 'unblockContact');
    if (changed === false) return res.status(400).json({ error: 'O WhatsApp não permitiu esta ação' });

    const identifiers = uniqueIdentifiers([
      conversation.phone,
      ...getConversationIdentifiers(db, conversation.id),
      getChatId(contact)
    ]);
    db.transaction(() => {
      db.prepare(`
        INSERT INTO contacts (whatsapp_id, phone, name, is_blocked, synced_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(whatsapp_id) DO UPDATE SET
          is_blocked = excluded.is_blocked,
          synced_at = CURRENT_TIMESTAMP
      `).run(
        identifiers[0] || conversation.phone,
        contactPhone(contact, conversation.phone),
        contactDisplayName(contact) || conversation.contact_name,
        blocked ? 1 : 0
      );
      if (identifiers.length) {
        const placeholders = identifiers.map(() => '?').join(', ');
        db.prepare(`UPDATE contacts SET is_blocked = ?, synced_at = CURRENT_TIMESTAMP WHERE whatsapp_id IN (${placeholders})`)
          .run(blocked ? 1 : 0, ...identifiers);
      }
    })();
    emitConversationUpdate(conversationId);
    res.json({ ok: true, blocked, profile: getCachedConversationProfile(conversationId) });
  } catch (err) {
    logger.warn({ err, conversationId, tenantId: req.user.tenant_id }, 'Falha ao alterar bloqueio do contato');
    res.status(err.statusCode || 502).json({ error: 'O WhatsApp não confirmou a alteração de bloqueio' });
  }
});

async function resolveNewConversationIdentity(client, { phone, contactId }) {
  const storedContact = contactId
    ? db.prepare('SELECT * FROM contacts WHERE whatsapp_id = ?').get(String(contactId))
    : null;
  if (contactId && !storedContact) {
    const err = new Error('Contato não encontrado na agenda sincronizada');
    err.statusCode = 404;
    throw err;
  }

  const fallbackContactId = storedContact?.whatsapp_id || '';
  const digits = storedContact?.phone
    ? normalizePhoneInput(storedContact.phone)
    : phone
      ? normalizePhoneInput(phone)
      : fallbackContactId.endsWith('@c.us')
        ? normalizePhoneInput(fallbackContactId)
        : '';
  let numberId = null;
  if (digits && typeof client.getNumberId === 'function') {
    numberId = await withTimeout(client.getNumberId(digits), 12000, 'getNumberId');
  }
  const serializedNumberId = getChatId(numberId);
  const chatId = serializedNumberId
    || (isImportableChatId(fallbackContactId) && !fallbackContactId.endsWith('@g.us') ? fallbackContactId : '');
  if (!chatId) {
    const err = new Error('Este número não está cadastrado no WhatsApp');
    err.statusCode = 404;
    throw err;
  }

  let liveContact = null;
  if (typeof client.getContactById === 'function') {
    try {
      liveContact = await withTimeout(client.getContactById(chatId), 5000, 'getContactById');
    } catch {}
  }
  const aliases = await resolveWhatsAppIdentifiers(client, chatId, 4000);
  return {
    chatId,
    aliases: uniqueIdentifiers([chatId, fallbackContactId, ...aliases]),
    phone: digits,
    contactName: contactDisplayName(liveContact)
      || storedContact?.name
      || storedContact?.short_name
      || storedContact?.push_name
      || storedContact?.verified_name
      || digits
      || fallbackContactId.replace(/@(c\.us|lid)$/i, ''),
    profilePicUrl: storedContact?.profile_pic_url || null
  };
}

app.post('/api/conversations/start', tenantAuthMiddleware(['vendor', 'admin']), async (req, res) => {
  const client = waManagerReady ? waManager.getReadyClient(req.user.tenant_id) : null;
  if (!client) return res.status(409).json({ error: 'WhatsApp da sua empresa não está conectado' });

  try {
    const identity = await resolveNewConversationIdentity(client, {
      phone: req.body.phone,
      contactId: req.body.contact_id
    });
    let conversation = findOpenConversationByIdentifiers(db, identity.aliases);
    let created = false;

    if (conversation && !canAccessConversation(req.user, conversation)) {
      return res.status(403).json({ error: 'Este contato já está em atendimento por outro departamento' });
    }

    if (!conversation) {
      const vendorId = req.user.role === 'vendor' ? req.user.id : null;
      const sectorId = req.user.role === 'vendor' ? req.user.sector_id : null;
      if (req.user.role === 'vendor' && !sectorId) {
        return res.status(409).json({ error: 'Seu usuário precisa pertencer a um departamento para iniciar conversas' });
      }
      const result = db.prepare(`
        INSERT INTO conversations (
          phone, contact_name, profile_pic_url, assigned_to, sector_id, status,
          is_group, manually_started, whatsapp_archived, archive_sync_state,
          last_activity_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, 1, 0, 'synced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        identity.chatId,
        identity.contactName,
        identity.profilePicUrl,
        vendorId,
        sectorId,
        vendorId ? 'active' : 'unassigned'
      );
      conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid);
      created = true;
    } else {
      db.prepare(`
        UPDATE conversations
        SET manually_started = 1,
            contact_name = COALESCE(NULLIF(contact_name, ''), ?),
            profile_pic_url = COALESCE(profile_pic_url, ?),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(identity.contactName, identity.profilePicUrl, conversation.id);
      conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation.id);
    }

    linkConversationIdentifiers(db, conversation.id, identity.aliases);
    emitConversationUpdate(conversation.id);
    res.status(created ? 201 : 200).json({ created, conversation });
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message || 'Não foi possível iniciar a conversa' });
  }
});

async function setWhatsAppConversationArchived(client, conversation, archived) {
  const chat = await getWhatsAppChatById(client, conversation.phone, getConversationIdentifiers(db, conversation.id));
  if (!chat) return { synced: false, chat: null };
  if (archived) {
    if (typeof chat.archive === 'function') await withTimeout(chat.archive(), 15000, 'archiveChat');
    else if (typeof client.archiveChat === 'function') await withTimeout(client.archiveChat(getChatId(chat)), 15000, 'archiveChat');
    else throw new Error('Esta sessão não oferece arquivamento');
  } else {
    if (typeof chat.unarchive === 'function') await withTimeout(chat.unarchive(), 15000, 'unarchiveChat');
    else if (typeof client.unarchiveChat === 'function') await withTimeout(client.unarchiveChat(getChatId(chat)), 15000, 'unarchiveChat');
    else throw new Error('Esta sessão não oferece desarquivamento');
  }
  return { synced: true, chat };
}

app.patch('/api/conversations/:id/archive', tenantAuthMiddleware(['vendor', 'admin']), async (req, res) => {
  const conversationId = parsePositiveInt(req.params.id, 'conversa');
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada' });
  if (!canAccessConversation(req.user, conversation)) {
    return res.status(403).json({ error: 'Essa conversa não pertence ao seu departamento' });
  }

  const archived = Boolean(req.body.archived);
  const client = waManagerReady ? waManager.getReadyClient(req.user.tenant_id) : null;
  if (!client) return res.status(409).json({ error: 'WhatsApp desconectado; arquivamento não foi alterado' });
  try {
    const result = await setWhatsAppConversationArchived(client, conversation, archived);
    const localOnly = !result.synced && Number(conversation.manually_started) === 1
      && !db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? LIMIT 1').get(conversationId);
    if (!result.synced && !localOnly) {
      return res.status(404).json({ error: 'Conversa não encontrada no WhatsApp para sincronizar o arquivamento' });
    }
    db.prepare(`
      UPDATE conversations
      SET whatsapp_archived = ?,
          archived_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
          archive_sync_state = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(archived ? 1 : 0, archived ? 1 : 0, result.synced ? 'synced' : 'local_only', conversationId);
    const updated = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    emitConversationUpdate(conversationId);
    res.json({ ok: true, synced: result.synced, conversation: updated });
  } catch (err) {
    logger.warn({ err, conversationId, tenantId: req.user.tenant_id }, 'Falha ao sincronizar arquivamento');
    res.status(502).json({ error: 'O WhatsApp não confirmou o arquivamento. Nada foi alterado.' });
  }
});

app.get('/api/conversations/unassigned', tenantAuthMiddleware(['admin']), (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  const conversations = db.prepare(`
    SELECT c.*, s.name as sector_name
    FROM conversations c
    LEFT JOIN sectors s ON c.sector_id = s.id
    WHERE c.assigned_to IS NULL AND c.sector_id IS NULL AND c.status = 'unassigned'
      AND COALESCE(c.whatsapp_archived, 0) = 0
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
    ORDER BY COALESCE(c.last_activity_at, c.updated_at, c.created_at) DESC, c.id DESC
  `).all();
  res.json(conversations);
});

app.post('/api/conversations/:id/assign', tenantAuthMiddleware(['admin']), (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  try {
    const conversationId = parsePositiveInt(req.params.id, 'conversa');
    const conversation = assignConversation({
      db,
      conversationId,
      vendorId: parseOptionalPositiveInt(req.body.vendor_id, 'usuario'),
      sectorId: parseOptionalPositiveInt(req.body.sector_id, 'setor')
    });
    auditSecurityEvent(req, 'conversation_assigned', {
      conversationId,
      vendorId: conversation.assigned_to,
      sectorId: conversation.sector_id
    });
    emitConversationUpdate(conversation.id);
    res.json(conversation);
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.post('/api/conversations/:id/close', tenantAuthMiddleware(['admin']), (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  const conversationId = parsePositiveInt(req.params.id, 'conversa');
  const result = db.prepare("UPDATE conversations SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(conversationId);
  if (!result.changes) return res.status(404).json({ error: 'Conversa nao encontrada' });
  auditSecurityEvent(req, 'conversation_closed', { conversationId });
  emitConversationUpdate(conversationId);
  res.json({ success: true });
});

app.patch('/api/conversations/:id/state', tenantAuthMiddleware(), (req, res) => {
  try {
    const conversationId = parsePositiveInt(req.params.id, 'conversa');
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

    if (!canAccessConversation(req.user, conv)) {
      return res.status(403).json({ error: 'Essa conversa não é sua' });
    }

    const state = updateConversationUserState({
      db,
      conversationId,
      user: req.user,
      patch: {
        pinned: req.body.pinned,
        muted: req.body.muted,
        mutedUntil: req.body.muted_until,
        markedUnread: req.body.marked_unread,
        draftText: req.body.draft_text
      }
    });
    emitConversationUpdate(conversationId);
    return res.json(state);
  } catch (err) {
    return sendRouteError(res, err);
  }
});

app.post('/api/conversations/:id/read', tenantAuthMiddleware(), (req, res) => {
  const conversationId = parsePositiveInt(req.params.id, 'conversa');
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

  if (!canAccessConversation(req.user, conv)) {
    return res.status(403).json({ error: 'Essa conversa não é sua' });
  }

  res.json(markConversationRead({
    db,
    conversationId,
    user: req.user,
    throughMessageId: parseOptionalPositiveInt(req.body?.last_message_id, 'ultima mensagem lida')
  }));
});

// ============ MESSAGES ============

app.post('/api/conversations/:id/sync', tenantAuthMiddleware(['vendor', 'admin']), async (req, res) => {
  const conversationId = parsePositiveInt(req.params.id, 'conversa');
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

  if (!canAccessConversation(req.user, conv)) {
    return res.status(403).json({ error: 'Essa conversa não é sua' });
  }

  try {
    const stats = await syncConversationFromWhatsApp({
      conversation: conv,
      tenantId: req.user.tenant_id
    });
    res.json({ ok: true, stats });
  } catch (err) {
    logger.warn({ err, conversationId, tenantId: req.user.tenant_id }, 'Falha ao sincronizar conversa sob demanda');
    res.status(err.statusCode || 500).json({ error: err.message || 'Erro ao sincronizar conversa' });
  }
});

app.post('/api/conversations/:id/sync-older', tenantAuthMiddleware(['vendor', 'admin']), async (req, res) => {
  const conversationId = parsePositiveInt(req.params.id, 'conversa');
  const beforeId = parsePositiveInt(req.body?.before_id, 'mensagem de referência');
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
  if (!canAccessConversation(req.user, conv)) {
    return res.status(403).json({ error: 'Essa conversa não é sua' });
  }
  const reference = db.prepare(`
    SELECT id
    FROM messages
    WHERE id = ? AND conversation_id = ?
  `).get(beforeId, conversationId);
  if (!reference) return res.status(404).json({ error: 'Mensagem de referência não encontrada nesta conversa' });

  const localCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE conversation_id = ?
  `).get(conversationId).count;
  const requestedLimit = Math.min(
    OLDER_SYNC_MAX_FETCH_LIMIT,
    Math.max(CONVERSATION_SYNC_MESSAGE_LIMIT, Number(localCount) + 100)
  );
  try {
    const stats = await syncConversationFromWhatsApp({
      conversation: conv,
      tenantId: req.user.tenant_id,
      messageLimit: requestedLimit,
      maxFetchLimit: requestedLimit,
      absoluteMaxFetchLimit: OLDER_SYNC_MAX_FETCH_LIMIT,
      chatFetchTimeoutMs: OLDER_SYNC_TIMEOUT_MS,
      force: true,
      forceHistoryRefresh: true,
      waitForLatestChange: false
    });
    const syncState = db.prepare(`
      SELECT history_complete, oldest_message_at, last_success_at, last_error
      FROM conversation_sync_state
      WHERE conversation_id = ?
    `).get(conversationId) || null;
    res.json({ ok: true, stats, syncState });
  } catch (err) {
    logger.warn({ err, conversationId, tenantId: req.user.tenant_id }, 'Falha ao buscar histórico antigo');
    res.status(err.statusCode || 500).json({ error: err.message || 'Erro ao buscar histórico antigo' });
  }
});

app.get('/api/conversations/:id/messages', tenantAuthMiddleware(), (req, res) => {
  const conversationId = parsePositiveInt(req.params.id, 'conversa');
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

  if (!canAccessConversation(req.user, conv)) {
    return res.status(403).json({ error: 'Essa conversa não é sua' });
  }

  const msgs = getConversationMessages({
    db,
    user: req.user,
    conversationId,
    filters: {
      starred: req.query.starred === '1',
      q: req.query.q || '',
      mediaType: req.query.media_type
    },
    pagination: {
      limit: req.query.limit,
      beforeId: parseOptionalPositiveInt(req.query.before_id, 'before_id'),
      aroundId: parseOptionalPositiveInt(req.query.around_id, 'around_id')
    }
  });
  res.json(msgs);
});

app.post('/api/conversations/:id/messages', tenantAuthMiddleware(['vendor', 'admin']), async (req, res) => {
  const conversationId = parsePositiveInt(req.params.id, 'conversa');
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

  if (!canAccessConversation(req.user, conv)) {
    return res.status(403).json({ error: 'Essa conversa não é sua' });
  }

  // Envia pelo WhatsApp DO PRÓPRIO tenant, nunca pela sessão global/padrão.
  const tenantClient = waManagerReady ? waManager.getReadyClient(req.user.tenant_id) : null;
  if (!tenantClient) {
    return res.status(409).json({ error: 'O WhatsApp da sua empresa não está conectado. Conecte em Conexão para enviar mensagens.' });
  }

  try {
    const msg = await sendOutboundMessage({
      db,
      whatsappClient: tenantClient,
      conversation: conv,
      user: req.user,
      payload: req.body,
      mediaRoot: MEDIA_ROOT
    });
    emitNewMessage(conv.id, msg.id);
    res.json(msg);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/messages/:id/star', tenantAuthMiddleware(['vendor', 'admin']), (req, res) => {
  const messageId = parsePositiveInt(req.params.id, 'mensagem');
  const msg = getMessageWithConversation(db, messageId);
  if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });

  if (!canAccessConversation(req.user, msg)) {
    return res.status(403).json({ error: 'Essa conversa não é sua' });
  }

  const updated = setMessageStarred({
    db,
    messageId,
    user: req.user,
    starred: Boolean(req.body.starred)
  });
  emitConversationUpdate(msg.conversation_id);
  res.json(updated);
});

app.patch('/api/messages/:id/pin', tenantAuthMiddleware(['vendor', 'admin']), (req, res) => {
  const messageId = parsePositiveInt(req.params.id, 'mensagem');
  const msg = getMessageWithConversation(db, messageId);
  if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
  if (!canAccessConversation(req.user, msg)) {
    return res.status(403).json({ error: 'Essa conversa não é sua' });
  }
  const state = setMessagePinned({
    db,
    messageId,
    user: req.user,
    pinned: Boolean(req.body.pinned)
  });
  emitConversationUpdate(msg.conversation_id);
  res.json({ ...state, pinned: Boolean(state?.pinned_at) });
});

const forwardMediaReadsByTenant = new Map();
let forwardMediaReadsGlobal = 0;

function acquireForwardMediaRead(tenantId) {
  const id = parsePositiveInt(tenantId, 'tenant');
  const perTenantLimit = Number(process.env.FORWARD_MEDIA_TENANT_CONCURRENCY || 2);
  const globalLimit = Number(process.env.FORWARD_MEDIA_GLOBAL_CONCURRENCY || 4);
  const tenantInFlight = forwardMediaReadsByTenant.get(id) || 0;
  if (tenantInFlight >= perTenantLimit || forwardMediaReadsGlobal >= globalLimit) {
    const error = new Error('Muitos encaminhamentos de midia simultaneos; tente novamente em instantes');
    error.statusCode = 429;
    error.code = 'FORWARD_MEDIA_BUSY';
    throw error;
  }
  forwardMediaReadsByTenant.set(id, tenantInFlight + 1);
  forwardMediaReadsGlobal += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    forwardMediaReadsGlobal = Math.max(0, forwardMediaReadsGlobal - 1);
    const remaining = (forwardMediaReadsByTenant.get(id) || 1) - 1;
    if (remaining > 0) forwardMediaReadsByTenant.set(id, remaining);
    else forwardMediaReadsByTenant.delete(id);
  };
}

async function forwardStoredMessageFallback({ source, target, client, user }) {
  const content = source.content && source.content !== '(mídia)' && !source.deleted_for_everyone
    ? source.content
    : '';
  let media = null;
  let releaseMediaRead = null;
  if (source.media_url) {
    const filename = path.basename(source.media_url);
    if (!isTenantMediaFilename(filename, user.tenant_id)) {
      const error = new Error('Mídia não pertence à sua empresa');
      error.statusCode = 403;
      throw error;
    }
    const mediaPath = path.join(MEDIA_ROOT, filename);
    let stats;
    try { stats = await fsPromises.stat(mediaPath); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const missing = new Error('A midia armazenada nao esta mais disponivel');
      missing.statusCode = 409;
      throw missing;
    }
    const maximumBytes = getMaxOutboundMediaBytes();
    if (!stats.isFile() || stats.size > maximumBytes) {
      const error = new Error(`A midia excede o limite de encaminhamento de ${maximumBytes} bytes`);
      error.statusCode = 413;
      error.code = 'FORWARD_MEDIA_TOO_LARGE';
      throw error;
    }
    releaseMediaRead = acquireForwardMediaRead(user.tenant_id);
    let data;
    try {
      data = await fsPromises.readFile(mediaPath);
    } catch (error) {
      releaseMediaRead();
      releaseMediaRead = null;
      throw error;
    }
    media = {
      filename: source.media_filename || filename,
      mimetype: source.media_mimetype || 'application/octet-stream',
      size: data.length,
      messageType: source.media_type === 'sticker' ? 'sticker' : '',
      data: data.toString('base64')
    };
  }
  if (!content && !media) {
    const error = new Error('Esta mensagem não está mais disponível para encaminhar');
    error.statusCode = 409;
    throw error;
  }
  try {
    return await sendOutboundMessage({
      db,
      whatsappClient: client,
      conversation: target,
      user,
      // O encaminhamento depende de DUAS autorizações até o instante real do
      // envio. Se a conversa-fonte for transferida enquanto o anexo aguarda
      // leitura/fila, a outbox aborta em vez de copiar dados para outro setor.
      requiredConversationIds: [source.conversation_id],
      payload: {
        content,
        media,
        sendAsSticker: source.media_type === 'sticker',
        client_request_id: crypto.randomUUID()
      },
      mediaRoot: MEDIA_ROOT
    });
  } finally {
    releaseMediaRead?.();
  }
}

app.post('/api/messages/:id/forward', tenantAuthMiddleware(['vendor', 'admin']), async (req, res) => {
  const messageId = parsePositiveInt(req.params.id, 'mensagem');
  const targetConversationId = parsePositiveInt(req.body.conversation_id, 'conversa de destino');
  const source = getMessageWithConversation(db, messageId);
  const target = db.prepare('SELECT * FROM conversations WHERE id = ?').get(targetConversationId);
  if (!source || !target) return res.status(404).json({ error: 'Mensagem ou conversa não encontrada' });
  if (!canAccessConversation(req.user, source) || !canAccessConversation(req.user, target)) {
    return res.status(403).json({ error: 'Sem permissão para encaminhar entre essas conversas' });
  }
  const client = waManagerReady ? waManager.getReadyClient(req.user.tenant_id) : null;
  if (!client) return res.status(409).json({ error: 'WhatsApp desconectado' });
  try {
    // Todo encaminhamento usa a cópia local durável e a mesma outbox/fila do
    // envio comum. O forward nativo do WhatsApp ignorava limite por hora,
    // intervalo, circuit breaker e confirmação local, permitindo rajadas e
    // mensagens 202 que nunca apareciam no chat interno.
    const forwarded = await forwardStoredMessageFallback({ source, target, client, user: req.user });
    emitNewMessage(target.id, forwarded.id);
    res.status(201).json({ ok: true, forwarded_natively: false, message: forwarded });
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message || 'Não foi possível encaminhar a mensagem' });
  }
});

app.delete('/api/messages/:id', tenantAuthMiddleware(['vendor', 'admin']), async (req, res) => {
  const messageId = parsePositiveInt(req.params.id, 'mensagem');
  const msg = getMessageWithConversation(db, messageId);
  if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
  if (!canAccessConversation(req.user, msg)) {
    return res.status(403).json({ error: 'Essa conversa não é sua' });
  }
  const scope = String(req.query.scope || 'me');
  if (scope === 'me') {
    const hidden = hideMessageForUser({ db, messageId, user: req.user });
    emitConversationUpdate(msg.conversation_id);
    return res.json(hidden);
  }
  if (scope !== 'everyone') return res.status(400).json({ error: 'Escopo de exclusão inválido' });
  if (msg.from_type !== 'vendor' || !msg.external_id) {
    return res.status(409).json({ error: 'Somente mensagens enviadas e confirmadas podem ser apagadas para todos' });
  }
  if (req.user.role === 'vendor' && Number(msg.vendor_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: 'Somente o autor pode apagar essa mensagem para todos' });
  }
  const client = waManagerReady ? waManager.getReadyClient(req.user.tenant_id) : null;
  if (!client) return res.status(409).json({ error: 'WhatsApp desconectado' });
  try {
    const liveMessage = await withTimeout(client.getMessageById(msg.external_id), 10000, 'getMessageById');
    if (typeof liveMessage?.delete !== 'function') {
      return res.status(409).json({ error: 'A mensagem não está mais disponível no WhatsApp' });
    }
    await withTimeout(liveMessage.delete(true), 20000, 'deleteMessageForEveryone');
    const updated = markMessageDeletedForEveryone({
      db,
      messageId,
      mediaRoot: MEDIA_ROOT,
      tenantId: req.user.tenant_id
    });
    emitNewMessage(msg.conversation_id, messageId);
    res.json(updated);
  } catch (err) {
    logger.warn({ err, messageId }, 'Falha ao apagar mensagem para todos');
    res.status(err.statusCode || 502).json({ error: 'O WhatsApp não confirmou a exclusão para todos' });
  }
});

app.get('/api/messages/starred', tenantAuthMiddleware(['vendor', 'admin']), (req, res) => {
  const messages = getStarredMessages({
    db,
    user: req.user,
    q: req.query.q || ''
  });
  res.json(messages);
});

app.get('/api/stickers/recent', tenantAuthMiddleware(['vendor', 'admin']), (req, res) => {
  const requestedLimit = Number(req.query.limit || 48);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 48, 1), 100);
  const vendorVisibility = req.user.role === 'vendor'
    ? 'AND (c.assigned_to = ? OR (? IS NOT NULL AND c.sector_id = ?))'
    : '';
  const params = req.user.role === 'vendor'
    ? [req.user.id, req.user.sector_id || null, req.user.sector_id || null]
    : [];
  const candidates = db.prepare(`
    SELECT m.id,
           m.conversation_id,
           m.media_url,
           m.media_filename,
           m.media_mimetype,
           m.media_sha256,
           m.created_at,
           c.assigned_to,
           c.sector_id,
           c.status,
           c.whatsapp_archived
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.media_type = 'sticker'
      AND m.media_url IS NOT NULL
      AND m.deleted_for_everyone = 0
      ${vendorVisibility}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `).all(...params, Math.min(2000, Math.max(200, limit * 20)));
  const seen = new Set();
  const stickers = [];
  for (const sticker of candidates) {
    if (!canAccessConversation(req.user, sticker)) continue;
    const dedupeKey = sticker.media_sha256 || sticker.media_url;
    if (!dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    stickers.push({
      id: sticker.id,
      media_url: sticker.media_url,
      media_filename: sticker.media_filename,
      media_mimetype: sticker.media_mimetype,
      created_at: sticker.created_at
    });
    if (stickers.length >= limit) break;
  }
  res.json(stickers);
});

// ============ QR CODE STATUS ============

let qrCodeData = null;
let clientReady = false;
let whatsapp = null;
// Estado de import POR TENANT (antes era global e vazava contagem entre empresas).
const importInProgress = new Map(); // tenantId -> bool
const lastImportStats = new Map();  // tenantId -> stats
const lastRecentSyncStats = new Map();
const lastSyncErrors = new Map();
const importKey = (tenantId) => {
  if (tenantId == null) return 0;
  const normalized = Number(tenantId);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error('Tenant inválido para estado de sincronização');
  }
  return normalized;
};
const importConversationUpdateTimers = new Map();
const importConversationUpdateIds = new Map();
const recentSyncTimers = new Map();
const recentSyncRunning = new Set();
const recentSyncRerunRequested = new Set();
const contactSyncTimers = new Map();
// Uma chamada Puppeteer que excede o timeout pode continuar executando no
// Chromium. O registro guarda também o Client e um token, impedindo uma
// segunda chamada no mesmo Client até a operação real encerrar. Uma sessão
// recriada pode avançar sem que a conclusão atrasada destrave a chamada nova.
const contactSyncRunning = new Map();
const contactSyncLastStartedAt = new Map();
const fullReconcileTimers = new Map();
const autoImportTimers = new Map();
const tenantReadyTokens = new Map();
const tenantSyncGenerations = new Map();
const syncRuntimeFailureCounts = new Map();
const conversationSyncInFlight = new Map();
const conversationSyncCache = new Map();
// Timers curtos e direcionados por mensagem. Eles não percorrem outros chats e
// não bloqueiam a reconciliação recente quando uma mídia acabou de chegar sem
// a chave de download ainda disponível no WhatsApp Web.
const realtimeMediaRepairTimers = new Map();
const incomingEnrichmentQueue = new PartitionedWorkQueue({
  concurrency: INCOMING_ENRICHMENT_CONCURRENCY,
  maxPending: INCOMING_ENRICHMENT_MAX_PENDING,
  onTaskError: (err, context) => {
    const tenantId = Number(context.partitionKey) || null;
    logger.warn(
      { err, tenantId, messageId: context.metadata?.messageId },
      'Falha no enriquecimento assíncrono de mensagem; reconciliação priorizada'
    );
    if (tenantId) scheduleRecentTenantSync(tenantId, 1000);
  }
});
let lastClientState = null;
let lastClientError = null;
let lastConnectionMessage = null;
let initializingWhatsApp = false;

function clearTenantRuntimeState(tenantId, { final = false } = {}) {
  const key = importKey(tenantId);
  const clearScheduled = (map, timerField = 'timer') => {
    const scheduled = map.get(key);
    if (scheduled) clearTimeout(timerField ? scheduled[timerField] : scheduled);
    map.delete(key);
  };

  // Invalidate completions already in flight before removing observable state.
  tenantSyncGenerations.set(key, (tenantSyncGenerations.get(key) || 0) + 1);
  clearScheduled(recentSyncTimers);
  clearScheduled(contactSyncTimers);
  clearScheduled(fullReconcileTimers);
  clearScheduled(autoImportTimers);
  clearScheduled(importConversationUpdateTimers, null);
  for (const [cacheKey, cached] of conversationSyncCache) {
    if (!cacheKey.startsWith(`${key}:`)) continue;
    clearTimeout(cached.cleanupTimer);
    conversationSyncCache.delete(cacheKey);
  }
  if (final) {
    for (const syncKey of conversationSyncInFlight.keys()) {
      if (syncKey.startsWith(`${key}:`)) conversationSyncInFlight.delete(syncKey);
    }
  }
  for (const [repairKey, scheduled] of realtimeMediaRepairTimers) {
    if (!repairKey.startsWith(`${key}:`)) continue;
    clearTimeout(scheduled.timer);
    realtimeMediaRepairTimers.delete(repairKey);
  }
  if (final) {
    for (const resolutionKey of conversationResolutionInFlight.keys()) {
      if (resolutionKey.startsWith(`${key}:`)) conversationResolutionInFlight.delete(resolutionKey);
    }
    for (const messageKey of incomingMessageInFlight) {
      if (messageKey.startsWith(`${key}:`)) incomingMessageInFlight.delete(messageKey);
    }
  }

  lastImportStats.delete(key);
  lastRecentSyncStats.delete(key);
  lastSyncErrors.delete(key);
  importConversationUpdateIds.delete(key);
  recentSyncRerunRequested.delete(key);
  tenantReadyTokens.delete(key);
  syncRuntimeFailureCounts.delete(key);
  if (final) {
    importInProgress.delete(key);
    recentSyncRunning.delete(key);
    contactSyncRunning.delete(key);
    contactSyncLastStartedAt.delete(key);
  }
  incomingEnrichmentQueue.discardPartition(key, { permanent: final });
  discardTenantMessageQueue(key, { permanent: final });
  if (final) billingPausedTenantRuntimes.delete(key);
}

function setConnectionStatus(state, { ready = clientReady, qr = qrCodeData, error = lastClientError, message = lastConnectionMessage } = {}) {
  clientReady = ready;
  qrCodeData = qr;
  lastClientState = state;
  lastClientError = error;
  lastConnectionMessage = message;
  emitConnectionUpdate();
}

// Status de conexão de UM tenant específico (fonte da verdade: waManager).
// Cada tenant tem sua própria sessão/número; nunca reaproveitar o status global.
function getTenantConnectionStatus(tenantId, { includeQr = false } = {}) {
  const key = importKey(tenantId);
  const s = waManagerReady && tenantId ? waManager.getStatus(tenantId) : null;
  if (!s) {
    return {
      ready: false,
      state: 'disconnected',
      qr: null,
      error: null,
      importing: false,
      lastImport: null,
      sync: {
        generation: tenantSyncGenerations.get(key) || 0,
        recent: lastRecentSyncStats.get(key) || null,
        lastError: lastSyncErrors.get(key) || null,
        enrichment: incomingEnrichmentQueue.getStats(key)
      }
    };
  }
  return {
    ready: Boolean(s.ready),
    state: s.status || s.state || 'disconnected',
    connectionState: s.state || null,
    qr: includeQr ? (s.qr || null) : null,
    error: s.error || null,
    loadingPercent: Number.isFinite(Number(s.loadingPercent)) ? Number(s.loadingPercent) : null,
    loadingMessage: s.loadingMessage || null,
    lastProgressAt: s.lastProgressAt || null,
    lastReadyAt: s.lastReadyAt || null,
    lastTransitionAt: s.lastTransitionAt || null,
    reconnecting: Boolean(s.reconnecting),
    reconnectAttempts: Number(s.reconnectAttempts || 0),
    reconnectTotal: Number(s.reconnectTotal || 0),
    nextReconnectAt: s.nextReconnectAt || null,
    requiresManualAction: Boolean(s.requiresManualAction),
    importing: Boolean(importInProgress.get(key)),
    lastImport: lastImportStats.get(key) || null,
    sync: {
      generation: tenantSyncGenerations.get(key) || 0,
      recent: lastRecentSyncStats.get(key) || null,
      lastError: lastSyncErrors.get(key) || null,
      enrichment: incomingEnrichmentQueue.getStats(key)
    }
  };
}

// Empurra o status apenas para os sockets do tenant dono da sessão.
function emitTenantConnectionStatus(tenantId) {
  if (!tenantId || !isTenantOperational(tenantId)) return;
  io.to(tenantOperationalRoom(tenantId)).emit(
    'connection:status',
    getTenantConnectionStatus(tenantId, { includeQr: false })
  );
}

function emitConnectionUpdate() {
  // A sessão global/singleton pertence ao tenant padrão; só notifica esse tenant.
  const defaultTenant = getTenantBySlug('default');
  if (defaultTenant) emitTenantConnectionStatus(defaultTenant.id);
}

// Tenant do contexto assíncrono atual (setado em authMiddleware e no handler
// de mensagens recebidas). Usado para escopar eventos de socket por empresa.
function currentTenantId() {
  return db.tenantCtx.getStore()?.tenantId || null;
}

// Eventos com ids de conversa vão para administradores do tenant e apenas
// para vendedores que podem consultar a conversa pelas mesmas regras da API.
// Assim nenhum socket recebe metadados que seriam negados por HTTP.
function emitToConversationAudience(event, payload, conversationId, { includeAdmins = true } = {}) {
  const tenantId = currentTenantId();
  if (!tenantId || !isTenantOperational(tenantId)) return;
  if (includeAdmins) io.to(tenantAdminRoom(tenantId)).emit(event, payload);

  const normalizedConversationId = Number(conversationId);
  if (!Number.isSafeInteger(normalizedConversationId) || normalizedConversationId <= 0) return;
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(normalizedConversationId);
  if (!conversation) return;
  for (const user of visibleUsersForConversation(conversation)) {
    if (user.role !== 'vendor') continue;
    io.to(userRoom(user, tenantId)).emit(event, payload);
  }
}

function emitConversationUpdate(conversationId) {
  emitToConversationAudience(
    'conversation:updated',
    { conversationId: Number(conversationId) || null },
    conversationId
  );
}

function scheduleImportConversationUpdate(tenantId, conversationId = null) {
  if (!tenantId || !isTenantOperational(tenantId)) return;
  const key = importKey(tenantId);
  let changedIds = importConversationUpdateIds.get(key);
  if (!changedIds) {
    changedIds = new Set();
    importConversationUpdateIds.set(key, changedIds);
  }
  if (Number(conversationId) > 0) changedIds.add(Number(conversationId));
  if (importConversationUpdateTimers.has(key)) return;
  const timer = setTimeout(() => {
    importConversationUpdateTimers.delete(key);
    const conversationIds = [...(importConversationUpdateIds.get(key) || [])];
    importConversationUpdateIds.delete(key);
    if (!tenantId || !isTenantOperational(tenantId)) return;
    io.to(tenantAdminRoom(tenantId)).emit('conversation:updated', {
      conversationId: conversationIds.length === 1 ? conversationIds[0] : null,
      conversationIds,
      synchronized: true
    });
    for (const conversationId of conversationIds) {
      emitToConversationAudience('conversation:updated', {
        conversationId,
        conversationIds: [conversationId],
        synchronized: true
      }, conversationId, { includeAdmins: false });
    }
  }, 1000);
  timer.unref?.();
  importConversationUpdateTimers.set(key, timer);
}

async function getWhatsAppChatById(client, chatId, knownIdentifiers = []) {
  if (!client || !chatId) return null;
  const identifierMap = await resolveWhatsAppIdentifierMap(
    client,
    uniqueIdentifiers([chatId, ...knownIdentifiers]),
    Math.min(CONVERSATION_SYNC_TIMEOUT_MS, 3000)
  );
  const candidates = uniqueIdentifiers([
    chatId,
    ...knownIdentifiers,
    ...[...identifierMap.values()].flat()
  ]);
  if (typeof client.getChatById === 'function') {
    for (const candidate of candidates) {
      try {
        const chat = await withTimeout(
          client.getChatById(candidate),
          CONVERSATION_SYNC_TIMEOUT_MS,
          'getChatById'
        );
        if (chat) return chat;
      } catch (err) {
        logger.warn({ err, chatId: candidate }, 'getChatById falhou; tentando identificador alternativo');
      }
    }
  }
  const chats = await withTimeout(() => client.getChats(), CONVERSATION_SYNC_TIMEOUT_MS, 'getChats');
  const candidateSet = new Set(candidates);
  return chats.find(chat => candidateSet.has(getChatId(chat))) || null;
}

async function getChatLatestExternalId(chat) {
  if (typeof chat?.fetchMessages !== 'function') return null;
  try {
    const messages = await withTimeout(
      chat.fetchMessages({ limit: 1 }),
      Math.min(CONVERSATION_SYNC_TIMEOUT_MS, 3000),
      'fetchLatestMessage'
    );
    return getMessageExternalId(messages?.[messages.length - 1]) || null;
  } catch {
    return null;
  }
}

async function waitForChatHistoryRefresh(chat, previousLatestId) {
  const maxWaitMs = Math.min(CONVERSATION_SYNC_TIMEOUT_MS, 2500);
  const deadline = Date.now() + maxWaitMs;
  do {
    if (CONVERSATION_SYNC_SETTLE_MS > 0) {
      await sleep(Math.min(750, CONVERSATION_SYNC_SETTLE_MS));
    }
    const latestId = await getChatLatestExternalId(chat);
    if (latestId && previousLatestId && latestId !== previousLatestId) return true;
    if (latestId && !previousLatestId) return true;
  } while (Date.now() < deadline);
  return false;
}

async function syncConversationFromWhatsApp(options) {
  const tenantId = Number(options.tenantId);
  const conversationId = Number(options.conversation?.id);
  if (!isTenantOperational(tenantId)) {
    const error = new Error('Empresa inativa ou com assinatura indisponível');
    error.statusCode = 402;
    throw error;
  }
  const syncKey = `${tenantId}:${conversationId}`;
  const existing = conversationSyncInFlight.get(syncKey);
  if (existing) return existing;

  const cached = conversationSyncCache.get(syncKey);
  if (
    !options.force
    && cached
    && Date.now() - cached.completedAt < CONVERSATION_SYNC_COOLDOWN_MS
  ) {
    return { ...cached.stats, coalesced: true };
  }
  if (cached) {
    clearTimeout(cached.cleanupTimer);
    conversationSyncCache.delete(syncKey);
  }

  const operation = performConversationSyncFromWhatsApp(options)
    .then(stats => {
      if (!isTenantOperational(tenantId)) return stats;
      const completedAt = Date.now();
      const cleanupTimer = setTimeout(() => {
        const current = conversationSyncCache.get(syncKey);
        if (current?.completedAt === completedAt) conversationSyncCache.delete(syncKey);
      }, Math.max(1, CONVERSATION_SYNC_COOLDOWN_MS));
      cleanupTimer.unref?.();
      conversationSyncCache.set(syncKey, { stats, completedAt, cleanupTimer });
      return stats;
    })
    .finally(() => conversationSyncInFlight.delete(syncKey));
  conversationSyncInFlight.set(syncKey, operation);
  return operation;
}

async function performConversationSyncFromWhatsApp({
  conversation,
  tenantId,
  messageLimit = CONVERSATION_SYNC_MESSAGE_LIMIT,
  maxFetchLimit = CONVERSATION_SYNC_MESSAGE_LIMIT,
  absoluteMaxFetchLimit = maxFetchLimit,
  chatFetchTimeoutMs = CONVERSATION_SYNC_TIMEOUT_MS,
  forceHistoryRefresh = true,
  waitForLatestChange = true
}) {
  const client = waManagerReady ? waManager.getReadyClient(tenantId) : null;
  if (!client) {
    const err = new Error('WhatsApp da sua empresa não está conectado');
    err.statusCode = 409;
    throw err;
  }

  const chat = await getWhatsAppChatById(
    client,
    conversation.phone,
    getConversationIdentifiers(db, conversation.id)
  ).catch(err => {
    recordSyncRuntimeFailure(tenantId, client, err, 'conversation_lookup');
    throw err;
  });
  if (!chat) {
    const err = new Error('Conversa não encontrada no WhatsApp Web');
    err.statusCode = 404;
    throw err;
  }
  const resolvedChatId = getChatId(chat) || conversation.phone;
  linkConversationIdentifiers(db, conversation.id, [conversation.phone, resolvedChatId]);
  const latestIdBeforeRefresh = await getChatLatestExternalId(chat);

  try {
    if (client.interface && typeof client.interface.openChatWindow === 'function') {
      await withTimeout(client.interface.openChatWindow(resolvedChatId), CONVERSATION_SYNC_TIMEOUT_MS, 'openChatWindow');
      logger.info({ tenantId, conversationId: conversation.id }, 'Janela do chat aberta para atualizar cache do WhatsApp Web');
      if (CONVERSATION_SYNC_SETTLE_MS > 0) {
        await sleep(Math.min(CONVERSATION_SYNC_SETTLE_MS, 250));
      }
    }
  } catch (err) {
    logger.warn({ err, tenantId, conversationId: conversation.id }, 'Falha ao abrir chat para atualizar cache do WhatsApp Web');
  }

  let historySyncRequested = false;
  try {
    if (forceHistoryRefresh && typeof chat.syncHistory === 'function') {
      historySyncRequested = await withTimeout(chat.syncHistory(), CONVERSATION_SYNC_TIMEOUT_MS, 'syncHistory');
    } else if (forceHistoryRefresh && typeof client.syncHistory === 'function') {
      historySyncRequested = await withTimeout(client.syncHistory(resolvedChatId), CONVERSATION_SYNC_TIMEOUT_MS, 'syncHistory');
    }
    logger.info({ tenantId, conversationId: conversation.id, historySyncRequested }, 'Sincronizacao de historico solicitada');
    if (historySyncRequested && waitForLatestChange) {
      await waitForChatHistoryRefresh(chat, latestIdBeforeRefresh);
    } else if (forceHistoryRefresh && CONVERSATION_SYNC_SETTLE_MS > 0) {
      await sleep(Math.min(CONVERSATION_SYNC_SETTLE_MS, 500));
    }
  } catch (err) {
    logger.warn({ err, tenantId, conversationId: conversation.id }, 'Falha ao solicitar sincronizacao de historico');
  }

  const stats = await importExistingChats({
    whatsapp: {
      getChats: async () => [chat],
      getContactLidAndPhone: typeof client.getContactLidAndPhone === 'function'
        ? client.getContactLidAndPhone.bind(client)
        : undefined,
      getContactById: typeof client.getContactById === 'function'
        ? client.getContactById.bind(client)
        : undefined
    },
    db,
    limit: messageLimit,
    adaptiveBackfill: true,
    maxFetchLimit,
    absoluteMaxFetchLimit,
    getChatsTimeoutMs: GET_CHATS_TIMEOUT_MS,
    chatFetchTimeoutMs,
    skipMediaDownload: false,
    retryUnavailableMedia: true,
    mediaRoot: MEDIA_ROOT,
    mediaDownloadTimeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
    profileFetchTimeoutMs: Math.min(PROFILE_FETCH_TIMEOUT_MS, 1000),
    chatImportDelayMs: 0,
    tenantId,
    onConversationImported: importedConversationId => scheduleImportConversationUpdate(tenantId, importedConversationId),
    logger: {
      log: message => logger.info({ tenantId, conversationId: conversation.id, message }, 'Sincronizacao pontual'),
      error: message => logger.warn({ tenantId, conversationId: conversation.id, message }, 'Erro na sincronizacao pontual')
    }
  }).catch(err => {
    recordSyncRuntimeFailure(tenantId, client, err, 'conversation_import');
    throw err;
  });
  try {
    assertSyncBatchUsable(stats);
  } catch (err) {
    recordSyncRuntimeFailure(tenantId, client, err, 'conversation_import');
    throw err;
  }

  if (stats.messagesImported || stats.messagesUpdated || stats.newConversations) {
    emitConversationUpdate(conversation.id);
  }
  clearSyncRuntimeFailures(tenantId);
  return stats;
}

// A sala inclui o tenant para NÃO colidir entre empresas: sem isso, o vendor
// id=1 do tenant A e o vendor id=1 do tenant B cairiam na mesma sala e
// receberiam notificação/typing um do outro (vazamento em tempo real).
function userRoom(user, tenantId) {
  const t = tenantId != null ? tenantId : (user.tenant_id != null ? user.tenant_id : currentTenantId());
  return buildUserRoom(user, t);
}

function identityRoom(user, tenantId) {
  return buildIdentityRoom(user, tenantId);
}

function sessionRoom(user, tenantId) {
  return buildSessionRoom(user, tenantId);
}

function supportTenantRoom(tenantId) {
  return buildSupportTenantRoom(tenantId);
}

function tenantAdminRoom(tenantId) {
  return `tenant:${parsePositiveInt(tenantId, 'tenant')}`;
}

function tenantOperationalRoom(tenantId) {
  return `tenant-operational:${parsePositiveInt(tenantId, 'tenant')}`;
}

function visibleUsersForConversation(conversation) {
  if (!conversation) return [];
  const users = db.prepare('SELECT id, username AS name FROM admins').all()
    .map(admin => ({ id: admin.id, role: 'admin', name: admin.name }));
  if (conversation.assigned_to || conversation.sector_id) {
    const vendors = db.prepare(`
      SELECT id, name, sector_id
      FROM vendors
      WHERE active = 1
        AND (id = ? OR (? IS NOT NULL AND sector_id = ?))
    `).all(conversation.assigned_to || 0, conversation.sector_id || null, conversation.sector_id || null);
    for (const vendor of vendors) {
      users.push({ id: vendor.id, role: 'vendor', name: vendor.name, sector_id: vendor.sector_id });
    }
  }
  return users;
}

function emitTypingUpdate(conversationId, typingUser, typing) {
  const tenantId = currentTenantId();
  if (!tenantId || !isTenantOperational(tenantId)) return;

  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
  if (!conversation || !canAccessConversation(typingUser, conversation)) return;

  updateConversationUserState({
    db,
    conversationId,
    user: typingUser,
    patch: { typing: Boolean(typing) }
  });

  const event = {
    conversationId: Number(conversationId),
    userId: typingUser.id,
    role: typingUser.role,
    name: typingUser.name || typingUser.username || (typingUser.role === 'admin' ? 'Admin' : 'Usuario'),
    typing: Boolean(typing)
  };
  for (const user of visibleUsersForConversation(conversation)) {
    io.to(userRoom(user, tenantId)).emit('typing:update', event);
  }
}

function emitNotificationForMessage(conversationId, messageId) {
  if (!messageId) return;
  const tenantId = currentTenantId();
  if (!tenantId || !isTenantOperational(tenantId)) return;

  const message = db.prepare(`
    SELECT m.*,
           c.phone,
           c.contact_name,
           c.assigned_to,
           c.sector_id,
           c.profile_pic_url,
           c.is_group,
           c.status,
           c.whatsapp_archived
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = ?
  `).get(messageId);
  if (!message || message.from_type !== 'client' || Number(message.whatsapp_archived) === 1) return;

  const title = message.contact_name || message.phone || 'Nova mensagem';
  const mediaLabels = {
    audio: 'Áudio', image: 'Foto', video: 'Vídeo', sticker: 'Figurinha', document: 'Documento'
  };
  const content = String(message.content || '').trim();
  const preview = content && content !== '(mídia)'
    ? content
    : (mediaLabels[message.media_type] || (message.media_url ? 'Mídia' : 'Nova mensagem'));
  const participant = message.participant_name || message.participant_phone || null;
  const body = Number(message.is_group) === 1 && participant
    ? `${participant}: ${preview}`
    : preview;
  for (const user of visibleUsersForConversation(message)) {
    if (isConversationMutedForUser({ db, conversationId, user })) continue;
    io.to(userRoom(user, tenantId)).emit('notification:new', {
      conversationId: Number(conversationId),
      messageId: Number(messageId),
      title,
      body,
      profilePicUrl: message.profile_pic_url || null,
      createdAt: message.created_at
    });
  }
}

function emitNewMessage(conversationId, messageId) {
  emitToConversationAudience(
    'message:new',
    {
      conversationId: Number(conversationId) || null,
      messageId: Number(messageId) || null
    },
    conversationId
  );
  emitNotificationForMessage(conversationId, messageId);
  emitConversationUpdate(conversationId);
}

function getSocketRateLimitKey(socket) {
  return socket.handshake.address || socket.conn?.remoteAddress || 'unknown';
}

function checkSocketRateLimit(socket) {
  const key = getSocketRateLimitKey(socket);
  return socketAuthRateLimiter.isLimited(key);
}

function consumeSocketEventQuota(socket, key, { windowMs, max }) {
  const now = Date.now();
  socket.eventQuotas ||= new Map();
  const current = socket.eventQuotas.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    socket.eventQuotas.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= max;
}

function updateSocketUserLastSeen(socket) {
  if (!socket.tenantDb || !socket.user?.id) return;
  const table = socket.user.role === 'vendor' ? 'vendors' : socket.user.role === 'admin' ? 'admins' : null;
  if (!table) return;
  try {
    socket.tenantDb.prepare(`UPDATE ${table} SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?`).run(socket.user.id);
  } catch (err) {
    logger.warn({ err, tenantId: socket.tenantId, userId: socket.user.id }, 'Falha ao persistir última atividade');
  }
}

io.use((socket, next) => {
  try {
    if (!isSocketOriginAllowed(socket.handshake.headers?.origin, socket.handshake.headers?.host)) {
      return next(new Error('Origem nao permitida'));
    }
    if (checkSocketRateLimit(socket)) {
      return next(new Error('Muitas tentativas de conexão'));
    }
    let token = '';
    const cookies = socket.handshake.headers?.cookie;
    if (cookies) {
      const match = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('auth_token='));
      if (match) token = decodeURIComponent(match.slice('auth_token='.length));
    }
    if (!token) return next(new Error('Token ausente'));
    socket.user = validateAuthenticatedPrincipal(jwt.verify(token, JWT_SECRET));

    if (socket.user.tenant_id) {
      const tenantId = Number(socket.user.tenant_id);
      const { getTenant } = require('./tenantManager');
      const tenant = Number.isSafeInteger(tenantId) && tenantId > 0 ? getTenant(tenantId) : null;
      if (!tenant || tenant.status !== 'active') return next(new Error('Empresa indisponível'));
      const billingBlock = checkBillingBlock(tenantId);
      if (billingBlock) {
        if (socket.user.role !== 'admin' || socket.user.super_admin) {
          return next(new Error('Assinatura inativa'));
        }
        // Admin suspenso recebe somente eventos de suporte/cobranca, nunca
        // conversas, presenca, typing ou notificacoes operacionais.
        socket.billingRestricted = true;
      }
      socket.tenantId = tenantId;
      socket.tenantDb = acquireTenantDbLease(socket.tenantId);
      socket.tenantDbLease = true;
    }

    const runInTenant = fn => (socket.tenantDb
      ? db.tenantCtx.run({ db: socket.tenantDb, tenantId: socket.tenantId }, fn)
      : fn());

    if (!runInTenant(() => isTokenVersionCurrent(socket.user))) {
      if (socket.tenantDbLease) {
        releaseTenantDbLease(socket.tenantId);
        socket.tenantDbLease = false;
      }
      return next(new Error('Token revogado'));
    }
    return next();
  } catch (err) {
    if (socket.tenantDbLease) {
      releaseTenantDbLease(socket.tenantId);
      socket.tenantDbLease = false;
    }
    logger.warn({ err, address: getSocketRateLimitKey(socket) }, 'Erro ao autenticar socket');
    return next(new Error('Token inválido'));
  }
});

io.on('connection', socket => {
  socket.join(sessionRoom(socket.user, socket.user.tenant_id));
  socket.join(identityRoom(socket.user, socket.user.tenant_id));
  const tokenExpiresInMs = Number(socket.user.exp || 0) * 1000 - Date.now();
  if (tokenExpiresInMs > 0) {
    socket.authExpiryTimer = setTimeout(() => socket.disconnect(true), tokenExpiresInMs);
    socket.authExpiryTimer.unref?.();
  }
  if (socket.user.super_admin) socket.join('super-admins');
  if (socket.tenantId) {
    if (socket.user.role === 'admin') socket.join(supportTenantRoom(socket.tenantId));
    if (!socket.billingRestricted) {
      socket.join(userRoom(socket.user, socket.tenantId));
      socket.join(tenantOperationalRoom(socket.tenantId));
      if (socket.user.role === 'admin') socket.join(tenantAdminRoom(socket.tenantId));
      presenceRegistry.connect({
        tenantId: socket.tenantId,
        user: socket.user,
        socketId: socket.id
      });
      if (socket.user.role === 'admin') {
        socket.emit('presence:changed', { users: presenceRegistry.list(socket.tenantId) });
      }
      socket.emit('connection:status', getTenantConnectionStatus(socket.tenantId, { includeQr: false }));
    }
  }
  socket.on('typing:update', payload => {
    if (socket.billingRestricted) return;
    if (!consumeSocketEventQuota(socket, 'typing:update', { windowMs: 10000, max: 60 })) return;
    const emit = () => emitTypingUpdate(Number(payload?.conversationId), socket.user, Boolean(payload?.typing));
    if (socket.tenantDb) {
      db.tenantCtx.run({ db: socket.tenantDb, tenantId: socket.tenantId }, emit);
    } else {
      emit();
    }
  });
  socket.on('disconnect', () => {
    if (socket.authExpiryTimer) clearTimeout(socket.authExpiryTimer);
    if (!socket.tenantId) return;
    try {
      if (!socket.billingRestricted) {
        presenceRegistry.disconnect({
          tenantId: socket.tenantId,
          user: socket.user,
          socketId: socket.id
        });
      }
      updateSocketUserLastSeen(socket);
    } catch (err) {
      logger.warn({ err, tenantId: socket.tenantId, socketId: socket.id }, 'Falha ao limpar socket desconectado');
    } finally {
      if (socket.tenantDbLease) {
        releaseTenantDbLease(socket.tenantId);
        socket.tenantDbLease = false;
      }
    }
  });
});

app.get('/api/status', tenantAuthMiddleware(), (req, res) => {
  if (!requireTenantMember(req, res)) return;
  // O status usado pelo vendedor precisa ser o da própria empresa. O endpoint
  // global fazia tenants conectados parecerem offline quando o número padrão
  // da plataforma estava sem parear.
  res.json({
    ...getTenantConnectionStatus(req.user.tenant_id, { includeQr: false }),
    qr: null
  });
});

app.get('/api/admin/connection', tenantAuthMiddleware(['admin']), (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  // Status da sessão do PRÓPRIO tenant (nunca o status global/padrão).
  res.json(getTenantConnectionStatus(req.user.tenant_id, { includeQr: true }));
});

// Lista de sessões de todos os tenants — exclusivo do super admin.
app.get('/api/admin/connections', authMiddleware(['admin']), async (req, res) => {
  if (!req.user.super_admin) return res.status(403).json({ error: 'Apenas super admin' });
  try {
    const sessions = waManagerReady ? waManager.listSessions() : [];
    const { master } = require('./tenantManager');
    const tenants = master.prepare("SELECT id, slug, name FROM tenants WHERE status = 'active'").all();
    const enriched = tenants.map((t) => {
      const session = sessions.find(s => s.tenantId === t.id) || null;
      const syncKey = importKey(t.id);
      const waStatus = session ? {
        state: session.state,
        status: session.status,
        ready: Boolean(session.ready),
        qr: session.qr || null,
        error: session.error || null,
        loadingPercent: Number.isFinite(Number(session.loadingPercent))
          ? Number(session.loadingPercent)
          : null,
        loadingMessage: session.loadingMessage || null,
        lastProgressAt: session.lastProgressAt || null,
        lastReadyAt: session.lastReadyAt || null,
        lastTransitionAt: session.lastTransitionAt || null,
        queuePosition: session.queuePosition || null,
        reconnectAttempts: session.reconnectAttempts || 0,
        reconnectTotal: session.reconnectTotal || 0,
        nextReconnectAt: session.nextReconnectAt || null,
        requiresManualAction: Boolean(session.requiresManualAction),
        isolated: session.isolated !== false,
        importing: Boolean(importInProgress.get(syncKey)),
        lastImport: lastImportStats.get(syncKey) || null,
        sync: {
          generation: tenantSyncGenerations.get(syncKey) || 0,
          recent: lastRecentSyncStats.get(syncKey) || null,
          lastError: lastSyncErrors.get(syncKey) || null,
          enrichment: incomingEnrichmentQueue.getStats(syncKey)
        }
      } : null;
      return { ...t, waStatus };
    });
    res.json(enriched);
  } catch (err) {
    logger.error({ err }, 'Erro ao listar sessoes WhatsApp');
    sendInternalError(res);
  }
});

app.post('/api/admin/connections/start', authMiddleware(['admin']), async (req, res) => {
  try {
    const tenantId = parsePositiveInt(req.body.tenantId, 'tenantId');
    if (!req.user.super_admin && tenantId !== Number(req.user.tenant_id)) {
      return res.status(403).json({ error: 'Sem permissão para este tenant' });
    }
    const tenant = require('./tenantManager').getTenant(tenantId);
    if (!tenant || tenant.status !== 'active') return res.status(404).json({ error: 'Tenant nao encontrado ou inativo' });
    await startTenantWaSession(tenantId);
    auditSecurityEvent(req, 'whatsapp_connection_start', { tenantId });
    res.json({ success: true, tenantId });
  } catch (err) {
    logger.error({ err }, 'Erro ao iniciar sessão WhatsApp');
    sendRouteError(res, err);
  }
});

app.post('/api/admin/connections/logout', authMiddleware(['admin']), async (req, res) => {
  try {
    const tenantId = parsePositiveInt(req.body.tenantId, 'tenantId');
    if (!req.user.super_admin && tenantId !== Number(req.user.tenant_id)) {
      return res.status(403).json({ error: 'Sem permissão para este tenant' });
    }
    await waManager.logoutSession(tenantId);
    auditSecurityEvent(req, 'whatsapp_connection_logout', { tenantId });
    res.json({ success: true, tenantId });
  } catch (err) {
    logger.error({ err }, 'Erro ao desconectar sessão WhatsApp');
    sendRouteError(res, err);
  }
});

async function handleImportHistory(req, res) {
  if (!requireTenantAdmin(req, res)) return;
  // Importa do WhatsApp DO PRÓPRIO tenant, nunca da sessão global/padrão
  // (senão as conversas de outra empresa entrariam na caixa deste tenant).
  const tenantId = req.user.tenant_id;
  const client = waManagerReady ? waManager.getReadyClient(tenantId) : null;
  if (!client) return res.status(409).json({ error: 'O WhatsApp da sua empresa não está conectado' });

  try {
    auditSecurityEvent(req, 'whatsapp_history_import', { tenantId });
    const started = startHistoryImportInBackground({ retryUnavailableMedia: true, client, tenantId, source: 'manual' });
    res.status(202).json({
      importing: true,
      alreadyRunning: !started,
      message: started
        ? 'Importacao de historico iniciada em segundo plano'
        : 'Importacao de historico ja esta em andamento'
    });
  } catch (err) {
    logger.error({ err }, 'Erro ao importar historico');
    sendInternalError(res);
  }
}

app.post('/api/import-history', tenantAuthMiddleware(['admin']), handleImportHistory);
app.post('/api/admin/import-history', tenantAuthMiddleware(['admin']), handleImportHistory);

app.post('/api/admin/reset-whatsapp', tenantAuthMiddleware(['admin']), async (req, res) => {
  if (!requireTenantAdmin(req, res)) return;
  // Reseta a sessão DO PRÓPRIO tenant. Antes atingia sempre o tenant padrão,
  // então qualquer admin de cliente podia derrubar o WhatsApp da plataforma.
  const tenantId = req.user.tenant_id;
  try {
    if (waManagerReady) {
      await waManager.logoutSession(tenantId);
      await startTenantWaSession(tenantId);
    }
    auditSecurityEvent(req, 'whatsapp_session_reset', { tenantId });
    res.json(getTenantConnectionStatus(tenantId, { includeQr: true }));
  } catch (err) {
    logger.error({ err }, 'Erro ao resetar WhatsApp');
    sendInternalError(res);
  }
});

// ============ WHATSAPP MULTI-TENANT MANAGER ============
const waManager = require('./whatsappManager');
let waManagerReady = false;
let waManagerInitPromise = null;

function clearSyncRuntimeFailures(tenantId) {
  syncRuntimeFailureCounts.delete(importKey(tenantId));
}

// Exceções minificadas vindas de dentro da página do WhatsApp Web (ex.: um
// erro chamado apenas "r") não carregam assinatura reconhecível na mensagem.
// Nesses casos o stack atravessando o puppeteer/whatsapp-web.js é o que
// distingue "contexto do navegador inutilizável" (recicla a sessão) de um bug
// do importador/banco (reciclar não ajudaria).
function isBrowserContextSyncFailure(err) {
  const message = String(err?.message || err || '');
  if (/getChats|fetchMessages|Evaluation failed|Target closed|Protocol error|Session closed|browser.*disconnect|Execution context.*destroy|excedeu\s+\d+ms/i.test(message)) {
    return true;
  }
  return /node_modules[\\/](?:puppeteer|whatsapp-web\.js)|ExecutionContext/.test(String(err?.stack || ''));
}

function recordSyncRuntimeFailure(tenantId, client, err, source) {
  if (!isBrowserContextSyncFailure(err)) {
    return 0;
  }
  const key = importKey(tenantId);
  const previous = syncRuntimeFailureCounts.get(key);
  const now = Date.now();
  const count = previous && now - previous.lastAt < 2 * 60 * 1000
    ? previous.count + 1
    : 1;
  syncRuntimeFailureCounts.set(key, { count, lastAt: now });
  if (count < 3) return count;

  syncRuntimeFailureCounts.delete(key);
  const recoveryScheduled = waManagerReady
    && typeof waManager.reportSessionRuntimeError === 'function'
    && waManager.reportSessionRuntimeError(tenantId, err, client);
  logger.warn(
    { err, tenantId, source, consecutiveFailures: count, recoveryScheduled },
    'Contexto do WhatsApp falhou repetidamente durante sincronização'
  );
  return count;
}

function assertSyncBatchUsable(stats) {
  const attemptedChats = Math.max(0, Number(stats?.totalChats || 0) - Number(stats?.skippedChats || 0));
  if (!attemptedChats || Number(stats?.failedChats || 0) < attemptedChats) return;
  const err = new Error(`fetchMessages falhou nas ${attemptedChats} conversas do lote`);
  err.code = 'WA_SYNC_BATCH_FAILED';
  throw err;
}

// Roda um handler dentro do contexto de banco do tenant (AsyncLocalStorage).
function runInTenantContext(tenantId, fn) {
  const tenantDb = acquireTenantDbLease(tenantId);
  let result;
  try {
    result = db.tenantCtx.run({ db: tenantDb, tenantId }, fn);
  } catch (err) {
    releaseTenantDbLease(tenantId);
    throw err;
  }
  if (result && typeof result.then === 'function') {
    return Promise.resolve(result).finally(() => releaseTenantDbLease(tenantId));
  }
  releaseTenantDbLease(tenantId);
  return result;
}

// Atualiza delivery_status a partir do ack do WhatsApp: 2=entregue, 3+=lido.
// Escrito no banco do tenant (via contexto), nunca no banco global.
function handleMessageAck(msg, ack) {
  try {
    const externalId = getMessageExternalId(msg);
    if (!externalId) return;
    const status = ack >= 3 ? 'read' : ack >= 2 ? 'delivered' : null;
    if (!status) return;
    let result = db.prepare(
      "UPDATE messages SET delivery_status = ? WHERE external_id = ? AND from_type = 'vendor' AND delivery_status != 'read'"
    ).run(status, externalId);
    if (!result.changes && msg?.fromMe) {
      const phone = isImportableChatId(msg.to) ? msg.to : null;
      const conversation = phone ? findOpenConversationByIdentifiers(db, [phone]) : null;
      const messageDate = toSqlDate(msg.timestamp);
      const pending = conversation
        ? findMatchingPendingOutboundMessage(
          conversation.id,
          typeof msg.body === 'string' ? msg.body : '',
          messageDate,
          getWhatsAppMediaType(msg.type)
        )
        : null;
      if (pending) {
        result = db.prepare(`
          UPDATE messages
          SET external_id = ?,
              delivery_status = ?,
              sent_at = COALESCE(sent_at, ?),
              delivery_error = NULL
          WHERE id = ? AND external_id IS NULL
        `).run(externalId, status, messageDate, pending.id);
      }
    }
    if (result.changes) {
      const row = db.prepare('SELECT conversation_id FROM messages WHERE external_id = ?').get(externalId);
      if (row) emitConversationUpdate(row.conversation_id);
    }
  } catch (err) {
    logger.error({ err }, 'Erro ao processar ack de mensagem');
  }
}

function handleMessageEdit(msg, newBody) {
  const externalId = getMessageExternalId(msg);
  const content = typeof newBody === 'string' ? newBody.trim() : '';
  if (!externalId || !content) return false;
  const editedAt = Number(msg?.latestEditSenderTimestampMs) > 0
    ? toSqlDate(Number(msg.latestEditSenderTimestampMs) / 1000)
    : toSqlDate(Date.now() / 1000);
  const result = db.prepare(`
    UPDATE messages
    SET content = ?, edited_at = ?
    WHERE external_id = ?
      AND COALESCE(deleted_for_everyone, 0) = 0
      AND content IS NOT ?
  `).run(content, editedAt, externalId, content);
  const row = db.prepare('SELECT conversation_id FROM messages WHERE external_id = ?').get(externalId);
  if (!row) return false;
  if (result.changes) emitConversationUpdate(row.conversation_id);
  return true;
}

function revokedExternalId(msg, revokedMsg) {
  const direct = getMessageExternalId(revokedMsg);
  if (direct) return direct;
  const protocolKey = msg?.protocolMessageKey;
  // Mesmo motivo de whatsappUtils.js: o nome do campo serializado muda entre
  // builds do WhatsApp Web, entao nao da para ler so `_serialized`.
  return serializedMessageId(protocolKey) || serializedMessageId(protocolKey?.id);
}

function handleMessageRevoke(msg, revokedMsg) {
  const externalId = revokedExternalId(msg, revokedMsg);
  if (!externalId) return false;
  const row = db.prepare('SELECT id, conversation_id FROM messages WHERE external_id = ?').get(externalId);
  if (!row) return false;
  markMessageDeletedForEveryone({ db, messageId: row.id, mediaRoot: MEDIA_ROOT });
  emitConversationUpdate(row.conversation_id);
  return true;
}

async function handleChatArchived(chat, currentState, _previousState, client) {
  const chatId = getChatId(chat);
  if (!chatId) return;
  const identifiers = await resolveWhatsAppIdentifiers(client, chatId, 4000);
  const conversation = findOpenConversationByIdentifiers(db, [chatId, ...identifiers]);
  if (!conversation) return;
  const archived = Boolean(currentState);
  db.prepare(`
    UPDATE conversations
    SET whatsapp_archived = ?,
        archived_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
        archive_sync_state = 'synced',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(archived ? 1 : 0, archived ? 1 : 0, conversation.id);
  linkConversationIdentifiers(db, conversation.id, [chatId, ...identifiers]);
  emitConversationUpdate(conversation.id);
}

// Handlers de mensagem + ack já amarrados ao contexto do tenant.
function tenantSessionHandlers(tenantId) {
  return {
    onMessage: (msg, client, source) => {
      if (!isTenantOperational(tenantId)) return undefined;
      return runInTenantContext(tenantId, () => handleIncomingMessage(msg, {
        client,
        source
      }).catch(err => {
        logger.error({ err, tenantId, source }, 'Erro msg');
        scheduleRecentTenantSync(tenantId, 1000);
      }));
    },
    onAck: (msg, ack) => {
      if (!isTenantOperational(tenantId)) return undefined;
      return runInTenantContext(tenantId, () => handleMessageAck(msg, ack));
    },
    onArchive: (chat, currentState, previousState, client) => {
      if (!isTenantOperational(tenantId)) return undefined;
      return runInTenantContext(tenantId, () => handleChatArchived(chat, currentState, previousState, client)
        .catch(err => logger.error({ err, tenantId }, 'Erro ao sincronizar evento de arquivamento')));
    },
    onMessageEdit: (msg, newBody) => {
      if (!isTenantOperational(tenantId)) return undefined;
      return runInTenantContext(tenantId, () => {
        if (!handleMessageEdit(msg, newBody)) scheduleRecentTenantSync(tenantId, 1000);
      });
    },
    onMessageRevoke: (msg, revokedMsg) => {
      if (!isTenantOperational(tenantId)) return undefined;
      return runInTenantContext(tenantId, () => {
        if (!handleMessageRevoke(msg, revokedMsg)) scheduleRecentTenantSync(tenantId, 1000);
      });
    },
    onSyncNeeded: reason => {
      if (!isTenantOperational(tenantId)) return;
      logger.warn({ tenantId, reason }, 'WhatsApp solicitou reconciliação prioritária');
      scheduleRecentTenantSync(tenantId, 1000);
    }
  };
}

// Lê o proxy configurado nas settings do tenant (se houver)
function getTenantProxy(tenantId) {
  try {
    const { getTenant } = require('./tenantManager');
    const tenant = getTenant(tenantId);
    if (!tenant?.settings) return undefined;
    const settings = typeof tenant.settings === 'string' ? JSON.parse(tenant.settings) : tenant.settings;
    return settings.proxy_server || undefined;
  } catch { return undefined; }
}

// Inicia (ou reusa) a sessão do tenant JÁ com os handlers corretos. Como
// startSession cria a sessão antes de registrar os handlers, evita o bug de
// registrar handler em sessão inexistente (no-op).
async function startTenantWaSession(tenantId) {
  if (!isTenantOperational(tenantId)) {
    const error = new Error('Empresa inativa ou com assinatura indisponível');
    error.statusCode = 402;
    throw error;
  }
  if (!waManagerReady) await initializeWhatsAppManager();
  const tenantDatabase = getTenantDb(tenantId);
  // Após um restart, nenhuma fila anterior continua viva. Portanto até uma
  // linha pending criada milissegundos antes do crash já é ambígua e deve ser
  // sinalizada imediatamente, sem aguardar uma segunda reinicialização.
  const recovered = recoverInterruptedOutboundMessages(tenantDatabase, { staleMinutes: 0 });
  if (recovered) logger.warn({ tenantId, recovered }, 'Outbox interrompido marcado para reconciliacao');
  const proxyServer = getTenantProxy(tenantId);
  return waManager.startSession(tenantId, { ...tenantSessionHandlers(tenantId), proxyServer });
}

function maybeScheduleTenantAutoImport(tenantId) {
  if (!tenantId || !isTenantOperational(tenantId)) return;
  const status = waManagerReady ? waManager.getStatus(tenantId) : null;
  if (!status?.ready) return;
  const key = importKey(tenantId);
  const readyToken = status.lastReadyAt || `${status.lastTransitionAt || ''}:${status.reconnectTotal || 0}`;
  if (tenantReadyTokens.get(key) === readyToken) return;

  tenantReadyTokens.set(key, readyToken);
  const generation = (tenantSyncGenerations.get(key) || 0) + 1;
  tenantSyncGenerations.set(key, generation);

  const previousAutoImport = autoImportTimers.get(key);
  if (previousAutoImport) clearTimeout(previousAutoImport.timer);
  autoImportTimers.delete(key);
  const previousFullReconcile = fullReconcileTimers.get(key);
  if (previousFullReconcile) clearTimeout(previousFullReconcile.timer);
  fullReconcileTimers.delete(key);

  // Todo ready/recovery recebe catch-up imediato. O job busca o Client atual
  // somente na hora de executar, portanto nunca usa uma geração já destruída.
  // Também recupera placeholders recentes que possam ter sobrevivido a um
  // restart entre o evento message_create e a liberação da mídia.
  scheduleRecentMissingMediaRepairs(tenantId);
  scheduleRecentTenantSync(tenantId, 1000);
  scheduleTenantContactsSync(tenantId, CONTACT_SYNC_START_DELAY_MS);
  scheduleAutoHistoryImport({ tenantId, generation });
}

// No boot, restaura sessões de todos os tenants que já estavam conectados
// (têm credenciais salvas e não ficaram apenas aguardando QR), escalonado. Sem isso, após um
// restart do processo só o tenant padrão voltava — os demais ficavam mudos.
async function restoreConnectedSessions() {
  const { listTenants } = require('./tenantManager');
  const defaultTenant = getTenantBySlug('default');
  for (const tenant of listTenants()) {
    if (defaultTenant && tenant.id === defaultTenant.id) continue; // default já sobe no startWhatsAppClient
    try {
      if (!isTenantOperational(tenant.id)) continue;
      if (!(await waManager.hasRestorableSession(tenant.id))) continue;
      await sleep(Number(process.env.WA_RESTORE_STAGGER_MS || 1500));
      startTenantWaSession(tenant.id).catch(err => logger.error({ err, tenantId: tenant.id }, 'Erro ao restaurar sessão'));
    } catch (err) {
      logger.error({ err, tenantId: tenant.id }, 'Erro ao avaliar restauração de sessão');
    }
  }
}

async function initializeWhatsAppManager() {
  if (waManagerReady) return;
  if (waManagerInitPromise) return waManagerInitPromise;
  waManagerInitPromise = (async () => {
    await waManager.init({
      puppeteer: PuppeteerExtra,
      logger,
      maxConcurrent: Number(process.env.WA_MAX_CONCURRENT_SESSIONS || 5),
      onStatusChange: (tenantId) => {
        emitTenantConnectionStatus(tenantId);
        maybeScheduleTenantAutoImport(tenantId);
        const defaultTenant = getTenantBySlug('default');
        if (defaultTenant && Number(defaultTenant.id) === Number(tenantId)) {
          const status = waManager.getStatus(tenantId);
          if (status?.ready) {
            const readyClient = waManager.getReadyClient(tenantId);
            if (readyClient) {
              whatsapp = readyClient;
              markClientReady(readyClient);
            }
          } else {
            whatsapp = null;
            clientReady = false;
            setConnectionStatus(status?.state || status?.status || 'DISCONNECTED', {
              ready: false,
              qr: status?.qr || null,
              error: status?.error || null,
              message: status?.status === 'qr'
                ? 'Aguardando leitura do QR code'
                : 'WhatsApp ainda não está pronto'
            });
          }
        }
      }
    });
    waManagerReady = true;
    logger.info('Gerenciador multi-sessão WhatsApp iniciado');
  })();
  try {
    await waManagerInitPromise;
  } catch (err) {
    waManagerReady = false;
    logger.error({ err }, 'Falha ao iniciar gerenciador multi-sessão');
    throw err;
  } finally {
    waManagerInitPromise = null;
  }
}

async function runHistoryImport({ retryUnavailableMedia = false, client, tenantId } = {}) {
  const normalizedTenantId = Number(tenantId);
  if (!Number.isSafeInteger(normalizedTenantId) || normalizedTenantId <= 0) {
    throw new Error('Tenant obrigatório para importar histórico');
  }
  if (currentTenantId() !== normalizedTenantId) {
    throw new Error('Contexto de tenant divergente na importação de histórico');
  }
  if (!isTenantOperational(normalizedTenantId)) {
    const error = new Error('Empresa inativa ou com assinatura indisponível');
    error.statusCode = 402;
    throw error;
  }
  const key = importKey(tenantId);
  if (importInProgress.get(key)) return lastImportStats.get(key) || { importing: true };

  const targetClient = client;
  if (!targetClient || typeof targetClient.getChats !== 'function') {
    throw new Error('Cliente WhatsApp indisponivel para importar historico');
  }
  if (waManagerReady && waManager.getReadyClient(normalizedTenantId) !== targetClient) {
    throw new Error('Cliente WhatsApp não pertence ao tenant da importação');
  }

  importInProgress.set(key, true);
  emitTenantConnectionStatus(tenantId);
  try {
    // O lock é adquirido antes da espera: duas solicitações manuais que chegam
    // durante a reconciliação recente nunca iniciam dois imports completos.
    const waitDeadline = Date.now() + HISTORY_IMPORT_LOCK_WAIT_MS;
    while (recentSyncRunning.has(key) && Date.now() < waitDeadline) await sleep(250);
    if (recentSyncRunning.has(key)) {
      const err = new Error('A reconciliação recente excedeu o prazo; tente novamente em instantes');
      err.code = 'WA_SYNC_LOCK_TIMEOUT';
      throw err;
    }

    const stats = await importExistingChats({
      whatsapp: targetClient,
      db,
      limit: HISTORY_IMPORT_LIMIT,
      adaptiveBackfill: true,
      maxFetchLimit: FULL_SYNC_MAX_FETCH_LIMIT,
      absoluteMaxFetchLimit: FULL_SYNC_ABSOLUTE_MAX_FETCH_LIMIT,
      getChatsTimeoutMs: GET_CHATS_TIMEOUT_MS,
      chatFetchTimeoutMs: HISTORY_CHAT_FETCH_TIMEOUT_MS,
      mediaRoot: MEDIA_ROOT,
      mediaDownloadTimeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
      profileFetchTimeoutMs: PROFILE_FETCH_TIMEOUT_MS,
      refreshProfiles: retryUnavailableMedia,
      retryUnavailableMedia,
      chatImportDelayMs: CHAT_IMPORT_DELAY_MS,
      tenantId,
      onConversationImported: importedConversationId => scheduleImportConversationUpdate(tenantId, importedConversationId),
      logger: {
        log: message => logger.info(message),
        error: message => logger.error(message)
      }
    });
    assertSyncBatchUsable(stats);
    const completedStats = { ...stats, completedAt: new Date().toISOString() };
    lastImportStats.set(key, completedStats);
    lastSyncErrors.delete(key);
    clearSyncRuntimeFailures(tenantId);
    emitConversationUpdate(null);
    return completedStats;
  } catch (err) {
    recordSyncRuntimeFailure(tenantId, targetClient, err, 'history');
    lastSyncErrors.set(key, {
      source: 'history',
      message: String(err.message || err),
      at: new Date().toISOString()
    });
    throw err;
  } finally {
    importInProgress.set(key, false);
    emitTenantConnectionStatus(tenantId);
  }
}

function startHistoryImportInBackground({ retryUnavailableMedia = false, client, tenantId, source = 'auto' } = {}) {
  if (!tenantId || !isTenantOperational(tenantId)) return false;
  const key = importKey(tenantId);
  if (importInProgress.get(key)) return false;

  emitHistoryImportStatus(tenantId, { status: 'started', source });

  const runImport = () => runHistoryImport({ retryUnavailableMedia, client, tenantId })
    .then(stats => {
      logger.info({ tenantId, source, stats }, 'Importacao de historico concluida em background');
      emitHistoryImportStatus(tenantId, { status: 'completed', source, stats });
    })
    .catch(err => {
      logger.error({ err, tenantId, source }, 'Erro ao importar historico em background');
      emitHistoryImportStatus(tenantId, { status: 'failed', source, error: err.message });
    });

  runInTenantContext(tenantId, runImport);
  return true;
}

function emitHistoryImportStatus(tenantId, payload) {
  const targetTenantId = tenantId || currentTenantId();
  if (!targetTenantId || !isTenantOperational(targetTenantId)) return;
  io.to(tenantOperationalRoom(targetTenantId)).emit('history:import', payload);
}

function scheduleTenantContactsSync(tenantId, delayMs = CONTACT_SYNC_INTERVAL_MS) {
  if (!tenantId || CONTACT_SYNC_INTERVAL_MS <= 0 || !isTenantOperational(tenantId)) return;
  const key = importKey(tenantId);
  const normalizedDelay = Math.max(1000, delayMs);
  const dueAt = Date.now() + normalizedDelay;
  const existing = contactSyncTimers.get(key);
  if (existing && existing.dueAt <= dueAt) return;
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const scheduled = contactSyncTimers.get(key);
    if (!scheduled || scheduled.timer !== timer) return;
    contactSyncTimers.delete(key);
    if (!isTenantOperational(key)) return;
    runTenantContactsSync(key).finally(() => {
      const status = waManagerReady ? waManager.getStatus(key) : null;
      if (status?.ready) scheduleTenantContactsSync(key, CONTACT_SYNC_INTERVAL_MS);
    });
  }, normalizedDelay);
  timer.unref?.();
  contactSyncTimers.set(key, { timer, dueAt });
}

async function runTenantContactsSync(tenantId, {
  client: suppliedClient = null,
  throwOnError = false,
  source = 'periodic'
} = {}) {
  const key = importKey(tenantId);
  if (!isTenantOperational(key)) return { started: false, reason: 'not_operational' };
  const client = suppliedClient || (waManagerReady ? waManager.getReadyClient(key) : null);
  if (!client) return { started: false, reason: 'client_unavailable' };

  const activeSync = contactSyncRunning.get(key);
  if (activeSync?.client === client) {
    return {
      started: false,
      reason: activeSync.timedOut ? 'quarantined' : 'already_running'
    };
  }

  const token = Symbol(`contact-sync:${key}`);
  contactSyncRunning.set(key, { token, client, timedOut: false });
  contactSyncLastStartedAt.set(key, Date.now());
  let releaseImmediately = true;
  try {
    const stats = await runInTenantContext(key, () => syncContacts(client, db, { timeoutMs: 30000 }));
    logger.info({ tenantId: key, source, stats }, 'Contatos do WhatsApp sincronizados');
    if (isTenantOperational(key)) io.to(tenantOperationalRoom(key)).emit('contacts:updated', stats);
    return { started: true, stats };
  } catch (err) {
    if (err.code === 'OPERATION_TIMEOUT' && err.pendingOperation) {
      releaseImmediately = false;
      const current = contactSyncRunning.get(key);
      if (current?.token === token) current.timedOut = true;
      err.pendingOperation.finally(() => {
        if (contactSyncRunning.get(key)?.token === token) contactSyncRunning.delete(key);
      }).catch(() => {});
    }
    logger.warn({ err, tenantId: key, source }, 'Falha na sincronização de contatos');
    if (throwOnError) throw err;
    return { started: true, error: err };
  } finally {
    if (releaseImmediately && contactSyncRunning.get(key)?.token === token) {
      contactSyncRunning.delete(key);
    }
  }
}

function scheduleRecentTenantSync(tenantId, delayMs = RECENT_SYNC_INTERVAL_MS) {
  if (!tenantId || RECENT_SYNC_INTERVAL_MS <= 0 || !isTenantOperational(tenantId)) return;
  const key = importKey(tenantId);
  if (recentSyncRunning.has(key)) {
    recentSyncRerunRequested.add(key);
    return;
  }
  const normalizedDelay = Math.max(1000, delayMs);
  const dueAt = Date.now() + normalizedDelay;
  const existing = recentSyncTimers.get(key);
  if (existing && existing.dueAt <= dueAt) return;
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const scheduled = recentSyncTimers.get(key);
    if (!scheduled || scheduled.timer !== timer) return;
    recentSyncTimers.delete(key);
    if (!isTenantOperational(tenantId)) return;
    runRecentTenantSync(tenantId).finally(() => {
      const status = waManagerReady ? waManager.getStatus(tenantId) : null;
      const rerun = recentSyncRerunRequested.delete(key);
      if (status?.ready) scheduleRecentTenantSync(tenantId, rerun ? 1000 : RECENT_SYNC_INTERVAL_MS);
    });
  }, normalizedDelay);
  timer.unref?.();
  recentSyncTimers.set(key, { timer, dueAt });
}

async function runRecentTenantSync(tenantId) {
  if (!isTenantOperational(tenantId)) return;
  const key = importKey(tenantId);
  if (recentSyncRunning.has(key)) {
    recentSyncRerunRequested.add(key);
    return;
  }
  if (importInProgress.get(key)) return;
  const client = waManagerReady ? waManager.getReadyClient(tenantId) : null;
  if (!client || typeof client.getChats !== 'function') return;

  recentSyncRunning.add(key);
  try {
    await runInTenantContext(tenantId, async () => {
      const stats = await importExistingChats({
        whatsapp: client,
        db,
        limit: RECENT_SYNC_MESSAGE_LIMIT,
        maxChats: RECENT_SYNC_CHAT_LIMIT,
        adaptiveBackfill: true,
        maxFetchLimit: RECENT_SYNC_MAX_FETCH_LIMIT,
        absoluteMaxFetchLimit: RECENT_SYNC_MAX_FETCH_LIMIT,
        resumePersistentGap: false,
        getChatsTimeoutMs: GET_CHATS_TIMEOUT_MS,
        skipMediaDownload: true,
        mediaRoot: MEDIA_ROOT,
        mediaDownloadTimeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
        profileFetchTimeoutMs: Math.min(PROFILE_FETCH_TIMEOUT_MS, 1000),
        chatImportDelayMs: 0,
        tenantId,
        onConversationImported: importedConversationId => scheduleImportConversationUpdate(tenantId, importedConversationId),
        logger: {
          log: () => {},
          error: message => logger.warn({ tenantId, message }, 'Erro na sincronizacao recente')
        }
      });
      assertSyncBatchUsable(stats);
      if (stats.messagesImported || stats.messagesUpdated || stats.newConversations) {
        logger.info({ tenantId, stats }, 'Sincronizacao recente atualizou conversas');
        scheduleImportConversationUpdate(tenantId);
      }
      lastRecentSyncStats.set(key, { ...stats, completedAt: new Date().toISOString() });
      lastSyncErrors.delete(key);
      clearSyncRuntimeFailures(tenantId);
    });
  } catch (err) {
    recordSyncRuntimeFailure(tenantId, client, err, 'recent');
    lastSyncErrors.set(key, {
      source: 'recent',
      message: String(err.message || err),
      at: new Date().toISOString()
    });
    logger.warn({ err, tenantId }, 'Falha na sincronizacao recente do WhatsApp');
  } finally {
    recentSyncRunning.delete(key);
    emitTenantConnectionStatus(tenantId);
  }
}

function scheduleFullTenantReconcile(tenantId, generation, delayMs = FULL_RECONCILE_INTERVAL_MS) {
  if (!tenantId || FULL_RECONCILE_INTERVAL_MS <= 0 || !isTenantOperational(tenantId)) return;
  const key = importKey(tenantId);
  const normalizedDelay = Math.max(1000, delayMs);
  const dueAt = Date.now() + normalizedDelay;
  const existing = fullReconcileTimers.get(key);
  if (existing && existing.generation === generation && existing.dueAt <= dueAt) return;
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const scheduled = fullReconcileTimers.get(key);
    if (!scheduled || scheduled.timer !== timer) return;
    fullReconcileTimers.delete(key);
    if (tenantSyncGenerations.get(key) !== generation) return;
    if (!isTenantOperational(tenantId)) return;
    const status = waManagerReady ? waManager.getStatus(tenantId) : null;
    if (!status?.ready) return;
    scheduleAutoHistoryImport({ tenantId, generation, attempt: 1, delayMs: 1000 });
  }, normalizedDelay);
  timer.unref?.();
  fullReconcileTimers.set(key, { timer, dueAt, generation });
}

function scheduleAutoHistoryImport({
  tenantId,
  generation = tenantSyncGenerations.get(importKey(tenantId)) || 0,
  attempt = 1,
  delayMs = AUTO_IMPORT_DELAY_MS * attempt
}) {
  if (!tenantId || !isTenantOperational(tenantId)) return;
  const key = importKey(tenantId);
  const existing = autoImportTimers.get(key);
  if (existing) clearTimeout(existing.timer);
  const normalizedDelay = Math.max(1000, delayMs);
  const timer = setTimeout(() => {
    const scheduled = autoImportTimers.get(key);
    if (!scheduled || scheduled.timer !== timer) return;
    autoImportTimers.delete(key);
    if (tenantSyncGenerations.get(key) !== generation) return;
    if (!isTenantOperational(tenantId)) return;
    const currentClient = waManagerReady ? waManager.getReadyClient(tenantId) : null;
    if (!currentClient) return;

    runInTenantContext(tenantId, () => runHistoryImport({ client: currentClient, tenantId }))
      .then(stats => {
        if (tenantSyncGenerations.get(key) !== generation) return;
        logger.info({ tenantId, generation, stats }, 'Reconciliação integral do WhatsApp concluída');
        scheduleFullTenantReconcile(tenantId, generation);
      })
      .catch(err => {
        if (tenantSyncGenerations.get(key) !== generation) return;
        const transientWhatsAppWebError = /getChats|Store|undefined|Target closed|Protocol error|Session closed|timeout|excedeu/i
          .test(String(err.message || err));
        const status = waManagerReady ? waManager.getStatus(tenantId) : null;
        if (attempt < AUTO_IMPORT_MAX_ATTEMPTS && transientWhatsAppWebError && status?.ready) {
          logger.warn(
            { err, tenantId, generation, attempt, delayMs: normalizedDelay },
            'WhatsApp Web ainda nao liberou chats; reagendando reconciliação integral'
          );
          scheduleAutoHistoryImport({ tenantId, generation, attempt: attempt + 1 });
          return;
        }
        logger.error({ err, tenantId, generation, attempts: attempt }, 'Erro na reconciliação integral do WhatsApp');
        if (status?.ready) scheduleFullTenantReconcile(tenantId, generation, Math.min(FULL_RECONCILE_INTERVAL_MS, 60000));
      });
  }, normalizedDelay);
  timer.unref?.();
  autoImportTimers.set(key, { timer, generation, attempt, dueAt: Date.now() + normalizedDelay });
}

function markClientReady(client = whatsapp) {
  if (client && client !== whatsapp) return;
  if (clientReady) return;
  setConnectionStatus('READY', {
    ready: true,
    qr: null,
    error: null,
    message: 'WhatsApp conectado e pronto para uso'
  });
  logger.info('WhatsApp conectado');

  const defaultTenant = getTenantBySlug('default');
  if (defaultTenant) maybeScheduleTenantAutoImport(defaultTenant.id);
}

function findMatchingPendingOutboundMessage(conversationId, body, messageDate, mediaType = null) {
  const candidates = db.prepare(`
    SELECT id, content, media_type, created_at
    FROM messages
    WHERE conversation_id = ?
      AND from_type = 'vendor'
      AND external_id IS NULL
      AND delivery_status IN ('pending', 'sent', 'unknown')
      AND created_at BETWEEN datetime(?, '-10 minutes') AND datetime(?, '+1 minute')
    ORDER BY created_at ASC, id ASC
    LIMIT 30
  `).all(conversationId, messageDate, messageDate);
  const normalizedBody = String(body || '').trim();
  const textMatch = candidates.find(candidate => {
    const content = String(candidate.content || '').trim();
    return content && (normalizedBody === content || normalizedBody.endsWith(`\n${content}`));
  });
  if (textMatch) return textMatch;
  if (!mediaType) return null;
  // Ecos de áudio/foto/vídeo normalmente não possuem corpo. O arquivo já foi
  // preparado antes do sendMessage(), portanto media_type é a assinatura mais
  // segura disponível sem baixar a mesma mídia uma segunda vez. A fila envia em
  // ordem; por isso o pendente mais antigo do mesmo tipo é o correspondente.
  return candidates.find(candidate => candidate.media_type === mediaType) || null;
}

const incomingMessageInFlight = new Set();
const conversationResolutionInFlight = new Map();

function isRealtimeMessageTimestamp(timestampSeconds) {
  const timestampMs = Number(timestampSeconds) * 1000;
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return true;
  const ageMs = Date.now() - timestampMs;
  return ageMs >= -60 * 1000 && ageMs <= REALTIME_MESSAGE_MAX_AGE_MS;
}

async function resolveIncomingConversation({ phone, contactName, messageDate, client, tenantId }) {
  let conversation = findOpenConversationByIdentifiers(db, [phone]);
  if (conversation) {
    linkConversationIdentifiers(db, conversation.id, [phone]);
    return conversation;
  }

  const resolutionKey = `${tenantId || 0}:${phone}`;
  if (conversationResolutionInFlight.has(resolutionKey)) {
    return conversationResolutionInFlight.get(resolutionKey);
  }

  const resolution = (async () => {
    const identifiers = await resolveWhatsAppIdentifiers(
      client,
      phone,
      PROFILE_FETCH_TIMEOUT_MS
    );
    let resolvedConversation = findOpenConversationByIdentifiers(db, identifiers);
    if (!resolvedConversation) {
      const result = db.prepare(`
        INSERT INTO conversations (phone, contact_name, last_activity_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(phone, contactName, messageDate, messageDate, messageDate);
      resolvedConversation = db.prepare('SELECT * FROM conversations WHERE id = ?')
        .get(result.lastInsertRowid);
      logger.info({
        conversationId: resolvedConversation.id,
        contactName,
        phone,
        identifiers
      }, 'Nova conversa');
    }
    linkConversationIdentifiers(db, resolvedConversation.id, identifiers);
    return resolvedConversation;
  })();

  conversationResolutionInFlight.set(resolutionKey, resolution);
  try {
    return await resolution;
  } finally {
    conversationResolutionInFlight.delete(resolutionKey);
  }
}

async function getIncomingQuotedMessageId(msg) {
  if (!msg?.hasQuotedMsg) return null;
  try {
    let quotedExternalId = msg._data?.context_info?.stanzaId;
    if (!quotedExternalId && typeof msg.getQuotedMessage === 'function') {
      const quotedMsg = await withTimeout(
        msg.getQuotedMessage(),
        PROFILE_FETCH_TIMEOUT_MS,
        'getQuotedMessage'
      );
      quotedExternalId = getMessageExternalId(quotedMsg);
    }
    if (!quotedExternalId) return null;
    return db.prepare('SELECT id FROM messages WHERE external_id = ?').get(quotedExternalId)?.id || null;
  } catch (err) {
    logger.warn({ err }, 'Erro ao extrair mensagem citada');
    return null;
  }
}

async function getIncomingProfile(msg, phone, client) {
  let profileChat = {
    id: { _serialized: phone },
    name: msg?._data?.notifyName,
    isGroup: phone.endsWith('@g.us')
  };
  if (typeof msg?.getChat === 'function') {
    try {
      const loadedChat = await withTimeout(msg.getChat(), PROFILE_FETCH_TIMEOUT_MS, 'getChat');
      if (loadedChat) profileChat = loadedChat;
    } catch {}
  }
  return getConversationProfile({
    whatsapp: client,
    chat: profileChat,
    chatId: phone,
    timeoutMs: PROFILE_FETCH_TIMEOUT_MS
  });
}

async function getIncomingParticipantInfo(msg, client, participantId) {
  if (!participantId) return null;
  let contact = null;
  if (typeof msg?.getContact === 'function') {
    try {
      contact = await withTimeout(msg.getContact(), PROFILE_FETCH_TIMEOUT_MS, 'getParticipantContact');
    } catch {}
  }
  if (!contact && typeof client?.getContactById === 'function') {
    try {
      contact = await withTimeout(client.getContactById(participantId), PROFILE_FETCH_TIMEOUT_MS, 'getParticipantById');
    } catch {}
  }
  const phone = contactPhone(contact, participantId)
    || (participantId.endsWith('@c.us') ? participantId.split('@')[0].replace(/\D/g, '') : null);
  const name = contactDisplayName(contact)
    || msg?._data?.notifyName
    || phone
    || participantId.replace(/@(c\.us|lid)$/i, '');
  return { participantId, phone, name };
}

async function downloadIncomingMedia(msg, {
  externalId,
  messageId,
  tenantId,
  client,
  attempts = REALTIME_MEDIA_DOWNLOAD_ATTEMPTS
}) {
  if (!hasPotentialMedia(msg) || typeof msg?.downloadMedia !== 'function') return null;
  try {
    // O próprio Chromium materializa ArrayBuffer + base64 antes de devolver a
    // mídia ao Node. Quando o WhatsApp informa o tamanho, recuse antes dessa
    // alocação para que um documento gigante não derrube todas as empresas.
    assertKnownInboundMediaSize(msg);
    if (MEDIA_DOWNLOAD_JITTER_MS > 0) {
      await sleep(Math.round(Math.random() * MEDIA_DOWNLOAD_JITTER_MS));
    }
    return await inboundMediaLimiter.run(tenantId, async () => {
      const result = await downloadRealtimeMediaWithRetry({
        message: msg,
        client,
        externalId,
        attempts,
        baseDelayMs: REALTIME_MEDIA_RETRY_BASE_DELAY_MS,
        downloadTimeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
        lookupTimeoutMs: Math.min(PROFILE_FETCH_TIMEOUT_MS, 5000)
      });
      if (!result.media) {
        if (result.lastError) {
          logger.warn(
            { err: result.lastError, externalId, messageId, attempts: result.attempts },
            'Mídia recém-chegada ainda não disponível; reparo direcionado agendado'
          );
        }
        return null;
      }
      return saveMessageMedia({
        messageId: externalId || `in-${messageId}`,
        namespace: tenantId,
        media: result.media,
        messageType: result.message?.type || msg.type,
        mediaRoot: MEDIA_ROOT,
        publicBasePath: '/media'
      });
    });
  } catch (err) {
    if (err?.code === 'MEDIA_TOO_LARGE') {
      const mediaType = getWhatsAppMediaType(msg.type);
      db.prepare(`
        UPDATE messages
        SET media_unavailable = 1,
            content = CASE
              WHEN content = '(mídia)' THEN ?
              ELSE content
            END
        WHERE id = ?
          AND media_url IS NULL
      `).run(unavailableMediaContent(mediaType), messageId);
      logger.warn({ externalId, messageId, tenantId }, 'Mídia recusada antes do download por exceder o limite');
      return { permanentlyUnavailable: true };
    }
    // Mantém o registro pendente para o reparo direcionado abaixo. Uma falha
    // transitória nunca é gravada como ausência definitiva.
    logger.warn({ err, externalId, messageId }, 'Mídia recebida pendente de nova tentativa');
    return null;
  }
}

function isMediaPlaceholderContent(value) {
  const content = String(value || '').trim();
  return content === '(mídia)' || /^\(.+ indisponível\)$/i.test(content);
}

function materializeDownloadedMedia({ messageId, body = '', messageType = null, mediaFields }) {
  if (!mediaFields?.media_url) return null;
  const removeIfUnreferenced = () => {
    const referenced = db.prepare('SELECT 1 FROM messages WHERE media_url = ? LIMIT 1')
      .get(mediaFields.media_url);
    if (!referenced) {
      removeStoredTenantMediaSync({
        mediaUrl: mediaFields.media_url,
        mediaRoot: MEDIA_ROOT
      });
    }
  };
  const current = db.prepare(`
    SELECT id, conversation_id, content, media_url, deleted_for_everyone
    FROM messages
    WHERE id = ?
  `).get(messageId);
  if (!current || current.media_url || Number(current.deleted_for_everyone) === 1) {
    removeIfUnreferenced();
    return null;
  }
  const normalizedBody = String(body || '').trim();
  const nextContent = isMediaPlaceholderContent(current.content)
    ? normalizedBody
    : current.content;
  const updated = db.prepare(`
    UPDATE messages
    SET content = ?,
        media_type = COALESCE(?, media_type),
        media_mimetype = ?,
        media_filename = ?,
        media_url = ?,
        media_size = ?,
        media_sha256 = ?,
        media_unavailable = 0
    WHERE id = ?
      AND media_url IS NULL
      AND COALESCE(deleted_for_everyone, 0) = 0
  `).run(
    nextContent,
    mediaFields.media_type || messageType,
    mediaFields.media_mimetype || null,
    mediaFields.media_filename || null,
    mediaFields.media_url,
    mediaFields.media_size || null,
    mediaFields.media_sha256 || null,
    messageId
  );
  if (!updated.changes) removeIfUnreferenced();
  return updated.changes ? current : null;
}

function realtimeMediaRepairDelayMs(attempt) {
  const delays = [2000, 10000, 30000, 120000, 300000];
  return delays[Math.min(Math.max(Number(attempt) - 1, 0), delays.length - 1)];
}

function scheduleRealtimeMediaRepair(tenantId, messageId, attempt = 1, delayMs = null) {
  const normalizedTenantId = Number(tenantId);
  const normalizedMessageId = Number(messageId);
  const normalizedAttempt = Number(attempt);
  if (!normalizedTenantId || !normalizedMessageId || !isTenantOperational(normalizedTenantId)) return false;
  if (!Number.isSafeInteger(normalizedAttempt)
      || normalizedAttempt < 1
      || normalizedAttempt > REALTIME_MEDIA_REPAIR_MAX_ATTEMPTS) return false;
  const key = `${normalizedTenantId}:${normalizedMessageId}`;
  if (realtimeMediaRepairTimers.has(key)) return false;
  const waitMs = Math.max(0, delayMs == null ? realtimeMediaRepairDelayMs(normalizedAttempt) : Number(delayMs) || 0);
  const timer = setTimeout(() => {
    const scheduled = realtimeMediaRepairTimers.get(key);
    if (!scheduled || scheduled.timer !== timer) return;
    realtimeMediaRepairTimers.delete(key);
    if (!isTenantOperational(normalizedTenantId)) return;
    runInTenantContext(normalizedTenantId, () => repairRealtimeMessageMedia({
      tenantId: normalizedTenantId,
      messageId: normalizedMessageId,
      attempt: normalizedAttempt
    })).catch(err => {
      logger.warn(
        { err, tenantId: normalizedTenantId, messageId: normalizedMessageId, attempt: normalizedAttempt },
        'Falha no reparo direcionado de mídia'
      );
      scheduleRealtimeMediaRepair(normalizedTenantId, normalizedMessageId, normalizedAttempt + 1);
    });
  }, waitMs);
  timer.unref?.();
  realtimeMediaRepairTimers.set(key, { timer, attempt: normalizedAttempt, dueAt: Date.now() + waitMs });
  return true;
}

async function repairRealtimeMessageMedia({ tenantId, messageId, attempt }) {
  if (!isTenantOperational(tenantId)) return false;
  const stored = db.prepare(`
    SELECT id, conversation_id, external_id, content, media_type, media_url, deleted_for_everyone
    FROM messages
    WHERE id = ?
  `).get(messageId);
  if (!stored || stored.media_url || Number(stored.deleted_for_everyone) === 1 || !stored.media_type) return true;

  const client = waManagerReady ? waManager.getReadyClient(tenantId) : null;
  if (!client || !stored.external_id || typeof client.getMessageById !== 'function') {
    scheduleRealtimeMediaRepair(tenantId, messageId, attempt + 1);
    return false;
  }

  let liveMessage = null;
  try {
    liveMessage = await withTimeout(
      () => client.getMessageById(stored.external_id),
      Math.min(CONVERSATION_SYNC_TIMEOUT_MS, 10000),
      'getMessageById para reparo de mídia'
    );
  } catch (err) {
    logger.debug({ err, tenantId, messageId, attempt }, 'Mensagem ainda não disponível para reparo de mídia');
  }
  if (!liveMessage) {
    scheduleRealtimeMediaRepair(tenantId, messageId, attempt + 1);
    return false;
  }

  const mediaFields = await downloadIncomingMedia(liveMessage, {
    externalId: stored.external_id,
    messageId,
    tenantId,
    client
  });
  const materialized = materializeDownloadedMedia({
    messageId,
    body: typeof liveMessage.body === 'string' ? liveMessage.body : '',
    messageType: liveMessage.type || stored.media_type,
    mediaFields
  });
  if (materialized) {
    logger.info({ tenantId, messageId, attempt }, 'Mídia recém-chegada materializada pelo reparo direcionado');
    emitConversationUpdate(materialized.conversation_id);
    return true;
  }
  if (mediaFields?.permanentlyUnavailable) {
    emitConversationUpdate(stored.conversation_id);
    return true;
  }

  const alreadyMaterialized = db.prepare('SELECT media_url FROM messages WHERE id = ?').get(messageId)?.media_url;
  if (alreadyMaterialized) return true;
  scheduleRealtimeMediaRepair(tenantId, messageId, attempt + 1);
  return false;
}

function scheduleRecentMissingMediaRepairs(tenantId) {
  const normalizedTenantId = Number(tenantId);
  if (!normalizedTenantId || !isTenantOperational(normalizedTenantId)) return;
  runInTenantContext(normalizedTenantId, () => {
    const lookbackHours = Math.max(1, Math.trunc(REALTIME_MEDIA_REPAIR_LOOKBACK_HOURS) || 24);
    const batchLimit = Math.max(1, Math.min(500, Math.trunc(REALTIME_MEDIA_REPAIR_BATCH_LIMIT) || 100));
    const rows = db.prepare(`
      SELECT id
      FROM messages
      WHERE media_type IN ('sticker', 'image', 'audio', 'video', 'document')
        AND media_url IS NULL
        AND COALESCE(media_unavailable, 0) = 0
        AND deleted_for_everyone = 0
        AND created_at >= datetime('now', ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(`-${lookbackHours} hours`, batchLimit);
    rows.forEach((row, index) => scheduleRealtimeMediaRepair(
      normalizedTenantId,
      row.id,
      1,
      1000 + (index * 100)
    ));
  });
}

async function enrichIncomingMessage({
  msg,
  phone,
  client,
  tenantId,
  messageId,
  body,
  participantId,
  quickContactName
}) {
  const currentMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!currentMessage) return;
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(currentMessage.conversation_id);
  if (!conv) return;

  const [profile, quotedMessageId, mediaFields, participantInfo] = await Promise.all([
    getIncomingProfile(msg, phone, client).catch(() => null),
    getIncomingQuotedMessageId(msg),
    currentMessage.media_url
      ? Promise.resolve(null)
      : downloadIncomingMedia(msg, {
          externalId: currentMessage.external_id,
          messageId,
          tenantId,
          client,
          // A fila de enriquecimento não fica presa em vários timeouts. Se o
          // primeiro download ainda não estiver pronto, o timer direcionado
          // assume as tentativas com backoff fora da fila compartilhada.
          attempts: 1
        }),
    getIncomingParticipantInfo(msg, client, participantId)
  ]);

  let enrichmentChanged = false;
  if (mediaFields?.media_url) {
    const materialized = materializeDownloadedMedia({
      messageId,
      body,
      messageType: getWhatsAppMediaType(msg.type),
      mediaFields
    });
    enrichmentChanged ||= Boolean(materialized);
  } else if (mediaFields?.permanentlyUnavailable) {
    enrichmentChanged = true;
  } else if (!mediaFields?.permanentlyUnavailable
      && !currentMessage.media_url
      && hasPotentialMedia(msg)) {
    // Se o evento chegou antes de a mídia ficar pronta, não dependemos da
    // varredura integral (15 min): buscamos somente esta mensagem com backoff.
    scheduleRealtimeMediaRepair(tenantId, messageId);
  }
  if (quotedMessageId && !currentMessage.quoted_message_id) {
    const updated = db.prepare(`
      UPDATE messages
      SET quoted_message_id = ?
      WHERE id = ? AND quoted_message_id IS NULL
    `).run(quotedMessageId, messageId);
    enrichmentChanged ||= Boolean(updated.changes);
  }
  if (participantInfo && (
    participantInfo.name !== currentMessage.participant_name
    || participantInfo.phone !== currentMessage.participant_phone
    || participantInfo.participantId !== currentMessage.participant_id
  )) {
    const updated = db.prepare(`
      UPDATE messages
      SET participant_id = ?, participant_phone = ?, participant_name = ?
      WHERE id = ?
    `).run(
      participantInfo.participantId,
      participantInfo.phone,
      participantInfo.name,
      messageId
    );
    enrichmentChanged ||= Boolean(updated.changes);
  }
  if (profile) {
    const profileName = profile.contactName || quickContactName;
    const enrichedName = shouldReplaceDisplayName(conv.contact_name, profileName, phone)
      ? profileName
      : conv.contact_name;
    if (enrichedName !== conv.contact_name
        || (profile.profilePicUrl && profile.profilePicUrl !== conv.profile_pic_url)) {
      const updated = db.prepare(`
        UPDATE conversations
        SET contact_name = ?,
            profile_pic_url = COALESCE(?, profile_pic_url),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(enrichedName, profile.profilePicUrl, conv.id);
      enrichmentChanged ||= Boolean(updated.changes);
    }
  }
  if (enrichmentChanged) emitConversationUpdate(conv.id);
}

async function handleIncomingMessage(msg, { client, source = 'message' } = {}) {
  if (!shouldProcessMessageEvent(msg, source)) return;

  const phone = msg.fromMe && isImportableChatId(msg.to) ? msg.to : msg.from;
  if (!isImportableChatId(phone)) return;

  const tenantId = currentTenantId();
  const owningSession = tenantId && waManagerReady ? waManager.getSession(tenantId) : null;
  if (!tenantId || !client || owningSession?.client !== client) {
    logger.error({ tenantId, source }, 'Evento WhatsApp recusado por contexto ou cliente divergente');
    return;
  }
  const externalId = getMessageExternalId(msg);
  if (!externalId) {
    logger.warn({ tenantId, source }, 'Evento WhatsApp sem ID externo; reconciliação priorizada');
    scheduleRecentTenantSync(tenantId, 1000);
    return;
  }
  const inFlightKey = externalId ? `${tenantId || 0}:${externalId}` : null;
  if (inFlightKey && incomingMessageInFlight.has(inFlightKey)) return;
  if (inFlightKey) incomingMessageInFlight.add(inFlightKey);

  try {
    const body = typeof msg.body === 'string' ? msg.body.trim() : '';
    const content = body || getMessageContent(msg);
    if (!content) return;
    const messageDate = toSqlDate(msg.timestamp);
    const quickContactName = msg._data?.notifyName || getDisplayName({}, phone);
    const isGroup = phone.endsWith('@g.us');
    const participantId = isGroup && !msg.fromMe
      ? getChatId(msg.author || msg._data?.author)
      : null;
    const quickParticipantPhone = participantId?.endsWith('@c.us')
      ? participantId.split('@')[0].replace(/\D/g, '')
      : null;
    const quickParticipantName = participantId
      ? (msg._data?.notifyName || quickParticipantPhone || participantId.replace(/@(c\.us|lid)$/i, ''))
      : null;

    let existingMessage = externalId
      ? db.prepare('SELECT * FROM messages WHERE external_id = ?').get(externalId)
      : null;
    let conv = existingMessage
      ? db.prepare('SELECT * FROM conversations WHERE id = ?').get(existingMessage.conversation_id)
      : null;
    if (!conv) {
      conv = await resolveIncomingConversation({
        phone,
        contactName: quickContactName,
        messageDate,
        client,
        tenantId
      });
    }

    if (msg.fromMe && externalId && !existingMessage) {
      const matchingPending = findMatchingPendingOutboundMessage(
        conv.id,
        body,
        messageDate,
        getWhatsAppMediaType(msg.type)
      );
      if (matchingPending) {
        db.transaction(() => {
          db.prepare(`
            UPDATE messages
            SET external_id = ?,
                delivery_status = 'sent',
                sent_at = ?,
                created_at = ?
            WHERE id = ?
          `).run(externalId, messageDate, messageDate, matchingPending.id);
          db.prepare(`
            UPDATE conversations
            SET last_activity_at = CASE
                  WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ?
                  ELSE last_activity_at
                END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(messageDate, messageDate, conv.id);
        })();
        emitNewMessage(conv.id, matchingPending.id);
        return;
      }
    }

    let inserted = false;
    let messageId = existingMessage?.id || null;
    const nextContactName = shouldReplaceDisplayName(conv.contact_name, quickContactName, phone)
      ? quickContactName
      : conv.contact_name;

    // Cria o watermark pessoal ANTES de inserir uma nova mensagem recebida.
    // Sem isso, o primeiro carregamento da fila após a chegada semeia o estado
    // já na mensagem nova e a bolinha verde some sem o usuário tê-la lido.
    if (!msg.fromMe && !messageId) {
      const previousLatest = db.prepare(`
        SELECT id, created_at
        FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(conv.id);
      for (const visibleUser of visibleUsersForConversation(conv)) {
        db.prepare(`
          INSERT OR IGNORE INTO conversation_user_state (
            conversation_id, user_role, user_id,
            last_read_message_id, last_read_message_at, last_read_at, marked_unread
          )
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 0)
        `).run(
          conv.id,
          visibleUser.role,
          visibleUser.id,
          previousLatest?.id || null,
          previousLatest?.created_at || null
        );
      }
    }

    db.transaction(() => {
      if (!messageId) {
        const result = db.prepare(`
          INSERT OR IGNORE INTO messages (
            conversation_id,
            external_id,
            from_type,
            content,
            media_type,
            participant_id,
            participant_phone,
            participant_name,
            media_unavailable,
            delivery_status,
            sent_at,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        `).run(
          conv.id,
          externalId,
          msg.fromMe ? 'vendor' : 'client',
          content,
          getWhatsAppMediaType(msg.type),
          participantId,
          quickParticipantPhone,
          quickParticipantName,
          msg.fromMe ? 'sent' : 'received',
          msg.fromMe ? messageDate : null,
          messageDate
        );
        inserted = Boolean(result.changes);
        messageId = inserted
          ? result.lastInsertRowid
          : db.prepare('SELECT id FROM messages WHERE external_id = ?').get(externalId)?.id || null;
      }
      db.prepare(`
        UPDATE conversations
        SET contact_name = ?,
            is_group = CASE WHEN ? = 1 THEN 1 ELSE is_group END,
            last_activity_at = CASE
              WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ?
              ELSE last_activity_at
            END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nextContactName, isGroup ? 1 : 0, messageDate, messageDate, conv.id);
    })();

    if (!messageId) return;
    if (inserted) {
      if (isRealtimeMessageTimestamp(msg.timestamp)) {
        emitNewMessage(conv.id, messageId);
      } else {
        // Eventos represados após reconnect são reconciliação, não dezenas de
        // notificações em tempo real. Um único refresh agrupado atualiza a UI.
        scheduleImportConversationUpdate(tenantId, conv.id);
      }
    }

    if (conv.assigned_to) {
      const vendor = db.prepare('SELECT name FROM vendors WHERE id = ?').get(conv.assigned_to);
      logger.info({ conversationId: conv.id, vendorId: conv.assigned_to, vendorName: vendor?.name }, 'Mensagem encaminhada para vendedor');
    } else {
      logger.info({ conversationId: conv.id }, 'Mensagem aguardando atribuicao');
    }

    // Texto/metadados essenciais já estão duráveis. Perfil, citação,
    // participante e mídia seguem em uma fila limitada por tenant, evitando
    // tempestade de chamadas Puppeteer durante rajadas.
    if (!isTenantOperational(tenantId)) return;
    const enrichmentAccepted = incomingEnrichmentQueue.enqueue(
      importKey(tenantId),
      messageId,
      () => {
        if (!isTenantOperational(tenantId)) return undefined;
        return runInTenantContext(tenantId, () => enrichIncomingMessage({
          msg,
          phone,
          client,
          tenantId,
          messageId,
          body,
          participantId,
          quickContactName
        }));
      },
      { messageId, conversationId: conv.id }
    );
    if (!enrichmentAccepted) scheduleRecentTenantSync(tenantId, 1000);
    else scheduleRecentTenantSync(tenantId, 2000);
  } finally {
    if (inFlightKey) incomingMessageInFlight.delete(inFlightKey);
  }
}

async function startWhatsAppClient({ reason = '' } = {}) {
  if (initializingWhatsApp) return;
  initializingWhatsApp = true;
  setConnectionStatus('INITIALIZING', {
    ready: false, qr: null, error: null,
    message: reason ? 'Reconectando...' : 'Inicializando...'
  });

  try {
    await initializeWhatsAppManager();

    // Sessões comerciais são restauradas independentemente do tenant legado
    // default. Uma credencial quebrada nesse tenant nunca mais bloqueia todas as
    // outras empresas, e clientes pagantes recebem capacidade primeiro.
    try {
      await restoreConnectedSessions();
    } catch (error) {
      logger.error({ err: error }, 'Erro ao restaurar sessões dos tenants');
    }

    const shouldStartDefault = process.env.WA_START_DEFAULT_SESSION === 'true'
      || (process.env.NODE_ENV !== 'production' && process.env.WA_START_DEFAULT_SESSION !== 'false');
    const defaultTenant = getTenantBySlug('default');
    let defaultStatus = null;
    if (defaultTenant && shouldStartDefault) {
      try {
        const client = await startTenantWaSession(defaultTenant.id);
        if (client) {
          whatsapp = client;
          defaultStatus = waManager.getStatus(defaultTenant.id);
          if (defaultStatus?.ready) markClientReady(client);
        }
      } catch (error) {
        defaultStatus = { status: 'DEFAULT_SESSION_FAILED', error: error.message };
        logger.error({ err: error, tenantId: defaultTenant.id }, 'Sessão default falhou sem bloquear tenants comerciais');
      }
    }

    if (!shouldStartDefault) {
      setConnectionStatus('MANAGED', {
        ready: true,
        qr: null,
        error: null,
        message: 'Gerenciador multiempresa pronto; sessão default desativada'
      });
    } else if (defaultStatus?.ready) {
      setConnectionStatus('READY', { ready: true, qr: null, error: null, message: 'WhatsApp pronto' });
    } else {
      setConnectionStatus(defaultStatus?.state || defaultStatus?.status || 'DISCONNECTED', {
        ready: false,
        qr: defaultStatus?.qr || null,
        error: defaultStatus?.error || null,
        message: defaultStatus?.status === 'qr'
          ? 'Aguardando leitura do QR code'
          : 'WhatsApp ainda não está pronto'
      });
    }

  } catch (err) {
    setConnectionStatus('MANAGER_INIT_FAILED', {
      ready: false,
      qr: null,
      error: err.message,
      message: 'Gerenciador do WhatsApp indisponível; verifique a configuração'
    });
    logger.error({ err }, 'Inicialização do WhatsApp não concluída');
  } finally {
    initializingWhatsApp = false;
  }
}

// O teste HTTP de isolamento sobe o servidor real, mas não deve abrir Chromium
// nem tocar sessões do WhatsApp. A chave é deliberadamente ignorada fora de
// NODE_ENV=test para nunca desabilitar o canal por engano em produção.
const whatsappBootstrapDisabledForTests = process.env.NODE_ENV === 'test'
  && process.env.DISABLE_WHATSAPP_BOOTSTRAP === 'true';
if (!whatsappBootstrapDisabledForTests) {
  startWhatsAppClient().catch(err => logger.error({ err }, 'Falha inesperada no bootstrap do WhatsApp'));
}

function closeHttpServer() {
  return new Promise(resolve => {
    httpServer.close(err => {
      if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
        logger.error({ err }, 'Erro ao fechar HTTP server');
      }
      resolve();
    });
  });
}

let shutdownStarted = false;
let runtimeDatabasesClosed = false;

function closeRuntimeDatabases() {
  if (runtimeDatabasesClosed) return;
  runtimeDatabasesClosed = true;
  try { db.defaultDb?.close(); } catch (dbErr) {
    logger.error({ err: dbErr }, 'Erro ao fechar banco da plataforma');
  }
  try {
    const { closeAllDbs } = require('./tenantManager');
    closeAllDbs();
  } catch (dbErr) {
    logger.error({ err: dbErr }, 'Erro ao fechar bancos SQLite');
  }
}

async function shutdownServer(signal, err = null, exitCode = 0, { discardWork = false } = {}) {
  const requestedExitCode = Number(exitCode) || 0;
  process.exitCode = Math.max(Number(process.exitCode) || 0, requestedExitCode);

  // Losing the single-writer lease is not a graceful deployment stop. Queue
  // admission must close synchronously before the first await, and SQLite must
  // close immediately so already-running async handlers cannot resume writes
  // while another writer owns the volume.
  if (discardWork) {
    abortMessageQueues('Lease exclusivo de escrita perdido; envio cancelado');
    incomingEnrichmentQueue.close({ discardPending: true });
    inboundMediaLimiter.close();
    httpServer.closeAllConnections?.();
    closeRuntimeDatabases();
  }

  if (shutdownStarted) return;
  shutdownStarted = true;

  clearInterval(billingSessionSweepTimer);
  if (trialCheckStartTimer) clearTimeout(trialCheckStartTimer);
  if (trialCheckInterval) clearInterval(trialCheckInterval);
  if (provisioningRecoveryStartTimer) clearTimeout(provisioningRecoveryStartTimer);
  if (provisioningRecoveryInterval) clearInterval(provisioningRecoveryInterval);
  for (const scheduled of recentSyncTimers.values()) clearTimeout(scheduled.timer);
  for (const scheduled of contactSyncTimers.values()) clearTimeout(scheduled.timer);
  for (const scheduled of autoImportTimers.values()) clearTimeout(scheduled.timer);
  for (const scheduled of fullReconcileTimers.values()) clearTimeout(scheduled.timer);
  for (const timer of importConversationUpdateTimers.values()) clearTimeout(timer);
  for (const cached of conversationSyncCache.values()) clearTimeout(cached.cleanupTimer);
  for (const scheduled of realtimeMediaRepairTimers.values()) clearTimeout(scheduled.timer);
  recentSyncTimers.clear();
  contactSyncTimers.clear();
  autoImportTimers.clear();
  fullReconcileTimers.clear();
  importConversationUpdateTimers.clear();
  conversationSyncCache.clear();
  realtimeMediaRepairTimers.clear();
  syncRuntimeFailureCounts.clear();

  const currentClient = whatsapp;
  whatsapp = null;

  if (err) logger.fatal({ err, signal }, 'Encerrando servidor por erro fatal');
  else logger.info({ signal }, 'Encerrando servidor');

  io.close();
  try {
    await withTimeout(closeHttpServer(), SHUTDOWN_HTTP_TIMEOUT_MS, 'Fechamento HTTP');
  } catch (closeErr) {
    logger.warn({ err: closeErr }, 'Forçando encerramento das conexões HTTP restantes');
    httpServer.closeAllConnections?.();
  }

  if (!discardWork) {
    // Deployment/operator shutdown remains graceful while this process still
    // owns the writer lease.
    try {
      await drainMessageQueues(SHUTDOWN_DRAIN_TIMEOUT_MS, { shutdown: true });
    } catch (queueErr) {
      logger.error({ err: queueErr }, 'Timeout ao drenar fila de envio');
    }

    const enrichmentDrained = await incomingEnrichmentQueue.drain(SHUTDOWN_WHATSAPP_TIMEOUT_MS);
    if (!enrichmentDrained) {
      logger.warn({ stats: incomingEnrichmentQueue.getStats() }, 'Timeout ao drenar enriquecimento de mensagens');
    }
    incomingEnrichmentQueue.close({ discardPending: !enrichmentDrained });

    const inboundMediaDrained = await inboundMediaLimiter.drain(SHUTDOWN_WHATSAPP_TIMEOUT_MS);
    if (!inboundMediaDrained) {
      logger.warn({ stats: inboundMediaLimiter.getStats() }, 'Timeout ao drenar downloads de mídia');
    }
    inboundMediaLimiter.close();
  }

  // Finaliza sessões WhatsApp + navegador compartilhado
  if (waManagerReady) {
    try {
      await withTimeout(
        waManager.shutdown(),
        SHUTDOWN_WHATSAPP_TIMEOUT_MS,
        'Encerramento WhatsApp'
      );
    } catch (err) {
      logger.error({ err }, 'Erro ao encerrar WhatsApp Manager');
    }
  } else if (currentClient) {
    try {
      await currentClient.destroy();
    } catch (err) {
      logger.error({ err }, 'Erro ao encerrar WhatsApp');
    }
  }

  closeRuntimeDatabases();

  process.exit(Math.max(Number(process.exitCode) || 0, requestedExitCode));
}

process.once('SIGINT', () => {
  shutdownServer('SIGINT');
});

process.once('SIGTERM', () => {
  const fatalExitCode = Math.max(0, Number(process.exitCode) || 0);
  shutdownServer('SIGTERM', null, fatalExitCode, { discardWork: fatalExitCode !== 0 });
});

const {
  PRODUCTION_WRITER_LEASE_LOST_EVENT
} = require('./productionWriterBootstrap');
process.once(PRODUCTION_WRITER_LEASE_LOST_EVENT, error => {
  shutdownServer('singleWriterLeaseLost', error, 1, { discardWork: true });
});

process.on('unhandledRejection', err => {
  const error = err instanceof Error ? err : new Error(String(err));
  if (waManagerReady
      && typeof waManager.recoverUnhandledRuntimeError === 'function'
      && waManager.recoverUnhandledRuntimeError(error)) {
    logger.warn({ err: error }, 'Erro transitório do WhatsApp isolado sem derrubar o servidor');
    return;
  }
  shutdownServer('unhandledRejection', error, 1);
});

process.on('uncaughtException', err => {
  shutdownServer('uncaughtException', err, 1);
});

app.use((err, req, res, next) => {
  logger.error({ err, path: req.path }, 'Erro na requisição');
  if (res.headersSent) return next(err);

  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'Corpo JSON inválido',
      code: 'INVALID_JSON'
    });
  }
  const rawStatusCode = Number(err.statusCode || err.status || 500);
  const statusCode = rawStatusCode >= 400 && rawStatusCode < 600 ? rawStatusCode : 500;
  const message = 'Erro interno do servidor';
  return res.status(statusCode).json({ error: message });
});

// ============ AVISO AUTOMÁTICO DE TRIAL VENCENDO ============
// Roda uma vez por dia; avisa o admin somente na última janela de 24 horas.
// Como o trial inteiro dura três dias, usar <=3 notificava imediatamente após
// o cadastro e marcava o aviso como já enviado.
// Não depende de cron externo — só do processo do servidor ficar de pé.

async function checkTrialsAndNotify() {
  const { listTenants, markTrialNotified } = require('./tenantManager');
  const { notifyTrialEnding } = require('./notifications');
  for (const tenant of listTenants()) {
    if (tenant.comp || tenant.billing_status !== 'trialing' || !tenant.trial_ends_at || tenant.trial_notified_at) continue;
    const daysLeft = Math.ceil((new Date(tenant.trial_ends_at) - Date.now()) / (24 * 60 * 60 * 1000));
    if (daysLeft < 0 || daysLeft > 1) continue;
    try {
      const email = getTenantDb(tenant.id).prepare('SELECT username FROM admins LIMIT 1').get()?.username;
      const sent = email
        ? await notifyTrialEnding({ to: email, companyName: tenant.name, daysLeft }, logger)
        : false;
      if (sent) markTrialNotified(tenant.id);
    } catch (err) {
      logger.error({ err, tenantId: tenant.id }, 'Erro ao avisar trial vencendo');
    }
  }
}

function recoverPasswordResetResolutionsNow() {
  const results = recoverInFlightPasswordResetResolutions({ masterDb: master, getTenantDb });
  for (const result of results) {
    if (result.recovered) {
      disconnectUserSockets({
        id: result.resolved.admin_id,
        role: 'admin',
        tenant_id: result.resolved.tenant_id
      });
      logger.warn(
        { requestId: result.requestId, tenantId: result.resolved.tenant_id },
        'Recuperacao de senha interrompida foi concluida'
      );
    } else {
      logger.error(
        { err: result.error, requestId: result.requestId },
        'Recuperacao de senha em voo ainda nao pôde ser concluida'
      );
    }
  }
  return results;
}

async function recoverStaleProvisioningTenants() {
  if (provisioningRecoveryRunning) return;
  provisioningRecoveryRunning = true;
  try {
    const {
      activateTenant,
      deleteTenant,
      getTenant,
      listExpiredCheckoutReservations,
      listStaleProvisioningTenants,
      logAudit,
      processForwardTenantDeletions
    } = require('./tenantManager');
    const forwardResults = await processForwardTenantDeletions(
      current => require('./billing').deleteTenantBilling(current)
    );
    for (const result of forwardResults) {
      if (result.committed) {
        clearTenantRuntimeState(result.tenantId, { final: true });
        if (result.cleanup && !result.cleanup.processed) {
          logger.error(
            { tenantId: result.tenantId, failures: result.cleanup.failures },
            'Exclusao recuperada; limpeza fisica segue pendente'
          );
        }
      } else if (result.error) {
        logger.error(
          { err: result.error, tenantId: result.tenantId },
          'Exclusao forward-only ainda nao pôde ser concluida'
        );
      }
    }
    recoverPasswordResetResolutionsNow();
    const billingRequired = process.env.NODE_ENV === 'production'
      && process.env.BILLING_REQUIRED !== 'false';
    if (billingRequired) {
      // Checkout aberto reserva uma vaga real, mas nao pode bloquea-la para
      // sempre. So removemos o tenant depois que a propria Stripe confirmou
      // atomicamente que a sessao expirou; uma conclusao concorrente sempre
      // vence e conserva a conta/capacidade.
      for (const snapshot of listExpiredCheckoutReservations()) {
        const tenant = getTenant(snapshot.id);
        if (!tenant || tenant.stripe_subscription_id || tenant.billing_status !== 'checkout_pending') continue;
        try {
          const release = await require('./billing').releaseExpiredCheckoutReservation(tenant);
          if (!release.released) {
            logger.warn(
              { tenantId: tenant.id, reason: release.reason },
              'Reserva de Checkout nao foi liberada; tenant preservado'
            );
            continue;
          }
          const deletion = await deleteTenant(tenant.id, {
            afterQuarantine: current => require('./billing').deleteTenantBilling(current)
          });
          clearTenantRuntimeState(tenant.id, { final: true });
          try {
            logAudit('system', 'checkout_reservation_expired', tenant.id, {
              checkoutSessionId: tenant.stripe_checkout_session_id,
              cleanupPending: !deletion.cleanup.processed
            });
          } catch (auditError) {
            logger.error({ err: auditError, tenantId: tenant.id }, 'Reserva removida, mas auditoria falhou');
          }
        } catch (error) {
          // Fail closed: erro/recurso ausente na Stripe nunca libera a vaga,
          // pois a sessao pode ter sido concluida no mesmo instante.
          logger.error({ err: error, tenantId: tenant.id }, 'Nao foi possivel validar expiracao do Checkout');
        }
      }
    }
    const configuredStaleMs = Number(process.env.TENANT_PROVISIONING_STALE_MS);
    const staleAfterMs = Number.isFinite(configuredStaleMs) && configuredStaleMs > 0
      ? Math.max(60 * 1000, configuredStaleMs)
      : 15 * 60 * 1000;
    for (const snapshot of listStaleProvisioningTenants(staleAfterMs)) {
      const tenant = getTenant(snapshot.id);
      if (!tenant || tenant.status !== 'provisioning') continue;
      // Em produção, `checkout_pending` prova que o fluxo chegou ao portão de
      // cobrança. Sem isso, ativar após crash concederia trial sem sequer
      // vincular a conta ao fluxo Stripe.
      const checkoutExpiryMs = new Date(tenant.checkout_expires_at || '').getTime();
      const hasLiveCheckoutReservation = tenant.billing_status === 'checkout_pending'
        && Boolean(tenant.stripe_checkout_session_id)
        && Number.isFinite(checkoutExpiryMs)
        && checkoutExpiryMs > Date.now();
      const hasVerifiedSubscription = Boolean(tenant.stripe_subscription_id)
        && ['active', 'trialing'].includes(tenant.billing_status);
      const billingGateReady = !billingRequired || hasLiveCheckoutReservation || hasVerifiedSubscription;
      if (billingGateReady) {
        try {
          const activated = activateTenant(tenant.id);
          logAudit('system', 'tenant_provisioning_recovered', tenant.id, {
            createdAt: tenant.created_at,
            status: activated.status
          });
          logger.warn({ tenantId: tenant.id }, 'Provisionamento completo recuperado apos reinicio');
          continue;
        } catch (error) {
          if (error.code !== 'PROVISIONING_OWNER_MISSING') {
            logger.error(
              { err: error, tenantId: tenant.id },
              'Falha transitoria ao validar provisionamento; mantendo para nova tentativa'
            );
            continue;
          }
          logger.warn(
            { tenantId: tenant.id },
            'Provisionamento antigo nao possui owner duravel; removendo com compensacao'
          );
        }
      } else if (billingRequired && tenant.stripe_checkout_session_id) {
        // Existe estado externo que ainda pode concluir/ter concluido. A
        // rotina acima o revalida quando vencer; apagar aqui criaria uma
        // disputa perigosa entre pagamento e compensacao.
        logger.warn(
          { tenantId: tenant.id },
          'Provisionamento possui Checkout sem reserva local valida; aguardando reconciliacao Stripe'
        );
        continue;
      } else {
        logger.warn(
          { tenantId: tenant.id },
          'Provisionamento antigo nao alcancou o portao de cobranca; removendo com compensacao'
        );
      }
      const deletion = await deleteTenant(tenant.id, {
        afterQuarantine: current => require('./billing').deleteTenantBilling(current)
      });
      try {
        logAudit('system', 'tenant_provisioning_abandoned', tenant.id, {
          createdAt: tenant.created_at,
          cleanupPending: !deletion.cleanup.processed
        });
      } catch (auditError) {
        logger.error({ err: auditError, tenantId: tenant.id }, 'Provisionamento removido, mas auditoria falhou');
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'Falha ao recuperar provisionamentos antigos');
  } finally {
    provisioningRecoveryRunning = false;
  }
}

// ============ START ============

// A edição SaaS conclui claims duráveis antes de aceitar login. Recuperação de
// senha de plataforma não existe na instalação interna exclusiva.
if (!INTERNAL_EDITION) recoverPasswordResetResolutionsNow();

httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, `Servidor rodando em http://localhost:${PORT}`);
  if (!INTERNAL_EDITION) {
    provisioningRecoveryStartTimer = setTimeout(
      () => recoverStaleProvisioningTenants(),
      5000
    );
    const configuredProvisioningIntervalMs = Number(process.env.TENANT_PROVISIONING_RECOVERY_INTERVAL_MS);
    const provisioningIntervalMs = Number.isFinite(configuredProvisioningIntervalMs)
      && configuredProvisioningIntervalMs > 0
      ? Math.max(60 * 1000, configuredProvisioningIntervalMs)
      : 5 * 60 * 1000;
    provisioningRecoveryInterval = setInterval(
      () => recoverStaleProvisioningTenants(),
      provisioningIntervalMs
    );
    trialCheckStartTimer = setTimeout(
      () => checkTrialsAndNotify().catch(err => logger.error({ err }, 'Erro no check de trials')),
      30000
    );
    trialCheckInterval = setInterval(
      () => checkTrialsAndNotify().catch(err => logger.error({ err }, 'Erro no check de trials')),
      24 * 60 * 60 * 1000
    );
    trialCheckStartTimer.unref?.();
    trialCheckInterval.unref?.();
    provisioningRecoveryStartTimer.unref?.();
    provisioningRecoveryInterval.unref?.();
  }
});
