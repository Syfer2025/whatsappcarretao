const { isImportableChatId } = require('./whatsappUtils');
const { withTimeout } = require('./runtimeUtils');

function uniqueIdentifiers(values) {
  return [...new Set((values || []).filter(isImportableChatId))];
}

function findOpenConversationByIdentifiers(db, identifiers) {
  const ids = uniqueIdentifiers(identifiers);
  if (!ids.length) return null;
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(`
    SELECT DISTINCT c.*
    FROM conversations c
    LEFT JOIN conversation_identifiers ci ON ci.conversation_id = c.id
    WHERE c.status != 'closed'
      AND (
        c.phone IN (${placeholders})
        OR ci.identifier IN (${placeholders})
      )
    ORDER BY c.id DESC
    LIMIT 1
  `).get(...ids, ...ids) || null;
}

function linkConversationIdentifiers(db, conversationId, identifiers) {
  const ids = uniqueIdentifiers(identifiers);
  if (!conversationId || !ids.length) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO conversation_identifiers (identifier, conversation_id)
    VALUES (?, ?)
  `);
  const linkAll = db.transaction(() => {
    for (const identifier of ids) insert.run(identifier, conversationId);
  });
  linkAll();
}

function getConversationIdentifiers(db, conversationId) {
  if (!conversationId) return [];
  const conversation = db.prepare('SELECT phone FROM conversations WHERE id = ?').get(conversationId);
  const aliases = db.prepare(`
    SELECT identifier
    FROM conversation_identifiers
    WHERE conversation_id = ?
  `).all(conversationId).map(row => row.identifier);
  return uniqueIdentifiers([conversation?.phone, ...aliases]);
}

async function resolveWhatsAppIdentifierMap(client, identifiers, timeoutMs = 2500) {
  const sourceIds = uniqueIdentifiers(identifiers);
  const resolvedMap = new Map(sourceIds.map(identifier => [identifier, [identifier]]));
  const directIds = sourceIds.filter(identifier => !identifier.endsWith('@g.us'));
  if (!directIds.length || typeof client?.getContactLidAndPhone !== 'function') return resolvedMap;

  try {
    const rows = await withTimeout(
      client.getContactLidAndPhone(directIds),
      timeoutMs,
      'getContactLidAndPhone'
    );
    directIds.forEach((identifier, index) => {
      const aliases = uniqueIdentifiers([identifier, rows?.[index]?.lid, rows?.[index]?.pn]);
      for (const alias of aliases) resolvedMap.set(alias, aliases);
    });
  } catch {
    // A resolução de identidade é uma otimização de consistência. Em caso de
    // indisponibilidade do Store, o ID original continua utilizável.
  }
  return resolvedMap;
}

async function resolveWhatsAppIdentifiers(client, identifier, timeoutMs = 2500) {
  const map = await resolveWhatsAppIdentifierMap(client, [identifier], timeoutMs);
  return map.get(identifier) || uniqueIdentifiers([identifier]);
}

module.exports = {
  uniqueIdentifiers,
  findOpenConversationByIdentifiers,
  linkConversationIdentifiers,
  getConversationIdentifiers,
  resolveWhatsAppIdentifierMap,
  resolveWhatsAppIdentifiers
};
