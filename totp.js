const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function normalizeBase32(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[\s=-]/g, '');
}

function decodeBase32(value) {
  const normalized = normalizeBase32(value);
  if (!normalized || /[^A-Z2-7]/.test(normalized)) {
    throw new Error('Segredo TOTP deve estar em Base32');
  }

  let bits = 0;
  let bitCount = 0;
  const bytes = [];
  for (const character of normalized) {
    bits = (bits << 5) | BASE32_ALPHABET.indexOf(character);
    bitCount += 5;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >>> bitCount) & 0xff);
      // Mantem somente os bits ainda nao consumidos para nao exceder os 32 bits
      // usados pelos operadores bitwise do JavaScript.
      bits &= (1 << bitCount) - 1;
    }
  }
  return Buffer.from(bytes);
}

function encodeBase32(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Buffer obrigatorio para Base32');
  }
  let bits = 0;
  let bitCount = 0;
  let output = '';
  for (const byte of buffer) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      output += BASE32_ALPHABET[(bits >>> bitCount) & 31];
      bits &= (1 << bitCount) - 1;
    }
  }
  if (bitCount > 0) output += BASE32_ALPHABET[(bits << (5 - bitCount)) & 31];
  return output;
}

function validateTotpSecret(secret, { minimumBytes = 20 } = {}) {
  const decoded = decodeBase32(secret);
  if (decoded.length < minimumBytes) {
    throw new Error(`Segredo TOTP deve possuir ao menos ${minimumBytes} bytes`);
  }
  return decoded;
}

function hotp(secretBuffer, counter, digits = 6) {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('Contador TOTP invalido');
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secretBuffer).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits);
  return String(binary).padStart(digits, '0');
}

function verifyTotp(code, secret, {
  now = Date.now(),
  periodSeconds = 30,
  window = 1,
  digits = 6
} = {}) {
  const normalizedCode = String(code || '').trim();
  if (!new RegExp(`^\\d{${digits}}$`).test(normalizedCode)) return false;
  const secretBuffer = validateTotpSecret(secret);
  const timestamp = Number(now);
  if (!Number.isFinite(timestamp) || timestamp < 0) return false;
  const counter = Math.floor(timestamp / 1000 / periodSeconds);

  for (let offset = -window; offset <= window; offset += 1) {
    if (counter + offset < 0) continue;
    const candidate = hotp(secretBuffer, counter + offset, digits);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(normalizedCode))) return true;
  }
  return false;
}

function generateTotpSecret(bytes = 20) {
  const length = Number(bytes);
  if (!Number.isSafeInteger(length) || length < 20 || length > 64) {
    throw new Error('Tamanho do segredo TOTP invalido');
  }
  return encodeBase32(crypto.randomBytes(length));
}

function buildTotpUri({ secret, account, issuer = 'WhatsApp AI' }) {
  validateTotpSecret(secret);
  const cleanAccount = String(account || '').trim();
  const cleanIssuer = String(issuer || '').trim();
  if (!cleanAccount || !cleanIssuer) throw new Error('Conta e emissor TOTP obrigatorios');
  const label = `${cleanIssuer}:${cleanAccount}`;
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${encodeURIComponent(normalizeBase32(secret))}&issuer=${encodeURIComponent(cleanIssuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = {
  buildTotpUri,
  decodeBase32,
  encodeBase32,
  generateTotpSecret,
  hotp,
  validateTotpSecret,
  verifyTotp
};
