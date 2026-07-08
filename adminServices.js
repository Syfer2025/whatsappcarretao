const bcrypt = require('bcryptjs');

function requiredText(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${label} obrigatorio`);
  return text;
}

function optionalId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function boolToInt(value, fallback = true) {
  if (value === undefined) return fallback ? 1 : 0;
  return value ? 1 : 0;
}

function getSector(db, sectorId) {
  const id = optionalId(sectorId);
  if (!id) return null;
  const sector = db.prepare('SELECT * FROM sectors WHERE id = ?').get(id);
  if (!sector) throw new Error('Setor nao encontrado');
  return sector;
}

function listSectors(db) {
  return db.prepare(`
    SELECT id, name, active, created_at, updated_at
    FROM sectors
    ORDER BY active DESC, name ASC
  `).all();
}

function createSector({ db, name, active = true }) {
  const cleanName = requiredText(name, 'Nome do setor');
  try {
    const result = db.prepare('INSERT INTO sectors (name, active) VALUES (?, ?)').run(cleanName, boolToInt(active));
    return db.prepare('SELECT * FROM sectors WHERE id = ?').get(result.lastInsertRowid);
  } catch (err) {
    if (err.message.includes('UNIQUE')) throw new Error('Setor ja existe');
    throw err;
  }
}

function updateSector({ db, id, name, active = true }) {
  const sectorId = optionalId(id);
  if (!sectorId) throw new Error('Setor invalido');
  const cleanName = requiredText(name, 'Nome do setor');
  try {
    const result = db.prepare(`
      UPDATE sectors
      SET name = ?,
          active = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(cleanName, boolToInt(active), sectorId);
    if (!result.changes) throw new Error('Setor nao encontrado');
    return db.prepare('SELECT * FROM sectors WHERE id = ?').get(sectorId);
  } catch (err) {
    if (err.message.includes('UNIQUE')) throw new Error('Setor ja existe');
    throw err;
  }
}

function listUsers(db) {
  return db.prepare(`
    SELECT v.id,
           v.name,
           v.username,
           v.active,
           v.sector_id,
           s.name AS sector_name
    FROM vendors v
    LEFT JOIN sectors s ON s.id = v.sector_id
    ORDER BY v.active DESC, v.name ASC
  `).all();
}

function getUserWithSector(db, id) {
  return db.prepare(`
    SELECT v.id,
           v.name,
           v.username,
           v.active,
           v.sector_id,
           s.name AS sector_name
    FROM vendors v
    LEFT JOIN sectors s ON s.id = v.sector_id
    WHERE v.id = ?
  `).get(id);
}

function createUser({ db, name, username, password, active = true, sectorId = null }) {
  const cleanName = requiredText(name, 'Nome');
  const cleanUsername = requiredText(username, 'Usuario');
  const cleanPassword = requiredText(password, 'Senha');
  const sector = getSector(db, sectorId);
  const hash = bcrypt.hashSync(cleanPassword, 10);

  try {
    const result = db.prepare(`
      INSERT INTO vendors (name, username, password, active, sector_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(cleanName, cleanUsername, hash, boolToInt(active), sector?.id || null);
    return getUserWithSector(db, result.lastInsertRowid);
  } catch (err) {
    if (err.message.includes('UNIQUE')) throw new Error('Username ja existe');
    throw err;
  }
}

function updateUser({ db, id, name, username, password = '', active = true, sectorId = null }) {
  const userId = optionalId(id);
  if (!userId) throw new Error('Usuario invalido');
  const cleanName = requiredText(name, 'Nome');
  const cleanUsername = requiredText(username, 'Usuario');
  const sector = getSector(db, sectorId);
  const cleanPassword = typeof password === 'string' ? password.trim() : '';

  try {
    const result = cleanPassword
      ? db.prepare(`
          UPDATE vendors
          SET name = ?,
              username = ?,
              password = ?,
              token_version = token_version + 1,
              active = ?,
              sector_id = ?
          WHERE id = ?
        `).run(cleanName, cleanUsername, bcrypt.hashSync(cleanPassword, 10), boolToInt(active), sector?.id || null, userId)
      : db.prepare(`
          UPDATE vendors
          SET name = ?,
              username = ?,
              active = ?,
              sector_id = ?
          WHERE id = ?
        `).run(cleanName, cleanUsername, boolToInt(active), sector?.id || null, userId);

    if (!result.changes) throw new Error('Usuario nao encontrado');
    return getUserWithSector(db, userId);
  } catch (err) {
    if (err.message.includes('UNIQUE')) throw new Error('Username ja existe');
    throw err;
  }
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
  const convId = optionalId(conversationId);
  if (!convId) throw new Error('Conversa invalida');

  const vendorIdValue = optionalId(vendorId);
  const sector = getSector(db, sectorId);

  if (vendorIdValue) {
    const vendor = db.prepare('SELECT id, active FROM vendors WHERE id = ?').get(vendorIdValue);
    if (!vendor) throw new Error('Usuario nao encontrado');
    if (!vendor.active) throw new Error('Usuario inativo');
  }

  const result = db.prepare(`
    UPDATE conversations
    SET assigned_to = ?,
        sector_id = ?,
        status = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(vendorIdValue, sector?.id || null, vendorIdValue ? 'active' : 'unassigned', convId);
  if (!result.changes) throw new Error('Conversa nao encontrada');
  return getConversationWithAssignment(db, convId);
}

module.exports = {
  createSector,
  updateSector,
  listSectors,
  createUser,
  updateUser,
  listUsers,
  assignConversation,
  getConversationWithAssignment
};
