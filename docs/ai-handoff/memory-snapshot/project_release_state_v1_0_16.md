---
name: project-release-state-v1-0-16
description: Live release / cloud / token state as of 2026-05-17 end-of-day so next sessions can resume KINTENSHAUTO work without re-deriving infra. v1.0.16 shipped.
metadata: 
  node_type: memory
  type: project
  originSessionId: 68011ab4-e208-4f56-ae40-8b30b1b8319a
---

Snapshot of the desktop app state at end of 2026-05-17 session.

**Latest release:** v1.0.16 (force-update in Supabase `app_versions`).
Five releases shipped today: v1.0.12 → v1.0.13 → v1.0.14 → v1.0.15 → v1.0.16.

**Why:** Next session shouldn't have to re-grep the repo to figure out where releases land, what auth still works, or where the binaries live. This is the "what's actually running in prod" file.

**How to apply:** On a fresh session, read this first to know the deployed version, what auto-update still works for whom, and which integrations are wired up.

---

## Release infra

- Source branch: `plan2-cloud-integration` on `Fordlovemm55/kintenshauto-releases`
- GitHub releases repo: `Fordlovemm55/kintenshauto-releases` (private, source code lives on the branch, release artifacts on tags)
- Supabase project: `etutmagymtlfagcsvavk` (ap-northeast-2) — owned by fordlovemm123@gmail.com
- Desktop edge function: `check-version` (verify_jwt=false; accepts no-auth probes from v1.0.11+ installs)
- Release script: `npm run release -- --publish always` (needs $env:GH_TOKEN with contents:write); `scripts/release.js` injects the token into electron/main.js, builds, publishes, restores placeholder

## Auto-update truth table

| User on | Behavior when v1.0.17+ ships |
|---|---|
| v1.0.16 / v1.0.15 / v1.0.14 / v1.0.13 / v1.0.12 | ✅ Auto-update works (token embedded at build time still valid) |
| v1.0.11 or older | ❌ Embedded classic PAT (now revoked) used to auth GitHub Releases API. Modal still shows but "Update Now" returns "Error invoking remote". Cloud release_notes_md tells them to download manually from a direct URL. |

## Active credentials (treat as sensitive)

- `GH_TOKEN` used for last 5 releases: `<REDACTED_FOR_HANDOFF — ask the operator for a fresh fine-grained PAT with Contents:Read+Write on Fordlovemm55/kintenshauto-releases>`. User was told to revoke after each release; status as of session end = unknown. **Confirm before next release.**
- Supabase anon (publishable) key: `sb_publishable_zlRdIib67v6B8cml000r2g_t8Ne-K_0` — safe to embed (RLS-enforced)
- Supabase service_role + ADMIN_SHARED_SECRET were scrubbed from git history; if needed for admin operations, query Supabase MCP or pull from Vercel env vars (admin repo is `Fordlovemm55/kintenshauto-admin` — NOT pushed to GitHub yet, exists only locally at `C:\Users\Pc2026\Desktop\kintenshauto-admin\`)

## What's in v1.0.16 (the live release)

Bundled features [[user_preferences]] cares about:
- Settings page (AI keys, defaults, storage, maintenance) — `SettingsView.jsx`
- Reviews page (copyright-blocked clips) — `ReviewsView.jsx`
- Banners / Comments / AI Captions pages
- Queue page with grouped layout + ✨ flash on new clips + 24h time picker + pause controls
- Per-page `post_times` schedule
- Auto-login Facebook (Puppeteer-fill on add-profile, auto-close Chrome on success)
- Channel Watcher `/videos → /shorts → /streams` fallback
- DepsRequiredScreen — blocks app launch if yt-dlp/ffmpeg missing, downloads to `<install-dir>/bin/`
- Tray-hide on close + headless Chrome toggles in Settings ("การทำงานเบื้องหลัง")
- Removed duplicate React `<ChannelWatcher>` tab (injection JS handles it)

## Data on Pc2026 dev machine

- DB: `C:\Users\Pc2026\AppData\Roaming\kintenshauto\kintenshauto.db` — seeded with a test page (id=1 "Test Page (เพจทดสอบ)") + channel (id=2 "zzzz" → @สาวสวย-Thailand, shorts) + 2 FB profiles. Use these for repro instead of creating fresh.
- Binaries at `C:\Users\Pc2026\AppData\Roaming\kintenshauto\bin\` (legacy AppData location; v1.0.16+ installs to install-dir but this existing copy still works via fallback)
- Logged in as fordlovemm55@gmail.com (Supabase user 346390f9-8e4b-48c5-8d84-00d153192901)

## What's NOT released yet

Nothing as of session end — all 5 staged commits shipped in v1.0.16 (`2218211`).

## Repos worth knowing

- Desktop: `C:\Users\Pc2026\Desktop\KINTENSHAUTO-Source-v1.0.0\` (this one)
- Cloud / Supabase project files: `C:\Users\Pc2026\Desktop\kintenshauto-cloud\` — deployed
- Admin Next.js panel: `C:\Users\Pc2026\Desktop\kintenshauto-admin\` — built, NOT pushed (waiting on `Fordlovemm55/kintenshauto-admin` repo to be created on GitHub; user was asked, never confirmed creation)
- Original v1.0.x source bundle (reference): `C:\Users\Pc2026\Desktop\New folder (3)\KINTENSHAUTO-Source-v1.0.0\` — read-only reference for "how it used to work"
