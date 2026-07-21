'use strict';

// Cofre de segredos da plataforma. Guardamos chaves sensiveis (Stripe, Turnstile)
// criptografadas em repouso no master.db, derivando a chave de criptografia do
// JWT_SECRET que ja existe. Assim nenhuma variavel de ambiente nova precisa ser
// adicionada e um dump do banco sozinho nao revela os segredos.
//
// Formato do blob: gcmv1.<b64(iv)>.<b64(authTag)>.<b64(ciphertext)>
// (o prefixo não contém ponto de propósito: o parsing separa o blob por ".")
// - AES-256-GCM com IV aleatorio de 12 bytes por valor (unico por criptografia).
// - A chave de 32 bytes vem de scrypt(keyMaterial, salt fixo do app).
//
// Trocar o JWT_SECRET torna os segredos existentes ilegiveis (decrypt lanca) e
// eles precisam ser reconfigurados pelo painel — comportamento intencional.

const crypto = require('node:crypto');

const BLOB_PREFIX = 'gcmv1';
const KEY_SALT = 'whatsa-platform-secrets-v1';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

const derivedKeyCache = new Map();

function keyMaterialFrom(explicit) {
  const material = explicit ?? process.env.JWT_SECRET;
  if (typeof material === 'string' && material.length > 0) return material;
  // Em desenvolvimento o JWT_SECRET pode faltar; usamos um material fixo apenas
  // para nao quebrar o fluxo local. Producao sempre tem JWT_SECRET (validado no boot).
  return 'dev-insecure-secret-material';
}

function deriveKey(keyMaterial) {
  const cached = derivedKeyCache.get(keyMaterial);
  if (cached) return cached;
  const key = crypto.scryptSync(keyMaterial, KEY_SALT, KEY_LENGTH);
  derivedKeyCache.set(keyMaterial, key);
  return key;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${BLOB_PREFIX}.`);
}

function encryptSecret(plaintext, keyMaterial) {
  if (plaintext === null || plaintext === undefined) return '';
  const text = String(plaintext);
  if (text === '') return '';
  const key = deriveKey(keyMaterialFrom(keyMaterial));
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    BLOB_PREFIX,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64')
  ].join('.');
}

function decryptSecret(blob, keyMaterial) {
  if (!isEncrypted(blob)) {
    // Tolera valores gravados em texto puro por versoes anteriores; devolve como veio.
    return blob === null || blob === undefined ? '' : String(blob);
  }
  const parts = String(blob).split('.');
  if (parts.length !== 4) throw new Error('Blob de segredo malformado');
  const [, ivB64, tagB64, ctB64] = parts;
  const key = deriveKey(keyMaterialFrom(keyMaterial));
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_LENGTH) throw new Error('IV de segredo invalido');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// Mascara um segredo para exibicao segura no painel: preserva um pequeno sufixo
// para o operador reconhecer a chave, sem revelar o valor. Nunca devolve o segredo cru.
function maskSecret(value, { visible = 4 } = {}) {
  const text = value === null || value === undefined ? '' : String(value);
  if (!text) return '';
  if (text.length <= visible) return '•'.repeat(8);
  return `${'•'.repeat(8)}${text.slice(-visible)}`;
}

module.exports = {
  BLOB_PREFIX,
  isEncrypted,
  encryptSecret,
  decryptSecret,
  maskSecret
};
