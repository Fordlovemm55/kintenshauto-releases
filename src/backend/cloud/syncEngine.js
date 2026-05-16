// Sync engine — bidirectional last-write-wins sync.
//
//   pullAll(db, accessToken)              fetch all cloud rows, LWW-merge into local
//   pushOne(db, accessToken, table, pk)   push one local row to cloud (assigns cloud_uuid if missing)
//   pushPending(db, accessToken)          push every row WHERE cloud_synced_at < updated_at

const crypto = require('crypto');
const { getUserClient } = require('./supabaseClient');
const SYNC_TABLES = require('./syncTables');

function generateUuid() {
  return crypto.randomUUID();
}

function tableConfig(localTable) {
  return SYNC_TABLES.find(t => t.localTable === localTable);
}

// Build the cloud payload for one row (handles encryptedColumn rename).
function buildCloudPayload(cfg, row) {
  const payload = {
    cloud_uuid: row.cloud_uuid,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at || null
  };
  for (const c of cfg.columns) payload[c] = row[c];
  if (cfg.encryptedColumn) {
    payload[cfg.encryptedColumn.cloud] = row[cfg.encryptedColumn.local];
  }
  return payload;
}

// Apply a cloud row into local DB (INSERT or UPDATE).
function applyCloudRowToLocal(db, cfg, cloudRow) {
  const localRow = db.prepare(
    `SELECT * FROM ${cfg.localTable} WHERE cloud_uuid = ?`
  ).get(cloudRow.cloud_uuid);

  // Soft delete from cloud
  if (cloudRow.deleted_at) {
    if (localRow) {
      db.prepare(`UPDATE ${cfg.localTable} SET deleted_at = ? WHERE ${cfg.pkLocal} = ?`)
        .run(cloudRow.deleted_at, localRow[cfg.pkLocal]);
      return 'updated';
    }
    return 'skipped';
  }

  // Map cloud encrypted_key → local api_key
  const colMap = {};
  for (const c of cfg.columns) colMap[c] = cloudRow[c] ?? null;
  if (cfg.encryptedColumn) {
    colMap[cfg.encryptedColumn.local] = cloudRow[cfg.encryptedColumn.cloud] ?? null;
  }

  if (!localRow) {
    // INSERT
    const allCols = ['cloud_uuid', 'cloud_synced_at', 'updated_at', ...Object.keys(colMap)];
    const allVals = [cloudRow.cloud_uuid, new Date().toISOString(), cloudRow.updated_at,
                     ...Object.values(colMap)];
    const placeholders = allCols.map(() => '?').join(',');
    db.prepare(`INSERT INTO ${cfg.localTable} (${allCols.join(',')}) VALUES (${placeholders})`)
      .run(...allVals);
    return 'inserted';
  }

  // UPDATE if cloud is newer (LWW)
  const localUpdated = new Date(localRow.updated_at || 0).getTime();
  const cloudUpdated = new Date(cloudRow.updated_at).getTime();
  if (cloudUpdated <= localUpdated) return 'skipped';

  const setCols = [...Object.keys(colMap), 'updated_at', 'cloud_synced_at'];
  const setVals = [...Object.values(colMap), cloudRow.updated_at, new Date().toISOString()];
  const sets = setCols.map(c => `${c} = ?`).join(', ');
  db.prepare(`UPDATE ${cfg.localTable} SET ${sets} WHERE ${cfg.pkLocal} = ?`)
    .run(...setVals, localRow[cfg.pkLocal]);
  return 'updated';
}

async function pullAll(db, accessToken) {
  const client = getUserClient(accessToken);
  if (!client) return { ok: false, reason: 'not_configured' };

  let totalInserted = 0, totalUpdated = 0, totalSkipped = 0;

  for (const cfg of SYNC_TABLES) {
    const { data: cloudRows, error } = await client.from(cfg.cloudTable).select('*');
    if (error) {
      console.error(`[sync] pull ${cfg.cloudTable} failed:`, error.message);
      continue;
    }
    for (const cloudRow of cloudRows || []) {
      try {
        const outcome = applyCloudRowToLocal(db, cfg, cloudRow);
        if (outcome === 'inserted') totalInserted++;
        else if (outcome === 'updated') totalUpdated++;
        else totalSkipped++;
      } catch (e) {
        console.error(`[sync] apply ${cfg.cloudTable}/${cloudRow.cloud_uuid}:`, e.message);
      }
    }
  }
  return { ok: true, inserted: totalInserted, updated: totalUpdated, skipped: totalSkipped };
}

async function pushOne(db, accessToken, localTable, localPk) {
  const cfg = tableConfig(localTable);
  if (!cfg) return { ok: false, reason: 'unknown_table' };
  const client = getUserClient(accessToken);
  if (!client) return { ok: false, reason: 'not_configured' };

  const row = db.prepare(`SELECT * FROM ${localTable} WHERE ${cfg.pkLocal} = ?`).get(localPk);
  if (!row) return { ok: false, reason: 'row_not_found' };

  // Assign cloud_uuid if missing
  if (!row.cloud_uuid) {
    const uuid = generateUuid();
    db.prepare(`UPDATE ${localTable} SET cloud_uuid = ? WHERE ${cfg.pkLocal} = ?`).run(uuid, localPk);
    row.cloud_uuid = uuid;
  }
  // Ensure updated_at is set
  if (!row.updated_at) {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(`UPDATE ${localTable} SET updated_at = ? WHERE ${cfg.pkLocal} = ?`).run(now, localPk);
    row.updated_at = now;
  }

  const payload = buildCloudPayload(cfg, row);

  const { error } = await client.from(cfg.cloudTable).upsert(payload, { onConflict: 'cloud_uuid' });
  if (error) return { ok: false, reason: 'upsert_failed', message: error.message };

  db.prepare(`UPDATE ${localTable} SET cloud_synced_at = datetime('now', 'localtime') WHERE ${cfg.pkLocal} = ?`)
    .run(localPk);
  return { ok: true };
}

async function pushPending(db, accessToken) {
  let pushed = 0, failed = 0;
  for (const cfg of SYNC_TABLES) {
    let pending;
    try {
      pending = db.prepare(`
        SELECT ${cfg.pkLocal} as pk FROM ${cfg.localTable}
        WHERE cloud_synced_at IS NULL OR cloud_synced_at < updated_at
      `).all();
    } catch (e) {
      // Table may not exist on fresh DB — skip
      continue;
    }
    for (const p of pending) {
      const r = await pushOne(db, accessToken, cfg.localTable, p.pk);
      if (r.ok) pushed++; else failed++;
    }
  }
  return { ok: true, pushed, failed };
}

module.exports = { pullAll, pushOne, pushPending };
