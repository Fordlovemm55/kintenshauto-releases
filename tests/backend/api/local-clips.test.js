import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';

let app, tmpDir, clipsDir, dbPath, pageId;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-api-localclips-'));
  dbPath = path.join(tmpDir, 'test.db');
  process.env.KINTENSHAUTO_USER_DATA = tmpDir;
  process.env.KINTENSHAUTO_DB = dbPath;
  process.env.KINTENSHAUTO_SKIP_AUTH = '1';
  process.env.KINTENSHAUTO_SUPABASE_URL = 'https://test.supabase.co';
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';
  const mod = await import('../../../src/backend/server.js');
  app = mod.app;

  clipsDir = path.join(tmpDir, 'myvideos');   // not 'clips' — server.js owns userData/clips
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.writeFileSync(path.join(clipsDir, 'a.mp4'), 'x');
  fs.writeFileSync(path.join(clipsDir, 'b.mp4'), 'x');
  fs.writeFileSync(path.join(clipsDir, 'note.txt'), 'x');

  const pr = await request(app).post('/api/profiles')
    .send({ platform: 'facebook', name: 'acc', fb_username: 'a@e.com', fb_password: 'pw' });
  const pg = await request(app).post('/api/pages')
    .send({ profile_id: pr.body.id, fb_page_id: '123456', name: 'Page A' });
  pageId = pg.body.id;
});

afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

describe('POST /api/local-clips/scan', () => {
  it('counts only the video files in the folder', async () => {
    const res = await request(app).post('/api/local-clips/scan').send({ folder: clipsDir });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});

describe('POST /api/local-clips/import', () => {
  it('creates one pending job per clip with a non-null caption + future schedule', async () => {
    const res = await request(app).post('/api/local-clips/import')
      .send({ folder: clipsDir, page_ids: [pageId], mode: 'distribute' });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(2);
    expect(res.body.perPage[String(pageId)]).toBe(2);

    const db = new Database(dbPath, { readonly: true });
    const jobs = db.prepare(`
      SELECT j.status, j.scheduled_at, c.caption, c.set1_path, c.assigned_page_id
      FROM jobs j JOIN clips c ON c.id = j.clip_id
      WHERE j.page_id = ?
    `).all(pageId);
    db.close();

    expect(jobs).toHaveLength(2);
    expect(jobs.every(r => r.status === 'pending')).toBe(true);
    expect(jobs.every(r => r.caption && String(r.caption).length > 0)).toBe(true);
    expect(jobs.every(r => String(r.set1_path).endsWith('.mp4'))).toBe(true);
    expect(jobs.every(r => r.assigned_page_id === pageId)).toBe(true);
  });
});
