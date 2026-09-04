// Incremente ao mudar o schema abaixo. DBs já na versão atual pulam a migração
// inteira (evita ~20 PRAGMAs/UPDATEs por abertura de banco em cada tenant).
// 15 (04/set/2026): messages.location_latitude/longitude — coordenada em
// coluna para o painel desenhar o mapa, em vez de interpretar o texto.
// 14 (04/set/2026): conversations.display_phone — telefone real resolvido do
// @c.us, porque a coluna phone passou a guardar o identificador @lid.
const SCHEMA_VERSION = 15;

// Pragmas de performance/robustez aplicados a TODO banco aberto.
// Em producao usamos synchronous=FULL: um crash do host nao deve confirmar ao
// usuario uma mensagem/configuracao que ainda nao chegou ao armazenamento.
// Desenvolvimento pode optar por NORMAL para reduzir latencia local.
// busy_timeout evita erros SQLITE_BUSY sob escrita concorrente.
function applyPragmas(db) {
  const requestedSynchronous = String(
    process.env.SQLITE_SYNCHRONOUS || (process.env.NODE_ENV === 'production' ? 'FULL' : 'NORMAL'),
  ).toUpperCase();
  if (!['FULL', 'NORMAL'].includes(requestedSynchronous)) {
    throw new Error('SQLITE_SYNCHRONOUS deve ser FULL ou NORMAL');
  }
  if (process.env.NODE_ENV === 'production' && requestedSynchronous !== 'FULL') {
    throw new Error('SQLITE_SYNCHRONOUS deve ser FULL em producao');
  }
  db.pragma('journal_mode = WAL');
  db.pragma(`synchronous = ${requestedSynchronous}`);
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -16000'); // ~16MB de cache de página por conexão
  db.pragma('temp_store = MEMORY');
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('journal_size_limit = 67108864');
}

function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

function ensureColumn(db, table, column, definition) {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function ensureSchema(db) {
  // Uma imagem anterior pode ser religada depois que a candidata aplicou uma
  // migração aditiva. Nunca rebaixe user_version: isso faria uma versão futura
  // acreditar que um schema novo ainda não foi aplicado e repetir migrações
  // sobre um estado incompatível. Releases destrutivas continuam proibidas
  // pelo contrato operacional de rollback.
  const currentVersion = db.pragma('user_version', { simple: true });
  if (currentVersion === SCHEMA_VERSION) return;
  if (currentVersion > SCHEMA_VERSION) {
    const requiredTables = ['admins', 'vendors', 'sectors', 'conversations', 'messages'];
    const existingTables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    const missing = requiredTables.filter((table) => !existingTables.has(table));
    if (missing.length > 0) {
      throw new Error(
        `Schema ${currentVersion} e mais novo que a aplicacao, mas faltam tabelas compativeis: ${missing.join(', ')}`,
      );
    }
    return;
  }

  // DDL também é transacional no SQLite. Sem esta fronteira, uma falha tardia
  // (por exemplo ao criar um índice UNIQUE em dados legados inconsistentes)
  // deixava colunas/tabelas parcialmente publicadas com user_version antigo.
  // A próxima inicialização passava a operar sobre um híbrido difícil de
  // recuperar. A migração inteira agora confirma ou reverte como uma unidade.
  const migrate = db.transaction(() => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      token_version INTEGER DEFAULT 0,
      inbox_baseline_at DATETIME,
      inbox_baseline_message_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      token_version INTEGER DEFAULT 0,
      row_version INTEGER NOT NULL DEFAULT 1,
      sector_id INTEGER REFERENCES sectors(id),
      active INTEGER DEFAULT 1,
      inbox_baseline_at DATETIME,
      inbox_baseline_message_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS sectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      active INTEGER DEFAULT 1,
      row_version INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      contact_name TEXT,
      profile_pic_url TEXT,
      assigned_to INTEGER REFERENCES vendors(id),
      sector_id INTEGER REFERENCES sectors(id),
      status TEXT DEFAULT 'unassigned',
      last_activity_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER REFERENCES conversations(id),
      external_id TEXT,
      from_type TEXT NOT NULL,
      content TEXT NOT NULL,
      media_type TEXT,
      media_mimetype TEXT,
      media_filename TEXT,
      media_url TEXT,
      media_size INTEGER,
      media_unavailable INTEGER DEFAULT 0,
      delivery_status TEXT DEFAULT 'received',
      delivery_error TEXT,
      sent_at DATETIME,
      client_request_id TEXT,
      media_sha256 TEXT,
      deleted_for_everyone INTEGER DEFAULT 0,
      deleted_for_everyone_at DATETIME,
      starred INTEGER DEFAULT 0,
      starred_at DATETIME,
      starred_by INTEGER,
      starred_by_role TEXT,
      vendor_id INTEGER REFERENCES vendors(id),
      vendor_sector_id INTEGER REFERENCES sectors(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversation_identifiers (
      identifier TEXT NOT NULL,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (identifier, conversation_id)
    );

    CREATE TABLE IF NOT EXISTS conversation_sync_state (
      conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      newest_external_id TEXT,
      newest_message_at DATETIME,
      oldest_external_id TEXT,
      oldest_message_at DATETIME,
      history_complete INTEGER DEFAULT 0,
      gap_target_external_id TEXT,
      gap_fetch_limit INTEGER,
      last_success_at DATETIME,
      last_error TEXT,
      last_error_at DATETIME,
      last_duration_ms INTEGER,
      last_messages_fetched INTEGER DEFAULT 0,
      last_messages_imported INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      whatsapp_id TEXT UNIQUE NOT NULL,
      phone TEXT,
      name TEXT,
      push_name TEXT,
      short_name TEXT,
      verified_name TEXT,
      profile_pic_url TEXT,
      is_saved INTEGER DEFAULT 0,
      is_business INTEGER DEFAULT 0,
      is_blocked INTEGER DEFAULT 0,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS group_participants (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
      participant_id TEXT NOT NULL,
      phone TEXT,
      name TEXT,
      profile_pic_url TEXT,
      is_admin INTEGER DEFAULT 0,
      is_super_admin INTEGER DEFAULT 0,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (conversation_id, participant_id)
    );

    CREATE TABLE IF NOT EXISTS conversation_user_state (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      user_role TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      last_read_message_id INTEGER REFERENCES messages(id),
      last_read_at DATETIME,
      PRIMARY KEY (conversation_id, user_role, user_id)
    );

    CREATE TABLE IF NOT EXISTS message_stars (
      message_id INTEGER NOT NULL REFERENCES messages(id),
      user_role TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, user_role, user_id)
    );

    CREATE TABLE IF NOT EXISTS message_user_state (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_role TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      pinned_at DATETIME,
      hidden_at DATETIME,
      PRIMARY KEY (message_id, user_role, user_id)
    );

    CREATE TABLE IF NOT EXISTS password_reset_applications (
      request_id INTEGER PRIMARY KEY,
      admin_id INTEGER NOT NULL,
      password_hash TEXT NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

    ensureColumn(db, 'vendors', 'sector_id', 'INTEGER REFERENCES sectors(id)');
    ensureColumn(db, 'admins', 'super_admin', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'admins', 'name', 'TEXT');
    ensureColumn(db, 'admins', 'token_version', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'admins', 'last_login_at', 'DATETIME');
    ensureColumn(db, 'admins', 'last_seen_at', 'DATETIME');
    ensureColumn(db, 'admins', 'inbox_baseline_at', 'DATETIME');
    ensureColumn(db, 'admins', 'inbox_baseline_message_id', 'INTEGER');
    ensureColumn(db, 'vendors', 'token_version', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'vendors', 'row_version', 'INTEGER NOT NULL DEFAULT 1');
    ensureColumn(db, 'vendors', 'last_login_at', 'DATETIME');
    ensureColumn(db, 'vendors', 'last_seen_at', 'DATETIME');
    ensureColumn(db, 'vendors', 'inbox_baseline_at', 'DATETIME');
    ensureColumn(db, 'vendors', 'inbox_baseline_message_id', 'INTEGER');
    ensureColumn(db, 'sectors', 'row_version', 'INTEGER NOT NULL DEFAULT 1');
    db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_username_nocase
      ON admins(username COLLATE NOCASE);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_username_nocase
      ON vendors(username COLLATE NOCASE);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sectors_name_nocase
      ON sectors(name COLLATE NOCASE);
  `);
    // O WhatsApp Web passou a enderecar por @lid e a coluna phone guarda esse
    // identificador — um numero longo que NAO e telefone e nao pode ser
    // mostrado ao atendente. O telefone real fica em conversation_identifiers
    // como @c.us. Denormalizado aqui de proposito: a alternativa era adicionar
    // um subselect em cada consulta de conversa (ha mais de dez), e bastava
    // esquecer uma para a tela voltar a mostrar o @lid — foi o que aconteceu
    // com o painel de perfil em 04/set/2026. Com a coluna, todo SELECT * ja
    // traz o valor. A coluna phone segue intocada porque o ENVIO depende dela.
    // Coordenada guardada em coluna, nao extraida do texto: o conteudo e feito
    // para humano ler e mudaria a qualquer ajuste de redacao, quebrando o mapa.
    // Serve para os dois sentidos — localizacao que o atendente envia e
    // localizacao que o cliente manda.
    ensureColumn(db, 'messages', 'location_latitude', 'REAL');
    ensureColumn(db, 'messages', 'location_longitude', 'REAL');
    ensureColumn(db, 'conversations', 'display_phone', 'TEXT');
    db.prepare(`
      UPDATE conversations
      SET display_phone = (
        SELECT ci.identifier
        FROM conversation_identifiers ci
        WHERE ci.conversation_id = conversations.id
          AND ci.identifier LIKE '%@c.us'
        ORDER BY LENGTH(ci.identifier), ci.identifier
        LIMIT 1
      )
      WHERE display_phone IS NULL
    `).run();
    ensureColumn(db, 'conversations', 'profile_pic_url', 'TEXT');
    ensureColumn(db, 'conversations', 'sector_id', 'INTEGER REFERENCES sectors(id)');
    ensureColumn(db, 'conversations', 'last_activity_at', 'DATETIME');
    ensureColumn(db, 'conversations', 'is_group', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'conversations', 'group_description', 'TEXT');
    ensureColumn(db, 'conversations', 'group_owner', 'TEXT');
    ensureColumn(db, 'conversations', 'group_created_at', 'DATETIME');
    ensureColumn(db, 'conversations', 'profile_about', 'TEXT');
    ensureColumn(db, 'conversations', 'whatsapp_archived', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'conversations', 'archived_at', 'DATETIME');
    ensureColumn(db, 'conversations', 'archive_sync_state', "TEXT DEFAULT 'synced'");
    ensureColumn(db, 'conversations', 'manually_started', 'INTEGER DEFAULT 0');

    ensureColumn(db, 'messages', 'external_id', 'TEXT');
    ensureColumn(db, 'messages', 'media_type', 'TEXT');
    ensureColumn(db, 'messages', 'media_mimetype', 'TEXT');
    ensureColumn(db, 'messages', 'media_filename', 'TEXT');
    ensureColumn(db, 'messages', 'media_url', 'TEXT');
    ensureColumn(db, 'messages', 'media_size', 'INTEGER');
    ensureColumn(db, 'messages', 'media_unavailable', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'messages', 'delivery_status', "TEXT DEFAULT 'received'");
    ensureColumn(db, 'messages', 'delivery_error', 'TEXT');
    ensureColumn(db, 'messages', 'sent_at', 'DATETIME');
    ensureColumn(db, 'messages', 'client_request_id', 'TEXT');
    ensureColumn(db, 'messages', 'media_sha256', 'TEXT');
    ensureColumn(db, 'messages', 'deleted_for_everyone', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'messages', 'deleted_for_everyone_at', 'DATETIME');
    ensureColumn(db, 'messages', 'starred', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'messages', 'starred_at', 'DATETIME');
    ensureColumn(db, 'messages', 'starred_by', 'INTEGER');
    ensureColumn(db, 'messages', 'starred_by_role', 'TEXT');
    ensureColumn(db, 'messages', 'vendor_id', 'INTEGER REFERENCES vendors(id)');
    ensureColumn(db, 'messages', 'vendor_sector_id', 'INTEGER REFERENCES sectors(id)');
    ensureColumn(db, 'messages', 'quoted_message_id', 'INTEGER REFERENCES messages(id)');
    ensureColumn(db, 'messages', 'edited_at', 'DATETIME');
    ensureColumn(db, 'messages', 'participant_id', 'TEXT');
    ensureColumn(db, 'messages', 'participant_phone', 'TEXT');
    ensureColumn(db, 'messages', 'participant_name', 'TEXT');
    ensureColumn(db, 'conversation_user_state', 'pinned_at', 'DATETIME');
    ensureColumn(db, 'conversation_user_state', 'muted_until', 'DATETIME');
    ensureColumn(db, 'conversation_user_state', 'marked_unread', 'INTEGER DEFAULT 0');
    ensureColumn(db, 'conversation_user_state', 'draft_text', 'TEXT');
    ensureColumn(db, 'conversation_user_state', 'draft_updated_at', 'DATETIME');
    ensureColumn(db, 'conversation_user_state', 'typing_at', 'DATETIME');
    ensureColumn(db, 'conversation_user_state', 'last_read_message_at', 'DATETIME');

    db.exec(`
    -- O baseline pertence ao momento em que a caixa de entrada passou a existir
    -- para a identidade. Assim a primeira listagem nao pode engolir uma mensagem
    -- real recebida enquanto o usuario estava offline. O id desempata mensagens
    -- gravadas no mesmo segundo; o horario evita que historico antigo importado
    -- depois da migracao apareca como notificacao nova.
    UPDATE admins
    SET inbox_baseline_at = COALESCE(
          inbox_baseline_at,
          strftime('%Y-%m-%d %H:%M:%f', 'now')
        ),
        inbox_baseline_message_id = COALESCE(
          inbox_baseline_message_id,
          (SELECT MAX(id) FROM messages),
          0
        )
    WHERE inbox_baseline_at IS NULL
       OR inbox_baseline_message_id IS NULL;

    UPDATE vendors
    SET inbox_baseline_at = COALESCE(
          inbox_baseline_at,
          strftime('%Y-%m-%d %H:%M:%f', 'now')
        ),
        inbox_baseline_message_id = COALESCE(
          inbox_baseline_message_id,
          (SELECT MAX(id) FROM messages),
          0
        )
    WHERE inbox_baseline_at IS NULL
       OR inbox_baseline_message_id IS NULL;

    CREATE TRIGGER IF NOT EXISTS trg_admins_inbox_baseline_after_insert
    AFTER INSERT ON admins
    WHEN NEW.inbox_baseline_at IS NULL
      OR NEW.inbox_baseline_message_id IS NULL
    BEGIN
      UPDATE admins
      SET inbox_baseline_at = COALESCE(
            NEW.inbox_baseline_at,
            strftime('%Y-%m-%d %H:%M:%f', 'now')
          ),
          inbox_baseline_message_id = COALESCE(
            NEW.inbox_baseline_message_id,
            (SELECT MAX(id) FROM messages),
            0
          )
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_vendors_inbox_baseline_after_insert
    AFTER INSERT ON vendors
    WHEN NEW.inbox_baseline_at IS NULL
      OR NEW.inbox_baseline_message_id IS NULL
    BEGIN
      UPDATE vendors
      SET inbox_baseline_at = COALESCE(
            NEW.inbox_baseline_at,
            strftime('%Y-%m-%d %H:%M:%f', 'now')
          ),
          inbox_baseline_message_id = COALESCE(
            NEW.inbox_baseline_message_id,
            (SELECT MAX(id) FROM messages),
            0
          )
      WHERE id = NEW.id;
    END;

    INSERT OR IGNORE INTO conversation_identifiers (identifier, conversation_id)
    SELECT phone, id
    FROM conversations;

    INSERT OR IGNORE INTO message_stars (message_id, user_role, user_id, created_at)
    SELECT id, starred_by_role, starred_by, COALESCE(starred_at, CURRENT_TIMESTAMP)
    FROM messages
    WHERE starred = 1
      AND starred_by_role IS NOT NULL
      AND starred_by IS NOT NULL;
  `);

    db.exec(`
    UPDATE messages
    SET delivery_status = 'received'
    WHERE delivery_status IS NULL;

    UPDATE messages
    SET delivery_status = 'sent',
        sent_at = COALESCE(sent_at, created_at)
    WHERE from_type = 'vendor'
      AND delivery_status = 'received';

    -- Congela o setor no momento do envio. Para o legado, a melhor informacao
    -- disponivel e o setor atual do vendedor; novos envios gravam o valor real.
    UPDATE messages
    SET vendor_sector_id = (
      SELECT v.sector_id
      FROM vendors v
      WHERE v.id = messages.vendor_id
    )
    WHERE vendor_id IS NOT NULL
      AND vendor_sector_id IS NULL;
  `);

    db.exec(`
    UPDATE conversations
    SET last_activity_at = COALESCE(
      (
        SELECT MAX(m.created_at)
        FROM messages m
        WHERE m.conversation_id = conversations.id
      ),
      updated_at,
      created_at,
      CURRENT_TIMESTAMP
    )
    WHERE last_activity_at IS NULL;

    UPDATE conversations
    SET is_group = CASE WHEN phone LIKE '%@g.us' THEN 1 ELSE 0 END
    WHERE is_group IS NULL
       OR (is_group = 0 AND phone LIKE '%@g.us');

    UPDATE conversations
    SET whatsapp_archived = COALESCE(whatsapp_archived, 0),
        archive_sync_state = COALESCE(archive_sync_state, 'synced'),
        manually_started = COALESCE(manually_started, 0);
  `);

    // Migra o watermark antigo (somente ID) para o cursor cronológico usado
    // pela paginação. Histórico inserido depois não deve reaparecer como novo.
    db.exec(`
    UPDATE conversation_user_state
    SET last_read_message_at = (
      SELECT m.created_at
      FROM messages m
      WHERE m.id = conversation_user_state.last_read_message_id
    )
    WHERE last_read_message_id IS NOT NULL
      AND last_read_message_at IS NULL;
  `);

    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone);
    CREATE INDEX IF NOT EXISTS idx_conversation_identifiers_identifier
      ON conversation_identifiers(identifier, conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_identifiers_conversation
      ON conversation_identifiers(conversation_id, identifier);
    CREATE INDEX IF NOT EXISTS idx_conversations_sector_id ON conversations(sector_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_last_activity_at ON conversations(last_activity_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_archived_activity
      ON conversations(whatsapp_archived, last_activity_at, id);
    CREATE INDEX IF NOT EXISTS idx_vendors_sector_id ON vendors(sector_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_id
      ON messages(conversation_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at
      ON messages(created_at, id);
    CREATE INDEX IF NOT EXISTS idx_messages_vendor_created
      ON messages(vendor_id, created_at, conversation_id)
      WHERE vendor_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_vendor_sector_created
      ON messages(vendor_sector_id, created_at, conversation_id)
      WHERE vendor_sector_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external_id
      ON messages(external_id)
      WHERE external_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_request_id
      ON messages(client_request_id)
      WHERE client_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_conversation_user_state_user
      ON conversation_user_state(user_role, user_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_user_state_pinned
      ON conversation_user_state(user_role, user_id, pinned_at);
    CREATE INDEX IF NOT EXISTS idx_message_stars_user
      ON message_stars(user_role, user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_message_stars_message_id
      ON message_stars(message_id);
    CREATE INDEX IF NOT EXISTS idx_message_user_state_user
      ON message_user_state(user_role, user_id, pinned_at, hidden_at);
    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
    CREATE INDEX IF NOT EXISTS idx_contacts_saved_name ON contacts(is_saved, name);
    CREATE INDEX IF NOT EXISTS idx_group_participants_conversation
      ON group_participants(conversation_id, name, phone);
    CREATE INDEX IF NOT EXISTS idx_messages_participant_id ON messages(participant_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_sync_state_success
      ON conversation_sync_state(last_success_at, last_error_at);
  `);

    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  migrate.immediate();
}

module.exports = {
  SCHEMA_VERSION,
  ensureSchema,
  applyPragmas,
};
