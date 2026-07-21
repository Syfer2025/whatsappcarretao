const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTotpUri,
  decodeBase32,
  encodeBase32,
  generateTotpSecret,
  hotp,
  validateTotpSecret,
  verifyTotp
} = require('./totp');

test('Base32 round-trips a cryptographic TOTP secret', () => {
  const secret = generateTotpSecret();
  const decoded = validateTotpSecret(secret);
  assert.equal(decoded.length, 20);
  assert.equal(encodeBase32(decodeBase32(secret)), secret);
});

test('HOTP follows the RFC 4226 SHA-1 vectors', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  assert.deepEqual(
    Array.from({ length: 10 }, (_, counter) => hotp(secret, counter)),
    ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']
  );
});

test('TOTP accepts only the configured time window', () => {
  const secret = encodeBase32(Buffer.from('12345678901234567890', 'ascii'));
  const now = 1_700_000_000_000;
  const current = hotp(decodeBase32(secret), Math.floor(now / 1000 / 30));
  const tooOld = hotp(decodeBase32(secret), Math.floor(now / 1000 / 30) - 2);

  assert.equal(verifyTotp(current, secret, { now }), true);
  assert.equal(verifyTotp(tooOld, secret, { now }), false);
  assert.equal(verifyTotp('12345x', secret, { now }), false);
});

test('builds an authenticator-compatible provisioning URI without weakening the secret', () => {
  const secret = encodeBase32(Buffer.from('12345678901234567890', 'ascii'));
  const uri = buildTotpUri({ secret, account: 'owner@example.test', issuer: 'WhatsApp AI' });
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, new RegExp(`secret=${secret}`));
  assert.match(uri, /digits=6&period=30/);
});
