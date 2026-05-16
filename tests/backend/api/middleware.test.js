import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import os from 'os';
import fs from 'fs';

let app, tmpDir;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-mw-'));
  process.env.KINTENSHAUTO_USER_DATA = tmpDir;
  process.env.KINTENSHAUTO_DB = path.join(tmpDir, 'test.db');
  delete process.env.KINTENSHAUTO_SUPABASE_URL;
  delete process.env.KINTENSHAUTO_SUPABASE_ANON_KEY;

  // Make sure no session file exists
  const sessionFile = path.join(tmpDir, '.session');
  if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);

  const mod = await import('../../../src/backend/server.js?n=' + Date.now());
  app = mod.app;
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('requireAuth middleware', () => {
  it('allows /api/health without auth', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('allows /api/auth/* without auth', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
  });

  it('blocks /api/profiles with 401 when no session', async () => {
    const res = await request(app).get('/api/profiles');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NO_SESSION');
  });

  it('blocks /api/jobs/recent with 401 when no session', async () => {
    const res = await request(app).get('/api/jobs/recent');
    expect(res.status).toBe(401);
  });
});
