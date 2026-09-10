'use strict';

// Leitura do orçamento de memória do próprio container.
//
// O Chromium vinha sendo morto pelo OOM killer do cgroup dezenas de vezes sem
// que nada disso aparecesse na aplicação: `RestartCount` ficava em zero (o Node
// sobrevive à morte do navegador), o /health continuava verde e a única prova
// estava no log do kernel do host — fora do alcance de quem opera o sistema.
//
// O kernel já mantém os três números que interessam, e o cgroup do container é
// visível de dentro dele. Ler daqui é mais barato e mais fiel do que somar
// processos: `memory.current` é exatamente o valor comparado com `memory.max`
// na hora de decidir matar alguém, e `memory.events` traz o contador de mortes
// acumuladas.
//
// Tudo é opcional por natureza — em Windows, macOS ou fora de container os
// arquivos não existem. Qualquer falha vira `null`, nunca uma exceção: isto
// alimenta uma rota de saúde e jamais pode ser o motivo de ela cair.

const fs = require('fs');

const CGROUP_V2_ROOT = '/sys/fs/cgroup';
const CGROUP_V1_ROOT = '/sys/fs/cgroup/memory';

function readFirstNumber(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw || raw === 'max') return null;
    const value = Number(raw.split(/\s+/)[0]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

// memory.events é um "chave valor" por linha; oom_kill acumula desde a criação
// do cgroup, então o número só faz sentido comparado com uma leitura anterior.
function readEventCounter(file, key) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      const [name, value] = line.trim().split(/\s+/);
      if (name === key) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      }
    }
  } catch {}
  return null;
}

function readCgroupV2() {
  const current = readFirstNumber(`${CGROUP_V2_ROOT}/memory.current`);
  if (current === null) return null;
  return {
    version: 2,
    usedBytes: current,
    limitBytes: readFirstNumber(`${CGROUP_V2_ROOT}/memory.max`),
    peakBytes: readFirstNumber(`${CGROUP_V2_ROOT}/memory.peak`),
    oomKills: readEventCounter(`${CGROUP_V2_ROOT}/memory.events`, 'oom_kill'),
    underPressure: readEventCounter(`${CGROUP_V2_ROOT}/memory.events`, 'high')
  };
}

function readCgroupV1() {
  const current = readFirstNumber(`${CGROUP_V1_ROOT}/memory.usage_in_bytes`);
  if (current === null) return null;
  const limit = readFirstNumber(`${CGROUP_V1_ROOT}/memory.limit_in_bytes`);
  return {
    version: 1,
    usedBytes: current,
    // Sem limite definido o kernel devolve um número absurdo (perto de 2^63);
    // reportar isso como "limite" enganaria mais do que ajudaria.
    limitBytes: limit !== null && limit < Number.MAX_SAFE_INTEGER / 2 ? limit : null,
    peakBytes: readFirstNumber(`${CGROUP_V1_ROOT}/memory.max_usage_in_bytes`),
    oomKills: readEventCounter(`${CGROUP_V1_ROOT}/memory.oom_control`, 'oom_kill'),
    underPressure: null
  };
}

function getContainerMemory() {
  const cgroup = readCgroupV2() || readCgroupV1();
  const process_ = process.memoryUsage();
  const node = {
    rssBytes: process_.rss,
    heapUsedBytes: process_.heapUsed,
    heapTotalBytes: process_.heapTotal,
    externalBytes: process_.external
  };
  if (!cgroup) return { available: false, node };

  const usedPercent = cgroup.limitBytes
    ? Math.round((cgroup.usedBytes / cgroup.limitBytes) * 1000) / 10
    : null;
  return {
    available: true,
    ...cgroup,
    usedPercent,
    // O Node é só uma parte do total: o resto é Chromium mais o que estiver
    // escrito nos tmpfs montados no container (/tmp e /dev/shm contam aqui).
    node
  };
}

module.exports = { getContainerMemory };
