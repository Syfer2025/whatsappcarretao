'use strict';

// Trava a correcao da janela de autorizacao encontrada na auditoria de
// 09/09/2026 (item W-04).
//
// O que acontecia: PATCH /api/conversations/:id/block conferia o dono da
// conversa no inicio e so depois ia buscar o contato no WhatsApp — uma espera
// de ate 13 segundos. Se nesse intervalo o admin transferisse a conversa ou
// revogasse a sessao de quem pediu, o bloqueio era aplicado assim mesmo e a
// rota respondia 200. A conferencia inicial virava um passe permanente para um
// efeito externo e irreversivel pelo painel.
//
// A fila de envio ja resolvia isso revalidando ao sair da fila; o conserto foi
// reusar a mesma funcao antes da chamada de bloqueio.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { assertCurrentOutboundAuthorization } = require('./messageSender');

// A funcao so toca o banco por `prepare().get()`. Um dobre em memoria cobre o
// comportamento inteiro sem SQLite e sem esquema — e deixa explicito o que cada
// consulta precisa devolver para a autorizacao valer.
function bancoFake({ vendor, admin, conversas = {} }) {
  return {
    prepare(sql) {
      return {
        get(...args) {
          if (/FROM vendors/i.test(sql)) return vendor;
          if (/FROM admins/i.test(sql)) return admin;
          if (/FROM conversations/i.test(sql)) return conversas[Number(args[0])];
          return undefined;
        }
      };
    }
  };
}

const VENDEDOR = { id: 9, role: 'vendor', token_version: 3, sector_id: 4 };

test('autoriza quando nada mudou desde a checagem da rota', () => {
  const db = bancoFake({
    vendor: { id: 9, sector_id: 4, token_version: 3 },
    conversas: { 100: { id: 100, assigned_to: 9, sector_id: 4 } }
  });
  assert.doesNotThrow(() => assertCurrentOutboundAuthorization(db, VENDEDOR, 100));
});

test('recusa quando a conversa foi transferida durante a espera', () => {
  const db = bancoFake({
    vendor: { id: 9, sector_id: 4, token_version: 3 },
    // O admin passou a conversa para o vendedor 12 enquanto o WhatsApp
    // respondia a busca do contato.
    conversas: { 100: { id: 100, assigned_to: 12, sector_id: 4 } }
  });
  assert.throws(
    () => assertCurrentOutboundAuthorization(db, VENDEDOR, 100),
    err => err.code === 'OUTBOUND_AUTHORIZATION_REVOKED' && err.statusCode === 403
  );
});

test('recusa quando a sessao do solicitante foi revogada durante a espera', () => {
  const db = bancoFake({
    // Logout, troca de setor ou desativacao incrementam token_version.
    vendor: { id: 9, sector_id: 4, token_version: 4 },
    conversas: { 100: { id: 100, assigned_to: 9, sector_id: 4 } }
  });
  assert.throws(
    () => assertCurrentOutboundAuthorization(db, VENDEDOR, 100),
    err => err.code === 'OUTBOUND_AUTHORIZATION_REVOKED'
  );
});

test('recusa quando o vendedor foi desativado durante a espera', () => {
  // A consulta filtra por active = 1: vendedor desativado simplesmente some.
  const db = bancoFake({
    vendor: undefined,
    conversas: { 100: { id: 100, assigned_to: 9, sector_id: 4 } }
  });
  assert.throws(
    () => assertCurrentOutboundAuthorization(db, VENDEDOR, 100),
    err => err.code === 'OUTBOUND_AUTHORIZATION_REVOKED'
  );
});

test('a mensagem de erro diz o que deixou de acontecer, nao "nao foi enviada"', () => {
  const db = bancoFake({
    vendor: { id: 9, sector_id: 4, token_version: 3 },
    conversas: { 100: { id: 100, assigned_to: 12, sector_id: 4 } }
  });

  // Sem opcao: texto historico da fila de envio.
  assert.throws(
    () => assertCurrentOutboundAuthorization(db, VENDEDOR, 100),
    /a mensagem não foi enviada/
  );

  // Com opcao: o vendedor precisa entender que a conversa saiu das maos dele, e
  // nao achar que o WhatsApp falhou.
  assert.throws(
    () => assertCurrentOutboundAuthorization(db, VENDEDOR, 100, [], {
      consequence: 'o contato não foi bloqueado'
    }),
    /o contato não foi bloqueado/
  );
});

// ── Auditoria do codigo: vale para o que ainda vai ser escrito ──────────────

const SERVER = fs.readFileSync('server.js', 'utf8');

function corpoDaRota(fonte, assinatura) {
  const inicio = fonte.indexOf(assinatura);
  assert.notEqual(inicio, -1, `rota nao encontrada em server.js: ${assinatura}`);
  const linhas = fonte.slice(inicio).split('\n');
  let fim = 1;
  while (fim < linhas.length && !/^app\.(get|post|put|patch|delete|use)\(/.test(linhas[fim])) fim++;
  return linhas.slice(0, fim).join('\n');
}

test('a rota de bloqueio revalida a autorizacao antes de falar com o WhatsApp', () => {
  const corpo = corpoDaRota(SERVER, "app.patch('/api/conversations/:id/block'");

  assert.match(
    corpo,
    /assertCurrentOutboundAuthorization\(/,
    'A rota espera o WhatsApp responder antes de bloquear. Sem revalidar, uma '
    + 'transferencia ou um logout durante essa espera ainda aplicam o bloqueio.'
  );

  // A ordem importa: revalidar depois da acao externa nao desfaz nada.
  const posRevalidacao = corpo.indexOf('assertCurrentOutboundAuthorization(');
  const posAcao = corpo.indexOf('action.call(contact)');
  assert.notEqual(posAcao, -1, 'a chamada de bloqueio mudou de forma; revise esta trava');
  assert.ok(
    posRevalidacao < posAcao,
    'a revalidacao precisa vir ANTES de action.call(contact)'
  );
});

test('a saude do WhatsApp tem rota propria e nao derruba o healthcheck do container', () => {
  assert.match(
    SERVER,
    /app\.get\('\/health\/whatsapp',\s*sendWhatsAppReadiness\)/,
    'monitoramento externo precisa de uma rota que caia quando o canal cair'
  );

  // /health/ready e o que o Docker consulta. Se ele passar a depender da sessao,
  // uma queda de WhatsApp vira reinicio do container inteiro — painel, filas e
  // conexoes dos vendedores junto.
  const corpo = SERVER.slice(
    SERVER.indexOf('function sendReadiness'),
    SERVER.indexOf('function sendWhatsAppReadiness')
  );
  assert.ok(corpo.length > 0, 'sendReadiness sumiu do server.js');
  // Só a linha que calcula `ok` importa: a contagem de sessoes continua no
  // corpo da resposta, e deve continuar — ela e informativa.
  const calculoDoOk = corpo.split('\n').find(linha => /^\s*const ok\s*=/.test(linha));
  assert.ok(calculoDoOk, 'sendReadiness nao calcula mais `ok`; revise esta trava');
  assert.doesNotMatch(
    calculoDoOk,
    /readySessions|listSessions|\.ready/,
    'sendReadiness nao pode decidir 200/503 pela sessao do WhatsApp'
  );
});
