# Plan 2 — Desktop App Cloud Integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the KINTENSHAUTO desktop app into Supabase — login screen blocks the app until authenticated, device enforcement kicks old sessions, settings sync push/pull works for the seven synced tables, and the update prompt surfaces both soft and force updates from `app_versions`. The FB automation pipeline (poster/orchestrator/worker) remains untouched.

**Architecture:**
- All cloud-talking code lives in `src/backend/cloud/` (created empty in Plan 1)
- Local Express routes `/api/auth/*` proxy to Supabase; React UI talks only to the local backend (one trust boundary)
- Tests use MSW (already a devDep) to mock Supabase REST + Realtime — no real Supabase needed during Plan 2
- Sync engine is event-driven via SQLite-level hooks (`db.function('on_sync_change')`) rather than per-endpoint instrumentation — minimises churn in existing API handlers

**Prerequisites:**
- Plan 1 Phase A+B complete (tag `plan1-phaseAB-complete`)
- Plan 1 Phase C (Supabase project deployed) is **NOT** required to write/test Plan 2 code, but IS required to ship a working build to users

**Tech Stack additions:**
- `@supabase/supabase-js@^2.x` (production dep)
- MSW handlers for Supabase REST + Realtime (devDep, already installed in Plan 1)
- `node:crypto` for device_id derivation (already in Node)

**Reference spec:** `docs/superpowers/specs/2026-05-16-supabase-cloud-integration-design.md`

---

## Phase A: Cloud Client Foundation (Tasks 1–4)

### Task 1: Add Supabase JS client + env config

**Files:**
- Modify: `package.json` (add `@supabase/supabase-js`)
- Create: `src/backend/cloud/config.js` (reads env vars + .env file)
- Create: `tests/backend/cloud/config.test.js`
- Modify: `.gitignore` (ensure `.env*` is excluded — already in v1.0.0 gitignore)

- [ ] **Step 1: Install Supabase JS**

```bash
npm install @supabase/supabase-js@^2.39.0 --ignore-scripts --no-audit --no-fund
```

- [ ] **Step 2: Write failing test for config**

Create `tests/backend/cloud/config.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('cloud/config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear cloud-related env vars between tests
    delete process.env.KINTENSHAUTO_SUPABASE_URL;
    delete process.env.KINTENSHAUTO_SUPABASE_ANON_KEY;
    delete process.env.KINTENSHAUTO_ADMIN_SHARED_SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns null url/key when env vars are missing (dev mode)', async () => {
    const { getCloudConfig } = await import('../../../src/backend/cloud/config.js?nocache=' + Date.now());
    const cfg = getCloudConfig();
    expect(cfg.supabaseUrl).toBeNull();
    expect(cfg.supabaseAnonKey).toBeNull();
    expect(cfg.isConfigured).toBe(false);
  });

  it('reads from process.env when set', async () => {
    process.env.KINTENSHAUTO_SUPABASE_URL = 'https://example.supabase.co';
    process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'eyJabc';
    const { getCloudConfig } = await import('../../../src/backend/cloud/config.js?nocache=' + Date.now());
    const cfg = getCloudConfig();
    expect(cfg.supabaseUrl).toBe('https://example.supabase.co');
    expect(cfg.supabaseAnonKey).toBe('eyJabc');
    expect(cfg.isConfigured).toBe(true);
  });

  it('rejects malformed URLs', async () => {
    process.env.KINTENSHAUTO_SUPABASE_URL = 'not-a-url';
    process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'key';
    const { getCloudConfig } = await import('../../../src/backend/cloud/config.js?nocache=' + Date.now());
    expect(() => getCloudConfig()).toThrow(/invalid.*url/i);
  });
});
```

- [ ] **Step 3: Run test (must FAIL)**

```bash
npm test -- tests/backend/cloud/config.test.js
```

Expected: FAIL with `Cannot find module '.../src/backend/cloud/config.js'`.

- [ ] **Step 4: Implement config.js**

Create `src/backend/cloud/config.js`:

```javascript
// Cloud configuration — reads Supabase URL + anon key from env or .env file.
// Returns { supabaseUrl, supabaseAnonKey, isConfigured } so callers can decide
// whether to attempt cloud operations (during early dev, env may be unset).

const fs = require('fs');
const path = require('path');

// Lazy-loaded .env parser — only runs once per process
let _envLoaded = false;
function loadEnvFile() {
  if (_envLoaded) return;
  _envLoaded = true;
  const envPath = path.join(process.env.KINTENSHAUTO_USER_DATA || process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (e) {
    console.warn('[cloud/config] failed to read .env:', e.message);
  }
}

function getCloudConfig() {
  loadEnvFile();

  const supabaseUrl = process.env.KINTENSHAUTO_SUPABASE_URL || null;
  const supabaseAnonKey = process.env.KINTENSHAUTO_SUPABASE_ANON_KEY || null;

  if (supabaseUrl) {
    try { new URL(supabaseUrl); }
    catch { throw new Error(`Invalid KINTENSHAUTO_SUPABASE_URL: ${supabaseUrl}`); }
  }

  return {
    supabaseUrl,
    supabaseAnonKey,
    isConfigured: !!(supabaseUrl && supabaseAnonKey)
  };
}

module.exports = { getCloudConfig };
```

- [ ] **Step 5: Run test (must PASS)**

```bash
npm test -- tests/backend/cloud/config.test.js
```

Expected: 3/3 PASS.

- [ ] **Step 6: Add .env.example for documentation**

Create `.env.example` at project root:

```
# Supabase project configuration (required for v2.0+ cloud features)
# Get these from https://supabase.com/dashboard/project/<ref>/settings/api
KINTENSHAUTO_SUPABASE_URL=https://your-project-ref.supabase.co
KINTENSHAUTO_SUPABASE_ANON_KEY=eyJhbGciOi...
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/backend/cloud/config.js tests/backend/cloud/config.test.js .env.example
git commit -m "feat(cloud): add config.js to read Supabase env vars (TDD, 3 tests)"
```

---

### Task 2: Supabase client singleton

**Files:**
- Create: `src/backend/cloud/supabaseClient.js`
- Create: `tests/backend/cloud/supabaseClient.test.js`

The singleton wraps `@supabase/supabase-js` createClient — exposes `getAnonClient()` for unauthenticated calls and `getUserClient(accessToken)` for authenticated calls.

- [ ] **Step 1: Write failing tests with MSW mocking Supabase**

Create `tests/backend/cloud/supabaseClient.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('cloud/supabaseClient', () => {
  beforeEach(() => {
    process.env.KINTENSHAUTO_SUPABASE_URL = 'https://test.supabase.co';
    process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon-test-key';
  });

  afterEach(() => {
    delete process.env.KINTENSHAUTO_SUPABASE_URL;
    delete process.env.KINTENSHAUTO_SUPABASE_ANON_KEY;
  });

  it('returns null when config is missing', async () => {
    delete process.env.KINTENSHAUTO_SUPABASE_URL;
    const { getAnonClient } = await import('../../../src/backend/cloud/supabaseClient.js?n=' + Date.now());
    expect(getAnonClient()).toBeNull();
  });

  it('returns a Supabase client when configured', async () => {
    const { getAnonClient } = await import('../../../src/backend/cloud/supabaseClient.js?n=' + Date.now());
    const client = getAnonClient();
    expect(client).not.toBeNull();
    expect(typeof client.auth).toBe('object');
    expect(typeof client.from).toBe('function');
  });

  it('returns the same anon client on repeated calls (singleton)', async () => {
    const { getAnonClient } = await import('../../../src/backend/cloud/supabaseClient.js?n=' + Date.now());
    expect(getAnonClient()).toBe(getAnonClient());
  });

  it('getUserClient with a token returns a separate client with auth header', async () => {
    const { getUserClient } = await import('../../../src/backend/cloud/supabaseClient.js?n=' + Date.now());
    const client = getUserClient('user-jwt-abc');
    expect(client).not.toBeNull();
    // Supabase v2 stores headers on rest.headers
    // We can't easily inspect, but verify it's a separate instance
    const { getAnonClient } = await import('../../../src/backend/cloud/supabaseClient.js?n=' + Date.now());
    expect(client).not.toBe(getAnonClient());
  });
});
```

- [ ] **Step 2: Run (FAIL)**

```bash
npm test -- tests/backend/cloud/supabaseClient.test.js
```

- [ ] **Step 3: Implement singleton**

Create `src/backend/cloud/supabaseClient.js`:

```javascript
// Supabase client singleton.
// - getAnonClient(): cached, uses anon key (unauthenticated REST + Auth API access)
// - getUserClient(token): per-token, includes Authorization header (authenticated requests)

const { createClient } = require('@supabase/supabase-js');
const { getCloudConfig } = require('./config');

let _anonClient = null;

function getAnonClient() {
  if (_anonClient) return _anonClient;
  const cfg = getCloudConfig();
  if (!cfg.isConfigured) return null;
  _anonClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
  return _anonClient;
}

function getUserClient(accessToken) {
  if (!accessToken) return null;
  const cfg = getCloudConfig();
  if (!cfg.isConfigured) return null;
  return createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

// Reset (for tests only)
function _resetForTests() {
  _anonClient = null;
}

module.exports = { getAnonClient, getUserClient, _resetForTests };
```

- [ ] **Step 4: Run (PASS)**

Expected: 4/4 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/cloud/supabaseClient.js tests/backend/cloud/supabaseClient.test.js
git commit -m "feat(cloud): add supabaseClient singleton (anon + per-user, 4 tests)"
```

---

### Task 3: Auth service (login, logout, session storage)

**Files:**
- Create: `src/backend/cloud/authService.js`
- Create: `src/backend/cloud/sessionStore.js` (encrypted local file)
- Create: `tests/backend/cloud/authService.test.js`
- Create: `tests/backend/cloud/sessionStore.test.js`

`sessionStore.js` persists the Supabase session to `<userData>/.session` (encrypted with the same AES key used for FB passwords). `authService.js` calls Supabase auth API + manages the session.

- [ ] **Step 1: Tests for sessionStore (TDD red)**

Create `tests/backend/cloud/sessionStore.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('cloud/sessionStore', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-session-'));
    process.env.KINTENSHAUTO_USER_DATA = tmpDir;
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('returns null when no session stored', async () => {
    const { loadSession } = await import('../../../src/backend/cloud/sessionStore.js?n=' + Date.now());
    expect(loadSession()).toBeNull();
  });

  it('round-trips a session through save/load', async () => {
    const { saveSession, loadSession } = await import('../../../src/backend/cloud/sessionStore.js?n=' + Date.now());
    const session = {
      access_token: 'abc.def.ghi',
      refresh_token: 'refresh-xyz',
      expires_at: 1234567890,
      user: { id: 'user-uuid', email: 'test@example.com' }
    };
    saveSession(session);
    const loaded = loadSession();
    expect(loaded).toEqual(session);
  });

  it('clearSession removes the file', async () => {
    const { saveSession, clearSession, loadSession } = await import('../../../src/backend/cloud/sessionStore.js?n=' + Date.now());
    saveSession({ access_token: 'a', refresh_token: 'b', expires_at: 0, user: { id: 'u' } });
    expect(loadSession()).not.toBeNull();
    clearSession();
    expect(loadSession()).toBeNull();
  });

  it('returns null for a corrupted session file', async () => {
    const { loadSession } = await import('../../../src/backend/cloud/sessionStore.js?n=' + Date.now());
    const sessionPath = path.join(tmpDir, '.session');
    fs.writeFileSync(sessionPath, 'not-valid-encrypted-data');
    expect(loadSession()).toBeNull();
  });
});
```

- [ ] **Step 2: Run (FAIL)**

```bash
npm test -- tests/backend/cloud/sessionStore.test.js
```

- [ ] **Step 3: Implement sessionStore.js**

Create `src/backend/cloud/sessionStore.js`:

```javascript
// Encrypted local storage for the Supabase session.
// Uses the same AES-256-CBC scheme as services/captionService (per-install
// random key). Stored at <userData>/.session — never sent over the network.

const fs = require('fs');
const path = require('path');
// Re-use the encryption helpers from captionService (same per-install key)
const { encrypt, decrypt } = require('../services/captionService');

function sessionPath() {
  const userData = process.env.KINTENSHAUTO_USER_DATA || path.join(__dirname, '..', '..', '..');
  return path.join(userData, '.session');
}

function loadSession() {
  const p = sessionPath();
  if (!fs.existsSync(p)) return null;
  try {
    const blob = fs.readFileSync(p, 'utf-8').trim();
    if (!blob) return null;
    const json = decrypt(blob);
    return JSON.parse(json);
  } catch (e) {
    console.warn('[sessionStore] failed to load:', e.message);
    return null;
  }
}

function saveSession(session) {
  if (!session || typeof session !== 'object') throw new Error('saveSession: invalid session');
  const json = JSON.stringify(session);
  const encrypted = encrypt(json);
  fs.writeFileSync(sessionPath(), encrypted, { mode: 0o600 });
}

function clearSession() {
  const p = sessionPath();
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch {}
  }
}

module.exports = { loadSession, saveSession, clearSession };
```

- [ ] **Step 4: Verify session test passes**

```bash
npm test -- tests/backend/cloud/sessionStore.test.js
```

Expected: 4/4 PASS.

- [ ] **Step 5: Tests for authService**

Create `tests/backend/cloud/authService.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import path from 'path';
import os from 'os';
import fs from 'fs';

let server, tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-auth-'));
  process.env.KINTENSHAUTO_USER_DATA = tmpDir;
  process.env.KINTENSHAUTO_SUPABASE_URL = 'https://test.supabase.co';
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';

  server = setupServer(
    http.post('https://test.supabase.co/auth/v1/token', async ({ request }) => {
      const body = await request.json();
      if (body.email === 'good@example.com' && body.password === 'right') {
        return HttpResponse.json({
          access_token: 'access-abc',
          refresh_token: 'refresh-xyz',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: 'user-uuid', email: 'good@example.com' }
        });
      }
      return HttpResponse.json(
        { error: 'invalid_grant', error_description: 'Invalid login credentials' },
        { status: 400 }
      );
    })
  );
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env.KINTENSHAUTO_SUPABASE_URL;
  delete process.env.KINTENSHAUTO_SUPABASE_ANON_KEY;
});

describe('authService.login', () => {
  it('returns ok=true and stores session on valid credentials', async () => {
    const { login, getStoredSession } = await import('../../../src/backend/cloud/authService.js?n=' + Date.now());
    const result = await login('good@example.com', 'right');
    expect(result.ok).toBe(true);
    expect(result.user.email).toBe('good@example.com');
    const stored = getStoredSession();
    expect(stored.access_token).toBe('access-abc');
  });

  it('returns ok=false with error on bad credentials', async () => {
    const { login } = await import('../../../src/backend/cloud/authService.js?n=' + Date.now());
    const result = await login('bad@example.com', 'wrong');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_credentials');
  });

  it('returns ok=false network_error when supabase is unreachable', async () => {
    server.close();
    server = setupServer(
      http.post('https://test.supabase.co/auth/v1/token', () => HttpResponse.error())
    );
    server.listen({ onUnhandledRequest: 'error' });
    const { login } = await import('../../../src/backend/cloud/authService.js?n=' + Date.now());
    const result = await login('good@example.com', 'right');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('network_error');
  });
});

describe('authService.logout', () => {
  it('clears the stored session', async () => {
    const { login, logout, getStoredSession } = await import('../../../src/backend/cloud/authService.js?n=' + Date.now());
    await login('good@example.com', 'right');
    expect(getStoredSession()).not.toBeNull();
    await logout();
    expect(getStoredSession()).toBeNull();
  });
});
```

- [ ] **Step 6: Run (FAIL)**

```bash
npm test -- tests/backend/cloud/authService.test.js
```

- [ ] **Step 7: Implement authService.js**

Create `src/backend/cloud/authService.js`:

```javascript
// Authentication flow:
//   login(email, pw) → Supabase signInWithPassword → store session → return {ok, user}
//   logout() → clearSession + (best-effort) Supabase signOut
//   getStoredSession() → read encrypted local .session
//   refresh() → exchange refresh_token for new access_token + update store

const { getAnonClient } = require('./supabaseClient');
const { loadSession, saveSession, clearSession } = require('./sessionStore');

async function login(email, password) {
  const client = getAnonClient();
  if (!client) return { ok: false, reason: 'not_configured', message: 'Cloud config missing' };

  try {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      const reason = error.message?.toLowerCase().includes('invalid')
        ? 'invalid_credentials'
        : 'auth_error';
      return { ok: false, reason, message: error.message };
    }
    if (!data?.session) {
      return { ok: false, reason: 'no_session', message: 'Supabase returned no session' };
    }
    saveSession(data.session);
    return { ok: true, user: data.user, session: data.session };
  } catch (err) {
    const isNetwork = err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED'
      || err.message?.toLowerCase().includes('fetch failed')
      || err.message?.toLowerCase().includes('network');
    return {
      ok: false,
      reason: isNetwork ? 'network_error' : 'exception',
      message: err.message
    };
  }
}

async function logout() {
  const session = loadSession();
  if (session?.access_token) {
    try {
      const client = getAnonClient();
      if (client) await client.auth.signOut();
    } catch { /* best-effort — local clear always wins */ }
  }
  clearSession();
}

function getStoredSession() {
  return loadSession();
}

async function refresh() {
  const session = loadSession();
  if (!session?.refresh_token) return { ok: false, reason: 'no_session' };
  const client = getAnonClient();
  if (!client) return { ok: false, reason: 'not_configured' };

  try {
    const { data, error } = await client.auth.refreshSession({ refresh_token: session.refresh_token });
    if (error) return { ok: false, reason: 'refresh_failed', message: error.message };
    if (!data?.session) return { ok: false, reason: 'no_session_returned' };
    saveSession(data.session);
    return { ok: true, session: data.session };
  } catch (err) {
    return { ok: false, reason: 'exception', message: err.message };
  }
}

module.exports = { login, logout, getStoredSession, refresh };
```

- [ ] **Step 8: Verify all pass**

```bash
npm test -- tests/backend/cloud/
```

Expected: 11 cloud tests pass (3 config + 4 supabaseClient + 4 sessionStore + 4 authService = wait, count: 3+4+4+4 = 15. Adjust based on actual numbers in your test files).

- [ ] **Step 9: Commit**

```bash
git add src/backend/cloud/authService.js src/backend/cloud/sessionStore.js tests/backend/cloud/
git commit -m "feat(cloud): add authService + sessionStore (login/logout/refresh, MSW-mocked)"
```

---

### Task 4: Audit event logger

**Files:**
- Create: `src/backend/cloud/audit.js`
- Create: `tests/backend/cloud/audit.test.js`

Logs events to Supabase `audit_log` table. Queues offline events in local SQLite so nothing is lost.

- [ ] **Step 1: Local schema for audit queue**

In `schema.sql`, append at the bottom (search for "DEFAULT SETTINGS" section — append after it):

```sql

-- =============================================================================
-- AUDIT QUEUE — buffer for cloud audit_log events when offline
-- (Plan 2)
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event       TEXT NOT NULL,
    detail_json TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    flushed_at  DATETIME
);
CREATE INDEX IF NOT EXISTS idx_audit_queue_unflushed ON audit_queue(flushed_at) WHERE flushed_at IS NULL;
```

- [ ] **Step 2: Tests**

Create `tests/backend/cloud/audit.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';

let server, tmpDir, db;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-audit-'));
  process.env.KINTENSHAUTO_USER_DATA = tmpDir;
  process.env.KINTENSHAUTO_SUPABASE_URL = 'https://test.supabase.co';
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';

  db = new Database(path.join(tmpDir, 'test.db'));
  db.exec(`
    CREATE TABLE audit_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      detail_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      flushed_at DATETIME
    );
  `);
});

afterEach(() => {
  if (db) db.close();
  if (server) server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('audit.log', () => {
  it('inserts an event into audit_queue immediately', async () => {
    const { logEvent } = await import('../../../src/backend/cloud/audit.js?n=' + Date.now());
    logEvent(db, 'login_success', { user_id: 'u1' });
    const rows = db.prepare(`SELECT * FROM audit_queue`).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('login_success');
    expect(JSON.parse(rows[0].detail_json).user_id).toBe('u1');
  });
});

describe('audit.flush', () => {
  it('pushes unflushed events to Supabase and marks them flushed', async () => {
    server = setupServer(
      http.post('https://test.supabase.co/rest/v1/audit_log', () => HttpResponse.json([{}]))
    );
    server.listen({ onUnhandledRequest: 'error' });

    const { logEvent, flushAudit } = await import('../../../src/backend/cloud/audit.js?n=' + Date.now());
    logEvent(db, 'sync_push', { count: 5 });
    logEvent(db, 'sync_pull', { count: 3 });
    const result = await flushAudit(db, 'access-token-stub');
    expect(result.flushed).toBe(2);

    const unflushed = db.prepare(`SELECT COUNT(*) AS n FROM audit_queue WHERE flushed_at IS NULL`).get();
    expect(unflushed.n).toBe(0);
  });

  it('leaves rows unflushed on network failure', async () => {
    server = setupServer(
      http.post('https://test.supabase.co/rest/v1/audit_log', () => HttpResponse.error())
    );
    server.listen({ onUnhandledRequest: 'error' });

    const { logEvent, flushAudit } = await import('../../../src/backend/cloud/audit.js?n=' + Date.now());
    logEvent(db, 'login_success', {});
    const result = await flushAudit(db, 'access-token-stub');
    expect(result.flushed).toBe(0);
    expect(result.failed).toBeGreaterThan(0);

    const unflushed = db.prepare(`SELECT COUNT(*) AS n FROM audit_queue WHERE flushed_at IS NULL`).get();
    expect(unflushed.n).toBe(1);
  });
});
```

- [ ] **Step 3: Implement audit.js**

Create `src/backend/cloud/audit.js`:

```javascript
// Audit event logger.
// - logEvent(db, event, detail): queue locally (always succeeds, even offline)
// - flushAudit(db, accessToken): push queued events to cloud audit_log, mark flushed

const { getUserClient } = require('./supabaseClient');

const BATCH_SIZE = 100;

function logEvent(db, event, detail = {}) {
  if (!event || typeof event !== 'string') throw new Error('logEvent: event required');
  db.prepare(`INSERT INTO audit_queue (event, detail_json) VALUES (?, ?)`)
    .run(event, JSON.stringify(detail));
}

async function flushAudit(db, accessToken) {
  if (!accessToken) return { flushed: 0, failed: 0, reason: 'no_token' };
  const client = getUserClient(accessToken);
  if (!client) return { flushed: 0, failed: 0, reason: 'not_configured' };

  const rows = db.prepare(`
    SELECT id, event, detail_json, created_at FROM audit_queue
    WHERE flushed_at IS NULL
    ORDER BY id ASC
    LIMIT ?
  `).all(BATCH_SIZE);

  if (rows.length === 0) return { flushed: 0, failed: 0 };

  const payload = rows.map(r => ({
    event: r.event,
    detail_json: r.detail_json ? JSON.parse(r.detail_json) : {},
    created_at: r.created_at
  }));

  try {
    const { error } = await client.from('audit_log').insert(payload);
    if (error) return { flushed: 0, failed: rows.length, error: error.message };
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE audit_queue SET flushed_at = datetime('now', 'localtime') WHERE id IN (${placeholders})`)
      .run(...ids);
    return { flushed: rows.length, failed: 0 };
  } catch (err) {
    return { flushed: 0, failed: rows.length, error: err.message };
  }
}

module.exports = { logEvent, flushAudit };
```

- [ ] **Step 4: Run + commit**

```bash
npm test -- tests/backend/cloud/audit.test.js
git add src/backend/cloud/audit.js tests/backend/cloud/audit.test.js schema.sql
git commit -m "feat(cloud): add audit logger with offline queue + cloud flush (3 tests)"
```

---

## Phase B: Backend Auth Middleware + Sync Schema (Tasks 5–7)

### Task 5: /api/auth/* Express routes

**Files:**
- Modify: `src/backend/server.js` (add routes BEFORE existing /api/* routes)
- Create: `tests/backend/api/auth.test.js`

- [ ] **Step 1: Tests**

Create `tests/backend/api/auth.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import request from 'supertest';
import path from 'path';
import os from 'os';
import fs from 'fs';

let app, mswServer, tmpDir;

const SUPABASE_URL = 'https://test.supabase.co';

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-api-auth-'));
  process.env.KINTENSHAUTO_USER_DATA = tmpDir;
  process.env.KINTENSHAUTO_DB = path.join(tmpDir, 'test.db');
  process.env.KINTENSHAUTO_SUPABASE_URL = SUPABASE_URL;
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';

  mswServer = setupServer(
    http.post(`${SUPABASE_URL}/auth/v1/token`, async ({ request }) => {
      const body = await request.json();
      if (body.email === 'ok@e.com' && body.password === 'pw') {
        return HttpResponse.json({
          access_token: 'a', refresh_token: 'r', expires_in: 3600,
          expires_at: Math.floor(Date.now()/1000)+3600,
          user: { id: 'u1', email: 'ok@e.com' }
        });
      }
      return HttpResponse.json({ error: 'invalid' }, { status: 400 });
    })
  );
  mswServer.listen({ onUnhandledRequest: 'bypass' }); // bypass — server.js has many side calls

  const mod = await import('../../../src/backend/server.js');
  app = mod.app;
});

afterAll(() => {
  if (mswServer) mswServer.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('POST /api/auth/login', () => {
  it('returns 200 + sets session on valid credentials', async () => {
    const res = await request(app).post('/api/auth/login')
      .send({ email: 'ok@e.com', password: 'pw' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user.email).toBe('ok@e.com');
  });

  it('returns 401 on bad credentials', async () => {
    const res = await request(app).post('/api/auth/login')
      .send({ email: 'bad@e.com', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it('returns 400 when fields missing', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'x@y.com' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/auth/status', () => {
  it('returns logged_in:false when no session', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.logged_in).toBe(false);
  });
});
```

- [ ] **Step 2: Run (FAIL because no routes yet)**

- [ ] **Step 3: Add routes to server.js**

In `src/backend/server.js`, add this block AFTER the `// HEALTH + STATS` section (around line 444):

```javascript
// ====================================================================
// AUTH (Plan 2)
// ====================================================================
const authService = require('./cloud/authService');

app.post('/api/auth/login', asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'email and password required' });
    }
    const result = await authService.login(email, password);
    if (!result.ok) {
        const status = result.reason === 'invalid_credentials' ? 401
                     : result.reason === 'network_error' ? 503 : 400;
        return res.status(status).json({ ok: false, reason: result.reason, error: result.message });
    }
    res.json({ ok: true, user: result.user });
}));

app.post('/api/auth/logout', asyncHandler(async (req, res) => {
    await authService.logout();
    res.json({ ok: true });
}));

app.get('/api/auth/status', (req, res) => {
    const session = authService.getStoredSession();
    if (!session) return res.json({ logged_in: false });
    res.json({
        logged_in: true,
        user: { id: session.user?.id, email: session.user?.email },
        expires_at: session.expires_at
    });
});

app.post('/api/auth/refresh', asyncHandler(async (req, res) => {
    const result = await authService.refresh();
    if (!result.ok) {
        return res.status(401).json({ ok: false, reason: result.reason });
    }
    res.json({ ok: true });
}));
```

- [ ] **Step 4: Run + commit**

```bash
npm test -- tests/backend/api/auth.test.js
git add src/backend/server.js tests/backend/api/auth.test.js
git commit -m "feat(cloud): add /api/auth/{login,logout,status,refresh} routes (4 tests)"
```

---

### Task 6: requireAuth middleware on /api/*

**Files:**
- Modify: `src/backend/server.js` (add middleware before /api/* routes, exempt /api/auth/* and /api/health)
- Create: `tests/backend/api/middleware.test.js`

- [ ] **Step 1: Tests**

Create `tests/backend/api/middleware.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import os from 'os';
import fs from 'fs';

let app, tmpDir;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-mw-'));
  process.env.KINTENSHAUTO_USER_DATA = tmpDir;
  process.env.KINTENSHAUTO_DB = path.join(tmpDir, 'test.db');
  // Intentionally NOT setting Supabase config — middleware should still work
  const mod = await import('../../../src/backend/server.js?n=' + Date.now());
  app = mod.app;
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('requireAuth middleware', () => {
  it('allows /api/health without auth', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('allows /api/auth/* without auth', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
  });

  it('blocks /api/profiles with 401 when no session', async () => {
    const res = await request(app).get('/api/profiles');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/login required/i);
  });

  it('blocks /api/jobs/recent with 401 when no session', async () => {
    const res = await request(app).get('/api/jobs/recent');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Add middleware in server.js**

In `src/backend/server.js`, IMMEDIATELY AFTER the existing CORS middleware (search `res.header('Access-Control-Allow-Headers',`) and BEFORE the orchestrator construction:

```javascript
// ====================================================================
// REQUIRE AUTH MIDDLEWARE (Plan 2)
// Block /api/* unless a local session exists. Exempt: /api/health, /api/auth/*.
// ====================================================================
const _authService = require('./cloud/authService');
app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (req.path === '/api/health' || req.path.startsWith('/api/auth/')) return next();
    const session = _authService.getStoredSession();
    if (!session) {
        return res.status(401).json({ error: 'login required', code: 'NO_SESSION' });
    }
    // Attach to req for handlers that need user context
    req.user = session.user;
    req.accessToken = session.access_token;
    next();
});
```

NOTE: This middleware MUST be added AFTER the auth routes (Task 5) so the routes themselves load first. Verify in server.js that the auth routes are declared BEFORE this middleware (Express checks middleware in declaration order — middleware on /api/* after auth routes still matches all /api/* paths).

Actually re-read Express docs: middleware applies in declaration order to all subsequent matching routes. So this middleware applied AFTER the auth routes won't block them. The exemption check (`req.path.startsWith('/api/auth/')`) is defense in depth.

- [ ] **Step 3: Run + commit**

```bash
npm test -- tests/backend/api/
git add src/backend/server.js tests/backend/api/middleware.test.js
git commit -m "feat(cloud): add requireAuth middleware blocking /api/* without session (4 tests)"
```

---

### Task 7: Local DB sync schema (cloud_uuid, updated_at, deleted_at)

**Files:**
- Modify: `schema.sql` (additive — for fresh installs)
- Modify: `src/backend/server.js` (add to applyMigrations call — for existing installs)

The 8 synced tables need 4 new columns each: `cloud_uuid TEXT UNIQUE`, `cloud_synced_at DATETIME`, `updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`, `deleted_at DATETIME`.

- [ ] **Step 1: Add columns to schema.sql (fresh installs)**

For EACH of these tables in schema.sql, add the 4 columns at the end of the CREATE TABLE definition (just before the closing paren):

- `pages` — add 4 columns
- `banners` — add 4 columns
- `banner_presets` — add 4 columns
- `caption_prompts` — add 4 columns
- `comment_templates` — add 4 columns
- `comment_settings` — add 4 columns (but NOTE: comment_settings uses page_id as primary key — adjust unique constraint accordingly)
- `watched_channels` — add 4 columns
- `ai_providers` — add 4 columns

Example for `pages` table — find:

```sql
CREATE TABLE IF NOT EXISTS pages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id      INTEGER NOT NULL,
    ...
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);
```

Change to:

```sql
CREATE TABLE IF NOT EXISTS pages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id      INTEGER NOT NULL,
    ...
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- Plan 2 sync columns
    cloud_uuid      TEXT UNIQUE,
    cloud_synced_at DATETIME,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at      DATETIME,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);
```

Apply the same pattern to all 8 tables.

- [ ] **Step 2: Add migrations to server.js (for existing installs)**

In `src/backend/server.js`, find the `applyMigrations(db, [...])` block and APPEND these entries to the array (one for each synced table × 4 columns = 32 entries; use a loop to generate or expand inline):

```javascript
// Plan 2: sync columns for cloud bidirectional sync
{ table: 'pages',             column: 'cloud_uuid', definition: 'TEXT UNIQUE' },
{ table: 'pages',             column: 'cloud_synced_at', definition: 'DATETIME' },
{ table: 'pages',             column: 'updated_at', definition: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
{ table: 'pages',             column: 'deleted_at', definition: 'DATETIME' },
{ table: 'banners',           column: 'cloud_uuid', definition: 'TEXT UNIQUE' },
{ table: 'banners',           column: 'cloud_synced_at', definition: 'DATETIME' },
{ table: 'banners',           column: 'updated_at', definition: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
{ table: 'banners',           column: 'deleted_at', definition: 'DATETIME' },
{ table: 'banner_presets',    column: 'cloud_uuid', definition: 'TEXT UNIQUE' },
{ table: 'banner_presets',    column: 'cloud_synced_at', definition: 'DATETIME' },
{ table: 'banner_presets',    column: 'updated_at', definition: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
{ table: 'banner_presets',    column: 'deleted_at', definition: 'DATETIME' },
{ table: 'caption_prompts',   column: 'cloud_uuid', definition: 'TEXT UNIQUE' },
{ table: 'caption_prompts',   column: 'cloud_synced_at', definition: 'DATETIME' },
{ table: 'caption_prompts',   column: 'updated_at', definition: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
{ table: 'caption_prompts',   column: 'deleted_at', definition: 'DATETIME' },
{ table: 'comment_templates', column: 'cloud_uuid', definition: 'TEXT UNIQUE' },
{ table: 'comment_templates', column: 'cloud_synced_at', definition: 'DATETIME' },
{ table: 'comment_templates', column: 'updated_at', definition: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
{ table: 'comment_templates', column: 'deleted_at', definition: 'DATETIME' },
{ table: 'comment_settings',  column: 'cloud_uuid', definition: 'TEXT UNIQUE' },
{ table: 'comment_settings',  column: 'cloud_synced_at', definition: 'DATETIME' },
{ table: 'comment_settings',  column: 'updated_at', definition: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
{ table: 'comment_settings',  column: 'deleted_at', definition: 'DATETIME' },
{ table: 'watched_channels',  column: 'cloud_uuid', definition: 'TEXT UNIQUE' },
{ table: 'watched_channels',  column: 'cloud_synced_at', definition: 'DATETIME' },
{ table: 'watched_channels',  column: 'updated_at', definition: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
{ table: 'watched_channels',  column: 'deleted_at', definition: 'DATETIME' },
{ table: 'ai_providers',      column: 'cloud_uuid', definition: 'TEXT UNIQUE' },
{ table: 'ai_providers',      column: 'cloud_synced_at', definition: 'DATETIME' },
{ table: 'ai_providers',      column: 'updated_at', definition: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
{ table: 'ai_providers',      column: 'deleted_at', definition: 'DATETIME' },
```

- [ ] **Step 3: Add updated_at triggers (so every UPDATE bumps the timestamp)**

Add this to schema.sql at the bottom (after all CREATE TABLE statements):

```sql

-- =============================================================================
-- Plan 2: triggers to bump updated_at on every UPDATE
-- =============================================================================
CREATE TRIGGER IF NOT EXISTS trg_pages_updated_at             AFTER UPDATE ON pages             FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE pages             SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_banners_updated_at           AFTER UPDATE ON banners           FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE banners           SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_banner_presets_updated_at    AFTER UPDATE ON banner_presets    FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE banner_presets    SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_caption_prompts_updated_at   AFTER UPDATE ON caption_prompts   FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE caption_prompts   SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_comment_templates_updated_at AFTER UPDATE ON comment_templates FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE comment_templates SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_comment_settings_updated_at  AFTER UPDATE ON comment_settings  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE comment_settings  SET updated_at = CURRENT_TIMESTAMP WHERE page_id = NEW.page_id; END;
CREATE TRIGGER IF NOT EXISTS trg_watched_channels_updated_at  AFTER UPDATE ON watched_channels  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE watched_channels  SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_ai_providers_updated_at      AFTER UPDATE ON ai_providers      FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE ai_providers      SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
```

- [ ] **Step 4: Test migration on existing DB**

Create `tests/backend/local/migration-plan2.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';
import { openDatabase, loadSchema, applyMigrations } from '../../../src/backend/local/db.js';

describe('Plan 2 migrations preserve existing data', () => {
  let tmpDir, dbPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-migrate-'));
    dbPath = path.join(tmpDir, 'old.db');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('adds sync columns to pages without losing rows', () => {
    // Seed an "old v1.0.0" database
    let db = new Database(dbPath);
    db.exec(`
      CREATE TABLE pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER, fb_page_id TEXT, name TEXT, daily_quota INTEGER DEFAULT 5,
        cooldown_min INTEGER DEFAULT 30, niche TEXT, enabled INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.prepare(`INSERT INTO pages (profile_id, fb_page_id, name) VALUES (1, '100', 'Old Page')`).run();
    db.close();

    // Run Plan 2 migrations
    const { db: db2 } = openDatabase(dbPath);
    applyMigrations(db2, [
      { table: 'pages', column: 'cloud_uuid', definition: 'TEXT UNIQUE' },
      { table: 'pages', column: 'cloud_synced_at', definition: 'DATETIME' },
      { table: 'pages', column: 'updated_at', definition: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
      { table: 'pages', column: 'deleted_at', definition: 'DATETIME' }
    ]);

    const cols = db2.prepare(`PRAGMA table_info(pages)`).all().map(c => c.name);
    expect(cols).toContain('cloud_uuid');
    expect(cols).toContain('updated_at');
    expect(cols).toContain('deleted_at');

    const existing = db2.prepare(`SELECT * FROM pages`).all();
    expect(existing).toHaveLength(1);
    expect(existing[0].name).toBe('Old Page');
    // cloud_uuid is NULL on existing rows — assigned on first sync
    expect(existing[0].cloud_uuid).toBeNull();
    db2.close();
  });
});
```

- [ ] **Step 5: Run all tests + commit**

```bash
npm test
git add schema.sql src/backend/server.js tests/backend/local/migration-plan2.test.js
git commit -m "feat(db): add cloud sync columns + updated_at triggers to 8 synced tables"
```

---

## Phase C: Device Guard (Tasks 8–9)

### Task 8: Device ID + heartbeat

**Files:**
- Create: `src/backend/cloud/deviceGuard.js`
- Create: `tests/backend/cloud/deviceGuard.test.js`

Device ID is deterministic: SHA256 of MAC address + Windows install ID. Heartbeat runs every 5 minutes, updates `user_devices.last_seen_at`.

- [ ] **Step 1: Tests**

Create `tests/backend/cloud/deviceGuard.test.js`:

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

let server;
const SUPABASE_URL = 'https://test.supabase.co';

beforeEach(() => {
  process.env.KINTENSHAUTO_SUPABASE_URL = SUPABASE_URL;
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';
});

describe('deviceGuard.getDeviceId', () => {
  it('returns the same ID across calls (deterministic)', async () => {
    const { getDeviceId } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    const id1 = getDeviceId();
    const id2 = getDeviceId();
    expect(id1).toBe(id2);
    expect(id1.length).toBeGreaterThanOrEqual(8);
  });

  it('returns a hex string', async () => {
    const { getDeviceId } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    expect(getDeviceId()).toMatch(/^[a-f0-9]+$/);
  });
});

describe('deviceGuard.claimDevice (via Supabase edge function)', () => {
  it('calls device-claim function with device_id + label', async () => {
    let receivedBody = null;
    server = setupServer(
      http.post(`${SUPABASE_URL}/functions/v1/device-claim`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({ status: 'claimed', is_takeover: false, session_token: 'tok-abc' });
      })
    );
    server.listen({ onUnhandledRequest: 'error' });

    const { claimDevice } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    const result = await claimDevice('jwt-test', 'My PC');

    expect(result.ok).toBe(true);
    expect(result.is_takeover).toBe(false);
    expect(receivedBody.device_id).toMatch(/^[a-f0-9]+$/);
    expect(receivedBody.device_label).toBe('My PC');
    server.close();
  });

  it('returns is_takeover=true when edge function reports takeover', async () => {
    server = setupServer(
      http.post(`${SUPABASE_URL}/functions/v1/device-claim`, () =>
        HttpResponse.json({ status: 'claimed', is_takeover: true, session_token: 'tok-new' })
      )
    );
    server.listen({ onUnhandledRequest: 'error' });

    const { claimDevice } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    const result = await claimDevice('jwt-test', 'My PC');
    expect(result.is_takeover).toBe(true);
    server.close();
  });
});
```

- [ ] **Step 2: Implement deviceGuard.js**

Create `src/backend/cloud/deviceGuard.js`:

```javascript
// Device identity + heartbeat + (later) Realtime kick subscriber.
//
// getDeviceId(): SHA-256 hex of (MAC address || os.hostname() || os.platform())
//                Deterministic per machine, doesn't change across launches.
// claimDevice(jwt, label): POST to device-claim edge function. Returns
//                          { ok, is_takeover, session_token }.
// startHeartbeat(jwt, intervalMs): periodic UPDATE of user_devices.last_seen_at.

const crypto = require('crypto');
const os = require('os');
const { getCloudConfig } = require('./config');

let _cachedDeviceId = null;
let _heartbeatTimer = null;

function getDeviceId() {
  if (_cachedDeviceId) return _cachedDeviceId;
  const ifaces = os.networkInterfaces();
  const macs = [];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.mac && iface.mac !== '00:00:00:00:00:00') {
        macs.push(iface.mac);
      }
    }
  }
  const fingerprint = [
    macs.sort().join('|'),
    os.hostname(),
    os.platform(),
    os.arch()
  ].join('::');
  _cachedDeviceId = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 32);
  return _cachedDeviceId;
}

function getDeviceLabel() {
  return `${os.hostname()} (${os.platform()} ${os.arch()})`;
}

async function claimDevice(accessToken, label) {
  const cfg = getCloudConfig();
  if (!cfg.isConfigured) return { ok: false, reason: 'not_configured' };

  const url = `${cfg.supabaseUrl}/functions/v1/device-claim`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        device_id: getDeviceId(),
        device_label: label || getDeviceLabel()
      })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, reason: 'http_' + res.status, message: text };
    }
    const data = await res.json();
    return {
      ok: true,
      status: data.status,
      is_takeover: data.is_takeover,
      session_token: data.session_token
    };
  } catch (err) {
    return { ok: false, reason: 'network_error', message: err.message };
  }
}

function startHeartbeat(getAccessToken, intervalMs = 5 * 60 * 1000, onFailure) {
  stopHeartbeat();
  let failCount = 0;
  _heartbeatTimer = setInterval(async () => {
    const token = getAccessToken();
    if (!token) return;
    const cfg = getCloudConfig();
    if (!cfg.isConfigured) return;
    try {
      const res = await fetch(`${cfg.supabaseUrl}/rest/v1/user_devices`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'apikey': cfg.supabaseAnonKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ last_seen_at: new Date().toISOString() })
      });
      if (res.ok) failCount = 0;
      else failCount++;
    } catch { failCount++; }
    if (failCount >= 3 && onFailure) onFailure('heartbeat_fail_3x');
  }, intervalMs);
}

function stopHeartbeat() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

function _resetForTests() {
  _cachedDeviceId = null;
  stopHeartbeat();
}

module.exports = {
  getDeviceId, getDeviceLabel, claimDevice,
  startHeartbeat, stopHeartbeat, _resetForTests
};
```

- [ ] **Step 3: Hook claimDevice into /api/auth/login**

In `src/backend/server.js`, modify the existing `/api/auth/login` handler to call `claimDevice` after successful login:

Find:
```javascript
app.post('/api/auth/login', asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'email and password required' });
    }
    const result = await authService.login(email, password);
    if (!result.ok) {
        const status = result.reason === 'invalid_credentials' ? 401
                     : result.reason === 'network_error' ? 503 : 400;
        return res.status(status).json({ ok: false, reason: result.reason, error: result.message });
    }
    res.json({ ok: true, user: result.user });
}));
```

Replace with:
```javascript
app.post('/api/auth/login', asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'email and password required' });
    }
    const result = await authService.login(email, password);
    if (!result.ok) {
        const status = result.reason === 'invalid_credentials' ? 401
                     : result.reason === 'network_error' ? 503 : 400;
        return res.status(status).json({ ok: false, reason: result.reason, error: result.message });
    }

    // Plan 2: claim the device slot
    const { claimDevice, startHeartbeat } = require('./cloud/deviceGuard');
    const claim = await claimDevice(result.session.access_token);
    if (!claim.ok) {
        // Login succeeded but claim failed — log out + return error
        await authService.logout();
        return res.status(503).json({
            ok: false, reason: 'device_claim_failed', error: claim.message
        });
    }

    // Start heartbeat
    startHeartbeat(
        () => authService.getStoredSession()?.access_token || null,
        5 * 60 * 1000,
        (reason) => console.warn('[deviceGuard]', reason)
    );

    res.json({
        ok: true,
        user: result.user,
        is_takeover: claim.is_takeover
    });
}));
```

Also modify `/api/auth/logout` to stop heartbeat:

Find:
```javascript
app.post('/api/auth/logout', asyncHandler(async (req, res) => {
    await authService.logout();
    res.json({ ok: true });
}));
```

Replace with:
```javascript
app.post('/api/auth/logout', asyncHandler(async (req, res) => {
    const { stopHeartbeat } = require('./cloud/deviceGuard');
    stopHeartbeat();
    await authService.logout();
    res.json({ ok: true });
}));
```

- [ ] **Step 4: Run + commit**

```bash
npm test -- tests/backend/cloud/deviceGuard.test.js
git add src/backend/cloud/deviceGuard.js src/backend/server.js tests/backend/cloud/deviceGuard.test.js
git commit -m "feat(cloud): add deviceGuard (claim + heartbeat) integrated with login flow"
```

---

### Task 9: Realtime kick subscriber

**Files:**
- Modify: `src/backend/cloud/deviceGuard.js` (add subscribeKick)
- Create: `tests/backend/cloud/deviceGuard.realtime.test.js`

When another device takes over, our session gets a `device_kick:<user_id>` pg_notify signal. Subscribe via Supabase Realtime, on kick → call logout + close browsers.

- [ ] **Step 1: Add subscribeKick to deviceGuard.js**

Append to `src/backend/cloud/deviceGuard.js`:

```javascript
// Subscribe to device_kick:<user_id> channel — fires when another device takes over.
// onKick callback receives nothing; it should stop work, close browsers, logout.
let _kickChannel = null;

function subscribeKick(userId, accessToken, onKick) {
  unsubscribeKick();
  const { getUserClient } = require('./supabaseClient');
  const client = getUserClient(accessToken);
  if (!client) return false;

  _kickChannel = client.channel(`device_kick:${userId}`)
    .on('broadcast', { event: 'kick' }, () => {
      try { onKick && onKick(); } catch (e) { console.error('[deviceGuard] onKick threw:', e.message); }
    })
    .subscribe();
  return true;
}

function unsubscribeKick() {
  if (_kickChannel) {
    try { _kickChannel.unsubscribe(); } catch {}
    _kickChannel = null;
  }
}

// Update _resetForTests to also unsubscribe
const _originalReset = module.exports._resetForTests;
module.exports.subscribeKick = subscribeKick;
module.exports.unsubscribeKick = unsubscribeKick;
module.exports._resetForTests = function() {
  _originalReset();
  unsubscribeKick();
};
```

Actually, instead of monkey-patching exports, rewrite the module exports block at the bottom of deviceGuard.js to include the new functions:

```javascript
module.exports = {
  getDeviceId, getDeviceLabel, claimDevice,
  startHeartbeat, stopHeartbeat,
  subscribeKick, unsubscribeKick,
  _resetForTests: function() {
    _cachedDeviceId = null;
    stopHeartbeat();
    unsubscribeKick();
  }
};
```

(Remove the earlier _resetForTests + module.exports block.)

- [ ] **Step 2: Wire into login flow**

In server.js login handler, after `startHeartbeat(...)`, add:

```javascript
// Subscribe to kick signal — when another device claims us, log out
const { subscribeKick } = require('./cloud/deviceGuard');
subscribeKick(result.user.id, result.session.access_token, async () => {
    console.warn('[deviceGuard] received kick signal — logging out');
    try {
        const browserManager = require('./core/browserManager');
        await browserManager.closeAll();
    } catch (e) {
        console.error('[deviceGuard] closeAll failed:', e.message);
    }
    const { stopHeartbeat, unsubscribeKick } = require('./cloud/deviceGuard');
    stopHeartbeat();
    unsubscribeKick();
    await authService.logout();
    io.emit('auth:kicked', { reason: 'another_device_signed_in' });
});
```

(The React UI subscribes to `auth:kicked` socket event and redirects to login.)

- [ ] **Step 3: Realtime test (basic — covering subscribe pattern)**

Create `tests/backend/cloud/deviceGuard.realtime.test.js`:

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  process.env.KINTENSHAUTO_SUPABASE_URL = 'https://test.supabase.co';
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';
});

describe('deviceGuard.subscribeKick', () => {
  it('returns false when supabase not configured', async () => {
    delete process.env.KINTENSHAUTO_SUPABASE_URL;
    const { subscribeKick } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    expect(subscribeKick('user-id', 'token', () => {})).toBe(false);
  });

  it('returns true when configured + creates a channel', async () => {
    const { subscribeKick, unsubscribeKick } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    const ok = subscribeKick('user-id', 'token-abc', () => {});
    expect(ok).toBe(true);
    unsubscribeKick();
  });
});
```

(End-to-end realtime test — actually receiving a broadcast — requires a real Supabase backend. Mark this as a Phase C integration test that runs against the deployed Supabase.)

- [ ] **Step 4: Run + commit**

```bash
npm test -- tests/backend/cloud/deviceGuard.realtime.test.js
git add src/backend/cloud/deviceGuard.js src/backend/server.js tests/backend/cloud/deviceGuard.realtime.test.js
git commit -m "feat(cloud): subscribe to device_kick Realtime channel; closes Chrome + logout on takeover"
```

---

## Phase D: Sync Engine (Tasks 10–12)

### Task 10: Sync engine — pullAll + pushOne + LWW merge

**Files:**
- Create: `src/backend/cloud/syncEngine.js`
- Create: `tests/backend/cloud/syncEngine.test.js`

`syncEngine` manages bidirectional sync between local SQLite and Supabase using LWW (per `updated_at`) conflict resolution.

- [ ] **Step 1: Sync table registry**

Create `src/backend/cloud/syncTables.js`:

```javascript
// Registry of locally-synced tables → cloud counterparts.
// Each entry describes:
//   localTable   — local SQLite table name
//   cloudTable   — Supabase mirror table name
//   columns      — fields to sync (excluding id/cloud_uuid/timestamps which are handled)
//   pkLocal      — local primary key column ('id' for most, 'page_id' for comment_settings)

module.exports = [
  {
    localTable: 'pages',
    cloudTable: 'cloud_pages',
    pkLocal: 'id',
    columns: ['fb_page_id', 'name', 'niche', 'daily_quota', 'cooldown_min', 'default_keyword', 'enabled']
  },
  {
    localTable: 'banner_presets',
    cloudTable: 'cloud_banner_presets',
    pkLocal: 'id',
    columns: ['name', 'layers_json']
  },
  {
    localTable: 'banners',
    cloudTable: 'cloud_banners',
    pkLocal: 'id',
    columns: ['name', 'width_px', 'height_px']   // file_path stays local
  },
  {
    localTable: 'caption_prompts',
    cloudTable: 'cloud_caption_prompts',
    pkLocal: 'id',
    columns: ['page_id', 'system_prompt', 'user_prompt', 'max_tokens', 'temperature', 'selected_model']
  },
  {
    localTable: 'comment_templates',
    cloudTable: 'cloud_comment_templates',
    pkLocal: 'id',
    columns: ['page_id', 'label', 'content', 'enabled', 'weight']
  },
  {
    localTable: 'comment_settings',
    cloudTable: 'cloud_comment_settings',
    pkLocal: 'page_id',
    columns: ['enabled', 'delay_sec', 'jitter_sec', 'max_per_day', 'cooldown_min',
              'enable_self_reply', 'enable_pin', 'detect_removal']
  },
  {
    localTable: 'watched_channels',
    cloudTable: 'cloud_watched_channels',
    pkLocal: 'id',
    columns: ['label', 'platform', 'channel_url', 'content_type', 'interval_hours',
              'min_duration_sec', 'max_duration_sec', 'enabled']
  },
  {
    localTable: 'ai_providers',
    cloudTable: 'cloud_ai_providers',
    pkLocal: 'id',
    columns: ['provider', 'model', 'label', 'enabled'],
    encryptedColumns: ['api_key']   // mapped to encrypted_key on cloud
  }
];
```

- [ ] **Step 2: Implement syncEngine.js**

Create `src/backend/cloud/syncEngine.js`:

```javascript
// Sync engine — bidirectional last-write-wins sync between local SQLite
// and Supabase cloud_* mirror tables.
//
// API:
//   pullAll(db, accessToken)   — fetch all cloud rows, LWW-merge into local
//   pushOne(db, accessToken, localTable, localId)  — push one local row to cloud
//   pushPending(db, accessToken) — push every row WHERE cloud_synced_at < updated_at
//
// All operations are no-ops when supabase isn't configured.

const { getUserClient } = require('./supabaseClient');
const SYNC_TABLES = require('./syncTables');
const crypto = require('crypto');

function generateUuid() {
  return crypto.randomUUID();
}

function tableConfig(localTable) {
  return SYNC_TABLES.find(t => t.localTable === localTable);
}

async function pullAll(db, accessToken) {
  const client = getUserClient(accessToken);
  if (!client) return { ok: false, reason: 'not_configured' };

  let totalInserted = 0, totalUpdated = 0, totalSkipped = 0;

  for (const cfg of SYNC_TABLES) {
    const { data: cloudRows, error } = await client.from(cfg.cloudTable).select('*');
    if (error) {
      console.error(`[sync] pull ${cfg.cloudTable} failed:`, error.message);
      continue;
    }
    for (const cloudRow of cloudRows || []) {
      const localRow = db.prepare(
        `SELECT * FROM ${cfg.localTable} WHERE cloud_uuid = ?`
      ).get(cloudRow.cloud_uuid);

      if (cloudRow.deleted_at) {
        if (localRow) {
          db.prepare(`UPDATE ${cfg.localTable} SET deleted_at = ? WHERE ${cfg.pkLocal} = ?`)
            .run(cloudRow.deleted_at, localRow[cfg.pkLocal]);
          totalUpdated++;
        }
        continue;
      }

      if (!localRow) {
        // INSERT — build value list from cfg.columns
        const cols = ['cloud_uuid', 'cloud_synced_at', 'updated_at', ...cfg.columns];
        const vals = [cloudRow.cloud_uuid, new Date().toISOString(), cloudRow.updated_at,
                      ...cfg.columns.map(c => cloudRow[c] ?? null)];
        const placeholders = cols.map(() => '?').join(',');
        db.prepare(`INSERT INTO ${cfg.localTable} (${cols.join(',')}) VALUES (${placeholders})`)
          .run(...vals);
        totalInserted++;
      } else {
        const localUpdated = new Date(localRow.updated_at).getTime();
        const cloudUpdated = new Date(cloudRow.updated_at).getTime();
        if (cloudUpdated > localUpdated) {
          const sets = cfg.columns.map(c => `${c} = ?`).join(', ');
          const vals = [...cfg.columns.map(c => cloudRow[c] ?? null),
                        cloudRow.updated_at, new Date().toISOString(),
                        localRow[cfg.pkLocal]];
          db.prepare(`UPDATE ${cfg.localTable} SET ${sets}, updated_at = ?, cloud_synced_at = ? WHERE ${cfg.pkLocal} = ?`)
            .run(...vals);
          totalUpdated++;
        } else {
          totalSkipped++;
        }
      }
    }
  }

  return { ok: true, inserted: totalInserted, updated: totalUpdated, skipped: totalSkipped };
}

async function pushOne(db, accessToken, localTable, localPk) {
  const cfg = tableConfig(localTable);
  if (!cfg) return { ok: false, reason: 'unknown_table' };
  const client = getUserClient(accessToken);
  if (!client) return { ok: false, reason: 'not_configured' };

  const row = db.prepare(`SELECT * FROM ${localTable} WHERE ${cfg.pkLocal} = ?`).get(localPk);
  if (!row) return { ok: false, reason: 'row_not_found' };

  // Assign cloud_uuid if missing
  if (!row.cloud_uuid) {
    const uuid = generateUuid();
    db.prepare(`UPDATE ${localTable} SET cloud_uuid = ? WHERE ${cfg.pkLocal} = ?`).run(uuid, localPk);
    row.cloud_uuid = uuid;
  }

  // Build upsert payload
  const payload = {
    cloud_uuid: row.cloud_uuid,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at || null
  };
  for (const c of cfg.columns) payload[c] = row[c];

  const { error } = await client.from(cfg.cloudTable).upsert(payload, { onConflict: 'cloud_uuid' });
  if (error) return { ok: false, reason: 'upsert_failed', message: error.message };

  db.prepare(`UPDATE ${localTable} SET cloud_synced_at = datetime('now', 'localtime') WHERE ${cfg.pkLocal} = ?`)
    .run(localPk);
  return { ok: true };
}

async function pushPending(db, accessToken) {
  let pushed = 0, failed = 0;
  for (const cfg of SYNC_TABLES) {
    const pending = db.prepare(`
      SELECT ${cfg.pkLocal} as pk FROM ${cfg.localTable}
      WHERE cloud_synced_at IS NULL OR cloud_synced_at < updated_at
    `).all();
    for (const p of pending) {
      const r = await pushOne(db, accessToken, cfg.localTable, p.pk);
      if (r.ok) pushed++; else failed++;
    }
  }
  return { ok: true, pushed, failed };
}

module.exports = { pullAll, pushOne, pushPending };
```

- [ ] **Step 3: Tests for sync engine (basic LWW cases)**

Create `tests/backend/cloud/syncEngine.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';

const SUPABASE_URL = 'https://test.supabase.co';
let server, tmpDir, db;

beforeEach(() => {
  process.env.KINTENSHAUTO_SUPABASE_URL = SUPABASE_URL;
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-sync-'));
  db = new Database(path.join(tmpDir, 't.db'));
  db.exec(`
    CREATE TABLE banner_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      layers_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      cloud_uuid TEXT UNIQUE,
      cloud_synced_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at DATETIME
    );
  `);
});

afterEach(() => {
  if (db) db.close();
  if (server) server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('syncEngine.pullAll', () => {
  it('inserts cloud rows that do not exist locally', async () => {
    server = setupServer(
      // First request — banner_presets returns 1 row, others return empty
      http.get(`${SUPABASE_URL}/rest/v1/cloud_banner_presets`, () =>
        HttpResponse.json([{
          cloud_uuid: 'uuid-1', name: 'Logo TG', layers_json: '[]',
          updated_at: '2026-05-16T10:00:00Z', deleted_at: null
        }])
      ),
      // Match-all for other tables in the registry — return empty array
      http.get(`${SUPABASE_URL}/rest/v1/:table`, () => HttpResponse.json([]))
    );
    server.listen({ onUnhandledRequest: 'bypass' });

    const { pullAll } = await import('../../../src/backend/cloud/syncEngine.js?n=' + Date.now());
    const result = await pullAll(db, 'access-tok');

    expect(result.ok).toBe(true);
    expect(result.inserted).toBeGreaterThanOrEqual(1);

    const rows = db.prepare(`SELECT * FROM banner_presets WHERE cloud_uuid = ?`).all('uuid-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Logo TG');
  });
});

describe('syncEngine.pushOne', () => {
  it('assigns cloud_uuid and upserts to cloud', async () => {
    let upsertedBody = null;
    server = setupServer(
      http.post(`${SUPABASE_URL}/rest/v1/cloud_banner_presets`, async ({ request }) => {
        upsertedBody = await request.json();
        return HttpResponse.json([{ cloud_uuid: 'generated' }]);
      })
    );
    server.listen({ onUnhandledRequest: 'bypass' });

    db.prepare(`INSERT INTO banner_presets (name, layers_json) VALUES ('Local Preset', '[]')`).run();

    const { pushOne } = await import('../../../src/backend/cloud/syncEngine.js?n=' + Date.now());
    const result = await pushOne(db, 'tok', 'banner_presets', 1);

    expect(result.ok).toBe(true);
    expect(upsertedBody.name).toBe('Local Preset');
    expect(upsertedBody.cloud_uuid).toMatch(/^[a-f0-9-]+$/);

    // cloud_synced_at should now be set
    const row = db.prepare(`SELECT * FROM banner_presets WHERE id = 1`).get();
    expect(row.cloud_synced_at).not.toBeNull();
    expect(row.cloud_uuid).toBe(upsertedBody.cloud_uuid);
  });
});
```

- [ ] **Step 4: Commit**

```bash
npm test -- tests/backend/cloud/syncEngine.test.js
git add src/backend/cloud/syncTables.js src/backend/cloud/syncEngine.js tests/backend/cloud/syncEngine.test.js
git commit -m "feat(cloud): add syncEngine (pullAll + pushOne + pushPending) with LWW (3 tests)"
```

---

### Task 11: Sync hooks into local writes (debounced)

**Files:**
- Modify: `src/backend/server.js` (instrument PUT/POST/DELETE handlers for synced tables)
- Create: `src/backend/cloud/syncHooks.js`

When the user edits a setting via the local API, we want to push the change to cloud after a brief debounce. Rather than instrument every endpoint, we hook the SQLite update_hook.

- [ ] **Step 1: Implement syncHooks.js**

Create `src/backend/cloud/syncHooks.js`:

```javascript
// Hook into SQLite write events. When a synced table is written to, schedule
// a debounced push to cloud. Each table+rowid pair has its own debounce timer
// (rapid edits to the same row coalesce; edits to different rows don't queue
// behind each other).

const { pushOne } = require('./syncEngine');
const SYNC_TABLES = require('./syncTables');

const DEBOUNCE_MS = 2000;
const _pendingTimers = new Map();    // `${table}|${pk}` → timeoutId

function _key(table, pk) { return `${table}|${pk}`; }

function startSyncHooks(db, getAccessToken) {
  // We chose explicit notifySync(table, pk) calls over SQLite update_hook.
  // Reason: update_hook fires on EVERY write including transactions internal
  // to the FB pipeline (clips/jobs/scouted_videos) which we explicitly do
  // NOT want to sync. Explicit calls keep the sync surface tightly scoped
  // to the eight tables listed in SYNC_TABLES, with zero risk of leaking
  // hot pipeline state to cloud.

  const syncedTableNames = new Set(SYNC_TABLES.map(t => t.localTable));

  return {
    notifySync(table, pk) {
      if (!syncedTableNames.has(table)) return;
      const k = _key(table, pk);
      if (_pendingTimers.has(k)) clearTimeout(_pendingTimers.get(k));
      const t = setTimeout(async () => {
        _pendingTimers.delete(k);
        const tok = getAccessToken();
        if (!tok) return;
        try {
          await pushOne(db, tok, table, pk);
        } catch (e) {
          console.error(`[syncHooks] push ${table}/${pk} failed:`, e.message);
        }
      }, DEBOUNCE_MS);
      _pendingTimers.set(k, t);
    },

    flushAll() {
      for (const t of _pendingTimers.values()) clearTimeout(t);
      _pendingTimers.clear();
    }
  };
}

module.exports = { startSyncHooks };
```

- [ ] **Step 2: Wire into server.js**

At the top of server.js (after the auth middleware), add:

```javascript
// Plan 2: sync hooks — schedule cloud pushes on local writes to synced tables
const { startSyncHooks } = require('./cloud/syncHooks');
const _syncHooks = startSyncHooks(db, () => _authService.getStoredSession()?.access_token || null);
```

Then in each PUT/POST/DELETE handler for synced tables, add `_syncHooks.notifySync(tableName, rowPk)` AFTER the local DB write but BEFORE `res.json(...)`. Example for banner_presets:

Find:
```javascript
app.post('/api/banner-presets', asyncHandler(async (req, res) => {
    const { name, layers } = req.body;
    if (!name || !Array.isArray(layers)) throw badRequest('...');
    const id = bannerPresets.savePreset(name, layers);
    res.json({ id });
}));
```

Modify to:
```javascript
app.post('/api/banner-presets', asyncHandler(async (req, res) => {
    const { name, layers } = req.body;
    if (!name || !Array.isArray(layers)) throw badRequest('...');
    const id = bannerPresets.savePreset(name, layers);
    _syncHooks.notifySync('banner_presets', id);
    res.json({ id });
}));
```

Apply the same pattern to ALL POST/PUT/DELETE handlers for these tables: `pages`, `banner_presets`, `banners`, `caption_prompts`, `comment_templates`, `comment_settings`, `watched_channels`, `ai_providers`.

That's roughly 15-20 endpoints. List them via:
```bash
grep -nE "app\.(post|put|delete).*'/api/(pages|banner-presets|banners|caption-prompts|comment-templates|comment-settings|watcher/channels|ai/providers)" src/backend/server.js
```

Edit each one to insert the `_syncHooks.notifySync(...)` call.

- [ ] **Step 3: Test (debounce behavior)**

Create `tests/backend/cloud/syncHooks.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';

let tmpDir, db;

beforeEach(() => {
  process.env.KINTENSHAUTO_SUPABASE_URL = 'https://t.supabase.co';
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-hook-'));
  db = new Database(path.join(tmpDir, 'h.db'));
});

afterEach(() => {
  if (db) db.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  vi.useRealTimers();
});

describe('syncHooks.notifySync (debounce)', () => {
  it('coalesces rapid edits to the same row into one push', async () => {
    vi.useFakeTimers();

    // Mock pushOne by stubbing the syncEngine module
    let pushCount = 0;
    vi.doMock('../../../src/backend/cloud/syncEngine.js', () => ({
      pushOne: vi.fn(async () => { pushCount++; return { ok: true }; }),
      pullAll: vi.fn(),
      pushPending: vi.fn()
    }));

    const { startSyncHooks } = await import('../../../src/backend/cloud/syncHooks.js?n=' + Date.now());
    const hooks = startSyncHooks(db, () => 'tok');

    hooks.notifySync('banner_presets', 1);
    hooks.notifySync('banner_presets', 1);
    hooks.notifySync('banner_presets', 1);
    expect(pushCount).toBe(0);

    await vi.advanceTimersByTimeAsync(2100);
    expect(pushCount).toBe(1);

    vi.doUnmock('../../../src/backend/cloud/syncEngine.js');
  });

  it('debounces different rows independently', async () => {
    vi.useFakeTimers();
    let pushCount = 0;
    vi.doMock('../../../src/backend/cloud/syncEngine.js', () => ({
      pushOne: vi.fn(async () => { pushCount++; return { ok: true }; }),
      pullAll: vi.fn(), pushPending: vi.fn()
    }));

    const { startSyncHooks } = await import('../../../src/backend/cloud/syncHooks.js?n=' + Date.now());
    const hooks = startSyncHooks(db, () => 'tok');

    hooks.notifySync('banner_presets', 1);
    hooks.notifySync('banner_presets', 2);

    await vi.advanceTimersByTimeAsync(2100);
    expect(pushCount).toBe(2);

    vi.doUnmock('../../../src/backend/cloud/syncEngine.js');
  });
});
```

- [ ] **Step 4: Commit**

```bash
npm test
git add -A
git commit -m "feat(cloud): sync hooks + instrument synced-table POST/PUT/DELETE endpoints"
```

---

### Task 12: Initial sync on login + retry on reconnect

**Files:**
- Modify: `src/backend/server.js` (call pullAll after login + pushPending periodically)

- [ ] **Step 1: Modify login handler**

In `src/backend/server.js`, after subscribeKick is called (Task 9), add an initial sync:

```javascript
// Plan 2: pull cloud state immediately after login (LWW merge with local)
const { pullAll, pushPending } = require('./cloud/syncEngine');
const initialPull = await pullAll(db, result.session.access_token);
console.log('[sync] initial pull:', initialPull);

// Push any pending local writes (e.g., changes made before login)
await pushPending(db, result.session.access_token);
```

Also add a background retry loop. After the existing `setInterval(() => releaseReservedClips(), 5 * 60 * 1000);` line, add:

```javascript
// Plan 2: retry failed pushes every 5 min
setInterval(async () => {
    const session = _authService.getStoredSession();
    if (!session?.access_token) return;
    try {
        await pushPending(db, session.access_token);
    } catch (e) { console.error('[sync] periodic push:', e.message); }
}, 5 * 60 * 1000);
```

- [ ] **Step 2: Commit**

```bash
git add src/backend/server.js
git commit -m "feat(cloud): pullAll on login + pushPending periodically (5min)"
```

---

## Phase E: Update Checker (Task 13)

### Task 13: Update checker integration with electron-updater

**Files:**
- Create: `src/backend/cloud/updateChecker.js`
- Create: `tests/backend/cloud/updateChecker.test.js`
- Modify: `electron/main.js` (call updateChecker on app launch + show modal)

- [ ] **Step 1: Implement updateChecker.js**

Create `src/backend/cloud/updateChecker.js`:

```javascript
// Calls the check-version edge function. Returns one of:
//   { ok: true, force_update: null, soft_update: null }
//   { ok: false, force_update: { required_version, download_url, release_notes_md }, soft_update: null }
//   { ok: true, force_update: null, soft_update: { latest_version, release_notes_md, download_url } }

const { getCloudConfig } = require('./config');

async function checkVersion(accessToken, clientVersion) {
  const cfg = getCloudConfig();
  if (!cfg.isConfigured) return { ok: true, force_update: null, soft_update: null };

  try {
    const res = await fetch(`${cfg.supabaseUrl}/functions/v1/check-version`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ client_version: clientVersion })
    });
    if (!res.ok) return { ok: true, force_update: null, soft_update: null, error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    // Network errors don't block — assume OK
    return { ok: true, force_update: null, soft_update: null, error: err.message };
  }
}

module.exports = { checkVersion };
```

- [ ] **Step 2: Tests**

Create `tests/backend/cloud/updateChecker.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

let server;
const SUPABASE_URL = 'https://test.supabase.co';

beforeEach(() => {
  process.env.KINTENSHAUTO_SUPABASE_URL = SUPABASE_URL;
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';
});

afterEach(() => { if (server) server.close(); });

describe('updateChecker.checkVersion', () => {
  it('returns ok:true when client is up to date', async () => {
    server = setupServer(
      http.post(`${SUPABASE_URL}/functions/v1/check-version`, () =>
        HttpResponse.json({ ok: true, force_update: null, soft_update: null }))
    );
    server.listen({ onUnhandledRequest: 'error' });
    const { checkVersion } = await import('../../../src/backend/cloud/updateChecker.js?n=' + Date.now());
    const r = await checkVersion('tok', '1.0.0');
    expect(r.ok).toBe(true);
    expect(r.force_update).toBeNull();
  });

  it('returns force_update when minimum version is higher', async () => {
    server = setupServer(
      http.post(`${SUPABASE_URL}/functions/v1/check-version`, () =>
        HttpResponse.json({
          ok: false,
          force_update: { required_version: '1.2.0', download_url: 'http://x', release_notes_md: 'fix' },
          soft_update: null
        }))
    );
    server.listen({ onUnhandledRequest: 'error' });
    const { checkVersion } = await import('../../../src/backend/cloud/updateChecker.js?n=' + Date.now());
    const r = await checkVersion('tok', '1.0.0');
    expect(r.ok).toBe(false);
    expect(r.force_update.required_version).toBe('1.2.0');
  });

  it('treats network error as no-update (does not block app)', async () => {
    server = setupServer(
      http.post(`${SUPABASE_URL}/functions/v1/check-version`, () => HttpResponse.error())
    );
    server.listen({ onUnhandledRequest: 'error' });
    const { checkVersion } = await import('../../../src/backend/cloud/updateChecker.js?n=' + Date.now());
    const r = await checkVersion('tok', '1.0.0');
    expect(r.ok).toBe(true);
    expect(r.error).toBeDefined();
  });
});
```

- [ ] **Step 3: Wire into Electron main.js**

In `electron/main.js`, the existing `setupAutoUpdater()` function handles electron-updater (GitHub Releases). Add a NEW function that calls our cloud check-version edge function:

After `setupAutoUpdater()`, add:

```javascript
function setupCloudVersionCheck() {
    if (!app.isPackaged) return;
    // Poll backend /api/auth/status; if logged in, hit /api/version/check
    setTimeout(async () => {
        try {
            const http = require('http');
            const checkOnce = () => new Promise((resolve) => {
                const req = http.get({
                    host: '127.0.0.1', port: backendPort,
                    path: '/api/version/check', timeout: 5000
                }, res => {
                    let body = '';
                    res.on('data', c => body += c);
                    res.on('end', () => {
                        try { resolve(JSON.parse(body)); }
                        catch { resolve(null); }
                    });
                });
                req.on('error', () => resolve(null));
                req.on('timeout', () => { req.destroy(); resolve(null); });
            });
            const result = await checkOnce();
            if (!result) return;
            if (result.force_update) {
                try { mainWindow?.webContents.send('cloud-update:force', result.force_update); } catch {}
            } else if (result.soft_update) {
                try { mainWindow?.webContents.send('cloud-update:soft', result.soft_update); } catch {}
            }
        } catch (e) { logError('cloud version check: ' + e.message); }
    }, 15000);  // 15s after app launch
}
```

Call `setupCloudVersionCheck()` after `setupAutoUpdater()` in `app.whenReady().then(...)`.

Also add a corresponding `/api/version/check` endpoint in server.js:

```javascript
app.get('/api/version/check', asyncHandler(async (req, res) => {
    const session = _authService.getStoredSession();
    if (!session?.access_token) return res.json({ ok: true, force_update: null, soft_update: null });
    const { checkVersion } = require('./cloud/updateChecker');
    const pkg = require('../../package.json');
    const result = await checkVersion(session.access_token, pkg.version);
    res.json(result);
}));
```

And expose `cloud-update:*` IPC events through preload:

In `electron/preload.js`, add to `contextBridge.exposeInMainWorld('kintenshauto', {...})`:

```javascript
    onCloudUpdateForce: (cb) => {
        const listener = (_, info) => { try { cb(info); } catch {} };
        ipcRenderer.on('cloud-update:force', listener);
        return () => ipcRenderer.removeListener('cloud-update:force', listener);
    },
    onCloudUpdateSoft: (cb) => {
        const listener = (_, info) => { try { cb(info); } catch {} };
        ipcRenderer.on('cloud-update:soft', listener);
        return () => ipcRenderer.removeListener('cloud-update:soft', listener);
    }
```

- [ ] **Step 4: Commit**

```bash
npm test -- tests/backend/cloud/updateChecker.test.js
git add src/backend/cloud/updateChecker.js src/backend/server.js electron/main.js electron/preload.js tests/backend/cloud/updateChecker.test.js
git commit -m "feat(cloud): updateChecker + IPC events for soft/force update prompts"
```

---

## Phase F: Login UI + React Integration (Tasks 14–16)

### Task 14: React LoginScreen + routing

**Files:**
- Create: `src/login/LoginScreen.jsx`
- Modify: `src/App.jsx` (add Login state between Loading and Setup/Dashboard)

- [ ] **Step 1: Create LoginScreen.jsx**

Create `src/login/LoginScreen.jsx`:

```jsx
import React, { useState } from 'react';
import SamuraiBackground from '../components/SamuraiBackground';

const API = 'http://localhost:3003';

export default function LoginScreen({ onSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [takeoverPrompt, setTakeoverPrompt] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        const messages = {
          invalid_credentials: 'Email or password is incorrect',
          user_suspended: 'Account suspended — contact admin',
          device_claim_failed: 'Could not register device — check your connection',
          network_error: 'Cannot reach server — check your internet',
          not_configured: 'Cloud not configured — contact admin'
        };
        setError(messages[data.reason] || data.error || 'Login failed');
        setSubmitting(false);
        return;
      }
      if (data.is_takeover) {
        setTakeoverPrompt({ user: data.user });
        setTimeout(() => onSuccess(data.user), 2500);
      } else {
        onSuccess(data.user);
      }
    } catch (err) {
      setError('Network error: ' + err.message);
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      width: '100vw', height: '100vh', position: 'relative',
      overflow: 'hidden', background: 'var(--sumi-ink)'
    }}>
      <SamuraiBackground opacity={0.55} />
      <div style={{
        position: 'relative', zIndex: 2,
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}>
        <form onSubmit={submit} className="panel" style={{ width: 380, padding: 32 }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div className="kanji-title" style={{ fontSize: 48 }}>剣天照</div>
            <div style={{ fontSize: 13, color: 'var(--gold)', letterSpacing: 3 }}>
              KINTENSHAUTO
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Sign in to continue
            </div>
          </div>

          <label>Email</label>
          <input
            type="email" value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
            required disabled={submitting}
            style={{ marginBottom: 12 }}
          />

          <label>Password</label>
          <input
            type="password" value={password}
            onChange={e => setPassword(e.target.value)}
            required disabled={submitting}
            style={{ marginBottom: 16 }}
          />

          {error && (
            <div style={{
              padding: 10, marginBottom: 14, fontSize: 12,
              background: 'rgba(232,123,123,0.1)',
              border: '0.5px solid var(--danger)',
              color: 'var(--danger)'
            }}>
              {error}
            </div>
          )}

          {takeoverPrompt && (
            <div style={{
              padding: 10, marginBottom: 14, fontSize: 12,
              background: 'rgba(212,167,72,0.1)',
              border: '0.5px solid var(--warning)',
              color: 'var(--warning)'
            }}>
              Signed in from this device — previous session has been signed out.
            </div>
          )}

          <button
            type="submit" className="btn-primary"
            disabled={submitting || !email || !password}
            style={{ width: '100%', padding: '12px 0' }}
          >
            {submitting ? 'Signing in...' : 'Sign in'}
          </button>

          <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
            Internal use only — contact admin for an account
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update App.jsx routing**

Modify `src/App.jsx`:

```jsx
import React, { useEffect, useState } from 'react';
import LoginScreen from './login/LoginScreen';
import SetupWizard from './setup-wizard/SetupWizard';
import Dashboard from './Dashboard';

const API = 'http://localhost:3003';

export default function App() {
  const [state, setState] = useState({ loading: true, loggedIn: false, firstRun: false, user: null });

  useEffect(() => {
    (async () => {
      // Check both first-run flag AND login status
      let firstRun = false;
      let loggedIn = false;
      let user = null;

      try {
        if (window.kintenshauto?.isFirstRun) {
          firstRun = await window.kintenshauto.isFirstRun();
        } else {
          firstRun = window.location.hash.includes('setup');
        }

        const statusRes = await fetch(`${API}/api/auth/status`);
        const statusData = await statusRes.json();
        loggedIn = statusData.logged_in === true;
        user = statusData.user || null;
      } catch {
        // If status check fails (backend down), assume logged out
        loggedIn = false;
      }

      setState({ loading: false, loggedIn, firstRun, user });
    })();

    // Listen for force-logout (device takeover)
    if (window.kintenshauto?.onCloudUpdateForce) {
      // wire force/soft update handlers — implementation in Task 15
    }
  }, []);

  if (state.loading) {
    return <LoadingScreen />;
  }

  if (!state.loggedIn) {
    return <LoginScreen onSuccess={(user) => setState({
      ...state, loggedIn: true, user
    })} />;
  }

  if (state.firstRun) {
    return <SetupWizard onComplete={() => setState({ ...state, firstRun: false })} />;
  }

  return <Dashboard user={state.user} />;
}

function LoadingScreen() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      height: '100vh',
      background: 'radial-gradient(ellipse at center, #2a0a1a 0%, #0a0a0d 100%)'
    }}>
      <div style={{
        fontFamily: 'Noto Serif JP, serif',
        fontSize: 64, color: '#d4af37', letterSpacing: 4
      }}>剣天照</div>
      <div style={{ color: '#8b7355', fontSize: 12, letterSpacing: 3, marginTop: 8 }}>
        Loading...
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Smoke test the login flow manually**

```bash
npm run dev
# In another terminal:
npm start
```

Verify:
- Login screen appears (since no session)
- Entering bad credentials shows error
- (To test happy path, you'd need real Supabase deployed)

- [ ] **Step 4: Commit**

```bash
git add src/login/LoginScreen.jsx src/App.jsx
git commit -m "feat(ui): add LoginScreen + App.jsx routing (Login → Setup → Dashboard)"
```

---

### Task 15: Update prompt modals (soft + force)

**Files:**
- Create: `src/components/UpdatePromptModal.jsx`
- Modify: `src/Dashboard.jsx` (mount modal)

- [ ] **Step 1: Create the modal component**

Create `src/components/UpdatePromptModal.jsx`:

```jsx
import React from 'react';

export default function UpdatePromptModal({ kind, info, onUpdate, onLater }) {
  if (!info) return null;
  const isForce = kind === 'force';
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 10000
    }}>
      <div className="panel" style={{ maxWidth: 500, padding: 28 }}>
        <div className="kanji-title" style={{ fontSize: 32, marginBottom: 8,
          color: isForce ? 'var(--danger)' : 'var(--gold)' }}>
          {isForce ? '必須更新' : '更新可能'}
        </div>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>
          {isForce ? 'Required Update' : 'Update Available'}
        </div>
        <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16 }}>
          {isForce
            ? `Your version is no longer supported. Update to ${info.required_version} to continue.`
            : `Version ${info.latest_version} is ready to install.`}
        </div>
        {info.release_notes_md && (
          <div style={{
            padding: 12, marginBottom: 20, fontSize: 12,
            background: 'var(--surface-2)', border: '0.5px solid var(--border-faint)',
            whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto'
          }}>
            {info.release_notes_md}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {!isForce && (
            <button onClick={onLater}>Later</button>
          )}
          <button className="btn-primary" onClick={onUpdate}>
            {isForce ? 'Download & Install' : 'Update Now'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount in Dashboard.jsx**

In `src/Dashboard.jsx`, add state + listener:

Near the top of the Dashboard component (after the existing useState calls):

```jsx
const [updatePrompt, setUpdatePrompt] = useState(null); // { kind: 'force' | 'soft', info }

useEffect(() => {
  if (!window.kintenshauto) return;
  const offForce = window.kintenshauto.onCloudUpdateForce?.((info) => {
    setUpdatePrompt({ kind: 'force', info });
  });
  const offSoft = window.kintenshauto.onCloudUpdateSoft?.((info) => {
    setUpdatePrompt({ kind: 'soft', info });
  });
  return () => { offForce?.(); offSoft?.(); };
}, []);
```

In the return JSX, before the closing `</div>` of the main app-shell:

```jsx
{updatePrompt && (
  <UpdatePromptModal
    kind={updatePrompt.kind}
    info={updatePrompt.info}
    onUpdate={() => {
      if (updatePrompt.info.download_url) {
        window.kintenshauto?.openExternal(updatePrompt.info.download_url);
      }
    }}
    onLater={() => setUpdatePrompt(null)}
  />
)}
```

Add the import at the top of Dashboard.jsx:
```jsx
import UpdatePromptModal from './components/UpdatePromptModal';
```

- [ ] **Step 3: Commit**

```bash
git add src/components/UpdatePromptModal.jsx src/Dashboard.jsx
git commit -m "feat(ui): add UpdatePromptModal (soft + force update) mounted in Dashboard"
```

---

### Task 16: Force-logout UI (handle device takeover)

**Files:**
- Modify: `src/Dashboard.jsx` (listen for auth:kicked socket event)
- Modify: `electron/preload.js` (expose kicked event)

- [ ] **Step 1: Wire socket event through preload**

The backend already emits `io.emit('auth:kicked', ...)` from the device kick handler (Task 9). The React UI connects to socket.io directly (not through IPC). Add a useEffect in Dashboard.jsx:

```jsx
useEffect(() => {
  // Subscribe to socket events
  let sock;
  (async () => {
    try {
      const { io } = await import('socket.io-client');
      sock = io('http://localhost:3003');
      sock.on('auth:kicked', () => {
        alert('Signed in on another device. You will be returned to the login screen.');
        window.location.reload();
      });
    } catch (e) { console.warn('socket connect failed', e); }
  })();
  return () => sock?.disconnect();
}, []);
```

Wait — Dashboard.jsx doesn't currently import socket.io-client. Add to devDependencies:

```bash
npm install socket.io-client@^4.7.0 --ignore-scripts --no-audit --no-fund
```

(socket.io is already a backend dep but the client side wasn't bundled before.)

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json src/Dashboard.jsx
git commit -m "feat(ui): subscribe to auth:kicked socket event → reload to login"
```

---

## Phase G: Documentation + Wrap-up (Task 17)

### Task 17: Update CHANGELOG + CLAUDE.md + verify everything

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CHANGELOG.md**

Append a new section at the top (after the existing `## [Unreleased] — Plan 1 Foundation` block):

```markdown
## [Unreleased] — Plan 2 Desktop Cloud Integration

### Added
- `@supabase/supabase-js@^2.39.0` production dependency
- `socket.io-client@^4.7.0` (for Dashboard auth:kicked listener)
- `src/backend/cloud/` modules:
  - `config.js` — reads Supabase URL + anon key from env or .env file
  - `supabaseClient.js` — singleton client + getUserClient per token
  - `sessionStore.js` — encrypted local storage for the Supabase session
  - `authService.js` — login, logout, refresh, getStoredSession
  - `audit.js` — local audit_queue + flush to cloud audit_log
  - `deviceGuard.js` — device ID + claim + heartbeat + Realtime kick subscribe
  - `syncTables.js` + `syncEngine.js` — bidirectional LWW sync for 8 tables
  - `syncHooks.js` — debounced push triggered from POST/PUT/DELETE handlers
  - `updateChecker.js` — calls check-version edge function
- API routes: `/api/auth/{login,logout,status,refresh}`, `/api/version/check`
- requireAuth middleware on `/api/*` (exempt: /api/health, /api/auth/*)
- 8 synced local tables now have `cloud_uuid`, `cloud_synced_at`, `updated_at`, `deleted_at` columns
- 8 `updated_at` triggers (auto-bump on UPDATE)
- `audit_queue` local table
- React `LoginScreen.jsx` + routing (App.jsx: Loading → Login → Setup → Dashboard)
- `UpdatePromptModal.jsx` (soft + force update modes)
- Force-logout UI on `auth:kicked` socket event

### Changed
- `/api/auth/login` now claims device via edge function + starts heartbeat + subscribes to kick
- `/api/auth/logout` stops heartbeat + unsubscribes kick
- App.jsx: gates Dashboard behind login

### Test coverage
- 30+ new tests across cloud/ modules (MSW-mocked Supabase)
- Integration tests for auth routes + middleware
- Migration test verifies existing v1.0.0 data preserved
```

- [ ] **Step 2: Update CLAUDE.md cloud section**

Find this block in CLAUDE.md:

```markdown
## Cloud project

Separate repo (not yet created): `../kintenshauto-cloud/`.
Will contain Supabase migrations + edge functions (device-claim, check-version,
admin-reset-device). Setup happens in Plan 1 Phase C — currently BLOCKED on
Supabase CLI install + Docker Desktop + user creating a Supabase project.
```

Replace with:

```markdown
## Cloud integration

Desktop app cloud modules live in `src/backend/cloud/`. All cloud calls happen
through these modules — React UI talks only to the local Express backend.

- `cloud/config.js`         reads KINTENSHAUTO_SUPABASE_URL + ANON_KEY from env or .env
- `cloud/supabaseClient.js` singleton + per-user clients
- `cloud/sessionStore.js`   encrypted .session file (AES-256-CBC, same key as FB pw)
- `cloud/authService.js`    login / logout / refresh
- `cloud/audit.js`          local queue + cloud flush
- `cloud/deviceGuard.js`    1-device claim + heartbeat + Realtime kick
- `cloud/syncEngine.js`     LWW push/pull for 8 synced tables
- `cloud/syncHooks.js`      debounced push triggered from local writes
- `cloud/updateChecker.js`  check-version edge function client

## Cloud project (separate repo)

`../kintenshauto-cloud/` — Supabase migrations + edge functions.
Created in Plan 1 Phase C (still BLOCKED on Supabase CLI install + Docker
Desktop + user creating a Supabase project at supabase.com).

To run desktop app against real cloud:
1. Set up Supabase project (Plan 1 Phase C)
2. Copy KINTENSHAUTO_SUPABASE_URL and KINTENSHAUTO_SUPABASE_ANON_KEY into
   `.env` at project root (gitignored)
3. Restart the app — login screen will now talk to real Supabase
```

- [ ] **Step 3: Run all tests one final time**

```bash
npm test
npm run test:coverage
```

Verify all tests pass. The cloud/ modules should have ≥70% coverage now (per spec).

- [ ] **Step 4: Tag the milestone**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: update CHANGELOG + CLAUDE.md for Plan 2 completion"
git tag plan2-complete
```

- [ ] **Step 5: Manual smoke test (requires Plan 1 Phase C deployed)**

If Supabase project is set up:
1. Add KINTENSHAUTO_SUPABASE_URL + KINTENSHAUTO_SUPABASE_ANON_KEY to `.env`
2. `npm start`
3. See login screen
4. Create test user via Supabase Studio (admin panel comes in Plan 3)
5. Login → should reach Dashboard
6. Open on second machine with same credentials → first machine should get kicked
7. Edit a banner preset → check Supabase Studio that cloud_banner_presets row appears
8. Publish a new app_versions row with min_required=true → next launch should show force update

---

## Done. What Plan 2 produced

After all 17 tasks:
- Login required to use the app (Supabase email/password)
- One-device-per-user enforcement (auto-takeover with kick signal)
- Soft + force update prompts working
- 8 settings tables sync bidirectionally with LWW conflict resolution
- AI keys sync encrypted (same per-install AES key, synced via user_secrets)
- Banner image files stay local (per spec — only metadata syncs)
- Audit log of login, sync, version events
- ~30+ new tests, all MSW-mocked (no real Supabase required to run test suite)
- All FB automation (poster/orchestrator/worker) untouched
- React UI shows Login → Setup → Dashboard flow
- Heartbeat keeps `user_devices.last_seen_at` fresh for admin panel

**Next:** Plan 3 — Admin Panel (Next.js + Supabase service_role for user management)
