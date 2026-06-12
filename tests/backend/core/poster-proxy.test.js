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

// These tests verify that proxyArgFor is the gate used to decide whether
// Thai-locale cloaking (emulateTimezone / Accept-Language) and WebRTC IP
// leak prevention flags are applied.  Both features must only activate for
// profiles that have a proxy; proxy-less profiles must not be affected.
describe('proxy presence gate (cloaking + WebRTC flags)', () => {
  it('proxyArgFor is falsy for a proxy-less profile — gate stays closed', () => {
    // Profiles stored with no proxy columns (NULL in DB) must not trigger
    // the Thai-locale or WebRTC cloaking blocks.
    expect(proxyArgFor({ id: 1 })).toBeNull();
    expect(proxyArgFor({ id: 1, proxy_host: null, proxy_port: null })).toBeNull();
    expect(proxyArgFor({ id: 1, proxy_host: '', proxy_port: 8080 })).toBeNull();
  });

  it('proxyArgFor is truthy for a proxy profile — gate opens', () => {
    // When a profile has both host and port the gate must open so that
    // Thai-locale headers and WebRTC flags are applied.
    expect(proxyArgFor({ proxy_host: '10.0.0.1', proxy_port: 3128 })).toBeTruthy();
    expect(proxyArgFor({ proxy_type: 'socks5', proxy_host: '10.0.0.1', proxy_port: 1080 })).toBeTruthy();
  });

  it('missing port keeps gate closed even when host is set', () => {
    // An incomplete proxy config (host without port) is treated as no proxy
    // to avoid a broken proxy-server flag.
    expect(proxyArgFor({ proxy_host: '10.0.0.1' })).toBeNull();
    expect(proxyArgFor({ proxy_host: '10.0.0.1', proxy_port: null })).toBeNull();
  });
});
