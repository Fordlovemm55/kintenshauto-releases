// Supabase client singleton.
// - getAnonClient(): cached, anon-key auth (unauthenticated REST + Auth API)
// - getUserClient(token): per-token, includes Authorization header (authenticated)
//
// Both return null if cloud isn't configured (env vars missing).

const { createClient } = require('@supabase/supabase-js');
const { getCloudConfig } = require('./config');

let _anonClient = null;

function getAnonClient() {
  if (_anonClient) return _anonClient;
  const cfg = getCloudConfig();
  if (!cfg.isConfigured) return null;
  _anonClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
  return _anonClient;
}

function getUserClient(accessToken) {
  if (!accessToken) return null;
  const cfg = getCloudConfig();
  if (!cfg.isConfigured) return null;
  return createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

// For test cleanup only
function _resetForTests() { _anonClient = null; }

module.exports = { getAnonClient, getUserClient, _resetForTests };
