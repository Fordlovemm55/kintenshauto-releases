# Per-Account Thai Proxy Pool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator paste many Thai proxies at once and have the app distribute them 1-proxy-per-account (one Facebook profile = one account), reporting exactly how many are short — so each account posts from its own Thai IP and is not banned for the always-on VPN's foreign IP.

**Architecture:** A new pure-logic service `proxyPool.js` (parse / distribute / test) drives REST endpoints in `server.js`. Assignments write the existing encrypted `profiles.proxy_*` columns. `poster.js` is upgraded to actually USE `proxy_user`/`proxy_pass` (via `page.authenticate`) and to block WebRTC leaks + force a Thai timezone so the proxy is convincing. A bulk-paste panel in `profiles-injection.js` exposes it, with a per-account leak-test that proves Facebook will see a Thai IP.

**Tech Stack:** Node.js (CommonJS) · better-sqlite3 · Express · puppeteer-extra · vitest + supertest + MSW · vanilla JS overlay. New deps: `https-proxy-agent`, `socks-proxy-agent`.

Spec: `docs/superpowers/specs/2026-06-13-per-account-thai-proxy-pool-design.md`.

---

## Ground rules (read first)

- **Do not change existing posting behavior** for proxy-less profiles. Every change is additive and guarded by `if (profile.proxy_host)`.
- **Reuse existing helpers:** `encrypt`/`decrypt` from `src/backend/services/captionService.js`; `applyMigrations` from `src/backend/local/db.js`; `asyncHandler`, `badRequest`, module-level `db`, and `encrypt` already imported in `src/backend/server.js`.
- **Existing columns already present** in `schema.sql` `profiles`: `proxy_type`('http'|'socks5'), `proxy_host`, `proxy_port`, `proxy_user`, `proxy_pass`(encrypted). Do NOT recreate them.
- **Comments + UI strings in English** (project rule); user-facing Thai strings already in the overlay may stay.
- **Run tests from** `kintenshauto-releases/`: `npm test` (vitest). Tests live in `tests/backend/**`.
- **API auth:** new `/api/proxies/*` routes sit behind the require-auth middleware. In tests, set `process.env.KINTENSHAUTO_SKIP_AUTH = '1'` (the dev bypass already in `server.js`) before importing the server.

---

## File structure

| File | Responsibility |
|---|---|
| `src/backend/services/proxyPool.js` (new) | Pure logic: `parse()`, `distribute()`, `testProxy()`. No DB, no Chrome. |
| `tests/backend/services/proxyPool.test.js` (new) | Unit tests for the three functions. |
| `schema.sql` (modify) | Add `proxy_pool` table + new settings seeds. |
| `src/backend/local/db.js` migrations list — **invoked from `server.js`** (modify `server.js`) | Additive `profiles` health columns. |
| `tests/backend/local/proxyPool-migration.test.js` (new) | Verify additive columns + table apply cleanly. |
| `src/backend/server.js` (modify) | `/api/proxies/parse-preview`, `/test`, `/distribute`, `/pool`, `/leak-test/:id`. |
| `tests/backend/api/proxies.test.js` (new) | Supertest coverage of the endpoints. |
| `src/backend/core/poster.js` (modify) | `proxyArgFor()` helper (scheme+host+port), `page.authenticate` for user/pass, WebRTC flags, Thai timezone/locale. |
| `tests/backend/core/poster-proxy.test.js` (new) | Unit-test `proxyArgFor()`. |
| `public/assets/profiles-injection.js` (modify) | Bulk-paste panel + distribute result + per-account leak-test button. |

---

# Phase 1 — Core: paste → distribute → store → use

## Task 1: `proxyPool.parse()` — parse pasted proxies

**Files:**
- Create: `src/backend/services/proxyPool.js`
- Test: `tests/backend/services/proxyPool.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/backend/services/proxyPool.test.js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { parse } = require('../../../src/backend/services/proxyPool');

describe('proxyPool.parse', () => {
  it('parses host:port with default http scheme', () => {
    const { proxies, invalid } = parse('1.2.3.4:8080');
    expect(invalid).toEqual([]);
    expect(proxies).toEqual([
      { raw: '1.2.3.4:8080', scheme: 'http', host: '1.2.3.4', port: 8080, user: null, pass: null },
    ]);
  });

  it('parses host:port:user:pass', () => {
    const { proxies } = parse('1.2.3.4:8080:bob:secret');
    expect(proxies[0]).toMatchObject({ host: '1.2.3.4', port: 8080, user: 'bob', pass: 'secret', scheme: 'http' });
  });

  it('parses user:pass@host:port', () => {
    const { proxies } = parse('bob:secret@1.2.3.4:8080');
    expect(proxies[0]).toMatchObject({ host: '1.2.3.4', port: 8080, user: 'bob', pass: 'secret' });
  });

  it('parses scheme://user:pass@host:port and keeps socks5', () => {
    const { proxies } = parse('socks5://bob:secret@1.2.3.4:1080');
    expect(proxies[0]).toMatchObject({ scheme: 'socks5', host: '1.2.3.4', port: 1080, user: 'bob', pass: 'secret' });
  });

  it('skips blank lines and # comments, dedupes identical entries', () => {
    const { proxies } = parse('1.2.3.4:8080\n\n# note\n1.2.3.4:8080\n5.6.7.8:9090');
    expect(proxies).toHaveLength(2);
  });

  it('reports invalid lines with a reason instead of dropping silently', () => {
    const { proxies, invalid } = parse('not-a-proxy\n1.2.3.4:99999');
    expect(proxies).toEqual([]);
    expect(invalid.map(i => i.raw)).toEqual(['not-a-proxy', '1.2.3.4:99999']);
    expect(invalid[0].reason).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- proxyPool`
Expected: FAIL — `Cannot find module '.../proxyPool'`.

- [ ] **Step 3: Implement `parse` (minimal)**

```javascript
// src/backend/services/proxyPool.js
'use strict';

const VALID_SCHEMES = ['http', 'https', 'socks5', 'socks5h'];

function _validPort(n) {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function _parseLine(raw) {
  let scheme = 'http';
  let rest = raw;

  const schemeMatch = rest.match(/^([a-zA-Z0-9]+):\/\/(.*)$/);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    rest = schemeMatch[2];
    if (!VALID_SCHEMES.includes(scheme)) {
      return { error: `unsupported scheme "${scheme}"` };
    }
  }

  let user = null, pass = null, hostPort = rest;
  if (rest.includes('@')) {
    const at = rest.lastIndexOf('@');
    const creds = rest.slice(0, at);
    hostPort = rest.slice(at + 1);
    const ci = creds.indexOf(':');
    if (ci < 0) return { error: 'credentials must be user:pass' };
    user = creds.slice(0, ci);
    pass = creds.slice(ci + 1);
  }

  const parts = hostPort.split(':');
  // host:port  OR  host:port:user:pass
  if (parts.length !== 2 && parts.length !== 4) {
    return { error: 'expected host:port[:user:pass]' };
  }
  const host = parts[0];
  const port = Number(parts[1]);
  if (!host) return { error: 'missing host' };
  if (!_validPort(port)) return { error: `bad port "${parts[1]}"` };
  if (parts.length === 4) {
    if (user !== null) return { error: 'credentials given twice' };
    user = parts[2];
    pass = parts[3];
  }
  return { scheme, host, port, user: user || null, pass: pass || null };
}

function parse(text) {
  const proxies = [];
  const invalid = [];
  const seen = new Set();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const raw = rawLine.trim();
    if (!raw || raw.startsWith('#')) continue;
    const r = _parseLine(raw);
    if (r.error) { invalid.push({ raw, reason: r.error }); continue; }
    const key = `${r.scheme}://${r.user || ''}:${r.pass || ''}@${r.host}:${r.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    proxies.push({ raw, scheme: r.scheme, host: r.host, port: r.port, user: r.user, pass: r.pass });
  }
  return { proxies, invalid };
}

module.exports = { parse };
```

- [ ] **Step 4: Run tests and confirm pass**

Run: `npm test -- proxyPool`
Expected: PASS (6 tests in `proxyPool.parse`).

- [ ] **Step 5: Commit**

```bash
git add src/backend/services/proxyPool.js tests/backend/services/proxyPool.test.js
git commit -m "feat(proxyPool): parse pasted proxies (host:port / creds / scheme)"
```

---

## Task 2: `proxyPool.distribute()` — 1 proxy per account + shortage report

**Files:**
- Modify: `src/backend/services/proxyPool.js`
- Test: `tests/backend/services/proxyPool.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/backend/services/proxyPool.test.js`:

```javascript
const { distribute } = require('../../../src/backend/services/proxyPool');

const P = (h) => ({ scheme: 'http', host: h, port: 8080, user: null, pass: null });
const A = (id, hasProxy = false) => ({ id, hasProxy });

describe('proxyPool.distribute', () => {
  it('assigns 1:1 to accounts missing a proxy (default top-up)', () => {
    const r = distribute([P('a'), P('b')], [A(1), A(2), A(3, true)]);
    expect(r.assignments).toEqual([
      { accountId: 1, proxy: P('a') },
      { accountId: 2, proxy: P('b') },
    ]);
    expect(r.shortBy).toBe(0);
    expect(r.uncovered).toEqual([]);
    expect(r.leftover).toEqual([]);
  });

  it('reports shortBy and uncovered accounts when proxies run out', () => {
    const r = distribute([P('a')], [A(1), A(2), A(3)]);
    expect(r.assignments).toHaveLength(1);
    expect(r.shortBy).toBe(2);
    expect(r.uncovered).toEqual([2, 3]);
  });

  it('returns leftover proxies when there are more than accounts', () => {
    const r = distribute([P('a'), P('b'), P('c')], [A(1)]);
    expect(r.assignments).toHaveLength(1);
    expect(r.leftover).toEqual([P('b'), P('c')]);
  });

  it('with onlyMissing=false reassigns ALL accounts in id order', () => {
    const r = distribute([P('a'), P('b')], [A(2, true), A(1, true)], { onlyMissing: false });
    expect(r.assignments).toEqual([
      { accountId: 1, proxy: P('a') },
      { accountId: 2, proxy: P('b') },
    ]);
  });

  it('never reuses a proxy across accounts', () => {
    const r = distribute([P('a')], [A(1), A(2)]);
    const used = r.assignments.map(x => x.proxy.host);
    expect(new Set(used).size).toBe(used.length);
  });
});
```

- [ ] **Step 2: Run and confirm fail**

Run: `npm test -- proxyPool`
Expected: FAIL — `distribute is not a function`.

- [ ] **Step 3: Implement `distribute`**

Add to `src/backend/services/proxyPool.js` (before `module.exports`):

```javascript
function distribute(proxies, accounts, { onlyMissing = true } = {}) {
  const targets = (onlyMissing ? accounts.filter(a => !a.hasProxy) : accounts.slice())
    .sort((x, y) => x.id - y.id);
  const assignments = [];
  const n = Math.min(targets.length, proxies.length);
  for (let i = 0; i < n; i++) {
    assignments.push({ accountId: targets[i].id, proxy: proxies[i] });
  }
  const uncovered = targets.slice(n).map(a => a.id);
  const leftover = proxies.slice(n);
  return { assignments, shortBy: uncovered.length, uncovered, leftover };
}
```

And update the export line:

```javascript
module.exports = { parse, distribute };
```

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- proxyPool`
Expected: PASS (all `parse` + `distribute` tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/services/proxyPool.js tests/backend/services/proxyPool.test.js
git commit -m "feat(proxyPool): distribute proxies 1:1 with shortage + leftover report"
```

---

## Task 3: Schema — `proxy_pool` table + settings, and additive `profiles` health columns

**Files:**
- Modify: `schema.sql` (after the `settings` seeds block, around line 326)
- Modify: `src/backend/server.js` (the `applyMigrations([...])` call — find it near DB init)
- Test: `tests/backend/local/proxyPool-migration.test.js`

- [ ] **Step 1: Write the failing migration test**

```javascript
// tests/backend/local/proxyPool-migration.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { openDatabase, loadSchema, applyMigrations } = require('../../../src/backend/local/db');

let tmpDir, dbPath, db;
const SCHEMA = path.join(__dirname, '../../../schema.sql');

// Mirror the migrations the server applies (kept in sync with server.js).
const MIGRATIONS = [
  { table: 'profiles', column: 'proxy_last_ip', definition: 'TEXT' },
  { table: 'profiles', column: 'proxy_last_country', definition: 'TEXT' },
  { table: 'profiles', column: 'proxy_checked_at', definition: 'DATETIME' },
];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-proxypool-mig-'));
  dbPath = path.join(tmpDir, 'test.db');
  ({ db } = openDatabase(dbPath));
  loadSchema(db, SCHEMA);
  applyMigrations(db, MIGRATIONS);
});

afterEach(() => {
  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

it('creates proxy_pool table', () => {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='proxy_pool'`).get();
  expect(row?.name).toBe('proxy_pool');
});

it('adds proxy health columns to profiles', () => {
  const cols = db.prepare(`PRAGMA table_info(profiles)`).all().map(c => c.name);
  expect(cols).toEqual(expect.arrayContaining(['proxy_last_ip', 'proxy_last_country', 'proxy_checked_at']));
});

it('seeds proxy settings', () => {
  const v = db.prepare(`SELECT value FROM settings WHERE key='proxy_default_scheme'`).get();
  expect(v?.value).toBe('http');
});
```

- [ ] **Step 2: Run and confirm fail**

Run: `npm test -- proxyPool-migration`
Expected: FAIL — no `proxy_pool` table / missing columns.

- [ ] **Step 3a: Add the table + settings to `schema.sql`**

Append after the existing `INSERT OR IGNORE INTO settings (...)` block (near line 326):

```sql
-- ---------- PROXY POOL (leftover proxies kept for future accounts) ----------
CREATE TABLE IF NOT EXISTS proxy_pool (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    scheme       TEXT DEFAULT 'http',
    host         TEXT NOT NULL,
    port         INTEGER NOT NULL,
    proxy_user   TEXT,
    proxy_pass   TEXT,                          -- encrypted
    last_ip      TEXT,
    last_country TEXT,
    status       TEXT DEFAULT 'unused',         -- unused | assigned | dead
    tested_at    DATETIME,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(scheme, host, port, proxy_user)
);

INSERT OR IGNORE INTO settings (key, value) VALUES
    ('proxy_default_scheme', 'http'),
    ('proxy_test_on_distribute', '1'),
    ('proxy_assign_only_missing', '1');
```

- [ ] **Step 3b: Register the additive columns in `server.js`**

Find the `applyMigrations(db, [ ... ])` call in `src/backend/server.js` (the long additive list near DB init — it already contains entries like `{ table: 'profiles', column: 'platform', ... }`). Add these three entries to that array:

```javascript
    { table: 'profiles', column: 'proxy_last_ip', definition: 'TEXT' },
    { table: 'profiles', column: 'proxy_last_country', definition: 'TEXT' },
    { table: 'profiles', column: 'proxy_checked_at', definition: 'DATETIME' },
```

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- proxyPool-migration`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add schema.sql src/backend/server.js tests/backend/local/proxyPool-migration.test.js
git commit -m "feat(db): proxy_pool table + proxy health columns + settings seeds"
```

---

## Task 4: Endpoints — parse-preview + distribute (writes encrypted proxies)

**Files:**
- Modify: `src/backend/server.js` (add a PROXY POOL section after the PROFILES block, ~line 857)
- Test: `tests/backend/api/proxies.test.js`

- [ ] **Step 1: Write the failing API test**

```javascript
// tests/backend/api/proxies.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import os from 'os';
import fs from 'fs';

let app, tmpDir;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-api-proxies-'));
  process.env.KINTENSHAUTO_USER_DATA = tmpDir;
  process.env.KINTENSHAUTO_DB = path.join(tmpDir, 'test.db');
  process.env.KINTENSHAUTO_SKIP_AUTH = '1';           // dev bypass → routes reachable
  process.env.KINTENSHAUTO_SUPABASE_URL = 'https://test.supabase.co';
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';
  const mod = await import('../../../src/backend/server.js');
  app = mod.app;
});

afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

async function addProfile(name) {
  const res = await request(app).post('/api/profiles')
    .send({ platform: 'facebook', name, fb_username: name + '@e.com', fb_password: 'pw' });
  return res.body.id;
}

describe('POST /api/proxies/parse-preview', () => {
  it('returns parsed count + invalid lines', async () => {
    const res = await request(app).post('/api/proxies/parse-preview')
      .send({ text: '1.2.3.4:8080\nbad-line' });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.invalid).toHaveLength(1);
  });
});

describe('POST /api/proxies/distribute', () => {
  it('assigns proxies to accounts missing one and reports shortage', async () => {
    const id1 = await addProfile('acc1');
    const id2 = await addProfile('acc2');
    const res = await request(app).post('/api/proxies/distribute')
      .send({ text: '11.11.11.11:8080', test: false });   // 1 proxy, 2 accounts
    expect(res.status).toBe(200);
    expect(res.body.assigned).toBe(1);
    expect(res.body.shortBy).toBe(1);
    // the assigned proxy is persisted + pass column stays usable
    const row = await request(app).get('/api/profiles');
    const withProxy = row.body.filter(p => p.proxy_host === '11.11.11.11');
    expect(withProxy).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and confirm fail**

Run: `npm test -- api/proxies`
Expected: FAIL — 404 on `/api/proxies/parse-preview`.

- [ ] **Step 3: Implement the endpoints**

In `src/backend/server.js`, immediately after the `app.delete('/api/profiles/:id', ...)` handler (~line 857), add:

```javascript
// ====================================================================
// PROXY POOL — bulk paste + distribute Thai proxies, 1 per account
// ====================================================================
const proxyPool = require('./services/proxyPool');

// Preview what a pasted blob parses to (no DB writes).
app.post('/api/proxies/parse-preview', asyncHandler(async (req, res) => {
    const { text } = req.body;
    const { proxies, invalid } = proxyPool.parse(text || '');
    res.json({ count: proxies.length, proxies: proxies.map(p => ({
        scheme: p.scheme, host: p.host, port: p.port, hasAuth: !!p.user,
    })), invalid });
}));

// Persist one parsed proxy onto a profile row (encrypts the password).
function _writeProxyToProfile(accountId, proxy) {
    db.prepare(`
        UPDATE profiles
           SET proxy_type = ?, proxy_host = ?, proxy_port = ?, proxy_user = ?, proxy_pass = ?
         WHERE id = ?
    `).run(
        proxy.scheme, proxy.host, proxy.port,
        proxy.user || null,
        proxy.pass ? encrypt(proxy.pass) : null,
        accountId
    );
}

app.post('/api/proxies/distribute', asyncHandler(async (req, res) => {
    const { text, onlyMissing = true } = req.body;
    const { proxies, invalid } = proxyPool.parse(text || '');

    const rows = db.prepare(`SELECT id, proxy_host FROM profiles ORDER BY id`).all();
    const accounts = rows.map(r => ({ id: r.id, hasProxy: !!r.proxy_host }));

    const result = proxyPool.distribute(proxies, accounts, { onlyMissing });
    for (const a of result.assignments) _writeProxyToProfile(a.accountId, a.proxy);

    // Keep leftovers in the pool for future accounts.
    const poolStmt = db.prepare(`
        INSERT OR IGNORE INTO proxy_pool (scheme, host, port, proxy_user, proxy_pass)
        VALUES (?, ?, ?, ?, ?)
    `);
    for (const p of result.leftover) {
        poolStmt.run(p.scheme, p.host, p.port, p.user || null, p.pass ? encrypt(p.pass) : null);
    }

    res.json({
        assigned: result.assignments.length,
        shortBy: result.shortBy,
        uncovered: result.uncovered,
        leftover: result.leftover.length,
        invalid,
    });
}));
```

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- api/proxies`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/server.js tests/backend/api/proxies.test.js
git commit -m "feat(api): /api/proxies parse-preview + distribute (encrypted persist + pool)"
```

---

## Task 5: `poster.js` — actually USE proxy auth + scheme (so authed Thai proxies work)

**Files:**
- Modify: `src/backend/core/poster.js`
- Test: `tests/backend/core/poster-proxy.test.js`

> Today `poster.js` builds `--proxy-server` from host:port only and ignores `proxy_user`/`proxy_pass`. Authed Thai proxies would silently fail. We extract a tested helper and wire `page.authenticate`.

- [ ] **Step 1: Write the failing unit test for the helper**

```javascript
// tests/backend/core/poster-proxy.test.js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { proxyArgFor } = require('../../../src/backend/core/poster');

describe('proxyArgFor', () => {
  it('returns null when no proxy host', () => {
    expect(proxyArgFor({})).toBeNull();
  });
  it('builds scheme://host:port from proxy_type', () => {
    expect(proxyArgFor({ proxy_type: 'socks5', proxy_host: '1.2.3.4', proxy_port: 1080 }))
      .toBe('--proxy-server=socks5://1.2.3.4:1080');
  });
  it('defaults scheme to http and never embeds credentials in the flag', () => {
    expect(proxyArgFor({ proxy_host: '1.2.3.4', proxy_port: 8080, proxy_user: 'bob', proxy_pass: 'x' }))
      .toBe('--proxy-server=http://1.2.3.4:8080');
  });
});
```

- [ ] **Step 2: Run and confirm fail**

Run: `npm test -- poster-proxy`
Expected: FAIL — `proxyArgFor is not a function`.

- [ ] **Step 3: Add the helper + export, replace inline proxy building**

In `src/backend/core/poster.js`, add near the top (after the requires):

```javascript
// Build the Chrome --proxy-server flag for a profile. Credentials are NEVER
// put in the flag (Chrome ignores them there); they are applied later via
// page.authenticate(). Returns null when the profile has no proxy.
function proxyArgFor(profile) {
    if (!profile || !profile.proxy_host || !profile.proxy_port) return null;
    const scheme = profile.proxy_type || 'http';
    return `--proxy-server=${scheme}://${profile.proxy_host}:${profile.proxy_port}`;
}
```

Replace BOTH existing inline proxy blocks (the two `if (profile.proxy_host && profile.proxy_port) { ... args.push(\`--proxy-server=...\`) }` sites — around lines 101-104 and ~225-227) with:

```javascript
    const proxyArg = proxyArgFor(profile);
    if (proxyArg) args.push(proxyArg);
```

Add to the bottom `module.exports` of `poster.js` (merge into the existing exported object — do not create a second one):

```javascript
    proxyArgFor,
```

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- poster-proxy`
Expected: PASS (3 tests). Also run the full suite to be sure nothing regressed: `npm test`.

- [ ] **Step 5: Wire `page.authenticate` for authed proxies (integration — guarded, additive)**

In `poster.js`, find where a new posting `page` is created in `postReel()` (just after `const page = await browser.newPage()` / equivalent). Add, guarded so proxy-less profiles are untouched:

```javascript
    // Authed proxy support: Chrome can't take creds in --proxy-server, so feed
    // them via CDP auth. decrypt() comes from captionService (same key as fb pw).
    if (profile && profile.proxy_user) {
        try {
            const { decrypt } = require('../services/captionService');
            const pass = profile.proxy_pass ? decrypt(profile.proxy_pass) : '';
            await page.authenticate({ username: profile.proxy_user, password: pass });
        } catch (e) {
            console.error('[poster] proxy auth setup failed:', e.message);
        }
    }
```

> Note: `postReel` must have access to the `profile` row (it already loads it for `pageId`/login). If only `pageId` is in scope, load the profile via the existing DB handle the file uses. Verify by reading the top of `postReel`.

- [ ] **Step 6: Commit**

```bash
git add src/backend/core/poster.js tests/backend/core/poster-proxy.test.js
git commit -m "feat(poster): honor proxy_type + proxy_user/pass via page.authenticate"
```

---

## Task 6: UI — bulk-paste panel in the Profiles Manager

**Files:**
- Modify: `public/assets/profiles-injection.js`

> Vanilla overlay; not unit-tested (no DOM harness here). Code is complete; verification is manual against the running app. `API` and `el()` helpers already exist in this file (`API = (window.kintenshauto && window.kintenshauto.apiBase) || 'http://localhost:3003'`).

- [ ] **Step 1: Add the panel renderer**

Add this function in `profiles-injection.js` (near the other render helpers):

```javascript
// --- Bulk Thai proxy pool panel -------------------------------------------
function renderProxyPoolPanel(container) {
  const box = el('div', { class: 'panel', style: 'margin:14px 0;padding:14px' },
    el('h3', {}, 'พร็อกซี่ไทย (วางทีละหลายตัว)'),
    el('p', { style: 'font-size:12px;color:#9a7fb3' },
      'วางพร็อกซี่บรรทัดละ 1 ตัว — host:port หรือ host:port:user:pass หรือ user:pass@host:port'),
    el('textarea', { id: 'proxyPoolText', rows: '8',
      style: 'width:100%;font-family:monospace;font-size:13px',
      placeholder: '1.2.3.4:8080\n5.6.7.8:1080:user:pass' }),
    el('div', { style: 'margin-top:10px;display:flex;gap:8px' },
      el('button', { class: 'btn-primary', id: 'proxyDistributeBtn' }, 'กระจายใส่เฟส'),
    ),
    el('div', { id: 'proxyPoolResult', style: 'margin-top:12px;font-size:14px' }),
  );
  container.appendChild(box);

  box.querySelector('#proxyDistributeBtn').addEventListener('click', async () => {
    const text = box.querySelector('#proxyPoolText').value;
    const out = box.querySelector('#proxyPoolResult');
    out.textContent = 'กำลังกระจาย...';
    try {
      const r = await fetch(API + '/api/proxies/distribute', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, onlyMissing: true }),
      }).then(x => x.json());
      const parts = [
        `ใส่ครบ ${r.assigned} เฟส`,
        r.shortBy ? `ขาดอีก ${r.shortBy} พร็อกซี่` : null,
        r.leftover ? `เหลือไม่ได้ใช้ ${r.leftover}` : null,
        (r.invalid && r.invalid.length) ? `บรรทัดผิดรูปแบบ ${r.invalid.length}` : null,
      ].filter(Boolean);
      out.innerHTML = '';
      out.appendChild(el('div', { style: 'color:#2e7d32;font-weight:600' }, '✅ ' + parts.join(' · ')));
      if (r.uncovered && r.uncovered.length) {
        out.appendChild(el('div', { style: 'color:#c62828;margin-top:6px' },
          'เฟสที่ยังไม่มีพร็อกซี่ (id): ' + r.uncovered.join(', ')));
      }
    } catch (e) {
      out.textContent = 'ผิดพลาด: ' + e.message;
    }
  });
}
```

- [ ] **Step 2: Mount the panel**

Find where the Profiles overlay renders its main content (the function that builds the overlay body, e.g. where the account list is appended). Call `renderProxyPoolPanel(<that container>)` once, above or below the account list.

- [ ] **Step 3: Manual verification (no automated test for the overlay)**

```
# rebuild the overlay into dist/ (Vite copies public/ → dist/) and relaunch
taskkill /F /IM electron.exe /T
$env:KINTENSHAUTO_SKIP_AUTH='1'
Start-Process "<...>/node_modules/electron/dist/electron.exe" -ArgumentList "." -WorkingDirectory "<releases>"
```

Then in the app: open **จัดการบัญชี**, confirm the "พร็อกซี่ไทย" panel shows, add 2 test accounts, paste one `1.2.3.4:8080` line, click **กระจายใส่เฟส**, and confirm the result reads `ใส่ครบ 1 เฟส · ขาดอีก 1 พร็อกซี่` with the uncovered account id listed.

- [ ] **Step 4: Commit**

```bash
git add public/assets/profiles-injection.js
git commit -m "feat(ui): bulk Thai proxy paste + distribute panel in Profiles Manager"
```

---

# Phase 2 — Verify it actually works (health test + leak-test)

## Task 7: `proxyPool.testProxy()` + the geo proxy agents

**Files:**
- Modify: `package.json` (deps), `src/backend/services/proxyPool.js`
- Test: `tests/backend/services/proxyPool.test.js`

- [ ] **Step 1: Add deps**

```bash
npm install https-proxy-agent socks-proxy-agent
```
Expected: both added to `dependencies`.

- [ ] **Step 2: Add failing tests (injected fetcher — no real network)**

Append to `tests/backend/services/proxyPool.test.js`:

```javascript
const { testProxy } = require('../../../src/backend/services/proxyPool');

describe('proxyPool.testProxy', () => {
  const proxy = { scheme: 'http', host: '1.2.3.4', port: 8080, user: null, pass: null };

  it('reports alive + Thai when geo lookup returns TH', async () => {
    const httpGet = async () => ({ status: 'success', query: '203.0.1.2', country: 'Thailand', countryCode: 'TH' });
    const r = await testProxy(proxy, { httpGet, now: () => 0 });
    expect(r).toMatchObject({ alive: true, ip: '203.0.1.2', country: 'TH', isThai: true });
  });

  it('reports alive but not Thai when geo is elsewhere', async () => {
    const httpGet = async () => ({ status: 'success', query: '8.8.8.8', country: 'United States', countryCode: 'US' });
    const r = await testProxy(proxy, { httpGet, now: () => 0 });
    expect(r).toMatchObject({ alive: true, isThai: false, country: 'US' });
  });

  it('reports dead when the request throws', async () => {
    const httpGet = async () => { throw new Error('ECONNREFUSED'); };
    const r = await testProxy(proxy, { httpGet, now: () => 0 });
    expect(r.alive).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });
});
```

- [ ] **Step 3: Run and confirm fail**

Run: `npm test -- proxyPool`
Expected: FAIL — `testProxy is not a function`.

- [ ] **Step 4: Implement `testProxy` + default agent-based fetcher**

Add to `src/backend/services/proxyPool.js`:

```javascript
const http = require('http');

function _makeAgent(proxy) {
  const cred = proxy.user ? `${encodeURIComponent(proxy.user)}:${encodeURIComponent(proxy.pass || '')}@` : '';
  const url = `${proxy.scheme}://${cred}${proxy.host}:${proxy.port}`;
  if (proxy.scheme.startsWith('socks')) {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    return new SocksProxyAgent(url);
  }
  const { HttpsProxyAgent } = require('https-proxy-agent');
  return new HttpsProxyAgent(url);
}

// Default fetcher: GET a free geo endpoint THROUGH the proxy.
function _defaultHttpGet(proxy, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: _makeAgent(proxy), timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad geo response')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function testProxy(proxy, { httpGet = _defaultHttpGet, timeoutMs = 8000, now = () => Date.now() } = {}) {
  const start = now();
  const GEO = 'http://ip-api.com/json/?fields=status,country,countryCode,query';
  try {
    const j = await httpGet(proxy, GEO, timeoutMs);
    if (!j || j.status !== 'success') return { alive: false, error: 'geo lookup failed', latencyMs: now() - start };
    return {
      alive: true, ip: j.query, country: j.countryCode, countryName: j.country,
      isThai: j.countryCode === 'TH', latencyMs: now() - start,
    };
  } catch (e) {
    return { alive: false, error: e.message, latencyMs: now() - start };
  }
}
```

Update the export:

```javascript
module.exports = { parse, distribute, testProxy };
```

- [ ] **Step 5: Run and confirm pass**

Run: `npm test -- proxyPool`
Expected: PASS (all parse + distribute + testProxy).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/backend/services/proxyPool.js tests/backend/services/proxyPool.test.js
git commit -m "feat(proxyPool): testProxy alive + Thai geo check via proxy agent"
```

---

## Task 8: Wire health-test into distribute + add `/api/proxies/test` and `/leak-test/:id`

**Files:**
- Modify: `src/backend/server.js`
- Test: `tests/backend/api/proxies.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/backend/api/proxies.test.js`:

```javascript
describe('POST /api/proxies/test', () => {
  it('returns per-proxy alive/Thai results', async () => {
    const res = await request(app).post('/api/proxies/test')
      .send({ text: '1.2.3.4:8080', _mock: { alive: true, country: 'TH', isThai: true, ip: '203.0.0.9' } });
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ host: '1.2.3.4', isThai: true });
  });
});
```

> The `_mock` field is a TEST-ONLY hook the endpoint honors **only when `process.env.KINTENSHAUTO_SKIP_AUTH==='1'`**, so real network calls are not made in CI. Document this inline.

- [ ] **Step 2: Run and confirm fail**

Run: `npm test -- api/proxies`
Expected: FAIL — 404 on `/api/proxies/test`.

- [ ] **Step 3: Implement `/test` and `/leak-test/:id`; add optional test to distribute**

Add to the PROXY POOL section of `server.js`:

```javascript
const https = require('https');

// Read this machine's REAL public IP directly (no proxy) — leak-test baseline.
function _directPublicIp() {
    return new Promise((resolve) => {
        https.get('https://api.ipify.org?format=json', (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d).ip); } catch { resolve(null); } });
        }).on('error', () => resolve(null));
    });
}

app.post('/api/proxies/test', asyncHandler(async (req, res) => {
    const { text, _mock } = req.body;
    const { proxies } = proxyPool.parse(text || '');
    const results = [];
    for (const p of proxies) {
        // TEST-ONLY shortcut (only honored under the dev bypass) to avoid live network in CI.
        const r = (_mock && process.env.KINTENSHAUTO_SKIP_AUTH === '1')
            ? _mock
            : await proxyPool.testProxy(p);
        results.push({ host: p.host, port: p.port, ...r });
    }
    res.json({ results });
}));

// Prove FB will see a Thai IP for this profile, not the VPN/real IP.
app.get('/api/proxies/leak-test/:id', asyncHandler(async (req, res) => {
    const row = db.prepare(`SELECT proxy_type, proxy_host, proxy_port, proxy_user, proxy_pass FROM profiles WHERE id = ?`).get(req.params.id);
    if (!row || !row.proxy_host) return res.json({ ok: false, reason: 'no_proxy' });
    const proxy = {
        scheme: row.proxy_type || 'http', host: row.proxy_host, port: row.proxy_port,
        user: row.proxy_user || null, pass: row.proxy_pass ? decrypt(row.proxy_pass) : null,
    };
    const [vpnIp, t] = await Promise.all([_directPublicIp(), proxyPool.testProxy(proxy)]);
    res.json({
        ok: t.alive,
        vpnIp,
        browserIp: t.ip || null,
        browserCountry: t.country || null,
        isThai: !!t.isThai,
        hidesVpn: !!(t.ip && vpnIp && t.ip !== vpnIp),
        error: t.error || null,
    });
}));
```

> `decrypt` must be in scope in `server.js`. It is imported alongside `encrypt` from `captionService`; if only `encrypt` is imported, extend that require to `const { encrypt, decrypt } = require('./services/captionService')`.

Then make `distribute` honor the health test: change the `/api/proxies/distribute` handler so that when `req.body.test !== false` it filters out dead/non-Thai proxies BEFORE distributing and reports them:

```javascript
    let pool = proxies;
    let badProxies = [];
    if (req.body.test !== false) {
        const tested = await Promise.all(proxies.map(async p => ({ p, r: await proxyPool.testProxy(p) })));
        pool = tested.filter(x => x.r.alive && x.r.isThai).map(x => x.p);
        badProxies = tested.filter(x => !(x.r.alive && x.r.isThai)).map(x => ({ host: x.p.host, ...x.r }));
    }
```
…and pass `pool` (not `proxies`) into `proxyPool.distribute(...)`, and include `badProxies: badProxies.length` in the JSON response. (The Task-4 test sends `test: false`, so it stays green.)

- [ ] **Step 4: Run and confirm pass**

Run: `npm test -- api/proxies`
Expected: PASS (all proxies API tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/server.js tests/backend/api/proxies.test.js
git commit -m "feat(api): proxy /test + /leak-test + health-filter on distribute"
```

---

## Task 9: UI — "ทดสอบ" button + per-account leak-test

**Files:**
- Modify: `public/assets/profiles-injection.js`

- [ ] **Step 1: Add a Test button next to Distribute**

In `renderProxyPoolPanel`, add a second button before `proxyDistributeBtn`:

```javascript
      el('button', { class: 'btn-secondary', id: 'proxyTestBtn' }, 'ทดสอบพร็อกซี่'),
```

And its handler (inside `renderProxyPoolPanel`, after the distribute handler):

```javascript
  box.querySelector('#proxyTestBtn').addEventListener('click', async () => {
    const text = box.querySelector('#proxyPoolText').value;
    const out = box.querySelector('#proxyPoolResult');
    out.textContent = 'กำลังทดสอบ...';
    try {
      const r = await fetch(API + '/api/proxies/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }).then(x => x.json());
      out.innerHTML = '';
      r.results.forEach(t => {
        const ok = t.alive && t.isThai;
        out.appendChild(el('div', { style: `color:${ok ? '#2e7d32' : '#c62828'}` },
          `${ok ? '✅' : '❌'} ${t.host}:${t.port} — ${t.alive ? (t.country || '?') : 'ตาย'}${t.alive && !t.isThai ? ' (ไม่ใช่ไทย)' : ''}`));
      });
    } catch (e) { out.textContent = 'ผิดพลาด: ' + e.message; }
  });
```

- [ ] **Step 2: Add a per-account "ตรวจ IP" button**

In the function that renders each account row, add a button and handler that calls `GET /api/proxies/leak-test/<accountId>` and shows 🟢/🔴 with `browserCountry`:

```javascript
  // inside the account-row builder, `acc` is the account object:
  const leakBtn = el('button', { class: 'btn-secondary', style: 'font-size:12px' }, 'ตรวจ IP');
  leakBtn.addEventListener('click', async () => {
    leakBtn.textContent = 'กำลังตรวจ...';
    try {
      const r = await fetch(API + '/api/proxies/leak-test/' + acc.id).then(x => x.json());
      leakBtn.textContent = (r.ok && r.isThai && r.hidesVpn)
        ? `🟢 ${r.browserCountry} (${r.browserIp})`
        : `🔴 ${r.reason || r.browserCountry || 'รั่ว/ไม่ใช่ไทย'}`;
    } catch (e) { leakBtn.textContent = '🔴 error'; }
  });
  // append leakBtn to the row's action area
```

- [ ] **Step 3: Manual verification**

Relaunch (Task 6 Step 3 commands). Paste a real Thai proxy, click **ทดสอบพร็อกซี่** → expect ✅ TH. Distribute, then click **ตรวจ IP** on that account → expect 🟢 TH with an IP that differs from the VPN IP.

- [ ] **Step 4: Commit**

```bash
git add public/assets/profiles-injection.js
git commit -m "feat(ui): proxy health test + per-account leak-test buttons"
```

---

# Phase 3 — Make the Thai proxy convincing (anti-leak)

## Task 10: WebRTC block + Thai timezone/locale on the posting browser

**Files:**
- Modify: `src/backend/core/poster.js`

> Additive, behavior-preserving. WebRTC flags go on the launch args; timezone/locale on each page.

- [ ] **Step 1: Add WebRTC flags to the launch args**

In `poster.js`, in BOTH `args = [ ... ]` arrays used to spawn Chrome (the login launch ~line 91 and the puppeteer-controlled launch), add these entries:

```javascript
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
```

- [ ] **Step 2: Apply Thai timezone + Accept-Language per page**

In `postReel()`, right after the page is created (and after the `page.authenticate` block from Task 5 Step 5), add:

```javascript
    // Make the Thai proxy convincing: a Bangkok timezone + Thai language so the
    // browser locale doesn't contradict the Thai exit IP. Best-effort.
    try {
        await page.emulateTimezone('Asia/Bangkok');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8' });
    } catch (e) {
        console.error('[poster] cloak setup failed:', e.message);
    }
```

- [ ] **Step 3: Verify no regression**

Run: `npm test`
Expected: PASS — full suite still green (these are additive; no test asserts their absence).

- [ ] **Step 4: Manual smoke**

Relaunch the app, post one job through a profile that has a Thai proxy, and confirm in `%APPDATA%\kintenshauto\logs\backend.log` there is no `cloak setup failed` / `proxy auth setup failed` error and the post completes.

- [ ] **Step 5: Commit**

```bash
git add src/backend/core/poster.js
git commit -m "feat(poster): block WebRTC leaks + force Bangkok timezone/locale"
```

---

## Task 11: Final integration verification

- [ ] **Step 1: Full test suite green**

Run: `npm test`
Expected: PASS — all suites, including the new `proxyPool`, `proxyPool-migration`, `api/proxies`, `poster-proxy`.

- [ ] **Step 2: End-to-end manual run (the real proof)**

With `KINTENSHAUTO_SKIP_AUTH=1`, launch the app while your system VPN is ON:
1. จัดการบัญชี → paste several real Thai proxies → **ทดสอบพร็อกซี่** → all ✅ TH.
2. **กระจายใส่เฟส** → result shows each account got one, shortage reported if any.
3. **ตรวจ IP** on an account → 🟢 TH, `browserIp` ≠ your VPN IP.
4. Post one Reel from that account → it publishes; the account's IP origin to FB is the Thai proxy.

- [ ] **Step 3: Update CHANGELOG**

Add an `[Unreleased]` entry summarizing the feature (English).

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): per-account Thai proxy pool"
```

---

## Self-review checklist (run before execution)

- **Spec coverage:** bulk paste (T1,T6) · distribute 1:1 (T2,T4) · shortage report (T2,T4,T6) · leftover pool (T3,T4) · health/Thai test (T7,T8,T9) · per-account leak-test (T8,T9) · proxy-auth honored (T5) · WebRTC + cloak (T10) · encrypted storage (T4) · settings/schema (T3). ✔ all spec sections mapped.
- **Types consistent:** `proxyPool.parse → {proxies, invalid}`, `distribute → {assignments, shortBy, uncovered, leftover}`, `testProxy → {alive, ip, country, isThai, latencyMs, error}` — used identically in endpoints and UI.
- **No placeholders:** every code step contains real code; manual-only steps (UI) are explicitly marked and have concrete verification.
- **Guarded/additive:** all `poster.js` changes are `if (proxy)`-guarded; existing proxy-less posting path is untouched.
