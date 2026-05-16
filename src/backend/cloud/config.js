// Cloud configuration — reads Supabase URL + anon key from env or .env file,
// falling back to embedded defaults so packaged installers work without an
// adjacent .env file. Returns { supabaseUrl, supabaseAnonKey, isConfigured }
// so callers can decide whether to attempt cloud operations.

const fs = require('fs');
const path = require('path');

// Embedded production defaults. The anon (publishable) key is safe to ship in
// the client bundle — RLS policies enforce access. Override via env or .env
// for dev/staging. service_role MUST NEVER be embedded here — it bypasses RLS.
const DEFAULT_SUPABASE_URL = 'https://etutmagymtlfagcsvavk.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_zlRdIib67v6B8cml000r2g_t8Ne-K_0';

let _envLoaded = false;

/**
 * Load .env file from the project root into process.env (without overriding
 * already-set vars). Safe to call repeatedly — only reads the file once per
 * process. Skipped under Vitest so unit tests can fully control the env.
 */
function loadEnvFile() {
  if (_envLoaded) return;
  _envLoaded = true;

  // Skip .env loading in tests — tests set env vars explicitly and a real
  // .env on disk would otherwise pollute "missing var" assertions.
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') return;

  // Try cwd first (normal Electron/node start), then walk up from this file
  // to reach the repo root when the module is loaded from a deeper cwd.
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '..', '..', '.env')
  ];

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) process.env[key] = val;
      }
      return;
    } catch (e) {
      console.warn('[cloud/config] failed to read', envPath, ':', e.message);
    }
  }
}

/**
 * Read Supabase configuration from process.env (after loading .env once).
 *
 * @returns {{ supabaseUrl: string|null, supabaseAnonKey: string|null, isConfigured: boolean }}
 * @throws {Error} when KINTENSHAUTO_SUPABASE_URL is set but not a valid URL.
 */
function getCloudConfig() {
  loadEnvFile();

  // In test mode, never fall back to embedded defaults — tests assert on
  // "missing" behavior. Production always resolves to a configured client.
  const inTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
  const supabaseUrl = process.env.KINTENSHAUTO_SUPABASE_URL
    || (inTest ? null : DEFAULT_SUPABASE_URL);
  const supabaseAnonKey = process.env.KINTENSHAUTO_SUPABASE_ANON_KEY
    || (inTest ? null : DEFAULT_SUPABASE_ANON_KEY);

  if (supabaseUrl) {
    try {
      new URL(supabaseUrl);
    } catch {
      throw new Error(`Invalid KINTENSHAUTO_SUPABASE_URL: ${supabaseUrl}`);
    }
  }

  return {
    supabaseUrl,
    supabaseAnonKey,
    isConfigured: !!(supabaseUrl && supabaseAnonKey)
  };
}

// Test-only helper for re-priming the .env-loading cache between cases.
function _resetEnvCache() {
  _envLoaded = false;
}

module.exports = { getCloudConfig, _resetEnvCache };
