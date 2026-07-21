const crypto = require('crypto');

const DEFAULT_COOKIE_NAME = 'csrf_token';
const DEFAULT_HEADER_NAME = 'x-csrf-token';
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function readCookie(req, name) {
  const cookieHeader = req.headers?.cookie;
  if (!cookieHeader) return '';
  const match = cookieHeader
    .split(';')
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(`${name}=`));
  if (!match) return '';
  try {
    return decodeURIComponent(match.slice(name.length + 1));
  } catch {
    return '';
  }
}

function readCsrfToken(req, { cookieName = DEFAULT_COOKIE_NAME } = {}) {
  const token = readCookie(req, cookieName);
  return /^[a-f0-9]{64}$/i.test(token) ? token : '';
}

function normalizeToken(value) {
  if (Array.isArray(value)) return String(value[0] || '');
  return String(value || '');
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(normalizeToken(left));
  const b = Buffer.from(normalizeToken(right));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestPath(req) {
  return req.path || new URL(req.url || '/', 'http://localhost').pathname;
}

function createCsrfMiddleware({
  cookieName = DEFAULT_COOKIE_NAME,
  headerName = DEFAULT_HEADER_NAME,
  exemptPaths = []
} = {}) {
  const exemptions = new Set(exemptPaths);

  return (req, res, next) => {
    const method = String(req.method || 'GET').toUpperCase();
    if (SAFE_METHODS.has(method) || exemptions.has(requestPath(req))) return next();

    const cookieToken = readCookie(req, cookieName);
    const headerToken = req.headers?.[headerName];
    if (!timingSafeEqual(cookieToken, headerToken)) {
      return res.status(403).json({ error: 'CSRF token inválido', code: 'CSRF_INVALID' });
    }
    return next();
  };
}

function issueCsrfToken(res, {
  cookieName = DEFAULT_COOKIE_NAME,
  secure = false,
  maxAge = DEFAULT_MAX_AGE_MS
} = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  res.cookie(cookieName, token, {
    path: '/',
    sameSite: 'strict',
    secure,
    httpOnly: false,
    maxAge
  });
  return token;
}

module.exports = {
  createCsrfMiddleware,
  issueCsrfToken,
  readCsrfToken
};
