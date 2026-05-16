/**
 * Scout — ค้นคลิปจาก bilibili.tv ด้วย keyword
 *
 * Strategy: ใช้ Puppeteer (plain Chrome เหมือนเปิดเอง) เปิดหน้า search
 *   → รอ results โหลด → ดึง URL + title + duration ของคลิป
 *   → ส่งกลับเป็น array ให้ orchestrator เลือกตัวแรก (หรือทั้งหมด)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const SCOUT_DATA_DIR = path.join(process.env.KINTENSHAUTO_USER_DATA || os.tmpdir(), 'scout-chrome');
let scoutBrowser = null;
let scoutProc = null;
const SCOUT_PORT = 9499;

function findChromeExecutable() {
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
    ];
    for (const c of candidates) {
        if (c && fs.existsSync(c)) return c;
    }
    return null;
}

async function waitForDebugPort(port, timeoutMs = 15000) {
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
    throw new Error(`scout debug port ${port} not ready`);
}

async function getScoutBrowser() {
    if (scoutBrowser) {
        try { if (scoutBrowser.isConnected()) return scoutBrowser; } catch {}
        scoutBrowser = null;
    }

    if (!fs.existsSync(SCOUT_DATA_DIR)) fs.mkdirSync(SCOUT_DATA_DIR, { recursive: true });
    for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        try { fs.unlinkSync(path.join(SCOUT_DATA_DIR, lock)); } catch {}
    }

    const chromePath = findChromeExecutable();
    if (!chromePath) throw new Error('Chrome ไม่เจอ');

    scoutProc = spawn(chromePath, [
        `--user-data-dir=${SCOUT_DATA_DIR}`,
        '--profile-directory=Default',
        `--remote-debugging-port=${SCOUT_PORT}`,
        '--no-first-run', '--no-default-browser-check',
        '--disable-features=DestroyProfileOnBrowserClose',
        '--headless=new',  // run scout headless so user doesn't see Chrome flash
        '--disable-gpu',
        '--window-size=1280,900'
    ], { detached: false, stdio: 'ignore', windowsHide: true });

    scoutProc.on('exit', () => { scoutBrowser = null; scoutProc = null; });

    const wsUrl = await waitForDebugPort(SCOUT_PORT);
    scoutBrowser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: { width: 1280, height: 900 } });
    return scoutBrowser;
}

/**
 * Search bilibili.tv with a keyword and return up to `limit` video candidates
 * Returns: [{ url, title, duration, thumbnail, views }]
 */
async function scoutBilibili(keyword, { limit = 5, onLog } = {}) {
    if (!keyword) throw new Error('keyword required');
    onLog?.(`scout: searching "${keyword}"`);

    const browser = await getScoutBrowser();
    const page = await browser.newPage();
    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');

        const searchUrl = `https://www.bilibili.tv/th/search-result?q=${encodeURIComponent(keyword)}`;
        onLog?.(`scout: navigating ${searchUrl}`);
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await new Promise(r => setTimeout(r, 4000));    // let JS render

        // Scroll to load lazy items
        for (let i = 0; i < 3; i++) {
            await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
            await new Promise(r => setTimeout(r, 800));
        }

        const videos = await page.evaluate((max) => {
            const out = [];
            const seen = new Set();

            // bilibili.tv uses anchors like /th/play/<season>/<episode>  or  /th/video/<aid>
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            for (const a of anchors) {
                const rawHref = a.getAttribute('href') || '';
                if (!rawHref) continue;
                let href = rawHref;
                // Normalize URL — handle protocol-relative (//), absolute path (/), and full URLs
                if (href.startsWith('//')) {
                    href = 'https:' + href;
                } else if (href.startsWith('/')) {
                    href = 'https://www.bilibili.tv' + href;
                } else if (!/^https?:/.test(href)) {
                    continue;   // skip mailto:, javascript:, etc.
                }
                if (!href.includes('bilibili.tv')) continue;
                if (!/\/th\/(?:play|video)\//.test(href)) continue;
                // Strip duplicate domain if any (defense-in-depth)
                href = href.replace(/^(https?:\/\/[^\/]+)\/+(?:www\.)?bilibili\.tv\//, '$1/');
                if (seen.has(href)) continue;

                // Title: try img alt → text content → aria-label
                const img = a.querySelector('img');
                const titleFromImg = img?.getAttribute('alt') || '';
                const textOnly = (a.innerText || a.textContent || '').trim();
                const title = (titleFromImg && titleFromImg.length > 3 ? titleFromImg : textOnly).slice(0, 200);
                if (!title || title.length < 3) continue;

                // Duration: look for span containing time pattern
                let duration = '';
                const allSpans = a.querySelectorAll('span,div');
                for (const s of allSpans) {
                    const t = (s.textContent || '').trim();
                    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) { duration = t; break; }
                }

                // Thumbnail
                const thumbnail = img?.getAttribute('src') || img?.getAttribute('data-src') || '';

                seen.add(href);
                out.push({ url: href, title, duration, thumbnail });
                if (out.length >= max) break;
            }
            return out;
        }, limit);

        onLog?.(`scout: found ${videos.length} videos`);
        return videos;
    } finally {
        try { await page.close(); } catch {}
    }
}

async function closeScout() {
    if (scoutBrowser) {
        try { await scoutBrowser.disconnect(); } catch {}
        scoutBrowser = null;
    }
    if (scoutProc) {
        try { scoutProc.kill(); } catch {}
        scoutProc = null;
    }
}

process.on('beforeExit', () => closeScout().catch(() => {}));
process.on('SIGTERM', () => closeScout().catch(() => {}));
process.on('SIGINT', () => closeScout().catch(() => {}));

module.exports = { scoutBilibili, closeScout };
