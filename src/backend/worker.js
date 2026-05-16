/**
 * Background Job Worker
 *
 * Runs every 15s (see server.js setInterval).
 * - Picks next pending job whose scheduled_at <= now
 * - Launches Puppeteer for that profile (or reuses)
 * - Posts the reel
 * - Monitors copyright
 * - Posts comment (template)
 *
 * Only 1 concurrent job per profile (FB rate-limit protection).
 */

const fs = require('fs');
const path = require('path');
const { toSqlLocal, nextPeakSlotAfter } = require('./peakSchedule');

module.exports = function createWorker(db, orchestrator, io, sessionMgr, dbPath) {
    const { postReel, warmUpSession, isLoggedIn, humanDelay, humanType } = require('./poster');
    const browserManager = require('./browserManager');
    const { CopyrightManager } = require('./services/copyrightManager');
    const { CommentTemplateEngine } = require('./services/commentTemplateEngine');

    const copyrightMgr = new CopyrightManager(dbPath);
    const commentEngine = new CommentTemplateEngine(dbPath);

    const busyProfiles = new Set();
    let tickBusy = false;

    // Delegate to shared manager so test-login / fetch-pages / worker all share the same Chrome
    const getBrowserFor = (profile) => browserManager.getBrowser(profile);

    function getSetting(key, fallback) {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row ? row.value : fallback;
    }

    async function runJobWorkerTick() {
        if (tickBusy) return;
        tickBusy = true;
        try {
            // SAFETY: Sweep stale 'running' jobs (Chrome crash, PC restart, forced kill).
            // If started_at is > 15 minutes ago and status still 'running', it's stuck.
            //
            // IMPORTANT: require started_at IS NOT NULL. A job that just transitioned to
            // 'running' but hasn't had started_at written yet (transient during the
            // UPDATE → processJob() handoff) must NOT be swept — that would mark a
            // healthy starting job as failed mid-flight.
            const staleRunning = db.prepare(`
                SELECT id FROM jobs
                WHERE status = 'running'
                  AND started_at IS NOT NULL
                  AND datetime(started_at, '+15 minutes') < datetime('now', 'localtime')
            `).all();
            for (const s of staleRunning) {
                db.prepare(`
                    UPDATE jobs SET status = 'failed',
                                     error_message = 'งานค้างเกิน 15 นาที (Chrome หรือระบบน่าจะ crash ก่อนโพสต์เสร็จ) — กด "เริ่มใหม่" ได้',
                                     finished_at = datetime('now', 'localtime')
                    WHERE id = ?
                `).run(s.id);
                io.emit('job:failed', { jobId: s.id, message: 'stale-running sweep' });
                console.warn(`[worker] swept stale 'running' job #${s.id} → failed`);
            }

            // SAFETY: Past-schedule protection. If a pending job's scheduled_at is more
            // than 1 hour in the past, it means the worker missed it (PC was off, or
            // preflight was failing). Reschedule to the NEXT upcoming peak slot rather
            // than firing all at once, so posts still land at times real users watch.
            //
            // Per page: chain each stale job after the latest existing future job so we
            // don't double-book a slot another clip already holds.
            const stalePending = db.prepare(`
                SELECT j.id, j.page_id, j.scheduled_at, p.cooldown_min
                FROM jobs j
                JOIN pages p ON p.id = j.page_id
                WHERE j.status = 'pending'
                  AND datetime(j.scheduled_at, '+1 hour') < datetime('now', 'localtime')
                ORDER BY j.page_id ASC, j.scheduled_at ASC
            `).all();
            if (stalePending.length) {
                const groups = new Map();
                for (const sp of stalePending) {
                    if (!groups.has(sp.page_id)) {
                        groups.set(sp.page_id, { cooldownMin: sp.cooldown_min || 30, jobs: [] });
                    }
                    groups.get(sp.page_id).jobs.push(sp);
                }
                for (const [pageId, group] of groups) {
                    // Find the last FUTURE scheduled_at for this page so we chain after it
                    const lastFuture = db.prepare(`
                        SELECT MAX(scheduled_at) AS t FROM jobs
                        WHERE page_id = ? AND status IN ('pending', 'running', 'posted')
                          AND datetime(scheduled_at) > datetime('now', 'localtime')
                    `).get(pageId);
                    let chainFrom = lastFuture?.t
                        ? new Date(lastFuture.t.replace(' ', 'T'))
                        : new Date();
                    for (const job of group.jobs) {
                        const next = nextPeakSlotAfter(chainFrom, group.cooldownMin);
                        const newSql = toSqlLocal(next.date);
                        db.prepare(`UPDATE jobs SET scheduled_at = ? WHERE id = ?`).run(newSql, job.id);
                        console.warn(`[worker] rescheduled stale job #${job.id} (was ${job.scheduled_at}) → ${newSql} (${next.slot.label})`);
                        io.emit('job:updated', { jobId: job.id, scheduled_at: newSql });
                        chainFrom = next.date;
                    }
                }
            }

            // Find a pending job whose time has come & profile not busy
            const candidates = db.prepare(`
                SELECT j.*, p.name AS page_name, p.profile_id, p.fb_page_id, p.niche,
                       c.set1_path, c.set2_path, c.caption, c.clip_index, c.scouted_id, c.cover_path,
                       sv.title AS video_title
                FROM jobs j
                JOIN pages p ON p.id = j.page_id
                JOIN clips c ON c.id = j.clip_id
                LEFT JOIN scouted_videos sv ON sv.id = c.scouted_id
                WHERE j.status = 'pending'
                  AND j.scheduled_at <= datetime('now', 'localtime')
                ORDER BY j.scheduled_at ASC
                LIMIT 10
            `).all();

            for (const job of candidates) {
                if (busyProfiles.has(job.profile_id)) continue;

                // Pre-flight check before letting puppeteer touch this job
                const preflight = preflightJob(job.id);
                if (!preflight.ok) {
                    const blockers = preflight.blockers.join(', ');
                    console.log(`[worker] job#${job.id} preflight FAIL: ${blockers}`);
                    db.prepare(`UPDATE jobs SET error_message = ? WHERE id = ?`)
                      .run(`ตรวจก่อนโพสต์ไม่ผ่าน: ${blockers}`, job.id);
                    io.emit('job:preflight_fail', { jobId: job.id, blockers });
                    // Don't mark as failed — just skip this tick. User may fix and we retry next tick.
                    continue;
                }

                busyProfiles.add(job.profile_id);
                // SAFETY: Wrap processJob in catch-all so any uncaught error marks job failed
                // instead of leaving it 'running' forever (which blocks the profile).
                processJob(job)
                    .catch(err => {
                        console.error(`[worker job#${job.id}] UNCAUGHT:`, err);
                        try { markFailed(job.id, 'error ไม่คาดคิด: ' + (err.message || String(err)).slice(0, 300)); } catch {}
                    })
                    .finally(() => busyProfiles.delete(job.profile_id));
                return; // 1 job per tick to keep things gentle
            }
        } finally {
            tickBusy = false;
        }
    }

    async function processJob(job) {
        const log = (m) => console.log(`[worker job#${job.id}]`, m);
        log(`start: page=${job.page_name} set=${job.use_set}`);

        db.prepare(`UPDATE jobs SET status = 'running', started_at = datetime('now', 'localtime') WHERE id = ?`).run(job.id);
        io.emit('job:start', { jobId: job.id, pageId: job.page_id });

        const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(job.profile_id);
        if (!profile) return markFailed(job.id, 'profile not found');

        const videoPath = job.use_set === 2 ? job.set2_path : job.set1_path;
        if (!videoPath || !fs.existsSync(videoPath)) {
            return markFailed(job.id, 'clip file missing: ' + videoPath);
        }

        let browser;
        try {
            browser = await getBrowserFor(profile);
        } catch (e) {
            return markFailed(job.id, 'launch Chrome failed: ' + e.message);
        }

        // Pre-delay: skip for priority/post-now jobs, human-like for normal scheduled jobs
        const isPriority = job.priority === 1;
        const preDelay = isPriority ? 3 : (30 + Math.floor(Math.random() * 90));
        log(`pre-delay: ${preDelay}s ${isPriority ? '(priority — fast path)' : '(human-like spacing)'}`);
        await new Promise(r => setTimeout(r, preDelay * 1000));

        // Warm-up (browse FB feed before posting)
        try {
            const warmDur = Number(getSetting('warmup_duration_sec', '60'));
            if (warmDur > 0) {
                // Add random jitter to warmup duration (±15% — tighter than before so we don't
                // overshoot FB's idle-session timeout which can invalidate cookies)
                const actualDur = Math.floor(warmDur * (0.85 + Math.random() * 0.3));
                log(`warm-up ${actualDur}s (random jitter)`);
                await warmUpSession(browser, actualDur);
            }
        } catch (e) { log('warm-up failed (continuing): ' + e.message); }

        // Post (pass pageId + pageName so composer can switch dropdown if needed)
        // Pass coverPath if one was generated (decision to generate was made in orchestrator
        // based on global cover_enabled setting). If the file exists, attach it.
        const coverToUse = (job.cover_path && fs.existsSync(job.cover_path))
            ? job.cover_path : null;
        const result = await postReel({
            browser, videoPath, caption: job.caption || '',
            coverPath: coverToUse,
            pageId: job.fb_page_id,
            pageName: job.page_name,
            onLog: m => { log(m); io.emit('job:log', { jobId: job.id, msg: m }); }
        });

        if (!result.success) {
            // Pre-publish copyright detection — never published, queue for manual Set 2
            if (result.reason === 'copyright_pre_publish') {
                const clip = db.prepare('SELECT audio_fp FROM clips WHERE id = ?').get(job.clip_id);
                await copyrightMgr.handleCopyrightHit(job.id, clip?.audio_fp, null, null).catch(e => log('handleCopyrightHit: ' + e.message));
                io.emit('notification:copyright', { jobId: job.id, reason: 'pre_publish', message: result.message });
                return;
            }
            // Session issue → mark profile + notify
            if (result.reason === 'logged_out' || result.reason === 'checkpoint') {
                db.prepare(`UPDATE profiles SET status = 'checkpoint' WHERE id = ?`).run(profile.id);
                io.emit('notification:session', { profileId: profile.id, reason: result.reason, message: result.message });
            }
            return markFailed(job.id, result.message || result.reason);
        }

        const postId = result.postId || result.url || '';
        // Clear error_message on successful post so stale preflight warnings don't
        // cling to the 'posted' badge in the UI (avoids confusion like
        // "โพสต์สำเร็จแล้ว · ⚠ ตรวจก่อนโพสต์ไม่ผ่าน")
        db.prepare(`
            UPDATE jobs SET status = 'posted',
                             fb_post_id = ?,
                             finished_at = datetime('now', 'localtime'),
                             error_message = NULL
            WHERE id = ?
        `).run(postId, job.id);
        bumpDailyStat(job.page_id, 'posts_count');
        io.emit('job:posted', { jobId: job.id, postId });

        // Insert post_log
        db.prepare(`INSERT INTO post_log (job_id, event, detail) VALUES (?, 'publish', ?)`)
          .run(job.id, JSON.stringify({ postId, url: result.url }));

        // Monitor copyright in background (doesn't block next job)
        monitorCopyright(browser, job, postId).catch(e => log('monitor error: ' + e.message));

        // Post comment (if templates exist)
        postComment(browser, job).catch(e => log('comment error: ' + e.message));
    }

    async function monitorCopyright(browser, job, postId) {
        const monitorSec = Number(getSetting('copyright_monitor_sec', '60'));
        if (monitorSec <= 0) return;

        const page = await browser.newPage();
        try {
            await new Promise(r => setTimeout(r, 30000)); // wait 30s for FB processing
            const blocked = await copyrightMgr.monitorPostPublish(page, postId, monitorSec * 1000);
            if (blocked.blocked) {
                const clip = db.prepare('SELECT audio_fp FROM clips WHERE id = ?').get(job.clip_id);
                await copyrightMgr.handleCopyrightHit(job.id, clip?.audio_fp, postId, page);
                io.emit('notification:copyright', { jobId: job.id });
            }
        } finally {
            await page.close().catch(() => {});
        }
    }

    async function postComment(browser, job) {
        const settings = db.prepare('SELECT * FROM comment_settings WHERE page_id = ?').get(job.page_id);
        if (settings && !settings.enabled) return;

        const delay = (settings?.delay_sec || 20) * 1000;
        const jitter = (settings?.jitter_sec || 10) * 1000;
        await new Promise(r => setTimeout(r, delay + Math.random() * jitter * 2 - jitter));

        const picked = commentEngine.pickAndRender(job.page_id, {
            page_name: job.page_name,
            clip_number: job.clip_index,
            video_title: job.video_title,
            caption: job.caption,
            hashtag: job.niche ? `#${job.niche}` : ''
        });
        if (!picked) { console.log(`[worker job#${job.id}] no comment template — skipped`); return; }

        // Skip if we only have a placeholder post ID (processing_<timestamp>) —
        // that URL resolves to FB's "content not available" page and serves no purpose.
        const isPlaceholderId = !job.fb_post_id || /^(processing_|unknown_)/i.test(job.fb_post_id);
        if (isPlaceholderId) {
            console.log(`[worker job#${job.id}] no real FB post ID captured — skipping auto-comment (placeholder: ${job.fb_post_id || 'none'})`);
            return;
        }

        const page = await browser.newPage();
        try {
            await page.goto(`https://www.facebook.com/${job.fb_post_id}`, {
                waitUntil: 'domcontentloaded'
            });
            await humanDelay(2000, 4000);

            // If FB still shows "content not available" (processing), abort gracefully
            // instead of leaving a broken tab open for the user to stare at.
            const unavailable = await page.evaluate(() => {
                const t = document.body.innerText || '';
                return t.includes('เนื้อหานี้ไม่พร้อมใช้งาน')
                    || t.includes("isn't available")
                    || t.includes('This content isn\'t available');
            }).catch(() => false);
            if (unavailable) {
                console.log(`[worker job#${job.id}] FB showed "content not available" — post still processing, skipping auto-comment`);
                return;
            }

            // Find the comment box
            const commentBox = await page.$('div[contenteditable="true"][aria-label*="omment" i]') ||
                               await page.$('div[contenteditable="true"]');
            if (!commentBox) {
                console.log(`[worker job#${job.id}] comment box not found`);
                return;
            }
            await commentBox.click();
            await humanDelay(500, 1200);
            // Use humanType (supports emoji + ZWJ sequences via CDP Input.insertText).
            // The old loop with page.keyboard.type(ch) broke emojis because surrogate pairs
            // can't be dispatched through Input.dispatchKeyEvent.
            await humanType(page, picked.rendered);
            await humanDelay(800, 1500);
            await page.keyboard.press('Enter');

            bumpDailyStat(job.page_id, 'comments_count');
            db.prepare(`INSERT INTO post_log (job_id, event, detail) VALUES (?, 'comment_posted', ?)`)
              .run(job.id, JSON.stringify({ template_id: picked.template_id, content: picked.rendered }));
        } finally {
            await page.close().catch(() => {});
        }
    }

    function markFailed(jobId, msg) {
        db.prepare(`
            UPDATE jobs SET status = 'failed', error_message = ?, finished_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(msg, jobId);
        io.emit('job:failed', { jobId, message: msg });
        console.error(`[worker job#${jobId}] FAILED: ${msg}`);
    }

    /**
     * Pre-flight checks — run BEFORE handing job to puppeteer.
     * Returns { ok: bool, checks: [{ key, label, ok, level, detail }] }
     *  level: 'critical' (blocks posting) or 'warning' (allows but flags)
     */
    function preflightJob(jobId) {
        const fs = require('fs');
        const job = db.prepare(`
            SELECT j.*, p.name AS page_name, p.profile_id, p.fb_page_id, p.daily_quota,
                   p.cooldown_min, p.enabled AS page_enabled,
                   pr.name AS profile_name, pr.status AS profile_status,
                   c.set1_path, c.set2_path, c.caption, c.audio_fp, c.status AS clip_status
            FROM jobs j
            JOIN pages p ON p.id = j.page_id
            JOIN profiles pr ON pr.id = p.profile_id
            JOIN clips c ON c.id = j.clip_id
            WHERE j.id = ?
        `).get(jobId);

        if (!job) return { ok: false, checks: [{ key: 'job', label: 'หางานนี้ไม่เจอในระบบ', ok: false, level: 'critical' }] };

        const checks = [];
        const videoPath = job.use_set === 2 ? job.set2_path : job.set1_path;

        // 1. Clip file exists
        const fileOk = videoPath && fs.existsSync(videoPath);
        let fileSize = 0;
        if (fileOk) {
            try { fileSize = fs.statSync(videoPath).size; } catch {}
        }
        // SAFETY: minimum 100 KB — catches truncated/empty files
        // (เดิม 500 KB false-positive Shorts สั้น ๆ 14-20s ที่ encode เสร็จขนาด ~300-500 KB ของจริง)
        const fileSizeOk = fileOk && fileSize >= 100 * 1024;
        checks.push({
            key: 'clip_file',
            label: fileOk && !fileSizeOk ? 'ไฟล์คลิปเล็กผิดปกติ (อาจ encode ไม่เสร็จ)' : 'ไฟล์คลิปหาย/ยังไม่ตัด',
            level: 'critical',
            ok: fileSizeOk,
            detail: fileOk ? `${(fileSize/1024/1024).toFixed(1)} MB` : 'ไฟล์หายหรือยังตัดไม่เสร็จ'
        });

        // 2. Clip status (slice + banner done)
        checks.push({
            key: 'clip_ready', label: 'คลิปยังตัด/ใส่แบนเนอร์ไม่เสร็จ', level: 'critical',
            ok: job.clip_status === 'ready' || job.clip_status === 'posting',
            detail: job.clip_status || 'ไม่ทราบสถานะ'
        });

        // 3. Caption — CRITICAL (upgraded from warning): Reels without captions perform
        //    poorly + user's strict flow requires captions always be ready before posting.
        const hasCaption = job.caption && job.caption.trim().length > 0;
        checks.push({
            key: 'caption', label: 'ยังไม่มีแคปชั่น — ต้องเขียนก่อนโพสต์', level: 'critical',
            ok: hasCaption,
            detail: hasCaption ? `${job.caption.length} ตัวอักษร` : 'ว่าง'
        });

        // 3b. Cover — CRITICAL if global AI cover is enabled. If user turned cover ON
        //     but the cover file is missing, block posting so we don't send a Reel without
        //     the cover the user expected.
        try {
            const coverEnabledRow = db.prepare(`SELECT value FROM settings WHERE key = 'cover_enabled'`).get();
            const coverGloballyEnabled = coverEnabledRow?.value === '1' || coverEnabledRow?.value === 1;
            if (coverGloballyEnabled) {
                const clipCover = db.prepare(`SELECT cover_path FROM clips WHERE id = ?`).get(job.clip_id)?.cover_path;
                const coverOk = clipCover && fs.existsSync(clipCover);
                checks.push({
                    key: 'cover', label: 'ยังไม่มีหน้าปก AI (เปิดฟีเจอร์ไว้แต่หาไฟล์ไม่เจอ)', level: 'critical',
                    ok: coverOk,
                    detail: coverOk ? path.basename(clipCover) : (clipCover ? 'ไฟล์หายจาก disk' : 'ยังไม่ได้สร้าง')
                });
            }
        } catch {}

        // 4. Audio fingerprint
        checks.push({
            key: 'audio_fp', label: 'ยังไม่ได้สแกนเสียง (ตรวจลิขสิทธิ์ไม่ได้)', level: 'warning',
            ok: !!job.audio_fp,
            detail: job.audio_fp ? 'พร้อมตรวจลิขสิทธิ์' : 'ไม่มี — ข้ามการตรวจลิขสิทธิ์'
        });

        // 5. Session
        const sess = db.prepare(`
            SELECT cookies_json, last_verified_at FROM session_cookies WHERE profile_id = ?
        `).get(job.profile_id);
        let sessionOk = false, sessionDetail = 'ยังไม่มี session';
        if (sess && sess.cookies_json) {
            try {
                const cookies = JSON.parse(sess.cookies_json);
                if (Array.isArray(cookies)) {
                    const names = new Set(cookies.map(c => c.name));
                    sessionOk = names.has('c_user') && names.has('xs');
                    sessionDetail = sessionOk ? `${cookies.length} cookies` : `มี ${cookies.length} cookies แต่ไม่มี c_user/xs`;
                } else {
                    sessionDetail = 'cookies_json ไม่ใช่ array';
                }
            } catch (e) {
                sessionDetail = 'cookies_json พัง: ' + e.message;
            }
        }
        checks.push({ key: 'session', label: 'ยังไม่ได้เข้าระบบเฟส', level: 'critical', ok: sessionOk, detail: sessionDetail });

        // 6. Profile status
        const profOk = job.profile_status !== 'blocked' && job.profile_status !== 'checkpoint';
        checks.push({
            key: 'profile_status', label: 'บัญชีเฟสถูกล็อก/ต้องยืนยันตัวตน', level: 'critical',
            ok: profOk,
            detail: job.profile_status || 'unknown'
        });

        // 7. Page enabled
        checks.push({
            key: 'page_enabled', label: 'เพจถูกปิดใช้งาน', level: 'critical',
            ok: !!job.page_enabled,
            detail: job.page_enabled ? 'เปิดอยู่' : 'ปิดอยู่'
        });

        // 8. Daily quota — use local date (Thai TZ) not UTC
        const todayStat = db.prepare(`
            SELECT COALESCE(posts_count, 0) AS n FROM daily_stats
            WHERE page_id = ? AND date = date('now', 'localtime')
        `).get(job.page_id);
        const postedToday = todayStat?.n || 0;
        const quota = job.daily_quota || 5;
        checks.push({
            key: 'quota', label: `โพสต์ครบจำนวน/วันแล้ว (${postedToday}/${quota})`, level: 'critical',
            ok: postedToday < quota,
            detail: `${postedToday}/${quota}`
        });

        // 9. Cooldown — last successful post for this page
        const lastPost = db.prepare(`
            SELECT MAX(finished_at) AS t FROM jobs
            WHERE page_id = ? AND status = 'posted'
        `).get(job.page_id);
        let cooldownOk = true, cooldownDetail = 'พร้อม';
        let cooldownLabel = 'ต้องเว้นระยะระหว่างโพสต์';
        if (lastPost?.t) {
            // BUG FIX: `lastPost.t` is SQLite local-time (no Z suffix). Appending 'Z' wrongly
            // tells JS it's UTC, making cooldown always pass (7h offset in ICT).
            // Parse as local time directly — replace space with 'T' for ISO parsing, NO 'Z'.
            const last = new Date(lastPost.t.replace(' ', 'T')).getTime();
            const elapsedMin = (Date.now() - last) / 60000;
            const cd = job.cooldown_min || 30;
            cooldownOk = elapsedMin >= cd;
            cooldownDetail = cooldownOk ? `ผ่าน ${Math.floor(elapsedMin)} นาที (≥${cd})` : `รออีก ${Math.ceil(cd - elapsedMin)} นาที`;
            if (!cooldownOk) cooldownLabel = `ต้องรออีก ${Math.ceil(cd - elapsedMin)} นาทีจึงจะโพสต์ได้`;
        }
        checks.push({
            key: 'cooldown', label: cooldownLabel, level: 'warning',
            ok: cooldownOk,
            detail: cooldownDetail
        });

        // 10. Banner files exist (if clip used a preset — heuristic: check if file_path of any banner referenced is missing)
        // We don't track preset_id per clip, so just check overlay folder has SOME files if banners table non-empty.
        const banners = db.prepare('SELECT file_path FROM banners').all();
        let bannerOk = true;
        if (banners.length > 0) {
            const missing = banners.filter(b => !fs.existsSync(b.file_path)).length;
            bannerOk = missing === 0;
            checks.push({
                key: 'banner_files', label: 'ไฟล์แบนเนอร์บางรูปหายไป', level: 'warning',
                ok: bannerOk,
                detail: missing > 0 ? `${missing}/${banners.length} ไฟล์หาย` : `ครบ ${banners.length} ไฟล์`
            });
        }

        const criticalFail = checks.filter(c => c.level === 'critical' && !c.ok);
        const warningFail = checks.filter(c => c.level === 'warning' && !c.ok);

        return {
            ok: criticalFail.length === 0,
            checks,
            critical_failures: criticalFail.length,
            warnings: warningFail.length,
            blockers: criticalFail.map(c => c.label)
        };
    }

    function bumpDailyStat(pageId, col) {
        db.prepare(`
            INSERT INTO daily_stats (page_id, date, ${col}) VALUES (?, date('now', 'localtime'), 1)
            ON CONFLICT(page_id, date) DO UPDATE SET ${col} = ${col} + 1
        `).run(pageId);
    }

    async function ensureSet2ForJob(jobId) {
        const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
        if (!job) throw new Error('Job not found');
        return await orchestrator.ensureSet2(job.clip_id);
    }

    /**
     * Reserved-clip scheduler.
     *
     * For each page that has clips status='reserved' AND last_session_at was
     * >= session_interval_hours ago → release the next batch (promote N clips
     * from 'reserved' to 'ready' + create their jobs).
     */
    function releaseReservedClips() {
        const pagesWithReserved = db.prepare(`
            SELECT p.*, COUNT(c.id) AS reserved_count
            FROM pages p
            JOIN clips c ON c.assigned_page_id = p.id AND c.status = 'reserved'
            WHERE p.enabled = 1
            GROUP BY p.id
        `).all();

        for (const page of pagesWithReserved) {
            const intervalHours = page.session_interval_hours || 24;
            const lastAt = page.last_session_at;
            if (lastAt) {
                // BUG FIX: `last_session_at` is local-time from DB. Don't append 'Z' (treats as UTC).
                const last = new Date(lastAt.replace(' ', 'T')).getTime();
                const elapsedHours = (Date.now() - last) / 3600000;
                if (elapsedHours < intervalHours) continue;  // not time yet
            }

            const batchSize = page.posts_per_session || 3;
            const next = db.prepare(`
                SELECT * FROM clips
                WHERE assigned_page_id = ? AND status = 'reserved'
                ORDER BY scouted_id, clip_index ASC
                LIMIT ?
            `).all(page.id, batchSize);

            if (!next.length) continue;

            console.log(`[scheduler] page ${page.id} (${page.name}): releasing ${next.length} reserved clips`);

            const cooldownMin = page.cooldown_min || 30;
            const now = new Date();
            const tx = db.transaction(() => {
                for (let i = 0; i < next.length; i++) {
                    const clip = next[i];
                    const scheduledAt = new Date(now.getTime() + i * cooldownMin * 60 * 1000);
                    db.prepare(`UPDATE clips SET status = 'ready' WHERE id = ?`).run(clip.id);
                    db.prepare(`
                        INSERT INTO jobs (clip_id, page_id, scheduled_at, use_set, status)
                        VALUES (?, ?, ?, 1, 'pending')
                    `).run(clip.id, page.id, toSqlLocal(scheduledAt));  // BUG FIX: was .toISOString() (UTC)
                }
                db.prepare(`UPDATE pages SET last_session_at = datetime('now', 'localtime') WHERE id = ?`).run(page.id);
            });
            tx();

            io.emit('scheduler:release', { pageId: page.id, count: next.length });
        }
    }

    return { runJobWorkerTick, releaseReservedClips, ensureSet2ForJob, preflightJob };
};
