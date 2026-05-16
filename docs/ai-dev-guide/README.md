# KINTENSHAUTO — AI Developer Guide

**Audience:** AI coding assistants (Claude, Cursor, Copilot, etc.) onboarding to this codebase from a different machine.

**Read order:**
1. This file (orientation)
2. [01-architecture.md](01-architecture.md) — what each project + folder does
3. [02-do-not-touch.md](02-do-not-touch.md) — forbidden zones (read BEFORE editing anything)
4. [03-dev-workflow.md](03-dev-workflow.md) — day-to-day editing, building, testing
5. [04-release-workflow.md](04-release-workflow.md) — how to publish a new auto-update version
6. [05-credentials.md](05-credentials.md) — where secrets live + how to request them
7. [06-common-pitfalls.md](06-common-pitfalls.md) — bugs that already bit us, don't repeat

---

## What this product is

KINTENSHAUTO is a Windows desktop app for automated Facebook Reel posting.

- **Desktop app**: Electron 32 + React 18 + Express 4 + Puppeteer (FB automation) + better-sqlite3 (local storage)
- **Cloud**: Supabase (auth, RLS, edge functions, Realtime) for user accounts, license control, settings sync, auto-update metadata
- **Admin panel**: Next.js 16 on Vercel for user/device/version management
- **Distribution**: NSIS installer hosted on GitHub Releases (public repo, free), auto-update via `electron-updater`

Three Git-independent project folders sit side-by-side on disk:

```
C:\Users\Pc2026\Desktop\
├── KINTENSHAUTO-Source-v1.0.0\   ← Desktop app (THIS PROJECT)
├── kintenshauto-cloud\           ← Supabase edge functions + migrations
└── kintenshauto-admin\           ← Next.js admin panel (Vercel)
```

## Three hard rules

1. **Never edit `dist/`, `dist-installer/`, `node_modules/`, or `bin/win32/`.** They are generated/downloaded; your edits will be lost.
2. **Never publish a new release (GitHub + `app_versions` insert) without explicit user instruction.** Batch features and wait for "อัพ" / "publish" / "push release". Every published version forces a download + restart on every active install — high churn cost.
3. **Never log out the actual end user without their knowing.** If you need to test login flow, use a separate test account.

## What "publishing a release" means

It is a 5-step ritual that affects every installed copy of the app within ~5 minutes:

1. Bump `package.json` `version`
2. `npx electron-builder --win --publish=never` → generates `dist-installer/*.exe`, `*.blockmap`, `latest.yml`
3. Create GitHub Release tag (e.g. `v1.0.8`) on `Fordlovemm55/kintenshauto-releases`
4. Upload 3 assets (`.exe`, `.blockmap`, `latest.yml`) to that release
5. Insert row into Supabase `app_versions` table (set `min_required = true` for force update)

Continuous polling (every 5 min, baked into the app since v1.0.4) means every running install will see the modal within 5 minutes.

Do NOT do this on your own. Wait for user.

## Where to start when given a task

| Task type | Folder to read first |
|---|---|
| UI change (Dashboard, login, modals) | `src/` |
| Backend API or FB automation | `src/backend/` |
| Auto-updater, splash, IPC, window lifecycle | `electron/` |
| New table, RLS, RPC, or edge function | `../kintenshauto-cloud/supabase/` |
| Admin panel page or server action | `../kintenshauto-admin/src/app/` |
| Type errors / build failures | `package.json` + relevant `.ts(x)/.js(x)` |

## Tone

Match the user's chat language (Thai). Product strings (UI text, log lines, code comments) MUST be English — this is a hard project rule. Existing Thai strings in legacy code stay until migrated as part of the same edit.
