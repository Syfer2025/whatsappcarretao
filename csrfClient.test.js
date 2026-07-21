const test = require('node:test');
const assert = require('node:assert/strict');

const { createClient, readCookie } = require('./frontend/csrf-client');

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    clone() { return response(status, body); }
  };
}

test('csrf client reads the current cookie safely', () => {
  assert.equal(readCookie('other=1; csrf_token=abc%20123'), 'abc 123');
  assert.equal(readCookie('other=1'), '');
  assert.equal(readCookie('csrf_token=%E0%A4%A'), '');
});

test('concurrent mutations share a single csrf token request', async () => {
  let cookie = '';
  let tokenRequests = 0;
  const mutationHeaders = [];
  const token = 'a'.repeat(64);
  const client = createClient({
    cookieSource: () => cookie,
    fetchImpl: async (url, options) => {
      if (url === '/api/csrf-token') {
        tokenRequests += 1;
        await Promise.resolve();
        cookie = `csrf_token=${token}`;
        return response(200, { csrfToken: token });
      }
      mutationHeaders.push(options.headers['X-CSRF-Token']);
      return response(200, { ok: true });
    }
  });

  await Promise.all([
    client.fetch('/api/first', { method: 'POST' }),
    client.fetch('/api/second', { method: 'PATCH' })
  ]);

  assert.equal(tokenRequests, 1);
  assert.deepEqual(mutationHeaders, [token, token]);
});

test('csrf client always follows a token changed by another tab', async () => {
  const first = 'b'.repeat(64);
  const second = 'c'.repeat(64);
  let cookie = `csrf_token=${first}`;
  const headers = [];
  const client = createClient({
    cookieSource: () => cookie,
    fetchImpl: async (url, options) => {
      assert.notEqual(url, '/api/csrf-token');
      headers.push(options.headers['X-CSRF-Token']);
      return response(200, { ok: true });
    }
  });

  await client.fetch('/api/update', { method: 'POST' });
  cookie = `csrf_token=${second}`;
  await client.fetch('/api/update', { method: 'POST' });

  assert.deepEqual(headers, [first, second]);
});

test('csrf client retries once with the live cookie only after csrf rejection', async () => {
  const stale = 'd'.repeat(64);
  const fresh = 'e'.repeat(64);
  let cookie = `csrf_token=${stale}`;
  const headers = [];
  const client = createClient({
    cookieSource: () => cookie,
    fetchImpl: async (url, options) => {
      assert.notEqual(url, '/api/csrf-token');
      headers.push(options.headers['X-CSRF-Token']);
      if (headers.length === 1) {
        cookie = `csrf_token=${fresh}`;
        return response(403, { error: 'CSRF token inválido', code: 'CSRF_INVALID' });
      }
      return response(200, { ok: true });
    }
  });

  const result = await client.fetch('/api/sync', { method: 'POST' });

  assert.equal(result.status, 200);
  assert.deepEqual(headers, [stale, fresh]);
});

test('csrf client does not retry unrelated forbidden responses', async () => {
  let calls = 0;
  const client = createClient({
    cookieSource: () => `csrf_token=${'f'.repeat(64)}`,
    fetchImpl: async () => {
      calls += 1;
      return response(403, { error: 'Essa conversa não é sua' });
    }
  });

  const result = await client.fetch('/api/private', { method: 'POST' });

  assert.equal(result.status, 403);
  assert.equal(calls, 1);
});
