# Supabase Cloud Integration — Design Spec

**Date:** 2026-05-16
**Status:** Approved by user, pending writing-plans handoff
**Scope:** Add user authentication, license management, settings sync, and version-pinned auto-update to KINTENSHAUTO v1.0.0
**Approach:** B — Modular split (3–4 weeks estimated)

---

## 1. Goals

1. Transform KINTENSHAUTO from a fully-local desktop tool into a **licensed organizational product**:
   - Admin creates and removes user accounts
   - One active device per user (auto-takeover on new login)
   - Admin can force a user offline at any time
2. Add **auto-update infrastructure** so critical fixes propagate to all users:
   - Optional soft updates (user-chosen install)
   - Required force updates (block app until installed)
3. Enable **device portability** for user-owned settings:
   - Banner presets, caption prompts, comment templates, AI keys sync across devices
   - Heavy files (FB cookies, video clips, banner images) stay local
4. Preserve the existing FB automation pipeline (`poster.js`, `orchestrator.js`, `worker.js`) untouched.

## 2. Non-Goals

- Multi-user concurrent editing (1-device rule eliminates this scenario)
- Offline mode (hard-online verification on every launch)
- Real-time settings collaboration (sync runs on local edits, not live across devices)
- Payment processing / Stripe integration (organizational use, admin-managed accounts only)
- Public signup (admin creates accounts only; no user self-registration)
- Migrating existing Thai UI text to English (separate cleanup task; only **new** UI is English)

## 3. Architecture

### 3.1 Deployable units

```
[1] KINTENSHAUTO Desktop App (Electron — existing, augmented)
[2] Supabase Cloud Project (new — auth + Postgres + Realtime + Storage)
[3] Admin Panel (new — Next.js on Vercel)
[4] GitHub Releases (existing repo, new release workflow)
```

### 3.2 Desktop app layer split

```
electron/                main + preload + login window
src/                     React UI
  ├─ login/              LoginScreen + state (NEW)
  ├─ setup-wizard/       existing wizard (unchanged)
  ├─ components/         existing + sync status indicator (NEW)
  ├─ Dashboard.jsx       existing + update prompt modal (NEW)
  └─ App.jsx             refactored: Splash → Login → Setup → Dashboard

src/backend/
  ├─ server.js           existing + auth middleware (CHANGED)
  ├─ core/               (NEW folder — move existing files here)
  │   ├─ poster.js
  │   ├─ orchestrator.js
  │   ├─ worker.js
  │   ├─ scout.js
  │   ├─ browserManager.js
  │   └─ peakSchedule.js
  ├─ local/              (NEW folder — extracted helpers)
  │   ├─ db.js           SQLite connection + migrations
  │   └─ migrations/     numbered SQL files
  ├─ cloud/              (NEW folder)
  │   ├─ supabaseClient.js     singleton, refreshes token
  │   ├─ authService.js        login, logout, refresh, verify
  │   ├─ deviceGuard.js        1-device claim + Realtime kick subscriber
  │   ├─ syncEngine.js         push/pull, LWW, queue processor
  │   ├─ updateChecker.js      version comparison + force-update logic
  │   └─ audit.js              event logger
  └─ services/           existing (unchanged)
```

### 3.3 Cloud schema (Supabase Postgres)

```sql
-- Native Supabase auth.users handles email/password (managed by admin via API)

CREATE TABLE user_devices (
  user_id        UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id      TEXT NOT NULL,
  device_label   TEXT,
  claimed_at     TIMESTAMPTZ DEFAULT now(),
  last_seen_at   TIMESTAMPTZ DEFAULT now(),
  session_token  TEXT NOT NULL
);

CREATE TABLE user_secrets (
  user_id        UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  encryption_key TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- Mirror tables for sync (one per synced local table)
CREATE TABLE cloud_banner_presets (
  cloud_uuid     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  layers_json    TEXT NOT NULL,
  updated_at     TIMESTAMPTZ DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
-- Same pattern: cloud_caption_prompts, cloud_comment_templates,
-- cloud_comment_settings, cloud_watched_channels, cloud_pages,
-- cloud_settings, cloud_banners (metadata only — no image blobs),
-- cloud_ai_providers (encrypted_key column instead of api_key)

CREATE TABLE app_versions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version             TEXT NOT NULL UNIQUE,
  min_required        BOOLEAN DEFAULT false,
  release_notes_md    TEXT,
  download_url        TEXT,
  published_at        TIMESTAMPTZ DEFAULT now(),
  published_by        UUID REFERENCES auth.users(id)
);

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES auth.users(id),
  event       TEXT NOT NULL,
  detail_json JSONB,
  ip          INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- RLS policies: all cloud_* tables and user_secrets/user_devices restricted
-- to WHERE user_id = auth.uid(). service_role (admin) bypasses RLS.
```

### 3.4 Edge Functions (Supabase Deno runtime)

```
functions/
├─ device-claim/        atomic device swap + emit kick signal
├─ check-version/       compare client_version to min_required
└─ admin-reset-device/  service_role only; clears user_devices.device_id
```

## 4. Component Specifications

### 4.1 Login Flow

```
Splash (2s)
  → Login screen (email + password)
     → POST authService.login(email, password)
        1. Supabase auth.signInWithPassword
        2. POST device-claim edge function:
           - new device → INSERT user_devices, return { is_takeover: false }
           - same device → UPDATE last_seen_at, return { is_takeover: false }
           - different device → emit pg_notify('device_kick:<user_id>', old_session)
             UPDATE user_devices, return { is_takeover: true }
        3. authService stores encrypted access_token + refresh_token in
           %APPDATA%/kintenshauto/.session
        4. POST check-version edge function:
           - force_update → return version + download_url; UI blocks login
           - soft_update → return latest version; UI shows after dashboard
           - ok → proceed
        5. syncEngine.pullInitial() — fetch all cloud data, merge into local
     → First time? → Setup Wizard (existing)
     → Returning? → Dashboard
```

### 4.2 Device Enforcement

**On the new device (login success):**
- Cloud emits `pg_notify('device_kick:<user_id>', old_session_token)` BEFORE updating row
- The OLD device subscribes via Supabase Realtime
- On receiving signal:
  1. Save FB cookies to DB (existing backup flow)
  2. Close all Chrome browsers (browserManager.closeAll)
  3. Clear local .session
  4. Show modal "Signed in on another device"
  5. Redirect to login screen

**Heartbeat (loose — does not aggressively kick):**
- `deviceGuard.heartbeat()` runs every 5 minutes
- UPDATE user_devices.last_seen_at = now() WHERE user_id AND session_token match
- If UPDATE returns 0 rows → session_token mismatch → trigger same kick flow as above
- If network fails 3 attempts (15 min total) → kick (prevents flap on transient outages)
- In-progress FB posts are NOT interrupted mid-post; they complete then app exits

### 4.3 Sync Engine

**Local schema additions** (additive migration — preserves v1.0.0 compatibility):
```sql
-- For each synced table (banner_presets, caption_prompts, etc.):
ALTER TABLE <name> ADD COLUMN cloud_uuid TEXT UNIQUE;
ALTER TABLE <name> ADD COLUMN cloud_synced_at DATETIME;
ALTER TABLE <name> ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE <name> ADD COLUMN deleted_at DATETIME;
```

**Sync queue (local, for crash safety):**
```sql
CREATE TABLE sync_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  operation       TEXT NOT NULL,         -- 'push' | 'delete'
  table_name      TEXT NOT NULL,
  row_uuid        TEXT NOT NULL,
  payload_json    TEXT,
  attempts        INTEGER DEFAULT 0,
  last_attempt_at DATETIME,
  last_error      TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Sync lifecycle:**
- `on login_success` → pullInitial() (full pull, LWW merge)
- `on local write` (synced tables only) → debounce 2s → enqueue push → process queue
- `on push success` → update local.cloud_synced_at, remove from queue
  - If local.updated_at changed during the push (user edited again) → re-enqueue immediately
- `on push conflict` (cloud has newer updated_at) → re-pull row → LWW resolve → retry
- `on push network fail` → keep in queue, exponential backoff (1m, 5m, 15m, max 1hr)
- `on logout` → stop listener, keep local data + queue intact

**LWW algorithm:** Compare `updated_at` per row. Newer wins. Deleted rows (`deleted_at IS NOT NULL`) win over edits at the same timestamp.

### 4.4 Sync Boundaries

| Local table | Cloud table | Direction | Notes |
|-------------|-------------|-----------|-------|
| `profiles` (FB password) | — | Local only | Security |
| `session_cookies` (FB) | — | Local only | Security + size |
| `pages` | `cloud_pages` | Bidirectional | Page metadata only |
| `banner_presets` | `cloud_banner_presets` | Bidirectional | JSON config |
| `caption_prompts` | `cloud_caption_prompts` | Bidirectional | — |
| `comment_templates` | `cloud_comment_templates` | Bidirectional | — |
| `comment_settings` | `cloud_comment_settings` | Bidirectional | — |
| `ai_providers` | `cloud_ai_providers` | Bidirectional | encrypted_key column; AES key from user_secrets |
| `watched_channels` + `watched_channel_pages` | `cloud_watched_channels` | Bidirectional | Junction stored as `page_uuids JSONB` |
| `settings` (14-key allowlist) | `cloud_settings` | Bidirectional | Same allowlist as ALLOWED_SETTING_KEYS |
| `banners` | `cloud_banners` | metadata only | File blobs stay local; missing files render placeholder |
| `scouted_videos`, `clips`, `jobs`, `daily_stats`, `post_log` | — | Local only | Heavy / ephemeral |
| `copyright_blacklist` | — | Local only | Phase 2 if needed |

### 4.5 Encryption Key Sync (for AI provider keys)

```
On first login from a fresh install:
  1. authService checks cloud user_secrets table
     - If row exists → pull encryption_key → write to local .encryption-key
     - If no row → generate new 32-byte hex key → INSERT into user_secrets
       → write to local .encryption-key
  2. syncEngine pulls cloud_ai_providers
  3. captionService decrypts encrypted_key using local .encryption-key
     (existing AES-256-CBC flow — no changes to encryption code)

Tradeoff (documented in CLAUDE.md):
  Supabase service_role (admin) can read both encryption_key and
  encrypted blobs → can technically decrypt user API keys.
  Acceptable for organizational use (admin owns the deployment).
  Upgrade path: password-derived key (Phase 2 if needed).
```

### 4.6 Update System

**Build flow:**
- Developer pushes git tag `v1.x.y`
- GitHub Actions matrix builds Windows/Mac/Linux installers
- electron-builder uploads to GitHub Releases (public repo): `latest.yml` + `.exe` + `.dmg` + `.AppImage` + `.blockmap`

**Client flow on every launch:**
1. Backend ready → POST `/api/auth/verify`
2. authService calls `check-version` edge function with `app.getVersion()`
3. If force_update → block at login screen, show Mode 3 modal
4. If ok → proceed; after dashboard renders, if soft_update available → show Mode 1 modal once

**Update modes:**
- **Mode 1 — Soft update:** non-blocking modal with [Update Later] / [Update Now]; auto-download in background; prompts [Install Later] / [Install Now] when ready
- **Mode 2 — Ready to install:** electron-updater `quitAndInstall()` flow
- **Mode 3 — Force update:** blocking modal with only [Download & Install] button; app cannot proceed until installed

**Admin policy UI (`/admin/versions`):**
- Lists all `app_versions` rows
- Publish button: insert row with `version`, `release_notes_md`, optional `min_required` flag
- Edit button: toggle `min_required` after the fact (e.g., upgrade soft to force when critical bug discovered)
- "Active users" column queries `audit_log` for last login per version

## 5. Admin Panel (Next.js)

```
repo: kintenshauto-admin/
deploy: Vercel free tier
auth: same Supabase project; admin = user with service_role flag in JWT claims
       (alternative: separate auth.users with admin role — TBD during implementation)

routes:
  /login                      Supabase Auth UI
  /users                      list, [+ Add user], [Edit], [Suspend], [Delete]
  /users/[id]                 details: device info, last_seen, audit log
  /users/[id]/reset-device    POST admin-reset-device edge function
  /sessions                   list active sessions (joined user_devices)
  /sessions/[id]/force-logout POST emit kick signal
  /versions                   list app_versions; [+ Publish]; toggle min_required
  /audit                      filterable audit_log view
```

## 6. Data Flow Diagrams

### 6.1 First-run install (new install, new user)

```
User runs KINTENSHAUTO-Setup-1.x.y.exe (NSIS installer)
  → Installs to %LOCALAPPDATA%\Programs\KINTENSHAUTO
  → Creates start menu + desktop shortcut
  → Launches app

app launches
  → Splash (2s)
  → No .session file → Login screen
     User enters email + password (provided by admin)
     → authService.login → device-claim (new row) → check-version
     → user_secrets row created → .encryption-key written
     → syncEngine.pullInitial() (empty cloud → nothing to pull)
  → No setup flag → Setup Wizard:
     1. Welcome
     2. Dependencies (check + install FFmpeg/yt-dlp/fpcalc)
     3. FB profile (optional)
     4. AI provider (optional — also pushed to cloud on save)
     5. Done
  → setup flag set → Dashboard
```

### 6.2 Device takeover

```
Device A: logged in, normal usage
Device B: user opens app, logs in with same credentials

Cloud:
  device-claim edge function:
    SELECT user_devices WHERE user_id → row exists, device_id != new
    pg_notify('device_kick:<user_id>', A.session_token)
    UPDATE user_devices SET device_id = B, session_token = new_uuid
    INSERT audit_log (event = 'device_takeover')

Device A:
  deviceGuard Realtime listener fires:
    backupCookiesToDb (FB cookies preserved)
    browserManager.closeAll
    fs.unlinkSync(.session)
    UI shows modal: "Signed in on another device"
    UI redirects to login screen

Device B:
  Login flow completes normally, syncEngine pulls cloud state
```

### 6.3 Settings edit + sync

```
User edits banner_preset in Dashboard:
  React → POST /api/banner-presets/:id (existing endpoint)
     existing handler updates local row + sets updated_at = now
     (NEW) hooks fire: syncEngine.onLocalWrite(table, rowId)
        debounce 2s → INSERT sync_queue (operation='push', ...)
        processQueue:
           Supabase REST: UPSERT cloud_banner_presets WHERE cloud_uuid = X
           on success → local.cloud_synced_at = now, DELETE from queue
           on conflict (cloud.updated_at > local.updated_at) →
              pull cloud row → LWW → if cloud wins, update local + emit
              "preset changed" event to React → re-render
```

## 7. Error Handling

| Layer | Failure | Behavior |
|-------|---------|----------|
| Network | DNS / Supabase 5xx | Login screen shows "Cannot reach server" + [Retry] |
| Auth | Invalid creds | Inline error on form |
| Auth | Suspended user | "Account suspended — contact admin" |
| Auth | Token refresh fails 3x | Hard logout → login screen + toast |
| Device | Realtime kick | Save cookies, close Chrome, redirect to login |
| Device | Heartbeat fails 3x (15min) | Same as kick |
| Sync | Push conflict | Re-pull, LWW resolve, retry (silent) |
| Sync | Push network fail | Queue + exponential backoff (1m → 1hr max) |
| Sync | Pull schema mismatch (older client) | Log warning, skip bad row, continue |
| Update | Download fail | Toast + auto-retry in 1hr |
| Update | Install fail (permission) | Show manual download link |
| Core (FB) | All existing failures | Unchanged — existing preflight + error handling |

## 8. Testing Strategy

### 8.1 Baseline infrastructure (Phase 0 — before any new feature work)

```
package.json devDependencies:
  vitest                  test runner
  @vitest/coverage-v8     coverage reporting
  supertest               HTTP integration tests
  @testing-library/react  component tests
  jsdom                   DOM for React tests
  msw                     mock Supabase REST + Realtime

scripts:
  "test":          "vitest run"
  "test:watch":    "vitest"
  "test:coverage": "vitest run --coverage"

.github/workflows/test.yml:
  on: pull_request, push to main
  jobs.test:
    - npm install
    - npm test
    - npm run test:coverage (fail if drops below threshold)
```

### 8.2 Test pyramid

**Tier 1 — Unit (target 70%+ coverage on new code):**
- `cloud/authService.js`: token refresh logic, expiry math
- `cloud/deviceGuard.js`: device_id generation (deterministic from MAC + install ID), kick handler
- `cloud/syncEngine.js`: LWW resolution (table-driven cases), queue processor, schema diff
- `cloud/updateChecker.js`: semver comparison, force-update gating

**Tier 2 — Integration (real SQLite + MSW-mocked Supabase, 25% of tests):**
- Login flow → device claim → token storage end-to-end
- Full sync cycle: local edit → push → "another device" pull → conflict resolution
- Express `requireAuth` middleware: blocks unauthenticated, allows valid
- Sync queue retry: success path, max-attempts path
- Schema migration: v1.0.0 SQLite → v2.0.0 schema, data preserved

**Tier 3 — E2E (Playwright on packaged build, smoke only, 5%):**
- First-run: install → login → wizard → dashboard
- Force-update: stale version → blocked → simulated install → login succeeds
- Device takeover: simulated machine A + B, A gets kicked

FB posting flow stays manual-verified (existing — FB DOM changes too often).

### 8.3 Test coverage policy

- New `cloud/*` and `local/*` files: 70%+ line coverage required
- Existing `core/*` files: no new coverage requirement; ADD tests when touching
- CI fails PR if `cloud/*` coverage drops below 70%

## 9. Migration & Rollback

### 9.1 Migration of existing v1.0.0 installs

```
On first launch of v2.0.0 over existing v1.0.0 install:
  1. local/db.js detects existing SQLite at expected path
  2. Runs additive migrations:
     - Add cloud_uuid, cloud_synced_at, updated_at, deleted_at to synced tables
     - Existing rows: cloud_uuid = NULL (will be assigned on first push)
     - Existing rows: updated_at = created_at (best estimate)
  3. Login screen appears
  4. After login + first sync:
     - All local rows with cloud_uuid IS NULL → assign UUID → push to cloud
     - Cloud is empty → user effectively "uploads" their existing state
```

### 9.2 Rollback to v1.0.0

If v2.0.0 breaks for a specific user, admin can:
- Push fallback installer (separate GitHub Release tagged `v1.0.0-fallback`)
- User downloads + installs over v2.0.0 → v1.0.0 binary
- v1.0.0 reads the migrated SQLite fine (additive columns are ignored)
- Cloud rows remain — re-installing v2.0.0 picks up where they left off

### 9.3 Schema evolution policy

- All local SQLite migrations are **additive only** (ADD COLUMN, never DROP/RENAME)
- Cloud migrations may DROP — but only with admin approval + downtime window
- Cloud tables versioned via `app_versions.min_required` — old clients blocked from connecting if their sync code can't handle new schema

## 10. Observability

**audit_log events (initial set):**
- `login_success` / `login_failure` (separate events; failure includes attempted email + ip)
- `logout` (with reason: `user_action` / `token_expired` / `kicked_by_device`)
- `device_takeover` (with old + new device labels)
- `device_heartbeat_fail` (after 3 retries)
- `sync_push` (table, row_count, duration)
- `sync_pull` (table, row_count, duration)
- `sync_conflict` (table, resolution)
- `version_block` (user blocked at login due to force update)
- `version_update_installed` (after restart)

**Admin panel `/audit`** filters by: user_id, event type, date range.

## 11. Out of Scope (Phase 2+)

- Password-derived encryption for zero-knowledge secret storage
- Real-time settings sync (current design = sync on save, not collaborative)
- Multi-device support (any change requires removing the 1-device rule)
- Cloud-stored video clips or banner blobs
- Self-service password reset (admin handles via Supabase Studio)
- Mobile / web client (desktop only)
- Subscription billing / Stripe
- Per-user feature gating (Free vs Pro tiers)

## 12. Open Questions (resolve during implementation)

1. Admin role enforcement: separate `auth.users` for admins, or flag on user metadata? (Recommend: separate Supabase project for admin auth, simpler RLS)
2. Service-role key storage in Next.js admin: env var on Vercel only, never client-side bundle
3. GitHub Releases public vs private: design assumes public (simpler); revisit if installer leak becomes a concern

## 13. Acceptance Criteria

- [ ] User can install KINTENSHAUTO-Setup-2.0.0.exe, log in with admin-issued credentials, complete setup wizard, and reach dashboard
- [ ] Editing a banner preset on Device A and logging into Device B within 5 minutes shows the new preset on Device B
- [ ] Logging in on Device B while Device A is open: Device A receives kick within 5 seconds and redirects to login
- [ ] Admin publishes version 2.0.1 with `min_required = true` → all v2.0.0 users blocked at login with force-update modal
- [ ] Admin in `/admin/users` clicks "Suspend" on a user → that user's next launch (or current heartbeat within 5min) results in logout
- [ ] FB posting workflow unchanged: scout, slice, banner, AI caption, post, copyright check all behave identically to v1.0.0
- [ ] All new `cloud/*` and `local/*` code has ≥70% test coverage; CI enforces threshold
- [ ] Rollback test: v2.0.0 install with cloud data → install v1.0.0 over it → app launches, local data intact, login screen not shown
