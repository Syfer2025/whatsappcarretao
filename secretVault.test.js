const test = require('node:test');
const assert = require('node:assert/strict');
const { encryptSecret, decryptSecret, maskSecret, isEncrypted } = require('./secretVault');

const KEY = 'chave-de-teste-suficientemente-longa-para-derivar';

test('round-trip encrypt/decrypt preserva o valor', () => {
  const secret = 'sk_live_abc123XYZ';
  const blob = encryptSecret(secret, KEY);
  assert.ok(isEncrypted(blob));
  assert.notEqual(blob, secret);
  assert.equal(decryptSecret(blob, KEY), secret);
});

test('valor vazio/nulo não é criptografado', () => {
  assert.equal(encryptSecret('', KEY), '');
  assert.equal(encryptSecret(null, KEY), '');
  assert.equal(encryptSecret(undefined, KEY), '');
});

test('cada criptografia usa IV distinto (blobs diferentes, mesmo valor)', () => {
  const a = encryptSecret('mesmo-valor', KEY);
  const b = encryptSecret('mesmo-valor', KEY);
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a, KEY), 'mesmo-valor');
  assert.equal(decryptSecret(b, KEY), 'mesmo-valor');
});

test('chave errada não descriptografa', () => {
  const blob = encryptSecret('segredo', 'chave-correta-abcdefghijklmnop');
  assert.throws(() => decryptSecret(blob, 'chave-errada-zzzzzzzzzzzzzzzzzz'));
});

test('blob adulterado falha na verificação de autenticidade (GCM)', () => {
  const blob = encryptSecret('segredo', KEY);
  const parts = blob.split('.');
  const corrupted = [parts[0], parts[1], parts[2], Buffer.from('adulterado').toString('base64')].join('.');
  assert.throws(() => decryptSecret(corrupted, KEY));
});

test('decryptSecret tolera texto puro legado', () => {
  assert.equal(decryptSecret('texto-puro-legado', KEY), 'texto-puro-legado');
  assert.equal(decryptSecret('', KEY), '');
});

test('maskSecret revela apenas o sufixo, nunca o valor cru', () => {
  const masked = maskSecret('sk_live_abcd1234');
  assert.match(masked, /1234$/);
  assert.ok(!masked.includes('sk_live_abcd'));
  assert.equal(maskSecret(''), '');
});
