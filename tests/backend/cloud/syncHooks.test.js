import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';

const SUPA_URL = 'https://test.supabase.co';
let tmpDir, db, server;

beforeEach(() => {
  process.env.KINTENSHAUTO_SUPABASE_URL = SUPA_URL;
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-hook-'));
  db = new Database(path.join(tmpDir, 'h.db'));
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
  `);
});

afterEach(() => {
  if (db) db.close();
  if (server) server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  vi.useRealTimers();
});

describe('syncHooks.notifySync (debounce)', () => {
  it('coalesces rapid edits to the same row into one push', async () => {
    let pushCount = 0;
    server = setupServer(
      http.post(`${SUPA_URL}/rest/v1/cloud_banner_presets`, () => {
        pushCount++;
        return HttpResponse.json([{ cloud_uuid: 'x' }]);
      })
    );
    server.listen({ onUnhandledRequest: 'bypass' });

    db.prepare(`INSERT INTO banner_presets (name, layers_json) VALUES ('p1', '[]')`).run();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { startSyncHooks } = await import('../../../src/backend/cloud/syncHooks.js?n=' + Date.now());
    const hooks = startSyncHooks(db, () => 'tok');

    hooks.notifySync('banner_presets', 1);
    hooks.notifySync('banner_presets', 1);
    hooks.notifySync('banner_presets', 1);
    expect(pushCount).toBe(0);

    await vi.advanceTimersByTimeAsync(2100);
    // Give the async push a moment to complete
    vi.useRealTimers();
    await new Promise(r => setTimeout(r, 100));
    expect(pushCount).toBe(1);
  });

  it('debounces different rows independently', async () => {
    let pushCount = 0;
    server = setupServer(
      http.post(`${SUPA_URL}/rest/v1/cloud_banner_presets`, () => {
        pushCount++;
        return HttpResponse.json([{ cloud_uuid: 'x' }]);
      })
    );
    server.listen({ onUnhandledRequest: 'bypass' });

    db.prepare(`INSERT INTO banner_presets (name, layers_json) VALUES ('p1', '[]')`).run();
    db.prepare(`INSERT INTO banner_presets (name, layers_json) VALUES ('p2', '[]')`).run();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { startSyncHooks } = await import('../../../src/backend/cloud/syncHooks.js?n=' + Date.now());
    const hooks = startSyncHooks(db, () => 'tok');

    hooks.notifySync('banner_presets', 1);
    hooks.notifySync('banner_presets', 2);

    await vi.advanceTimersByTimeAsync(2100);
    vi.useRealTimers();
    await new Promise(r => setTimeout(r, 100));
    expect(pushCount).toBe(2);
  });

  it('ignores notifications for non-synced tables', async () => {
    let pushCount = 0;
    server = setupServer(
      http.post(`${SUPA_URL}/rest/v1/:table`, () => {
        pushCount++;
        return HttpResponse.json([]);
      })
    );
    server.listen({ onUnhandledRequest: 'bypass' });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { startSyncHooks } = await import('../../../src/backend/cloud/syncHooks.js?n=' + Date.now());
    const hooks = startSyncHooks(db, () => 'tok');

    hooks.notifySync('clips', 1);        // not in SYNC_TABLES
    hooks.notifySync('jobs', 5);          // not in SYNC_TABLES
    hooks.notifySync('scouted_videos', 99);

    await vi.advanceTimersByTimeAsync(2100);
    vi.useRealTimers();
    await new Promise(r => setTimeout(r, 100));
    expect(pushCount).toBe(0);
  });
});
