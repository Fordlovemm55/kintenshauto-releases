import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
const require = createRequire(import.meta.url);

const REPO_ROOT = path.resolve(__dirname, '../../..');
const { ChannelWatcher } = require(path.join(REPO_ROOT, 'src/backend/services/channelWatcher.js'));
const Database = require('better-sqlite3');

// สร้าง watcher บน in-memory DB (constructor รับ Database instance ได้ตรง ๆ)
// pages table ต้องมีก่อน เพราะ watched_channel_pages อ้าง FK ไป pages(id)
function makeWatcher() {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT
    );`);
    const w = new ChannelWatcher(db, { downloadsRoot: path.join(REPO_ROOT, '.test-tmp-downloads') });
    return { w, db };
}

describe('_parseTikTokChannelUrl (pure)', () => {
    let w;
    beforeEach(() => { ({ w } = makeWatcher()); });

    it('keeps a full @handle profile URL as channel root', () => {
        expect(w._parseTikTokChannelUrl('https://www.tiktok.com/@tiktok'))
            .toBe('https://www.tiktok.com/@tiktok');
    });

    it('strips a /video/<id> clip URL down to the channel root', () => {
        expect(w._parseTikTokChannelUrl('https://www.tiktok.com/@user.name/video/7645395404045028639'))
            .toBe('https://www.tiktok.com/@user.name');
    });

    it('strips a /photo/<id> post URL down to the channel root', () => {
        expect(w._parseTikTokChannelUrl('https://www.tiktok.com/@user_name/photo/123'))
            .toBe('https://www.tiktok.com/@user_name');
    });

    it('accepts handles with dots and underscores', () => {
        expect(w._parseTikTokChannelUrl('https://www.tiktok.com/@a.b_c/video/1?lang=th'))
            .toBe('https://www.tiktok.com/@a.b_c');
    });

    it('returns null when there is no @handle (e.g. homepage redirect)', () => {
        expect(w._parseTikTokChannelUrl('https://www.tiktok.com/?_r=1')).toBeNull();
        expect(w._parseTikTokChannelUrl('')).toBeNull();
        expect(w._parseTikTokChannelUrl(null)).toBeNull();
    });
});

describe('TikTok timestamp baseline in _pushItemsToPending + photo filter', () => {
    let w, db;
    beforeEach(() => { ({ w, db } = makeWatcher()); });

    function seedChannel(extra = {}) {
        const info = db.prepare(`
            INSERT INTO watched_channels (label, platform, channel_url, content_type, download_dir)
            VALUES (?, 'tiktok', 'https://www.tiktok.com/@x', 'all', '.')
        `).run(extra.label || 'x');
        return info.lastInsertRowid;
    }

    it('skips TikTok /photo/ posts but keeps /video/ posts', () => {
        const id = seedChannel();
        const ch = { id, platform: 'tiktok', content_type: 'all', min_duration_sec: 0, max_duration_sec: 0 };
        const items = [
            { id: 'v1', url: 'https://www.tiktok.com/@x/video/1', duration: 30, timestamp: 100, title: 'vid' },
            { id: 'p1', url: 'https://www.tiktok.com/@x/photo/2', duration: 0,  timestamp: 101, title: 'photo' },
        ];
        const { added, skipped } = w._pushItemsToPending(ch, items);
        expect(added).toBe(1);
        expect(skipped).toBe(1);
        const rows = db.prepare(`SELECT video_id FROM pending_approvals WHERE watched_id = ?`).all(id);
        expect(rows.map(r => r.video_id)).toEqual(['v1']);
    });

    it('builds sourceUrl from it.uploader (handle), not numeric uploader_id', () => {
        const id = seedChannel();
        const ch = { id, platform: 'tiktok', content_type: 'all', min_duration_sec: 0, max_duration_sec: 0 };
        // ไม่มี webpage_url/url → บังคับให้เข้า fallback branch
        const items = [{ id: '999', uploader: 'realhandle', uploader_id: '107955', duration: 12, timestamp: 5, title: 't' }];
        w._pushItemsToPending(ch, items);
        const row = db.prepare(`SELECT source_url FROM pending_approvals WHERE watched_id = ?`).get(id);
        expect(row.source_url).toBe('https://www.tiktok.com/@realhandle/video/999');
    });
});

describe('_videoFormatSelector — กันลายน้ำ TikTok', () => {
    let w;
    beforeEach(() => { ({ w } = makeWatcher()); });

    const CAP = '[width<=1920][height<=1920]';
    const TIKTOK_SEL = `bv*${CAP}+ba/b${CAP}[format_id!=download]/bv*+ba/b[format_id!=download]`;
    const DEFAULT_SEL = `bv*${CAP}[vcodec^=avc1]+ba[acodec^=mp4a]/bv*${CAP}+ba/b${CAP}/bv*+ba/b`;

    it('TikTok URL → ตัด format_id=download (ตัวมีลายน้ำ) ออก + จำกัดขนาด Full-HD', () => {
        const sel = w._videoFormatSelector('https://www.tiktok.com/@x/video/123');
        expect(sel).toBe(TIKTOK_SEL);
        expect(sel).toContain('format_id!=download');
        expect(sel).toContain('width<=1920');
    });

    it('YouTube URL → จำกัด Full-HD + เลือก H.264/AAC ก่อน + fallback กันพลาด', () => {
        const sel = w._videoFormatSelector('https://www.youtube.com/watch?v=abc');
        expect(sel).toBe(DEFAULT_SEL);
        expect(sel).toContain('width<=1920');
        expect(sel).toContain('vcodec^=avc1');
        expect(sel.endsWith('/bv*+ba/b')).toBe(true);
    });

    it('Facebook/Bilibili/อื่น ๆ → ใช้ selector มาตรฐาน (จำกัด Full-HD)', () => {
        expect(w._videoFormatSelector('https://www.facebook.com/watch/?v=1')).toBe(DEFAULT_SEL);
        expect(w._videoFormatSelector('https://www.bilibili.com/video/BV1')).toBe(DEFAULT_SEL);
        expect(w._videoFormatSelector('https://example.com/x')).toBe(DEFAULT_SEL);
    });
});

describe('module exports still intact (regression)', () => {
    it('SUPPORTED_PLATFORMS includes youtube and tiktok', () => {
        const mod = require(path.join(REPO_ROOT, 'src/backend/services/channelWatcher.js'));
        expect(mod.SUPPORTED_PLATFORMS).toContain('youtube');
        expect(mod.SUPPORTED_PLATFORMS).toContain('tiktok');
    });
});
