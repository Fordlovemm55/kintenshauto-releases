/**
 * Dependency Checker
 * ตรวจสอบว่ามี binaries ที่จำเป็นครบไหม
 *
 * Required:
 * - FFmpeg (ตัดคลิป + overlay banner)
 * - yt-dlp (ดาวน์โหลด bilibili/youtube)
 * - fpcalc (audio fingerprint)
 * - Chrome/Chromium (Puppeteer)
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');

function runCommand(cmd, args, timeoutMs = 5000) {
    return new Promise((resolve) => {
        // On Windows, use shell:true only for PATH-based lookups (bare names like "ffmpeg").
        // For absolute/relative .exe paths, shell=true breaks because cmd.exe interprets
        // backslashes as escape chars (e.g. \w, \f) inside the concatenated command line.
        const isAbsolutePath = path.isAbsolute(cmd) || cmd.includes(path.sep);
        const opts = { timeout: timeoutMs, windowsHide: true };
        if (process.platform === 'win32' && !isAbsolutePath) opts.shell = true;
        try {
            const proc = execFile(cmd, args, opts, (err, stdout, stderr) => {
                if (err) resolve({ ok: false, error: err.message });
                else resolve({ ok: true, output: (stdout || '').trim() || (stderr || '').trim() });
            });
            proc.on('error', (e) => resolve({ ok: false, error: e.message }));
        } catch (e) {
            resolve({ ok: false, error: e.message });
        }
    });
}

async function checkFFmpeg(binPath) {
    const candidates = [binPath, 'ffmpeg'].filter(Boolean);
    for (const cmd of candidates) {
        if (cmd !== 'ffmpeg' && !fs.existsSync(cmd)) continue;
        const result = await runCommand(cmd, ['-version']);
        if (result.ok) {
            const match = result.output.match(/ffmpeg version (\S+)/);
            return {
                name: 'FFmpeg',
                ok: true,
                version: match ? match[1] : 'unknown',
                path: cmd,
                required: true,
                description: 'ตัดคลิป + ซ้อนแบนเนอร์'
            };
        }
    }
    return {
        name: 'FFmpeg',
        ok: false,
        required: true,
        description: 'ตัดคลิป + ซ้อนแบนเนอร์',
        install_hint: 'ระบบจะติดตั้งอัตโนมัติ'
    };
}

async function checkYtDlp(binPath) {
    const candidates = [binPath, 'yt-dlp'].filter(Boolean);
    for (const cmd of candidates) {
        if (cmd !== 'yt-dlp' && !fs.existsSync(cmd)) continue;
        const result = await runCommand(cmd, ['--version']);
        if (result.ok) {
            return {
                name: 'yt-dlp',
                ok: true,
                version: result.output,
                path: cmd,
                required: true,
                description: 'ดาวน์โหลดคลิปจาก bilibili / youtube'
            };
        }
    }
    return {
        name: 'yt-dlp',
        ok: false,
        required: true,
        description: 'ดาวน์โหลดคลิปจาก bilibili / youtube',
        install_hint: 'ระบบจะติดตั้งอัตโนมัติ'
    };
}

async function checkFpcalc(binPath) {
    const candidates = [binPath, 'fpcalc'].filter(Boolean);
    for (const cmd of candidates) {
        if (cmd !== 'fpcalc' && !fs.existsSync(cmd)) continue;
        const result = await runCommand(cmd, ['-version']);
        if (result.ok || result.error?.includes('Usage')) {
            return {
                name: 'fpcalc (Chromaprint)',
                ok: true,
                path: cmd,
                required: false,
                description: 'ตรวจลิขสิทธิ์เพลงก่อนโพสต์ (แนะนำ)'
            };
        }
    }
    return {
        name: 'fpcalc (Chromaprint)',
        ok: false,
        required: false,
        description: 'ตรวจลิขสิทธิ์เพลงก่อนโพสต์ (แนะนำ)',
        install_hint: 'ระบบจะติดตั้งอัตโนมัติ (optional)'
    };
}

async function checkChrome() {
    const platform = process.platform;
    const candidates = [];

    if (platform === 'win32') {
        candidates.push(
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
        );
    } else if (platform === 'darwin') {
        candidates.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium'
        );
    } else {
        candidates.push(
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium'
        );
    }

    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return {
                name: 'Chrome/Chromium',
                ok: true,
                path: p,
                required: true,
                description: 'เบราว์เซอร์สำหรับ automation'
            };
        }
    }

    return {
        name: 'Chrome/Chromium',
        ok: false,
        required: true,
        description: 'เบราว์เซอร์สำหรับ automation',
        install_hint: 'กรุณาติดตั้ง Google Chrome จาก https://www.google.com/chrome/'
    };
}

async function checkDiskSpace(minGB = 5) {
    try {
        const stats = fs.statfsSync ? fs.statfsSync(os.homedir()) : null;
        if (stats) {
            const freeGB = (stats.bavail * stats.bsize) / (1024 ** 3);
            return {
                name: 'พื้นที่ว่างในดิสก์',
                ok: freeGB >= minGB,
                value: `${freeGB.toFixed(1)} GB`,
                required: true,
                description: `ต้องการอย่างน้อย ${minGB} GB`
            };
        }
    } catch (e) {}
    return {
        name: 'พื้นที่ว่างในดิสก์',
        ok: true,
        value: 'ตรวจไม่ได้',
        required: true,
        description: `ต้องการอย่างน้อย ${minGB} GB`
    };
}

async function checkNodeVersion() {
    const major = parseInt(process.versions.node.split('.')[0], 10);
    return {
        name: 'Node.js runtime',
        ok: major >= 18,
        version: process.versions.node,
        required: true,
        description: 'ต้องการ Node 18+'
    };
}

function withTimeout(promise, ms, fallback) {
    return Promise.race([
        promise.catch((e) => ({ ...fallback, ok: false, error: e.message })),
        new Promise((resolve) => setTimeout(() => resolve({ ...fallback, ok: false, error: 'timeout' }), ms))
    ]);
}

async function checkAllDependencies(binPaths = {}) {
    const TIMEOUT = 8000;
    const results = await Promise.all([
        withTimeout(checkNodeVersion(), TIMEOUT, { name: 'Node.js runtime', required: true }),
        withTimeout(checkFFmpeg(binPaths.ffmpeg), TIMEOUT, { name: 'FFmpeg', required: true, description: 'ตัดคลิป + ซ้อนแบนเนอร์' }),
        withTimeout(checkYtDlp(binPaths.ytdlp), TIMEOUT, { name: 'yt-dlp', required: true, description: 'ดาวน์โหลดคลิป' }),
        withTimeout(checkFpcalc(binPaths.fpcalc), TIMEOUT, { name: 'fpcalc (Chromaprint)', required: false, description: 'ตรวจลิขสิทธิ์เพลง' }),
        withTimeout(checkChrome(), TIMEOUT, { name: 'Chrome/Chromium', required: true, description: 'เบราว์เซอร์สำหรับ automation' }),
        withTimeout(checkDiskSpace(), TIMEOUT, { name: 'พื้นที่ว่างในดิสก์', required: true })
    ]);

    const allRequired = results.filter(r => r.required).every(r => r.ok);
    const missingRequired = results.filter(r => r.required && !r.ok).map(r => r.name);
    const missingOptional = results.filter(r => !r.required && !r.ok).map(r => r.name);

    return {
        results,
        allRequired,
        missingRequired,
        missingOptional,
        ready: allRequired
    };
}

if (require.main === module) {
    checkAllDependencies().then((summary) => {
        console.log('\n=== KINTENSHAUTO Dependency Check ===\n');
        for (const r of summary.results) {
            const icon = r.ok ? '✓' : (r.required ? '✗' : '○');
            const color = r.ok ? '\x1b[32m' : (r.required ? '\x1b[31m' : '\x1b[33m');
            const reset = '\x1b[0m';
            console.log(`${color}${icon}${reset} ${r.name} ${r.version || r.value || ''}`);
            console.log(`    ${r.description}`);
            if (!r.ok && r.install_hint) console.log(`    → ${r.install_hint}`);
            console.log('');
        }

        if (summary.ready) {
            console.log('\x1b[32m✓ พร้อมใช้งาน\x1b[0m\n');
            process.exit(0);
        } else {
            console.log(`\x1b[31m✗ ยังขาด: ${summary.missingRequired.join(', ')}\x1b[0m\n`);
            process.exit(1);
        }
    });
}

module.exports = {
    checkAllDependencies,
    checkFFmpeg,
    checkYtDlp,
    checkFpcalc,
    checkChrome
};
