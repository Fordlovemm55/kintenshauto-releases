// Plan 2 Task 13: cloud version check.
// Calls the `check-version` Supabase edge function and returns one of:
//   { ok: true,  force_update: null, soft_update: null }   — up to date
//   { ok: false, force_update: { required_version, download_url, release_notes_md }, soft_update: null }
//   { ok: true,  force_update: null, soft_update: { latest_version, release_notes_md, download_url } }
//
// Failure modes (cloud unconfigured, no token, no version, network error,
// non-2xx response) all return ok:true so the app never blocks on a transient
// outage. Callers can inspect `reason` / `error` for telemetry.

const { getCloudConfig } = require('./config');

/**
 * @param {string|null} accessToken Supabase session access_token.
 * @param {string|null} clientVersion semver string from package.json.
 * @returns {Promise<{ok: boolean, force_update: object|null, soft_update: object|null, reason?: string, error?: string}>}
 */
async function checkVersion(accessToken, clientVersion) {
    const cfg = getCloudConfig();
    if (!cfg.isConfigured) {
        return { ok: true, force_update: null, soft_update: null, reason: 'not_configured' };
    }
    if (!clientVersion) {
        return { ok: true, force_update: null, soft_update: null, reason: 'no_version' };
    }

    // Fall back to the anon/publishable key when no user session exists — the
    // edge function accepts either, so update prompts can surface before login.
    const token = accessToken || cfg.supabaseAnonKey;

    try {
        const res = await fetch(`${cfg.supabaseUrl}/functions/v1/check-version`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'apikey': cfg.supabaseAnonKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ client_version: clientVersion })
        });
        if (!res.ok) {
            // Failed check — assume OK so app keeps working.
            return { ok: true, force_update: null, soft_update: null, error: `HTTP ${res.status}` };
        }
        const data = await res.json();
        return {
            ok: data.ok !== false,
            force_update: data.force_update || null,
            soft_update: data.soft_update || null
        };
    } catch (err) {
        // Network error → assume OK (don't block app on transient outage).
        return { ok: true, force_update: null, soft_update: null, error: err.message };
    }
}

module.exports = { checkVersion };
