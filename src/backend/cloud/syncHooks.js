// Hook into local writes — when a synced table is written to, schedule
// a debounced push to cloud (coalesces rapid edits to the same row).
//
// Why explicit notifySync() vs SQLite update_hook:
//   Update_hook fires on every write, including FB pipeline tables (clips/jobs)
//   which we explicitly do NOT want to sync. Explicit calls keep the sync surface
//   tightly scoped to the eight tables in SYNC_TABLES.

const { pushOne } = require('./syncEngine');
const SYNC_TABLES = require('./syncTables');

const DEBOUNCE_MS = 2000;

function startSyncHooks(db, getAccessToken) {
  const syncedTableNames = new Set(SYNC_TABLES.map(t => t.localTable));
  const _pendingTimers = new Map();    // `${table}|${pk}` → timeoutId

  function key(table, pk) { return `${table}|${pk}`; }

  return {
    notifySync(table, pk) {
      if (!syncedTableNames.has(table)) return;
      const k = key(table, pk);
      if (_pendingTimers.has(k)) clearTimeout(_pendingTimers.get(k));
      const t = setTimeout(async () => {
        _pendingTimers.delete(k);
        const tok = getAccessToken();
        if (!tok) return;
        try {
          await pushOne(db, tok, table, pk);
        } catch (e) {
          console.error(`[syncHooks] push ${table}/${pk} failed:`, e.message);
        }
      }, DEBOUNCE_MS);
      if (t && typeof t.unref === 'function') t.unref();
      _pendingTimers.set(k, t);
    },

    flushAll() {
      for (const t of _pendingTimers.values()) clearTimeout(t);
      _pendingTimers.clear();
    }
  };
}

module.exports = { startSyncHooks };
