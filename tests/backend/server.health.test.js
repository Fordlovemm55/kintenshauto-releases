import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// server.js reads KINTENSHAUTO_DB and KINTENSHAUTO_USER_DATA from env.
// Set up an isolated tmpdir before requiring it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kintenshauto-test-'));
process.env.KINTENSHAUTO_USER_DATA = tmpDir;
process.env.KINTENSHAUTO_DB = path.join(tmpDir, 'test.db');
process.env.PORT = '0'; // let OS pick free port; supertest hits the app object directly

let app, server;

beforeAll(async () => {
  // Import after env is set so server.js picks them up
  const mod = await import('../../src/backend/server.js');
  app = mod.app || mod.default?.app;
  server = mod.server || mod.default?.server;
});

afterAll(async () => {
  if (server && server.close) {
    await new Promise(resolve => server.close(resolve));
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('GET /api/health', () => {
  it('returns 200 with ok:true', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const pkg = require('../../package.json');
    expect(res.body.version).toBe(pkg.version);
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reports db state', async () => {
    const res = await request(app).get('/api/health');
    // db state could be 'fresh' or 'existing' depending on whether server.js
    // ran any startup migrations; just verify the field is present and is one of
    // the two valid values.
    expect(['fresh', 'existing']).toContain(res.body.db);
  });
});
