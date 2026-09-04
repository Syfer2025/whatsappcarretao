'use strict';
/**
 * Proxy de quadradinhos (tiles) de mapa, servidos pelo proprio servidor.
 *
 * Por que proxy e nao imagem direta no navegador: a CSP do painel permite
 * imagem apenas de 'self' (server.js: imgSrc). Liberar um host de mapa
 * afrouxaria a politica para toda a aplicacao, e faria o navegador de CADA
 * atendente enviar a coordenada do CLIENTE para um servico de terceiro. Aqui
 * so o servidor conversa com o OpenStreetMap, uma vez por tile, e guarda em
 * disco.
 *
 * A politica de uso do OpenStreetMap exige User-Agent identificavel e proibe
 * uso em massa. O cache atende as duas coisas: uma localizacao aberta dez
 * vezes busca zero tile a mais.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const TILE_HOST = process.env.MAP_TILE_HOST || 'https://tile.openstreetmap.org';
const USER_AGENT = process.env.MAP_TILE_USER_AGENT
  || 'WhatsCarretao/1.0 (painel interno de atendimento; contato via administrador do sistema)';
const FETCH_TIMEOUT_MS = Number(process.env.MAP_TILE_TIMEOUT_MS || 8000);
const MAX_TILE_BYTES = Number(process.env.MAP_TILE_MAX_BYTES || 512 * 1024);
const CACHE_TTL_MS = Number(process.env.MAP_TILE_CACHE_TTL_MS || 30 * 24 * 60 * 60 * 1000);

const ZOOM_MIN = 1;
const ZOOM_MAX = 19;

function isInteger(value) {
  return Number.isSafeInteger(value);
}

/**
 * Valida z/x/y antes de qualquer I/O. Sem isto um x/y arbitrario viraria
 * caminho de arquivo e requisicao externa controlada por quem chama.
 */
function parseTileCoords({ z, x, y }) {
  const zoom = Number(z);
  const tileX = Number(x);
  const tileY = Number(y);
  if (!isInteger(zoom) || zoom < ZOOM_MIN || zoom > ZOOM_MAX) {
    throw new Error('Zoom invalido');
  }
  const limite = 2 ** zoom;
  if (!isInteger(tileX) || tileX < 0 || tileX >= limite) throw new Error('Coordenada X invalida');
  if (!isInteger(tileY) || tileY < 0 || tileY >= limite) throw new Error('Coordenada Y invalida');
  return { zoom, tileX, tileY };
}

function cachePathFor(cacheRoot, { zoom, tileX, tileY }) {
  // Nome derivado apenas de inteiros ja validados: nao ha componente vindo
  // de texto livre, entao nao existe travessia de caminho possivel.
  return path.join(cacheRoot, `${zoom}-${tileX}-${tileY}.png`);
}

async function readFresh(arquivo) {
  try {
    const info = await fsp.stat(arquivo);
    if (Date.now() - info.mtimeMs > CACHE_TTL_MS) return null;
    return await fsp.readFile(arquivo);
  } catch {
    return null;
  }
}

async function fetchTile({ zoom, tileX, tileY }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resposta = await fetch(`${TILE_HOST}/${zoom}/${tileX}/${tileY}.png`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/png,image/*' },
      signal: controller.signal
    });
    if (!resposta.ok) throw new Error(`Servico de mapa respondeu ${resposta.status}`);

    const tipo = String(resposta.headers.get('content-type') || '');
    if (!/^image\//i.test(tipo)) throw new Error('Servico de mapa nao devolveu imagem');

    const buffer = Buffer.from(await resposta.arrayBuffer());
    if (!buffer.length) throw new Error('Servico de mapa devolveu imagem vazia');
    if (buffer.length > MAX_TILE_BYTES) throw new Error('Imagem de mapa acima do limite');
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Devolve o PNG do tile, do cache quando possivel.
 * @returns {Promise<{ buffer: Buffer, fromCache: boolean }>}
 */
async function getTile(params, { cacheRoot }) {
  const coords = parseTileCoords(params);
  const arquivo = cachePathFor(cacheRoot, coords);

  const emCache = await readFresh(arquivo);
  if (emCache) return { buffer: emCache, fromCache: true };

  const buffer = await fetchTile(coords);

  // Gravacao best-effort: falha de disco nao pode impedir a resposta, o mapa
  // apenas deixa de ser cacheado.
  try {
    await fsp.mkdir(cacheRoot, { recursive: true });
    const temporario = `${arquivo}.${process.pid}.tmp`;
    await fsp.writeFile(temporario, buffer);
    await fsp.rename(temporario, arquivo);
  } catch {
    // segue sem cache
  }

  return { buffer, fromCache: false };
}

function ensureCacheRoot(cacheRoot) {
  try {
    fs.mkdirSync(cacheRoot, { recursive: true });
  } catch {
    // sem cache: getTile continua funcionando, so busca sempre
  }
}

module.exports = {
  getTile,
  parseTileCoords,
  ensureCacheRoot,
  ZOOM_MIN,
  ZOOM_MAX
};
