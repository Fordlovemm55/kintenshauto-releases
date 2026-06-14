/**
 * AI Caption Provider Adapter
 * รองรับ: OpenAI, Anthropic (Claude), Google Gemini
 *
 * Usage:
 *   const provider = await getProvider(pageId);
 *   const caption = await provider.generateCaption({
 *     videoTitle: "ซีรีส์จีน EP.1",
 *     niche: "ซีรีส์จีน",
 *     duration: 90
 *   });
 */

const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ============================================================
// Encryption helper — auto-generates and persists a per-install random key.
// Priority: env var > .secret file in userData > freshly generated
// ============================================================
// ✅ FIX: lazy-init encryption key (เดิม resolve ที่ require() time → ถ้าใครเผลอ
// import captionService ก่อน main.js ตั้ง KINTENSHAUTO_USER_DATA จะ exit(1) ทันที)
// ✅ FIX: cache derived scrypt key — เดิมเรียก scryptSync ทุก encrypt/decrypt = ~50-100ms ต่อครั้ง
let _ENCRYPTION_KEY = null;
let _DERIVED_KEY = null;
function getEncryptionKey() {
    if (_ENCRYPTION_KEY) return _ENCRYPTION_KEY;
    if (process.env.KINTENSHAUTO_SECRET) {
        _ENCRYPTION_KEY = process.env.KINTENSHAUTO_SECRET;
        return _ENCRYPTION_KEY;
    }
    const userData = process.env.KINTENSHAUTO_USER_DATA || path.join(__dirname, '../../..');
    const secretFile = path.join(userData, '.encryption-key');
    try {
        if (fs.existsSync(secretFile)) {
            const existing = fs.readFileSync(secretFile, 'utf-8').trim();
            if (existing && existing.length >= 32) { _ENCRYPTION_KEY = existing; return _ENCRYPTION_KEY; }
            try { fs.renameSync(secretFile, secretFile + '.corrupt-' + Date.now()); } catch {}
        }
        try { fs.mkdirSync(userData, { recursive: true }); } catch {}
        const fresh = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(secretFile, fresh, { mode: 0o600 });
        try {
            const verify = fs.readFileSync(secretFile, 'utf-8').trim();
            if (verify !== fresh) throw new Error('verify mismatch');
        } catch (e) {
            throw new Error(`could not persist encryption key at ${secretFile}: ${e.message}`);
        }
        console.log('[encryption] generated new per-install key at', secretFile);
        _ENCRYPTION_KEY = fresh;
        return _ENCRYPTION_KEY;
    } catch (e) {
        // ✅ FIX: throw แทน process.exit — caller จัดการได้ ไม่ kill ทั้ง main process
        throw new Error(
            `[encryption] FATAL: cannot persist encryption key (${e.message}). ` +
            `กรุณาตรวจสิทธิ์เขียนไฟล์ของ ${userData} หรือกำหนด env var KINTENSHAUTO_SECRET เป็น hex 32 bytes`
        );
    }
}
function getDerivedKey() {
    if (_DERIVED_KEY) return _DERIVED_KEY;
    _DERIVED_KEY = crypto.scryptSync(getEncryptionKey(), 'salt', 32);
    return _DERIVED_KEY;
}
const ALGORITHM = 'aes-256-cbc';

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, getDerivedKey(), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encrypted) {
    // ✅ FIX: split with limit 2 — กรณี IV หรือ data มี ':' (ไม่ควรเกิด แต่กันเหนียว)
    const sep = encrypted.indexOf(':');
    if (sep < 0) throw new Error('decrypt: invalid format (missing separator)');
    const ivHex = encrypted.slice(0, sep);
    const data = encrypted.slice(sep + 1);
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, getDerivedKey(), iv);
    let decrypted = decipher.update(data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// ============================================================
// CAPTION MODELS REGISTRY
// ============================================================
// Each entry defines:
//   provider      : which API backend (openai / anthropic / gemini)
//   label         : human-readable name for UI
//   priceInUSD_per1K  : input token cost per 1K tokens in USD
//   priceOutUSD_per1K : output token cost per 1K tokens in USD
//
// "Price per caption" estimate is calculated dynamically assuming a typical
// caption generation: ~1000 input tokens (system + user prompt w/ variables)
// + ~200 output tokens. This is a ballpark — real usage varies.
//
// Prices are as of Jan 2026 — update these when providers change pricing.
const CAPTION_MODELS = {
    // ── OpenAI ──
    'gpt-4o-mini': {
        provider: 'openai', label: 'GPT-4o mini (ถูก · ใช้ได้ดี)',
        priceInUSD_per1K: 0.00015, priceOutUSD_per1K: 0.0006
    },
    'gpt-4o': {
        provider: 'openai', label: 'GPT-4o (คุณภาพสูง)',
        priceInUSD_per1K: 0.0025, priceOutUSD_per1K: 0.01
    },
    'gpt-4.1-mini': {
        provider: 'openai', label: 'GPT-4.1 mini (ใหม่ · ถูกสุด)',
        priceInUSD_per1K: 0.00015, priceOutUSD_per1K: 0.0006
    },

    // ── Anthropic Claude ──
    'claude-haiku-4-5-20251001': {
        provider: 'anthropic', label: 'Claude Haiku 4.5 (ถูก · เร็ว)',
        priceInUSD_per1K: 0.0008, priceOutUSD_per1K: 0.004
    },
    'claude-sonnet-4-5-20250929': {
        provider: 'anthropic', label: 'Claude Sonnet 4.5 (คุณภาพสูงสุด)',
        priceInUSD_per1K: 0.003, priceOutUSD_per1K: 0.015
    },

    // ── Google Gemini ──
    'gemini-2.0-flash': {
        provider: 'gemini', label: 'Gemini 2.0 Flash (ถูก · เร็ว)',
        priceInUSD_per1K: 0.0001, priceOutUSD_per1K: 0.0004
    },
    'gemini-2.5-flash': {
        provider: 'gemini', label: 'Gemini 2.5 Flash (ใหม่ · สมดุล)',
        priceInUSD_per1K: 0.000075, priceOutUSD_per1K: 0.0003
    },
    'gemini-2.5-pro': {
        provider: 'gemini', label: 'Gemini 2.5 Pro (คุณภาพสูงสุด)',
        priceInUSD_per1K: 0.00125, priceOutUSD_per1K: 0.005
    }
};

// Typical token usage per caption generation (used to estimate cost)
const TYPICAL_INPUT_TOKENS = 1000;
const TYPICAL_OUTPUT_TOKENS = 200;
// Approximate USD → THB. We don't pull live rates to avoid API calls;
// update manually every few months. As of Jan 2026 ~ 35 THB per USD.
const USD_TO_THB = 35;

/**
 * Return the estimated cost per caption for a given model, in both USD and THB.
 * Returns null if the model isn't in the registry.
 */
function estimateCaptionCost(modelId) {
    const m = CAPTION_MODELS[modelId];
    if (!m) return null;
    const usd = (TYPICAL_INPUT_TOKENS / 1000) * m.priceInUSD_per1K
              + (TYPICAL_OUTPUT_TOKENS / 1000) * m.priceOutUSD_per1K;
    const thb = usd * USD_TO_THB;
    return {
        usd: Math.round(usd * 100000) / 100000,        // 5 decimals — USD per caption
        thb: Math.round(thb * 10000) / 10000,           // 4 decimals — THB per caption (tiny)
        per1000: Math.round(thb * 1000 * 100) / 100     // THB per 1000 captions (2 decimals)
    };
}

// ============================================================
// Base Provider Interface
// ============================================================
class BaseProvider {
    constructor(config) {
        this.apiKey = config.apiKey;
        this.model = config.model;
        this.label = config.label;
    }

    async generateCaption(context) {
        throw new Error('Must implement generateCaption()');
    }

    buildPrompt(template, variables) {
        let prompt = template;
        for (const [key, value] of Object.entries(variables)) {
            prompt = prompt.replace(new RegExp(`{${key}}`, 'g'), value || '');
        }
        return prompt;
    }
}

// ============================================================
// OpenAI Provider
// ============================================================
class OpenAIProvider extends BaseProvider {
    async generateCaption({ systemPrompt, userPrompt, maxTokens, temperature }) {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: this.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: maxTokens || 200,
                temperature: temperature || 0.8
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`OpenAI error ${response.status}: ${err}`);
        }

        const data = await response.json();
        return data.choices[0].message.content.trim();
    }
}

// ============================================================
// Anthropic (Claude) Provider
// ============================================================
class AnthropicProvider extends BaseProvider {
    async generateCaption({ systemPrompt, userPrompt, maxTokens, temperature }) {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: maxTokens || 200,
                temperature: temperature || 0.8,
                system: systemPrompt,
                messages: [
                    { role: 'user', content: userPrompt }
                ]
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Anthropic error ${response.status}: ${err}`);
        }

        const data = await response.json();
        return data.content[0].text.trim();
    }
}

// ============================================================
// Google Gemini Provider
// ============================================================
class GeminiProvider extends BaseProvider {
    async generateCaption({ systemPrompt, userPrompt, maxTokens, temperature }) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

        // Gemini 2.5 models have a "thinking" mode that consumes maxOutputTokens
        // BEFORE producing any visible output. With thinkingBudget=0 we force it to
        // spend 100% of the budget on actual response. Critical for long prompts —
        // otherwise a 200-token budget gets eaten by internal reasoning and the
        // caption comes out 1-2 sentences long (or empty).
        const generationConfig = {
            maxOutputTokens: maxTokens || 2000,     // default raised from 200 (Gemini 2.5 Flash with thinking needs headroom)
            temperature: temperature ?? 0.8
        };
        // Only 2.5-* models accept thinkingConfig — skip for older models
        if (/^gemini-2\.5-/i.test(this.model)) {
            generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
                generationConfig
            })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Gemini error ${response.status}: ${err}`);
        }

        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
            // Surface the real reason — often finishReason='MAX_TOKENS' means thinking
            // ate the budget, or 'SAFETY' means content was blocked.
            const reason = data?.candidates?.[0]?.finishReason || 'unknown';
            throw new Error(`Gemini returned empty response (finishReason: ${reason}) — ลอง max_tokens สูงขึ้น`);
        }
        return text.trim();
    }
}

// ============================================================
// Factory — สร้าง provider ตาม type
// ============================================================
function createProvider(providerType, config) {
    switch (providerType) {
        case 'openai':
            return new OpenAIProvider(config);
        case 'anthropic':
            return new AnthropicProvider(config);
        case 'gemini':
            return new GeminiProvider(config);
        default:
            throw new Error(`Unknown provider: ${providerType}`);
    }
}

// ============================================================
// Caption Service — high-level API ใช้งานจริง
// ============================================================
class CaptionService {
    constructor(dbPath) {
        this.db = dbPath instanceof Database ? dbPath : new Database(dbPath);
        this.db.pragma('foreign_keys = ON');   // ✅ FIX H1: per-connection cascade enable
    }

    /**
     * Caption generation mode — read from settings table.
     *   'ai' (default)    → call OpenAI/Anthropic/Gemini (existing behavior)
     *   'template'        → render `caption_template` setting with variable
     *                       substitution + emoji rotation. NO API call, FREE.
     *   'source_title'    → just "{video_title} EP.{n} {emoji}". NO API call.
     *   'off'             → empty string. Worker may skip the post entirely.
     */
    _getCaptionMode() {
        try {
            const row = this.db.prepare(
                `SELECT value FROM settings WHERE key = 'caption_mode'`
            ).get();
            const v = (row?.value || '').toLowerCase();
            return ['ai', 'template', 'source_title', 'off'].includes(v) ? v : 'ai';
        } catch { return 'ai'; }
    }

    _getSetting(key) {
        try { return this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value || ''; }
        catch { return ''; }
    }

    /**
     * Render a template string with {var} substitution. No AI involved.
     * Variables filled from videoContext + the page row:
     *   {video_title}      full title
     *   {video_title_short} first 80 chars + … if longer
     *   {clip_number}      EP number
     *   {total_clips}      total EPs in the set
     *   {channel_label}    Watcher channel label (if from watcher)
     *   {page_name}        FB page name
     *   {niche}            page niche
     *   {emoji}            random from caption_emoji_pool (or default set)
     *   {emoji2}, {emoji3} additional random picks (different positions)
     */
    _renderTemplate(template, videoContext, pageRow) {
        const emojiPool = (this._getSetting('caption_emoji_pool')
            || '🎬,🔥,✨,📺,⚡,💥,🌟,🎥,🎞,🎟').split(',').map(s => s.trim()).filter(Boolean);
        const pickEmoji = () => emojiPool[Math.floor(Math.random() * emojiPool.length)] || '';

        const title = String(videoContext.videoTitle || pageRow?.niche || 'คลิปดี');
        const vars = {
            video_title: title,
            video_title_short: title.length > 80 ? title.slice(0, 80) + '…' : title,
            clip_number: videoContext.clipNumber || 1,
            total_clips: videoContext.totalClips || 1,
            channel_label: videoContext.channelLabel || '',
            page_name: pageRow?.name || '',
            niche: pageRow?.niche || '',
            emoji: pickEmoji(),
            emoji2: pickEmoji(),
            emoji3: pickEmoji(),
        };
        return String(template || '').replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
    }

    /**
     * No-AI caption path — used when caption_mode is template / source_title / off.
     * Returns a deterministic string built from local data; never calls an API.
     */
    _buildNonAICaption(mode, pageId, videoContext) {
        if (mode === 'off') return '';
        const pageRow = pageId
            ? this.db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId)
            : null;
        if (mode === 'source_title') {
            const title = (videoContext.videoTitle || 'ซีรีส์น่าดู').slice(0, 100);
            const ep = videoContext.clipNumber ? ` EP.${videoContext.clipNumber}` : '';
            return this._renderTemplate(`${title}${ep} {emoji}`, videoContext, pageRow);
        }
        // 'template' — default uses only supported {var} tokens. The old default had a
        // '{? EP.{clip_number}}' conditional that _renderTemplate doesn't understand, so the
        // literal braces ('{? EP.3}') leaked into the posted caption.
        const tpl = this._getSetting('caption_template')
            || '{video_title} EP.{clip_number} {emoji}\n#ซีรีส์ #คลิปดี';
        return this._renderTemplate(tpl, videoContext, pageRow);
    }

    async generateForPage(pageId, videoContext) {
        // Non-AI modes short-circuit BEFORE any DB lookup of providers / prompts.
        // Lets the user run the whole pipeline with zero API spend.
        const mode = this._getCaptionMode();
        if (mode !== 'ai') {
            return this._buildNonAICaption(mode, pageId, videoContext);
        }
        return this._generateForPageAI(pageId, videoContext);
    }

    async _generateForPageAI(pageId, videoContext) {
        // Prompt lookup stays the same — page-specific wins over the default.
        const promptRow = this.db.prepare(`
            SELECT cp.*, ap.provider, ap.api_key, ap.model, ap.label
            FROM caption_prompts cp
            LEFT JOIN ai_providers ap ON ap.id = cp.ai_provider_id
            WHERE cp.page_id = ? OR cp.page_id IS NULL
            ORDER BY cp.page_id DESC
            LIMIT 1
        `).get(pageId);

        if (!promptRow) {
            return this.fallbackTemplate(videoContext);
        }

        // Model selection: if the caption_prompts row has `selected_model` set and that
        // model is in our registry, use it — find a provider row matching its provider type.
        // Otherwise fall back to the legacy ai_provider_id linkage or the first-available.
        let providerRow = null;
        let modelOverride = null;
        const selectedModel = promptRow.selected_model;
        if (selectedModel && CAPTION_MODELS[selectedModel]) {
            const targetProvider = CAPTION_MODELS[selectedModel].provider;
            const r = this.db.prepare(`SELECT * FROM ai_providers WHERE provider = ? AND enabled = 1 LIMIT 1`).get(targetProvider);
            if (r) {
                providerRow = r;
                modelOverride = selectedModel;
            }
        }
        if (!providerRow && promptRow.provider) {
            providerRow = { provider: promptRow.provider, api_key: promptRow.api_key, model: promptRow.model, label: promptRow.label };
        }
        if (!providerRow) {
            const order = ['openai', 'anthropic', 'gemini'];
            for (const p of order) {
                const r = this.db.prepare(`SELECT * FROM ai_providers WHERE provider = ? AND enabled = 1 LIMIT 1`).get(p);
                if (r) { providerRow = r; break; }
            }
        }
        if (!providerRow) {
            console.warn('[CaptionService] no API key configured — using fallback template');
            return this.fallbackTemplate(videoContext);
        }

        const provider = createProvider(providerRow.provider, {
            apiKey: decrypt(providerRow.api_key),
            // Use explicit modelOverride (from selected_model) if set, else the provider's default model
            model: modelOverride || providerRow.model,
            label: providerRow.label
        });

        const pageRow = this.db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId);

        const variables = {
            video_title: videoContext.videoTitle || '',
            video_desc: videoContext.videoDesc || '',
            niche: pageRow?.niche || '',
            page_name: pageRow?.name || '',
            clip_duration: videoContext.duration || 0,
            clip_number: videoContext.clipNumber || 1,
            total_clips: videoContext.totalClips || 1
        };

        const userPrompt = provider.buildPrompt(promptRow.user_prompt, variables);

        // Prepend a strict output guard to the system prompt so models don't echo back
        // the rules/instructions as their response (the "prompt-as-caption" bug).
        // This line alone fixes 90% of the cases we see.
        const guardedSystemPrompt =
            'ตอบกลับเฉพาะข้อความแคปชั่นที่เสร็จสมบูรณ์เท่านั้น ห้ามขึ้นต้นด้วย "คุณคือ/คุณเป็น/You are" ห้ามใส่กฎ/ข้อกำหนด/รายการข้อ เช่น "1. ..., 2. ..." ห้ามอธิบายเหตุผล ให้ส่งเฉพาะแคปชั่นที่พร้อมโพสต์ไปยัง Facebook ทันที\n\n' +
            (promptRow.system_prompt || '');

        // Try up to 2 times — if first attempt looks like a prompt-echo, retry once with
        // temperature bumped to break the pattern.
        const MAX_ATTEMPTS = 2;
        let lastErr = null;
        const baseTemp = promptRow.temperature || 0.8;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            // Cap at 1.5 — most providers accept up to 2.0 but behavior gets erratic above 1.5.
            const attemptTemp = Math.min(1.5, baseTemp + (attempt * 0.2));
            try {
                const caption = await provider.generateCaption({
                    systemPrompt: guardedSystemPrompt,
                    userPrompt: userPrompt,
                    maxTokens: promptRow.max_tokens,
                    temperature: attemptTemp
                });

                // Sanity check — reject prompt-echo / instruction-list outputs.
                const rejection = CaptionService.detectPromptEcho(caption, promptRow.system_prompt || '');
                if (rejection) {
                    console.warn(`[CaptionService] attempt ${attempt + 1} rejected (${rejection}): "${caption.slice(0, 80)}..."`);
                    lastErr = new Error(`AI response rejected: ${rejection}`);
                    continue;
                }
                return caption;
            } catch (err) {
                lastErr = err;
                console.error(`[CaptionService] attempt ${attempt + 1} failed:`, err.message);
            }
        }
        console.error('[CaptionService] all attempts failed — using fallback template. Last error:', lastErr?.message);
        return this.fallbackTemplate(videoContext);
    }

    /**
     * ✅ NEW: Generate caption สำหรับ Channel Watcher — แยก prompt จากของหลัก
     * - ใช้ settings keys: 'watcher_caption_system_prompt', 'watcher_caption_user_prompt',
     *   'watcher_caption_max_tokens', 'watcher_caption_temperature', 'watcher_caption_model'
     * - ถ้า prompt ทั้ง 2 ตัวว่าง → fall back to generateForPage() (ใช้ของหลัก)
     * - ใช้ provider/model selection logic เดียวกับ generateForPage
     * - ไม่แตะ caption_prompts table — แยก scope ผ่าน settings
     */
    async generateForWatcher(pageId, videoContext) {
        // Honor the global caption_mode toggle — if user disabled AI, the
        // watcher path also goes through the template/source_title/off branch
        // (NOT just the page-prompt path). Otherwise approving from the watcher
        // would still burn API credits even with "AI off" selected.
        const mode = this._getCaptionMode();
        if (mode !== 'ai') {
            return this._buildNonAICaption(mode, pageId, videoContext);
        }

        const getSetting = (key) => {
            try { return this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value; }
            catch { return null; }
        };

        const wSystem = (getSetting('watcher_caption_system_prompt') || '').trim();
        const wUser   = (getSetting('watcher_caption_user_prompt') || '').trim();

        // ถ้าไม่ได้ตั้ง prompt watcher → fall back ใช้ prompt หลัก
        if (!wSystem && !wUser) {
            console.log('[captionService] watcher prompts empty — falling back to main caption flow');
            return this._generateForPageAI(pageId, videoContext);
        }

        // model selection (แชร์ logic กับ generateForPage)
        let providerRow = null;
        let modelOverride = null;
        const wModel = getSetting('watcher_caption_model');
        if (wModel && CAPTION_MODELS[wModel]) {
            const target = CAPTION_MODELS[wModel].provider;
            const r = this.db.prepare(`SELECT * FROM ai_providers WHERE provider = ? AND enabled = 1 LIMIT 1`).get(target);
            if (r) { providerRow = r; modelOverride = wModel; }
        }
        if (!providerRow) {
            for (const p of ['openai', 'anthropic', 'gemini']) {
                const r = this.db.prepare(`SELECT * FROM ai_providers WHERE provider = ? AND enabled = 1 LIMIT 1`).get(p);
                if (r) { providerRow = r; break; }
            }
        }
        if (!providerRow) {
            console.warn('[captionService:watcher] no AI provider configured — using fallback template');
            return this.fallbackTemplate(videoContext);
        }

        const provider = createProvider(providerRow.provider, {
            apiKey: decrypt(providerRow.api_key),
            model: modelOverride || providerRow.model,
            label: providerRow.label
        });

        const pageRow = this.db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId);
        const variables = {
            video_title: videoContext.videoTitle || '',
            video_desc: videoContext.videoDesc || '',
            niche: pageRow?.niche || '',
            page_name: pageRow?.name || '',
            clip_duration: videoContext.duration || 0,
            channel_label: videoContext.channelLabel || '',
            source_url: videoContext.sourceUrl || ''
        };
        const userPrompt = provider.buildPrompt(wUser || 'เขียนแคปชั่น Reel สั้นๆ ภาษาไทย ให้น่าคลิก สำหรับคลิป "{video_title}" จากช่อง "{channel_label}" — ใส่อิโมจิ + แฮชแท็กที่เกี่ยวข้อง', variables);
        const guardedSystemPrompt =
            'ตอบกลับเฉพาะข้อความแคปชั่นที่เสร็จสมบูรณ์เท่านั้น ห้ามขึ้นต้นด้วย "คุณคือ/คุณเป็น/You are" ห้ามใส่กฎ/ข้อกำหนด ให้ส่งเฉพาะแคปชั่นที่พร้อมโพสต์ FB ทันที\n\n' +
            (wSystem || 'คุณคือผู้เชี่ยวชาญเขียนแคปชั่น Reel ภาษาไทย — กระชับ ดึงดูด ใช้อิโมจิและแฮชแท็ก ไม่เกิน 8 บรรทัด');

        const maxTokens = parseInt(getSetting('watcher_caption_max_tokens') || '300', 10);
        const baseTemp = parseFloat(getSetting('watcher_caption_temperature') || '0.85');

        const MAX_ATTEMPTS = 2;
        let lastErr = null;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const t = Math.min(1.5, baseTemp + attempt * 0.2);
            try {
                const caption = await provider.generateCaption({
                    systemPrompt: guardedSystemPrompt,
                    userPrompt, maxTokens, temperature: t
                });
                const rejection = CaptionService.detectPromptEcho(caption, wSystem);
                if (rejection) {
                    console.warn(`[captionService:watcher] attempt ${attempt + 1} rejected: ${rejection}`);
                    continue;
                }
                return caption.trim();
            } catch (e) { lastErr = e; }
        }
        console.error('[captionService:watcher] all attempts failed:', lastErr?.message);
        return this.fallbackTemplate(videoContext);
    }

    // Heuristic: detect AI response that's actually echoing back the system prompt /
    // rules instead of writing a caption. Returns a reason string if suspicious, null if OK.
    static detectPromptEcho(caption, systemPrompt) {
        if (!caption || typeof caption !== 'string') return 'empty';
        const s = caption.trim();
        if (s.length < 5) return 'too short';
        if (s.length > 2200) return 'too long (> 2200 chars — FB won\'t accept)';

        // Starts with "You are..." / "คุณคือ..." / "คุณเป็น..." — classic prompt-echo pattern
        if (/^(คุณคือ|คุณเป็น|You are|You're|Act as|จงเขียน|ต่อไปนี้คือ|Here are the rules|กฎ|Rules:)/i.test(s)) {
            return 'starts with role-definition phrase';
        }
        // Contains MANY numbered instruction items (5+) in a row ("1. ... 2. ... 3. ...").
        // Legit captions may have "3 เหตุผลที่ต้องดู" so allow up to 4 — rules lists usually 5+.
        const numberedListItems = (s.match(/\n\s*\d+\.\s+\S/g) || []).length;
        if (numberedListItems >= 5) {
            return `contains ${numberedListItems} numbered instructions (looks like rules list)`;
        }
        // If response and system prompt share a very long common prefix, it's echoing.
        if (systemPrompt && systemPrompt.length > 60) {
            const firstLine = systemPrompt.split('\n')[0].trim();
            if (firstLine.length > 20 && s.includes(firstLine)) {
                return 'contains verbatim line from system prompt';
            }
        }
        return null;
    }

    fallbackTemplate(ctx) {
        const title = (ctx.videoTitle || 'ซีรีส์น่าดู').slice(0, 100);
        const num = ctx.clipNumber ? ` EP.${ctx.clipNumber}` : '';
        return `${title}${num} 🎬\nดูต่อในคอมเมนต์ได้เลย #ซีรีส์จีน #ดูฟรี`;
    }

    addProvider(providerType, apiKey, model, label) {
        const stmt = this.db.prepare(`
            INSERT INTO ai_providers (provider, api_key, model, label)
            VALUES (?, ?, ?, ?)
        `);
        return stmt.run(providerType, encrypt(apiKey), model, label).lastInsertRowid;
    }

    listProviders() {
        return this.db.prepare('SELECT id, provider, model, label, enabled FROM ai_providers WHERE enabled = 1').all();
    }
}

module.exports = {
    CaptionService,
    CAPTION_MODELS,
    estimateCaptionCost,
    createProvider,
    OpenAIProvider,
    AnthropicProvider,
    GeminiProvider,
    encrypt,
    decrypt
};
