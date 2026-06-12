import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { scanFolder, planAssignments } = require('../../../src/backend/services/localClips');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-localclips-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

describe('scanFolder', () => {
  it('returns only video files, sorted by name (case-insensitive ext)', () => {
    fs.writeFileSync(path.join(tmp, 'b.mp4'), 'x');
    fs.writeFileSync(path.join(tmp, 'a.MOV'), 'x');
    fs.writeFileSync(path.join(tmp, 'note.txt'), 'x');
    const { files } = scanFolder(tmp);
    expect(files.map(f => f.name)).toEqual(['a.MOV', 'b.mp4']);
    expect(files[0].path).toBe(path.join(tmp, 'a.MOV'));
  });
  it('returns an error and no files for a missing folder', () => {
    const r = scanFolder(path.join(tmp, 'does-not-exist'));
    expect(r.files).toEqual([]);
    expect(r.error).toBeTruthy();
  });
});

describe('planAssignments', () => {
  const files = [{ name: '1' }, { name: '2' }, { name: '3' }];

  it('round-robins clips across pages in distribute mode', () => {
    const a = planAssignments(files, [10, 20], 'distribute');
    expect(a.map(x => x.pageId)).toEqual([10, 20, 10]);
    expect(a.map(x => x.file.name)).toEqual(['1', '2', '3']);
  });

  it('posts every clip to every page in all mode', () => {
    const a = planAssignments([{ name: '1' }, { name: '2' }], [10, 20], 'all');
    expect(a).toHaveLength(4);
    expect(a.map(x => x.pageId)).toEqual([10, 20, 10, 20]);
  });

  it('returns [] when files or pages are empty', () => {
    expect(planAssignments([], [1], 'distribute')).toEqual([]);
    expect(planAssignments(files, [], 'distribute')).toEqual([]);
  });
});
