'use strict';

const INTERNAL_HTML_PATHS = new Set([
  '/index.html',
  '/register.html',
  '/forgot-password.html',
  '/settings.html',
  '/setup.html',
  '/superadmin.html'
]);

function isInternalEdition(env = process.env) {
  const appMode = String(env.APP_MODE || '').trim().toLowerCase();
  const legacyFlag = String(env.INTERNAL_SINGLE_TENANT || '').trim().toLowerCase();
  return appMode === 'internal' || ['1', 'true', 'yes', 'on'].includes(legacyFlag);
}

function getInternalAgentLimit(env = process.env) {
  const raw = String(env.INTERNAL_AGENT_LIMIT || '100').trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error('INTERNAL_AGENT_LIMIT deve ser um inteiro positivo');
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) {
    throw new Error('INTERNAL_AGENT_LIMIT deve estar entre 1 e 10000');
  }
  return limit;
}

function isInternalHtmlPath(pathname) {
  const path = String(pathname || '');
  return INTERNAL_HTML_PATHS.has(path) || path === '/support-widget.js';
}

function isInternalBlockedApiPath(pathname) {
  const path = String(pathname || '');
  return path === '/api/register'
    || path === '/api/webhooks/stripe'
    || path === '/api/forgot-password'
    || path === '/api/audit-log'
    || path === '/api/admin/platform-config'
    || path.startsWith('/api/admin/platform-config/')
    || path === '/api/tenants'
    || path.startsWith('/api/tenants/')
    || path === '/api/password-reset-requests'
    || path.startsWith('/api/password-reset-requests/')
    || path === '/api/support'
    || path.startsWith('/api/support/')
    || path === '/api/billing'
    || path.startsWith('/api/billing/');
}

module.exports = {
  getInternalAgentLimit,
  isInternalBlockedApiPath,
  isInternalEdition,
  isInternalHtmlPath
};
