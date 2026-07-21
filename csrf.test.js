const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCsrfMiddleware,
  issueCsrfToken,
  readCsrfToken
} = require('./csrf');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    cookies: {},
    cookie(name, value, options) {
      this.cookies[name] = { value, options };
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test('issues csrf token in a same-site cookie', () => {
  const res = createResponse();
  const token = issueCsrfToken(res, { secure: true });

  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(res.cookies.csrf_token.value, token);
  assert.equal(res.cookies.csrf_token.options.sameSite, 'strict');
  assert.equal(res.cookies.csrf_token.options.secure, true);
  assert.equal(res.cookies.csrf_token.options.httpOnly, false);
});

test('reads only well-formed csrf cookie tokens for safe reuse', () => {
  const valid = 'a'.repeat(64);
  assert.equal(readCsrfToken({ headers: { cookie: `other=1; csrf_token=${valid}` } }), valid);
  assert.equal(readCsrfToken({ headers: { cookie: 'csrf_token=abc' } }), '');
  assert.equal(readCsrfToken({ headers: {} }), '');
});

test('csrf middleware protects mutating api requests', () => {
  const middleware = createCsrfMiddleware();
  let nextCalled = false;
  const res = createResponse();

  middleware({
    method: 'POST',
    path: '/conversations/1/messages',
    headers: { cookie: 'csrf_token=abc', 'x-csrf-token': 'wrong' }
  }, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'CSRF token inválido');
  assert.equal(res.body.code, 'CSRF_INVALID');
});

test('csrf middleware allows matching tokens safe methods and exempt paths', () => {
  const middleware = createCsrfMiddleware({ exemptPaths: ['/login'] });

  for (const req of [
    { method: 'GET', path: '/conversations', headers: {} },
    { method: 'POST', path: '/login', headers: {} },
    { method: 'DELETE', path: '/vendors/1', headers: { cookie: 'csrf_token=abc', 'x-csrf-token': 'abc' } }
  ]) {
    let nextCalled = false;
    const res = createResponse();
    middleware(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true, `${req.method} ${req.path} should pass`);
    assert.equal(res.statusCode, 200);
  }
});
