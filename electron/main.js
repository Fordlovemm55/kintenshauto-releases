const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

const USER_DATA = app.getPath('userData');
const DB_PATH = path.join(USER_DATA, 'kintenshauto.db');
const SETUP_FLAG = path.join(USER_DATA, '.setup-complete');
const LOG_DIR = path.join(USER_DATA, 'logs');
const CHROME_PROFILES_DIR = path.join(USER_DATA, 'chrome-profiles');
const DOWNLOADS_DIR = path.join(USER_DATA, 'downloads');
const OVERLAYS_DIR = path.join(USER_DATA, 'overlays');

for (const dir of [LOG_DIR, CHROME_PROFILES_DIR, DOWNLOADS_DIR, OVERLAYS_DIR]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

let mainWindow = null;
let splashWindow = null;
let backendProcess = null;
let backendRestartCount = 0;
let tray = null;
let backendPort = parseInt(process.env.PORT || '3003', 10);

// Resolve paths to extra resources (bin/, assets/) — these are unpacked
// alongside app.asar, NOT inside it.
function getResourcePath(...segments) {
    return app.isPackaged
        ? path.join(process.resourcesPath, ...segments)
        : path.join(__dirname, '..', ...segments);
}

// User-writable bin dir for runtime-downloaded binaries (set up by setup wizard)
const USER_BIN_DIR = path.join(USER_DATA, 'bin');

function getBinPath(binName) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const candidates = app.isPackaged
        ? [
            path.join(USER_BIN_DIR, binName + ext),                      // user-downloaded (priority)
            path.join(process.resourcesPath, 'bin', binName + ext)        // bundled
        ]
        : [
            path.join(USER_BIN_DIR, binName + ext),
            path.join(__dirname, '..', 'bin', process.platform, binName + ext)
        ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    // Return the first candidate even if missing — caller may handle ENOENT
    return candidates[candidates.length - 1];
}

function getAssetPath(name) {
    const fromResources = path.join(process.resourcesPath || '', 'assets', name);
    if (app.isPackaged && fs.existsSync(fromResources)) return fromResources;
    return path.join(__dirname, '..', 'assets', name);
}

// ---- Logger with size-based rotation (10 MB cap, 3 generations) ----
function rotateLogIfBig(logFile, maxBytes = 10 * 1024 * 1024) {
    try {
        if (!fs.existsSync(logFile)) return;
        const { size } = fs.statSync(logFile);
        if (size < maxBytes) return;
        for (let i = 2; i >= 1; i--) {
            const older = `${logFile}.${i + 1}`;
            const newer = `${logFile}.${i}`;
            if (fs.existsSync(newer)) {
                try { if (fs.existsSync(older)) fs.unlinkSync(older); } catch {}
                try { fs.renameSync(newer, older); } catch {}
            }
        }
        try { fs.renameSync(logFile, `${logFile}.1`); } catch {}
    } catch {}
}

function logError(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        const f = path.join(LOG_DIR, 'app.log');
        rotateLogIfBig(f);
        fs.appendFileSync(f, entry);
    } catch {}
    try { console.error(entry); } catch {}
}

function logInfo(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        const f = path.join(LOG_DIR, 'app.log');
        rotateLogIfBig(f);
        fs.appendFileSync(f, entry);
    } catch {}
    try { console.log(entry); } catch {}
}

// ---- Find a free port if the default is in use ----
function isPortFree(port, host = '127.0.0.1') {
    return new Promise(resolve => {
        const server = net.createServer();
        server.unref();
        server.on('error', () => resolve(false));
        server.listen(port, host, () => {
            server.close(() => resolve(true));
        });
    });
}

async function pickBackendPort() {
    const wanted = backendPort;
    for (let p = wanted; p < wanted + 50; p++) {
        if (await isPortFree(p)) return p;
    }
    // Last resort: let OS pick (port 0 binds to ephemeral)
    return wanted;
}

// ---- Wait for backend HTTP /api/health to respond ----
function waitForBackend(port, timeoutMs = 30000) {
    const http = require('http');
    const start = Date.now();
    return new Promise(resolve => {
        const tick = () => {
            if (Date.now() - start > timeoutMs) return resolve(false);
            const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, res => {
                if (res.statusCode === 200) { res.resume(); return resolve(true); }
                res.resume();
                setTimeout(tick, 400);
            });
            req.on('error', () => setTimeout(tick, 400));
            req.on('timeout', () => { req.destroy(); setTimeout(tick, 400); });
        };
        tick();
    });
}

function createSplash() {
    splashWindow = new BrowserWindow({
        width: 480,
        height: 320,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        center: true,
        skipTaskbar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });
    splashWindow.loadFile(path.join(__dirname, 'splash.html')).catch(e => logError('splash load: ' + e.message));
    splashWindow.once('closed', () => { splashWindow = null; });
}

function closeSplash() {
    if (splashWindow && !splashWindow.isDestroyed()) {
        try { splashWindow.close(); } catch {}
    }
    splashWindow = null;
}

function createMainWindow() {
    const iconPath = getAssetPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png');

    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1200,
        minHeight: 720,
        show: false,
        icon: fs.existsSync(iconPath) ? iconPath : undefined,
        backgroundColor: '#0a0a0d',
        title: 'KINTENSHAUTO · 剣天照',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            // Tell renderer which port to talk to (avoids hardcoding 3003)
            additionalArguments: [`--kintenshauto-port=${backendPort}`]
        }
    });

    const isFirstRun = !fs.existsSync(SETUP_FLAG);
    const builtIndex = path.join(__dirname, '..', 'dist', 'index.html');

    // Decide frontend URL:
    //  - packaged → always load built dist/index.html
    //  - dev → try Vite dev (5173) first; fall back to built dist if Vite isn't running.
    //    This prevents black screens if user runs `npm start` without `npm run dev`.
    async function pickFrontendUrl() {
        if (app.isPackaged) return null; // signal: use loadFile
        try {
            const http = require('http');
            const alive = await new Promise(resolve => {
                const req = http.get('http://localhost:5173/', { timeout: 1500 }, res => {
                    resolve(res.statusCode < 500);
                    res.resume();
                });
                req.on('error', () => resolve(false));
                req.on('timeout', () => { req.destroy(); resolve(false); });
            });
            if (alive) return 'http://localhost:5173';
        } catch {}
        if (fs.existsSync(builtIndex)) {
            logInfo('[main] Vite dev not reachable — falling back to built dist/');
            return null; // use loadFile
        }
        return 'http://localhost:5173';
    }

    pickFrontendUrl().then(frontendUrl => {
        const hash = isFirstRun ? '#/setup' : '';
        if (frontendUrl) {
            mainWindow.loadURL(frontendUrl + hash).catch(e => {
                logError('loadURL failed: ' + e.message);
                showLoadFailureDialog();
            });
        } else {
            // Use loadFile so Vite's relative asset paths (base: './') resolve
            mainWindow.loadFile(builtIndex, { hash: hash.replace('#', '') }).catch(e => {
                logError('loadFile failed: ' + e.message);
                showLoadFailureDialog();
            });
        }
    });

    // Safety net: if ready-to-show never fires within 30s, surface an error
    const readyTimeout = setTimeout(() => {
        if (mainWindow && !mainWindow.isVisible()) {
            logError('main window did not become ready within 30s');
            closeSplash();
            try { mainWindow.show(); } catch {}
        }
    }, 30000);

    mainWindow.once('ready-to-show', () => {
        clearTimeout(readyTimeout);
        closeSplash();
        try { mainWindow.show(); } catch {}
    });

    mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
        // -3 = aborted (normal during navigation), ignore
        if (errorCode === -3) return;
        logError(`did-fail-load: ${errorCode} ${errorDescription} url=${validatedURL}`);
    });

    mainWindow.on('close', (e) => {
        // ✅ FIX C4: ถ้า tray ไม่มี (init fail) → ปิด window = ออกโปรแกรมจริง
        // เดิม: hide ตลอดแม้ tray ไม่มี → user ไม่มีทางเปิดใหม่ ต้องไป Task Manager
        if (!app.isQuitting) {
            if (!tray) {
                app.isQuitting = true;
                return;  // อย่า preventDefault → window close = quit ตามปกติ
            }
            e.preventDefault();
            try { mainWindow.hide(); } catch {}
            if (process.platform === 'win32') {
                try { mainWindow.setSkipTaskbar(true); } catch {}
            }
        }
    });

    mainWindow.on('closed', () => { mainWindow = null; });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
}

function showLoadFailureDialog() {
    closeSplash();
    dialog.showErrorBox(
        'KINTENSHAUTO',
        'ไม่สามารถโหลดหน้าโปรแกรมได้\n\n' +
        'กรุณาตรวจสอบไฟล์การติดตั้ง หรือเปิด log:\n' + path.join(LOG_DIR, 'app.log')
    );
    app.isQuitting = true;
    app.quit();
}

function createTray() {
    const trayIconPath = getAssetPath('tray-icon.png');
    const fallbackIconPath = getAssetPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png');

    let trayImage = null;
    if (fs.existsSync(trayIconPath)) {
        trayImage = nativeImage.createFromPath(trayIconPath);
    } else if (fs.existsSync(fallbackIconPath)) {
        trayImage = nativeImage.createFromPath(fallbackIconPath);
        if (!trayImage.isEmpty()) trayImage = trayImage.resize({ width: 16, height: 16 });
    }
    if (!trayImage || trayImage.isEmpty()) {
        // Last-resort: 1px transparent — tray will appear as blank dot but at least
        // the menu still works so the user can recover the window
        trayImage = nativeImage.createEmpty();
    }

    try {
        tray = new Tray(trayImage);
    } catch (e) {
        logError('tray init failed: ' + e.message);
        return;
    }
    tray.setToolTip('KINTENSHAUTO · 剣天照');

    const showWindow = () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            createMainWindow();
            return;
        }
        try {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.setSkipTaskbar(false);
            mainWindow.focus();
        } catch (e) { logError('tray show: ' + e.message); }
    };

    const contextMenu = Menu.buildFromTemplate([
        { label: 'เปิดหน้าต่าง', click: showWindow },
        { label: 'ดู logs', click: () => shell.openPath(LOG_DIR) },
        { type: 'separator' },
        { label: 'ออกจากโปรแกรม', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(contextMenu);
    tray.on('double-click', showWindow);
    tray.on('click', showWindow);
}

function startBackend() {
    const backendScript = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar', 'src', 'backend', 'server.js')
        : path.join(__dirname, '..', 'src', 'backend', 'server.js');

    if (!fs.existsSync(backendScript)) {
        logError('Backend script not found: ' + backendScript);
        return;
    }

    const logFile = path.join(LOG_DIR, 'backend.log');
    rotateLogIfBig(logFile);

    backendProcess = spawn(process.execPath, [backendScript], {
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            KINTENSHAUTO_DB: DB_PATH,
            KINTENSHAUTO_USER_DATA: USER_DATA,
            KINTENSHAUTO_CHROME_PROFILES: CHROME_PROFILES_DIR,
            KINTENSHAUTO_DOWNLOADS: DOWNLOADS_DIR,
            KINTENSHAUTO_OVERLAYS: OVERLAYS_DIR,
            KINTENSHAUTO_FFMPEG: getBinPath('ffmpeg'),
            KINTENSHAUTO_YTDLP: getBinPath('yt-dlp'),
            KINTENSHAUTO_FPCALC: getBinPath('fpcalc'),
            // Force Bangkok TZ so peakSchedule slots fire at intended local times
            TZ: process.env.TZ || 'Asia/Bangkok',
            PORT: String(backendPort)
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });

    backendProcess.on('error', (err) => {
        logError('Backend spawn error: ' + err.message);
    });

    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    backendProcess.stdout.pipe(logStream);
    backendProcess.stderr.pipe(logStream);

    backendProcess.on('exit', (code, signal) => {
        logError(`Backend exited: code=${code} signal=${signal}`);
        backendProcess = null;
        // Auto-restart up to 3 times in 60s window if exit was abnormal and we're not quitting
        if (!app.isQuitting && code !== 0 && backendRestartCount < 3) {
            backendRestartCount++;
            logInfo(`[main] backend restart ${backendRestartCount}/3 in 2s`);
            setTimeout(() => {
                if (!app.isQuitting) startBackend();
            }, 2000);
        } else if (!app.isQuitting && backendRestartCount >= 3) {
            try {
                dialog.showErrorBox(
                    'KINTENSHAUTO',
                    'Backend หยุดทำงานซ้ำๆ — กรุณาตรวจ log ที่:\n' + path.join(LOG_DIR, 'backend.log')
                );
            } catch {}
        }
    });
}

ipcMain.handle('app:getPaths', () => ({
    userData: USER_DATA,
    dbPath: DB_PATH,
    logDir: LOG_DIR,
    chromeProfilesDir: CHROME_PROFILES_DIR,
    downloadsDir: DOWNLOADS_DIR,
    overlaysDir: OVERLAYS_DIR,
    backendPort
}));

ipcMain.handle('app:isFirstRun', () => !fs.existsSync(SETUP_FLAG));

ipcMain.handle('app:completeSetup', () => {
    try {
        fs.writeFileSync(SETUP_FLAG, new Date().toISOString());
        return { ok: true };
    } catch (e) {
        logError('writeSetupFlag: ' + e.message);
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('app:resetSetup', () => {
    try {
        if (fs.existsSync(SETUP_FLAG)) fs.unlinkSync(SETUP_FLAG);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('app:checkDeps', async () => {
    try {
        const depsPath = require.resolve('../scripts/check-dependencies');
        delete require.cache[depsPath];
        const { checkAllDependencies } = require('../scripts/check-dependencies');
        const result = await checkAllDependencies({
            ffmpeg: getBinPath('ffmpeg'),
            ytdlp: getBinPath('yt-dlp'),
            fpcalc: getBinPath('fpcalc')
        });
        return result;
    } catch (err) {
        logError('checkDeps failed: ' + (err && err.stack || err));
        return {
            results: [],
            allRequired: false,
            missingRequired: ['ไม่ทราบ'],
            missingOptional: [],
            ready: false,
            error: err.message || String(err)
        };
    }
});

ipcMain.handle('app:installDeps', async (event) => {
    try {
        // Make sure download-deps writes to a writable dir (not inside app.asar)
        try { fs.mkdirSync(USER_BIN_DIR, { recursive: true }); } catch {}
        process.env.KINTENSHAUTO_BIN_DIR = USER_BIN_DIR;
        process.env.KINTENSHAUTO_USER_DATA = USER_DATA;

        // Bust require cache so the env var is picked up if previous load
        // already locked in a non-writable PROJECT_ROOT path
        const depsScript = require.resolve('../scripts/download-deps');
        delete require.cache[depsScript];
        const { downloadAllDependencies } = require('../scripts/download-deps');

        return await downloadAllDependencies((progress) => {
            try { event.sender.send('deps:progress', progress); } catch {}
        });
    } catch (err) {
        logError('installDeps failed: ' + (err && err.stack || err));
        return { ok: false, error: err.message || String(err) };
    }
});

ipcMain.handle('app:openExternal', async (e, target) => {
    // ✅ รองรับทั้ง http(s) URL (เปิดใน browser) และ local absolute path (เปิดใน file explorer)
    // เดิม block local path → ปุ่ม "เปิดโฟลเดอร์" ในหน้าคลังคลิป + sidebar logs ใช้ไม่ได้
    if (typeof target !== 'string' || !target) return false;
    if (/^https?:\/\//.test(target)) {
        try { await shell.openExternal(target); return true; }
        catch { return false; }
    }
    try {
        if (path.isAbsolute(target) && fs.existsSync(target)) {
            const err = await shell.openPath(target);
            return !err;   // openPath returns "" on success, error string on fail
        }
    } catch {}
    return false;
});
ipcMain.handle('app:showOpenDialog', (e, opts) => dialog.showOpenDialog(mainWindow, opts || {}));
ipcMain.handle('app:showMessageBox', (e, opts) => dialog.showMessageBox(mainWindow, opts || {}));

ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.handle('app:reportCrash', (_e, info) => {
    try {
        logError('[renderer crash] ' + JSON.stringify(info || {}).slice(0, 4000));
    } catch {}
    return true;
});

ipcMain.handle('app:openLogs', () => shell.openPath(LOG_DIR));

// ---- Auto-updater (only enabled when a publish URL is configured at build time) ----
function setupAutoUpdater() {
    if (!app.isPackaged) return;
    let autoUpdater;
    try {
        ({ autoUpdater } = require('electron-updater'));
    } catch (e) {
        return; // electron-updater not bundled / disabled
    }
    // electron-updater reads update.yml that ships in the installer. If no
    // publish.url was set at build time, the file won't exist → silently skip.
    const updateFile = path.join(process.resourcesPath || '', 'app-update.yml');
    if (!fs.existsSync(updateFile)) {
        logInfo('[updater] app-update.yml missing — auto-update disabled (no publish URL configured)');
        return;
    }
    autoUpdater.autoDownload = false;
    autoUpdater.on('update-available', (info) => {
        try { mainWindow?.webContents.send('update:available', info); } catch {}
    });
    autoUpdater.on('update-downloaded', (info) => {
        try { mainWindow?.webContents.send('update:downloaded', info); } catch {}
    });
    autoUpdater.on('error', (err) => logError('Update error: ' + err.message));
    setTimeout(() => {
        autoUpdater.checkForUpdates().catch(e => logError('Update check: ' + e.message));
    }, 10000);

    ipcMain.handle('update:download', () => autoUpdater.downloadUpdate());
    ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());
}

// Plan 2 Task 13: cloud-driven version check. Polls /api/version/check 15s
// after launch; sends `cloud-update:force` or `cloud-update:soft` IPC events
// to the renderer so React can render UpdatePromptModal (Plan 2 Task 15).
function setupCloudVersionCheck() {
    if (!app.isPackaged && !process.env.KINTENSHAUTO_FORCE_VERSION_CHECK) {
        // Skip in dev mode unless explicitly enabled.
        return;
    }
    setTimeout(async () => {
        try {
            const http = require('http');
            const result = await new Promise((resolve) => {
                const req = http.get({
                    host: '127.0.0.1', port: backendPort,
                    path: '/api/version/check', timeout: 5000
                }, res => {
                    let body = '';
                    res.on('data', c => body += c);
                    res.on('end', () => {
                        try { resolve(JSON.parse(body)); }
                        catch { resolve(null); }
                    });
                });
                req.on('error', () => resolve(null));
                req.on('timeout', () => { req.destroy(); resolve(null); });
            });
            if (!result) return;
            if (result.force_update) {
                logInfo('[cloud-update] force update available: ' + result.force_update.required_version);
                try { mainWindow?.webContents.send('cloud-update:force', result.force_update); } catch {}
            } else if (result.soft_update) {
                logInfo('[cloud-update] soft update available: ' + result.soft_update.latest_version);
                try { mainWindow?.webContents.send('cloud-update:soft', result.soft_update); } catch {}
            }
        } catch (e) { logError('cloud version check: ' + e.message); }
    }, 15000); // 15s after app launch
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            try {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.setSkipTaskbar(false);
                mainWindow.focus();
            } catch {}
        }
    });

    app.whenReady().then(async () => {
        backendPort = await pickBackendPort();
        if (backendPort !== 3003) logInfo(`[main] using backend port ${backendPort} (3003 was busy)`);

        createSplash();
        startBackend();

        // Wait for backend to actually respond before opening main window —
        // prevents the renderer firing API calls into the void.
        const ready = await waitForBackend(backendPort, 30000);
        if (!ready) logError('[main] backend did not respond within 30s — opening UI anyway');

        createMainWindow();
        createTray();
        setupAutoUpdater();
        setupCloudVersionCheck();
    }).catch(e => {
        logError('whenReady failed: ' + (e && e.stack || e));
    });
}

// ✅ FIX C3: kill backend tree (รวม yt-dlp / ffmpeg children)
// บน Windows ใช้ taskkill /T /F ฆ่าทั้ง process tree
// บน POSIX ใช้ process.kill(-pgid) ถ้า detached, ไม่งั้น SIGTERM แล้ว SIGKILL ตามหลัง
function killBackendTree() {
    if (!backendProcess) return;
    const pid = backendProcess.pid;
    backendProcess = null;
    if (!pid) return;
    try {
        if (process.platform === 'win32') {
            // taskkill ฆ่า tree — ครอบคลุม ffmpeg/yt-dlp/puppeteer chrome ที่ backend spawn
            const { spawnSync } = require('child_process');
            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
                stdio: 'ignore', windowsHide: true, timeout: 5000
            });
        } else {
            // ส่ง SIGTERM ก่อน — ถ้าไม่ exit ภายใน 2s ค่อย SIGKILL
            try { process.kill(pid, 'SIGTERM'); } catch {}
            setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, 2000);
        }
    } catch (e) {
        logError('killBackendTree: ' + e.message);
    }
}

app.on('before-quit', () => {
    app.isQuitting = true;
    killBackendTree();
    if (tray) {
        try { tray.destroy(); } catch {}
        tray = null;
    }
});

// ✅ FIX C3: also kill on hard exit / signals (uncaught crashes, OS shutdown)
app.on('quit', () => killBackendTree());
process.on('exit', () => killBackendTree());
process.on('SIGINT',  () => { app.isQuitting = true; killBackendTree(); app.quit(); });
process.on('SIGTERM', () => { app.isQuitting = true; killBackendTree(); app.quit(); });

app.on('window-all-closed', () => {
    // Keep app alive in tray on Windows/Linux; quit only on macOS convention reversed
    if (process.platform === 'darwin') {
        // mac: stay alive (standard behavior)
    } else if (app.isQuitting) {
        app.quit();
    } else if (!tray) {
        // ✅ FIX C4: ถ้าไม่มี tray (init fail) → window all closed = ออกจริง
        // (ของเดิม: hidden เพราะ !app.isQuitting → user ติดอยู่ใน background ตลอด)
        app.isQuitting = true;
        app.quit();
    }
});

process.on('uncaughtException', (err) => logError('Uncaught: ' + (err && err.stack || err)));
process.on('unhandledRejection', (err) => logError('Unhandled: ' + (err && err.stack || err)));
