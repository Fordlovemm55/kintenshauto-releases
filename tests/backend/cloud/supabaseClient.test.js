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
    const first = getAnonClient();
    const second = getAnonClient();
    expect(first).toBe(second);
  });

  it('getUserClient with a token returns a non-null client', async () => {
    const { getUserClient } = await import('../../../src/backend/cloud/supabaseClient.js?n=' + Date.now());
    const client = getUserClient('user-jwt-abc');
    expect(client).not.toBeNull();
    expect(typeof client.from).toBe('function');
  });

  it('getUserClient(null) returns null', async () => {
    const { getUserClient } = await import('../../../src/backend/cloud/supabaseClient.js?n=' + Date.now());
    expect(getUserClient(null)).toBeNull();
    expect(getUserClient('')).toBeNull();
  });

  it('getUserClient returns a different instance from getAnonClient', async () => {
    const mod = await import('../../../src/backend/cloud/supabaseClient.js?n=' + Date.now());
    expect(mod.getUserClient('token')).not.toBe(mod.getAnonClient());
  });
});
