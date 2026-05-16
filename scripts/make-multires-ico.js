/**
 * สร้าง multi-resolution .ico จาก .png 256x256
 * ICO format: PNG-encoded entries (Windows Vista+)
 *   ICONDIR (6 bytes)
 *   ICONDIRENTRY × N (16 bytes each)
 *   PNG data × N
 *
 * No dependencies — pure Node fs/buffer.
 * Each entry uses the SAME 256x256 PNG. Windows scales it down for taskbar/explorer.
 * (Real multi-res would need image resizing — but Electron's nativeImage handles
 *  scaling itself for taskbar; .ico is mainly for file association / installer.)
 */
const fs = require('fs');
const path = require('path');

const pngPath = process.argv[2] || path.join(__dirname, '..', 'assets', 'icon.png');
const icoPath = process.argv[3] || path.join(__dirname, '..', 'assets', 'icon.ico');

if (!fs.existsSync(pngPath)) { console.error('PNG not found:', pngPath); process.exit(1); }

const pngData = fs.readFileSync(pngPath);
console.log(`PNG size: ${pngData.length} bytes`);

// Sizes to embed — using same PNG for all (Electron + Windows will scale)
// For BEST quality: we'd need pre-resized PNGs at each size. But same-source
// PNG works fine for the file association use case.
const sizes = [256, 128, 64, 48, 32, 16];

// Build ICONDIR header (6 bytes)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);          // reserved
header.writeUInt16LE(1, 2);          // type 1 = ICO
header.writeUInt16LE(sizes.length, 4); // count

// Build ICONDIRENTRY (16 bytes each) + collect data offsets
const entries = [];
let dataOffset = 6 + (sizes.length * 16);
for (const sz of sizes) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(sz === 256 ? 0 : sz, 0);  // width (0 = 256)
    entry.writeUInt8(sz === 256 ? 0 : sz, 1);  // height
    entry.writeUInt8(0, 2);                    // color count (0 = 256+)
    entry.writeUInt8(0, 3);                    // reserved
    entry.writeUInt16LE(1, 4);                 // color planes
    entry.writeUInt16LE(32, 6);                // bits per pixel
    entry.writeUInt32LE(pngData.length, 8);    // data size
    entry.writeUInt32LE(dataOffset, 12);       // data offset
    entries.push(entry);
    dataOffset += pngData.length;
}

// Concatenate all parts
const parts = [header, ...entries];
for (let i = 0; i < sizes.length; i++) parts.push(pngData);
const ico = Buffer.concat(parts);

fs.writeFileSync(icoPath, ico);
console.log(`✓ Wrote ${icoPath} (${ico.length} bytes, ${sizes.length} sizes: ${sizes.join('/')})`);
