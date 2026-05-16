/**
 * KINTENSHAUTO Pipeline Orchestrator
 *
 * Flow (ต่อ 1 URL):
 *   1. yt-dlp ดาวน์โหลดคลิปเต็ม  → downloads/video_<id>.mp4
 *   2. ffprobe อ่านความยาว
 *   3. FFmpeg ตัดเป็น N คลิปย่อย (default 4 clips × 75s)
 *   4. ถ้ามี banner preset → overlay (sync)
 *   5. สร้าง Set 2 (mirror + pitch shift + zoom)   [lazy — เฉพาะเมื่อต้องใช้]
 *   6. fpcalc → audio fingerprint → เช็ค blacklist
 *   7. AI caption per clip
 *   8. แต่ละคลิป → แปลงเป็น job (status=pending)
 *
 * Orchestrator คืนค่า jobId list ทันทีเพื่อไม่บล็อก HTTP handler
 * งานจริงทำใน background + emit socket events
 */

const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const { planClipSchedule, toSqlLocal, friendlyThaiDate } = require('./peakSchedule');

// Read these dynamically so server.js's resolveWorkingFfmpeg() can override
function FFMPEG() { return process.env.KINTENSHAUTO_FFMPEG || 'ffmpeg'; }
function YTDLP()  { return process.env.KINTENSHAUTO_YTDLP  || 'yt-dlp'; }
function FPCALC() { return process.env.KINTENSHAUTO_FPCALC || 'fpcalc'; }

// Folder paths are also dynamic — server.js writes them to env after reading user
// settings from DB. Functions instead of const so a runtime override sticks.
function DOWNLOADS() {
    return process.env.KINTENSHAUTO_DOWNLOADS
        || path.join(process.env.KINTENSHAUTO_USER_DATA || __dirname, 'downloads');
}
function OVERLAYS() {
    return process.env.KINTENSHAUTO_OVERLAYS
        || path.join(process.env.KINTENSHAUTO_USER_DATA || __dirname, 'overlays');
}
function CLIPS_DIR() {
    return process.env.KINTENSHAUTO_CLIPS_DIR
        || path.join(process.env.KINTENSHAUTO_USER_DATA || __dirname, 'clips');
}
function COVERS_DIR() {
    return process.env.KINTENSHAUTO_COVERS_DIR
        || path.join(process.env.KINTENSHAUTO_USER_DATA || __dirname, 'covers');
}

function ensureFolders() {
    for (const d of [DOWNLOADS(), CLIPS_DIR(), OVERLAYS(), COVERS_DIR()]) {
        try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch {}
    }
}
ensureFolders();

function sh(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const proc = execFile(cmd, args, { maxBuffer: 1024 * 1024 * 20, ...opts }, (err, stdout, stderr) => {
            if (err) {
                err.stderr = stderr;
                reject(err);
            } else resolve({ stdout, stderr });
        });
    });
}

// Streaming variant for FFmpeg — parses stderr for `time=HH:MM:SS.ms` and calls
// onProgress(currentSec) so callers can compute % of expected duration.
function shWithProgress(cmd, args, opts = {}, onProgress) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, opts);
        let stdout = '';
        let stderr = '';
        let killTimer = null;
        if (opts.timeout) {
            killTimer = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch {}
                reject(new Error(`Command timed out after ${opts.timeout}ms`));
            }, opts.timeout);
        }
        proc.stdout?.on('data', d => { stdout += String(d); });
        proc.stderr?.on('data', d => {
            const chunk = String(d);
            stderr += chunk;
            if (onProgress) {
                // FFmpeg emits "time=HH:MM:SS.ms" repeatedly during encode
                const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/g;
                let match, last = null;
                while ((match = m.exec(chunk)) !== null) last = match;
                if (last) {
                    const sec = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
                    try { onProgress(sec); } catch {}
                }
            }
        });
        proc.on('close', code => {
            if (killTimer) clearTimeout(killTimer);
            if (code === 0) resolve({ stdout, stderr });
            else {
                const err = new Error(`Command failed (exit ${code}): ${cmd}`);
                err.stderr = stderr;
                reject(err);
            }
        });
        proc.on('error', err => {
            if (killTimer) clearTimeout(killTimer);
            reject(err);
        });
    });
}

function hashUrl(url) {
    return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
}

// Canonicalize a URL for dedup purposes — drops query string + fragment.
// This way "https://bilibili.tv/th/video/123?ref=a" and "?ref=b" hash the same.
function canonicalUrl(url) {
    try {
        const u = new URL(url);
        return u.origin + u.pathname;
    } catch { return String(url || ''); }
}

// Return the set of canonical URLs that have already been scouted/processed.
// Used to skip duplicate clips in both preview and pipeline-start flows.
function getUsedCanonicalUrls(db) {
    try {
        const rows = db.prepare(`SELECT source_url FROM scouted_videos`).all();
        return new Set(rows.map(r => canonicalUrl(r.source_url)));
    } catch {
        return new Set();
    }
}

async function ffprobeDuration(file) {
    const res = await sh(FFMPEG(), ['-i', file, '-hide_banner']).catch(err => ({ stderr: err.stderr || '' }));
    const match = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(res.stderr || '');
    if (!match) return 0;
    const [, h, m, s] = match;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

// Fetch real video title from a URL via yt-dlp (no download, just metadata).
// Used when the user pastes a direct URL so the cover generator + caption can
// use the real show name instead of the file-hash filename.
async function fetchVideoTitle(url) {
    try {
        const res = await sh(YTDLP(), ['--skip-download', '--print', 'title', '--no-playlist', url], {
            timeout: 30000
        });
        const title = (res.stdout || '').trim().split('\n')[0];
        return title && title.length > 1 ? title : null;
    } catch {
        return null;
    }
}

// Download a reference thumbnail from a URL to a local file.
// Returns the local path, or null on any failure (caller handles gracefully).
// We save these next to the videos so they survive if bilibili later blocks the URL.
async function downloadThumbnail(url, outPath) {
    if (!url) return null;
    try {
        const res = await fetch(url, {
            redirect: 'follow',
            headers: {
                // bilibili sometimes gates thumbnails behind a browser-like UA
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1024) return null;  // smaller than 1 KB = probably placeholder/error
        fs.writeFileSync(outPath, buf);
        return outPath;
    } catch (err) {
        console.warn('[orchestrator] thumbnail download failed:', err.message);
        return null;
    }
}

async function downloadVideo(url, onLog) {
    const id = hashUrl(url);
    const outPath = path.join(DOWNLOADS(), `video_${id}.%(ext)s`);

    onLog?.('download: starting yt-dlp...');
    // bilibili.tv (BiliIntl) serves video + audio separately (DASH).
    // Use bv*+ba (best video + best audio) and merge to mp4 via FFmpeg.
    // Fallback "b" picks any single combined file if available.
    // yt-dlp --ffmpeg-location accepts EITHER the binary path OR the directory
    // containing ffmpeg.exe + ffprobe.exe. We pass the directory so it can find both.
    const ffmpegPath = FFMPEG();
    const ffmpegDir = (ffmpegPath && ffmpegPath !== 'ffmpeg' && fs.existsSync(ffmpegPath))
        ? path.dirname(ffmpegPath)
        : null;

    const ytdlpArgs = [
        '-f', 'bv*+ba/b',
        '--merge-output-format', 'mp4',
        '--no-playlist',
        '--no-warnings',
        '--retries', '3',
        '-o', outPath
    ];
    if (ffmpegDir) ytdlpArgs.push('--ffmpeg-location', ffmpegDir);
    ytdlpArgs.push(url);
    await sh(YTDLP(), ytdlpArgs, { timeout: 900000 });   // 15 min

    // yt-dlp writes video_<id>.mp4 (or other ext if merge failed)
    const prefix = `video_${id}.`;
    const files = fs.readdirSync(DOWNLOADS()).filter(f => f.startsWith(prefix) && !f.endsWith('.part'));
    if (!files.length) throw new Error('yt-dlp finished but no file found');

    // Detect merge failure: if we have separate .f12.mp4 + .f2.mp4 instead of a merged .mp4,
    // that means FFmpeg couldn't run. Abort with a clear message.
    const mergedMp4 = files.find(f => f === `video_${id}.mp4`);
    if (!mergedMp4) {
        const fragments = files.filter(f => /\.f\d+\.(mp4|webm|m4a)$/.test(f));
        if (fragments.length > 0) {
            // Clean up fragments so next retry doesn't re-use them
            for (const frag of fragments) {
                try { fs.unlinkSync(path.join(DOWNLOADS(), frag)); } catch {}
            }
            throw new Error('ดาวน์โหลดสำเร็จแต่ merge video+audio ล้มเหลว — FFmpeg อาจโดน Windows Device Guard block · ไปตั้งค่าเมนู "Settings" กด "ตรวจ dependencies ใหม่"');
        }
    }

    // Prefer .mp4 over other extensions
    files.sort((a, b) => {
        if (a.endsWith('.mp4') && !b.endsWith('.mp4')) return -1;
        if (!a.endsWith('.mp4') && b.endsWith('.mp4')) return 1;
        return 0;
    });
    const finalPath = path.join(DOWNLOADS(), files[0]);

    // Validate the file is a real video (size > 1 MB and readable)
    const stat = fs.statSync(finalPath);
    if (stat.size < 1024 * 1024) {
        throw new Error(`ไฟล์ที่ download มาเล็กเกินไป (${(stat.size/1024).toFixed(1)} KB) — น่าจะ download ไม่สมบูรณ์`);
    }

    onLog?.(`download: saved ${files[0]} (${(stat.size/1024/1024).toFixed(1)} MB)`);
    return { path: finalPath, id };
}

async function sliceClip(videoPath, outPath, startSec, durSec, onPct, speedFactor = 1.0) {
    // speedFactor: 1.0 = normal · 1.1 = 10% faster (common copyright-evasion) · max 2.0
    // Clamp to sane range to avoid breaking FFmpeg
    const speed = Math.max(1.0, Math.min(2.0, Number(speedFactor) || 1.0));
    const sped = Math.abs(speed - 1.0) > 0.01;

    // When sped up, we need to READ more source content so the output still lasts `durSec`.
    // Example: dur=75s, speed=1.1 → read 82.5s of source, speed-up to fit 75s.
    // This packs more content into the same clip length AND shifts audio fingerprint.
    const sourceReadDur = durSec * speed;

    const args = ['-y', '-ss', String(startSec), '-i', videoPath, '-t', String(sourceReadDur)];
    if (sped) {
        // Video: setpts=PTS/N speeds the video up N× while keeping frame quality
        // Audio: atempo=N speeds audio N× WITHOUT changing pitch (perfect for copyright
        // evasion — fingerprint algorithms key off timing + pitch patterns, both shift slightly)
        args.push('-filter_complex', `[0:v]setpts=PTS/${speed}[v];[0:a]atempo=${speed}[a]`);
        args.push('-map', '[v]', '-map', '[a]');
    }
    args.push(
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        outPath
    );

    // Progress reporting: when sped-up, FFmpeg's "time=" counter is against the OUTPUT
    // duration (durSec), so percent math stays correct.
    if (onPct) {
        await shWithProgress(FFMPEG(), args, { timeout: 1800000 }, (sec) => {
            const pct = Math.max(0, Math.min(100, Math.round((sec / durSec) * 100)));
            onPct(pct);
        });
    } else {
        await sh(FFMPEG(), args, { timeout: 1800000 });
    }
    // SAFETY: verify FFmpeg actually produced a valid file (disk-full / Device Guard kill
    // sometimes leaves a truncated file that passes fs.existsSync but is useless).
    if (!fs.existsSync(outPath)) {
        throw new Error('FFmpeg จบแล้วแต่หาไฟล์ผลลัพธ์ไม่เจอ (อาจ disk เต็มหรือถูกโปรแกรม antivirus ลบ)');
    }
    const sz = fs.statSync(outPath).size;
    if (sz < 100 * 1024) {  // < 100 KB = corrupt/empty
        try { fs.unlinkSync(outPath); } catch {}
        throw new Error(`ตัดคลิปเสร็จแต่ไฟล์เล็กผิดปกติ (${(sz/1024).toFixed(1)} KB) — อาจ disk เต็มหรือ encode ผิดพลาด`);
    }
    return outPath;
}

async function applyBannerOverlay(videoPath, outPath, layers, bannersDb, outputSize = { w: 1080, h: 1920 }, onPct, totalDurSec) {
    if (!layers || layers.length === 0) {
        // No overlays — just copy
        fs.copyFileSync(videoPath, outPath);
        return outPath;
    }

    const sorted = [...layers].sort((a, b) => a.z_index - b.z_index);
    const validLayers = [];
    const args = ['-y', '-i', videoPath];

    for (const layer of sorted) {
        const banner = bannersDb.prepare('SELECT * FROM banners WHERE id = ?').get(layer.banner_id);
        if (!banner || !fs.existsSync(banner.file_path)) continue;
        args.push('-i', banner.file_path);
        validLayers.push({ ...layer, banner });
    }

    if (validLayers.length === 0) {
        fs.copyFileSync(videoPath, outPath);
        return outPath;
    }

    const filters = [];
    filters.push(`[0:v]scale=${outputSize.w}:${outputSize.h}:force_original_aspect_ratio=decrease,pad=${outputSize.w}:${outputSize.h}:(ow-iw)/2:(oh-ih)/2:black[base0]`);

    let currentLabel = 'base0';
    for (let i = 0; i < validLayers.length; i++) {
        const layer = validLayers[i];
        const inputIdx = i + 1;
        const bannerLabel = `bn${i}`;
        const outLabel = (i === validLayers.length - 1) ? 'vout' : `tmp${i}`;

        const targetWidth = Math.round(outputSize.w * layer.size.width / 100);
        filters.push(`[${inputIdx}:v]scale=${targetWidth}:-1[${bannerLabel}_scaled]`);
        let bnChain = `${bannerLabel}_scaled`;

        if (layer.opacity < 100) {
            const alpha = layer.opacity / 100;
            filters.push(`[${bnChain}]format=rgba,colorchannelmixer=aa=${alpha}[${bannerLabel}_op]`);
            bnChain = `${bannerLabel}_op`;
        }

        const posX = `(main_w-overlay_w)*${layer.position.x / 100}`;
        const posY = `(main_h-overlay_h)*${layer.position.y / 100}`;

        let enable = '';
        if (layer.timing.start > 0 || layer.timing.end > 0) {
            const start = layer.timing.start;
            const end = layer.timing.end > 0 ? layer.timing.end : 999999;
            enable = `:enable='between(t,${start},${end})'`;
        }

        filters.push(`[${currentLabel}][${bnChain}]overlay=${posX}:${posY}${enable}[${outLabel}]`);
        currentLabel = outLabel;
    }

    args.push('-filter_complex', filters.join(';'),
              '-map', '[vout]', '-map', '0:a?',
              '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
              '-c:a', 'aac', '-b:a', '128k',
              '-movflags', '+faststart',
              outPath);

    if (onPct && totalDurSec) {
        await shWithProgress(FFMPEG(), args, { timeout: 1800000 }, (sec) => {
            const pct = Math.max(0, Math.min(100, Math.round((sec / totalDurSec) * 100)));
            onPct(pct);
        });
    } else {
        await sh(FFMPEG(), args, { timeout: 1800000 });
    }
    // SAFETY: verify output is valid (see sliceClip note)
    if (!fs.existsSync(outPath)) {
        throw new Error('ใส่แบนเนอร์เสร็จแต่หาไฟล์ผลลัพธ์ไม่เจอ');
    }
    const sz = fs.statSync(outPath).size;
    if (sz < 100 * 1024) {
        try { fs.unlinkSync(outPath); } catch {}
        throw new Error(`ใส่แบนเนอร์เสร็จแต่ไฟล์เล็กผิดปกติ (${(sz/1024).toFixed(1)} KB)`);
    }
    return outPath;
}

async function makeSet2(inputVideo, outPath) {
    // Mirror horizontally + pitch shift audio +2 semitones + zoom 1.05x
    await sh(FFMPEG(), [
        '-y', '-i', inputVideo,
        '-vf', 'hflip,scale=iw*1.05:ih*1.05,crop=iw/1.05:ih/1.05',
        '-af', 'rubberband=pitch=1.122', // 2 semitones up
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        outPath
    ], { timeout: 300000 }).catch(async () => {
        // Fallback without rubberband (not all ffmpeg builds have it) — use asetrate trick
        await sh(FFMPEG(), [
            '-y', '-i', inputVideo,
            '-vf', 'hflip',
            '-af', 'asetrate=48000*1.059,aresample=48000,atempo=0.944',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '128k',
            outPath
        ], { timeout: 300000 });
    });
    return outPath;
}

async function audioFingerprint(file) {
    try {
        const { stdout } = await sh(FPCALC(), ['-raw', '-length', '20', file], { timeout: 30000 });
        const match = /FINGERPRINT=([^\n\r]+)/.exec(stdout);
        return match ? match[1].trim() : null;
    } catch (e) {
        return null;
    }
}

// ----------------------------------------------------------------
// High-level Orchestrator (wraps everything for server.js)
// ----------------------------------------------------------------
class Orchestrator {
    constructor({ db, captionService, coverService, io, logger }) {
        this.db = db;
        this.captionService = captionService;
        this.coverService = coverService;
        this.io = io;
        this.log = logger || console.log;
        this.running = new Map();
    }

    /**
     * Entry point: given a URL + page(s) + preset, build all clips & queue them.
     * Returns immediately with a runId; actual work happens in background.
     *
     * Per-page semantics:
     *   - `clipsPerPage` = how many SOURCE VIDEOS to scout for each page (1 video = N sub-clips)
     *   - `keyword` (optional global override) — if empty, each page uses its own default_keyword
     *   - `pageKeywords` = { pageId: keyword } — caller-resolved per-page defaults (lookup happens
     *     in server.js so the orchestrator stays DB-agnostic about the override logic)
     *
     * sourceUrl path: 1 URL → 1 page (first selected). Multi-page sourceUrl makes no sense
     * because the same video would be posted to multiple pages — caller is warned in UI.
     */
    enqueue({ pageId, pageIds, sourceUrl, keyword, pageKeywords, presetId,
              clipsPerVideo, clipDurationSec, clipsPerPage, scoutLimit,
              useWatcherCaption,    // ✅ Channel Watcher's separate caption prompt
              skipAutoEdit }) {     // ✅ NEW: ปิดตัดต่ออัตโนมัติ — โพสต์ raw clip ตรงๆ
        if (!sourceUrl && !keyword && !pageKeywords) {
            throw new Error('Must provide sourceUrl, keyword, or pageKeywords');
        }
        const targetPageIds = Array.isArray(pageIds) && pageIds.length ? pageIds : (pageId ? [pageId] : []);
        if (!targetPageIds.length) throw new Error('Must provide page_id or page_ids[]');

        // Backward compat: old callers used scoutLimit (total clips, round-robin).
        // New callers use clipsPerPage (clips per page, dedicated). If only scoutLimit
        // is given, treat it as `Math.ceil(scoutLimit / pageCount)` per page so existing
        // single-page callers behave identically.
        const perPage = Math.max(1, Number(clipsPerPage)
            || Math.ceil(Number(scoutLimit || 1) / targetPageIds.length));

        const runId = `run_${Date.now()}`;
        this.running.set(runId, {
            status: 'starting',
            sourceUrl: sourceUrl || `keyword:${keyword || '(per-page)'}`,
            pageIds: targetPageIds
        });

        setImmediate(async () => {
            try {
                if (sourceUrl) {
                    // Single URL → single page (first selected). Posting the same video to
                    // multiple pages would create duplicate content across pages.
                    const firstPageId = targetPageIds[0];
                    if (targetPageIds.length > 1) {
                        this.log(`[orchestrator] sourceUrl + ${targetPageIds.length} pages — only first page (${firstPageId}) gets the clip`);
                        this.io?.emit('pipeline:phase', {
                            runId, phase: 'sourceUrl_one_page_only',
                            pageId: firstPageId,
                            ignoredPages: targetPageIds.slice(1)
                        });
                    }
                    let directTitle = null;
                    try {
                        directTitle = await fetchVideoTitle(sourceUrl);
                        this.log(`[orchestrator] yt-dlp title for direct URL: "${directTitle}"`);
                    } catch (e) {
                        this.log(`[orchestrator] could not fetch title, will use filename:`, e.message);
                    }
                    await this._execute(runId, {
                        pageId: firstPageId,
                        sourceUrl,
                        hintedTitle: directTitle,
                        hintedThumbnail: null,
                        hintedKeyword: null,
                        presetId, clipsPerVideo, clipDurationSec,
                        useWatcherCaption,    // ✅ pass-through
                        skipAutoEdit          // ✅ NEW: pass-through
                    });
                } else {
                    // Keyword path — group pages by their effective keyword and scout once
                    // per group. Pages without a keyword (no global override + no default) are
                    // skipped, surfaced via socket so the UI can warn.
                    const skippedPages = [];
                    const groups = new Map();   // effectiveKeyword -> [pageId, ...]
                    for (const pid of targetPageIds) {
                        const effKw = (keyword && keyword.trim())
                            || (pageKeywords && pageKeywords[pid] && String(pageKeywords[pid]).trim())
                            || null;
                        if (!effKw) { skippedPages.push(pid); continue; }
                        if (!groups.has(effKw)) groups.set(effKw, []);
                        groups.get(effKw).push(pid);
                    }
                    if (skippedPages.length) {
                        this.log(`[orchestrator] skipped pages with no keyword: ${skippedPages.join(', ')}`);
                        this.io?.emit('pipeline:phase', {
                            runId, phase: 'pages_skipped_no_keyword',
                            pages: skippedPages
                        });
                    }
                    if (!groups.size) {
                        throw new Error('ไม่มีเพจไหนมี keyword (ทั้ง global override และ default ของเพจ) — ใส่ keyword ก่อนกด "เริ่มงาน"');
                    }

                    // Scout each group, build [{pageId, item}] work list. Each page gets
                    // exactly `perPage` source videos (or fewer if scout doesn't return enough).
                    const allWork = [];
                    for (const [kw, pages] of groups) {
                        const needed = perPage * pages.length;
                        this.io?.emit('pipeline:phase', {
                            runId, phase: 'scouting',
                            keyword: kw, pages: pages.length, needed
                        });
                        const { scoutBilibili } = require('./scout');
                        const fetchLimit = Math.max(needed * 3, 12);
                        const results = await scoutBilibili(kw, {
                            limit: fetchLimit,
                            onLog: m => this.log('[scout]', m)
                        });
                        if (!results.length) {
                            this.log(`[orchestrator] keyword "${kw}": no results · pages [${pages.join(',')}] get nothing`);
                            this.io?.emit('pipeline:phase', {
                                runId, phase: 'scout_empty', keyword: kw, pages
                            });
                            continue;
                        }
                        const urlHashes = results.map(r => hashUrl(r.url));
                        const usedRows = this.db.prepare(
                            `SELECT url_hash FROM scouted_videos WHERE url_hash IN (${urlHashes.map(() => '?').join(',')})`
                        ).all(...urlHashes);
                        const usedSet = new Set(usedRows.map(r => r.url_hash));
                        const fresh = results.filter(r => !usedSet.has(hashUrl(r.url)));
                        const filteredCount = results.length - fresh.length;
                        if (filteredCount > 0) {
                            this.log(`[orchestrator] keyword "${kw}": filtered ${filteredCount} already-used; ${fresh.length} fresh remaining`);
                        }
                        if (!fresh.length) {
                            this.log(`[orchestrator] keyword "${kw}": all ${results.length} clips already processed · pages [${pages.join(',')}] get nothing`);
                            this.io?.emit('pipeline:phase', {
                                runId, phase: 'scout_all_used',
                                keyword: kw, pages, total: results.length
                            });
                            continue;
                        }
                        const taken = fresh.slice(0, Math.min(fresh.length, needed)).map(r => ({
                            url: r.url, title: r.title, thumbnail: r.thumbnail, keyword: kw
                        }));
                        // Dedicated assignment: page A gets clips 1..perPage,
                        // page B gets clips perPage+1..2*perPage, etc. NOT round-robin.
                        // Pages at the tail may get fewer if scout came up short.
                        let cursor = 0;
                        const pagesGotSomething = [];
                        for (const pid of pages) {
                            let assignedCount = 0;
                            for (let i = 0; i < perPage && cursor < taken.length; i++) {
                                allWork.push({ pageId: pid, item: taken[cursor++] });
                                assignedCount++;
                            }
                            if (assignedCount > 0) pagesGotSomething.push({ pid, count: assignedCount });
                            else this.log(`[orchestrator] keyword "${kw}": page ${pid} got 0 clips (scout returned ${taken.length}, needed ${needed})`);
                        }
                        this.io?.emit('pipeline:phase', {
                            runId, phase: 'scout_done',
                            keyword: kw,
                            count: taken.length,
                            assigned: pagesGotSomething,
                            filtered_out: filteredCount,
                            candidates: taken
                        });
                    }

                    if (!allWork.length) {
                        throw new Error('ค้นแล้วไม่ได้คลิปสำหรับเพจไหนเลย — ลองเปลี่ยน keyword หรือเช็คว่า bilibili มีคลิปจริง');
                    }

                    // Concurrency: 2 in parallel for download/slice/banner pace
                    const PIPELINE_CONCURRENCY = 2;
                    let cursor = 0;
                    const runNext = async () => {
                        while (cursor < allWork.length) {
                            const idx = cursor++;
                            const t = allWork[idx];
                            this.log(`[orchestrator] task ${idx + 1}/${allWork.length}: page ${t.pageId} · "${t.item.title || '(none)'}"`);
                            try {
                                await this._execute(runId, {
                                    pageId: t.pageId,
                                    sourceUrl: t.item.url,
                                    hintedTitle: t.item.title,
                                    hintedThumbnail: t.item.thumbnail,
                                    hintedKeyword: t.item.keyword,
                                    presetId, clipsPerVideo, clipDurationSec
                                });
                            } catch (err) {
                                this.log(`[orchestrator] task ${idx + 1} failed: ${err.message}`);
                            }
                        }
                    };
                    const workers = [];
                    for (let w = 0; w < Math.min(PIPELINE_CONCURRENCY, allWork.length); w++) {
                        workers.push(runNext());
                    }
                    await Promise.all(workers);
                }
            } catch (err) {
                this.log('[orchestrator] pipeline failed:', err.message);
                this.running.set(runId, { status: 'failed', error: err.message });
                this.io?.emit('pipeline:failed', { runId, error: err.message });
            }
        });

        return { runId, pageCount: targetPageIds.length };
    }

    async _execute(runId, { pageId, sourceUrl, hintedTitle, hintedThumbnail, hintedKeyword, presetId, clipsPerVideo = 4, clipDurationSec = 75, useWatcherCaption = false, skipAutoEdit = false }) {
        const emit = (phase, data) => {
            this.log(`[orchestrator] ${runId} ${phase}:`, JSON.stringify(data).slice(0, 150));
            this.io?.emit('pipeline:phase', { runId, phase, ...data });
        };

        emit('download_start', { sourceUrl, pageId });
        this.running.set(runId, { status: 'downloading', sourceUrl });

        // 1. Check dedup by URL hash
        const urlHash = hashUrl(sourceUrl);
        let scoutedRow = this.db.prepare(`SELECT * FROM scouted_videos WHERE url_hash = ?`).get(urlHash);

        // CRITICAL: INSERT scouted_videos row IMMEDIATELY (before download) so that
        // future searches filter this URL out as "already selected" — even if the
        // download fails or takes a long time. Without this, user could re-pick the
        // same URL while it's still downloading.
        if (!scoutedRow) {
            const placeholderTitle = hintedTitle || `(กำลังดาวน์โหลด) ${sourceUrl.slice(-40)}`;
            const result = this.db.prepare(`
                INSERT OR IGNORE INTO scouted_videos
                (source, source_url, url_hash, title, keyword, thumbnail_url, downloaded_at)
                VALUES ('manual', ?, ?, ?, ?, ?, NULL)
            `).run(sourceUrl, urlHash, placeholderTitle, hintedKeyword || null, hintedThumbnail || null);
            // Re-read to get either the new row or the existing one (race-safe)
            scoutedRow = this.db.prepare(`SELECT * FROM scouted_videos WHERE url_hash = ?`).get(urlHash);
            this.log(`[orchestrator] reserved scouted_video #${scoutedRow?.id} for URL (placeholder, file_path=NULL)`);
        }

        // Upgrade row with better metadata if we have it (and existing row was a placeholder)
        if (scoutedRow) {
            const updates = [];
            const vals = [];
            const titleIsPlaceholder = /^\(กำลังดาวน์โหลด\)/.test(scoutedRow.title || '')
                                    || /^video_[a-f0-9]+$/i.test(scoutedRow.title || '');
            if (hintedTitle && titleIsPlaceholder) {
                updates.push('title = ?'); vals.push(hintedTitle);
                scoutedRow.title = hintedTitle;
            }
            if (hintedThumbnail && !scoutedRow.thumbnail_url) {
                updates.push('thumbnail_url = ?'); vals.push(hintedThumbnail);
                scoutedRow.thumbnail_url = hintedThumbnail;
            }
            if (hintedKeyword && !scoutedRow.keyword) {
                updates.push('keyword = ?'); vals.push(hintedKeyword);
                scoutedRow.keyword = hintedKeyword;
            }
            if (updates.length) {
                vals.push(scoutedRow.id);
                this.db.prepare(`UPDATE scouted_videos SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
                this.log(`[orchestrator] upgraded scouted_video #${scoutedRow.id}: ${updates.join(' + ')}`);
            }
        }

        let videoPath;
        if (scoutedRow && scoutedRow.file_path && fs.existsSync(scoutedRow.file_path)) {
            videoPath = scoutedRow.file_path;
            emit('download_cache_hit', { path: videoPath });
        } else {
            const { path: downloadedPath } = await downloadVideo(sourceUrl, msg => emit('download_log', { msg }));
            videoPath = downloadedPath;

            const duration = await ffprobeDuration(videoPath);
            const fileSize = fs.statSync(videoPath).size;

            // Prefer real title from scout, falling back to yt-dlp, then filename
            let realTitle = hintedTitle;
            if (!realTitle) {
                try { realTitle = await fetchVideoTitle(sourceUrl); } catch {}
            }
            if (!realTitle) realTitle = path.basename(videoPath, path.extname(videoPath));

            // UPDATE the placeholder row with download details (the row already exists from
            // the early INSERT above — see "reserved scouted_video" log)
            this.db.prepare(`
                UPDATE scouted_videos
                SET title = COALESCE(NULLIF(?, ''), title),
                    duration_sec = ?,
                    file_path = ?,
                    file_size = ?,
                    downloaded_at = datetime('now', 'localtime')
                WHERE id = ?
            `).run(realTitle, Math.floor(duration), videoPath, fileSize, scoutedRow.id);
            scoutedRow = this.db.prepare(`SELECT * FROM scouted_videos WHERE id = ?`).get(scoutedRow.id);
        }

        // 1b. Download thumbnail reference image (once per video, not per clip)
        //     Used by the cover generator to "match the show" — AI sees the real show image.
        if (scoutedRow && scoutedRow.thumbnail_url && !scoutedRow.thumbnail_local_path) {
            const ext = /\.(jpg|jpeg|png|webp)(\?|$)/i.exec(scoutedRow.thumbnail_url)?.[1] || 'jpg';
            const refOut = path.join(COVERS_DIR(), `ref_${scoutedRow.id}.${ext}`);
            emit('thumbnail_downloading', { url: scoutedRow.thumbnail_url });
            const saved = await downloadThumbnail(scoutedRow.thumbnail_url, refOut);
            if (saved) {
                this.db.prepare('UPDATE scouted_videos SET thumbnail_local_path = ? WHERE id = ?')
                    .run(saved, scoutedRow.id);
                scoutedRow.thumbnail_local_path = saved;
                this.log(`[orchestrator] reference thumbnail saved → ${saved}`);
            }
        }

        const duration = scoutedRow.duration_sec || await ffprobeDuration(videoPath);
        if (duration < clipDurationSec) {
            throw new Error(`คลิปสั้นเกินไป (${duration}s < ${clipDurationSec}s)`);
        }

        // 2. Compute clip windows
        const clipWindows = this._pickClipWindows(duration, clipsPerVideo, clipDurationSec);
        emit('slicing_start', { windows: clipWindows.length });

        // 3. Get banner preset (if any)
        let presetLayers = [];
        if (presetId) {
            const preset = this.db.prepare('SELECT layers_json FROM banner_presets WHERE id = ?').get(presetId);
            if (preset) {
                try { presetLayers = JSON.parse(preset.layers_json) || []; }
                catch (e) { console.warn('[orchestrator] preset', presetId, 'parse failed:', e.message); }
            }
        }

        // 4. Get the SINGLE assigned page for this video
        const targetPage = this.db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId);
        if (!targetPage) throw new Error(`Page ${pageId} not found`);

        this.db.prepare('UPDATE scouted_videos SET assigned_page_id = ? WHERE id = ? AND assigned_page_id IS NULL')
               .run(pageId, scoutedRow.id);

        // Find the latest scheduled time for this page so we don't double-book.
        //
        // Include: pending / running / posted / processing / copyright_waiting
        // Exclude: 'failed' / 'cancelled' — user dropped them, they shouldn't shift schedules.
        //
        // Also: only count jobs whose scheduled_at is in the future (tolerate 1 day
        // into the past for recently-posted clips). Prevents ancient processing rows
        // (left by a crashed pipeline that never got swept) from shifting schedules.
        const lastScheduled = this.db.prepare(`
            SELECT MAX(scheduled_at) AS t FROM jobs
            WHERE page_id = ?
              AND status IN ('pending', 'running', 'posted', 'processing', 'copyright_waiting')
              AND datetime(scheduled_at) > datetime('now', 'localtime', '-1 day')
        `).get(targetPage.id);

        // "Each new set gets a fresh day" policy (user request):
        //   • First set ever (nothing scheduled) → start from now → fills today's remaining slots
        //   • Additional sets → start at 00:00 of the day AFTER last scheduled clip.
        //     nextPeakSlotAfter() will round up to 07:00 (first peak of that day).
        // This keeps each queued set clearly bundled on one day instead of splitting
        // across "last slot of today + first slots of tomorrow" which confused users.
        let startFrom;
        if (lastScheduled?.t) {
            const lastDate = new Date(lastScheduled.t.replace(' ', 'T'));
            // Midnight of the day AFTER lastScheduled (local)
            const nextDayMidnight = new Date(
                lastDate.getFullYear(),
                lastDate.getMonth(),
                lastDate.getDate() + 1,
                0, 0, 0, 0
            );
            // Guard against clock skew: never start before "now"
            startFrom = new Date(Math.max(Date.now(), nextDayMidnight.getTime()));
        } else {
            startFrom = new Date();
        }

        // Plan ALL clips across peak slots — first batch immediate, rest auto-spread
        const cooldownMin = targetPage.cooldown_min || 30;
        const schedule = planClipSchedule(clipWindows.length, startFrom, cooldownMin);
        emit('schedule_planned', {
            count: schedule.length,
            firstSlot: friendlyThaiDate(schedule[0].date),
            lastSlot: friendlyThaiDate(schedule[schedule.length - 1].date)
        });

        // ── NEW: Insert all clip + job rows UPFRONT with status='processing' ──
        // This lets the user see the upcoming clips in the Queue immediately while
        // the pipeline works in the background (slicing takes minutes for long clips).
        const prePlaced = [];
        for (let i = 0; i < clipWindows.length; i++) {
            const { start, dur } = clipWindows[i];
            // ✅ FIX multi-page race: เดิม path = clip_<scoutedId>_<idx>_set1.mp4
            //   → multi-page approve = หลาย enqueue ใช้ scoutedId เดียวกัน (dedup by urlHash)
            //   → FFmpeg เขียนไฟล์เดียวกัน race condition → "FFmpeg จบแล้วหาไฟล์ผลลัพธ์ไม่เจอ"
            // ใหม่: ใส่ pageId ใน path → แต่ละเพจมีไฟล์แยก ไม่ชนกัน
            const set1Path = path.join(CLIPS_DIR(), `clip_${scoutedRow.id}_p${targetPage.id}_${i + 1}_set1.mp4`);
            // SAFETY: Windows API limit is 260 chars. FFmpeg fails cryptically beyond this.
            if (set1Path.length > 250) {
                throw new Error(`เส้นทางไฟล์ยาวเกิน Windows รองรับ (${set1Path.length} > 250 chars) — เปลี่ยนที่เก็บให้สั้นลง เช่น C:\\clips\\`);
            }
            const clipResultPre = this.db.prepare(`
                INSERT INTO clips (scouted_id, clip_index, start_sec, end_sec, set1_path, caption, status, assigned_page_id)
                VALUES (?, ?, ?, ?, ?, ?, 'processing', ?)
            `).run(scoutedRow.id, i + 1, start, start + dur, set1Path, '', targetPage.id);
            const clipDbIdPre = clipResultPre.lastInsertRowid;
            const planEntryPre = schedule[i];
            const scheduledSqlPre = toSqlLocal(planEntryPre.date);
            const jobResultPre = this.db.prepare(`
                INSERT INTO jobs (clip_id, page_id, scheduled_at, use_set, status, error_message)
                VALUES (?, ?, ?, 1, 'processing', ?)
            `).run(clipDbIdPre, targetPage.id, scheduledSqlPre, 'กำลังเตรียมคลิป (ดาวน์โหลด/ตัด/ใส่แบนเนอร์)...');
            prePlaced.push({ clipDbId: clipDbIdPre, jobId: jobResultPre.lastInsertRowid, set1Path });
            this.io?.emit('job:created', { jobId: jobResultPre.lastInsertRowid, clipId: clipDbIdPre, status: 'processing' });
        }

        const createdClips = [];
        try {
        for (let i = 0; i < clipWindows.length; i++) {
            const { start, dur } = clipWindows[i];
            const clipId = `${scoutedRow.id}_${i + 1}`;
            const set1Path = prePlaced[i].set1Path;
            const { clipDbId: preClipId, jobId: preJobId } = prePlaced[i];

            emit('slicing_clip', { index: i + 1, of: clipWindows.length });
            const bumpJobMsg = (msg) => this.db.prepare(`UPDATE jobs SET error_message = ? WHERE id = ?`).run(msg, preJobId);

            // Throttle UI updates to avoid hammering SQLite: max 1 update per 800ms.
            let lastPctUpdate = 0;
            const throttledPct = (label, pct) => {
                const now = Date.now();
                if (pct >= 100 || now - lastPctUpdate >= 800) {
                    lastPctUpdate = now;
                    bumpJobMsg(`${label} ${pct}%`);
                }
            };

            // Speed-up factor for copyright evasion (read once per loop — cheap)
            const speedFactor = (() => {
                try {
                    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'slice_speed_factor'`).get();
                    const n = Number(row?.value);
                    return Number.isFinite(n) && n >= 1.0 && n <= 2.0 ? n : 1.0;
                } catch { return 1.0; }
            })();

            const speedMsg = speedFactor > 1.0 ? ` (เร่ง ${speedFactor}x)` : '';

            // ✅ NEW: skipAutoEdit = true → ไม่ slice/banner — copy raw clip ตรงๆ → set1Path
            // (toggle ใน watcher: "ปิดตัดต่ออัตโนมัติ" → โพสต์คลิปต้นฉบับเลย)
            if (skipAutoEdit) {
                bumpJobMsg(`📋 ตัดต่ออัตโนมัติปิดอยู่ — copy คลิปเต็ม...`);
                try {
                    fs.copyFileSync(videoPath, set1Path);
                } catch (copyErr) {
                    throw new Error(`copy raw clip ไม่สำเร็จ: ${copyErr.message}`);
                }
                bumpJobMsg(`✓ ใช้คลิปต้นฉบับ (ไม่ตัดต่อ) · กำลังสแกนเสียง...`);
            } else {
                bumpJobMsg(`✂️ กำลังตัดคลิป ${i + 1}/${clipWindows.length}${speedMsg} · 0%`);

                // Slice raw clip first — with live percent + speed factor
                const rawTmp = path.join(CLIPS_DIR(), `_raw_${clipId}.mp4`);
                await sliceClip(videoPath, rawTmp, start, dur, (pct) => {
                    throttledPct(`✂️ กำลังตัดคลิป ${i + 1}/${clipWindows.length}${speedMsg}`, pct);
                }, speedFactor);
                bumpJobMsg(`✓ ตัดคลิป ${i + 1}/${clipWindows.length} เสร็จ · เริ่มใส่แบนเนอร์...`);

                // Apply banner overlay if any — with live percent
                if (presetLayers.length > 0) {
                    lastPctUpdate = 0;
                    await applyBannerOverlay(rawTmp, set1Path, presetLayers, this.db, undefined, (pct) => {
                        throttledPct(`🖼 กำลังใส่แบนเนอร์ ${i + 1}/${clipWindows.length}`, pct);
                    }, dur);
                    try { fs.unlinkSync(rawTmp); } catch {}
                } else {
                    fs.renameSync(rawTmp, set1Path);
                }
                bumpJobMsg(`✓ ใส่แบนเนอร์เสร็จ · กำลังสแกนเสียง...`);
            }

            // Fingerprint Set 1
            let audioFp = null;
            try {
                audioFp = await audioFingerprint(set1Path);
            } catch {}

            // Check against blacklist BEFORE generating Set 2 (save time)
            let skipReason = null;
            if (audioFp) {
                const blacklisted = this.db.prepare('SELECT id FROM copyright_blacklist WHERE audio_fp = ?').get(audioFp);
                if (blacklisted) skipReason = 'blacklist_match';
            }
            bumpJobMsg(`กำลังให้ AI เขียนแคปชั่น...`);

            // Generate Set 2 lazily — only when needed (on copyright hit)
            // But persist the plan — we'll create Set 2 on demand

            // 5. Generate caption per page's context
            // ✅ NEW: ถ้ามาจาก Channel Watcher (useWatcherCaption=true) → ใช้ generateForWatcher
            // (separate prompt จากของหลัก — ไม่กระทบ flow ปกติ)
            let caption = null;
            try {
                const ctx = {
                    videoTitle: scoutedRow.title || 'คลิป',
                    niche: targetPage.niche || '',
                    duration: dur,
                    clipNumber: i + 1,
                    totalClips: clipWindows.length,
                    sourceUrl: sourceUrl || '',
                    channelLabel: hintedKeyword || ''
                };
                caption = useWatcherCaption && typeof this.captionService.generateForWatcher === 'function'
                    ? await this.captionService.generateForWatcher(targetPage.id, ctx)
                    : await this.captionService.generateForPage(targetPage.id, ctx);
            } catch (e) {
                this.log('[orchestrator] caption failed, using fallback:', e.message);
                const safeTitle = (scoutedRow.title || 'คลิปใหม่').slice(0, 120);
                caption = `${safeTitle} EP.${i + 1} 🎬 #${targetPage.niche || 'reel'}`;
            }
            // SAFETY: Facebook Reel caption limit is ~2200 chars but shorter works better.
            // Truncate very long captions to avoid silent clipping by FB.
            if (caption && caption.length > 2100) {
                caption = caption.slice(0, 2080) + '…';
            }

            // 5b. Generate AI cover — STRICT MODE:
            // If cover_enabled is ON, the job MUST have a cover before going to 'pending'.
            // If generation fails (including the frame-extract fallback inside coverService),
            // we mark the job as FAILED and keep it out of the 'pending' queue. This prevents
            // clips without covers from being posted when the user intended them to have one.
            let coverPath = null;
            let coverFatalError = null;
            const coverEnabled = (() => {
                try {
                    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'cover_enabled'`).get();
                    return row?.value === '1' || row?.value === 1 || row?.value === 'true';
                } catch { return false; }
            })();
            if (coverEnabled && this.coverService) {
                // Validate title is usable — don't send "video_<hash>" garbage to the AI
                const titleForCover = scoutedRow.title || '';
                if (!titleForCover.trim() || /^video_[a-f0-9]+$/i.test(titleForCover)) {
                    this.log(`[orchestrator] WARNING: cover will be generated with poor title: "${titleForCover}"`);
                }
                bumpJobMsg(`🎨 กำลังสร้างหน้าปก AI สำหรับ "${titleForCover.slice(0, 40) || 'คลิป'}"...`);
                try {
                    const coverOut = path.join(COVERS_DIR(), `cover_${scoutedRow.id}_${i + 1}.png`);
                    const r = await this.coverService.generateCover({
                        videoPath: set1Path,
                        videoTitle: titleForCover || 'คลิป',
                        niche: targetPage.niche || '',
                        clipIndex: i + 1,
                        totalClips: clipWindows.length,
                        pageOverridePrompt: null,
                        // NEW: extra context to help the AI match the actual show
                        searchKeyword: scoutedRow.keyword || null,
                        referenceImagePath: scoutedRow.thumbnail_local_path || null,
                        outPath: coverOut
                    });
                    coverPath = r.path;
                    // Verify the file actually exists + has content before trusting it
                    if (!fs.existsSync(coverPath) || fs.statSync(coverPath).size < 20 * 1024) {
                        throw new Error(`coverService claimed success but file is missing or < 20KB`);
                    }
                    bumpJobMsg(`✓ หน้าปกเสร็จ (${r.source}) · กำลังสร้างแคปชั่น...`);
                } catch (e) {
                    // Even the FFmpeg frame-extract fallback failed → fatal for this clip
                    coverFatalError = e.message;
                    this.log('[orchestrator] cover FATAL (all fallbacks failed):', e.message);
                }
            }

            // 6. Validate caption — must be non-empty string after all fallbacks.
            // captionService has a template fallback so this should practically never fail,
            // but check defensively.
            let captionFatalError = null;
            if (!caption || typeof caption !== 'string' || caption.trim().length === 0) {
                captionFatalError = 'แคปชั่นว่างหลังจาก AI + fallback template ล้มเหลวทั้งคู่';
                this.log('[orchestrator] caption FATAL for clip', i + 1);
            }

            // 7. UPDATE clip row with whatever we have (so user can see in UI + regen if needed)
            const clipStatus = skipReason ? 'copyright_block' : 'ready';
            this.db.prepare(`
                UPDATE clips
                SET audio_fp = ?, caption = ?, cover_path = ?, status = ?
                WHERE id = ?
            `).run(audioFp, caption, coverPath, clipStatus, preClipId);

            createdClips.push({ clipId: preClipId, caption, skipReason, status: clipStatus });

            // Decide job fate:
            //   copyright blacklist → cancelled
            //   cover required but failed → failed (user regen manually)
            //   caption empty → failed
            //   otherwise → pending (worker will pick up)
            if (skipReason) {
                this.db.prepare(`UPDATE jobs SET status = 'cancelled', error_message = ? WHERE id = ?`)
                    .run('ติด blacklist ลิขสิทธิ์ — ข้ามคลิปนี้', preJobId);
                emit('clip_skipped', { clipIdx: i + 1, reason: skipReason });
                this.io?.emit('job:updated', { jobId: preJobId, status: 'cancelled' });
                continue;
            }
            if (coverFatalError) {
                this.db.prepare(`UPDATE jobs SET status = 'failed', error_message = ? WHERE id = ?`)
                    .run(`สร้างหน้าปกไม่สำเร็จ: ${coverFatalError.slice(0, 200)} — กด 🔄 สร้างใหม่ ในเมนูดูคลิป`, preJobId);
                this.io?.emit('job:updated', { jobId: preJobId, status: 'failed' });
                continue;
            }
            if (captionFatalError) {
                this.db.prepare(`UPDATE jobs SET status = 'failed', error_message = ? WHERE id = ?`)
                    .run(`${captionFatalError} — แก้ prompt หรือ AI key ที่เมนู "AI แคปชั่น"`, preJobId);
                this.io?.emit('job:updated', { jobId: preJobId, status: 'failed' });
                continue;
            }

            // All checks passed — schedule the job
            const planEntry = schedule[i];
            const scheduledSql = toSqlLocal(planEntry.date);
            this.db.prepare(`
                UPDATE jobs
                SET status = 'pending', scheduled_at = ?, error_message = NULL
                WHERE id = ?
            `).run(scheduledSql, preJobId);
            emit('job_scheduled', {
                clipIdx: i + 1,
                pageId: targetPage.id,
                scheduledAt: scheduledSql,
                slot: planEntry.slot.label,
                friendly: friendlyThaiDate(planEntry.date)
            });
            this.io?.emit('job:updated', { jobId: preJobId, status: 'pending' });
        }
        } catch (err) {
            // Mark any pre-placed jobs that are still 'processing' as 'failed'
            // so the user sees the error in the Queue instead of a stuck spinner.
            for (const pp of prePlaced) {
                this.db.prepare(`
                    UPDATE jobs SET status = 'failed', error_message = ?
                    WHERE id = ? AND status = 'processing'
                `).run(`Pipeline ล้มเหลว: ${err.message}`.slice(0, 500), pp.jobId);
                this.io?.emit('job:updated', { jobId: pp.jobId, status: 'failed' });
            }
            throw err;
        }

        // Mark this page as having started a session
        this.db.prepare(`UPDATE pages SET last_session_at = datetime('now', 'localtime') WHERE id = ?`).run(targetPage.id);
        emit('pipeline_done', {
            scoutedId: scoutedRow.id,
            pageId: targetPage.id,
            queued: createdClips.filter(c => c.status === 'ready').length,
            reserved: createdClips.filter(c => c.status === 'reserved').length
        });

        emit('done', { totalClips: createdClips.length });
        this.running.set(runId, { status: 'done', clipsCreated: createdClips.length });
        this.io?.emit('pipeline:done', { runId, clipsCreated: createdClips.length });
    }

    _pickClipWindows(totalDuration, n, clipDur) {
        // Skip first and last 10% (credits/intro), space evenly
        const usableStart = totalDuration * 0.1;
        const usableEnd = totalDuration * 0.9;
        const usableLen = usableEnd - usableStart;
        if (usableLen < clipDur * n) {
            // Not enough room — shrink count
            n = Math.max(1, Math.floor(usableLen / clipDur));
        }
        const gap = (usableLen - clipDur * n) / Math.max(1, n - 1);
        const windows = [];
        for (let i = 0; i < n; i++) {
            const start = Math.floor(usableStart + i * (clipDur + gap));
            windows.push({ start, dur: clipDur });
        }
        return windows;
    }

    // Create Set 2 for a clip on demand (when user clicks "use Set 2")
    async ensureSet2(clipId) {
        const clip = this.db.prepare('SELECT * FROM clips WHERE id = ?').get(clipId);
        if (!clip) throw new Error('Clip not found');
        if (clip.set2_path && fs.existsSync(clip.set2_path)) return clip.set2_path;

        const set2Path = clip.set1_path.replace('_set1.mp4', '_set2.mp4');
        await makeSet2(clip.set1_path, set2Path);
        this.db.prepare('UPDATE clips SET set2_path = ? WHERE id = ?').run(set2Path, clipId);
        return set2Path;
    }

    getStatus(runId) {
        return this.running.get(runId) || { status: 'unknown' };
    }

    /**
     * Resume a single clip's preparation that failed mid-pipeline (download crashed,
     * slice crashed, banner crashed, caption crashed — anything BEFORE posting).
     *
     * Unlike enqueue() which creates new clip/job rows, this reuses the existing
     * clip_id + job_id so the scheduled_at slot is preserved → day-alignment stays
     * clean.
     *
     * Flow:
     *   1. Ensure the source video is downloaded (re-download if missing)
     *   2. Slice the clip (if set1_path missing or truncated)
     *   3. Apply banner overlay if the page has a preset
     *   4. Compute audio fingerprint
     *   5. Check against copyright blacklist
     *   6. Generate caption (if clip.caption is empty or prompt-echo)
     *   7. Update clip.status = 'ready', job.status = 'pending'
     */
    async resumeSingleClip({ clipId, jobId, pageId, onLog }) {
        const log = (m) => { try { onLog?.(m); } catch {} };

        const clip = this.db.prepare(`
            SELECT c.*, sv.file_path AS video_path, sv.source_url, sv.title AS video_title,
                   sv.keyword AS search_keyword, sv.thumbnail_local_path
            FROM clips c
            LEFT JOIN scouted_videos sv ON sv.id = c.scouted_id
            WHERE c.id = ?
        `).get(clipId);
        if (!clip) throw new Error('Clip not found');

        const page = this.db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId);
        if (!page) throw new Error('Page not found');

        // Step 1: ensure video source exists
        let videoPath = clip.video_path;
        if (!videoPath || !fs.existsSync(videoPath)) {
            if (!clip.source_url) throw new Error('ต้นฉบับหายและไม่มี source_url ให้ดาวน์โหลดใหม่');
            log('กำลังดาวน์โหลดคลิปต้นฉบับใหม่ (หายไปจาก disk)...');
            const { path: downloadedPath } = await downloadVideo(clip.source_url, msg => log('download: ' + msg));
            videoPath = downloadedPath;
            const stat = fs.statSync(videoPath);
            this.db.prepare(`UPDATE scouted_videos SET file_path = ?, file_size = ? WHERE id = ?`)
                .run(videoPath, stat.size, clip.scouted_id);
        } else {
            log('✓ ต้นฉบับยังอยู่ — ข้ามขั้นตอน download');
        }

        // Step 2: slice if missing/broken
        // ✅ FIX multi-page race: fallback path ก็ต้องใส่ pageId ด้วย (assigned_page_id)
        const fallbackName = clip.assigned_page_id
            ? `clip_${clip.scouted_id}_p${clip.assigned_page_id}_${clip.clip_index}_set1.mp4`
            : `clip_${clip.scouted_id}_${clip.clip_index}_set1.mp4`;
        const set1Path = clip.set1_path || path.join(CLIPS_DIR(), fallbackName);
        const needSlice = !fs.existsSync(set1Path) || fs.statSync(set1Path).size < 100 * 1024;
        if (needSlice) {
            // Read speed factor for copyright evasion
            const speedFactor = (() => {
                try {
                    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'slice_speed_factor'`).get();
                    const n = Number(row?.value);
                    return Number.isFinite(n) && n >= 1.0 && n <= 2.0 ? n : 1.0;
                } catch { return 1.0; }
            })();
            const speedMsg = speedFactor > 1.0 ? ` (เร่ง ${speedFactor}x)` : '';
            log(`กำลังตัดคลิปย่อย${speedMsg} (start=${clip.start_sec}s, dur=${clip.end_sec - clip.start_sec}s)...`);
            const rawTmp = path.join(CLIPS_DIR(), `_raw_resume_${clipId}.mp4`);
            await sliceClip(videoPath, rawTmp, clip.start_sec, clip.end_sec - clip.start_sec,
                pct => log(`✂️ กำลังตัด${speedMsg} · ${pct}%`), speedFactor);
            log('✓ ตัดคลิปเสร็จ · กำลังใส่แบนเนอร์...');

            // Step 3: apply banner overlay if the page has a preset
            // (we don't know exactly which preset was used originally, so use the current default)
            const presetRow = this.db.prepare(`
                SELECT layers_json FROM banner_presets ORDER BY id ASC LIMIT 1
            `).get();
            let layers = [];
            if (presetRow && presetRow.layers_json) {
                try { layers = JSON.parse(presetRow.layers_json) || []; }
                catch (e) { console.warn('[orchestrator] resume preset parse failed:', e.message); }
            }
            if (layers.length > 0) {
                const dur = clip.end_sec - clip.start_sec;
                await applyBannerOverlay(rawTmp, set1Path, layers, this.db, undefined,
                    pct => log(`🖼 กำลังใส่แบนเนอร์ · ${pct}%`), dur);
                try { fs.unlinkSync(rawTmp); } catch {}
            } else {
                fs.renameSync(rawTmp, set1Path);
            }
            this.db.prepare('UPDATE clips SET set1_path = ? WHERE id = ?').run(set1Path, clipId);
            log('✓ ใส่แบนเนอร์เสร็จ');
        } else {
            log('✓ คลิปย่อยยังอยู่ — ข้ามขั้นตอน slice');
        }

        // Step 4: audio fingerprint (if missing)
        let audioFp = clip.audio_fp;
        if (!audioFp) {
            log('กำลังสแกนเสียง...');
            try { audioFp = await audioFingerprint(set1Path); } catch {}
            if (audioFp) {
                this.db.prepare('UPDATE clips SET audio_fp = ? WHERE id = ?').run(audioFp, clipId);
            }
        }

        // Step 5: copyright blacklist check
        let skipReason = null;
        if (audioFp) {
            const bl = this.db.prepare('SELECT id FROM copyright_blacklist WHERE audio_fp = ?').get(audioFp);
            if (bl) skipReason = 'blacklist_match';
        }

        // Step 6: caption (if missing or looks like prompt echo)
        if (!clip.caption || clip.caption.length < 10) {
            log('กำลังให้ AI เขียนแคปชั่น...');
            try {
                const totalClips = this.db.prepare(`SELECT COUNT(*) AS n FROM clips WHERE scouted_id = ?`)
                    .get(clip.scouted_id).n;
                const cap = await this.captionService.generateForPage(pageId, {
                    videoTitle: clip.video_title || 'คลิป',
                    niche: page.niche || '',
                    duration: clip.end_sec - clip.start_sec,
                    clipNumber: clip.clip_index,
                    totalClips
                });
                const safeCap = cap && cap.length > 2100 ? cap.slice(0, 2080) + '…' : cap;
                this.db.prepare('UPDATE clips SET caption = ? WHERE id = ?').run(safeCap || '', clipId);
                log('✓ แคปชั่นเสร็จ');
            } catch (e) {
                log('เขียนแคปชั่นไม่สำเร็จ (ใช้ fallback): ' + e.message);
                const fallback = `${(clip.video_title || 'คลิป').slice(0, 100)} EP.${clip.clip_index} 🎬 #${page.niche || 'reel'}`;
                this.db.prepare('UPDATE clips SET caption = ? WHERE id = ?').run(fallback, clipId);
            }
        }

        // Step 6b: AI cover (if enabled globally AND this clip doesn't already have one)
        const coverEnabled = (() => {
            try {
                const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'cover_enabled'`).get();
                return row?.value === '1' || row?.value === 1 || row?.value === 'true';
            } catch { return false; }
        })();
        const needCover = coverEnabled && this.coverService &&
            (!clip.cover_path || !fs.existsSync(clip.cover_path) ||
             (fs.existsSync(clip.cover_path) && fs.statSync(clip.cover_path).size < 20 * 1024));
        if (needCover) {
            log('🎨 กำลังสร้างหน้าปก AI...');
            try {
                const coverOut = path.join(COVERS_DIR(), `cover_${clip.scouted_id}_${clip.clip_index}.png`);
                const r = await this.coverService.generateCover({
                    videoPath: clip.set1_path,
                    videoTitle: clip.video_title || 'คลิป',
                    niche: page.niche || '',
                    clipIndex: clip.clip_index,
                    totalClips: this.db.prepare(`SELECT COUNT(*) AS n FROM clips WHERE scouted_id = ?`).get(clip.scouted_id).n,
                    pageOverridePrompt: null,
                    searchKeyword: clip.search_keyword || null,
                    referenceImagePath: clip.thumbnail_local_path || null,
                    outPath: coverOut
                });
                const coverPath = r.path;
                if (!fs.existsSync(coverPath) || fs.statSync(coverPath).size < 20 * 1024) {
                    throw new Error(`coverService อ้างว่าสำเร็จแต่ไฟล์หายหรือเล็กเกินไป`);
                }
                this.db.prepare('UPDATE clips SET cover_path = ? WHERE id = ?').run(coverPath, clipId);
                log(`✓ หน้าปกเสร็จ (${r.source})`);
            } catch (e) {
                // Cover is required if cover_enabled=ON — fail the resume (don't mark 'ready')
                log('❌ สร้างหน้าปกไม่สำเร็จ: ' + e.message);
                throw new Error('สร้างหน้าปก AI ไม่สำเร็จ: ' + e.message);
            }
        } else if (coverEnabled) {
            log('✓ หน้าปกมีอยู่แล้ว — ข้ามขั้นตอน cover');
        }

        // Step 7: mark clip ready + job pending (reuse original scheduled_at)
        const clipStatus = skipReason ? 'copyright_block' : 'ready';
        this.db.prepare('UPDATE clips SET status = ? WHERE id = ?').run(clipStatus, clipId);
        if (skipReason) {
            this.db.prepare(`
                UPDATE jobs SET status = 'cancelled', error_message = ? WHERE id = ?
            `).run('ติด blacklist ลิขสิทธิ์ — ข้ามคลิปนี้', jobId);
            this.io?.emit('job:updated', { jobId, status: 'cancelled' });
        } else {
            this.db.prepare(`
                UPDATE jobs SET status = 'pending', error_message = NULL WHERE id = ?
            `).run(jobId);
            this.io?.emit('job:updated', { jobId, status: 'pending' });
        }
        log('✓ ทำคลิปต่อเสร็จ · รอถึงเวลาโพสต์');
    }
}

module.exports = {
    Orchestrator,
    downloadVideo,
    sliceClip,
    applyBannerOverlay,
    makeSet2,
    audioFingerprint,
    ffprobeDuration,
    canonicalUrl,
    hashUrl,                  // ✅ FIX: ChannelWatcher ต้องใช้ hash function เดียวกัน
                              // (เดิม channelWatcher hash ด้วย SHA256 ทำให้ orchestrator dedup ไม่เจอ
                              //  → INSERT ซ้ำ → source_url UNIQUE blocks → row ไม่ถูก SELECT → undefined.id crash)
    getUsedCanonicalUrls
};
