// Authentication service — wraps Supabase auth + local session storage.
//
//   login(email, password) → Supabase signInWithPassword → store session
//   logout()               → clear local session + best-effort Supabase signOut
//   getStoredSession()     → read encrypted local .session
//   refresh()              → exchange refresh_token for new access_token + save

const { getAnonClient } = require('./supabaseClient');
const { loadSession, saveSession, clearSession } = require('./sessionStore');

async function login(email, password) {
  const client = getAnonClient();
  if (!client) {
    return { ok: false, reason: 'not_configured', message: 'Cloud config missing' };
  }

  try {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      const lower = (error.message || '').toLowerCase();
      const reason = lower.includes('invalid') || lower.includes('invalid_grant')
        ? 'invalid_credentials'
        : 'auth_error';
      return { ok: false, reason, message: error.message };
    }
    if (!data?.session) {
      return { ok: false, reason: 'no_session', message: 'Supabase returned no session' };
    }
    saveSession(data.session);
    return { ok: true, user: data.user, session: data.session };
  } catch (err) {
    const lower = (err.message || '').toLowerCase();
    const isNetwork = err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED'
      || lower.includes('fetch failed') || lower.includes('network')
      || lower.includes('failed to fetch');
    return {
      ok: false,
      reason: isNetwork ? 'network_error' : 'exception',
      message: err.message
    };
  }
}

async function logout() {
  const session = loadSession();
  if (session?.access_token) {
    try {
      const client = getAnonClient();
      if (client) await client.auth.signOut();
    } catch { /* best-effort — local clear always wins */ }
  }
  clearSession();
}

function getStoredSession() {
  return loadSession();
}

async function refresh() {
  const session = loadSession();
  if (!session?.refresh_token) {
    return { ok: false, reason: 'no_session' };
  }
  const client = getAnonClient();
  if (!client) {
    return { ok: false, reason: 'not_configured' };
  }

  try {
    const { data, error } = await client.auth.refreshSession({ refresh_token: session.refresh_token });
    if (error) {
      return { ok: false, reason: 'refresh_failed', message: error.message };
    }
    if (!data?.session) {
      return { ok: false, reason: 'no_session_returned' };
    }
    saveSession(data.session);
    return { ok: true, session: data.session };
  } catch (err) {
    return { ok: false, reason: 'exception', message: err.message };
  }
}

module.exports = { login, logout, getStoredSession, refresh };
