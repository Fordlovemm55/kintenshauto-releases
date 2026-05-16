import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('cloud/config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.KINTENSHAUTO_SUPABASE_URL;
    delete process.env.KINTENSHAUTO_SUPABASE_ANON_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns null url/key when env vars are missing (dev mode)', async () => {
    const { getCloudConfig } = await import('../../../src/backend/cloud/config.js?n=' + Date.now());
    const cfg = getCloudConfig();
    expect(cfg.supabaseUrl).toBeNull();
    expect(cfg.supabaseAnonKey).toBeNull();
    expect(cfg.isConfigured).toBe(false);
  });

  it('reads from process.env when set', async () => {
    process.env.KINTENSHAUTO_SUPABASE_URL = 'https://example.supabase.co';
    process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'eyJabc';
    const { getCloudConfig } = await import('../../../src/backend/cloud/config.js?n=' + Date.now());
    const cfg = getCloudConfig();
    expect(cfg.supabaseUrl).toBe('https://example.supabase.co');
    expect(cfg.supabaseAnonKey).toBe('eyJabc');
    expect(cfg.isConfigured).toBe(true);
  });

  it('rejects malformed URLs', async () => {
    process.env.KINTENSHAUTO_SUPABASE_URL = 'not-a-url';
    process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'key';
    const { getCloudConfig } = await import('../../../src/backend/cloud/config.js?n=' + Date.now());
    expect(() => getCloudConfig()).toThrow(/invalid.*url/i);
  });
});
