const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const { normalizeMime } = require('./runtimeUtils');
const { scanMediaBuffer, validateMediaForStorage } = require('./mediaSecurity');

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DEFAULT_MAX_INBOUND_MEDIA_BYTES = 128 * MIB;
const DEFAULT_TENANT_MEDIA_QUOTA_BYTES = 10 * GIB;
const DEFAULT_MEDIA_GLOBAL_QUOTA_BYTES = 50 * GIB;
const DEFAULT_MIN_FREE_BYTES = (process.env.NODE_ENV === 'production' ? 1024 : 64) * MIB;
const MEDIA_USAGE_CACHE_MS = 30 * 1000;
const mediaUsageCache = new Map();
let mediaQuotaQueue = Promise.resolve();

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

function normalizeMediaNamespace(namespace, { required = false } = {}) {
  if (namespace === undefined || namespace === null || namespace === '') {
    if (required) throw new Error('Namespace de tenant obrigatorio para midia');
    return null;
  }
  if (typeof namespace === 'boolean'
      || (typeof namespace === 'string' && !/^[1-9]\d*$/.test(namespace.trim()))) {
    throw new Error('Namespace de tenant invalido para midia');
  }
  const tenantId = Number(namespace);
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
    throw new Error('Namespace de tenant invalido para midia');
  }
  return tenantId;
}

function tenantMediaPrefix(namespace) {
  return `t${normalizeMediaNamespace(namespace, { required: true })}-`;
}

function isTenantMediaFilename(filename, namespace) {
  const raw = String(filename || '');
  const basename = path.basename(raw);
  return Boolean(
    basename
    && basename === raw
    && /^[a-zA-Z0-9._-]+$/.test(basename)
    && basename.startsWith(tenantMediaPrefix(namespace))
  );
}

function positiveLimit(value, fallback, label) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    const error = new Error(`${label} deve ser um inteiro positivo`);
    error.code = 'MEDIA_STORAGE_CONFIG_INVALID';
    throw error;
  }
  return number;
}

function configuredStorageLimits(overrides = {}) {
  return {
    maxInboundBytes: positiveLimit(
      overrides.maxInboundBytes ?? process.env.MAX_INBOUND_MEDIA_BYTES,
      DEFAULT_MAX_INBOUND_MEDIA_BYTES,
      'MAX_INBOUND_MEDIA_BYTES'
    ),
    tenantQuotaBytes: positiveLimit(
      overrides.tenantQuotaBytes ?? process.env.TENANT_MEDIA_QUOTA_BYTES,
      DEFAULT_TENANT_MEDIA_QUOTA_BYTES,
      'TENANT_MEDIA_QUOTA_BYTES'
    ),
    globalQuotaBytes: positiveLimit(
      overrides.globalQuotaBytes ?? process.env.MEDIA_GLOBAL_QUOTA_BYTES,
      DEFAULT_MEDIA_GLOBAL_QUOTA_BYTES,
      'MEDIA_GLOBAL_QUOTA_BYTES'
    ),
    minFreeBytes: positiveLimit(
      overrides.minFreeBytes
        ?? (process.env.MIN_RUNTIME_FREE_DISK_MB
          ? Number(process.env.MIN_RUNTIME_FREE_DISK_MB) * MIB
          : undefined),
      DEFAULT_MIN_FREE_BYTES,
      'Reserva minima de disco para midia'
    )
  };
}

function estimatedMediaBytes(data) {
  if (Buffer.isBuffer(data)) return data.length;
  const encoded = String(data || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!encoded) return 0;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(encoded.length * 3 / 4) - padding);
}

function knownWhatsAppMediaSize(message) {
  const candidates = [
    message?.filesize,
    message?.size,
    message?._data?.filesize,
    message?._data?.fileSize,
    message?._data?.size
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const bytes = Number(candidate);
    if (Number.isFinite(bytes) && bytes > 0) return Math.ceil(bytes);
  }
  return null;
}

function assertKnownInboundMediaSize(message, storageLimits) {
  const knownBytes = knownWhatsAppMediaSize(message);
  if (knownBytes == null) return null;
  const limits = configuredStorageLimits(storageLimits);
  if (knownBytes > limits.maxInboundBytes) {
    throw storageCapacityError(
      `Midia excede o limite de ${limits.maxInboundBytes} bytes`,
      'MEDIA_TOO_LARGE'
    );
  }
  return knownBytes;
}

function storageCapacityError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 507;
  return error;
}

async function scanMediaUsage(mediaRoot) {
  const usage = { total: 0, byTenant: new Map(), expiresAt: Date.now() + MEDIA_USAGE_CACHE_MS, pending: 0 };
  let entries = [];
  try {
    entries = await fs.readdir(mediaRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    let stats;
    try { stats = await fs.stat(path.join(mediaRoot, entry.name)); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    usage.total += stats.size;
    const match = entry.name.match(/^t([1-9]\d*)-/);
    if (match) {
      const tenantId = Number(match[1]);
      usage.byTenant.set(tenantId, (usage.byTenant.get(tenantId) || 0) + stats.size);
    }
  }
  return usage;
}

function serializeMediaQuota(operation) {
  const result = mediaQuotaQueue.then(operation, operation);
  mediaQuotaQueue = result.catch(() => {});
  return result;
}

async function reserveMediaCapacity({ mediaRoot, destination, namespace, bytes, limits }) {
  return serializeMediaQuota(async () => {
    const root = path.resolve(mediaRoot);
    let usage = mediaUsageCache.get(root);
    if (!usage || (usage.pending === 0 && usage.expiresAt <= Date.now())) {
      usage = await scanMediaUsage(root);
      mediaUsageCache.set(root, usage);
    }

    let previousBytes = 0;
    try { previousBytes = (await fs.stat(destination)).size; } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const delta = bytes - previousBytes;
    const projectedGlobal = usage.total + delta;
    if (projectedGlobal > limits.globalQuotaBytes) {
      throw storageCapacityError('Limite global de armazenamento de midia atingido', 'MEDIA_GLOBAL_QUOTA_REACHED');
    }
    if (namespace) {
      const projectedTenant = (usage.byTenant.get(namespace) || 0) + delta;
      if (projectedTenant > limits.tenantQuotaBytes) {
        throw storageCapacityError('Limite de armazenamento de midia da empresa atingido', 'TENANT_MEDIA_QUOTA_REACHED');
      }
    }

    const stats = await fs.statfs(root);
    const availableBytes = Number(stats.bavail || 0) * Number(stats.bsize || 0);
    if (!Number.isFinite(availableBytes) || availableBytes - Math.max(0, delta) < limits.minFreeBytes) {
      throw storageCapacityError('Espaco em disco insuficiente para armazenar nova midia', 'MEDIA_DISK_RESERVE_REACHED');
    }

    usage.total = projectedGlobal;
    if (namespace) usage.byTenant.set(namespace, (usage.byTenant.get(namespace) || 0) + delta);
    usage.pending += 1;
    usage.expiresAt = Date.now() + MEDIA_USAGE_CACHE_MS;
    return { root, namespace, delta, settled: false };
  });
}

async function settleMediaCapacity(reservation, committed) {
  if (!reservation || reservation.settled) return;
  reservation.settled = true;
  await serializeMediaQuota(() => {
    const usage = mediaUsageCache.get(reservation.root);
    if (!usage) return;
    usage.pending = Math.max(0, usage.pending - 1);
    if (!committed) {
      usage.total -= reservation.delta;
      if (reservation.namespace) {
        usage.byTenant.set(
          reservation.namespace,
          (usage.byTenant.get(reservation.namespace) || 0) - reservation.delta
        );
      }
    }
  });
}

function getSafeMediaFilename(messageId, mimetype, namespace) {
  // Prefixo por tenant evita colisão de nomes no diretório de mídia compartilhado
  // (ex: "out-1.jpg" de dois tenants diferentes sobrescreveriam um ao outro).
  const normalizedNamespace = normalizeMediaNamespace(namespace);
  const ns = normalizedNamespace ? tenantMediaPrefix(normalizedNamespace) : '';
  const base = String(messageId || `media-${Date.now()}`)
    .replace(/@/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || `media-${Date.now()}`;
  return `${ns}${base}.${extensionForMime(mimetype)}`;
}

async function createExclusiveTempFile(destination) {
  const directory = path.dirname(destination);
  const basename = path.basename(destination);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tempPath = path.join(
      directory,
      `.${basename}.${process.pid}-${crypto.randomUUID()}.tmp`
    );

    try {
      const handle = await fs.open(tempPath, 'wx', 0o600);
      return { handle, tempPath };
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt === 4) throw error;
    }
  }

  throw new Error('Nao foi possivel criar arquivo temporario de midia');
}

async function writeFileAtomically(destination, buffer) {
  const { handle, tempPath } = await createExclusiveTempFile(destination);
  let handleIsOpen = true;

  try {
    await handle.writeFile(buffer);
    // rename atomico evita arquivo parcial para leitores concorrentes; fsync do
    // arquivo garante que o conteudo chegou ao storage antes de publicar o nome.
    await handle.sync();
    await handle.close();
    handleIsOpen = false;
    await fs.rename(tempPath, destination);
    // O rename em si tambem precisa ser persistido. Sem fsync do diretorio, uma
    // queda do host pode trazer de volta a entrada antiga ou nenhuma entrada.
    const directoryHandle = await fs.open(path.dirname(destination), 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (handleIsOpen) {
      try {
        await handle.close();
      } catch {
        // Mantem o erro original da gravacao; o rm abaixo ainda pode limpar o arquivo.
      }
    }

    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      // A falha de limpeza nao deve esconder a causa original da gravacao.
    }

    throw error;
  }
}

async function saveMessageMedia({
  messageId,
  media,
  messageType,
  mediaRoot,
  publicBasePath = '/media',
  namespace,
  storageLimits
}) {
  if (!media?.data || !media?.mimetype) return null;

  const normalizedNamespace = normalizeMediaNamespace(namespace);
  const limits = configuredStorageLimits(storageLimits);
  const estimatedBytes = estimatedMediaBytes(media.data);
  if (estimatedBytes > limits.maxInboundBytes) {
    throw storageCapacityError(
      `Midia excede o limite de ${limits.maxInboundBytes} bytes`,
      'MEDIA_TOO_LARGE'
    );
  }
  const filename = getSafeMediaFilename(messageId, media.mimetype, normalizedNamespace);
  const { buffer } = validateMediaForStorage(media);
  if (buffer.length > limits.maxInboundBytes) {
    throw storageCapacityError(
      `Midia excede o limite de ${limits.maxInboundBytes} bytes`,
      'MEDIA_TOO_LARGE'
    );
  }
  await fs.mkdir(mediaRoot, { recursive: true });
  const destination = path.join(mediaRoot, filename);
  const reservation = await reserveMediaCapacity({
    mediaRoot,
    destination,
    namespace: normalizedNamespace,
    bytes: buffer.length,
    limits
  });
  let committed = false;
  try {
    await scanMediaBuffer(buffer);
    await writeFileAtomically(destination, buffer);
    committed = true;
  } finally {
    await settleMediaCapacity(reservation, committed);
  }

  return {
    media_type: classifyMedia(media.mimetype, messageType),
    media_mimetype: media.mimetype,
    media_filename: media.filename || filename,
    media_url: `${publicBasePath}/${filename}`,
    media_size: buffer.length,
    media_sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  };
}

function resolveStoredTenantMediaPath({ mediaUrl, mediaRoot, namespace = null }) {
  const rawUrl = String(mediaUrl || '');
  const prefix = '/media/';
  if (!rawUrl.startsWith(prefix) || !mediaRoot) return null;
  const filename = rawUrl.slice(prefix.length);
  if (!filename || filename !== path.basename(filename) || !/^[a-zA-Z0-9._-]+$/.test(filename)) {
    return null;
  }
  try {
    if (namespace == null) {
      // Runtime media is always tenant-prefixed. Refuse legacy/global names
      // when the caller cannot prove which tenant owns the database row.
      if (!/^t[1-9]\d*-/.test(filename)) return null;
    } else if (!isTenantMediaFilename(filename, namespace)) {
      return null;
    }
  } catch {
    return null;
  }

  const root = path.resolve(mediaRoot);
  const destination = path.resolve(root, filename);
  return path.dirname(destination) === root ? { root, destination, filename } : null;
}

function removeStoredTenantMediaSync({ mediaUrl, mediaRoot, namespace = null, onError = null }) {
  const resolved = resolveStoredTenantMediaPath({ mediaUrl, mediaRoot, namespace });
  if (!resolved) return false;
  try {
    fsSync.rmSync(resolved.destination, { force: true });
    // A cached quota must observe the deletion before the next reservation.
    // Do not discard a cache entry with in-flight reservations: expiring it is
    // enough, and it will be rescanned as soon as pending reaches zero.
    const usage = mediaUsageCache.get(resolved.root);
    if (usage) usage.expiresAt = 0;

    // Persist the directory entry removal when the filesystem supports fsync
    // on directories. Failure here is non-fatal: the unlink already succeeded.
    let directoryFd = null;
    try {
      directoryFd = fsSync.openSync(resolved.root, 'r');
      fsSync.fsyncSync(directoryFd);
    } catch {} finally {
      if (directoryFd !== null) {
        try { fsSync.closeSync(directoryFd); } catch {}
      }
    }
    return true;
  } catch (error) {
    try { onError?.(error); } catch {}
    return false;
  }
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
  normalizeMediaNamespace,
  tenantMediaPrefix,
  isTenantMediaFilename,
  getSafeMediaFilename,
  configuredStorageLimits,
  estimatedMediaBytes,
  knownWhatsAppMediaSize,
  assertKnownInboundMediaSize,
  saveMessageMedia,
  resolveStoredTenantMediaPath,
  removeStoredTenantMediaSync,
  unavailableMediaContent
};
