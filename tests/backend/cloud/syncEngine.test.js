import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';

const SUPA_URL = 'https://test.supabase.co';
let server, tmpDir, db;

beforeEach(() => {
  process.env.KINTENSHAUTO_SUPABASE_URL = SUPA_URL;
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-sync-'));
  db = new Database(path.join(tmpDir, 't.db'));
  // Create minimal subset of synced tables for tests
  db.exec(`
    CREATE TABLE banner_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      layers_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      cloud_uuid TEXT,
      cloud_synced_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at DATETIME
    );
    CREATE UNIQUE INDEX idx_banner_presets_cloud_uuid ON banner_presets(cloud_uuid) WHERE cloud_uuid IS NOT NULL;
  `);
});

afterEach(() => {
  if (db) db.close();
  if (server) server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('syncEngine.pullAll', () => {
  it('inserts cloud rows that do not exist locally', async () => {
    server = setupServer(
      http.get(`${SUPA_URL}/rest/v1/cloud_banner_presets`, () =>
        HttpResponse.json([{
          cloud_uuid: 'uuid-1', name: 'Logo TG', layers_json: '[]',
          updated_at: '2026-05-16T10:00:00Z', deleted_at: null
        }])
      ),
      http.get(`${SUPA_URL}/rest/v1/:table`, () => HttpResponse.json([]))
    );
    server.listen({ onUnhandledRequest: 'bypass' });

    const { pullAll } = await import('../../../src/backend/cloud/syncEngine.js?n=' + Date.now());
    const result = await pullAll(db, 'access-tok');

    expect(result.ok).toBe(true);
    expect(result.inserted).toBeGreaterThanOrEqual(1);

    const rows = db.prepare(`SELECT * FROM banner_presets WHERE cloud_uuid = ?`).all('uuid-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Logo TG');
  });

  it('returns reason=not_configured when no client', async () => {
    delete process.env.KINTENSHAUTO_SUPABASE_URL;
    const { pullAll } = await import('../../../src/backend/cloud/syncEngine.js?n=' + Date.now());
    const r = await pullAll(db, 'tok');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_configured');
  });

  it('updates local row when cloud is newer (LWW)', async () => {
    // Seed local with older updated_at
    db.prepare(`INSERT INTO banner_presets (name, layers_json, cloud_uuid, updated_at, cloud_synced_at) VALUES (?, ?, ?, ?, ?)`)
      .run('Old Name', '[]', 'uuid-1', '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z');

    server = setupServer(
      http.get(`${SUPA_URL}/rest/v1/cloud_banner_presets`, () =>
        HttpResponse.json([{
          cloud_uuid: 'uuid-1', name: 'New Name', layers_json: '[]',
          updated_at: '2026-05-16T10:00:00Z', deleted_at: null
        }])
      ),
      http.get(`${SUPA_URL}/rest/v1/:table`, () => HttpResponse.json([]))
    );
    server.listen({ onUnhandledRequest: 'bypass' });

    const { pullAll } = await import('../../../src/backend/cloud/syncEngine.js?n=' + Date.now());
    await pullAll(db, 'tok');

    const row = db.prepare(`SELECT * FROM banner_presets WHERE cloud_uuid = 'uuid-1'`).get();
    expect(row.name).toBe('New Name');
  });

  it('skips local row when local is newer (LWW)', async () => {
    db.prepare(`INSERT INTO banner_presets (name, layers_json, cloud_uuid, updated_at, cloud_synced_at) VALUES (?, ?, ?, ?, ?)`)
      .run('Local Newer', '[]', 'uuid-1', '2026-05-17T00:00:00Z', '2026-05-15T00:00:00Z');

    server = setupServer(
      http.get(`${SUPA_URL}/rest/v1/cloud_banner_presets`, () =>
        HttpResponse.json([{
          cloud_uuid: 'uuid-1', name: 'Cloud Older', layers_json: '[]',
          updated_at: '2026-05-16T10:00:00Z', deleted_at: null
        }])
      ),
      http.get(`${SUPA_URL}/rest/v1/:table`, () => HttpResponse.json([]))
    );
    server.listen({ onUnhandledRequest: 'bypass' });

    const { pullAll } = await import('../../../src/backend/cloud/syncEngine.js?n=' + Date.now());
    await pullAll(db, 'tok');

    const row = db.prepare(`SELECT * FROM banner_presets WHERE cloud_uuid = 'uuid-1'`).get();
    expect(row.name).toBe('Local Newer');  // local stays
  });

  it('applies soft delete from cloud', async () => {
    db.prepare(`INSERT INTO banner_presets (name, layers_json, cloud_uuid, updated_at, deleted_at) VALUES (?, ?, ?, ?, NULL)`)
      .run('To Delete', '[]', 'uuid-1', '2026-05-15T00:00:00Z');

    server = setupServer(
      http.get(`${SUPA_URL}/rest/v1/cloud_banner_presets`, () =>
        HttpResponse.json([{
          cloud_uuid: 'uuid-1', name: 'To Delete', layers_json: '[]',
          updated_at: '2026-05-16T00:00:00Z', deleted_at: '2026-05-16T00:00:00Z'
        }])
      ),
      http.get(`${SUPA_URL}/rest/v1/:table`, () => HttpResponse.json([]))
    );
    server.listen({ onUnhandledRequest: 'bypass' });

    const { pullAll } = await import('../../../src/backend/cloud/syncEngine.js?n=' + Date.now());
    await pullAll(db, 'tok');

    const row = db.prepare(`SELECT * FROM banner_presets WHERE cloud_uuid = 'uuid-1'`).get();
    expect(row.deleted_at).toBeTruthy();
  });
});

describe('syncEngine.pushOne', () => {
  it('assigns cloud_uuid + upserts to cloud + sets cloud_synced_at', async () => {
    let upsertedBody = null;
    server = setupServer(
      http.post(`${SUPA_URL}/rest/v1/cloud_banner_presets`, async ({ request }) => {
        const body = await request.json();
        upsertedBody = Array.isArray(body) ? body[0] : body;
        return HttpResponse.json([{ cloud_uuid: upsertedBody.cloud_uuid }]);
      })
    );
    server.listen({ onUnhandledRequest: 'bypass' });

    db.prepare(`INSERT INTO banner_presets (name, layers_json) VALUES ('Local Preset', '[]')`).run();

    const { pushOne } = await import('../../../src/backend/cloud/syncEngine.js?n=' + Date.now());
    const result = await pushOne(db, 'tok', 'banner_presets', 1);

    expect(result.ok).toBe(true);
    expect(upsertedBody.name).toBe('Local Preset');
    expect(upsertedBody.cloud_uuid).toMatch(/^[a-f0-9-]+$/);

    const row = db.prepare(`SELECT * FROM banner_presets WHERE id = 1`).get();
    expect(row.cloud_synced_at).not.toBeNull();
    expect(row.cloud_uuid).toBe(upsertedBody.cloud_uuid);
  });

  it('returns reason=unknown_table for unsupported table', async () => {
    const { pushOne } = await import('../../../src/backend/cloud/syncEngine.js?n=' + Date.now());
    const r = await pushOne(db, 'tok', 'not_a_synced_table', 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unknown_table');
  });

  it('returns reason=row_not_found when pk does not exist', async () => {
    const { pushOne } = await import('../../../src/backend/cloud/syncEngine.js?n=' + Date.now());
    const r = await pushOne(db, 'tok', 'banner_presets', 9999);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('row_not_found');
  });
});
