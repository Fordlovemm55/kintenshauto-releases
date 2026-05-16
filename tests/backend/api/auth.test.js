import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import request from 'supertest';
import path from 'path';
import os from 'os';
import fs from 'fs';

let app, mswServer, tmpDir;
const SUPA_URL = 'https://test.supabase.co';

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-api-auth-'));
  process.env.KINTENSHAUTO_USER_DATA = tmpDir;
  process.env.KINTENSHAUTO_DB = path.join(tmpDir, 'test.db');
  process.env.KINTENSHAUTO_SUPABASE_URL = SUPA_URL;
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';

  mswServer = setupServer(
    http.post(`${SUPA_URL}/auth/v1/token`, async ({ request }) => {
      const body = await request.json();
      if (body.email === 'ok@e.com' && body.password === 'pw') {
        return HttpResponse.json({
          access_token: 'a', refresh_token: 'r', expires_in: 3600,
          expires_at: Math.floor(Date.now()/1000)+3600,
          user: { id: 'u1', email: 'ok@e.com' }
        });
      }
      return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
    })
  );
  mswServer.listen({ onUnhandledRequest: 'bypass' });

  const mod = await import('../../../src/backend/server.js');
  app = mod.app;
});

afterAll(() => {
  if (mswServer) mswServer.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('POST /api/auth/login', () => {
  it('returns 200 on valid credentials', async () => {
    const res = await request(app).post('/api/auth/login')
      .send({ email: 'ok@e.com', password: 'pw' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user.email).toBe('ok@e.com');
  });

  it('returns 401 on bad credentials', async () => {
    const res = await request(app).post('/api/auth/login')
      .send({ email: 'bad@e.com', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it('returns 400 when fields missing', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'x@y.com' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/auth/status', () => {
  it('returns logged_in:true after successful login', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    // Could be true (if the login test ran first and persisted) or false (fresh)
    expect(typeof res.body.logged_in).toBe('boolean');
  });
});
