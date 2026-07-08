const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

test('server keeps public status qr-free and exposes admin connection endpoints', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /app\.get\('\/api\/status'/);
  assert.match(source, /qr:\s*null/);
  assert.match(source, /app\.get\('\/api\/admin\/connection',\s*authMiddleware\(\['admin'\]\)/);
  assert.match(source, /app\.post\('\/api\/admin\/reset-whatsapp',\s*authMiddleware\(\['admin'\]\)/);
  assert.match(source, /app\.post\('\/api\/admin\/import-history',\s*authMiddleware\(\['admin'\]\)/);
});

test('server exposes sectors and user management routes for admin', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /app\.get\('\/api\/sectors',\s*authMiddleware\(\['admin'\]\)/);
  assert.match(source, /app\.post\('\/api\/sectors',\s*authMiddleware\(\['admin'\]\)/);
  assert.match(source, /app\.put\('\/api\/sectors\/:id',\s*authMiddleware\(\['admin'\]\)/);
  assert.match(source, /createUser/);
  assert.match(source, /updateUser/);
  assert.match(source, /assignConversation/);
});

test('server schedules whatsapp reconnects and reports connection transitions', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /function scheduleWhatsAppReconnect/);
  assert.match(source, /function restartWhatsAppClient/);
  assert.match(source, /client\.on\('disconnected',\s*reason\s*=>/);
  assert.match(source, /lastConnectionMessage/);
  assert.match(source, /takeoverOnConflict:\s*true/);
});

test('server does not auto-reply to incoming customer messages', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.doesNotMatch(source, /msg\.reply\(/);
  assert.doesNotMatch(source, /vendedor entrará em contato/i);
});

test('server hardens whatsapp initialization and history import against stale clients', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /WHATSAPP_INIT_TIMEOUT_MS/);
  assert.match(source, /withTimeout\(client\.initialize\(\),\s*WHATSAPP_INIT_TIMEOUT_MS/);
  assert.match(source, /async function runHistoryImport\(\{[\s\S]*client = whatsapp/);
  assert.match(source, /typeof targetClient\.getChats !== 'function'/);
  assert.match(source, /runHistoryImport\(\{ client \}\)/);
});

test('connection monitor schedules reconnect after repeated state check failures', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /stateCheckFailures >= MAX_STATE_CHECK_FAILURES/);
  assert.match(source, /setConnectionStatus\('STATE_CHECK_FAILED'/);
  assert.match(source, /scheduleWhatsAppReconnect\('state check failed'\)/);
});

test('dev runner ignores runtime files that change during whatsapp use', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const nodemonConfig = JSON.parse(fs.readFileSync('nodemon.json', 'utf8'));

  assert.match(pkg.scripts.dev, /nodemon --config nodemon\.json server\.js/);
  for (const pattern of [
    'data.db*',
    'media/**',
    '.wwebjs_auth/**',
    '.wwebjs_cache/**',
    '*.test.js',
    'docs/**'
  ]) {
    assert.ok(nodemonConfig.ignore.includes(pattern), `${pattern} must be ignored`);
  }
});

test('server has VPS hardening middleware and structured logging', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.ok(pkg.dependencies['express-rate-limit'], 'express-rate-limit dependency is required');
  assert.ok(pkg.dependencies.pino, 'pino dependency is required');
  assert.ok(pkg.dependencies['pino-http'], 'pino-http dependency is required');
  assert.match(source, /rateLimit/);
  assert.match(source, /loginLimiter/);
  assert.match(source, /apiLimiter/);
  assert.match(source, /pinoHttp/);
  assert.match(source, /TRUST_PROXY/);
  assert.match(source, /app\.set\('trust proxy'/);
  assert.match(source, /validateRuntimeConfig/);
  assert.match(source, /randomBytes\(32\)/);
  assert.doesNotMatch(source, /dev-only-change-me/);
  assert.doesNotMatch(source, /app\.use\(cors\(\)\)/);
});

test('server handles fatal process errors and express route errors safely', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /process\.on\('unhandledRejection'/);
  assert.match(source, /process\.on\('uncaughtException'/);
  assert.match(source, /function shutdownServer/);
  assert.match(source, /httpServer\.close/);
  assert.match(source, /io\.close/);
  assert.match(source, /waitForMessageQueueIdle/);
  assert.match(source, /db\.close/);
  assert.match(source, /app\.use\(\(err,\s*req,\s*res,\s*next\)/);
  assert.match(source, /res\.status\(statusCode\)\.json/);
});

test('server invalidates JWTs with token versions and logout', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const schema = fs.readFileSync('schema.js', 'utf8');
  const adminServices = fs.readFileSync('adminServices.js', 'utf8');

  assert.match(schema, /token_version/);
  assert.match(source, /token_version/);
  assert.match(source, /app\.post\('\/api\/logout',\s*authMiddleware\(\)/);
  assert.match(source, /incrementTokenVersion/);
  assert.match(adminServices, /token_version = token_version \+ 1/);
});

test('server exposes private media and production health checks', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');

  assert.match(source, /app\.get\('\/health'/);
  assert.match(source, /app\.get\('\/media\/:filename'/);
  assert.match(source, /authMiddleware\(\)/);
  assert.match(source, /sendFile/);
  assert.doesNotMatch(source, /app\.use\('\/media',\s*express\.static/);
  assert.match(source, /CORS_ORIGIN obrigatorio em producao/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /\/health/);
});

test('server rate limits socket authentication attempts', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /socketAuthAttempts/);
  assert.match(source, /SOCKET_RATE_LIMIT_MAX/);
  assert.match(source, /Erro ao autenticar socket/);
});

test('server exposes a Socket.IO realtime layer instead of only polling', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.ok(pkg.dependencies['socket.io'], 'socket.io dependency is required');
  assert.match(source, /createServer\(app\)/);
  assert.match(source, /new Server\(httpServer/);
  assert.match(source, /function emitConversationUpdate/);
  assert.match(source, /function emitConnectionUpdate/);
  assert.match(source, /io\.on\('connection'/);
  assert.match(source, /httpServer\.listen/);
  assert.doesNotMatch(source, /app\.listen\(PORT/);
});

test('server exposes per-user search conversation state and media filter routes', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /searchVisibleContent/);
  assert.match(source, /app\.get\('\/api\/search',\s*authMiddleware\(\)/);
  assert.match(source, /app\.patch\('\/api\/conversations\/:id\/state',\s*authMiddleware\(\)/);
  assert.match(source, /updateConversationUserState/);
  assert.match(source, /mediaType:\s*req\.query\.media_type/);
});

test('server scopes typing and notification socket events to authenticated users', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /socket\.join\(userRoom\(socket\.user\)\)/);
  assert.match(source, /function userRoom/);
  assert.match(source, /function visibleUsersForConversation/);
  assert.match(source, /function emitTypingUpdate/);
  assert.match(source, /function emitNotificationForMessage/);
  assert.match(source, /socket\.on\('typing:update'/);
  assert.match(source, /isConversationMutedForUser/);
  assert.match(source, /io\.to\(userRoom\(user\)\)\.emit\('notification:new'/);
});
