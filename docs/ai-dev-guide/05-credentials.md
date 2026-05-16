# 05 — Credentials & Secrets

## Hard rule

**Never write a real secret into any file in this guide.** If you need a credential to do work, ASK THE USER. The user manages all rotation manually.

## Where each credential is needed

| Credential | Used for | Where to store at runtime |
|---|---|---|
| **GitHub PAT** | Creating releases, uploading assets to `Fordlovemm55/kintenshauto-releases`, deleting old assets | Ask user per-session. Embedded in `electron/main.js` `setupAutoUpdater()` for in-app updates (was needed when repo was private; now repo is public — see "PAT cleanup" below). |
| **Supabase Personal Access Token** | Running SQL via `https://api.supabase.com/v1/projects/.../database/query`, deploying edge functions, managing project config | Ask user per-session. NEVER embed. |
| **Supabase service_role key** | Admin panel server-side (admin.auth.admin.*, bypasses RLS) | Stored in `kintenshauto-admin/.env.local` AND in Vercel project env vars. Never expose to client bundle (`NEXT_PUBLIC_*` is forbidden for this). |
| **Supabase anon / publishable key** | Desktop app client + admin panel client (RLS enforces access) | Embedded in `src/backend/cloud/config.js` `DEFAULT_SUPABASE_ANON_KEY` constant AND in `.env`. Safe to expose. |
| **Supabase URL** | Both desktop + admin | `https://etutmagymtlfagcsvavk.supabase.co` — embedded in `config.js` + `.env`. Public, not sensitive. |
| **ADMIN_SHARED_SECRET** | Admin panel → `admin-reset-device` edge function header | Vercel env var + Supabase function secret. Never embedded. |
| **Vercel deploy token** | `vercel --prod` deployments | Ask user per-session. NEVER embed. |
| **AES-256 per-install key** | Encrypts `.session` + saved FB passwords | Generated at `%APPDATA%/KINTENSHAUTO/.encryption-key` on first launch. Never leaves the device. |

## How to request a credential from the user

Phrase it like:

> "I need <credential type> to <do thing>. Could you paste it? It will be used only for <specific call>. Remember to rotate it after — it'll be visible in this chat transcript."

Examples:
- "I need a GitHub PAT with `repo` scope to create the v1.0.X release and upload 3 assets. Paste it here, then revoke at https://github.com/settings/tokens after I'm done."
- "I need the Supabase Personal Access Token to run an SQL update on `app_versions`. Paste it from https://supabase.com/dashboard/account/tokens."

## Public values you CAN paste in code

These are safe to embed in source / installers / docs:

- `KINTENSHAUTO_SUPABASE_URL = https://etutmagymtlfagcsvavk.supabase.co`
- `KINTENSHAUTO_SUPABASE_ANON_KEY = sb_publishable_zlRdIib67v6B8cml000r2g_t8Ne-K_0` (RLS-enforced; safe in clients)
- GitHub repo: `Fordlovemm55/kintenshauto-releases` (public)
- Vercel project: `kintenshauto-admin` (public deployment)
- Vercel deployment URL: `https://kintenshauto-admin.vercel.app`
- Supabase project ref: `etutmagymtlfagcsvavk`
- Admin panel login: `admin@kintenshauto.local` (password rotated separately)

## PAT cleanup (open item)

**Status as of 2026-05-17:** A classic GitHub PAT is embedded in `electron/main.js` line ~534 (`process.env.GH_TOKEN = 'ghp_...'`). This was needed when `Fordlovemm55/kintenshauto-releases` was a private repo. The repo is now PUBLIC, so the embedded PAT is no longer needed for end-user auto-update calls.

**Recommended action (requires user approval):**
1. Remove the embedded `process.env.GH_TOKEN = 'ghp_...'` line from `electron/main.js`
2. Build a new version (e.g. v1.0.X+1)
3. Publish — existing installs auto-update to the PAT-free version
4. Revoke the embedded PAT at https://github.com/settings/tokens

Until that's done, the embedded PAT can be extracted by anyone who unpacks `app.asar`. The PAT scopes are very broad (admin:enterprise, admin:org, repo, delete_repo, ...) — much more than needed. Treat as a known security debt.

## Where files contain secrets (gitignored — don't read or commit)

| File | Location | Contents |
|---|---|---|
| `.env` | `C:/Users/Pc2026/Desktop/KINTENSHAUTO-Source-v1.0.0/.env` | Desktop app dev env vars |
| `kintenshauto-admin/.env.local` | `C:/Users/Pc2026/Desktop/kintenshauto-admin/.env.local` | Admin panel local env (service_role, ADMIN_SHARED_SECRET, etc.) |
| `kintenshauto-cloud/PROJECT.md` | `C:/Users/Pc2026/Desktop/kintenshauto-cloud/PROJECT.md` | Supabase service_role, DB password, function secrets |
| `kintenshauto-admin/.vercel/` | `C:/Users/Pc2026/Desktop/kintenshauto-admin/.vercel/` | Vercel deploy state (project ID, org ID) |
| `%APPDATA%/KINTENSHAUTO/.session` | Per-user | Encrypted Supabase access token |
| `%APPDATA%/KINTENSHAUTO/.encryption-key` | Per-user | AES-256 key |

You may READ these to debug or to extract a value the user explicitly asked you to use. You may NOT commit them to git or paste them in chat unsolicited.

## Test users for development

Recommend creating a separate test account (e.g. `test@kintenshauto.local`) via the admin panel `/users/new`. Use this for any login/logout/kick/ban testing instead of the user's actual account. The real user's session being unexpectedly logged out is one of the more disruptive errors.
