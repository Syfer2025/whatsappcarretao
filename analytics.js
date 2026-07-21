function clampDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days)) return 30;
  return Math.min(Math.max(Math.trunc(days), 1), 365);
}

function toSqlTimestamp(date) {
  return new Date(date).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function tableHasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

function getTenantStatistics({ db, days: rawDays = 30, presence = [], now = new Date() }) {
  const days = clampDays(rawDays);
  const generatedAt = new Date(now);
  const fromDate = new Date(generatedAt.getTime() - days * 24 * 60 * 60 * 1000);
  const from = toSqlTimestamp(fromDate);
  const hasVendorLastSeen = tableHasColumn(db, 'vendors', 'last_seen_at');
  const hasAdminName = tableHasColumn(db, 'admins', 'name');
  const hasAdminLastSeen = tableHasColumn(db, 'admins', 'last_seen_at');

  const base = db.prepare(`
    SELECT
      (SELECT COUNT(DISTINCT conversation_id)
       FROM messages
       WHERE from_type = 'vendor' AND created_at >= ?) AS attended_contacts,
      (SELECT COUNT(*) FROM messages
       WHERE from_type = 'vendor' AND created_at >= ?) AS messages_sent,
      (SELECT COUNT(*) FROM messages
       WHERE from_type = 'client' AND created_at >= ?) AS messages_received,
      (SELECT COUNT(*) FROM conversations
       WHERE status != 'closed' AND COALESCE(whatsapp_archived, 0) = 0) AS open_conversations,
      (SELECT COUNT(*) FROM conversations
       WHERE status = 'unassigned' AND COALESCE(whatsapp_archived, 0) = 0) AS unassigned_conversations,
      (SELECT COUNT(*) FROM vendors WHERE active = 1) AS active_vendors
  `).get(from, from, from);

  const responseTime = db.prepare(`
    WITH first_client AS (
      SELECT conversation_id, MIN(created_at) AS client_at
      FROM messages
      WHERE from_type = 'client' AND created_at >= ?
      GROUP BY conversation_id
    ), first_reply AS (
      SELECT fc.conversation_id,
             fc.client_at,
             MIN(m.created_at) AS reply_at
      FROM first_client fc
      JOIN messages m
        ON m.conversation_id = fc.conversation_id
       AND m.from_type = 'vendor'
       AND m.created_at >= fc.client_at
      GROUP BY fc.conversation_id, fc.client_at
    )
    SELECT ROUND(AVG((julianday(reply_at) - julianday(client_at)) * 86400)) AS seconds
    FROM first_reply
  `).get(from)?.seconds;

  const vendors = db.prepare(`
    WITH vendor_messages AS (
      SELECT vendor_id,
             COUNT(DISTINCT conversation_id) AS attended_contacts,
             COUNT(*) AS messages_sent
      FROM messages
      WHERE from_type = 'vendor'
        AND vendor_id IS NOT NULL
        AND created_at >= ?
      GROUP BY vendor_id
    ), vendor_open AS (
      SELECT assigned_to AS vendor_id, COUNT(*) AS assigned_open
      FROM conversations
      WHERE status != 'closed'
        AND COALESCE(whatsapp_archived, 0) = 0
        AND assigned_to IS NOT NULL
      GROUP BY assigned_to
    )
    SELECT v.id,
           v.name,
           v.username,
           v.active,
           v.sector_id,
           s.name AS sector_name,
           ${hasVendorLastSeen ? 'v.last_seen_at' : 'NULL AS last_seen_at'},
           COALESCE(vm.attended_contacts, 0) AS attended_contacts,
           COALESCE(vm.messages_sent, 0) AS messages_sent,
           COALESCE(vo.assigned_open, 0) AS assigned_open
    FROM vendors v
    LEFT JOIN sectors s ON s.id = v.sector_id
    LEFT JOIN vendor_messages vm ON vm.vendor_id = v.id
    LEFT JOIN vendor_open vo ON vo.vendor_id = v.id
    ORDER BY v.active DESC, attended_contacts DESC, v.name ASC
  `).all(from);

  const onlineKeys = new Set(
    (Array.isArray(presence) ? presence : []).map(item => `${item.role}:${Number(item.userId)}`)
  );
  const presenceByKey = new Map(
    (Array.isArray(presence) ? presence : []).map(item => [`${item.role}:${Number(item.userId)}`, item])
  );

  const vendorRows = vendors.map(vendor => {
    const onlinePresence = presenceByKey.get(`vendor:${vendor.id}`);
    return {
      ...vendor,
      online: Boolean(onlinePresence),
      online_since: onlinePresence?.connectedAt || null,
      connection_count: Number(onlinePresence?.connectionCount || 0)
    };
  });

  const admins = db.prepare(`
    SELECT id,
           ${hasAdminName ? 'COALESCE(NULLIF(name, \'\'), username)' : 'username'} AS name,
           username,
           ${hasAdminLastSeen ? 'last_login_at' : 'NULL AS last_login_at'},
           ${hasAdminLastSeen ? 'last_seen_at' : 'NULL AS last_seen_at'}
    FROM admins
    WHERE coalesce(super_admin, 0) = 0
    ORDER BY name COLLATE NOCASE, id
  `).all().map(admin => {
    const onlinePresence = presenceByKey.get(`admin:${admin.id}`);
    return {
      ...admin,
      online: Boolean(onlinePresence),
      online_since: onlinePresence?.connectedAt || null,
      connection_count: Number(onlinePresence?.connectionCount || 0)
    };
  });

  const sectors = db.prepare(`
    WITH sector_vendors AS (
      SELECT sector_id, COUNT(*) AS vendor_count
      FROM vendors
      WHERE active = 1 AND sector_id IS NOT NULL
      GROUP BY sector_id
    ), sector_messages AS (
      SELECT COALESCE(m.vendor_sector_id, v.sector_id) AS sector_id,
             COUNT(DISTINCT m.conversation_id) AS attended_contacts,
             COUNT(*) AS messages_sent
      FROM messages m
      LEFT JOIN vendors v ON v.id = m.vendor_id
      WHERE m.from_type = 'vendor'
        AND m.created_at >= ?
        AND COALESCE(m.vendor_sector_id, v.sector_id) IS NOT NULL
      GROUP BY COALESCE(m.vendor_sector_id, v.sector_id)
    ), sector_open AS (
      SELECT sector_id, COUNT(*) AS open_conversations
      FROM conversations
      WHERE status != 'closed'
        AND COALESCE(whatsapp_archived, 0) = 0
        AND sector_id IS NOT NULL
      GROUP BY sector_id
    )
    SELECT s.id,
           s.name,
           s.active,
           COALESCE(sv.vendor_count, 0) AS vendor_count,
           COALESCE(sm.attended_contacts, 0) AS attended_contacts,
           COALESCE(sm.messages_sent, 0) AS messages_sent,
           COALESCE(so.open_conversations, 0) AS open_conversations
    FROM sectors s
    LEFT JOIN sector_vendors sv ON sv.sector_id = s.id
    LEFT JOIN sector_messages sm ON sm.sector_id = s.id
    LEFT JOIN sector_open so ON so.sector_id = s.id
    ORDER BY s.active DESC, attended_contacts DESC, s.name ASC
  `).all(from).map(sector => ({
    ...sector,
    online_users: vendorRows.filter(v => v.online && Number(v.sector_id) === Number(sector.id)).length
  }));

  return {
    period_days: days,
    from: fromDate.toISOString(),
    generated_at: generatedAt.toISOString(),
    summary: {
      ...base,
      online_users: onlineKeys.size,
      online_vendors: [...onlineKeys].filter(key => key.startsWith('vendor:')).length,
      online_admins: [...onlineKeys].filter(key => key.startsWith('admin:')).length,
      average_first_response_seconds: responseTime == null ? null : Number(responseTime)
    },
    admins,
    vendors: vendorRows,
    sectors
  };
}

module.exports = { getTenantStatistics };
