import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { CommentTemplateEngine } = require('../../../src/backend/services/commentTemplateEngine');

let tmpDir, dbPath, db, engine;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-engine-test-'));
  dbPath = path.join(tmpDir, 'test.db');
  db = new Database(dbPath);
  // Minimal schema for the engine
  db.exec(`
    CREATE TABLE comment_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER,
      label TEXT,
      content TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      weight INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.close();   // close the test db handle; engine opens its own
  engine = new CommentTemplateEngine(dbPath);
});

afterEach(() => {
  if (engine?.db) { try { engine.db.close(); } catch {} }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('CommentTemplateEngine.render', () => {
  it('substitutes {page_name} variable', () => {
    const out = engine.render('สวัสดี {page_name}', { page_name: 'Page A' });
    expect(out).toBe('สวัสดี Page A');
  });

  it('handles {random:a|b|c} syntax — picks one option', () => {
    const out = engine.render('{random:hi|hello|hey}');
    expect(['hi', 'hello', 'hey']).toContain(out);
  });

  it('replaces unknown variables with empty string', () => {
    const out = engine.render('hello {nonexistent}');
    expect(out).toBe('hello');
  });

  it('substitutes all 8 supported variables', () => {
    const out = engine.render(
      '{page_name} {clip_number}/{total_clips} {hashtag} {caption} {video_title}',
      {
        page_name: 'P',
        clip_number: 2,
        total_clips: 5,
        hashtag: '#x',
        caption: 'cap',
        video_title: 'V'
      }
    );
    expect(out).toBe('P 2/5 #x cap V');
  });
});

describe('CommentTemplateEngine.validateTemplate', () => {
  it('rejects empty content', () => {
    expect(engine.validateTemplate('')).toContain('Content cannot be empty');
    expect(engine.validateTemplate('   ')).toContain('Content cannot be empty');
  });

  it('rejects content > 8000 chars', () => {
    const long = 'x'.repeat(8001);
    expect(engine.validateTemplate(long)).toContain('Content too long (max 8000 chars)');
  });

  it('rejects unknown variables', () => {
    const errors = engine.validateTemplate('hi {bogus_var}');
    expect(errors.some(e => e.includes('Unknown variable'))).toBe(true);
  });

  it('accepts valid template with known variables', () => {
    const errors = engine.validateTemplate('สวัสดี {page_name} {random:a|b}');
    expect(errors).toEqual([]);
  });
});

describe('CommentTemplateEngine.pickRandom', () => {
  it('returns null when no templates exist', () => {
    expect(engine.pickRandom(1)).toBeNull();
  });

  it('picks one of N enabled templates', () => {
    engine.addTemplate(1, 'A', 'hello A');
    engine.addTemplate(1, 'B', 'hello B');
    const picked = engine.pickRandom(1);
    expect(['hello A', 'hello B']).toContain(picked.content);
  });

  it('respects weight (higher weight = more likely)', () => {
    engine.addTemplate(1, 'low', 'low', 1);
    engine.addTemplate(1, 'high', 'high', 100);
    const counts = { low: 0, high: 0 };
    for (let i = 0; i < 200; i++) {
      const p = engine.pickRandom(1);
      counts[p.label]++;
    }
    expect(counts.high).toBeGreaterThan(counts.low * 5);
  });
});

describe('CommentTemplateEngine.preview', () => {
  it('returns { ok: false, errors } for invalid template', () => {
    const r = engine.preview('');
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('Content cannot be empty');
  });

  it('returns { ok: true, rendered } for valid template', () => {
    const r = engine.preview('hello {page_name}');
    expect(r.ok).toBe(true);
    expect(r.rendered).toContain('hello ');
  });
});
