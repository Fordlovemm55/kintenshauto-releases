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
