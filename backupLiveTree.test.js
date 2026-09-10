'use strict';

// Backup com o sistema NO AR: arquivo que some no meio da copia nao pode
// derrubar o snapshot inteiro.
//
// Descoberto em 10/09/2026, ao instalar o backup agendado: a primeira execucao
// morreu com
//   ENOENT: no such file or directory, lstat
//   '/app/.wwebjs_auth/tenant_1/session/Default/Cache/Cache_Data/63557e...'
// O Chromium reescreve o proprio cache o tempo todo enquanto a sessao do
// WhatsApp esta conectada, entao um arquivo listado pelo readdir ja nao existe
// quando chega a vez de copia-lo.
//
// Isso explica por que os unicos backups que existiam eram os do deploy: la o
// app esta parado. Todo backup rodado com o sistema em producao falhava — e
// falhava calado, porque ninguem lia a saida.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { copySnapshotTree } = require('./scripts/backup');

function criarArvore() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-live-tree-'));
  const origem = path.join(raiz, 'origem');
  fs.mkdirSync(path.join(origem, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(origem, 'credenciais.json'), '{"sessao":"vale"}');
  fs.writeFileSync(path.join(origem, 'cache', 'a.tmp'), 'descartavel-a');
  fs.writeFileSync(path.join(origem, 'cache', 'b.tmp'), 'descartavel-b');
  return { raiz, origem, destino: path.join(raiz, 'destino') };
}

// Substitui uma funcao do fs por uma versao que finge ENOENT em um caminho
// especifico. O backup.js guarda a referencia do mesmo objeto de modulo, entao
// trocar a propriedade aqui alcanca a copia de verdade.
function comArquivoSumindo(nomeDaFuncao, alvo, corpo) {
  const original = fsp[nomeDaFuncao];
  fsp[nomeDaFuncao] = async (caminho, ...resto) => {
    if (String(caminho).endsWith(alvo)) {
      const erro = new Error(`ENOENT: no such file or directory, ${nomeDaFuncao} '${caminho}'`);
      erro.code = 'ENOENT';
      throw erro;
    }
    return original.call(fsp, caminho, ...resto);
  };
  return corpo().finally(() => { fsp[nomeDaFuncao] = original; });
}

test('arquivo que some antes do lstat nao derruba o backup', async () => {
  const { origem, destino } = criarArvore();

  const resumo = await comArquivoSumindo('lstat', path.join('cache', 'a.tmp'), () =>
    copySnapshotTree(origem, destino));

  assert.equal(resumo.vanishedDuringCopy, 1, 'o sumico precisa ser contado, nao engolido');
  assert.equal(resumo.files, 2, 'os outros dois arquivos foram copiados');
  // O que interessa de verdade: as credenciais da sessao continuam no snapshot.
  assert.equal(
    fs.readFileSync(path.join(destino, 'credenciais.json'), 'utf8'),
    '{"sessao":"vale"}'
  );
  assert.equal(fs.existsSync(path.join(destino, 'cache', 'a.tmp')), false);
  assert.equal(fs.existsSync(path.join(destino, 'cache', 'b.tmp')), true);
});

test('arquivo que some entre o lstat e a copia nao deixa destino vazio para tras', async () => {
  const { origem, destino } = criarArvore();

  const resumo = await comArquivoSumindo('copyFile', path.join('cache', 'b.tmp'), () =>
    copySnapshotTree(origem, destino));

  assert.equal(resumo.vanishedDuringCopy, 1);
  assert.equal(resumo.files, 2);
  // Um arquivo de 0 byte sobrando entraria no hash da arvore como se fosse
  // conteudo real, e a verificacao passaria validando um arquivo inexistente.
  assert.equal(fs.existsSync(path.join(destino, 'cache', 'b.tmp')), false);
});

test('o hash da arvore ignora o que sumiu, para a verificacao continuar batendo', async () => {
  const { origem, destino } = criarArvore();
  const comSumico = await comArquivoSumindo('lstat', path.join('cache', 'a.tmp'), () =>
    copySnapshotTree(origem, destino));

  // Mesma arvore, mas com o arquivo realmente ausente desde o inicio: o hash
  // precisa ser o mesmo, senao verify-backup recusaria o snapshot depois.
  const { origem: origem2, destino: destino2 } = criarArvore();
  fs.rmSync(path.join(origem2, 'cache', 'a.tmp'));
  const semOArquivo = await copySnapshotTree(origem2, destino2);

  assert.equal(comSumico.sha256, semOArquivo.sha256);
  assert.equal(comSumico.bytes, semOArquivo.bytes);
});

test('origem que desaparece inteira ainda e erro', async () => {
  const { origem, destino } = criarArvore();

  // Aqui nao ha o que tolerar: publicar um snapshot vazio como valido seria
  // pior do que nao ter backup nenhum.
  await assert.rejects(
    () => comArquivoSumindo('lstat', 'origem', () => copySnapshotTree(origem, destino)),
    /ENOENT/
  );
});
