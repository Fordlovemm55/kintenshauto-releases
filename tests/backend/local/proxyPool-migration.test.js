// tests/backend/local/proxyPool-migration.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { openDatabase, loadSchema, applyMigrations } = require('../../../src/backend/local/db');

let tmpDir, dbPath, db;
const SCHEMA = path.join(__dirname, '../../../schema.sql');

// Mirror the migrations the server applies (kept in sync with server.js).
const MIGRATIONS = [
  { table: 'profiles', column: 'proxy_last_ip', definition: 'TEXT' },
  { table: 'profiles', column: 'proxy_last_country', definition: 'TEXT' },
  { table: 'profiles', column: 'proxy_checked_at', definition: 'DATETIME' },
];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-proxypool-mig-'));
  dbPath = path.join(tmpDir, 'test.db');
  ({ db } = openDatabase(dbPath));
  loadSchema(db, SCHEMA);
  applyMigrations(db, MIGRATIONS);
});

afterEach(() => {
  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

it('creates proxy_pool table', () => {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='proxy_pool'`).get();
  expect(row?.name).toBe('proxy_pool');
});

it('adds proxy health columns to profiles', () => {
  const cols = db.prepare(`PRAGMA table_info(profiles)`).all().map(c => c.name);
  expect(cols).toEqual(expect.arrayContaining(['proxy_last_ip', 'proxy_last_country', 'proxy_checked_at']));
});

it('seeds proxy settings', () => {
  const v = db.prepare(`SELECT value FROM settings WHERE key='proxy_default_scheme'`).get();
  expect(v?.value).toBe('http');
});
