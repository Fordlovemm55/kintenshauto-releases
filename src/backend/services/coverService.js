/**
 * AI Cover Image Generator for Facebook Reels (9:16)
 *
 * Supports multiple image-gen providers — auto-picks based on which API key
 * is configured and which model the user selected in settings.
 *
 *   OpenAI:  DALL-E 3 (standard)     — 1024×1792, ~$0.04
 *   OpenAI:  DALL-E 3 (HD)           — 1024×1792, ~$0.08 (higher quality)
 *   Google:  Imagen 3                 — 1024×1792, ~$0.03
 *   Google:  Imagen 3 Fast           — 1024×1792, ~$0.02
 *   Google:  Gemini 2.5 Flash Image   — multi-modal, ~$0.039
 *
 * Falls back to an FFmpeg-extracted video frame if no key / all attempts fail.
 *
 * Output: 1080×1920 PNG in the clips directory.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { decrypt } = require('./captionService');

// Baked-in default system prompt matching the user's exact spec for Reel covers
const DEFAULT_SYSTEM_PROMPT = `คุณคือผู้เชี่ยวชาญด้านการออกแบบปก Facebook Reel (9:16) สำหรับสปอยหนังและซีรีส์

กฎเหล็กที่ต้องปฏิบัติตามอย่างเคร่งครัด:

1. การวิเคราะห์แนวเรื่อง — สำคัญที่สุด:
   - ให้ยึด "ชื่อเรื่อง" และ "รูปต้นฉบับ" (ถ้ามี) เป็นหลัก อย่าเชื่อ niche ของเพจเกินไป
     (เพจแนว "ซีรีย์จีน" ไม่ได้แปลว่าทุกคลิปเป็นจีน · บางคลิปเป็นฝรั่ง/เกาหลี/ญี่ปุ่น)
   - ถ้าชื่อเรื่องมีคำว่า "ฝรั่ง / ฮอลลีวูด / อเมริกัน / ยุโรป / Western" → สไตล์โปสเตอร์ฮอลลีวูดฟอร์มยักษ์ (ห้ามจีน)
   - ถ้าชื่อเรื่องมีคำว่า "เกาหลี / K-drama / KDrama / โอปป้า" → สไตล์ซีรีย์เกาหลีโรแมนติก (ห้ามจีน)
   - ถ้าชื่อเรื่องมีคำว่า "ญี่ปุ่น / Japanese / Japan / อนิเมะ" → สไตล์ญี่ปุ่น (ห้ามจีน)
   - ถ้าชื่อเรื่องมีคำว่า "ไทย / Thai / ละครไทย" → สไตล์ละครไทย
   - ถ้าชื่อเรื่องมีคำว่า "จีน / ซีรีย์จีน / เทพเซียน / กำลังภายใน / ย้อนยุค" → สไตล์จีนโบราณ
   - ถ้าไม่แน่ใจ → ยึดรูปต้นฉบับเป็นหลัก ดูเสื้อผ้า/ฉาก/หน้าตัวละคร

2. สไตล์ภาพ: ตัวละครต้องเป็น "คนจริง (Photorealistic)" เท่านั้น
   - ห้ามการ์ตูน ห้ามภาพวาด
   - เชื้อชาติตัวละครต้องตรงกับแนว (ฝรั่ง=คอเคเซียน · จีน=เอเชียตะวันออก · ฝรั่ง=คอเคเซียน)

3. ภาษาไทย: ตัวหนังสือไทยในรูปต้องสะกดถูก 100% ไม่เพี้ยน ไม่เบลอ อ่านง่ายเด่นชัด

4. องค์ประกอบปก:
   - มีคำโปรย: "พากย์ไทย / จัดเต็มครบทุกตอน / ดูฟรี HD 4K" ในจุดที่เห็นชัด
   - อัตราส่วน 9:16 สำหรับ Reel
   - ห้ามใส่ปุ่ม Play (ไอคอนวิดีโอ) ในรูปเด็ดขาด`;

// Detect genre from title using keyword patterns. Returns a canonical label + confidence.
// Called BEFORE sending to AI so we can pass an explicit hint to override a wrong niche.
function detectGenreFromTitle(title) {
    if (!title) return null;
    const t = String(title).toLowerCase();
    // Pattern order matters — check stronger signals first
    // Western / Hollywood
    if (/ฝรั่ง|hollywood|western|american|british|europ|ยุโรป|อเมริก|อังกฤษ/i.test(t)) {
        return { genre: 'western', th: 'ซีรีย์ฝรั่ง / ฮอลลีวูด', style: 'โปสเตอร์ฮอลลีวูดฟอร์มยักษ์ ตัวละครคอเคเซียน' };
    }
    // Korean
    if (/เกาหลี|korean|\bk-?drama\b|โอปป้า|oppa/i.test(t)) {
        return { genre: 'korean', th: 'ซีรีย์เกาหลี', style: 'ซีรีย์เกาหลีโรแมนติก ตัวละครเอเชียเกาหลี' };
    }
    // Japanese
    if (/ญี่ปุ่น|japanese|\bjapan\b|\bjdrama\b|อนิเมะ|anime/i.test(t)) {
        return { genre: 'japanese', th: 'หนัง/ซีรีย์ญี่ปุ่น', style: 'สไตล์ญี่ปุ่น ตัวละครเอเชียญี่ปุ่น' };
    }
    // Thai
    if (/\bไทย\b|\bthai\b|ละครไทย|tdrama/i.test(t)) {
        return { genre: 'thai', th: 'ละครไทย', style: 'ละครไทยสมจริง ตัวละครคนไทย' };
    }
    // Chinese — MUST come after the others so "[ซับไทย]" doesn't match as "thai" etc,
    // but also so "ซีรีย์ฝรั่ง" in a cn-configured page isn't misread as chinese.
    if (/จีน|chinese|\bcdrama\b|เทพเซียน|กำลังภายใน|ย้อนยุค|หวงเอ้อ|ฮ่องเต้|บู๊เฮี๊ยบ/i.test(t)) {
        return { genre: 'chinese', th: 'ซีรีย์จีน', style: 'สไตล์จีน ตัวละครเอเชียจีน' };
    }
    return null;
}

// Registry of supported cover-generation models, each with the provider that
// serves it and estimated price per image. The UI picks from this list.
//
// Ordering matters: displayed top → bottom in the UI picker, and the
// auto-select picks the first AVAILABLE model in this order when user has
// multiple providers configured.
const COVER_MODELS = {
    // --- OpenAI ---
    'dall-e-3':                { provider: 'openai',    label: 'DALL-E 3 (standard)',  priceUSD: 0.040 },
    'dall-e-3-hd':             { provider: 'openai',    label: 'DALL-E 3 (HD)',         priceUSD: 0.080 },
    'gpt-image-1':             { provider: 'openai',    label: 'GPT-Image-1',           priceUSD: 0.040 },

    // --- Google Imagen 4 (ใหม่ล่าสุด · Jan 2026) ---
    'imagen-4.0-ultra-generate-001': { provider: 'gemini', label: 'Imagen 4 Ultra (คุณภาพสูงสุด)', priceUSD: 0.060 },
    'imagen-4.0-generate-001':       { provider: 'gemini', label: 'Imagen 4',               priceUSD: 0.040 },
    'imagen-4.0-fast-generate-001':  { provider: 'gemini', label: 'Imagen 4 Fast',          priceUSD: 0.020 },

    // --- Google Imagen 3 (stable, ตัวเก่ากว่า) ---
    'imagen-3.0-generate-001':       { provider: 'gemini', label: 'Imagen 3',               priceUSD: 0.030 },
    'imagen-3.0-fast-generate-001':  { provider: 'gemini', label: 'Imagen 3 Fast',          priceUSD: 0.020 },

    // --- Google Nano Banana / Gemini Flash Image (multi-modal · รองรับ image-to-image) ---
    // "Nano Banana" คือชื่อเรียกไม่เป็นทางการของ Gemini Flash Image ของ Google
    // Pro = รุ่นใหม่กว่า คุณภาพสูงกว่า · ธรรมดา = เร็ว ถูกกว่า
    'gemini-3-pro-image-preview':     { provider: 'gemini', label: '🍌 Nano Banana Pro (Gemini 3 · คุณภาพสูงสุด)', priceUSD: 0.120 },
    'gemini-2.5-flash-image':         { provider: 'gemini', label: '🍌 Nano Banana (Gemini 2.5 Flash Image)', priceUSD: 0.039 },
    'gemini-2.5-flash-image-preview': { provider: 'gemini', label: '🍌 Nano Banana · preview',               priceUSD: 0.039 }
};

class CoverService {
    constructor(db, opts = {}) {
        this.db = db;
        this._ffmpegOverride = opts.ffmpegPath;
        this.clipsDir = opts.clipsDir;
    }

    // Resolve at call time so user-changed env vars take effect immediately
    get ffmpegPath() {
        return this._ffmpegOverride || process.env.KINTENSHAUTO_FFMPEG || 'ffmpeg';
    }

    // Lookup the API key for a specific provider. Returns null if not configured.
    _getProviderKey(providerName) {
        const row = this.db.prepare(
            `SELECT api_key, model FROM ai_providers WHERE provider = ? ORDER BY id ASC LIMIT 1`
        ).get(providerName);
        if (!row) return null;
        try { return { apiKey: decrypt(row.api_key), model: row.model }; }
        catch { return null; }
    }

    // Decide which cover model to use based on user's saved preference + available keys.
    // Priority:
    //   1. Explicit user setting (settings.cover_model) — if the provider has a key
    //   2. First available provider (Gemini → OpenAI order)
    //   3. null → fall back to frame extraction
    _resolveModel() {
        let preferredModel = null;
        try {
            const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'cover_model'`).get();
            if (row?.value && COVER_MODELS[row.value]) preferredModel = row.value;
        } catch {}

        if (preferredModel) {
            const info = COVER_MODELS[preferredModel];
            if (this._getProviderKey(info.provider)) return { model: preferredModel, ...info };
        }

        // Auto-fallback priority (if user didn't explicitly pick a model):
        //   1. Gemini configured → Imagen 4 (newest, good quality/price balance)
        //   2. OpenAI configured → DALL-E 3 standard
        //   3. Gemini only  → Imagen 3 as safer older fallback
        const hasGemini = !!this._getProviderKey('gemini');
        const hasOpenAI = !!this._getProviderKey('openai');

        if (hasGemini) {
            const m = 'imagen-4.0-generate-001';
            return { model: m, ...COVER_MODELS[m] };
        }
        if (hasOpenAI) {
            const m = 'dall-e-3';
            return { model: m, ...COVER_MODELS[m] };
        }
        return null;
    }

    _getGlobalPrompt() {
        try {
            const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'cover_prompt_default'`).get();
            if (row?.value && row.value.trim()) return row.value;
        } catch {}
        return DEFAULT_SYSTEM_PROMPT;
    }

    _buildPrompt({ videoTitle, niche, clipIndex, totalClips, pageOverridePrompt, searchKeyword, referenceDescription }) {
        // Priority: per-page override > global custom > factory default
        const tpl = (pageOverridePrompt && pageOverridePrompt.trim())
            ? pageOverridePrompt
            : this._getGlobalPrompt();
        const heading = `[TASK] สร้างภาพปก Facebook Reel (9:16) คุณภาพสูงสำหรับเรื่องนี้`;

        // Auto-detect genre from title. This becomes an AUTHORITATIVE instruction that
        // overrides the page niche — prevents the "page is 'ซีรีย์จีน' but this clip is
        // ฝรั่ง" bug where AI generated a Chinese cover for a western show.
        const titleGenre = detectGenreFromTitle(videoTitle);
        const keywordGenre = detectGenreFromTitle(searchKeyword);
        // Title wins if both exist; else whichever is non-null
        const detected = titleGenre || keywordGenre;

        const contextLines = [`ชื่อเรื่อง: "${videoTitle || 'ไม่ระบุ'}"`];
        if (detected) {
            contextLines.push(
                `🎯 แนวเรื่องที่ระบบตรวจจับได้จากชื่อเรื่อง: ${detected.th}`,
                `   → ต้องสร้างปกเป็นสไตล์: ${detected.style}`,
                `   → ห้ามสร้างเป็นแนวอื่นแม้ niche ของเพจจะต่างจากนี้`
            );
        }
        if (niche) {
            if (detected) {
                // niche becomes a weak background hint — explicitly downgraded
                contextLines.push(`(niche ของเพจคือ "${niche}" — แต่เรื่องนี้เป็นคนละแนว ให้ยึดชื่อเรื่องข้างบนเป็นหลัก)`);
            } else {
                // no genre detected from title → fall back to niche
                contextLines.push(`แนวเนื้อหาของเพจ (ใช้เป็นแนวทางเมื่อชื่อเรื่องไม่ชัดเจน): ${niche}`);
            }
        }
        if (searchKeyword && !keywordGenre) {
            contextLines.push(`คำค้นที่ผู้ใช้ใช้หาเรื่องนี้: "${searchKeyword}"`);
        }
        if (clipIndex && totalClips) {
            contextLines.push(`ตอนที่ ${clipIndex} จาก ${totalClips}`);
        }

        let context = contextLines.join('\n');
        if (referenceDescription) {
            context += `\n\n[คำบรรยายจากภาพต้นฉบับของเรื่องนี้ — ใช้เป็น SOURCE OF TRUTH สูงสุด สำหรับเชื้อชาติ/เสื้อผ้า/ฉาก]:\n${referenceDescription}`;
        }
        return `${heading}\n${context}\n\n${tpl}`;
    }

    // Ask Gemini Flash (cheap text model) to describe what's in the reference thumbnail.
    // Used for text-only image-gen providers (DALL-E, Imagen) so they still get a rich
    // description of the actual show characters/setting even without image-to-image.
    async _describeReferenceImage(referenceImagePath) {
        const geminiKey = this._getProviderKey('gemini');
        if (!geminiKey?.apiKey) return null;
        try {
            const buf = fs.readFileSync(referenceImagePath);
            const mime = /\.png$/i.test(referenceImagePath) ? 'image/png' :
                         /\.webp$/i.test(referenceImagePath) ? 'image/webp' : 'image/jpeg';
            const body = {
                contents: [{
                    parts: [
                        { text: `ดูรูปนี้แล้วบอกข้อมูลต่อไปนี้เป็นภาษาไทย สั้นๆ ชัดเจน (รวมไม่เกิน 4 บรรทัด):

1. เชื้อชาติตัวละคร: คอเคเซียน/ฝรั่ง, เอเชียจีน, เกาหลี, ญี่ปุ่น, ไทย, หรืออื่นๆ — ต้องตอบให้ชัด (สำคัญมาก)
2. แนวเรื่อง: ซีรีย์จีนย้อนยุค / ซีรีย์จีนปัจจุบัน / ฝรั่งฮอลลีวูด / เกาหลีโรแมนติก / ญี่ปุ่น / ไทย / อื่นๆ
3. เสื้อผ้า / ยุคสมัย: ย้อนยุค, ปัจจุบัน, สูท, เครื่องแบบ, ชุดแต่งงาน ฯลฯ
4. อารมณ์/ฉาก: 1 วลีสั้นๆ (เช่น "งานแต่งหรูในโบสถ์ฝรั่งเศส")

ห้ามอธิบายว่ารูปเป็นปก/โปสเตอร์ — ให้บอกเฉพาะว่า "เนื้อเรื่อง" เป็นแนวอะไร` },
                        { inline_data: { mime_type: mime, data: buf.toString('base64') } }
                    ]
                }],
                generationConfig: { maxOutputTokens: 300, temperature: 0.2 }
            };
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(geminiKey.apiKey)}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!res.ok) return null;
            const data = await res.json();
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            return text || null;
        } catch (err) {
            console.warn('[coverService] describe reference failed:', err.message);
            return null;
        }
    }

    // ---------- Provider-specific image generators ----------

    // OpenAI DALL-E 3 (also handles hd variant + gpt-image-1 which uses same endpoint)
    async _genOpenAI(apiKey, model, prompt) {
        const quality = model === 'dall-e-3-hd' ? 'hd' : 'standard';
        const realModel = model === 'dall-e-3-hd' ? 'dall-e-3' : model;
        const body = {
            model: realModel,
            prompt: prompt.slice(0, 3900),
            size: '1024x1792',    // closest to 9:16 DALL-E supports
            quality,
            n: 1,
            response_format: 'b64_json'
        };
        const res = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            const err = await res.text().catch(() => res.statusText);
            throw new Error(`OpenAI ${model} HTTP ${res.status}: ${err.slice(0, 300)}`);
        }
        const data = await res.json();
        const b64 = data?.data?.[0]?.b64_json;
        if (!b64) throw new Error('OpenAI response missing b64_json');
        return Buffer.from(b64, 'base64');
    }

    // Google Imagen 3 via Gemini API (REST)
    async _genImagen(apiKey, model, prompt) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${encodeURIComponent(apiKey)}`;
        const body = {
            instances: [{ prompt: prompt.slice(0, 2000) }],
            parameters: {
                sampleCount: 1,
                aspectRatio: '9:16'
            }
        };
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            const err = await res.text().catch(() => res.statusText);
            throw new Error(`Imagen HTTP ${res.status}: ${err.slice(0, 300)}`);
        }
        const data = await res.json();
        const b64 = data?.predictions?.[0]?.bytesBase64Encoded;
        if (!b64) throw new Error('Imagen response missing image bytes');
        return Buffer.from(b64, 'base64');
    }

    // Gemini 2.5 Flash Image (multi-modal — text + optional image input + image output).
    // Google's API requires responseModalities: ['TEXT', 'IMAGE'] (both) or sometimes
    // just ['IMAGE']. We try the most-permissive first, then fall back.
    // Also: the model name has changed a few times — we try known variants if the
    // preferred one returns 404.
    async _genGeminiFlashImage(apiKey, model, prompt, referenceImagePath) {
        const parts = [{ text: prompt.slice(0, 3000) }];
        if (referenceImagePath && fs.existsSync(referenceImagePath)) {
            try {
                const buf = fs.readFileSync(referenceImagePath);
                const mime = /\.png$/i.test(referenceImagePath) ? 'image/png' :
                             /\.webp$/i.test(referenceImagePath) ? 'image/webp' : 'image/jpeg';
                parts.push({ inline_data: { mime_type: mime, data: buf.toString('base64') } });
            } catch (err) {
                console.warn('[coverService] could not attach reference image:', err.message);
            }
        }

        // Fallback model names in order — the API evolves, so try known variants.
        // "Nano Banana" family:
        //   • gemini-3-pro-image-preview  = Nano Banana Pro (newest, highest quality)
        //   • gemini-2.5-flash-image      = Nano Banana (standard, faster)
        //   • gemini-2.5-flash-image-preview = Nano Banana preview variant
        const modelCandidates = [
            model,
            'gemini-3-pro-image-preview',          // Nano Banana Pro
            'gemini-2.5-flash-image-preview',      // Nano Banana preview
            'gemini-2.5-flash-image',              // Nano Banana
            'gemini-2.0-flash-preview-image-generation'
        ].filter((m, i, arr) => arr.indexOf(m) === i);   // dedupe

        // Try modality config variations — some models want both TEXT and IMAGE
        const modalityConfigs = [
            { responseModalities: ['TEXT', 'IMAGE'] },
            { responseModalities: ['IMAGE'] }
        ];

        const errors = [];
        for (const tryModel of modelCandidates) {
            for (const cfg of modalityConfigs) {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${tryModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
                const body = {
                    contents: [{ parts }],
                    generationConfig: cfg
                };
                try {
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    if (!res.ok) {
                        const errText = await res.text().catch(() => res.statusText);
                        errors.push(`${tryModel}/${cfg.responseModalities.join('+')} → ${res.status}: ${errText.slice(0, 200)}`);
                        // If it's a model-not-found error, try next model immediately
                        if (res.status === 404) break;
                        continue;
                    }
                    const data = await res.json();
                    const respParts = data?.candidates?.[0]?.content?.parts || [];
                    for (const p of respParts) {
                        if (p.inlineData?.data) return Buffer.from(p.inlineData.data, 'base64');
                        if (p.inline_data?.data) return Buffer.from(p.inline_data.data, 'base64');
                    }
                    // Response OK but no image data — surface the text part so user sees why
                    const textPart = respParts.find(p => p.text)?.text || JSON.stringify(data).slice(0, 300);
                    errors.push(`${tryModel}/${cfg.responseModalities.join('+')} → 200 but no image: ${textPart.slice(0, 200)}`);
                } catch (err) {
                    errors.push(`${tryModel}/${cfg.responseModalities.join('+')} → network error: ${err.message}`);
                }
            }
        }
        throw new Error(`Gemini Flash Image failed all attempts:\n${errors.join('\n').slice(0, 600)}`);
    }

    // Dispatch to the right backend based on model name.
    // referenceImagePath is only used by image-to-image capable models (Gemini Flash Image).
    async _generateImage(model, providerKey, prompt, referenceImagePath) {
        const info = COVER_MODELS[model];
        if (!info) throw new Error(`unknown cover model: ${model}`);
        if (info.provider === 'openai') return this._genOpenAI(providerKey, model, prompt);
        if (info.provider === 'gemini') {
            if (model.startsWith('imagen-')) return this._genImagen(providerKey, model, prompt);
            return this._genGeminiFlashImage(providerKey, model, prompt, referenceImagePath);
        }
        throw new Error(`no generator for provider: ${info.provider}`);
    }

    // ---------- Resize + fallback ----------

    async _resizeTo9by16(srcPath, dstPath) {
        await new Promise((resolve, reject) => {
            execFile(this.ffmpegPath, [
                '-y',
                '-i', srcPath,
                '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
                '-frames:v', '1',
                dstPath
            ], { timeout: 30000 }, (err, _stdout, stderr) => {
                if (err) { err.stderr = stderr; reject(err); }
                else resolve();
            });
        });
    }

    async extractFrameCover(videoPath, outPath) {
        await new Promise((resolve, reject) => {
            execFile(this.ffmpegPath, [
                '-y',
                '-ss', '00:00:03',
                '-i', videoPath,
                '-vframes', '1',
                '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
                '-q:v', '2',
                outPath
            ], { timeout: 30000 }, (err, _stdout, stderr) => {
                if (err) { err.stderr = stderr; reject(err); }
                else resolve();
            });
        });
        return outPath;
    }

    /**
     * Public API.
     * Tries the user's configured model; on failure falls through to a frame extract
     * so posting never blocks on cover generation alone.
     */
    async generateCover({ videoPath, videoTitle, niche, clipIndex, totalClips, pageOverridePrompt,
                          searchKeyword, referenceImagePath, outPath, skipFallback }) {
        if (!outPath) throw new Error('generateCover: outPath required');

        const resolved = this._resolveModel();

        // Step 1: If the resolved model is TEXT-ONLY (DALL-E/Imagen) AND we have a reference
        // thumbnail, ask Gemini Flash (cheap) to describe it first. This gives the image
        // generator much better context about what the actual show looks like.
        let referenceDescription = null;
        // Nano Banana family (Gemini Flash Image + Gemini 3 Pro Image) are multi-modal
        // and accept image input — they do image-to-image natively, so we skip the
        // extra describe-reference step and pass the raw thumbnail directly.
        const isImageToImageCapable = resolved && (
            resolved.model === 'gemini-2.5-flash-image-preview' ||
            resolved.model === 'gemini-2.5-flash-image' ||
            resolved.model === 'gemini-3-pro-image-preview'
        );
        if (resolved && !isImageToImageCapable && referenceImagePath && fs.existsSync(referenceImagePath)) {
            try {
                referenceDescription = await this._describeReferenceImage(referenceImagePath);
                if (referenceDescription) {
                    console.log(`[coverService] enriched prompt with reference description: "${referenceDescription.slice(0, 100)}..."`);
                }
            } catch {}
        }

        const prompt = this._buildPrompt({
            videoTitle, niche, clipIndex, totalClips, pageOverridePrompt,
            searchKeyword, referenceDescription
        });

        if (resolved) {
            const providerKey = this._getProviderKey(resolved.provider);
            if (providerKey?.apiKey) {
                try {
                    // Pass reference image to the generator — Gemini Flash Image uses it as
                    // actual image-to-image input; other models ignore it (they got the
                    // description from describe-step above instead).
                    const buf = await this._generateImage(resolved.model, providerKey.apiKey, prompt, referenceImagePath);
                    const tmp = outPath + '.tmp.png';
                    fs.writeFileSync(tmp, buf);
                    await this._resizeTo9by16(tmp, outPath);
                    try { fs.unlinkSync(tmp); } catch {}
                    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 20 * 1024) {
                        throw new Error('resized cover is too small (< 20 KB)');
                    }
                    return {
                        path: outPath,
                        source: resolved.model,
                        provider: resolved.provider,
                        priceUSD: resolved.priceUSD,
                        usedReference: !!referenceImagePath,
                        usedDescription: !!referenceDescription
                    };
                } catch (err) {
                    console.warn(`[coverService] ${resolved.model} failed, trying frame extract:`, err.message);
                }
            }
        } else {
            console.log('[coverService] no API key configured — using frame extraction');
        }

        // Fallback: grab a frame from the video itself
        if (skipFallback || !videoPath) {
            throw new Error('สร้าง cover ไม่สำเร็จ — AI ไม่ตอบสนอง และไม่มีวิดีโอให้ fallback');
        }
        try {
            await this.extractFrameCover(videoPath, outPath);
            if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10 * 1024) {
                return { path: outPath, source: 'frame-extract', provider: 'ffmpeg', priceUSD: 0 };
            }
            throw new Error('extracted frame too small or missing');
        } catch (err) {
            console.error('[coverService] frame extraction also failed:', err.message);
            throw new Error(`สร้าง cover ไม่สำเร็จ: ${err.message}`);
        }
    }
}

module.exports = {
    CoverService,
    COVER_MODELS,
    DEFAULT_COVER_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT
};
