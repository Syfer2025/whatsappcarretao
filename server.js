require('dotenv').config();

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
const pino = require('pino');
const pinoHttp = require('pino-http');
const path = require('path');
const fs = require('fs/promises');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const db = require('./db');
const { sleep, withTimeout } = require('./runtimeUtils');
const { importExistingChats } = require('./historyImporter');
const {
  isImportableChatId,
  getDisplayName,
  shouldReplaceDisplayName,
  getMessageExternalId,
  getMessageContent
} = require('./whatsappUtils');
const { saveMessageMedia, unavailableMediaContent } = require('./mediaStorage');
const { getConversationProfile } = require('./conversationProfile');
const { sendOutboundMessage, waitForMessageQueueIdle } = require('./messageSender');
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
  createUser,
  updateUser,
  listUsers,
  assignConversation
} = require('./adminServices');

const app = express();
const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: ['req.headers.authorization', 'req.headers.cookie']
});
startupWarnings.forEach(message => logger.warn(message));

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
const PROFILE_FETCH_TIMEOUT_MS = Number(process.env.PROFILE_FETCH_TIMEOUT_MS || 2500);
const CONNECTION_CHECK_INTERVAL_MS = Number(process.env.CONNECTION_CHECK_INTERVAL_MS || 60000);
const RECONNECT_BASE_DELAY_MS = Number(process.env.RECONNECT_BASE_DELAY_MS || 2000);
const RECONNECT_MAX_DELAY_MS = Number(process.env.RECONNECT_MAX_DELAY_MS || 30000);
const MAX_STATE_CHECK_FAILURES = Number(process.env.MAX_STATE_CHECK_FAILURES || 2);
const WHATSAPP_INIT_TIMEOUT_MS = Number(process.env.WHATSAPP_INIT_TIMEOUT_MS || 60000);
const SOCKET_RATE_LIMIT_WINDOW_MS = Number(process.env.SOCKET_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const SOCKET_RATE_LIMIT_MAX = Number(process.env.SOCKET_RATE_LIMIT_MAX || 60);
const SHUTDOWN_DRAIN_TIMEOUT_MS = Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS || 5000);
const MEDIA_ROOT = path.join(__dirname, 'media');
const WWEBJS_AUTH_ROOT = path.join(__dirname, '.wwebjs_auth');
const WWEBJS_CACHE_ROOT = path.join(__dirname, '.wwebjs_cache');

function validateRuntimeConfig() {
  if (process.env.NODE_ENV === 'production' && !JWT_SECRET) {
    throw new Error('JWT_SECRET obrigatorio em producao');
  }
  if (process.env.NODE_ENV === 'production' && !corsOriginConfig) {
    throw new Error('CORS_ORIGIN obrigatorio em producao');
  }
  if (!process.env.JWT_SECRET) {
    logger.warn('JWT_SECRET nao configurado; usando segredo temporario de desenvolvimento');
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
const loginLimiter = rateLimit({
  windowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  limit: Number(process.env.LOGIN_RATE_LIMIT_MAX || 20),
  standardHeaders: 'draft-8',
  legacyHeaders: false
});
const apiLimiter = rateLimit({
  windowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60 * 1000),
  limit: Number(process.env.API_RATE_LIMIT_MAX || 240),
  standardHeaders: 'draft-8',
  legacyHeaders: false
});
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: corsOptions });
const socketAuthAttempts = new Map();

app.use(cors(corsOptions));
app.use(pinoHttp({ logger }));
app.use('/api/login', loginLimiter);
app.use('/api/', apiLimiter);
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '50mb' }));
app.use(express.static(path.join(__dirname, 'frontend')));

app.get('/', (req, res) => res.redirect('/login.html'));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    ready: clientReady,
    state: lastClientState,
    reconnecting: Boolean(reconnectTimer),
    uptime: process.uptime()
  });
});

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
  const headerToken = req.headers.authorization?.replace('Bearer ', '');
  return headerToken || getCookie(req, 'auth_token');
}

function setAuthCookie(res, token) {
  res.cookie('auth_token', token, {
    path: '/',
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function getCurrentTokenVersion(user) {
  if (user.role === 'admin') {
    return db.prepare('SELECT token_version FROM admins WHERE id = ?').get(user.id)?.token_version;
  }
  if (user.role === 'vendor') {
    return db.prepare('SELECT token_version FROM vendors WHERE id = ? AND active = 1').get(user.id)?.token_version;
  }
  return null;
}

function isTokenVersionCurrent(user) {
  const currentVersion = getCurrentTokenVersion(user);
  return currentVersion !== undefined && currentVersion !== null && Number(user.token_version || 0) === Number(currentVersion);
}

function incrementTokenVersion(user) {
  if (user.role === 'admin') {
    return db.prepare('UPDATE admins SET token_version = token_version + 1 WHERE id = ?').run(user.id);
  }
  if (user.role === 'vendor') {
    return db.prepare('UPDATE vendors SET token_version = token_version + 1 WHERE id = ?').run(user.id);
  }
  return { changes: 0 };
}

function authMiddleware(roles = []) {
  return (req, res, next) => {
    const token = getAuthToken(req);
    if (!token) return res.status(401).json({ error: 'Token ausente' });

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (roles.length && !roles.includes(decoded.role)) {
        return res.status(403).json({ error: 'Sem permissão' });
      }
      if (!isTokenVersionCurrent(decoded)) {
        return res.status(401).json({ error: 'Token revogado' });
      }
      req.user = decoded;
      next();
    } catch {
      res.status(401).json({ error: 'Token inválido' });
    }
  };
}

function findMediaConversation(filename) {
  return db.prepare(`
    SELECT c.*
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.media_url = ?
       OR m.media_filename = ?
    ORDER BY m.id DESC
    LIMIT 1
  `).get(`/media/${filename}`, filename);
}

app.get('/media/:filename', authMiddleware(), (req, res, next) => {
  const filename = path.basename(String(req.params.filename || ''));
  if (!filename || filename !== req.params.filename) {
    return res.status(400).json({ error: 'Arquivo inválido' });
  }

  const conversation = findMediaConversation(filename);
  if (!conversation) return res.status(404).json({ error: 'Mídia não encontrada' });
  if (!canAccessConversation(req.user, conversation)) {
    return res.status(403).json({ error: 'Sem permissão para acessar essa mídia' });
  }

  return res.sendFile(path.join(MEDIA_ROOT, filename), err => {
    if (!err) return;
    if (res.headersSent) return next(err);
    if (err.statusCode === 404 || err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Mídia não encontrada' });
    }
    return next(err);
  });
});

// ============ AUTH ============

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (admin && bcrypt.compareSync(password, admin.password)) {
    const token = jwt.sign({ id: admin.id, role: 'admin', token_version: admin.token_version || 0 }, JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(res, token);
    return res.json({ token, role: 'admin' });
  }

  const vendor = db.prepare(`
    SELECT v.*, s.name AS sector_name
    FROM vendors v
    LEFT JOIN sectors s ON s.id = v.sector_id
    WHERE v.username = ? AND v.active = 1
  `).get(username);
  if (vendor && bcrypt.compareSync(password, vendor.password)) {
    const token = jwt.sign({
      id: vendor.id,
      role: 'vendor',
      name: vendor.name,
      sector_id: vendor.sector_id || null,
      sector_name: vendor.sector_name || null,
      token_version: vendor.token_version || 0
    }, JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(res, token);
    return res.json({ token, role: 'vendor', name: vendor.name, sector_id: vendor.sector_id || null, sector_name: vendor.sector_name || null });
  }

  res.status(401).json({ error: 'Usuário ou senha inválidos' });
});

app.get('/api/me', authMiddleware(), (req, res) => {
  res.json(req.user);
});

app.post('/api/logout', authMiddleware(), (req, res) => {
  incrementTokenVersion(req.user);
  res.clearCookie('auth_token', { path: '/' });
  res.json({ success: true });
});

// ============ USERS AND SECTORS (admin) ============

app.get('/api/sectors', authMiddleware(['admin']), (req, res) => {
  res.json(listSectors(db));
});

app.post('/api/sectors', authMiddleware(['admin']), (req, res) => {
  try {
    res.json(createSector({
      db,
      name: req.body.name,
      active: req.body.active !== false
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/sectors/:id', authMiddleware(['admin']), (req, res) => {
  try {
    res.json(updateSector({
      db,
      id: req.params.id,
      name: req.body.name,
      active: req.body.active !== false
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/vendors', authMiddleware(['admin']), (req, res) => {
  res.json(listUsers(db));
});

app.post('/api/vendors', authMiddleware(['admin']), (req, res) => {
  try {
    res.json(createUser({
      db,
      name: req.body.name,
      username: req.body.username,
      password: req.body.password,
      active: req.body.active !== false,
      sectorId: req.body.sector_id
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/vendors/:id', authMiddleware(['admin']), (req, res) => {
  try {
    res.json(updateUser({
      db,
      id: req.params.id,
      name: req.body.name,
      username: req.body.username,
      password: req.body.password || '',
      active: req.body.active !== false,
      sectorId: req.body.sector_id
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/vendors/:id', authMiddleware(['admin']), (req, res) => {
  db.prepare('UPDATE vendors SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/search', authMiddleware(), (req, res) => {
  res.json(searchVisibleContent({
    db,
    user: req.user,
    q: req.query.q || '',
    mediaType: req.query.media_type || ''
  }));
});

// ============ CONVERSATIONS ============

app.get('/api/conversations', authMiddleware(), (req, res) => {
  res.json(getVisibleConversations({
    db,
    user: req.user,
    queue: req.query.queue || ''
  }));
});

app.get('/api/conversations/unassigned', authMiddleware(['admin']), (req, res) => {
  const conversations = db.prepare(`
    SELECT c.*, s.name as sector_name
    FROM conversations c
    LEFT JOIN sectors s ON c.sector_id = s.id
    WHERE c.assigned_to IS NULL AND c.status = 'unassigned'
    ORDER BY c.created_at DESC
  `).all();
  res.json(conversations);
});

app.post('/api/conversations/:id/assign', authMiddleware(['admin']), (req, res) => {
  try {
    const conversation = assignConversation({
      db,
      conversationId: req.params.id,
      vendorId: req.body.vendor_id,
      sectorId: req.body.sector_id
    });
    emitConversationUpdate(conversation.id);
    res.json(conversation);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/conversations/:id/close', authMiddleware(['admin']), (req, res) => {
  db.prepare("UPDATE conversations SET status = 'closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(req.params.id);
  emitConversationUpdate(req.params.id);
  res.json({ success: true });
});

app.patch('/api/conversations/:id/state', authMiddleware(), (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

  if (!canAccessConversation(req.user, conv)) {
    return res.status(403).json({ error: 'Essa conversa não é sua' });
  }

  const state = updateConversationUserState({
    db,
    conversationId: req.params.id,
    user: req.user,
    patch: {
      pinned: req.body.pinned,
      muted: req.body.muted,
      mutedUntil: req.body.muted_until,
      markedUnread: req.body.marked_unread,
      draftText: req.body.draft_text
    }
  });
  emitConversationUpdate(req.params.id);
  res.json(state);
});

app.post('/api/conversations/:id/read', authMiddleware(), (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

  if (!canAccessConversation(req.user, conv)) {
    return res.status(403).json({ error: 'Essa conversa não é sua' });
  }

  res.json(markConversationRead({
    db,
    conversationId: req.params.id,
    user: req.user
  }));
});

// ============ MESSAGES ============

app.get('/api/conversations/:id/messages', authMiddleware(), (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

  if (!canAccessConversation(req.user, conv)) {
    return res.status(403).json({ error: 'Essa conversa não é sua' });
  }

  const msgs = getConversationMessages({
    db,
    user: req.user,
    conversationId: req.params.id,
    filters: {
      starred: req.query.starred === '1',
      q: req.query.q || '',
      mediaType: req.query.media_type
    },
    pagination: {
      limit: req.query.limit,
      beforeId: req.query.before_id
    }
  });
  res.json(msgs);
});

app.post('/api/conversations/:id/messages', authMiddleware(['vendor', 'admin']), async (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

  if (!canAccessConversation(req.user, conv)) {
    return res.status(403).json({ error: 'Essa conversa não é sua' });
  }

  try {
    const msg = await sendOutboundMessage({
      db,
      whatsappClient,
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

app.patch('/api/messages/:id/star', authMiddleware(['vendor', 'admin']), (req, res) => {
  const msg = getMessageWithConversation(db, req.params.id);
  if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });

  if (!canAccessConversation(req.user, msg)) {
    return res.status(403).json({ error: 'Essa conversa não é sua' });
  }

  const updated = setMessageStarred({
    db,
    messageId: req.params.id,
    user: req.user,
    starred: Boolean(req.body.starred)
  });
  emitConversationUpdate(msg.conversation_id);
  res.json(updated);
});

app.get('/api/messages/starred', authMiddleware(['vendor', 'admin']), (req, res) => {
  const messages = getStarredMessages({
    db,
    user: req.user,
    q: req.query.q || ''
  });
  res.json(messages);
});

// ============ QR CODE STATUS ============

let qrCodeData = null;
let clientReady = false;
let whatsapp = null;
let whatsappClient = null;
let importInProgress = false;
let lastImportStats = null;
let autoImportDone = false;
let lastClientState = null;
let lastClientError = null;
let lastConnectionMessage = null;
let lastConnectionChangedAt = null;
let initializingWhatsApp = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = Number(process.env.MAX_RECONNECT_ATTEMPTS || 8);
let stateCheckFailures = 0;

function setConnectionStatus(state, { ready = clientReady, qr = qrCodeData, error = lastClientError, message = lastConnectionMessage } = {}) {
  clientReady = ready;
  qrCodeData = qr;
  lastClientState = state;
  lastClientError = error;
  lastConnectionMessage = message;
  lastConnectionChangedAt = new Date().toISOString();
  emitConnectionUpdate();
}

function getConnectionStatus({ includeQr = false } = {}) {
  return {
    ready: clientReady,
    qr: includeQr ? qrCodeData : null,
    importing: importInProgress,
    lastImport: lastImportStats,
    state: lastClientState,
    error: lastClientError,
    message: lastConnectionMessage,
    changedAt: lastConnectionChangedAt,
    reconnecting: Boolean(reconnectTimer),
    reconnectAttempts
  };
}

function emitConnectionUpdate() {
  io.emit('connection:status', getConnectionStatus({ includeQr: false }));
}

function emitConversationUpdate(conversationId) {
  io.emit('conversation:updated', { conversationId: Number(conversationId) || null });
}

function userRoom(user) {
  return `user:${user.role}:${user.id}`;
}

function visibleUsersForConversation(conversation) {
  if (!conversation) return [];
  const users = db.prepare('SELECT id, username AS name FROM admins').all()
    .map(admin => ({ id: admin.id, role: 'admin', name: admin.name }));
  if (conversation.assigned_to) {
    const vendor = db.prepare('SELECT id, name FROM vendors WHERE id = ? AND active = 1').get(conversation.assigned_to);
    if (vendor) users.push({ id: vendor.id, role: 'vendor', name: vendor.name });
  }
  return users;
}

function emitTypingUpdate(conversationId, typingUser, typing) {
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
    io.to(userRoom(user)).emit('typing:update', event);
  }
}

function emitNotificationForMessage(conversationId, messageId) {
  if (!messageId) return;
  const message = db.prepare(`
    SELECT m.*,
           c.phone,
           c.contact_name,
           c.assigned_to,
           c.profile_pic_url,
           c.status
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = ?
  `).get(messageId);
  if (!message || message.from_type !== 'client') return;

  const title = message.contact_name || message.phone || 'Nova mensagem';
  const body = message.content || message.media_filename || (message.media_url ? 'Mídia' : 'Nova mensagem');
  for (const user of visibleUsersForConversation(message)) {
    if (isConversationMutedForUser({ db, conversationId, user })) continue;
    io.to(userRoom(user)).emit('notification:new', {
      conversationId: Number(conversationId),
      messageId: Number(messageId),
      title,
      body,
      createdAt: message.created_at
    });
  }
}

function emitNewMessage(conversationId, messageId) {
  io.emit('message:new', {
    conversationId: Number(conversationId) || null,
    messageId: Number(messageId) || null
  });
  emitNotificationForMessage(conversationId, messageId);
  emitConversationUpdate(conversationId);
}

function getSocketRateLimitKey(socket) {
  return socket.handshake.address || socket.conn?.remoteAddress || 'unknown';
}

function checkSocketRateLimit(socket) {
  const now = Date.now();
  const key = getSocketRateLimitKey(socket);
  const record = socketAuthAttempts.get(key);
  if (!record || now - record.startedAt >= SOCKET_RATE_LIMIT_WINDOW_MS) {
    socketAuthAttempts.set(key, { count: 1, startedAt: now });
    return false;
  }

  record.count += 1;
  return record.count > SOCKET_RATE_LIMIT_MAX;
}

io.use((socket, next) => {
  try {
    if (checkSocketRateLimit(socket)) {
      return next(new Error('Muitas tentativas de conexão'));
    }
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Token ausente'));
    socket.user = jwt.verify(token, JWT_SECRET);
    if (!isTokenVersionCurrent(socket.user)) return next(new Error('Token revogado'));
    return next();
  } catch (err) {
    logger.warn({ err, address: getSocketRateLimitKey(socket) }, 'Erro ao autenticar socket');
    return next(new Error('Token inválido'));
  }
});

io.on('connection', socket => {
  socket.join(userRoom(socket.user));
  socket.emit('connection:status', getConnectionStatus({ includeQr: false }));
  socket.on('typing:update', payload => {
    emitTypingUpdate(Number(payload?.conversationId), socket.user, Boolean(payload?.typing));
  });
});

app.get('/api/status', (req, res) => {
  res.json({ ...getConnectionStatus({ includeQr: false }), qr: null });
});

app.get('/api/admin/connection', authMiddleware(['admin']), (req, res) => {
  res.json(getConnectionStatus({ includeQr: true }));
});

async function handleImportHistory(req, res) {
  if (!clientReady) return res.status(409).json({ error: 'WhatsApp ainda não está conectado' });

  try {
    const stats = await runHistoryImport({ retryUnavailableMedia: true });
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.post('/api/import-history', authMiddleware(['admin']), handleImportHistory);
app.post('/api/admin/import-history', authMiddleware(['admin']), handleImportHistory);

app.post('/api/admin/reset-whatsapp', authMiddleware(['admin']), async (req, res) => {
  try {
    await resetWhatsAppSession();
    res.json(getConnectionStatus({ includeQr: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ WHATSAPP CLIENT ============

function detectSystemChrome() {
  const envPath = process.env.CHROME_EXECUTABLE_PATH;
  if (envPath) return envPath;

  const paths = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium'
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    ]
  };

  const candidates = paths[process.platform] || paths.linux;
  for (const p of candidates) {
    try { require('fs').accessSync(p); return p; } catch {}
  }
  return undefined;
}

function createWhatsAppClient() {
  // User-Agent dinâmico: se o Chrome do sistema for detectado, tenta extrair a
  // versão real; senão, usa Chrome 130 como fallback razoável para 2026.
  const executablePath = detectSystemChrome();
  let userAgent = process.env.WHATSAPP_USER_AGENT;
  if (!userAgent) {
    if (executablePath) {
      try {
        const { execFileSync } = require('child_process');
        const out = execFileSync(executablePath, ['--version'], { encoding: 'utf8', timeout: 3000 });
        const match = out.match(/(\d+)/);
        const ver = match ? match[1] : '130';
        userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver}.0.0.0 Safari/537.36`;
      } catch {
        userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
      }
    } else {
      userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    }
  }

  const browserProfilePath = process.env.BROWSER_PROFILE_DIR
    ? path.resolve(process.env.BROWSER_PROFILE_DIR)
    : undefined;

  if (executablePath) {
    logger.info({ executablePath }, 'Usando Chrome do sistema — fingerprint mais natural');
  } else {
    logger.info('Chrome do sistema não encontrado, usando Chromium bundled');
  }

  const isHeadless = process.env.WHATSAPP_HEADLESS !== 'false';
  // Modo headless "new" (Chrome 112+): renderiza GPU, carrega extensões,
  // não define navigator.webdriver — muito mais difícil de detectar que o
  // headless antigo. Se o Chrome do sistema for <112, faz fallback automático.
  const headlessMode = isHeadless ? 'new' : false;

  const proxyServer = process.env.WHATSAPP_PROXY || '';
  const proxyArgs = proxyServer ? [`--proxy-server=${proxyServer}`] : [];

  return new Client({
    authStrategy: new LocalAuth({ dataPath: WWEBJS_AUTH_ROOT }),
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,
    userAgent,
    puppeteer: {
      headless: headlessMode,
      executablePath,
      userDataDir: browserProfilePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-sync',
        '--lang=pt-BR',
        '--window-size=1920,1080',
        // --disable-gpu só no headless antigo; no modo "new" (Chrome 112+)
        // a GPU é renderizada e desativá-la criaria fingerprint contraditório
        ...(isHeadless && headlessMode === true ? [
          '--disable-gpu',
          '--disable-accelerated-2d-canvas'
        ] : []),
        ...proxyArgs
      ]
    }
  });
}

function registerWhatsAppEvents(client) {
  client.on('qr', qr => {
    if (client !== whatsapp) return;
    setConnectionStatus('QR', {
      ready: false,
      qr,
      error: null,
      message: 'Aguardando leitura do QR code no painel admin'
    });
    qrcode.generate(qr, { small: true });
    logger.info('Escaneie o QR code no painel admin');
  });

  client.on('loading_screen', (percent, message) => {
    if (client !== whatsapp) return;
    setConnectionStatus(`LOADING ${percent}%`, {
      ready: false,
      message: `WhatsApp carregando: ${percent}%`
    });
    logger.info({ percent, message }, 'WhatsApp carregando');
  });

  client.on('authenticated', () => {
    if (client !== whatsapp) return;
    setConnectionStatus('AUTHENTICATED', {
      ready: false,
      qr: null,
      error: null,
      message: 'QR lido. Autenticando sessao...'
    });
    logger.info('WhatsApp autenticado');
  });

  client.on('auth_failure', msg => {
    if (client !== whatsapp) return;
    setConnectionStatus('AUTH_FAILURE', {
      ready: false,
      qr: null,
      error: msg,
      message: 'Falha ao autenticar. Resete a sessao e leia um novo QR code.'
    });
    logger.error({ error: msg }, 'Falha de autenticação do WhatsApp');
  });

  client.on('change_state', state => {
    if (client !== whatsapp) return;
    lastClientState = state;
    lastConnectionMessage = state === 'CONNECTED'
      ? 'WhatsApp conectado, aguardando prontidao final...'
      : `Estado do WhatsApp: ${state}`;
    lastConnectionChangedAt = new Date().toISOString();
    emitConnectionUpdate();
    logger.info({ state }, 'Estado do WhatsApp');
  });

  client.on('ready', () => {
    if (client !== whatsapp) return;
    markClientReady(client);
  });

  client.on('disconnected', reason => {
    if (client !== whatsapp) return;
    whatsappClient = null;
    setConnectionStatus('DISCONNECTED', {
      ready: false,
      qr: null,
      error: reason || 'WhatsApp desconectado',
      message: 'WhatsApp desconectado. Tentando reconectar...'
    });
    logger.warn({ reason: reason || '' }, 'WhatsApp desconectado');
    scheduleWhatsAppReconnect(reason || 'disconnected');
  });

  client.on('message', msg => {
    if (client !== whatsapp) return;
    handleIncomingMessage(msg).catch(err => {
      lastClientError = err.message;
      logger.error({ err }, 'Erro ao processar mensagem recebida');
    });
  });

  client.on('message_ack', (msg, ack) => {
    if (client !== whatsapp) return;
    const statuses = ['', 'sent', 'delivered', 'read', 'played'];
    const status = statuses[ack] || 'sent';
    if (status === 'sent') return;
    const externalId = getMessageExternalId(msg);
    if (externalId) {
      try {
        db.prepare('UPDATE messages SET delivery_status = ? WHERE external_id = ?').run(status, externalId);
      } catch (err) {
        logger.error({ err, externalId, status }, 'Erro ao atualizar delivery_status');
      }
    }
  });
}

async function refreshClientState() {
  if (!whatsapp || initializingWhatsApp) return;
  try {
    const state = await whatsapp.getState();
    stateCheckFailures = 0;
    if (state) lastClientState = state;
    if (state === 'CONNECTED' && !clientReady) {
      markClientReady(whatsapp);
    }
  } catch (err) {
    lastClientError = err.message;
    stateCheckFailures += 1;
    if (stateCheckFailures >= MAX_STATE_CHECK_FAILURES) {
      setConnectionStatus('STATE_CHECK_FAILED', {
        ready: false,
        qr: null,
        error: err.message,
        message: 'Monitor de conexao falhou repetidamente. Tentando reconectar...'
      });
      scheduleWhatsAppReconnect('state check failed');
    }
  }
}

async function runHistoryImport({ retryUnavailableMedia = false, client = whatsapp } = {}) {
  if (importInProgress) return lastImportStats || { importing: true };

  const targetClient = client || whatsapp;
  if (!targetClient || typeof targetClient.getChats !== 'function') {
    throw new Error('Cliente WhatsApp indisponivel para importar historico');
  }

  importInProgress = true;
  try {
    lastImportStats = await importExistingChats({
      whatsapp: targetClient,
      db,
      limit: HISTORY_IMPORT_LIMIT,
      mediaRoot: MEDIA_ROOT,
      mediaDownloadTimeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
      profileFetchTimeoutMs: PROFILE_FETCH_TIMEOUT_MS,
      refreshProfiles: retryUnavailableMedia,
      retryUnavailableMedia,
      chatImportDelayMs: Number(process.env.CHAT_IMPORT_DELAY_MS || 2000),
      logger: {
        log: message => logger.info(message),
        error: message => logger.error(message)
      }
    });
    emitConversationUpdate(null);
    return lastImportStats;
  } finally {
    importInProgress = false;
  }
}

function markClientReady(client = whatsapp) {
  if (client && client !== whatsapp) return;
  if (clientReady) return;
  reconnectAttempts = 0;
  stateCheckFailures = 0;
  setConnectionStatus('READY', {
    ready: true,
    qr: null,
    error: null,
    message: 'WhatsApp conectado e pronto para uso'
  });
  logger.info('WhatsApp conectado');

  // Só importa histórico automaticamente na primeira conexão
  // Evita pico de atividade em reconexões que pode ser detectado como bot
  if (!autoImportDone) {
    autoImportDone = true;
    runHistoryImport({ client }).catch(err => {
      logger.error({ err }, 'Erro ao importar conversas');
    });
  } else {
    logger.info('Histórico já importado anteriormente. Pulei importação automática na reconexão.');
  }
}

function scheduleWhatsAppReconnect(reason) {
  if (reconnectTimer || initializingWhatsApp) return;
  reconnectAttempts += 1;

  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    setConnectionStatus('MAX_RECONNECT_EXCEEDED', {
      ready: false,
      qr: null,
      error: `Máximo de ${MAX_RECONNECT_ATTEMPTS} tentativas de reconexão atingido`,
      message: 'Número máximo de tentativas de reconexão excedido. Faça um reset manual da sessão.'
    });
    emitConnectionUpdate();
    logger.error({ maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS }, 'Reconexão interrompida após limite de tentativas');
    return;
  }

  const baseDelay = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * (2 ** Math.max(0, reconnectAttempts - 1))
  );
  // Jitter: 50-100% do delay base para evitar padrões previsíveis de bot
  const jitter = 0.5 + Math.random() * 0.5;
  const delayMs = Math.round(baseDelay * jitter);

  lastConnectionMessage = `WhatsApp desconectado. Tentando reconectar em ${Math.ceil(delayMs / 1000)}s (tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}).`;
  lastConnectionChangedAt = new Date().toISOString();
  emitConnectionUpdate();

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    restartWhatsAppClient(reason).catch(err => {
      setConnectionStatus('RECONNECT_FAILED', {
        ready: false,
        qr: null,
        error: err.message,
        message: 'Falha ao tentar reconectar automaticamente'
      });
      scheduleWhatsAppReconnect('reconnect failed');
    });
  }, delayMs);
}

async function restartWhatsAppClient(reason) {
  const currentClient = whatsapp;
  whatsapp = null;
  whatsappClient = null;
  clientReady = false;

  if (currentClient) {
    try {
      await currentClient.destroy();
    } catch (err) {
      lastClientError = err.message;
    }
  }

  await sleep(1000);
  initializingWhatsApp = false;
  await startWhatsAppClient({ reason });
}

async function handleIncomingMessage(msg) {
  if (msg.fromMe) return;
  if (!isImportableChatId(msg.from)) return;

  const phone = msg.from;
  const externalId = getMessageExternalId(msg);
  let mediaFields = {};
  let mediaUnavailable = false;

  if (msg.hasMedia && typeof msg.downloadMedia === 'function') {
    try {
      // Delay humano (0.5-2s) antes de baixar mídia pra evitar padrão de bot
      await sleep(500 + Math.round(Math.random() * 1500));
      const media = await msg.downloadMedia();
      if (media) {
        mediaFields = await saveMessageMedia({
          messageId: externalId,
          media,
          messageType: msg.type,
          mediaRoot: MEDIA_ROOT,
          publicBasePath: '/media'
        }) || {};
      } else {
        mediaUnavailable = true;
      }
    } catch (err) {
      mediaUnavailable = true;
      logger.error({ err }, 'Erro ao baixar mídia recebida');
    }
  }

  const body = typeof msg.body === 'string' ? msg.body.trim() : '';
  const content = body || (mediaUnavailable ? unavailableMediaContent(msg.type) : mediaFields.media_url ? '' : getMessageContent(msg));
  if (!content && !mediaFields.media_url) return;

  let quotedMessageId = null;
  if (typeof msg.hasQuotedMsg === 'function' && msg.hasQuotedMsg()) {
    try {
      let quotedExternalId = msg._data?.context_info?.stanzaId;
      if (!quotedExternalId) {
        const quotedMsg = await msg.getQuotedMessage();
        quotedExternalId = getMessageExternalId(quotedMsg);
      }
      if (quotedExternalId) {
        const quoted = db.prepare('SELECT id FROM messages WHERE external_id = ?').get(quotedExternalId);
        if (quoted) quotedMessageId = quoted.id;
      }
    } catch (err) {
      logger.warn({ err }, 'Erro ao extrair mensagem citada');
    }
  }

  let profileChat = {
    id: { _serialized: phone },
    name: msg._data?.notifyName,
    isGroup: phone.endsWith('@g.us')
  };

  if (typeof msg.getChat === 'function') {
    try {
      const loadedChat = await Promise.race([
        msg.getChat(),
        new Promise(resolve => setTimeout(() => resolve(null), PROFILE_FETCH_TIMEOUT_MS))
      ]);
      if (loadedChat) profileChat = loadedChat;
    } catch {}
  }

  const profile = await getConversationProfile({
    whatsapp,
    chat: profileChat,
    chatId: phone,
    timeoutMs: PROFILE_FETCH_TIMEOUT_MS
  });
  const contactName = profile.contactName || msg._data?.notifyName || getDisplayName({}, phone);

  let conv = db.prepare('SELECT * FROM conversations WHERE phone = ? AND status != ?').get(phone, 'closed');
  if (!conv) {
    const result = db.prepare('INSERT INTO conversations (phone, contact_name, profile_pic_url) VALUES (?, ?, ?)')
      .run(phone, contactName, profile.profilePicUrl);
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid);
    logger.info({ conversationId: conv.id, contactName, phone }, 'Nova conversa');
  }

  const insertResult = db.prepare(`
    INSERT OR IGNORE INTO messages (
      conversation_id,
      external_id,
      from_type,
      content,
      media_type,
      media_mimetype,
      media_filename,
      media_url,
      media_size,
      media_unavailable,
      quoted_message_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    conv.id,
    externalId,
    'client',
    content,
    mediaFields.media_type || null,
    mediaFields.media_mimetype || null,
    mediaFields.media_filename || null,
    mediaFields.media_url || null,
    mediaFields.media_size || null,
    mediaUnavailable ? 1 : 0,
    quotedMessageId
  );
  const nextContactName = shouldReplaceDisplayName(conv.contact_name, contactName, phone)
    ? contactName
    : conv.contact_name;
  db.prepare(`
    UPDATE conversations
    SET contact_name = ?,
        profile_pic_url = COALESCE(?, profile_pic_url),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(nextContactName, profile.profilePicUrl, conv.id);

  if (conv.assigned_to) {
    const vendor = db.prepare('SELECT name FROM vendors WHERE id = ?').get(conv.assigned_to);
    logger.info({ conversationId: conv.id, vendorId: conv.assigned_to, vendorName: vendor?.name }, 'Mensagem encaminhada para vendedor');
  } else {
    logger.info({ conversationId: conv.id }, 'Mensagem aguardando atribuicao');
  }

  emitNewMessage(conv.id, insertResult.lastInsertRowid);

}

async function startWhatsAppClient({ reason = '' } = {}) {
  if (initializingWhatsApp) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  initializingWhatsApp = true;
  setConnectionStatus('INITIALIZING', {
    ready: false,
    qr: null,
    error: null,
    message: reason ? 'Reconectando WhatsApp...' : 'Inicializando WhatsApp...'
  });

  const client = createWhatsAppClient();
  whatsapp = client;
  whatsappClient = client;
  registerWhatsAppEvents(client);

  try {
    await withTimeout(client.initialize(), WHATSAPP_INIT_TIMEOUT_MS, 'Inicializacao do WhatsApp');
    if (client === whatsapp) logger.info('Inicialização do WhatsApp concluída');
  } catch (err) {
    if (client === whatsapp) {
      setConnectionStatus('INITIALIZE_FAILED', {
        ready: false,
        qr: null,
        error: err.message,
        message: 'Falha ao inicializar WhatsApp. Nova tentativa sera feita automaticamente.'
      });
      logger.error({ err }, 'Erro ao inicializar WhatsApp');
      initializingWhatsApp = false;
      scheduleWhatsAppReconnect('initialize failed');
    }
  } finally {
    if (client === whatsapp) initializingWhatsApp = false;
  }
}

async function resetWhatsAppSession() {
  const currentClient = whatsapp;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  stateCheckFailures = 0;
  setConnectionStatus('RESETTING', {
    ready: false,
    qr: null,
    error: null,
    message: 'Resetando sessao do WhatsApp...'
  });
  whatsapp = null;
  whatsappClient = null;

  if (currentClient) {
    try {
      await currentClient.destroy();
    } catch (err) {
      lastClientError = err.message;
    }
  }

  await fs.rm(WWEBJS_AUTH_ROOT, { recursive: true, force: true });
  await fs.rm(WWEBJS_CACHE_ROOT, { recursive: true, force: true });
  initializingWhatsApp = false;
  await startWhatsAppClient();
}

startWhatsAppClient();

let connectionMonitor;
function scheduleConnectionCheck() {
  // Jitter de 90-110% pra evitar padrão previsível de bot
  const jitter = Math.round(CONNECTION_CHECK_INTERVAL_MS * (0.9 + Math.random() * 0.2));
  connectionMonitor = setTimeout(() => {
    refreshClientState();
    scheduleConnectionCheck();
  }, jitter);
}
scheduleConnectionCheck();

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
async function shutdownServer(signal, err = null, exitCode = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearTimeout(connectionMonitor);

  const currentClient = whatsapp;
  whatsapp = null;
  whatsappClient = null;

  if (err) logger.fatal({ err, signal }, 'Encerrando servidor por erro fatal');
  else logger.info({ signal }, 'Encerrando servidor');

  io.close();
  await closeHttpServer();

  try {
    await waitForMessageQueueIdle(SHUTDOWN_DRAIN_TIMEOUT_MS);
  } catch (queueErr) {
    logger.error({ err: queueErr }, 'Timeout aguardando fila de envio esvaziar');
  }

  if (currentClient) {
    try {
      await currentClient.destroy();
    } catch (err) {
      logger.error({ err }, 'Erro ao encerrar WhatsApp');
    }
  }

  try {
    db.close();
  } catch (dbErr) {
    logger.error({ err: dbErr }, 'Erro ao fechar SQLite');
  }

  process.exit(exitCode);
}

process.once('SIGINT', () => {
  shutdownServer('SIGINT');
});

process.once('SIGTERM', () => {
  shutdownServer('SIGTERM');
});

process.on('unhandledRejection', err => {
  shutdownServer('unhandledRejection', err instanceof Error ? err : new Error(String(err)), 1);
});

process.on('uncaughtException', err => {
  shutdownServer('uncaughtException', err, 1);
});

app.use((err, req, res, next) => {
  logger.error({ err, path: req.path }, 'Erro na requisição');
  if (res.headersSent) return next(err);

  const rawStatusCode = Number(err.statusCode || err.status || 500);
  const statusCode = rawStatusCode >= 400 && rawStatusCode < 600 ? rawStatusCode : 500;
  const message = statusCode >= 500 ? 'Erro interno do servidor' : err.message;
  return res.status(statusCode).json({ error: message });
});

// ============ START ============

httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, `Servidor rodando em http://localhost:${PORT}`);
});
