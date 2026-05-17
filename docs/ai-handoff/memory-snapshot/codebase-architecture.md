---
name: codebase-architecture
description: KINTENSHAUTO codebase structure snapshot (อ่านครบทุกไฟล์ 2026-05-16) — Electron+React+Express+Puppeteer สำหรับโพสต์ Reel Facebook อัตโนมัติ
metadata: 
  node_type: memory
  type: project
  originSessionId: bb88b3ff-311f-4e43-a220-ae303eeac8f4
---

**Snapshot timestamp:** 2026-05-16 (อ่านทุกไฟล์ใน source bundle v1.0.0)

## Layer breakdown

```
electron/          → main.js (629 บรรทัด) spawn backend + IPC + tray
src/               → React frontend (App, Dashboard, SetupWizard, ChannelWatcher, SamuraiBackground, theme)
src/backend/       → server.js (2683) + orchestrator.js (1314) + worker.js (598) + poster.js (2985) + scout.js + browserManager.js + peakSchedule.js
src/backend/services/ → channelWatcher.js (1334), captionService.js (579), coverService.js (527), copyrightManager.js (282), bannerLayerSystem.js (242), sessionManager.js (174), commentTemplateEngine.js (188), platformConfig.js (67)
scripts/           → download-deps.js, check-dependencies.js, generate-icons.js, make-multires-ico.js
dist/assets/       → index-CqXjTLNH.js (compiled React), watcher-injection.js (1768), profiles-injection.js (769)
schema.sql         → 18 tables + 11 seeded settings
```

## Key tech
- **Electron** 32 + electron-builder 25 + electron-updater (disabled — no publish URL)
- **React** 18 + Vite 5.4
- **better-sqlite3** 11 (WAL mode) + cookies/profiles persistence
- **puppeteer-core** 23 + puppeteer-extra-stealth + ghost-cursor
- **express** 4 + socket.io 4 (port 3003 default, auto-pick free)
- **node-cron** 3 (Channel Watcher 5-min tick)
- **External binaries:** FFmpeg, yt-dlp, fpcalc (auto-downloaded per platform to bin/)

## Critical flow chain
1. Electron main spawns backend with `ELECTRON_RUN_AS_NODE=1` + env vars (DB path, bin paths, TZ=Asia/Bangkok)
2. Backend starts Express + socket + worker tick (15s) + scheduler tick (5 min) + channel-watcher cron
3. React UI polls `/api/stats/daily` every 10s + uses `window.kintenshauto.*` for OS bridges
4. Vanilla JS injections (watcher/profiles) overlay React DOM since compiled bundle can't be modified

## Files marked DO NOT EDIT (from HANDOFF-v2)
- `dist/assets/index-*.js` — compiled React bundle (edit `src/` then `npm run build-frontend`)
- `COMPOSER_URL` in `src/backend/poster.js` (= `business.facebook.com/latest/reels_composer?ref=`)
- `UNIQUE(watched_id, video_id)` constraint in pending_approvals table
- `bin/win32/*` — auto-downloaded binaries

## 30+ bug fixes already applied (see KINTENSHAUTO-DEV-HANDOFF-v2.md)
Most relate to: multi-page race conditions, FB UI changes, IME freeze in modals, timezone bugs (UTC vs Asia/Bangkok), pending_approvals UNIQUE constraint, Chrome SingletonLock, Thai chars in URLs/paths

Related: [[project-goals]]
