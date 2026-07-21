'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  verifyTurnstileToken,
  getTurnstileConfigurationStatus,
  TURNSTILE_VERIFY_URL
} = require('./signupProtection');

const VALID_TURNSTILE_SITE_KEY = '0x4AAAAAAValidProductionSiteKey';
const VALID_TURNSTILE_SECRET_KEY = '0x4AAAAAAValidProductionSecretKey';

test('Turnstile configuration is disabled only when both keys are absent', () => {
  assert.deepEqual(
    getTurnstileConfigurationStatus({}, { production: true }),
    { configured: false, reason: 'disabled' }
  );
  assert.deepEqual(
    getTurnstileConfigurationStatus({
      TURNSTILE_SITE_KEY: '   ',
      TURNSTILE_SECRET_KEY: ''
    }, { production: true }),
    { configured: false, reason: 'disabled' }
  );
});

test('Turnstile configuration requires one valid atomic site/secret pair', () => {
  assert.deepEqual(
    getTurnstileConfigurationStatus({
      TURNSTILE_SITE_KEY: VALID_TURNSTILE_SITE_KEY,
      TURNSTILE_SECRET_KEY: VALID_TURNSTILE_SECRET_KEY
    }, { production: true }),
    { configured: true, reason: null }
  );

  for (const partial of [
    { TURNSTILE_SITE_KEY: VALID_TURNSTILE_SITE_KEY },
    { TURNSTILE_SECRET_KEY: VALID_TURNSTILE_SECRET_KEY }
  ]) {
    assert.deepEqual(
      getTurnstileConfigurationStatus(partial, { production: true }),
      { configured: false, reason: 'partial_configuration' }
    );
  }
});

test('Turnstile configuration rejects malformed keys', () => {
  for (const malformed of [
    {
      TURNSTILE_SITE_KEY: 'short',
      TURNSTILE_SECRET_KEY: VALID_TURNSTILE_SECRET_KEY
    },
    {
      TURNSTILE_SITE_KEY: VALID_TURNSTILE_SITE_KEY,
      TURNSTILE_SECRET_KEY: 'invalid secret with spaces'
    }
  ]) {
    assert.deepEqual(
      getTurnstileConfigurationStatus(malformed, { production: true }),
      { configured: false, reason: 'invalid_key' }
    );
  }
});

test('Turnstile configuration rejects official Cloudflare test keys only in production', () => {
  const testKeys = {
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA'
  };

  assert.deepEqual(
    getTurnstileConfigurationStatus(testKeys, { production: true }),
    { configured: false, reason: 'test_key_in_production' }
  );
  assert.deepEqual(
    getTurnstileConfigurationStatus(testKeys, { production: false }),
    { configured: true, reason: null }
  );
});

test('signup challenge validates server-side action and exact production hostname', async () => {
  const calls = [];
  const result = await verifyTurnstileToken({
    token: 'single-use-token',
    remoteIp: '203.0.113.7',
    secretKey: 'private-secret',
    expectedHostname: 'app.example.test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return {
            success: true,
            hostname: 'app.example.test',
            action: 'signup',
            challenge_ts: '2026-07-13T12:00:00Z'
          };
        }
      };
    }
  });
  assert.equal(result.success, true);
  assert.equal(calls[0].url, TURNSTILE_VERIFY_URL);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, {
    secret: 'private-secret',
    response: 'single-use-token',
    remoteip: '203.0.113.7'
  });
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
});

test('signup challenge fails closed for missing, replayed, cross-host and unavailable validation', async () => {
  await assert.rejects(
    verifyTurnstileToken({ token: '', secretKey: 'secret', expectedHostname: 'app.test' }),
    error => error.statusCode === 400 && error.code === 'SIGNUP_CHALLENGE_REQUIRED'
  );
  for (const result of [
    { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { success: true, hostname: 'evil.test', action: 'signup' },
    { success: true, hostname: 'app.test', action: 'other' }
  ]) {
    await assert.rejects(
      verifyTurnstileToken({
        token: 'token',
        secretKey: 'secret',
        expectedHostname: 'app.test',
        fetchImpl: async () => ({ ok: true, json: async () => result })
      }),
      error => error.statusCode === 400 && error.code === 'SIGNUP_CHALLENGE_INVALID'
    );
  }
  await assert.rejects(
    verifyTurnstileToken({
      token: 'token',
      secretKey: 'secret',
      expectedHostname: 'app.test',
      fetchImpl: async () => { throw new Error('offline'); }
    }),
    error => error.statusCode === 503 && error.code === 'SIGNUP_CHALLENGE_UNAVAILABLE'
  );
});
