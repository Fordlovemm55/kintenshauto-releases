import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

let server;
const SUPA_URL = 'https://test.supabase.co';

beforeEach(() => {
  process.env.KINTENSHAUTO_SUPABASE_URL = SUPA_URL;
  process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';
});

afterEach(() => {
  if (server) server.close();
  delete process.env.KINTENSHAUTO_SUPABASE_URL;
  delete process.env.KINTENSHAUTO_SUPABASE_ANON_KEY;
});

describe('deviceGuard.getDeviceId', () => {
  it('returns the same ID across calls (deterministic)', async () => {
    const { getDeviceId, _resetForTests } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    _resetForTests();
    const id1 = getDeviceId();
    const id2 = getDeviceId();
    expect(id1).toBe(id2);
    expect(id1.length).toBeGreaterThanOrEqual(8);
  });

  it('returns a hex string', async () => {
    const { getDeviceId, _resetForTests } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    _resetForTests();
    expect(getDeviceId()).toMatch(/^[a-f0-9]+$/);
  });
});

describe('deviceGuard.getDeviceLabel', () => {
  it('returns a non-empty string', async () => {
    const { getDeviceLabel } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    const label = getDeviceLabel();
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });
});

describe('deviceGuard.claimDevice', () => {
  it('returns reason=not_configured when cloud missing', async () => {
    delete process.env.KINTENSHAUTO_SUPABASE_URL;
    const { claimDevice } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    const r = await claimDevice('jwt-test', 'My PC');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_configured');
  });

  it('returns reason=no_token when no JWT', async () => {
    const { claimDevice } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    const r = await claimDevice(null, 'My PC');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_token');
  });

  it('posts device_id + label to edge function', async () => {
    let receivedBody = null;
    server = setupServer(
      http.post(`${SUPA_URL}/functions/v1/device-claim`, async ({ request }) => {
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
  });

  it('returns is_takeover=true when edge function reports takeover', async () => {
    server = setupServer(
      http.post(`${SUPA_URL}/functions/v1/device-claim`, () =>
        HttpResponse.json({ status: 'claimed', is_takeover: true, session_token: 'tok-new' })
      )
    );
    server.listen({ onUnhandledRequest: 'error' });

    const { claimDevice } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    const result = await claimDevice('jwt-test', 'My PC');
    expect(result.is_takeover).toBe(true);
  });

  it('returns reason=network_error on fetch failure', async () => {
    server = setupServer(
      http.post(`${SUPA_URL}/functions/v1/device-claim`, () => HttpResponse.error())
    );
    server.listen({ onUnhandledRequest: 'error' });

    const { claimDevice } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    const result = await claimDevice('jwt-test', 'My PC');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('network_error');
  });
});

describe('deviceGuard.subscribeKick', () => {
  it('returns false when supabase not configured', async () => {
    delete process.env.KINTENSHAUTO_SUPABASE_URL;
    const { subscribeKick } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    expect(subscribeKick('user-id', 'token', () => {})).toBe(false);
  });

  it('returns false when userId or token missing', async () => {
    const { subscribeKick } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    expect(subscribeKick('', 'token', () => {})).toBe(false);
    expect(subscribeKick('user', '', () => {})).toBe(false);
  });

  it('returns true when configured + creates a channel', async () => {
    const { subscribeKick, unsubscribeKick } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    const ok = subscribeKick('user-id', 'token-abc', () => {});
    expect(ok).toBe(true);
    unsubscribeKick();
  });
});

describe('deviceGuard.startHeartbeat', () => {
  it('can be started + stopped without errors', async () => {
    const { startHeartbeat, stopHeartbeat } = await import('../../../src/backend/cloud/deviceGuard.js?n=' + Date.now());
    startHeartbeat(() => 'tok', 60_000);
    stopHeartbeat();
    // No assertion — just smoke
    expect(true).toBe(true);
  });
});
