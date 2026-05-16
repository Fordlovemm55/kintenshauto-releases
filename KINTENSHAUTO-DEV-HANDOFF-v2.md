# 🎯 KINTENSHAUTO Development Handoff v2 (2026-05-06)

> เอกสารส่งต่องาน — เปิดแชทใหม่ → อ่านไฟล์นี้ → AI จะเข้าใจสถานะทั้งหมด 100%
> (อัพเดทจาก v1 — มี fixes 30+ จาก session ล่าสุด)

---

## 🏁 สถานะปัจจุบัน

✅ **Production-ready · Verified working**
- 25+ Reels posted สำเร็จ (verified ผ่าน href-based Reel ID diff)
- Multi-page, multi-profile, multi-channel ใช้งานได้
- User ส่ง patch 4.7 MB ให้คนอื่นใช้ได้

📦 **ไฟล์สำหรับ ship:**
- `C:\Users\User\Desktop\KINTENSHAUTO-Portable-v1.0.0.zip` (287 MB) — full ZIP สำหรับคนใหม่
- `C:\Users\User\Downloads\KINTENSHAUTO-Patch-fix-deps.zip` (4.7 MB) — patch สำหรับคนที่มี zip เก่าแล้ว

---

## 🗂 โครงสร้างโฟลเดอร์

```
C:\Users\User\Desktop\
├── kintenshauto-full\          ← BUILD SOURCE
│   ├── package.json            (electron-builder config + asarUnpack)
│   ├── electron\main.js        (Electron entry, IPC handlers)
│   ├── electron\preload.js
│   ├── src\backend\            (server.js, orchestrator, worker, poster, services/)
│   ├── src\App.jsx + src\Dashboard.jsx + components\ + theme\ + setup-wizard\
│   ├── dist\                   (built React + watcher-injection.js)
│   ├── dist-installer\win-unpacked\  (build output)
│   ├── bin\win32\              (yt-dlp, ffmpeg, ffprobe, fpcalc)
│   ├── assets\                 (icon.png/ico)
│   ├── scripts\                (check-dependencies.js + download-deps.js)
│   ├── schema.sql
│   └── src.bak-114001\         (backup ที่ใช้ recover หลัง robocopy /MIR accident)
│
├── 1555\                       ← LIVE INSTALL (running program)
│   ├── KINTENSHAUTO.exe
│   ├── README.txt              (Thai user guide)
│   ├── SETUP.bat               (shortcut creator + path validator)
│   ├── !_อ่านก่อน_EXTRACT_ZIP_FIRST.txt  (warning file)
│   ├── ffmpeg.dll, d3dcompiler_47.dll, ... (Electron DLLs at root)
│   └── resources\
│       ├── app.asar            (all code packed)
│       ├── app.asar.unpacked\  (better-sqlite3 + puppeteer-core native)
│       ├── bin\                (yt-dlp/ffmpeg/ffprobe/fpcalc)
│       └── assets\             (icon)
│
├── 1555-workspace\app\          ← DEPRECATED — was workspace for live edits
│   (history: extracted from app.asar early in development, edits happened here,
│    then synced to kintenshauto-full. Current convention: edit in
│    1555-workspace\app\ AND in kintenshauto-full\ then build from
│    kintenshauto-full\.)
│
├── KINTENSHAUTO-Portable-v1.0.0.zip   (287 MB — full distribution)
├── KINTENSHAUTO-Patch\          (patch staging folder)
│   ├── resources\app.asar
│   ├── README.txt
│   ├── SETUP.bat
│   └── !_อ่านก่อน_*.txt
│
└── KINTENSHAUTO-DEV-HANDOFF-v2.md   ← THIS FILE
```

**User data (NOT in zip — auto-created per user):**
```
%APPDATA%\kintenshauto\
├── kintenshauto.db          (SQLite + WAL)
├── logs\backend.log
├── downloads\channels\<id>_<label>\
├── clips\clip_<sId>_p<pId>_<idx>_set1.mp4
├── covers\
├── overlays\
└── chrome-profiles\profile_<id>\   (Chrome user-data-dir per profile)
```

---

## 🔄 Build/Deploy Workflow (MUST follow every code edit)

จาก memory rule `feedback_build_deploy.md`:

```powershell
# 1. แก้ source ใน 1555-workspace\app\... หรือ kintenshauto-full\...
# 2. Kill running program
taskkill /F /IM KINTENSHAUTO.exe /T

# 3. Sync workspace → kintenshauto-full (if edited in workspace)
robocopy 1555-workspace\app\src\backend kintenshauto-full\src\backend /E /NFL /NDL /NP /NJH /NJS
# DON'T use /MIR with src\ — it deletes React source files (App.jsx, Dashboard.jsx)

# 4. Build
cd kintenshauto-full
npx electron-builder --win --dir
# (winCodeSign error normal — needs admin to extract darwin libs, but --dir works)

# 5. Sync build → live install
robocopy dist-installer\win-unpacked C:\Users\User\Desktop\1555 /E /NFL /NDL /NP /NJH /NJS

# 6. Re-zip if shipping
powershell -Command "Compress-Archive -Path 'C:\Users\User\Desktop\kintenshauto-full\dist-installer\win-unpacked\*' -DestinationPath 'C:\Users\User\Desktop\KINTENSHAUTO-Portable-v1.0.0.zip' -CompressionLevel Optimal -Force"

# 7. Update patch (เฉพาะ app.asar + 3 helper files)
cp "1555\resources\app.asar" "KINTENSHAUTO-Patch\resources\app.asar"
powershell -Command "Compress-Archive -Path 'KINTENSHAUTO-Patch\*' -DestinationPath 'C:\Users\User\Downloads\KINTENSHAUTO-Patch-fix-deps.zip' -CompressionLevel Optimal -Force"

# 8. Re-launch program (use PowerShell — cmd start has escape bugs)
powershell -Command "Start-Process 'C:\Users\User\Desktop\1555\KINTENSHAUTO.exe'"
```

---

## 🐛 บัคที่แก้ใน session ล่าสุด (30+ fixes)

### 🟥 CRITICAL — ส่งผลกระทบใหญ่

1. **COMPOSER_URL — `?ref=` only** (USER REQUESTED EXACT URL)
   - **เดิม:** `business.facebook.com/latest/reels_composer?ref=bizweb&asset_id=<pageId>`
     บางเพจ "ขออภัย" เพราะ asset_id ผูกผิด/restrict
   - **ใหม่:** `business.facebook.com/latest/reels_composer?ref=` (ไม่ใส่ asset_id, ไม่เติมอะไร)
     FB ใช้ session identity (ที่ page-switch ตั้งไว้) เปิด composer
   - **โค้ด:** poster.js — `const COMPOSER_URL = 'https://business.facebook.com/latest/reels_composer?ref=';`
   - **ห้าม:** แก้ URL นี้ — user verified ว่าใช้ได้กับทุกเพจ

2. **Multi-page race condition** — FFmpeg เขียนไฟล์เดียวกันชนกัน
   - **เดิม:** filename = `clip_<sId>_<idx>_set1.mp4` (ไม่มี pageId)
     → 5 pages approve คลิปเดียวกัน → 5 FFmpeg writers → race → "FFmpeg จบแล้วหาไฟล์ผลลัพธ์ไม่เจอ"
   - **ใหม่:** `clip_<sId>_p<pageId>_<idx>_set1.mp4` (ใส่ pageId)
   - **โค้ด:** orchestrator.js — `path.join(CLIPS_DIR(), \`clip_\${scoutedRow.id}_p\${targetPage.id}_\${i+1}_set1.mp4\`)`

3. **scripts/check-dependencies.js ไม่ได้ pack เข้า app.asar**
   - **บั๊ก:** ตอนเปิดครั้งแรก wizard → "Cannot find module '../scripts/check-dependencies'"
   - **แก้:** package.json `"files"` เพิ่ม `"scripts/**/*"`

4. **pending_approvals UNIQUE source_url ผิด design**
   - **เดิม:** `source_url TEXT NOT NULL UNIQUE` (global)
     → เพิ่มช่องเดียวกัน 2 ครั้ง (label ต่าง) → source_url ซ้ำ → INSERT OR IGNORE skip ทั้งหมด → "เพิ่ม 0 คลิป"
   - **ใหม่:** `UNIQUE(watched_id, video_id)` composite
   - **โค้ด:** channelWatcher.js `_ensureSchema()` migration:
     ```js
     // ตรวจ table sql, ถ้ามี "source_url ... UNIQUE" → migrate
     // CREATE TABLE pending_approvals_new (...UNIQUE(watched_id, video_id)...);
     // INSERT INTO pending_approvals_new SELECT * FROM pending_approvals;
     // DROP + RENAME
     ```

5. **URL Thai chars encoded → yt-dlp 404**
   - **บั๊ก:** browser address bar encode `@กฤติพงษ์` → `@%E0%B8%81...` → user paste → DB เก็บ encoded → yt-dlp 404
   - **แก้:** เพิ่ม `_decodeUrl()` ใน channelWatcher.js — `decodeURI()` แปลงกลับเป็น Thai chars
   - Node spawn ส่ง UTF-8 ได้ปกติบน Windows (tested)

6. **Preflight threshold 500 KB เข้มไป**
   - **บั๊ก:** Shorts 14s = ~500 KB ของจริง → preflight "ไฟล์เล็กผิดปกติ" → block
   - **แก้:** worker.js — ลด threshold เป็น 100 KB

7. **Folder name Thai → Node spawn arg encoding broken**
   - **บั๊ก:** DB เก็บ `3_ทดลอง` แต่ download ไป `3_` (Thai chars หาย) → "ไฟล์ดาวน์โหลดไม่เจอ"
   - **แก้:** channelWatcher.js `_sanitizeLabel()` → ASCII-only (`[^\w-]` replace)
   - **+ Migration:** auto-rename folder `3_ทดลอง` → `3_ch` + อัพเดต DB

8. **Verify post หา Reel ไม่เจอ → loop 5 นาที**
   - **เดิม:** caption text match — FB encode/truncate text → match fail
   - **ใหม่:** href-based diff
     ```js
     // Capture top 12 Reel IDs as baseline ก่อน poll
     // Poll → ดู Reel ID ใหม่ที่ไม่อยู่ใน baseline = posted
     // ~30 วินาที typically (vs 5 min loop เดิม)
     ```

9. **openExternal block local paths**
   - **บั๊ก:** ปุ่ม "เปิดโฟลเดอร์" ทุกหน้า + sidebar logs ไม่เปิด
   - **แก้:** main.js — `ipcMain.handle('app:openExternal')` รองรับทั้ง URL + local path (`shell.openPath`)

10. **IME ไทยค้างพิมพ์รอบ 2 ในช่องกรอกใน watcher modal**
    - **บั๊ก:** url field `oninput: () => renderForm()` → ทำลาย DOM ทั้ง form → input อื่น focus หาย → IME ไทยค้าง
    - **แก้:** watcher-injection.js — partial update (อัพเดทแค่ platform badge ผ่าน DOM directly)

### 🟧 HIGH

11. **Cross-profile leave dialog block** — Chrome "Leave site?" / FB "ทิ้งการเปลี่ยนแปลง"
    - **แก้:** 3-layer handler:
      - `page.on('dialog', d => d.accept())` (native confirm)
      - `evaluateOnNewDocument` override `onbeforeunload`
      - Periodic 3-sec interval scan DOM + click "ทิ้งการเปลี่ยนแปลง" / Discard button
    - **Cleanup:** `clearInterval(_modalDismissTimer)` ใน finally block

12. **Composer "ขออภัย" admin UI false-negative**
    - **บั๊ก:** Admin keywords matched 5 อันแต่ check fail
    - **สาเหตุ:** `onPage` regex `/<pid>/` ไม่ match URL `/profile.php?id=<pid>`
    - **แก้:** poster.js — เพิ่ม pattern `profile\\.php\\?id=${pid}` ใน onPage check

13. **Smart adaptive expansion** — ช่องลงคลิป >15 ตัวระหว่าง intervals → พลาด
    - **แก้:** channelWatcher.js — ถ้า batch แรก 15 คลิปไม่เจอ baseline → auto expand 100 → 300

14. **Personal Profile ID format detection** (Phương My = 100094397139889 — 15 หลัก 100xxx)
    - **แก้:** poster.js — detect `/^100\d{12,13}$/` → message ชัด "เพจนี้เป็น Personal Profile ไม่ใช่ Page — Reels ใช้ไม่ได้"

15. **Default settings seeded** — schema.sql เพิ่ม `INSERT OR IGNORE INTO settings` สำหรับ 11 keys
    - watcher_caption_user_prompt (universal AI prompt — ใช้ได้ทุกเพจ)
    - watcher_caption_system_prompt, _temperature, _max_tokens
    - watcher_auto_edit_enabled (default '1')
    - default_clips_per_video, default_clip_duration_sec, warmup_duration_sec, copyright_monitor_sec
    - strict_copyright_wait (default '0'), chrome_executable_path

16. **Timezone bug — Electron Node `getHours()` returns UTC** (some systems)
    - **แก้:** channelWatcher.js `_pushItemsToPending` — explicit `detected_at = toSqlLocal(new Date())`
    - **UI:** watcher-injection.js — parse with `+ 'Z'` suffix (treat as UTC consistently)
    - badge "🆕 ใหม่" timing changed 6h → 24h

17. **Sort order: newest first** — user request
    - **แก้:** channelWatcher.js `listPending` — เพิ่ม `pa.id DESC` เป็น secondary sort

### 🟨 MEDIUM

18. setInterval _modalDismissTimer leak on postReel throw — added clearInterval in finally
19. Chrome detection — Edge fallback + `chrome_executable_path` settings override
20. detectCurrentIdentity — เลิก auto switchBackToUser (caused regression — broke direct-page-url switch prompt)
21. asset_id URL "always-fails" cache removed — was misleading
22. Composer URL alreadyOnComposer check — simplified to plain regex match

### Features ที่เพิ่ม

1. **📥 ดึงคลิปล่าสุดมา Approve เลย** — ตอน add channel (checkbox + count 1-20)
2. **📥 ดึงเก่า** — modal เลือก 15/50/100/all/custom + checkbox "รวมคลิปที่เคยปฏิเสธ" (clearRejected option)
3. **✗✗ ปฏิเสธทั้งหมด** — confirm dialog (สีแดง คู่กับ "อนุมัติทั้งหมด")
4. **📺 Group pending ตามช่อง + เพจปลายทาง** — section header แสดงชื่อช่อง + badges เพจที่ผูก
5. **✂ ตัดต่ออัตโนมัติ toggle** — ON = slice + banner, OFF = copy raw clip ตรงๆ (เร็วกว่า, ไม่มี branding)
6. **Identity log** — passive (อ่าน URL ปัจจุบัน, ไม่ navigate /me/)
7. **README.txt + SETUP.bat + !_อ่านก่อน_EXTRACT_ZIP_FIRST.txt** ใน ZIP root
8. **AI Caption universal prompt** seeded — ใช้ได้ทุกเพจ ทุกประเภทเนื้อหา

---

## 📐 Flow Architecture (สมบูรณ์)

```
┌─ 1. SETUP (one-time per machine) ──────────────────────────┐
│  User extract ZIP → run SETUP.bat → shortcut + open app    │
│  First-run wizard #/setup (main.js: !fs.existsSync(SETUP_FLAG)) │
│  → เพิ่มเฟส → Login Chrome → Fetch Pages → done            │
└────────────────────────────────────────────────────────────┘
                          ▼
┌─ 2. WATCH LOOP (cron 5 min) ───────────────────────────────┐
│  channelWatcher.checkDue() → fetch yt-dlp metadata         │
│  Smart adaptive expand 15→100→300 if all-new in batch      │
│  INSERT pending_approvals (composite UNIQUE)               │
└────────────────────────────────────────────────────────────┘
                          ▼
┌─ 3. APPROVAL (user action) ────────────────────────────────┐
│  ✓ approve OR ✓✓ all OR ✗✗ reject all                      │
│  Channel Watcher: download → INSERT scouted_videos         │
│  → orchestrator.enqueue per page (with skipAutoEdit flag)  │
└────────────────────────────────────────────────────────────┘
                          ▼
┌─ 4. PIPELINE (orchestrator) ───────────────────────────────┐
│  filename = clip_<sId>_p<pageId>_<idx>_set1.mp4            │
│  skipAutoEdit=true → fs.copyFileSync (no slice/banner)     │
│  skipAutoEdit=false → sliceClip + applyBannerOverlay       │
│  AI caption (watcher prompt → fallback template if no AI)  │
│  Schedule jobs via peakSchedule (Thai TZ peak slots)       │
└────────────────────────────────────────────────────────────┘
                          ▼
┌─ 5. POSTING (worker tick 15s) ─────────────────────────────┐
│  preflight: file ≥100KB · caption · session · quota        │
│  spawn Chrome (cookies restore) → 3-layer dialog handlers  │
│  warm-up 60s → page-switch (5 strategies):                 │
│    0. passive identity log (read URL)                      │
│    1. fast-path composer verify                            │
│    2. direct page URL /<pid> → admin-UI-detected (5 keys)  │
│    3. asset_id URL → "ขออภัย" fallback                    │
│    4. avatar dropdown                                       │
│  Composer URL: business.facebook.com/latest/reels_composer?ref=  │
│    (USER VERIFIED: ทำงานทุกเพจ — DON'T MODIFY)            │
│  Verify "โพสต์ไปยัง" = target page                          │
│  Upload + caption + copyright check + share button         │
│  Verify (href-based): capture 12 Reel IDs → poll → diff    │
│  Mark posted/failed                                         │
└────────────────────────────────────────────────────────────┘
```

---

## 🔑 Critical Files & Where Things Live

| Feature | File |
|---|---|
| App entry + IPC | electron/main.js |
| Express server + APIs | src/backend/server.js |
| Worker job loop | src/backend/worker.js |
| FB Puppeteer + page-switch + verify | src/backend/poster.js |
| Pipeline (slice/banner/schedule) | src/backend/orchestrator.js |
| Channel Watcher (yt-dlp, baseline) | src/backend/services/channelWatcher.js |
| Caption AI (Gemini/OpenAI/Anthropic) | src/backend/services/captionService.js |
| Banner overlay | src/backend/services/bannerLayerSystem.js |
| Cover gen (AI image) | src/backend/services/coverService.js |
| Auto-comment | src/backend/services/commentTemplateEngine.js |
| Copyright detect | src/backend/services/copyrightManager.js |
| Session cookies + Chrome profiles | src/backend/services/sessionManager.js + browserManager.js |
| Scout bilibili search | src/backend/scout.js |
| Schedule peak slots Thai TZ | src/backend/peakSchedule.js |
| Schema + 11 default settings | schema.sql |
| Channel Watcher UI (vanilla JS overlay) | dist/assets/watcher-injection.js (~83KB) |
| React UI (compiled) | dist/assets/index-CqXjTLNH.js (compiled — DO NOT MODIFY) |

---

## 🚫 ห้ามทำ (Critical Don'ts)

1. **ห้ามแก้ React bundle** `dist/assets/index-*.js` — compiled. ใช้ `dist/assets/watcher-injection.js` (vanilla JS DOM injection) แทน
2. **ห้ามใช้ `robocopy /MIR` กับ `src\`** — ลบ React source (App.jsx, Dashboard.jsx, etc.) — ใช้ `/E` (recurse, no delete) เสมอ
3. **ห้ามแก้ COMPOSER_URL** — user verified `?ref=` ใช้ได้ทุกเพจ
4. **ห้ามใช้ Windows Developer Mode** — no admin available
5. **ห้าม sign / code-sign** — ไม่มี cert
6. **ห้ามใช้ NSIS installer build** — winCodeSign extract ต้อง admin
7. **ห้ามเปลี่ยน UNIQUE constraint ของ pending_approvals** — composite (watched_id, video_id) สำคัญ

---

## 🌏 User Context

- ภาษาไทย (เป็นหลัก)
- Backend port 3003 (default — main.js หา free port ถ้าไม่ว่าง)
- Backend spawn จาก main.js ด้วย `ELECTRON_RUN_AS_NODE=1` + env vars
- Production: `C:\Users\User\Desktop\1555\`
- Workspace edits: `C:\Users\User\Desktop\1555-workspace\app\` (sync to kintenshauto-full)
- Memory rules: `C:\Users\User\.claude\projects\C--Users-User-Desktop-1555\memory\`
  - `feedback_build_deploy.md` — must build + sync + deploy + launch after every code edit

---

## 🎯 Settings (ALLOWED_SETTING_KEYS — 14 keys ใน server.js)

```
default_clips_per_video         (default '4')
default_clip_duration_sec       (default '900')
warmup_duration_sec             (default '60')
copyright_monitor_sec           (default '60')
storage_videos_dir              (user override)
storage_clips_dir               (user override)
storage_covers_dir              (user override)
cover_prompt_default            (AI cover prompt)
cover_enabled                   (default '0')
cover_model                     (AI image model)
slice_speed_factor              (1.0-2.0, default 1.0 — copyright evasion)
strict_copyright_wait           (default '0' — post anyway after timeout)
chrome_executable_path          (user override Chrome path, '' = auto)
watcher_auto_edit_enabled       (default '1' — ตัดต่ออัตโนมัติ ON/OFF)
```

Plus watcher prompts:
```
watcher_caption_user_prompt     (seeded with Thai universal prompt)
watcher_caption_system_prompt   (seeded with persona)
watcher_caption_temperature     (default '0.85')
watcher_caption_max_tokens      (default '300')
```

---

## 🧪 Smoke Test Commands

```bash
# Health check
curl http://localhost:3003/api/health

# All page endpoints (should all be 200)
for ep in /api/stats/daily /api/profiles /api/pages /api/banner-presets \
         /api/ai/providers /api/caption-prompts /api/comment-templates \
         /api/series /api/copyright/pending /api/storage/info /api/settings \
         /api/watcher/meta /api/watcher/channels /api/watcher/pending; do
  curl -o /dev/null -w "%{http_code} $ep\n" "http://localhost:3003$ep"
done

# Posting stats
curl "http://localhost:3003/api/jobs/recent?limit=50" | grep -oE '"status":"[a-z_]+"' | sort | uniq -c

# Trigger manual check on channel id
curl -X POST "http://localhost:3003/api/watcher/channels/4/check-now"

# Reset baseline + pull old (with rejected re-included)
curl -X POST "http://localhost:3003/api/watcher/channels/4/check-now?reset_seen=1&fetch_count=50&include_rejected=1"

# Bash → can't use cmd start (escape bugs). Use PowerShell:
powershell -Command "Start-Process 'C:\Users\User\Desktop\1555\KINTENSHAUTO.exe'"
```

---

## 📤 Patch System (ส่งแก้บั๊กให้คนอื่น)

```bash
# Patch zip contains only changed files (~4.7 MB vs 287 MB full):
KINTENSHAUTO-Patch\
├── resources\app.asar       (latest build)
├── README.txt
├── SETUP.bat
└── !_อ่านก่อน_*.txt (2 files)

# Build & ship:
cp 1555\resources\app.asar KINTENSHAUTO-Patch\resources\app.asar
powershell -Command "Compress-Archive -Path 'KINTENSHAUTO-Patch\*' \
  -DestinationPath 'C:\Users\User\Downloads\KINTENSHAUTO-Patch-fix-deps.zip' \
  -CompressionLevel Optimal -Force"

# User instructions:
# 1. taskkill KINTENSHAUTO
# 2. Extract patch zip
# 3. Copy over folder → "Replace All"
# 4. Re-run SETUP.bat or KINTENSHAUTO.exe
```

---

## ⚠️ Known Limitations

1. **Personal profiles (FB user IDs 100xxx, 15 digits) ใช้ Reels ไม่ได้** — Business Suite Reels รองรับเฉพาะ Pages (Format 14 digits 615xxx). โค้ดมี early detect + clear error message
2. **Pages ที่ Reels feature ยังไม่ unlock** — FB rollout gradual. "ขออภัย" ขึ้นแม้เป็น Page ที่ถูก format. → User ต้องรอ FB หรือใช้เพจอื่น
3. **NSIS installer (.exe)** — สร้างไม่ได้ (winCodeSign ต้อง admin). ส่ง portable ZIP แทน
4. **Code signing** — ไม่ได้ sign → SmartScreen เตือนครั้งแรก. User คลิก "More info" → "Run anyway"
5. **Antivirus may quarantine** yt-dlp.exe / ffmpeg.exe — bundled unsigned binaries. User unblock manually
6. **FB UI changes** — อาจกระทบ page-switch, composer DOM. มี fallback หลายชั้นแต่ไม่ 100%
7. **Auto-update server** — ปิดอยู่ (no publish URL). User ต้อง download patch/zip ใหม่เอง
8. **Chrome must be installed** — Edge fallback มี แต่ Chrome แนะนำ

---

## 🛠 ถ้า user รายงานปัญหา — Debug Workflow

1. **อ่าน log:** `%APPDATA%\kintenshauto\logs\backend.log`
2. **ตรวจ posting stats:** `curl /api/jobs/recent?limit=50 | grep status` — posted vs failed ratio
3. **ตรวจ watcher state:** `curl /api/watcher/channels` — channels, last_seen_video_id
4. **ตรวจ pending:** `curl /api/watcher/pending` — sort by id DESC = newest first
5. **DB direct query** (Electron node only — system node has version mismatch):
   ```bash
   cd kintenshauto-full && ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe -e "
     const Database = require('better-sqlite3');
     const db = new Database('%APPDATA%/kintenshauto/kintenshauto.db', { readonly: true });
     ..."
   ```

---

## 🎨 Icon

- PNG 256x256: `kintenshauto-full\assets\icon.png`
- ICO multi-res 6 sizes (256/128/64/48/32/16): `kintenshauto-full\assets\icon.ico`
- Generation: `scripts\make-multires-ico.js`
- Embed: `rcedit-x64.exe` (built-in via electron-builder)

---

## 📅 Version & Recent Build Times

- ZIP/Patch latest: 2026-05-06 19:40-19:41
- COMPOSER_URL: `https://business.facebook.com/latest/reels_composer?ref=` (user verified)
- Build flow: `npx electron-builder --win --dir` → robocopy → Compress-Archive

---

## 📞 สำคัญ — บอก AI ที่อ่านต่อ

1. **ผู้ใช้ภาษาไทย** เป็นหลัก
2. **ทุก code edit → build + deploy + restart** (memory rule บังคับ)
3. **อย่าเปลี่ยน COMPOSER_URL** — `?ref=` user verified แล้ว
4. **อย่าใช้ `robocopy /MIR`** กับ src\ — ลบ React source
5. **อย่าแก้ React bundle** — ใช้ watcher-injection.js
6. **เปิดโปรแกรมหลัง build** ด้วย `powershell -Command "Start-Process ..."` (cmd start เพี้ยน)
7. **Patch ZIP 4.7 MB** ใน `C:\Users\User\Downloads\` — update ทุกครั้งที่ build ใหม่
8. **Full ZIP 287 MB** ใน `C:\Users\User\Desktop\` — ส่งคนใหม่
9. **User Context Memory:** `C:\Users\User\.claude\projects\C--Users-User-Desktop-1555\memory\MEMORY.md`
10. **ห้าม emoji ใน response** เว้นแต่ user ขอ (per system instruction)

---

**END OF HANDOFF v2 — 2026-05-06**

Built across this conversation with 30+ bug fixes + 8 new features. Production-ready, multi-machine portable, patch-deployable. ส่ง patch.zip 4.7 MB ให้คนอื่นได้ทันที.
