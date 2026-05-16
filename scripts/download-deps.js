/**
 * Auto-download dependencies
 * ดาวน์โหลด FFmpeg, yt-dlp, fpcalc อัตโนมัติ ตาม platform ของเครื่อง
 *
 * ใช้ได้ 2 แบบ:
 * 1. ตอน npm install (postinstall) - ดาวน์โหลดใส่ bin/<platform>/
 * 2. จาก UI (setup wizard) - user กดปุ่ม "ติดตั้ง dependencies"
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { pipeline } = require('stream/promises');
const { execSync } = require('child_process');
const os = require('os');

// In packaged Electron, scripts/ live inside app.asar (READ-ONLY). Writing
// binaries there would silently fail. Use a writable dir:
//   - dev:        <project>/bin/<platform>
//   - packaged:   <userData>/bin or <resources>/bin (next to asar)
function resolveBinDir() {
    // Prefer explicit override (set by Electron main when calling from UI)
    if (process.env.KINTENSHAUTO_BIN_DIR) return process.env.KINTENSHAUTO_BIN_DIR;

    const projectBin = path.join(__dirname, '..', 'bin', process.platform);
    // If we can write to projectBin (dev), use it
    try {
        if (!fs.existsSync(projectBin)) fs.mkdirSync(projectBin, { recursive: true });
        const probe = path.join(projectBin, '.write-probe');
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return projectBin;
    } catch {}

    // Packaged: write into userData (always writable)
    const userData = process.env.KINTENSHAUTO_USER_DATA || os.homedir();
    const fallback = path.join(userData, 'bin');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
}

const PROJECT_ROOT = path.join(__dirname, '..');
const BIN_DIR = resolveBinDir();

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function download(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const tmp = destPath + '.tmp';
        const fileStream = fs.createWriteStream(tmp);

        const doFetch = (u, redirects = 0) => {
            if (redirects > 5) return reject(new Error('Too many redirects'));
            https.get(u, (res) => {
                if ([301, 302, 307, 308].includes(res.statusCode)) {
                    return doFetch(res.headers.location, redirects + 1);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
                }

                const total = parseInt(res.headers['content-length'] || '0', 10);
                let downloaded = 0;
                res.on('data', (chunk) => {
                    downloaded += chunk.length;
                    if (onProgress && total) {
                        onProgress({ downloaded, total, pct: Math.round(downloaded / total * 100) });
                    }
                });
                res.pipe(fileStream);
                fileStream.on('finish', () => {
                    fileStream.close();
                    fs.renameSync(tmp, destPath);
                    resolve(destPath);
                });
                fileStream.on('error', reject);
            }).on('error', reject);
        };
        doFetch(url);
    });
}

function getFFmpegUrl() {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === 'win32') {
        return {
            url: 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
            archive: 'zip',
            binaries: ['ffmpeg.exe', 'ffprobe.exe']
        };
    } else if (platform === 'darwin') {
        return {
            url: arch === 'arm64'
                ? 'https://evermeet.cx/ffmpeg/ffmpeg-7.0.2.zip'
                : 'https://evermeet.cx/ffmpeg/ffmpeg-7.0.2.zip',
            archive: 'zip',
            binaries: ['ffmpeg']
        };
    } else {
        return {
            url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
            archive: 'tar.xz',
            binaries: ['ffmpeg', 'ffprobe']
        };
    }
}

function getYtDlpUrl() {
    const platform = process.platform;
    if (platform === 'win32') {
        return { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', binary: 'yt-dlp.exe' };
    } else if (platform === 'darwin') {
        return { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos', binary: 'yt-dlp' };
    } else {
        return { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', binary: 'yt-dlp' };
    }
}

function getFpcalcUrl() {
    const platform = process.platform;
    const base = 'https://github.com/acoustid/chromaprint/releases/download/v1.5.1';
    if (platform === 'win32') {
        return { url: `${base}/chromaprint-fpcalc-1.5.1-windows-x86_64.zip`, archive: 'zip', binary: 'fpcalc.exe' };
    } else if (platform === 'darwin') {
        return { url: `${base}/chromaprint-fpcalc-1.5.1-macos-x86_64.tar.gz`, archive: 'tar.gz', binary: 'fpcalc' };
    } else {
        return { url: `${base}/chromaprint-fpcalc-1.5.1-linux-x86_64.tar.gz`, archive: 'tar.gz', binary: 'fpcalc' };
    }
}

async function extractArchive(archivePath, destDir, binaries) {
    const ext = path.extname(archivePath).toLowerCase();
    ensureDir(destDir);

    if (ext === '.zip') {
        if (process.platform === 'win32') {
            execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`);
        } else {
            execSync(`unzip -o "${archivePath}" -d "${destDir}"`);
        }
    } else {
        execSync(`tar -xf "${archivePath}" -C "${destDir}"`);
    }

    for (const bin of binaries) {
        const found = findFileRecursive(destDir, bin);
        if (found && found !== path.join(destDir, bin)) {
            fs.copyFileSync(found, path.join(destDir, bin));
        }
        const target = path.join(destDir, bin);
        if (fs.existsSync(target) && process.platform !== 'win32') {
            fs.chmodSync(target, 0o755);
        }
    }
}

function findFileRecursive(dir, filename) {
    try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            const full = path.join(dir, item);
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
                const found = findFileRecursive(full, filename);
                if (found) return found;
            } else if (item === filename) {
                return full;
            }
        }
    } catch (e) {}
    return null;
}

async function installFFmpeg(onProgress) {
    const config = getFFmpegUrl();
    const archivePath = path.join(os.tmpdir(), 'ffmpeg-archive' + path.extname(config.url));

    onProgress?.({ step: 'ffmpeg', status: 'downloading', message: 'กำลังดาวน์โหลด FFmpeg...' });
    await download(config.url, archivePath, (p) => {
        onProgress?.({ step: 'ffmpeg', status: 'downloading', pct: p.pct });
    });

    onProgress?.({ step: 'ffmpeg', status: 'extracting', message: 'กำลังแตกไฟล์...' });
    await extractArchive(archivePath, BIN_DIR, config.binaries);

    fs.unlinkSync(archivePath);
    onProgress?.({ step: 'ffmpeg', status: 'done', message: 'FFmpeg ติดตั้งเสร็จ' });
}

async function installYtDlp(onProgress) {
    const config = getYtDlpUrl();
    const destPath = path.join(BIN_DIR, config.binary);

    ensureDir(BIN_DIR);
    onProgress?.({ step: 'ytdlp', status: 'downloading', message: 'กำลังดาวน์โหลด yt-dlp...' });
    await download(config.url, destPath, (p) => {
        onProgress?.({ step: 'ytdlp', status: 'downloading', pct: p.pct });
    });

    if (process.platform !== 'win32') {
        fs.chmodSync(destPath, 0o755);
    }

    onProgress?.({ step: 'ytdlp', status: 'done', message: 'yt-dlp ติดตั้งเสร็จ' });
}

async function installFpcalc(onProgress) {
    const config = getFpcalcUrl();
    const archivePath = path.join(os.tmpdir(), 'fpcalc-archive' + path.extname(config.url).replace('.xz', '').replace('.gz', ''));

    onProgress?.({ step: 'fpcalc', status: 'downloading', message: 'กำลังดาวน์โหลด fpcalc...' });
    try {
        await download(config.url, archivePath, (p) => {
            onProgress?.({ step: 'fpcalc', status: 'downloading', pct: p.pct });
        });

        onProgress?.({ step: 'fpcalc', status: 'extracting', message: 'กำลังแตกไฟล์...' });
        await extractArchive(archivePath, BIN_DIR, [config.binary]);

        if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
        onProgress?.({ step: 'fpcalc', status: 'done', message: 'fpcalc ติดตั้งเสร็จ' });
    } catch (e) {
        onProgress?.({ step: 'fpcalc', status: 'skipped', message: 'ข้าม fpcalc (ไม่จำเป็น)' });
    }
}

async function downloadAllDependencies(onProgress) {
    ensureDir(BIN_DIR);
    const results = { ffmpeg: false, ytdlp: false, fpcalc: false };

    try {
        await installFFmpeg(onProgress);
        results.ffmpeg = true;
    } catch (e) {
        onProgress?.({ step: 'ffmpeg', status: 'error', message: 'ล้มเหลว: ' + e.message });
    }

    try {
        await installYtDlp(onProgress);
        results.ytdlp = true;
    } catch (e) {
        onProgress?.({ step: 'ytdlp', status: 'error', message: 'ล้มเหลว: ' + e.message });
    }

    try {
        await installFpcalc(onProgress);
        results.fpcalc = true;
    } catch (e) {
        onProgress?.({ step: 'fpcalc', status: 'error', message: 'ล้มเหลว: ' + e.message });
    }

    return results;
}

if (require.main === module) {
    if (process.env.SKIP_POSTINSTALL) {
        console.log('Skipping dependency download (SKIP_POSTINSTALL set)');
        process.exit(0);
    }
    console.log('Downloading dependencies to:', BIN_DIR);
    downloadAllDependencies((p) => {
        if (p.pct !== undefined) {
            process.stdout.write(`\r  ${p.step}: ${p.pct}%  `);
        } else {
            console.log(`\n[${p.step}] ${p.message}`);
        }
    }).then((r) => {
        console.log('\n\nResults:', r);
        process.exit(0);
    }).catch((e) => {
        console.error('\nFailed:', e);
        process.exit(1);
    });
}

module.exports = { downloadAllDependencies, installFFmpeg, installYtDlp, installFpcalc };
