'use strict';

const os = require('node:os');

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const BASE_CONTAINER_MEMORY_BYTES = 768 * MIB;
const MEMORY_PER_WHATSAPP_SESSION_BYTES = 768 * MIB;
const BASE_CONTAINER_CPU = 0.5;
const CPU_PER_WHATSAPP_SESSION = 0.5;
const HOST_MEMORY_RESERVE_BYTES = GIB;
const HOST_CPU_RESERVE = 0.5;

function valueOf(env, name, fallback) {
  const value = env[name];
  return value === undefined || value === null || String(value).trim() === '' ? fallback : String(value).trim();
}

function parsePositiveInteger(value, name) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error(`${name} deve ser um inteiro positivo`);
  }
  return Number(value);
}

function parseCpuLimit(value) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error('CPU_LIMIT deve ser um número positivo');
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('CPU_LIMIT deve ser um número positivo');
  }
  return parsed;
}

function parseMemoryLimit(value) {
  const match = String(value)
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*([kmgt]i?b?|b)?$/);
  if (!match) {
    throw new Error('MEMORY_LIMIT deve usar formato Docker, por exemplo 6g ou 6144m');
  }

  const amount = Number(match[1]);
  const unit = match[2] || 'b';
  const multipliers = {
    b: 1,
    k: 1024,
    kb: 1024,
    kib: 1024,
    m: MIB,
    mb: MIB,
    mib: MIB,
    g: GIB,
    gb: GIB,
    gib: GIB,
    t: 1024 * GIB,
    tb: 1024 * GIB,
    tib: 1024 * GIB,
  };
  const bytes = amount * multipliers[unit];
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error('MEMORY_LIMIT deve representar uma quantidade positiva e segura de bytes');
  }
  return bytes;
}

function readCapacityConfiguration(env = process.env) {
  const cpuLimit = parseCpuLimit(valueOf(env, 'CPU_LIMIT', '3.0'));
  const memoryLimitBytes = parseMemoryLimit(valueOf(env, 'MEMORY_LIMIT', '6g'));
  const whatsappSessions = parsePositiveInteger(
    valueOf(env, 'WA_MAX_CONCURRENT_SESSIONS', '5'),
    'WA_MAX_CONCURRENT_SESSIONS',
  );
  const minimumContainerCpu = BASE_CONTAINER_CPU + whatsappSessions * CPU_PER_WHATSAPP_SESSION;
  const minimumContainerMemoryBytes =
    BASE_CONTAINER_MEMORY_BYTES + whatsappSessions * MEMORY_PER_WHATSAPP_SESSION_BYTES;

  return {
    cpuLimit,
    memoryLimitBytes,
    whatsappSessions,
    minimumContainerCpu,
    minimumContainerMemoryBytes,
    minimumHostCpu: Math.ceil(cpuLimit + HOST_CPU_RESERVE),
    minimumHostMemoryBytes: memoryLimitBytes + HOST_MEMORY_RESERVE_BYTES,
  };
}

function validateCapacityConfiguration(env = process.env) {
  const errors = [];
  let configuration;
  try {
    configuration = readCapacityConfiguration(env);
  } catch (error) {
    errors.push(error.message);
    return { errors, configuration: null };
  }

  if (configuration.cpuLimit < configuration.minimumContainerCpu) {
    errors.push(
      `CPU_LIMIT=${configuration.cpuLimit} é insuficiente para ${configuration.whatsappSessions} sessões; ` +
        `configure ao menos ${configuration.minimumContainerCpu.toFixed(1)} CPUs`,
    );
  }
  if (configuration.memoryLimitBytes < configuration.minimumContainerMemoryBytes) {
    errors.push(
      `MEMORY_LIMIT é insuficiente para ${configuration.whatsappSessions} sessões; ` +
        `configure ao menos ${formatGiB(configuration.minimumContainerMemoryBytes)}`,
    );
  }

  return { errors, configuration };
}

function evaluateHostCapacity(
  env = process.env,
  {
    logicalCpuCount = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
    totalMemoryBytes = os.totalmem(),
  } = {},
) {
  const result = validateCapacityConfiguration(env);
  const errors = [...result.errors];
  const { configuration } = result;
  if (!configuration) return { errors, configuration, logicalCpuCount, totalMemoryBytes };

  if (!Number.isSafeInteger(logicalCpuCount) || logicalCpuCount <= 0) {
    errors.push('não foi possível determinar a quantidade de CPUs lógicas do host');
  } else if (logicalCpuCount < configuration.minimumHostCpu) {
    errors.push(
      `host com ${logicalCpuCount} CPUs lógicas é insuficiente: CPU_LIMIT=${configuration.cpuLimit} ` +
        `exige ao menos ${configuration.minimumHostCpu} CPUs no host, incluindo reserva para o sistema`,
    );
  }

  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    errors.push('não foi possível determinar a memória total do host');
  } else if (totalMemoryBytes < configuration.minimumHostMemoryBytes) {
    errors.push(
      `host com ${formatGiB(totalMemoryBytes)} de RAM é insuficiente: MEMORY_LIMIT=${formatGiB(
        configuration.memoryLimitBytes,
      )} exige ao menos ${formatGiB(configuration.minimumHostMemoryBytes)} no host, ` +
        'incluindo 1,00 GiB reservado para sistema, proxy e Docker',
    );
  }

  return { errors, configuration, logicalCpuCount, totalMemoryBytes };
}

function formatGiB(bytes) {
  return `${(Number(bytes) / GIB).toFixed(2).replace('.', ',')} GiB`;
}

if (require.main === module) {
  const result = evaluateHostCapacity();
  if (result.errors.length) {
    for (const error of result.errors) process.stderr.write(`ERRO: ${error}\n`);
    process.stderr.write(
      'ERRO: capacidade incompatível; ajuste CPU_LIMIT/MEMORY_LIMIT/sessões ou use uma VPS maior antes do deploy.\n',
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Capacidade do host validada: ${result.logicalCpuCount} CPUs, ${formatGiB(
        result.totalMemoryBytes,
      )} RAM, ${result.configuration.whatsappSessions} sessões.\n`,
    );
  }
}

module.exports = {
  evaluateHostCapacity,
  formatGiB,
  parseCpuLimit,
  parseMemoryLimit,
  readCapacityConfiguration,
  validateCapacityConfiguration,
};
