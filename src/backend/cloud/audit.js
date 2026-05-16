// Audit event logger.
//   logEvent(db, event, detail)  — queue locally (always succeeds; offline-safe)
//   flushAudit(db, accessToken)  — push queued events to cloud audit_log, mark flushed

const { getUserClient } = require('./supabaseClient');

const BATCH_SIZE = 100;

function logEvent(db, event, detail = {}) {
  if (!event || typeof event !== 'string') {
    throw new Error('logEvent: event must be a non-empty string');
  }
  const payload = JSON.stringify(detail || {});
  db.prepare(`INSERT INTO audit_queue (event, detail_json) VALUES (?, ?)`)
    .run(event, payload);
}

async function flushAudit(db, accessToken) {
  if (!accessToken) return { flushed: 0, failed: 0, reason: 'no_token' };
  const client = getUserClient(accessToken);
  if (!client) return { flushed: 0, failed: 0, reason: 'not_configured' };

  const rows = db.prepare(`
    SELECT id, event, detail_json, created_at
    FROM audit_queue
    WHERE flushed_at IS NULL
    ORDER BY id ASC
    LIMIT ?
  `).all(BATCH_SIZE);

  if (rows.length === 0) return { flushed: 0, failed: 0 };

  const payload = rows.map(r => ({
    event: r.event,
    detail_json: r.detail_json ? JSON.parse(r.detail_json) : {},
    created_at: r.created_at
  }));

  try {
    const { error } = await client.from('audit_log').insert(payload);
    if (error) {
      return { flushed: 0, failed: rows.length, error: error.message };
    }
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE audit_queue SET flushed_at = datetime('now', 'localtime') WHERE id IN (${placeholders})`
    ).run(...ids);
    return { flushed: rows.length, failed: 0 };
  } catch (err) {
    return { flushed: 0, failed: rows.length, error: err.message };
  }
}

module.exports = { logEvent, flushAudit };
