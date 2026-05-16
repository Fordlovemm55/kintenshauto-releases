/**
 * Icon generator — pure Node, no deps.
 * Creates samurai-themed gold-on-dark icons (icon.ico, icon.png, tray-icon.png)
 * if they don't already exist in assets/.
 *
 * The user can drop their own icons into assets/ and this script will skip
 * regeneration. Uses standard PNG format wrapped in ICO with multiple sizes.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

const TARGETS = {
    'icon.ico':       { type: 'ico', sizes: [16, 32, 48, 64, 128, 256] },
    'icon.png':       { type: 'png', size: 256 },
    'tray-icon.png':  { type: 'png', size: 32 },
    'icon.icns':      { type: 'icns', sizes: [16, 32, 64, 128, 256, 512] }
};

function allExist() {
    for (const name of Object.keys(TARGETS)) {
        const p = path.join(ASSETS_DIR, name);
        if (name === 'icon.icns' && process.platform !== 'darwin') continue;
        if (!fs.existsSync(p)) return false;
    }
    return true;
}

if (allExist()) {
    console.log('[icons] all icon files exist — skipping regeneration');
    process.exit(0);
}

// ---- CRC32 (PNG chunks need it) ----
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
}

// Samurai theme: dark crimson background, gold sword ✚ pattern
function samuraiPixel(x, y, size) {
    const cx = size / 2, cy = size / 2;
    const dx = x - cx, dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const borderPx = Math.max(1, Math.floor(size * 0.04));
    const isBorder = x < borderPx || x >= size - borderPx || y < borderPx || y >= size - borderPx;

    const bladeWidth = Math.max(1, Math.floor(size * 0.05));
    const guardWidth = Math.max(1, Math.floor(size * 0.05));
    const guardLen = Math.floor(size * 0.32);

    const isVerticalBlade = Math.abs(dx) < bladeWidth && Math.abs(dy) < size * 0.42;
    const isHorizontalGuard = Math.abs(dy) < guardWidth && Math.abs(dx) < guardLen;

    if (isBorder) {
        return [212, 175, 55, 255]; // gold #d4af37
    }
    if (isVerticalBlade || isHorizontalGuard) {
        return [212, 175, 55, 255]; // gold sword
    }

    // Background: radial gradient from dark crimson center → near-black edge
    const t = Math.min(1, dist / (size * 0.7));
    const r = Math.round(42 - t * 32); // 42 → 10
    const g = Math.round(10 - t * 6);  // 10 → 4
    const b = Math.round(26 - t * 19); // 26 → 7
    return [r, g, b, 255];
}

function makePng(size) {
    // PNG signature
    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    // IHDR
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // color type RGBA
    ihdr[10] = 0;  // compression
    ihdr[11] = 0;  // filter
    ihdr[12] = 0;  // interlace

    // Pixel data: 1 filter byte per row + RGBA per pixel
    const rowLen = 1 + size * 4;
    const raw = Buffer.alloc(size * rowLen);
    for (let y = 0; y < size; y++) {
        raw[y * rowLen] = 0; // filter type 0 (none)
        for (let x = 0; x < size; x++) {
            const [r, g, b, a] = samuraiPixel(x, y, size);
            const o = y * rowLen + 1 + x * 4;
            raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
        }
    }
    const idat = zlib.deflateSync(raw, { level: 9 });

    return Buffer.concat([
        sig,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', idat),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

function makeIco(sizes) {
    // Build PNG payloads (ICO supports embedded PNG since Vista)
    const pngs = sizes.map(s => ({ size: s, png: makePng(s) }));

    const headerSize = 6 + pngs.length * 16;
    const dir = Buffer.alloc(6);
    dir.writeUInt16LE(0, 0);
    dir.writeUInt16LE(1, 2);
    dir.writeUInt16LE(pngs.length, 4);

    const entries = [];
    let offset = headerSize;
    for (const { size, png } of pngs) {
        const e = Buffer.alloc(16);
        e[0] = size >= 256 ? 0 : size;
        e[1] = size >= 256 ? 0 : size;
        e[2] = 0; // colorCount
        e[3] = 0; // reserved
        e.writeUInt16LE(1, 4);   // planes
        e.writeUInt16LE(32, 6);  // bitCount
        e.writeUInt32LE(png.length, 8);
        e.writeUInt32LE(offset, 12);
        entries.push(e);
        offset += png.length;
    }

    return Buffer.concat([dir, ...entries, ...pngs.map(p => p.png)]);
}

function makeIcns(sizes) {
    // ICNS: 'icns' header + length, then a series of typed PNG chunks.
    // Modern ICNS accepts PNG payloads via type codes mapped per size.
    const codeForSize = {
        16: 'icp4', 32: 'icp5', 64: 'icp6',
        128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10'
    };
    const chunks = [];
    for (const s of sizes) {
        const code = codeForSize[s];
        if (!code) continue;
        const png = makePng(s);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(8 + png.length, 0);
        chunks.push(Buffer.from(code, 'ascii'), len, png);
    }
    const body = Buffer.concat(chunks);
    const totalLen = Buffer.alloc(4);
    totalLen.writeUInt32BE(8 + body.length, 0);
    return Buffer.concat([Buffer.from('icns', 'ascii'), totalLen, body]);
}

let createdAny = false;
for (const [name, cfg] of Object.entries(TARGETS)) {
    const out = path.join(ASSETS_DIR, name);
    if (fs.existsSync(out)) continue;
    if (name === 'icon.icns' && process.platform !== 'darwin') continue;

    let buf;
    if (cfg.type === 'png') buf = makePng(cfg.size);
    else if (cfg.type === 'ico') buf = makeIco(cfg.sizes);
    else if (cfg.type === 'icns') buf = makeIcns(cfg.sizes);

    fs.writeFileSync(out, buf);
    console.log(`[icons] generated ${name} (${buf.length} bytes)`);
    createdAny = true;
}

if (!createdAny) {
    console.log('[icons] nothing to generate');
}
