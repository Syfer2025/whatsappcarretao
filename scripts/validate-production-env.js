'use strict';

const { validateCapacityConfiguration } = require('./validate-host-capacity');
const { validateTotpSecret } = require('../totp');
const { isInternalEdition } = require('../internalEdition');
const { getTurnstileConfigurationStatus } = require('../signupProtection');

const PLACEHOLDER_PATTERN = /(CHANGE_ME|REPLACE_ME|EXAMPLE|YOUR_|<[^>]+>|XXX)/i;
const PUBLIC_HOST_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function valueOf(env, name, fallback = '') {
  const value = env[name];
  return value === undefined || value === null ? fallback : String(value).trim();
}

function isPositiveInteger(value) {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function validateProductionEnv(env = process.env) {
  const errors = [];
  const appMode = valueOf(env, 'APP_MODE', 'commercial').toLowerCase();
  const internalMode = appMode === 'internal';
  if (!['commercial', 'internal'].includes(appMode)) {
    errors.push('APP_MODE deve ser commercial ou internal');
  }
  if (internalMode && valueOf(env, 'INTERNAL_SINGLE_TENANT').toLowerCase() !== 'true') {
    errors.push('INTERNAL_SINGLE_TENANT deve ser true no modo internal');
  }
  const required = [
    'DOMAIN',
    'APP_URL',
    'CORS_ORIGIN',
    'JWT_SECRET',
    'ADMIN_USERNAME',
    'ADMIN_PASSWORD',
    // SUPERADMIN_TOTP_SECRET tornou-se opcional em 15/jul/2026 por decisão do
    // dono da plataforma: presente = 2FA obrigatório no login do super admin;
    // ausente = login somente com e-mail e senha. O formato continua validado
    // abaixo quando fornecido.
    // Stripe e Turnstile são configurados em runtime pelo super admin (guardados
    // criptografados no master.db), então não são mais exigidos no ambiente. As
    // validações de formato abaixo continuam valendo se forem fornecidos por env.
  ];

  for (const name of required) {
    const value = valueOf(env, name);
    if (!value) errors.push(`defina ${name}`);
    else if (PLACEHOLDER_PATTERN.test(value)) errors.push(`${name} ainda contém um placeholder`);
  }

  const jwtSecret = valueOf(env, 'JWT_SECRET');
  const adminUsername = valueOf(env, 'ADMIN_USERNAME');
  const adminPassword = valueOf(env, 'ADMIN_PASSWORD');
  if (jwtSecret && jwtSecret.length < 32) errors.push('JWT_SECRET deve ter ao menos 32 caracteres aleatórios');
  if (adminPassword && Array.from(adminPassword).length < 12) {
    errors.push('ADMIN_PASSWORD deve ter ao menos 12 caracteres');
  }
  if (adminPassword && Buffer.byteLength(adminPassword, 'utf8') > 72) {
    errors.push('ADMIN_PASSWORD deve ter no máximo 72 bytes UTF-8');
  }
  if (adminPassword && /^(admin|password|senha|123456)/i.test(adminPassword)) {
    errors.push('ADMIN_PASSWORD não pode ser uma senha comum');
  }
  if (adminPassword && adminPassword === adminUsername) {
    errors.push('ADMIN_PASSWORD não pode ser igual ao usuário admin');
  }
  if (jwtSecret && adminPassword && jwtSecret === adminPassword) {
    errors.push('JWT_SECRET e ADMIN_PASSWORD devem ser diferentes');
  }
  const superAdminTotpSecret = valueOf(env, 'SUPERADMIN_TOTP_SECRET');
  if (superAdminTotpSecret && !PLACEHOLDER_PATTERN.test(superAdminTotpSecret)) {
    try {
      validateTotpSecret(superAdminTotpSecret);
    } catch (error) {
      errors.push(`SUPERADMIN_TOTP_SECRET invalido: ${error.message}`);
    }
  }

  if (!internalMode) {
    const stripeSecret = valueOf(env, 'STRIPE_SECRET_KEY');
    const stripeWebhookSecret = valueOf(env, 'STRIPE_WEBHOOK_SECRET');
    if (stripeSecret && !/^sk_live_[A-Za-z0-9]+$/.test(stripeSecret)) {
      errors.push('STRIPE_SECRET_KEY deve ser uma chave de produção iniciada por sk_live_');
    }
    if (stripeWebhookSecret && !/^whsec_[A-Za-z0-9]+$/.test(stripeWebhookSecret)) {
      errors.push('STRIPE_WEBHOOK_SECRET deve começar com whsec_');
    }

    const turnstileValues = ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY']
      .map(name => [name, valueOf(env, name)]);
    const turnstileHasPlaceholder = turnstileValues.some(([name, value]) => {
      if (!value || !PLACEHOLDER_PATTERN.test(value)) return false;
      errors.push(`${name} ainda contém um placeholder`);
      return true;
    });
    if (!turnstileHasPlaceholder) {
      const turnstileStatus = getTurnstileConfigurationStatus(env, { production: true });
      const messages = {
        partial_configuration: 'TURNSTILE_SITE_KEY e TURNSTILE_SECRET_KEY devem ser configuradas juntas',
        invalid_key: 'TURNSTILE_SITE_KEY e TURNSTILE_SECRET_KEY devem ser chaves Turnstile validas',
        test_key_in_production: 'TURNSTILE_SITE_KEY nao pode usar uma chave de teste em produção'
      };
      if (!turnstileStatus.configured && turnstileStatus.reason !== 'disabled') {
        errors.push(messages[turnstileStatus.reason] || 'configuração Turnstile invalida');
      }
    }

    const fallbackPrice = valueOf(env, 'STRIPE_PRICE_ID');
    const basicPrice = valueOf(env, 'STRIPE_PRICE_ID_BASIC');
    const proPrice = valueOf(env, 'STRIPE_PRICE_ID_PRO');
    const configuredPrices = [
      ['STRIPE_PRICE_ID', fallbackPrice],
      ['STRIPE_PRICE_ID_BASIC', basicPrice],
      ['STRIPE_PRICE_ID_PRO', proPrice],
    ];
    for (const [name, value] of configuredPrices) {
      if (!value) continue;
      if (PLACEHOLDER_PATTERN.test(value)) errors.push(`${name} ainda contém um placeholder`);
      else if (!/^price_[A-Za-z0-9]+$/.test(value)) errors.push(`${name} deve começar com price_`);
    }
    // No modo comercial, valores fornecidos por ambiente continuam sujeitos a
    // validação de formato e coerência, ainda que possam vir do painel.
    if (fallbackPrice && (basicPrice || proPrice)) {
      errors.push('configure STRIPE_PRICE_ID sozinho OU BASIC/PRO, sem misturar os modos');
    }
    if (basicPrice && proPrice && basicPrice === proPrice) {
      errors.push('STRIPE_PRICE_ID_BASIC e STRIPE_PRICE_ID_PRO devem ser diferentes');
    }
  }

  const domain = valueOf(env, 'DOMAIN').toLowerCase();
  if (domain && !PUBLIC_HOST_PATTERN.test(domain)) {
    errors.push('DOMAIN deve ser um hostname público válido, sem protocolo ou caminho');
  }

  let appUrl = null;
  const rawAppUrl = valueOf(env, 'APP_URL');
  if (rawAppUrl) {
    try {
      appUrl = new URL(rawAppUrl);
      if (
        appUrl.protocol !== 'https:' ||
        appUrl.hostname.toLowerCase() !== domain ||
        appUrl.port ||
        appUrl.username ||
        appUrl.password ||
        appUrl.search ||
        appUrl.hash ||
        !['', '/'].includes(appUrl.pathname)
      ) {
        errors.push('APP_URL deve ser exatamente a origem HTTPS do DOMAIN');
      }
    } catch {
      errors.push('APP_URL inválida');
    }
  }

  const origins = valueOf(env, 'CORS_ORIGIN')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (valueOf(env, 'CORS_ORIGIN') && !origins.length) errors.push('CORS_ORIGIN deve conter ao menos uma origem');
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) {
        errors.push(`origem CORS deve ser HTTPS e não conter caminho: ${origin}`);
      }
    } catch {
      errors.push(`origem CORS inválida: ${origin}`);
    }
  }
  if (appUrl && (origins.length !== 1 || origins[0] !== appUrl.origin)) {
    errors.push('CORS_ORIGIN deve ser exatamente a origem de APP_URL');
  }

  if (!internalMode) {
    const checkoutReservationMinutes = valueOf(env, 'STRIPE_CHECKOUT_RESERVATION_MINUTES', '30');
    if (
      !/^\d+$/.test(checkoutReservationMinutes) ||
      Number(checkoutReservationMinutes) < 30 ||
      Number(checkoutReservationMinutes) > 1440
    ) {
      errors.push('STRIPE_CHECKOUT_RESERVATION_MINUTES deve ser um inteiro entre 30 e 1440');
    }
    if (valueOf(env, 'TRIAL_DAYS', '3') !== '3') errors.push('TRIAL_DAYS deve ser exatamente 3');
  }
  if (valueOf(env, 'WA_BROWSER_MODE', 'isolated') !== 'isolated') {
    errors.push('WA_BROWSER_MODE deve ser isolated');
  }
  // Idealmente o sandbox do Chromium fica ligado (WA_NO_SANDBOX=false). Alguns
  // hosts restringem namespaces de usuário e o zygote do Chromium falha ao
  // iniciar mesmo com todas as outras camadas do container (non-root, todas as
  // capabilities removidas, no-new-privileges, rootfs somente leitura) já
  // aplicadas — nesse caso --no-sandbox é o mitigador padrão do próprio
  // Puppeteer/Chrome, pois o isolamento passa a ser responsabilidade do
  // container. Por isso validamos só o formato, não forçamos mais 'false'.
  const waNoSandbox = valueOf(env, 'WA_NO_SANDBOX', 'false').toLowerCase();
  if (!['true', 'false'].includes(waNoSandbox)) {
    errors.push('WA_NO_SANDBOX deve ser true ou false');
  }
  if (valueOf(env, 'WHATSAPP_HEADLESS', 'true').toLowerCase() !== 'true') {
    errors.push('WHATSAPP_HEADLESS deve ser true na VPS sem interface gráfica');
  }
  // A regra nasceu na edicao comercial multi-tenant: la a capacidade e disputada
  // e nenhuma sessao sobe sozinha, para nao consumir slot de tenant pagante. Na
  // edicao interna existe UM tenant e WA_MAX_CONCURRENT_SESSIONS=1 — nao ha
  // capacidade a reservar de ninguem, e a proibicao so produz um efeito ruim:
  // depois de cada deploy ou reboot o WhatsApp fica fora do ar ate alguem abrir
  // o painel e clicar em conectar (medido em 04/set/2026, apos um restart do
  // container: zero processos de Chromium e nenhuma sessao). A sessao restaura
  // de .wwebjs_auth sem pedir QR, entao subir sozinha e o comportamento
  // desejado aqui. No modo comercial a trava continua valendo.
  const startDefaultSession = valueOf(env, 'WA_START_DEFAULT_SESSION', 'false').toLowerCase();
  if (!['true', 'false'].includes(startDefaultSession)) {
    errors.push('WA_START_DEFAULT_SESSION deve ser true ou false');
  } else if (startDefaultSession === 'true' && !isInternalEdition(env)) {
    errors.push('WA_START_DEFAULT_SESSION deve ser false na edicao comercial para reservar capacidade aos tenants');
  }
  if (valueOf(env, 'FFMPEG_PATH', '/usr/bin/ffmpeg') !== '/usr/bin/ffmpeg') {
    errors.push('FFMPEG_PATH deve apontar para /usr/bin/ffmpeg na imagem oficial');
  }
  const billingRequired = valueOf(env, 'BILLING_REQUIRED', internalMode ? 'false' : 'true').toLowerCase();
  if (internalMode && billingRequired !== 'false') {
    errors.push('BILLING_REQUIRED deve ser false no modo internal');
  } else if (!internalMode && billingRequired !== 'true') {
    errors.push('BILLING_REQUIRED deve ser true no modo commercial');
  }
  if (valueOf(env, 'COOKIE_SECURE', 'true').toLowerCase() !== 'true') {
    errors.push('COOKIE_SECURE deve ser true em produção');
  }
  if (valueOf(env, 'SQLITE_SYNCHRONOUS', 'FULL').toUpperCase() !== 'FULL') {
    errors.push('SQLITE_SYNCHRONOUS deve ser FULL em produção');
  }
  if (valueOf(env, 'HOST_BIND', '127.0.0.1') !== '127.0.0.1') {
    errors.push('HOST_BIND deve ser 127.0.0.1; publique somente pelo proxy HTTPS');
  }

  for (const name of [
    'APP_UID',
    'APP_GID',
    'REGISTER_RATE_LIMIT_MAX',
    'BACKUP_RETENTION',
    'BACKUP_LOCK_STALE_MS',
    'MIN_FREE_DISK_MB',
    'WA_MAX_CONCURRENT_SESSIONS',
    'WA_DISK_CACHE_BYTES',
    'WA_MEDIA_CACHE_BYTES',
    'MAX_MESSAGE_QUEUE_SIZE',
    'MAX_MESSAGE_QUEUE_BYTES',
    'MAX_GLOBAL_MESSAGE_QUEUE_BYTES',
    'MAX_OUTBOUND_MEDIA_BYTES',
    'MIN_RUNTIME_FREE_DISK_MB',
    'MAX_INBOUND_MEDIA_BYTES',
    'INBOUND_MEDIA_GLOBAL_CONCURRENCY',
    'INBOUND_MEDIA_TENANT_CONCURRENCY',
    'INBOUND_MEDIA_MAX_PENDING',
    'INBOUND_MEDIA_SLOT_TIMEOUT_MS',
    'TENANT_MEDIA_QUOTA_BYTES',
    'MEDIA_GLOBAL_QUOTA_BYTES',
    'FORWARD_MEDIA_TENANT_CONCURRENCY',
    'FORWARD_MEDIA_GLOBAL_CONCURRENCY',
    'WA_RECONNECT_MAX_ATTEMPTS',
    'HISTORY_IMPORT_LIMIT',
    'GET_CHATS_TIMEOUT_MS',
    'HISTORY_CHAT_FETCH_TIMEOUT_MS',
    'HISTORY_IMPORT_LOCK_WAIT_MS',
    'RECENT_SYNC_INTERVAL_MS',
    'RECENT_SYNC_CHAT_LIMIT',
    'RECENT_SYNC_MESSAGE_LIMIT',
    'RECENT_SYNC_MAX_FETCH_LIMIT',
    'FULL_SYNC_MAX_FETCH_LIMIT',
    'FULL_SYNC_ABSOLUTE_MAX_FETCH_LIMIT',
    'FULL_RECONCILE_INTERVAL_MS',
    'CONVERSATION_SYNC_MESSAGE_LIMIT',
    'CONVERSATION_SYNC_TIMEOUT_MS',
    'CONVERSATION_SYNC_SETTLE_MS',
    'CONVERSATION_SYNC_COOLDOWN_MS',
    'OLDER_SYNC_MAX_FETCH_LIMIT',
    'OLDER_SYNC_TIMEOUT_MS',
    'INCOMING_ENRICHMENT_CONCURRENCY',
    'INCOMING_ENRICHMENT_MAX_PENDING',
    'REALTIME_MEDIA_DOWNLOAD_ATTEMPTS',
    'REALTIME_MEDIA_RETRY_BASE_DELAY_MS',
    'REALTIME_MEDIA_REPAIR_MAX_ATTEMPTS',
    'REALTIME_MEDIA_REPAIR_LOOKBACK_HOURS',
    'REALTIME_MEDIA_REPAIR_BATCH_LIMIT',
    'CONTACT_SYNC_INTERVAL_MS',
    'CONTACT_SYNC_MANUAL_COOLDOWN_MS',
    'DEPLOY_WAIT_TIMEOUT',
    'DEPLOY_STOP_TIMEOUT',
    'SMOKE_RETRIES',
    'SMOKE_RETRY_DELAY',
    'PIDS_LIMIT',
    'TRUST_PROXY',
    'SINGLE_WRITER_LEASE_TTL_MS',
    'SINGLE_WRITER_LEASE_HEARTBEAT_MS',
    'SHUTDOWN_DRAIN_TIMEOUT_MS',
    'SHUTDOWN_HTTP_TIMEOUT_MS',
    'SHUTDOWN_WHATSAPP_TIMEOUT_MS',
  ]) {
    const value = valueOf(env, name);
    if (value && !isPositiveInteger(value)) errors.push(`${name} deve ser um inteiro positivo`);
  }

  if (internalMode && valueOf(env, 'WA_MAX_CONCURRENT_SESSIONS', '1') !== '1') {
    errors.push('WA_MAX_CONCURRENT_SESSIONS deve ser 1 no modo internal');
  }
  if (internalMode) {
    const internalAgentLimit = valueOf(env, 'INTERNAL_AGENT_LIMIT', '100');
    if (!isPositiveInteger(internalAgentLimit) || Number(internalAgentLimit) > 10000) {
      errors.push('INTERNAL_AGENT_LIMIT deve ser um inteiro entre 1 e 10000');
    }
    const internalAdminName = valueOf(env, 'INTERNAL_ADMIN_NAME', 'Super Admin');
    if (!internalAdminName || internalAdminName.length > 160 || /\p{Cc}/u.test(internalAdminName)) {
      errors.push('INTERNAL_ADMIN_NAME invalido');
    }
  }

  const numericValue = (name, fallback) => {
    const value = valueOf(env, name, String(fallback));
    return isPositiveInteger(value) ? Number(value) : null;
  };
  const backupRetention = numericValue('BACKUP_RETENTION', 4);
  if (backupRetention && (backupRetention < 2 || backupRetention > 7)) {
    errors.push('BACKUP_RETENTION deve ficar entre 2 e 7 snapshots completos locais');
  }
  const backupFreeMarginMb = valueOf(env, 'BACKUP_FREE_MARGIN_MB', '2048');
  if (!isPositiveInteger(backupFreeMarginMb) || Number(backupFreeMarginMb) < 512) {
    errors.push('BACKUP_FREE_MARGIN_MB deve reservar ao menos 512 MiB');
  }

  const deployStopTimeout = numericValue('DEPLOY_STOP_TIMEOUT', 120);
  const shutdownDrainTimeout = numericValue('SHUTDOWN_DRAIN_TIMEOUT_MS', 15000);
  const shutdownHttpTimeout = numericValue('SHUTDOWN_HTTP_TIMEOUT_MS', 15000);
  const shutdownWhatsappTimeout = numericValue('SHUTDOWN_WHATSAPP_TIMEOUT_MS', 25000);
  const shutdownBudgetMs =
    shutdownDrainTimeout && shutdownHttpTimeout && shutdownWhatsappTimeout
      ? shutdownDrainTimeout + shutdownHttpTimeout + shutdownWhatsappTimeout * 3
      : null;
  if (deployStopTimeout && deployStopTimeout < 90) {
    errors.push('DEPLOY_STOP_TIMEOUT deve ser de pelo menos 90 segundos');
  }
  if (deployStopTimeout && shutdownBudgetMs && deployStopTimeout * 1000 < shutdownBudgetMs + 10000) {
    errors.push('DEPLOY_STOP_TIMEOUT deve superar o pior caso dos timeouts de shutdown em pelo menos 10 segundos');
  }

  errors.push(...validateCapacityConfiguration(env).errors);
  const recentMessageLimit = numericValue('RECENT_SYNC_MESSAGE_LIMIT', 50);
  const recentFetchLimit = numericValue('RECENT_SYNC_MAX_FETCH_LIMIT', 500);
  if (recentMessageLimit && recentFetchLimit && recentFetchLimit < recentMessageLimit) {
    errors.push('RECENT_SYNC_MAX_FETCH_LIMIT não pode ser menor que RECENT_SYNC_MESSAGE_LIMIT');
  }
  const historyImportLimit = numericValue('HISTORY_IMPORT_LIMIT', 50);
  const fullFetchLimit = numericValue('FULL_SYNC_MAX_FETCH_LIMIT', 2000);
  if (historyImportLimit && fullFetchLimit && fullFetchLimit < historyImportLimit) {
    errors.push('FULL_SYNC_MAX_FETCH_LIMIT não pode ser menor que HISTORY_IMPORT_LIMIT');
  }
  const fullAbsoluteFetchLimit = numericValue('FULL_SYNC_ABSOLUTE_MAX_FETCH_LIMIT', 20000);
  if (fullFetchLimit && fullAbsoluteFetchLimit && fullAbsoluteFetchLimit < fullFetchLimit) {
    errors.push('FULL_SYNC_ABSOLUTE_MAX_FETCH_LIMIT não pode ser menor que FULL_SYNC_MAX_FETCH_LIMIT');
  }
  const conversationMessageLimit = numericValue('CONVERSATION_SYNC_MESSAGE_LIMIT', 150);
  const olderFetchLimit = numericValue('OLDER_SYNC_MAX_FETCH_LIMIT', 20000);
  if (conversationMessageLimit && olderFetchLimit && olderFetchLimit < conversationMessageLimit) {
    errors.push('OLDER_SYNC_MAX_FETCH_LIMIT não pode ser menor que CONVERSATION_SYNC_MESSAGE_LIMIT');
  }
  const enrichmentConcurrency = numericValue('INCOMING_ENRICHMENT_CONCURRENCY', 2);
  const enrichmentMaxPending = numericValue('INCOMING_ENRICHMENT_MAX_PENDING', 500);
  if (enrichmentConcurrency && enrichmentMaxPending && enrichmentMaxPending < enrichmentConcurrency) {
    errors.push('INCOMING_ENRICHMENT_MAX_PENDING não pode ser menor que INCOMING_ENRICHMENT_CONCURRENCY');
  }
  const singleWriterTtl = numericValue('SINGLE_WRITER_LEASE_TTL_MS', 90000);
  const singleWriterHeartbeat = numericValue('SINGLE_WRITER_LEASE_HEARTBEAT_MS', 20000);
  if (singleWriterTtl && singleWriterTtl < 60000) {
    errors.push('SINGLE_WRITER_LEASE_TTL_MS deve ser de pelo menos 60000');
  }
  if (singleWriterTtl && singleWriterHeartbeat && singleWriterHeartbeat >= singleWriterTtl / 2) {
    errors.push('SINGLE_WRITER_LEASE_HEARTBEAT_MS deve ser menor que metade do TTL');
  }
  const maxInboundMediaBytes = numericValue('MAX_INBOUND_MEDIA_BYTES', 128 * 1024 * 1024);
  const maxOutboundMediaBytes = numericValue('MAX_OUTBOUND_MEDIA_BYTES', 25 * 1024 * 1024);
  const maxMessageQueueBytes = numericValue('MAX_MESSAGE_QUEUE_BYTES', 64 * 1024 * 1024);
  const maxGlobalMessageQueueBytes = numericValue('MAX_GLOBAL_MESSAGE_QUEUE_BYTES', 256 * 1024 * 1024);
  const encodedOutboundBytes = maxOutboundMediaBytes ? Math.ceil((maxOutboundMediaBytes * 4) / 3) + 4096 : null;
  if (encodedOutboundBytes && maxMessageQueueBytes && maxMessageQueueBytes < encodedOutboundBytes) {
    errors.push('MAX_MESSAGE_QUEUE_BYTES deve comportar ao menos um anexo MAX_OUTBOUND_MEDIA_BYTES em base64');
  }
  if (maxMessageQueueBytes && maxGlobalMessageQueueBytes && maxGlobalMessageQueueBytes < maxMessageQueueBytes) {
    errors.push('MAX_GLOBAL_MESSAGE_QUEUE_BYTES não pode ser menor que MAX_MESSAGE_QUEUE_BYTES');
  }
  const inboundGlobalConcurrency = numericValue('INBOUND_MEDIA_GLOBAL_CONCURRENCY', 2);
  const inboundTenantConcurrency = numericValue('INBOUND_MEDIA_TENANT_CONCURRENCY', 1);
  const inboundMaxPending = numericValue('INBOUND_MEDIA_MAX_PENDING', 100);
  const tenantMediaQuotaBytes = numericValue('TENANT_MEDIA_QUOTA_BYTES', 10 * 1024 * 1024 * 1024);
  const globalMediaQuotaBytes = numericValue('MEDIA_GLOBAL_QUOTA_BYTES', 50 * 1024 * 1024 * 1024);
  const minimumRuntimeFreeBytes = numericValue('MIN_RUNTIME_FREE_DISK_MB', 1024) * 1024 * 1024;
  if (maxInboundMediaBytes && tenantMediaQuotaBytes && tenantMediaQuotaBytes < maxInboundMediaBytes) {
    errors.push('TENANT_MEDIA_QUOTA_BYTES não pode ser menor que MAX_INBOUND_MEDIA_BYTES');
  }
  if (inboundTenantConcurrency && inboundGlobalConcurrency && inboundGlobalConcurrency < inboundTenantConcurrency) {
    errors.push('INBOUND_MEDIA_GLOBAL_CONCURRENCY não pode ser menor que INBOUND_MEDIA_TENANT_CONCURRENCY');
  }
  if (inboundGlobalConcurrency && inboundMaxPending && inboundMaxPending < inboundGlobalConcurrency) {
    errors.push('INBOUND_MEDIA_MAX_PENDING não pode ser menor que INBOUND_MEDIA_GLOBAL_CONCURRENCY');
  }
  if (tenantMediaQuotaBytes && globalMediaQuotaBytes && globalMediaQuotaBytes < tenantMediaQuotaBytes) {
    errors.push('MEDIA_GLOBAL_QUOTA_BYTES não pode ser menor que TENANT_MEDIA_QUOTA_BYTES');
  }
  if (maxInboundMediaBytes && minimumRuntimeFreeBytes && minimumRuntimeFreeBytes < maxInboundMediaBytes * 2) {
    errors.push('MIN_RUNTIME_FREE_DISK_MB deve reservar ao menos duas vezes MAX_INBOUND_MEDIA_BYTES');
  }
  const forwardTenantConcurrency = numericValue('FORWARD_MEDIA_TENANT_CONCURRENCY', 2);
  const forwardGlobalConcurrency = numericValue('FORWARD_MEDIA_GLOBAL_CONCURRENCY', 4);
  if (forwardTenantConcurrency && forwardGlobalConcurrency && forwardGlobalConcurrency < forwardTenantConcurrency) {
    errors.push('FORWARD_MEDIA_GLOBAL_CONCURRENCY não pode ser menor que FORWARD_MEDIA_TENANT_CONCURRENCY');
  }

  const publicSmokeUrl = valueOf(env, 'PUBLIC_SMOKE_URL');
  if (publicSmokeUrl && appUrl) {
    try {
      const parsed = new URL(publicSmokeUrl);
      if (parsed.origin !== appUrl.origin || parsed.pathname !== '/health/ready' || parsed.search || parsed.hash) {
        errors.push('PUBLIC_SMOKE_URL deve apontar para /health/ready na origem de APP_URL');
      }
    } catch {
      errors.push('PUBLIC_SMOKE_URL inválida');
    }
  }

  const localSmokeUrl = valueOf(env, 'LOCAL_SMOKE_URL');
  if (localSmokeUrl) {
    try {
      const parsed = new URL(localSmokeUrl);
      if (
        parsed.protocol !== 'http:' ||
        parsed.hostname !== '127.0.0.1' ||
        parsed.pathname !== '/health/ready' ||
        parsed.search ||
        parsed.hash
      ) {
        errors.push('LOCAL_SMOKE_URL deve usar http://127.0.0.1 e /health/ready');
      }
    } catch {
      errors.push('LOCAL_SMOKE_URL inválida');
    }
  }

  return errors;
}

if (require.main === module) {
  const errors = validateProductionEnv();
  if (errors.length) {
    for (const error of errors) process.stderr.write(`ERRO: ${error}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Configuração de produção validada.\n');
  }
}

module.exports = { validateProductionEnv };
