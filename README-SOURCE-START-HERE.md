# KINTENSHAUTO Source Bundle — เริ่มอ่านที่นี่ก่อน

> Source code ทั้งหมดของโปรแกรม KINTENSHAUTO สำหรับ developer ที่จะแก้ไข/พัฒนาต่อ
> **ไม่ใช่** เวอร์ชันที่ติดตั้งใช้งานเลย — ต้อง build เองตามขั้นตอนด้านล่าง

---

## สิ่งที่อยู่ใน Bundle

```
KINTENSHAUTO-Source/
├── src/                  React frontend + backend source
│   ├── App.jsx, Dashboard.jsx, main.jsx
│   ├── components/       React components
│   ├── setup-wizard/     First-run wizard
│   ├── theme/            Samurai theme + UI styles
│   └── backend/          Express server + services
│       ├── server.js
│       ├── orchestrator.js
│       ├── worker.js
│       ├── poster.js     ← Facebook Puppeteer automation
│       ├── peakSchedule.js
│       └── services/     channelWatcher, sessionManager, etc.
├── electron/             Electron main + preload
├── scripts/              Build helpers + auto-download deps
│   ├── download-deps.js  ← postinstall: ดาวน์โหลด yt-dlp, ffmpeg อัตโนมัติ
│   ├── check-dependencies.js
│   ├── generate-icons.js
│   └── make-multires-ico.js
├── assets/               icon.png, icon.ico, icon.icns
├── dist/                 Built React + vanilla JS injection (committed)
│   └── assets/
│       ├── index-*.js              ← React compiled (rebuild via vite — อย่าแก้ตรง)
│       ├── watcher-injection.js    ← Channel Watcher UI (vanilla JS — แก้ตรงได้)
│       └── profiles-injection.js   ← Profile Manager UI (vanilla JS — แก้ตรงได้)
├── schema.sql            SQLite schema + default settings seed
├── package.json          npm scripts + electron-builder config
├── vite.config.js        Vite config สำหรับ React build
├── index.html            React entry HTML
├── build.bat / build.sh  build shortcuts
├── README.md             Feature overview + architecture diagram
├── BUILD.md              Build instructions (detailed)
├── BUILD_YOURSELF.md     Build from scratch guide
├── INSTALLATION.md       End-user install guide (Thai)
├── UPDATES.md            Version history
└── KINTENSHAUTO-DEV-HANDOFF-v2.md   ← ⭐ อ่านนี่ก่อนแก้โค้ด!
```

**ขนาด:** ~2 MB (source-only)
**หลัง npm install:** ~600 MB (รวม node_modules + binaries)

---

## Prerequisites

| ตัว | เวอร์ชัน | หมายเหตุ |
|---|---|---|
| Node.js | >= 18 (แนะนำ 20 LTS) | https://nodejs.org/ |
| npm | >= 9 | มากับ Node |
| Windows | 10/11 x64 | ทดสอบหลักบน Windows |
| Chrome | Latest | ใช้ Puppeteer — ระบบจะ auto-detect (Edge fallback) |

---

## ขั้นตอน Setup (ครั้งแรก)

```powershell
# 1. Extract zip ออกมา ลงที่ไหนก็ได้ (ห้ามมีอักขระไทย/ช่องว่างใน path)
#    เช่น: C:\Dev\KINTENSHAUTO-Source\

# 2. เข้าโฟลเดอร์
cd C:\Dev\KINTENSHAUTO-Source

# 3. ติดตั้ง dependencies
npm install
#    → จะรัน postinstall อัตโนมัติ: download yt-dlp + ffmpeg + ffprobe + fpcalc
#    → ลงไว้ที่ bin/win32/ (~150 MB, ใช้เวลา 3-5 นาที)

# 4. (Optional) ตรวจว่า binaries ครบ
npm run check-deps
```

ถ้า postinstall fail (network issue):
- Manual download yt-dlp ลง `bin/win32/yt-dlp.exe`: https://github.com/yt-dlp/yt-dlp/releases
- Manual download ffmpeg + ffprobe ลง `bin/win32/`: https://www.gyan.dev/ffmpeg/builds/
- Manual download fpcalc ลง `bin/win32/fpcalc.exe`: https://acoustid.org/chromaprint

---

## Development Mode (แก้โค้ด + ดูผลทันที)

```powershell
# Terminal 1: Vite dev server (hot reload สำหรับ React)
npm run dev

# Terminal 2: Electron (เปิดแอป)
npm start
```

แก้ React ใน `src/` → reload เห็นผลทันที (vite HMR)
แก้ backend ใน `src/backend/` → ต้อง restart electron (npm start)
แก้ vanilla JS injection ใน `dist/assets/watcher-injection.js` หรือ `profiles-injection.js` → restart electron

---

## Build (สร้างไฟล์ .exe สำหรับ distribute)

```powershell
# Option A: Portable (แนะนำ — ไม่ต้อง admin)
npm run build-frontend
npx electron-builder --win --dir
#    → Output: dist-installer/win-unpacked/KINTENSHAUTO.exe
#    → Folder นี้คือโปรแกรมพร้อมใช้ — copy ทั้งโฟลเดอร์ไปไหนก็ได้

# Option B: NSIS Installer (.exe ติดตั้ง) — ต้อง Admin
npm run dist:win
#    → ต้อง Run as Administrator (ไม่งั้น winCodeSign extract fail)
#    → Output: dist-installer/KINTENSHAUTO-Setup-1.0.0.exe
```

---

## ห้ามแก้ (Critical Don'ts — จาก HANDOFF-v2)

1. **`dist/assets/index-*.js`** — React bundle compiled แล้ว แก้ไม่ได้ตรง ต้องแก้ source ใน `src/` แล้ว `npm run build-frontend`
2. **`COMPOSER_URL`** ใน `src/backend/poster.js` ที่เป็น `business.facebook.com/latest/reels_composer?ref=` — user verified ห้ามเปลี่ยน
3. **UNIQUE constraint ใน `pending_approvals`** (composite `watched_id, video_id`) — ห้ามเปลี่ยน
4. **`bin/win32/*`** — auto-download อย่าแก้ตรง

## ไฟล์ที่แก้ตรงได้

- `src/**` — React + backend
- `electron/main.js`, `electron/preload.js`
- `schema.sql` (เพิ่ม migration ทุกครั้งที่เปลี่ยน schema)
- `dist/assets/watcher-injection.js` — Channel Watcher UI
- `dist/assets/profiles-injection.js` — Profile Manager UI (FB/X/IG)

---

## Build Workflow ที่ User เดิมใช้

หลังแก้โค้ดทุกครั้ง (ตาม HANDOFF-v2):

```powershell
# 1. Kill รัน
taskkill /F /IM KINTENSHAUTO.exe /T

# 2. Build (ใช้ --dir, ไม่ต้อง admin)
npx electron-builder --win --dir

# 3. Output อยู่ที่ dist-installer/win-unpacked/
#    copy ไปที่ที่ install จริง
robocopy dist-installer\win-unpacked C:\path\to\install /E /NFL /NDL /NP /NJH /NJS

# 4. Re-launch (ใช้ PowerShell — cmd start escape เพี้ยน)
powershell -Command "Start-Process 'C:\path\to\install\KINTENSHAUTO.exe'"
```

---

## ข้อจำกัดที่ต้องรู้

- **ไม่มี code-signing cert** → Windows SmartScreen เตือนครั้งแรก (user คลิก "More info" → "Run anyway")
- **NSIS installer build ต้อง admin** (winCodeSign extract darwin libs) → ใช้ `--dir` แทน
- **Antivirus อาจ quarantine** yt-dlp.exe / ffmpeg.exe (unsigned binaries)
- **Facebook อาจเปลี่ยน UI** → กระทบ page-switch + composer DOM selectors ใน `poster.js`
- **Auto-update ปิดอยู่** → ไม่มี publish URL — ต้อง download patch/zip ใหม่เอง

---

## ติดปัญหาบ่อย

| ปัญหา | สาเหตุ | แก้ |
|---|---|---|
| `npm install` fail at postinstall | Network blocked yt-dlp/ffmpeg download | Manual download (ดูด้านบน) |
| เปิดแอปแล้วจอขาว | Backend ไม่ขึ้น | ดู `%APPDATA%\kintenshauto\logs\backend.log` |
| "Cannot find module 'better-sqlite3'" | Native binding ไม่ตรง Electron version | `npm rebuild better-sqlite3 --runtime=electron --target=<version>` |
| Build fail "winCodeSign" | ใช้ NSIS โดยไม่ admin | ใช้ `--dir` แทน |
| IME ไทยค้างพิมพ์ | Bug รู้จัก (fix v1.0.0+) | Update `watcher-injection.js` + `profiles-injection.js` |

---

## เอกสารอื่นๆ ที่ควรอ่าน

| ไฟล์ | อ่านเมื่อ |
|---|---|
| **`KINTENSHAUTO-DEV-HANDOFF-v2.md`** | **อ่านก่อนแก้โค้ด!** — context การพัฒนา, บัค 30+ ที่แก้, flow ทั้งระบบ |
| `README.md` | Feature overview + architecture diagram |
| `BUILD.md` | Build instructions แบบละเอียด |
| `BUILD_YOURSELF.md` | Build from scratch (clean state) |
| `INSTALLATION.md` | คู่มือสำหรับ end user (ภาษาไทย) |
| `UPDATES.md` | Version history |

---

## Architecture สรุปสั้นๆ

```
Electron Main (electron/main.js)
    ↓ spawn backend
Express Backend (src/backend/server.js, port 3003)
    ├── Channel Watcher (services/channelWatcher.js) ← cron 5 นาที, ตามช่อง YouTube/TikTok/FB
    ├── Orchestrator (orchestrator.js) ← slice + banner + caption + schedule
    ├── Worker (worker.js) ← tick 15s, post Reels
    └── Poster (poster.js) ← Puppeteer + page-switch + verify
        ↓
Chrome (per profile) ← post Reel ผ่าน business.facebook.com
```

Frontend:
- React UI (Dashboard, Setup Wizard) — compiled ไป `dist/assets/index-*.js`
- Channel Watcher UI — vanilla JS overlay (`dist/assets/watcher-injection.js`)
- Profile Manager UI — vanilla JS overlay (`dist/assets/profiles-injection.js`)

---

**Last Updated:** 2026-05-16
**Source from:** KINTENSHAUTO v1.0.0 (production-verified, 25+ Reels posted)
