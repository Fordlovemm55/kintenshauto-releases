# CLAUDE.md — KINTENSHAUTO

Project orientation for AI assistants working on this codebase.

## What this is

KINTENSHAUTO is an Electron desktop app for automated Facebook Reel posting,
built with React + Express + Puppeteer + SQLite. v2.0 adds Supabase-backed
auth, license management, and settings sync (in progress).

## Active spec / plans

- Spec: `docs/superpowers/specs/2026-05-16-supabase-cloud-integration-design.md`
- Plan 1 — Foundation (in progress on branch `plan1-foundation`):
  `docs/superpowers/plans/2026-05-16-plan1-foundation.md`
- Plan 2 — Desktop cloud integration (pending — written after Plan 1 ships)
- Plan 3 — Admin panel (Next.js, pending)

## Backend structure (post-Plan-1 Phase B)

```
src/backend/
  server.js          Express + Socket.IO + REST API (port 3003)
  core/              FB automation (poster, orchestrator, worker, scout,
                     browserManager, peakSchedule) — DO NOT change behavior
  local/             SQLite helpers (db.js — openDatabase, loadSchema,
                     applyMigrations)
  cloud/             Supabase integration (EMPTY in Plan 1; populated in Plan 2)
  services/          captionService, channelWatcher, copyrightManager,
                     coverService, bannerLayerSystem, sessionManager,
                     commentTemplateEngine, platformConfig
```

## Cloud project

Separate repo (not yet created): `../kintenshauto-cloud/`.
Will contain Supabase migrations + edge functions (device-claim, check-version,
admin-reset-device). Setup happens in Plan 1 Phase C — currently BLOCKED on
Supabase CLI install + Docker Desktop + user creating a Supabase project.

## Testing

- Framework: vitest 1.6.x
- Run: `npm test` (all) | `npm run test:watch` | `npm run test:coverage`
- Current count: 29 unit + integration tests across 4 modules
- Coverage so far: db.js 85%, commentTemplateEngine 86%, peakSchedule 65%
- Coverage policy: Plan 2 will enforce >=70% on cloud/ + local/ modules
- CI: `.github/workflows/test.yml` runs on every PR and push to main

## Critical don'ts (from HANDOFF v2 + Plan 1)

- DO NOT edit `dist/assets/index-*.js` — compiled React; edit `src/` then rebuild
- DO NOT change `COMPOSER_URL` in `src/backend/core/poster.js`
- DO NOT change UNIQUE constraint on `pending_approvals` (composite
  watched_id, video_id)
- DO NOT manually edit `bin/win32/*` — auto-downloaded
- DO NOT use `robocopy /MIR` against `src/` — use `/E` (no delete)
- DO NOT downgrade better-sqlite3 below v12 — Node 24 has no prebuilds for v11
- Use English for all new product content (UI text, code comments, docs);
  existing Thai content stays until migrated as part of the same edit

## Node + dependency notes

- Node 24+ required (Electron 32 supports it; better-sqlite3 v12+ has prebuilds)
- Install with `SKIP_POSTINSTALL=1 npm install --ignore-scripts --no-audit --no-fund`
  to skip the slow ffmpeg/yt-dlp download (occurs on first app launch instead)
- Run `npx prebuild-install --runtime=node --target=$(node --version | sed s/v//) --arch=x64 --platform=win32`
  inside `node_modules/better-sqlite3/` if the native binding needs fetching

## Build + deploy flow

After any code edit:
```bash
taskkill /F /IM KINTENSHAUTO.exe /T
npx electron-builder --win --dir
robocopy dist-installer/win-unpacked C:/path/to/install /E /NFL /NDL /NP /NJH /NJS
powershell -Command "Start-Process 'C:/path/to/install/KINTENSHAUTO.exe'"
```

## Memory + planning artifacts

- Memory: `C:/Users/Pc2026/.claude/projects/C--Users-Pc2026-Desktop-KINTENSHAUTO-Source-v1-0-0/memory/`
- Specs: `docs/superpowers/specs/`
- Plans: `docs/superpowers/plans/`
- Changelog: `CHANGELOG.md`
