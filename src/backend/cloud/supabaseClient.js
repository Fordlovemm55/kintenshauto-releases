// Supabase client singleton.
// - getAnonClient(): cached, anon-key auth (unauthenticated REST + Auth API)
// - getUserClient(token): per-token, includes Authorization header (authenticated)
//
// Both return null if cloud isn't configured (env vars missing).

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { getCloudConfig } = require('./config');

// Electron 32 embeds Node 20.x, which has no global WebSocket. Supabase's
// realtime-js needs an explicit transport on Node < 22 or it throws
// "Node.js X detected without native WebSocket support" when Realtime
// channels (e.g. device-kick) try to connect.
const REALTIME_OPTIONS = { transport: ws };

let _anonClient = null;
let _anonKey = null; // cache fingerprint — invalidates when env-driven config changes

function getAnonClient() {
  const cfg = getCloudConfig();
  if (!cfg.isConfigured) return null;
  const fingerprint = `${cfg.supabaseUrl}|${cfg.supabaseAnonKey}`;
  if (_anonClient && _anonKey === fingerprint) return _anonClient;
  _anonClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    },
    realtime: REALTIME_OPTIONS
  });
  _anonKey = fingerprint;
  return _anonClient;
}

function getUserClient(accessToken) {
  if (!accessToken) return null;
  const cfg = getCloudConfig();
  if (!cfg.isConfigured) return null;
  return createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: REALTIME_OPTIONS
  });
}

// For test cleanup only
function _resetForTests() { _anonClient = null; _anonKey = null; }

module.exports = { getAnonClient, getUserClient, _resetForTests };
