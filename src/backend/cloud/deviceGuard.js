// Device identity + claim + heartbeat + Realtime kick subscriber.
//
//   getDeviceId():          deterministic SHA-256 hex of MAC+hostname+platform
//   getDeviceLabel():       human-readable label for device_label column
//   claimDevice(jwt, label): POST device-claim edge function; returns
//                            { ok, is_takeover, session_token, status }
//   startHeartbeat(...):    periodic UPDATE user_devices.last_seen_at every 5min
//   stopHeartbeat():        clearInterval
//   subscribeKick(uid, jwt, onKick): Realtime channel; fires onKick when another
//                            device claims; returns true if subscribed
//   unsubscribeKick():      tear down channel

const crypto = require('crypto');
const os = require('os');
const { getCloudConfig } = require('./config');

let _cachedDeviceId = null;
let _heartbeatTimer = null;
let _kickChannel = null;

function getDeviceId() {
  if (_cachedDeviceId) return _cachedDeviceId;
  const ifaces = os.networkInterfaces();
  const macs = [];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.mac && iface.mac !== '00:00:00:00:00:00') {
        macs.push(iface.mac);
      }
    }
  }
  const fingerprint = [
    macs.sort().join('|'),
    os.hostname(),
    os.platform(),
    os.arch()
  ].join('::');
  _cachedDeviceId = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 32);
  return _cachedDeviceId;
}

function getDeviceLabel() {
  return `${os.hostname()} (${os.platform()} ${os.arch()})`;
}

async function claimDevice(accessToken, label) {
  const cfg = getCloudConfig();
  if (!cfg.isConfigured) return { ok: false, reason: 'not_configured' };
  if (!accessToken) return { ok: false, reason: 'no_token' };

  const url = `${cfg.supabaseUrl}/functions/v1/device-claim`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        device_id: getDeviceId(),
        device_label: label || getDeviceLabel()
      })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, reason: `http_${res.status}`, message: text };
    }
    const data = await res.json();
    return {
      ok: true,
      status: data.status,
      is_takeover: data.is_takeover,
      session_token: data.session_token
    };
  } catch (err) {
    return { ok: false, reason: 'network_error', message: err.message };
  }
}

function startHeartbeat(getAccessToken, intervalMs = 5 * 60 * 1000, onFailure) {
  stopHeartbeat();
  let failCount = 0;
  _heartbeatTimer = setInterval(async () => {
    const token = getAccessToken();
    if (!token) return;
    const cfg = getCloudConfig();
    if (!cfg.isConfigured) return;
    try {
      const res = await fetch(`${cfg.supabaseUrl}/rest/v1/user_devices`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'apikey': cfg.supabaseAnonKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ last_seen_at: new Date().toISOString() })
      });
      if (res.ok) failCount = 0;
      else failCount++;
    } catch { failCount++; }
    if (failCount >= 3 && onFailure) onFailure('heartbeat_fail_3x');
  }, intervalMs);
  // Don't keep the event loop alive just for heartbeat (Node-only).
  if (_heartbeatTimer && typeof _heartbeatTimer.unref === 'function') {
    _heartbeatTimer.unref();
  }
}

function stopHeartbeat() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

function subscribeKick(userId, accessToken, mySessionToken, onKick) {
  unsubscribeKick();
  if (!userId || !accessToken) return false;
  const { getUserClient } = require('./supabaseClient');
  const client = getUserClient(accessToken);
  if (!client) return false;

  // Listen to user_devices changes via Postgres CDC instead of broadcast — the
  // execute_claim RPC mutates the row, so any takeover or admin force-logout
  // shows up as UPDATE/DELETE here. Kicks fire when:
  //   UPDATE → session_token differs from this device's token (another claim)
  //   DELETE → admin force-logged this device out (or banned the user)
  const fire = (reason) => {
    try { onKick && onKick(reason); }
    catch (e) { console.error('[deviceGuard] onKick threw:', e.message); }
  };
  _kickChannel = client.channel(`user-devices-${userId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'user_devices',
      filter: `user_id=eq.${userId}`
    }, (payload) => {
      if (payload.eventType === 'DELETE') return fire('admin_force_logout');
      const newToken = payload.new?.session_token;
      if (mySessionToken && newToken && newToken !== mySessionToken) {
        fire('another_device_signed_in');
      }
    })
    .subscribe();
  return true;
}

function unsubscribeKick() {
  if (_kickChannel) {
    try { _kickChannel.unsubscribe(); } catch {}
    _kickChannel = null;
  }
}

function _resetForTests() {
  _cachedDeviceId = null;
  stopHeartbeat();
  unsubscribeKick();
}

module.exports = {
  getDeviceId, getDeviceLabel, claimDevice,
  startHeartbeat, stopHeartbeat,
  subscribeKick, unsubscribeKick,
  _resetForTests
};
