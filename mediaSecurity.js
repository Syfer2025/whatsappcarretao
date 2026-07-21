const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { normalizeMime } = require('./runtimeUtils');

const execFileAsync = promisify(execFile);

const ALLOWED_MEDIA = {
  'image/jpeg': { extensions: ['jpg', 'jpeg'], magic: buffer => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  'image/png': { extensions: ['png'], magic: buffer => buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { extensions: ['webp'], magic: buffer => buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP' },
  'image/gif': { extensions: ['gif'], magic: buffer => ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii')) },
  'audio/ogg': { extensions: ['ogg', 'oga'], magic: buffer => buffer.subarray(0, 4).toString('ascii') === 'OggS' },
  'audio/mpeg': { extensions: ['mp3'], magic: buffer => buffer.subarray(0, 3).toString('ascii') === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) },
  'audio/mp4': { extensions: ['m4a', 'mp4'], magic: hasMp4Signature },
  'audio/aac': { extensions: ['aac'], magic: buffer => buffer[0] === 0xff && (buffer[1] === 0xf1 || buffer[1] === 0xf9) },
  'audio/webm': { extensions: ['webm'], magic: hasWebmSignature },
  'video/mp4': { extensions: ['mp4'], magic: hasMp4Signature },
  'video/webm': { extensions: ['webm'], magic: hasWebmSignature },
  'application/pdf': { extensions: ['pdf'], magic: buffer => buffer.subarray(0, 5).toString('ascii') === '%PDF-' },
  'text/plain': { extensions: ['txt', 'log', 'csv'], magic: buffer => !looksExecutableText(buffer) },
  'application/msword': { extensions: ['doc'], magic: hasOleSignature },
  'application/vnd.ms-excel': { extensions: ['xls'], magic: hasOleSignature },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { extensions: ['docx'], magic: hasZipSignatureWithoutMacros },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { extensions: ['xlsx'], magic: hasZipSignatureWithoutMacros }
};

function hasMp4Signature(buffer) {
  return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
}

function hasWebmSignature(buffer) {
  return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

function hasOleSignature(buffer) {
  return buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}

function hasZipSignature(buffer) {
  const signature = buffer.subarray(0, 4);
  return signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    signature.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])) ||
    signature.equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
}

function hasZipSignatureWithoutMacros(buffer) {
  return hasZipSignature(buffer) && !buffer.toString('latin1').toLowerCase().includes('vbaproject.bin');
}

function looksExecutableText(buffer) {
  const sample = buffer.subarray(0, 4096).toString('utf8').toLowerCase();
  return /<\s*script|<\s*html|<!doctype\s+html|<\s*svg|javascript:|<\?xml/.test(sample);
}

function normalizeBase64(data) {
  const value = String(data || '');
  const match = value.match(/^data:[^;]+;base64,(.+)$/);
  return match ? match[1] : value;
}

function mediaBuffer(media) {
  if (Buffer.isBuffer(media?.data)) return media.data;
  return Buffer.from(normalizeBase64(media?.data), 'base64');
}

function extensionForFilename(filename) {
  return path.extname(String(filename || '')).replace('.', '').toLowerCase();
}

function validateMediaForStorage(media) {
  const mimetype = normalizeMime(media?.mimetype);
  const rule = ALLOWED_MEDIA[mimetype];
  if (!rule) throw new Error('Tipo de arquivo nao permitido');

  const extension = extensionForFilename(media?.filename);
  if (extension && !rule.extensions.includes(extension)) {
    throw new Error('Extensao de arquivo nao permitida para o tipo informado');
  }

  const buffer = mediaBuffer(media);
  if (!buffer.length) throw new Error('Anexo invalido');
  if (!rule.magic(buffer)) throw new Error('Assinatura de arquivo invalida');

  return { mimetype, buffer };
}

async function scanMediaBuffer(buffer, {
  clamscanPath = process.env.CLAMSCAN_PATH,
  timeoutMs = Number(process.env.CLAMSCAN_TIMEOUT_MS || 15000)
} = {}) {
  if (!clamscanPath) return;

  const tempPath = path.join(os.tmpdir(), `whatsa-scan-${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`);
  await fs.writeFile(tempPath, buffer, { mode: 0o600 });
  try {
    await execFileAsync(clamscanPath, ['--no-summary', tempPath], { timeout: timeoutMs });
  } catch (err) {
    const output = `${err.stdout || ''}\n${err.stderr || ''}`;
    if (output.includes('FOUND')) throw new Error('Arquivo bloqueado por antivirus');
    throw new Error('Falha ao escanear anexo com antivirus');
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

module.exports = {
  validateMediaForStorage,
  scanMediaBuffer
};
