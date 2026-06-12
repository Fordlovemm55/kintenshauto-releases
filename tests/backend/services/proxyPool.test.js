// tests/backend/services/proxyPool.test.js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { parse } = require('../../../src/backend/services/proxyPool');
const { distribute } = require('../../../src/backend/services/proxyPool');

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
