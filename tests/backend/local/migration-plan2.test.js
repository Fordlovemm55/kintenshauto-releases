import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';
import { openDatabase, applyMigrations } from '../../../src/backend/local/db.js';

describe('Plan 2 migrations preserve existing data', () => {
  let tmpDir, dbPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-migrate-'));
    dbPath = path.join(tmpDir, 'old.db');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('adds 4 sync columns to pages without losing rows', () => {
    let db = new Database(dbPath);
    db.exec(`
      CREATE TABLE pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER, fb_page_id TEXT, name TEXT, daily_quota INTEGER DEFAULT 5,
        cooldown_min INTEGER DEFAULT 30, niche TEXT, enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.prepare(`INSERT INTO pages (profile_id, fb_page_id, name) VALUES (1, '100', 'Old Page')`).run();
    db.close();

    const { db: db2 } = openDatabase(dbPath);
    // NOTE: SQLite ALTER TABLE ADD COLUMN cannot accept UNIQUE or
    // non-constant DEFAULT — these are enforced post-migration via partial
    // UNIQUE INDEX + UPDATE backfill (mirrors src/backend/server.js).
    applyMigrations(db2, [
      { table: 'pages', column: 'cloud_uuid', definition: 'TEXT' },
      { table: 'pages', column: 'cloud_synced_at', definition: 'DATETIME' },
      { table: 'pages', column: 'updated_at', definition: 'DATETIME' },
      { table: 'pages', column: 'deleted_at', definition: 'DATETIME' }
    ]);
    db2.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_cloud_uuid ON pages(cloud_uuid) WHERE cloud_uuid IS NOT NULL`);
    db2.prepare(`UPDATE pages SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL`).run();

    const cols = db2.prepare(`PRAGMA table_info(pages)`).all().map(c => c.name);
    expect(cols).toContain('cloud_uuid');
    expect(cols).toContain('cloud_synced_at');
    expect(cols).toContain('updated_at');
    expect(cols).toContain('deleted_at');

    const existing = db2.prepare(`SELECT * FROM pages`).all();
    expect(existing).toHaveLength(1);
    expect(existing[0].name).toBe('Old Page');
    expect(existing[0].cloud_uuid).toBeNull();
    expect(existing[0].updated_at).not.toBeNull();

    // Partial unique index enforces uniqueness only for non-NULL values
    db2.prepare(`UPDATE pages SET cloud_uuid = 'abc' WHERE id = 1`).run();
    expect(() => {
      db2.prepare(`INSERT INTO pages (profile_id, fb_page_id, name, cloud_uuid) VALUES (1, '101', 'Dup', 'abc')`).run();
    }).toThrow(/UNIQUE/i);

    db2.close();
  });
});
