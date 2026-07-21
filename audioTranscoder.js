const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { normalizeMime } = require('./runtimeUtils');

const execFileAsync = promisify(execFile);
const WHATSAPP_VOICE_MIMETYPE = 'audio/ogg; codecs=opus';

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createAudioTranscodeLimiter({ concurrency = 2, maxPending = 20, waitTimeoutMs = 120000 } = {}) {
  const limit = positiveInteger(concurrency, 2);
  const pendingLimit = positiveInteger(maxPending, 20);
  const timeoutMs = positiveInteger(waitTimeoutMs, 120000);
  const pending = [];
  let active = 0;

  function limiterError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = 503;
    return error;
  }

  function pump() {
    while (active < limit && pending.length) {
      const item = pending.shift();
      if (item.cancelled) continue;
      clearTimeout(item.timer);
      active += 1;
      let released = false;
      item.resolve(() => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
        pump();
      });
    }
  }

  function acquire() {
    if (active < limit && pending.length === 0) {
      active += 1;
      let released = false;
      return Promise.resolve(() => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
        pump();
      });
    }
    if (pending.length >= pendingLimit) {
      return Promise.reject(limiterError(
        'AUDIO_TRANSCODE_QUEUE_FULL',
        'Fila global de conversão de áudio temporariamente cheia'
      ));
    }
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, cancelled: false, timer: null };
      item.timer = setTimeout(() => {
        const index = pending.indexOf(item);
        if (index === -1) return;
        pending.splice(index, 1);
        item.cancelled = true;
        reject(limiterError(
          'AUDIO_TRANSCODE_SLOT_TIMEOUT',
          'Tempo excedido aguardando capacidade para converter áudio'
        ));
      }, timeoutMs);
      item.timer.unref?.();
      pending.push(item);
      pump();
    });
  }

  async function run(operation) {
    const release = await acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  return {
    run,
    getStats: () => ({ active, pending: pending.length, concurrency: limit, maxPending: pendingLimit })
  };
}

const audioTranscodeLimiter = createAudioTranscodeLimiter({
  concurrency: process.env.AUDIO_TRANSCODE_CONCURRENCY,
  maxPending: process.env.AUDIO_TRANSCODE_MAX_PENDING,
  waitTimeoutMs: process.env.AUDIO_TRANSCODE_SLOT_TIMEOUT_MS
});

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
  const commandRunner = options.execFileAsync || execFileAsync;
  return audioTranscodeLimiter.run(async () => {
    const tempDir = await fs.mkdtemp(path.join(tempRoot, 'whatsapp-voice-'));
    const suffix = crypto.randomBytes(6).toString('hex');
    const inputPath = path.join(tempDir, `input-${suffix}${extensionForAudio(media.mimetype, media.filename)}`);
    const outputPath = path.join(tempDir, `output-${suffix}.ogg`);

    try {
      await fs.writeFile(inputPath, Buffer.from(media.data, 'base64'));
      await commandRunner(ffmpegPath, [
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
      const detail = String(err.stderr || err.message || err).slice(0, 2000);
      throw new Error(`Falha ao converter áudio para voz do WhatsApp: ${detail}`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
}

module.exports = {
  WHATSAPP_VOICE_MIMETYPE,
  prepareVoiceMediaForSend,
  createAudioTranscodeLimiter,
  audioTranscodeLimiter
};
