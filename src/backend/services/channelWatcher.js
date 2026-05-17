/**
 * Channel Watcher - บอทคอยเช็คคลิปใหม่จากช่องที่ผู้ใช้ใส่ลิงก์ไว้
 *
 * Flow:
 * 1. user เพิ่มช่อง (URL + เพจปลายทาง[หลายเพจได้] + ประเภทคลิป + interval ชม.)
 *    → baseline: ดึง video id ล่าสุดเก็บเป็น last_seen (ไม่ดูด history เก่า)
 *    → สร้างโฟลเดอร์เฉพาะช่องนี้: downloads/channels/<id>_<label>/
 * 2. cron tick ทุก 5 นาที → หา channel ที่ next_check_at <= now
 * 3. รัน yt-dlp --flat-playlist ดึง metadata เท่านั้น (เร็ว, ไม่โหลดวิดีโอ)
 * 4. กรองตาม content_type + duration
 * 5. อันใหม่ที่ไม่เคยเห็น → insert pending_approvals → emit socket
 * 6. user กด "อนุมัติ" →
 *    (a) ดาวน์โหลดคลิปเต็มลงโฟลเดอร์เฉพาะช่อง  (per-channel folder = "ไม่มั่ว")
 *    (b) INSERT scouted_videos พร้อม file_path
 *    (c) ส่งต่อ orchestrator.enqueue() ต่อเพจ → pipeline เดิม slice/banner/caption/schedule
 *        (orchestrator dedup ด้วย url_hash → ไม่ download ซ้ำ)
 *
 * กันมั่ว:
 *  - source_url UNIQUE (insert ซ้ำไม่ได้)
 *  - URL ตามประเภท (/shorts หรือ /videos) ไม่ดึงข้ามประเภท
 *  - duration filter ก่อนเพิ่มเข้า pending
 *  - per-channel download folder: ไฟล์ raw ของช่อง A อยู่โฟลเดอร์ A เสมอ
 *  - clip → job ผูกกันแน่นใน DB (1 clip = 1 page_id) — ไม่มีทางสลับเพจ
 *  - error_count backoff: fail 5 ครั้ง → disable ช่อง
 *  - approveAll: จำกัด concurrency กัน yt-dlp / orchestrator burst
 *  - zombie reaper: 'downloading' เกิน 45 นาที = stuck → reset เป็น 'failed'
 *  - ใช้ peakSchedule.toSqlLocal() เพื่อให้ next_check_at เป็น local time
 *    (ตรงกับที่ pipeline เดิมใช้ทุก scheduled_at column)
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const Database = require('better-sqlite3');
const cron = require('node-cron');

// peakSchedule.toSqlLocal — ทุก datetime column ของระบบเดิมใช้ local time
// (ดู worker.js stale-pending sweep, orchestrator schedule, etc.)
let toSqlLocal;
try {
    ({ toSqlLocal } = require('../core/peakSchedule'));
} catch {
    toSqlLocal = (date) => {
        const pad = n => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
               `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };
}

// ✅ FIX: ใช้ hashUrl + ffprobeDuration เดียวกับ orchestrator
let orchHashUrl, orchCanonicalUrl, orchFfprobeDuration;
try {
    ({ hashUrl: orchHashUrl, canonicalUrl: orchCanonicalUrl,
       ffprobeDuration: orchFfprobeDuration } = require('../core/orchestrator'));
} catch {
    const cryptoMod = require('crypto');
    orchCanonicalUrl = (url) => {
        try { const u = new URL(url); return u.origin + u.pathname; } catch { return String(url || ''); }
    };
    orchHashUrl = (url) => cryptoMod.createHash('sha1').update(url).digest('hex').slice(0, 16);
    orchFfprobeDuration = async () => 0;
}

const MAX_ERRORS_BEFORE_DISABLE = 5;
const BASELINE_FETCH_COUNT = 5;       // ตอน add ช่องใหม่ ดึงแค่ล่าสุด N รายการ มาเก็บ baseline
const CHECK_FETCH_COUNT = 15;         // ตอนเช็คปกติ ดึง N ล่าสุด เทียบกับ baseline
const CHECK_TICK_MINUTES = 5;         // cron ตื่นทุกๆ N นาที
const JITTER_BETWEEN_CHANNELS_MS = [3000, 8000];  // หน่วงระหว่างเช็คแต่ละช่อง
const YTDLP_TIMEOUT_MS = 60_000;      // metadata fetch ต้องเสร็จใน 60s
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;  // ดาวน์โหลดเต็ม 30 นาที
const MAX_CONCURRENT_DOWNLOADS = 2;   // approveAll: จำกัด yt-dlp ขนานกัน
const ZOMBIE_REAPER_THRESHOLD_MS = 45 * 60_000;  // 'downloading' เกิน 45 นาที = stuck

const SUPPORTED_PLATFORMS = ['youtube', 'bilibili', 'tiktok', 'facebook', 'other'];
const SUPPORTED_CONTENT_TYPES = ['all', 'shorts', 'reels', 'longform', 'live'];

class ChannelWatcher extends EventEmitter {
    /**
     * @param {string|Database} dbPath
     * @param {object} opts
     * @param {string} opts.ytDlpPath
     * @param {string} opts.downloadsRoot
     * @param {object} [opts.orchestrator] - ถ้าส่งมา: หลัง download เสร็จจะเรียก orchestrator.enqueue
     *                                       (recommended — pipeline จัดการ slice/banner/caption ให้)
     *                                       ถ้าไม่ส่ง: fall back สร้าง clip + jobs เอง (legacy/testing)
     */
    constructor(dbPath, opts = {}) {
        super();
        this.db = dbPath instanceof Database ? dbPath : new Database(dbPath);
        // ✅ FK pragma ที่ connection นี้ (default ปิดอยู่ → ON DELETE CASCADE จะไม่ทำงาน)
        this.db.pragma('foreign_keys = ON');

        this.ytDlpPath = opts.ytDlpPath || 'yt-dlp';
        this.downloadsRoot = opts.downloadsRoot || path.join(process.cwd(), 'downloads');
        this.channelsDir = path.join(this.downloadsRoot, 'channels');
        this.orchestrator = opts.orchestrator || null;
        this.autoPrepare = opts.autoPrepare !== false;  // legacy: เปิด only when no orchestrator

        if (!fs.existsSync(this.channelsDir)) fs.mkdirSync(this.channelsDir, { recursive: true });

        this._cronTask = null;
        this._busy = false;
        this._activeDownloads = 0;     // concurrency limit สำหรับ approveAll
        this._downloadQueue = [];      // pending approvals waiting for slot
        this._channelChecks = new Map();   // ✅ H4: per-channel mutex (id → Promise)
        this._ensureSchema();
    }

    _ensureSchema() {
        // safety net สำหรับ DB เก่าที่ยังไม่มีตาราง watched_channels / pending_approvals
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS watched_channels (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                label               TEXT NOT NULL,
                platform            TEXT NOT NULL,
                channel_url         TEXT NOT NULL,
                content_type        TEXT NOT NULL DEFAULT 'all',
                interval_hours      REAL NOT NULL DEFAULT 5,
                min_duration_sec    INTEGER DEFAULT 0,
                max_duration_sec    INTEGER DEFAULT 0,
                download_dir        TEXT NOT NULL,
                last_checked_at     DATETIME,
                last_seen_video_id  TEXT,
                next_check_at       DATETIME,
                enabled             INTEGER DEFAULT 1,
                error_count         INTEGER DEFAULT 0,
                last_error          TEXT,
                created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS watched_channel_pages (
                watched_id      INTEGER NOT NULL,
                page_id         INTEGER NOT NULL,
                created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (watched_id, page_id),
                FOREIGN KEY (watched_id) REFERENCES watched_channels(id) ON DELETE CASCADE,
                FOREIGN KEY (page_id)    REFERENCES pages(id)            ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS pending_approvals (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                watched_id      INTEGER NOT NULL,
                video_id        TEXT NOT NULL,
                source_url      TEXT NOT NULL UNIQUE,
                title           TEXT,
                duration_sec    INTEGER,
                thumbnail_url   TEXT,
                upload_date     TEXT,
                detected_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
                status          TEXT DEFAULT 'pending',
                scouted_id      INTEGER,
                FOREIGN KEY (watched_id) REFERENCES watched_channels(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_watched_next_check ON watched_channels(next_check_at);
            CREATE INDEX IF NOT EXISTS idx_watched_enabled ON watched_channels(enabled);
            CREATE INDEX IF NOT EXISTS idx_approvals_status ON pending_approvals(status);
            CREATE INDEX IF NOT EXISTS idx_approvals_watched ON pending_approvals(watched_id);
            CREATE INDEX IF NOT EXISTS idx_wcp_page ON watched_channel_pages(page_id);
        `);

        // migrations: เช็คก่อน ALTER + try/catch แต่ละตัว (เผื่อ DB legacy weirdness)
        // ✅ ห่อ try/catch เพื่อไม่ให้ migration failure ทำให้ constructor crash → ระบบใช้ไม่ได้
        try {
            const cols = this.db.prepare(`PRAGMA table_info(pending_approvals)`).all().map(c => c.name);
            const addColIfMissing = (name, def) => {
                if (cols.includes(name)) return;
                try { this.db.exec(`ALTER TABLE pending_approvals ADD COLUMN ${name} ${def}`); }
                catch (e) { console.warn(`[ChannelWatcher] migration add ${name} skipped:`, e.message); }
            };
            addColIfMissing('download_progress', 'INTEGER DEFAULT 0');
            addColIfMissing('download_error', 'TEXT');
            addColIfMissing('orchestrator_run_id', 'TEXT');
        } catch (e) {
            console.warn('[ChannelWatcher] migration scan failed:', e.message);
        }

        // ✅ CRITICAL MIGRATION: เปลี่ยน UNIQUE จาก source_url (global) → (watched_id, video_id) composite
        // เดิม: ถ้า user เพิ่มช่องเดียวกันใน label ต่างกัน → source_url ซ้ำ → INSERT OR IGNORE skip ทั้งหมด
        //       → "เพิ่ม 0 คลิป" ทั้งที่ดึงคลิปได้ปกติ (total_fetched > 0)
        // ใหม่: composite UNIQUE (watched_id, video_id) → channel แยกกันได้, video_id ไม่ซ้ำในช่องเดียว
        try {
            const tableSql = this.db.prepare(
                `SELECT sql FROM sqlite_master WHERE type='table' AND name='pending_approvals'`
            ).get();
            const hasOldUnique = tableSql?.sql?.includes('source_url') &&
                                 /source_url\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(tableSql.sql);
            if (hasOldUnique) {
                console.log('[ChannelWatcher] migrating pending_approvals UNIQUE constraint → (watched_id, video_id)');
                this.db.exec(`
                    BEGIN;
                    CREATE TABLE pending_approvals_new (
                        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                        watched_id          INTEGER NOT NULL,
                        video_id            TEXT NOT NULL,
                        source_url          TEXT NOT NULL,
                        title               TEXT,
                        duration_sec        INTEGER,
                        thumbnail_url       TEXT,
                        upload_date         TEXT,
                        detected_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
                        status              TEXT DEFAULT 'pending',
                        scouted_id          INTEGER,
                        download_progress   INTEGER DEFAULT 0,
                        download_error      TEXT,
                        orchestrator_run_id TEXT,
                        UNIQUE(watched_id, video_id),
                        FOREIGN KEY (watched_id) REFERENCES watched_channels(id) ON DELETE CASCADE
                    );
                    INSERT OR IGNORE INTO pending_approvals_new
                        (id, watched_id, video_id, source_url, title, duration_sec,
                         thumbnail_url, upload_date, detected_at, status, scouted_id,
                         download_progress, download_error, orchestrator_run_id)
                    SELECT id, watched_id, video_id, source_url, title, duration_sec,
                           thumbnail_url, upload_date, detected_at, status, scouted_id,
                           download_progress, download_error, orchestrator_run_id
                    FROM pending_approvals;
                    DROP TABLE pending_approvals;
                    ALTER TABLE pending_approvals_new RENAME TO pending_approvals;
                    CREATE INDEX IF NOT EXISTS idx_approvals_status ON pending_approvals(status);
                    CREATE INDEX IF NOT EXISTS idx_approvals_watched ON pending_approvals(watched_id);
                    COMMIT;
                `);
                console.log('[ChannelWatcher] ✓ migrated pending_approvals UNIQUE constraint');
            }
        } catch (e) {
            console.warn('[ChannelWatcher] UNIQUE migration failed:', e.message);
            try { this.db.exec('ROLLBACK'); } catch {}
        }

        // ✅ MIGRATION: re-sanitize download_dir paths สำหรับ channels ที่ใช้ Thai/Unicode
        // (เก่า: 3_ทดลอง — Node spawn บน Windows ส่ง yt-dlp args เพี้ยน → ดาวน์โหลดผิด folder)
        try {
            const channels = this.db.prepare(
                `SELECT id, label, download_dir FROM watched_channels WHERE download_dir IS NOT NULL`
            ).all();
            for (const ch of channels) {
                const expected = this._channelFolder(ch.id, ch.label);
                if (ch.download_dir === expected) continue;
                // Rename old folder → new ASCII-only folder (best effort)
                try {
                    if (fs.existsSync(ch.download_dir) && !fs.existsSync(expected)) {
                        fs.renameSync(ch.download_dir, expected);
                        console.log(`[ChannelWatcher] migrated folder: ${ch.download_dir} → ${expected}`);
                    } else if (!fs.existsSync(expected)) {
                        fs.mkdirSync(expected, { recursive: true });
                    }
                } catch (renameErr) {
                    console.warn(`[ChannelWatcher] folder rename failed for ch#${ch.id}:`, renameErr.message);
                }
                this.db.prepare(`UPDATE watched_channels SET download_dir = ? WHERE id = ?`)
                    .run(expected, ch.id);
            }
        } catch (e) {
            console.warn('[ChannelWatcher] download_dir migration failed:', e.message);
        }
    }

    /**
     * คืน list ของ page_id ที่ผูกกับช่องนี้
     */
    _getChannelPageIds(watchedId) {
        return this.db.prepare(
            `SELECT page_id FROM watched_channel_pages WHERE watched_id = ? ORDER BY page_id`
        ).all(watchedId).map(r => r.page_id);
    }

    /**
     * คืน list ของ {id, name} ของเพจที่ผูกกับช่องนี้
     */
    _getChannelPages(watchedId) {
        return this.db.prepare(`
            SELECT p.id, p.name
            FROM watched_channel_pages wcp
            JOIN pages p ON p.id = wcp.page_id
            WHERE wcp.watched_id = ?
            ORDER BY p.name
        `).all(watchedId);
    }

    /**
     * แทนที่ mapping ทั้งหมดของช่อง → set ใหม่จาก pageIds (atomic)
     */
    _setChannelPages(watchedId, pageIds) {
        const ids = Array.from(new Set((pageIds || []).map(Number).filter(Boolean)));
        if (ids.length === 0) throw new Error('ต้องเลือกเพจอย่างน้อย 1 เพจ');

        // ตรวจว่าทุก page id มีอยู่จริง
        const placeholders = ids.map(() => '?').join(',');
        const found = this.db.prepare(
            `SELECT id FROM pages WHERE id IN (${placeholders})`
        ).all(...ids).map(r => r.id);
        const missing = ids.filter(i => !found.includes(i));
        if (missing.length > 0) throw new Error(`ไม่พบเพจ id: ${missing.join(', ')}`);

        const tx = this.db.transaction((wid, pids) => {
            this.db.prepare(`DELETE FROM watched_channel_pages WHERE watched_id = ?`).run(wid);
            const ins = this.db.prepare(
                `INSERT INTO watched_channel_pages (watched_id, page_id) VALUES (?, ?)`
            );
            for (const pid of pids) ins.run(wid, pid);
        });
        tx(watchedId, ids);
    }

    // ---------------- Helpers ----------------

    _sanitizeLabel(s) {
        // ASCII-only — Node spawn บน Windows ส่ง args ที่ไม่ใช่ ANSI page เพี้ยน
        // → yt-dlp ดาวน์โหลดไป folder ผิด (เช่น 3_ทดลอง → 3_) → "ไฟล์ดาวน์โหลดไม่เจอ"
        // เลยเก็บเฉพาะ a-z, A-Z, 0-9, _, - (drop Thai/Unicode) → folder name = "ch" ถ้าไม่เหลือ
        const cleaned = (s || 'ch')
            .replace(/[^\w-]/g, '_')      // ลบ non-ASCII (รวม Thai) → "_"
            .replace(/_+/g, '_')           // collapse runs of "_"
            .replace(/^_+|_+$/g, '')       // trim leading/trailing "_"
            .slice(0, 40);
        return cleaned || 'ch';
    }

    _channelFolder(id, label) {
        return path.join(this.channelsDir, `${id}_${this._sanitizeLabel(label)}`);
    }

    _detectPlatform(url) {
        const u = (url || '').toLowerCase();
        if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
        if (u.includes('bilibili.com')) return 'bilibili';
        if (u.includes('tiktok.com')) return 'tiktok';
        if (u.includes('facebook.com') || u.includes('fb.com') || u.includes('fb.watch')) return 'facebook';
        return 'other';
    }

    /**
     * Decode URL-encoded characters (e.g., %E0%B8%XX) → Thai chars จริง
     * เพราะ user paste URL จาก browser address bar (browser encode Thai chars อัตโนมัติ)
     * แต่ yt-dlp ไม่รับ encoded path สำหรับ @-handle → 404
     * Node spawn ส่ง Thai chars ตรง ๆ ผ่าน UTF-8 ได้ปกติ (ทดสอบแล้ว)
     */
    _decodeUrl(url) {
        if (!url) return url;
        try {
            const decoded = decodeURI(url);
            // เช็คว่ามี Thai/Unicode chars หลัง decode → ถ้ามี ใช้ decoded version
            // (ถ้าไม่มี = ASCII URL ปกติ — return as-is, กันการ decode reserved chars)
            if (decoded !== url) return decoded;
        } catch { /* malformed URI — ใช้ original */ }
        return url;
    }

    /**
     * เปลี่ยน URL ให้ตรงประเภทที่ user เลือก (เช่น YouTube /shorts vs /videos)
     * - ตัด trailing /videos /shorts /streams /live ออกก่อน แล้วค่อยต่อใหม่
     */
    _buildScopedUrl(channelUrl, platform, contentType) {
        if (!channelUrl) return channelUrl;
        // ✅ Decode URL-encoded Thai chars first (กัน yt-dlp 404 กับ %E0%B8%XX paths)
        channelUrl = this._decodeUrl(channelUrl);
        let base = channelUrl.replace(/\/$/, '');

        if (platform === 'youtube') {
            // ตัดหาง path ที่เป็นประเภทออกก่อน (กันต่อซ้อน)
            base = base.replace(/\/(videos|shorts|streams|live|featured)$/i, '');
            switch (contentType) {
                case 'shorts':   return base + '/shorts';
                case 'live':     return base + '/streams';
                case 'longform': return base + '/videos';
                case 'reels':    return base + '/shorts';   // YouTube ไม่มี Reels — ใช้ Shorts
                case 'all':
                default:         return base + '/videos';
            }
        }

        if (platform === 'facebook') {
            base = base.replace(/\/(reels|videos|live)$/i, '');
            if (contentType === 'reels') return base + '/reels';
            if (contentType === 'live')  return base + '/live';
            return base + '/videos';
        }

        // tiktok / bilibili / other → ส่งตามที่ user ใส่
        return channelUrl;
    }

    _isVideoMatch(meta, contentType, minDur, maxDur) {
        const dur = Number(meta.duration || 0);

        // กรอง live เฉพาะที่มี signal ชัดเจน — เดิม `duration===null` treat as live ทำให้
        // ทุกคลิป YouTube Shorts (ที่ flat-playlist ไม่ส่ง duration) ถูก filter ออก
        const isLiveLike =
            meta.is_live === true ||
            meta.live_status === 'is_live' ||
            meta.live_status === 'is_upcoming';
        if (isLiveLike && contentType !== 'live') return false;

        // กรองตามประเภทแบบ defensive (เผื่อ yt-dlp คืนคลิปข้ามประเภทมาด้วย)
        if (contentType === 'shorts' || contentType === 'reels') {
            // shorts/reels ปกติ <= 60s บางที 90s
            if (dur && dur > 90) return false;
        }
        if (contentType === 'longform') {
            if (dur && dur < 60) return false;
        }

        // กรองความยาวที่ user ตั้ง
        if (minDur > 0 && dur > 0 && dur < minDur) return false;
        if (maxDur > 0 && dur > 0 && dur > maxDur) return false;

        return true;
    }

    _scheduleNext(intervalHours) {
        // ⚠️ CRITICAL: ทุก scheduled_at ในระบบใช้ local time (worker.js stale-pending sweep
        // อาศัย datetime('now','localtime') เปรียบเทียบ). ใช้ UTC จะทำให้ค่า "ห่าง 7 ชม."
        // ใน TZ ไทย → ทุกครั้งที่เช็คจะเข้าเงื่อนไข "stale" → reschedule ผิดเสมอ
        const ms = Math.max(0.1, Number(intervalHours) || 5) * 3600 * 1000;
        return toSqlLocal(new Date(Date.now() + ms));
    }

    _nowSqlLocal() {
        return toSqlLocal(new Date());
    }

    _sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // ---------------- yt-dlp invocation ----------------

    /**
     * เรียก yt-dlp ดึง metadata รายการคลิป (ไม่ดาวน์โหลดวิดีโอ)
     * @param {number} count - 0/null = ดึงทั้งหมด (no playlist-items limit), >0 = top N
     * @returns {Promise<Array>} array ของ metadata object
     */
    _fetchChannelVideos(channelUrl, count) {
        // YouTube channels with no /videos tab (Shorts-only, Live-only, or
        // music auto-generated channels) cause yt-dlp to return:
        //   "ERROR: [youtube:tab] <handle>: This channel does not have a videos tab"
        // Auto-retry with /shorts → /streams → root URL so the user doesn't
        // have to know in advance which tab the channel uses.
        const isYouTube = /(?:^|\/\/)(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(channelUrl);
        if (!isYouTube) return this._fetchChannelVideosOnce(channelUrl, count);

        const m = channelUrl.match(/^(.+?)\/(videos|shorts|streams|live|featured)(\/?$)/i);
        const fallbacks = [];
        if (m) {
            const base = m[1];
            const tried = m[2].toLowerCase();
            // Original first, then the other tabs the channel might actually have
            fallbacks.push(channelUrl);
            for (const tab of ['shorts', 'videos', 'streams', '']) {
                if (tab === tried) continue;
                fallbacks.push(tab ? `${base}/${tab}` : base);
            }
        } else {
            // No tab suffix — try /shorts and /videos as common fallbacks
            const base = channelUrl.replace(/\/+$/, '');
            fallbacks.push(channelUrl, `${base}/shorts`, `${base}/videos`);
        }

        return (async () => {
            let lastErr;
            for (const url of fallbacks) {
                try {
                    const items = await this._fetchChannelVideosOnce(url, count);
                    if (items.length > 0) {
                        if (url !== channelUrl) {
                            console.log(`[ChannelWatcher] _fetchChannelVideos: fell back from "${channelUrl}" to "${url}" (${items.length} items)`);
                        }
                        return items;
                    }
                    lastErr = new Error(`empty playlist from ${url}`);
                } catch (e) {
                    lastErr = e;
                    // Only keep trying on the specific "no videos tab" / 404 errors;
                    // a real failure (network, timeout) should not waste time on retries.
                    const isTabError = /does not have a (videos|shorts|streams) tab/i.test(e.message)
                        || /Unable to download API page/i.test(e.message)
                        || /404/i.test(e.message);
                    if (!isTabError) throw e;
                }
            }
            throw lastErr || new Error('yt-dlp: no tab variant succeeded');
        })();
    }

    _fetchChannelVideosOnce(channelUrl, count) {
        const noLimit = !count || count <= 0;
        return new Promise((resolve, reject) => {
            const args = [
                '--flat-playlist',
                '--dump-json',
                '--no-warnings',
                '--ignore-errors',
            ];
            if (!noLimit) args.push('--playlist-items', `1:${count}`);
            args.push(channelUrl);

            const proc = spawn(this.ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            // ดึงทั้งหมดอาจใช้เวลานาน (ช่องใหญ่ 100+ คลิป) → ขยาย timeout เป็น 5 นาที
            const timeoutMs = noLimit ? 5 * 60_000 : YTDLP_TIMEOUT_MS;
            const timer = setTimeout(() => {
                proc.kill('SIGKILL');
                reject(new Error(`yt-dlp timeout ${timeoutMs}ms`));
            }, timeoutMs);

            proc.stdout.on('data', d => { stdout += d.toString(); });
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('error', err => { clearTimeout(timer); reject(err); });
            proc.on('close', code => {
                clearTimeout(timer);
                if (code !== 0 && !stdout.trim()) {
                    return reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(0, 300)}`));
                }
                const lines = stdout.split('\n').filter(l => l.trim());
                const items = [];
                for (const line of lines) {
                    try { items.push(JSON.parse(line)); }
                    catch { /* skip invalid line */ }
                }
                resolve(items);
            });
        });
    }

    /**
     * ดาวน์โหลดคลิปเต็ม ลงใน folder ของช่อง
     * @param {string} sourceUrl
     * @param {string} folder
     * @param {function} [onProgress] - callback(percent, speed, eta) — เรียกเมื่อมี progress update
     * @returns {Promise<{filePath: string}>}
     */
    _downloadFullVideo(sourceUrl, folder, onProgress) {
        if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

        return new Promise((resolve, reject) => {
            const outTmpl = path.join(folder, '%(id)s.%(ext)s');
            const args = [
                '-f', 'bv*+ba/best',
                '--merge-output-format', 'mp4',
                '-o', outTmpl,
                '--print', 'after_move:filepath',
                '--newline',                 // progress lines ใช้ \n แทน \r → parse ได้
                '--no-warnings',
                '--no-playlist',
                sourceUrl
            ];

            const proc = spawn(this.ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            let stdoutBuf = '';
            let lastEmittedPct = -1;

            const timer = setTimeout(() => {
                proc.kill('SIGKILL');
                reject(new Error(`download timeout`));
            }, DOWNLOAD_TIMEOUT_MS);

            // parse [download]   45.3% of 12.34MiB at 1.23MiB/s ETA 00:30
            const progressRe = /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+\S+(?:\s+at\s+(\S+))?(?:\s+ETA\s+(\S+))?/;

            proc.stdout.on('data', d => {
                const text = d.toString();
                stdout += text;
                stdoutBuf += text;
                // ดึงทุกบรรทัดที่จบแล้วออกมา parse
                let nl;
                while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
                    const line = stdoutBuf.slice(0, nl);
                    stdoutBuf = stdoutBuf.slice(nl + 1);
                    const m = line.match(progressRe);
                    if (m) {
                        const pct = Math.floor(parseFloat(m[1]));
                        // emit ทุก 5% เพื่อไม่ flood DB
                        if (onProgress && (pct >= lastEmittedPct + 5 || pct === 100)) {
                            lastEmittedPct = pct;
                            try { onProgress(pct, m[2] || null, m[3] || null); }
                            catch { /* swallow */ }
                        }
                    }
                }
            });
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('error', err => { clearTimeout(timer); reject(err); });
            proc.on('close', code => {
                clearTimeout(timer);
                if (code !== 0) {
                    return reject(new Error(`yt-dlp download exit ${code}: ${stderr.slice(0, 300) || stdout.slice(-300)}`));
                }
                // path ของไฟล์จริง = บรรทัดสุดท้ายของ stdout ที่ไม่ใช่ progress
                const lines = stdout.split('\n').map(s => s.trim()).filter(Boolean);
                // หา line ที่ดูเป็น path (ลงท้าย .mp4 / .mkv / .webm หรือ absolute path)
                let filePath = null;
                for (let i = lines.length - 1; i >= 0; i--) {
                    const l = lines[i];
                    if (progressRe.test(l)) continue;       // skip progress
                    if (l.startsWith('[')) continue;        // skip [download] / [Merger]
                    filePath = l;
                    break;
                }
                if (!filePath) {
                    return reject(new Error(`yt-dlp ไม่ได้ส่ง output path. stdout: ${stdout.slice(-300)}`));
                }
                resolve({ filePath });
            });
        });
    }

    // ---------------- Public API: channels ----------------

    listChannels() {
        const channels = this.db.prepare(`
            SELECT wc.*
            FROM watched_channels wc
            ORDER BY wc.created_at DESC
        `).all();
        // attach pages array
        for (const c of channels) {
            c.pages = this._getChannelPages(c.id);
        }
        return channels;
    }

    getChannel(id) {
        const ch = this.db.prepare(`SELECT * FROM watched_channels WHERE id = ?`).get(id);
        if (ch) ch.pages = this._getChannelPages(ch.id);
        return ch;
    }

    /**
     * เพิ่มช่องใหม่ + baseline ทันที (กันดูด history เก่า)
     * @param {object} args
     * @param {number[]} args.target_page_ids - array ของ page_id (อย่างน้อย 1 เพจ)
     */
    async addChannel({ label, channel_url, target_page_ids, content_type = 'all',
                      interval_hours = 5, min_duration_sec = 0, max_duration_sec = 0,
                      platform: platformOverride, pull_latest = 0 } = {}) {
        if (!label || !channel_url) {
            throw new Error('ต้องมี label และ channel_url');
        }
        if (!Array.isArray(target_page_ids) || target_page_ids.length === 0) {
            throw new Error('ต้องเลือกเพจปลายทางอย่างน้อย 1 เพจ');
        }
        if (!SUPPORTED_CONTENT_TYPES.includes(content_type)) {
            throw new Error(`content_type ไม่ถูกต้อง (ใช้ได้: ${SUPPORTED_CONTENT_TYPES.join(', ')})`);
        }
        const platform = platformOverride || this._detectPlatform(channel_url);
        if (!SUPPORTED_PLATFORMS.includes(platform)) {
            throw new Error(`platform ไม่รองรับ: ${platform}`);
        }

        // insert channel ก่อน เพื่อให้มี id ไปสร้าง folder
        // (ใช้ _scheduleNext เพื่อ next_check_at เป็น local time consistent กับระบบ)
        const result = this.db.prepare(`
            INSERT INTO watched_channels
                (label, platform, channel_url, content_type,
                 interval_hours, min_duration_sec, max_duration_sec,
                 download_dir, next_check_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(label, platform, channel_url, content_type,
                interval_hours, min_duration_sec, max_duration_sec,
                '__placeholder__', this._scheduleNext(interval_hours));

        const id = result.lastInsertRowid;
        const folder = this._channelFolder(id, label);
        if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

        this.db.prepare(`UPDATE watched_channels SET download_dir = ? WHERE id = ?`).run(folder, id);

        // ผูกเพจ (validate + insert ใน transaction)
        try {
            this._setChannelPages(id, target_page_ids);
        } catch (err) {
            // rollback channel ถ้า map page ไม่ได้
            this.db.prepare(`DELETE FROM watched_channels WHERE id = ?`).run(id);
            try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* silent */ }
            throw err;
        }

        // baseline: ดึง latest แล้วเก็บ id ล่าสุด ไม่เพิ่มเข้า pending
        // ถ้า pull_latest > 0 → ดึง N คลิปล่าสุดเข้า pending_approvals ทันที (ไม่ต้องรอ check tick)
        try {
            const scopedUrl = this._buildScopedUrl(channel_url, platform, content_type);
            const fetchCount = pull_latest > 0
                ? Math.min(Math.max(pull_latest, BASELINE_FETCH_COUNT), 30)
                : BASELINE_FETCH_COUNT;
            const items = await this._fetchChannelVideos(scopedUrl, fetchCount);
            const latestId = items[0]?.id || null;

            let pendingAdded = 0;
            if (pull_latest > 0 && items.length > 0) {
                // เก่า → ใหม่ ตอน insert (yt-dlp คืนใหม่สุดก่อน) — กัน schedule_at ผิดลำดับ
                const slice = items.slice(0, pull_latest).reverse();
                const channelForPush = {
                    id, platform, content_type,
                    min_duration_sec, max_duration_sec
                };
                const r = this._pushItemsToPending(channelForPush, slice);
                pendingAdded = r.added;
            }

            this.db.prepare(`
                UPDATE watched_channels
                SET last_seen_video_id = ?, last_checked_at = ?
                WHERE id = ?
            `).run(latestId, toSqlLocal(new Date()), id);

            this.emit('channel:added', {
                id, label,
                baseline_video_id: latestId,
                baseline_count: items.length,
                pending_added: pendingAdded
            });
            if (pendingAdded > 0) {
                this.emit('approvals:new', { channel_id: id, channel_label: label, added: pendingAdded });
            }
        } catch (err) {
            // baseline fail → เก็บ error แต่ไม่ rollback (user แก้ทีหลังได้)
            this.db.prepare(`
                UPDATE watched_channels SET error_count = 1, last_error = ? WHERE id = ?
            `).run(err.message.slice(0, 500), id);
            this.emit('channel:baseline_failed', { id, error: err.message });
        }

        return this.getChannel(id);
    }

    updateChannel(id, patch) {
        const allowed = ['label', 'content_type', 'interval_hours', 'min_duration_sec',
                         'max_duration_sec', 'enabled'];
        const sets = [];
        const vals = [];
        for (const k of allowed) {
            if (patch[k] !== undefined) {
                sets.push(`${k} = ?`);
                vals.push(patch[k]);
            }
        }
        if (sets.length > 0) {
            vals.push(id);
            this.db.prepare(`UPDATE watched_channels SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        }

        // อัปเดต pages ถ้าส่งมา
        if (Array.isArray(patch.target_page_ids)) {
            this._setChannelPages(id, patch.target_page_ids);
        }

        // ถ้าเปลี่ยน enabled = 1 หรือ interval → reset error + กำหนด next_check ใหม่
        if (patch.enabled === 1 || patch.interval_hours !== undefined) {
            const ch = this.getChannel(id);
            this.db.prepare(`
                UPDATE watched_channels
                SET error_count = 0, last_error = NULL, next_check_at = ?
                WHERE id = ?
            `).run(this._scheduleNext(ch.interval_hours), id);
        }
        return this.getChannel(id);
    }

    removeChannel(id) {
        const ch = this.getChannel(id);
        this.db.prepare(`DELETE FROM watched_channels WHERE id = ?`).run(id);
        // หมายเหตุ: ไม่ลบโฟลเดอร์อัตโนมัติ — กันลบไฟล์ user ทิ้ง
        return { deleted: true, channel: ch, folder_kept: ch?.download_dir };
    }

    // ---------------- Check logic ----------------

    /**
     * Insert items เข้า pending_approvals พร้อม filter (content_type / duration / live)
     * + URL fallback (sourceUrl ต้องเป็น absolute URL ไม่งั้น yt-dlp ดาวน์โหลดไม่ออก)
     * @param {object} channel - ต้องมี id, platform, content_type, min_duration_sec, max_duration_sec
     * @param {Array} items - yt-dlp meta objects (id, title, duration, webpage_url, ...)
     * @returns {{added: number, skipped: number}}
     */
    _pushItemsToPending(channel, items) {
        // ✅ FIX timezone: explicit detected_at = local time (ตรงกับ last_checked_at)
        // เดิม: ใช้ DEFAULT CURRENT_TIMESTAMP (UTC) → UI parse เป็น local → off ~7 ชม.
        //   → "🆕 ใหม่" badge หายเร็วกว่ากำหนด, "เพิ่ง X นาที" แสดงผิด
        const insertStmt = this.db.prepare(`
            INSERT OR IGNORE INTO pending_approvals
                (watched_id, video_id, source_url, title, duration_sec, thumbnail_url, upload_date, detected_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const detectedNow = toSqlLocal(new Date());
        let added = 0, skipped = 0;
        for (const it of items) {
            if (!this._isVideoMatch(it, channel.content_type, channel.min_duration_sec, channel.max_duration_sec)) {
                skipped++;
                continue;
            }
            let sourceUrl = it.webpage_url || it.url || '';
            if (!sourceUrl.startsWith('http') && it.id) {
                if (channel.platform === 'youtube') {
                    sourceUrl = (channel.content_type === 'shorts' || channel.content_type === 'reels')
                        ? `https://www.youtube.com/shorts/${it.id}`
                        : `https://www.youtube.com/watch?v=${it.id}`;
                } else if (channel.platform === 'bilibili') {
                    sourceUrl = `https://www.bilibili.com/video/${it.id}`;
                } else if (channel.platform === 'tiktok') {
                    const uploader = it.uploader_id || it.uploader || it.channel;
                    if (uploader) {
                        sourceUrl = `https://www.tiktok.com/@${uploader.replace(/^@/, '')}/video/${it.id}`;
                    } else {
                        skipped++;
                        continue;
                    }
                } else if (channel.platform === 'facebook') {
                    sourceUrl = `https://www.facebook.com/watch/?v=${it.id}`;
                } else {
                    skipped++;
                    continue;
                }
            }
            if (!sourceUrl.startsWith('http')) { skipped++; continue; }
            if (!it.id) { skipped++; continue; }
            const r = insertStmt.run(
                channel.id, it.id, sourceUrl, it.title || null,
                Math.round(Number(it.duration || 0)) || null,
                it.thumbnail || it.thumbnails?.[0]?.url || null,
                it.upload_date || null,
                detectedNow
            );
            if (r.changes > 0) added++;
        }
        return { added, skipped };
    }

    /**
     * เช็คคลิปใหม่ของช่องเดียว — ✅ H4: per-channel mutex กัน race
     * (cron tick + manual check-now เรียกพร้อมกันได้ → จะคืน Promise เดียวกัน)
     * @returns {Promise<{added: number, skipped: number, error?: string}>}
     */
    async checkChannel(id, fetchCountOverride = null, options = {}) {
        // ถ้ามี check ของช่องนี้รันอยู่แล้ว → return Promise เดิม (ไม่สร้างซ้ำ)
        const existing = this._channelChecks.get(id);
        if (existing) return existing;
        const p = this._doCheckChannel(id, fetchCountOverride, options).finally(() => {
            this._channelChecks.delete(id);
        });
        this._channelChecks.set(id, p);
        return p;
    }

    async _doCheckChannel(id, fetchCountOverride = null, options = {}) {
        const ch = this.getChannel(id);
        if (!ch) throw new Error(`channel id=${id} not found`);

        // ✅ NEW: ถ้า user ขอรวม rejected → ลบ rejected entries ของ channel นี้ก่อน
        // กรณี: user กด "ดึงเก่า" + checkbox "รวมคลิปที่เคยปฏิเสธ"
        // → INSERT OR IGNORE ใน _pushItemsToPending จะไม่ skip คลิปเก่าอีก
        if (options.clearRejected) {
            const r = this.db.prepare(
                `DELETE FROM pending_approvals WHERE watched_id = ? AND status = 'rejected'`
            ).run(id);
            console.log(`[ChannelWatcher] ch#${id}: cleared ${r.changes} rejected entries (user opted to re-include)`);
        }

        try {
            const scopedUrl = this._buildScopedUrl(ch.channel_url, ch.platform, ch.content_type);
            // fetchCountOverride: null = ใช้ default (CHECK_FETCH_COUNT) + smart expand,
            //                     0 = ดึงทั้งหมด (no expand needed), >0 = top N (no expand)
            const initialCount = fetchCountOverride !== null ? fetchCountOverride : CHECK_FETCH_COUNT;
            let items = await this._fetchChannelVideos(scopedUrl, initialCount);

            // ✅ SMART ADAPTIVE EXPANSION (เฉพาะ "เช็คเลย" ปกติ — ไม่กระทบ "ดึงเก่า")
            // กัน case: ช่องลงคลิป >15 ตัวระหว่าง check intervals → ระบบพลาดคลิปใหม่
            // วิธี: ถ้า fetched batch ยังไม่เห็น baseline (last_seen_video_id) → expand 100
            //       ถ้ายังไม่เจอใน 100 → expand 300 → ถ้ายังไม่เจอ → ยอมแพ้ + warn (ช่อง reset history)
            const isAutoCheck = fetchCountOverride === null;
            if (isAutoCheck && ch.last_seen_video_id && items.length >= initialCount) {
                const baselineFound = items.some(it => it.id === ch.last_seen_video_id);
                if (!baselineFound) {
                    console.log(`[ChannelWatcher] ch#${id} (${ch.label}): baseline ไม่เจอใน ${initialCount} → expand 100`);
                    const expanded100 = await this._fetchChannelVideos(scopedUrl, 100);
                    if (expanded100.length > 0) {
                        items = expanded100;
                        const stillNotFound = !expanded100.some(it => it.id === ch.last_seen_video_id);
                        if (stillNotFound && expanded100.length >= 100) {
                            console.log(`[ChannelWatcher] ch#${id}: ยังไม่เจอ baseline ใน 100 → expand 300`);
                            const expanded300 = await this._fetchChannelVideos(scopedUrl, 300);
                            if (expanded300.length > 0) {
                                items = expanded300;
                                const stillNotFound2 = !expanded300.some(it => it.id === ch.last_seen_video_id);
                                if (stillNotFound2) {
                                    console.warn(`[ChannelWatcher] ch#${id}: baseline ไม่เจอแม้ใน 300 — ช่องอาจ reset history. Accept top 300 เป็นใหม่ทั้งหมด`);
                                }
                            }
                        }
                    }
                }
            }

            // yt-dlp คืนล่าสุดก่อน — เดินจากท้ายมาหัว เพื่อ insert ตามลำดับเวลาจริง
            // เจอ last_seen_video_id เมื่อไหร่ → คลิปก่อนหน้านั้นถือว่า "เคยเห็น" หยุด
            const newOnes = [];
            for (const it of items) {
                if (ch.last_seen_video_id && it.id === ch.last_seen_video_id) break;
                newOnes.push(it);
            }
            // newOnes เรียงจาก "ใหม่สุด → เก่า" → reverse ให้เป็น "เก่า → ใหม่" ตอน insert
            newOnes.reverse();

            const { added, skipped } = this._pushItemsToPending(ch, newOnes);

            // อัปเดต last_seen เป็น latest item ของรอบนี้ (id แรกใน items = ใหม่สุด)
            const newestId = items[0]?.id || ch.last_seen_video_id;
            this.db.prepare(`
                UPDATE watched_channels
                SET last_seen_video_id = ?,
                    last_checked_at = ?,
                    next_check_at = ?,
                    error_count = 0,
                    last_error = NULL
                WHERE id = ?
            `).run(newestId, toSqlLocal(new Date()), this._scheduleNext(ch.interval_hours), id);

            if (added > 0) {
                this.emit('approvals:new', { channel_id: id, channel_label: ch.label, added });
            }
            return { added, skipped, total_fetched: items.length };
        } catch (err) {
            const newErrCount = (ch.error_count || 0) + 1;
            const shouldDisable = newErrCount >= MAX_ERRORS_BEFORE_DISABLE;
            this.db.prepare(`
                UPDATE watched_channels
                SET error_count = ?,
                    last_error = ?,
                    last_checked_at = ?,
                    next_check_at = ?,
                    enabled = ?
                WHERE id = ?
            `).run(
                newErrCount,
                err.message.slice(0, 500),
                toSqlLocal(new Date()),
                this._scheduleNext(ch.interval_hours),
                shouldDisable ? 0 : ch.enabled,
                id
            );
            if (shouldDisable) {
                this.emit('channel:disabled', { id, reason: 'too_many_errors', error: err.message });
            }
            return { added: 0, skipped: 0, error: err.message };
        }
    }

    /**
     * เช็คทุกช่องที่ถึงรอบ
     */
    async checkDue() {
        if (this._busy) {
            console.log('[ChannelWatcher] tick skipped — previous check still running');
            return { skipped: 'busy' };
        }
        this._busy = true;
        try {
            // ✅ FIX timezone bug: SQLite's ? ใน Electron's bundled
            // Node บางเครื่องคืน timezone ผิด (เคยเจอ off 6 ชม.) → cron compare ผิด → ไม่ fire
            // ใช้ Node Date.toSqlLocal() แทน — ใช้ system timezone ที่ JS เห็นจริง
            const nowStr = toSqlLocal(new Date());
            const due = this.db.prepare(`
                SELECT id, label FROM watched_channels
                WHERE enabled = 1
                  AND (next_check_at IS NULL OR next_check_at <= ?)
                ORDER BY (last_checked_at IS NULL) DESC, last_checked_at ASC
                LIMIT 20
            `).all(nowStr);
            console.log(`[ChannelWatcher] checkDue: node now=${nowStr}, due=${due.length}`);

            const results = [];
            for (let i = 0; i < due.length; i++) {
                const r = await this.checkChannel(due[i].id);
                results.push({ id: due[i].id, label: due[i].label, ...r });
                // jitter ระหว่างช่อง กัน yt-dlp burst
                if (i < due.length - 1) {
                    const [lo, hi] = JITTER_BETWEEN_CHANNELS_MS;
                    await this._sleep(lo + Math.random() * (hi - lo));
                }
            }
            this.emit('check:complete', { count: due.length, results });
            return { count: due.length, results };
        } finally {
            this._busy = false;
        }
    }

    // ---------------- Approvals ----------------

    listPending(limit = 50) {
        // คืน pending + downloading + failed → UI ใช้แสดง progress bar / retry button
        const rows = this.db.prepare(`
            SELECT pa.*, wc.label AS channel_label, wc.download_dir, wc.platform
            FROM pending_approvals pa
            LEFT JOIN watched_channels wc ON wc.id = pa.watched_id
            WHERE pa.status IN ('pending', 'downloading', 'failed')
            ORDER BY
                CASE pa.status WHEN 'downloading' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                pa.detected_at DESC,
                pa.id DESC
            LIMIT ?
        `).all(limit);
        // ✅ FIX sort: เพิ่ม pa.id DESC เป็น secondary sort
        // เดิม: items ที่ insert ใน batch เดียวกัน detected_at ตรงกัน → SQLite return เรียง id ASC
        //   = video เก่า (id ต่ำ) ขึ้นบน, video ใหม่ (id สูง) อยู่ล่าง — ตรงข้ามจากที่ user ต้องการ
        // ใหม่: id DESC → video ที่ insert ล่าสุด (= newest video on channel) อยู่บน
        // attach target pages list
        for (const r of rows) {
            r.target_pages = this._getChannelPages(r.watched_id);
        }
        return rows;
    }

    /**
     * Retry: failed → pending (user กดลองใหม่)
     */
    retryFailed(approvalId) {
        const r = this.db.prepare(`
            UPDATE pending_approvals
            SET status = 'pending', download_progress = 0, download_error = NULL
            WHERE id = ? AND status = 'failed'
        `).run(approvalId);
        return { ok: r.changes > 0 };
    }

    /**
     * อนุมัติคลิป → enqueue เข้า concurrency-limited queue
     * (return ทันที — งานจริงทำ background)
     */
    async approve(approvalId) {
        const row = this.db.prepare(`
            SELECT pa.*, wc.download_dir, wc.label AS channel_label, wc.platform
            FROM pending_approvals pa
            JOIN watched_channels wc ON wc.id = pa.watched_id
            WHERE pa.id = ?
        `).get(approvalId);

        if (!row) throw new Error(`pending approval id=${approvalId} not found`);
        if (row.status !== 'pending') throw new Error(`status=${row.status} อนุมัติซ้ำไม่ได้`);

        const targetPageIds = this._getChannelPageIds(row.watched_id);
        if (targetPageIds.length === 0) {
            throw new Error('ช่องนี้ยังไม่ได้ผูกเพจ — ตั้งค่าเพจปลายทางก่อน');
        }

        this.db.prepare(
            `UPDATE pending_approvals SET status = 'downloading', download_progress = 0 WHERE id = ?`
        ).run(approvalId);

        // ใส่คิว concurrency-limited
        this._enqueueDownload({ approvalId, row, targetPageIds });

        return { ok: true, approval_id: approvalId, status: 'downloading',
                 target_page_ids: targetPageIds };
    }

    /**
     * Concurrency limiter: รัน _performDownload สูงสุด MAX_CONCURRENT_DOWNLOADS ขนาน
     * ที่เหลือเข้าคิวรอ
     */
    _enqueueDownload(task) {
        if (this._activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
            this._activeDownloads++;
            this._performDownload(task.approvalId, task.row, task.targetPageIds)
                .catch(err => console.error('[ChannelWatcher] download err', err))
                .finally(() => {
                    this._activeDownloads--;
                    const next = this._downloadQueue.shift();
                    if (next) this._enqueueDownload(next);
                });
        } else {
            this._downloadQueue.push(task);
        }
    }

    async _performDownload(approvalId, row, targetPageIds) {
        // progress callback → update DB
        const updateProgressStmt = this.db.prepare(
            `UPDATE pending_approvals SET download_progress = ? WHERE id = ?`
        );
        const onProgress = (pct, speed, eta) => {
            try {
                updateProgressStmt.run(pct, approvalId);
                this.emit('download:progress', { approval_id: approvalId, percent: pct, speed, eta });
            } catch { /* DB locked — ignore */ }
        };

        try {
            // Step 1: download คลิปเต็ม → folder เฉพาะช่อง (per-channel guarantee)
            const { filePath } = await this._downloadFullVideo(row.source_url, row.download_dir, onProgress);
            if (!filePath || !fs.existsSync(filePath)) {
                throw new Error(`ไฟล์ดาวน์โหลดไม่เจอบน disk: ${filePath || '(empty)'}`);
            }
            const stat = fs.statSync(filePath);

            // Step 2: pre-INSERT scouted_videos กับ file_path
            // → orchestrator (ที่จะเรียกถัดไป) จะ dedup ด้วย url_hash, เห็น file_path มี → ไม่ download ซ้ำ
            // ✅ FIX: ใช้ canonicalUrl + hashUrl เดียวกับ orchestrator (SHA1 16 chars)
            //         ไม่งั้น dedup แตก → orchestrator INSERT row ใหม่ + source_url UNIQUE block → crash
            const canonical = orchCanonicalUrl(row.source_url);
            const urlHash = orchHashUrl(canonical);
            this.db.prepare(`
                INSERT OR IGNORE INTO scouted_videos
                    (source, source_url, url_hash, title, duration_sec, thumbnail_url,
                     file_path, file_size, keyword, downloaded_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                row.platform, row.source_url, urlHash, row.title,
                row.duration_sec, row.thumbnail_url,
                filePath, stat.size || null,
                `[watcher:${row.channel_label}]`,
                toSqlLocal(new Date())
            );
            // ถ้ามีอยู่แล้ว (IGNORE / หรือ row ที่ orchestrator เคยสร้าง) — UPDATE file_path ให้ชี้ไฟล์ที่เพิ่งโหลด
            this.db.prepare(`
                UPDATE scouted_videos SET file_path = ?, file_size = ?
                WHERE url_hash = ? AND (file_path IS NULL OR file_path = '')
            `).run(filePath, stat.size || null, urlHash);
            const scoutedId = this.db.prepare(
                `SELECT id FROM scouted_videos WHERE url_hash = ?`
            ).get(urlHash)?.id;

            // Step 2.5: ffprobe เพื่อรู้ duration จริง — สำคัญสำหรับ Shorts (ไม่ต้อง slice เป็นชิ้นๆ)
            // เพราะ orchestrator default clipDurationSec=75s จะ throw "คลิปสั้นเกินไป" ถ้าวิดีโอสั้นกว่า
            let videoDuration = 0;
            try {
                videoDuration = await orchFfprobeDuration(filePath);
                videoDuration = Math.floor(videoDuration);
            } catch (e) {
                console.warn('[ChannelWatcher] ffprobe failed:', e.message);
            }

            // Step 3: หยิบ pipeline เดิมทำต่อ — orchestrator จะ slice/banner/caption/schedule
            // เรียก enqueue() แยกต่อเพจ (orchestrator's sourceUrl path = 1 page เท่านั้น
            // dedup ด้วย url_hash ทำให้ไม่ download ซ้ำ)
            //
            // สำหรับ Shorts/วิดีโอสั้น (≤120s):
            //   - clipsPerVideo = 1  (ไม่ตัดเป็นชิ้น)
            //   - clipDurationSec = videoDuration (ใช้เต็มคลิป)
            // สำหรับวิดีโอยาว: ปล่อย default (clipsPerVideo=4, clipDurationSec=75)
            const isShortVideo = videoDuration > 0 && videoDuration <= 120;
            const enqueueOpts = isShortVideo
                ? { clipsPerVideo: 1, clipDurationSec: Math.max(5, videoDuration) }
                : {};   // default

            // ✅ NEW: อ่าน setting "watcher_auto_edit_enabled" (default '1' = เปิดตัดต่อ)
            // ถ้า '0' → orchestrator ข้าม slice/banner — โพสต์ raw clip ตรงๆ
            let skipAutoEdit = false;
            try {
                const row = this.db.prepare(
                    `SELECT value FROM settings WHERE key = 'watcher_auto_edit_enabled'`
                ).get();
                skipAutoEdit = row?.value === '0' || row?.value === 0;
            } catch {}

            let totalRunIds = [];
            if (this.orchestrator) {
                for (const pid of targetPageIds) {
                    try {
                        const r = this.orchestrator.enqueue({
                            pageId: pid,
                            sourceUrl: row.source_url,
                            scoutLimit: 1,
                            clipsPerPage: 1,
                            useWatcherCaption: true,
                            // ✅ FIX H8: ส่ง channel label เป็น hintedKeyword → orchestrator ใช้
                            // เป็น context.channelLabel ตอน generateForWatcher → caption variable
                            // {channel_label} จะมีค่าจริง (เดิม empty)
                            hintedKeyword: row.channel_label || null,
                            // ✅ NEW: skip slice + banner → คลิปเต็มถูกใช้ตรงๆ (clipsPerVideo=1, banner=none)
                            skipAutoEdit,
                            ...enqueueOpts
                        });
                        if (r?.runId) totalRunIds.push(r.runId);
                        console.log(`[ChannelWatcher] enqueued ${row.source_url} → page ${pid}` +
                                    (isShortVideo ? ` (short ${videoDuration}s, clipsPerVideo=1)` : ''));
                    } catch (e) {
                        console.warn(`[ChannelWatcher] orchestrator.enqueue failed for page ${pid}:`, e.message);
                    }
                }
            } else if (this.autoPrepare) {
                // legacy fallback (no orchestrator)
                this._legacyAutoPrepare(scoutedId, filePath, row, targetPageIds);
            }

            this.db.prepare(`
                UPDATE pending_approvals
                SET status = 'done', scouted_id = ?, download_progress = 100,
                    orchestrator_run_id = ?
                WHERE id = ?
            `).run(scoutedId, totalRunIds.join(',') || null, approvalId);

            this.emit('approval:done', {
                approval_id: approvalId,
                scouted_id: scoutedId,
                file_path: filePath,
                channel_label: row.channel_label,
                target_page_ids: targetPageIds,
                run_ids: totalRunIds
            });
        } catch (err) {
            this.db.prepare(`
                UPDATE pending_approvals SET status = 'failed', download_error = ? WHERE id = ?
            `).run(err.message.slice(0, 500), approvalId);
            this.emit('approval:failed', { approval_id: approvalId, error: err.message });
        }
    }

    /**
     * Legacy fallback (testing only, no orchestrator) — สร้าง clip + jobs โดยตรง
     * ⚠️ คลิปจะ status='ready' แต่ caption=NULL → preflight จะบล็อก
     * ใน production ควรส่ง orchestrator มา
     */
    _legacyAutoPrepare(scoutedId, filePath, scoutedRow, targetPageIds) {
        if (!scoutedId || !targetPageIds?.length) return [];

        let clipId = this.db.prepare(
            `SELECT id FROM clips WHERE scouted_id = ? ORDER BY clip_index ASC LIMIT 1`
        ).get(scoutedId)?.id;

        if (!clipId) {
            const duration = Number(scoutedRow.duration_sec || 0) || 60;
            const r = this.db.prepare(`
                INSERT INTO clips (scouted_id, clip_index, start_sec, end_sec, set1_path, status)
                VALUES (?, 1, 0, ?, ?, 'ready')
            `).run(scoutedId, duration, filePath);
            clipId = r.lastInsertRowid;
        }

        const jobIds = [];
        const insertJob = this.db.prepare(`
            INSERT INTO jobs (clip_id, page_id, scheduled_at, status, use_set)
            VALUES (?, ?, ?, 'pending', 1)
        `);
        const checkExisting = this.db.prepare(`SELECT id FROM jobs WHERE clip_id = ? AND page_id = ?`);
        const getPage = this.db.prepare(`SELECT cooldown_min FROM pages WHERE id = ?`);
        const getLastScheduled = this.db.prepare(`
            SELECT scheduled_at FROM jobs
            WHERE page_id = ? AND status IN ('pending', 'running')
            ORDER BY scheduled_at DESC LIMIT 1
        `);

        for (const pageId of targetPageIds) {
            if (checkExisting.get(clipId, pageId)) continue;
            const page = getPage.get(pageId);
            const cooldownMin = page?.cooldown_min || 30;

            // ใช้ local time consistent กับระบบเดิม
            const lastSched = getLastScheduled.get(pageId)?.scheduled_at;
            let scheduledAtMs;
            if (lastSched) {
                // lastSched เป็น local time string YYYY-MM-DD HH:MM:SS
                // (สร้างโดย worker.js / orchestrator ที่ใช้ datetime('now','localtime'))
                const lastTs = new Date(lastSched.replace(' ', 'T')).getTime();  // ❌ ไม่ใส่ Z = parse เป็น local
                const candidate = lastTs + cooldownMin * 60_000;
                const minStart = Date.now() + 5 * 60_000;
                scheduledAtMs = Math.max(candidate, minStart);
            } else {
                scheduledAtMs = Date.now() + 5 * 60_000;
            }
            const scheduledAt = toSqlLocal(new Date(scheduledAtMs));

            const r = insertJob.run(clipId, pageId, scheduledAt);
            jobIds.push(r.lastInsertRowid);
        }
        return jobIds;
    }

    // ---------------- Approve all ----------------

    /**
     * อนุมัติทุก pending approval — concurrency-limited
     * (approve() เพียงบันทึกใน DB + ใส่คิว — return เร็ว)
     */
    async approveAll() {
        const pending = this.db.prepare(
            `SELECT id FROM pending_approvals WHERE status = 'pending'`
        ).all();

        const results = await Promise.allSettled(pending.map(p => this.approve(p.id)));

        let approved = 0, skipped = 0;
        const errors = [];
        for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'fulfilled') approved++;
            else {
                skipped++;
                errors.push({ id: pending[i].id, error: results[i].reason?.message || 'unknown' });
            }
        }
        return { approved, skipped, errors };
    }

    /**
     * Zombie reaper: หา 'downloading' rows ที่ค้างนานเกินกำหนด → reset เป็น 'failed'
     * (เกิดเมื่อโปรแกรมถูกปิดระหว่าง _performDownload)
     */
    _reapZombieDownloads() {
        try {
            const cutoff = toSqlLocal(new Date(Date.now() - ZOMBIE_REAPER_THRESHOLD_MS));
            const r = this.db.prepare(`
                UPDATE pending_approvals
                SET status = 'failed',
                    download_error = 'โปรแกรมถูกปิดระหว่างดาวน์โหลด — กด "ลองใหม่" ได้'
                WHERE status = 'downloading' AND detected_at < ?
            `).run(cutoff);
            if (r.changes > 0) {
                console.log(`[ChannelWatcher] reaped ${r.changes} zombie download(s)`);
            }
        } catch (e) {
            console.warn('[ChannelWatcher] reapZombieDownloads error:', e.message);
        }
    }

    reject(approvalId) {
        const r = this.db.prepare(`
            UPDATE pending_approvals SET status = 'rejected'
            WHERE id = ? AND status = 'pending'
        `).run(approvalId);
        return { ok: r.changes > 0 };
    }

    /**
     * ปฏิเสธทุก pending approval ในรอบเดียว
     * (ไม่กระทบ downloading/failed → กันเผลอลบงานที่กำลังทำอยู่)
     */
    rejectAll() {
        const r = this.db.prepare(`
            UPDATE pending_approvals
            SET status = 'rejected'
            WHERE status = 'pending'
        `).run();
        return { rejected: r.changes };
    }

    countPending() {
        return this.db.prepare(`SELECT COUNT(*) AS n FROM pending_approvals WHERE status = 'pending'`)
            .get().n;
    }

    // ---------------- Cron lifecycle ----------------

    start() {
        if (this._cronTask) return;

        // 1. Reap zombies (downloading rows ที่ค้างจากการ crash ครั้งก่อน) ทันที
        this._reapZombieDownloads();

        // 2. ทุก N นาที — random offset เพื่อไม่ tick ตรงกับเครื่องอื่น (กัน burst)
        const offsetMin = Math.floor(Math.random() * CHECK_TICK_MINUTES);
        const expr = `${offsetMin}-59/${CHECK_TICK_MINUTES} * * * *`;
        this._cronTask = cron.schedule(expr, () => {
            console.log(`[ChannelWatcher] cron tick fired @ ${new Date().toLocaleString()}`);
            this.checkDue()
                .then(r => {
                    if (r && r.count !== undefined) {
                        const added = r.results?.reduce((s, x) => s + (x.added || 0), 0) || 0;
                        console.log(`[ChannelWatcher] tick complete — checked ${r.count} channel(s), added ${added} new clip(s)`);
                    }
                })
                .catch(err => console.error('[ChannelWatcher] tick error', err));
            this._reapZombieDownloads();   // run reaper periodically too
        });
        console.log(`[ChannelWatcher] started (tick every ${CHECK_TICK_MINUTES} min, offset=${offsetMin})`);

        // 3. เช็ครอบแรกหลัง start 30 วิ
        this._initialTick = setTimeout(() => {
            this.checkDue().catch(err => console.error('[ChannelWatcher] initial tick error', err));
        }, 30_000);
    }

    stop() {
        if (this._cronTask) {
            this._cronTask.stop();
            this._cronTask = null;
        }
        if (this._initialTick) {
            clearTimeout(this._initialTick);
            this._initialTick = null;
        }
        console.log('[ChannelWatcher] stopped');
    }
}

module.exports = { ChannelWatcher, SUPPORTED_PLATFORMS, SUPPORTED_CONTENT_TYPES };
