const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { normalizeMime } = require('./runtimeUtils');

const execFileAsync = promisify(execFile);
const WHATSAPP_VOICE_MIMETYPE = 'audio/ogg; codecs=opus';

function extensionForAudio(mimetype, filename = '') {
  const normalized = normalizeMime(mimetype);
  if (normalized === 'audio/ogg' || /\.ogg$/i.test(filename)) return '.ogg';
  if (normalized === 'audio/mp4' || normalized === 'audio/aac' || /\.m4a$/i.test(filename)) return '.m4a';
  if (normalized === 'audio/mpeg' || /\.mp3$/i.test(filename)) return '.mp3';
  if (normalized === 'audio/webm' || /\.webm$/i.test(filename)) return '.webm';
  return '.audio';
}

function withOggExtension(filename = '') {
  const safeName = String(filename || 'audio.ogg').replace(/[\\/]/g, '-');
  if (!safeName || safeName === 'audio.ogg') return 'audio.ogg';
  return safeName.replace(/\.[^.]+$/, '') + '.ogg';
}

function isWhatsAppVoiceMedia(media) {
  return normalizeMime(media?.mimetype) === 'audio/ogg';
}

async function prepareVoiceMediaForSend(media, options = {}) {
  if (!media?.data || !String(media.mimetype || '').startsWith('audio/')) {
    return media;
  }

  if (isWhatsAppVoiceMedia(media)) {
    return {
      ...media,
      mimetype: WHATSAPP_VOICE_MIMETYPE,
      filename: withOggExtension(media.filename),
      size: media.size || Buffer.from(media.data, 'base64').length
    };
  }

  const ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  const tempRoot = options.tempRoot || os.tmpdir();
  const tempDir = await fs.mkdtemp(path.join(tempRoot, 'whatsapp-voice-'));
  const suffix = crypto.randomBytes(6).toString('hex');
  const inputPath = path.join(tempDir, `input-${suffix}${extensionForAudio(media.mimetype, media.filename)}`);
  const outputPath = path.join(tempDir, `output-${suffix}.ogg`);

  try {
    await fs.writeFile(inputPath, Buffer.from(media.data, 'base64'));
    await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-f',
      'ogg',
      outputPath
    ], { timeout: 30000, maxBuffer: 1024 * 1024 });

    const output = await fs.readFile(outputPath);
    return {
      ...media,
      mimetype: WHATSAPP_VOICE_MIMETYPE,
      filename: withOggExtension(media.filename),
      data: output.toString('base64'),
      size: output.length
    };
  } catch (err) {
    const detail = err.stderr || err.message || String(err);
    throw new Error(`Falha ao converter áudio para voz do WhatsApp: ${detail}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  WHATSAPP_VOICE_MIMETYPE,
  prepareVoiceMediaForSend
};
