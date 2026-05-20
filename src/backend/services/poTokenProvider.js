/**
 * PO Token Provider — generates YouTube Proof-of-Origin tokens for yt-dlp.
 *
 * Why this exists:
 *   YouTube increasingly rejects yt-dlp requests with "Sign in to confirm
 *   you're not a bot" or returns only storyboard formats. The fix yt-dlp
 *   supports is `--extractor-args "youtube:po_token=mweb.gvs+TOKEN"` — a
 *   token derived from Google's BotGuard JS challenge. Bgutils-js runs
 *   that challenge locally and gives us the token; we pass it to yt-dlp.
 *
 * Cost model:
 *   Token generation runs the BotGuard VM (a few hundred ms of JS in
 *   JSDOM). Tokens are valid for ~10 minutes — we cache for 8 minutes
 *   so subsequent yt-dlp calls don't re-pay the cost.
 *
 * Failure model:
 *   Network fail to Google's BotGuard endpoint, JSDOM setup fail, library
 *   API change — all return null. Callers must tolerate "no token" and
 *   fall back to anonymous fetch.
 */

const { BG, USER_AGENT } = require('bgutils-js');
const { JSDOM } = require('jsdom');

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const CACHE_TTL_MS = 8 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

// Pull a fresh visitor_data ID off the YouTube homepage. The string is
// embedded in `ytcfg.set({...})` inside an inline <script>. Format is a
// URL-safe base64 protobuf typically 60-100 chars, starting with "Cgs".
async function fetchVisitorData() {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch('https://www.youtube.com/', {
            signal: ctrl.signal,
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        if (!res.ok) throw new Error(`youtube.com HTTP ${res.status}`);
        const html = await res.text();
        // Try the most reliable embed location first
        let m = html.match(/"visitorData"\s*:\s*"([^"]+)"/);
        if (m && m[1]) return m[1];
        m = html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/);
        if (m && m[1]) return m[1];
        throw new Error('visitor_data not found in youtube.com HTML');
    } finally {
        clearTimeout(t);
    }
}

class POTokenProvider {
    constructor() {
        this._cache = null;        // { poToken, visitorData, generatedAt }
        this._inflight = null;     // dedupe parallel callers
    }

    isCached() {
        return !!(this._cache && Date.now() - this._cache.generatedAt < CACHE_TTL_MS);
    }

    // Drop the cache — call after suspected token-rejection on yt-dlp side
    invalidate() {
        this._cache = null;
    }

    /**
     * @returns {Promise<{poToken: string, visitorData: string} | null>}
     *          null = generation failed; caller should fall back to anonymous.
     */
    async get() {
        if (this.isCached()) return this._cache;
        if (this._inflight) return this._inflight;
        this._inflight = this._generate().finally(() => { this._inflight = null; });
        return this._inflight;
    }

    async _generate() {
        try {
            // 1) visitor_data — needed as the BG identifier
            const visitorData = await fetchVisitorData();

            // 2) Set up a JSDOM environment for the BotGuard VM to run in
            const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
                url: 'https://www.youtube.com/',
                referrer: 'https://www.youtube.com/',
                contentType: 'text/html',
                pretendToBeVisual: true,
                resources: 'usable'
            });
            // Expose dom globals on globalThis so the VM finds them.
            // Node 22+ ships its own read-only `navigator` getter — we have
            // to use defineProperty (writable) to override it instead of
            // assignment. We capture descriptors so we can restore later.
            const exportKeys = ['window', 'document', 'navigator'];
            const previousDescriptors = {};
            for (const k of exportKeys) {
                previousDescriptors[k] = Object.getOwnPropertyDescriptor(globalThis, k);
                const value = (k === 'window') ? dom.window : dom.window[k];
                Object.defineProperty(globalThis, k, {
                    value, writable: true, configurable: true, enumerable: false
                });
            }

            try {
                const bgConfig = {
                    fetch: (url, opts) => fetch(url, opts),
                    requestKey: REQUEST_KEY,
                    globalObj: globalThis,
                    identifier: visitorData
                };

                const challenge = await BG.Challenge.create(bgConfig);
                if (!challenge || !challenge.program) {
                    throw new Error('BG.Challenge.create returned empty result');
                }

                // The challenge's interpreterJavascript is the BotGuard VM
                // bytecode wrapped as JS — we have to eval it INTO globalThis
                // so the `globalName` symbol gets defined for generate() to
                // find. Skipping this step yields "VM not found".
                const interpreterJs = challenge.interpreterJavascript
                    ?.privateDoNotAccessOrElseSafeScriptWrappedValue;
                if (!interpreterJs) {
                    throw new Error('BG.Challenge missing interpreterJavascript');
                }
                // Evaluate in global scope — using Function() not eval to keep
                // strict-mode behavior consistent
                new Function(interpreterJs)();

                const result = await BG.PoToken.generate({
                    program: challenge.program,
                    globalName: challenge.globalName,
                    bgConfig
                });
                if (!result || !result.poToken) {
                    throw new Error('BG.PoToken.generate returned empty result');
                }

                this._cache = {
                    poToken: result.poToken,
                    visitorData,
                    generatedAt: Date.now()
                };
                console.log(`[poToken] generated (${result.poToken.length} chars), valid ~${CACHE_TTL_MS / 60000} min`);
                return this._cache;
            } finally {
                // Restore globals — re-apply original descriptor or delete
                for (const k of exportKeys) {
                    const desc = previousDescriptors[k];
                    if (desc) {
                        try { Object.defineProperty(globalThis, k, desc); } catch {}
                    } else {
                        try { delete globalThis[k]; } catch {}
                    }
                }
                try { dom.window.close(); } catch {}
            }
        } catch (e) {
            console.warn(`[poToken] generation failed:`, e.message);
            return null;
        }
    }
}

// Module-level singleton — one provider for the whole app
let _instance = null;
function getProvider() {
    if (!_instance) _instance = new POTokenProvider();
    return _instance;
}

module.exports = { POTokenProvider, getProvider };
