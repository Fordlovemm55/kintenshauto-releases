/**
 * Banner Layer System - รองรับ layers ไม่จำกัด
 *
 * Layer config structure (เก็บใน banner_presets.layers_json):
 * {
 *   banner_id: number,          // FK ไป banners.id
 *   z_index: number,            // ยิ่งมาก ยิ่งอยู่บน
 *   position: { x: 0-100, y: 0-100 },     // % ของ frame
 *   size: { width: 10-100 },              // % ของ frame width
 *   opacity: 0-100,
 *   rotation: -180 to 180,
 *   timing: {
 *     start: seconds,
 *     end: seconds or -1 (ตลอดคลิป),
 *     fade_in: ms,
 *     fade_out: ms
 *   }
 * }
 */

const path = require('path');
const { execFile } = require('child_process');
const Database = require('better-sqlite3');

// ============================================================
// Validation
// ============================================================
function validateLayer(layer) {
    const errors = [];
    if (!layer.banner_id) errors.push('banner_id required');
    if (layer.position?.x < 0 || layer.position?.x > 100) errors.push('x must be 0-100');
    if (layer.position?.y < 0 || layer.position?.y > 100) errors.push('y must be 0-100');
    if (layer.size?.width < 1 || layer.size?.width > 100) errors.push('width must be 1-100');
    if (layer.opacity < 0 || layer.opacity > 100) errors.push('opacity must be 0-100');
    return errors;
}

function normalizeLayer(layer) {
    return {
        banner_id: layer.banner_id,
        z_index: layer.z_index ?? 0,
        position: {
            x: layer.position?.x ?? 50,
            y: layer.position?.y ?? 50
        },
        size: {
            width: layer.size?.width ?? 30
        },
        opacity: layer.opacity ?? 100,
        rotation: layer.rotation ?? 0,
        timing: {
            start: layer.timing?.start ?? 0,
            end: layer.timing?.end ?? -1,
            fade_in: layer.timing?.fade_in ?? 0,
            fade_out: layer.timing?.fade_out ?? 0
        }
    };
}

// ============================================================
// FFmpeg Command Builder
// ============================================================
class BannerFFmpegBuilder {
    constructor(dbPath) {
        this.db = dbPath instanceof Database ? dbPath : new Database(dbPath);
        this.db.pragma('foreign_keys = ON');   // ✅ FIX H1: per-connection cascade enable
    }

    getBanner(bannerId) {
        return this.db.prepare('SELECT * FROM banners WHERE id = ?').get(bannerId);
    }

    /**
     * สร้าง FFmpeg filter_complex สำหรับ layers ไม่จำกัด
     *
     * @param {string} inputVideo - path คลิปต้นฉบับ
     * @param {Array} layers - array ของ layer configs
     * @param {object} options - { outputWidth, outputHeight, outputPath }
     * @returns {object} { args: [...], outputPath }
     */
    buildCommand(inputVideo, layers, options = {}) {
        const outW = options.outputWidth || 1080;
        const outH = options.outputHeight || 1920;
        const outputPath = options.outputPath;

        const sortedLayers = [...layers].sort((a, b) => a.z_index - b.z_index);

        const args = ['-y', '-i', inputVideo];

        for (const layer of sortedLayers) {
            const banner = this.getBanner(layer.banner_id);
            if (!banner) {
                console.warn(`Banner ${layer.banner_id} not found, skipping layer`);
                continue;
            }
            args.push('-i', banner.file_path);
        }

        const filters = [];
        filters.push(`[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:black[base0]`);

        let currentLabel = 'base0';
        let validLayerIndex = 0;

        for (let i = 0; i < sortedLayers.length; i++) {
            const layer = sortedLayers[i];
            const banner = this.getBanner(layer.banner_id);
            if (!banner) continue;

            const inputIdx = validLayerIndex + 1;
            const bannerLabel = `bn${validLayerIndex}`;
            const outLabel = (i === sortedLayers.length - 1) ? 'vout' : `tmp${validLayerIndex}`;

            const targetWidth = Math.round(outW * layer.size.width / 100);
            filters.push(`[${inputIdx}:v]scale=${targetWidth}:-1[${bannerLabel}_scaled]`);

            let bnChain = `${bannerLabel}_scaled`;

            if (layer.rotation !== 0) {
                const rad = (layer.rotation * Math.PI) / 180;
                filters.push(`[${bnChain}]rotate=${rad}:c=none:ow=rotw(${rad}):oh=roth(${rad})[${bannerLabel}_rot]`);
                bnChain = `${bannerLabel}_rot`;
            }

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
            validLayerIndex++;
        }

        if (currentLabel !== 'vout') {
            filters.push(`[${currentLabel}]null[vout]`);
        }

        args.push('-filter_complex', filters.join(';'));
        args.push('-map', '[vout]');
        args.push('-map', '0:a?');
        args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '23');
        args.push('-c:a', 'aac', '-b:a', '128k');
        args.push('-movflags', '+faststart');
        args.push(outputPath);

        return { args, outputPath };
    }

    /**
     * Execute FFmpeg — resolve binary at call time so user-changed paths
     * (or main process env vars) take effect without restart.
     */
    async render(inputVideo, layers, options) {
        const { args, outputPath } = this.buildCommand(inputVideo, layers, options);
        const ffmpegBin = process.env.KINTENSHAUTO_FFMPEG || 'ffmpeg';

        return new Promise((resolve, reject) => {
            execFile(ffmpegBin, args, { maxBuffer: 1024 * 1024 * 10, windowsHide: true }, (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(`FFmpeg failed: ${stderr || err.message}`));
                } else {
                    resolve({ outputPath, stderr });
                }
            });
        });
    }
}

// ============================================================
// Preset Service
// ============================================================
class BannerPresetService {
    constructor(dbPath) {
        this.db = dbPath instanceof Database ? dbPath : new Database(dbPath);
        this.db.pragma('foreign_keys = ON');   // ✅ FIX H1: per-connection cascade enable
    }

    savePreset(name, layers) {
        for (const layer of layers) {
            const errors = validateLayer(layer);
            if (errors.length) {
                throw new Error(`Layer validation failed: ${errors.join(', ')}`);
            }
        }

        const normalized = layers.map(normalizeLayer);
        const stmt = this.db.prepare(`
            INSERT INTO banner_presets (name, layers_json)
            VALUES (?, ?)
        `);
        return stmt.run(name, JSON.stringify(normalized)).lastInsertRowid;
    }

    getPreset(id) {
        const row = this.db.prepare('SELECT * FROM banner_presets WHERE id = ?').get(id);
        if (!row) return null;
        let layers = [];
        try { layers = JSON.parse(row.layers_json) || []; }
        catch (e) { console.warn('[banner-preset]', id, 'parse failed:', e.message); }
        return { ...row, layers };
    }

    listPresets() {
        const rows = this.db.prepare('SELECT * FROM banner_presets ORDER BY created_at DESC').all();
        return rows.map(r => {
            let layers = [];
            try { layers = JSON.parse(r.layers_json) || []; }
            catch (e) { console.warn('[banner-preset]', r.id, 'parse failed:', e.message); }
            return { ...r, layers };
        });
    }

    updatePreset(id, name, layers) {
        const normalized = layers.map(normalizeLayer);
        this.db.prepare(`
            UPDATE banner_presets SET name = ?, layers_json = ? WHERE id = ?
        `).run(name, JSON.stringify(normalized), id);
    }

    deletePreset(id) {
        this.db.prepare('DELETE FROM banner_presets WHERE id = ?').run(id);
    }
}

module.exports = {
    BannerFFmpegBuilder,
    BannerPresetService,
    validateLayer,
    normalizeLayer
};
