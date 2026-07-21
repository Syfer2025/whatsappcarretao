const test = require('node:test');
const assert = require('node:assert/strict');
const tenantManager = require('./tenantManager');

const {
  setPlatformConfig,
  getPlatformConfigStatus,
  getResolvedPlatformEnv,
  getPlatformSetting,
  master
} = tenantManager;

function clearAll() {
  setPlatformConfig({
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    STRIPE_PRICE_ID: '',
    STRIPE_PRICE_ID_BASIC: '',
    STRIPE_PRICE_ID_PRO: '',
    TURNSTILE_SITE_KEY: '',
    TURNSTILE_SECRET_KEY: ''
  });
}

test('grava, resolve e mascara: segredo nunca volta cru no status', () => {
  clearAll();
  setPlatformConfig({
    STRIPE_SECRET_KEY: 'sk_live_abcdef123456',
    STRIPE_PRICE_ID_BASIC: 'price_basic_1'
  });
  // Internamente o segredo resolve em texto puro (para billing/webhook usarem)...
  assert.equal(getPlatformSetting('STRIPE_SECRET_KEY'), 'sk_live_abcdef123456');
  assert.equal(getResolvedPlatformEnv().STRIPE_PRICE_ID_BASIC, 'price_basic_1');

  const status = getPlatformConfigStatus();
  // ...mas o status exposto ao painel nunca devolve o segredo cru, só máscara.
  assert.equal(status.STRIPE_SECRET_KEY.configured, true);
  assert.equal(status.STRIPE_SECRET_KEY.value, '');
  assert.match(status.STRIPE_SECRET_KEY.masked, /3456$/);
  assert.ok(!status.STRIPE_SECRET_KEY.masked.includes('sk_live_abcdef'));
  // Chave pública (price id) volta inteira para exibição/edição.
  assert.equal(status.STRIPE_PRICE_ID_BASIC.value, 'price_basic_1');
  clearAll();
});

test('valor vazio limpa a chave', () => {
  setPlatformConfig({ TURNSTILE_SITE_KEY: '0x4AAAA_teste' });
  assert.equal(getResolvedPlatformEnv().TURNSTILE_SITE_KEY, '0x4AAAA_teste');
  setPlatformConfig({ TURNSTILE_SITE_KEY: '' });
  assert.equal(getPlatformConfigStatus().TURNSTILE_SITE_KEY.configured, false);
  assert.equal(getResolvedPlatformEnv().TURNSTILE_SITE_KEY, undefined);
});

test('segredo é persistido criptografado no master.db (não em texto puro)', () => {
  clearAll();
  setPlatformConfig({ STRIPE_WEBHOOK_SECRET: 'whsec_supersecreto123' });
  const raw = master
    .prepare('SELECT value, is_secret FROM platform_settings WHERE key = ?')
    .get('STRIPE_WEBHOOK_SECRET');
  assert.equal(raw.is_secret, 1);
  assert.ok(!raw.value.includes('whsec_supersecreto123'));
  assert.ok(raw.value.startsWith('gcmv1.'));
  // Ainda assim resolve de volta corretamente.
  assert.equal(getPlatformSetting('STRIPE_WEBHOOK_SECRET'), 'whsec_supersecreto123');
  clearAll();
});

test('chaves fora da allowlist são ignoradas', () => {
  clearAll();
  setPlatformConfig({ NAO_EXISTE: 'x', JWT_SECRET: 'nao-deveria-gravar' });
  assert.equal(getResolvedPlatformEnv().NAO_EXISTE, undefined);
  assert.equal(getResolvedPlatformEnv().JWT_SECRET, undefined);
  clearAll();
});
