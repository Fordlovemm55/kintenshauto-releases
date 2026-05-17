# AI Handoff — KINTENSHAUTO

**Read order for the next AI assistant / developer picking up this project:**

1. [`../../CLAUDE.md`](../../CLAUDE.md) — project orientation, structure, critical don'ts
2. [`memory-snapshot/MEMORY.md`](memory-snapshot/MEMORY.md) — index of the prior AI session's persistent memory
3. [`memory-snapshot/project_release_state_v1_0_16.md`](memory-snapshot/project_release_state_v1_0_16.md) — live infra snapshot end of 2026-05-17 (releases, tokens, dev DB seed, repos)
4. [`memory-snapshot/feedback_release_workflow.md`](memory-snapshot/feedback_release_workflow.md) — **HARD RULE: do not auto-publish. Only release on explicit user "อัพ" / "ปล่อย" trigger.**
5. [`memory-snapshot/user_preferences.md`](memory-snapshot/user_preferences.md) — Thai language, no emojis in commits
6. [`memory-snapshot/codebase-architecture.md`](memory-snapshot/codebase-architecture.md) — Electron/React/Express/Puppeteer layer breakdown
7. [`memory-snapshot/project_goals.md`](memory-snapshot/project_goals.md) — what we're building toward
8. [`../ai-dev-guide/README.md`](../ai-dev-guide/README.md) — 7-file deep-dive guide (architecture, do-not-touch zones, dev workflow, release workflow, credentials, pitfalls)
9. [`../../CHANGELOG.md`](../../CHANGELOG.md) — every release since v1.0.x (newest first)

## How to restore this AI's working memory locally

The "auto-memory" feature only loads files from
`~/.claude/projects/<project-slug>/memory/` on each AI session start. The
snapshot in this `memory-snapshot/` folder lets a NEW AI session bootstrap
into the same context:

```bash
# On the new dev's machine, after cloning the repo:
mkdir -p ~/.claude/projects/C--Users-Pc2026-Desktop-KINTENSHAUTO-Source-v1-0-0/memory
cp docs/ai-handoff/memory-snapshot/*.md \
   ~/.claude/projects/C--Users-Pc2026-Desktop-KINTENSHAUTO-Source-v1-0-0/memory/
```

(Adjust the `<project-slug>` if the project is in a different path on the new
machine — Claude Code derives it from the absolute project path.)

The next AI session opening the project directory will auto-load these
files and resume with the same context the previous session had.

## Live release state — end of 2026-05-17

- **v1.0.17** published, force-update active on Supabase `app_versions`
- 17 features shipped today across v1.0.12 → v1.0.17 (see CHANGELOG)
- v1.0.11 and older installs CANNOT auto-update (old embedded PAT was revoked) —
  they see a modal pointing to the direct download URL
- v1.0.12+ installs auto-update normally via the embedded PAT baked at build time

## What's deliberately UNRELEASED

Nothing — all staged commits shipped in v1.0.17 (commit `89758ac`).
Next code change starts from a clean tree.

## Three repositories — co-located on disk

| Repo | Path | Purpose | Pushed? |
|---|---|---|---|
| **Desktop app** | `KINTENSHAUTO-Source-v1.0.0/` (THIS one) | Electron + React + Express + Puppeteer auto-poster | ✅ `Fordlovemm55/kintenshauto-releases` branch `plan2-cloud-integration` |
| **Cloud** | `../kintenshauto-cloud/` | Supabase migrations + edge functions | Deployed to project `etutmagymtlfagcsvavk` — local source not currently version-controlled to GitHub |
| **Admin** | `../kintenshauto-admin/` | Next.js admin panel (users, sessions, versions, audit) | ❌ NOT pushed — waiting on GitHub repo `Fordlovemm55/kintenshauto-admin` to be created |

## Critical operational facts

- **Release workflow:** `$env:GH_TOKEN = 'ghp_or_github_pat_...'; npm run release -- --publish always`. The script (`scripts/release.js`) injects the token into `electron/main.js` at build time, runs electron-builder, and restores the placeholder. Token never lands in git.
- **Cloud version table:** After publishing a GitHub release, the user-facing modal won't fire until you `INSERT` into Supabase `public.app_versions`. Use the SQL pattern in `docs/ai-dev-guide/04-release-workflow.md` step 5, or the Supabase MCP.
- **Auto-update token gotcha:** When publishing, ensure the GH_TOKEN you use has Contents:Read+Write on the release repo. Older `ghp_` classic tokens may have been revoked. Generate fresh fine-grained tokens for each batch.
- **Memory rule:** The operator wants features batched into ONE release per "อัพ" trigger. Do NOT bump version or publish after a code change unless the operator explicitly says "อัพ" / "ปล่อย" / "ship it" / "publish".

## Open follow-ups

- Admin Next.js panel locally built but never pushed (`kintenshauto-admin/` needs a GitHub repo first — operator was asked, never confirmed).
- Token currently used for releases is in this session's chat history. Operator was reminded to revoke after each release; status as of v1.0.17 publish = unknown. **Confirm before reusing.**
- `src/backend/` has 6 untracked stale files (`browserManager.js`, `orchestrator.js`, etc.) — duplicates left over from the `core/` refactor. Server.js imports from `./core/`, so these are dead code. Can be deleted in a cleanup commit.
- `New folder (3)/KINTENSHAUTO-Source-v1.0.0/` on the operator's Desktop is a read-only reference copy of pre-Plan-2 source — useful for "how it used to work" comparisons. Not a checked-out branch.
