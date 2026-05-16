// Encrypted local storage for the Supabase session.
// Re-uses the AES-256-CBC scheme from services/captionService (per-install key).
// Path: <userData>/.session (file mode 0o600).

const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('../services/captionService');

function sessionPath() {
  const userData = process.env.KINTENSHAUTO_USER_DATA || path.join(__dirname, '..', '..', '..');
  return path.join(userData, '.session');
}

function loadSession() {
  const p = sessionPath();
  if (!fs.existsSync(p)) return null;
  try {
    const blob = fs.readFileSync(p, 'utf-8').trim();
    if (!blob) return null;
    const json = decrypt(blob);
    return JSON.parse(json);
  } catch (e) {
    console.warn('[sessionStore] failed to load:', e.message);
    return null;
  }
}

function saveSession(session) {
  if (!session || typeof session !== 'object') {
    throw new Error('saveSession: invalid session');
  }
  const json = JSON.stringify(session);
  const encrypted = encrypt(json);
  fs.writeFileSync(sessionPath(), encrypted, { mode: 0o600 });
}

function clearSession() {
  const p = sessionPath();
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch {}
  }
}

module.exports = { loadSession, saveSession, clearSession };
