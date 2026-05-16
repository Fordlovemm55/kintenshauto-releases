import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';

let server, tmpDir, db;
const SUPA_URL = 'https://test.supabase.co';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-audit-'));
  process.env.KINTENSHAUTO_USER_DATA = tmpDir;
  process.env.KINTENSHAUTO_SUPABASE_URL = SUPA_URL;
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';

  db = new Database(path.join(tmpDir, 'test.db'));
  db.exec(`
    CREATE TABLE audit_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      detail_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      flushed_at DATETIME
    );
  `);
});

afterEach(() => {
  if (db) db.close();
  if (server) server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env.KINTENSHAUTO_SUPABASE_URL;
  delete process.env.KINTENSHAUTO_SUPABASE_ANON_KEY;
});

describe('audit.logEvent', () => {
  it('inserts an event into audit_queue immediately', async () => {
    const { logEvent } = await import('../../../src/backend/cloud/audit.js?n=' + Date.now());
    logEvent(db, 'login_success', { user_id: 'u1' });
    const rows = db.prepare(`SELECT * FROM audit_queue`).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('login_success');
    expect(JSON.parse(rows[0].detail_json).user_id).toBe('u1');
  });

  it('throws when event is missing or invalid', async () => {
    const { logEvent } = await import('../../../src/backend/cloud/audit.js?n=' + Date.now());
    expect(() => logEvent(db, '', {})).toThrow();
    expect(() => logEvent(db, null, {})).toThrow();
  });

  it('handles empty detail (no extra info)', async () => {
    const { logEvent } = await import('../../../src/backend/cloud/audit.js?n=' + Date.now());
    logEvent(db, 'simple_event');
    const row = db.prepare(`SELECT * FROM audit_queue`).get();
    expect(row.event).toBe('simple_event');
    expect(row.detail_json).toBe('{}');
  });
});

describe('audit.flushAudit', () => {
  it('pushes unflushed events to Supabase and marks them flushed', async () => {
    server = setupServer(
      http.post(`${SUPA_URL}/rest/v1/audit_log`, () => HttpResponse.json([{}], { status: 201 }))
    );
    server.listen({ onUnhandledRequest: 'error' });

    const { logEvent, flushAudit } = await import('../../../src/backend/cloud/audit.js?n=' + Date.now());
    logEvent(db, 'sync_push', { count: 5 });
    logEvent(db, 'sync_pull', { count: 3 });
    const result = await flushAudit(db, 'access-token-stub');
    expect(result.flushed).toBe(2);

    const unflushed = db.prepare(`SELECT COUNT(*) AS n FROM audit_queue WHERE flushed_at IS NULL`).get();
    expect(unflushed.n).toBe(0);
  });

  it('leaves rows unflushed on network failure', async () => {
    server = setupServer(
      http.post(`${SUPA_URL}/rest/v1/audit_log`, () => HttpResponse.error())
    );
    server.listen({ onUnhandledRequest: 'error' });

    const { logEvent, flushAudit } = await import('../../../src/backend/cloud/audit.js?n=' + Date.now());
    logEvent(db, 'login_success', {});
    const result = await flushAudit(db, 'access-token-stub');
    expect(result.flushed).toBe(0);
    expect(result.failed).toBeGreaterThan(0);

    const unflushed = db.prepare(`SELECT COUNT(*) AS n FROM audit_queue WHERE flushed_at IS NULL`).get();
    expect(unflushed.n).toBe(1);
  });

  it('returns flushed:0 when no token provided', async () => {
    const { logEvent, flushAudit } = await import('../../../src/backend/cloud/audit.js?n=' + Date.now());
    logEvent(db, 'event_a', {});
    const result = await flushAudit(db, null);
    expect(result.flushed).toBe(0);
    expect(result.reason).toBe('no_token');
  });
});
