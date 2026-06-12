# Per-Account Thai Proxy Pool — Design

> Date: 2026-06-13 · Status: Draft for review · Owner: KINTENSHAUTO
> Supersedes the earlier `2026-06-13-location-privacy-protection-design.md` (the
> operator already runs an always-on system VPN for personal privacy, so the bundled
> WARP / location-hiding work is no longer needed).

## 1. Problem & goal

The operator keeps a **system-wide VPN on at all times** (their own privacy). The VPN's
exit IP is **not Thai**, so Facebook accounts posted from it get banned ("เฟสบิน").

**Goal:** give each Facebook account (a *profile* in this app — one Chrome instance / one
login) its **own Thai proxy**, so Facebook sees a distinct **Thai** IP per account and
does not ban them for the foreign VPN IP.

**Headline feature requested:** a **bulk proxy box** — paste many Thai proxies (one per
line), and the app **distributes them 1 proxy : 1 account** across all accounts. If there
are **fewer proxies than accounts, just report how many are short** (and which accounts
are still uncovered). No proxy is reused across accounts.

### Why this works even with the always-on VPN
Chrome's `--proxy-server` sets the exit Facebook sees. With the system VPN up, the
connection *to* the Thai proxy travels through the VPN tunnel, but the egress Facebook
observes is the **Thai proxy's** IP — exactly what we want. The only leak risk is
**WebRTC**, which can expose the VPN/real IP past the proxy; we block it.

## 2. Scope

**In scope:**
- A bulk-paste proxy box that parses many proxies in common formats.
- Auto-distribution: 1 proxy → 1 account, across a chosen account set, deterministic order.
- **Shortage report:** assign what's possible; report exactly how many proxies are short
  and list the accounts still without one. **Never reuse a proxy** to cover the gap.
- **Surplus handling:** leftover proxies are kept in an "unused pool" for future accounts
  (and the count is reported).
- **Optional proxy health + geo test:** check each proxy is alive and its IP geolocates to
  **Thailand**; flag dead / non-Thai proxies so they aren't assigned.
- Per-account proxy storage (existing encrypted fields) + the single-proxy field in the
  Add/Edit-account modal stays for manual entry.
- **Supporting anti-leak so the Thai proxy is convincing:** WebRTC block (Chrome flags +
  JS guard), Thai `timezone`/`locale`/`Accept-Language` override, and a per-account
  **leak-test** that confirms Facebook will see a **Thai** IP — not the VPN IP.

**Non-goals:**
- The app does **not** supply proxies — the operator pastes their own. No bundled WARP.
- No location-hiding/VPN feature (the operator's own VPN handles personal privacy).
- Not "100% unbannable" — content, posting cadence and behavior still matter; this only
  fixes the IP-origin signal.

## 3. Architecture

```
  paste box (multiline) ─► proxyPool.parse() ─► [{scheme,host,port,user,pass}]
                                   │
                      (optional) proxyPool.test() ─► {alive, ip, country=TH?, latency}
                                   │  drop dead / non-TH
                                   ▼
            proxyPool.distribute(proxies, accounts, policy)
                                   │
            ┌──────────────────────┼───────────────────────────┐
            ▼                      ▼                            ▼
   assign 1:1 (deterministic)   shortBy = max(0, A-P)     leftover pool
   → write profiles.proxy_*     + uncovered accounts      (unused, kept)
            │
            ▼
   poster.js builds --proxy-server=scheme://user:pass@host:port
   + WebRTC block flags + Thai cloak  ─►  Facebook sees the Thai proxy IP
            │
            ▼
   leak-test (per account): browserIp == proxy.ip (TH) and != VPN/real IP, no WebRTC leak
```

Two clean units:
- **`proxyPool`** — pure logic + network tests; owns parsing, distribution math, testing.
  No browser/automation dependency. Fully unit-testable.
- **Posting path** — consumes each profile's stored proxy; unchanged contract
  (`poster.js` already supports `--proxy-server`).

## 4. `services/proxyPool.js` (new)

- **`parse(text) → { proxies: [...], invalid: [...] }`** — split by line, trim, dedupe,
  accept these formats (auto-detected per line):
  - `host:port`
  - `host:port:user:pass`
  - `user:pass@host:port`
  - `scheme://user:pass@host:port` (scheme ∈ http|https|socks5)
  Default scheme when omitted: `http` (most Thai residential/mobile proxies). Invalid
  lines are returned separately (not silently dropped) so the user sees what failed.
- **`test(proxy, {timeoutMs}) → { alive, ip, country, city, latencyMs, error }`** — make a
  request through the proxy to an IP-geo endpoint (e.g. `http://ip-api.com/json`), report
  the exit IP + country. Run concurrently with a small cap (e.g. 8) and emit progress.
- **`distribute(proxies, accounts, policy) → { assignments, shortBy, uncovered, leftover }`**
  — deterministic order (accounts sorted by id), 1:1, no reuse:
  - `assignments`: `[{ accountId, proxy }]`
  - `shortBy`: `max(0, accounts.length - proxies.length)`
  - `uncovered`: account ids that got no proxy (when short)
  - `leftover`: proxies beyond the account count (kept in the unused pool)

## 5. Distribution policy (please confirm — §11)

- **Target account set (default):** all enabled accounts. Options: *only accounts without a
  proxy yet*, or *selected accounts*. (Proposed default: **only accounts without a proxy**,
  so re-pasting tops up new accounts without disturbing existing assignments.)
- **Replace existing?** Off by default (top-up). A "reassign all" checkbox overwrites.
- **Bad proxies:** if the health test is enabled, dead / non-Thai proxies are excluded from
  distribution and listed, so they don't silently cover an account with a broken IP.

## 6. Data model

- Reuse `profiles` proxy columns; ensure these exist (additive ALTER per project rule):
  `proxy_scheme TEXT`, `proxy_host TEXT`, `proxy_port INTEGER`, `proxy_user TEXT`,
  `proxy_pass TEXT` (AES-encrypted via the existing `captionService` encrypt, same as
  `fb_password`), `proxy_last_ip TEXT`, `proxy_last_country TEXT`, `proxy_checked_at`.
- New table `proxy_pool` for leftover/unused proxies (so a later "add account" can auto-
  draw one): `id, scheme, host, port, user, pass(enc), last_ip, last_country, status
  (unused|assigned|dead), tested_at`. (Local only; no cloud sync needed.)

## 7. Posting path changes

- `core/poster.js` / `core/browserManager.js`: build the `--proxy-server` arg from the
  profile's `proxy_scheme/host/port` (already partly supported), and pass proxy auth via
  the CDP `Fetch.authRequired` / `page.authenticate({username,password})` flow when the
  proxy needs user:pass.
- Add WebRTC-leak block flags (so the VPN/real IP can't leak past the Thai proxy):
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` plus an
  `evaluateOnNewDocument` `RTCPeerConnection` guard.
- Apply the Thai cloak (timezone `Asia/Bangkok`, `Accept-Language: th-TH`) so a Thai proxy
  isn't betrayed by a non-Thai timezone/locale.

## 8. Leak-test / verification (`/api/proxies/leak-test/:profileId`)

So the operator can *see* it works before trusting it with accounts:
1. Backend reads the **real/VPN** public IP directly (baseline).
2. Open a page with that profile's proxy + cloak; read the IP it sees + WebRTC probe.
3. Return `{ vpnIp, browserIp, browserCountry, isThai, hidesVpn: browserIp!==vpnIp,
   webrtcLeak }`.
4. UI: 🟢 "FB จะเห็น IP ไทย (เมือง X) ✅ ไม่ใช่ IP VPN" / 🔴 with the reason.

## 9. UI (`public/assets/profiles-injection.js`)

A "พร็อกซี่ไทย (Bulk)" panel in the Profiles Manager:
- A large **paste box** (multiline) + format hint.
- Buttons: **ทดสอบพร็อกซี่** (optional health/geo test, shows alive/Thai per line) and
  **กระจายใส่เฟส** (distribute).
- A result summary after distribute, e.g.:
  > ใส่ครบ **8/10 เฟส** · **ขาดอีก 2 พร็อกซี่** · พร็อกซี่เสีย/ไม่ใช่ไทย **1** · เหลือไม่ได้ใช้ **0**
  > เฟสที่ยังไม่มีพร็อกซี่: บัญชีหลัก 3, บัญชีหลัก 7
- Per-account rows show the assigned proxy (masked) + a **ตรวจ (leak-test)** button.
- The single-proxy field stays in the Add/Edit-account modal for one-off manual entry.

## 10. Components touched

| Unit | Change |
|---|---|
| `services/proxyPool.js` (new) | parse / test / distribute |
| `server.js` | `/api/proxies/parse-preview`, `/test`, `/distribute`, `/pool`, `/leak-test/:id` |
| `core/poster.js`, `core/browserManager.js` | build `--proxy-server` + `page.authenticate`; WebRTC flags; Thai cloak |
| `schema.sql` + `local/db.js` | additive proxy columns + `proxy_pool` table + settings seeds |
| `public/assets/profiles-injection.js` | bulk paste panel, distribute result, per-account leak-test |
| (encryption) | reuse `captionService` AES for `proxy_pass` |

## 11. Decisions (locked 2026-06-13)

1. **Default target set:** **only accounts without a proxy** (top-up). Re-pasting tops up
   newly added accounts without disturbing existing assignments. A "reassign all" checkbox
   exists for explicit overwrite.
2. **Auto health/geo test:** **included in the distribute flow** — every pasted proxy is
   tested (alive + IP geolocates to Thailand) before assignment; dead / non-Thai proxies
   are excluded and listed, never silently assigned. A cached result avoids re-testing the
   same proxy within a session.
3. **Default proxy scheme** when a pasted line omits it: **`http`**.

## 12. Testing

- `proxyPool.parse`: all four formats, invalid lines surfaced, dedupe.
- `proxyPool.distribute`: exact / short (shortBy + uncovered correct) / surplus (leftover)
  cases; deterministic order; no reuse.
- `proxy_pass` encryption round-trip.
- leak-test logic with MSW-mocked IP-geo for hidden vs exposed.
- Coverage ≥70% on `proxyPool`.

## 13. Honest caveats (shown in UI)

- Double hop (Chrome → VPN → Thai proxy → FB) adds latency; uploads go through both, so a
  bit slower than a direct connection. This is inherent to "VPN on + Thai proxy".
- Proxy quality matters: cheap/blacklisted Thai proxies can still get accounts flagged. The
  health test reduces but does not eliminate this.
- 1 proxy : 1 account is enforced; sharing a proxy across accounts re-introduces IP linking.
