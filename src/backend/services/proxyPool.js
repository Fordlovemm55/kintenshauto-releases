// src/backend/services/proxyPool.js
'use strict';

const VALID_SCHEMES = ['http', 'https', 'socks5', 'socks5h'];

function _validPort(n) {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function _parseLine(raw) {
  let scheme = 'http';
  let rest = raw;

  const schemeMatch = rest.match(/^([a-zA-Z0-9]+):\/\/(.*)$/);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    rest = schemeMatch[2];
    if (!VALID_SCHEMES.includes(scheme)) {
      return { error: `unsupported scheme "${scheme}"` };
    }
  }

  let user = null, pass = null, hostPort = rest;
  if (rest.includes('@')) {
    const at = rest.lastIndexOf('@');
    const creds = rest.slice(0, at);
    hostPort = rest.slice(at + 1);
    const ci = creds.indexOf(':');
    if (ci < 0) return { error: 'credentials must be user:pass' };
    user = creds.slice(0, ci);
    pass = creds.slice(ci + 1);
  }

  const parts = hostPort.split(':');
  // host:port  OR  host:port:user:pass
  if (parts.length !== 2 && parts.length !== 4) {
    return { error: 'expected host:port[:user:pass]' };
  }
  const host = parts[0];
  const port = Number(parts[1]);
  if (!host) return { error: 'missing host' };
  if (!_validPort(port)) return { error: `bad port "${parts[1]}"` };
  if (parts.length === 4) {
    if (user !== null) return { error: 'credentials given twice' };
    user = parts[2];
    pass = parts[3];
  }
  return { scheme, host, port, user: user || null, pass: pass || null };
}

function parse(text) {
  const proxies = [];
  const invalid = [];
  const seen = new Set();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const raw = rawLine.trim();
    if (!raw || raw.startsWith('#')) continue;
    const r = _parseLine(raw);
    if (r.error) { invalid.push({ raw, reason: r.error }); continue; }
    const key = `${r.scheme}://${r.user || ''}:${r.pass || ''}@${r.host}:${r.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    proxies.push({ raw, scheme: r.scheme, host: r.host, port: r.port, user: r.user, pass: r.pass });
  }
  return { proxies, invalid };
}

function distribute(proxies, accounts, { onlyMissing = true } = {}) {
  const targets = (onlyMissing ? accounts.filter(a => !a.hasProxy) : accounts.slice())
    .sort((x, y) => x.id - y.id);
  const assignments = [];
  const n = Math.min(targets.length, proxies.length);
  for (let i = 0; i < n; i++) {
    assignments.push({ accountId: targets[i].id, proxy: proxies[i] });
  }
  const uncovered = targets.slice(n).map(a => a.id);
  const leftover = proxies.slice(n);
  return { assignments, shortBy: uncovered.length, uncovered, leftover };
}

const http = require('http');

function _makeAgent(proxy) {
  const cred = proxy.user ? `${encodeURIComponent(proxy.user)}:${encodeURIComponent(proxy.pass || '')}@` : '';
  const url = `${proxy.scheme}://${cred}${proxy.host}:${proxy.port}`;
  if (proxy.scheme.startsWith('socks')) {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    return new SocksProxyAgent(url);
  }
  const { HttpsProxyAgent } = require('https-proxy-agent');
  return new HttpsProxyAgent(url);
}

// Default fetcher: GET a free geo endpoint THROUGH the proxy.
function _defaultHttpGet(proxy, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: _makeAgent(proxy), timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad geo response')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function testProxy(proxy, { httpGet = _defaultHttpGet, timeoutMs = 8000, now = () => Date.now() } = {}) {
  const start = now();
  const GEO = 'http://ip-api.com/json/?fields=status,country,countryCode,query';
  try {
    const j = await httpGet(proxy, GEO, timeoutMs);
    if (!j || j.status !== 'success') return { alive: false, error: 'geo lookup failed', latencyMs: now() - start };
    return {
      alive: true, ip: j.query, country: j.countryCode, countryName: j.country,
      isThai: j.countryCode === 'TH', latencyMs: now() - start,
    };
  } catch (e) {
    return { alive: false, error: e.message, latencyMs: now() - start };
  }
}

module.exports = { parse, distribute, testProxy };
