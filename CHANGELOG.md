# Changelog

## [1.0.24] — 2026-05-26

### Fixed — Per-page post_times skipped same-day slots, piled clips on consecutive days at first slot
- When a page had custom `post_times` like `["09:00","13:00","18:00","21:00"]`
  and the user added clips one at a time (typical workflow), every new
  clip was forced to "next-day midnight" as the scheduling baseline. The
  scheduler then picked the first peak slot AFTER midnight — i.e. the
  earliest time in the list — for every clip. Result: instead of filling
  13:00/18:00/21:00 of the same day, clips piled up at 09:00 of day+1,
  day+2, day+3… so a page's `post_times` was effectively reduced to one
  slot per day.
- The "fresh-day" baseline came from an older user request to keep batch
  enqueues bundled on one calendar day. That intent was correct for
  multi-clip batches but wrong for single-clip enqueues: the baseline
  should only roll forward when same-day slots are exhausted.
- Fix: drop the next-day-midnight forcing in `orchestrator.js` (and the
  matching preview paths in `server.js`). Start from
  `lastScheduled + cooldown` and let `nextPeakSlotAfter()` pick the next
  available slot — which prefers the remaining same-day slots, then rolls
  to the next day naturally once today is full.
- Preview endpoints (`/api/pipeline/start` and
  `/api/pipeline/preview-schedule`) now also pass the page's `post_times`
  through to `planClipSchedule`, so the preview shown to the user matches
  the schedule the orchestrator will actually create.

## [1.0.23] — 2026-05-19

### Fixed — YouTube login captured incomplete cookies, broke yt-dlp
- v1.0.22 closed the dedicated Chrome window the instant SAPISID
  appeared on `.google.com`. That cookie is set immediately after the
  Google login form, BEFORE Google redirects the user to
  `www.youtube.com` — so the captured `cookies.txt` was missing the
  YouTube session cookie (`LOGIN_INFO`) that yt-dlp actually needs.
  Result: users completed the gate but every download still hit
  "Sign in to confirm you're not a bot".
- New detection waits until BOTH `SAPISID` (.google) AND `LOGIN_INFO`
  (.youtube) are present, and stays that way for 3 consecutive polls
  (~6s) before snapshotting. Trailing redirects/refresh cookies land
  before we close.
- After Google login finishes but the user is stuck somewhere other
  than youtube.com (account-picker, Google home), the service now
  force-navigates the first page to `https://www.youtube.com/` so the
  YouTube cookie can get set without manual help.
- If the user closes the Chrome window themselves (as several testers
  preferred), we now use the best snapshot captured so far instead of
  throwing "User closed before login completed".

## [1.0.22] — 2026-05-18

### Added — Dedicated YouTube login flow + cookies.txt
- New service `youtubeLogin.js` spawns Chrome with a profile dir that is
  separate from the user's real browser, points it at
  `accounts.google.com/ServiceLogin?service=youtube`, polls for SAPISID
  cookies, and writes every google.com / youtube.com cookie to a
  Netscape-format `youtube-cookies.txt`. `ChannelWatcher` reads the path
  from `settings.youtube_cookies_path` and switches yt-dlp to
  `--cookies <path>` whenever the file exists (more reliable than
  `--cookies-from-browser`, which fails on locked Chrome / missing
  profiles / decrypt errors).
- Three new endpoints expose the lifecycle:
  - `GET  /api/system/youtube-login-status`
  - `POST /api/system/youtube-login`        (blocks until logged in)
  - `POST /api/system/youtube-login-cancel` (closes the Chrome window)
  - `POST /api/system/youtube-logout`       (wipes cookies + profile)
- Settings panel gains a "YouTube Login" section with status, "Login",
  "Re-login", and "Logout" buttons. Toast feedback on success/fail.
- App boot now gates Dashboard behind a `YouTubeLoginRequiredScreen` —
  if no cookies are captured yet, the user MUST click "Login YouTube"
  to proceed. Same shape as the existing deps gate.

### Fixed — Modal regex no longer misses encoding-mangled apostrophes
- The "Sign in to confirm you're not a bot" detector used `you'?re`
  which missed yt-dlp output where the Unicode apostrophe (U+2019)
  decoded into `you�re` due to a stdout codepage mismatch on some
  Windows installs. Pattern relaxed to `Sign in to confirm.*not a bot`
  plus a fallback that matches the `Use --cookies-from-browser` hint
  line that yt-dlp emits with this error class.

## [1.0.21] — 2026-05-18

### Added — YouTube login prompt for age/region-locked clips
- When a download fails with "Sign in to confirm you're not a bot" (or
  the age-confirm / Music-Premium variants), the failure is now tagged
  with a `[NEEDS_YT_LOGIN]` marker in the DB instead of being shown raw.
- A modal pops up automatically in the Channel Watcher pane explaining
  what's needed:
  1. open YouTube via the modal's "🌐 เปิด YouTube" button (uses
     `shell.openExternal` to the system browser),
  2. log into the YouTube account whose cookies yt-dlp will read,
  3. click "✓ ฉัน login แล้ว — ลองใหม่" to batch-retry every flagged
     pending in one round-trip.
- Backend exposes `POST /api/watcher/pending/retry-needs-login` that
  resets every NEEDS_YT_LOGIN pending to `pending` and re-runs
  `approve()` on each (Promise.allSettled, so one stubborn clip can't
  break the rest). A new socket event
  `watcher:needs_youtube_login` is also emitted in real time.
- The pending row's error text now reads
  `🔐 ต้อง login YouTube ก่อน — กด "ตกลง" ในกล่องด้านบน` instead of
  the raw yt-dlp stderr, so the user sees actionable guidance.
- Dismissing the modal ("ยกเลิก") suppresses re-opening until a NEW
  flagged failure shows up, so polling doesn't spam the modal.

## [1.0.20] — 2026-05-18

### Fixed — yt-dlp fallback is now unconditional when cookies fail
- The cookie-loading retry path used to match a specific error string
  (`Could not copy ... cookie database`). That covered users running
  Chrome at the same time as the app but missed everything else:
  Chrome not installed at all, cookie DB present but profile name
  mismatch, DPAPI decrypt failures, sandboxed-keychain errors on locked
  Windows accounts. Affected users saw yt-dlp fail on every channel.
- New behavior: if `--cookies-from-browser` (or `--cookies`) is
  configured and the first yt-dlp call returns any non-zero exit, the
  request is retried once with cookies disabled. Anonymous fetch works
  on most public/Shorts content via yt-dlp's default android_vr client,
  so users with no Chrome (or a Chrome that yt-dlp can't read for any
  reason) now succeed on the retry instead of failing outright.

## [1.0.19] — 2026-05-18

### Fixed — Auto-update no longer breaks when the release PAT is revoked
- `publish.private` flipped from `true` to `false` in `package.json`. The
  generated `app-update.yml` shipped with every install told
  electron-updater "this repo is private, always send Authorization", which
  forced it to use the embedded GH_TOKEN. Once that token was revoked
  post-release (standard hygiene), every installed copy of the app got
  HTTP 401 on auto-update and could never reach the next version.
- `electron/main.js` now **drops** the GH_TOKEN env var entirely when only
  the placeholder is present (e.g. local `--dir` builds). Anonymous fetch
  works against the public release repo and stops sending a bad
  Authorization header.
- `scripts/release.js` no longer injects the token into the installer at
  build time. The token is still required at build time for electron-
  builder's `--publish always` to create the release and upload assets,
  but it is no longer baked into the shipped `.exe`. Rotating the token
  now only affects whoever publishes next — installed users are
  unaffected.

### Migration note
- Installed copies of v1.0.17 and v1.0.18 still carry an embedded PAT in
  their main process and will fail auto-update once that PAT is revoked.
  Those users need to manually install v1.0.19 once
  (`https://github.com/Fordlovemm55/kintenshauto-releases/releases/latest`).
  All updates from v1.0.19 onwards work without any token.

## [1.0.18] — 2026-05-18

### Fixed — YouTube anti-bot + cookie-lock auto-retry
- yt-dlp now passes `--cookies-from-browser chrome` + a real-browser
  User-Agent on every playlist fetch and full download. Resolves the
  recurring `[youtube] ...: Sign in to confirm you're not a bot` failure
  that bumped `error_count` on channels with no actual problem.
- **Auto-retry without cookies** when yt-dlp errors with `Could not copy
  Chrome cookie database` (Windows file-locks the DB when Chrome is
  running). Both the playlist-metadata fetch and the full-video download
  detect this specific error and transparently retry once with cookies
  disabled — most public/Shorts content still works because yt-dlp's
  default player client (`android_vr`) doesn't require auth.
- No `--extractor-args` is passed by default. An earlier attempt forced
  `youtube:player_client=mweb,web`, which now requires a GVS PO Token —
  without one yt-dlp only returns storyboard images and downloads fail
  with "Requested format is not available". The default client picks
  itself and works fine.
- Two env-var overrides exposed at backend startup:
  `KINTENSHAUTO_YTDLP_BROWSER` (browser to read cookies from — default
  `chrome`; empty string disables) and `KINTENSHAUTO_YTDLP_COOKIES` (path
  to a Netscape-format `cookies.txt` when not using a browser).
- Download format selector relaxed from `bv*+ba/best` to `bv*+ba/b` — `b`
  matches any single-stream format with both audio + video, which is
  required when an extractor returns combined-only streams.

### Added — Home dashboard digest
- New fourth stat card "รออนุมัติ" surfaces pending Channel Watcher clips.
  Click it (or any digest row) to jump straight to the Watcher tab.
- New panel "ช่องที่มีคลิปใหม่" lists up to 5 channels with pending clips,
  most-recently-checked first, with a `+N` badge per channel.
- New panel "โพสต์ถัดไป" shows a live HH:MM:SS countdown to the next
  scheduled job along with target page, title, and clip index. Falls back
  to `—` when the queue is empty.
- Backend `/api/home/digest` returns both blocks in one round-trip; the
  existing `/api/stats/daily` was extended with `pending_approvals`.

### Changed
- Channel Watcher row no longer shows the red `error ×N` counter under the
  status badge. The cumulative count is still tracked in the DB and still
  auto-disables a channel at 5 failed checks — it just isn't surfaced in
  the UI anymore.

## [1.0.17] — 2026-05-17

### Added — No-AI caption modes
- New `caption_mode` setting (`ai` / `template` / `source_title` / `off`) so
  users can run the entire posting pipeline without paying for any AI
  provider. Honored at BOTH `generateForPage` and `generateForWatcher` entry
  points — no accidental API spend from the watcher shortcut.
- Two helper settings exposed when `template` is picked:
  `caption_template` (user template string) and `caption_emoji_pool` (csv
  emoji rotated into `{emoji}` placeholders).
- Variable support in templates: `{video_title}` `{video_title_short}`
  `{clip_number}` `{total_clips}` `{channel_label}` `{page_name}` `{niche}`
  plus `{emoji}` `{emoji2}` `{emoji3}` for independent random picks.
- Settings UI section "แคปชั่น (AI หรือ Template)" — select for the mode,
  textarea for the template, text input for the emoji pool.

### Fixed
- Facebook "Allow notifications?" permission prompt no longer freezes the
  bot. Three layers: `--disable-notifications` and `--deny-permission-prompts`
  Chrome flags on both `launchForProfile` and `launchPlainChromeForLogin`,
  plus runtime `Permissions.overridePermissions(origin, [])` for the FB / IG
  / X domains via Puppeteer CDP. Catches profiles whose Chrome had a stale
  "granted" entry from before the flags were added.
- Dropdown options in every `<select>` are now readable on the dark theme.
  Chromium-on-Windows renders the open dropdown outside the page DOM with
  white system background but inherits the select's `color`, so cream
  `--text-primary` was unreadable on white. Global `select option`
  override paints them dark with bright text and a darker checked highlight.

## [1.0.16] — 2026-05-17

### Added
- Queue "fresh" indicator: rows that just arrived since the last 5s refresh
  tick get a pulsing gold border + "✨ ใหม่" badge for 15 seconds. The
  panel title shows a "✨ มี N คลิปใหม่ — คลิกเพื่อเลื่อนไปดู" pill that
  scrolls to the first fresh row when clicked. Sets containing fresh clips
  auto-expand. Same treatment for Pending Downloads rows.
- New "การทำงานเบื้องหลัง" section in Settings with two toggles:
  - `close_to_tray` (default on) — closing the window hides to tray instead
    of quitting, so posting keeps running.
  - `chrome_headless` (default off) — Puppeteer Chrome launches hidden so
    it doesn't pop up over the user's other windows. Applies to the next
    Chrome spawn per profile.

### Changed
- Deps downloader writes to `<install-dir>/bin/` instead of always
  `%APPDATA%\Roaming\kintenshauto\bin\`. User who installs to D:\ now keeps
  ffmpeg + yt-dlp on D: too. Legacy AppData path stays in the lookup chain
  so upgrades don't re-download.
- Schedule time picker is now hour + minute `<select>` (00–23 / 00–59)
  instead of `<input type="time">`. Always 24-hour regardless of OS locale
  — English-locale Windows no longer renders the schedule as 12-hour AM/PM.

## [1.0.15] — 2026-05-17

### Added — System dependency gate
- `GET /api/system/deps` re-resolves binary paths from disk on every request
  (was reading cached env vars baked in at backend spawn).
- `DepsRequiredScreen` — full-screen blocking modal that fires on app launch
  if `ffmpeg` or `yt-dlp` is missing. Shows per-binary status, a "📥 ดาวน์โหลด
  ทั้งหมด" button with live progress, and triggers an auto-restart after
  successful install so the backend respawns with correct env paths.
- `app:relaunch` IPC bridge → `app.relaunch() + app.exit(0)` so the entire
  Electron + backend stack restarts cleanly after the deps download.

### Fixed — Channel watcher YouTube tab fallback
- yt-dlp returns `"This channel does not have a videos tab"` for Shorts-only
  / Live-only / music-auto channels. Now `_fetchChannelVideos` wraps the
  call in a fallback chain — original URL first, then `/shorts` → `/videos`
  → `/streams` → root. Retries only on the specific tab/404 errors so real
  failures still surface immediately. Verified manually against the failing
  Thai channel `@สาวสวย-Thailand` (zero items at `/videos`, 3 at `/shorts`).

### Fixed — Facebook auto-login reliability
- Set a mobile Android Chrome user-agent before `page.goto` so FB serves the
  lightweight `m.facebook.com` form with stable `name=email` / `name=pass`
  selectors. The v1.0.14 code routed through `mbasic.facebook.com` but FB
  redirected desktop UA to `www.facebook.com/login.php`, whose React-
  hydrated form took longer than 15s to render the email input → timeout
  and empty Chrome window.
- Wait 2s after navigation then inspect URL — if FB redirected away from
  `/login` (cookies still valid), treat as already-logged-in success
  instead of waiting forever for a form that won't render.
- Try multiple selector variants for email / password / submit; first match
  wins. Handles `m.facebook.com` vs `www.facebook.com` vs the rare
  `m_login_email` legacy id.
- Auto-close Chrome on success (2.5s grace period for cookies to flush);
  leave it open on `needs_2fa` / `login_failed` so the user can finish
  manually. That's the whole point of the flow returning control.

## [1.0.14] — 2026-05-17

### Added — Auto-login for Facebook profiles
- New endpoint `POST /api/profiles/:id/auto-login` that launches the user's
  Puppeteer-controlled Chrome, navigates to `mbasic.facebook.com/login.php`,
  autofills email + password, clicks Login, and hands the window back to the
  user for 2FA / device confirmation. Failure is non-fatal — the profile row
  stays and the user can still use "🌐 เปิด Chrome" to log in manually.
- Profile-add form now fires auto-login automatically after creating a FB
  profile with stored credentials — one click to add + log in. Plain Chrome
  open is still available as a fallback button on the profile card.
- New "⚡ Auto-login" primary button on every FB profile card that has
  credentials (replaces "🌐 เปิด Chrome" as the primary action; the manual
  Chrome button moves to the secondary slot).
- Status reflected in `profiles.status`: `logged_in` / `needs_2fa` /
  `login_failed`. Socket.io `login:status` event broadcasts the result.

### Fixed — Duplicate "ตามช่องอัตโนมัติ" nav entry
- Removed the React `<ChannelWatcher>` tab from `Dashboard.jsx` NAV array.
  `watcher-injection.js` already injects a fuller channel-watcher UI (1768
  lines, 25 endpoints vs the React skeleton's 707 lines / 13 endpoints), so
  having both produced two identical sidebar entries. The injection wins.

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
