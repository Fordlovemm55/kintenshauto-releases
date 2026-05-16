# Changelog

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
