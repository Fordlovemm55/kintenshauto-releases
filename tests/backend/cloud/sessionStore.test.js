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

  it('saveSession throws on invalid input', async () => {
    const { saveSession } = await import('../../../src/backend/cloud/sessionStore.js?n=' + Date.now());
    expect(() => saveSession(null)).toThrow();
    expect(() => saveSession(undefined)).toThrow();
  });
});
