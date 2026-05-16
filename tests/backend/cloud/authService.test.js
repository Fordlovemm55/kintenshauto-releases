import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import path from 'path';
import os from 'os';
import fs from 'fs';

let server, tmpDir;

const SUPA_URL = 'https://test.supabase.co';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kts-auth-'));
  process.env.KINTENSHAUTO_USER_DATA = tmpDir;
  process.env.KINTENSHAUTO_SUPABASE_URL = SUPA_URL;
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';
});

afterEach(() => {
  if (server) server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env.KINTENSHAUTO_SUPABASE_URL;
  delete process.env.KINTENSHAUTO_SUPABASE_ANON_KEY;
});

describe('authService.login', () => {
  it('returns ok=true and stores session on valid credentials', async () => {
    server = setupServer(
      http.post(`${SUPA_URL}/auth/v1/token`, async ({ request }) => {
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

    const { login, getStoredSession } = await import('../../../src/backend/cloud/authService.js?n=' + Date.now());
    const result = await login('good@example.com', 'right');
    expect(result.ok).toBe(true);
    expect(result.user.email).toBe('good@example.com');
    const stored = getStoredSession();
    expect(stored.access_token).toBe('access-abc');
  });

  it('returns ok=false with reason on bad credentials', async () => {
    server = setupServer(
      http.post(`${SUPA_URL}/auth/v1/token`, () =>
        HttpResponse.json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, { status: 400 })
      )
    );
    server.listen({ onUnhandledRequest: 'error' });

    const { login } = await import('../../../src/backend/cloud/authService.js?n=' + Date.now());
    const result = await login('bad@example.com', 'wrong');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_credentials');
  });

  it('returns ok=false reason=network_error when unreachable', async () => {
    server = setupServer(
      http.post(`${SUPA_URL}/auth/v1/token`, () => HttpResponse.error())
    );
    server.listen({ onUnhandledRequest: 'error' });

    const { login } = await import('../../../src/backend/cloud/authService.js?n=' + Date.now());
    const result = await login('good@example.com', 'right');
    expect(result.ok).toBe(false);
    expect(['network_error', 'auth_error', 'exception']).toContain(result.reason);
  });
});

describe('authService.logout', () => {
  it('clears the stored session', async () => {
    server = setupServer(
      http.post(`${SUPA_URL}/auth/v1/token`, () =>
        HttpResponse.json({
          access_token: 'a', refresh_token: 'r', expires_in: 3600,
          expires_at: Math.floor(Date.now()/1000)+3600,
          user: { id: 'u', email: 'e@e.com' }
        })),
      // logout endpoint
      http.post(`${SUPA_URL}/auth/v1/logout`, () => HttpResponse.json({}, { status: 204 }))
    );
    server.listen({ onUnhandledRequest: 'bypass' });

    const { login, logout, getStoredSession } = await import('../../../src/backend/cloud/authService.js?n=' + Date.now());
    await login('e@e.com', 'pw');
    expect(getStoredSession()).not.toBeNull();
    await logout();
    expect(getStoredSession()).toBeNull();
  });
});

describe('authService.refresh', () => {
  it('returns ok=false reason=no_session when no stored session', async () => {
    const { refresh } = await import('../../../src/backend/cloud/authService.js?n=' + Date.now());
    const result = await refresh();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_session');
  });
});

describe('authService when not configured', () => {
  it('login returns reason=not_configured when env vars missing', async () => {
    delete process.env.KINTENSHAUTO_SUPABASE_URL;
    const { login } = await import('../../../src/backend/cloud/authService.js?n=' + Date.now());
    const result = await login('a@b.com', 'pw');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_configured');
  });
});
