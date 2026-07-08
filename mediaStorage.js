const fs = require('fs/promises');
const path = require('path');
const { normalizeMime } = require('./runtimeUtils');

const MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'
};

function classifyMedia(mimetype, messageType = '') {
  const normalized = normalizeMime(mimetype);
  if (messageType === 'sticker') return 'sticker';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized) return 'document';
  return 'unknown';
}

function extensionForMime(mimetype) {
  const normalized = normalizeMime(mimetype);
  if (MIME_EXTENSIONS[normalized]) return MIME_EXTENSIONS[normalized];
  const subtype = normalized.split('/')[1];
  return subtype ? subtype.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() || 'bin' : 'bin';
}

function getSafeMediaFilename(messageId, mimetype) {
  const base = String(messageId || `media-${Date.now()}`)
    .replace(/@/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || `media-${Date.now()}`;
  return `${base}.${extensionForMime(mimetype)}`;
}

async function saveMessageMedia({ messageId, media, messageType, mediaRoot, publicBasePath = '/media' }) {
  if (!media?.data || !media?.mimetype) return null;

  const filename = getSafeMediaFilename(messageId, media.mimetype);
  const buffer = Buffer.from(media.data, 'base64');
  await fs.mkdir(mediaRoot, { recursive: true });
  await fs.writeFile(path.join(mediaRoot, filename), buffer);

  return {
    media_type: classifyMedia(media.mimetype, messageType),
    media_mimetype: media.mimetype,
    media_filename: media.filename || filename,
    media_url: `${publicBasePath}/${filename}`,
    media_size: buffer.length
  };
}

function unavailableMediaContent(messageType = '') {
  const type = String(messageType || '').toLowerCase();
  if (type === 'audio' || type === 'ptt') return '(áudio indisponível)';
  if (type === 'image') return '(foto indisponível)';
  if (type === 'video') return '(vídeo indisponível)';
  if (type === 'sticker') return '(figurinha indisponível)';
  if (type === 'document') return '(anexo indisponível)';
  return '(mídia indisponível)';
}

module.exports = {
  classifyMedia,
  extensionForMime,
  getSafeMediaFilename,
  saveMessageMedia,
  unavailableMediaContent
};
