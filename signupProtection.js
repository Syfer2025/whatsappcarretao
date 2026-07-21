'use strict';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TURNSTILE_TOKEN_LENGTH = 4096;
const TURNSTILE_KEY_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;
const TURNSTILE_TEST_KEY_PATTERN = /^[123]x0{10,}/;

function getTurnstileConfigurationStatus(env = process.env, {
  production = env.NODE_ENV === 'production'
} = {}) {
  const siteKey = String(env.TURNSTILE_SITE_KEY || '').trim();
  const secretKey = String(env.TURNSTILE_SECRET_KEY || '').trim();
  const invalid = reason => ({ configured: false, reason });

  if (!siteKey && !secretKey) return invalid('disabled');
  if (!siteKey || !secretKey) return invalid('partial_configuration');
  if (!TURNSTILE_KEY_PATTERN.test(siteKey) || !TURNSTILE_KEY_PATTERN.test(secretKey)) {
    return invalid('invalid_key');
  }
  if (production && (TURNSTILE_TEST_KEY_PATTERN.test(siteKey) || TURNSTILE_TEST_KEY_PATTERN.test(secretKey))) {
    return invalid('test_key_in_production');
  }
  return { configured: true, reason: null };
}

function signupChallengeError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

async function verifyTurnstileToken({
  token,
  remoteIp,
  secretKey,
  expectedHostname,
  fetchImpl = global.fetch,
  timeoutMs = 8000
}) {
  const responseToken = typeof token === 'string' ? token.trim() : '';
  if (!responseToken || responseToken.length > MAX_TURNSTILE_TOKEN_LENGTH) {
    throw signupChallengeError('Conclua a verificacao anti-robo', 400, 'SIGNUP_CHALLENGE_REQUIRED');
  }
  if (!secretKey || !expectedHostname || typeof fetchImpl !== 'function') {
    throw signupChallengeError('Protecao de cadastro indisponivel', 503, 'SIGNUP_CHALLENGE_UNAVAILABLE');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 8000));
  timer.unref?.();
  try {
    let response;
    try {
      response = await fetchImpl(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: secretKey,
          response: responseToken,
          ...(remoteIp ? { remoteip: String(remoteIp) } : {})
        }),
        signal: controller.signal
      });
    } catch {
      throw signupChallengeError('Verificacao anti-robo temporariamente indisponivel', 503, 'SIGNUP_CHALLENGE_UNAVAILABLE');
    }
    if (!response?.ok) {
      throw signupChallengeError('Verificacao anti-robo temporariamente indisponivel', 503, 'SIGNUP_CHALLENGE_UNAVAILABLE');
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw signupChallengeError('Verificacao anti-robo temporariamente indisponivel', 503, 'SIGNUP_CHALLENGE_UNAVAILABLE');
    }
    if (!result?.success
        || result.hostname !== expectedHostname
        || result.action !== 'signup') {
      throw signupChallengeError('Verificacao anti-robo invalida ou expirada', 400, 'SIGNUP_CHALLENGE_INVALID');
    }
    return { success: true, challengeTimestamp: result.challenge_ts || null };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  TURNSTILE_VERIFY_URL,
  MAX_TURNSTILE_TOKEN_LENGTH,
  TURNSTILE_KEY_PATTERN,
  TURNSTILE_TEST_KEY_PATTERN,
  getTurnstileConfigurationStatus,
  verifyTurnstileToken
};
