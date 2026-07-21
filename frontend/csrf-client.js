/* global window */
(function initCsrfClient(root) {
  'use strict';

  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  const COOKIE_NAME = 'csrf_token';
  const HEADER_NAME = 'X-CSRF-Token';

  function readCookie(cookieHeader, name = COOKIE_NAME) {
    const prefix = `${name}=`;
    const item = String(cookieHeader || '')
      .split(';')
      .map(part => part.trim())
      .find(part => part.startsWith(prefix));
    if (!item) return '';
    try {
      return decodeURIComponent(item.slice(prefix.length));
    } catch {
      return '';
    }
  }

  function normalizeHeaders(input) {
    if (!input) return {};
    if (Array.isArray(input)) return Object.fromEntries(input);
    if (typeof input.forEach === 'function') {
      const output = {};
      input.forEach((value, key) => { output[key] = value; });
      return output;
    }
    return { ...input };
  }

  function withCsrfHeader(input, token) {
    const headers = normalizeHeaders(input);
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === HEADER_NAME.toLowerCase()) delete headers[key];
    }
    headers[HEADER_NAME] = token;
    return headers;
  }

  function createClient({ fetchImpl, cookieSource } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl deve ser uma função');
    const getCookieHeader = typeof cookieSource === 'function' ? cookieSource : () => '';
    let tokenRequest = null;

    async function ensureToken({ forceRefresh = false } = {}) {
      const liveToken = readCookie(getCookieHeader());
      if (!forceRefresh && liveToken) return liveToken;
      if (tokenRequest) return tokenRequest;

      tokenRequest = (async () => {
        const response = await fetchImpl('/api/csrf-token', {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { Accept: 'application/json' }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.csrfToken) {
          throw new Error(data.error || 'Não foi possível validar a sessão');
        }
        return data.csrfToken;
      })();

      try {
        return await tokenRequest;
      } finally {
        tokenRequest = null;
      }
    }

    async function isInvalidCsrfResponse(response) {
      if (!response || response.status !== 403 || typeof response.clone !== 'function') return false;
      const data = await response.clone().json().catch(() => ({}));
      return data.code === 'CSRF_INVALID' || data.error === 'CSRF token inválido';
    }

    async function request(url, options = {}) {
      const method = String(options.method || 'GET').toUpperCase();
      const baseOptions = {
        ...options,
        method,
        credentials: options.credentials || 'same-origin'
      };
      if (SAFE_METHODS.has(method)) {
        return fetchImpl(url, { ...baseOptions, headers: normalizeHeaders(options.headers) });
      }

      const initialToken = await ensureToken();
      const send = token => fetchImpl(url, {
        ...baseOptions,
        headers: withCsrfHeader(options.headers, token)
      });
      const response = await send(initialToken);
      if (!await isInvalidCsrfResponse(response)) return response;

      // O middleware rejeita CSRF antes de executar a rota, então repetir uma
      // única vez não duplica a mutação. Primeiro aproveita o cookie vivo de
      // outra aba; se ele não mudou, força a emissão de um token novo.
      const liveToken = readCookie(getCookieHeader());
      const retryToken = liveToken && liveToken !== initialToken
        ? liveToken
        : await ensureToken({ forceRefresh: true });
      return send(retryToken);
    }

    return Object.freeze({ fetch: request, ensureToken });
  }

  const exported = { createClient, readCookie, normalizeHeaders };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root && typeof root.fetch === 'function') {
    root.CsrfClient = createClient({
      fetchImpl: root.fetch.bind(root),
      cookieSource: () => root.document?.cookie || ''
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
