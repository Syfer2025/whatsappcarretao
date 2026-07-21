const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { validateProductionEnv } = require('./scripts/validate-production-env');
const { evaluateHostCapacity, parseMemoryLimit } = require('./scripts/validate-host-capacity');

function validEnvironment(overrides = {}) {
  return {
    DOMAIN: 'app.acme.test',
    APP_URL: 'https://app.acme.test',
    CORS_ORIGIN: 'https://app.acme.test',
    JWT_SECRET: '0123456789abcdef0123456789abcdef',
    ADMIN_USERNAME: 'owner@acme.test',
    ADMIN_PASSWORD: 'Very-Strong-Admin-Password-42',
    SUPERADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    STRIPE_SECRET_KEY: 'sk_live_1234567890abcdef',
    STRIPE_WEBHOOK_SECRET: 'whsec_1234567890abcdef',
    STRIPE_PRICE_ID_BASIC: 'price_basic123',
    STRIPE_PRICE_ID_PRO: 'price_pro123',
    TURNSTILE_SITE_KEY: '0x4AAAAAAValidProductionSiteKey',
    TURNSTILE_SECRET_KEY: '0x4AAAAAAValidProductionSecretKey',
    TRIAL_DAYS: '3',
    WA_BROWSER_MODE: 'isolated',
    WA_NO_SANDBOX: 'false',
    WA_START_DEFAULT_SESSION: 'false',
    BILLING_REQUIRED: 'true',
    HOST_BIND: '127.0.0.1',
    ...overrides,
  };
}

function validInternalEnvironment(overrides = {}) {
  return validEnvironment({
    APP_MODE: 'internal',
    INTERNAL_SINGLE_TENANT: 'true',
    INTERNAL_ADMIN_NAME: 'Super Admin',
    INTERNAL_AGENT_LIMIT: '100',
    BILLING_REQUIRED: 'false',
    WA_MAX_CONCURRENT_SESSIONS: '1',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    STRIPE_PRICE_ID_BASIC: '',
    STRIPE_PRICE_ID_PRO: '',
    TURNSTILE_SITE_KEY: '',
    TURNSTILE_SECRET_KEY: '',
    ...overrides,
  });
}

test('accepts the exclusive internal edition without Stripe, trial or Turnstile', () => {
  assert.deepEqual(validateProductionEnv(validInternalEnvironment()), []);
});

test('internal edition enforces one WhatsApp session and a bounded agent limit', () => {
  const errors = validateProductionEnv(validInternalEnvironment({
    INTERNAL_SINGLE_TENANT: 'false',
    INTERNAL_AGENT_LIMIT: '10001',
    WA_MAX_CONCURRENT_SESSIONS: '2',
    BILLING_REQUIRED: 'true',
  }));
  for (const expected of [
    'INTERNAL_SINGLE_TENANT',
    'INTERNAL_AGENT_LIMIT',
    'WA_MAX_CONCURRENT_SESSIONS',
    'BILLING_REQUIRED',
  ]) {
    assert.ok(errors.some(error => error.includes(expected)), `${expected} should be rejected`);
  }
});

test('accepts both plan-specific Stripe prices', () => {
  assert.deepEqual(validateProductionEnv(validEnvironment()), []);
});

test('accepts a single fallback Stripe price', () => {
  assert.deepEqual(
    validateProductionEnv(
      validEnvironment({
        STRIPE_PRICE_ID: 'price_fallback123',
        STRIPE_PRICE_ID_BASIC: '',
        STRIPE_PRICE_ID_PRO: '',
      }),
    ),
    [],
  );
});

test('single-domain production rejects extra CORS origins and invalid checkout reservation windows', () => {
  const extraOrigin = validateProductionEnv(
    validEnvironment({
      CORS_ORIGIN: 'https://app.acme.test,https://secondary.acme.test',
    }),
  );
  assert.ok(extraOrigin.some((error) => /exatamente a origem de APP_URL/.test(error)));

  const tooShort = validateProductionEnv(
    validEnvironment({
      STRIPE_CHECKOUT_RESERVATION_MINUTES: '29',
    }),
  );
  const tooLong = validateProductionEnv(
    validEnvironment({
      STRIPE_CHECKOUT_RESERVATION_MINUTES: '1441',
    }),
  );
  assert.ok(tooShort.some((error) => /entre 30 e 1440/.test(error)));
  assert.ok(tooLong.some((error) => /entre 30 e 1440/.test(error)));
});

test('permite ambiente sem price ids (configurados em runtime pelo super admin)', () => {
  const errors = validateProductionEnv(
    validEnvironment({
      STRIPE_PRICE_ID: '',
      STRIPE_PRICE_ID_BASIC: '',
      STRIPE_PRICE_ID_PRO: '',
    }),
  );
  assert.ok(!errors.some((error) => /fallback OU os dois preços/.test(error)));
});

test('rejects ambiguous or mixed Stripe price-to-plan mappings', () => {
  const repeated = validateProductionEnv(
    validEnvironment({
      STRIPE_PRICE_ID_PRO: 'price_basic123',
    }),
  );
  assert.ok(repeated.some((error) => /devem ser diferentes/.test(error)));

  const mixed = validateProductionEnv(
    validEnvironment({
      STRIPE_PRICE_ID: 'price_fallback123',
    }),
  );
  assert.ok(mixed.some((error) => /sem misturar os modos/.test(error)));
});

test('requires Turnstile site and secret keys to be configured as one atomic pair', () => {
  for (const partialEnvironment of [
    { TURNSTILE_SECRET_KEY: '' },
    { TURNSTILE_SITE_KEY: '' },
  ]) {
    const errors = validateProductionEnv(validEnvironment(partialEnvironment));
    assert.ok(
      errors.some((error) => /TURNSTILE_SITE_KEY e TURNSTILE_SECRET_KEY devem ser configuradas juntas/.test(error)),
      'a partial Turnstile configuration must fail closed',
    );
  }

  const disabled = validateProductionEnv(
    validEnvironment({ TURNSTILE_SITE_KEY: '', TURNSTILE_SECRET_KEY: '' }),
  );
  assert.ok(
    !disabled.some((error) => /TURNSTILE_SITE_KEY e TURNSTILE_SECRET_KEY devem ser configuradas juntas/.test(error)),
    'both keys may be absent when Turnstile will be configured at runtime',
  );
});

test('rejects official Cloudflare Turnstile test keys in production', () => {
  const testKeyPairs = [
    {
      TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    },
    {
      TURNSTILE_SITE_KEY: '2x00000000000000000000AB',
      TURNSTILE_SECRET_KEY: '2x0000000000000000000000000000000AA',
    },
    {
      TURNSTILE_SITE_KEY: '3x00000000000000000000FF',
      TURNSTILE_SECRET_KEY: '3x0000000000000000000000000000000AA',
    },
  ];

  for (const testKeys of testKeyPairs) {
    const errors = validateProductionEnv(validEnvironment(testKeys));
    assert.ok(
      errors.some((error) => /TURNSTILE_(?:SITE|SECRET)_KEY nao pode usar uma chave de teste em produção/.test(error)),
      'Cloudflare test credentials must never be accepted in production',
    );
  }
});

test('rejects unsafe production invariants and non-live Stripe keys', () => {
  const errors = validateProductionEnv(
    validEnvironment({
      STRIPE_SECRET_KEY: 'sk_test_1234567890',
      TRIAL_DAYS: '7',
      WA_BROWSER_MODE: 'shared',
      WA_NO_SANDBOX: 'yes-please',
      WA_START_DEFAULT_SESSION: 'true',
      WHATSAPP_HEADLESS: 'false',
      BILLING_REQUIRED: 'false',
      COOKIE_SECURE: 'false',
      SQLITE_SYNCHRONOUS: 'NORMAL',
      HOST_BIND: '0.0.0.0',
      WA_MAX_CONCURRENT_SESSIONS: '0',
      SINGLE_WRITER_LEASE_TTL_MS: '30000',
      SINGLE_WRITER_LEASE_HEARTBEAT_MS: '20000',
    }),
  );
  for (const expected of [
    'sk_live_',
    'exatamente 3',
    'isolated',
    'WA_NO_SANDBOX',
    'WA_START_DEFAULT_SESSION',
    'WHATSAPP_HEADLESS',
    'BILLING_REQUIRED',
    'COOKIE_SECURE',
    'SQLITE_SYNCHRONOUS',
    'HOST_BIND',
    'WA_MAX_CONCURRENT_SESSIONS',
    'SINGLE_WRITER_LEASE_TTL_MS',
    'SINGLE_WRITER_LEASE_HEARTBEAT_MS',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      `${expected} should be rejected`,
    );
  }
});

test('permite desligar o sandbox do Chromium quando o host não suporta user namespaces', () => {
  // Alguns hosts restringem namespaces de usuário e o zygote do Chromium falha
  // mesmo com todas as outras camadas do container aplicadas (non-root, cap
  // drop ALL, no-new-privileges, rootfs somente leitura). Nesse caso o operador
  // pode desligar o sandbox interno do Chrome via WA_NO_SANDBOX=true.
  const errors = validateProductionEnv(validEnvironment({ WA_NO_SANDBOX: 'true' }));
  assert.ok(!errors.some((error) => /WA_NO_SANDBOX/.test(error)));
});

test('rejects placeholders even when a valid fallback also exists', () => {
  const errors = validateProductionEnv(
    validEnvironment({
      STRIPE_PRICE_ID: 'price_fallback123',
      STRIPE_PRICE_ID_BASIC: 'CHANGE_ME_PRICE',
      STRIPE_PRICE_ID_PRO: '',
    }),
  );
  assert.ok(errors.some((error) => /STRIPE_PRICE_ID_BASIC ainda contém um placeholder/.test(error)));
});

test('superadmin TOTP secret is optional but must be strong Base32 when provided', () => {
  // Decisão do dono da plataforma (15/jul/2026): segredo ausente = 2FA
  // desligado no login do super admin; o boot não pode mais recusar por isso.
  const missing = validateProductionEnv(validEnvironment({ SUPERADMIN_TOTP_SECRET: '' }));
  const weak = validateProductionEnv(validEnvironment({ SUPERADMIN_TOTP_SECRET: 'JBSWY3DP' }));
  assert.ok(!missing.some((error) => error.includes('SUPERADMIN_TOTP_SECRET')));
  assert.ok(weak.some((error) => error.includes('SUPERADMIN_TOTP_SECRET invalido')));
});

test('requires smoke tests to target the expected readiness endpoints', () => {
  const errors = validateProductionEnv(
    validEnvironment({
      LOCAL_SMOKE_URL: 'http://0.0.0.0:3000/health/ready',
      PUBLIC_SMOKE_URL: 'https://other.acme.test/health/ready',
    }),
  );
  assert.ok(errors.some((error) => /LOCAL_SMOKE_URL/.test(error)));
  assert.ok(errors.some((error) => /PUBLIC_SMOKE_URL/.test(error)));
});

test('validates whatsapp synchronization limits and their safe ordering', () => {
  const errors = validateProductionEnv(
    validEnvironment({
      GET_CHATS_TIMEOUT_MS: 'NaN',
      HISTORY_CHAT_FETCH_TIMEOUT_MS: 'infinito',
      HISTORY_IMPORT_LOCK_WAIT_MS: '0',
      RECENT_SYNC_INTERVAL_MS: '-1',
      CONTACT_SYNC_MANUAL_COOLDOWN_MS: '0',
      RECENT_SYNC_CHAT_LIMIT: '3.5',
      RECENT_SYNC_MESSAGE_LIMIT: '100',
      RECENT_SYNC_MAX_FETCH_LIMIT: '50',
      HISTORY_IMPORT_LIMIT: '200',
      FULL_SYNC_MAX_FETCH_LIMIT: '100',
      FULL_SYNC_ABSOLUTE_MAX_FETCH_LIMIT: '50',
      CONVERSATION_SYNC_MESSAGE_LIMIT: '250',
      OLDER_SYNC_MAX_FETCH_LIMIT: '200',
      OLDER_SYNC_TIMEOUT_MS: '-60000',
      INCOMING_ENRICHMENT_CONCURRENCY: '8',
      INCOMING_ENRICHMENT_MAX_PENDING: '4',
    }),
  );

  for (const expected of [
    'GET_CHATS_TIMEOUT_MS deve ser um inteiro positivo',
    'HISTORY_CHAT_FETCH_TIMEOUT_MS deve ser um inteiro positivo',
    'HISTORY_IMPORT_LOCK_WAIT_MS deve ser um inteiro positivo',
    'RECENT_SYNC_INTERVAL_MS deve ser um inteiro positivo',
    'CONTACT_SYNC_MANUAL_COOLDOWN_MS deve ser um inteiro positivo',
    'RECENT_SYNC_CHAT_LIMIT deve ser um inteiro positivo',
    'RECENT_SYNC_MAX_FETCH_LIMIT não pode ser menor',
    'FULL_SYNC_MAX_FETCH_LIMIT não pode ser menor',
    'FULL_SYNC_ABSOLUTE_MAX_FETCH_LIMIT não pode ser menor',
    'OLDER_SYNC_MAX_FETCH_LIMIT não pode ser menor',
    'OLDER_SYNC_TIMEOUT_MS deve ser um inteiro positivo',
    'INCOMING_ENRICHMENT_MAX_PENDING não pode ser menor',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      `${expected} should be rejected`,
    );
  }
});

test('validates process-wide inbound media backpressure', () => {
  const errors = validateProductionEnv(
    validEnvironment({
      INBOUND_MEDIA_GLOBAL_CONCURRENCY: '1',
      INBOUND_MEDIA_TENANT_CONCURRENCY: '2',
      INBOUND_MEDIA_MAX_PENDING: '0',
      INBOUND_MEDIA_SLOT_TIMEOUT_MS: 'NaN',
    }),
  );
  for (const expected of [
    'INBOUND_MEDIA_MAX_PENDING deve ser um inteiro positivo',
    'INBOUND_MEDIA_SLOT_TIMEOUT_MS deve ser um inteiro positivo',
    'INBOUND_MEDIA_GLOBAL_CONCURRENCY não pode ser menor',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      `${expected} should be rejected`,
    );
  }
});

test('validates outbound queue byte budgets against base64 expansion', () => {
  const errors = validateProductionEnv(
    validEnvironment({
      MAX_OUTBOUND_MEDIA_BYTES: '26214400',
      MAX_MESSAGE_QUEUE_BYTES: '30000000',
      MAX_GLOBAL_MESSAGE_QUEUE_BYTES: '20000000',
    }),
  );
  assert.ok(errors.some((error) => error.includes('MAX_MESSAGE_QUEUE_BYTES deve comportar')));
  assert.ok(errors.some((error) => error.includes('MAX_GLOBAL_MESSAGE_QUEUE_BYTES não pode ser menor')));
});

test('rejects deploy shutdown windows that cannot cover graceful draining', () => {
  const errors = validateProductionEnv(
    validEnvironment({
      DEPLOY_STOP_TIMEOUT: '90',
      SHUTDOWN_DRAIN_TIMEOUT_MS: '15000',
      SHUTDOWN_HTTP_TIMEOUT_MS: '15000',
      SHUTDOWN_WHATSAPP_TIMEOUT_MS: '25000',
    }),
  );
  assert.ok(errors.some((error) => error.includes('pior caso dos timeouts de shutdown')));

  const tooShort = validateProductionEnv(validEnvironment({ DEPLOY_STOP_TIMEOUT: '89' }));
  assert.ok(tooShort.some((error) => error.includes('pelo menos 90 segundos')));
});

test('bounds complete local backup retention', () => {
  const tooFew = validateProductionEnv(validEnvironment({ BACKUP_RETENTION: '1' }));
  const tooMany = validateProductionEnv(validEnvironment({ BACKUP_RETENTION: '30' }));
  assert.ok(tooFew.some((error) => error.includes('entre 2 e 7')));
  assert.ok(tooMany.some((error) => error.includes('entre 2 e 7')));
});

test('requires a meaningful free-space reserve for complete backups', () => {
  const zero = validateProductionEnv(validEnvironment({ BACKUP_FREE_MARGIN_MB: '0' }));
  const tooSmall = validateProductionEnv(validEnvironment({ BACKUP_FREE_MARGIN_MB: '511' }));
  const valid = validateProductionEnv(validEnvironment({ BACKUP_FREE_MARGIN_MB: '2048' }));
  assert.ok(zero.some((error) => error.includes('ao menos 512 MiB')));
  assert.ok(tooSmall.some((error) => error.includes('ao menos 512 MiB')));
  assert.equal(
    valid.some((error) => error.includes('BACKUP_FREE_MARGIN_MB')),
    false,
  );
});

test('validates container resources against whatsapp session capacity', () => {
  const errors = validateProductionEnv(
    validEnvironment({
      CPU_LIMIT: '1.5',
      MEMORY_LIMIT: '3g',
      WA_MAX_CONCURRENT_SESSIONS: '5',
    }),
  );
  assert.ok(errors.some((error) => error.includes('CPU_LIMIT=1.5 é insuficiente')));
  assert.ok(errors.some((error) => error.includes('MEMORY_LIMIT é insuficiente')));
  assert.equal(parseMemoryLimit('6144m'), 6 * 1024 * 1024 * 1024);
});

test('pre-deploy capacity check refuses a 2 CPU 3.6 GiB host and accepts 4 CPU 8 GiB', () => {
  const environment = validEnvironment({
    CPU_LIMIT: '3.0',
    MEMORY_LIMIT: '6g',
    WA_MAX_CONCURRENT_SESSIONS: '5',
  });
  const undersized = evaluateHostCapacity(environment, {
    logicalCpuCount: 2,
    totalMemoryBytes: Math.floor(3.6 * 1024 ** 3),
  });
  assert.ok(undersized.errors.some((error) => error.includes('2 CPUs lógicas é insuficiente')));
  assert.ok(undersized.errors.some((error) => error.includes('3,60 GiB de RAM é insuficiente')));

  const adequate = evaluateHostCapacity(environment, {
    logicalCpuCount: 4,
    totalMemoryBytes: 8 * 1024 ** 3,
  });
  assert.deepEqual(adequate.errors, []);
});

test('server rejects an invalid production environment before creating data.db', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-config-fail-closed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATA_DIR: dataDir,
      DOMAIN: 'CHANGE_ME.example.com',
      APP_URL: 'http://CHANGE_ME.example.com',
      CORS_ORIGIN: 'http://CHANGE_ME.example.com',
      JWT_SECRET: 'short',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin',
      STRIPE_SECRET_KEY: 'sk_test_invalid',
      STRIPE_WEBHOOK_SECRET: 'invalid',
      STRIPE_PRICE_ID: 'invalid',
    },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Configuracao de producao invalida/);
  assert.equal(fs.existsSync(path.join(dataDir, 'data.db')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'master.db')), false);
});
