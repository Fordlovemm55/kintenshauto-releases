// tests/backend/api/proxies.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import os from 'os';
import fs from 'fs';

let app, tmpDir;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-api-proxies-'));
  process.env.KINTENSHAUTO_USER_DATA = tmpDir;
  process.env.KINTENSHAUTO_DB = path.join(tmpDir, 'test.db');
  process.env.KINTENSHAUTO_SKIP_AUTH = '1';           // dev bypass → routes reachable
  process.env.KINTENSHAUTO_SUPABASE_URL = 'https://test.supabase.co';
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';
  const mod = await import('../../../src/backend/server.js');
  app = mod.app;
});

afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

async function addProfile(name) {
  const res = await request(app).post('/api/profiles')
    .send({ platform: 'facebook', name, fb_username: name + '@e.com', fb_password: 'pw' });
  return res.body.id;
}

describe('POST /api/proxies/parse-preview', () => {
  it('returns parsed count + invalid lines', async () => {
    const res = await request(app).post('/api/proxies/parse-preview')
      .send({ text: '1.2.3.4:8080\nbad-line' });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.invalid).toHaveLength(1);
  });
});

describe('POST /api/proxies/distribute', () => {
  it('assigns proxies to accounts missing one and reports shortage', async () => {
    const id1 = await addProfile('acc1');
    const id2 = await addProfile('acc2');
    const res = await request(app).post('/api/proxies/distribute')
      .send({ text: '11.11.11.11:8080', test: false });   // 1 proxy, 2 accounts
    expect(res.status).toBe(200);
    expect(res.body.assigned).toBe(1);
    expect(res.body.shortBy).toBe(1);
    // the assigned proxy is persisted + pass column stays usable
    const row = await request(app).get('/api/profiles');
    const withProxy = row.body.filter(p => p.proxy_host === '11.11.11.11');
    expect(withProxy).toHaveLength(1);
  });
});
