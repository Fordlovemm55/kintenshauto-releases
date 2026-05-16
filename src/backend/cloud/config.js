// Cloud configuration — reads Supabase URL + anon key from env or .env file.
// Returns { supabaseUrl, supabaseAnonKey, isConfigured } so callers can decide
// whether to attempt cloud operations. When values are missing the app stays in
// local-only/dev mode and never reaches out to Supabase.

const fs = require('fs');
const path = require('path');

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

  const supabaseUrl = process.env.KINTENSHAUTO_SUPABASE_URL || null;
  const supabaseAnonKey = process.env.KINTENSHAUTO_SUPABASE_ANON_KEY || null;

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
