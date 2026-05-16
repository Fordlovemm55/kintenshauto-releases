/**
 * Browser Manager — one Chrome per profile, shared across all modules
 *
 * Why this exists:
 *   Chrome uses a SingletonLock on userDataDir. If two Puppeteer launches
 *   target the same userDataDir, the second one triggers a message to the
 *   first to open a new window — and the second's DevTools port is never
 *   attached. The result is that the originally-logged-in window appears
 *   to "disappear" and you get a brand-new unlogged-in Chrome.
 *
 *   Solution: keep ONE browser per profile.id in memory. test-login,
 *   fetch-pages, worker, and posting all get the same instance.
 *
 *   The browser stays open for the life of the backend. If the user
 *   closes Chrome manually, we detect the 'disconnected' event and
 *   drop it from cache — next request relaunches (cookies on disk
 *   mean login is preserved).
 */

const { launchForProfile, restoreCookiesFromDb, backupCookiesToDb } = require('./poster');

class BrowserManager {
    constructor() {
        this.browsers = new Map();             // profileId -> browser
        this.pending = new Map();              // profileId -> Promise<browser>
        this.backupTimers = new Map();         // profileId -> interval id
        this.db = null;                        // injected on first use
    }

    setDb(db) { this.db = db; }

    async getBrowser(profile, { headless = false } = {}) {
        const cached = this.browsers.get(profile.id);
        if (cached) {
            try {
                if (cached.isConnected && cached.isConnected()) {
                    return cached;
                }
            } catch {}
            this.browsers.delete(profile.id);
        }

        if (this.pending.has(profile.id)) {
            return this.pending.get(profile.id);
        }

        const launchPromise = (async () => {
            try {
                const browser = await launchForProfile(profile, { headless });

                // Restore cookies from DB backup — set BEFORE any page.goto
                if (this.db) {
                    try {
                        const r = await restoreCookiesFromDb(this.db, profile.id, browser);
                        console.log(`[browserManager] profile ${profile.id}: restored ${r.restored} cookies from DB`);
                    } catch (e) { console.error('[browserManager] cookie restore failed:', e.message); }
                }

                this.browsers.set(profile.id, browser);

                // Hook up cookie-capture listeners on EVERY page (existing + new)
                // Platform-aware: filter URLs to profile.platform's domains (default 'facebook' for legacy rows)
                if (this.db) {
                    const { isUrlForPlatform } = require('./services/platformConfig');
                    const profilePlatform = profile.platform || 'facebook';
                    const attachToPage = (page) => {
                        if (!page) return;
                        // Every response from the platform's domain — check for Set-Cookie, save on a short debounce
                        let saveTimer = null;
                        page.on('response', (resp) => {
                            try {
                                const url = resp.url() || '';
                                if (!isUrlForPlatform(url, profilePlatform)) return;
                                const headers = resp.headers() || {};
                                if (!headers['set-cookie']) return;
                                if (saveTimer) clearTimeout(saveTimer);
                                saveTimer = setTimeout(() => {
                                    backupCookiesToDb(this.db, profile.id, browser, profilePlatform)
                                        .then(r => {
                                            if (r.saved > 0) console.log(`[browserManager] live-save profile ${profile.id} (${profilePlatform}): ${r.saved} cookies`);
                                        }).catch(() => {});
                                }, 400);
                            } catch {}
                        });
                        // Also save on framenavigated so page transitions catch cookies too
                        page.on('framenavigated', (frame) => {
                            try {
                                if (frame !== page.mainFrame()) return;
                                const url = frame.url() || '';
                                if (!isUrlForPlatform(url, profilePlatform)) return;
                                setTimeout(() => {
                                    backupCookiesToDb(this.db, profile.id, browser, profilePlatform)
                                        .then(r => {
                                            if (r.saved > 0) console.log(`[browserManager] nav-save profile ${profile.id} (${profilePlatform}): ${r.saved} cookies @ ${url.slice(0,60)}`);
                                        }).catch(() => {});
                                }, 500);
                            } catch {}
                        });
                    };

                    // Attach to pages that already exist at launch
                    try {
                        const existingPages = await browser.pages();
                        for (const p of existingPages) attachToPage(p);
                    } catch {}

                    // Attach to any new tabs/popups opened later
                    browser.on('targetcreated', async (target) => {
                        if (target.type() !== 'page') return;
                        try {
                            const page = await target.page();
                            attachToPage(page);
                        } catch {}
                    });
                }

                // Also keep the periodic backup as a safety net
                if (this.db) this.startCookieBackup(profile.id, browser);

                browser.on('disconnected', async () => {
                    this.stopCookieBackup(profile.id);
                    this.browsers.delete(profile.id);
                    console.log(`[browserManager] profile ${profile.id} disconnected`);
                });
                return browser;
            } finally {
                this.pending.delete(profile.id);
            }
        })();

        this.pending.set(profile.id, launchPromise);
        return launchPromise;
    }

    startCookieBackup(profileId, browser) {
        this.stopCookieBackup(profileId);
        const tick = async () => {
            try {
                if (!browser.isConnected || !browser.isConnected()) return;
                await backupCookiesToDb(this.db, profileId, browser);
            } catch (e) { /* silent */ }
        };
        // Fast first backup so brief sessions still get captured,
        // then periodic backups while Chrome stays open.
        setTimeout(tick, 3000);
        setTimeout(tick, 8000);
        setTimeout(tick, 15000);
        const id = setInterval(tick, 30000);
        this.backupTimers.set(profileId, id);
    }

    stopCookieBackup(profileId) {
        const id = this.backupTimers.get(profileId);
        if (id) { clearInterval(id); this.backupTimers.delete(profileId); }
    }

    isOpen(profileId) {
        const b = this.browsers.get(profileId);
        try { return b && b.isConnected && b.isConnected(); } catch { return false; }
    }

    async closeBrowser(profileId) {
        const b = this.browsers.get(profileId);
        if (b) {
            if (this.db) {
                try { await backupCookiesToDb(this.db, profileId, b); } catch (e) {
                    console.error('[browserManager] backup before close failed:', e.message);
                }
            }
            this.stopCookieBackup(profileId);
            // When we spawn Chrome + connect via debug port, browser.close() on the
            // connected client doesn't terminate Chrome (it just disconnects). We
            // must kill the spawned process explicitly.
            try { await b.disconnect(); } catch {}
            try {
                const { killSpawnedChrome } = require('./poster');
                killSpawnedChrome(profileId);
            } catch {}
            this.browsers.delete(profileId);
        }
    }

    async closeAll() {
        // ✅ FIX H5: เดิมเรียก b.close() — แต่ browsers เหล่านี้ spawn ผ่าน puppeteer.connect()
        // (poster.js launchForProfile) → close() แค่ disconnect, Chrome process ยังรัน
        // → 50+ chrome.exe ค้างจริงตามที่ตรวจเจอใน live test
        // วิธีถูก: เรียก closeBrowser(profileId) ที่มีอยู่แล้ว (ทำ disconnect + killSpawnedChrome)
        const ids = Array.from(this.browsers.keys());
        for (const id of ids) {
            try { await this.closeBrowser(id); } catch (e) {
                console.error('[browserManager] closeAll error for profile', id, e.message);
            }
        }
        this.browsers.clear();
    }
}

// Singleton per process
const manager = new BrowserManager();

// Gracefully close all browsers on backend shutdown so Chrome flushes cookies to disk
process.on('beforeExit', () => manager.closeAll().catch(() => {}));
process.on('SIGTERM', () => manager.closeAll().catch(() => {}));
process.on('SIGINT', () => manager.closeAll().catch(() => {}));

module.exports = manager;
