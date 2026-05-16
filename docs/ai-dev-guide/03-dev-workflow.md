# 03 — Dev Workflow

How to edit, build, and test the desktop app without publishing.

## Initial setup (fresh machine)

```bash
cd C:/Users/Pc2026/Desktop/KINTENSHAUTO-Source-v1.0.0

# Install dependencies WITHOUT triggering the slow ffmpeg/yt-dlp download
SKIP_POSTINSTALL=1 npm install --ignore-scripts --no-audit --no-fund

# Rebuild the native better-sqlite3 binding for the current Node version
cd node_modules/better-sqlite3
npx prebuild-install --runtime=node --target=$(node --version | sed s/v//) --arch=x64 --platform=win32
cd ../..
```

Required Node version: **24+** (Electron 32 + better-sqlite3 v12 prebuilts).

## Day-to-day editing

| What you edited | What to do |
|---|---|
| `src/` React files | `npm run dev` (Vite dev server on :5173) — Electron picks it up if running |
| `src/backend/*.js` | Restart the backend process — kill `KINTENSHAUTO.exe` + relaunch, or `taskkill /F /IM node.exe /T` to force the spawned backend |
| `electron/*.js` | Full app restart — `taskkill /F /IM KINTENSHAUTO.exe` then relaunch |
| `electron/preload.js` API surface | Rebuild app — preload is loaded into a special context, not hot-reloadable |
| `electron/splash.html` | Restart (splash loaded once on app start) |
| `schema.sql` (new columns/tables) | Add migration logic in `src/backend/local/db.js` `applyMigrations()`. New users get the new schema; existing users get the migration on next start. |
| `package.json` deps | `npm install`, then restart app |
| `package.json` build config | Affects `electron-builder` output only — no app restart needed until next build |

## Run the app in dev mode

Two terminals:

```bash
# Terminal 1 — Vite dev server (React)
npm run dev

# Terminal 2 — Electron pointing at Vite
npm start
```

`electron/main.js` auto-detects Vite on :5173 and loads from there. Falls back to `dist/index.html` if Vite isn't running.

## Build the installer locally (without publishing)

```bash
# Rebuild React → dist/
npm run build-frontend

# Build .exe (NSIS installer) → dist-installer/
npx electron-builder --win --publish=never
```

Output:
- `dist-installer/KINTENSHAUTO-Setup-X.Y.Z.exe` — the installer
- `dist-installer/KINTENSHAUTO-Setup-X.Y.Z.exe.blockmap` — for differential auto-update
- `dist-installer/latest.yml` — electron-updater manifest
- `dist-installer/win-unpacked/KINTENSHAUTO.exe` — already-extracted runnable copy (for quick testing)

`--publish=never` is REQUIRED. Without it, electron-builder will try to POST to GitHub Releases on its own — that's a separate flow and not what we want.

## Test the built installer locally

```bash
# Silent install to a test location
dist-installer/KINTENSHAUTO-Setup-X.Y.Z.exe /S /D=C:\Users\Pc2026\AppData\Local\KTS-test

# Or just run the unpacked version (no install needed, but auto-update may behave differently)
dist-installer/win-unpacked/KINTENSHAUTO.exe
```

**Note:** NSIS silent flag `/S` may not work with `oneClick: false` config. If `/S` produces no install:
- Run the installer manually (double-click → Next → Install)
- Or use `dist-installer/win-unpacked/KINTENSHAUTO.exe` directly

## Run tests

```bash
npx vitest run                              # Run all tests once
npx vitest run tests/backend/cloud/         # Run a folder
npx vitest run tests/backend/cloud/config.test.js  # Run one file
npx vitest                                  # Watch mode
npx vitest run --coverage                   # With coverage report
```

**Known pre-existing failure:** Several backend integration tests fail with `ERR_DLOPEN_FAILED` due to better-sqlite3 native binding issues in the test runner. This is NOT related to recent changes — it's a Node version / prebuild mismatch in the test sandbox. Cloud-related unit tests (with MSW mocks) all pass.

To verify your specific test file:
```bash
npx vitest run tests/backend/cloud/<your-test>.test.js
```

## Read logs while debugging

```
C:/Users/Pc2026/AppData/Roaming/KINTENSHAUTO/logs/
├── app.log         ← Electron main process (updater, splash, IPC)
└── backend.log     ← Express server + cron jobs + watcher + sync
```

Both rotate at 10MB (keeps 3 generations as `.1`, `.2`, `.3`).

## Inspect the running app

The app runs Express on `http://localhost:3003`. From any terminal:

```bash
# Health (always works, even pre-login)
curl http://localhost:3003/api/health
# → {"ok":true,"version":"1.0.7","db":"existing","time":"..."}

# Auth status
curl http://localhost:3003/api/auth/status
# → {"logged_in":true|false,"user":{...}}

# Version check (calls Supabase, may need session)
curl http://localhost:3003/api/version/check
# → {"ok":true,"force_update":{...}|null,"soft_update":{...}|null}
```

## When the app refuses to start

| Symptom | Likely cause | Fix |
|---|---|---|
| Splash screen forever, no main window | Backend crashed on boot | `tail backend.log` — usually a native module or migration error |
| "Cloud not configured" on login | Embedded SUPABASE_URL/KEY missing from build | Check `src/backend/cloud/config.js` DEFAULT_* constants are populated |
| "WebSocket not available" / "Node.js detected without native WebSocket" | Realtime can't find `ws` transport | Verify `realtime: { transport: ws }` in `supabaseClient.js` |
| "Update failed: signed by application owner" | Old install, signature check enabled | Already fixed in v1.0.5+ — user must update past that version |
| Multiple `KINTENSHAUTO.exe` processes | Backend crash + restart loop | `taskkill /F /IM KINTENSHAUTO.exe /T` then relaunch |
| `EADDRINUSE :3003` on backend boot | Previous backend still alive | `taskkill /F /IM node.exe /T` (be careful — kills ALL node processes) |

## Adding a new feature — checklist

1. **Read first.** Use Grep to find all references to what you're touching. Don't assume.
2. **Branch + small commits.** Even though there's no enforced PR workflow, keep changes scoped.
3. **Write a test if it's testable** (anything pure, anything with cloud calls — use MSW).
4. **Run the existing tests** for the area you touched (`npx vitest run tests/backend/cloud/` etc.).
5. **Build locally + smoke test** the installer (or run from `win-unpacked/`).
6. **Read the logs** — `app.log` + `backend.log` for any errors or warnings introduced.
7. **DO NOT publish.** Tell the user what you changed. They will batch with other features and tell you when to release.

## Files that need to stay in sync

| Change in… | …also update |
|---|---|
| `electron/preload.js` (new API method) | `src/App.jsx` or wherever the renderer calls it |
| `src/backend/cloud/syncTables.js` | Supabase `app_versions` ? no — different concern. But check that all listed tables exist + have RLS |
| `package.json` version | Nothing else — but remember to bump for releases |
| `schema.sql` | `src/backend/local/db.js` migration code (otherwise existing installs break) |
| Supabase migration | Re-deploy via `supabase db push --linked` from `../kintenshauto-cloud/` |
| Supabase edge function | Re-deploy via `supabase functions deploy <name> --project-ref etutmagymtlfagcsvavk --no-verify-jwt` |
| Admin panel server action | Vercel auto-deploys on `vercel --prod --yes` from `../kintenshauto-admin/` |
