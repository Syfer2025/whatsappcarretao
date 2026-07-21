const bcrypt = require('bcryptjs');

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._+@-]*[a-z0-9])?$/;

function domainError(message, statusCode = 400, code = 'INVALID_INPUT', detail = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, detail);
  return err;
}

function normalizeDisplayText(value, label, { min = 2, max = 120 } = {}) {
  if (typeof value !== 'string') throw domainError(`${label} obrigatorio`);
  const text = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!text) throw domainError(`${label} obrigatorio`);
  if (text.length < min || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw domainError(`${label} deve ter entre ${min} e ${max} caracteres`);
  }
  return text;
}

function normalizeUsername(value) {
  if (typeof value !== 'string') throw domainError('Usuario obrigatorio');
  const username = value.normalize('NFKC').trim().toLowerCase();
  if (username.length < 3 || username.length > 160 || !USERNAME_PATTERN.test(username)) {
    throw domainError('Usuario invalido. Use de 3 a 160 letras, numeros, ponto, arroba, +, _ ou -');
  }
  return username;
}

function validatedPassword(value, { required = true } = {}) {
  if (!required && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim()) throw domainError('Senha obrigatoria');
  if (Array.from(value).length < 10 || Buffer.byteLength(value, 'utf8') > 72) {
    throw domainError('Senha deve ter no minimo 10 caracteres e no maximo 72 bytes');
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw domainError('Senha contem caracteres invalidos');
  }
  return value;
}

function positiveId(value, label, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value === 'boolean' || (typeof value === 'string' && !/^[1-9]\d*$/.test(value.trim()))) {
    throw domainError(`${label} invalido`);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw domainError(`${label} invalido`);
  return id;
}

function normalizeBoolean(value, { fallback } = {}) {
  if (value === undefined && fallback !== undefined) return fallback ? 1 : 0;
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw domainError('Status ativo invalido');
}

function normalizeUserLimit(value) {
  if (value === undefined || value === null) return null;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw domainError('Limite de usuarios invalido');
  return limit;
}

function normalizeExpectedVersion(value, currentVersion) {
  if (value === undefined || value === null || value === '') return Number(currentVersion || 1);
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version <= 0) throw domainError('Versao do registro invalida');
  return version;
}

function runImmediate(db, operation) {
  return db.transaction(operation).immediate();
}

function isUniqueConstraint(err) {
  return ['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes(String(err?.code || ''))
    || /UNIQUE constraint failed/i.test(String(err?.message || ''));
}

function countActiveUsers(db) {
  return Number(db.prepare('SELECT COUNT(*) AS total FROM vendors WHERE active = 1').get()?.total || 0);
}

function assertUserCapacity(db, userLimit, additionalActiveUsers = 1) {
  const limit = normalizeUserLimit(userLimit);
  if (limit === null || additionalActiveUsers <= 0) return;
  const used = countActiveUsers(db);
  if (used + additionalActiveUsers > limit) {
    throw domainError(
      `Limite de ${limit} usuarios ativos atingido`,
      409,
      'USER_LIMIT_REACHED',
      { limit, used }
    );
  }
}

function getSector(db, sectorId, { required = false, active = false } = {}) {
  if (!required && (sectorId === null || sectorId === undefined || sectorId === '')) return null;
  if (required && (sectorId === null || sectorId === undefined || sectorId === '')) {
    throw domainError('Setor obrigatorio');
  }
  const id = positiveId(sectorId, 'Setor');
  const sector = db.prepare('SELECT * FROM sectors WHERE id = ?').get(id);
  if (!sector) throw domainError('Setor nao encontrado', 404, 'SECTOR_NOT_FOUND');
  if (active && !sector.active) throw domainError('Setor inativo', 409, 'SECTOR_INACTIVE');
  return sector;
}

function listSectors(db) {
  return db.prepare(`
    SELECT s.id,
           s.name,
           s.active,
           s.row_version,
           s.created_at,
           s.updated_at,
           (
             SELECT COUNT(*)
             FROM vendors v
             WHERE v.sector_id = s.id
           ) AS user_count,
           (
             SELECT COUNT(*)
             FROM vendors v
             WHERE v.sector_id = s.id AND v.active = 1
           ) AS active_user_count,
           (
             SELECT COUNT(*)
             FROM conversations c
             WHERE c.sector_id = s.id
           ) AS conversation_count
    FROM sectors s
    ORDER BY s.active DESC, s.name COLLATE NOCASE ASC, s.id ASC
  `).all();
}

function createSector({ db, name, active = true }) {
  const cleanName = normalizeDisplayText(name, 'Nome do setor', { max: 80 });
  const activeValue = normalizeBoolean(active, { fallback: true });
  try {
    return runImmediate(db, () => {
      const result = db.prepare('INSERT INTO sectors (name, active, row_version) VALUES (?, ?, 1)')
        .run(cleanName, activeValue);
      return db.prepare('SELECT * FROM sectors WHERE id = ?').get(result.lastInsertRowid);
    });
  } catch (err) {
    if (isUniqueConstraint(err)) throw domainError('Setor ja existe', 409, 'SECTOR_ALREADY_EXISTS');
    throw err;
  }
}

function updateSector({ db, id, name, active, expectedVersion }) {
  const sectorId = positiveId(id, 'Setor');
  const cleanName = normalizeDisplayText(name, 'Nome do setor', { max: 80 });
  try {
    return runImmediate(db, () => {
      const existing = db.prepare('SELECT * FROM sectors WHERE id = ?').get(sectorId);
      if (!existing) throw domainError('Setor nao encontrado', 404, 'SECTOR_NOT_FOUND');
      const expected = normalizeExpectedVersion(expectedVersion, existing.row_version);
      if (expected !== Number(existing.row_version)) {
        throw domainError(
          'Este setor foi alterado em outra aba. Recarregue os dados e tente novamente',
          409,
          'STALE_WRITE',
          { currentVersion: Number(existing.row_version) }
        );
      }
      const activeValue = normalizeBoolean(active, { fallback: Boolean(existing.active) });
      if (existing.active && !activeValue) {
        const activeUsers = Number(db.prepare(`
          SELECT COUNT(*) AS total FROM vendors WHERE sector_id = ? AND active = 1
        `).get(sectorId)?.total || 0);
        if (activeUsers > 0) {
          throw domainError(
            `Desative ou transfira os ${activeUsers} usuarios ativos deste setor antes de desativa-lo`,
            409,
            'SECTOR_HAS_ACTIVE_USERS',
            { activeUsers }
          );
        }
      }
      const result = db.prepare(`
        UPDATE sectors
        SET name = ?,
            active = ?,
            row_version = row_version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND row_version = ?
      `).run(cleanName, activeValue, sectorId, expected);
      if (!result.changes) {
        throw domainError(
          'Este setor foi alterado em outra aba. Recarregue os dados e tente novamente',
          409,
          'STALE_WRITE'
        );
      }
      if (existing.active && !activeValue) {
        db.prepare(`
          UPDATE conversations
          SET assigned_to = NULL,
              sector_id = NULL,
              status = 'unassigned',
              updated_at = CURRENT_TIMESTAMP
          WHERE sector_id = ?
            AND COALESCE(status, '') != 'closed'
        `).run(sectorId);
      }
      return db.prepare('SELECT * FROM sectors WHERE id = ?').get(sectorId);
    });
  } catch (err) {
    if (isUniqueConstraint(err)) throw domainError('Setor ja existe', 409, 'SECTOR_ALREADY_EXISTS');
    throw err;
  }
}

function listUsers(db) {
  return db.prepare(`
    SELECT v.id,
           v.name,
           v.username,
           v.active,
           v.row_version,
           v.sector_id,
           v.last_login_at,
           v.last_seen_at,
           s.name AS sector_name,
           s.active AS sector_active
    FROM vendors v
    LEFT JOIN sectors s ON s.id = v.sector_id
    ORDER BY v.active DESC, v.name COLLATE NOCASE ASC, v.id ASC
  `).all();
}

function getUserWithSector(db, id) {
  return db.prepare(`
    SELECT v.id,
           v.name,
           v.username,
           v.active,
           v.row_version,
           v.sector_id,
           v.last_login_at,
           v.last_seen_at,
           s.name AS sector_name,
           s.active AS sector_active
    FROM vendors v
    LEFT JOIN sectors s ON s.id = v.sector_id
    WHERE v.id = ?
  `).get(id);
}

function createUser({
  db,
  name,
  username,
  password,
  active = true,
  sectorId = null,
  userLimit = null,
  onBeforeCommit = null
}) {
  const cleanName = normalizeDisplayText(name, 'Nome');
  const cleanUsername = normalizeUsername(username);
  const cleanPassword = validatedPassword(password);
  const activeValue = normalizeBoolean(active, { fallback: true });
  const hash = bcrypt.hashSync(cleanPassword, 10);

  try {
    return runImmediate(db, () => {
      const sector = getSector(db, sectorId, { required: true, active: Boolean(activeValue) });
      assertUserCapacity(db, userLimit, activeValue);
      const result = db.prepare(`
        INSERT INTO vendors (name, username, password, active, sector_id, row_version)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(cleanName, cleanUsername, hash, activeValue, sector.id);
      const user = getUserWithSector(db, result.lastInsertRowid);
      if (typeof onBeforeCommit === 'function') onBeforeCommit(user);
      return user;
    });
  } catch (err) {
    if (isUniqueConstraint(err)) throw domainError('Usuario ja existe', 409, 'USERNAME_ALREADY_EXISTS');
    throw err;
  }
}

function updateUser({
  db,
  id,
  name,
  username,
  password = '',
  active,
  sectorId = null,
  userLimit = null,
  expectedVersion,
  onBeforeCommit = null
}) {
  const userId = positiveId(id, 'Usuario');
  const cleanName = normalizeDisplayText(name, 'Nome');
  const cleanUsername = normalizeUsername(username);
  const cleanPassword = validatedPassword(password, { required: false });
  const passwordHash = cleanPassword ? bcrypt.hashSync(cleanPassword, 10) : null;

  try {
    return runImmediate(db, () => {
      const existing = db.prepare('SELECT * FROM vendors WHERE id = ?').get(userId);
      if (!existing) throw domainError('Usuario nao encontrado', 404, 'USER_NOT_FOUND');
      const expected = normalizeExpectedVersion(expectedVersion, existing.row_version);
      if (expected !== Number(existing.row_version)) {
        throw domainError(
          'Este usuario foi alterado em outra aba. Recarregue os dados e tente novamente',
          409,
          'STALE_WRITE',
          { currentVersion: Number(existing.row_version) }
        );
      }
      const activeValue = normalizeBoolean(active, { fallback: Boolean(existing.active) });
      const sector = getSector(db, sectorId, { required: true, active: Boolean(activeValue) });
      assertUserCapacity(db, userLimit, !existing.active && activeValue ? 1 : 0);

      const result = passwordHash
        ? db.prepare(`
            UPDATE vendors
            SET name = ?,
                username = ?,
                password = ?,
                token_version = token_version + 1,
                row_version = row_version + 1,
                active = ?,
                sector_id = ?
            WHERE id = ? AND row_version = ?
          `).run(cleanName, cleanUsername, passwordHash, activeValue, sector.id, userId, expected)
        : db.prepare(`
            UPDATE vendors
            SET name = ?,
                username = ?,
                token_version = token_version + 1,
                row_version = row_version + 1,
                active = ?,
                sector_id = ?
            WHERE id = ? AND row_version = ?
          `).run(cleanName, cleanUsername, activeValue, sector.id, userId, expected);

      if (!result.changes) {
        throw domainError(
          'Este usuario foi alterado em outra aba. Recarregue os dados e tente novamente',
          409,
          'STALE_WRITE'
        );
      }

      // Conversas abertas acompanham o setor operacional atual do vendedor.
      // Ao desativá-lo, elas voltam para a fila do setor para não ficarem
      // presas a uma conta que já não pode entrar. Mensagens mantêm o
      // vendor_sector_id histórico gravado no momento do envio.
      if (!activeValue) {
        db.prepare(`
          UPDATE conversations
          SET assigned_to = NULL,
              sector_id = ?,
              status = 'active',
              updated_at = CURRENT_TIMESTAMP
          WHERE assigned_to = ?
            AND status != 'closed'
        `).run(sector.id, userId);
      } else if (Number(existing.sector_id) !== Number(sector.id)) {
        db.prepare(`
          UPDATE conversations
          SET sector_id = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE assigned_to = ?
            AND status != 'closed'
        `).run(sector.id, userId);
      }

      const user = getUserWithSector(db, userId);
      if (typeof onBeforeCommit === 'function') onBeforeCommit(user, existing);
      return user;
    });
  } catch (err) {
    if (isUniqueConstraint(err)) throw domainError('Usuario ja existe', 409, 'USERNAME_ALREADY_EXISTS');
    throw err;
  }
}

function deactivateUser({ db, id, expectedVersion }) {
  const userId = positiveId(id, 'Usuario');
  return runImmediate(db, () => {
    const existing = db.prepare('SELECT * FROM vendors WHERE id = ?').get(userId);
    if (!existing) throw domainError('Usuario nao encontrado', 404, 'USER_NOT_FOUND');
    const expected = normalizeExpectedVersion(expectedVersion, existing.row_version);
    if (expected !== Number(existing.row_version)) {
      throw domainError(
        'Este usuario foi alterado em outra aba. Recarregue os dados e tente novamente',
        409,
        'STALE_WRITE',
        { currentVersion: Number(existing.row_version) }
      );
    }
    const result = db.prepare(`
      UPDATE vendors
      SET active = 0,
          token_version = token_version + 1,
          row_version = row_version + 1
      WHERE id = ? AND row_version = ?
    `).run(userId, expected);
    if (!result.changes) throw domainError('Usuario nao encontrado', 404, 'USER_NOT_FOUND');
    db.prepare(`
      UPDATE conversations
      SET assigned_to = NULL,
          status = CASE WHEN sector_id IS NULL THEN 'unassigned' ELSE 'active' END,
          updated_at = CURRENT_TIMESTAMP
      WHERE assigned_to = ?
        AND status != 'closed'
    `).run(userId);
    return getUserWithSector(db, userId);
  });
}

function getConversationWithAssignment(db, conversationId) {
  return db.prepare(`
    SELECT c.*,
           v.name AS vendor_name,
           s.name AS sector_name
    FROM conversations c
    LEFT JOIN vendors v ON v.id = c.assigned_to
    LEFT JOIN sectors s ON s.id = c.sector_id
    WHERE c.id = ?
  `).get(conversationId);
}

function assignConversation({ db, conversationId, vendorId = null, sectorId = null }) {
  const convId = positiveId(conversationId, 'Conversa');
  const vendorIdValue = positiveId(vendorId, 'Usuario', { optional: true });

  return runImmediate(db, () => {
    let sector = getSector(db, sectorId, { active: true });

    if (vendorIdValue) {
      const vendor = db.prepare('SELECT id, active, sector_id FROM vendors WHERE id = ?').get(vendorIdValue);
      if (!vendor) throw domainError('Usuario nao encontrado', 404, 'USER_NOT_FOUND');
      if (!vendor.active) throw domainError('Usuario inativo', 409, 'USER_INACTIVE');
      if (!vendor.sector_id) throw domainError('Usuario sem setor', 409, 'USER_WITHOUT_SECTOR');
      const vendorSector = getSector(db, vendor.sector_id, { required: true, active: true });
      if (sector && sector.id !== vendorSector.id) {
        throw domainError('Usuario nao pertence ao setor informado', 409, 'USER_SECTOR_MISMATCH');
      }
      sector = vendorSector;
    }

    const result = db.prepare(`
      UPDATE conversations
      SET assigned_to = ?,
          sector_id = ?,
          status = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(vendorIdValue, sector?.id || null, (vendorIdValue || sector) ? 'active' : 'unassigned', convId);
    if (!result.changes) throw domainError('Conversa nao encontrada', 404, 'CONVERSATION_NOT_FOUND');
    return getConversationWithAssignment(db, convId);
  });
}

module.exports = {
  normalizeUsername,
  createSector,
  updateSector,
  listSectors,
  createUser,
  updateUser,
  deactivateUser,
  listUsers,
  countActiveUsers,
  assignConversation,
  getConversationWithAssignment
};
