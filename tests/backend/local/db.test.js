import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { openDatabase, applyMigrations, loadSchema } from '../../../src/backend/local/db.js';

let tmpDir, dbPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-db-test-'));
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('openDatabase', () => {
  it('creates a new database file when none exists', () => {
    const { db, isFresh } = openDatabase(dbPath);
    expect(isFresh).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
  });

  it('reports isFresh=false when DB already exists', () => {
    const { db } = openDatabase(dbPath);
    db.close();
    const { isFresh, db: db2 } = openDatabase(dbPath);
    expect(isFresh).toBe(false);
    db2.close();
  });

  it('enables foreign_keys pragma', () => {
    const { db } = openDatabase(dbPath);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });
});

describe('applyMigrations', () => {
  it('adds missing columns idempotently', () => {
    const { db } = openDatabase(dbPath);
    db.exec(`CREATE TABLE pages (id INTEGER PRIMARY KEY, name TEXT)`);

    applyMigrations(db, [
      { table: 'pages', column: 'niche', definition: 'TEXT' },
      { table: 'pages', column: 'enabled', definition: 'INTEGER DEFAULT 1' }
    ]);

    const cols = db.prepare(`PRAGMA table_info(pages)`).all().map(c => c.name);
    expect(cols).toContain('niche');
    expect(cols).toContain('enabled');

    // Running again is a no-op (column count stable)
    applyMigrations(db, [
      { table: 'pages', column: 'niche', definition: 'TEXT' }
    ]);
    const cols2 = db.prepare(`PRAGMA table_info(pages)`).all().map(c => c.name);
    expect(cols2.filter(c => c === 'niche').length).toBe(1);

    db.close();
  });

  it('logs and continues if a single migration fails', () => {
    const { db } = openDatabase(dbPath);
    db.exec(`CREATE TABLE pages (id INTEGER PRIMARY KEY)`);

    // First migration targets a table that doesn't exist — ALTER TABLE throws.
    // applyMigrations must catch the error and proceed to the second migration.
    applyMigrations(db, [
      { table: 'no_such_table', column: 'x', definition: 'TEXT' },
      { table: 'pages',         column: 'good_col', definition: 'TEXT' }
    ]);

    const cols = db.prepare(`PRAGMA table_info(pages)`).all().map(c => c.name);
    expect(cols).toContain('good_col');

    // Confirm the bad migration didn't somehow create the table
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(t => t.name);
    expect(tables).not.toContain('no_such_table');

    db.close();
  });
});
