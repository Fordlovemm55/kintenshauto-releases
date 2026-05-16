# Plan 1 — Foundation: Test Infra + Backend Refactor + Supabase Setup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish baseline test infrastructure, refactor backend into core/local/cloud/services layer structure (no user-visible behavior change), and deploy a Supabase project with the cloud schema, RLS policies, and edge functions. After this plan, the desktop app still works identically to v1.0.0 but is structured for Plans 2 and 3.

**Architecture:**
- Test infrastructure: vitest + msw + supertest, CI on every PR
- Backend folders: `src/backend/{core,local,cloud,services}/` — `cloud/` is empty in this plan (populated in Plan 2)
- Supabase setup lives in a separate repo `kintenshauto-cloud/` containing SQL migrations + edge functions, managed via Supabase CLI

**Tech Stack:**
- Test: vitest 1.x, @vitest/coverage-v8, msw 2.x, supertest 7.x
- Existing: Electron 32, React 18, Express 4, better-sqlite3 11, puppeteer-core 23, socket.io 4
- Cloud: Supabase (managed Postgres + Auth + Realtime + Edge Functions Deno runtime)
- CLI tools: `supabase` (Supabase CLI) for local dev + migrations + deploys

**Reference spec:** `docs/superpowers/specs/2026-05-16-supabase-cloud-integration-design.md`

---

## Phase A: Test Infrastructure (Tasks 1–4)

### Task 1: Install vitest and configure

**Files:**
- Modify: `package.json` (add devDependencies + scripts)
- Create: `vitest.config.js`
- Create: `tests/.gitkeep`

- [ ] **Step 1: Add vitest devDependencies via npm**

Run:
```bash
npm install --save-dev vitest@^1.6.0 @vitest/coverage-v8@^1.6.0 msw@^2.3.0 supertest@^7.0.0
```

Expected: package.json updated, no install errors.

- [ ] **Step 2: Add test scripts to package.json**

Modify `package.json` — locate the `"scripts"` object and add three entries (after existing `"check-deps"`):

```json
"scripts": {
  "start": "electron .",
  "dev": "vite dev",
  "build-frontend": "vite build",
  "postinstall": "electron-builder install-app-deps && node scripts/download-deps.js",
  "check-deps": "node scripts/check-dependencies.js",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage",
  "pack": "npm run build-frontend && electron-builder --dir",
  ...
}
```

- [ ] **Step 3: Create vitest.config.js**

Write `vitest.config.js`:

```javascript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: [
        'src/backend/core/**/*.js',
        'src/backend/local/**/*.js',
        'src/backend/cloud/**/*.js',
        'src/backend/services/**/*.js'
      ],
      exclude: ['**/node_modules/**', 'tests/**'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: {
        // No global threshold yet — Plan 2 will enforce >=70% on cloud/
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0
      }
    },
    testTimeout: 10000
  }
});
```

- [ ] **Step 4: Create empty tests/ directory**

Run:
```bash
mkdir -p tests
touch tests/.gitkeep
```

- [ ] **Step 5: Verify vitest runs (no tests yet)**

Run:
```bash
npm test
```

Expected output: `No test files found` (exit code 0 or with informational message — vitest exits cleanly when no tests match).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.js tests/.gitkeep
git commit -m "test: add vitest infrastructure with empty tests/ directory"
```

---

### Task 2: First unit test — peakSchedule (validates setup)

**Files:**
- Create: `tests/backend/core/peakSchedule.test.js`

`peakSchedule.js` is a pure-function module (no DB, no FS, no network). Perfect first test.

- [ ] **Step 1: Write failing tests**

Create `tests/backend/core/peakSchedule.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import {
  PEAK_SLOTS,
  nextPeakSlotAfter,
  planClipSchedule,
  toSqlLocal,
  friendlyThaiDate
} from '../../../src/backend/peakSchedule.js';

describe('peakSchedule', () => {
  describe('PEAK_SLOTS', () => {
    it('exposes 5 slots ordered by time of day', () => {
      expect(PEAK_SLOTS).toHaveLength(5);
      expect(PEAK_SLOTS.map(s => s.hour)).toEqual([7, 12, 18, 20, 22]);
    });
  });

  describe('nextPeakSlotAfter', () => {
    it('picks 07:00 slot when called at 06:00 with no cooldown', () => {
      const after = new Date(2026, 4, 16, 6, 0, 0); // May 16, 06:00 local
      const { date, slot } = nextPeakSlotAfter(after, 0);
      expect(slot.hour).toBe(7);
      expect(date.getHours()).toBe(7);
      expect(date.getMinutes()).toBe(0);
      expect(date.getDate()).toBe(16);
    });

    it('skips to next day 07:00 when called at 22:30 (after last slot)', () => {
      const after = new Date(2026, 4, 16, 22, 30, 0);
      const { date, slot } = nextPeakSlotAfter(after, 0);
      expect(slot.hour).toBe(7);
      expect(date.getDate()).toBe(17);
    });

    it('respects cooldown — skips slot too close to lastTime', () => {
      const after = new Date(2026, 4, 16, 7, 0, 0); // exactly 07:00
      const { slot } = nextPeakSlotAfter(after, 30); // 30 min cooldown
      // Earliest = 07:30, so 12:30 slot is the next valid
      expect(slot.hour).toBe(12);
      expect(slot.minute).toBe(30);
    });
  });

  describe('planClipSchedule', () => {
    it('plans N clips at consecutive peak slots', () => {
      const start = new Date(2026, 4, 16, 6, 0, 0); // 06:00 May 16
      const plan = planClipSchedule(3, start, 30);
      expect(plan).toHaveLength(3);
      expect(plan[0].slot.hour).toBe(7);
      expect(plan[1].slot.hour).toBe(12);
      expect(plan[2].slot.hour).toBe(18);
    });
  });

  describe('toSqlLocal', () => {
    it('formats date as YYYY-MM-DD HH:MM:SS local time', () => {
      const d = new Date(2026, 4, 16, 7, 5, 30); // May 16, 07:05:30
      expect(toSqlLocal(d)).toBe('2026-05-16 07:05:30');
    });

    it('zero-pads single-digit values', () => {
      const d = new Date(2026, 0, 1, 0, 0, 0); // Jan 1, 00:00:00
      expect(toSqlLocal(d)).toBe('2026-01-01 00:00:00');
    });
  });

  describe('friendlyThaiDate', () => {
    it('returns "วันนี้ HH:MM" for same-day date', () => {
      const ref = new Date(2026, 4, 16, 8, 0, 0);
      const target = new Date(2026, 4, 16, 20, 0, 0);
      expect(friendlyThaiDate(target, ref)).toBe('วันนี้ 20:00');
    });

    it('returns "พรุ่งนี้ HH:MM" for tomorrow', () => {
      const ref = new Date(2026, 4, 16, 8, 0, 0);
      const target = new Date(2026, 4, 17, 12, 30, 0);
      expect(friendlyThaiDate(target, ref)).toBe('พรุ่งนี้ 12:30');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail or pass appropriately**

Run:
```bash
npm test -- tests/backend/core/peakSchedule.test.js
```

Expected: All 8 tests PASS (peakSchedule.js is already implemented correctly). If any fail, it indicates either a vitest config bug or a real peakSchedule bug — investigate before continuing.

- [ ] **Step 3: Commit**

```bash
git add tests/backend/core/peakSchedule.test.js
git commit -m "test: add unit tests for peakSchedule (validates vitest setup)"
```

---

### Task 3: Add CI workflow for tests

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Create workflow file**

Write `.github/workflows/test.yml`:

```yaml
name: Test

on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js 18
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'

      - name: Install dependencies
        run: npm install
        env:
          SKIP_POSTINSTALL: '1'

      - name: Run tests
        run: npm test

      - name: Run coverage
        run: npm run test:coverage
        continue-on-error: true
```

(`continue-on-error: true` on coverage because thresholds are 0 in this plan. Plan 2 removes that flag once thresholds are set.)

- [ ] **Step 2: Verify YAML is valid locally**

Run:
```bash
node -e "const yaml = require('js-yaml'); yaml.load(require('fs').readFileSync('.github/workflows/test.yml','utf-8')); console.log('valid YAML')"
```

If `js-yaml` is missing:
```bash
npx --yes js-yaml@4 .github/workflows/test.yml > /dev/null && echo "valid YAML"
```

Expected: `valid YAML`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add test workflow running on PR and main pushes"
```

---

### Task 4: Smoke test — integration test for /api/health

**Files:**
- Create: `tests/backend/server.health.test.js`

Validates that we can start the Express app in a test process and hit endpoints.

- [ ] **Step 1: Write integration test**

Create `tests/backend/server.health.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// server.js reads KINTENSHAUTO_DB and KINTENSHAUTO_USER_DATA from env.
// Set up an isolated tmpdir before requiring it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kintenshauto-test-'));
process.env.KINTENSHAUTO_USER_DATA = tmpDir;
process.env.KINTENSHAUTO_DB = path.join(tmpDir, 'test.db');
process.env.PORT = '0'; // let OS pick free port — we use supertest agent against the app, not the port

let app, server;

beforeAll(async () => {
  // Import after env is set so server.js picks them up
  ({ app, server } = await import('../../src/backend/server.js'));
});

afterAll(async () => {
  if (server && server.close) {
    await new Promise(resolve => server.close(resolve));
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('GET /api/health', () => {
  it('returns 200 with ok:true', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toBe('1.0.0');
  });

  it('reports correct db state (fresh)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.db).toBe('fresh');
  });
});
```

- [ ] **Step 2: Modify server.js to export app + server**

`src/backend/server.js` currently calls `server.listen(...)` at the bottom but does not export anything. We need to export both so tests can use them without binding to a real port.

Modify `src/backend/server.js` — at the very end of the file (after the final `process.on('unhandledRejection', ...)` line, but BEFORE the channel-watcher IIFE since that block needs to run), add:

```javascript
// Export for tests
module.exports = { app, server };
```

Also wrap the `server.listen(PORT, '127.0.0.1', ...)` call so it doesn't bind during tests:

Find the existing block:
```javascript
server.listen(PORT, '127.0.0.1', () => {
    console.log(`[server] KINTENSHAUTO backend listening on http://localhost:${PORT}`);
    ...
});
```

Replace with:
```javascript
// Only listen if not in test environment
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`[server] KINTENSHAUTO backend listening on http://localhost:${PORT}`);
        console.log(`[server] DB: ${DB_PATH}`);
        console.log(`[server] Overlays: ${OVERLAYS_DIR}`);
        console.log(`[server] Downloads: ${DOWNLOADS_DIR}`);
    });
}
```

vitest sets `process.env.VITEST = 'true'` automatically, so this branch is skipped during tests.

- [ ] **Step 3: Run the test**

Run:
```bash
npm test -- tests/backend/server.health.test.js
```

Expected: Both tests PASS.

If `app` or `server` is undefined in test:
- Verify the `module.exports = { app, server };` line was added at the bottom
- Check for any error during server.js evaluation (likely an FFmpeg auto-resolver issue on macOS/Linux — `resolveWorkingFfmpeg` returns early if not win32, so it should be fine)

- [ ] **Step 4: Commit**

```bash
git add tests/backend/server.health.test.js src/backend/server.js
git commit -m "test: add /api/health integration test + export app/server"
```

---

## Phase B: Backend Folder Refactor (Tasks 5–9)

This phase moves files into `src/backend/{core,local,cloud,services}/` without changing behavior. `cloud/` stays empty for now (Plan 2 fills it). After each move we update imports and run tests.

### Task 5: Create folder structure + move core files

**Files:**
- Create dirs: `src/backend/core/`, `src/backend/local/`, `src/backend/cloud/`
- Move: `src/backend/poster.js` → `src/backend/core/poster.js`
- Move: `src/backend/orchestrator.js` → `src/backend/core/orchestrator.js`
- Move: `src/backend/worker.js` → `src/backend/core/worker.js`
- Move: `src/backend/scout.js` → `src/backend/core/scout.js`
- Move: `src/backend/browserManager.js` → `src/backend/core/browserManager.js`
- Move: `src/backend/peakSchedule.js` → `src/backend/core/peakSchedule.js`

- [ ] **Step 1: Create directories**

Run:
```bash
mkdir -p src/backend/core src/backend/local src/backend/cloud
touch src/backend/cloud/.gitkeep
```

- [ ] **Step 2: Move files with git (preserves history)**

Run:
```bash
git mv src/backend/poster.js src/backend/core/poster.js
git mv src/backend/orchestrator.js src/backend/core/orchestrator.js
git mv src/backend/worker.js src/backend/core/worker.js
git mv src/backend/scout.js src/backend/core/scout.js
git mv src/backend/browserManager.js src/backend/core/browserManager.js
git mv src/backend/peakSchedule.js src/backend/core/peakSchedule.js
```

- [ ] **Step 3: Update intra-core imports**

Each moved file may import others that also moved. Update relative paths. Run these greps to find affected lines:

```bash
grep -n "require('./poster')" src/backend/core/*.js
grep -n "require('./orchestrator')" src/backend/core/*.js
grep -n "require('./worker')" src/backend/core/*.js
grep -n "require('./scout')" src/backend/core/*.js
grep -n "require('./browserManager')" src/backend/core/*.js
grep -n "require('./peakSchedule')" src/backend/core/*.js
grep -n "require('./services/" src/backend/core/*.js
```

For each match: the `./X` requires still work (same directory), but `./services/X` becomes `../services/X`. Update:

In `src/backend/core/browserManager.js`:
- `require('./poster')` → stays `./poster` (both in core/)
- `require('./services/platformConfig')` → `../services/platformConfig`

In `src/backend/core/orchestrator.js`:
- `require('./peakSchedule')` → stays
- `require('./scout')` → stays

In `src/backend/core/worker.js`:
- `require('./poster')` → stays
- `require('./browserManager')` → stays
- `require('./services/copyrightManager')` → `../services/copyrightManager`
- `require('./services/commentTemplateEngine')` → `../services/commentTemplateEngine`
- `require('./peakSchedule')` → stays

In `src/backend/core/poster.js`:
- `require('./services/platformConfig')` → `../services/platformConfig` (search for all occurrences — there are several)

- [ ] **Step 4: Update server.js imports to point to core/**

In `src/backend/server.js`, update the requires for files that moved. Search for each:

```bash
grep -n "require('./poster')\|require('./orchestrator')\|require('./worker')\|require('./scout')\|require('./browserManager')\|require('./peakSchedule')" src/backend/server.js
```

Update each path: `./poster` → `./core/poster`, `./orchestrator` → `./core/orchestrator`, etc.

Note: `require('./services/...')` paths in server.js are UNCHANGED (services/ is still at `src/backend/services/`).

- [ ] **Step 5: Update the existing test import path**

In `tests/backend/core/peakSchedule.test.js`, the import was already written as `'../../../src/backend/peakSchedule.js'`. Update to `'../../../src/backend/core/peakSchedule.js'`:

```javascript
import {
  PEAK_SLOTS, nextPeakSlotAfter, planClipSchedule, toSqlLocal, friendlyThaiDate
} from '../../../src/backend/core/peakSchedule.js';
```

- [ ] **Step 6: Run tests — everything should still pass**

Run:
```bash
npm test
```

Expected: All 10 tests PASS (8 peakSchedule + 2 server.health).

If a test fails with `Cannot find module './X'`: an import path was missed. Re-run the greps from Step 3.

- [ ] **Step 7: Manual smoke test — launch the app**

Run in two terminals:
```bash
# Terminal 1
npm run dev
```
```bash
# Terminal 2
npm start
```

Expected: app launches normally, dashboard loads. Open browser DevTools (Ctrl+Shift+I in the Electron window) → Network tab — `/api/health` returns 200.

Close the app after verifying.

- [ ] **Step 8: Commit**

```bash
git add -A src/backend/ tests/
git commit -m "refactor: move FB automation files into src/backend/core/

No behavior change. Files moved with git mv (history preserved).
All imports updated to reflect new paths."
```

---

### Task 6: Extract SQLite init code to src/backend/local/db.js

**Files:**
- Create: `src/backend/local/db.js`
- Create: `src/backend/local/migrations/.gitkeep`
- Modify: `src/backend/server.js` (lines 150–240 region — DB init + migrations)

Currently `server.js` does DB init + 8 `addColumnIfMissing` calls + `loadStoragePathsFromSettings` inline. Extract to a focused module.

- [ ] **Step 1: Write tests first (TDD)**

Create `tests/backend/local/db.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { openDatabase, applyMigrations } from '../../../src/backend/local/db.js';

let tmpDir, dbPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-db-test-'));
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('openDatabase', () => {
  it('creates a new database file when none exists', () => {
    const { db, isFresh } = openDatabase(dbPath);
    expect(isFresh).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
  });

  it('reports isFresh=false when DB already exists', () => {
    const { db } = openDatabase(dbPath);
    db.close();
    const { isFresh } = openDatabase(dbPath);
    expect(isFresh).toBe(false);
  });

  it('enables foreign_keys pragma', () => {
    const { db } = openDatabase(dbPath);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });
});

describe('applyMigrations', () => {
  it('adds missing columns idempotently', () => {
    const { db } = openDatabase(dbPath);
    // Create a minimal schema for the test
    db.exec(`CREATE TABLE pages (id INTEGER PRIMARY KEY, name TEXT)`);

    applyMigrations(db, [
      { table: 'pages', column: 'niche', definition: 'TEXT' },
      { table: 'pages', column: 'enabled', definition: 'INTEGER DEFAULT 1' }
    ]);

    const cols = db.prepare(`PRAGMA table_info(pages)`).all().map(c => c.name);
    expect(cols).toContain('niche');
    expect(cols).toContain('enabled');

    // Running again is a no-op
    applyMigrations(db, [
      { table: 'pages', column: 'niche', definition: 'TEXT' }
    ]);
    const cols2 = db.prepare(`PRAGMA table_info(pages)`).all().map(c => c.name);
    expect(cols2.filter(c => c === 'niche').length).toBe(1);

    db.close();
  });

  it('logs and continues if a single migration fails', () => {
    const { db } = openDatabase(dbPath);
    db.exec(`CREATE TABLE pages (id INTEGER PRIMARY KEY)`);

    // Bad definition will throw, but should not abort the rest
    applyMigrations(db, [
      { table: 'pages', column: 'bad_col', definition: 'INVALID_TYPE_XYZ' },
      { table: 'pages', column: 'good_col', definition: 'TEXT' }
    ]);

    const cols = db.prepare(`PRAGMA table_info(pages)`).all().map(c => c.name);
    expect(cols).toContain('good_col');
    db.close();
  });
});
```

- [ ] **Step 2: Run tests — they MUST fail (file doesn't exist yet)**

Run:
```bash
npm test -- tests/backend/local/db.test.js
```

Expected: FAIL with `Cannot find module '.../src/backend/local/db.js'`.

- [ ] **Step 3: Create db.js implementation**

Write `src/backend/local/db.js`:

```javascript
// SQLite database management — connection setup + lightweight additive migrations.
// Extracted from src/backend/server.js so it can be tested in isolation.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

/**
 * Open a better-sqlite3 connection at dbPath. Creates the file if missing.
 * Applies the four standard pragmas (WAL, foreign_keys ON, busy_timeout, synchronous NORMAL).
 *
 * @param {string} dbPath  Absolute path to .db file
 * @returns {{ db: Database, isFresh: boolean }} Connection + flag for whether the file was newly created
 * @throws Error if the path cannot be opened (read-only filesystem, permission, etc.)
 */
function openDatabase(dbPath) {
  const isFresh = !fs.existsSync(dbPath);

  let db;
  try {
    db = new Database(dbPath);
  } catch (e) {
    throw new Error(`Cannot open DB at ${dbPath}: ${e.message}`);
  }

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  return { db, isFresh };
}

/**
 * Load + execute a schema.sql file. Idempotent (uses CREATE TABLE IF NOT EXISTS).
 *
 * @param {Database} db
 * @param {string} schemaPath  Absolute path to schema.sql
 */
function loadSchema(db, schemaPath) {
  if (!fs.existsSync(schemaPath)) return;
  const sql = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(sql);
}

/**
 * Apply a list of additive column migrations. Each migration is checked
 * against PRAGMA table_info — if the column already exists, it's a no-op.
 * If an individual migration fails (bad definition, table missing, etc.),
 * logs the error and continues with the rest.
 *
 * @param {Database} db
 * @param {Array<{table: string, column: string, definition: string}>} migrations
 */
function applyMigrations(db, migrations) {
  for (const m of migrations) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${m.table})`).all();
      if (cols.find(c => c.name === m.column)) continue;
      db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.definition}`);
      console.log(`[migration] added ${m.table}.${m.column}`);
    } catch (e) {
      console.error(`[migration] ${m.table}.${m.column} failed:`, e.message);
    }
  }
}

module.exports = { openDatabase, loadSchema, applyMigrations };
```

- [ ] **Step 4: Run tests — they should PASS now**

Run:
```bash
npm test -- tests/backend/local/db.test.js
```

Expected: All 5 db.js tests PASS.

- [ ] **Step 5: Refactor server.js to use local/db.js**

In `src/backend/server.js`, locate the existing DB-init block (approximately lines 163–186) and the migration block (lines 188–229). Replace with calls into the new module.

Find:
```javascript
const schemaPath = path.join(__dirname, '../../schema.sql');
const dbExists = fs.existsSync(DB_PATH);
let db;
try {
    db = new Database(DB_PATH);
} catch (e) {
    console.error(`[startup] FATAL: cannot open DB at ${DB_PATH}: ${e.message}`);
    process.exit(1);
}
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

if (!dbExists && fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(schema);
    console.log('[server] Database initialized from schema.sql');
}

if (fs.existsSync(schemaPath)) {
    try { db.exec(fs.readFileSync(schemaPath, 'utf-8')); } catch (e) { /* non-fatal */ }
}

function addColumnIfMissing(table, column, definition) {
    try {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        if (!cols.find(c => c.name === column)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
            console.log(`[migration] added ${table}.${column}`);
        }
    } catch (e) { console.error('[migration]', table, column, e.message); }
}
// 1 video / 1 page assignment
addColumnIfMissing('scouted_videos', 'assigned_page_id', 'INTEGER');
addColumnIfMissing('clips', 'assigned_page_id', 'INTEGER');
// Per-page batch settings
addColumnIfMissing('pages', 'posts_per_session', 'INTEGER DEFAULT 3');
addColumnIfMissing('pages', 'session_interval_hours', 'INTEGER DEFAULT 24');
addColumnIfMissing('pages', 'last_session_at', 'DATETIME');
// Per-page default search keyword
addColumnIfMissing('pages', 'default_keyword', 'TEXT');
addColumnIfMissing('jobs', 'priority', 'INTEGER DEFAULT 0');

// AI Cover feature
addColumnIfMissing('clips', 'cover_path', 'TEXT');
addColumnIfMissing('pages', 'use_ai_cover', 'INTEGER DEFAULT 0');
addColumnIfMissing('pages', 'cover_prompt', 'TEXT');
addColumnIfMissing('scouted_videos', 'thumbnail_local_path', 'TEXT');

// Caption model selection per prompt row
addColumnIfMissing('caption_prompts', 'selected_model', 'TEXT');

// Multi-platform profile support
addColumnIfMissing('profiles', 'platform', "TEXT NOT NULL DEFAULT 'facebook'");
addColumnIfMissing('profiles', 'account_handle', 'TEXT');

// One-time upgrade: old Gemini default "gemini-2.0-flash" is EOL — swap to gemini-2.5-flash
try {
    const r = db.prepare(`
        UPDATE ai_providers SET model = 'gemini-2.5-flash'
        WHERE provider = 'gemini' AND model = 'gemini-2.0-flash'
    `).run();
    if (r.changes > 0) console.log(`[migration] upgraded ${r.changes} ai_providers row(s) from gemini-2.0-flash to gemini-2.5-flash`);
} catch (e) { /* ignore if table not ready */ }

// Now safe to load storage paths (db is ready)
loadStoragePathsFromSettings();
```

Replace with:

```javascript
const { openDatabase, loadSchema, applyMigrations } = require('./local/db');

const schemaPath = path.join(__dirname, '../../schema.sql');
let db, dbExists;
try {
    const opened = openDatabase(DB_PATH);
    db = opened.db;
    dbExists = !opened.isFresh;
} catch (e) {
    console.error('[startup] FATAL:', e.message);
    process.exit(1);
}

if (!dbExists && fs.existsSync(schemaPath)) {
    loadSchema(db, schemaPath);
    console.log('[server] Database initialized from schema.sql');
}
// Always ensure schema (idempotent via CREATE TABLE IF NOT EXISTS)
try { loadSchema(db, schemaPath); } catch { /* non-fatal */ }

applyMigrations(db, [
    { table: 'scouted_videos', column: 'assigned_page_id', definition: 'INTEGER' },
    { table: 'clips',          column: 'assigned_page_id', definition: 'INTEGER' },
    { table: 'pages',          column: 'posts_per_session', definition: 'INTEGER DEFAULT 3' },
    { table: 'pages',          column: 'session_interval_hours', definition: 'INTEGER DEFAULT 24' },
    { table: 'pages',          column: 'last_session_at', definition: 'DATETIME' },
    { table: 'pages',          column: 'default_keyword', definition: 'TEXT' },
    { table: 'jobs',           column: 'priority', definition: 'INTEGER DEFAULT 0' },
    { table: 'clips',          column: 'cover_path', definition: 'TEXT' },
    { table: 'pages',          column: 'use_ai_cover', definition: 'INTEGER DEFAULT 0' },
    { table: 'pages',          column: 'cover_prompt', definition: 'TEXT' },
    { table: 'scouted_videos', column: 'thumbnail_local_path', definition: 'TEXT' },
    { table: 'caption_prompts', column: 'selected_model', definition: 'TEXT' },
    { table: 'profiles',       column: 'platform', definition: "TEXT NOT NULL DEFAULT 'facebook'" },
    { table: 'profiles',       column: 'account_handle', definition: 'TEXT' }
]);

// One-time upgrade: old Gemini default "gemini-2.0-flash" is EOL → swap to gemini-2.5-flash
// (preserved from original server.js — must run AFTER applyMigrations so caption_prompts.selected_model exists)
try {
    const r = db.prepare(`
        UPDATE ai_providers SET model = 'gemini-2.5-flash'
        WHERE provider = 'gemini' AND model = 'gemini-2.0-flash'
    `).run();
    if (r.changes > 0) console.log(`[migration] upgraded ${r.changes} ai_providers row(s) from gemini-2.0-flash to gemini-2.5-flash`);
} catch (e) { /* ignore if table not ready */ }

// Load user-configured storage paths (preserved from original server.js)
loadStoragePathsFromSettings();
```

Also delete the local `addColumnIfMissing` function definition since it's no longer used. The `loadStoragePathsFromSettings()` function and the gemini upgrade block stay in server.js but move below the new `applyMigrations()` call (as shown above).

- [ ] **Step 6: Run all tests + verify smoke test**

Run:
```bash
npm test
```

Expected: All tests pass (8 peakSchedule + 2 health + 5 db = 15 total).

- [ ] **Step 7: Manual smoke test — launch app**

```bash
# Terminal 1: npm run dev
# Terminal 2: npm start
```

App should launch + dashboard load identically to before. Close after verifying.

- [ ] **Step 8: Commit**

```bash
git add -A src/backend/local/ src/backend/server.js tests/backend/local/
git commit -m "refactor: extract SQLite init+migrations to src/backend/local/db.js

Behavior unchanged. server.js now calls openDatabase/loadSchema/applyMigrations
from a dedicated module. 5 unit tests added for db.js."
```

---

### Task 7: Update electron/main.js path for backend script

**Files:**
- Modify: `electron/main.js` (the `startBackend` function references the backend script path)

The server.js path in main.js hasn't moved — server.js is still at `src/backend/server.js` — but verify nothing broke.

- [ ] **Step 1: Verify backend script path**

Open `electron/main.js`, find `startBackend` (~line 337). Confirm:

```javascript
const backendScript = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'src', 'backend', 'server.js')
    : path.join(__dirname, '..', 'src', 'backend', 'server.js');
```

Both paths are correct (server.js did not move). No change needed.

- [ ] **Step 2: Verify package.json files array still covers the new core/ folder**

Open `package.json`, check `build.files`:

```json
"files": [
  "electron/**/*",
  "dist/**/*",
  "src/backend/**/*",
  "scripts/**/*",
  "schema.sql",
  "!node_modules/**/*test*/**",
  "!**/*.map"
],
```

The pattern `src/backend/**/*` already includes `src/backend/core/`, `src/backend/local/`, `src/backend/cloud/`. No change needed.

- [ ] **Step 3: Commit (empty — just documenting verification)**

If no files changed, skip this commit.

---

### Task 8: Add tests for an existing service (commentTemplateEngine)

This adds real coverage for a service we'll rely on in Plan 2 sync flows.

**Files:**
- Create: `tests/backend/services/commentTemplateEngine.test.js`

- [ ] **Step 1: Write tests**

Create `tests/backend/services/commentTemplateEngine.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';
const { CommentTemplateEngine } = require('../../../src/backend/services/commentTemplateEngine');

let tmpDir, dbPath, db, engine;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-engine-test-'));
  dbPath = path.join(tmpDir, 'test.db');
  db = new Database(dbPath);
  // Minimal schema for the engine
  db.exec(`
    CREATE TABLE comment_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER,
      label TEXT,
      content TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      weight INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  engine = new CommentTemplateEngine(dbPath);
});

afterEach(() => {
  if (db) db.close();
  if (engine?.db) engine.db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('CommentTemplateEngine.render', () => {
  it('substitutes {page_name} variable', () => {
    const out = engine.render('สวัสดี {page_name}', { page_name: 'Page A' });
    expect(out).toBe('สวัสดี Page A');
  });

  it('handles {random:a|b|c} syntax — picks one option', () => {
    const out = engine.render('{random:hi|hello|hey}');
    expect(['hi', 'hello', 'hey']).toContain(out);
  });

  it('replaces unknown variables with empty string', () => {
    const out = engine.render('hello {nonexistent}');
    expect(out).toBe('hello');
  });

  it('substitutes all 8 supported variables', () => {
    const out = engine.render(
      '{page_name} {clip_number}/{total_clips} {hashtag} {caption} {video_title}',
      {
        page_name: 'P',
        clip_number: 2,
        total_clips: 5,
        hashtag: '#x',
        caption: 'cap',
        video_title: 'V'
      }
    );
    expect(out).toBe('P 2/5 #x cap V');
  });
});

describe('CommentTemplateEngine.validateTemplate', () => {
  it('rejects empty content', () => {
    expect(engine.validateTemplate('')).toContain('Content cannot be empty');
    expect(engine.validateTemplate('   ')).toContain('Content cannot be empty');
  });

  it('rejects content > 8000 chars', () => {
    const long = 'x'.repeat(8001);
    expect(engine.validateTemplate(long)).toContain('Content too long (max 8000 chars)');
  });

  it('rejects unknown variables', () => {
    const errors = engine.validateTemplate('hi {bogus_var}');
    expect(errors.some(e => e.includes('Unknown variable'))).toBe(true);
  });

  it('accepts valid template with known variables', () => {
    const errors = engine.validateTemplate('สวัสดี {page_name} {random:a|b}');
    expect(errors).toEqual([]);
  });
});

describe('CommentTemplateEngine.pickRandom', () => {
  it('returns null when no templates exist', () => {
    expect(engine.pickRandom(1)).toBeNull();
  });

  it('picks one of N enabled templates', () => {
    engine.addTemplate(1, 'A', 'hello A');
    engine.addTemplate(1, 'B', 'hello B');
    const picked = engine.pickRandom(1);
    expect(['hello A', 'hello B']).toContain(picked.content);
  });

  it('respects weight (higher weight = more likely)', () => {
    engine.addTemplate(1, 'low', 'low', 1);
    engine.addTemplate(1, 'high', 'high', 100);
    const counts = { low: 0, high: 0 };
    for (let i = 0; i < 200; i++) {
      const p = engine.pickRandom(1);
      counts[p.label]++;
    }
    expect(counts.high).toBeGreaterThan(counts.low * 5);
  });
});

describe('CommentTemplateEngine.preview', () => {
  it('returns { ok: false, errors } for invalid template', () => {
    const r = engine.preview('');
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('Content cannot be empty');
  });

  it('returns { ok: true, rendered } for valid template', () => {
    const r = engine.preview('hello {page_name}');
    expect(r.ok).toBe(true);
    expect(r.rendered).toContain('hello ');
  });
});
```

- [ ] **Step 2: Run tests**

Run:
```bash
npm test -- tests/backend/services/commentTemplateEngine.test.js
```

Expected: All 12 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/backend/services/
git commit -m "test: add unit tests for CommentTemplateEngine (12 tests)"
```

---

### Task 9: Run full test suite + coverage report

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected: ~27 tests pass (8 + 2 + 5 + 12).

- [ ] **Step 2: Generate coverage report**

```bash
npm run test:coverage
```

Open `coverage/index.html` in browser. Verify:
- `src/backend/core/peakSchedule.js` — 70%+ coverage (from Task 2)
- `src/backend/local/db.js` — 80%+ coverage (from Task 6)
- `src/backend/services/commentTemplateEngine.js` — 70%+ coverage (from Task 8)

- [ ] **Step 3: Add a CHANGELOG entry**

Create `CHANGELOG.md` if it doesn't exist, or append:

```markdown
# Changelog

## [Unreleased] — Plan 1 Foundation

### Added
- vitest test infrastructure with msw and supertest
- 27 unit + integration tests covering peakSchedule, db.js, CommentTemplateEngine, /api/health
- GitHub Actions CI workflow (.github/workflows/test.yml)
- `src/backend/core/` folder for FB automation modules
- `src/backend/local/db.js` — extracted SQLite init + migrations
- `src/backend/cloud/` folder (empty placeholder for Plan 2)

### Changed
- Backend FB automation files moved into `src/backend/core/` (history preserved via git mv)
- `server.js` DB initialization now uses `local/db.js` module
- `server.js` does not bind to port when `process.env.VITEST` is set

### Unchanged
- All user-facing behavior identical to v1.0.0
- FB posting pipeline, watcher, scheduler all work as before
- No new dependencies in production bundle (only devDeps for testing)
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add CHANGELOG.md with Plan 1 entries"
```

---

## Phase C: Supabase Project Setup (Tasks 10–16)

This phase creates a separate `kintenshauto-cloud/` repository containing all Supabase migrations + edge functions + RLS policies. The desktop app is NOT modified — the cloud project exists independently, ready for Plan 2 to integrate.

### Task 10: Initialize the kintenshauto-cloud repository

**Files (new repo — separate from kintenshauto):**
- Create directory: `kintenshauto-cloud/` (outside the desktop repo)
- Create: `kintenshauto-cloud/README.md`
- Create: `kintenshauto-cloud/.gitignore`
- Create: `kintenshauto-cloud/supabase/config.toml`

**Prerequisite:** Install Supabase CLI:
```bash
# Windows (via Scoop)
scoop install supabase

# Or via npm (cross-platform)
npm install -g supabase
```

Verify: `supabase --version` returns a version string.

- [ ] **Step 1: Create directory + initialize Supabase project**

Run (outside the kintenshauto desktop repo):
```bash
cd C:/Users/Pc2026/Desktop
mkdir kintenshauto-cloud
cd kintenshauto-cloud
git init
supabase init
```

This creates `supabase/config.toml`, `supabase/migrations/`, `supabase/functions/`, and `supabase/seed.sql`.

- [ ] **Step 2: Write README**

Create `kintenshauto-cloud/README.md`:

```markdown
# KINTENSHAUTO Cloud

Supabase project for KINTENSHAUTO v2.0+ — handles auth, license management,
settings sync, and version pinning for the desktop app.

## Structure

- `supabase/migrations/`  — SQL migration files (timestamped)
- `supabase/functions/`   — Deno edge functions (device-claim, check-version, admin-reset-device)
- `supabase/config.toml`  — local dev config
- `supabase/seed.sql`     — dev-only seed data

## Local development

```bash
supabase start         # boots local Postgres + Auth + Storage in Docker
supabase db reset      # rebuilds DB from migrations + seed
supabase functions serve  # starts edge functions on localhost:54321
```

## Deployment

```bash
supabase link --project-ref <project-id>
supabase db push       # apply migrations to remote
supabase functions deploy <function-name>
```

## Related

- Desktop app: `../kintenshauto/`
- Admin panel: `../kintenshauto-admin/` (Plan 3)
- Spec: `../kintenshauto/docs/superpowers/specs/2026-05-16-supabase-cloud-integration-design.md`
```

- [ ] **Step 3: Configure .gitignore**

Create `kintenshauto-cloud/.gitignore`:

```
# Supabase
supabase/.branches
supabase/.temp
.env
.env.local
.env.*.local

# Node (for any future tooling)
node_modules/
*.log
```

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "chore: initialize kintenshauto-cloud Supabase project"
```

---

### Task 11: Write the cloud schema migration

**Files:**
- Create: `kintenshauto-cloud/supabase/migrations/20260516000001_initial_schema.sql`

- [ ] **Step 1: Generate timestamped migration file**

Run inside `kintenshauto-cloud/`:
```bash
supabase migration new initial_schema
```

This creates a file like `supabase/migrations/<timestamp>_initial_schema.sql`. Note the actual timestamp produced (rename in instructions below if different).

- [ ] **Step 2: Write the schema**

Edit the generated migration file:

```sql
-- =============================================================================
-- Initial schema for KINTENSHAUTO cloud
-- Per spec: docs/superpowers/specs/2026-05-16-supabase-cloud-integration-design.md
-- Section 3.3
-- =============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- -----------------------------------------------------------------------------
-- Device tracking — 1-device-per-user rule
-- -----------------------------------------------------------------------------
CREATE TABLE public.user_devices (
  user_id        UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id      TEXT NOT NULL,
  device_label   TEXT,
  claimed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_token  TEXT NOT NULL
);
CREATE INDEX idx_user_devices_session ON public.user_devices(session_token);

-- -----------------------------------------------------------------------------
-- Encryption keys (per user) for syncing encrypted blobs
-- -----------------------------------------------------------------------------
CREATE TABLE public.user_secrets (
  user_id        UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  encryption_key TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- App version registry — soft and force updates
-- -----------------------------------------------------------------------------
CREATE TABLE public.app_versions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version             TEXT NOT NULL UNIQUE,
  min_required        BOOLEAN NOT NULL DEFAULT false,
  release_notes_md    TEXT,
  download_url        TEXT,
  published_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by        UUID REFERENCES auth.users(id)
);
CREATE INDEX idx_app_versions_required ON public.app_versions(min_required, published_at DESC);
CREATE INDEX idx_app_versions_published ON public.app_versions(published_at DESC);

-- -----------------------------------------------------------------------------
-- Sync mirror tables (one per local synced table from spec section 4.4)
-- All have: cloud_uuid, user_id, updated_at, deleted_at (soft delete)
-- -----------------------------------------------------------------------------

-- pages metadata (FB page list — NOT cookies)
CREATE TABLE public.cloud_pages (
  cloud_uuid       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fb_page_id       TEXT NOT NULL,
  name             TEXT NOT NULL,
  niche            TEXT,
  daily_quota      INTEGER DEFAULT 5,
  cooldown_min     INTEGER DEFAULT 30,
  default_keyword  TEXT,
  enabled          INTEGER DEFAULT 1,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX idx_cloud_pages_user ON public.cloud_pages(user_id) WHERE deleted_at IS NULL;

-- banner presets (JSON layer config — image blobs stay local)
CREATE TABLE public.cloud_banner_presets (
  cloud_uuid    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  layers_json   TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX idx_cloud_banner_presets_user ON public.cloud_banner_presets(user_id) WHERE deleted_at IS NULL;

-- banner metadata (file_path stays local; we sync name + dimensions for UI hints)
CREATE TABLE public.cloud_banners (
  cloud_uuid    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  width_px      INTEGER,
  height_px     INTEGER,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX idx_cloud_banners_user ON public.cloud_banners(user_id) WHERE deleted_at IS NULL;

-- caption prompts
CREATE TABLE public.cloud_caption_prompts (
  cloud_uuid     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_cloud_uuid UUID REFERENCES public.cloud_pages(cloud_uuid),
  system_prompt  TEXT NOT NULL,
  user_prompt    TEXT NOT NULL,
  max_tokens     INTEGER DEFAULT 200,
  temperature    REAL DEFAULT 0.8,
  selected_model TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX idx_cloud_caption_prompts_user ON public.cloud_caption_prompts(user_id) WHERE deleted_at IS NULL;

-- comment templates
CREATE TABLE public.cloud_comment_templates (
  cloud_uuid       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_cloud_uuid  UUID REFERENCES public.cloud_pages(cloud_uuid),
  label            TEXT,
  content          TEXT NOT NULL,
  weight           INTEGER DEFAULT 1,
  enabled          INTEGER DEFAULT 1,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX idx_cloud_comment_templates_user ON public.cloud_comment_templates(user_id) WHERE deleted_at IS NULL;

-- comment settings (per page)
CREATE TABLE public.cloud_comment_settings (
  page_cloud_uuid   UUID PRIMARY KEY REFERENCES public.cloud_pages(cloud_uuid) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled           INTEGER DEFAULT 1,
  delay_sec         INTEGER DEFAULT 20,
  jitter_sec        INTEGER DEFAULT 10,
  max_per_day       INTEGER DEFAULT 30,
  cooldown_min      INTEGER DEFAULT 5,
  enable_self_reply INTEGER DEFAULT 0,
  enable_pin        INTEGER DEFAULT 0,
  detect_removal    INTEGER DEFAULT 1,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX idx_cloud_comment_settings_user ON public.cloud_comment_settings(user_id) WHERE deleted_at IS NULL;

-- watched channels (Channel Watcher)
CREATE TABLE public.cloud_watched_channels (
  cloud_uuid          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,
  platform            TEXT NOT NULL,
  channel_url         TEXT NOT NULL,
  content_type        TEXT NOT NULL DEFAULT 'all',
  interval_hours      REAL NOT NULL DEFAULT 5,
  min_duration_sec    INTEGER DEFAULT 0,
  max_duration_sec    INTEGER DEFAULT 0,
  enabled             INTEGER DEFAULT 1,
  page_cloud_uuids    JSONB DEFAULT '[]'::jsonb, -- junction stored as array
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX idx_cloud_watched_channels_user ON public.cloud_watched_channels(user_id) WHERE deleted_at IS NULL;

-- AI providers (encrypted api keys)
CREATE TABLE public.cloud_ai_providers (
  cloud_uuid     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,         -- 'openai' | 'anthropic' | 'gemini'
  encrypted_key  TEXT NOT NULL,          -- AES-encrypted with user_secrets.encryption_key
  model          TEXT NOT NULL,
  label          TEXT,
  enabled        INTEGER DEFAULT 1,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX idx_cloud_ai_providers_user ON public.cloud_ai_providers(user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_cloud_ai_providers_user_provider
  ON public.cloud_ai_providers(user_id, provider)
  WHERE deleted_at IS NULL;

-- key/value settings (allowlisted same as local ALLOWED_SETTING_KEYS)
CREATE TABLE public.cloud_settings (
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  PRIMARY KEY (user_id, key)
);

-- -----------------------------------------------------------------------------
-- Audit log
-- -----------------------------------------------------------------------------
CREATE TABLE public.audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event       TEXT NOT NULL,
  detail_json JSONB,
  ip          INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_user ON public.audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_event ON public.audit_log(event, created_at DESC);

-- -----------------------------------------------------------------------------
-- Helper: trigger to bump updated_at on UPDATE
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bump_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all cloud_* tables that need it
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'cloud_pages', 'cloud_banner_presets', 'cloud_banners',
    'cloud_caption_prompts', 'cloud_comment_templates', 'cloud_comment_settings',
    'cloud_watched_channels', 'cloud_ai_providers', 'cloud_settings',
    'user_devices'
  ])
  LOOP
    EXECUTE format('
      CREATE TRIGGER trg_%I_bump_updated_at
      BEFORE UPDATE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.bump_updated_at();
    ', t, t);
  END LOOP;
END$$;
```

- [ ] **Step 3: Test the migration locally**

Start local Supabase (requires Docker Desktop):
```bash
supabase start
```

Apply migrations:
```bash
supabase db reset
```

Expected: All migrations apply cleanly. Output ends with `Finished supabase db reset`.

Inspect schema:
```bash
supabase db inspect tables --schema public
```

Expected: lists all 12 tables (user_devices, user_secrets, app_versions, cloud_pages, cloud_banner_presets, cloud_banners, cloud_caption_prompts, cloud_comment_templates, cloud_comment_settings, cloud_watched_channels, cloud_ai_providers, cloud_settings, audit_log).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/
git commit -m "feat(schema): add initial cloud tables — devices, secrets, sync mirrors, audit"
```

---

### Task 12: Add Row Level Security policies

**Files:**
- Create: `kintenshauto-cloud/supabase/migrations/20260516000002_rls_policies.sql`

- [ ] **Step 1: Generate migration**

```bash
supabase migration new rls_policies
```

- [ ] **Step 2: Write RLS policies**

Edit the new migration file:

```sql
-- =============================================================================
-- Row Level Security — users see only their own data
-- service_role bypasses RLS automatically (admin panel uses service_role key)
-- =============================================================================

-- Enable RLS on all user-scoped tables
ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_banner_presets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_banners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_caption_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_comment_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_comment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_watched_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cloud_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_versions ENABLE ROW LEVEL SECURITY;

-- Generic policy template: user can do anything to their own rows
-- user_devices and user_secrets — keyed by user_id
CREATE POLICY "users see own devices"    ON public.user_devices FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "users see own secrets"    ON public.user_secrets FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- All cloud_* mirror tables — same pattern
CREATE POLICY "users see own pages"             ON public.cloud_pages             FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "users see own banner_presets"    ON public.cloud_banner_presets    FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "users see own banners"           ON public.cloud_banners           FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "users see own caption_prompts"   ON public.cloud_caption_prompts   FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "users see own comment_templates" ON public.cloud_comment_templates FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "users see own comment_settings"  ON public.cloud_comment_settings  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "users see own watched_channels"  ON public.cloud_watched_channels  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "users see own ai_providers"      ON public.cloud_ai_providers      FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "users see own settings"          ON public.cloud_settings          FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- audit_log — users can INSERT their own events; SELECT only own; no UPDATE/DELETE
CREATE POLICY "users insert own audit"  ON public.audit_log FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "users see own audit"     ON public.audit_log FOR SELECT TO authenticated USING (user_id = auth.uid());

-- app_versions — all authenticated users can SELECT (everyone needs to check versions)
--                only service_role can INSERT/UPDATE/DELETE (admin panel)
CREATE POLICY "everyone reads versions" ON public.app_versions FOR SELECT TO authenticated USING (true);
```

- [ ] **Step 3: Apply + test RLS**

```bash
supabase db reset
```

Test RLS works — connect as anon (no auth):
```bash
supabase db query "SELECT * FROM public.cloud_pages;" --role anon
```
Expected: empty result (RLS filters everything out).

As authenticated user (service_role bypasses RLS):
```bash
supabase db query "SELECT * FROM public.cloud_pages;" --role service_role
```
Expected: works (returns whatever rows exist).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/
git commit -m "feat(schema): add RLS policies — users see only own data"
```

---

### Task 13: Write device-claim edge function

**Files:**
- Create: `kintenshauto-cloud/supabase/functions/device-claim/index.ts`
- Create: `kintenshauto-cloud/supabase/functions/device-claim/deno.json`

- [ ] **Step 1: Generate function scaffold**

```bash
supabase functions new device-claim
```

This creates `supabase/functions/device-claim/index.ts` with a starter template.

- [ ] **Step 2: Write the implementation**

Replace the generated `supabase/functions/device-claim/index.ts` with:

```typescript
// Edge function: device-claim
// Atomically claim a device slot for the authenticated user.
// If another device holds the slot, emit a kick signal via pg_notify.
//
// POST /functions/v1/device-claim
// Headers: Authorization: Bearer <user_jwt>
// Body: { device_id: string, device_label: string }
//
// Response 200: { status: 'claimed' | 'reclaimed', is_takeover: boolean, session_token: string }
// Response 401: { error: 'unauthorized' }
// Response 400: { error: 'bad_request', detail: string }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

interface ClaimRequest {
  device_id: string;
  device_label?: string;
}

interface ClaimResponse {
  status: 'claimed' | 'reclaimed';
  is_takeover: boolean;
  session_token: string;
}

function generateSessionToken(): string {
  return crypto.randomUUID();
}

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let body: ClaimRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad_request', detail: 'invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!body.device_id || typeof body.device_id !== 'string' || body.device_id.length < 8) {
    return new Response(JSON.stringify({ error: 'bad_request', detail: 'device_id required (min 8 chars)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Service-role client for atomic write + pg_notify
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Resolve user from JWT
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: 'unauthorized', detail: userErr?.message }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  const userId = userData.user.id;

  const newSessionToken = generateSessionToken();

  // Atomic upsert with conditional logic via Postgres function
  // We use a single SQL statement that handles all three cases:
  //   1. No row → INSERT, return is_takeover=false
  //   2. Same device → UPDATE last_seen+session_token, is_takeover=false
  //   3. Different device → emit pg_notify, UPDATE, is_takeover=true
  const sql = `
    WITH existing AS (
      SELECT user_id, device_id, session_token
      FROM public.user_devices
      WHERE user_id = $1
      FOR UPDATE
    ),
    notification AS (
      SELECT pg_notify('device_kick:' || $1, existing.session_token)
      FROM existing
      WHERE existing.device_id IS DISTINCT FROM $2
    ),
    upserted AS (
      INSERT INTO public.user_devices (user_id, device_id, device_label, session_token, claimed_at, last_seen_at)
      VALUES ($1, $2, $3, $4, now(), now())
      ON CONFLICT (user_id) DO UPDATE
        SET device_id     = EXCLUDED.device_id,
            device_label  = EXCLUDED.device_label,
            session_token = EXCLUDED.session_token,
            claimed_at    = CASE
                              WHEN public.user_devices.device_id IS DISTINCT FROM EXCLUDED.device_id
                              THEN now()
                              ELSE public.user_devices.claimed_at
                            END,
            last_seen_at  = now()
      RETURNING user_id, device_id, session_token
    )
    SELECT
      upserted.session_token,
      CASE
        WHEN (SELECT device_id FROM existing) IS NULL THEN 'claimed'
        WHEN (SELECT device_id FROM existing) = $2 THEN 'reclaimed'
        ELSE 'claimed'
      END AS status,
      CASE
        WHEN (SELECT device_id FROM existing) IS NOT NULL
         AND (SELECT device_id FROM existing) <> $2 THEN true
        ELSE false
      END AS is_takeover,
      (SELECT device_id FROM existing) AS old_device_id
    FROM upserted;
  `;

  const { data: result, error: rpcErr } = await supabase.rpc('execute_claim', {
    p_user_id: userId,
    p_device_id: body.device_id,
    p_device_label: body.device_label || 'Unknown device',
    p_session_token: newSessionToken
  }).single();

  // We use an RPC function (defined in next migration) instead of raw SQL
  // because supabase-js v2 does not support inline SQL with WITH clauses.

  if (rpcErr) {
    return new Response(JSON.stringify({ error: 'internal', detail: rpcErr.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Log to audit_log
  await supabase.from('audit_log').insert({
    user_id: userId,
    event: result.is_takeover ? 'device_takeover' : (result.status === 'claimed' ? 'device_claim' : 'device_reclaim'),
    detail_json: {
      device_id: body.device_id,
      device_label: body.device_label,
      old_device_id: result.old_device_id
    },
    ip: req.headers.get('x-forwarded-for'),
    user_agent: req.headers.get('user-agent')
  });

  const response: ClaimResponse = {
    status: result.status,
    is_takeover: result.is_takeover,
    session_token: result.session_token
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
});
```

- [ ] **Step 3: Add the supporting RPC function as a migration**

```bash
supabase migration new device_claim_rpc
```

Edit the new migration:

```sql
-- RPC function called from the device-claim edge function.
-- Performs the atomic device slot claim with pg_notify for takeover.

CREATE OR REPLACE FUNCTION public.execute_claim(
  p_user_id        UUID,
  p_device_id      TEXT,
  p_device_label   TEXT,
  p_session_token  TEXT
) RETURNS TABLE (
  session_token  TEXT,
  status         TEXT,
  is_takeover    BOOLEAN,
  old_device_id  TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_existing_device_id   TEXT;
  v_existing_session     TEXT;
BEGIN
  -- Lock the row (or absence) for this user
  SELECT ud.device_id, ud.session_token
  INTO v_existing_device_id, v_existing_session
  FROM public.user_devices ud
  WHERE ud.user_id = p_user_id
  FOR UPDATE;

  -- Emit kick notification if a different device holds the slot
  IF v_existing_device_id IS NOT NULL AND v_existing_device_id <> p_device_id THEN
    PERFORM pg_notify('device_kick:' || p_user_id::text, v_existing_session);
  END IF;

  -- Upsert
  INSERT INTO public.user_devices (user_id, device_id, device_label, session_token, claimed_at, last_seen_at)
  VALUES (p_user_id, p_device_id, p_device_label, p_session_token, now(), now())
  ON CONFLICT (user_id) DO UPDATE
    SET device_id     = EXCLUDED.device_id,
        device_label  = EXCLUDED.device_label,
        session_token = EXCLUDED.session_token,
        claimed_at    = CASE
                          WHEN public.user_devices.device_id IS DISTINCT FROM EXCLUDED.device_id
                          THEN now()
                          ELSE public.user_devices.claimed_at
                        END,
        last_seen_at  = now();

  -- Return computed status
  RETURN QUERY SELECT
    p_session_token AS session_token,
    CASE
      WHEN v_existing_device_id IS NULL THEN 'claimed'
      WHEN v_existing_device_id = p_device_id THEN 'reclaimed'
      ELSE 'claimed'
    END AS status,
    (v_existing_device_id IS NOT NULL AND v_existing_device_id <> p_device_id) AS is_takeover,
    v_existing_device_id AS old_device_id;
END;
$$;

-- Grant execute to authenticated role (edge function calls via service_role,
-- but expose to authenticated for direct testing too)
GRANT EXECUTE ON FUNCTION public.execute_claim(UUID, TEXT, TEXT, TEXT) TO authenticated, service_role;
```

- [ ] **Step 4: Apply migrations + test the function locally**

```bash
supabase db reset
supabase functions serve device-claim
```

In another terminal, create a test user via Supabase CLI:
```bash
supabase auth users invite --email test@example.com
# (in local Supabase, this just creates the user; password reset link goes to inbucket: http://localhost:54324)
```

Get a JWT from the local Supabase Studio (http://localhost:54323 → Auth → Users → click user → copy access token), or use `supabase auth login` to issue one programmatically.

Call the function:
```bash
curl -X POST http://localhost:54321/functions/v1/device-claim \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"device_id":"test-device-12345","device_label":"Test PC"}'
```

Expected response:
```json
{"status":"claimed","is_takeover":false,"session_token":"<uuid>"}
```

Verify in DB:
```bash
supabase db query "SELECT * FROM public.user_devices;"
```

Should show one row.

Call again with a different device_id:
```bash
curl -X POST http://localhost:54321/functions/v1/device-claim \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"device_id":"different-device","device_label":"Other PC"}'
```

Expected: `{"status":"claimed","is_takeover":true,"session_token":"<new uuid>"}`

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/device-claim/ supabase/migrations/
git commit -m "feat(functions): add device-claim edge function with atomic execute_claim RPC"
```

---

### Task 14: Write check-version edge function

**Files:**
- Create: `kintenshauto-cloud/supabase/functions/check-version/index.ts`

- [ ] **Step 1: Generate scaffold**

```bash
supabase functions new check-version
```

- [ ] **Step 2: Implement**

Replace `supabase/functions/check-version/index.ts`:

```typescript
// Edge function: check-version
// Compare client app version to the version registry and tell the client
// whether to force-update, soft-update, or proceed.
//
// POST /functions/v1/check-version
// Headers: Authorization: Bearer <user_jwt>
// Body: { client_version: string }
//
// Response 200: {
//   ok: boolean,
//   force_update: { required_version: string, download_url: string, release_notes_md: string } | null,
//   soft_update: { latest_version: string, release_notes_md: string } | null
// }
// Response 400 / 401 as usual

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

interface CheckVersionRequest {
  client_version: string;
}

// Semver compare: returns -1 if a < b, 0 if equal, 1 if a > b
// Accepts forms like "1.0.0", "1.0.0-beta.1" (suffix ignored beyond major.minor.patch for now)
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main] = v.split('-');
    return main.split('.').map(n => parseInt(n, 10) || 0);
  };
  const aParts = parse(a);
  const bParts = parse(b);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const ai = aParts[i] || 0;
    const bi = bParts[i] || 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405 });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  let body: CheckVersionRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad_request', detail: 'invalid JSON' }), { status: 400 });
  }

  if (!body.client_version || typeof body.client_version !== 'string') {
    return new Response(JSON.stringify({ error: 'bad_request', detail: 'client_version required' }), { status: 400 });
  }

  // Read-only — use anon client with user JWT (RLS allows authenticated SELECT on app_versions)
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );

  // Highest min_required version (force update threshold)
  const { data: requiredRow } = await supabase
    .from('app_versions')
    .select('version, release_notes_md, download_url')
    .eq('min_required', true)
    .order('published_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Latest published (soft update)
  const { data: latestRow } = await supabase
    .from('app_versions')
    .select('version, release_notes_md, download_url')
    .order('published_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let force_update = null;
  let soft_update = null;

  if (requiredRow && compareVersions(body.client_version, requiredRow.version) < 0) {
    force_update = {
      required_version: requiredRow.version,
      download_url: requiredRow.download_url || '',
      release_notes_md: requiredRow.release_notes_md || ''
    };
  } else if (latestRow && compareVersions(body.client_version, latestRow.version) < 0) {
    soft_update = {
      latest_version: latestRow.version,
      release_notes_md: latestRow.release_notes_md || '',
      download_url: latestRow.download_url || ''
    };
  }

  return new Response(JSON.stringify({
    ok: force_update === null,
    force_update,
    soft_update
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
});
```

- [ ] **Step 3: Test locally**

Insert test versions:
```bash
supabase db query "
  INSERT INTO public.app_versions (version, min_required, release_notes_md, download_url) VALUES
    ('1.0.0', false, 'Initial release', 'https://example.com/v1.0.0.exe'),
    ('1.1.0', false, 'Fixes', 'https://example.com/v1.1.0.exe'),
    ('1.2.0', true,  'Critical security fix', 'https://example.com/v1.2.0.exe');
"
```

```bash
supabase functions serve check-version
```

Call with v1.0.0:
```bash
curl -X POST http://localhost:54321/functions/v1/check-version \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"client_version":"1.0.0"}'
```

Expected: `force_update` populated (since 1.2.0 is min_required, and 1.0.0 < 1.2.0).

Call with v1.2.0:
```bash
curl -X POST http://localhost:54321/functions/v1/check-version \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"client_version":"1.2.0"}'
```

Expected: `ok: true, force_update: null, soft_update: null`.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/check-version/
git commit -m "feat(functions): add check-version edge function with semver comparison"
```

---

### Task 15: Write admin-reset-device edge function

**Files:**
- Create: `kintenshauto-cloud/supabase/functions/admin-reset-device/index.ts`

This function lets an admin clear a user's device slot so they can log in from a new machine.

- [ ] **Step 1: Generate scaffold**

```bash
supabase functions new admin-reset-device
```

- [ ] **Step 2: Implement**

Replace `supabase/functions/admin-reset-device/index.ts`:

```typescript
// Edge function: admin-reset-device
// Allow an admin (via service_role key, NOT user JWT) to delete a user's device slot.
// The user will be able to log in fresh on next attempt.
//
// POST /functions/v1/admin-reset-device
// Headers:
//   Authorization: Bearer <SERVICE_ROLE_KEY>   (NOT a user JWT — admin only)
//   X-Admin-Auth:  <ADMIN_SHARED_SECRET>       (additional gate)
// Body: { user_id: string }
//
// Response 200: { ok: true, was_present: boolean, old_device_id: string|null }
// Response 401: { error: 'unauthorized' }

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405 });
  }

  // Two-factor admin auth:
  //   1. Authorization header MUST contain service_role key
  //   2. X-Admin-Auth MUST equal ADMIN_SHARED_SECRET env var
  const authHeader = req.headers.get('Authorization');
  const adminAuth = req.headers.get('X-Admin-Auth');
  const expectedService = `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`;
  const expectedAdmin = Deno.env.get('ADMIN_SHARED_SECRET');

  if (authHeader !== expectedService || adminAuth !== expectedAdmin) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  let body: { user_id: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad_request', detail: 'invalid JSON' }), { status: 400 });
  }

  if (!body.user_id) {
    return new Response(JSON.stringify({ error: 'bad_request', detail: 'user_id required' }), { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // Read existing row to know if we're deleting anything
  const { data: existing } = await supabase
    .from('user_devices')
    .select('device_id, session_token')
    .eq('user_id', body.user_id)
    .maybeSingle();

  if (existing) {
    // Emit kick signal BEFORE delete so old device drops gracefully
    await supabase.rpc('emit_device_kick', {
      p_user_id: body.user_id,
      p_session_token: existing.session_token
    });

    await supabase.from('user_devices').delete().eq('user_id', body.user_id);

    await supabase.from('audit_log').insert({
      user_id: body.user_id,
      event: 'admin_reset_device',
      detail_json: { old_device_id: existing.device_id, by: 'admin' }
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    was_present: !!existing,
    old_device_id: existing?.device_id || null
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
});
```

- [ ] **Step 3: Add the emit_device_kick RPC migration**

```bash
supabase migration new emit_device_kick_rpc
```

Edit the migration:

```sql
-- Helper RPC: emit pg_notify for device_kick.
-- Used by admin-reset-device function (can't call pg_notify directly via REST).

CREATE OR REPLACE FUNCTION public.emit_device_kick(
  p_user_id        UUID,
  p_session_token  TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM pg_notify('device_kick:' || p_user_id::text, p_session_token);
END;
$$;

GRANT EXECUTE ON FUNCTION public.emit_device_kick(UUID, TEXT) TO service_role;
```

- [ ] **Step 4: Apply migration + test**

```bash
supabase db reset
```

Configure local secret for the function (use `supabase/.env.local`):
```bash
echo "ADMIN_SHARED_SECRET=dev-admin-secret-change-in-prod" > supabase/.env.local
supabase functions serve admin-reset-device --env-file supabase/.env.local
```

Test (use the test user from Task 13):
```bash
# Get the local service_role key from `supabase status` output
SERVICE_ROLE=$(supabase status --output json | jq -r '.service_role_key')

# First make sure user has a device row from Task 13's setup
curl -X POST http://localhost:54321/functions/v1/admin-reset-device \
  -H "Authorization: Bearer $SERVICE_ROLE" \
  -H "X-Admin-Auth: dev-admin-secret-change-in-prod" \
  -H "Content-Type: application/json" \
  -d "{\"user_id\":\"<test_user_uuid>\"}"
```

Expected: `{"ok":true,"was_present":true,"old_device_id":"..."}`

Verify deletion:
```bash
supabase db query "SELECT * FROM public.user_devices WHERE user_id = '<test_user_uuid>';"
```
Expected: 0 rows.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/admin-reset-device/ supabase/migrations/
git commit -m "feat(functions): add admin-reset-device function with service_role + shared secret gate"
```

---

### Task 16: Deploy to a real Supabase project (production-ready)

**Prerequisite:** A Supabase project created at https://supabase.com/dashboard (Free tier OK for this plan; user must do this in the browser — not scriptable).

After creating the project, note these values from the dashboard:
- Project ref (URL part: `xxxxxxx.supabase.co` → `xxxxxxx`)
- Anon key (Settings → API)
- Service role key (Settings → API → reveal)

- [ ] **Step 1: Link local repo to remote**

```bash
cd kintenshauto-cloud
supabase link --project-ref <project-ref>
```

When prompted, enter the database password (set when creating the project).

- [ ] **Step 2: Push migrations**

```bash
supabase db push
```

Expected: All 4 migrations applied (initial_schema, rls_policies, device_claim_rpc, emit_device_kick_rpc).

Verify in the Supabase dashboard → Database → Tables that all expected tables exist.

- [ ] **Step 3: Set production secrets for edge functions**

```bash
supabase secrets set ADMIN_SHARED_SECRET="$(openssl rand -hex 32)"
```

Save the generated value somewhere safe — this is needed by the admin panel (Plan 3).

- [ ] **Step 4: Deploy edge functions**

```bash
supabase functions deploy device-claim
supabase functions deploy check-version
supabase functions deploy admin-reset-device
```

Expected: Each command outputs `Deployed Function ...`.

- [ ] **Step 5: Create the first admin user**

In the Supabase dashboard → Authentication → Users → "Add user" → Invite the admin email. The admin will receive an invitation link to set their password.

(For the admin panel in Plan 3, the admin uses this account to log in. The admin's privileges come from using the service_role key in the Next.js backend, NOT from a per-user "admin" flag on the auth user.)

- [ ] **Step 6: Document the project config**

Create `kintenshauto-cloud/PROJECT.md`:

```markdown
# Production Project Configuration

**Project ref:** `<project-ref>`
**URL:** `https://<project-ref>.supabase.co`
**Region:** `<region from dashboard>`

## Keys (DO NOT commit values)
- Anon key — used by desktop app + admin panel
- Service role key — used ONLY by admin panel server-side; NEVER bundle in desktop app
- ADMIN_SHARED_SECRET — set via `supabase secrets`; required by admin-reset-device function

## Initial admin user
- Email: `<admin email>`
- Created: 2026-05-16
- Privileges: server-side service_role usage in admin panel

## Storage buckets
- (none in Plan 1; banner blobs stay local)

## Edge functions deployed
- device-claim
- check-version
- admin-reset-device
```

Do NOT commit actual keys. Use a separate `.env` (gitignored) for local dev:

Create `kintenshauto-cloud/.env.example`:

```
SUPABASE_PROJECT_REF=
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ADMIN_SHARED_SECRET=
```

- [ ] **Step 7: Commit**

```bash
git add PROJECT.md .env.example
git commit -m "docs: add PROJECT.md template + .env.example for production config"
```

---

## Phase D: Wrap-up + Documentation (Tasks 17–18)

### Task 17: Update desktop app CLAUDE.md with new structure

**Files:**
- Modify: `C:/Users/Pc2026/Desktop/KINTENSHAUTO-Source-v1.0.0/CLAUDE.md` (create if missing)

- [ ] **Step 1: Create or update CLAUDE.md**

Write `CLAUDE.md` in the kintenshauto desktop repo:

```markdown
# CLAUDE.md — KINTENSHAUTO

Project context for AI assistants working on this codebase.

## What this is

KINTENSHAUTO is an Electron desktop app for automated Facebook Reel posting,
built with React + Express + Puppeteer + SQLite. v2.0 adds Supabase-backed
auth, license, and settings sync (in progress — see specs and plans).

## Active spec / plans

- Spec: `docs/superpowers/specs/2026-05-16-supabase-cloud-integration-design.md`
- Plan 1 (Foundation — in progress): `docs/superpowers/plans/2026-05-16-plan1-foundation.md`
- Plan 2 (Desktop cloud integration — pending)
- Plan 3 (Admin panel — pending)

## Backend structure (post-Plan-1)

```
src/backend/
  server.js          Express + Socket.IO + REST API (port 3003)
  core/              FB automation (poster, orchestrator, worker, scout,
                     browserManager, peakSchedule) — DO NOT change behavior
  local/             SQLite helpers (db.js — openDatabase, loadSchema, applyMigrations)
  cloud/             Supabase integration (EMPTY in Plan 1; populated in Plan 2)
  services/          captionService, channelWatcher, copyrightManager, etc.
                     (unchanged from v1.0.0)
```

## Cloud project

Separate repo: `../kintenshauto-cloud/` (Supabase migrations + edge functions).
Schema and RLS defined there; desktop app talks to it via Supabase JS client
(integration coming in Plan 2).

## Testing

- Framework: vitest
- Run: `npm test` (all) | `npm run test:watch` | `npm run test:coverage`
- Coverage targets (Plan 2 will enforce): cloud/ + local/ ≥ 70%, services/ existing code ≥ 50%
- CI: `.github/workflows/test.yml` runs on every PR

## Critical don'ts (from HANDOFF v2)

- DO NOT edit `dist/assets/index-*.js` — that's compiled React; edit `src/` then rebuild
- DO NOT change `COMPOSER_URL` in `src/backend/core/poster.js`
- DO NOT change UNIQUE constraint on `pending_approvals` (composite watched_id, video_id)
- DO NOT manually edit `bin/win32/*` — auto-downloaded
- DO NOT use `robocopy /MIR` against `src/` — use `/E` (no delete)
- Use English for all new product content (UI, comments, docs); existing Thai stays
  until refactored as part of the same edit

## Build + deploy flow

After any code edit:
```bash
taskkill /F /IM KINTENSHAUTO.exe /T
npx electron-builder --win --dir
robocopy dist-installer\win-unpacked C:\path\to\install /E /NFL /NDL /NP /NJH /NJS
powershell -Command "Start-Process 'C:\path\to\install\KINTENSHAUTO.exe'"
```

## Memory location

`C:/Users/Pc2026/.claude/projects/C--Users-Pc2026-Desktop-KINTENSHAUTO-Source-v1-0-0/memory/`
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add CLAUDE.md with project context + Plan 1 structure"
```

---

### Task 18: Final integration test — full app lifecycle

This is a manual smoke test combining all Plan 1 changes.

- [ ] **Step 1: Clean install simulation**

```bash
# Backup current user data
mv "$APPDATA/kintenshauto" "$APPDATA/kintenshauto.bak"

# Build the app
npm run build-frontend
npx electron-builder --win --dir

# Launch the built version
powershell -Command "Start-Process 'dist-installer/win-unpacked/KINTENSHAUTO.exe'"
```

Expected:
- Splash screen shows 剣天照
- Setup Wizard appears (first-run because user data is fresh)
- After completing wizard, dashboard loads
- Health check (DevTools → Network) shows `/api/health` returning 200
- No console errors related to missing modules

- [ ] **Step 2: Restore your user data**

```bash
# Close the app first
taskkill /F /IM KINTENSHAUTO.exe /T

# Restore
mv "$APPDATA/kintenshauto.bak" "$APPDATA/kintenshauto"
```

- [ ] **Step 3: Test existing functionality unchanged**

Re-launch the app (your real data). Verify:
- Existing pages list shows correctly
- Existing watched channels still listed
- Banner presets still work
- Worker tick fires every 15s (check backend.log)

If any of these break, revert to last known good commit and investigate.

- [ ] **Step 4: Run full test suite one more time**

```bash
npm test
npm run test:coverage
```

Expected: All ~27 tests pass; coverage report generated in `coverage/`.

- [ ] **Step 5: Tag the milestone**

```bash
git tag plan1-foundation-complete
git push origin plan1-foundation-complete  # if pushing to remote
```

- [ ] **Step 6: Final commit (if anything changed during smoke test)**

```bash
git status
# If any fixes were needed, commit them
git commit -am "fix: <whatever was needed during smoke test>"
```

---

## Done. What Plan 1 produced

After all 18 tasks:

- 27+ tests passing in vitest with CI workflow
- Backend folders restructured: `core/` `local/` `cloud/` `services/`
- `src/backend/local/db.js` — testable SQLite module extracted from server.js
- Empty `src/backend/cloud/` folder ready for Plan 2
- Separate `kintenshauto-cloud/` repo with:
  - Postgres schema (13 tables) + RLS policies
  - 3 edge functions deployed (device-claim, check-version, admin-reset-device)
  - 2 supporting RPC functions (execute_claim, emit_device_kick)
  - Linked to a real Supabase project
- Desktop app: identical user-facing behavior to v1.0.0
- `CLAUDE.md` documents the new structure
- `CHANGELOG.md` tracks what changed

**Next:** Plan 2 — Desktop App Cloud Integration (login UI + cloud/ modules + sync + update checker)
