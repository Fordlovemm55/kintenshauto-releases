/**
 * Copyright Manager - ระบบจัดการลิขสิทธิ์แบบ manual
 *
 * Flow:
 * 1. โพสต์ด้วย Set 1
 * 2. Monitor หลังโพสต์ 30-60 วิ
 * 3. ถ้าติดลิขสิทธิ์:
 *    - ลบโพสต์ออก
 *    - เพิ่ม audio_fp เข้า blacklist
 *    - update jobs.copyright_blocked = 1
 *    - ส่ง notification รอ user กด "ใช้ Set 2"
 * 4. user กดปุ่ม → สร้าง job ใหม่ใช้ Set 2
 */

const Database = require('better-sqlite3');
const EventEmitter = require('events');

class CopyrightManager extends EventEmitter {
    constructor(dbPath) {
        super();
        this.db = dbPath instanceof Database ? dbPath : new Database(dbPath);
        this.db.pragma('foreign_keys = ON');   // ✅ FIX H1: per-connection cascade enable
    }

    /**
     * เช็คก่อนอัปโหลด - เทียบ audio fingerprint กับ blacklist
     * @returns {boolean} true = ปลอดภัย, false = อยู่ใน blacklist
     */
    preCheck(audioFingerprint) {
        const row = this.db.prepare(`
            SELECT id FROM copyright_blacklist WHERE audio_fp = ?
        `).get(audioFingerprint);
        return !row;
    }

    /**
     * Detect ลิขสิทธิ์ก่อน publish (อ่าน DOM ของ reels_composer)
     * จะถูกเรียกจาก Puppeteer
     */
    async detectPrePublish(page) {
        const selectors = [
            'div[role="alert"]',
            '[aria-label*="copyright" i]',
            '[aria-label*="ลิขสิทธิ์"]'
        ];

        for (const sel of selectors) {
            try {
                const el = await page.$(sel);
                if (el) {
                    const text = await page.evaluate(e => e.textContent, el);
                    if (this.isCopyrightWarning(text)) {
                        return { blocked: true, reason: 'pre_publish', message: text };
                    }
                }
            } catch (e) {
                continue;
            }
        }
        return { blocked: false };
    }

    /**
     * Monitor หลัง publish - exponential backoff (15s → 30s → 60s)
     * ✅ FIX H2: เดิม poll ทุก 5 วิ → page.goto FB rate-limit
     */
    async monitorPostPublish(page, postId, timeoutMs = 60000) {
        const start = Date.now();
        const intervals = [15000, 30000, 60000];   // backoff schedule
        let i = 0;

        while (Date.now() - start < timeoutMs) {
            const result = await this.checkPostStatus(page, postId);
            if (result.blocked) return result;
            const wait = intervals[Math.min(i, intervals.length - 1)];
            i++;
            // ถ้า wait เกิน timeout ที่เหลือ → wait แค่ที่เหลือ
            const remaining = timeoutMs - (Date.now() - start);
            if (remaining <= 0) break;
            await new Promise(r => setTimeout(r, Math.min(wait, remaining)));
        }
        return { blocked: false };
    }

    async checkPostStatus(page, postId) {
        // Skip placeholder/synthetic IDs — these don't resolve to a real post on FB, so
        // visiting them and scanning the page would produce a false copyright verdict.
        // 'verified_' = poster confirmed the Reel via the Reels tab but never parsed a numeric id.
        if (!postId || /^(processing_|unknown_|verified_)/i.test(postId)) {
            return { blocked: false, skipped: true, reason: 'no_real_post_id' };
        }
        try {
            await page.goto(`https://www.facebook.com/${postId}`, { waitUntil: 'domcontentloaded' });
            const bodyText = await page.evaluate(() => document.body.innerText);

            if (this.isCopyrightWarning(bodyText)) {
                return { blocked: true, reason: 'post_publish_detection' };
            }

            const isVisible = await page.evaluate(() => {
                return !document.body.innerText.includes('This content isn\'t available') &&
                       !document.body.innerText.includes('ไม่พร้อมให้บริการ');
            });

            if (!isVisible) {
                return { blocked: true, reason: 'post_removed' };
            }

            return { blocked: false };
        } catch (err) {
            return { blocked: false, error: err.message };
        }
    }

    isCopyrightWarning(text) {
        if (!text) return false;
        const lower = text.toLowerCase();
        // Match SPECIFIC copyright-claim / muted-audio phrases only.
        // Bare words like "copyright" / "muted" / "content id" / "ลิขสิทธิ์" appear in
        // Facebook's footer + menu chrome on EVERY logged-in page, so scanning the whole
        // page body for them produced false strikes that blacklisted audio and deleted
        // successfully-posted Reels. These multi-word phrases only show up in an actual claim.
        const phrases = [
            'copyrighted content',
            'copyrighted music',
            'copyright claim',
            'copyright infringement',
            'because of a copyright',
            'may contain copyrighted',
            'matched third-party content',
            'content id claim',
            'we muted the audio',
            'muted the audio',
            'audio was muted',
            'audio has been muted',
            "can't use this audio",
            'เนื้อหาที่มีลิขสิทธิ์',
            'ดนตรีที่มีลิขสิทธิ์',
            'มีลิขสิทธิ์ของบุคคลที่สาม',
            'ปิดเสียงเนื่องจาก',
            'ถูกปิดเสียงเพราะ',
            'ถูกปิดเสียงเนื่องจาก'
        ];
        return phrases.some(p => lower.includes(p.toLowerCase()));
    }

    /**
     * Handle การติดลิขสิทธิ์ - manual flow
     */
    async handleCopyrightHit(jobId, audioFp, postId = null, page = null) {
        const tx = this.db.transaction(() => {
            // Read prior state BEFORE the update so we can tell a pre-publish hit (job was
            // 'running', never posted) from a post-publish strike (job was 'posted' and the
            // live post is about to be deleted).
            const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
            const wasPosted = job && job.status === 'posted';

            this.db.prepare(`
                UPDATE jobs
                SET copyright_blocked = 1, status = 'copyright_waiting'
                WHERE id = ?
            `).run(jobId);

            const existing = this.db.prepare(
                'SELECT id FROM copyright_blacklist WHERE audio_fp = ?'
            ).get(audioFp);

            if (!existing && audioFp) {
                this.db.prepare(`
                    INSERT INTO copyright_blacklist (audio_fp, note)
                    VALUES (?, ?)
                `).run(audioFp, `Auto-added from job ${jobId}`);
            }

            this.db.prepare(`
                INSERT INTO post_log (job_id, event, detail)
                VALUES (?, 'copyright_detected', ?)
            `).run(jobId, JSON.stringify({ post_id: postId, audio_fp: audioFp }));

            if (job) {
                // Upsert so the strike is recorded even on the day's first event (a bare
                // UPDATE was a no-op when no daily_stats row existed yet).
                this.db.prepare(`
                    INSERT INTO daily_stats (page_id, date, copyright_blocks)
                    VALUES (?, date('now', 'localtime'), 1)
                    ON CONFLICT(page_id, date) DO UPDATE SET copyright_blocks = copyright_blocks + 1
                `).run(job.page_id);
                // When we actually delete the live post (real id + page provided), don't keep
                // counting it against the daily quota — otherwise a removed Reel still burns a
                // posting slot. (An in-tab verdict with page=null leaves the post up → keep the count.)
                if (wasPosted && postId && page) {
                    this.db.prepare(`
                        UPDATE daily_stats SET posts_count = MAX(0, posts_count - 1)
                        WHERE page_id = ? AND date = date('now', 'localtime')
                    `).run(job.page_id);
                }
            }
        });

        tx();

        if (postId && page) {
            await this.deletePost(page, postId).catch(err => {
                console.error('[CopyrightManager] Failed to delete post:', err.message);
            });
        }

        this.emit('copyright_blocked', { jobId, audioFp, postId });

        return {
            jobId,
            message: 'คลิปติดลิขสิทธิ์ - รอ user กดปุ่ม "ใช้ Set 2 แทน"'
        };
    }

    async deletePost(page, postId) {
        // Skip placeholder/synthetic IDs — can't delete a post we don't have a real ID for.
        if (!postId || /^(processing_|unknown_|verified_)/i.test(postId)) {
            console.log(`[CopyrightManager] deletePost skipped — no real post ID (got: ${postId || 'none'})`);
            return;
        }
        await page.goto(`https://www.facebook.com/${postId}`, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 2000));

        const menuBtn = await page.$('[aria-label="Actions for this post"]');
        if (menuBtn) {
            await menuBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            // Puppeteer 23 removed page.$x() — use evaluateHandle for XPath-like text matching
            const deleteHandle = await page.evaluateHandle(() => {
                const spans = Array.from(document.querySelectorAll('span'));
                return spans.find(s => {
                    const t = (s.textContent || '').trim();
                    return t === 'Delete' || t === 'ลบ' || t === 'Remove';
                }) || null;
            });
            if (deleteHandle && deleteHandle.asElement()) {
                await deleteHandle.asElement().click();
                await new Promise(r => setTimeout(r, 1000));

                const confirmHandle = await page.evaluateHandle(() => {
                    const candidates = Array.from(document.querySelectorAll('[role="button"]'));
                    return candidates.find(el => {
                        const t = (el.textContent || '').trim();
                        return t === 'Delete' || t === 'ลบ' || t === 'Remove';
                    }) || null;
                });
                if (confirmHandle && confirmHandle.asElement()) {
                    await confirmHandle.asElement().click();
                }
            }
        }
    }

    /**
     * User กดปุ่ม "ใช้ Set 2 แทน" - สร้าง job ใหม่
     */
    retryWithSet2(jobId) {
        const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
        if (!job) throw new Error(`Job ${jobId} not found`);
        if (!job.copyright_blocked) throw new Error(`Job ${jobId} not blocked`);

        const clip = this.db.prepare('SELECT * FROM clips WHERE id = ?').get(job.clip_id);
        if (!clip.set2_path) throw new Error('Set 2 ยังไม่ถูกสร้าง');

        const tx = this.db.transaction(() => {
            this.db.prepare(`
                UPDATE jobs SET status = 'cancelled' WHERE id = ?
            `).run(jobId);

            const result = this.db.prepare(`
                INSERT INTO jobs (clip_id, page_id, scheduled_at, use_set, status)
                VALUES (?, ?, datetime('now', 'localtime', '+30 seconds'), 2, 'pending')
            `).run(job.clip_id, job.page_id);

            this.db.prepare(`
                INSERT INTO post_log (job_id, event, detail)
                VALUES (?, 'retry_with_set2', ?)
            `).run(result.lastInsertRowid, JSON.stringify({ original_job: jobId }));

            return result.lastInsertRowid;
        });

        const newJobId = tx();
        this.emit('retry_with_set2', { originalJobId: jobId, newJobId });
        return newJobId;
    }

    /**
     * ดึง jobs ที่รอ user ตัดสินใจ (แสดงใน UI notification)
     */
    getPendingReviews() {
        // ✅ FIX C6: เดิม ORDER BY finished_at — แต่ handleCopyrightHit ไม่ได้ set
        // ค่านี้ → ทุก row finished_at = NULL → เรียงผิดสุ่ม
        // เปลี่ยนเป็น created_at (มี DEFAULT CURRENT_TIMESTAMP — มีค่าเสมอ)
        return this.db.prepare(`
            SELECT j.*, c.caption, c.set2_path, p.name as page_name, sv.title as video_title
            FROM jobs j
            JOIN clips c ON c.id = j.clip_id
            JOIN pages p ON p.id = j.page_id
            LEFT JOIN scouted_videos sv ON sv.id = c.scouted_id
            WHERE j.copyright_blocked = 1
              AND j.status = 'copyright_waiting'
            ORDER BY COALESCE(j.finished_at, j.created_at) DESC
        `).all();
    }

    dismissReview(jobId) {
        this.db.prepare(`
            UPDATE jobs SET status = 'failed', copyright_blocked = 0
            WHERE id = ? AND status = 'copyright_waiting'
        `).run(jobId);
        this.emit('review_dismissed', { jobId });
    }
}

module.exports = { CopyrightManager };
