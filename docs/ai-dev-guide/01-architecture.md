# 01 — Architecture

## Project 1: Desktop app (THIS folder)

`C:\Users\Pc2026\Desktop\KINTENSHAUTO-Source-v1.0.0\`

```
KINTENSHAUTO-Source-v1.0.0/
├── electron/                 ← Electron main process (Node side)
│   ├── main.js              ← Window lifecycle, IPC, auto-updater, splash, tray, single-instance lock
│   ├── preload.js           ← contextBridge — exposes window.kintenshauto to renderer
│   └── splash.html          ← Startup splash window (loaded by main.js before main window)
│
├── src/                      ← React app (renderer side) + Express backend
│   ├── App.jsx              ← Top-level router: Loading → Login → Setup → Dashboard. Mounts UpdatePromptModal.
│   ├── Dashboard.jsx        ← Main app screen (header, sidebar, nav, panels)
│   ├── login/               ← LoginScreen.jsx — Supabase email/password auth
│   ├── setup-wizard/        ← SetupWizard.jsx — 5-step first-run wizard
│   ├── components/          ← Shared UI components (UpdatePromptModal, SamuraiBackground, etc.)
│   ├── theme/               ← CSS (samurai.css design system)
│   │
│   └── backend/             ← Express server (runs in separate Node process spawned by electron/main.js)
│       ├── server.js        ← All routes (auth, pipeline, watcher, pages, sync, version check). 2600+ lines.
│       ├── core/            ← FB automation primitives ⚠️ DO NOT change behavior
│       │   ├── poster.js              ← Submits the reel to the FB composer
│       │   ├── orchestrator.js        ← Schedules + sequences post jobs
│       │   ├── worker.js              ← Pipeline worker
│       │   ├── scout.js               ← Scrapes channels for new clips
│       │   ├── browserManager.js      ← Puppeteer browser pool
│       │   └── peakSchedule.js        ← Time-of-day slot allocation
│       ├── local/           ← SQLite helpers (db.js — openDatabase, loadSchema, applyMigrations)
│       ├── cloud/           ← Supabase integration (this is the layer to touch for cloud features)
│       │   ├── config.js              ← Reads SUPABASE_URL + ANON_KEY (env, .env, or embedded default)
│       │   ├── supabaseClient.js      ← Cached anon + per-user clients (uses ws transport for Node)
│       │   ├── sessionStore.js        ← Encrypted .session file (AES-256-CBC, per-install key)
│       │   ├── authService.js         ← login() / logout() / refresh() / getStoredSession()
│       │   ├── audit.js               ← Local audit queue + cloud flush
│       │   ├── deviceGuard.js         ← Device ID, claim, heartbeat, Realtime kick subscriber
│       │   ├── syncTables.js          ← List of synced tables (8 tables)
│       │   ├── syncEngine.js          ← LWW push/pull merge
│       │   ├── syncHooks.js           ← Debounced push (2s)
│       │   └── updateChecker.js       ← POST /functions/v1/check-version
│       └── services/        ← Domain services (caption AI, channel watcher, copyright, comment templates, ...)
│
├── public/                   ← Static assets served by Vite, copied to dist/ on build
│   └── assets/
│       ├── watcher-injection.js     ← Hand-written vanilla JS overlay for Channel Watcher screen
│       └── profiles-injection.js    ← Hand-written vanilla JS overlay for Profile Manager
│
├── scripts/                  ← Build helpers
│   ├── download-deps.js     ← Downloads ffmpeg, yt-dlp, fpcalc on first launch
│   └── check-dependencies.js ← Verifies binaries are present + runnable
│
├── tests/                    ← Vitest tests (unit + integration). MSW mocks Supabase.
├── docs/                     ← Specs, plans, this guide, changelogs
├── assets/                   ← Icons (icon.ico, icon.png) — buildResources for electron-builder
│
├── package.json             ← Dependencies, version, electron-builder config (build.publish, build.nsis)
├── schema.sql               ← Local SQLite schema (used on first install)
├── index.html               ← Vite entry — root for React app
├── vite.config.js           ← Vite build config
└── .env                     ← KINTENSHAUTO_SUPABASE_URL + ANON_KEY (gitignored, dev-only)
```

### Process model at runtime

```
KINTENSHAUTO.exe (Electron main)
 ├── splash window (electron/splash.html)
 ├── main window (loads dist/index.html → React)
 └── backend subprocess (node src/backend/server.js, port 3003)
       ├── Express REST API (/api/*)
       ├── Socket.IO server (auth:kicked, deps:progress events)
       ├── Puppeteer Chrome processes (one per FB page)
       └── ffmpeg / yt-dlp / fpcalc child processes
```

The React frontend talks to the local Express backend at `http://localhost:3003`. The backend talks to Supabase. The React frontend NEVER talks to Supabase directly.

## Project 2: Supabase cloud

`C:\Users\Pc2026\Desktop\kintenshauto-cloud\`

```
kintenshauto-cloud/
├── supabase/
│   ├── migrations/          ← SQL migrations applied via `supabase db push --linked`
│   │   ├── 20260516121539_initial_schema.sql       ← 13 tables
│   │   ├── 20260516121744_rls_policies.sql         ← 46 RLS policies
│   │   ├── 20260516121746_device_claim_rpc.sql     ← execute_claim()
│   │   └── 20260516121747_emit_device_kick_rpc.sql ← emit_device_kick()
│   └── functions/           ← Deno edge functions deployed via `supabase functions deploy`
│       ├── device-claim/             ← Atomic device slot claim
│       ├── check-version/            ← Compares client_version → app_versions, returns force/soft
│       └── admin-reset-device/       ← Admin-only force-logout
├── DEPLOY.md                ← Step-by-step deploy commands
└── PROJECT.md               ← Project secrets (gitignored — do not commit)
```

**Live project ref:** `etutmagymtlfagcsvavk`
**URL:** `https://etutmagymtlfagcsvavk.supabase.co`
**Region:** ap-northeast-2 (Seoul)

## Project 3: Admin panel (Next.js on Vercel)

`C:\Users\Pc2026\Desktop\kintenshauto-admin\`

```
kintenshauto-admin/
├── src/
│   ├── app/
│   │   ├── login/                    ← Public — admin sign-in
│   │   ├── (admin)/                  ← Protected — requireAdmin gate via layout.tsx
│   │   │   ├── users/                ← User CRUD + Ban/Unban/Reset device/Delete
│   │   │   ├── sessions/             ← Active devices, force logout
│   │   │   ├── versions/             ← Publish app_versions rows (soft + force update)
│   │   │   └── audit/                ← Audit log viewer
│   │   ├── page.tsx                  ← Root — redirects to /users
│   │   └── globals.css
│   ├── components/                   ← shadcn/ui (base-nova variant — uses @base-ui/react not Radix)
│   ├── lib/
│   │   ├── supabase/                 ← server.ts, client.ts, admin.ts (createClient helpers)
│   │   └── auth/requireAdmin.ts      ← Cached gate (React cache()) for admin check
│   └── middleware.ts                 ← Cookie session refresh for protected routes
├── scripts/
│   └── promote-admin.ts              ← Promote existing user to admin (sets app_metadata.is_admin)
├── vercel.json                       ← regions: ["icn1"] — same as Supabase
├── next.config.ts
└── package.json
```

**Live URL:** https://kintenshauto-admin.vercel.app
**Vercel region:** `icn1` (Seoul — matches Supabase to minimize latency)
**Admin user:** `admin@kintenshauto.local` (password rotated separately)

## How the three projects interact

```
                          ┌─────────────────────────────┐
                          │  GitHub Releases (PUBLIC)   │
                          │  Fordlovemm55/              │
                          │  kintenshauto-releases      │
                          │  → latest.yml + .exe        │
                          └────────────┬────────────────┘
                                       │ fetched by electron-updater (HTTP)
                                       ▼
┌───────────────────┐         ┌────────────────────────┐         ┌──────────────────┐
│  Admin panel      │ ──────► │  Supabase Cloud        │ ◄────── │  Desktop app     │
│  Vercel (Next.js) │  RLS    │  • auth                │  REST + │  Electron+React  │
│  /users           │  auth   │  • app_versions table  │  RT     │  • Express :3003 │
│  /sessions        │         │  • user_devices table  │         │  • SQLite local  │
│  /versions        │         │  • edge functions      │         │  • Puppeteer FB  │
│  /audit           │         │  • 13 tables + RLS     │         │  • auto-update   │
└───────────────────┘         └────────────────────────┘         └──────────────────┘
```

## Key tech-stack version constraints

| Stack | Version | Why pinned |
|---|---|---|
| Node | 24+ | Electron 32 embeds it; better-sqlite3 v12 needs prebuilts for this version |
| Electron | 32.x | Bundles Node 20 inside (NOT 24 — this matters: realtime-js needs `ws` transport passed) |
| better-sqlite3 | 12.x | Node 24 has no prebuilds for v11 — DO NOT downgrade |
| React | 18.x | Stable; Next.js 16 admin panel uses 19, but desktop is separate |
| Next.js (admin) | 16.x | App Router; useSearchParams needs Suspense wrap |
| Tailwind (admin) | v4 | CSS-based config (no `tailwind.config.js`) |
| shadcn variant (admin) | base-nova | Uses `@base-ui/react` NOT Radix — `asChild` prop becomes `render={...}` |
| Supabase JS | 2.105+ | Realtime needs explicit `transport: ws` on Node < 22 |
