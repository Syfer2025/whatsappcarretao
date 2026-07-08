const Database = require('better-sqlite3');
const path = require('path');
const { ensureSchema } = require('./schema');

const db = new Database(path.join(__dirname, 'data.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

ensureSchema(db);

const bcrypt = require('bcryptjs');

const initialAdminUsername = process.env.ADMIN_USERNAME || 'admin';
const initialAdminPassword = process.env.ADMIN_PASSWORD || process.env.ADMIN_INITIAL_PASSWORD || '';
const adminExists = db.prepare('SELECT id FROM admins WHERE username = ?').get(initialAdminUsername);
if (!adminExists) {
  if (process.env.NODE_ENV === 'production' && !initialAdminPassword) {
    throw new Error('ADMIN_PASSWORD obrigatorio para criar o primeiro admin em producao');
  }
  const password = initialAdminPassword || 'admin123';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO admins (username, password) VALUES (?, ?)').run(initialAdminUsername, hash);
}

module.exports = db;
