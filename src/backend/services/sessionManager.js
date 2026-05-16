/**
 * Session Manager - จัดการ session cookies ของ FB
 *
 * ทำไมสำคัญ: ถ้า login ซ้ำบ่อย FB จะ flag เป็น bot
 * วิธีแก้: เก็บ cookies หลัง login ครั้งแรก ครั้งต่อไป set cookies แทน
 *
 * Flow:
 *   1. เปิด Chrome ด้วย userDataDir (Chrome จะเก็บ cookies ให้)
 *   2. ถ้ายังไม่เคย login -> เปิดให้ user login เอง (manual)
 *   3. Detect checkpoint/captcha -> หยุดและแจ้ง user
 *   4. Save cookies ลง DB เป็น backup
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getPlatformConfig } = require('./platformConfig');

class SessionManager {
    constructor(dbPath, chromeProfilesDir) {
        this.db = dbPath instanceof Database ? dbPath : new Database(dbPath);
        this.db.pragma('foreign_keys = ON');   // ✅ FIX H1: per-connection cascade enable
        this.chromeProfilesDir = chromeProfilesDir;

        // Create cookies backup table if not exists
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_cookies (
                profile_id INTEGER PRIMARY KEY,
                cookies_json TEXT NOT NULL,
                last_verified_at DATETIME,
                FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
            )
        `);
    }

    getProfile(profileId) {
        return this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
    }

    getUserDataDir(profileId) {
        const profile = this.getProfile(profileId);
        return profile?.user_data_dir;
    }

    /**
     * Resolve profile platform — defaults to 'facebook' for legacy rows (no platform column populated).
     */
    _platformOf(profileId) {
        try {
            const row = this.db.prepare('SELECT platform FROM profiles WHERE id = ?').get(profileId);
            return row?.platform || 'facebook';
        } catch { return 'facebook'; }
    }

    /**
     * Save cookies after successful login.
     * Platform is resolved from the profile row (FB default for legacy rows).
     */
    async saveCookies(profileId, page) {
        const platform = this._platformOf(profileId);
        let cookies;
        if (platform === 'facebook') {
            // Legacy path: explicit FB domain pair (unchanged behavior)
            cookies = await page.cookies('https://www.facebook.com', 'https://business.facebook.com');
        } else {
            // Other platforms: pull cookies for that domain
            const url = getPlatformConfig(platform).loginUrl;
            cookies = await page.cookies(url);
        }
        const json = JSON.stringify(cookies);

        this.db.prepare(`
            INSERT OR REPLACE INTO session_cookies (profile_id, cookies_json, last_verified_at)
            VALUES (?, ?, datetime('now', 'localtime'))
        `).run(profileId, json);

        this.db.prepare(`
            UPDATE profiles SET last_login_at = datetime('now', 'localtime'), status = 'active' WHERE id = ?
        `).run(profileId);
    }

    /**
     * Load cookies into browser (if user_data_dir lost them)
     */
    async restoreCookies(profileId, page) {
        const row = this.db.prepare(`SELECT cookies_json FROM session_cookies WHERE profile_id = ?`).get(profileId);
        if (!row || !row.cookies_json) return false;

        let cookies;
        try { cookies = JSON.parse(row.cookies_json); }
        catch (e) { console.warn('[sessionManager] cookies_json corrupt for profile', profileId, e.message); return false; }
        if (!Array.isArray(cookies) || cookies.length === 0) return false;
        await page.setCookie(...cookies);
        return true;
    }

    /**
     * Verify session by navigating to the platform's home & checking if logged in.
     * Pass profileId so we know which platform to navigate to (FB-only for legacy callers).
     */
    async verifySession(page, profileId) {
        const platform = profileId ? this._platformOf(profileId) : 'facebook';
        const loginUrl = getPlatformConfig(platform).loginUrl;
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const result = await page.evaluate(() => {
            const url = window.location.href;
            const body = document.body.innerText || '';

            // Logged out indicators (generic — works for FB/X/IG redirect-to-login pattern)
            if (url.includes('/login') || url.includes('/checkpoint')) {
                return { ok: false, reason: url.includes('checkpoint') ? 'checkpoint' : 'logged_out' };
            }
            // Checkpoint in body
            if (/security check|verify.+identity|ยืนยัน.+ตัวตน|checkpoint/i.test(body)) {
                return { ok: false, reason: 'checkpoint' };
            }
            // Captcha
            if (/captcha|recaptcha/i.test(body)) {
                return { ok: false, reason: 'captcha' };
            }
            return { ok: true };
        });

        return result;
    }

    /**
     * Detect checkpoint/captcha and throw with user-friendly message
     */
    async detectBlocks(page) {
        const verify = await this.verifySession(page);
        if (!verify.ok) {
            const msg = {
                logged_out: 'Session หมดอายุ - ต้อง login ใหม่',
                checkpoint: 'FB ขอยืนยันตัวตน - เปิด Chrome ยืนยันก่อน แล้วค่อยรัน',
                captcha: 'FB ขอทำ CAPTCHA - เปิด Chrome ทำก่อน แล้วค่อยรัน'
            }[verify.reason] || 'Session ผิดปกติ';

            return { blocked: true, reason: verify.reason, message: msg };
        }
        return { blocked: false };
    }

    markProfileBlocked(profileId, reason) {
        this.db.prepare(`UPDATE profiles SET status = 'blocked' WHERE id = ?`).run(profileId);
        this.db.prepare(`
            INSERT INTO post_log (event, detail)
            VALUES ('profile_blocked', ?)
        `).run(JSON.stringify({ profile_id: profileId, reason }));
    }

    /**
     * Warm-up: scroll feed for 60-120 seconds before posting (anti-detection)
     */
    async warmUp(page, durationSec = 90) {
        console.log(`[session] warming up for ${durationSec}s...`);
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });

        const startTime = Date.now();
        const endTime = startTime + durationSec * 1000;

        while (Date.now() < endTime) {
            // Random scroll
            await page.evaluate(() => {
                window.scrollBy({ top: 300 + Math.random() * 500, behavior: 'smooth' });
            });
            // Random pause 2-5 sec
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
        }
    }
}

module.exports = { SessionManager };
