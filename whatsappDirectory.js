const { getChatId, getDisplayName } = require('./whatsappUtils');
const { withTimeout } = require('./runtimeUtils');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CONTACT_LIMIT = 50;
const MAX_CONTACT_LIMIT = 200;
const PARTICIPANT_LOOKUP_CONCURRENCY = 6;

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizePhoneInput(value) {
  const raw = String(value || '').trim();
  if (!raw) throw badRequest('Telefone obrigatório');

  const withoutSuffix = raw.replace(/@(c\.us|s\.whatsapp\.net)$/i, '');
  const plusCount = (withoutSuffix.match(/\+/g) || []).length;
  if (/[^+\d\s().-]/.test(withoutSuffix)
      || plusCount > 1
      || (plusCount === 1 && !withoutSuffix.startsWith('+'))) {
    throw badRequest('Telefone inválido');
  }

  const digits = withoutSuffix.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    throw badRequest('Telefone inválido. Informe DDI e número com 8 a 15 dígitos');
  }
  return digits;
}

function cleanText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function serializedId(value) {
  if (typeof value === 'string') return value;
  if (typeof value?._serialized === 'string') return value._serialized;
  return getChatId(value);
}

function contactDisplayName(contact) {
  return cleanText(contact?.name)
    || cleanText(contact?.shortName)
    || cleanText(contact?.pushname)
    || cleanText(contact?.verifiedName)
    || null;
}

function identifierPhone(identifier) {
  const value = String(identifier || '');
  if (!/@(?:c\.us|s\.whatsapp\.net)$/i.test(value)) return null;
  const digits = value.split('@')[0].replace(/\D/g, '');
  return digits || null;
}

function isLidIdentifier(identifier) {
  return /@lid$/i.test(String(identifier || ''));
}

function identifierUser(identifier) {
  return String(identifier || '').split('@')[0].replace(/\D/g, '');
}

function contactPhone(contact, fallbackIdentifier = '') {
  const direct = String(contact?.number || contact?.userid || '').replace(/\D/g, '');
  if (direct) return direct;
  const contactIdentifier = getChatId(contact);
  return identifierPhone(contactIdentifier) || identifierPhone(fallbackIdentifier);
}

function contactToRecord(contact, fallbackIdentifier = '', overrides = {}) {
  const whatsappId = getChatId(contact) || String(fallbackIdentifier || '');
  if (!whatsappId) return null;
  return {
    whatsapp_id: whatsappId,
    phone: overrides.phone ?? contactPhone(contact, fallbackIdentifier),
    name: overrides.name ?? cleanText(contact?.name),
    push_name: overrides.push_name ?? cleanText(contact?.pushname),
    short_name: overrides.short_name ?? cleanText(contact?.shortName),
    verified_name: overrides.verified_name ?? cleanText(contact?.verifiedName),
    profile_pic_url: overrides.profile_pic_url ?? cleanText(contact?.profile_pic_url),
    is_saved: overrides.is_saved ?? (contact?.isMyContact ? 1 : 0),
    is_business: overrides.is_business ?? (contact?.isBusiness || contact?.isEnterprise ? 1 : 0),
    is_blocked: overrides.is_blocked ?? (contact?.isBlocked ? 1 : 0)
  };
}

function upsertContact(db, record) {
  if (!record?.whatsapp_id) return null;
  db.prepare(`
    INSERT INTO contacts (
      whatsapp_id,
      phone,
      name,
      push_name,
      short_name,
      verified_name,
      profile_pic_url,
      is_saved,
      is_business,
      is_blocked,
      synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(whatsapp_id) DO UPDATE SET
      phone = COALESCE(NULLIF(excluded.phone, ''), contacts.phone),
      name = COALESCE(NULLIF(excluded.name, ''), contacts.name),
      push_name = COALESCE(NULLIF(excluded.push_name, ''), contacts.push_name),
      short_name = COALESCE(NULLIF(excluded.short_name, ''), contacts.short_name),
      verified_name = COALESCE(NULLIF(excluded.verified_name, ''), contacts.verified_name),
      profile_pic_url = COALESCE(NULLIF(excluded.profile_pic_url, ''), contacts.profile_pic_url),
      is_saved = excluded.is_saved,
      is_business = excluded.is_business,
      is_blocked = excluded.is_blocked,
      synced_at = CURRENT_TIMESTAMP
  `).run(
    record.whatsapp_id,
    record.phone || null,
    record.name || null,
    record.push_name || null,
    record.short_name || null,
    record.verified_name || null,
    record.profile_pic_url || null,
    record.is_saved ? 1 : 0,
    record.is_business ? 1 : 0,
    record.is_blocked ? 1 : 0
  );
  return db.prepare('SELECT * FROM contacts WHERE whatsapp_id = ?').get(record.whatsapp_id) || null;
}

function createContactIndex(contacts) {
  const index = new Map();
  for (const contact of contacts || []) {
    const identifier = getChatId(contact);
    const phone = contactPhone(contact, identifier);
    if (identifier) index.set(identifier, contact);
    if (phone) index.set(phone, contact);
    if (phone) index.set(`${phone}@c.us`, contact);
  }
  return index;
}

async function tryCall(factory, timeoutMs, label) {
  try {
    return await withTimeout(factory, timeoutMs, label);
  } catch {
    return null;
  }
}

async function syncContacts(client, db, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!client || typeof client.getContacts !== 'function') {
    throw new Error('Cliente WhatsApp não oferece sincronização de contatos');
  }

  // Promise.race não cancela a chamada que já entrou no Chromium. Expomos ao
  // coordenador apenas uma Promise sanitizada de conclusão para que ele possa
  // manter o tenant em quarentena e nunca sobrepor dois getContacts no mesmo
  // Client depois de um timeout.
  const pendingOperation = Promise.resolve().then(() => client.getContacts());
  let contacts;
  try {
    contacts = await withTimeout(pendingOperation, timeoutMs, 'getContacts');
  } catch (error) {
    if (error.code === 'OPERATION_TIMEOUT') {
      Object.defineProperty(error, 'pendingOperation', {
        configurable: false,
        enumerable: false,
        value: pendingOperation.then(() => undefined, () => undefined),
        writable: false
      });
    }
    throw error;
  }
  const usableContacts = (Array.isArray(contacts) ? contacts : []).filter(contact => {
    const identifier = getChatId(contact);
    if (!identifier || contact?.isMe || contact?.isGroup) return false;
    if (contact?.isUser === false && !contact?.isMyContact) return false;
    if (contact?.isWAContact === false && !contact?.isMyContact) return false;
    return true;
  });

  let inserted = 0;
  let updated = 0;
  const save = db.transaction(() => {
    for (const contact of usableContacts) {
      const record = contactToRecord(contact);
      if (!record) continue;
      const existed = db.prepare('SELECT 1 FROM contacts WHERE whatsapp_id = ?').get(record.whatsapp_id);
      upsertContact(db, record);
      if (existed) updated += 1;
      else inserted += 1;
    }
  });
  save();

  return {
    total: usableContacts.length,
    inserted,
    updated,
    saved: usableContacts.filter(contact => contact?.isMyContact).length
  };
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, char => `\\${char}`);
}

function normalizeListArguments(dbOrOptions, maybeOptions) {
  if (dbOrOptions && typeof dbOrOptions.prepare === 'function') {
    return { db: dbOrOptions, ...(maybeOptions || {}) };
  }
  return dbOrOptions || {};
}

function listContacts(dbOrOptions, maybeOptions) {
  const {
    db,
    q = '',
    limit = DEFAULT_CONTACT_LIMIT,
    savedOnly = true
  } = normalizeListArguments(dbOrOptions, maybeOptions);
  if (!db) throw new Error('Banco obrigatório');

  const where = [];
  const params = [];
  if (savedOnly) where.push('is_saved = 1');
  const query = String(q || '').trim();
  if (query) {
    const pattern = `%${escapeLike(query)}%`;
    where.push(`(
      name LIKE ? ESCAPE '\\'
      OR short_name LIKE ? ESCAPE '\\'
      OR push_name LIKE ? ESCAPE '\\'
      OR verified_name LIKE ? ESCAPE '\\'
      OR phone LIKE ? ESCAPE '\\'
      OR whatsapp_id LIKE ? ESCAPE '\\'
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }
  const cappedLimit = Math.min(Math.max(Number(limit) || DEFAULT_CONTACT_LIMIT, 1), MAX_CONTACT_LIMIT);
  params.push(cappedLimit);

  return db.prepare(`
    SELECT *,
           COALESCE(NULLIF(name, ''), NULLIF(short_name, ''), NULLIF(push_name, ''),
                    NULLIF(verified_name, ''), NULLIF(phone, ''), whatsapp_id) AS display_name
    FROM contacts
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY is_saved DESC, display_name COLLATE NOCASE ASC, phone ASC
    LIMIT ?
  `).all(...params);
}

function searchContacts(dbOrOptions, qOrOptions = '', maybeOptions = {}) {
  if (dbOrOptions && typeof dbOrOptions.prepare === 'function') {
    const options = typeof qOrOptions === 'object'
      ? qOrOptions
      : { ...maybeOptions, q: qOrOptions };
    return listContacts(dbOrOptions, options);
  }
  return listContacts({ ...(dbOrOptions || {}), ...(typeof qOrOptions === 'object' ? qOrOptions : {}), q: typeof qOrOptions === 'string' ? qOrOptions : dbOrOptions?.q });
}

function sqlDateTime(value) {
  if (!value) return null;
  const date = value instanceof Date
    ? value
    : new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function safeProperty(object, property) {
  try {
    return object?.[property] ?? null;
  } catch {
    return null;
  }
}

async function getProfilePicture(client, contact, identifier, timeoutMs) {
  const attempts = [];
  if (typeof contact?.getProfilePicUrl === 'function') attempts.push(() => contact.getProfilePicUrl());
  if (typeof client?.getProfilePicUrl === 'function' && identifier) attempts.push(() => client.getProfilePicUrl(identifier));
  for (const attempt of attempts) {
    const result = await tryCall(attempt, timeoutMs, 'getProfilePicUrl');
    if (cleanText(result)) return cleanText(result);
  }
  return null;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function findStoredContact(db, identifier) {
  const phone = identifierPhone(identifier);
  return db.prepare(`
    SELECT *
    FROM contacts
    WHERE whatsapp_id = ?
       OR (? IS NOT NULL AND phone = ?)
    ORDER BY CASE WHEN whatsapp_id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(identifier, phone, phone, identifier) || null;
}

async function resolveLidPhoneMap(client, identifiers, timeoutMs) {
  const lids = [...new Set((identifiers || []).filter(isLidIdentifier))];
  const resolved = new Map();
  if (!lids.length || typeof client?.getContactLidAndPhone !== 'function') return resolved;

  async function resolveBatch(batch) {
    let rows;
    try {
      rows = await withTimeout(
        () => client.getContactLidAndPhone(batch),
        timeoutMs,
        'getContactLidAndPhone'
      );
    } catch {
      // Um LID antigo que saiu do grupo pode fazer o Promise.all interno da
      // biblioteca rejeitar o lote inteiro. Divide apenas em caso de falha,
      // preservando resolução em lote no caminho normal e isolando o inválido.
      if (batch.length <= 1) return;
      const middle = Math.ceil(batch.length / 2);
      await resolveBatch(batch.slice(0, middle));
      await resolveBatch(batch.slice(middle));
      return;
    }
    if (!Array.isArray(rows)) return;
    batch.forEach((sourceId, index) => {
      const row = rows[index] || {};
      const lid = serializedId(row.lid) || sourceId;
      const phoneId = serializedId(row.pn || row.phone);
      if (!phoneId || !identifierPhone(phoneId)) return;
      resolved.set(sourceId, phoneId);
      resolved.set(lid, phoneId);
    });
  }

  await resolveBatch(lids);
  return resolved;
}

function usableParticipantPhone(phone, participantId, resolvedPhoneId = null) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return identifierPhone(resolvedPhoneId);
  if (isLidIdentifier(participantId)
      && digits === identifierUser(participantId)
      && !identifierPhone(resolvedPhoneId)) {
    return null;
  }
  return identifierPhone(resolvedPhoneId) || digits;
}

function extractParticipantIdFromExternalId(externalId) {
  const match = String(externalId || '').match(/_([^_]+@(?:lid|c\.us))$/i);
  return match?.[1] || null;
}

function weakParticipantPhone(phone, participantId) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return true;
  return isLidIdentifier(participantId) && digits === identifierUser(participantId);
}

function weakParticipantName(name, participantId, participantPhone = '') {
  const value = cleanText(name);
  if (!value) return true;
  const normalized = value.toLowerCase();
  const rawCandidates = new Set([
    String(participantId || '').toLowerCase(),
    identifierUser(participantId),
    String(participantPhone || '').replace(/\D/g, ''),
    'cliente',
    'participante',
    'desconhecido'
  ].filter(Boolean));
  return rawCandidates.has(normalized) || rawCandidates.has(value.replace(/\D/g, ''));
}

function getHistoricalGroupParticipantIds(db, conversationId) {
  return [...new Set(db.prepare(`
    SELECT external_id
    FROM messages
    WHERE conversation_id = ?
      AND from_type = 'client'
      AND external_id IS NOT NULL
  `).all(conversationId)
    .map(row => extractParticipantIdFromExternalId(row.external_id))
    .filter(Boolean))];
}

function backfillGroupMessageParticipants(db, conversationId, { lidPhoneMap = new Map() } = {}) {
  const participants = db.prepare(`
    SELECT gp.participant_id,
           c.whatsapp_id AS contact_whatsapp_id,
           COALESCE(NULLIF(gp.phone, ''), NULLIF(c.phone, '')) AS resolved_phone,
           COALESCE(
             NULLIF(gp.name, ''),
             NULLIF(c.name, ''),
             NULLIF(c.short_name, ''),
             NULLIF(c.push_name, ''),
             NULLIF(c.verified_name, '')
           ) AS resolved_name
    FROM group_participants gp
    LEFT JOIN contacts c ON c.id = gp.contact_id
    WHERE gp.conversation_id = ?
  `).all(conversationId);
  const participantMap = new Map();
  for (const participant of participants) {
    participantMap.set(participant.participant_id, participant);
    if (participant.contact_whatsapp_id) {
      participantMap.set(participant.contact_whatsapp_id, participant);
    }
  }
  const directContact = db.prepare(`
    SELECT phone,
           COALESCE(
             NULLIF(name, ''),
             NULLIF(short_name, ''),
             NULLIF(push_name, ''),
             NULLIF(verified_name, '')
           ) AS resolved_name
    FROM contacts
    WHERE whatsapp_id = ?
    LIMIT 1
  `);
  const messages = db.prepare(`
    SELECT id,
           external_id,
           participant_id,
           participant_phone,
           participant_name
    FROM messages
    WHERE conversation_id = ?
      AND from_type = 'client'
      AND external_id IS NOT NULL
  `).all(conversationId);
  const update = db.prepare(`
    UPDATE messages
    SET participant_id = ?,
        participant_phone = ?,
        participant_name = ?
    WHERE id = ?
  `);

  let updated = 0;
  const apply = db.transaction(() => {
    for (const message of messages) {
      const extractedId = extractParticipantIdFromExternalId(message.external_id);
      if (!extractedId) continue;
      const resolvedPhoneId = lidPhoneMap.get(extractedId) || null;
      const participant = participantMap.get(extractedId)
        || participantMap.get(resolvedPhoneId)
        || null;
      const contact = participant ? null : directContact.get(resolvedPhoneId || extractedId);
      const candidatePhone = participant?.resolved_phone
        || contact?.phone
        || identifierPhone(resolvedPhoneId)
        || null;
      const candidateName = participant?.resolved_name || contact?.resolved_name || null;
      const nextId = message.participant_id || extractedId;
      const nextPhone = weakParticipantPhone(message.participant_phone, nextId)
        && !weakParticipantPhone(candidatePhone, extractedId)
        ? String(candidatePhone).replace(/\D/g, '')
        : message.participant_phone;
      const nextName = weakParticipantName(message.participant_name, nextId, message.participant_phone)
        && !weakParticipantName(candidateName, extractedId, candidatePhone)
        ? candidateName
        : message.participant_name;

      if (nextId === message.participant_id
          && nextPhone === message.participant_phone
          && nextName === message.participant_name) {
        continue;
      }
      update.run(nextId, nextPhone || null, nextName || null, message.id);
      updated += 1;
    }
  });
  apply();
  return { scanned: messages.length, updated };
}

async function resolveGroupParticipants({ client, db, conversationId, participants, timeoutMs }) {
  if (!Array.isArray(participants)) return [];
  const directoryContacts = typeof client?.getContacts === 'function'
    ? await tryCall(() => client.getContacts(), timeoutMs, 'getContacts') || []
    : [];
  const contactIndex = createContactIndex(directoryContacts);
  const participantIds = participants
    .map(participant => serializedId(participant?.id || participant))
    .filter(Boolean);
  const historicalParticipantIds = getHistoricalGroupParticipantIds(db, conversationId);
  const lidPhoneMap = await resolveLidPhoneMap(
    client,
    [...participantIds, ...historicalParticipantIds],
    timeoutMs
  );

  const resolved = await mapWithConcurrency(
    participants,
    PARTICIPANT_LOOKUP_CONCURRENCY,
    async participant => {
      const participantId = serializedId(participant?.id || participant);
      if (!participantId) return null;
      const resolvedPhoneId = lidPhoneMap.get(participantId) || null;
      const resolvedPhone = identifierPhone(resolvedPhoneId);
      let contact = contactIndex.get(resolvedPhoneId)
        || contactIndex.get(resolvedPhone)
        || contactIndex.get(participantId)
        || contactIndex.get(identifierPhone(participantId))
        || null;
      if (!contact && typeof client?.getContactById === 'function') {
        contact = await tryCall(
          () => client.getContactById(resolvedPhoneId || participantId),
          timeoutMs,
          'getContactById'
        );
      }

      const phoneStored = resolvedPhoneId ? findStoredContact(db, resolvedPhoneId) : null;
      const lidStored = findStoredContact(db, participantId);
      const liveContactIsPhone = Boolean(identifierPhone(getChatId(contact)));
      const preferredField = (liveValue, phoneValue, lidValue) => liveContactIsPhone
        ? cleanText(liveValue) || phoneValue || lidValue || null
        : phoneValue || cleanText(liveValue) || lidValue || null;
      const preferredBoolean = (liveValue, phoneValue, lidValue) => {
        if (liveContactIsPhone && liveValue !== undefined) return Boolean(liveValue);
        if (phoneValue !== undefined && phoneValue !== null) return Boolean(phoneValue);
        if (liveValue !== undefined) return Boolean(liveValue);
        return Boolean(lidValue);
      };
      const livePhone = usableParticipantPhone(
        contactPhone(contact, resolvedPhoneId || participantId),
        participantId,
        resolvedPhoneId
      );
      const preferredIdentifier = resolvedPhoneId || getChatId(contact) || participantId;
      const record = contactToRecord(contact, preferredIdentifier, {
        phone: resolvedPhone || livePhone || phoneStored?.phone || lidStored?.phone || null,
        name: preferredField(contact?.name, phoneStored?.name, lidStored?.name),
        push_name: preferredField(contact?.pushname, phoneStored?.push_name, lidStored?.push_name),
        short_name: preferredField(contact?.shortName, phoneStored?.short_name, lidStored?.short_name),
        verified_name: preferredField(contact?.verifiedName, phoneStored?.verified_name, lidStored?.verified_name),
        profile_pic_url: phoneStored?.profile_pic_url || lidStored?.profile_pic_url || null,
        is_saved: preferredBoolean(contact?.isMyContact, phoneStored?.is_saved, lidStored?.is_saved),
        is_business: preferredBoolean(
          contact ? Boolean(contact.isBusiness || contact.isEnterprise) : undefined,
          phoneStored?.is_business,
          lidStored?.is_business
        ),
        is_blocked: preferredBoolean(contact?.isBlocked, phoneStored?.is_blocked, lidStored?.is_blocked)
      });
      if (resolvedPhoneId) record.whatsapp_id = resolvedPhoneId;
      const savedContact = upsertContact(db, record);
      const phone = usableParticipantPhone(
        resolvedPhone || savedContact?.phone || livePhone,
        participantId,
        resolvedPhoneId
      );
      const name = phoneStored?.name
        || phoneStored?.short_name
        || phoneStored?.push_name
        || phoneStored?.verified_name
        || contactDisplayName(contact)
        || savedContact?.name
        || savedContact?.short_name
        || savedContact?.push_name
        || savedContact?.verified_name
        || phone
        || participantId;

      return {
        conversation_id: conversationId,
        contact_id: savedContact?.id || null,
        participant_id: participantId,
        phone: phone || null,
        name,
        profile_pic_url: savedContact?.profile_pic_url || null,
        is_admin: participant?.isAdmin ? 1 : 0,
        is_super_admin: participant?.isSuperAdmin ? 1 : 0
      };
    }
  );

  const rows = resolved.filter(Boolean);
  const replaceParticipants = db.transaction(() => {
    db.prepare('DELETE FROM group_participants WHERE conversation_id = ?').run(conversationId);
    const insert = db.prepare(`
      INSERT INTO group_participants (
        conversation_id,
        contact_id,
        participant_id,
        phone,
        name,
        profile_pic_url,
        is_admin,
        is_super_admin,
        synced_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    for (const row of rows) {
      insert.run(
        row.conversation_id,
        row.contact_id,
        row.participant_id,
        row.phone,
        row.name,
        row.profile_pic_url,
        row.is_admin,
        row.is_super_admin
      );
    }
  });
  replaceParticipants();
  backfillGroupMessageParticipants(db, conversationId, { lidPhoneMap });
  return rows;
}

async function syncConversationProfile(client, db, conversation, chat = null, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!conversation?.id || !conversation?.phone) throw new Error('Conversa inválida');
  let targetChat = chat;
  if (!targetChat && typeof client?.getChatById === 'function') {
    targetChat = await withTimeout(
      () => client.getChatById(conversation.phone),
      timeoutMs,
      'getChatById'
    );
  }
  if (!targetChat) throw new Error('Conversa não encontrada no WhatsApp');

  const chatId = getChatId(targetChat) || conversation.phone;
  const isGroup = Boolean(targetChat.isGroup || chatId.endsWith('@g.us'));
  let contact = null;
  if (typeof targetChat.getContact === 'function') {
    contact = await tryCall(() => targetChat.getContact(), timeoutMs, 'getContact');
  }
  if (!contact && !isGroup && typeof client?.getContactById === 'function') {
    contact = await tryCall(() => client.getContactById(chatId), timeoutMs, 'getContactById');
  }

  const profilePicUrl = await getProfilePicture(client, contact, chatId, timeoutMs);
  const about = !isGroup && typeof contact?.getAbout === 'function'
    ? await tryCall(() => contact.getAbout(), timeoutMs, 'getAbout')
    : null;
  const contactName = getDisplayName(targetChat, chatId, contact);
  const description = isGroup ? cleanText(safeProperty(targetChat, 'description')) : null;
  const owner = isGroup ? serializedId(safeProperty(targetChat, 'owner')) || null : null;
  const groupCreatedAt = isGroup ? sqlDateTime(safeProperty(targetChat, 'createdAt')) : null;
  const archived = targetChat.archived ? 1 : 0;

  const savedProfileContact = !isGroup && contact
    ? upsertContact(db, contactToRecord(contact, chatId, { profile_pic_url: profilePicUrl }))
    : null;

  db.prepare(`
    UPDATE conversations
    SET contact_name = COALESCE(NULLIF(?, ''), contact_name),
        profile_pic_url = COALESCE(NULLIF(?, ''), profile_pic_url),
        is_group = ?,
        group_description = ?,
        group_owner = ?,
        group_created_at = ?,
        profile_about = ?,
        whatsapp_archived = ?,
        archived_at = CASE
          WHEN ? = 1 THEN COALESCE(archived_at, CURRENT_TIMESTAMP)
          ELSE NULL
        END,
        archive_sync_state = 'synced',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    contactName,
    profilePicUrl,
    isGroup ? 1 : 0,
    description,
    owner,
    groupCreatedAt,
    cleanText(about),
    archived,
    archived,
    conversation.id
  );

  const participants = isGroup
    ? await resolveGroupParticipants({
      client,
      db,
      conversationId: conversation.id,
      participants: safeProperty(targetChat, 'participants') || [],
      timeoutMs
    })
    : [];

  return {
    conversation: db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation.id),
    isGroup,
    participants,
    contact: savedProfileContact
  };
}

module.exports = {
  normalizePhoneInput,
  syncContacts,
  listContacts,
  searchContacts,
  syncConversationProfile,
  contactDisplayName,
  contactPhone,
  contactToRecord,
  createContactIndex,
  backfillGroupMessageParticipants
};
