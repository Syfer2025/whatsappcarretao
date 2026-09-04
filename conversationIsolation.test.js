const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const { ensureSchema } = require('./schema');
const {
  canAccessConversation,
  getVisibleConversations,
  getConversationMessages,
  searchVisibleContent,
  getStarredMessages
} = require('./messageQueries');

/**
 * ISOLAMENTO DA CONVERSA — a regra que nao pode cair nunca.
 *
 * O vendedor so alcanca a conversa que o ADMIN atribuiu a ele. Nem lista, nem
 * busca, nem favorito, nem evento em tempo real, nem envio. Setor nao da acesso
 * a nada.
 *
 * Em 04/09/2026 o cliente 554391070374 foi atendido por dois vendedores:
 * Jackson respondeu e passou preco (R$ 235,00) e, quase uma hora depois,
 * Lauriane entrou na MESMA conversa, cumprimentou do zero e mandou o cliente
 * falar com um terceiro vendedor. A conversa nao tinha dono e pertencer ao
 * setor bastava.
 *
 * Este arquivo existe para que isso nao volte por descuido. Alem de checar o
 * comportamento, ele AUDITA O CODIGO: rota nova que o vendedor alcance e que
 * nao filtre por dono quebra o teste, mesmo que ninguem lembre desta regra na
 * hora de escrever.
 */

const ADMIN = { role: 'admin', id: 1 };
const DONO = { role: 'vendor', id: 9, sector_id: 4 };
const COLEGA = { role: 'vendor', id: 8, sector_id: 4 };   // mesmo setor do dono
const DE_FORA = { role: 'vendor', id: 7, sector_id: 5 };  // outro setor

function criarBanco() {
  const db = new Database(':memory:');
  ensureSchema(db);
  db.prepare("INSERT INTO sectors (id, name) VALUES (4, 'Vendas'), (5, 'Suporte')").run();
  db.prepare("INSERT INTO admins (id, name, username, password) VALUES (1, 'Admin', 'admin', 'h')").run();
  db.prepare(`INSERT INTO vendors (id, name, username, password, sector_id) VALUES
    (9, 'Jackson', 'jackson', 'h', 4),
    (8, 'Lauriane', 'lauriane', 'h', 4),
    (7, 'Externo', 'externo', 'h', 5)`).run();
  db.prepare(`INSERT INTO conversations (id, phone, contact_name, assigned_to, sector_id, status) VALUES
    (1, 'cliente-do-jackson@c.us', 'Cliente do Jackson', 9, 4, 'active'),
    (2, 'sem-dono@c.us', 'Cliente sem dono', NULL, 4, 'unassigned')`).run();
  db.prepare(`INSERT INTO messages (id, conversation_id, from_type, content, delivery_status, created_at) VALUES
    (1, 1, 'client', 'paralama fechado 440 tem qual valor', 'received', '2026-09-04 16:49:24'),
    (2, 1, 'vendor', '235,00', 'sent', '2026-09-04 17:49:07'),
    (3, 2, 'client', 'orcamento por favor', 'received', '2026-09-04 18:00:00')`).run();
  return db;
}

test('a regra: so quem recebeu a conversa alcanca a conversa', () => {
  assert.equal(canAccessConversation(ADMIN, { assigned_to: null, sector_id: 4 }), true, 'admin recebe tudo');
  assert.equal(canAccessConversation(DONO, { assigned_to: 9, sector_id: 4 }), true, 'dono alcanca a dele');

  // O caso do incidente: mesmo setor NAO da acesso.
  assert.equal(canAccessConversation(COLEGA, { assigned_to: 9, sector_id: 4 }), false);
  // Conversa que ainda nao foi distribuida e do admin, de mais ninguem.
  assert.equal(canAccessConversation(COLEGA, { assigned_to: null, sector_id: 4 }), false);
  assert.equal(canAccessConversation(DE_FORA, { assigned_to: 9, sector_id: 4 }), false);
  // Atribuicao vale mesmo quando o setor da conversa e outro: quem manda e o admin.
  assert.equal(canAccessConversation(DE_FORA, { assigned_to: 7, sector_id: 4 }), true);

  // Entradas quebradas nao podem virar acesso por acidente.
  assert.equal(canAccessConversation(null, { assigned_to: 9 }), false);
  assert.equal(canAccessConversation(DONO, null), false);
  assert.equal(canAccessConversation({ role: 'vendor' }, { assigned_to: null }), false);
  assert.equal(canAccessConversation({ role: 'vendor', id: 0 }, { assigned_to: 0 }), false);
});

test('nenhum caminho de leitura entrega a conversa de outro vendedor', () => {
  const db = criarBanco();

  assert.deepEqual(getVisibleConversations({ db, user: DONO }).map(c => c.id), [1]);
  assert.deepEqual(getVisibleConversations({ db, user: COLEGA }).map(c => c.id), []);
  assert.deepEqual(getVisibleConversations({ db, user: DE_FORA }).map(c => c.id), []);
  assert.deepEqual(getVisibleConversations({ db, user: ADMIN }).map(c => c.id).sort(), [1, 2]);

  assert.deepEqual(searchVisibleContent({ db, user: COLEGA, q: 'paralama' }).messages.map(m => m.id), []);
  assert.deepEqual(searchVisibleContent({ db, user: COLEGA, q: 'paralama' }).conversations.map(c => c.id), []);
  assert.deepEqual(searchVisibleContent({ db, user: DONO, q: 'paralama' }).messages.map(m => m.id), [1]);

  assert.deepEqual(getStarredMessages({ db, user: COLEGA }).map(m => m.id), []);

  // Ler a conversa direto pelo id tambem nao pode devolver nada.
  assert.deepEqual(
    getConversationMessages({ db, user: COLEGA, conversationId: 1 }).map(m => m.id),
    [],
    'colega de setor nao le a conversa pelo id'
  );

  db.close();
});

// ── Auditoria do codigo: vale para o que ainda vai ser escrito ──────────────

const SERVER = fs.readFileSync('server.js', 'utf8');
const QUERIES = fs.readFileSync('messageQueries.js', 'utf8');

/**
 * Rotas que o vendedor alcanca e que NAO carregam dado de conversa. Cada uma
 * precisa de justificativa aqui — e o unico jeito de sair da auditoria.
 */
const ROTAS_SEM_CONVERSA = new Map([
  ['GET /api/status', 'estado da conexao do WhatsApp da empresa; nao le conversa'],
  ['GET /api/maps/tile/:z/:x/:y', 'quadradinho de mapa vindo do OpenStreetMap; nao le conversa'],
  ['GET /api/contacts', 'agenda do numero da empresa, nao mensagens; usada para iniciar conversa'],
  ['POST /api/contacts/sync', 'sincroniza a agenda do numero da empresa com o WhatsApp']
]);

function rotasAlcancaveisPeloVendedor(fonte) {
  const linhas = fonte.split('\n');
  const rotas = [];
  for (let i = 0; i < linhas.length; i++) {
    const m = linhas[i].match(/^app\.(get|post|put|patch|delete)\('([^']+)'\s*,\s*tenantAuthMiddleware\((\[[^\]]*\]|)\)/);
    if (!m) continue;
    const [, metodo, caminho, papeis] = m;
    if (papeis && !papeis.includes("'vendor'")) continue;
    let j = i + 1;
    while (j < linhas.length && !/^app\.(get|post|put|patch|delete|use)\(/.test(linhas[j])) j++;
    rotas.push({
      chave: `${metodo.toUpperCase()} ${caminho}`,
      corpo: linhas.slice(i, j).join('\n')
    });
  }
  return rotas;
}

test('toda rota que o vendedor alcanca filtra por dono da conversa', () => {
  const rotas = rotasAlcancaveisPeloVendedor(SERVER);
  assert.ok(rotas.length >= 20, `esperava encontrar as rotas do vendedor, achei ${rotas.length}`);

  const semGuarda = [];
  for (const { chave, corpo } of rotas) {
    if (ROTAS_SEM_CONVERSA.has(chave)) continue;
    const filtra = corpo.includes('canAccessConversation')
      || corpo.includes('getVisibleConversations')
      || corpo.includes('searchVisibleContent')
      || corpo.includes('getStarredMessages')
      || corpo.includes('getConversationMessages')
      || /assigned_to\s*=\s*\?/.test(corpo);
    if (!filtra) semGuarda.push(chave);
  }

  assert.deepEqual(
    semGuarda,
    [],
    'Rota alcancavel pelo vendedor sem filtro de dono. Use canAccessConversation '
    + '(ou uma consulta de messageQueries) antes de devolver dado de conversa. Se a rota '
    + 'realmente nao le conversa, declare em ROTAS_SEM_CONVERSA com a justificativa.'
  );
});

test('setor nao volta a valer como permissao em nenhuma consulta', () => {
  // Padroes exatos que existiam antes do incidente. Se reaparecerem, o vendedor
  // volta a enxergar a conversa do colega.
  const padroesProibidos = [
    /assigned_to = \?\s*OR\s*[\w.]*sector_id = \?/i,
    /OR \(\? IS NOT NULL AND [\w.]*sector_id = \?\)/i,
    /AND \(id = \? OR \(\? IS NOT NULL AND sector_id = \?\)\)/i
  ];
  for (const padrao of padroesProibidos) {
    assert.doesNotMatch(SERVER, padrao, `server.js voltou a liberar conversa por setor: ${padrao}`);
    assert.doesNotMatch(QUERIES, padrao, `messageQueries.js voltou a liberar conversa por setor: ${padrao}`);
  }

  // A funcao de acesso nao pode consultar setor: se consultar, alguem religou a regra.
  const corpoDaRegra = QUERIES.slice(
    QUERIES.indexOf('function canAccessConversation'),
    QUERIES.indexOf('function conversationOwner')
  );
  assert.doesNotMatch(corpoDaRegra, /sector/i, 'canAccessConversation nao pode olhar setor');
});

test('o tempo real entrega apenas ao vendedor atribuido', () => {
  const corpo = SERVER.slice(
    SERVER.indexOf('function visibleUsersForConversation'),
    SERVER.indexOf('function emitTypingUpdate')
  );
  assert.ok(corpo.length > 0, 'visibleUsersForConversation sumiu do server.js');
  assert.match(corpo, /WHERE id = \? AND active = 1/, 'deve buscar o vendedor atribuido pelo id');
  assert.doesNotMatch(corpo, /sector_id = \?/, 'nao pode entregar evento para o setor inteiro');

  // Todo evento de conversa passa por esta funcao — e o unico ponto de saida.
  assert.match(SERVER, /function emitToConversationAudience/);
  assert.match(SERVER, /for \(const user of visibleUsersForConversation\(conversation\)\)/);
  assert.match(SERVER, /for \(const user of visibleUsersForConversation\(message\)\)/);
});

test('o envio recusa conversa que nao foi atribuida ao vendedor', () => {
  const sender = fs.readFileSync('messageSender.js', 'utf8');
  assert.match(sender, /SELECT assigned_to FROM conversations WHERE id = \?/);
  assert.match(sender, /Esta conversa está atribuída a/);
  assert.match(sender, /Esta conversa ainda não foi atribuída a você/);
  // A recusa precisa vir ANTES de gravar a mensagem pendente, senao sobra linha órfã.
  assert.ok(
    sender.indexOf('Esta conversa ainda não foi atribuída a você') < sender.indexOf('const pendingInsert = insertPendingMessage'),
    'a checagem de dono precisa acontecer antes de insertPendingMessage'
  );
});

test('somente o admin atribui conversa', () => {
  assert.match(SERVER, /app\.post\('\/api\/conversations\/:id\/assign', tenantAuthMiddleware\(\['admin'\]\)/);
  assert.match(SERVER, /app\.get\('\/api\/conversations\/unassigned', tenantAuthMiddleware\(\['admin'\]\)/);
  // Nada pode marcar dono sozinho: a mensagem que chega nao escolhe vendedor.
  const atribuicoesEmServer = SERVER.match(/SET[^;]*assigned_to\s*=\s*(?!NULL)/gi) || [];
  assert.deepEqual(
    atribuicoesEmServer,
    [],
    'server.js nao pode definir dono de conversa; isso e da rota de atribuicao do admin'
  );
});
