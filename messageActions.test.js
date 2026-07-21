const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { markMessageDeletedForEveryone } = require('./messageActions');

test('revoking a message clears its durable media reference and removes only its tenant file', t => {
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-revoke-media-'));
  t.after(() => fs.rmSync(mediaRoot, { recursive: true, force: true }));
  const ownFilename = 't71-revoked.webp';
  const otherFilename = 't72-keep.webp';
  fs.writeFileSync(path.join(mediaRoot, ownFilename), 'revoked');
  fs.writeFileSync(path.join(mediaRoot, otherFilename), 'keep');

  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      content TEXT,
      media_type TEXT,
      media_mimetype TEXT,
      media_filename TEXT,
      media_url TEXT,
      media_size INTEGER,
      media_unavailable INTEGER DEFAULT 0,
      deleted_for_everyone INTEGER DEFAULT 0,
      deleted_for_everyone_at TEXT,
      delivery_status TEXT,
      delivery_error TEXT
    );
  `);
  db.prepare(`
    INSERT INTO messages (
      id, content, media_type, media_mimetype, media_filename, media_url,
      media_size, delivery_status
    ) VALUES (1, 'figurinha', 'sticker', 'image/webp', ?, ?, 7, 'sent')
  `).run(ownFilename, `/media/${ownFilename}`);

  const revoked = markMessageDeletedForEveryone({
    db,
    messageId: 1,
    mediaRoot,
    tenantId: 71
  });

  assert.equal(revoked.deleted_for_everyone, 1);
  assert.equal(revoked.delivery_status, 'revoked');
  assert.equal(revoked.media_url, null);
  assert.equal(fs.existsSync(path.join(mediaRoot, ownFilename)), false);
  assert.equal(fs.readFileSync(path.join(mediaRoot, otherFilename), 'utf8'), 'keep');
});
