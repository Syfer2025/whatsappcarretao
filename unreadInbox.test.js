'use strict';

// Conversa nao lida sobe para o topo e o painel mostra um total de nao lidas.
//
// Antes, a lista era ordenada so pela atividade mais recente: uma conversa que
// ninguem abriu ia descendo conforme outras mensagens chegavam ate sair da
// primeira pagina. Quem estava esperando resposta simplesmente sumia da tela.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { ensureSchema } = require('./schema');
const {
  countUnreadConversations,
  getVisibleConversations,
  markConversationRead,
  updateConversationUserState
} = require('./messageQueries');

const ADMIN = { role: 'admin', id: 1 };
const JACKSON = { role: 'vendor', id: 9, sector_id: 4 };
const MARIA = { role: 'vendor', id: 8, sector_id: 4 };

// O baseline fica ANTES de tudo de proposito: assim as mensagens do cenario
// contam como nao lidas. Em producao ele marca o momento em que a conta passou a
// existir, para uma conta nova nao herdar o historico inteiro como "nao lido".
function createDb() {
  const db = new Database(':memory:');
  ensureSchema(db);
  db.prepare("INSERT INTO sectors (id, name) VALUES (4, 'Vendas')").run();
  db.prepare("INSERT INTO admins (id, name, username, password) VALUES (1, 'Admin', 'admin', 'hash')").run();
  db.prepare("INSERT INTO vendors (id, name, username, password, sector_id) VALUES (9, 'Jackson', 'jackson', 'hash', 4)").run();
  db.prepare("INSERT INTO vendors (id, name, username, password, sector_id) VALUES (8, 'Maria', 'maria', 'hash', 4)").run();

  // 10 = antiga com mensagem do cliente sem abrir.
  // 11 = movimentada agora, mas so com resposta do vendedor: nada a ler.
  // 12 = da Maria, para provar que o total de um vendedor nao conta a do colega.
  db.prepare("INSERT INTO conversations (id, phone, contact_name, assigned_to, sector_id, status) VALUES (10, 'a@lid', 'Antiga sem abrir', 9, 4, 'active')").run();
  db.prepare("INSERT INTO conversations (id, phone, contact_name, assigned_to, sector_id, status) VALUES (11, 'b@lid', 'Recente ja lida', 9, 4, 'active')").run();
  db.prepare("INSERT INTO conversations (id, phone, contact_name, assigned_to, sector_id, status) VALUES (12, 'c@lid', 'Da Maria', 8, 4, 'active')").run();

  db.prepare(`
    INSERT INTO messages (id, conversation_id, from_type, content, vendor_id, delivery_status, created_at)
    VALUES
      (1, 10, 'client', 'bom dia, tem essa peca?', NULL, 'received', '2026-09-10 09:00:00'),
      (2, 10, 'client', 'alo?',                    NULL, 'received', '2026-09-10 09:05:00'),
      (3, 11, 'vendor', 'ja enviei o orcamento',      9, 'sent',     '2026-09-10 11:00:00'),
      (4, 12, 'client', 'oi Maria',               NULL, 'received', '2026-09-10 10:00:00')
  `).run();

  db.prepare("UPDATE admins SET inbox_baseline_at = '2026-09-10 08:00:00', inbox_baseline_message_id = 0").run();
  db.prepare("UPDATE vendors SET inbox_baseline_at = '2026-09-10 08:00:00', inbox_baseline_message_id = 0").run();
  return db;
}

function idsVisiveis(db, user) {
  return getVisibleConversations({ db, user }).map(c => c.id);
}

test('conversa nao aberta fica no topo, mesmo com outra mais recente embaixo', () => {
  const db = createDb();
  const lista = getVisibleConversations({ db, user: JACKSON });

  assert.deepEqual(lista.map(c => c.id), [10, 11], 'a nao lida precisa vir primeiro');
  assert.equal(lista[0].unread_count, 2, 'as duas mensagens do cliente contam');
  assert.equal(lista[1].unread_count, 0, 'resposta do proprio vendedor nao e "nao lida"');

  // A 11 e mesmo a mais recente: sem a regra de nao lidas ela lideraria.
  assert.ok(lista[1].last_activity_at > lista[0].last_activity_at);
});

test('depois de abrir, a conversa volta para a ordem por data', () => {
  const db = createDb();
  markConversationRead({ db, conversationId: 10, user: JACKSON });

  const lista = getVisibleConversations({ db, user: JACKSON });
  assert.deepEqual(lista.map(c => c.id), [11, 10], 'lida volta a ordenar por atividade');
  assert.equal(lista[1].unread_count, 0);
});

test('marcar como nao lida devolve a conversa ao topo', () => {
  const db = createDb();
  markConversationRead({ db, conversationId: 10, user: JACKSON });
  assert.deepEqual(idsVisiveis(db, JACKSON), [11, 10]);

  updateConversationUserState({ db, conversationId: 10, user: JACKSON, patch: { markedUnread: true } });
  assert.deepEqual(idsVisiveis(db, JACKSON), [10, 11], 'escolha explicita do usuario vale');
});

test('nao lida fica acima ate de conversa fixada e ja lida', () => {
  const db = createDb();
  // A 11 esta fixada e nao tem nada a ler; a 10 tem duas mensagens sem abrir.
  updateConversationUserState({ db, conversationId: 11, user: JACKSON, patch: { pinned: true } });

  // Com a lista paginada, um punhado de fixadas ja lidas empurraria quem esta
  // esperando resposta para fora da primeira pagina.
  assert.deepEqual(idsVisiveis(db, JACKSON), [10, 11], 'nao lida vem primeiro');
});

test('fixar continua ordenando DENTRO de cada grupo', () => {
  const db = createDb();
  // Duas nao lidas: a 12 e mais recente que a 10, entao lideraria por data.
  db.prepare('UPDATE conversations SET assigned_to = 9 WHERE id = 12').run();
  assert.deepEqual(idsVisiveis(db, JACKSON), [12, 10, 11], 'nao lidas por data, lida por ultimo');

  // Fixar a 10 a coloca na frente da 12 — mas as duas seguem acima da lida.
  updateConversationUserState({ db, conversationId: 10, user: JACKSON, patch: { pinned: true } });
  assert.deepEqual(idsVisiveis(db, JACKSON), [10, 12, 11], 'fixada primeiro entre as nao lidas');

  // E entre as lidas a fixacao tambem vale: 11 e a unica lida, fixa-la nao a
  // tira do fim, porque nao lida ganha sempre.
  updateConversationUserState({ db, conversationId: 11, user: JACKSON, patch: { pinned: true } });
  assert.deepEqual(idsVisiveis(db, JACKSON), [10, 12, 11], 'fixar uma lida nao a poe acima de nao lidas');
});

test('o total de nao lidas conta conversas e mensagens', () => {
  const db = createDb();
  // O admin enxerga tudo: a conversa do Jackson e a da Maria.
  assert.deepEqual(countUnreadConversations({ db, user: ADMIN }), { conversations: 2, messages: 3 });
});

test('o total do vendedor nao inclui a conversa do colega', () => {
  const db = createDb();
  assert.deepEqual(countUnreadConversations({ db, user: JACKSON }), { conversations: 1, messages: 2 });
  assert.deepEqual(countUnreadConversations({ db, user: MARIA }), { conversations: 1, messages: 1 });
});

test('abrir a conversa zera o total daquele usuario', () => {
  const db = createDb();
  markConversationRead({ db, conversationId: 10, user: JACKSON });
  assert.deepEqual(countUnreadConversations({ db, user: JACKSON }), { conversations: 0, messages: 0 });

  // Cada um tem sua propria leitura: o admin ainda nao abriu nada.
  assert.equal(countUnreadConversations({ db, user: ADMIN }).conversations, 2);
});

test('conversa arquivada nao entra no total', () => {
  const db = createDb();
  db.prepare('UPDATE conversations SET whatsapp_archived = 1 WHERE id = 10').run();

  assert.deepEqual(countUnreadConversations({ db, user: JACKSON }), { conversations: 0, messages: 0 });
  assert.equal(countUnreadConversations({ db, user: ADMIN }).conversations, 1, 'a da Maria continua contando');
});

test('marcar como nao lida sem mensagem nova ainda conta como uma', () => {
  const db = createDb();
  markConversationRead({ db, conversationId: 11, user: JACKSON });
  updateConversationUserState({ db, conversationId: 11, user: JACKSON, patch: { markedUnread: true } });

  const total = countUnreadConversations({ db, user: JACKSON });
  assert.equal(total.conversations, 2, 'a 10 e a 11');
  assert.equal(total.messages, 3, 'as 2 mensagens reais da 10 mais o piso de 1 da 11');
});
