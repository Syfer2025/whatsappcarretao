'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseTileCoords, getTile } = require('./mapTiles');

// O tile e servido pelo proprio servidor de proposito: a CSP do painel so
// permite imagem de 'self', e liberar um host de mapa faria o navegador de cada
// atendente enviar a coordenada do CLIENTE para um terceiro.
test('coordenada de tile e validada antes de qualquer I/O', () => {
  assert.deepEqual(parseTileCoords({ z: 16, x: 10, y: 20 }), { zoom: 16, tileX: 10, tileY: 20 });
  assert.deepEqual(parseTileCoords({ z: '16', x: '10', y: '20' }), { zoom: 16, tileX: 10, tileY: 20 });

  // Sem estas guardas, x/y arbitrario viraria nome de arquivo no cache e
  // requisicao externa controlada por quem chama.
  assert.throws(() => parseTileCoords({ z: 0, x: 0, y: 0 }), /Zoom invalido/);
  assert.throws(() => parseTileCoords({ z: 20, x: 0, y: 0 }), /Zoom invalido/);
  assert.throws(() => parseTileCoords({ z: 16, x: -1, y: 0 }), /Coordenada X invalida/);
  assert.throws(() => parseTileCoords({ z: 16, x: 0, y: -1 }), /Coordenada Y invalida/);
  assert.throws(() => parseTileCoords({ z: 1, x: 2, y: 0 }), /Coordenada X invalida/);
  assert.throws(() => parseTileCoords({ z: 16, x: 1.5, y: 0 }), /Coordenada X invalida/);
  assert.throws(() => parseTileCoords({ z: 16, x: '../../etc/passwd', y: 0 }), /Coordenada X invalida/);
});

test('tile vem do cache na segunda chamada, sem repetir a busca externa', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiles-'));
  let buscas = 0;
  const fetchOriginal = global.fetch;
  global.fetch = async () => {
    buscas += 1;
    // PNG minimo valido o suficiente para o modulo aceitar.
    return {
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).buffer
    };
  };
  try {
    const primeira = await getTile({ z: 16, x: 1, y: 1 }, { cacheRoot });
    assert.equal(primeira.fromCache, false);
    assert.equal(buscas, 1);

    const segunda = await getTile({ z: 16, x: 1, y: 1 }, { cacheRoot });
    assert.equal(segunda.fromCache, true, 'a segunda chamada deve vir do disco');
    assert.equal(buscas, 1, 'a politica do OpenStreetMap proibe uso em massa: nao pode rebuscar');
    assert.deepEqual(segunda.buffer, primeira.buffer);
  } finally {
    global.fetch = fetchOriginal;
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('resposta que nao e imagem nao entra no cache', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tiles-'));
  const fetchOriginal = global.fetch;
  global.fetch = async () => ({
    ok: true,
    headers: { get: () => 'text/html' },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
  });
  try {
    await assert.rejects(
      getTile({ z: 16, x: 2, y: 2 }, { cacheRoot }),
      /nao devolveu imagem/
    );
    assert.equal(fs.readdirSync(cacheRoot).length, 0, 'nada deve ser gravado');
  } finally {
    global.fetch = fetchOriginal;
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});
