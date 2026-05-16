# Changelog

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
