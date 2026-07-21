const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

function boot(dataDir, username, password) {
  const result = spawnSync(process.execPath, ['-e', "const db=require('./db'); db.defaultDb.close();"], {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      SQLITE_SYNCHRONOUS: 'NORMAL',
      ADMIN_USERNAME: username,
      ADMIN_PASSWORD: password
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('ADMIN_USERNAME and ADMIN_PASSWORD rotate the single platform owner and revoke legacy credentials', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsa-platform-admin-'));
  try {
    boot(dataDir, 'owner-old@example.test', 'Owner-Password-Old-123');
    boot(dataDir, 'owner-new@example.test', 'Owner-Password-New-123');
    boot(dataDir, 'owner-new@example.test', 'Owner-Password-Rotated-456');

    const database = new Database(path.join(dataDir, 'data.db'), { readonly: true });
    try {
      const activeOwners = database.prepare(`
        SELECT * FROM admins WHERE coalesce(super_admin, 0) = 1
      `).all();
      assert.equal(activeOwners.length, 1);
      assert.equal(activeOwners[0].username, 'owner-new@example.test');
      assert.equal(bcrypt.compareSync('Owner-Password-Rotated-456', activeOwners[0].password), true);
      assert.equal(bcrypt.compareSync('Owner-Password-New-123', activeOwners[0].password), false);
      assert.equal(bcrypt.compareSync('Owner-Password-Old-123', activeOwners[0].password), false);
      assert.equal(activeOwners[0].token_version, 2);
      assert.equal(
        database.prepare(`
          SELECT COUNT(*) AS total FROM admins
          WHERE username = 'owner-old@example.test' COLLATE NOCASE
            AND coalesce(super_admin, 0) = 1
        `).get().total,
        0
      );
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
