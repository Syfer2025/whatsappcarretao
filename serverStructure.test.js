const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('node:vm');

test('todo caminho de download de midia repara o id antes de chamar downloadMedia', () => {
  const fs = require('node:fs');
  for (const arquivo of ['historyImporter.js', 'realtimeMediaDownloader.js']) {
    const source = fs.readFileSync(require.resolve(`./${arquivo}`), 'utf8');
    assert.match(source, /repairMessageId/, `${arquivo} deve importar e usar repairMessageId`);
    const posReparo = source.indexOf('repairMessageId(');
    const posDownload = source.search(/(?:msg|candidate)\.downloadMedia\(\)/);
    assert.ok(posReparo > -1 && posDownload > -1, `${arquivo}: pontos nao encontrados`);
    assert.ok(
      posReparo < posDownload,
      `${arquivo}: o reparo do id tem de vir ANTES do downloadMedia`
    );
  }
});

test('boot restoration skips auth directories explicitly left at an unpaired QR', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  assert.match(source, /await waManager\.hasRestorableSession\(tenant\.id\)/);
  assert.doesNotMatch(source, /fs\.readdirSync\(authPath\)/);
});

test('server keeps tenant status authenticated and qr-free and exposes admin connection endpoints', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /app\.get\('\/api\/status',\s*tenantAuthMiddleware\(\)/);
  assert.match(source, /getTenantConnectionStatus\(req\.user\.tenant_id/);
  assert.match(source, /qr:\s*null/);
  assert.match(source, /app\.get\('\/api\/admin\/connection',\s*tenantAuthMiddleware\(\['admin'\]\)/);
  assert.match(source, /app\.post\('\/api\/admin\/reset-whatsapp',\s*tenantAuthMiddleware\(\['admin'\]\)/);
  assert.match(source, /app\.post\('\/api\/admin\/import-history',\s*tenantAuthMiddleware\(\['admin'\]\)/);
});

test('server exposes sectors and user management routes for admin', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /app\.get\('\/api\/sectors',\s*tenantAuthMiddleware\(\['admin'\]\)/);
  assert.match(source, /app\.post\('\/api\/sectors',\s*tenantAuthMiddleware\(\['admin'\]\)/);
  assert.match(source, /app\.put\('\/api\/sectors\/:id',\s*tenantAuthMiddleware\(\['admin'\]\)/);
  assert.match(source, /createUser/);
  assert.match(source, /updateUser/);
  assert.match(source, /assignConversation/);
});

test('completed tenant activation is never deleted by post-activation audit or response failures', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const publicRegistration = source.match(/app\.post\('\/api\/register'[\s\S]*?\/\/ ==================================================/)?.[0] || '';
  const manualRegistration = source.match(/app\.post\('\/api\/tenants'[\s\S]*?app\.put\('\/api\/tenants\/:id'/)?.[0] || '';
  for (const route of [publicRegistration, manualRegistration]) {
    const activation = route.indexOf('activateTenant(');
    const disarm = route.indexOf('compensationEligible = false', activation);
    const audit = route.indexOf('logAudit(', activation);
    assert.ok(activation >= 0 && disarm > activation, 'activation must disarm provisioning compensation');
    assert.ok(audit < 0 || disarm < audit, 'compensation must be disarmed before post-activation audit');
    assert.match(route, /if \(createdTenant && compensationEligible\)/);
  }
});

test('public signup proves humanity and abandoned Stripe reservations cannot consume capacity forever', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const billing = fs.readFileSync('billing.js', 'utf8');
  const tenants = fs.readFileSync('tenantManager.js', 'utf8');
  const publicRegistration = source.match(/app\.post\('\/api\/register'[\s\S]*?\/\/ ==================================================/)?.[0] || '';
  assert.match(publicRegistration, /await verifyTurnstileToken\(/);
  assert.match(publicRegistration, /runtimeTenantLimit:/);
  const billingGuard = publicRegistration.indexOf("code: 'BILLING_NOT_CONFIGURED'");
  const tenantCreation = publicRegistration.indexOf('createTenant({');
  assert.ok(billingGuard >= 0 && billingGuard < tenantCreation, 'billing must be checked before tenant provisioning');
  assert.match(publicRegistration, /req\.body && typeof req\.body === 'object' && !Array\.isArray\(req\.body\)/);
  assert.match(source, /signupBillingConfigured:\s*process\.env\.NODE_ENV !== 'production' \|\| isBillingConfigured\(\)/);
  assert.match(source, /signupConfigured:\s*isPublicSignupConfigured\(\)/);
  assert.match(publicRegistration, /challenge\.status\.reason !== 'disabled'/);
  assert.match(publicRegistration, /code: 'SIGNUP_CONFIGURATION_INVALID'/);
  assert.match(source, /function isBillingConfigured\(\)[\s\S]*getBillingConfigurationStatus\(effective\)\.configured/);
  assert.match(publicRegistration, /err\.code === 'SIGNUP_CHALLENGE_UNAVAILABLE'[\s\S]*res\.status\(503\)/);
  assert.match(publicRegistration, /err\.code === 'TENANT_RUNTIME_CAPACITY_REACHED'/);
  assert.match(publicRegistration, /if \(billingCheckoutStarted\)[\s\S]*code: 'BILLING_UNAVAILABLE'/);
  assert.match(source, /function validatePlatformConfigSet\(updates\)/);
  assert.match(source, /getBillingConfigurationStatus\(effective\)/);
  assert.match(source, /errors\.push\(\.\.\.validatePlatformConfigSet\(updates\)\)/);
  assert.match(source, /validateStripeSecretRotation\(updates, effective\)/);
  assert.match(source, /await require\('\.\/billing'\)\.validateStripeConfigurationConnectivity\(effective\)/);
  assert.match(source, /err\.code === 'STRIPE_CONFIGURATION_UNAVAILABLE'/);
  assert.match(billing, /expires_at: checkoutExpiresAt/);
  assert.match(billing, /releaseExpiredCheckoutReservation/);
  assert.match(source, /listExpiredCheckoutReservations/);
  assert.match(source, /if \(!release\.released\)/);
  assert.match(tenants, /checkout_expires_at/);
});

test('tenant admin routes fail closed for platform superadmins and coordinate identity changes transactionally', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const vendorRoutes = source.match(/app\.post\('\/api\/vendors'[\s\S]*?app\.get\('\/api\/admin\/statistics'/)?.[0] || '';

  assert.match(source, /function requireTenantAdmin\(req,\s*res\)/);
  assert.match(source, /req\.user\?\.super_admin/);
  assert.match(source, /Number\(req\.tenant\?\.id\) !== Number\(req\.user\.tenant_id\)/);
  assert.match(source, /app\.get\('\/api\/status'[\s\S]*?if \(!requireTenantMember\(req, res\)\) return/);
  assert.ok(
    (source.match(/if \(!requireTenantAdmin\(req, res\)\) return;/g) || []).length >= 10,
    'tenant-only routes should explicitly reject platform admins'
  );
  assert.match(vendorRoutes, /normalizeUsername\(req\.body\.username\)/);
  assert.match(vendorRoutes, /SELECT 1 FROM admins WHERE username = \? COLLATE NOCASE/);
  assert.match(vendorRoutes, /onBeforeCommit: created => \{[\s\S]*registerDirectoryUser/);
  assert.match(vendorRoutes, /onBeforeCommit: \(updated, existing\) =>/);
  assert.equal(
    (vendorRoutes.match(/withTenantCapacityLock\(tenantId,/g) || []).length,
    2,
    'create and update/reactivation must share the master-to-tenant capacity lock'
  );
  assert.match(vendorRoutes, /tenantUserInserted[\s\S]*DELETE FROM vendors/);
  assert.match(vendorRoutes, /tenantUserUpdated[\s\S]*vendor_update_recovered/);
  assert.match(vendorRoutes, /expectedVersion: parseExpectedRowVersion\(req\.body\.row_version\)/);
  assert.match(source, /function parseExpectedRowVersion\(value\)/);
  assert.match(vendorRoutes, /deactivateUser\(\{/);
  assert.match(vendorRoutes, /vendor_created/);
  assert.match(vendorRoutes, /vendor_updated/);
  assert.match(vendorRoutes, /vendor_deactivated/);
  assert.match(source, /JOIN sectors s ON s\.id = v\.sector_id AND s\.active = 1/);
  assert.match(source, /WHERE v\.username = \? COLLATE NOCASE AND v\.active = 1/);
});

test('server exposes contact directory, profile, new conversation and synchronized archive routes', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const manager = fs.readFileSync('whatsappManager.js', 'utf8');

  assert.match(source, /app\.get\('\/api\/contacts',\s*tenantAuthMiddleware\(\)/);
  assert.match(source, /app\.post\('\/api\/contacts\/sync'/);
  assert.match(source, /app\.post\('\/api\/conversations\/start'/);
  assert.match(source, /getNumberId/);
  assert.match(source, /app\.get\('\/api\/conversations\/:id\/profile'/);
  assert.match(source, /syncConversationProfile/);
  assert.match(source, /app\.patch\('\/api\/conversations\/:id\/archive'/);
  assert.match(source, /setWhatsAppConversationArchived/);
  assert.match(source, /handleChatArchived/);
  assert.match(manager, /client\.on\('chat_archived'/);
  assert.match(source, /scheduleTenantContactsSync/);
});

test('server identifies group senders and notifies every member of the assigned department', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /participant_id/);
  assert.match(source, /getIncomingParticipantInfo/);
  assert.match(source, /participant_name/);
  assert.match(source, /sector_id = \?/);
  assert.match(source, /profilePicUrl/);
});

test('whatsapp manager is the single reconnect authority and reports connection transitions', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const manager = fs.readFileSync('whatsappManager.js', 'utf8');

  assert.doesNotMatch(source, /function scheduleWhatsAppReconnect/);
  assert.doesNotMatch(source, /function restartWhatsAppClient/);
  assert.match(manager, /function scheduleReconnect/);
  assert.match(manager, /reconnectTotal/);
  assert.match(manager, /client\.on\('disconnected',\s*reason\s*=>/);
  assert.match(source, /lastConnectionMessage/);
  assert.match(manager, /takeoverOnConflict:\s*true/);
});

test('server does not auto-reply to incoming customer messages', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.doesNotMatch(source, /msg\.reply\(/);
  assert.doesNotMatch(source, /vendedor entrará em contato/i);
});

test('server hardens whatsapp initialization and history import against stale clients', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const manager = fs.readFileSync('whatsappManager.js', 'utf8');

  assert.match(manager, /WHATSAPP_INIT_TIMEOUT_MS/);
  assert.match(manager, /withTimeout\(client\.initialize\(\),\s*WHATSAPP_INIT_TIMEOUT_MS/);
  assert.match(source, /async function runHistoryImport\(\{ retryUnavailableMedia = false, client, tenantId \} = \{\}\)/);
  assert.doesNotMatch(source, /runHistoryImport\(\{[^}]*client = whatsapp/);
  assert.match(source, /typeof targetClient\.getChats !== 'function'/);
  assert.match(source, /const currentClient = waManagerReady \? waManager\.getReadyClient\(tenantId\) : null/);
  assert.match(source, /runHistoryImport\(\{ client: currentClient,\s*tenantId \}\)/);
  assert.match(source, /tenantSyncGenerations\.get\(key\) !== generation/);
});

test('server reconciles recent whatsapp chats and handles message_create events', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const recentSyncSource = source.match(/async function runRecentTenantSync[\s\S]*?function scheduleFullTenantReconcile/)?.[0] || '';

  assert.match(source, /RECENT_SYNC_INTERVAL_MS/);
  assert.match(source, /function scheduleRecentTenantSync/);
  assert.match(source, /function runRecentTenantSync/);
  assert.match(source, /maxChats:\s*RECENT_SYNC_CHAT_LIMIT/);
  assert.match(recentSyncSource, /skipMediaDownload:\s*true/);
  assert.match(recentSyncSource, /adaptiveBackfill:\s*true/);
  assert.match(recentSyncSource, /maxFetchLimit:\s*RECENT_SYNC_MAX_FETCH_LIMIT/);
  assert.match(source, /shouldProcessMessageEvent\(msg,\s*source\)/);
  assert.match(source, /msg\.fromMe && isImportableChatId\(msg\.to\) \? msg\.to : msg\.from/);
  assert.match(source, /findMatchingPendingOutboundMessage/);
  assert.match(source, /if \(inserted\)[\s\S]*emitNewMessage\(conv\.id,\s*messageId\)/);
  assert.match(source, /downloadRealtimeMediaWithRetry\(\{/);
  assert.match(source, /scheduleRealtimeMediaRepair\(tenantId,\s*messageId\)/);
  assert.match(source, /scheduleRecentMissingMediaRepairs\(tenantId\)/);
  assert.match(source, /const incomingMessageInFlight = new Set\(\)/);
  assert.match(source, /isRealtimeMessageTimestamp\(msg\.timestamp\)/);
  assert.match(source, /scheduleImportConversationUpdate\(tenantId,\s*conv\.id\)/);
  assert.match(source, /app\.post\('\/api\/conversations\/:id\/sync'/);
  assert.match(source, /syncConversationFromWhatsApp/);
  assert.match(source, /getChatById/);
  assert.match(source, /CONVERSATION_SYNC_MESSAGE_LIMIT/);
  assert.match(source, /CONVERSATION_SYNC_SETTLE_MS/);
  assert.match(source, /openChatWindow/);
  assert.match(source, /syncHistory/);
});

test('all forwarding uses the durable outbox and realtime media has targeted repair', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const forwardRoute = source.match(/app\.post\('\/api\/messages\/:id\/forward'[\s\S]*?app\.delete\('\/api\/messages\/:id'/)?.[0] || '';

  assert.match(forwardRoute, /forwardStoredMessageFallback\(\{ source, target, client, user: req\.user \}\)/);
  assert.match(forwardRoute, /res\.status\(201\)\.json\(\{ ok: true, forwarded_natively: false, message: forwarded \}\)/);
  assert.doesNotMatch(forwardRoute, /liveMessage\.forward|forwarded_natively:\s*true/);
  assert.match(source, /inboundMediaLimiter\.run\(tenantId/);
  assert.match(source, /function repairRealtimeMessageMedia/);
  assert.match(source, /client\.getMessageById\(stored\.external_id\)/);
  assert.match(source, /materializeDownloadedMedia/);
  assert.match(source, /emitConversationUpdate\(materialized\.conversation_id\)/);
  assert.match(source, /timer direcionado[\s\S]*?attempts:\s*1/);
  assert.match(source, /for \(const scheduled of realtimeMediaRepairTimers\.values\(\)\) clearTimeout/);
});

test('late media enrichment cannot resurrect a revoked message or leave its file referenced', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const start = source.indexOf('function materializeDownloadedMedia');
  const end = source.indexOf('function realtimeMediaRepairDelayMs', start);
  const materialization = source.slice(start, end);

  assert.match(materialization, /SELECT id, conversation_id, content, media_url, deleted_for_everyone/);
  assert.match(materialization, /Number\(current\.deleted_for_everyone\) === 1/);
  assert.match(materialization, /AND COALESCE\(deleted_for_everyone, 0\) = 0/);
  assert.match(materialization, /if \(!updated\.changes\) removeIfUnreferenced\(\)/);
  assert.match(materialization, /removeStoredTenantMediaSync/);
  assert.match(source, /markMessageDeletedForEveryone\(\{[\s\S]*?mediaRoot: MEDIA_ROOT/);
});

test('server starts manual history import in background', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const handlerSource = source.match(/async function handleImportHistory[\s\S]*?app\.post\('\/api\/import-history'/)?.[0] || '';

  assert.match(source, /function startHistoryImportInBackground/);
  assert.match(source, /function emitHistoryImportStatus/);
  assert.match(source, /CHAT_IMPORT_DELAY_MS/);
  assert.match(handlerSource, /startHistoryImportInBackground\(\{ retryUnavailableMedia: true,\s*client,\s*tenantId,\s*source: 'manual' \}\)/);
  assert.match(handlerSource, /res\.status\(202\)\.json/);
  assert.doesNotMatch(handlerSource, /await runHistoryImport/);
});

test('whatsapp chromium launch args keep sandbox enabled in production by default', () => {
  const manager = fs.readFileSync('whatsappManager.js', 'utf8');

  assert.match(manager, /function shouldDisableChromiumSandbox\(\)/);
  assert.match(manager, /function buildChromiumLaunchArgs\(/);
  assert.match(manager, /const disableSandbox = shouldDisableChromiumSandbox\(\)/);
  assert.match(manager, /if \(disableSandbox\) \{[\s\S]*--no-sandbox[\s\S]*--disable-setuid-sandbox/);
  assert.match(manager, /args: buildChromiumLaunchArgs\(\{ proxyServer \}\)/);
  assert.doesNotMatch(manager, /args:\s*\['--no-sandbox'/);
  assert.doesNotMatch(manager, /browserWSEndpoint|sharedBrowser/);
});

test('whatsapp manager health monitor schedules persistent recovery', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const manager = fs.readFileSync('whatsappManager.js', 'utf8');

  assert.doesNotMatch(source, /MAX_STATE_CHECK_FAILURES/);
  assert.match(manager, /HEALTH_CHECK_MAX_FAILURES/);
  assert.match(manager, /health_check_failed/);
  assert.match(manager, /scheduleReconnect\(tenantId, s\)/);
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
  assert.match(source, /sanitizeHttpResponse/);
  assert.match(source, /res\.headers\["set-cookie"\]/);
  assert.match(source, /req\.headers\["x-csrf-token"\]/);
  assert.match(source, /TRUST_PROXY/);
  assert.match(source, /app\.set\('trust proxy'/);
  assert.match(source, /validateRuntimeConfig/);
  assert.match(source, /randomBytes\(32\)/);
  assert.doesNotMatch(source, /dev-only-change-me/);
  assert.doesNotMatch(source, /app\.use\(cors\(\)\)/);
});

test('server applies core browser security headers', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.ok(pkg.dependencies.helmet, 'helmet dependency is required');
  assert.match(source, /helmet\(/);
  assert.match(source, /contentSecurityPolicy/);
  assert.match(source, /frameAncestors/);
  assert.match(source, /hsts/);
  assert.match(source, /imgSrc:\s*\[[^\]]*https:\/\/pps\.whatsapp\.net/);
  // As telas de login/cadastro carregam a fonte Inter do Google Fonts; sem
  // estas origens o CSP bloqueia o stylesheet e os arquivos de fonte.
  assert.match(source, /styleSrc:\s*\[[^\]]*https:\/\/fonts\.googleapis\.com/);
  assert.match(source, /fontSrc:\s*\[[^\]]*https:\/\/fonts\.gstatic\.com/);
});

test('server does not force browser HTTPS upgrades on direct HTTP deployments', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /upgradeInsecureRequests:\s*null/);
  assert.doesNotMatch(source, /upgradeInsecureRequests:\s*process\.env\.NODE_ENV === 'production'/);
});

test('auth cookie is httpOnly and mutation routes use csrf protection', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /httpOnly:\s*true/);
  assert.match(source, /function setAuthCookie[\s\S]*?sameSite:\s*'lax'/);
  assert.match(fs.readFileSync('csrf.js', 'utf8'), /sameSite:\s*'strict'/);
  assert.match(source, /createCsrfMiddleware/);
  assert.match(source, /issueCsrfToken/);
  assert.match(source, /const csrfMiddleware = createCsrfMiddleware/);
  assert.match(source, /app\.get\('\/api\/csrf-token'/);
  assert.match(source, /app\.use\('\/api',\s*csrfMiddleware\)/);
});

test('secure cookies depend on the actual request transport or explicit override', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /function isSecureCookie\(req\)/);
  assert.match(source, /process\.env\.COOKIE_SECURE === 'true'/);
  assert.match(source, /process\.env\.COOKIE_SECURE === 'false'/);
  assert.match(source, /req\?\.secure/);
  assert.match(source, /x-forwarded-proto/);
  assert.match(source, /setAuthCookie\(req,\s*res,\s*token\)/);
  assert.doesNotMatch(source, /return process\.env\.COOKIE_SECURE === 'true' \|\| process\.env\.NODE_ENV === 'production'/);
});

test('server does not expose JWTs outside httpOnly cookies', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.doesNotMatch(source, /headers\.authorization\?\.replace\('Bearer '/);
  assert.doesNotMatch(source, /socket\.handshake\.auth\?\.token/);
  assert.doesNotMatch(source, /res\.json\(\{\s*token,/);
  assert.doesNotMatch(source, /return res\.json\(\{\s*token,/);
});

test('server renders qr codes locally without putting qr tokens in urls', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /app\.post\('\/api\/qrcode',\s*authMiddleware\(\['admin'\]\)/);
  assert.match(source, /req\.body\?\.data/);
  assert.match(source, /Cache-Control',\s*'no-store'/);
  assert.doesNotMatch(source, /app\.get\('\/api\/qrcode'/);
  assert.doesNotMatch(source, /req\.query\.data/);
});

test('server handles fatal process errors and express route errors safely', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /function sendInternalError\(res\)/);
  assert.doesNotMatch(source, /res\.status\(500\)\.json\(\{\s*error:\s*err\.message\s*\}\)/);
  assert.match(source, /process\.on\('unhandledRejection'/);
  assert.match(source, /waManager\.recoverUnhandledRuntimeError\(error\)/);
  assert.match(source, /process\.on\('uncaughtException'/);
  assert.match(source, /function shutdownServer/);
  assert.match(source, /httpServer\.close/);
  assert.match(source, /io\.close/);
  assert.match(source, /drainMessageQueues/);
  assert.match(source, /closeAllDbs/);
  assert.match(source, /app\.use\(\(err,\s*req,\s*res,\s*next\)/);
  assert.match(source, /res\.status\(statusCode\)\.json/);
});

test('writer lease loss discards runtime work immediately and exits non-zero without graceful queue drain', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const shutdownStart = source.indexOf('async function shutdownServer');
  const shutdownEnd = source.indexOf("process.once('SIGINT'", shutdownStart);
  const shutdown = source.slice(shutdownStart, shutdownEnd);

  assert.match(shutdown, /if \(discardWork\) \{[\s\S]*abortMessageQueues/);
  assert.match(shutdown, /incomingEnrichmentQueue\.close\(\{ discardPending: true \}\)/);
  assert.match(shutdown, /inboundMediaLimiter\.close\(\)/);
  assert.match(shutdown, /closeRuntimeDatabases\(\)/);
  assert.match(shutdown, /if \(!discardWork\) \{[\s\S]*drainMessageQueues/);
  assert.match(source, /process\.once\(PRODUCTION_WRITER_LEASE_LOST_EVENT,[\s\S]*exitCode|singleWriterLeaseLost/);
  assert.match(source, /shutdownServer\('singleWriterLeaseLost', error, 1, \{ discardWork: true \}\)/);
  assert.match(source, /SIGTERM[\s\S]*fatalExitCode[\s\S]*discardWork: fatalExitCode !== 0/);
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

test('every login gets a browser session and account switching removes only the stale browser socket', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const issuer = source.match(/function issueAuthenticatedSession[\s\S]*?\n\}/)?.[0] || '';

  assert.equal(
    (source.match(/issueAuthenticatedSession\(req, res, \{/g) || []).length,
    4,
    'register, platform admin, tenant admin and vendor must use the same hardened issuer'
  );
  assert.match(issuer, /session_id:\s*crypto\.randomUUID\(\)/);
  assert.match(issuer, /disconnectPreviousBrowserSession\(req, principal\)[\s\S]*jwt\.sign\(principal/);
  assert.match(source, /const previousSessionRoom = sessionRoom\(previousUser, previousUser\.tenant_id\)/);
  assert.match(source, /io\.to\(previousSessionRoom\)\.emit\('auth:session-replaced'\)/);
  assert.match(source, /io\.in\(previousSessionRoom\)\.disconnectSockets\(true\)/);
  assert.match(source, /io\.in\(identityRoom\(user, user\.tenant_id\)\)\.disconnectSockets\(true\)/);
});

test('server validates numeric route ids and audits security-sensitive events', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /function parsePositiveInt\(value,\s*label/);
  assert.match(source, /function parseOptionalPositiveInt\(value,\s*label/);
  assert.match(source, /function auditSecurityEvent\(req,\s*action/);
  assert.match(source, /const actor = req\.user\s*\?/);
  assert.doesNotMatch(source, /const actor = detail\.username \|\| req\.user/);
  assert.match(source, /login_success/);
  assert.match(source, /login_failed/);
  assert.match(source, /logout/);
  assert.match(source, /password_reset_requested/);
  assert.match(source, /password_reset_resolved/);
  assert.match(source, /whatsapp_connection_start/);
  assert.doesNotMatch(source, /const tenantId = Number\(req\.params\.id\);/);
});

test('tenant settings cannot turn Chromium into an arbitrary proxy and never reveal the operational proxy', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const settings = fs.readFileSync('frontend/settings.html', 'utf8');

  assert.doesNotMatch(source, /function validateProxyServer/);
  assert.match(source, /settings\.proxy_server/);
  assert.match(source, /delete publicSettings\.proxy_server/);
  assert.doesNotMatch(settings, /id="proxyServer"/);
  assert.doesNotMatch(settings, /data\.proxy_server/);
  assert.doesNotMatch(settings, /proxy_server:\s*document\.getElementById\('proxyServer'\)\.value/);
});

test('server exposes private media and production health checks', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');

  assert.match(source, /app\.get\('\/health'/);
  assert.match(source, /app\.get\('\/media\/:filename'/);
  assert.match(source, /app\.get\('\/media\/:filename',\s*tenantAuthMiddleware\(\)/);
  assert.match(source, /sendFile/);
  assert.doesNotMatch(source, /app\.use\('\/media',\s*express\.static/);
  assert.match(source, /missing\.push\('CORS_ORIGIN'\)/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /\/health/);
});

test('server rate limits socket authentication attempts', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /socketAuthAttempts/);
  assert.match(source, /createSocketRateLimiter/);
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
  assert.match(source, /app\.get\('\/api\/search',\s*tenantAuthMiddleware\(\)/);
  assert.match(source, /app\.patch\('\/api\/conversations\/:id\/state',\s*tenantAuthMiddleware\(\)/);
  assert.match(source, /updateConversationUserState/);
  assert.match(source, /mediaType:\s*req\.query\.media_type/);
});

test('manual contact sync is serialized per tenant and quarantines uncancelled Chromium work', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const directory = fs.readFileSync('whatsappDirectory.js', 'utf8');

  assert.match(source, /const contactSyncRunning = new Map\(\)/);
  assert.match(source, /CONTACT_SYNC_MANUAL_COOLDOWN_MS/);
  assert.match(source, /CONTACT_SYNC_IN_PROGRESS/);
  assert.match(source, /CONTACT_SYNC_QUARANTINED/);
  assert.match(source, /activeSync\?\.client === client/);
  assert.match(source, /contactSyncRunning\.get\(key\)\?\.token === token/);
  assert.match(directory, /Object\.defineProperty\(error, 'pendingOperation'/);
});

test('server scopes typing and notification socket events to authenticated users', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /socket\.join\(sessionRoom\(socket\.user,\s*socket\.user\.tenant_id\)\)/);
  assert.match(source, /socket\.join\(identityRoom\(socket\.user,\s*socket\.user\.tenant_id\)\)/);
  assert.match(source, /socket\.join\(userRoom\(socket\.user,\s*socket\.tenantId\)\)/);
  assert.match(source, /function userRoom/);
  assert.match(source, /function visibleUsersForConversation/);
  assert.match(source, /function emitTypingUpdate/);
  assert.match(source, /function emitNotificationForMessage/);
  assert.match(source, /socket\.on\('typing:update'/);
  assert.match(source, /isConversationMutedForUser/);
  assert.doesNotMatch(source, /io\.to\(userRoom\(user\)\)\.emit/);
  assert.match(source, /io\.to\(userRoom\(user,\s*tenantId\)\)\.emit\('typing:update'/);
  assert.match(source, /io\.to\(userRoom\(user,\s*tenantId\)\)\.emit\('notification:new'/);
});

test('socket rooms expose conversation metadata and presence only to their authorized audience', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const connection = source.match(/io\.on\('connection'[\s\S]*?app\.get\('\/api\/status'/)?.[0] || '';

  assert.match(source, /function tenantAdminRoom\(tenantId\)/);
  assert.match(source, /function tenantOperationalRoom\(tenantId\)/);
  assert.match(source, /function emitToConversationAudience\(event, payload, conversationId/);
  assert.match(source, /visibleUsersForConversation\(conversation\)/);
  assert.match(source, /if \(user\.role !== 'vendor'\) continue/);
  assert.match(source, /io\.to\(tenantAdminRoom\(tenantId\)\)\.emit\('presence:changed'/);
  assert.match(connection, /socket\.join\(tenantOperationalRoom\(socket\.tenantId\)\)/);
  assert.match(connection, /if \(socket\.user\.role === 'admin'\) socket\.join\(tenantAdminRoom\(socket\.tenantId\)\)/);
  assert.doesNotMatch(connection, /socket\.join\(`tenant:\$\{socket\.tenantId\}`\)/);
  assert.match(connection, /if \(socket\.user\.role === 'admin'\) \{[\s\S]*socket\.emit\('presence:changed'/);
});

test('socket handshake validates browser origin before authentication', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  // Atualizado em 04/set/2026: as asserções antigas congelavam o formato em que
  // origem AUSENTE era recusada em producao. Navegador nao envia Origin em GET
  // same-origin — o transporte polling do socket.io — entao aquilo recusava
  // toda conexao do painel (403) e zerava o tempo real. A validacao agora cai
  // no Host, que o navegador nao deixa forjar.
  assert.match(source, /function isSocketOriginAllowed\(origin, host\)/);
  assert.match(source, /allowRequest\(request, callback\)/);
  // Os DOIS pontos de checagem precisam receber o host, senao um deles recusa.
  assert.match(source, /isSocketOriginAllowed\(request\.headers\?\.origin, request\.headers\?\.host\)/);
  assert.match(source, /if \(!isSocketOriginAllowed\(socket\.handshake\.headers\?\.origin, socket\.handshake\.headers\?\.host\)\)/);
  // Origem presente continua conferida contra a lista exata.
  assert.match(source, /return allowedOrigins\.includes\(normalizedOrigin\)/);
});

test('support channel is tenant-admin-only and delete-for-everyone enforces message authorship', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const deletion = source.match(/app\.delete\('\/api\/messages\/:id'[\s\S]*?app\.get\('\/api\/messages\/starred'/)?.[0] || '';
  const authorCheck = deletion.indexOf("req.user.role === 'vendor'");
  const whatsappLookup = deletion.indexOf('waManager.getReadyClient');

  assert.match(source, /app\.get\('\/support-media\/:filename',\s*authMiddleware\(\['admin'\]\)/);
  assert.match(source, /app\.get\('\/api\/support\/thread',\s*tenantAuthMiddleware\(\['admin'\]\)/);
  assert.match(source, /app\.post\('\/api\/support\/messages',\s*tenantAuthMiddleware\(\['admin'\]\)/);
  assert.match(source, /app\.patch\('\/api\/support\/thread\/read',\s*tenantAuthMiddleware\(\['admin'\]\)/);
  assert.ok(
    (source.match(/if \(!requireTenantAdmin\(req, res\)\) return;/g) || []).length >= 13,
    'support endpoints must use the same tenant-admin guard as other admin routes'
  );
  assert.match(source, /if \(socket\.user\.role === 'admin'\) socket\.join\(supportTenantRoom\(socket\.tenantId\)\)/);
  assert.ok(authorCheck >= 0 && whatsappLookup > authorCheck, 'authorship must be rejected before contacting WhatsApp');
  assert.match(deletion, /Number\(msg\.vendor_id\) !== Number\(req\.user\.id\)/);
});

test('server keeps whatsapp import state and default auto-import scoped by tenant', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const tenantManager = fs.readFileSync('tenantManager.js', 'utf8');

  assert.match(source, /const importInProgress = new Map\(\)/);
  assert.match(source, /const lastImportStats = new Map\(\)/);
  assert.match(source, /const tenantReadyTokens = new Map\(\)/);
  assert.match(source, /const tenantSyncGenerations = new Map\(\)/);
  assert.match(source, /const autoImportTimers = new Map\(\)/);
  assert.match(source, /const fullReconcileTimers = new Map\(\)/);
  assert.match(source, /const importConversationUpdateTimers = new Map\(\)/);
  assert.match(source, /const key = importKey\(tenantId\);[\s\S]*importInProgress\.get\(key\)/);
  assert.match(source, /lastImportStats\.get\(key\)/);
  assert.match(source, /runInTenantContext\(tenantId,\s*runImport\)/);
  assert.match(source, /acquireTenantDbLease\(tenantId\)/);
  assert.match(source, /releaseTenantDbLease\(tenantId\)/);
  assert.match(tenantManager, /if \(\(tenantDbLeases\.get\(tenantId\) \|\| 0\) > 0\) continue/);
  assert.match(source, /function maybeScheduleTenantAutoImport\(tenantId\)/);
  assert.match(source, /tenantReadyTokens\.get\(key\) === readyToken/);
  assert.match(source, /tenantSyncGenerations\.set\(key,\s*generation\)/);
  assert.match(source, /function scheduleImportConversationUpdate\(tenantId,\s*conversationId = null\)/);
  assert.match(source, /onConversationImported:\s*importedConversationId => scheduleImportConversationUpdate\(tenantId,\s*importedConversationId\)/);
  assert.match(source, /AUTO_IMPORT_DELAY_MS/);
  assert.match(source, /AUTO_IMPORT_MAX_ATTEMPTS/);
  assert.match(source, /function scheduleAutoHistoryImport/);
  assert.match(source, /scheduleAutoHistoryImport\(\{ tenantId,\s*generation \}\)/);
  assert.match(source, /reagendando reconciliação integral/);
  assert.match(source, /scheduleFullTenantReconcile\(tenantId,\s*generation\)/);
});

test('tenant suspension and deletion invalidate runtime work without an ABA generation reset', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const clearRuntime = source.match(/function clearTenantRuntimeState[\s\S]*?\n\}/)?.[0] || '';
  const pauseRuntime = source.match(/function pauseTenantRuntimeForBilling[\s\S]*?\n\}/)?.[0] || '';
  const webhook = source.match(/app\.post\('\/api\/webhooks\/stripe'[\s\S]*?\n\}\);/)?.[0] || '';
  const deletion = source.match(/app\.delete\('\/api\/tenants\/:id'[\s\S]*?app\.post\('\/api\/tenants\/:id\/status'/)?.[0] || '';
  const operationalStatus = source.match(/app\.post\('\/api\/tenants\/:id\/status'[\s\S]*?app\.post\('\/api\/tenants\/:id\/billing-status'/)?.[0] || '';

  assert.match(clearRuntime, /tenantSyncGenerations\.set\(key, \(tenantSyncGenerations\.get\(key\) \|\| 0\) \+ 1\)/);
  assert.doesNotMatch(clearRuntime, /tenantSyncGenerations\.delete/);
  assert.match(clearRuntime, /discardPartition\(key, \{ permanent: final \}\)/);
  assert.match(clearRuntime, /discardTenantMessageQueue\(key, \{ permanent: final \}\)/);
  assert.match(pauseRuntime, /billingPausedTenantRuntimes\.has\(normalizedTenantId\)\) return/);
  assert.match(webhook, /resumeTenantRuntimeAfterBilling\(result\.tenantId, \{ force: true \}\)/);
  assert.match(webhook, /pauseTenantRuntimeForBilling\(result\.tenantId\)/);
  assert.match(deletion, /const deletion = await deleteTenant[\s\S]*clearTenantRuntimeState\(tenantId, \{ final: true \}\)/);
  assert.match(source, /function revokeAllTenantSessions\(tenantId\)[\s\S]*UPDATE admins SET token_version = token_version \+ 1[\s\S]*UPDATE vendors SET token_version = token_version \+ 1/);
  assert.match(operationalStatus, /revokeAllTenantSessions\(tenantId\)/);
  assert.match(operationalStatus, /pauseTenantRuntimeForBilling\(tenantId\)/);
  assert.match(operationalStatus, /resumeTenantRuntimeAfterBilling\(tenantId, \{ force: true \}\)/);
});

test('server exposes resilient incremental whatsapp synchronization and recovery telemetry', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.match(source, /app\.post\('\/api\/conversations\/:id\/sync-older'/);
  assert.match(source, /FULL_SYNC_ABSOLUTE_MAX_FETCH_LIMIT/);
  assert.match(source, /resumePersistentGap:\s*false/);
  assert.match(source, /const incomingEnrichmentQueue = new PartitionedWorkQueue/);
  assert.match(source, /onMessageEdit:/);
  assert.match(source, /onMessageRevoke:/);
  assert.match(source, /onSyncNeeded:/);
  assert.match(source, /reportSessionRuntimeError\(tenantId,\s*err,\s*client\)/);
  assert.match(source, /tenantsWithConsecutiveRuntimeFailures/);
  assert.match(source, /assertSyncBatchUsable\(stats\)/);
});

test('sync runtime failure detection recognizes minified page errors via stack', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  assert.match(source, /function recordSyncRuntimeFailure[\s\S]*?isBrowserContextSyncFailure\(err\)/);

  const functionSource = source.match(/function isBrowserContextSyncFailure[\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource, 'isBrowserContextSyncFailure deve existir em server.js');
  const context = {};
  vm.createContext(context);
  new vm.Script(`${functionSource}; detect = isBrowserContextSyncFailure;`, {
    filename: 'server.js#isBrowserContextSyncFailure'
  }).runInContext(context);

  // Exceção minificada rethrow do puppeteer (produção 2026-07-15): name/message
  // são apenas "r"; só o stack identifica o contexto do navegador.
  const minified = new Error('r');
  minified.stack = [
    'r: r',
    '    at #evaluate (/app/node_modules/puppeteer-core/lib/cjs/puppeteer/cdp/ExecutionContext.js:391:56)',
    '    at async ExecutionContext.evaluate (/app/node_modules/puppeteer-core/lib/cjs/puppeteer/cdp/ExecutionContext.js:277:16)'
  ].join('\n');
  assert.equal(context.detect(minified), true);

  const timeout = new Error('getChats excedeu 15000ms');
  assert.equal(context.detect(timeout), true);

  const batchFailure = new Error('fetchMessages falhou nas 12 conversas do lote');
  assert.equal(context.detect(batchFailure), true);

  // Bug do importador/banco: reciclar a sessão do WhatsApp não ajudaria.
  const importerBug = new TypeError("Cannot read properties of undefined (reading 'length')");
  importerBug.stack = [
    "TypeError: Cannot read properties of undefined (reading 'length')",
    '    at persistChatBatch (/app/historyImporter.js:812:20)',
    '    at runRecentTenantSync (/app/server.js:4820:11)'
  ].join('\n');
  assert.equal(context.detect(importerBug), false);
});

test('whatsapp manager uses real tenant isolation without fingerprint spoofing', () => {
  const manager = fs.readFileSync('whatsappManager.js', 'utf8');

  assert.match(manager, /WA_BROWSER_MODE/);
  assert.match(manager, /function isIsolatedBrowserMode\(\)/);
  assert.match(manager, /function buildClientPuppeteerOptions/);
  assert.match(manager, /function startHealthCheck/);
  assert.match(manager, /for \(const \[tenantId,\s*s\] of sessions\)/);
  assert.match(manager, /client\.getState\(\)/);
  assert.doesNotMatch(manager, /randomizePageFingerprint/);
  assert.doesNotMatch(manager, /WebGLRenderingContext/);
  assert.doesNotMatch(manager, /HTMLCanvasElement/);
  assert.doesNotMatch(manager, /AudioContext/);
});

test('server does not keep unused single-tenant whatsapp client wiring', () => {
  const source = fs.readFileSync('server.js', 'utf8');

  assert.doesNotMatch(source, /function createWhatsAppClient/);
  assert.doesNotMatch(source, /function registerWhatsAppEvents/);
  assert.doesNotMatch(source, /async function resetWhatsAppSession/);
  assert.doesNotMatch(source, /const \{ Client,\s*LocalAuth \} = require\('whatsapp-web\.js'\)/);
});
