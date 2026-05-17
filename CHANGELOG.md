# Changelog

## [1.0.13] — 2026-05-17

Verification release — exercises the v1.0.12 → v1.0.13 auto-update path now
that the embedded token works (the v1.0.11 → v1.0.12 jump had to be done
manually because the old PAT was revoked).

No code changes vs v1.0.12.

## [1.0.12] — 2026-05-17

### Added — UI for every previously-placeholder sidebar tab
- **ตั้งค่า (Settings)** — `SettingsView.jsx`: account/version/logs/logout, AI API
  keys (OpenAI/Anthropic/Gemini) save/test/delete, app defaults (clip duration,
  copyright wait, slice speed), cover-generation toggle + prompt, storage paths,
  maintenance (log tail + clean downloads).
- **ตรวจสอบ (Reviews)** — `ReviewsView.jsx`: copyright-blocked clips waiting
  for retry decision; "ลอง Set 2" calls retry-set2 with on-demand ensureSet2,
  "ยกเลิก" dismisses to failed. Auto-refresh every 8s.
- **แบนเนอร์ (Banners)** — `BannersView.jsx`: upload PNG/JPG library +
  multi-layer preset editor (X/Y/size/opacity, 9-direction quick-pick).
- **คอมเม้นอัตโนมัติ (Comments)** — `CommentsView.jsx`: per-page comment-
  settings (delay/jitter/max-per-day/cooldown/self-reply/pin/detect-removal) +
  comment-template CRUD with live preview, page-scoped or global, weighted.
- **AI แคปชั่น (AI Captions)** — `AICaptionsView.jsx`: caption-prompt CRUD,
  model picker showing per-caption THB cost, in-modal "🧪 Test" against real AI.
- **คิวงาน (Queue)** — `QueueView.jsx`: grouped page → scouted_video → clip
  layout, per-page schedule editor (`post_times` JSON array), pause controls,
  ClipPreviewModal integration.

### Added — Backend, electron, build
- Per-page `post_times` (TEXT JSON) column on `pages`; scheduler honors it
  before falling back to global PEAK_SLOTS.
- `/api/queue/grouped` endpoint serving the new QueueView.
- Auto-updater progress + error IPC channels; private GitHub releases auth
  via env-provided `GH_TOKEN`; verifyUpdateCodeSignature skipped (no cert).
- Dynamic app version exposed via `app:getVersion` IPC → shown in window
  title, splash, LoginScreen, SetupWizard, /api/health.
- Mobile-responsive Dashboard: hamburger sidebar + scrim < 900px.

### Fixed
- Realtime channels couldn't connect on Electron 32 (Node 20 lacks global
  WebSocket) → `supabaseClient.js` passes `ws` as transport.
- Device-kick channel switched from broadcast to `postgres_changes` CDC on
  `user_devices` — fires on takeover AND admin force-logout.
- `/api/version/check` now runs unauthenticated, falling back to anon key, so
  force-update prompts surface BEFORE login.
- `/api/health` reads version from `package.json` instead of a hardcoded
  literal that went stale every release.
- Root `index.html` entry restored to `/src/main.jsx` (had been replaced with
  built-artifact path, breaking subsequent Vite rebuilds).
- Embedded production Supabase defaults in `config.js` so packaged installer
  works without an adjacent `.env`. service_role is NEVER embedded.

### Security
- Removed all hardcoded secrets from working tree + git history via
  filter-branch: GitHub PAT (`electron/main.js`), Supabase service_role +
  ADMIN_SHARED_SECRET (`plan3` doc). Must be supplied via env var at build
  time. Backup of pre-rewrite history kept locally on tag
  `backup-pre-secret-rewrite`.

## [Unreleased] — Plan 2 Desktop Cloud Integration

### Added
- `@supabase/supabase-js@^2.39.0` production dependency
- `socket.io-client@^4.7.0` production dependency (Dashboard auth:kicked listener)
- `src/backend/cloud/` modules (9 files):
  - `config.js` — reads Supabase URL + anon key from env or .env file
  - `supabaseClient.js` — singleton anon client + per-user clients (cached by URL+key)
  - `sessionStore.js` — encrypted local .session file (AES-256-CBC, same key as FB pw)
  - `authService.js` — login / logout / refresh / getStoredSession
  - `audit.js` — local audit_queue + flush to cloud audit_log
  - `deviceGuard.js` — device ID + claim + heartbeat + Realtime kick subscriber
  - `syncTables.js` + `syncEngine.js` — bidirectional LWW sync for 8 tables
  - `syncHooks.js` — debounced notifySync (2s) for endpoint instrumentation
  - `updateChecker.js` — calls check-version edge function
- API routes: `/api/auth/{login,logout,status,refresh}`, `/api/version/check`
- requireAuth middleware on `/api/*` (exempt: /api/health, /api/auth/*, /api/version/*)
- 8 synced local tables: `cloud_uuid`, `cloud_synced_at`, `updated_at`, `deleted_at`
  columns + per-table partial UNIQUE INDEX on cloud_uuid + updated_at triggers
- `audit_queue` local table
- React `LoginScreen.jsx` + routing (App.jsx: Loading → Login → Setup → Dashboard)
- `UpdatePromptModal.jsx` (soft + force update modes)
- Dashboard subscribes to cloud-update IPC events + socket.io auth:kicked

### Changed
- `/api/auth/login` claims device via edge function + starts heartbeat + subscribes
  to kick + initial pull from cloud + pushPending
- `/api/auth/logout` stops heartbeat + unsubscribes kick
- App.jsx: gates Dashboard behind login
- `public/assets/` added — Vite copies watcher-injection.js + profiles-injection.js
  on every build (replaces hand-managed dist/assets/ placement)
- index.html: expanded CSP for ws://127.0.0.1:* (socket.io); added <script defer>
  tags for the 2 injection files
- electron/main.js: added setupCloudVersionCheck() polling /api/version/check
- electron/preload.js: exposes onCloudUpdateForce + onCloudUpdateSoft listeners

### Test coverage
- 38 new tests across cloud/ modules + api routes (94 → from 56 at Plan 1 end)
- All tests use MSW to mock Supabase — no real cloud connection required to run
- Smoke-tested against real Supabase (etutmagymtlfagcsvavk) — schema + edge
  functions all working

## [Unreleased] — Plan 1 Foundation

### Added
- vitest test infrastructure with msw and supertest as devDependencies
- 29 unit + integration tests covering peakSchedule, db.js, CommentTemplateEngine, /api/health
- GitHub Actions CI workflow (.github/workflows/test.yml) — runs on every PR and push to main
- `src/backend/core/` folder for FB automation modules
- `src/backend/local/db.js` — extracted SQLite init + migrations (openDatabase, loadSchema, applyMigrations)
- `src/backend/cloud/` folder (empty placeholder for Plan 2)
- `src/backend/local/` folder
- vitest.config.js at project root with coverage scoped to backend modules

### Changed
- Upgraded better-sqlite3 from v11.3.0 to v12.x — adds prebuilt binaries for Node 24
- Backend FB automation files moved into `src/backend/core/` (history preserved via git mv):
  - poster.js, orchestrator.js, worker.js, scout.js, browserManager.js, peakSchedule.js
- `server.js` DB initialization now uses `local/db.js` module (78 inline lines → 30 module call lines)
- `server.js` does not bind to port when `process.env.VITEST` is set (test isolation)
- `server.js` exports `{ app, server }` for supertest integration tests
- `.gitignore` updated: dist/ now tracked (contains hand-written injection JS), coverage/ excluded

### Unchanged
- All user-facing behavior identical to v1.0.0
- FB posting pipeline, Channel Watcher, scheduler all work as before
- No new production dependencies — vitest/msw/supertest are devDependencies only
- COMPOSER_URL, pending_approvals UNIQUE constraint, dist React bundle — all per HANDOFF v2 critical-don'ts
