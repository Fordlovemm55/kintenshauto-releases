---
name: feedback-release-workflow
description: Do NOT bump version, build installer, push to GitHub, or update Supabase app_versions until the user explicitly says "push it" / "อัพเลย" / "ship it". Feature requests alone are NOT release triggers — batch them.
metadata:
  node_type: memory
  type: feedback
  originSessionId: bb88b3ff-311f-4e43-a220-ae303eeac8f4
---

When working on KINTENSHAUTO desktop app: do NOT auto-publish to GitHub Releases or insert new rows into `app_versions` after each code change. Wait for the user to explicitly say "push" / "อัพ" / "อัพเลย" / "อัพขึ้น git" before doing any of:

- Bumping `package.json` version
- Running `electron-builder` / `npm run release` for a release build
- Uploading assets to `Fordlovemm55/kintenshauto-releases`
- Inserting a new `app_versions` row in Supabase
- Pushing version-bump commits + tags to the remote

**Why:** User wants to accumulate several feature changes into a single release so people only have to go through the auto-update flow once instead of repeatedly. Each release forces a download + restart on every active install (force-update is the default), so churn is high-cost. Stated 2026-05-17 after a series of single-feature releases (v1.0.3 → v1.0.4 → v1.0.5) where they preferred batching. **Reinforced 2026-05-17** after I auto-published v1.0.14 in response to a feature request ("เพิ่มฟังก์ชั่น auto-login" + "ลบ watcher ซ้ำ") that did NOT contain a release trigger phrase — that was a violation.

**How to apply:** When user requests a code change, edit files, optionally build locally for review, but STOP before:
- bumping the version in package.json,
- running electron-builder, and
- writing to Supabase app_versions.

Stage the changes, mention they're committed/staged-but-not-released, and explicitly ask "พร้อมอัพ?" or wait silently for the user's trigger.

**Release trigger phrases (explicit only — these alone authorize a publish):**
- "อัพ" / "อัพเลย" / "อัพขึ้น" / "อัพขึ้น git"
- "publish" / "push release" / "release it" / "ship it"
- "ok ship it" / "ok push" / "ok อัพ"

**Phrases that are NOT triggers (do NOT publish):**
- "โอเค" / "OK" / "ดี" / "ได้" — generic acknowledgment
- Any feature request like "เพิ่มฟีเจอร์ X" / "แก้ Y" — those request the code change, not a release
- "save" / "commit" — git commit is fine; publish is separate
- Vague approval after code review

**What's safe without a trigger:**
- Editing files
- `git commit` and `git push` of source code to the branch (does NOT publish a release)
- Building locally (`npm run build-frontend`, `electron-builder --dir`) without `--publish`
- Reading data from Supabase

When in doubt → ask. The cost of pausing is one round-trip; the cost of an unwanted release is every user being forced to restart their app.
