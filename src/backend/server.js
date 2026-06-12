/**
 * KINTENSHAUTO Backend Server
 * Port: 3003
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const DB_PATH = process.env.KINTENSHAUTO_DB || path.join(__dirname, '../../kintenshauto.db');
const PORT = parseInt(process.env.PORT || '3003', 10);
const USER_DATA = process.env.KINTENSHAUTO_USER_DATA || path.join(__dirname, '../..');
const OVERLAYS_DIR = process.env.KINTENSHAUTO_OVERLAYS || path.join(USER_DATA, 'overlays');
const DOWNLOADS_DIR = process.env.KINTENSHAUTO_DOWNLOADS || path.join(USER_DATA, 'downloads');
const CHROME_PROFILES = process.env.KINTENSHAUTO_CHROME_PROFILES || path.join(USER_DATA, 'chrome-profiles');
// Dirs that user can change at runtime via /api/storage/path — use getters so
// env updates propagate without restarting
const getClipsDir  = () => process.env.KINTENSHAUTO_CLIPS_DIR  || path.join(USER_DATA, 'clips');
const getCoversDir = () => process.env.KINTENSHAUTO_COVERS_DIR || path.join(USER_DATA, 'covers');
const CLIPS_DIR = getClipsDir();  // snapshot for initial service wiring

// ✅ FIX #6/7: ensure ALL essential dirs exist on cold start (รวม USER_DATA + clips/covers)
// — เดิม ขาด clips/covers → endpoint regenerate-cover/test crash บน fresh install
for (const d of [USER_DATA, OVERLAYS_DIR, DOWNLOADS_DIR, CHROME_PROFILES, getClipsDir(), getCoversDir()]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {
        if (e.code !== 'EEXIST') console.warn('[server] mkdir', d, e.message);
    }
}

// ---- Resolve a working FFmpeg ----
// Some Windows machines have Device Guard / SmartScreen that blocks unsigned
// executables (like our bundled bin/win32/ffmpeg.exe from BtbN). When this
// happens, yt-dlp's merge step fails silently with "ffmpeg is not installed".
//
// Strategy:
//  1. Try the bundled ffmpeg first (run -version)
//  2. If blocked / fails → fall back to system ffmpeg via `where ffmpeg.exe`
//  3. Override KINTENSHAUTO_FFMPEG env so all child modules pick it up
function resolveWorkingFfmpeg() {
    if (process.platform !== 'win32') return;
    const { execSync } = require('child_process');
    const bundled = process.env.KINTENSHAUTO_FFMPEG;

    // Full-capability probe: not just `-version` (which may pass under Device Guard
    // even when real encode subprocess is blocked). We test that ffmpeg can actually
    // generate a 1-second silent video to memory — that exercises subprocess/IO paths.
    function testExeFully(p) {
        if (!p || !fs.existsSync(p)) return false;
        try {
            // -version first (cheap)
            execSync(`"${p}" -version`, { stdio: 'pipe', timeout: 5000 });
            // Then full-capability: encode 1 frame of black to a null sink
            execSync(`"${p}" -f lavfi -i color=c=black:s=16x16:d=0.1 -frames:v 1 -f null -`, {
                stdio: 'pipe', timeout: 10000
            });
            return true;
        } catch { return false; }
    }

    // Unblock attempt first (covers Mark-of-the-Web blocks).
    // Pass binDir as a base64-encoded literal to avoid PowerShell injection if
    // path contains quotes / backticks.
    try {
        const binDir = bundled ? path.dirname(bundled) : path.join(__dirname, '..', '..', 'bin', 'win32');
        if (fs.existsSync(binDir)) {
            const psScript = `$dir = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(binDir, 'utf-8').toString('base64')}')); Get-ChildItem -LiteralPath $dir -Recurse -Include *.exe | Unblock-File -ErrorAction SilentlyContinue`;
            execSync(`powershell -NoProfile -NonInteractive -Command "${psScript.replace(/"/g, '\\"')}"`,
                { timeout: 15000, stdio: 'pipe' });
        }
    } catch {}

    // Try system ffmpeg FIRST (more reliable — bundled may pass -version but fail
    // under Device Guard when yt-dlp invokes it as a child process)
    try {
        const out = execSync('where ffmpeg.exe', { stdio: 'pipe', timeout: 5000 }).toString();
        const candidates = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        for (const c of candidates) {
            if (testExeFully(c)) {
                process.env.KINTENSHAUTO_FFMPEG = c;
                console.log(`[startup] FFmpeg OK (system - preferred): ${c}`);
                return;
            }
        }
    } catch {}

    // WinGet location as a secondary system source
    const winget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    if (fs.existsSync(winget)) {
        try {
            const ffmpegPkg = fs.readdirSync(winget).find(d => d.startsWith('yt-dlp.FFmpeg'));
            if (ffmpegPkg) {
                const inner = fs.readdirSync(path.join(winget, ffmpegPkg))
                    .find(d => d.startsWith('ffmpeg-'));
                if (inner) {
                    const p = path.join(winget, ffmpegPkg, inner, 'bin', 'ffmpeg.exe');
                    if (testExeFully(p)) {
                        process.env.KINTENSHAUTO_FFMPEG = p;
                        console.log(`[startup] FFmpeg OK (WinGet): ${p}`);
                        return;
                    }
                }
            }
        } catch {}
    }

    // Fallback: bundled ffmpeg
    if (testExeFully(bundled)) {
        console.log(`[startup] FFmpeg OK (bundled fallback): ${bundled}`);
        return;
    }

    console.error('[startup] WARNING: no working FFmpeg found — yt-dlp merge will fail');
}
resolveWorkingFfmpeg();

// ---- Load user-configured storage paths from settings (overrides env defaults) ----
function loadStoragePathsFromSettings() {
    try {
        const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN ('storage_videos_dir', 'storage_clips_dir', 'storage_covers_dir')`).all();
        for (const r of rows) {
            if (r.key === 'storage_videos_dir' && r.value && fs.existsSync(r.value)) {
                process.env.KINTENSHAUTO_DOWNLOADS = r.value;
                console.log(`[storage] full videos → ${r.value}`);
            }
            if (r.key === 'storage_clips_dir' && r.value && fs.existsSync(r.value)) {
                process.env.KINTENSHAUTO_CLIPS_DIR = r.value;
                console.log(`[storage] clips → ${r.value}`);
            }
            if (r.key === 'storage_covers_dir' && r.value && fs.existsSync(r.value)) {
                process.env.KINTENSHAUTO_COVERS_DIR = r.value;
                console.log(`[storage] covers → ${r.value}`);
            }
        }
        // Ensure the active dirs exist (whether default or custom)
        const dirs = [
            process.env.KINTENSHAUTO_DOWNLOADS,
            process.env.KINTENSHAUTO_CLIPS_DIR,
            getCoversDir()
        ].filter(Boolean);
        for (const d of dirs) {
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        }
    } catch (e) { console.error('[storage] load paths failed:', e.message); }
}
// Note: we'll call this AFTER the db variable is defined below. Add it after migrations.

// ------------- Initialize DB -------------
// Validate USER_DATA is writable before opening DB — gives clear error if
// user installed to a read-only location.
try {
    const probe = path.join(USER_DATA, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
} catch (e) {
    console.error(`[startup] FATAL: cannot write to ${USER_DATA}: ${e.message}`);
    console.error(`[startup] กรุณาตรวจสิทธิ์เขียนไฟล์ของโฟลเดอร์ดังกล่าว`);
    process.exit(1);
}

const { openDatabase, loadSchema, applyMigrations } = require('./local/db');

const schemaPath = path.join(__dirname, '../../schema.sql');
let db, dbExists;
try {
    const opened = openDatabase(DB_PATH);
    db = opened.db;
    dbExists = !opened.isFresh;
} catch (e) {
    console.error('[startup] FATAL:', e.message);
    process.exit(1);
}

if (!dbExists && fs.existsSync(schemaPath)) {
    loadSchema(db, schemaPath);
    console.log('[server] Database initialized from schema.sql');
}
// Always ensure schema (idempotent via CREATE TABLE IF NOT EXISTS)
try { loadSchema(db, schemaPath); } catch { /* non-fatal */ }

applyMigrations(db, [
    { table: 'scouted_videos', column: 'assigned_page_id', definition: 'INTEGER' },
    { table: 'clips',          column: 'assigned_page_id', definition: 'INTEGER' },
    { table: 'pages',          column: 'posts_per_session', definition: 'INTEGER DEFAULT 3' },
    { table: 'pages',          column: 'session_interval_hours', definition: 'INTEGER DEFAULT 24' },
    { table: 'pages',          column: 'last_session_at', definition: 'DATETIME' },
    { table: 'pages',          column: 'default_keyword', definition: 'TEXT' },
    { table: 'jobs',           column: 'priority', definition: 'INTEGER DEFAULT 0' },
    { table: 'clips',          column: 'cover_path', definition: 'TEXT' },
    { table: 'pages',          column: 'use_ai_cover', definition: 'INTEGER DEFAULT 0' },
    { table: 'pages',          column: 'cover_prompt', definition: 'TEXT' },
    { table: 'scouted_videos', column: 'thumbnail_local_path', definition: 'TEXT' },
    { table: 'caption_prompts', column: 'selected_model', definition: 'TEXT' },
    { table: 'profiles',       column: 'platform', definition: "TEXT NOT NULL DEFAULT 'facebook'" },
    { table: 'profiles',       column: 'account_handle', definition: 'TEXT' },
    // Per-page posting schedule — daily_quota already exists. post_times is a
    // JSON array of "HH:MM" strings. The scheduler uses these slots in order;
    // when full for today, rolls over to next day.
    { table: 'pages',          column: 'post_times', definition: 'TEXT' },
    // Plan 2: sync columns for cloud bidirectional sync.
    // NOTE: SQLite's ALTER TABLE ADD COLUMN cannot add UNIQUE constraints or
    // non-constant defaults (CURRENT_TIMESTAMP). We add plain TEXT/DATETIME
    // columns here, then create unique indexes + backfill below.
    { table: 'pages',             column: 'cloud_uuid', definition: 'TEXT' },
    { table: 'pages',             column: 'cloud_synced_at', definition: 'DATETIME' },
    { table: 'pages',             column: 'updated_at', definition: 'DATETIME' },
    { table: 'pages',             column: 'deleted_at', definition: 'DATETIME' },
    { table: 'banners',           column: 'cloud_uuid', definition: 'TEXT' },
    { table: 'banners',           column: 'cloud_synced_at', definition: 'DATETIME' },
    { table: 'banners',           column: 'updated_at', definition: 'DATETIME' },
    { table: 'banners',           column: 'deleted_at', definition: 'DATETIME' },
    { table: 'banner_presets',    column: 'cloud_uuid', definition: 'TEXT' },
    { table: 'banner_presets',    column: 'cloud_synced_at', definition: 'DATETIME' },
    { table: 'banner_presets',    column: 'updated_at', definition: 'DATETIME' },
    { table: 'banner_presets',    column: 'deleted_at', definition: 'DATETIME' },
    { table: 'caption_prompts',   column: 'cloud_uuid', definition: 'TEXT' },
    { table: 'caption_prompts',   column: 'cloud_synced_at', definition: 'DATETIME' },
    { table: 'caption_prompts',   column: 'updated_at', definition: 'DATETIME' },
    { table: 'caption_prompts',   column: 'deleted_at', definition: 'DATETIME' },
    { table: 'comment_templates', column: 'cloud_uuid', definition: 'TEXT' },
    { table: 'comment_templates', column: 'cloud_synced_at', definition: 'DATETIME' },
    { table: 'comment_templates', column: 'updated_at', definition: 'DATETIME' },
    { table: 'comment_templates', column: 'deleted_at', definition: 'DATETIME' },
    { table: 'comment_settings',  column: 'cloud_uuid', definition: 'TEXT' },
    { table: 'comment_settings',  column: 'cloud_synced_at', definition: 'DATETIME' },
    { table: 'comment_settings',  column: 'updated_at', definition: 'DATETIME' },
    { table: 'comment_settings',  column: 'deleted_at', definition: 'DATETIME' },
    { table: 'watched_channels',  column: 'cloud_uuid', definition: 'TEXT' },
    { table: 'watched_channels',  column: 'cloud_synced_at', definition: 'DATETIME' },
    { table: 'watched_channels',  column: 'updated_at', definition: 'DATETIME' },
    { table: 'watched_channels',  column: 'deleted_at', definition: 'DATETIME' },
    { table: 'ai_providers',      column: 'cloud_uuid', definition: 'TEXT' },
    { table: 'ai_providers',      column: 'cloud_synced_at', definition: 'DATETIME' },
    { table: 'ai_providers',      column: 'updated_at', definition: 'DATETIME' },
    { table: 'ai_providers',      column: 'deleted_at', definition: 'DATETIME' },
    { table: 'profiles', column: 'proxy_last_ip', definition: 'TEXT' },
    { table: 'profiles', column: 'proxy_last_country', definition: 'TEXT' },
    { table: 'profiles', column: 'proxy_checked_at', definition: 'DATETIME' },
]);

// Plan 2: post-migration steps that ALTER TABLE ADD COLUMN cannot do directly.
//   1. UNIQUE constraint on cloud_uuid — emulated via partial UNIQUE INDEX
//      (partial so multiple rows with NULL cloud_uuid don't collide)
//   2. Backfill updated_at on existing rows (was NULL after ALTER ADD COLUMN)
const SYNCED_TABLES = [
    'pages', 'banners', 'banner_presets', 'caption_prompts',
    'comment_templates', 'comment_settings', 'watched_channels', 'ai_providers'
];
for (const t of SYNCED_TABLES) {
    try {
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${t}_cloud_uuid ON ${t}(cloud_uuid) WHERE cloud_uuid IS NOT NULL`);
    } catch (e) {
        console.warn(`[migration] unique index for ${t}.cloud_uuid failed:`, e.message);
    }
    try {
        const r = db.prepare(`UPDATE ${t} SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL`).run();
        if (r.changes > 0) console.log(`[migration] backfilled ${r.changes} ${t}.updated_at row(s)`);
    } catch (e) { /* table might not exist on very old installs */ }
}

// One-time upgrade: old Gemini default "gemini-2.0-flash" is EOL → swap to gemini-2.5-flash
// (preserved from original server.js — must run AFTER applyMigrations so caption_prompts.selected_model exists)
try {
    const r = db.prepare(`
        UPDATE ai_providers SET model = 'gemini-2.5-flash'
        WHERE provider = 'gemini' AND model = 'gemini-2.0-flash'
    `).run();
    if (r.changes > 0) console.log(`[migration] upgraded ${r.changes} ai_providers row(s) from gemini-2.0-flash to gemini-2.5-flash`);
} catch (e) { /* ignore if table not ready */ }

// Load user-configured storage paths (preserved from original server.js)
loadStoragePathsFromSettings();

// ------------- Load services -------------
const { CaptionService, encrypt, decrypt } = require('./services/captionService');
const { CommentTemplateEngine } = require('./services/commentTemplateEngine');
const { CopyrightManager } = require('./services/copyrightManager');
const { BannerPresetService } = require('./services/bannerLayerSystem');
const { SessionManager } = require('./services/sessionManager');
const { CoverService, DEFAULT_COVER_SYSTEM_PROMPT } = require('./services/coverService');
const { Orchestrator } = require('./core/orchestrator');

const captionService = new CaptionService(DB_PATH);
const commentEngine = new CommentTemplateEngine(DB_PATH);
const copyrightMgr = new CopyrightManager(DB_PATH);
const bannerPresets = new BannerPresetService(DB_PATH);
const sessionMgr = new SessionManager(DB_PATH, CHROME_PROFILES);
const coverService = new CoverService(db, { clipsDir: CLIPS_DIR });

// ------------- Express setup -------------
const app = express();
const server = http.createServer(app);
// Socket.IO origin: only allow Vite dev (5173) + Electron file:// (origin null) + embedded app.
// Reject external websites connecting to our local port.
const io = new Server(server, {
    cors: {
        origin: (origin, cb) => {
            if (!origin) return cb(null, true);  // null origin = Electron file://
            if (/^https?:\/\/(localhost|127\.0\.0\.1):(5173|3003)$/.test(origin)) return cb(null, true);
            cb(new Error('CORS: origin not allowed'));
        }
    }
});

// Banners are base64 PNGs — typically < 1 MB. Cap at 10 MB to stop runaway payloads.
app.use(express.json({ limit: '10mb' }));
// Serve banner images so the React UI can preview them (file:// is blocked under contextIsolation)
app.use('/overlays', express.static(OVERLAYS_DIR));
// Serve clip videos so the QueueView can preview them inline
app.get('/clip-video/:jobId', (req, res) => {
    const j = db.prepare(`
        SELECT j.use_set, c.set1_path, c.set2_path FROM jobs j
        JOIN clips c ON c.id = j.clip_id WHERE j.id = ?
    `).get(req.params.jobId);
    if (!j) return res.status(404).send('not found');
    const file = j.use_set === 2 ? j.set2_path : j.set1_path;
    if (!file || !fs.existsSync(file)) return res.status(404).send('file missing');

    // ✅ FIX C2: รองรับ Range header — เดิมส่ง Accept-Ranges: bytes แต่ pipe ไฟล์เต็ม
    // → browser seek ไม่ได้ + กิน bandwidth
    const stat = fs.statSync(file);
    const range = req.headers.range;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');

    if (!range) {
        res.setHeader('Content-Length', stat.size);
        fs.createReadStream(file).pipe(res);
        return;
    }

    // parse "bytes=N-M" or "bytes=N-"
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) {
        res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
        return;
    }
    const start = parseInt(m[1], 10);
    const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
    if (isNaN(start) || start >= stat.size || end < start) {
        res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
        return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(file, { start, end }).pipe(res);
});

// Serve AI cover images so QueueView can show thumbnails
app.get('/clip-cover/:clipId', (req, res) => {
    const c = db.prepare(`SELECT cover_path FROM clips WHERE id = ?`).get(req.params.clipId);
    if (!c?.cover_path || !fs.existsSync(c.cover_path)) return res.status(404).send('no cover');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(c.cover_path).pipe(res);
});
// SECURITY: Restrict CORS to local development origins only.
// App binds to 127.0.0.1 but external websites could still hit our API via CSRF
// if we returned `Access-Control-Allow-Origin: *`. Allow only:
//   - null / missing origin (Electron file:// and same-process calls)
//   - http://localhost:5173 (Vite dev)
//   - http://127.0.0.1:5173
//   - http://localhost:3003 (rare — backend calling itself)
const ALLOWED_ORIGINS = new Set([
    'http://localhost:5173', 'http://127.0.0.1:5173',
    'http://localhost:3003', 'http://127.0.0.1:3003'
]);
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) {
        // No Origin header = same-origin / Electron file:// / curl. Allow without
        // setting ACAO (browser doesn't enforce CORS for these requests anyway).
    } else if (ALLOWED_ORIGINS.has(origin)) {
        // Echo the origin back so credentialed requests work
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Vary', 'Origin');
    }
    // else: external origin → no ACAO header, browser blocks the response
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const orchestrator = new Orchestrator({
    db, captionService, coverService, io,
    logger: (...a) => console.log('[orchestrator]', ...a)
});

// Inject DB into the shared browser manager so it can back up / restore FB cookies
const browserManager = require('./core/browserManager');
browserManager.setDb(db);

// Background job worker loop — checks pending jobs every 15s
const { runJobWorkerTick, releaseReservedClips, ensureSet2ForJob, preflightJob } =
    require('./core/worker')(db, orchestrator, io, sessionMgr, DB_PATH);

// STARTUP SAFETY: any job in 'running' or 'processing' status at startup is orphaned
// — the pipeline/worker process that was handling it is gone (program was closed / crashed).
// Mark them all as failed so user can restart them, AND so their scheduled_at slots
// don't incorrectly block new sets from reusing those times.
try {
    const orphanRunning = db.prepare(`
        UPDATE jobs
        SET status = 'failed',
            error_message = 'โปรแกรมถูกปิดระหว่างโพสต์ — กด "เริ่มใหม่" เพื่อโพสต์ใหม่',
            finished_at = datetime('now', 'localtime')
        WHERE status = 'running'
    `).run();
    if (orphanRunning.changes > 0) {
        console.log(`[startup] swept ${orphanRunning.changes} orphaned 'running' job(s) → failed`);
    }

    // Also sweep stuck 'processing' jobs. These are pre-placed rows from a pipeline that
    // crashed during download/slice/banner. Their scheduled_at slots would otherwise shift
    // every new set's timing indefinitely into the future (user reported: "set ต่อไป = 22:00
    // ของอีกวัน" — caused by orphaned processing rows dragging lastScheduled far ahead).
    const orphanProcessing = db.prepare(`
        UPDATE jobs
        SET status = 'failed',
            error_message = 'โปรแกรมถูกปิดระหว่างเตรียมคลิป (download/ตัด/banner) — กด "🔧 ทำคลิปต่อ" เพื่อทำต่อจากที่ค้าง (ไม่เลื่อนเวลา)',
            finished_at = datetime('now', 'localtime')
        WHERE status = 'processing'
    `).run();
    if (orphanProcessing.changes > 0) {
        console.log(`[startup] swept ${orphanProcessing.changes} orphaned 'processing' job(s) → failed`);
    }

    // Also mark the clips themselves as failed so they don't show as 'processing' in Series view
    db.prepare(`
        UPDATE clips
        SET status = 'failed'
        WHERE status = 'processing'
    `).run();
} catch (err) {
    console.warn('[startup] orphan sweep failed:', err.message);
}

// Worker control — pausable + ✅ FIX H4: lock to prevent overlapping ticks
// (เดิม setInterval ไม่ await tick → ถ้า tick ใช้ > 15s, multiple ticks ทำงานพร้อมกัน
//  แล้ว 2 worker หยิบ job เดียวกันได้)
const workerState = { paused: false, pausedUntil: null };
let _workerTickInFlight = false;
// Guard background schedulers under tests (VITEST) so vitest's event loop can
// exit cleanly — these timers would otherwise keep the process alive after tests.
if (!process.env.VITEST) {
setInterval(() => {
    if (workerState.paused) {
        if (workerState.pausedUntil && Date.now() >= workerState.pausedUntil) {
            workerState.paused = false; workerState.pausedUntil = null;
            console.log('[worker] auto-resumed (pause expired)');
        } else {
            return;
        }
    }
    if (_workerTickInFlight) return;   // ✅ skip if previous tick still running
    _workerTickInFlight = true;
    runJobWorkerTick()
        .catch(e => console.error('[worker]', e.message))
        .finally(() => { _workerTickInFlight = false; });
}, 15000);
setInterval(() => releaseReservedClips(), 5 * 60 * 1000);

// Plan 2: periodic push of pending sync queue (every 5 min)
setInterval(async () => {
    const session = authService.getStoredSession();
    if (!session?.access_token) return;
    try {
        const { pushPending } = require('./cloud/syncEngine');
        await pushPending(db, session.access_token);
    } catch (e) { console.error('[sync] periodic push:', e.message); }
}, 5 * 60 * 1000);
}

// ------------- Helpers -------------
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
        console.error('[API error]', req.method, req.path, err);
        res.status(err.status || 500).json({ error: err.message, code: err.code || 'INTERNAL' });
    });
};

function badRequest(msg) { const e = new Error(msg); e.status = 400; e.code = 'VALIDATION'; return e; }
function notFound(msg)   { const e = new Error(msg); e.status = 404; e.code = 'NOT_FOUND';  return e; }

// ====================================================================
// HEALTH + STATS
// ====================================================================
app.get('/api/health', (req, res) => {
    const pkg = require('../../package.json');
    res.json({ ok: true, version: pkg.version, db: dbExists ? 'existing' : 'fresh', time: new Date().toISOString() });
});

// Binary dependency status — yt-dlp + ffmpeg + ffprobe + fpcalc.
// Re-resolves paths from disk on every call. The env vars
// (KINTENSHAUTO_FFMPEG/YTDLP/FPCALC) are baked in at backend spawn time, so
// if the user just finished downloading deps into USER_BIN_DIR the env vars
// still point at the missing-bundled path. We need to look on disk fresh.
//
// Exempt from auth — runs before the user has even logged in.
app.get('/api/system/deps', (req, res) => {
    const fsLocal = require('fs');
    const pathLocal = require('path');

    // Prefer the writable bin dir chosen by main.js (next to .exe when the
    // install dir is writable, else userData/bin). Legacy AppData location
    // is checked second so existing installs that wrote there continue to work.
    const userBinDir = process.env.KINTENSHAUTO_BIN_DIR
        || (process.env.KINTENSHAUTO_USER_DATA ? pathLocal.join(process.env.KINTENSHAUTO_USER_DATA, 'bin') : null);
    const legacyBinDir = process.env.KINTENSHAUTO_LEGACY_BIN_DIR
        || (process.env.KINTENSHAUTO_USER_DATA ? pathLocal.join(process.env.KINTENSHAUTO_USER_DATA, 'bin') : null);
    const ext = process.platform === 'win32' ? '.exe' : '';

    function resolve(binName) {
        const candidates = [];
        if (userBinDir)   candidates.push(pathLocal.join(userBinDir, binName + ext));
        if (legacyBinDir && legacyBinDir !== userBinDir) {
            candidates.push(pathLocal.join(legacyBinDir, binName + ext));
        }
        // Env-var path (set at spawn) — keep as backstop in case main.js
        // somehow used a different location entirely.
        const envKey = ({ ffmpeg: 'KINTENSHAUTO_FFMPEG', 'yt-dlp': 'KINTENSHAUTO_YTDLP',
                          fpcalc: 'KINTENSHAUTO_FPCALC' })[binName];
        if (envKey && process.env[envKey]) candidates.push(process.env[envKey]);

        for (const c of candidates) {
            if (c && fsLocal.existsSync(c)) return c;
        }
        return candidates[0] || null;  // expected path, even if missing
    }

    const checks = [
        { name: 'ffmpeg',  required: true,  path: resolve('ffmpeg')  },
        { name: 'yt-dlp',  required: true,  path: resolve('yt-dlp')  },
        { name: 'fpcalc',  required: false, path: resolve('fpcalc')  },
    ];
    // ffprobe is shipped alongside ffmpeg by the same download — derive from ffmpeg path
    const ffmpegPath = checks[0].path;
    const ffprobePath = ffmpegPath
        ? ffmpegPath.replace(/ffmpeg(\.exe)?$/i, (_, e) => 'ffprobe' + (e || ''))
        : null;
    checks.push({ name: 'ffprobe', required: false, path: ffprobePath });

    const paths = {};
    const sizes = {};
    const missing = [];
    for (const c of checks) {
        paths[c.name] = c.path;
        if (c.path && fsLocal.existsSync(c.path)) {
            try { sizes[c.name] = fsLocal.statSync(c.path).size; } catch { sizes[c.name] = null; }
        } else if (c.required) {
            missing.push(c.name);
        }
    }
    res.json({
        ok: missing.length === 0,
        missing,
        paths,
        sizes,
        bin_dir: userBinDir
    });
});

app.get('/api/stats/daily', asyncHandler(async (req, res) => {
    const today = db.prepare(`
        SELECT COALESCE(SUM(posts_count), 0) as posted_today
        FROM daily_stats WHERE date = date('now', 'localtime')
    `).get();
    const inQueue = db.prepare(`SELECT COUNT(*) as n FROM jobs WHERE status = 'pending' OR status = 'running'`).get();
    const pendingReviews = db.prepare(`SELECT COUNT(*) as n FROM jobs WHERE status = 'copyright_waiting'`).get();
    // Pending Channel-Watcher approvals — table may not exist on legacy DBs, so guard.
    let pendingApprovals = 0;
    try {
        pendingApprovals = db.prepare(
            `SELECT COUNT(*) as n FROM pending_approvals WHERE status = 'pending'`
        ).get().n;
    } catch { /* table absent — watcher not yet initialized */ }
    res.json({
        posted_today: today.posted_today,
        in_queue: inQueue.n,
        pending_reviews: pendingReviews.n,
        pending_approvals: pendingApprovals
    });
}));

// Home dashboard digest — channel-watcher activity + next scheduled post.
// One round-trip beats three parallel fetches and keeps HomeView simple.
app.get('/api/home/digest', asyncHandler(async (req, res) => {
    // 1) Channels with pending clips — most-recent activity first, capped to 5.
    let watcherChannels = [];
    try {
        watcherChannels = db.prepare(`
            SELECT wc.id, wc.label, wc.platform, wc.last_checked_at,
                   COUNT(pa.id) AS pending_count
            FROM watched_channels wc
            LEFT JOIN pending_approvals pa
                   ON pa.watched_id = wc.id AND pa.status = 'pending'
            GROUP BY wc.id
            HAVING pending_count > 0
            ORDER BY wc.last_checked_at DESC NULLS LAST
            LIMIT 5
        `).all();
    } catch { /* tables absent — watcher not initialized */ }

    // 2) Next scheduled post — closest future job in 'pending' status.
    let nextPost = null;
    try {
        nextPost = db.prepare(`
            SELECT j.id, j.scheduled_at, j.page_id,
                   p.name AS page_name,
                   sv.title AS video_title,
                   c.clip_index
            FROM jobs j
            LEFT JOIN clips c ON c.id = j.clip_id
            LEFT JOIN pages p ON p.id = j.page_id
            LEFT JOIN scouted_videos sv ON sv.id = c.scouted_id
            WHERE j.status = 'pending'
              AND j.scheduled_at IS NOT NULL
              AND j.scheduled_at >= datetime('now', 'localtime')
            ORDER BY j.scheduled_at ASC
            LIMIT 1
        `).get() || null;
    } catch { /* schema mismatch — leave null */ }

    res.json({
        watcher_channels: watcherChannels,
        next_post: nextPost
    });
}));

// ====================================================================
// AUTH (Plan 2)
// ====================================================================
const authService = require('./cloud/authService');

// Plan 2 Task 11: sync hooks — schedule cloud pushes on local writes
// NOTE: Individual POST/PUT/DELETE endpoints are not yet instrumented with
// _syncHooks.notifySync() — that's a follow-up. The hooks infra is wired and
// pushPending (called periodically + after login) still flushes pending writes.
const { startSyncHooks } = require('./cloud/syncHooks');
const _syncHooks = startSyncHooks(db, () => authService.getStoredSession()?.access_token || null);

app.post('/api/auth/login', asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'email and password required' });
    }
    const result = await authService.login(email, password);
    if (!result.ok) {
        const status = result.reason === 'invalid_credentials' ? 401
                     : result.reason === 'network_error' ? 503
                     : result.reason === 'not_configured' ? 503
                     : 400;
        return res.status(status).json({ ok: false, reason: result.reason, error: result.message });
    }

    // Plan 2 Task 8: claim the device slot
    const { claimDevice, startHeartbeat, subscribeKick } = require('./cloud/deviceGuard');
    const claim = await claimDevice(result.session.access_token);
    if (!claim.ok) {
        // Login succeeded but claim failed — log out + return error
        await authService.logout();
        const status = claim.reason === 'not_configured' ? 503 : 503;
        return res.status(status).json({
            ok: false, reason: 'device_claim_failed', error: claim.message
        });
    }

    // Start heartbeat
    startHeartbeat(
        () => authService.getStoredSession()?.access_token || null,
        5 * 60 * 1000,
        (reason) => console.warn('[deviceGuard] heartbeat issue:', reason)
    );

    // Subscribe to kick signal — fires when another device takes the slot OR
    // admin force-logs this device out (deletes the user_devices row).
    subscribeKick(result.user.id, result.session.access_token, claim.session_token, async (reason) => {
        console.warn('[deviceGuard] received kick signal:', reason, '— closing browsers + logging out');
        try {
            const browserManager = require('./core/browserManager');
            await browserManager.closeAll();
        } catch (e) {
            console.error('[deviceGuard] closeAll failed:', e.message);
        }
        const { stopHeartbeat, unsubscribeKick } = require('./cloud/deviceGuard');
        stopHeartbeat();
        unsubscribeKick();
        await authService.logout();
        try { io.emit('auth:kicked', { reason: reason || 'another_device_signed_in' }); } catch {}
    });

    // Plan 2 Task 12: initial pull from cloud (LWW merge into local)
    try {
        const { pullAll, pushPending } = require('./cloud/syncEngine');
        const pullResult = await pullAll(db, result.session.access_token);
        console.log('[sync] initial pull:', JSON.stringify(pullResult));
        // Push any pending local writes that didn't sync before login
        await pushPending(db, result.session.access_token);
    } catch (e) {
        console.warn('[sync] initial sync error (non-fatal):', e.message);
    }

    res.json({
        ok: true,
        user: result.user,
        is_takeover: claim.is_takeover
    });
}));

app.post('/api/auth/logout', asyncHandler(async (req, res) => {
    const { stopHeartbeat, unsubscribeKick } = require('./cloud/deviceGuard');
    stopHeartbeat();
    unsubscribeKick();
    await authService.logout();
    res.json({ ok: true });
}));

app.get('/api/auth/status', (req, res) => {
    // DEV ONLY: KINTENSHAUTO_SKIP_AUTH=1 bypasses Supabase login for local
    // development so the UI skips the LoginScreen. Never set in a packaged build.
    if (process.env.KINTENSHAUTO_SKIP_AUTH === '1') {
        return res.json({
            logged_in: true,
            user: { id: 'dev-local', email: 'dev@local' },
            expires_at: null,
            dev_bypass: true
        });
    }
    const session = authService.getStoredSession();
    if (!session) return res.json({ logged_in: false });
    res.json({
        logged_in: true,
        user: { id: session.user?.id, email: session.user?.email },
        expires_at: session.expires_at
    });
});

app.post('/api/auth/refresh', asyncHandler(async (req, res) => {
    const result = await authService.refresh();
    if (!result.ok) {
        return res.status(401).json({ ok: false, reason: result.reason });
    }
    res.json({ ok: true });
}));

// Plan 2 Task 13: cloud version check. Runs unauthenticated too — the desktop
// app polls this on startup BEFORE login, so users see force-update prompts
// without having to authenticate (otherwise a force-update could lock them out).
app.get('/api/version/check', asyncHandler(async (req, res) => {
    const session = authService.getStoredSession();
    const { checkVersion } = require('./cloud/updateChecker');
    const pkg = require('../../package.json');
    const result = await checkVersion(session?.access_token || null, pkg.version);
    res.json(result);
}));

// ====================================================================
// REQUIRE AUTH MIDDLEWARE (Plan 2)
// Blocks /api/* unless a local Supabase session exists.
// Exempt: /api/health, /api/auth/*, /api/version/*
// ====================================================================
app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (req.path === '/api/health'
        || req.path.startsWith('/api/auth/')
        || req.path.startsWith('/api/version/')) {
        return next();
    }
    // DEV ONLY: KINTENSHAUTO_SKIP_AUTH=1 lets the local API work without a
    // Supabase session (paired with the /api/auth/status bypass above).
    if (process.env.KINTENSHAUTO_SKIP_AUTH === '1') {
        req.user = { id: 'dev-local', email: 'dev@local' };
        req.accessToken = null;
        return next();
    }
    const session = authService.getStoredSession();
    if (!session) {
        return res.status(401).json({ error: 'login required', code: 'NO_SESSION' });
    }
    req.user = session.user;
    req.accessToken = session.access_token;
    next();
});

// ====================================================================
// PROFILES
// ====================================================================
// Multi-platform support: profiles can be FB / X / Instagram.
// Pass ?platform=facebook|x|instagram to filter; omit for all platforms.
app.get('/api/profiles', (req, res) => {
    const { platform } = req.query;
    let rows;
    if (platform) {
        rows = db.prepare(`
            SELECT id, name, platform, account_handle, fb_username, proxy_host, proxy_port, status, last_login_at
            FROM profiles WHERE platform = ? ORDER BY id
        `).all(platform);
    } else {
        rows = db.prepare(`
            SELECT id, name, platform, account_handle, fb_username, proxy_host, proxy_port, status, last_login_at
            FROM profiles ORDER BY id
        `).all();
    }
    res.json(rows);
});

app.post('/api/profiles', asyncHandler(async (req, res) => {
    const {
        platform: rawPlatform,
        name,
        fb_username, fb_password, fb_2fa_secret,
        account_handle,
        proxy_host, proxy_port, proxy_user, proxy_pass
    } = req.body;

    const { SUPPORTED_PLATFORMS, getUserDataPrefix } = require('./services/platformConfig');
    const platform = SUPPORTED_PLATFORMS.includes(rawPlatform) ? rawPlatform : 'facebook';

    // Validation rules differ by platform.
    // FB: requires fb_username + fb_password (legacy — unchanged).
    // X / Instagram: only `name` is required; user logs in manually via Chrome.
    if (!name) throw badRequest('กรอกชื่อกำกับเฟส/บัญชี');
    if (platform === 'facebook') {
        if (!fb_username || !fb_password) {
            throw badRequest('กรอกข้อมูลไม่ครบ (ชื่อเรียก, อีเมล/เบอร์เฟส, รหัสผ่าน)');
        }
    }

    // Use platform-specific dir prefix so file system clearly shows which profile is which.
    // FB legacy prefix stays as 'profile' → existing FB rows/dirs unchanged.
    const prefix = getUserDataPrefix(platform);
    const userDataDir = path.join(CHROME_PROFILES, `${prefix}_${Date.now()}`);
    fs.mkdirSync(userDataDir, { recursive: true });

    // For non-FB platforms, store placeholder empty strings so NOT NULL constraints don't trip.
    // These columns are FB-specific and unused for X/IG (login is manual via Chrome only).
    const finalFbUsername = fb_username || (platform === 'facebook' ? '' : `_${platform}_${Date.now()}`);
    const finalFbPassword = fb_password ? encrypt(fb_password) : encrypt('');
    const final2fa = fb_2fa_secret ? encrypt(fb_2fa_secret) : null;

    const stmt = db.prepare(`
        INSERT INTO profiles (name, platform, account_handle, fb_username, fb_password, fb_2fa_secret,
                              proxy_host, proxy_port, proxy_user, proxy_pass, user_data_dir)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
        name, platform, account_handle || null,
        finalFbUsername, finalFbPassword, final2fa,
        proxy_host || null, proxy_port ? Number(proxy_port) : null, proxy_user || null,
        proxy_pass ? encrypt(proxy_pass) : null,
        userDataDir
    );
    res.json({ id: result.lastInsertRowid, platform, ok: true });
}));

app.delete('/api/profiles/:id', (req, res) => {
    const profile = db.prepare('SELECT user_data_dir FROM profiles WHERE id = ?').get(req.params.id);
    db.prepare(`DELETE FROM profiles WHERE id = ?`).run(req.params.id);
    // Keep the Chrome profile directory — user may re-add later; only delete if they explicitly ask
    res.json({ ok: true });
});

// ====================================================================
// PROXY POOL — bulk paste + distribute Thai proxies, 1 per account
// ====================================================================
const proxyPool = require('./services/proxyPool');

// Preview what a pasted blob parses to (no DB writes).
app.post('/api/proxies/parse-preview', asyncHandler(async (req, res) => {
    const { text } = req.body;
    const { proxies, invalid } = proxyPool.parse(text || '');
    res.json({ count: proxies.length, proxies: proxies.map(p => ({
        scheme: p.scheme, host: p.host, port: p.port, hasAuth: !!p.user,
    })), invalid });
}));

// Persist one parsed proxy onto a profile row (encrypts the password).
function _writeProxyToProfile(accountId, proxy) {
    db.prepare(`
        UPDATE profiles
           SET proxy_type = ?, proxy_host = ?, proxy_port = ?, proxy_user = ?, proxy_pass = ?
         WHERE id = ?
    `).run(
        proxy.scheme, proxy.host, proxy.port,
        proxy.user || null,
        proxy.pass ? encrypt(proxy.pass) : null,
        accountId
    );
}

app.post('/api/proxies/distribute', asyncHandler(async (req, res) => {
    const { text, onlyMissing = true } = req.body;
    const { proxies, invalid } = proxyPool.parse(text || '');

    // When test !== false, filter out dead/non-Thai proxies before distributing.
    let pool = proxies;
    let badProxies = [];
    if (req.body.test !== false) {
        const tested = await Promise.all(proxies.map(async p => ({ p, r: await proxyPool.testProxy(p) })));
        pool = tested.filter(x => x.r.alive && x.r.isThai).map(x => x.p);
        badProxies = tested.filter(x => !(x.r.alive && x.r.isThai)).map(x => ({ host: x.p.host, ...x.r }));
    }

    const rows = db.prepare(`SELECT id, proxy_host FROM profiles ORDER BY id`).all();
    const accounts = rows.map(r => ({ id: r.id, hasProxy: !!r.proxy_host }));

    const result = proxyPool.distribute(pool, accounts, { onlyMissing });
    for (const a of result.assignments) _writeProxyToProfile(a.accountId, a.proxy);

    // Keep leftovers in the pool for future accounts.
    const poolStmt = db.prepare(`
        INSERT OR IGNORE INTO proxy_pool (scheme, host, port, proxy_user, proxy_pass)
        VALUES (?, ?, ?, ?, ?)
    `);
    for (const p of result.leftover) {
        poolStmt.run(p.scheme, p.host, p.port, p.user || null, p.pass ? encrypt(p.pass) : null);
    }

    res.json({
        assigned: result.assignments.length,
        shortBy: result.shortBy,
        uncovered: result.uncovered,
        leftover: result.leftover.length,
        badProxies: badProxies.length,
        invalid,
    });
}));

const https = require('https');

// Read this machine's REAL public IP directly (no proxy) — leak-test baseline.
function _directPublicIp() {
    return new Promise((resolve) => {
        https.get('https://api.ipify.org?format=json', (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d).ip); } catch { resolve(null); } });
        }).on('error', () => resolve(null));
    });
}

app.post('/api/proxies/test', asyncHandler(async (req, res) => {
    const { text, _mock } = req.body;
    const { proxies } = proxyPool.parse(text || '');
    const results = [];
    for (const p of proxies) {
        // TEST-ONLY shortcut (only honored under the dev bypass) to avoid live network in CI.
        const r = (_mock && process.env.KINTENSHAUTO_SKIP_AUTH === '1')
            ? _mock
            : await proxyPool.testProxy(p);
        results.push({ host: p.host, port: p.port, ...r });
    }
    res.json({ results });
}));

// Prove FB will see a Thai IP for this profile, not the VPN/real IP.
app.get('/api/proxies/leak-test/:id', asyncHandler(async (req, res) => {
    const row = db.prepare(`SELECT proxy_type, proxy_host, proxy_port, proxy_user, proxy_pass FROM profiles WHERE id = ?`).get(req.params.id);
    if (!row || !row.proxy_host) return res.json({ ok: false, reason: 'no_proxy' });
    const proxy = {
        scheme: row.proxy_type || 'http', host: row.proxy_host, port: row.proxy_port,
        user: row.proxy_user || null, pass: row.proxy_pass ? decrypt(row.proxy_pass) : null,
    };
    const [vpnIp, t] = await Promise.all([_directPublicIp(), proxyPool.testProxy(proxy)]);
    res.json({
        ok: t.alive,
        vpnIp,
        browserIp: t.ip || null,
        browserCountry: t.country || null,
        isThai: !!t.isThai,
        hidesVpn: !!(t.ip && vpnIp && t.ip !== vpnIp),
        error: t.error || null,
    });
}));

// Per-profile locks so duplicate clicks don't spawn duplicate Chromes / tabs
const fetchPagesInFlight = new Map();   // profileId -> Promise

// Auto-fetch pages from FB "your pages" bookmark
app.post('/api/profiles/:id/fetch-pages', asyncHandler(async (req, res) => {
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
    if (!profile) throw notFound('ไม่พบบัญชีเฟสที่เลือก (อาจถูกลบไปแล้ว)');

    // If a fetch is already running for this profile, wait for it instead of starting another
    if (fetchPagesInFlight.has(profile.id)) {
        const existing = await fetchPagesInFlight.get(profile.id);
        return res.json({ ...existing, deduped: true });
    }

    const browserManager = require('./core/browserManager');
    const { fetchManagedPages } = require('./core/poster');

    const task = (async () => {
        let browser;
        try {
            browser = await browserManager.getBrowser(profile);
        } catch (e) {
            throw new Error('เปิด Chrome ล้มเหลว: ' + e.message);
        }

        const fetchResult = await fetchManagedPages(browser, m => console.log('[fetch-pages]', m));
        if (!fetchResult.success) {
            const err = new Error(fetchResult.message || fetchResult.reason);
            err.status = 400; err.code = fetchResult.reason;
            throw err;
        }

        // Insert pages (skip existing by profile+page_id)
        const insert = db.prepare(`
            INSERT INTO pages (profile_id, fb_page_id, name, daily_quota, cooldown_min, niche)
            VALUES (?, ?, ?, 5, 30, NULL)
        `);
        const existsStmt = db.prepare(`SELECT id FROM pages WHERE profile_id = ? AND fb_page_id = ?`);
        const inserted = [];
        const skipped = [];
        for (const p of fetchResult.pages) {
            const exists = existsStmt.get(profile.id, p.fb_page_id);
            if (exists) { skipped.push(p.name); continue; }
            try {
                const r = insert.run(profile.id, p.fb_page_id, p.name);
                db.prepare('INSERT OR IGNORE INTO comment_settings (page_id) VALUES (?)').run(r.lastInsertRowid);
                inserted.push(p.name);
            } catch (e) {
                console.error('[fetch-pages] insert failed:', e.message);
            }
        }

        db.prepare(`UPDATE profiles SET status = 'active', last_login_at = datetime('now', 'localtime') WHERE id = ?`).run(profile.id);

        return {
            ok: true,
            found: fetchResult.pages.length,
            inserted: inserted.length,
            skipped: skipped.length,
            insertedNames: inserted,
            skippedNames: skipped
        };
    })();

    fetchPagesInFlight.set(profile.id, task);
    try {
        const out = await task;
        res.json(out);
    } finally {
        fetchPagesInFlight.delete(profile.id);
    }
}));

// (legacy inline fetch-pages block removed — use the locked handler above)

// Check if Chrome is open for this profile + session backup status + count cookies
// Platform-aware: uses profile.platform to pick the right login-cookie indicators
app.get('/api/profiles/:id/browser-status', (req, res) => {
    const browserManager = require('./core/browserManager');
    const { getPlatformConfig } = require('./services/platformConfig');
    const profileRow = db.prepare('SELECT platform FROM profiles WHERE id = ?').get(req.params.id);
    const platform = profileRow?.platform || 'facebook';
    const loginCookieNames = getPlatformConfig(platform).loginCookieNames;

    const backup = db.prepare(`
        SELECT last_verified_at, cookies_json, length(cookies_json) as size
        FROM session_cookies WHERE profile_id = ?
    `).get(req.params.id);
    let count = 0, hasLoginCookies = false;
    if (backup && backup.cookies_json) {
        try {
            const cookies = JSON.parse(backup.cookies_json);
            if (Array.isArray(cookies)) {
                count = cookies.length;
                const names = new Set(cookies.map(c => c.name));
                hasLoginCookies = loginCookieNames.every(n => names.has(n));
            }
        } catch (e) {
            console.warn('[browser-status] cookies_json parse failed:', e.message);
        }
    }
    res.json({
        open: browserManager.isOpen(Number(req.params.id)),
        platform,
        backup: backup ? {
            last_saved_at: backup.last_verified_at,
            size: backup.size,
            count,
            logged_in: hasLoginCookies
        } : null
    });
});

// Sync cookies from Chrome's userDataDir into our DB.
// Use case: user logged in via plain Chrome (no Puppeteer) — Chrome saved cookies
// to disk, but our DB doesn't know yet. This launches a headless Puppeteer Chrome
// briefly with the same userDataDir, reads cookies, saves to DB, closes.
app.post('/api/profiles/:id/sync-cookies', asyncHandler(async (req, res) => {
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
    if (!profile) throw notFound('ไม่พบบัญชีเฟส');

    const browserManagerLocal = require('./core/browserManager');
    const { launchForProfile, backupCookiesToDb } = require('./core/poster');

    // If our managed Chrome is already open, just back up — done
    const existing = browserManagerLocal.browsers.get(profile.id);
    if (existing && existing.isConnected && existing.isConnected()) {
        const r = await backupCookiesToDb(db, profile.id, existing);
        return res.json({ ok: true, mode: 'existing-browser', saved: r.saved });
    }

    // Otherwise: spin up a brief headless puppeteer Chrome that reads disk cookies + writes them to DB
    let browser;
    try {
        browser = await launchForProfile(profile, { headless: true });
    } catch (e) {
        throw new Error('เปิด Chrome (background) ล้มเหลว: ' + e.message + ' — ปิด Chrome อื่นที่ใช้ profile นี้ก่อน');
    }

    try {
        // Open one page so the cookie store is fully populated — navigate to the platform's home
        const { getPlatformConfig } = require('./services/platformConfig');
        const platform = profile.platform || 'facebook';
        const platformCfg = getPlatformConfig(platform);
        const page = await browser.newPage();
        await page.goto(platformCfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1500));

        const result = await backupCookiesToDb(db, profile.id, browser, platform);

        // Verify by reading back — use platform-specific login cookie names
        const row = db.prepare('SELECT cookies_json FROM session_cookies WHERE profile_id = ?').get(profile.id);
        let hasLogin = false;
        if (row && row.cookies_json) {
            try {
                const cookies = JSON.parse(row.cookies_json);
                if (Array.isArray(cookies)) {
                    const names = new Set(cookies.map(c => c.name));
                    hasLogin = platformCfg.loginCookieNames.every(n => names.has(n));
                }
            } catch (e) {
                console.warn('[sync-cookies] parse failed:', e.message);
            }
        }

        if (hasLogin) {
            db.prepare(`UPDATE profiles SET status = 'active', last_login_at = datetime('now', 'localtime') WHERE id = ?`).run(profile.id);
        }

        res.json({ ok: true, mode: 'headless-sync', saved: result.saved, logged_in: hasLogin });
    } finally {
        try { await browser.close(); } catch {}
    }
}));

// Manual "save session now" — useful right after login to lock in cookies
app.post('/api/profiles/:id/save-session', asyncHandler(async (req, res) => {
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
    if (!profile) throw notFound('ไม่พบบัญชีเฟส');
    const { backupCookiesToDb } = require('./core/poster');
    const browserManager = require('./core/browserManager');
    const browser = browserManager.browsers.get(profile.id);
    if (!browser) {
        return res.status(400).json({ error: 'Chrome ยังไม่ได้เปิด — กด "เปิด Chrome" ก่อน' });
    }
    const result = await backupCookiesToDb(db, profile.id, browser);
    res.json({ ok: true, saved: result.saved, error: result.error });
}));

// Close Chrome for this profile (user-triggered — Chrome flushes cookies on clean close)
app.post('/api/profiles/:id/close-browser', asyncHandler(async (req, res) => {
    const browserManager = require('./core/browserManager');
    await browserManager.closeBrowser(Number(req.params.id));
    res.json({ ok: true });
}));

// Login Chrome (plain) — no Puppeteer, platform doesn't detect automation → login succeeds + cookies persist
// startUrl auto-resolved from profile.platform (FB → facebook.com, X → x.com, IG → instagram.com)
app.post('/api/profiles/:id/login-chrome', asyncHandler(async (req, res) => {
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
    if (!profile) throw notFound('ไม่พบบัญชีเฟส');

    const browserManager = require('./core/browserManager');

    // If our Puppeteer-controlled Chrome is already running for this profile, close it first
    // (Chrome won't let two processes share the same userDataDir).
    if (browserManager.isOpen(profile.id)) {
        await browserManager.closeBrowser(profile.id);
        await new Promise(r => setTimeout(r, 500));
    }

    const { launchPlainChromeForLogin } = require('./core/poster');
    const { getPlatformConfig } = require('./services/platformConfig');
    const platform = profile.platform || 'facebook';
    const startUrl = getPlatformConfig(platform).loginUrl;
    try {
        const info = launchPlainChromeForLogin(profile, { startUrl });
        db.prepare(`UPDATE profiles SET status = 'active' WHERE id = ?`).run(profile.id);
        res.json({ ok: true, pid: info.pid, platform, startUrl, message: `เปิด Chrome (${getPlatformConfig(platform).label}) สำหรับ login แล้ว — ปิด Chrome เองหลัง login เสร็จ` });
    } catch (e) {
        throw new Error('เปิด Chrome ล้มเหลว: ' + e.message);
    }
}));

// Auto-login: launch Puppeteer-controlled Chrome, autofill email + password,
// click Login, then hand the window back to the user so they can complete
// 2FA / CAPTCHA / device confirmation themselves.
//
// Only valid for FB profiles with stored credentials. The autofill happens
// via DevTools Protocol on the user's real userDataDir, so cookies set by
// FB after a successful login persist on disk (next session = already logged
// in). We deliberately do NOT close the Chrome window after submitting the
// form — closing would interrupt 2FA/checkpoint flows.
//
// Returns immediately after launching the browser. The actual fill+click
// runs in the background and result is emitted via socket.io 'login:status'.
app.post('/api/profiles/:id/auto-login', asyncHandler(async (req, res) => {
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
    if (!profile) throw notFound('ไม่พบบัญชีเฟส');
    if ((profile.platform || 'facebook') !== 'facebook') {
        throw badRequest('Auto-login รองรับเฉพาะ Facebook (สำหรับ X / Instagram ใช้ "เปิด Chrome" แล้ว login เอง)');
    }
    if (!profile.fb_username) throw badRequest('บัญชีนี้ไม่มีอีเมล/เบอร์โทร — แก้ไขก่อน');
    if (!profile.fb_password) throw badRequest('บัญชีนี้ไม่มีรหัสผ่าน — แก้ไขก่อน');

    const password = decrypt(profile.fb_password);
    if (!password) throw new Error('ถอดรหัสรหัสผ่านไม่สำเร็จ — รหัสอาจถูกบันทึกผิดรอบ');

    // Kick off in background — Chrome takes 2–4s to spawn + connect, and we
    // don't want the user to wait on the modal closing. They'll see the
    // Chrome window pop up shortly.
    (async () => {
        try {
            const browserManager = require('./core/browserManager');
            const browser = await browserManager.getBrowser(profile);
            const pages = await browser.pages();
            const page = pages[0] || await browser.newPage();
            try { await page.bringToFront(); } catch {}

            // Mobile UA → FB serves the leaner mbasic markup with stable
            // input[name=email] / input[name=pass] / button[name=login]
            // selectors. Without this, desktop FB renders a JS-heavy form
            // where the input fields render asynchronously and selectors
            // can time out before the React hydration completes.
            const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 10; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
            try { await page.setUserAgent(MOBILE_UA); } catch {}

            await page.goto('https://m.facebook.com/login.php', {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            // Give FB ~2s to fully render and run its redirects. Old cookies
            // may bump the page to /home, /save-device, /checkpoint, or
            // straight to the user's home — handle all those.
            await new Promise(r => setTimeout(r, 2000));

            const earlyUrl = page.url();
            const alreadyLoggedIn = !/\/(login|recover|reg)/i.test(earlyUrl)
                && !(/login\.php/.test(earlyUrl));
            if (alreadyLoggedIn) {
                db.prepare(`UPDATE profiles SET status = 'logged_in', last_login_at = datetime('now', 'localtime') WHERE id = ?`)
                  .run(profile.id);
                io.emit('login:status', {
                    profileId: profile.id, platform: 'facebook',
                    ok: true, already_logged_in: true, url: earlyUrl,
                    message: 'มี session อยู่แล้ว — login ผ่าน cookies เดิม · ปิด Chrome ให้อัตโนมัติ'
                });
                // Auto-close: no user interaction was needed
                await new Promise(r => setTimeout(r, 1500));
                try { await browserManager.closeBrowser(profile.id); } catch {}
                return;
            }

            // Wait for any of several email-input variants to appear
            const EMAIL_SELECTORS = [
                'input[name="email"]',
                'input#email',
                'input[id="m_login_email"]',
                'input[type="email"]'
            ];
            const PASS_SELECTORS = [
                'input[name="pass"]',
                'input#pass',
                'input[id="m_login_password"]',
                'input[type="password"]'
            ];
            const SUBMIT_SELECTORS = [
                'button[name="login"]',
                'button[type="submit"]',
                '#login_form button',
                '#login_password_step_element button',
                'input[type="submit"][value*="Log"]'
            ];

            const findFirst = async (selectors, timeoutEach = 4000) => {
                for (const s of selectors) {
                    try {
                        await page.waitForSelector(s, { timeout: timeoutEach });
                        return s;
                    } catch {}
                }
                return null;
            };

            const emailSel = await findFirst(EMAIL_SELECTORS);
            if (!emailSel) {
                // Couldn't find login form on a /login URL — could be a
                // partial-cookies state where FB shows "use saved account"
                // instead. Don't error out; leave the window for the user.
                throw new Error('ไม่เจอ field email บนหน้า login (อาจอยู่ใน save-device flow) — กรอกเองใน Chrome');
            }
            const passSel = await findFirst(PASS_SELECTORS, 2000);

            // Clear + type credentials
            await page.evaluate((es, ps) => {
                const e = document.querySelector(es);
                if (e) { e.value = ''; e.focus(); }
                const p = ps && document.querySelector(ps);
                if (p) p.value = '';
            }, emailSel, passSel);
            await page.type(emailSel, profile.fb_username, { delay: 30 });
            if (passSel) await page.type(passSel, password, { delay: 30 });

            // Click whatever submit button exists
            const submitSel = await findFirst(SUBMIT_SELECTORS, 1500);
            await Promise.all([
                page.waitForNavigation({ timeout: 20000 }).catch(() => null),
                submitSel
                    ? page.click(submitSel).catch(() => {})
                    : page.keyboard.press('Enter').catch(() => {})
            ]);

            // Let 2FA / checkpoint page render
            await new Promise(r => setTimeout(r, 2000));

            const finalUrl = page.url();
            const needsExtraStep = /checkpoint|two_step|two-factor|two_factor|confirm|save-device|approvals/.test(finalUrl)
                || (await page.$('input[name="approvals_code"]').catch(() => null)) != null;
            const stillOnLogin = /\/login(\.php)?\//.test(finalUrl) || /\/login(\.php)?$/.test(finalUrl);

            let status, ok, message, autoClose;
            if (needsExtraStep) {
                status = 'needs_2fa'; ok = false; autoClose = false;
                message = 'กรอก email + รหัสผ่านให้แล้ว — Facebook ขอ verify (2FA / device confirm) ทำต่อใน Chrome';
            } else if (stillOnLogin) {
                status = 'login_failed'; ok = false; autoClose = false;
                message = 'login ไม่ผ่าน — รหัสผิด หรือบัญชีโดน lock — ลองกรอกเองใน Chrome';
            } else {
                status = 'logged_in'; ok = true; autoClose = true;
                message = 'login สำเร็จ — ปิด Chrome อัตโนมัติแล้ว';
            }

            db.prepare(`UPDATE profiles SET status = ?, last_login_at = datetime('now', 'localtime') WHERE id = ?`)
              .run(status, profile.id);
            io.emit('login:status', { profileId: profile.id, platform: 'facebook',
                ok, needs_2fa: needsExtraStep, url: finalUrl, message });

            // Auto-close on success only — 2FA / login_failed leaves the window
            // open so the user can finish manually. Wait ~2.5s so the post-login
            // cookies have time to commit to disk before we tear down Chrome.
            if (autoClose) {
                await new Promise(r => setTimeout(r, 2500));
                try { await browserManager.closeBrowser(profile.id); } catch {}
            }
        } catch (e) {
            console.error('[auto-login] failed for profile', profile.id, ':', e.message);
            db.prepare(`UPDATE profiles SET status = 'login_failed' WHERE id = ?`).run(profile.id);
            io.emit('login:status', {
                profileId: profile.id,
                platform: 'facebook',
                ok: false,
                error: e.message,
                message: 'auto-login ล้มเหลว: ' + e.message + ' — login เองในหน้าต่าง Chrome'
            });
        }
    })();

    res.json({
        ok: true,
        message: 'กำลังเปิด Chrome + กรอกข้อมูลให้... รอ 3-5 วินาที — ถ้ามี 2FA ทำต่อในหน้าต่าง Chrome'
    });
}));

// "Test login" — open Chrome (or focus existing) for user to verify session
app.post('/api/profiles/:id/test-login', asyncHandler(async (req, res) => {
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
    if (!profile) throw notFound('ไม่พบบัญชีเฟสที่เลือก (อาจถูกลบไปแล้ว)');

    const browserManager = require('./core/browserManager');
    const { isLoggedIn } = require('./core/poster');

    browserManager.getBrowser(profile).then(async (browser) => {
        const page = await browser.newPage();
        const platform = profile.platform || 'facebook';
        const status = await isLoggedIn(page, platform);
        io.emit('login:status', { profileId: profile.id, platform, ...status });
        db.prepare(`UPDATE profiles SET status = ?, last_login_at = datetime('now', 'localtime') WHERE id = ?`)
          .run(status.ok ? 'active' : 'checkpoint', profile.id);
        // Keep browser open so user can login manually if needed; don't close the page either.
    }).catch(e => {
        console.error('[test-login] failed:', e.message);
        io.emit('login:status', { profileId: profile.id, ok: false, reason: 'launch_failed', message: e.message });
    });

    res.json({ ok: true, message: 'Chrome พร้อมใช้งาน — ถ้ายังไม่ login ให้ login ในหน้าต่างนั้น แล้วกดปุ่มอื่นต่อได้เลย' });
}));

// ====================================================================
// PAGES
// ====================================================================
app.get('/api/pages', (req, res) => {
    const rows = db.prepare(`
        SELECT p.*, pr.name as profile_name,
               (SELECT COUNT(*) FROM session_cookies sc WHERE sc.profile_id = p.profile_id) AS has_session,
               (SELECT MAX(last_verified_at) FROM session_cookies sc WHERE sc.profile_id = p.profile_id) AS session_verified_at,
               (SELECT MAX(finished_at) FROM jobs j WHERE j.page_id = p.id AND j.status = 'posted') AS last_post_at
        FROM pages p LEFT JOIN profiles pr ON pr.id = p.profile_id
        WHERE p.enabled = 1 ORDER BY p.created_at DESC
    `).all();
    res.json(rows);
});

app.post('/api/pages', asyncHandler(async (req, res) => {
    const { profile_id, fb_page_id, name, daily_quota, cooldown_min, niche, default_keyword } = req.body;
    if (!profile_id || !fb_page_id || !name) throw badRequest('กรอกข้อมูลเพจไม่ครบ (บัญชีเฟส, รหัสเพจ, ชื่อเพจ)');

    const stmt = db.prepare(`
        INSERT INTO pages (profile_id, fb_page_id, name, daily_quota, cooldown_min, niche, default_keyword)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
        profile_id, fb_page_id, name,
        daily_quota || 5, cooldown_min || 30,
        niche || null,
        (default_keyword && String(default_keyword).trim()) || null
    );

    // Also create default comment_settings
    db.prepare(`
        INSERT OR IGNORE INTO comment_settings (page_id) VALUES (?)
    `).run(result.lastInsertRowid);

    res.json({ id: result.lastInsertRowid });
}));

app.delete('/api/pages/:id', (req, res) => {
    db.prepare(`DELETE FROM pages WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
});

// Bulk delete pages (for cleaning up bad fetch-pages results)
app.post('/api/pages/bulk-delete', asyncHandler(async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) throw badRequest('ยังไม่ได้เลือกรายการที่จะดำเนินการ');
    // ✅ FIX H3: cap input — SQLite default param limit = 999
    if (ids.length > 500) throw badRequest('เลือกได้สูงสุด 500 รายการต่อครั้ง');
    const placeholders = ids.map(() => '?').join(',');
    const result = db.prepare(`DELETE FROM pages WHERE id IN (${placeholders})`).run(...ids);
    res.json({ ok: true, deleted: result.changes });
}));

app.put('/api/pages/:id', asyncHandler(async (req, res) => {
    const allowed = ['name', 'daily_quota', 'cooldown_min', 'niche', 'enabled', 'avatar_url',
                     'posts_per_session', 'session_interval_hours', 'default_keyword', 'post_times'];
    const updates = [];
    const values = [];
    for (const k of allowed) {
        if (!(k in req.body)) continue;
        let v = req.body[k];
        // post_times accepts an array → stored as JSON string. Validate each entry is "HH:MM".
        if (k === 'post_times') {
            if (Array.isArray(v)) {
                const re = /^([01]\d|2[0-3]):[0-5]\d$/;
                v = v.filter(t => typeof t === 'string' && re.test(t)).slice(0, 24);
                v = JSON.stringify(v);
            } else if (typeof v !== 'string') {
                continue;
            }
        }
        updates.push(`${k} = ?`);
        values.push(v);
    }
    if (!updates.length) return res.json({ ok: true });
    values.push(req.params.id);
    db.prepare(`UPDATE pages SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    res.json({ ok: true });
}));

// ====================================================================
// BANNERS (upload/list/delete)
// ====================================================================
app.get('/api/banners', (req, res) => {
    res.json(db.prepare(`SELECT * FROM banners ORDER BY created_at DESC`).all());
});

app.post('/api/banners', asyncHandler(async (req, res) => {
    const { name, data_base64, width, height } = req.body;
    if (!data_base64) throw badRequest('ไม่มีข้อมูลรูปภาพที่อัปโหลด');
    const buf = Buffer.from(data_base64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const filename = `banner_${Date.now()}.png`;
    const filePath = path.join(OVERLAYS_DIR, filename);
    fs.writeFileSync(filePath, buf);
    const result = db.prepare(`INSERT INTO banners (name, file_path, width_px, height_px) VALUES (?, ?, ?, ?)`)
                     .run(name || filename, filePath, width || null, height || null);
    res.json({ id: result.lastInsertRowid, file_path: filePath });
}));

app.delete('/api/banners/:id', (req, res) => {
    const b = db.prepare('SELECT file_path FROM banners WHERE id = ?').get(req.params.id);
    if (b && b.file_path && fs.existsSync(b.file_path)) {
        try { fs.unlinkSync(b.file_path); } catch {}
    }
    db.prepare('DELETE FROM banners WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
});

// ====================================================================
// BANNER PRESETS
// ====================================================================
app.get('/api/banner-presets', (req, res) => {
    res.json(bannerPresets.listPresets());
});

app.post('/api/banner-presets', asyncHandler(async (req, res) => {
    const { name, layers } = req.body;
    if (!name || !Array.isArray(layers)) throw badRequest('กรอกข้อมูลชุดแบนเนอร์ไม่ครบ (ต้องมีชื่อชุด + ชั้นแบนเนอร์อย่างน้อย 1 ชั้น)');
    const id = bannerPresets.savePreset(name, layers);
    res.json({ id });
}));

app.put('/api/banner-presets/:id', asyncHandler(async (req, res) => {
    const { name, layers } = req.body;
    bannerPresets.updatePreset(req.params.id, name, layers);
    res.json({ ok: true });
}));

app.delete('/api/banner-presets/:id', (req, res) => {
    bannerPresets.deletePreset(req.params.id);
    res.json({ ok: true });
});

// ====================================================================
// COMMENT TEMPLATES
// ====================================================================
app.get('/api/comment-templates', (req, res) => {
    const pageId = req.query.page_id;
    const rows = pageId
        ? commentEngine.listTemplates(pageId)
        : db.prepare(`SELECT * FROM comment_templates ORDER BY created_at DESC`).all();
    res.json(rows);
});

app.post('/api/comment-templates', asyncHandler(async (req, res) => {
    const { page_id, label, content, weight } = req.body;
    const id = commentEngine.addTemplate(page_id || null, label, content, weight);
    res.json({ id });
}));

app.put('/api/comment-templates/:id', asyncHandler(async (req, res) => {
    commentEngine.updateTemplate(req.params.id, req.body);
    res.json({ ok: true });
}));

app.delete('/api/comment-templates/:id', (req, res) => {
    commentEngine.deleteTemplate(req.params.id);
    res.json({ ok: true });
});

app.post('/api/comment-templates/preview', (req, res) => {
    const { content, context } = req.body;
    res.json(commentEngine.preview(content, context));
});

// ====================================================================
// COMMENT SETTINGS (per page)
// ====================================================================
app.get('/api/comment-settings/:pageId', asyncHandler(async (req, res) => {
    let row = db.prepare('SELECT * FROM comment_settings WHERE page_id = ?').get(req.params.pageId);
    if (!row) {
        db.prepare('INSERT INTO comment_settings (page_id) VALUES (?)').run(req.params.pageId);
        row = db.prepare('SELECT * FROM comment_settings WHERE page_id = ?').get(req.params.pageId);
    }
    res.json(row);
}));

app.put('/api/comment-settings/:pageId', asyncHandler(async (req, res) => {
    const allowed = ['enabled', 'delay_sec', 'jitter_sec', 'max_per_day', 'cooldown_min', 'enable_self_reply', 'enable_pin', 'detect_removal'];
    const updates = [];
    const values = [];
    for (const k of allowed) if (k in req.body) { updates.push(`${k} = ?`); values.push(req.body[k]); }
    db.prepare('INSERT OR IGNORE INTO comment_settings (page_id) VALUES (?)').run(req.params.pageId);
    if (updates.length) {
        values.push(req.params.pageId);
        db.prepare(`UPDATE comment_settings SET ${updates.join(', ')} WHERE page_id = ?`).run(...values);
    }
    res.json({ ok: true });
}));

// ====================================================================
// AI PROVIDERS
// ====================================================================
app.get('/api/ai/providers', (req, res) => {
    res.json(captionService.listProviders());
});

app.post('/api/ai/providers', asyncHandler(async (req, res) => {
    const { provider, api_key, model, label } = req.body;
    if (!provider || !api_key || !model) throw badRequest('กรอกข้อมูล AI ไม่ครบ (ผู้ให้บริการ, API key, รุ่น AI)');
    const id = captionService.addProvider(provider, api_key, model, label || provider);
    res.json({ id });
}));

app.delete('/api/ai/providers/:id', (req, res) => {
    db.prepare('DELETE FROM ai_providers WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
});

// Test a provider with a small prompt
app.post('/api/ai/providers/:id/test', asyncHandler(async (req, res) => {
    const row = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(req.params.id);
    if (!row) throw notFound('ไม่พบ AI ที่เลือก (อาจถูกลบไปแล้ว)');
    const { createProvider } = require('./services/captionService');
    const provider = createProvider(row.provider, {
        apiKey: decrypt(row.api_key),
        model: row.model,
        label: row.label
    });
    const sample = await provider.generateCaption({
        systemPrompt: 'คุณเป็นผู้เขียนแคปชั่น Facebook Reel ภาษาไทยที่สั้นและกระชับ',
        userPrompt: 'เขียนแคปชั่น 1 บรรทัดโฆษณาคลิป "ซีรีส์จีน EP.1" (ยาว 60 วิ)',
        maxTokens: 100,
        temperature: 0.7
    });
    res.json({ ok: true, sample });
}));

// ====================================================================
// SIMPLIFIED API KEYS  (new preferred API — 1 key per provider, auto label)
// ====================================================================
// Returns which providers have a key configured (without exposing the key itself)
// and the default model the app will use for each.
const PROVIDER_DEFAULT_MODELS = {
    openai:    'gpt-4o-mini',
    anthropic: 'claude-haiku-4-5-20251001',
    gemini:    'gemini-2.5-flash'
};
const PROVIDER_LABELS = { openai: 'OpenAI', anthropic: 'Anthropic (Claude)', gemini: 'Google Gemini' };

app.get('/api/ai/keys', (req, res) => {
    const rows = db.prepare(`SELECT id, provider, model, label FROM ai_providers`).all();
    const out = {};
    for (const p of ['openai', 'anthropic', 'gemini']) {
        const row = rows.find(r => r.provider === p);
        out[p] = {
            configured: !!row,
            id: row?.id || null,
            model: row?.model || PROVIDER_DEFAULT_MODELS[p],
            label: PROVIDER_LABELS[p]
        };
    }
    out.primary = out.openai.configured ? 'openai'
                : out.anthropic.configured ? 'anthropic'
                : out.gemini.configured ? 'gemini'
                : null;
    res.json(out);
});

// Set or replace a single provider's key. Uses a fixed label per provider so
// repeated saves upsert cleanly (the UI doesn't have to care about IDs).
app.post('/api/ai/keys', asyncHandler(async (req, res) => {
    const { provider, api_key } = req.body;
    if (!['openai', 'anthropic', 'gemini'].includes(provider)) {
        throw badRequest('ผู้ให้บริการไม่ถูกต้อง (ต้องเป็น openai/anthropic/gemini)');
    }
    if (!api_key || typeof api_key !== 'string' || api_key.length < 10) {
        throw badRequest('กรอกรหัส API Key ให้ถูกต้อง');
    }
    const model = PROVIDER_DEFAULT_MODELS[provider];
    const label = PROVIDER_LABELS[provider];
    // Upsert: if a row exists for this provider, update it; otherwise insert
    const existing = db.prepare(`SELECT id FROM ai_providers WHERE provider = ? LIMIT 1`).get(provider);
    if (existing) {
        db.prepare(`UPDATE ai_providers SET api_key = ?, model = ?, label = ? WHERE id = ?`)
          .run(encrypt(api_key), model, label, existing.id);
        res.json({ ok: true, id: existing.id, updated: true });
    } else {
        const id = captionService.addProvider(provider, api_key, model, label);
        res.json({ ok: true, id, updated: false });
    }
}));

// Delete a provider's key (by provider name, not ID — easier for the simple UI)
app.delete('/api/ai/keys/:provider', (req, res) => {
    const p = req.params.provider;
    if (!['openai', 'anthropic', 'gemini'].includes(p)) {
        return res.status(400).json({ error: 'ผู้ให้บริการไม่ถูกต้อง' });
    }
    db.prepare(`DELETE FROM ai_providers WHERE provider = ?`).run(p);
    res.json({ ok: true });
});

// Test whichever key is configured for this provider
app.post('/api/ai/keys/:provider/test', asyncHandler(async (req, res) => {
    const p = req.params.provider;
    const row = db.prepare(`SELECT * FROM ai_providers WHERE provider = ? LIMIT 1`).get(p);
    if (!row) throw notFound('ยังไม่ได้ตั้งรหัสของผู้ให้บริการนี้');
    const { createProvider } = require('./services/captionService');
    const provider = createProvider(row.provider, {
        apiKey: decrypt(row.api_key),
        model: row.model,
        label: row.label
    });
    const sample = await provider.generateCaption({
        systemPrompt: 'คุณเป็นผู้เขียนแคปชั่น Facebook Reel ภาษาไทยที่สั้นและกระชับ',
        userPrompt: 'เขียนแคปชั่น 1 บรรทัดโฆษณาคลิป "ซีรีส์จีน EP.1"',
        maxTokens: 80,
        temperature: 0.7
    });
    res.json({ ok: true, sample });
}));

// ====================================================================
// CAPTION PROMPTS
// ====================================================================
app.get('/api/caption-prompts', (req, res) => {
    res.json(db.prepare('SELECT * FROM caption_prompts ORDER BY id DESC').all());
});

app.post('/api/caption-prompts', asyncHandler(async (req, res) => {
    const { page_id, ai_provider_id, system_prompt, user_prompt, max_tokens, temperature, selected_model } = req.body;
    if (!system_prompt || !user_prompt) throw badRequest('ต้องกรอกคำสั่งหลัก และข้อความที่ส่งให้ AI');
    const result = db.prepare(`
        INSERT INTO caption_prompts (page_id, ai_provider_id, system_prompt, user_prompt, max_tokens, temperature, selected_model)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(page_id || null, ai_provider_id || null, system_prompt, user_prompt,
          max_tokens || 200, temperature || 0.8, selected_model || null);
    res.json({ id: result.lastInsertRowid });
}));

app.put('/api/caption-prompts/:id', asyncHandler(async (req, res) => {
    const allowed = ['page_id', 'ai_provider_id', 'system_prompt', 'user_prompt', 'max_tokens', 'temperature', 'selected_model'];
    const updates = [];
    const values = [];
    for (const k of allowed) if (k in req.body) { updates.push(`${k} = ?`); values.push(req.body[k]); }
    if (!updates.length) return res.json({ ok: true });
    values.push(req.params.id);
    db.prepare(`UPDATE caption_prompts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    res.json({ ok: true });
}));

// List available caption models + estimated cost per caption (in both USD and THB).
// UI calls this to build the model picker dropdown with prices.
app.get('/api/caption-models', (req, res) => {
    const { CAPTION_MODELS, estimateCaptionCost } = require('./services/captionService');
    // Which providers have a key configured?
    const configured = new Set(
        db.prepare(`SELECT provider FROM ai_providers`).all().map(r => r.provider)
    );
    const models = Object.entries(CAPTION_MODELS).map(([id, info]) => {
        const cost = estimateCaptionCost(id);
        return {
            id,
            label: info.label,
            provider: info.provider,
            available: configured.has(info.provider),
            cost_per_caption_usd: cost.usd,
            cost_per_caption_thb: cost.thb,
            cost_per_1000_captions_thb: cost.per1000
        };
    });
    res.json({ models });
});

app.delete('/api/caption-prompts/:id', (req, res) => {
    db.prepare('DELETE FROM caption_prompts WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
});

// ====================================================================
// JOBS
// ====================================================================
app.get('/api/jobs/recent', (req, res) => {
    const limit = parseInt(req.query.limit || '10', 10);
    const rows = db.prepare(`
        SELECT j.*, c.clip_index, c.scouted_id, c.caption, c.set1_path, c.set2_path, p.name as page_name, sv.title as video_title
        FROM jobs j
        LEFT JOIN clips c ON c.id = j.clip_id
        LEFT JOIN pages p ON p.id = j.page_id
        LEFT JOIN scouted_videos sv ON sv.id = c.scouted_id
        ORDER BY j.created_at DESC LIMIT ?
    `).all(limit);
    res.json(rows);
});

app.get('/api/jobs/all', (req, res) => {
    const filter = req.query.filter || 'all';
    let where = '';
    const params = [];
    if (filter !== 'all') { where = 'WHERE j.status = ?'; params.push(filter); }
    const rows = db.prepare(`
        SELECT j.*, c.clip_index, c.scouted_id, c.caption, c.set1_path, c.set2_path, c.cover_path,
               p.name as page_name,
               sv.title as video_title, sv.thumbnail_url, sv.source_url
        FROM jobs j
        LEFT JOIN clips c ON c.id = j.clip_id
        LEFT JOIN pages p ON p.id = j.page_id
        LEFT JOIN scouted_videos sv ON sv.id = c.scouted_id
        ${where}
        ORDER BY j.created_at DESC
    `).all(...params);
    res.json(rows);
});

// Grouped queue view — returns pages → scouted_videos (sets) → clips/jobs.
// Used by the categorized queue UI ("จัดเป็นเซ็ตตามเรื่อง").
//
// IMPORTANT: lists EVERY enabled page even if it has zero jobs, so the user
// can always reach the schedule editor (⚙ แก้ตั้งค่า) — required to set
// daily_quota + post_times BEFORE any clips are queued.
app.get('/api/queue/grouped', (req, res) => {
    // 1. All enabled pages — seed map so empty pages still show with schedule editor.
    const pageRows = db.prepare(
        `SELECT id, name, daily_quota, post_times FROM pages WHERE enabled = 1 ORDER BY id`
    ).all();

    const pages = new Map();
    for (const pr of pageRows) {
        let postTimes = [];
        try { if (pr.post_times) postTimes = JSON.parse(pr.post_times); }
        catch { postTimes = []; }
        pages.set(pr.id, {
            page_id: pr.id,
            page_name: pr.name,
            daily_quota: pr.daily_quota || 5,
            post_times: postTimes,
            sets: new Map(),
            total_clips: 0,
            posted_clips: 0,
        });
    }

    // 2. Jobs + clips + scouted videos — fold into the page map above.
    const jobRows = db.prepare(`
        SELECT j.id as job_id, j.status, j.scheduled_at, j.use_set, j.fb_post_id,
               j.copyright_blocked, j.error_message, j.retry_count,
               c.id as clip_id, c.clip_index, c.caption, c.set1_path, c.set2_path, c.cover_path,
               sv.id as scouted_id, sv.title as video_title, sv.thumbnail_url,
               sv.keyword, sv.source_url,
               j.page_id
        FROM jobs j
        LEFT JOIN clips c ON c.id = j.clip_id
        LEFT JOIN scouted_videos sv ON sv.id = c.scouted_id
        ORDER BY j.page_id, sv.id, c.clip_index, j.scheduled_at
    `).all();

    for (const r of jobRows) {
        // Orphan jobs (page deleted / disabled) — bucket into a synthetic page.
        if (!pages.has(r.page_id)) {
            pages.set(r.page_id ?? `orphan-${r.job_id}`, {
                page_id: r.page_id,
                page_name: '(เพจถูกลบหรือปิดใช้งาน)',
                daily_quota: 0,
                post_times: [],
                sets: new Map(),
                total_clips: 0,
                posted_clips: 0,
            });
        }
        const page = pages.get(r.page_id);
        const setKey = r.scouted_id ?? `orphan-${r.job_id}`;
        if (!page.sets.has(setKey)) {
            page.sets.set(setKey, {
                scouted_id: r.scouted_id,
                video_title: r.video_title || '(no title)',
                thumbnail_url: r.thumbnail_url,
                keyword: r.keyword,
                source_url: r.source_url,
                jobs: [],
                posted_count: 0,
            });
        }
        const set = page.sets.get(setKey);
        set.jobs.push({
            job_id: r.job_id, clip_id: r.clip_id, clip_index: r.clip_index,
            status: r.status, scheduled_at: r.scheduled_at, use_set: r.use_set,
            fb_post_id: r.fb_post_id, error_message: r.error_message,
            retry_count: r.retry_count, copyright_blocked: r.copyright_blocked,
            caption: r.caption, set1_path: r.set1_path, set2_path: r.set2_path,
            cover_path: r.cover_path,
        });
        page.total_clips++;
        if (r.status === 'posted') { page.posted_clips++; set.posted_count++; }
    }

    // 3. Materialize to nested arrays for JSON.
    const out = Array.from(pages.values()).map(p => ({
        ...p,
        sets: Array.from(p.sets.values()),
        set_count: p.sets.size,
    }));
    res.json(out);
});

app.post('/api/jobs/:id/cancel', (req, res) => {
    db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE id = ? AND status = 'pending'`).run(req.params.id);
    res.json({ ok: true });
});

app.post('/api/jobs/:id/retry', (req, res) => {
    db.prepare(`
        UPDATE jobs SET status = 'pending', retry_count = retry_count + 1, error_message = NULL,
                        scheduled_at = datetime('now', '+10 seconds')
        WHERE id = ? AND status IN ('failed', 'cancelled')
    `).run(req.params.id);
    res.json({ ok: true });
});

app.delete('/api/jobs/:id', (req, res) => {
    db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
});

// Test: open Reels composer for a page (debug helper) — same flow as worker but no upload
app.post('/api/pages/:id/test-composer', asyncHandler(async (req, res) => {
    const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
    if (!page) throw notFound('ไม่พบเพจ');
    const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(page.profile_id);
    if (!profile) throw notFound('ไม่พบบัญชีเฟส');

    const browserManager = require('./core/browserManager');
    const browser = await browserManager.getBrowser(profile);
    const pup = await browser.newPage();

    const candidateUrls = [
        `https://business.facebook.com/latest/reels_composer?ref=biz_web_content_manager_calendar_view&asset_id=${encodeURIComponent(page.fb_page_id)}&context_ref=CONTENT_CALENDAR`,
        `https://business.facebook.com/latest/reels_composer/?asset_id=${encodeURIComponent(page.fb_page_id)}`
    ];

    let landed = null;
    for (const url of candidateUrls) {
        try {
            await pup.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 3000));
            const cur = pup.url();
            if (cur.includes('reels_composer')) { landed = { url, current: cur }; break; }
        } catch {}
    }
    res.json({
        ok: !!landed,
        landed,
        message: landed
            ? `เปิดสำเร็จ — ดูที่หน้าต่าง Chrome (page ${page.name})`
            : `เปิดไม่สำเร็จ — FB อาจเปลี่ยน URL หรือ session หมดอายุ`
    });
}));

// Pre-flight check for a job — what's ready, what's blocking
app.get('/api/jobs/:id/preflight', (req, res) => {
    res.json(preflightJob(Number(req.params.id)));
});

// Update a clip's caption
app.put('/api/clips/:id/caption', asyncHandler(async (req, res) => {
    const { caption } = req.body;
    db.prepare(`UPDATE clips SET caption = ? WHERE id = ?`).run(caption || '', req.params.id);
    res.json({ ok: true });
}));

// Generate caption from a CUSTOM user-supplied prompt (any AI provider)
app.post('/api/ai/generate-caption', asyncHandler(async (req, res) => {
    const { prompt, system_prompt, provider_id, max_tokens, temperature } = req.body;
    if (!prompt) throw badRequest('กรอกคำสั่ง AI ก่อน');
    const providers = captionService.listProviders();
    if (!providers.length) throw new Error('ยังไม่มี AI provider — ไปตั้งค่าที่เมนู "AI แคปชั่น"');
    const chosen = provider_id
        ? providers.find(p => p.id === Number(provider_id))
        : providers[0];
    if (!chosen) throw new Error('ไม่เจอ provider ที่เลือก');

    const row = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(chosen.id);
    const { createProvider } = require('./services/captionService');
    const provider = createProvider(row.provider, {
        apiKey: decrypt(row.api_key),
        model: row.model,
        label: row.label
    });
    const text = await provider.generateCaption({
        systemPrompt: system_prompt || 'คุณเป็นคนเขียนแคปชั่น Facebook Reel ภาษาไทย สั้น กระชับ ชวนดู ใส่ emoji + hashtag เล็กน้อย ไม่เกิน 200 ตัวอักษร',
        userPrompt: prompt,
        maxTokens: max_tokens || 200,
        temperature: temperature || 0.8
    });
    res.json({ ok: true, caption: text, provider: row.label || row.provider });
}));

// Regenerate a clip's caption via AI (uses page's prompt + niche)
// Bulk regenerate caption for multiple clips — repairs clips whose caption was left
// as the system prompt (known bug before captionService validation was added).
// Body: { clip_ids: [1,2,3] }  OR  { bad_only: true } to auto-find suspicious captions.
app.post('/api/clips/bulk-regenerate-captions', asyncHandler(async (req, res) => {
    let clipIds = Array.isArray(req.body?.clip_ids) ? req.body.clip_ids.map(Number).filter(Boolean) : [];
    const badOnly = !!req.body?.bad_only;
    if (clipIds.length > 500) throw badRequest('ไม่เกิน 500 คลิปต่อครั้ง');

    if (!clipIds.length && badOnly) {
        // Auto-find: clips with caption that looks like a prompt (numbered rules / role phrase / > 1000 chars)
        const all = db.prepare(`SELECT id, caption FROM clips WHERE caption IS NOT NULL AND caption != ''`).all();
        const { CaptionService } = require('./services/captionService');
        clipIds = all
            .filter(c => CaptionService.detectPromptEcho(c.caption, '') !== null)
            .map(c => c.id);
    }
    if (!clipIds.length) {
        return res.json({ ok: true, regenerated: 0, failed: 0, message: 'ไม่มีคลิปที่ต้อง regenerate' });
    }

    let regenerated = 0;
    const failures = [];
    for (const id of clipIds) {
        try {
            const clip = db.prepare(`
                SELECT c.*, sv.title AS video_title FROM clips c
                JOIN scouted_videos sv ON sv.id = c.scouted_id
                WHERE c.id = ?
            `).get(id);
            if (!clip) { failures.push({ id, reason: 'not found' }); continue; }
            let page = clip.assigned_page_id ? db.prepare('SELECT * FROM pages WHERE id = ?').get(clip.assigned_page_id) : null;
            if (!page) {
                const job = db.prepare('SELECT page_id FROM jobs WHERE clip_id = ? LIMIT 1').get(id);
                if (job) page = db.prepare('SELECT * FROM pages WHERE id = ?').get(job.page_id);
            }
            if (!page) { failures.push({ id, reason: 'no page' }); continue; }
            const totalClips = db.prepare(`SELECT COUNT(*) AS n FROM clips WHERE scouted_id = ?`).get(clip.scouted_id).n;
            const newCaption = await captionService.generateForPage(page.id, {
                videoTitle: clip.video_title || 'คลิป',
                niche: page.niche || '',
                duration: (clip.end_sec || 0) - (clip.start_sec || 0),
                clipNumber: clip.clip_index,
                totalClips
            });
            db.prepare(`UPDATE clips SET caption = ? WHERE id = ?`).run(newCaption, id);
            regenerated++;
        } catch (err) {
            failures.push({ id, reason: err.message?.slice(0, 100) || 'unknown' });
        }
    }
    res.json({ ok: true, regenerated, failed: failures.length, failures: failures.slice(0, 10) });
}));

app.post('/api/clips/:id/regenerate-caption', asyncHandler(async (req, res) => {
    const clip = db.prepare(`
        SELECT c.*, sv.title AS video_title, sv.duration_sec
        FROM clips c JOIN scouted_videos sv ON sv.id = c.scouted_id
        WHERE c.id = ?
    `).get(req.params.id);
    if (!clip) throw notFound('ไม่พบคลิปที่เลือก');

    // Find page (assigned, or via job)
    let page = clip.assigned_page_id
        ? db.prepare('SELECT * FROM pages WHERE id = ?').get(clip.assigned_page_id)
        : null;
    if (!page) {
        const job = db.prepare('SELECT page_id FROM jobs WHERE clip_id = ? LIMIT 1').get(clip.id);
        if (job) page = db.prepare('SELECT * FROM pages WHERE id = ?').get(job.page_id);
    }
    if (!page) throw badRequest('คลิปนี้ยังไม่ถูกกำหนดเพจ');

    const totalClips = db.prepare(`SELECT COUNT(*) AS n FROM clips WHERE scouted_id = ?`).get(clip.scouted_id).n;
    const newCaption = await captionService.generateForPage(page.id, {
        videoTitle: clip.video_title || 'คลิป',
        niche: page.niche || '',
        duration: (clip.end_sec || 0) - (clip.start_sec || 0),
        clipNumber: clip.clip_index,
        totalClips
    });
    db.prepare(`UPDATE clips SET caption = ? WHERE id = ?`).run(newCaption, clip.id);
    res.json({ ok: true, caption: newCaption });
}));

// Regenerate cover for a clip (fresh DALL-E call + fallback to frame extract)
app.post('/api/clips/:id/regenerate-cover', asyncHandler(async (req, res) => {
    const clip = db.prepare(`
        SELECT c.*, sv.title AS video_title, sv.keyword AS search_keyword,
               sv.thumbnail_local_path
        FROM clips c JOIN scouted_videos sv ON sv.id = c.scouted_id
        WHERE c.id = ?
    `).get(req.params.id);
    if (!clip) throw notFound('ไม่พบคลิปที่เลือก');
    const page = clip.assigned_page_id
        ? db.prepare('SELECT * FROM pages WHERE id = ?').get(clip.assigned_page_id)
        : null;
    if (!page) throw badRequest('คลิปนี้ยังไม่ถูกกำหนดเพจ');
    const totalClips = db.prepare(`SELECT COUNT(*) AS n FROM clips WHERE scouted_id = ?`).get(clip.scouted_id).n;
    const coverOut = path.join(getCoversDir(), `cover_${clip.scouted_id}_${clip.clip_index}.png`);
    const r = await coverService.generateCover({
        videoPath: clip.set1_path,
        videoTitle: clip.video_title || 'คลิป',
        niche: page.niche || '',
        clipIndex: clip.clip_index,
        totalClips,
        pageOverridePrompt: null,
        searchKeyword: clip.search_keyword || null,
        referenceImagePath: clip.thumbnail_local_path || null,
        outPath: coverOut
    });
    db.prepare(`UPDATE clips SET cover_path = ? WHERE id = ?`).run(r.path, clip.id);
    res.json({ ok: true, cover_path: r.path, source: r.source, used_reference: r.usedReference || false });
}));

// Get/set the global default cover prompt (used when page doesn't have its own)
// List available cover models (for UI picker) with pricing + availability
app.get('/api/cover-models', (req, res) => {
    const { COVER_MODELS } = require('./services/coverService');
    // Which providers have a key configured right now
    const configured = new Set(
        db.prepare(`SELECT provider FROM ai_providers`).all().map(r => r.provider)
    );
    const selected = getSetting('cover_model', null);
    const out = Object.entries(COVER_MODELS).map(([id, info]) => ({
        id,
        label: info.label,
        provider: info.provider,
        priceUSD: info.priceUSD,
        available: configured.has(info.provider),
        is_selected: selected === id
    }));
    res.json({
        models: out,
        selected_model: selected,                // null = auto-pick
        auto_model: (() => {
            // What would auto-pick choose right now?
            if (selected && out.find(m => m.id === selected && m.available)) return selected;
            const firstAvail = out.find(m => m.available);
            return firstAvail?.id || null;
        })()
    });
});
app.put('/api/cover-models/selected', (req, res) => {
    const { model } = req.body;
    const { COVER_MODELS } = require('./services/coverService');
    if (model && !COVER_MODELS[model]) {
        return res.status(400).json({ error: 'โมเดลไม่ถูกต้อง' });
    }
    if (!model) {
        // clear = auto-pick
        db.prepare(`DELETE FROM settings WHERE key = 'cover_model'`).run();
    } else {
        setSetting('cover_model', model);
    }
    res.json({ ok: true, model: model || null });
});

// Test a caption prompt live — fills variables with example values (or user-provided)
// and runs it through the configured AI provider. Does NOT save anything.
app.post('/api/caption-prompts/test', asyncHandler(async (req, res) => {
    const { system_prompt, user_prompt, variables, max_tokens, temperature } = req.body;
    if (!system_prompt || !user_prompt) {
        throw badRequest('ต้องกรอกคำสั่งหลัก และข้อความที่ส่งให้ AI');
    }

    // Pick first configured provider in priority order
    let providerRow = null;
    for (const p of ['openai', 'gemini', 'anthropic']) {
        providerRow = db.prepare(`SELECT * FROM ai_providers WHERE provider = ? LIMIT 1`).get(p);
        if (providerRow) break;
    }
    if (!providerRow) {
        throw badRequest('ยังไม่ได้ตั้ง API Key — ไปตั้งที่ panel "🔑 รหัส API Key"');
    }

    const { createProvider } = require('./services/captionService');
    const provider = createProvider(providerRow.provider, {
        apiKey: decrypt(providerRow.api_key),
        model: providerRow.model,
        label: providerRow.label
    });

    // Merge user-supplied variables with sensible defaults
    const defaults = {
        video_title: 'หงส์เหิรฟ้า EP.1',
        niche: 'ซีรีส์จีนย้อนยุค',
        clip_number: '1',
        total_clips: '4',
        page_name: 'เพจทดสอบ',
        video_desc: '',
        clip_duration: '75'
    };
    const vars = { ...defaults, ...(variables || {}) };
    let filledUserPrompt = user_prompt;
    for (const [k, v] of Object.entries(vars)) {
        filledUserPrompt = filledUserPrompt.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }

    const caption = await provider.generateCaption({
        systemPrompt: system_prompt,
        userPrompt: filledUserPrompt,
        maxTokens: Number(max_tokens) || 2000,   // raised — long prompts need headroom
        temperature: Number(temperature) || 0.8
    });
    res.json({
        ok: true,
        caption,
        provider: providerRow.provider,
        model: providerRow.model,
        variables_used: vars
    });
}));

// Test a cover prompt live — generates a sample image using the custom prompt.
// Does not save to any clip row. Returns a URL that the UI can display.
app.post('/api/cover-prompt/test', asyncHandler(async (req, res) => {
    const { prompt, video_title, niche, keyword, model } = req.body;
    if (!video_title || !String(video_title).trim()) {
        throw badRequest('กรอกชื่อเรื่องสำหรับทดสอบ');
    }

    // If a specific model was requested for the test, temporarily override the
    // selected model — but restore after so we don't mess with user's preference
    const originalSelected = getSetting('cover_model', null);
    if (model) setSetting('cover_model', model);

    const testOut = path.join(getCoversDir(), `_test_${Date.now()}.png`);
    try {
        try {
            const r = await coverService.generateCover({
                videoPath: null,
                videoTitle: String(video_title).trim(),
                niche: niche || '',
                clipIndex: 1,
                totalClips: 1,
                pageOverridePrompt: prompt && String(prompt).trim() ? String(prompt) : null,
                searchKeyword: keyword || null,
                referenceImagePath: null,
                outPath: testOut,
                skipFallback: true
            });
            res.json({
                ok: true,
                cover_url: `/cover-test/${path.basename(r.path)}`,
                source: r.source,
                provider: r.provider,
                priceUSD: r.priceUSD
            });
        } catch (err) {
            // Surface the REAL error from the AI provider so the user can fix it
            // (key invalid, model unavailable, quota exceeded, etc.)
            console.error('[cover-test]', err.message);
            res.status(500).json({
                error: err.message,
                hint: err.message.includes('404') ? 'โมเดลนี้อาจเลิกให้บริการ — ลองเปลี่ยนโมเดลที่ด้านบน'
                    : err.message.includes('403') || err.message.includes('401') ? 'API Key อาจไม่ถูก/ไม่มีสิทธิ์ใช้โมเดลนี้'
                    : err.message.includes('429') ? 'โดน rate limit — รอสักครู่แล้วลองใหม่'
                    : err.message.includes('billing') || err.message.includes('quota') ? 'Quota หมด — เช็คที่หน้า API key ของ provider'
                    : 'ดู error ด้านบน — อาจต้องตรวจ API key หรือเปลี่ยนโมเดล'
            });
        }
    } finally {
        if (model) {
            if (originalSelected) setSetting('cover_model', originalSelected);
            else db.prepare(`DELETE FROM settings WHERE key = 'cover_model'`).run();
        }
    }
}));

// Serve test cover images (whitelisted pattern — only _test_<timestamp>.png)
app.get('/cover-test/:filename', (req, res) => {
    const fname = req.params.filename;
    if (!/^_test_\d+\.png$/.test(fname)) return res.status(400).send('invalid filename');
    const fullPath = path.join(getCoversDir(), fname);
    if (!fs.existsSync(fullPath)) return res.status(404).send('not found');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(fullPath).pipe(res);
});

app.get('/api/cover-prompt/default', (req, res) => {
    const custom = getSetting('cover_prompt_default', null);
    res.json({
        prompt: custom || DEFAULT_COVER_SYSTEM_PROMPT,
        is_custom: !!custom,
        factory_default: DEFAULT_COVER_SYSTEM_PROMPT
    });
});
app.put('/api/cover-prompt/default', (req, res) => {
    const prompt = String(req.body?.prompt || '').slice(0, 4000);
    if (!prompt.trim()) return res.status(400).json({ error: 'prompt ว่าง' });
    setSetting('cover_prompt_default', prompt);
    res.json({ ok: true });
});
app.post('/api/cover-prompt/reset', (req, res) => {
    db.prepare(`DELETE FROM settings WHERE key = 'cover_prompt_default'`).run();
    res.json({ ok: true, prompt: DEFAULT_COVER_SYSTEM_PROMPT });
});

// Re-render a clip with a different banner preset
// Resume preparation for a single clip that failed during the pipeline
// (download/slice/banner/caption — BEFORE it ever got posted).
//
// Use case: orphan sweep marked 'processing' rows as 'failed' because program was
// closed mid-pipeline. User clicks "ทำคลิปต่อ" instead of re-queuing a whole new set.
// This preserves the original scheduled_at slot so the set's day-alignment doesn't shift.
app.post('/api/clips/:id/resume-preparation', asyncHandler(async (req, res) => {
    const clipId = Number(req.params.id);
    const clip = db.prepare(`
        SELECT c.*, sv.file_path AS video_path, sv.title AS video_title, sv.keyword
        FROM clips c
        LEFT JOIN scouted_videos sv ON sv.id = c.scouted_id
        WHERE c.id = ?
    `).get(clipId);
    if (!clip) throw notFound('ไม่พบคลิปที่เลือก');

    // Find the associated job (there should be exactly one)
    const job = db.prepare(`SELECT * FROM jobs WHERE clip_id = ? LIMIT 1`).get(clipId);
    if (!job) throw notFound('ไม่พบงานที่เชื่อมกับคลิปนี้');

    // Find the assigned page (for banner preset + page-specific AI settings)
    const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(clip.assigned_page_id || job.page_id);
    if (!page) throw badRequest('คลิปนี้ยังไม่ถูกกำหนดเพจ');

    // Fire off the resume in the background — pipeline can take minutes
    setImmediate(async () => {
        const emit = (msg) => {
            try {
                db.prepare(`UPDATE jobs SET error_message = ? WHERE id = ?`).run(msg, job.id);
            } catch {}
            io.emit('job:log', { jobId: job.id, msg });
        };
        try {
            // Mark as processing so UI shows live progress
            db.prepare(`UPDATE jobs SET status = 'processing', error_message = ? WHERE id = ?`)
                .run('กำลังเตรียมคลิปต่อจากที่ค้าง...', job.id);
            db.prepare(`UPDATE clips SET status = 'processing' WHERE id = ?`).run(clipId);
            io.emit('job:updated', { jobId: job.id, status: 'processing' });

            await orchestrator.resumeSingleClip({
                clipId,
                jobId: job.id,
                pageId: page.id,
                onLog: emit
            });
            // orchestrator.resumeSingleClip updates rows on success
        } catch (err) {
            console.error('[resume-preparation]', err);
            db.prepare(`
                UPDATE jobs SET status = 'failed',
                                error_message = ?,
                                finished_at = datetime('now', 'localtime')
                WHERE id = ?
            `).run('ทำคลิปต่อไม่สำเร็จ: ' + (err.message || String(err)).slice(0, 300), job.id);
            db.prepare(`UPDATE clips SET status = 'failed' WHERE id = ?`).run(clipId);
            io.emit('job:failed', { jobId: job.id, message: err.message });
        }
    });

    res.json({ ok: true, message: 'เริ่มทำคลิปต่อแล้ว — ดูความคืบหน้าได้ในคิวงาน' });
}));

app.post('/api/clips/:id/re-render', asyncHandler(async (req, res) => {
    const { preset_id } = req.body;
    const clip = db.prepare('SELECT * FROM clips WHERE id = ?').get(req.params.id);
    if (!clip) throw notFound('ไม่พบคลิปที่เลือก');
    const scouted = db.prepare('SELECT * FROM scouted_videos WHERE id = ?').get(clip.scouted_id);
    if (!scouted || !scouted.file_path || !fs.existsSync(scouted.file_path)) {
        throw new Error('คลิปต้นฉบับไม่อยู่ในเครื่องแล้ว — re-render ไม่ได้');
    }
    let layers = [];
    if (preset_id) {
        const preset = db.prepare('SELECT layers_json FROM banner_presets WHERE id = ?').get(preset_id);
        if (preset) {
            try { layers = JSON.parse(preset.layers_json) || []; }
            catch (e) { console.warn('[banner-preset] parse failed:', e.message); layers = []; }
        }
    }
    // ✅ FIX C5: null guard — เดิมถ้า set1_path เป็น NULL จะเขียน "null.tmp_raw.mp4" ลง cwd
    if (!clip.set1_path) {
        throw badRequest('คลิปนี้ยังไม่มี set1 (ยังไม่ได้ตัด/render ครั้งแรก) — กด "ทำคลิปต่อ" ก่อน');
    }
    const { sliceClip, applyBannerOverlay } = require('./core/orchestrator');
    const tmpRaw  = clip.set1_path + '.tmp_raw.mp4';
    const newOut  = clip.set1_path + '.new.mp4';
    const bakOrig = clip.set1_path + '.bak';      // ✅ FIX C5: rollback file
    try {
        await sliceClip(scouted.file_path, tmpRaw, clip.start_sec, clip.end_sec - clip.start_sec);
        if (layers.length > 0) {
            await applyBannerOverlay(tmpRaw, newOut, layers, db);
            try { fs.unlinkSync(tmpRaw); } catch {}
        } else {
            fs.renameSync(tmpRaw, newOut);
        }
        // ✅ FIX C5: atomic-ish replace
        // 1. ย้าย original → .bak (กันหายถ้า rename ใหม่ fail)
        // 2. rename new → original
        // 3. ลบ .bak (ของเดิมแน่ใจว่าทับสำเร็จ)
        // ถ้า step 2 fail (Windows file lock จาก clip-video stream) → restore จาก .bak
        try { fs.renameSync(clip.set1_path, bakOrig); } catch (e) {
            try { fs.unlinkSync(newOut); } catch {}
            throw new Error('ไม่สามารถย้ายไฟล์เดิมได้ (อาจถูก lock โดย preview/อัปโหลด): ' + e.message);
        }
        try {
            fs.renameSync(newOut, clip.set1_path);
            try { fs.unlinkSync(bakOrig); } catch {}
        } catch (e) {
            // rollback
            try { fs.renameSync(bakOrig, clip.set1_path); } catch {}
            try { fs.unlinkSync(newOut); } catch {}
            throw new Error('ไม่สามารถ rename ไฟล์ใหม่ได้: ' + e.message);
        }

        // Invalidate set2 (regen on next request if needed)
        if (clip.set2_path && fs.existsSync(clip.set2_path)) {
            try { fs.unlinkSync(clip.set2_path); } catch {}
            db.prepare('UPDATE clips SET set2_path = NULL WHERE id = ?').run(clip.id);
        }
        res.json({ ok: true, message: 'render เสร็จ — refresh preview เพื่อดูผล' });
    } catch (e) {
        try { fs.unlinkSync(tmpRaw); } catch {}
        try { fs.unlinkSync(newOut); } catch {}
        // ถ้ายังมี .bak ค้าง = original ยังอยู่ใน .bak → restore
        if (fs.existsSync(bakOrig) && !fs.existsSync(clip.set1_path)) {
            try { fs.renameSync(bakOrig, clip.set1_path); } catch {}
        }
        throw new Error('Re-render ล้มเหลว: ' + e.message);
    }
}));

// Bulk job actions
app.post('/api/jobs/bulk', asyncHandler(async (req, res) => {
    const { ids, action } = req.body;
    if (!Array.isArray(ids) || !ids.length) throw badRequest('ยังไม่ได้เลือกรายการที่จะดำเนินการ');
    if (!['cancel', 'delete', 'retry'].includes(action)) throw badRequest('คำสั่งไม่ถูกต้อง (ต้องเป็น ยกเลิก/ลบ/ลองใหม่)');
    const placeholders = ids.map(() => '?').join(',');
    let result;
    if (action === 'cancel') {
        result = db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE id IN (${placeholders}) AND status IN ('pending', 'failed')`).run(...ids);
    } else if (action === 'delete') {
        result = db.prepare(`DELETE FROM jobs WHERE id IN (${placeholders})`).run(...ids);
    } else if (action === 'retry') {
        result = db.prepare(`UPDATE jobs SET status = 'pending', retry_count = retry_count + 1, error_message = NULL,
                                            scheduled_at = datetime('now', 'localtime', '+10 seconds')
                            WHERE id IN (${placeholders}) AND status IN ('failed', 'cancelled')`).run(...ids);
    }
    res.json({ ok: true, action, affected: result.changes });
}));

// Post-now: move a pending/failed job to "schedule = now" so worker picks it up immediately
app.post('/api/jobs/:id/post-now', asyncHandler(async (req, res) => {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) throw notFound('ไม่พบงานนี้ในระบบ');
    db.prepare(`
        UPDATE jobs
        SET status = 'pending', priority = 1,
            scheduled_at = datetime('now', 'localtime', '-1 minute'),
            error_message = NULL
        WHERE id = ?
    `).run(req.params.id);
    runJobWorkerTick().catch(e => console.error('[post-now]', e.message));
    res.json({ ok: true, message: 'Worker will pick this up within seconds' });
}));

// Force-kill a running job — closes Chrome for the profile so any stuck puppeteer
// call aborts, then marks the job 'failed' and clears the busyProfiles lock so worker
// can pick the next job immediately.
app.post('/api/jobs/:id/kill', asyncHandler(async (req, res) => {
    const job = db.prepare(`
        SELECT j.*, p.profile_id FROM jobs j
        JOIN pages p ON p.id = j.page_id
        WHERE j.id = ?
    `).get(req.params.id);
    if (!job) throw notFound('ไม่พบงานนี้ในระบบ');

    db.prepare(`
        UPDATE jobs SET status = 'failed',
                         error_message = 'ผู้ใช้กดหยุด',
                         finished_at = datetime('now', 'localtime')
        WHERE id = ?
    `).run(req.params.id);

    // Close the browser for that profile — this breaks any in-flight puppeteer call
    // (warm-up scroll, upload wait, caption typing, etc.) and the posting task's
    // promise will reject, freeing busyProfiles via its finally() block.
    if (job.profile_id) {
        try {
            await browserManager.closeBrowser(job.profile_id);
            console.log(`[kill] job#${job.id} — closed Chrome for profile ${job.profile_id}`);
        } catch (err) {
            console.warn(`[kill] job#${job.id} — closeBrowser failed:`, err.message);
        }
    }
    io.emit('job:failed', { jobId: Number(req.params.id), message: 'killed by user' });
    res.json({ ok: true });
}));

// Restart a job — resets to 'pending' with priority=1 + scheduled_at=now, kicks the worker
// immediately. Works for running/failed/cancelled jobs. For running jobs, also kills the
// current Chrome session so the new attempt starts fresh.
app.post('/api/jobs/:id/restart', asyncHandler(async (req, res) => {
    const job = db.prepare(`
        SELECT j.*, p.profile_id FROM jobs j
        JOIN pages p ON p.id = j.page_id
        WHERE j.id = ?
    `).get(req.params.id);
    if (!job) throw notFound('ไม่พบงานนี้ในระบบ');
    if (!['running', 'failed', 'cancelled', 'copyright_waiting'].includes(job.status)) {
        throw badRequest(`งานสถานะ "${job.status}" เริ่มใหม่ไม่ได้ — ต้องเป็น running/failed/cancelled`);
    }

    // If currently running, close Chrome so previous attempt aborts
    if (job.status === 'running' && job.profile_id) {
        try { await browserManager.closeBrowser(job.profile_id); } catch {}
    }

    db.prepare(`
        UPDATE jobs SET status = 'pending',
                         priority = 1,
                         error_message = NULL,
                         started_at = NULL,
                         finished_at = NULL,
                         scheduled_at = datetime('now', 'localtime', '-10 seconds'),
                         retry_count = retry_count + 1
        WHERE id = ?
    `).run(req.params.id);

    // Kick worker immediately (don't wait for next 15s tick)
    setTimeout(() => runJobWorkerTick().catch(err => console.error('[worker tick after restart]', err)), 500);
    io.emit('job:updated', { jobId: Number(req.params.id), status: 'pending' });
    res.json({ ok: true, message: 'คิวให้โพสต์ใหม่ทันที' });
}));

// Worker control
app.get('/api/worker/status', (req, res) => {
    const stats = {
        processing: db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status='processing'`).get().n,
        pending:    db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status='pending'`).get().n,
        running:    db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status='running'`).get().n,
        failed:     db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status='failed'`).get().n,
        posted_today: db.prepare(`SELECT COALESCE(SUM(posts_count),0) AS n FROM daily_stats WHERE date=date('now','localtime')`).get().n
    };
    res.json({
        paused: workerState.paused,
        pausedUntil: workerState.pausedUntil,
        ...stats
    });
});

app.post('/api/worker/pause', (req, res) => {
    const minutes = Number(req.body?.minutes) || 0;
    workerState.paused = true;
    workerState.pausedUntil = minutes > 0 ? Date.now() + minutes * 60 * 1000 : null;
    console.log(`[worker] paused${minutes > 0 ? ` for ${minutes}min` : ''}`);
    res.json({ ok: true, paused: true, pausedUntil: workerState.pausedUntil });
});

app.post('/api/worker/resume', (req, res) => {
    workerState.paused = false;
    workerState.pausedUntil = null;
    console.log('[worker] resumed');
    res.json({ ok: true, paused: false });
});

// Series-level operations
app.post('/api/series/:id/delete', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const series = db.prepare('SELECT * FROM scouted_videos WHERE id = ?').get(id);
    if (!series) throw notFound('ไม่พบเรื่องที่เลือก (อาจถูกลบไปแล้ว)');
    const deleteFiles = req.body?.delete_files === true;

    // Delete jobs + clips first (FK)
    const clips = db.prepare('SELECT id, set1_path, set2_path FROM clips WHERE scouted_id = ?').all(id);
    let filesDeleted = 0;
    if (deleteFiles) {
        for (const c of clips) {
            for (const p of [c.set1_path, c.set2_path]) {
                if (p && fs.existsSync(p)) { try { fs.unlinkSync(p); filesDeleted++; } catch {} }
            }
        }
        if (series.file_path && fs.existsSync(series.file_path)) {
            try { fs.unlinkSync(series.file_path); filesDeleted++; } catch {}
        }
    }
    db.prepare(`DELETE FROM jobs WHERE clip_id IN (SELECT id FROM clips WHERE scouted_id = ?)`).run(id);
    db.prepare(`DELETE FROM clips WHERE scouted_id = ?`).run(id);
    db.prepare(`DELETE FROM scouted_videos WHERE id = ?`).run(id);

    res.json({ ok: true, clips_deleted: clips.length, files_deleted: filesDeleted });
}));

// List clips waiting for a future session (reserved) for a page
app.get('/api/pages/:id/reserved-clips', (req, res) => {
    const rows = db.prepare(`
        SELECT c.*, sv.title AS video_title, sv.source_url
        FROM clips c
        JOIN scouted_videos sv ON sv.id = c.scouted_id
        WHERE c.assigned_page_id = ? AND c.status = 'reserved'
        ORDER BY c.scouted_id, c.clip_index
    `).all(req.params.id);
    res.json(rows);
});

// List ALL series (scouted videos) and which page they're assigned to + clip stats
app.get('/api/series', (req, res) => {
    const rows = db.prepare(`
        SELECT sv.*, p.name AS assigned_page_name, p.id AS assigned_page_id,
               (SELECT COUNT(*) FROM clips WHERE scouted_id = sv.id) AS total_clips,
               (SELECT COUNT(*) FROM clips WHERE scouted_id = sv.id AND status = 'reserved') AS reserved_clips,
               (SELECT COUNT(*) FROM clips WHERE scouted_id = sv.id AND status = 'ready') AS ready_clips,
               (SELECT COUNT(*) FROM jobs j JOIN clips c ON c.id = j.clip_id WHERE c.scouted_id = sv.id AND j.status = 'posted') AS posted_jobs,
               (SELECT COUNT(*) FROM jobs j JOIN clips c ON c.id = j.clip_id WHERE c.scouted_id = sv.id) AS total_jobs
        FROM scouted_videos sv
        LEFT JOIN pages p ON p.id = sv.assigned_page_id
        ORDER BY sv.created_at DESC
    `).all();
    res.json(rows);
});

// Manual trigger: release reserved clips now (for testing)
app.post('/api/scheduler/run-now', (req, res) => {
    releaseReservedClips();
    res.json({ ok: true, message: 'Scheduler ran' });
});

// Expose peak slots so UI can explain to user why each clip is scheduled there
app.get('/api/peak-slots', (req, res) => {
    const { PEAK_SLOTS, planClipSchedule, friendlyThaiDate } = require('./core/peakSchedule');
    res.json({
        slots: PEAK_SLOTS,
        // include a sample plan of next 5 slots for preview
        sample: planClipSchedule(5).map(p => ({
            slot: p.slot.label,
            why: p.slot.why,
            time: p.date.toISOString(),
            friendly: friendlyThaiDate(p.date)
        }))
    });
});

// ====================================================================
// PIPELINE
// ====================================================================
app.post('/api/pipeline/start', asyncHandler(async (req, res) => {
    const { page_id, page_ids, keyword, source_url, preset_id, scout_limit, clips_per_page } = req.body;
    // Accept either page_ids[] (new) or page_id (legacy)
    const pageIdList = Array.isArray(page_ids) && page_ids.length
        ? page_ids.map(Number).filter(Boolean)
        : (page_id ? [Number(page_id)] : []);
    if (!pageIdList.length) throw badRequest('กรุณาเลือกเพจอย่างน้อย 1 เพจ');

    // Validate every page exists + the profile behind it has session cookies.
    // Also pull each page's default_keyword so we can fall back to per-page search
    // when the user leaves the global keyword input empty.
    const placeholders = pageIdList.map(() => '?').join(',');
    const found = db.prepare(`
        SELECT p.id, p.name, p.profile_id, p.default_keyword,
               pr.name AS profile_name,
               (SELECT COUNT(*) FROM session_cookies WHERE profile_id = p.profile_id) AS has_session
        FROM pages p
        JOIN profiles pr ON pr.id = p.profile_id
        WHERE p.id IN (${placeholders})
    `).all(...pageIdList);
    if (found.length !== pageIdList.length) {
        const missing = pageIdList.filter(id => !found.find(p => p.id === id));
        throw notFound(`ไม่พบเพจที่เลือก (อาจถูกลบไปแล้ว) — กรุณาเลือกเพจใหม่ · ID: ${missing.join(', ')}`);
    }
    // UX: Fail fast if no session cookies for any selected page's profile — otherwise the
    // pipeline succeeds in queuing jobs but they all fail preflight ("ยังไม่ได้เข้าระบบเฟส").
    const notLoggedIn = found.filter(p => !p.has_session);
    if (notLoggedIn.length) {
        const names = notLoggedIn.map(p => `"${p.name}" (บัญชี: ${p.profile_name})`).join(', ');
        throw badRequest(`ยังไม่ได้เข้าระบบ Facebook สำหรับ: ${names} · ไปเมนู "จัดการเฟส + เพจ" เข้าระบบก่อน`);
    }

    // Effective keyword resolution: global keyword (if given) wins; otherwise each page
    // uses its own default_keyword. If the user supplies no URL and no keyword
    // (neither global nor any page default), we can't search anything — reject early.
    const globalKw = (keyword && String(keyword).trim()) || null;
    const pageKeywords = {};
    const pagesMissingKw = [];
    for (const p of found) {
        const kw = globalKw || (p.default_keyword && String(p.default_keyword).trim()) || null;
        if (kw) pageKeywords[p.id] = kw;
        else pagesMissingKw.push(p.name);
    }
    if (!source_url && Object.keys(pageKeywords).length === 0) {
        throw badRequest('กรอก keyword หรือ URL ของคลิปก่อน — หรือไปตั้ง "Keyword default" ให้แต่ละเพจในเมนู "จัดการเฟส + เพจ"');
    }
    // Allow partial runs but return a warning the UI can surface.
    const pageKeywordWarning = (!source_url && pagesMissingKw.length)
        ? `${pagesMissingKw.length} เพจจะถูกข้ามเพราะยังไม่ได้ตั้ง keyword: ${pagesMissingKw.join(', ')}`
        : null;

    const clipsPerVideo = Number(getSetting('default_clips_per_video', '4'));
    const clipDurationSec = Number(getSetting('default_clip_duration_sec', '75'));

    // Preview: compute when the FIRST clip will actually land so user can see it
    // before the pipeline runs (answers "ลงวันไหน?" without waiting).
    const { planClipSchedule, friendlyThaiDate } = require('./core/peakSchedule');
    const previewPerPage = found.map(p => {
        const lastRow = db.prepare(`
            SELECT MAX(scheduled_at) AS t FROM jobs
            WHERE page_id = ?
              AND status IN ('pending', 'running', 'posted', 'processing', 'copyright_waiting')
              AND datetime(scheduled_at) > datetime('now', 'localtime', '-1 day')
        `).get(p.id);
        // Match orchestrator policy: continue from lastScheduled + cooldown so
        // remaining same-day slots get filled before rolling to the next day.
        const pagePage = db.prepare('SELECT cooldown_min, post_times FROM pages WHERE id = ?').get(p.id);
        const cooldownMin = pagePage?.cooldown_min || 30;
        let startFrom;
        if (lastRow?.t) {
            const ld = new Date(lastRow.t.replace(' ', 'T'));
            startFrom = new Date(Math.max(Date.now(), ld.getTime() + cooldownMin * 60 * 1000));
        } else {
            startFrom = new Date();
        }
        // Plan for the number of clips this page will receive (1 video × clipsPerVideo,
        // or share across pages — simplified: assume 1 video per page here)
        const clipsThisPage = Math.max(1, clipsPerVideo);
        let customTimes;
        try { if (pagePage?.post_times) customTimes = JSON.parse(pagePage.post_times); } catch {}
        const plan = planClipSchedule(clipsThisPage, startFrom, cooldownMin, customTimes);
        return {
            page_id: p.id,
            page_name: p.name,
            first_slot: friendlyThaiDate(plan[0].date),
            last_slot: friendlyThaiDate(plan[plan.length - 1].date),
            total_clips: clipsThisPage
        };
    });

    // clips_per_page is the new semantic: how many source videos each selected page gets.
    // Falls back to legacy scout_limit if caller hasn't migrated yet.
    const perPage = Math.max(1, Number(clips_per_page) || Number(scout_limit) || 1);

    const { runId, pageCount } = orchestrator.enqueue({
        pageIds: pageIdList,
        keyword: globalKw,
        pageKeywords,
        sourceUrl: source_url,
        presetId: preset_id,
        clipsPerVideo, clipDurationSec,
        clipsPerPage: perPage
    });
    res.json({
        ok: true, run_id: runId,
        page_count: pageCount,
        page_names: found.map(p => p.name),
        page_keywords: pageKeywords,
        clips_per_page: perPage,
        schedule_preview: previewPerPage,
        warning: pageKeywordWarning,
        message: `Pipeline started for ${pageCount} page(s)`
    });
}));

// Preview scheduled slots WITHOUT starting the pipeline — lets user see
// "ถ้ากดเริ่มตอนนี้ คลิปจะลงวันไหน" before committing. Handy for planning.
app.post('/api/pipeline/preview-schedule', asyncHandler(async (req, res) => {
    const { page_ids, clips_per_page } = req.body;
    const ids = Array.isArray(page_ids) ? page_ids.map(Number).filter(Boolean) : [];
    if (!ids.length) throw badRequest('ต้องเลือกเพจอย่างน้อย 1 เพจ');
    if (ids.length > 50) throw badRequest('เลือกได้ไม่เกิน 50 เพจในครั้งเดียว');
    const n = Math.max(1, Number(clips_per_page) || Number(getSetting('default_clips_per_video', '4')));
    const { planClipSchedule, friendlyThaiDate } = require('./core/peakSchedule');

    const placeholders = ids.map(() => '?').join(',');
    const pages = db.prepare(`
        SELECT id, name, cooldown_min, post_times FROM pages WHERE id IN (${placeholders})
    `).all(...ids);

    const out = pages.map(p => {
        const lastRow = db.prepare(`
            SELECT MAX(scheduled_at) AS t FROM jobs
            WHERE page_id = ?
              AND status IN ('pending', 'running', 'posted', 'processing', 'copyright_waiting')
              AND datetime(scheduled_at) > datetime('now', 'localtime', '-1 day')
        `).get(p.id);
        // Match orchestrator policy: continue from lastScheduled + cooldown so
        // remaining same-day slots get filled before rolling to the next day.
        const cooldownMin = p.cooldown_min || 30;
        let startFrom;
        if (lastRow?.t) {
            const ld = new Date(lastRow.t.replace(' ', 'T'));
            startFrom = new Date(Math.max(Date.now(), ld.getTime() + cooldownMin * 60 * 1000));
        } else {
            startFrom = new Date();
        }
        let customTimes;
        try { if (p.post_times) customTimes = JSON.parse(p.post_times); } catch {}
        const plan = planClipSchedule(n, startFrom, cooldownMin, customTimes);
        return {
            page_id: p.id,
            page_name: p.name,
            slots: plan.map(x => ({
                friendly: friendlyThaiDate(x.date),
                slot_label: x.slot.label,
                day_offset: x.dayOffset
            })),
            first_slot: friendlyThaiDate(plan[0].date),
            last_slot: friendlyThaiDate(plan[plan.length - 1].date)
        };
    });
    res.json({ ok: true, clips_per_page: n, preview: out });
}));

// Scout-only — preview search results without enqueuing a pipeline
app.post('/api/scout', asyncHandler(async (req, res) => {
    const { keyword, limit, include_used } = req.body;
    if (!keyword) throw badRequest('กรอกคำค้นก่อน');
    const { scoutBilibili } = require('./core/scout');
    const rawLimit = limit || 8;
    // Over-fetch a bit so we still have enough results after filtering duplicates
    const scoutLimit = include_used ? rawLimit : Math.max(rawLimit * 3, 20);
    const videos = await scoutBilibili(keyword, { limit: scoutLimit, onLog: m => console.log('[scout]', m) });

    // Default: filter out URLs we've already processed (exist in scouted_videos).
    // Pass `include_used: true` in the body to bypass this filter (e.g. if user wants
    // to re-run a clip that failed).
    let filtered = videos;
    let filteredOut = 0;
    if (!include_used) {
        const crypto = require('crypto');
        const hashUrl = (u) => crypto.createHash('sha1').update(u).digest('hex').slice(0, 16);
        const urlHashes = videos.map(v => hashUrl(v.url));
        const chunks = [];
        for (let i = 0; i < urlHashes.length; i += 500) chunks.push(urlHashes.slice(i, i + 500));
        const usedHashes = new Set();
        for (const chunk of chunks) {
            const rows = db.prepare(
                `SELECT url_hash FROM scouted_videos WHERE url_hash IN (${chunk.map(() => '?').join(',')})`
            ).all(...chunk);
            for (const r of rows) usedHashes.add(r.url_hash);
        }
        const before = videos.length;
        filtered = videos.filter(v => !usedHashes.has(hashUrl(v.url)));
        filteredOut = before - filtered.length;
        // Trim to the user's actual requested limit
        filtered = filtered.slice(0, rawLimit);
    }

    res.json({
        ok: true,
        count: filtered.length,
        videos: filtered,
        filtered_out: filteredOut,            // how many duplicates were hidden
        total_before_filter: videos.length    // so UI can warn if all results were dupes
    });
}));

// ====================================================================
// COPYRIGHT
// ====================================================================
app.get('/api/copyright/pending', (req, res) => {
    res.json(copyrightMgr.getPendingReviews());
});

app.post('/api/copyright/retry-set2/:jobId', asyncHandler(async (req, res) => {
    // Ensure Set 2 video exists first (generate if missing)
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
    if (!job) throw notFound('ไม่พบงานนี้ในระบบ');
    try {
        await orchestrator.ensureSet2(job.clip_id);
    } catch (e) {
        throw new Error('สร้าง Set 2 ล้มเหลว: ' + e.message);
    }
    const newJobId = copyrightMgr.retryWithSet2(req.params.jobId);
    res.json({ new_job_id: newJobId });
}));

app.post('/api/copyright/dismiss/:jobId', (req, res) => {
    copyrightMgr.dismissReview(req.params.jobId);
    res.json({ ok: true });
});

copyrightMgr.on('copyright_blocked', (data) => io.emit('notification:copyright', data));
copyrightMgr.on('retry_with_set2', (data) => io.emit('notification:retry', data));

// ====================================================================
// SETTINGS (key-value)
// ====================================================================
function getSetting(key, fallback = null) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
}
function setSetting(key, value) {
    db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
}

app.get('/api/settings', (req, res) => {
    res.json(db.prepare('SELECT * FROM settings').all());
});

// SECURITY: Allowlist of settings keys users can change via the API. Adding a key here
// documents its purpose. Don't accept arbitrary keys — that lets any frontend bug
// (or malicious extension) corrupt system behavior.
const ALLOWED_SETTING_KEYS = new Set([
    'default_clips_per_video',
    'default_clip_duration_sec',
    'warmup_duration_sec',
    'copyright_monitor_sec',
    'storage_videos_dir',
    'storage_clips_dir',
    'storage_covers_dir',
    'cover_prompt_default',
    'cover_enabled',           // global on/off for AI cover generation
    'cover_model',             // which image model to use (see COVER_MODELS in coverService)
    'slice_speed_factor',      // 1.0-2.0, speed-up factor during slice for copyright evasion
    'strict_copyright_wait',   // '0' = post anyway after copyright timeout (default), '1' = block
    'chrome_executable_path',  // user override for Chrome path (empty = auto-detect)
    'watcher_auto_edit_enabled', // '1' = slice + banner ปกติ, '0' = โพสต์ raw clip ตรงๆ
    'close_to_tray',           // '1' (default) = close window hides to tray · '0' = quit on close
    'chrome_headless',         // '0' (default) = Chrome ปรากฏ · '1' = ทำงานเบื้องหลัง (headless)
    'caption_mode',            // 'ai' (default) | 'template' | 'source_title' | 'off' — see captionService
    'caption_template',        // template string used when caption_mode='template' (supports {video_title} etc.)
    'caption_emoji_pool'       // comma-separated emoji rotated into {emoji} placeholder
]);

// Mirror window-affecting settings to a tiny JSON file that the main Electron
// process can read synchronously inside its close handler. main.js doesn't
// share the SQLite connection (different process) so this avoids a sync IPC
// at close time.
function syncWindowPrefsFile() {
    try {
        const userData = process.env.KINTENSHAUTO_USER_DATA;
        if (!userData) return;
        const prefsPath = require('path').join(userData, 'window-prefs.json');
        const closeToTray = db.prepare(
            `SELECT value FROM settings WHERE key = 'close_to_tray'`
        ).get()?.value;
        const chromeHeadless = db.prepare(
            `SELECT value FROM settings WHERE key = 'chrome_headless'`
        ).get()?.value;
        require('fs').writeFileSync(prefsPath, JSON.stringify({
            close_to_tray: closeToTray !== '0',          // default ON
            chrome_headless: chromeHeadless === '1',     // default OFF
        }, null, 2));
    } catch (e) { console.warn('[settings] sync window-prefs failed:', e.message); }
}

// GET single setting by key — used by UI to read current value (e.g., toggle state)
app.get('/api/settings/:key', (req, res) => {
    const key = req.params.key;
    if (!ALLOWED_SETTING_KEYS.has(key)) {
        return res.status(400).json({ error: `ค่าการตั้งค่า "${key}" ไม่อยู่ในรายการ` });
    }
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
    res.json({ key, value: row?.value ?? null });
});

app.put('/api/settings/:key', (req, res) => {
    const key = req.params.key;
    if (!ALLOWED_SETTING_KEYS.has(key)) {
        return res.status(400).json({ error: `ค่าการตั้งค่า "${key}" ไม่อยู่ในรายการที่แก้ได้` });
    }
    const value = req.body?.value;
    if (value === undefined || value === null || String(value).length > 1024) {
        return res.status(400).json({ error: 'ค่าว่างเปล่าหรือยาวเกิน 1024 ตัวอักษร' });
    }
    setSetting(key, value);
    // When a window/Chrome behavior toggle changes, push it to the JSON file
    // so the Electron main process picks it up next time it reads.
    if (key === 'close_to_tray' || key === 'chrome_headless') {
        syncWindowPrefsFile();
    }
    res.json({ ok: true });
});

// Run the sync once at startup so the file exists even before the user touches
// any toggle (main.js then has a deterministic baseline to read from).
syncWindowPrefsFile();

// ====================================================================
// ADMIN
// ====================================================================
// View recent backend log entries in the app (no need to open files folder)
app.get('/api/admin/log-tail', (req, res) => {
    const lines = Math.min(Number(req.query.lines) || 100, 500);
    const logFile = path.join(USER_DATA, 'logs', 'backend.log');
    if (!fs.existsSync(logFile)) return res.json({ lines: [], path: logFile });
    try {
        const content = fs.readFileSync(logFile, 'utf-8');
        const allLines = content.split(/\r?\n/);
        res.json({ lines: allLines.slice(-lines), path: logFile, totalLines: allLines.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/clean-downloads', (req, res) => {
    let deleted = 0;
    try {
        const files = fs.readdirSync(DOWNLOADS_DIR);
        for (const f of files) {
            try { fs.unlinkSync(path.join(DOWNLOADS_DIR, f)); deleted++; } catch {}
        }
    } catch {}
    res.json({ ok: true, deleted });
});

// ====================================================================
// STORAGE — clip folders management
// ====================================================================
function folderInfo(dir) {
    const out = { path: dir, exists: false, file_count: 0, total_bytes: 0, files: [] };
    if (!dir || !fs.existsSync(dir)) return out;
    out.exists = true;
    function walk(d, depth = 0) {
        try {
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
                const full = path.join(d, entry.name);
                if (entry.isDirectory()) {
                    if (depth < 2) walk(full, depth + 1);
                } else {
                    try {
                        const st = fs.statSync(full);
                        out.file_count++;
                        out.total_bytes += st.size;
                        if (out.files.length < 50) {
                            out.files.push({
                                name: path.relative(dir, full),
                                size: st.size,
                                modified: st.mtime.toISOString()
                            });
                        }
                    } catch {}
                }
            }
        } catch {}
    }
    walk(dir);
    out.files.sort((a, b) => b.modified.localeCompare(a.modified));
    return out;
}

app.get('/api/storage/info', (req, res) => {
    const videosDir = process.env.KINTENSHAUTO_DOWNLOADS || path.join(USER_DATA, 'downloads');
    const clipsDir  = process.env.KINTENSHAUTO_CLIPS_DIR || path.join(USER_DATA, 'clips');
    const coversDir = getCoversDir();
    const overlaysDir = OVERLAYS_DIR;
    res.json({
        videos:   { ...folderInfo(videosDir),   label: 'คลิปเต็ม (raw)',     description: 'คลิปต้นฉบับที่ดาวน์โหลดจาก bilibili/YouTube — ลบได้หลังตัดเสร็จ' },
        clips:    { ...folderInfo(clipsDir),    label: 'คลิปตัดต่อแล้ว',     description: 'คลิปย่อยที่ตัด+ใส่แบนเนอร์เสร็จ — ใช้โพสต์จริง อย่าลบจนกว่าจะโพสต์เสร็จ' },
        covers:   { ...folderInfo(coversDir),   label: 'หน้าปก AI (รูป)',    description: 'ภาพหน้าปก 9:16 ที่ AI สร้าง · แนบเข้า FB ตอนโพสต์ · ลบได้หลังโพสต์เสร็จ' },
        overlays: { ...folderInfo(overlaysDir), label: 'แบนเนอร์ (รูป)',      description: 'รูปภาพแบนเนอร์ที่อัปโหลด' }
    });
});

// Update a storage path — validates it exists/can be created + writable
app.post('/api/storage/path', asyncHandler(async (req, res) => {
    const { kind, path: newPath } = req.body;
    if (!['videos', 'clips', 'covers'].includes(kind)) throw badRequest('ประเภทโฟลเดอร์ไม่ถูกต้อง (ต้องเป็น คลิปต้นฉบับ/คลิปตัดต่อ/หน้าปก)');
    if (!newPath || typeof newPath !== 'string') throw badRequest('ต้องระบุเส้นทางโฟลเดอร์');

    // SECURITY: Require absolute path and reject obvious traversal patterns.
    // Also validate path length (Windows max is 260 chars for regular API).
    if (!path.isAbsolute(newPath)) throw badRequest('ต้องเป็นเส้นทางแบบเต็ม (เช่น C:\\folder\\name)');
    if (newPath.includes('..')) throw badRequest('เส้นทางต้องไม่มี .. (path traversal)');
    if (newPath.length > 200) throw badRequest('เส้นทางยาวเกิน 200 ตัวอักษร — อาจโดน Windows block');

    // Create if not exists, test writability
    try {
        if (!fs.existsSync(newPath)) fs.mkdirSync(newPath, { recursive: true });
        const testFile = path.join(newPath, '.kintenshauto_write_test');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
    } catch (e) {
        throw new Error('โฟลเดอร์ใช้ไม่ได้: ' + e.message);
    }

    const settingKey = kind === 'videos' ? 'storage_videos_dir'
                     : kind === 'clips'  ? 'storage_clips_dir'
                     : 'storage_covers_dir';
    setSetting(settingKey, newPath);

    // Apply to env immediately so orchestrator picks it up on next call
    if (kind === 'videos') process.env.KINTENSHAUTO_DOWNLOADS = newPath;
    if (kind === 'clips')  process.env.KINTENSHAUTO_CLIPS_DIR = newPath;
    if (kind === 'covers') process.env.KINTENSHAUTO_COVERS_DIR = newPath;

    res.json({ ok: true, path: newPath });
}));

// Clean a specific folder (videos / clips / covers)
app.post('/api/storage/clean', asyncHandler(async (req, res) => {
    const { kind } = req.body;
    let dir;
    if (kind === 'videos')      dir = process.env.KINTENSHAUTO_DOWNLOADS || path.join(USER_DATA, 'downloads');
    else if (kind === 'clips')  dir = process.env.KINTENSHAUTO_CLIPS_DIR || path.join(USER_DATA, 'clips');
    else if (kind === 'covers') dir = getCoversDir();
    else throw badRequest('ประเภทโฟลเดอร์ไม่ถูกต้อง (ต้องเป็น คลิปต้นฉบับ/คลิปตัดต่อ/หน้าปก)');

    if (!fs.existsSync(dir)) return res.json({ ok: true, deleted: 0 });

    let deleted = 0, failed = 0, freedBytes = 0;
    function walkDelete(d) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
                walkDelete(full);
                try { fs.rmdirSync(full); } catch {}
            } else {
                try {
                    const st = fs.statSync(full);
                    fs.unlinkSync(full);
                    deleted++;
                    freedBytes += st.size;
                } catch { failed++; }
            }
        }
    }
    walkDelete(dir);

    // If clips folder is cleaned, mark all clips as 'deleted' so worker skips them
    if (kind === 'clips') {
        db.prepare(`UPDATE clips SET status = 'deleted' WHERE status IN ('ready', 'reserved')`).run();
        db.prepare(`UPDATE jobs SET status = 'cancelled', error_message = 'clips folder cleaned' WHERE status = 'pending'`).run();
    }

    res.json({ ok: true, deleted, failed, freedBytes, freedMB: (freedBytes / 1024 / 1024).toFixed(1) });
}));

// ====================================================================
// Socket.IO
// ====================================================================
io.on('connection', (socket) => {
    console.log('[socket] client connected');
    socket.on('disconnect', () => console.log('[socket] client disconnected'));
});

// ====================================================================
// Start
// ====================================================================
// SECURITY: Bind explicitly to 127.0.0.1 (localhost-only) so the backend isn't reachable
// from other devices on the network. Without this, Node may default to 0.0.0.0.
// Only listen if not running under vitest — tests use supertest against the
// app object directly without binding to a port.
if (!process.env.VITEST) {
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`[server] KINTENSHAUTO backend listening on http://localhost:${PORT}`);
        console.log(`[server] DB: ${DB_PATH}`);
        console.log(`[server] Overlays: ${OVERLAYS_DIR}`);
        console.log(`[server] Downloads: ${DOWNLOADS_DIR}`);
    });
}

// ------------------------------------------------------------------------
// Background maintenance: DB backup + orphan file cleanup
// ------------------------------------------------------------------------
// Rotating backup: keeps .db.bak, .db.bak2, .db.bak3 (newest → oldest).
// If the DB gets corrupted, user can delete kintenshauto.db and rename the .bak.
let backupInProgress = false;
function backupDatabase() {
    // Prevent overlapping backups — if a backup takes > 6hr (slow disk), we'd otherwise
    // queue another one while the first is still holding the DB lock.
    if (backupInProgress) {
        console.warn('[backup] previous backup still in progress, skipping this tick');
        return;
    }
    if (!fs.existsSync(DB_PATH)) return;

    backupInProgress = true;
    let asyncBackupStarted = false;     // ✅ FIX: track whether async path took ownership
                                        // of the flag; sync finally only resets if not.

    try {
        const bak3 = DB_PATH + '.bak3';
        const bak2 = DB_PATH + '.bak2';
        const bak1 = DB_PATH + '.bak';
        try { if (fs.existsSync(bak3)) fs.unlinkSync(bak3); } catch {}
        try { if (fs.existsSync(bak2)) fs.renameSync(bak2, bak3); } catch {}
        try { if (fs.existsSync(bak1)) fs.renameSync(bak1, bak2); } catch {}

        // better-sqlite3's .backup() handles WAL correctly — produces a single
        // consistent .db file even with active writers.
        try {
            const backupPromise = db.backup(bak1);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('backup timeout (60s)')), 60000)
            );
            asyncBackupStarted = true;   // ⚠️ ownership transferred to .finally below
            Promise.race([backupPromise, timeoutPromise])
                .then(() => console.log(`[backup] DB backed up → ${path.basename(bak1)}`))
                .catch(err => console.warn('[backup] DB backup failed:', err.message))
                .finally(() => { backupInProgress = false; });
            return;
        } catch (err) {
            // Fallback: plain file copy. WAL mode requires copying the main DB
            // *and* the -wal + -shm files together, otherwise the backup is
            // effectively missing the most recent transactions.
            try {
                fs.copyFileSync(DB_PATH, bak1);
                const walFile = DB_PATH + '-wal';
                const shmFile = DB_PATH + '-shm';
                if (fs.existsSync(walFile)) fs.copyFileSync(walFile, bak1 + '-wal');
                if (fs.existsSync(shmFile)) fs.copyFileSync(shmFile, bak1 + '-shm');
                console.log('[backup] DB copied → .bak (fallback, with WAL/SHM)');
            } catch (e) {
                console.warn('[backup] fallback copy failed:', e.message);
            }
        }
    } catch (err) {
        console.warn('[backup] error:', err.message);
    } finally {
        // ✅ FIX: only reset flag if async path didn't take ownership
        // (เดิม async path กับ sync finally แข่งกัน reset → backup ถัดไปทับขณะตัวก่อนยังเขียน)
        if (!asyncBackupStarted) backupInProgress = false;
    }
}

// Orphan clip cleanup: files in clips/ and downloads/ that no DB row references.
// Runs weekly. Skips files younger than 1 hour (pipeline may still be using them).
function cleanupOrphanFiles() {
    try {
        const referencedPaths = new Set();
        db.prepare('SELECT set1_path, set2_path FROM clips').all().forEach(r => {
            if (r.set1_path) referencedPaths.add(path.normalize(r.set1_path));
            if (r.set2_path) referencedPaths.add(path.normalize(r.set2_path));
        });
        db.prepare('SELECT file_path FROM scouted_videos WHERE file_path IS NOT NULL').all().forEach(r => {
            if (r.file_path) referencedPaths.add(path.normalize(r.file_path));
        });

        // Also track cover paths so we don't delete in-use covers
        db.prepare('SELECT cover_path FROM clips WHERE cover_path IS NOT NULL').all().forEach(r => {
            if (r.cover_path) referencedPaths.add(path.normalize(r.cover_path));
        });

        const now = Date.now();
        let deletedCount = 0, freedBytes = 0;
        // Use current env values (user may have changed storage path since startup)
        const currentClipsDir = getClipsDir();
        const currentDownloadsDir = process.env.KINTENSHAUTO_DOWNLOADS || DOWNLOADS_DIR;
        const currentCoversDir = getCoversDir();
        for (const dir of [currentClipsDir, currentDownloadsDir, currentCoversDir]) {
            if (!dir || !fs.existsSync(dir)) continue;
            for (const name of fs.readdirSync(dir)) {
                const full = path.normalize(path.join(dir, name));
                if (referencedPaths.has(full)) continue;
                try {
                    const st = fs.statSync(full);
                    if (!st.isFile()) continue;
                    // Protect recent files (< 1 hour) — pipeline may still be writing them
                    if (now - st.mtimeMs < 60 * 60 * 1000) continue;
                    fs.unlinkSync(full);
                    deletedCount++;
                    freedBytes += st.size;
                } catch {}
            }
        }
        if (deletedCount > 0) {
            console.log(`[cleanup] removed ${deletedCount} orphan file(s), freed ${(freedBytes/1024/1024).toFixed(1)} MB`);
        }
    } catch (err) {
        console.warn('[cleanup] error:', err.message);
    }
}

// Schedule: DB backup every 6 hrs, orphan cleanup every 24 hrs.
// First run happens 5 minutes after startup so Electron has time to stabilize.
if (!process.env.VITEST) {
setTimeout(() => {
    backupDatabase();
    setInterval(backupDatabase, 6 * 60 * 60 * 1000);
}, 5 * 60 * 1000);

setTimeout(() => {
    cleanupOrphanFiles();
    setInterval(cleanupOrphanFiles, 24 * 60 * 60 * 1000);
}, 10 * 60 * 1000);
}

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('uncaughtException', (err) => console.error('[uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));

// ============================================================
// CHANNEL WATCHER FEATURE (additive)
// ทั้ง block ห่อใน try/catch — ถ้าฟีเจอร์ใหม่พัง ของหลักยังทำงานได้ปกติ
// ============================================================
(function initChannelWatcher() {
    try {
        const { ChannelWatcher, SUPPORTED_PLATFORMS, SUPPORTED_CONTENT_TYPES } =
            require('./services/channelWatcher');

        // หา yt-dlp ตาม env (electron main.js ส่งเป็น KINTENSHAUTO_YTDLP)
        function findYtDlp() {
            const fromEnv = process.env.KINTENSHAUTO_YTDLP || process.env.KINTENSHAUTO_YTDLP_PATH;
            if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
            const ext = process.platform === 'win32' ? '.exe' : '';
            const candidates = [
                path.join(USER_DATA, 'bin', 'yt-dlp' + ext),
                path.join(USER_DATA, 'bin', process.platform, 'yt-dlp' + ext),
                path.join(__dirname, '..', '..', 'bin', process.platform, 'yt-dlp' + ext),
                path.join(__dirname, '..', '..', '..', 'bin', 'yt-dlp' + ext)  // ขณะรันใน app.asar (resources/bin)
            ];
            for (const c of candidates) if (fs.existsSync(c)) return c;
            return 'yt-dlp';
        }

        const ytDlpPath = findYtDlp();
        const watcherDownloads = process.env.KINTENSHAUTO_DOWNLOADS || DOWNLOADS_DIR;

        // YouTube cookies precedence (most specific wins):
        //   1. KINTENSHAUTO_YTDLP_COOKIES env (explicit override)
        //   2. settings.youtube_cookies_path  (set by Settings → "Login YouTube" flow)
        //   3. KINTENSHAUTO_YTDLP_BROWSER env (browser to read cookies from)
        //   4. default --cookies-from-browser chrome
        const envCookiesFile = process.env.KINTENSHAUTO_YTDLP_COOKIES || '';
        let settingsCookiesFile = '';
        try {
            const r = db.prepare(`SELECT value FROM settings WHERE key = 'youtube_cookies_path'`).get();
            if (r?.value && fs.existsSync(r.value)) settingsCookiesFile = r.value;
        } catch { /* table missing or DB busy */ }
        const cookiesFile = envCookiesFile || settingsCookiesFile;
        // If we have a cookies file, prefer it — leave cookiesFromBrowser
        // empty so we don't double-up auth (yt-dlp would still try the
        // browser even with a cookies file present)
        const cookiesFromBrowser = cookiesFile
            ? ''
            : (process.env.KINTENSHAUTO_YTDLP_BROWSER === undefined
                ? 'chrome'
                : process.env.KINTENSHAUTO_YTDLP_BROWSER);

        const channelWatcher = new ChannelWatcher(DB_PATH, {
            ytDlpPath,
            downloadsRoot: watcherDownloads,
            orchestrator,
            cookiesFromBrowser,
            cookiesFile
        });
        // Allow the YouTube-login endpoints to switch the cookies file at runtime
        // without restarting the backend — see /api/system/youtube-login below.
        channelWatcher.refreshCookiesFromSettings = () => {
            try {
                const r = db.prepare(`SELECT value FROM settings WHERE key = 'youtube_cookies_path'`).get();
                const newPath = (r?.value && fs.existsSync(r.value)) ? r.value : '';
                channelWatcher.cookiesFile = newPath;
                channelWatcher.cookiesFromBrowser = newPath ? '' : 'chrome';
            } catch { /* swallow */ }
        };

        // ============================================================
        // YOUTUBE LOGIN — dedicated profile + cookies.txt for yt-dlp
        // ============================================================
        const { YouTubeLoginService } = require('./services/youtubeLogin');
        const ytLoginService = new YouTubeLoginService({
            userDataRoot: USER_DATA,
            cookiesPath: path.join(USER_DATA, 'youtube-cookies.txt'),
            db
        });

        app.get('/api/system/youtube-login-status', (req, res) => {
            res.json(ytLoginService.getStatus());
        });

        app.post('/api/system/youtube-login', asyncHandler(async (req, res) => {
            try {
                const result = await ytLoginService.login({
                    onLog: (m) => console.log('[ytLogin]', m)
                });
                channelWatcher.refreshCookiesFromSettings();
                res.json(result);
            } catch (e) {
                console.error('[ytLogin] failed:', e.message);
                res.status(500).json({ ok: false, error: e.message });
            }
        }));

        app.post('/api/system/youtube-login-cancel', (req, res) => {
            ytLoginService.closeWindow();
            res.json({ ok: true });
        });

        app.post('/api/system/youtube-logout', asyncHandler(async (req, res) => {
            const r = await ytLoginService.logout();
            channelWatcher.refreshCookiesFromSettings();
            res.json(r);
        }));

        console.log('[watcher] initialized | yt-dlp:', ytDlpPath, '| downloads:', watcherDownloads,
                    '| orchestrator: yes | cookies:', cookiesFromBrowser || cookiesFile || 'none');

        // ---------- API endpoints ----------
        app.get('/api/watcher/meta', (req, res) => {
            res.json({
                platforms: SUPPORTED_PLATFORMS,
                content_types: SUPPORTED_CONTENT_TYPES,
                ytdlp_path: ytDlpPath,
                downloads_root: watcherDownloads
            });
        });

        app.get('/api/watcher/channels', (req, res) => {
            res.json(channelWatcher.listChannels());
        });

        app.post('/api/watcher/channels', asyncHandler(async (req, res) => {
            res.json(await channelWatcher.addChannel(req.body || {}));
        }));

        app.put('/api/watcher/channels/:id', asyncHandler(async (req, res) => {
            res.json(channelWatcher.updateChannel(parseInt(req.params.id, 10), req.body || {}));
        }));

        app.delete('/api/watcher/channels/:id', (req, res) => {
            res.json(channelWatcher.removeChannel(parseInt(req.params.id, 10)));
        });

        app.post('/api/watcher/channels/:id/check-now', asyncHandler(async (req, res) => {
            const id = parseInt(req.params.id, 10);
            // ?reset_seen=1 → ล้าง baseline ก่อน เพื่อ "หลอก" ว่าทุกคลิปเป็นใหม่
            // (สำหรับ test E2E + initial backfill)
            if (req.query.reset_seen === '1') {
                channelWatcher.db.prepare(
                    `UPDATE watched_channels SET last_seen_video_id = NULL WHERE id = ?`
                ).run(id);
                console.log(`[watcher] reset_seen for channel ${id}`);
            }
            // ?fetch_count=N → override ดึง top N (ปุ่ม "ดึงเก่า" เลือกจำนวนได้)
            // ?fetch_count=all → ดึงทุกคลิปของช่อง (respect content_type filter เดิม)
            let fetchCountOverride = null;
            if (req.query.fetch_count === 'all') {
                fetchCountOverride = 0;   // 0 = no limit
            } else if (req.query.fetch_count) {
                const n = parseInt(req.query.fetch_count, 10);
                if (Number.isFinite(n) && n > 0) fetchCountOverride = Math.min(n, 500);
            }
            // ?include_rejected=1 → ลบคลิปที่เคย reject ของช่องนี้ก่อน → user เปลี่ยนใจกลับมา approve ได้
            const options = { clearRejected: req.query.include_rejected === '1' };
            res.json(await channelWatcher.checkChannel(id, fetchCountOverride, options));
        }));

        app.get('/api/watcher/pending', (req, res) => {
            res.json(channelWatcher.listPending(parseInt(req.query.limit || '50', 10)));
        });

        app.post('/api/watcher/pending/:id/approve', asyncHandler(async (req, res) => {
            res.json(await channelWatcher.approve(parseInt(req.params.id, 10)));
        }));

        app.post('/api/watcher/pending/:id/reject', (req, res) => {
            res.json(channelWatcher.reject(parseInt(req.params.id, 10)));
        });

        app.post('/api/watcher/pending/:id/retry', (req, res) => {
            res.json(channelWatcher.retryFailed(parseInt(req.params.id, 10)));
        });

        // หลัง user login YouTube ใน Chrome → กด "ตกลง" ในโมดัล →
        // reset ทุก row ที่ failed ด้วย [NEEDS_YT_LOGIN] marker กลับเป็น pending
        // และเรียก approve อีกครั้ง (cookies ใหม่จะถูกอ่านจาก Chrome)
        app.post('/api/watcher/pending/retry-needs-login', asyncHandler(async (req, res) => {
            const rows = channelWatcher.db.prepare(
                `SELECT id FROM pending_approvals WHERE status = 'failed' AND download_error LIKE '[NEEDS_YT_LOGIN]%'`
            ).all();
            const ids = rows.map(r => r.id);
            for (const id of ids) channelWatcher.retryFailed(id);
            // approve ทีละ id (allSettled กัน 1 fail ทำให้ทั้ง batch แตก)
            const results = await Promise.allSettled(ids.map(id => channelWatcher.approve(id)));
            const ok = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.length - ok;
            res.json({ retried: ids.length, ok, failed });
        }));

        app.post('/api/watcher/pending/approve-all', asyncHandler(async (req, res) => {
            res.json(await channelWatcher.approveAll());
        }));

        app.post('/api/watcher/pending/reject-all', (req, res) => {
            res.json(channelWatcher.rejectAll());
        });

        // Debug/manual: force run checkDue (เรียกได้ทุกเมื่อโดยไม่ต้องรอ cron tick)
        // ใช้ตอน user สงสัยว่าระบบเช็ค auto ทำงานไหม
        app.post('/api/watcher/tick-now', asyncHandler(async (req, res) => {
            console.log('[ChannelWatcher] manual tick triggered via API');
            const r = await channelWatcher.checkDue();
            res.json(r);
        }));

        app.get('/api/watcher/pending/count', (req, res) => {
            res.json({ count: channelWatcher.countPending() });
        });

        // ✅ NEW: separate caption prompt for Channel Watcher (ไม่กระทบของหลัก)
        // Stored in settings table:
        //   watcher_caption_system_prompt
        //   watcher_caption_user_prompt
        //   watcher_caption_max_tokens   (optional, default 300)
        //   watcher_caption_temperature  (optional, default 0.85)
        //   watcher_caption_model        (optional)
        app.get('/api/watcher/caption-prompt', (req, res) => {
            const get = (k) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(k)?.value || '';
            res.json({
                system_prompt: get('watcher_caption_system_prompt'),
                user_prompt:   get('watcher_caption_user_prompt'),
                max_tokens:    parseInt(get('watcher_caption_max_tokens') || '300', 10),
                temperature:   parseFloat(get('watcher_caption_temperature') || '0.85'),
                model:         get('watcher_caption_model')
            });
        });
        app.put('/api/watcher/caption-prompt', (req, res) => {
            const { system_prompt, user_prompt, max_tokens, temperature, model } = req.body || {};
            const upsert = db.prepare(`
                INSERT INTO settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            `);
            upsert.run('watcher_caption_system_prompt', String(system_prompt ?? ''));
            upsert.run('watcher_caption_user_prompt',   String(user_prompt   ?? ''));
            if (max_tokens !== undefined)  upsert.run('watcher_caption_max_tokens',  String(max_tokens));
            if (temperature !== undefined) upsert.run('watcher_caption_temperature', String(temperature));
            if (model !== undefined)       upsert.run('watcher_caption_model',       String(model || ''));
            res.json({ ok: true });
        });

        // ---------- Socket.IO relays ----------
        channelWatcher.on('approvals:new',          (d) => io.emit('watcher:new_videos', d));
        channelWatcher.on('channel:disabled',       (d) => io.emit('watcher:channel_disabled', d));
        channelWatcher.on('channel:added',          (d) => io.emit('watcher:channel_added', d));
        channelWatcher.on('channel:baseline_failed',(d) => io.emit('watcher:baseline_failed', d));   // ✅ H3
        channelWatcher.on('approval:done',          (d) => io.emit('watcher:download_done', d));
        channelWatcher.on('approval:failed',        (d) => io.emit('watcher:download_failed', d));
        channelWatcher.on('approval:needs_youtube_login', (d) => io.emit('watcher:needs_youtube_login', d));
        channelWatcher.on('download:progress',      (d) => io.emit('watcher:download_progress', d));

        if (!process.env.VITEST) channelWatcher.start();   // cron leaks the event loop under tests

        // graceful shutdown
        const _origSigterm = process.listeners('SIGTERM').slice();
        const _origSigint  = process.listeners('SIGINT').slice();
        process.removeAllListeners('SIGTERM');
        process.removeAllListeners('SIGINT');
        process.on('SIGTERM', () => { try { channelWatcher.stop(); } catch {} _origSigterm.forEach(fn => fn()); });
        process.on('SIGINT',  () => { try { channelWatcher.stop(); } catch {} _origSigint.forEach(fn => fn()); });

    } catch (err) {
        console.error('[watcher] init FAILED — ฟีเจอร์ Channel Watcher ไม่พร้อม:', err.message);
        // ของหลักยังทำงานปกติ — ฟีเจอร์ใหม่แค่ใช้ไม่ได้
    }
})();

// Export for tests (supertest hits app directly without binding to a port)
module.exports = { app, server };
