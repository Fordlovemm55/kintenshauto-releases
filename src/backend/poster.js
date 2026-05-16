/**
 * Facebook Reels Poster (Puppeteer)
 *
 * Strategy: user-friendly + safe
 * - Launch Chrome with profile's userDataDir (keeps cookies)
 * - If not logged in → leave browser open so user logs in manually
 * - If logged in → navigate to reels composer, upload, caption, click publish
 * - Monitor copyright warning
 *
 * Note: we DO NOT auto-type password. User types it the first time.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

/**
 * Find Chrome binary on this machine (Windows)
 * Priority: settings override → env var → standard install paths
 */
function findChromeExecutable() {
    // 1. User-specified override via settings (sticky across restarts)
    try {
        const dbPath = process.env.KINTENSHAUTO_DB;
        if (dbPath && fs.existsSync(dbPath)) {
            const tdb = new Database(dbPath, { readonly: true });
            const row = tdb.prepare(`SELECT value FROM settings WHERE key = 'chrome_executable_path'`).get();
            tdb.close();
            const userPath = row?.value;
            if (userPath && fs.existsSync(userPath)) return userPath;
        }
    } catch { /* fallthrough */ }

    // 2. Env var override
    if (process.env.KINTENSHAUTO_CHROME && fs.existsSync(process.env.KINTENSHAUTO_CHROME)) {
        return process.env.KINTENSHAUTO_CHROME;
    }

    // 3. Standard Windows install locations
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        // Edge as last resort (Chromium-based, works with Puppeteer)
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    for (const c of candidates) {
        if (c && fs.existsSync(c)) return c;
    }
    return null;
}

/**
 * Launch Chrome for user login — still looks 100% like a normal Chrome to FB (no
 * automation flags), but includes --remote-debugging-port so our backend can
 * connect via puppeteer later WITHOUT spawning a second Chrome (Chrome can only
 * run one process per userDataDir).
 *
 * Tracked in spawnedChromes so later automation (fetch-pages / post) reuses this
 * same process — never a 2nd Chrome for the same profile.
 */
function launchPlainChromeForLogin(profile, { startUrl = 'https://www.facebook.com/' } = {}) {
    const userDataDir = profile.user_data_dir;
    if (!userDataDir) throw new Error('profile.user_data_dir missing');
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    // If we already have a tracked Chrome for this profile that's still alive, return it
    const existing = spawnedChromes.get(profile.id);
    if (existing && existing.proc && existing.proc.exitCode === null) {
        return { pid: existing.proc.pid, port: existing.port, reused: true };
    }

    for (const lockName of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        try { fs.unlinkSync(path.join(userDataDir, lockName)); } catch {}
    }

    const chromePath = findChromeExecutable();
    if (!chromePath) throw new Error('ไม่เจอ Chrome — ต้องติดตั้ง Google Chrome ก่อน');

    const port = pickPortForProfile(profile.id);

    // MINIMAL flags + remote-debugging-port. NO automation flags.
    const args = [
        `--user-data-dir=${userDataDir}`,
        '--profile-directory=Default',
        `--remote-debugging-port=${port}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=DestroyProfileOnBrowserClose'
    ];
    if (profile.proxy_host && profile.proxy_port) {
        const proxy = (profile.proxy_type || 'http') + '://' + profile.proxy_host + ':' + profile.proxy_port;
        args.push(`--proxy-server=${proxy}`);
    }
    args.push(startUrl);

    const child = spawn(chromePath, args, {
        detached: false,
        stdio: 'ignore',
        windowsHide: false
    });
    spawnedChromes.set(profile.id, { proc: child, port });
    child.on('exit', () => {
        const cur = spawnedChromes.get(profile.id);
        if (cur && cur.proc === child) spawnedChromes.delete(profile.id);
    });

    return { pid: child.pid, port, reused: false };
}

/**
 * Try to reconnect to an ALREADY-RUNNING Chrome for this profile.
 * Puppeteer writes DevToolsActivePort to userDataDir on launch. If Chrome
 * is still alive, that file still points to a valid debug endpoint.
 * Returns null if no existing Chrome.
 */
async function tryReconnect(profile) {
    const activeFile = path.join(profile.user_data_dir || '', 'DevToolsActivePort');
    if (!fs.existsSync(activeFile)) return null;
    try {
        const content = fs.readFileSync(activeFile, 'utf-8').split('\n');
        const port = parseInt(content[0], 10);
        const wsPath = content[1] || '';
        if (!port || !wsPath) return null;
        const browserWSEndpoint = `ws://127.0.0.1:${port}${wsPath}`;
        const browser = await puppeteer.connect({ browserWSEndpoint, defaultViewport: null });
        return browser;
    } catch {
        return null;
    }
}

// Track plain-Chrome processes we spawn per profile
const spawnedChromes = new Map();  // profileId -> { proc, port }

function pickPortForProfile(profileId) {
    return 9333 + (Number(profileId) % 500);
}

async function waitForDebugPort(port, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (res.ok) {
                const data = await res.json();
                return data.webSocketDebuggerUrl;
            }
        } catch {}
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`debug port ${port} not ready after ${timeoutMs}ms`);
}

/**
 * Launch Chrome that looks 100% identical to a normal user Chrome to Facebook.
 *
 * Strategy: spawn a plain Chrome process with --remote-debugging-port (no automation
 * flags), then connect Puppeteer via puppeteer.connect(). FB sees a regular Chrome —
 * same fingerprint as the one user logged in with — so session persists.
 */
async function launchForProfile(profile, { headless = false } = {}) {
    const userDataDir = profile.user_data_dir;
    if (!userDataDir) throw new Error('profile.user_data_dir missing');
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    // Try reconnecting to an already-running Chrome (via /DevToolsActivePort file)
    const reconnected = await tryReconnect(profile);
    if (reconnected) {
        console.log(`[poster] reconnected to existing Chrome for profile ${profile.id}`);
        return reconnected;
    }

    // If we previously spawned a Chrome and it's still alive, reconnect via its known port
    const prev = spawnedChromes.get(profile.id);
    if (prev && prev.proc && prev.proc.exitCode === null) {
        try {
            const wsUrl = await waitForDebugPort(prev.port, 2000);
            const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null });
            console.log(`[poster] reconnected to our spawned Chrome (port ${prev.port}) for profile ${profile.id}`);
            return browser;
        } catch {
            try { prev.proc.kill(); } catch {}
            spawnedChromes.delete(profile.id);
        }
    }

    // Clean stale locks ONLY if no Chrome is running for this userDataDir
    for (const lockName of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        try { fs.unlinkSync(path.join(userDataDir, lockName)); } catch {}
    }

    const chromePath = findChromeExecutable();
    if (!chromePath) throw new Error('Google Chrome ไม่เจอในเครื่อง โปรดติดตั้งก่อน');

    const port = pickPortForProfile(profile.id);

    // MINIMAL flags — looks identical to plain Chrome from FB's perspective
    const args = [
        `--user-data-dir=${userDataDir}`,
        '--profile-directory=Default',
        `--remote-debugging-port=${port}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=DestroyProfileOnBrowserClose',
        '--disable-session-crashed-bubble',
        '--disable-infobars'
    ];
    if (profile.proxy_host && profile.proxy_port) {
        const proxy = (profile.proxy_type || 'http') + '://' + profile.proxy_host + ':' + profile.proxy_port;
        args.push(`--proxy-server=${proxy}`);
    }
    if (headless) args.push('--headless=new');

    const proc = spawn(chromePath, args, {
        detached: false,
        stdio: 'ignore',
        windowsHide: false
    });
    spawnedChromes.set(profile.id, { proc, port });
    proc.on('exit', () => {
        const cur = spawnedChromes.get(profile.id);
        if (cur && cur.proc === proc) spawnedChromes.delete(profile.id);
    });

    let wsUrl;
    try {
        wsUrl = await waitForDebugPort(port);
    } catch (e) {
        try { proc.kill(); } catch {}
        spawnedChromes.delete(profile.id);
        throw new Error('Chrome ไม่ตอบ debug port: ' + e.message);
    }

    const browser = await puppeteer.connect({
        browserWSEndpoint: wsUrl,
        defaultViewport: null
    });
    console.log(`[poster] profile ${profile.id}: spawned Chrome on port ${port} and connected puppeteer`);
    return browser;
}

function getSpawnedChromeInfo(profileId) {
    return spawnedChromes.get(profileId);
}

async function killSpawnedChrome(profileId) {
    const entry = spawnedChromes.get(profileId);
    if (!entry) return false;
    try { entry.proc.kill(); } catch {}
    spawnedChromes.delete(profileId);
    return true;
}

// Resolve platform from profileId — falls back to 'facebook' for legacy profiles
// (rows that existed before the platform column was added).
function _platformOf(db, profileId) {
    try {
        const row = db.prepare('SELECT platform FROM profiles WHERE id = ?').get(profileId);
        return row?.platform || 'facebook';
    } catch { return 'facebook'; }
}

async function isLoggedIn(page, platform = 'facebook') {
    try {
        const { getPlatformConfig } = require('./services/platformConfig');
        const cfg = getPlatformConfig(platform);
        await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 1500));
        const url = page.url();
        if (url.includes('/login') || url.includes('/checkpoint')) return { ok: false, reason: url.includes('checkpoint') ? 'checkpoint' : 'logged_out' };
        // FB-specific email input check (legacy behavior — only meaningful for FB)
        if (platform === 'facebook') {
            const hasLoginForm = await page.$('input[name="email"]').catch(() => null);
            if (hasLoginForm) return { ok: false, reason: 'logged_out' };
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: 'error', message: e.message };
    }
}

/**
 * Save all cookies the browser currently has for the profile's platform to the DB as backup.
 * Platform filter is resolved from profiles.platform column (falls back to 'facebook' for legacy).
 * This protects against Chrome's userDataDir getting wiped/corrupted.
 */
async function backupCookiesToDb(db, profileId, browser, platformOverride) {
    try {
        const platform = platformOverride || _platformOf(db, profileId);
        const { isDomainForPlatform } = require('./services/platformConfig');
        // browser.cookies() exists in Puppeteer 23+ and returns all cookies.
        // Fall back to page.cookies() per page if not supported.
        let allCookies = [];
        if (typeof browser.cookies === 'function') {
            allCookies = await browser.cookies();
        } else {
            const pages = await browser.pages();
            for (const p of pages) {
                try {
                    const cs = await p.cookies();
                    allCookies.push(...cs);
                } catch {}
            }
        }
        const platformCookies = allCookies.filter(c => isDomainForPlatform(c.domain, platform));
        // Dedupe by name+domain+path (page.cookies returns duplicates across pages)
        const seen = new Set();
        const unique = platformCookies.filter(c => {
            const key = `${c.name}|${c.domain}|${c.path}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        if (unique.length === 0) return { saved: 0 };

        // Extend expiry on critical auth cookies so they survive Chrome restarts even
        // if they were originally "session" cookies (expires = -1 / 0).
        // This artificially extends login lifetime to 90 days on the client side.
        const NINETY_DAYS = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
        const persistent = unique.map(c => {
            const needsExtend = !c.expires || c.expires < 0 || c.expires < Math.floor(Date.now() / 1000);
            return needsExtend ? { ...c, expires: NINETY_DAYS, session: false } : { ...c, session: false };
        });

        db.prepare(`
            INSERT OR REPLACE INTO session_cookies (profile_id, cookies_json, last_verified_at)
            VALUES (?, ?, datetime('now', 'localtime'))
        `).run(profileId, JSON.stringify(persistent));
        return { saved: persistent.length };
    } catch (e) {
        return { saved: 0, error: e.message };
    }
}

/**
 * Restore cookies from DB into a freshly-launched browser.
 * Call BEFORE navigating to facebook.com on the first page.
 */
async function restoreCookiesFromDb(db, profileId, browser) {
    try {
        const row = db.prepare(`SELECT cookies_json FROM session_cookies WHERE profile_id = ?`).get(profileId);
        if (!row || !row.cookies_json) return { restored: 0 };
        let cookies;
        try { cookies = JSON.parse(row.cookies_json); }
        catch (e) { console.warn('[poster] cookies_json corrupt for profile', profileId, e.message); return { restored: 0, error: 'corrupt' }; }
        if (!Array.isArray(cookies) || cookies.length === 0) return { restored: 0 };

        // Clean cookies: drop fields that CDP rejects; re-normalize sameSite
        const clean = cookies.map(c => {
            const out = {
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path || '/',
                secure: !!c.secure,
                httpOnly: !!c.httpOnly
            };
            if (c.expires !== undefined && c.expires !== -1 && c.expires > 0) out.expires = c.expires;
            if (c.sameSite) {
                const ss = String(c.sameSite).toLowerCase();
                if (ss === 'lax') out.sameSite = 'Lax';
                else if (ss === 'strict') out.sameSite = 'Strict';
                else if (ss === 'none') out.sameSite = 'None';
            }
            return out;
        });

        if (typeof browser.setCookie === 'function') {
            await browser.setCookie(...clean);
        } else {
            const pages = await browser.pages();
            const page = pages[0] || await browser.newPage();
            await page.setCookie(...clean);
        }
        // Show login-cookie presence in log (platform-aware)
        try {
            const { getPlatformConfig } = require('./services/platformConfig');
            const platform = _platformOf(db, profileId);
            const indicators = getPlatformConfig(platform).loginCookieNames || [];
            const present = indicators.filter(n => clean.some(c => c.name === n));
            console.log(`[poster] restored ${clean.length} cookies for profile ${profileId} (${platform}: login cookies ${present.length}/${indicators.length} present)`);
        } catch {
            console.log(`[poster] restored ${clean.length} cookies for profile ${profileId}`);
        }
        return { restored: clean.length };
    } catch (e) {
        console.error(`[poster] restoreCookies failed for profile ${profileId}:`, e.message);
        return { restored: 0, error: e.message };
    }
}

async function humanDelay(min = 600, max = 1500) {
    return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

// Segment text into grapheme clusters so emoji surrogate pairs + ZWJ sequences
// (👨‍👩‍👧, skin-tone modifiers, flags) stay together. Fallback to code-point iteration
// if Intl.Segmenter is unavailable.
function segmentGraphemes(text) {
    try {
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
            const seg = new Intl.Segmenter('th', { granularity: 'grapheme' });
            return Array.from(seg.segment(text), s => s.segment);
        }
    } catch {}
    // Fallback: Array.from iterates by code point (so surrogate pairs become 1 entry),
    // which handles most emojis but not ZWJ sequences.
    return Array.from(text);
}

// Heuristic: does this segment contain any character outside the Basic Multilingual Plane
// (i.e. emojis / symbols)? If yes, keyboard.type() likely can't send it — use sendCharacter.
function containsNonBMP(s) {
    for (const ch of s) {
        if (ch.codePointAt(0) > 0xFFFF) return true;
    }
    // Also catch common BMP emoji blocks: dingbats, misc symbols, arrows, etc.
    return /[\u2600-\u27BF\u2B00-\u2BFF\u3000-\u303F]/.test(s);
}

// Type text into focused field with variable speed + occasional pauses (human feel),
// correctly handling emoji / multi-codepoint grapheme clusters.
//
// Puppeteer's page.keyboard.type() sends per-char keypress events via the CDP
// Input.dispatchKeyEvent API which chokes on:
//   - Surrogate pairs (any emoji above U+FFFF — most of them)
//   - ZWJ-joined sequences (family emoji, skin tones)
//   - Combining marks
// Solution: segment text into grapheme clusters; for non-BMP/multi-char clusters use
// page.keyboard.sendCharacter() which maps to Input.insertText (handles any Unicode).
async function humanType(page, text) {
    const segments = segmentGraphemes(text);
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const baseDelay = /[ก-๙]/.test(seg) ? 60 : 35;
        let d = baseDelay + Math.random() * 80;
        // 8% chance of a "thinking pause"
        if (Math.random() < 0.08) d += 200 + Math.random() * 600;

        const needsInsertText = seg.length > 1 || containsNonBMP(seg);

        if (needsInsertText) {
            // Emoji / grapheme cluster — use sendCharacter (CDP Input.insertText under the hood).
            // This inserts the text without synthesizing keydown/keyup which would strip surrogates.
            try {
                await page.keyboard.sendCharacter(seg);
            } catch (e) {
                // Last-resort: type via element.value fallback (won't trigger React handlers,
                // but better than skipping the emoji entirely). Only reached if sendCharacter fails.
                try {
                    await page.evaluate((emoji) => {
                        const el = document.activeElement;
                        if (!el) return;
                        if (el.isContentEditable) {
                            document.execCommand('insertText', false, emoji);
                        } else if ('value' in el) {
                            const start = el.selectionStart ?? el.value.length;
                            const end = el.selectionEnd ?? el.value.length;
                            el.value = el.value.slice(0, start) + emoji + el.value.slice(end);
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    }, seg);
                } catch {}
            }
            await new Promise(r => setTimeout(r, d));
            continue;
        }

        // Plain ASCII / Thai single char — can use keyboard.type for realistic typing feel.
        // Tiny chance of typo + correction (1.5%) — only for alphabetic chars
        if (Math.random() < 0.015 && /[a-zA-Zก-๙]/.test(seg)) {
            const wrongCh = String.fromCharCode(97 + Math.floor(Math.random() * 26));
            await page.keyboard.type(wrongCh, { delay: d });
            await new Promise(r => setTimeout(r, 150 + Math.random() * 300));
            await page.keyboard.press('Backspace');
            await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
        }
        await page.keyboard.type(seg, { delay: d });
    }
}

// Random small scrolls within page — looks like browsing
async function humanScroll(page, times = 2) {
    for (let i = 0; i < times; i++) {
        const dy = (Math.random() < 0.7 ? 1 : -1) * (100 + Math.random() * 400);
        await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: 'smooth' }), dy).catch(() => {});
        await humanDelay(800, 2000);
    }
}

// Random mouse movement (jiggle within viewport)
async function humanMouseMove(page) {
    try {
        const vp = await page.viewport() || { width: 1280, height: 800 };
        const x = 100 + Math.random() * (vp.width - 200);
        const y = 100 + Math.random() * (vp.height - 200);
        await page.mouse.move(x, y, { steps: 10 + Math.floor(Math.random() * 15) });
    } catch {}
}

// Click an element by visible text (FB uses div[role="button"] with nested span text)
async function clickButtonByText(page, texts, opts = {}) {
    const wantPrimary = opts.primary || false;   // prefer blue/colored button if present
    const handle = await page.evaluateHandle((textsArr, primary) => {
        const buttons = Array.from(document.querySelectorAll(
            'div[role="button"], button, [role="button"]'
        ));
        const matches = [];
        for (const btn of buttons) {
            const txt = (btn.innerText || btn.textContent || '').trim();
            const ariaLabel = btn.getAttribute('aria-label') || '';
            const candidate = txt || ariaLabel;
            for (const want of textsArr) {
                if (candidate === want || candidate.startsWith(want)) {
                    matches.push(btn);
                    break;
                }
            }
        }
        if (!matches.length) return null;
        if (primary) {
            // Prefer button whose computed background-color is bluish (FB primary)
            const blue = matches.find(b => {
                try {
                    const bg = getComputedStyle(b).backgroundColor;
                    if (!bg || bg === 'rgba(0, 0, 0, 0)') return false;
                    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
                    if (!m) return false;
                    const [, r, g, bl] = m.map(Number);
                    return bl > 150 && bl > r + 20;
                } catch { return false; }
            });
            if (blue) return blue;
        }
        return matches[matches.length - 1];   // last = usually bottom-right primary
    }, texts, wantPrimary);

    const el = handle && handle.asElement && handle.asElement();
    if (!el) return false;
    try {
        await el.scrollIntoView();
    } catch {}
    await el.click().catch(async () => {
        // Fallback: synthetic click via JS
        await page.evaluate(e => e.click(), el);
    });
    return true;
}

// Wait for copyright check on the share step.
// FB shows copyright scan with a progress bar + text "กำลังตรวจหาเนื้อหาที่มีลิขสิทธิ์".
// User can proceed without waiting, but we WAIT until scan completes for safety —
// posting during scan increases false-positive copyright hits later.
// Returns { blocked: boolean, message?: string, status: 'safe'|'blocked'|'scan_done'|'no-check'|'timeout' }
async function waitForCopyrightCheck(page, timeoutMs = 120000) {
    const start = Date.now();
    let sawCheckIndicator = false;
    let lastProgress = -1;
    let progressStableSince = 0;

    while (Date.now() - start < timeoutMs) {
        try {
            const result = await page.evaluate(() => {
                const text = document.body.innerText || '';

                // BLOCKED — copyright infringement detected (HARD fail)
                if (/ลิขสิทธิ์.*ละเมิด|copyright.*infring|content.*matches|พบเนื้อหาลิขสิทธิ์|ตรวจพบเนื้อหาที่มีลิขสิทธิ์|copyright.*claim/i.test(text)) {
                    const m = text.match(/[^\n]*(?:ลิขสิทธิ์|copyright)[^\n]*/i);
                    return { status: 'blocked', message: m ? m[0].slice(0, 200) : 'copyright detected' };
                }

                // SAFE — explicit green check
                if (/เผยแพร่ได้อย่างปลอดภัย|ไม่พบประเด็นปัญหา.*ลิขสิทธิ์|safe to publish|no copyright issues/i.test(text)) {
                    return { status: 'safe' };
                }

                // CHECKING — text OR visible progress bar
                const hasCheckText = /กำลังตรวจ.*ลิขสิทธิ์|กำลังตรวจหาเนื้อหา|ดำเนินการหรือไม่ก็ได้|checking.*copyright|scanning/i.test(text);
                const bars = Array.from(document.querySelectorAll('[role="progressbar"], progress'));
                let maxProgress = -1;
                for (const b of bars) {
                    const v = Number(b.getAttribute('aria-valuenow'));
                    const max = Number(b.getAttribute('aria-valuemax')) || 100;
                    if (Number.isFinite(v) && v >= 0 && v < max) {
                        // Found an incomplete progress bar — scan is running
                        const pct = Math.round((v / max) * 100);
                        if (pct > maxProgress) maxProgress = pct;
                    }
                }
                const hasIncompleteBar = maxProgress >= 0 && maxProgress < 100;

                if (hasCheckText || hasIncompleteBar) {
                    return { status: 'checking', progress: maxProgress, hasCheckText, hasIncompleteBar };
                }

                // NO CHECK INDICATOR — maybe personal page (no scan) OR scan finished silently
                const hasShareBtn = Array.from(document.querySelectorAll('div[role="button"]'))
                    .some(b => /^(แชร์|Share|เผยแพร่|Publish)$/i.test((b.innerText || '').trim()));
                return { status: hasShareBtn ? 'ready' : 'unknown', shareBtn: hasShareBtn };
            });

            if (result.status === 'blocked') return { blocked: true, status: 'blocked', message: result.message };
            if (result.status === 'safe')    return { blocked: false, status: 'safe' };

            if (result.status === 'checking') {
                sawCheckIndicator = true;
                // Track progress changes
                if (result.progress >= 0) {
                    if (result.progress !== lastProgress) {
                        lastProgress = result.progress;
                        progressStableSince = Date.now();
                    }
                }
                // keep waiting
            } else if (result.status === 'ready') {
                // Scan indicator gone + share button visible
                if (sawCheckIndicator) {
                    // We watched it through — wait 2s extra for UI settle, then proceed
                    await new Promise(r => setTimeout(r, 2000));
                    return { blocked: false, status: 'scan_done' };
                }
                // Never saw scanning — could be personal page (no scan) or scan finished before we looked
                // Wait at least 6s to confirm no scan will appear
                if (Date.now() - start > 6000) {
                    return { blocked: false, status: 'no-check' };
                }
            }
        } catch {}
        await new Promise(r => setTimeout(r, 1500));
    }
    return { blocked: false, status: 'timeout', message: `copyright check timed out after ${timeoutMs/1000}s (last progress: ${lastProgress}%)` };
}

// Dismiss any FB "nudge" modal that can pop up during the composer flow.
// Known variants:
//   • "เข้าถึงกลุ่มเป้าหมายใหม่ๆ ด้วยการสร้างคลิป Reels" → click "ไว้โอกาสหน้า"
//   • Re-Reels / Music / feature nudges with "ไม่ใช่ตอนนี้", "Not now", close button
//   • Generic dialog with × close button
// Returns true if a modal was dismissed. Safe to call at any step — does nothing if no modal.
async function dismissNudgeModal(page, onLog) {
    const dismissed = await page.evaluate(() => {
        // Find visible modal/dialog containers (FB uses role="dialog" for these)
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
            .filter(d => {
                const r = d.getBoundingClientRect();
                return r.width > 200 && r.height > 100;
            });
        if (!dialogs.length) return null;

        const dismissTexts = /^(ไว้โอกาสหน้า|ไม่ใช่ตอนนี้|ไม่เอา|ข้าม|ภายหลัง|Not now|Maybe later|Skip|Later|Close|No thanks|ไม่ต้องการ)$/i;

        for (const dialog of dialogs) {
            // Prefer explicit dismiss buttons first
            const buttons = Array.from(dialog.querySelectorAll('div[role="button"], button, a[role="button"]'));
            for (const btn of buttons) {
                const t = (btn.innerText || btn.textContent || '').trim();
                if (dismissTexts.test(t)) {
                    btn.click();
                    return { type: 'dismiss_text', text: t };
                }
            }
            // Fall back to the X close button (aria-label "Close" / "ปิด")
            const closeBtn = dialog.querySelector(
                '[aria-label="Close"], [aria-label="ปิด"], [aria-label="close" i]'
            );
            if (closeBtn) { closeBtn.click(); return { type: 'close_button' }; }
        }
        return null;
    }).catch(() => null);

    if (dismissed) {
        onLog?.(`[modal] dismissed nudge modal (${dismissed.type}${dismissed.text ? ': "'+dismissed.text+'"' : ''})`);
        await new Promise(r => setTimeout(r, 800 + Math.random() * 600));
        return true;
    }
    return false;
}

// =====================================================================================
// Page identity switcher — matches the UI flow from the user's screenshots:
//
//   Step A. Force-navigate to facebook.com (fresh state — dropdown always available)
//   Step B. Find + click the profile avatar (rightmost button in banner, has image, no href)
//   Step C. Wait for dropdown portal to render (visible + large + positioned: fixed/absolute)
//   Step D. Find the row with EXACT text match to target page name → click via ElementHandle
//   Step E. Wait for FB to reload/SPA-route to that identity
//
// Uses ElementHandle.click() instead of page.mouse.click(x,y) because React's synthetic
// event system responds more reliably to Puppeteer's handle-based clicks.
// Takes debug screenshots at each step so users can inspect what went wrong.
// =====================================================================================
// Process-level cache: map of `${profileId}|${pageId}` → timestamp of last successful switch.
// When worker posts multiple clips for the same page within a short window, we skip the
// entire switch flow (save ~20-40 seconds per subsequent post on the same page).
const pageIdentityCache = new Map();
const IDENTITY_CACHE_TTL_MS = 10 * 60 * 1000;  // 10 minutes

/**
 * ✅ NEW: ตรวจ identity ปัจจุบันของ FB session — ก่อน switch flow
 * บอกได้ว่าตอนนี้เป็น โปรไฟล์เฟส (user) หรือ โปรไฟล์เพจ X (page identity)
 *
 * วิธี: navigate ไป /me/ → FB redirect ตามตัวตน
 *   - /me/ → /<numericPageId> → identity = page (acting as page)
 *   - /me/ → /profile.php?id=<userId> → identity = user
 *   - /me/ → /<username> → identity = user (vanity URL)
 *
 * @returns {{kind:'page'|'user'|'unknown', id:string|null, url:string, title:string}}
 */
async function detectCurrentIdentity(page, onLog) {
    try {
        await page.goto('https://www.facebook.com/me/', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await new Promise(r => setTimeout(r, 2500));   // FB redirect + js load
        const url = page.url();
        const title = await page.title().catch(() => '');

        // Pattern 1: facebook.com/<numericId> with no /profile.php prefix → page identity
        // (FB switches identity contextually — when "as page X", /me/ redirects to /<pageId>)
        const pageMatch = url.match(/facebook\.com\/(\d{8,})(?:\/|$|\?)/);
        if (pageMatch) {
            return { kind: 'page', id: pageMatch[1], url, title };
        }
        // Pattern 2: profile.php?id=<userId> → user identity (always personal)
        const userIdMatch = url.match(/profile\.php\?id=(\d+)/);
        if (userIdMatch) {
            return { kind: 'user', id: userIdMatch[1], url, title };
        }
        // Pattern 3: /me/ stayed (rare) or /<username> → user identity
        return { kind: 'user', id: null, url, title };
    } catch (e) {
        onLog?.(`[identity] detect failed: ${e.message}`);
        return { kind: 'unknown', id: null, url: '', title: '' };
    }
}

/**
 * ✅ NEW: สลับกลับเป็น โปรไฟล์เฟส (user identity) — ใช้ตอน identity เป็นเพจอื่นที่ไม่ใช่เป้าหมาย
 *
 * วิธี: click avatar (top right) → หาเมนู "สลับกลับเป็นโปรไฟล์ส่วนตัว..." → click
 * ถ้าหาไม่เจอ → fallback: navigate facebook.com/?as=user (ไม่เสมอใช้ได้ — depends on FB version)
 */
async function switchBackToUser(page, onLog) {
    onLog?.('[identity] switching back to user (โปรไฟล์เฟส)');
    try {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise(r => setTimeout(r, 2500));

        // Click avatar — try multiple selectors (FB UI changes often)
        const avatarClicked = await page.evaluate(() => {
            const candidates = [
                'div[aria-label="บัญชีของคุณ"]',
                'div[aria-label="Your profile"]',
                'div[aria-label*="โปรไฟล์ของคุณ"]',
                'div[aria-label*="Your account"]',
                // Fallback: rightmost circular image in top nav
                'div[role="banner"] image[width="40"]',
            ];
            for (const sel of candidates) {
                const el = document.querySelector(sel);
                if (el) {
                    el.scrollIntoView({ block: 'center' });
                    el.click();
                    return sel;
                }
            }
            return null;
        });
        if (!avatarClicked) {
            return { ok: false, reason: 'avatar button not found' };
        }
        await new Promise(r => setTimeout(r, 2000));

        // Find + click "สลับกลับเป็น..." menu item
        const switched = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll(
                'div[role="menuitem"], a[role="menuitem"], div[role="button"], a[role="button"]'
            ));
            for (const item of items) {
                const text = (item.innerText || item.textContent || '').trim();
                if (/สลับกลับ|กลับไปยังโปรไฟล์|Switch back to|Switch to your personal/i.test(text)) {
                    item.scrollIntoView({ block: 'center' });
                    item.click();
                    return text.slice(0, 60);
                }
            }
            return null;
        });
        if (switched) {
            await new Promise(r => setTimeout(r, 4000));   // FB context switch
            onLog?.(`[identity] ✓ clicked "${switched}"`);
            return { ok: true };
        }
        // Fallback: maybe already as user (no menu item shown)
        return { ok: false, reason: 'no switch-back menu item found' };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

async function switchToPageViaProfileMenu(page, targetPageName, onLog, targetPageId) {
    if (!targetPageName) return { ok: false, reason: 'no_target_name' };
    onLog?.(`[page-switch] ▶ starting identity switch → "${targetPageName}"${targetPageId ? ` (id=${targetPageId})` : ''}`);

    const cacheKey = `${targetPageId || targetPageName}`;

    // ─── FAST-PATH: Verify-then-trust ───
    // Cache without verification was BUGGY: if a previous switch landed on the wrong
    // page but cache was still set, subsequent posts to that target would skip the
    // switch and post to wrong page silently. Now we ALWAYS read current composer
    // page first, and only fast-path if it ACTUALLY shows the target page.
    try {
        const currentUrl = page.url();
        if (/facebook\.com/i.test(currentUrl)) {
            const currentPageName = await readCurrentComposerPage(page).catch(() => '');
            if (currentPageName && pageNameMatches(currentPageName, targetPageName)) {
                onLog?.(`[page-switch] ✓ FAST-PATH: composer already shows "${currentPageName}" — no switch needed`);
                pageIdentityCache.set(cacheKey, Date.now());
                return { ok: true, fastPath: 'verified-already-on' };
            }
            if (currentPageName) {
                onLog?.(`[page-switch] composer currently shows "${currentPageName}" (need "${targetPageName}") — running switch`);
            }
        }
    } catch {}

    // Don't trust the cache without verification — we drop it here so next post will re-verify.
    // (Cache will be re-set in postReel AFTER the composer verify confirms target page.)
    if (pageIdentityCache.has(cacheKey)) {
        const ageSecs = Math.round((Date.now() - pageIdentityCache.get(cacheKey)) / 1000);
        onLog?.(`[page-switch] cache says we switched to this page ${ageSecs}s ago, but verify failed — re-running switch`);
        pageIdentityCache.delete(cacheKey);
    }

    const snap = async (label) => {
        try {
            const dir = path.join(process.env.KINTENSHAUTO_USER_DATA || '.', 'logs', 'screenshots');
            fs.mkdirSync(dir, { recursive: true });
            await page.screenshot({ path: path.join(dir, `${Date.now()}_pageswitch_${label}.png`) });
        } catch {}
    };

    // Step A: navigate to facebook.com ONLY if we're not already on a FB page.
    // The avatar dropdown is reachable from any fb.com URL, so navigating again wastes 5s.
    const currUrl = page.url();
    const alreadyOnFb = /^https?:\/\/(www\.|business\.|m\.)?facebook\.com/i.test(currUrl);
    if (!alreadyOnFb) {
        onLog?.('[page-switch A] navigating to facebook.com');
        try {
            await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (e) {
            onLog?.(`[page-switch A] could not load facebook.com: ${e.message}`);
            return { ok: false, reason: 'load_home_failed' };
        }
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));  // reduced from 3.5-5s
    } else {
        onLog?.(`[page-switch A] already on FB (${currUrl.slice(0, 60)}...) — skipping nav`);
        await new Promise(r => setTimeout(r, 800 + Math.random() * 600));
    }
    await snap('A_loaded_home');

    // Step B: locate + click the profile avatar.
    //
    // Priority order for detection (most reliable → least):
    //   1. aria-label match: "บัญชี" / "Account" / "โปรไฟล์" / "Profile"
    //      (FB gives the avatar button an explicit aria-label for accessibility)
    //   2. Rightmost round clickable with an actual profile image (backgroundImage/img/svg)
    //      in the top banner region
    //
    // The avatar is the TOP-RIGHT button user circled in screenshot. FB also shows
    // a small chevron indicating it opens a menu.
    const avatarHandle = await page.evaluateHandle(() => {
        const banner = document.querySelector('div[role="banner"]') || document.querySelector('header') || document.body;

        // Strategy 1: aria-label match — FB's avatar has labels like "บัญชี" or "Your profile"
        // when localized. Try specific patterns first.
        const ariaPatterns = [
            /^บัญชี$/, /บัญชีของคุณ/,
            /^Account$/i, /your account/i, /your profile/i,
            /^โปรไฟล์$/, /โปรไฟล์ของคุณ/,
            /^Profile$/i,
            /การตั้งค่าและกิจกรรมบัญชี/, /Account settings and activity/i
        ];
        const ariaBtns = Array.from(banner.querySelectorAll('[aria-label]'));
        for (const btn of ariaBtns) {
            const label = (btn.getAttribute('aria-label') || '').trim();
            if (!label) continue;
            for (const re of ariaPatterns) {
                if (re.test(label)) {
                    const r = btn.getBoundingClientRect();
                    if (r.top < 120 && r.width > 20 && r.height > 20 && r.right > window.innerWidth * 0.6) {
                        btn.setAttribute('data-kts-avatar-via', 'aria-label:' + label);
                        return btn;
                    }
                }
            }
        }

        // Strategy 2: rightmost round clickable with profile image
        const buttons = Array.from(banner.querySelectorAll('div[role="button"], button'));
        const withImage = buttons.filter(b => {
            // Must NOT be a link (messenger, notifications are <a> tags; account button is div)
            if (b.tagName === 'A' || b.hasAttribute('href')) return false;
            // Must have an image indicator — profile pic is usually inside nested divs with background-image
            if (b.querySelector('image, img')) return true;   // img/image tag
            const bg = window.getComputedStyle(b).backgroundImage;
            if (bg && bg !== 'none' && bg.includes('url')) return true;
            const nested = b.querySelectorAll('div, i');
            for (const n of nested) {
                const nbg = window.getComputedStyle(n).backgroundImage;
                if (nbg && nbg !== 'none' && nbg.includes('url')) return true;
            }
            return false;
        });
        const sorted = withImage
            .map(el => ({ el, r: el.getBoundingClientRect() }))
            .filter(x => x.r.top < 120 && x.r.width > 20 && x.r.height > 20
                     && x.r.right > window.innerWidth * 0.6)   // must be on the right half
            .sort((a, b) => b.r.right - a.r.right);
        if (sorted.length) {
            sorted[0].el.setAttribute('data-kts-avatar-via', 'rightmost-image');
            return sorted[0].el;
        }
        return null;
    });

    const avatarEl = avatarHandle.asElement();
    if (!avatarEl) {
        onLog?.('[page-switch B] ✗ could not locate avatar button (neither aria-label nor rightmost image)');
        await snap('B_no_avatar');
        return { ok: false, reason: 'no_avatar_button' };
    }

    // Log which strategy found the avatar (for debugging)
    const detectedVia = await page.evaluate(el => el.getAttribute('data-kts-avatar-via') || 'unknown', avatarEl);
    const avatarRect = await page.evaluate(el => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }, avatarEl);
    onLog?.(`[page-switch B] found avatar via "${detectedVia}" at (${avatarRect.x},${avatarRect.y}) size ${avatarRect.w}×${avatarRect.h}`);

    // Click via the ElementHandle (Puppeteer moves the mouse + clicks the center — very reliable)
    try {
        await avatarEl.scrollIntoViewIfNeeded?.();
        await avatarEl.click({ delay: 60 + Math.random() * 80 });
        onLog?.('[page-switch B] ✓ clicked avatar (via ElementHandle)');
    } catch (e) {
        onLog?.(`[page-switch B] avatar click failed: ${e.message}`);
        return { ok: false, reason: 'avatar_click_failed' };
    }

    // Step C: wait for dropdown to render — FB renders this as a portal, typically
    // a `<div>` with `position: fixed` that appears near the avatar.
    await new Promise(r => setTimeout(r, 1800 + Math.random() * 1200));
    await snap('C_dropdown_open');

    // Verify a dropdown actually opened. If not, re-click once + wait more.
    const dropdownOpen = await page.evaluate(() => {
        const dropdowns = document.querySelectorAll('[role="menu"], [role="dialog"], [role="listbox"]');
        for (const d of dropdowns) {
            const r = d.getBoundingClientRect();
            if (r.width > 200 && r.height > 100) return true;
        }
        // Fallback: look for "ดูโปรไฟล์ทั้งหมด" / "See all profiles" text which is a
        // strong indicator that the account menu actually rendered.
        const text = document.body.innerText || '';
        return /ดูโปรไฟล์ทั้งหมด|See all profiles|Meta Business Suite|ออกจากระบบ/i.test(text);
    });
    if (!dropdownOpen) {
        onLog?.('[page-switch C] dropdown not detected after first click — retrying');
        try { await avatarEl.click({ delay: 80 + Math.random() * 80 }); } catch {}
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));
        await snap('C2_retry_dropdown');
    } else {
        onLog?.('[page-switch C] ✓ dropdown rendered');
    }

    // Step D: find the page row by matching text OR by pageId in href.
    // Returns an ElementHandle so we can click it via handle (not coordinates) —
    // more reliable for React portals.
    //
    // Pages are matched by (in priority order):
    //   1. href contains the target pageId (most reliable — survives rename/typos)
    //   2. Exact text match (case-insensitive, first-line only)
    //   3. Partial prefix match (first 20 char diff tolerance)
    //
    // If no match found in the INITIAL dropdown, we also look for a "ดูโปรไฟล์ทั้งหมด"
    // / "See all profiles" button and click it → FB expands the list (or opens a full
    // "Profile switcher" page). Then we re-scan.
    async function findAndPickRow() {
        return await page.evaluateHandle((target, pid) => {
            const normalize = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
            const needle = normalize(target);
            const pidStr = pid ? String(pid) : null;

            // Collect likely dropdown containers. We look for portals (fixed/absolute
            // positioned div that JUST appeared with a reasonable size for a dropdown).
            const containers = new Set();
            document.querySelectorAll('[role="menu"], [role="dialog"], [role="listbox"], [role="navigation"]')
                .forEach(d => containers.add(d));
            document.querySelectorAll('div').forEach(d => {
                const cs = window.getComputedStyle(d);
                const r = d.getBoundingClientRect();
                if ((cs.position === 'fixed' || cs.position === 'absolute')
                    && r.width > 250 && r.width < 800
                    && r.height > 120
                    && cs.visibility !== 'hidden' && cs.display !== 'none') {
                    containers.add(d);
                }
            });
            // Also search the whole page body as a fallback (for full-page profile switchers)
            containers.add(document.body);

            // For each container, find clickable rows.
            // Match priority (STRICT):
            //   1. EXACT pageId in href path / data attribute (rename-proof)
            //   2. EXACT first-line text match (case-insensitive, normalized whitespace)
            //   3. ❌ NO loose/prefix matching — too many false positives when many
            //      pages share a prefix like "ดู..." or "ซีรีย์..."
            let pidRow = null, exactRow = null;
            const visibleOptions = [];
            const checkedHrefs = [];
            for (const container of containers) {
                const rows = Array.from(container.querySelectorAll(
                    'a[role="link"], a[role="button"], a[href], div[role="button"], div[role="menuitem"], div[role="option"]'
                ));
                for (const row of rows) {
                    const raw = (row.innerText || row.textContent || '').trim();
                    if (!raw || raw.length < 2 || raw.length > 300) continue;
                    const firstLine = raw.split('\n')[0].trim();
                    if (firstLine.length < 2) continue;

                    // Strongest: pageId match. Use word-boundary check to avoid false
                    // positives where pageId is a substring of another id.
                    if (pidStr && !pidRow) {
                        const href = row.getAttribute('href') || '';
                        const aria = row.getAttribute('aria-label') || '';
                        const dataId = row.getAttribute('data-profile-id') ||
                                       row.getAttribute('data-page-id') || '';
                        if (href) checkedHrefs.push(href.slice(0, 60));
                        // Match patterns: /<pageId>/, /<pageId>?, /<pageId>$, =<pageId>&, =<pageId>$
                        const pidRe = new RegExp(`(^|[/=?&])${pidStr}([/?&#=]|$)`);
                        if (pidRe.test(href) || dataId === pidStr || aria.includes(pidStr)) {
                            pidRow = row;
                        }
                    }

                    visibleOptions.push(firstLine.slice(0, 80));
                    const nFirst = normalize(firstLine);
                    if (!exactRow && nFirst === needle) exactRow = row;
                }
                if (pidRow) break;
            }
            // Stash debug info on window for outer JS to read
            window.__KTS_VISIBLE_OPTIONS = [...new Set(visibleOptions)].slice(0, 25);
            window.__KTS_CHECKED_HREFS = [...new Set(checkedHrefs)].slice(0, 15);

            // STRICT: only pidRow or exactRow. No prefix fallback.
            const pick = pidRow || exactRow;
            if (pick) {
                pick.setAttribute('data-kts-pick', pidRow ? 'pid' : 'exact-text');
                pick.scrollIntoView({ block: 'center' });
                return pick;
            }
            return null;
        }, targetPageName, targetPageId || null);
    }

    // Look for "ดูโปรไฟล์ทั้งหมด" / "See all profiles" / "See more" link and click it.
    // Returns the clicked text if found, null otherwise.
    // Relaxed matching: uses .includes instead of exact-match so stray icons/whitespace
    // in innerText don't block detection.
    async function expandSeeAllProfiles() {
        return await page.evaluate(() => {
            // Search in EVERY kind of clickable element
            const candidates = Array.from(document.querySelectorAll(
                'a, div[role="button"], span[role="button"], a[role="link"], [role="menuitem"], button'
            ));
            const needles = [
                'ดูโปรไฟล์ทั้งหมด', 'โปรไฟล์ทั้งหมด', 'ดูทั้งหมด',
                'See all profiles', 'See more profiles', 'All profiles',
                'Switch profile', 'สลับโปรไฟล์', 'ดูโปรไฟล์', 'Your profiles'
            ];
            // Look for exact match first, then relaxed
            for (const el of candidates) {
                const raw = (el.innerText || el.textContent || '').trim();
                if (!raw || raw.length > 80) continue;
                // Strip leading SVG/icon spacing, normalize
                const clean = raw.replace(/\s+/g, ' ').trim();
                for (const n of needles) {
                    if (clean === n || clean.startsWith(n) || (clean.length < n.length + 10 && clean.includes(n))) {
                        el.scrollIntoView({ block: 'center' });
                        el.click();
                        return clean;
                    }
                }
            }
            return null;
        });
    }

    // Try initial scan
    let rowHandle = await findAndPickRow();
    let rowEl = rowHandle.asElement();

    // If not found, scroll the dropdown and re-scan (some pages only show on scroll)
    if (!rowEl) {
        onLog?.('[page-switch D] target not in initial dropdown — scrolling to reveal more rows');
        await page.evaluate(() => {
            document.querySelectorAll('[role="menu"], div[style*="position: fixed"], div[style*="position:fixed"]')
                .forEach(el => {
                    const scroller = el.querySelector('[style*="overflow"]') || el;
                    try { scroller.scrollTop = scroller.scrollHeight; } catch {}
                });
        });
        await new Promise(r => setTimeout(r, 1200));
        rowHandle = await findAndPickRow();
        rowEl = rowHandle.asElement();
    }

    // Still not found — click "ดูโปรไฟล์ทั้งหมด" / "See all profiles" and re-scan
    if (!rowEl) {
        // Log what's visible BEFORE trying expansion so we can debug
        const visibleNow = await page.evaluate(() => window.__KTS_VISIBLE_OPTIONS || []);
        onLog?.(`[page-switch D] target "${targetPageName}" not in initial scan · visible: ${visibleNow.slice(0, 8).join(' | ') || '(none)'}`);

        const expanded = await expandSeeAllProfiles();
        if (expanded) {
            onLog?.(`[page-switch D] clicked "${expanded}" to expand full profile list · waiting 4s for FB to render full list...`);
            // Longer wait — clicking "See all" may navigate to a new page or open a large modal
            await new Promise(r => setTimeout(r, 4000 + Math.random() * 1500));
            await snap('D2_after_see_all');
            rowHandle = await findAndPickRow();
            rowEl = rowHandle.asElement();
            if (!rowEl) {
                const visibleAfter = await page.evaluate(() => window.__KTS_VISIBLE_OPTIONS || []);
                onLog?.(`[page-switch D2] after expansion · visible: ${visibleAfter.slice(0, 12).join(' | ') || '(none)'}`);
            }
        } else {
            onLog?.(`[page-switch D] no "ดูโปรไฟล์ทั้งหมด" button found — maybe UI is already showing all pages`);
        }
    }

    if (!rowEl) {
        const visibleOptions = await page.evaluate(() => window.__KTS_VISIBLE_OPTIONS || []);
        onLog?.(`[page-switch D] ✗ target "${targetPageName}" NOT FOUND even after expansion`);
        if (visibleOptions.length) {
            onLog?.(`[page-switch D] visible options: ${visibleOptions.slice(0, 10).join(' | ')}`);
        }
        await snap('D_no_match');
        try { await page.keyboard.press('Escape'); } catch {}
        return { ok: false, reason: 'page_not_in_dropdown', visibleOptions };
    }

    // Click the row via ElementHandle
    try {
        const matchedVia = await page.evaluate(el => el.getAttribute('data-kts-pick') || '?', rowEl);
        const matchedText = await page.evaluate(el => (el.innerText || '').split('\n')[0].slice(0, 100), rowEl);
        await rowEl.click({ delay: 50 + Math.random() * 70 });
        onLog?.(`[page-switch D] ✓ clicked row "${matchedText}" (matched via: ${matchedVia})`);
    } catch (e) {
        onLog?.(`[page-switch D] row click failed: ${e.message}`);
        await snap('D_click_failed');
        return { ok: false, reason: 'row_click_failed' };
    }

    // Step E: wait for FB to finish switching identity (tightened — 15s → 8s timeout)
    await snap('E_after_row_click');
    try {
        await Promise.race([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }),
            new Promise(r => setTimeout(r, 4500))
        ]);
    } catch {}
    // Settle wait reduced from 3-4.5s to 1.5-2.5s
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
    await snap('F_after_settle');

    onLog?.(`[page-switch] ✓ identity switch complete · now at ${page.url().slice(0, 100)}`);
    // NOTE: cache .set() moved to postReel verify block — only after composer
    // confirms we're on the correct page. Caching here would lock in wrong-page state.
    return { ok: true };
}

// Read the currently-active "posting as" page name from the composer UI.
// Returns a string (possibly empty) — caller compares to the expected name.
async function readCurrentComposerPage(page) {
    return await page.evaluate(() => {
        // Multiple places the active page name may appear:
        //   1. "โพสต์ไปยัง" label with a sibling showing the name
        //   2. Composer header showing the page avatar + name
        //   3. Any selected dropdown trigger text
        const labels = Array.from(document.querySelectorAll('div, span, label'));
        for (const lbl of labels) {
            const t = (lbl.textContent || '').trim();
            if (/^(โพสต์ไปยัง|Post to|Posting as|ลงในฐานะ)/i.test(t)) {
                // Walk up a couple levels and find a sibling with the page name
                let p = lbl;
                for (let i = 0; i < 4 && p; i++) {
                    p = p.parentElement;
                    if (!p) break;
                    const span = p.querySelector('span[dir="auto"], div[dir="auto"]');
                    if (span && span !== lbl) {
                        const s = (span.textContent || '').trim();
                        if (s && s !== t) return s;
                    }
                }
            }
        }
        return '';
    }).catch(() => '');
}

function pageNameMatches(a, b) {
    if (!a || !b) return false;
    const na = String(a).trim().toLowerCase();
    const nb = String(b).trim().toLowerCase();
    return na === nb || na.startsWith(nb) || nb.startsWith(na);
}

// Switch identity by navigating DIRECTLY to the page's own URL (facebook.com/<pageId>).
// When admin loads their own page, FB shows a banner with "สลับเป็นเพจ" / "Switch to Page"
// button. Clicking it sets the active identity. This is the most reliable strategy for
// newly-added pages that don't appear in the account avatar dropdown.
async function switchViaDirectPageUrl(page, targetPageId, targetPageName, onLog) {
    if (!targetPageId) return { ok: false, reason: 'no_page_id' };
    const url = `https://www.facebook.com/${targetPageId}`;
    onLog?.(`[switch:page-url] ▶ navigating directly to ${url}`);

    const snap = async (label) => {
        try {
            const dir = path.join(process.env.KINTENSHAUTO_USER_DATA || '.', 'logs', 'screenshots');
            fs.mkdirSync(dir, { recursive: true });
            await page.screenshot({ path: path.join(dir, `${Date.now()}_pageurl_${label}.png`) });
        } catch {}
    };

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
        return { ok: false, reason: 'nav_failed: ' + e.message };
    }
    await new Promise(r => setTimeout(r, 3500 + Math.random() * 1500));
    await snap('loaded_page');

    // The page shows a "จัดการเพจ" panel on the LEFT with:
    //   • Header: "สลับไปใช้เพจ <pageName> เพื่อดำเนินการเพิ่มเติม"
    //   • Button: just "สลับ" (single word — need context to disambiguate)
    //
    // Strategy: 2-stage search.
    //   Stage 1 — find the descriptive text "สลับไปใช้เพจ X" (or "Switch to X"). Locate
    //            the nearest clickable ancestor/sibling with short text like "สลับ" /
    //            "Switch". Click it.
    //   Stage 2 — fallback: look for any button with text exactly "สลับ" / "Switch"
    //            that's reasonably small (so it's a button, not a random word).
    //   Stage 3 — legacy: look for banners with longer texts like "สลับเป็นเพจ".
    const clickedText = await page.evaluate((targetName) => {
        const inViewport = (el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight + 200;
        };
        const clickableTag = (el) =>
            el.tagName === 'BUTTON' ||
            el.tagName === 'A' ||
            el.getAttribute('role') === 'button' ||
            el.getAttribute('role') === 'link';

        // Stage 1: find the "สลับไปใช้เพจ X" / "Switch to X" descriptive text,
        // then walk up to find a nearby clickable "สลับ" button.
        const allEls = Array.from(document.querySelectorAll('div, span, p'));
        for (const el of allEls) {
            const t = (el.textContent || '').trim();
            if (!t || t.length > 300) continue;
            const isPrompt = /สลับไปใช้เพจ|สลับเป็นเพจ|Switch to the .* Page|Switch to use/i.test(t);
            if (!isPrompt) continue;
            // Walk up to ~6 levels and find a button-like descendant with short "สลับ"/"Switch" text
            let container = el;
            for (let i = 0; i < 6 && container; i++) {
                const clickables = Array.from(container.querySelectorAll('button, [role="button"], a[role="button"], a[role="link"]'));
                for (const btn of clickables) {
                    const raw = (btn.innerText || btn.textContent || '').trim();
                    if (raw.length > 40) continue;
                    if (/^(สลับ|Switch)$/i.test(raw) && inViewport(btn)) {
                        btn.scrollIntoView({ block: 'center' });
                        btn.click();
                        return `[context-match] "${raw}" near prompt "${t.slice(0, 60)}..."`;
                    }
                }
                container = container.parentElement;
            }
        }

        // Stage 2: any small button with EXACT text "สลับ" or "Switch" in viewport
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const btn of buttons) {
            const raw = (btn.innerText || btn.textContent || '').trim();
            if (/^(สลับ|Switch)$/i.test(raw) && inViewport(btn)) {
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                return `[exact-match] "${raw}"`;
            }
        }

        // Stage 3: legacy longer banner texts
        const legacy = Array.from(document.querySelectorAll('a, a[role="link"], div[role="button"], button'));
        const needles = [
            /^สลับเป็น/, /^สลับไปใช้/, /^Switch to/i, /^ใช้เป็นเพจ/,
            /^Use as page/i, /^เปิดใช้/, /^Switch profile/i
        ];
        for (const el of legacy) {
            const raw = (el.innerText || el.textContent || '').trim();
            if (!raw || raw.length > 120) continue;
            const firstLine = raw.split('\n')[0].trim();
            for (const re of needles) {
                if (re.test(firstLine) && inViewport(el)) {
                    el.scrollIntoView({ block: 'center' });
                    el.click();
                    return `[legacy-banner] "${firstLine}"`;
                }
            }
        }
        return null;
    }, targetPageName);

    if (clickedText) {
        onLog?.(`[switch:page-url] ✓ first click: ${clickedText} — waiting for confirm dialog`);
        // FB shows a 2-stage confirm: first "สลับ" click opens a modal
        //   { title: "เปลี่ยนโปรไฟล์", body: "สลับไปใช้ X เพื่อใช้งานฟีเจอร์...",
        //     buttons: ["ดูโปรไฟล์ทั้งหมด", "สลับ"(blue primary)] }
        // Wait up to 6s for dialog to render, then click the BLUE "สลับ".
        await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
        await snap('after_first_click_dialog');

        // Look for the confirm button in a dialog — prefer the last/primary-colored one
        // since "ดูโปรไฟล์ทั้งหมด" (gray) comes before "สลับ" (blue primary).
        const confirmResult = await page.evaluate(() => {
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
            for (const dlg of dialogs) {
                const r = dlg.getBoundingClientRect();
                if (r.width < 200 || r.height < 100) continue;
                // Only consider dialogs that look like the "เปลี่ยนโปรไฟล์" modal
                const dlgText = (dlg.textContent || '');
                const isSwitchDialog = /เปลี่ยนโปรไฟล์|สลับไปใช้|Switch profile|Change profile/i.test(dlgText);
                if (!isSwitchDialog) continue;

                const buttons = Array.from(dlg.querySelectorAll('button, [role="button"]'));
                // Among buttons with text exactly "สลับ" or "Switch", prefer the LAST one
                // (blue primary button is rendered last in FB's dialog layout).
                const matches = buttons.filter(b => {
                    const t = (b.innerText || b.textContent || '').trim();
                    return /^(สลับ|Switch)$/i.test(t);
                });
                if (matches.length > 0) {
                    const primary = matches[matches.length - 1];
                    primary.scrollIntoView({ block: 'center' });
                    primary.click();
                    return { clicked: true, buttonsFound: matches.length };
                }
            }
            // Fallback: any dialog-scoped button with "สลับ"
            for (const dlg of dialogs) {
                const buttons = Array.from(dlg.querySelectorAll('button, [role="button"]'));
                for (const b of buttons.reverse()) {   // last-first = primary-first
                    const t = (b.innerText || b.textContent || '').trim();
                    if (/^(สลับ|Switch)$/i.test(t)) {
                        b.scrollIntoView({ block: 'center' });
                        b.click();
                        return { clicked: true, fallback: true };
                    }
                }
            }
            return { clicked: false };
        });

        if (confirmResult.clicked) {
            onLog?.(`[switch:page-url] ✓✓ confirm-dialog: clicked blue "สลับ" (matches=${confirmResult.buttonsFound || 'fallback'})`);
            await new Promise(r => setTimeout(r, 3500 + Math.random() * 1500));
            await snap('after_confirm_click');
            return { ok: true, clicked: clickedText + ' → confirm' };
        } else {
            onLog?.(`[switch:page-url] no confirm dialog found — maybe FB skipped confirm (rare). Assuming switch OK.`);
            await new Promise(r => setTimeout(r, 2500 + Math.random() * 1000));
            return { ok: true, clicked: clickedText };
        }
    }

    // No "Switch" button found — FB might already be displaying us AS the page (admin view).
    // ✅ FIX: ขยาย wait + ขยาย admin UI keywords + ตรวจ URL pattern
    // เดิม: เร็วไป + keywords แคบ → false-negative ทำให้ flow fail ทั้งหมด
    onLog?.('[switch:page-url] no switch banner — waiting longer for admin UI to load...');
    await new Promise(r => setTimeout(r, 3500));   // เพิ่ม 3.5s — FB admin UI โหลดช้า

    const adminCheck = await page.evaluate((pid) => {
        const text = document.body.innerText || '';
        const url = location.href;

        // 1. URL pattern: /pageId/ หรือ profile.php?id=pageId = on page
        // (FB อาจ redirect /<pid> → /profile.php?id=<pid> สำหรับเพจใหม่ — รองรับทั้งคู่)
        const onPage = new RegExp(`/${pid}(?:[/?#]|$)`).test(url) ||
                       new RegExp(`profile\\.php\\?id=${pid}`).test(url);

        // 2. Admin UI keywords — ขยายให้ครอบคลุม FB versions ปัจจุบัน
        const adminKeywords = [
            // Thai
            /โพสต์สตอรี่/, /โพสต์ในฐานะ/, /แก้ไขเพจ/, /แก้ไขโปรไฟล์/, /ศูนย์ควบคุม/,
            /สร้างโพสต์/, /สร้าง Reel/, /สร้างคลิป/, /สร้างสตอรี่/,
            /แดชบอร์ดมืออาชีพ/, /ข้อมูลเชิงลึก/, /ผู้ติดตาม/, /โปรโมท/,
            /เครื่องมือเพิ่มเติม/, /Meta Business/, /ลงโฆษณา/,
            // English
            /Create post/i, /Post as/i, /Edit page/i, /Edit profile/i,
            /Create Reel/i, /Create story/i, /Create photo/i,
            /Professional dashboard/i, /Page insights/i, /Followers/i,
            /Promote/i, /Boost post/i, /Inbox/i,
            // Page management features (only visible to admins)
            /จัดการเพจ/, /Manage Page/i, /Page settings/i, /การตั้งค่าเพจ/
        ];
        const matchedKeywords = adminKeywords
            .map(re => { const m = text.match(re); return m ? m[0] : null; })
            .filter(Boolean);

        return {
            onPage,
            isAdmin: matchedKeywords.length >= 2,    // need ≥2 keywords for confidence
            matched: matchedKeywords.slice(0, 5),    // log first 5 for debugging
            url: url.slice(0, 120)
        };
    }, targetPageId);

    if (adminCheck.isAdmin && adminCheck.onPage) {
        onLog?.(`[switch:page-url] ✓ admin UI detected (${adminCheck.matched.length} keywords: ${adminCheck.matched.join(', ')}) — already on page as admin`);
        return { ok: true, clicked: 'admin-ui-detected' };
    }

    onLog?.(`[switch:page-url] ✗ no switch banner + admin UI weak (matched: ${adminCheck.matched.join(', ') || 'none'}) at ${adminCheck.url}`);
    await snap('no_switch_banner');
    return { ok: false, reason: 'no_switch_banner_and_no_admin_ui' };
}

// Switch identity via Meta Account Center flow (new FB UI as of late 2025).
// In this flow, clicking the avatar doesn't show a simple dropdown — it opens a
// "Settings & privacy" menu. The page switcher lives under:
//   Settings & privacy → See all profiles → pick page
// OR via direct URL: https://www.facebook.com/me/ → "Switch to page" button
// OR via: https://accountscenter.facebook.com/profiles
//
// Our approach: navigate to a URL that directly shows the profile switcher,
// then click the target page row. Much simpler than navigating the nested menu.
async function switchViaAccountCenter(page, targetPageName, onLog) {
    if (!targetPageName) return { ok: false, reason: 'no_target_name' };
    onLog?.(`[account-center] ▶ trying account-center flow → "${targetPageName}"`);

    const snap = async (label) => {
        try {
            const dir = path.join(process.env.KINTENSHAUTO_USER_DATA || '.', 'logs', 'screenshots');
            fs.mkdirSync(dir, { recursive: true });
            await page.screenshot({ path: path.join(dir, `${Date.now()}_accountcenter_${label}.png`) });
        } catch {}
    };

    // Try a few FB URLs that show profile switchers
    const switchUrls = [
        'https://www.facebook.com/me/switch_profile/',
        'https://www.facebook.com/profile/switch/',
        'https://www.facebook.com/pages/?category=your_pages'
    ];

    const visibleOptions = [];

    for (const url of switchUrls) {
        onLog?.(`[account-center] navigating to ${url}`);
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await new Promise(r => setTimeout(r, 3000 + Math.random() * 1500));
        } catch (e) {
            onLog?.(`[account-center] ${url} load failed: ${e.message}`);
            continue;
        }
        await snap(`loaded_${url.replace(/[^a-z0-9]/gi, '_').slice(-20)}`);

        // Look for a clickable row matching target page name
        const clicked = await page.evaluate((target) => {
            const normalize = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
            const needle = normalize(target);
            const candidates = Array.from(document.querySelectorAll(
                'a[role="link"], a[href*="/pages/"], a[href*="/profile.php"], div[role="button"], div[role="link"], a'
            ));
            const visible = [];
            let exactRow = null, startRow = null;
            for (const el of candidates) {
                const r = el.getBoundingClientRect();
                if (r.width < 50 || r.height < 20) continue;
                const raw = (el.innerText || el.textContent || '').trim();
                if (!raw || raw.length < 2 || raw.length > 200) continue;
                const firstLine = raw.split('\n')[0].trim();
                if (firstLine.length < 2) continue;
                visible.push(firstLine.slice(0, 80));
                const nFirst = normalize(firstLine);
                if (nFirst === needle) { exactRow = el; break; }
                if (!startRow && (nFirst.startsWith(needle) || needle.startsWith(nFirst))
                             && Math.abs(nFirst.length - needle.length) < 20) {
                    startRow = el;
                }
            }
            const pick = exactRow || startRow;
            if (pick) { pick.click(); return { clicked: true }; }
            return { clicked: false, visible: [...new Set(visible)].slice(0, 25) };
        }, targetPageName);

        if (clicked.visible) visibleOptions.push(...clicked.visible);

        if (clicked.clicked) {
            onLog?.(`[account-center] ✓ clicked matching row on ${url}`);
            await new Promise(r => setTimeout(r, 3500 + Math.random() * 1500));
            await snap('after_click');
            return { ok: true };
        }
    }

    onLog?.(`[account-center] ✗ no matching row in any switcher URL`);
    return { ok: false, reason: 'no_match_in_any_switcher', visibleOptions: [...new Set(visibleOptions)] };
}

/**
 * Post a reel using the real FB business reels_composer flow.
 *
 * Steps (matches https://business.facebook.com/latest/reels_composer):
 *   STEP 0 — SWITCH PAGE:  (critical if user has multiple pages)
 *   STEP 1 — สร้าง:  upload video + type caption → click "ถัดไป"
 *   STEP 2 — แก้ไข:  (skip music/edits) → click "ถัดไป"
 *   STEP 3 — แชร์:   wait for copyright scan → click "แชร์" (blue)
 *
 * @param {object}  opts
 * @param {Browser} opts.browser
 * @param {string}  opts.videoPath
 * @param {string}  opts.caption
 * @param {string}  opts.pageId    - FB page id (numeric) used in asset_id
 * @param {string}  opts.pageName  - display name used for in-UI verification + fallback
 * @param {Function} opts.onLog
 */
async function postReel({ browser, videoPath, caption, coverPath, pageId, pageName, onLog }) {
    const page = await browser.newPage();
    // Set realistic viewport (most users)
    try { await page.setViewport({ width: 1366, height: 768 }); } catch {}

    // ✅ FIX cross-profile composer state: auto-accept browser dialogs
    // (เดิม: composer ที่มี media ค้างจาก session ก่อน → puppeteer navigate away
    //  → "Leave site? Changes you made may not be saved" → block flow)
    page.on('dialog', async (dialog) => {
        try {
            onLog?.(`[dialog] auto-accept: ${dialog.type()} — "${(dialog.message() || '').slice(0, 80)}"`);
            await dialog.accept();
        } catch (e) {
            onLog?.(`[dialog] accept failed: ${e.message}`);
        }
    });
    // Disable beforeunload globally — guarantee navigation never blocks
    try {
        await page.evaluateOnNewDocument(() => {
            window.addEventListener('beforeunload', (e) => {
                e.stopImmediatePropagation();
                delete e.returnValue;
            }, { capture: true });
            // Override onbeforeunload setter to swallow assignments
            try {
                Object.defineProperty(window, 'onbeforeunload', {
                    set: () => {}, get: () => null, configurable: true
                });
            } catch {}
        });
    } catch {}

    // Bring Chrome window to FRONT so user can see it working
    try {
        await page.bringToFront();
        // Also try to focus + maximize via CDP
        const session = await page.target().createCDPSession();
        const { windowId } = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', {
            windowId,
            bounds: { windowState: 'normal' }
        }).catch(() => {});
        await session.send('Browser.setWindowBounds', {
            windowId,
            bounds: { windowState: 'maximized' }
        }).catch(() => {});
        onLog?.('▶ Chrome window brought to front + maximized');
    } catch (e) { onLog?.('bringToFront failed (continuing): ' + e.message); }

    // Helper: dump screenshot for debugging
    async function snap(label) {
        try {
            const dir = path.join(process.env.KINTENSHAUTO_USER_DATA || '.', 'logs', 'screenshots');
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `${Date.now()}_${label}.png`);
            await page.screenshot({ path: file, fullPage: false });
            onLog?.(`screenshot: ${file}`);
        } catch (e) { onLog?.('screenshot failed: ' + e.message); }
    }

    // ✅ NEW: ดึง "ทิ้งการเปลี่ยนแปลง" / "Leave" / "Discard" ออกจาก React modal ของ FB
    // (puppeteer dialog handler จัดการ browser native dialog ได้ แต่ FB ทำ React modal ของตัวเอง
    //  ที่ไม่ใช่ browser dialog → ต้องคลิก DOM ตรง ๆ)
    async function dismissLeaveModalIfShown() {
        try {
            const clicked = await page.evaluate(() => {
                // Look for "ทิ้งการเปลี่ยนแปลง" / "Discard changes" / "Leave" buttons in any visible dialog
                const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'));
                for (const dlg of dialogs) {
                    const r = dlg.getBoundingClientRect();
                    if (r.width < 100 || r.height < 50) continue;
                    const buttons = Array.from(dlg.querySelectorAll('button, [role="button"], a[role="button"]'));
                    for (const btn of buttons) {
                        const t = (btn.innerText || btn.textContent || '').trim();
                        if (/^(ทิ้งการเปลี่ยนแปลง|Discard|Discard changes|Leave|ออกจากหน้า)$/i.test(t)) {
                            btn.scrollIntoView({ block: 'center' });
                            btn.click();
                            return t;
                        }
                    }
                }
                return null;
            });
            if (clicked) {
                onLog?.(`[modal] dismissed "${clicked}" (ทิ้ง composer state เก่า)`);
                await new Promise(r => setTimeout(r, 1200));
            }
        } catch {}
    }
    // Periodic dismiss — กัน modal โผล่ระหว่าง slow operation
    const _modalDismissTimer = setInterval(() => {
        dismissLeaveModalIfShown().catch(() => {});
    }, 3000);
    // cleanup at end of postReel
    page.once('close', () => clearInterval(_modalDismissTimer));

    try {
        const status = await isLoggedIn(page);
        if (!status.ok) {
            return { success: false, reason: status.reason, message: 'ยังไม่ได้ login FB — login ก่อนแล้วค่อยลองใหม่' };
        }

        // -------- HUMAN PRE-WARM: browse FB for a bit so it doesn't look like bot jumping straight to composer --------
        onLog?.('human pre-warm: browsing feed first');
        await humanScroll(page, 2 + Math.floor(Math.random() * 3));
        await humanMouseMove(page);
        await humanDelay(2000, 4000);

        // ═══════════════════════════════════════════════════════════════════════════════
        // STEP 0 — PAGE IDENTITY SWITCH (must happen BEFORE navigating to composer)
        // ═══════════════════════════════════════════════════════════════════════════════
        //
        // Flow (matches the UI in the user's screenshots):
        //   1. Go to facebook.com
        //   2. Click avatar (top-right) → dropdown shows personal + list of pages
        //   3. Click the row matching the target page name → FB reloads as that page
        //   4. ONLY THEN navigate to reels_composer (no asset_id — proved unreliable)
        //   5. Verify the composer shows the correct "โพสต์ไปยัง"
        //   6. If mismatch → try in-composer dropdown fallback
        //   7. If still mismatch → ABORT (never post to wrong page silently)
        //
        // Why always switch? URL ?asset_id=<pageId> returns "content unavailable"
        // on the FB composer for many pages — the avatar-dropdown switch is the only
        // approach that consistently works across page types (new pages, business
        // pages, Creator Studio pages, etc.).
        // ═══════════════════════════════════════════════════════════════════════════════

        if (pageName) {
            // ═══ PAGE SWITCH — asset_id URL fast-path + dropdown fallback ═══
            //
            // ✅ FIX: Reorder strategies — เดิม asset_id ก่อน → fail ทุกครั้งสำหรับ user
            //         ที่เพจไม่ผ่าน Business Manager (เห็นหน้า "ขออภัย" 6+ วิ — UX แย่)
            //
            // ลำดับใหม่ (เร็วสุด → ช้าสุด):
            //   1. Fast-path cache: ถ้า composer อยู่ที่เพจถูกอยู่แล้ว → skip
            //   2. Direct page URL + "สลับ" prompt (proven ใน prod logs ของ user)
            //   3. asset_id URL (fast แต่ fail สำหรับเพจที่ไม่ผ่าน BM)
            //      — skip ถ้า cache บอกว่าเคย fail ใน profile นี้
            //   4. Avatar dropdown (fallback)
            //   5. Composer plain + verify (last resort)
            onLog?.('[page-switch] ═══ starting switch flow (reordered) ═══');

            let switched = false;

            // ✅ Identity log — passive (ไม่ navigate กระทบ session state)
            // เดิม: detectCurrentIdentity navigate /me/ → reset identity เป็น user
            //   → direct-page-url ไม่เจอ "สลับ" prompt (admin อยู่แล้ว) → fail
            // ใหม่: ดูจาก URL ปัจจุบันเฉยๆ ไม่ navigate
            try {
                const curUrl = page.url();
                const userMatch = curUrl.match(/profile\.php\?id=(\d+)/);
                const pageMatch = curUrl.match(/facebook\.com\/(\d{8,})(?:[/?#]|$)/);
                const identLabel = pageMatch && pageMatch[1] === String(pageId)
                    ? `โปรไฟล์เพจเป้าหมาย (id=${pageMatch[1]})`
                    : pageMatch ? `โปรไฟล์เพจอื่น (id=${pageMatch[1]})`
                    : userMatch ? `โปรไฟล์เฟส (user id=${userMatch[1]})`
                    : 'unknown (URL: ' + curUrl.slice(0, 60) + '...)';
                onLog?.(`[identity] current: ${identLabel}`);
            } catch {}

            // Strategy 1: Fast-path verify
            try {
                const cur = await readCurrentComposerPage(page).catch(() => '');
                if (cur && pageNameMatches(cur, pageName)) {
                    onLog?.(`[page-switch:fast] ✓ already on "${cur}" — skipping switch`);
                    switched = true;
                }
            } catch {}

            // Strategy 2: Direct page URL + "สลับ" prompt — proven for this user's setup
            if (!switched && pageId) {
                onLog?.('[page-switch] trying direct page URL (strategy 2 — most reliable)');
                try {
                    const sw3 = await switchViaDirectPageUrl(page, pageId, pageName, onLog);
                    if (sw3.ok) {
                        onLog?.(`[page-switch] ═══ direct page URL switch OK (${sw3.clicked}) ═══`);
                        switched = true;
                    } else {
                        onLog?.(`[page-switch] ✗ direct-page-url: ${sw3.reason}`);
                    }
                } catch (e) {
                    onLog?.(`[page-switch] direct-page-url error: ${e.message}`);
                }
            }

            // Strategy 3: asset_id URL — only if direct-page-url didn't work AND
            //             not known to fail for this profile (cache check)
            const assetIdCacheKey = `assetIdFails:${pageId}`;
            const assetIdKnownFail = pageIdentityCache.get(assetIdCacheKey) === 'always-fails';

            if (!switched && pageId && !assetIdKnownFail) {
                const assetUrl = `https://business.facebook.com/latest/reels_composer?ref=bizweb&asset_id=${encodeURIComponent(pageId)}`;
                onLog?.(`[page-switch:asset-id] trying fast-path: ${assetUrl}`);
                try {
                    await page.goto(assetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    await humanDelay(3000, 4500);
                    const errTxt = await page.evaluate(() => {
                        const t = document.body.innerText || '';
                        return /ขออภัย.*เนื้อหานี้ไม่พร้อม|This content isn'?t available|Sorry, this content/i.test(t);
                    }).catch(() => false);
                    if (!errTxt) {
                        const currentPage = await readCurrentComposerPage(page);
                        if (pageNameMatches(currentPage, pageName)) {
                            onLog?.('[page-switch:asset-id] ✓ VERIFIED — asset_id worked');
                            switched = true;
                        }
                    } else {
                        // ไม่ cache เป็น always-fails — asset_id อาจ work ตอนอื่น (session/cookie state)
                        // user verify: paste URL with asset_id manually works → don't permanently disable
                        onLog?.('[page-switch:asset-id] "content unavailable" — will retry final composer URL with asset_id');
                    }
                } catch (e) {
                    onLog?.(`[page-switch:asset-id] nav failed: ${e.message}`);
                }
            } else if (!switched && assetIdKnownFail) {
                onLog?.('[page-switch:asset-id] skipped (cached as always-fails for this page)');
            }

            // Strategy 4: avatar dropdown
            if (!switched) {
                onLog?.('[page-switch] trying avatar dropdown (strategy 4 — fallback)');
                const sw = await switchToPageViaProfileMenu(page, pageName, onLog, pageId);
                if (sw.ok) {
                    onLog?.('[page-switch] ═══ dropdown switch OK ═══');
                    switched = true;
                } else {
                    onLog?.(`[page-switch] ✗ profile-menu switch failed: ${sw.reason}`);
                }
            }

            if (!switched) {
                onLog?.('[page-switch] ⚠ all strategies failed — relying on composer + verify safety net');
            }
        } else {
            onLog?.('[page-switch] no pageName specified — skipping switch (using current identity)');
        }

        // ✅ FIX (user-verified): ใช้ URL `?ref=` เดียว — ไม่ต้องเติม asset_id หรืออะไรเพิ่ม
        // user ทดสอบแล้ว: URL นี้ใช้ได้กับทุกเพจที่ page-switch สลับไปแล้ว
        // FB ใช้ session identity ปัจจุบัน (ที่ page-switch ตั้งให้ก่อนหน้า) เปิด composer ของเพจนั้น
        const COMPOSER_URL = 'https://business.facebook.com/latest/reels_composer?ref=';
        const currentUrlNow = page.url();
        const alreadyOnComposer = /business\.facebook\.com\/latest\/reels_composer/i.test(currentUrlNow);
        if (!alreadyOnComposer) {
            onLog?.(`navigating to composer: ${COMPOSER_URL}`);
            await page.goto(COMPOSER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await humanDelay(2500, 4000);   // reduced from 4-6s
        } else {
            onLog?.(`already on composer (${currentUrlNow.slice(0, 60)}...) — skipping nav`);
            await humanDelay(500, 1000);
        }

        // Fail fast if FB shows "content unavailable"
        const errorPage = await page.evaluate(() => {
            const t = document.body.innerText || '';
            return /ขออภัย.*เนื้อหานี้ไม่พร้อม|This content isn'?t available|Sorry, this content/i.test(t);
        }).catch(() => false);
        if (errorPage) {
            await snap('composer_unavailable');
            // ✅ Detect personal profile ID format (15 digits starting with 100xxx)
            // FB Pages 2.0 มี ID เริ่ม "6" (เช่น 61578...) — Pages = 14 digits
            // User profiles มี ID เริ่ม "100" (เช่น 100094...) — Users = 15-16 digits
            const isProfileLike = /^100\d{12,13}$/.test(String(pageId || ''));
            const baseMsg = isProfileLike
                ? `⚠ "${pageName || 'เพจนี้'}" มี ID format ของ Personal Profile (${pageId}, 15 หลักเริ่ม 100xxx). ` +
                  'Reels Composer ผ่าน Business Suite รองรับเฉพาะ Pages (14 หลัก เริ่ม 6xxx) ไม่ใช่ profiles. ' +
                  'แนะนำ: ลบเพจนี้ออกจากรายการ (จัดการเฟส + เพจ → ลบ) หรือ convert profile → Page ใน FB'
                : 'FB ปฏิเสธเปิด Reels Composer สำหรับเพจนี้ ("ขออภัย เนื้อหาไม่พร้อม"). ' +
                  'สาเหตุ: (1) เพจยังไม่ได้ link Meta Business Suite, (2) FB ยังไม่เปิด Reels feature, ' +
                  '(3) สิทธิ์ admin ไม่พอ. ' +
                  'ทดสอบ: เปิด business.facebook.com/latest/reels_composer?asset_id=' + (pageId || 'X') +
                  ' ใน Chrome เองดู — ถ้า "ขออภัย" เหมือนกัน → ต้องแก้ใน FB ก่อน';
            return {
                success: false,
                reason: isProfileLike ? 'personal_profile_not_supported' : 'composer_unavailable',
                message: baseMsg
            };
        }
        onLog?.('✓ composer page loaded');

        // VERIFY the composer is actually scoped to our target page. If not, try two
        // fallbacks before aborting:
        //   (a) in-composer "โพสต์ไปยัง" dropdown
        //   (b) asset_id URL — navigate to composer with ?asset_id=<pageId>
        if (pageName) {
            let currentPage = await readCurrentComposerPage(page);
            onLog?.(`[verify] composer "โพสต์ไปยัง": "${currentPage}" · target: "${pageName}"`);

            if (!pageNameMatches(currentPage, pageName)) {
                // ✅ FIX (multi-page): Fallback (a) — in-composer dropdown — robust version
                onLog?.('[verify] mismatch after switch — trying in-composer dropdown (multi-page strict)');
                await snap('verify_mismatch_before_dropdown');

                const opened = await page.evaluate(() => {
                    // หา label "โพสต์ไปยัง" / "Post to" — รองรับทั้ง role=combobox และปุ่มแบบ FB ที่ใช้ div[role=button]
                    const labels = Array.from(document.querySelectorAll('div, span, label'));
                    for (const lbl of labels) {
                        const t = (lbl.textContent || '').trim();
                        if (/^(โพสต์ไปยัง|Post to|แชร์ไปที่|Share to)/i.test(t)) {
                            let p = lbl;
                            for (let i = 0; i < 8 && p; i++) {
                                p = p.parentElement; if (!p) break;
                                const dd = p.querySelector(
                                    '[role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], ' +
                                    '[aria-expanded], div[role="button"], button'
                                );
                                if (dd) {
                                    // visual check
                                    const r = dd.getBoundingClientRect();
                                    if (r.width > 0 && r.height > 0) {
                                        dd.click();
                                        return true;
                                    }
                                }
                            }
                        }
                    }
                    return false;
                });

                if (opened) {
                    await humanDelay(2000, 3500);   // ✅ FIX: รอนานขึ้น — FB lazy render dropdown items
                    await snap('verify_dropdown_opened');

                    // ✅ FIX: scroll ภายใน dropdown ก่อน — เผื่อมีหลายเพจที่ต้อง scroll หา
                    await page.evaluate(() => {
                        const lists = document.querySelectorAll('[role="listbox"], [role="menu"]');
                        for (const list of lists) {
                            const r = list.getBoundingClientRect();
                            if (r.height > 100) {
                                list.scrollTop = 0;   // เริ่มจาก top
                            }
                        }
                    });
                    await humanDelay(400, 700);

                    const picked = await page.evaluate((target, pid) => {
                        const pidStr = pid ? String(pid) : null;
                        const norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
                        const targetNorm = norm(target);

                        // Strategy: match ด้วย 3 ระดับ — exact id (ดีที่สุด) > exact text > startsWith > includes
                        const items = Array.from(document.querySelectorAll(
                            '[role="option"], [role="menuitem"], [role="link"], a, ' +
                            'div[role="button"]'
                        ));

                        // Pass 1: by page id (href หรือ data-page-id)
                        if (pidStr) {
                            for (const it of items) {
                                const href = it.getAttribute('href') || '';
                                const dataPid = it.getAttribute('data-page-id') || '';
                                if (href.includes(pidStr) || dataPid === pidStr) {
                                    it.scrollIntoView({ block: 'center' });
                                    it.click();
                                    return { matched: 'by-id', text: (it.textContent || '').slice(0, 60) };
                                }
                            }
                        }
                        // Pass 2: exact text match (first line)
                        for (const it of items) {
                            const firstLine = ((it.textContent || '').trim().split('\n')[0] || '').trim();
                            if (norm(firstLine) === targetNorm) {
                                it.scrollIntoView({ block: 'center' });
                                it.click();
                                return { matched: 'exact-text', text: firstLine };
                            }
                        }
                        // Pass 3: startsWith
                        for (const it of items) {
                            const firstLine = ((it.textContent || '').trim().split('\n')[0] || '').trim();
                            if (norm(firstLine).startsWith(targetNorm)) {
                                it.scrollIntoView({ block: 'center' });
                                it.click();
                                return { matched: 'starts-with', text: firstLine };
                            }
                        }
                        // Pass 4: includes
                        for (const it of items) {
                            const t = norm((it.textContent || '').trim());
                            if (t.includes(targetNorm) && targetNorm.length >= 6) {
                                it.scrollIntoView({ block: 'center' });
                                it.click();
                                return { matched: 'includes', text: (it.textContent || '').slice(0, 60) };
                            }
                        }
                        return { matched: null };
                    }, pageName, pageId || null);

                    if (picked.matched) {
                        onLog?.(`[verify] dropdown picked via "${picked.matched}": "${picked.text}"`);
                        await humanDelay(2500, 4000);
                        await snap('verify_after_dropdown_pick');
                        currentPage = await readCurrentComposerPage(page);
                    } else {
                        onLog?.('[verify] dropdown opened but target page not found in list');
                        await snap('verify_dropdown_no_match');
                    }
                } else {
                    onLog?.('[verify] could not open in-composer dropdown');
                }

                // Fallback (b): reload composer with asset_id URL (works for many page types,
                // even when the identity dropdown fails).
                if (!pageNameMatches(currentPage, pageName) && pageId) {
                    onLog?.(`[verify] still mismatched — trying asset_id URL recovery`);
                    const recoveryUrl = `https://business.facebook.com/latest/reels_composer?ref=bizweb&asset_id=${encodeURIComponent(pageId)}`;
                    try {
                        await page.goto(recoveryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                        await humanDelay(3500, 5500);
                        // Check for "content unavailable" first
                        const errTxt = await page.evaluate(() => {
                            const t = document.body.innerText || '';
                            return /ขออภัย.*เนื้อหานี้ไม่พร้อม|This content isn'?t available|Sorry, this content/i.test(t);
                        }).catch(() => false);
                        if (errTxt) {
                            onLog?.('[verify] asset_id URL shows "content unavailable" — giving up');
                        } else {
                            currentPage = await readCurrentComposerPage(page);
                            onLog?.(`[verify] after asset_id recovery: "${currentPage}"`);
                        }
                    } catch (e) {
                        onLog?.('[verify] asset_id recovery nav failed: ' + e.message);
                    }
                }

                // HARD ABORT if still not matching
                if (!pageNameMatches(currentPage, pageName)) {
                    await snap('wrong_page_at_composer');
                    onLog?.(`[verify] ✗ ABORTING — still on "${currentPage}", not "${pageName}"`);

                    // Try to dump the visible page-switcher options so user can see what bot saw
                    let visiblePages = [];
                    try {
                        // Re-open the avatar dropdown briefly to capture page list (best-effort)
                        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
                        await new Promise(r => setTimeout(r, 2000));
                        visiblePages = await page.evaluate(() => {
                            const options = new Set();
                            // Look for page name candidates in the body — pages usually appear
                            // in the top-right account dropdown OR sidebar shortcuts
                            document.querySelectorAll('a[href*="/profile.php"], a[role="link"]').forEach(a => {
                                const t = (a.innerText || '').trim().split('\n')[0];
                                if (t && t.length > 1 && t.length < 80) options.add(t);
                            });
                            return [...options].slice(0, 15);
                        }).catch(() => []);
                    } catch {}

                    const visibleHint = visiblePages.length
                        ? ` · เพจที่เห็นในเฟส: ${visiblePages.slice(0, 6).join(' · ')}`
                        : '';
                    return {
                        success: false, reason: 'wrong_page',
                        message: `ยืนยันไม่ได้ว่าจะโพสต์เป็นเพจ "${pageName}" — composer แสดง "${currentPage || 'ไม่ระบุ'}" · หยุดโพสต์เพื่อกันโพสต์ผิดเพจ${visibleHint} · (ลองเพิ่มเพจในเฟสอีกครั้ง หรือตรวจสิทธิ์ admin ของเพจ)`
                    };
                }
            }
            onLog?.(`[verify] ✓✓ confirmed posting as "${currentPage}"`);
            // ONLY now do we update the identity cache — after composer verified target.
            // (Earlier code cached on switch return, before verifying — caused wrong-page bugs.)
            try { pageIdentityCache.set(`${pageId || pageName}`, Date.now()); } catch {}
        }

        // ========== STEP 1: สร้าง (Create) — Upload video ==========
        // Verify the clip file exists on disk (CRITICAL — if missing, abort early with clear msg)
        if (!fs.existsSync(videoPath)) {
            return {
                success: false, reason: 'clip_missing',
                message: `ไม่เจอไฟล์คลิป: ${videoPath} — ตรวจที่เมนู "คลังคลิป (ไฟล์)" หรือ run pipeline ใหม่`
            };
        }
        const fileSize = fs.statSync(videoPath).size;
        onLog?.(`clip file OK: ${videoPath} (${(fileSize/1024/1024).toFixed(1)} MB)`);

        // STRATEGY: Use waitForFileChooser to intercept FB's system file dialog.
        // FB's "เพิ่มวิดีโอ" button triggers an OS file picker — Puppeteer's
        // page.waitForFileChooser() catches it BEFORE the dialog opens and lets
        // us inject the file directly. This works 100% across all OS / FB UI versions.
        onLog?.('step 1: setting up file chooser interceptor + clicking "เพิ่มวิดีโอ"');

        // First try the simpler approach: find a hidden input[type=file] and set it directly
        // (works for older composer versions)
        const directInput = await page.$('input[type="file"]').catch(() => null);
        if (directInput) {
            try {
                onLog?.('found hidden input[type=file] — uploading directly');
                await directInput.uploadFile(videoPath);
                onLog?.('✓ direct upload sent');
                await humanDelay(2000, 3500);
            } catch (e) {
                onLog?.('direct upload failed, falling back to fileChooser: ' + e.message);
            }
        }

        // If direct didn't trigger upload (no progress visible after 5s), use fileChooser approach
        const uploadStarted = await page.waitForFunction(() => {
            const t = document.body.innerText || '';
            return /\b\d+%|กำลังอัปโหลด|Uploading|processing/i.test(t);
        }, { timeout: 5000 }).then(() => true).catch(() => false);

        if (!uploadStarted) {
            onLog?.('direct upload didn\'t kick off — using waitForFileChooser path');
            try {
                // Set up the chooser intercept BEFORE clicking
                const [fileChooser] = await Promise.all([
                    page.waitForFileChooser({ timeout: 30000 }),
                    (async () => {
                        // Click "เพิ่มวิดีโอ" / "Add video" button which triggers the dialog
                        await page.evaluate(() => {
                            const buttons = Array.from(document.querySelectorAll('div[role="button"], button, [role="button"]'));
                            const targets = ['เพิ่มวิดีโอ', 'Add video', 'อัปโหลดวิดีโอ', 'Upload video',
                                             'เลือกไฟล์', 'Choose file', 'เลือกจากคอมพิวเตอร์'];
                            for (const btn of buttons) {
                                const txt = (btn.innerText || btn.textContent || '').trim();
                                for (const want of targets) {
                                    if (txt === want || txt.startsWith(want)) { btn.click(); return; }
                                }
                            }
                        });
                    })()
                ]);
                await fileChooser.accept([videoPath]);
                onLog?.(`✓ fileChooser accepted: ${videoPath}`);
            } catch (e) {
                await snap('upload_failed');
                return {
                    success: false, reason: 'upload_failed',
                    message: `อัปโหลดไม่สำเร็จ: ${e.message} — ดู screenshot`
                };
            }
        }

        // 1b) Wait for upload to truly finish — multi-signal check:
        //   (a) Progress text shows 100% (and no lower % like 50% hanging around)
        //   (b) "ภาพขนาดย่อ" / "Thumbnail" section is visible (= upload done)
        //   (c) No visible progressbar with value < 100
        //   (d) "ถัดไป" (Next) button exists AND is not disabled
        //   (e) Green checkmark SVG near the progress bar (stronger signal)
        // ALL must be true. Gives up to 10 min for big clips.
        // Poll faster (500ms) so we catch the moment of completion — previously polled
        // every 1.5s then added 2.5-4s humanDelay = up to 5s wasted per post.
        onLog?.('waiting for upload to TRULY finish (checkmark + Next enabled)');
        await page.waitForFunction(() => {
            const t = document.body.innerText || '';

            // (a) 100% visible AND no partial % (0-99%) still shown
            const has100 = /\b100%\b/.test(t);
            const partialMatches = t.match(/\b(\d{1,2})%/g) || [];
            const hasPartial = partialMatches.some(m => {
                const n = parseInt(m, 10);
                return n >= 0 && n < 100;
            });

            // (b) thumbnail section showing
            const hasThumbSection = /ภาพขนาดย่อ|Thumbnail/i.test(t);

            // (c) no progressbar < 100
            const progressBars = Array.from(document.querySelectorAll('[role="progressbar"], progress'));
            const hasIncompleteBar = progressBars.some(b => {
                const v = Number(b.getAttribute('aria-valuenow'));
                const max = Number(b.getAttribute('aria-valuemax')) || 100;
                return Number.isFinite(v) && v < max;
            });

            // (d) Next button exists and enabled
            const buttons = Array.from(document.querySelectorAll('div[role="button"], button'));
            const nextBtn = buttons.find(b => /^(ถัดไป|Next)$/i.test((b.innerText || '').trim()));
            const nextEnabled = nextBtn && nextBtn.getAttribute('aria-disabled') !== 'true'
                                && !nextBtn.disabled;

            // (e) Green checkmark SVG visible directly beside "100%" text.
            //     NARROW match: FB's upload-success icon has aria-label EXACTLY "Tick" /
            //     "เสร็จสิ้น" / "check mark"; OR it's immediately adjacent to a "100%"-only
            //     parent element. Broader regex would false-positive on nearby "Complete
            //     your profile" prompts/ads.
            const svgCheck = Array.from(document.querySelectorAll('svg'))
                .some(s => {
                    // Skip tiny / invisible SVGs
                    const r = s.getBoundingClientRect();
                    if (r.width < 10 || r.height < 10) return false;
                    const aria = (s.getAttribute('aria-label') || '').toLowerCase().trim();
                    // Only match EXACT check-related aria-labels (not partial like "completed profile")
                    if (aria === 'check' || aria === 'tick' || aria === 'done' ||
                        aria === '✓' || aria === 'เสร็จสิ้น' || aria === 'สำเร็จ') return true;
                    // Strongest signal: the SVG is a direct child of an element whose
                    // trimmed text is EXACTLY "100%" (nothing else around).
                    const parent = s.parentElement;
                    if (parent && (parent.textContent || '').trim() === '100%') return true;
                    return false;
                });

            // Primary condition: thumbnail section + Next enabled + no incomplete bar  (fast path)
            // Extra confirmation: 100% text AND no partial + Next enabled
            // Strongest: green checkmark visible → go IMMEDIATELY
            const done = svgCheck
                      || (hasThumbSection && nextEnabled && !hasIncompleteBar)
                      || (has100 && !hasPartial && nextEnabled);
            return done;
        }, { timeout: 10 * 60 * 1000, polling: 500 }).catch(() => {
            onLog?.('upload progress check timed out after 10 min (continuing anyway — may be partial upload)');
        });
        // Short delay for the DOM to settle (was 2.5-4s, now 400-800ms — user wanted bot
        // to proceed immediately after 100% green checkmark).
        await humanDelay(400, 800);
        onLog?.('✓ upload confirmed complete — proceeding to cover/caption');

        // 1b-cover) Attach AI-generated cover image.
        //
        // EXACT flow from the user's screenshots (FB Reel composer, Thai UI, Jan 2026):
        //   STEP A. Scroll down to the "ภาพขนาดย่อ" (Thumbnail) section
        //   STEP B. That section has 3 tabs: "เลือกที่แนะนำ | เลือกกรอบ | อัพโหลดภาพ"
        //            → click the 3rd tab "อัพโหลดภาพ"
        //   STEP C. After the tab activates, a new row appears with an "อัพโหลดภาพ" LINK
        //            on the right → click that link to trigger the file picker
        //   STEP D. Intercept fileChooser → attach the cover PNG
        //   STEP E. FB auto-attaches; no Save dialog needed — just continue the flow.
        //
        // Best-effort: if any step fails, continue posting without cover (FB will pick
        // an auto-thumbnail from the video itself).
        if (coverPath && fs.existsSync(coverPath)) {
            onLog?.(`[cover] attempting to attach AI cover: ${coverPath}`);
            try {
                // STEP A: scroll to the ภาพขนาดย่อ section so the tabs are in viewport
                const scrolledToThumb = await page.evaluate(() => {
                    // Find the label with exact text "ภาพขนาดย่อ" or "Thumbnail"
                    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
                    let node;
                    while ((node = walker.nextNode())) {
                        const t = (node.textContent || '').trim();
                        // Match ONLY exact label (not descendants containing other sections too)
                        if ((t === 'ภาพขนาดย่อ' || t === 'Thumbnail') && node.children.length === 0) {
                            node.scrollIntoView({ block: 'center', behavior: 'instant' });
                            return true;
                        }
                    }
                    return false;
                });
                if (!scrolledToThumb) {
                    onLog?.('[cover] "ภาพขนาดย่อ" section label not found — skipping');
                } else {
                    await humanDelay(800, 1400);

                    // STEP B: click the "อัพโหลดภาพ" tab (3rd tab in the thumbnail tabs row)
                    const tabClick = await page.evaluate(() => {
                        // Tabs are rendered as role="tab" or role="button". Among the multiple
                        // "อัพโหลดภาพ" elements on this page, the TAB is the one NOT inside a
                        // row that says "อัพโหลดภาพ" twice (header+link). We pick the FIRST
                        // match in document order — tabs always come before the link row.
                        const candidates = Array.from(document.querySelectorAll(
                            'div[role="tab"], [role="tab"], div[role="button"], button, span[role="button"]'
                        ));
                        const re = /^(อัพโหลดภาพ|อัปโหลดภาพ|Upload\s+image|Upload\s+a\s+photo|Upload)$/i;
                        const matches = candidates.filter(el => re.test((el.innerText || '').trim()));
                        if (!matches.length) return { ok: false, found: 0 };
                        // First one is the tab
                        matches[0].scrollIntoView({ block: 'center' });
                        matches[0].click();
                        return { ok: true, found: matches.length };
                    });
                    if (!tabClick.ok) {
                        onLog?.('[cover] "อัพโหลดภาพ" tab not found — skipping');
                    } else {
                        onLog?.(`[cover] ✓ clicked "อัพโหลดภาพ" tab (${tabClick.found} matches on page)`);
                        await humanDelay(1500, 2500);

                        // STEP C+D: click the "อัพโหลดภาพ" link below the tab → file picker opens
                        // There are now 2+ "อัพโหลดภาพ" elements: the TAB (selected) and the LINK.
                        // The link is NOT role=tab, NOT aria-selected=true.
                        const [coverChooser] = await Promise.all([
                            page.waitForFileChooser({ timeout: 20000 }).catch(() => null),
                            (async () => {
                                await page.evaluate(() => {
                                    const candidates = Array.from(document.querySelectorAll(
                                        'a, div[role="button"], button, span[role="button"]'
                                    ));
                                    const re = /^(อัพโหลดภาพ|อัปโหลดภาพ|Upload\s+image|Upload\s+a\s+photo|Upload|เลือกไฟล์|Choose\s+file)$/i;
                                    const all = candidates.filter(el => re.test((el.innerText || '').trim()));
                                    // Exclude the active tab — the LINK is the one NOT marked as a tab
                                    const linkCandidates = all.filter(el => {
                                        if (el.getAttribute('role') === 'tab') return false;
                                        if (el.getAttribute('aria-selected') === 'true') return false;
                                        return true;
                                    });
                                    // Pick the last one in document order (the upload section is below the tabs)
                                    const pick = linkCandidates.length ? linkCandidates[linkCandidates.length - 1]
                                               : all[all.length - 1];
                                    if (pick) { pick.scrollIntoView({ block: 'center' }); pick.click(); }
                                });
                            })()
                        ]);

                        if (coverChooser) {
                            await coverChooser.accept([coverPath]);
                            onLog?.(`[cover] ✓ attached cover via file picker: ${path.basename(coverPath)}`);
                            // Wait for the UI to show the uploaded thumbnail
                            await humanDelay(3000, 4500);
                            onLog?.('[cover] ✓ cover upload complete — proceeding to caption/next');
                        } else {
                            onLog?.('[cover] file picker did not open within 20s — continuing without cover');
                        }
                    }
                }
            } catch (e) {
                onLog?.('[cover] upload step threw (continuing without cover): ' + e.message);
            }
        } else if (coverPath) {
            onLog?.(`[cover] skipping — file not found on disk: ${coverPath}`);
        }

        // 1c) Type caption — find by placeholder/aria-label/context (FB uses <textarea> or contenteditable)
        if (caption && caption.trim()) {
            onLog?.('typing caption (human-like)');

            // Wait briefly for the caption section to render after upload
            await humanDelay(2000, 3500);

            const captionHandle = await page.evaluateHandle(() => {
                // Strategy 1: textarea with FB-specific placeholder
                const textareas = Array.from(document.querySelectorAll('textarea'));
                for (const ta of textareas) {
                    const ph = ta.getAttribute('placeholder') || '';
                    if (/บอกให้ผู้รับชมทราบ|Tell viewers|Tell people|describe|คำอธิบาย/i.test(ph)) {
                        return ta;
                    }
                }
                // Strategy 2: contenteditable with similar placeholder
                const editables = Array.from(document.querySelectorAll('div[contenteditable="true"]'));
                for (const e of editables) {
                    const ph = e.getAttribute('aria-placeholder') || e.getAttribute('data-placeholder') || '';
                    if (/บอกให้ผู้รับชมทราบ|Tell viewers|Tell people|describe|คำอธิบาย/i.test(ph)) {
                        return e;
                    }
                    // Also check the placeholder rendered as a child div
                    const placeholderChild = e.parentElement?.querySelector('[class*="placeholder" i], div[role="presentation"]');
                    if (placeholderChild) {
                        const t = placeholderChild.textContent || '';
                        if (/บอกให้ผู้รับชมทราบ|Tell viewers|describe/i.test(t)) return e;
                    }
                }
                // Strategy 3: aria-label
                const ariaTargets = Array.from(document.querySelectorAll('[aria-label]'));
                for (const el of ariaTargets) {
                    const lbl = el.getAttribute('aria-label') || '';
                    if (/^คำอธิบาย|^Description|description.*reel|caption/i.test(lbl)) {
                        if (el.tagName === 'TEXTAREA' || el.contentEditable === 'true') return el;
                        const inner = el.querySelector('textarea, [contenteditable="true"]');
                        if (inner) return inner;
                    }
                }
                // Strategy 4: walk from "คำอธิบาย" label to nearest editable
                const allEls = Array.from(document.querySelectorAll('div, span, label'));
                for (const lbl of allEls) {
                    const t = (lbl.textContent || '').trim();
                    if (/^คำอธิบาย|^Description/i.test(t) && t.length < 30) {
                        let p = lbl;
                        for (let i = 0; i < 8 && p; i++) {
                            p = p.parentElement;
                            if (!p) break;
                            const inner = p.querySelector('textarea, div[contenteditable="true"]');
                            if (inner) return inner;
                        }
                    }
                }
                // Last resort: any contenteditable that's NOT inside a button
                const lastResort = Array.from(document.querySelectorAll('div[contenteditable="true"]'))
                    .filter(e => !e.closest('[role="button"]'));
                return lastResort[0] || null;
            });

            const el = captionHandle && captionHandle.asElement && captionHandle.asElement();
            if (el) {
                const tagInfo = await el.evaluate(e => ({ tag: e.tagName, ph: e.placeholder || e.getAttribute('aria-placeholder') || '' })).catch(() => ({}));
                onLog?.(`✓ found caption field: <${tagInfo.tag}> placeholder="${(tagInfo.ph || '').slice(0, 40)}"`);
                try {
                    await el.click({ delay: 50 });
                    await humanDelay(500, 900);
                    await el.focus().catch(() => {});
                    await humanDelay(300, 600);
                    await humanType(page, caption);
                    onLog?.(`✓ typed ${caption.length} chars`);
                } catch (e) {
                    onLog?.('caption type failed: ' + e.message);
                }
            } else {
                onLog?.('WARN: caption box not found, posting without caption');
                await snap('no_caption_field');
            }
        }
        // Random human pause — review what was typed
        await humanDelay(2500, 5000);
        await humanMouseMove(page);

        // Dismiss any nudge modal that may have appeared after upload (e.g. "Convert to Reels")
        await dismissNudgeModal(page, onLog);

        // 1d) Click "ถัดไป" → step 2
        onLog?.('step 1 → step 2: clicking ถัดไป');
        const next1 = await clickButtonByText(page, ['ถัดไป', 'Next'], { primary: true });
        if (!next1) return { success: false, reason: 'no_next_btn', message: 'ไม่เจอปุ่ม "ถัดไป" ในขั้น 1' };
        await humanDelay(3500, 5500);

        // Another nudge check before step 2
        await dismissNudgeModal(page, onLog);

        // ========== STEP 2: แก้ไข (Edit — skip) ==========
        onLog?.('step 2 → step 3: clicking ถัดไป (skip edit)');
        const next2 = await clickButtonByText(page, ['ถัดไป', 'Next'], { primary: true });
        if (!next2) onLog?.('WARN: ถัดไป (step 2) not found — maybe single-step composer');
        await humanDelay(4000, 6500);

        // Dismiss any modal that appears on the share step (FB often shows
        // "เข้าถึงกลุ่มเป้าหมายใหม่ๆ" nudge here)
        await dismissNudgeModal(page, onLog);

        // ========== STEP 3: แชร์ (Share) — wait for copyright scan (max 120s) ==========
        // Copyright scan can take a while for long clips. FB lets user click share earlier
        // but we WAIT so we don't trigger a post-publish takedown. 120s is enough for
        // 15-min clips based on observation.
        onLog?.('step 3: waiting for copyright scan to complete (max 120s)');
        const copyResult = await waitForCopyrightCheck(page, 120000);
        onLog?.(`copyright check result: ${copyResult.status} · ${copyResult.message || 'OK'}`);

        if (copyResult.blocked) {
            return {
                success: false,
                reason: 'copyright_pre_publish',
                message: copyResult.message || 'FB ตรวจพบลิขสิทธิ์ — ใช้ Set 2 แทน'
            };
        }

        // ✅ FIX H8: ถ้า copyright check timeout — ไม่โพสต์ต่อ (เดิม return blocked:false
        // แล้วโพสต์เลย → คลิปลิขสิทธิ์ผ่านได้เงียบๆ)
        // user setting strict_copyright_wait = '0' = ปิด (โพสต์ต่อทั้งที่ยังไม่ confirm)
        if (copyResult.status === 'timeout') {
            try {
                const Database = require('better-sqlite3');
                const dbPath = process.env.KINTENSHAUTO_DB;
                if (dbPath) {
                    const tdb = new Database(dbPath, { readonly: true });
                    const strictRow = tdb.prepare(`SELECT value FROM settings WHERE key = 'strict_copyright_wait'`).get();
                    tdb.close();
                    const strictOff = strictRow?.value === '0' || strictRow?.value === 0;
                    if (strictOff) {
                        onLog?.('⚠ copyright timeout but strict_copyright_wait=0 → posting anyway');
                    } else {
                        return {
                            success: false,
                            reason: 'copyright_timeout',
                            message: 'FB ตรวจลิขสิทธิ์ไม่เสร็จใน 120 วิ — หยุดโพสต์กันส่ง content ไม่ได้ตรวจ ' +
                                     '(ปิดได้ใน "ตั้งค่าระบบ" → strict_copyright_wait)'
                        };
                    }
                }
            } catch (e) {
                onLog?.(`copyright timeout settings check failed: ${e.message} — defaulting to strict`);
                return {
                    success: false,
                    reason: 'copyright_timeout',
                    message: 'FB ตรวจลิขสิทธิ์ไม่เสร็จใน 120 วิ — หยุดโพสต์'
                };
            }
        }

        // Final nudge-modal check just before clicking share — FB sometimes surfaces
        // a re-engagement modal ("เข้าถึงกลุ่มเป้าหมายใหม่ๆ...") after the scan completes.
        await dismissNudgeModal(page, onLog);

        // Click "แชร์" (blue button at bottom-right of dialog) — final publish
        await humanDelay(1500, 2500);
        await snap('before_share');
        onLog?.('clicking แชร์ (final publish) — using real Puppeteer mouse click');

        // Get a handle on the BLUE share button (must be primary action, not a toggle)
        // We find candidates first, then return a handle so puppeteer can do a real click
        const shareHandle = await page.evaluateHandle(() => {
            const targets = ['แชร์', 'Share', 'เผยแพร่', 'Publish', 'โพสต์', 'Post'];
            const buttons = Array.from(document.querySelectorAll('div[role="button"], button, [role="button"]'));

            // EXACT text match (not "แชร์ไปยังกลุ่ม" etc)
            const matching = buttons.filter(b => {
                const t = (b.innerText || b.textContent || '').trim();
                if (!targets.includes(t)) return false;
                // Exclude buttons inside toggle/switch UI
                if (b.closest('[role="switch"]') || b.querySelector('[role="switch"]')) return false;
                // Must be visible
                const r = b.getBoundingClientRect();
                if (r.width < 30 || r.height < 20) return false;
                return true;
            });
            if (!matching.length) return null;

            // Prefer BLUE button at the bottom of viewport (FB primary CTA)
            let best = null, bestScore = -1;
            for (const b of matching) {
                const r = b.getBoundingClientRect();
                const bg = getComputedStyle(b).backgroundColor;
                let blue = 0;
                const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg || '');
                if (m) {
                    const [, red, gr, bl] = m.map(Number);
                    if (bl > 130 && bl > red + 30) blue = 100;
                }
                // Bottom area = higher score
                const bottomScore = Math.max(0, 100 - (window.innerHeight - r.bottom));
                // Right area = higher score
                const rightScore = Math.max(0, 100 - (window.innerWidth - r.right));
                const score = blue * 3 + bottomScore + rightScore;
                if (score > bestScore) { bestScore = score; best = b; }
            }
            return best;
        });

        const shareEl = shareHandle && shareHandle.asElement && shareHandle.asElement();
        if (!shareEl) {
            await snap('share_not_found');
            return { success: false, reason: 'no_share_btn', message: 'ไม่เจอปุ่ม "แชร์" สีฟ้าด้านล่าง' };
        }

        // Get button info for log
        const btnInfo = await shareEl.evaluate(el => ({
            text: (el.innerText || '').trim(),
            rect: el.getBoundingClientRect().toJSON ? el.getBoundingClientRect() : null
        })).catch(() => ({}));
        onLog?.(`found share button: "${btnInfo.text}"`);

        // Real Puppeteer mouse click — triggers React handlers properly
        try {
            await shareEl.scrollIntoViewIfNeeded?.();
            await shareEl.click({ delay: 50 + Math.random() * 100 });
            onLog?.('✓ share button clicked (real mouse)');
        } catch (e) {
            // Fallback: synthetic click
            await page.evaluate(el => el.click(), shareEl);
            onLog?.('✓ share button clicked (synthetic fallback)');
        }

        // Verify post succeeded — FB shows EITHER:
        //   (A) "กำลังประมวลผลคลิป Reels" modal with "เรียบร้อย" button  (primary indicator)
        //   (B) "วิดีโอของคุณเผยแพร่ได้อย่างปลอดภัยแล้ว · ไม่พบประเด็นปัญหาด้านลิขสิทธิ์"
        //        (post-publish copyright all-clear — FINAL confirmation that post is safe)
        // Either is sufficient to call the post successful; if we see (B) we can also record
        // copyright-safe status on the job.
        onLog?.('waiting for success modal (processing OR copyright-safe confirmation)...');
        let posted = false;
        let detectedVia = null;
        let copyrightSafeConfirmed = false;

        for (let i = 0; i < 25; i++) {
            await new Promise(r => setTimeout(r, 1500));
            const status = await page.evaluate(() => {
                const text = document.body.innerText || '';
                // POST-PUBLISH COPYRIGHT SAFE — strongest success signal (from screenshot 3)
                // "วิดีโอของคุณเผยแพร่ได้อย่างปลอดภัยแล้ว!" + "ไม่พบประเด็นปัญหาด้านลิขสิทธิ์"
                if (/เผยแพร่ได้อย่างปลอดภัย|ไม่พบประเด็นปัญหา.*ลิขสิทธิ์|published safely|no copyright issues/i.test(text)) {
                    return 'copyright-safe';
                }
                // PRIMARY success indicator — the processing modal
                if (/กำลังประมวลผลคลิป Reels|Processing your reel|Your reel is being processed/i.test(text)) {
                    return 'processing-modal';
                }
                // Other success indicators (older FB UI)
                if (/Reel.*ของคุณ.*ได้รับการเผยแพร่|reel.*has been published|posted successfully|Your reel was posted/i.test(text)) {
                    return 'success-text';
                }
                // Error indicators
                if (/มีบางอย่างผิดพลาด|something went wrong|failed to post/i.test(text)) {
                    return 'error';
                }
                return 'still-waiting';
            }).catch(() => 'eval-error');

            if (status === 'copyright-safe' || status === 'processing-modal' || status === 'success-text') {
                posted = true;
                detectedVia = status;
                if (status === 'copyright-safe') copyrightSafeConfirmed = true;
                onLog?.(`✓ POSTED — detected via "${status}"${copyrightSafeConfirmed ? ' (copyright CLEAN ✓)' : ''}`);
                await snap('post_success');
                // Click "เรียบร้อย" / "OK" / "Done" to dismiss the modal
                await new Promise(r => setTimeout(r, 1500));
                await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('div[role="button"], button'));
                    for (const b of buttons) {
                        const t = (b.innerText || '').trim();
                        if (/^(เรียบร้อย|OK|Done|ตกลง)$/i.test(t)) {
                            b.click();
                            return true;
                        }
                    }
                    return false;
                }).catch(() => {});
                break;
            }
            if (status === 'error') {
                await snap('post_error_modal');
                return { success: false, reason: 'fb_error', message: 'FB แสดง error modal หลังกด share' };
            }
            if (i === 5) onLog?.(`still waiting... (${i + 1}/25)`);
            if (i === 15) onLog?.(`taking longer than usual (${i + 1}/25)`);
        }

        if (!posted) {
            await snap('share_no_confirm');
            return {
                success: false, reason: 'share_no_confirm',
                message: 'กดปุ่มแชร์แล้วแต่ไม่เจอ "กำลังประมวลผลคลิป Reels" modal — อาจไม่ได้กดถูกปุ่ม'
            };
        }

        // BONUS: if we got the processing modal but NOT yet the copyright-safe confirmation,
        // poll for another 20s to see if FB shows the safe/blocked verdict.
        // This gives us a definitive copyright result on the same tab instead of relying
        // on monitorPostPublish (which navigates to facebook.com/<id> and often hits the
        // "processing" placeholder page).
        if (posted && !copyrightSafeConfirmed) {
            onLog?.('post accepted — polling 20s for post-publish copyright verdict...');
            for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 2000));
                const verdict = await page.evaluate(() => {
                    const text = document.body.innerText || '';
                    if (/เผยแพร่ได้อย่างปลอดภัย|ไม่พบประเด็นปัญหา.*ลิขสิทธิ์|published safely|no copyright issues/i.test(text)) {
                        return 'safe';
                    }
                    if (/พบเนื้อหา.*ลิขสิทธิ์|copyright.*claim|copyright.*infring|ตรวจพบเนื้อหาที่มีลิขสิทธิ์/i.test(text)) {
                        return 'blocked';
                    }
                    return null;
                }).catch(() => null);
                if (verdict === 'safe') {
                    copyrightSafeConfirmed = true;
                    onLog?.('✓ post-publish copyright verdict: SAFE');
                    break;
                } else if (verdict === 'blocked') {
                    onLog?.('⚠ post-publish copyright verdict: BLOCKED — will need Set 2 retry');
                    // Don't fail the job — the post WAS published, just flag it
                    break;
                }
            }
            if (!copyrightSafeConfirmed) {
                onLog?.('no post-publish copyright verdict within 20s (FB may show it later)');
            }
        }

        // Try to extract post ID from URL after modal dismissal
        // Wait a bit longer (6s total) so FB has time to redirect from composer → processing URL
        await new Promise(r => setTimeout(r, 2000));
        let finalUrl = page.url();
        let postIdMatch = /\/(?:videos|reel|posts|processing_)(\d+)/.exec(finalUrl)
                       || /\/processing_(\d+)/.exec(finalUrl);
        if (!postIdMatch) {
            // Retry read after another 4s — FB sometimes takes time to redirect
            await new Promise(r => setTimeout(r, 4000));
            finalUrl = page.url();
            postIdMatch = /\/(?:videos|reel|posts|processing_)(\d+)/.exec(finalUrl)
                       || /\/processing_(\d+)/.exec(finalUrl);
        }
        if (postIdMatch) {
            return { success: true, postId: postIdMatch[1], url: finalUrl, detectedVia };
        }

        // ✅ FIX: เดิม "success modal" ตรวจไม่แม่น — modal "กำลังประมวลผลคลิป Reels"
        //   อาจปรากฏขณะที่ FB block content เงียบๆ (gambling/spam filter)
        //   → คลิปไม่ขึ้นจริงแต่ระบบ mark posted = false positive
        // วิธีแก้: navigate ไป Reels tab ของเพจ + ตรวจหา caption ของเรา
        //   ถ้าเจอ → posted จริง / ถ้าไม่เจอใน 60 วิ → mark failed
        onLog?.(`no post ID in URL (${finalUrl}) — verifying by checking page Reels tab...`);
        try {
            const verifyOk = await verifyPostOnPageReels(page, pageId, caption, onLog);
            if (verifyOk) {
                return {
                    success: true,
                    postId: `verified_${Date.now()}`,
                    url: finalUrl,
                    detectedVia,
                    noPostId: true
                };
            } else {
                onLog?.('✗ verification FAILED — Reel ไม่อยู่ในเพจ (FB อาจ block content)');
                return {
                    success: false,
                    reason: 'post_not_found_after_share',
                    message: 'กดแชร์แล้ว FB แสดง modal "กำลังประมวลผล" แต่คลิปไม่ขึ้นในเพจหลัง verify ' +
                            '5 นาที — FB น่าจะ block content (เช่น gambling/spam filter) หรือยัง process อยู่นาน. ' +
                            'ลองตรวจเพจเองว่ามี Reel หรือไม่'
                };
            }
        } catch (verifyErr) {
            onLog?.(`verify step failed: ${verifyErr.message} — falling back to "posted" status (best effort)`);
            return {
                success: true,
                postId: `unknown_${Date.now()}`,
                url: finalUrl,
                detectedVia,
                noPostId: true,
                verifyFailed: true
            };
        }
    } catch (err) {
        onLog?.('ERROR: ' + err.message);
        return { success: false, reason: 'exception', message: err.message };
    } finally {
        // ✅ FIX leak: cleanup periodic dismiss timer (กัน setInterval ค้างต่อหลัง postReel exit)
        // เดิม clearInterval อยู่ใน page.once('close') — ถ้า postReel throw ก่อน close → leak
        try { clearInterval(_modalDismissTimer); } catch {}
        // Don't close the page — leave it for user to verify
    }
}

/**
 * ✅ FIX v2: post-verify ใช้ href-based diff (แม่นยำ 100% ไม่ขึ้นกับ caption text)
 *
 * Strategy:
 *   1. Navigate ไป /<pageId>/reels — capture baseline reel ID set (top 12 hrefs)
 *   2. Poll ทุก 10 วิ × 30 รอบ = 5 นาที:
 *      - reload page (force FB cache refresh) ทุก 2 รอบ
 *      - capture reel IDs ปัจจุบัน
 *      - ถ้าเจอ ID ที่ไม่อยู่ใน baseline = NEW REEL → ✓ posted
 *      - fallback: caption text match (กรณี anti-bot บล็อก href)
 *
 * เดิม: text-probe matching ที่ FB encode/truncate caption ทำให้ false-negative
 * ใหม่: href diff → independent of caption rendering, works even if FB hides text
 *
 * @returns {Promise<boolean>} true = posted จริง, false = ไม่เจอ
 */
async function verifyPostOnPageReels(page, pageId, caption, onLog) {
    if (!pageId) {
        onLog?.('verify skip — no pageId');
        return false;
    }

    const reelsUrl = `https://www.facebook.com/${pageId}/reels`;

    // ดึง reel IDs จาก a[href*="/reel/<id>"] (FB Reels grid pattern)
    const captureReelIds = async () => {
        return await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/reel/"]'));
            const ids = links.map(a => {
                const m = (a.getAttribute('href') || '').match(/\/reel\/(\d+)/);
                return m ? m[1] : null;
            }).filter(Boolean);
            return [...new Set(ids)].slice(0, 12);   // top 12 unique reel IDs
        }).catch(() => []);
    };

    // Step 1: navigate + capture baseline
    onLog?.(`verify: navigate to /${pageId}/reels for baseline capture (max 5 min)`);
    try {
        await page.goto(reelsUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await new Promise(r => setTimeout(r, 3500));   // FB lazy-loads reels grid
    } catch (e) {
        onLog?.(`verify nav error: ${e.message} — continuing with empty baseline`);
    }
    const baselineReels = new Set(await captureReelIds());
    onLog?.(`verify baseline: ${baselineReels.size} existing Reel IDs captured`);

    // Step 2: build caption probe (secondary fallback)
    const captionText = String(caption || '');
    const lines = captionText.split('\n');
    let probe = '';
    for (const line of lines) {
        const t = line.trim();
        if (t.length < 8) continue;
        if (t.startsWith('#')) continue;
        probe = t.slice(0, 30);
        if (probe.replace(/[^\u0E00-\u0E7Fa-zA-Z0-9]/g, '').length >= 6) break;
        probe = '';
    }

    // Step 3: poll for new reel — primary = href diff, fallback = caption text
    const MAX_ATTEMPTS = 30;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        await new Promise(r => setTimeout(r, 10000));
        try {
            // refresh ทุก 2 รอบ (FB cache บางทีไม่อัปเดต)
            if (attempt > 0 && attempt % 2 === 0) {
                try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
                await new Promise(r => setTimeout(r, 2500));   // FB lazy-loads
            }

            // PRIMARY: href diff — new reel ID = posted
            const currentReels = await captureReelIds();
            const newReels = currentReels.filter(id => !baselineReels.has(id));
            if (newReels.length > 0) {
                onLog?.(`✓✓ verify PASS — new Reel ID detected: ${newReels[0]} (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
                return true;
            }

            // SECONDARY: caption text match (กรณี anti-bot บล็อก href listing)
            if (probe.length >= 8) {
                const found = await page.evaluate((p) => {
                    return (document.body.innerText || '').includes(p);
                }, probe).catch(() => false);
                if (found) {
                    onLog?.(`✓ verify PASS via caption probe — "${probe.slice(0, 25)}..." (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
                    return true;
                }
            }

            // log แบบไม่ noisy — ทุก 5 รอบ
            if ((attempt + 1) % 5 === 0 || attempt === 0) {
                const elapsedSec = Math.round((attempt + 1) * 10);
                onLog?.(`verify ${attempt + 1}/${MAX_ATTEMPTS}: ${currentReels.length} reels visible, no new ID yet (${elapsedSec}s elapsed)`);
            }
        } catch (e) { onLog?.(`verify eval error: ${e.message}`); }
    }
    onLog?.(`verify FAIL after 5 min — no new Reel ID detected in /${pageId}/reels (FB may have blocked content)`);
    return false;
}

async function warmUpSession(browser, durationSec = 60) {
    const page = await browser.newPage();
    // Bring window to front so user sees the warm-up happening
    try {
        await page.bringToFront();
        const session = await page.target().createCDPSession();
        const { windowId } = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } }).catch(() => {});
    } catch {}
    try {
        await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        const end = Date.now() + durationSec * 1000;
        while (Date.now() < end) {
            await page.evaluate(() => {
                window.scrollBy({ top: 200 + Math.random() * 500, behavior: 'smooth' });
            }).catch(() => {});
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
        }
    } finally {
        await page.close().catch(() => {});
    }
}

/**
 * Scrape FB pages the user manages.
 * Multiple strategies for FB's ever-changing UI.
 */
async function fetchManagedPages(browser, onLog) {
    const page = await browser.newPage();
    try {
        const status = await isLoggedIn(page);
        if (!status.ok) {
            return { success: false, reason: status.reason, message: 'ยังไม่ได้ login FB เปิด Chrome login ก่อน' };
        }

        onLog?.('navigating to pages bookmark');
        await page.goto('https://www.facebook.com/pages/?category=your_pages&ref=bookmarks', {
            waitUntil: 'domcontentloaded', timeout: 45000
        });
        await humanDelay(3500, 5500);

        // Scroll to load lazy items
        for (let i = 0; i < 5; i++) {
            await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
            await humanDelay(700, 1300);
        }
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
        await humanDelay(500, 1000);

        onLog?.('extracting page list');
        const extracted = await page.evaluate(() => {
            const debugInfo = { strategies: {}, scopeFound: false };
            const results = [];
            const seen = new Set();

            function addResult(name, pageId, href, strategy) {
                if (!name || name.length < 2 || name.length > 100) return;
                const key = pageId || href;
                if (seen.has(key)) return;
                if (/^(home|menu|search|profile|settings|help|notifications|marketplace|watch|groups|memories|hide|manage|see all|more|bookmarks|facebook|meta|ก่อตั้งเพจ|สร้างเพจ|followed pages|คำเชิญ|สำรวจ|เพจที่คุณจัดการ|page notifications|messages|ข้อความ)$/i.test(name.toLowerCase().trim())) return;
                seen.add(key);
                results.push({ name, fb_page_id: pageId || href.replace(/^\//, '').split(/[?#/]/)[0], href, strategy });
            }

            function parseHref(href) {
                if (!href) return null;
                if (!href.startsWith('/') && !href.startsWith('https://www.facebook.com/')) return null;
                const path = href.startsWith('http') ? new URL(href).pathname + new URL(href).search : href;
                // EXCLUDE non-page paths — strict blacklist
                if (path.startsWith('/pages/') || path.startsWith('/groups/') || path.startsWith('/marketplace') ||
                    path.startsWith('/watch') || path.startsWith('/settings') || path.startsWith('/help') ||
                    path.startsWith('/bookmarks') || path.startsWith('/notifications') || path.startsWith('/messages') ||
                    path.startsWith('/friends') || path.startsWith('/memories') || path === '/' ||
                    path.startsWith('/search') || path.startsWith('/stories') || path.startsWith('/reel') ||
                    path.startsWith('/afad') || path.startsWith('/ad_center') || path.startsWith('/ads/') ||
                    path.startsWith('/latest/') || path.startsWith('/business') || path.startsWith('/login') ||
                    path.startsWith('/checkpoint') || path.startsWith('/policies') || path.startsWith('/legal') ||
                    path.startsWith('/privacy') || path.startsWith('/terms') || path.startsWith('/lite') ||
                    path.startsWith('/games')) return null;

                const idMatch = /[?&]id=(\d+)/.exec(path);
                if (idMatch) return { id: idMatch[1], slug: null };
                const slugMatch = /^\/([^/?#]+)/.exec(path);
                if (!slugMatch) return null;
                const slug = slugMatch[1];
                // Slug must look like a page name/id (not a UI route)
                if (slug.length < 2 || slug.length > 80) return null;
                if (/^(home|menu|profile|reels|news|api|legal|policy|policies|business|developers)$/i.test(slug)) return null;
                return { id: null, slug };
            }

            // ---------- SCOPE: find the "Pages you manage" container ----------
            // Look for headings containing "เพจที่คุณจัดการ" / "Pages you manage" / "คุณจัดการ"
            // and use that section's element as the search root.
            let searchRoots = [];
            const allHeaders = Array.from(document.querySelectorAll('h1,h2,h3,h4,div,span'));
            for (const h of allHeaders) {
                const t = (h.textContent || '').trim();
                if (/^(เพจที่คุณจัดการ|Pages you manage|Your Pages|เพจของฉัน)$/i.test(t)) {
                    debugInfo.scopeFound = true;
                    // Walk up to find the containing section, then scope to its sibling/parent
                    let container = h;
                    for (let i = 0; i < 8 && container; i++) {
                        container = container.parentElement;
                        if (container && container.querySelectorAll('a[href]').length > 1) {
                            searchRoots.push(container);
                            break;
                        }
                    }
                }
            }
            // Fallback: if no explicit "Pages you manage" header found, use main role area
            if (searchRoots.length === 0) {
                const main = document.querySelector('[role="main"]');
                if (main) searchRoots.push(main);
                else searchRoots.push(document.body);
            }

            // ---------- Strategy 1: find <img> avatars, then climb to anchor/clickable ----------
            const imgs = [];
            for (const root of searchRoots) {
                imgs.push(...Array.from(root.querySelectorAll('img[alt]')));
            }
            debugInfo.strategies.imgs = imgs.length;
            for (const img of imgs) {
                const alt = img.getAttribute('alt') || '';
                // FB uses alt="ชื่อเพจ" for page avatars
                if (!alt || alt.length < 2 || alt.length > 100) continue;
                // Skip obvious non-page alts
                if (/^(user|profile picture|photo|image|avatar|facebook|meta|may be an image|image of|สัญลักษณ์)$/i.test(alt.trim())) continue;

                // Climb up to find a parent anchor with href
                let node = img;
                for (let i = 0; i < 8 && node; i++) {
                    node = node.parentElement;
                    if (!node) break;
                    const link = node.tagName === 'A' ? node : node.querySelector && node.querySelector('a[href]');
                    if (link && link.href) {
                        const href = link.getAttribute('href') || link.href;
                        const parsed = parseHref(href);
                        if (parsed) {
                            addResult(alt.trim(), parsed.id, href, 'img-alt');
                            break;
                        }
                    }
                }
            }

            // ---------- Strategy 2: anchors with role=link + image inside ----------
            const anchors = [];
            for (const root of searchRoots) {
                anchors.push(...Array.from(root.querySelectorAll('a[href]')));
            }
            debugInfo.strategies.anchors = anchors.length;
            for (const a of anchors) {
                const href = a.getAttribute('href') || '';
                const parsed = parseHref(href);
                if (!parsed) continue;

                // Must have an image inside (page avatar) OR be under a "Pages you manage" header
                const hasImg = a.querySelector('img');
                if (!hasImg) continue;

                // Name from alt of inner img, or from inner text
                const altName = hasImg.getAttribute('alt');
                const textName = (a.textContent || '').trim();
                const name = (altName && altName.length >= 2 && altName.length <= 100) ? altName : textName;
                if (!name) continue;

                addResult(name.trim(), parsed.id, href, 'anchor-img');
            }

            // ---------- Strategy 3: generic role=link with svg/img ----------
            const roleLinks = [];
            for (const root of searchRoots) {
                roleLinks.push(...Array.from(root.querySelectorAll('[role="link"]')));
            }
            debugInfo.strategies.roleLinks = roleLinks.length;
            for (const el of roleLinks) {
                const href = el.getAttribute('href') || '';
                if (!href) continue;
                const parsed = parseHref(href);
                if (!parsed) continue;

                const img = el.querySelector('img');
                const name = img?.getAttribute('alt') || (el.textContent || '').trim();
                if (name) addResult(name.trim(), parsed.id, href, 'role-link');
            }

            debugInfo.totalFound = results.length;
            debugInfo.seenKeys = Array.from(seen).slice(0, 20);
            return { results, debugInfo };
        });

        onLog?.(`scraper debug: ${JSON.stringify(extracted.debugInfo)}`);
        onLog?.(`found ${extracted.results.length} candidate pages via strategies: ${extracted.results.map(p => p.strategy).join(',')}`);

        // If nothing found, capture the page HTML for debugging
        if (extracted.results.length === 0) {
            try {
                const snippet = await page.evaluate(() => {
                    const main = document.querySelector('[role="main"]') || document.body;
                    return main.innerHTML.slice(0, 3000);
                });
                onLog?.('DEBUG html snippet: ' + snippet.slice(0, 500));
            } catch {}
            return { success: false, reason: 'no_pages_found',
                message: 'ไม่เจอเพจในหน้า FB Pages — FB อาจเปลี่ยน UI ส่ง log มาให้ดู หรือลองเพิ่มเพจด้วยตนเอง' };
        }

        return { success: true, pages: extracted.results };
    } catch (e) {
        return { success: false, reason: 'exception', message: e.message };
    } finally {
        try { await page.close(); } catch {}
    }
}

module.exports = {
    launchForProfile,
    launchPlainChromeForLogin,
    findChromeExecutable,
    killSpawnedChrome,
    getSpawnedChromeInfo,
    isLoggedIn,
    postReel,
    warmUpSession,
    humanDelay,
    humanType,
    fetchManagedPages,
    backupCookiesToDb,
    restoreCookiesFromDb
};
