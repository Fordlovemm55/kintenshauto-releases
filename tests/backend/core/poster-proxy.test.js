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
