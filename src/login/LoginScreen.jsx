import React, { useState, useEffect } from 'react';
import SamuraiBackground from '../components/SamuraiBackground';

const API = 'http://localhost:3003';

export default function LoginScreen({ onSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [takeoverNote, setTakeoverNote] = useState(false);
  const [version, setVersion] = useState('');

  useEffect(() => {
    if (window.kintenshauto?.getVersion) {
      window.kintenshauto.getVersion().then(setVersion).catch(() => {});
    }
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        const messages = {
          invalid_credentials: 'Email or password is incorrect',
          user_suspended: 'Account suspended — contact admin',
          device_claim_failed: 'Could not register device — check connection',
          network_error: 'Cannot reach server — check internet',
          not_configured: 'Cloud not configured — contact admin'
        };
        setError(messages[data.reason] || data.error || 'Login failed');
        setSubmitting(false);
        return;
      }
      if (data.is_takeover) {
        setTakeoverNote(true);
        setTimeout(() => onSuccess(data.user), 2500);
      } else {
        onSuccess(data.user);
      }
    } catch (err) {
      setError('Network error: ' + err.message);
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      width: '100vw', height: '100vh', position: 'relative',
      overflow: 'hidden', background: 'var(--sumi-ink)'
    }}>
      <SamuraiBackground opacity={0.55} />
      <div style={{
        position: 'relative', zIndex: 2,
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}>
        <form onSubmit={submit} className="panel"
              style={{ width: '100%', maxWidth: 380, padding: 32, margin: 16 }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div className="kanji-title" style={{ fontSize: 48 }}>剣天照</div>
            <div style={{ fontSize: 13, color: 'var(--gold)', letterSpacing: 3 }}>
              KINTENSHAUTO {version && <span style={{ opacity: 0.6 }}>· v{version}</span>}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Sign in to continue
            </div>
          </div>

          <label htmlFor="login-email">Email</label>
          <input id="login-email"
            type="email" value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
            required disabled={submitting}
            style={{ marginBottom: 12 }}
            autoComplete="email"
            autoFocus
          />

          <label htmlFor="login-password">Password</label>
          <input id="login-password"
            type="password" value={password}
            onChange={e => setPassword(e.target.value)}
            required disabled={submitting}
            autoComplete="current-password"
            style={{ marginBottom: 16 }}
          />

          {error && (
            <div style={{
              padding: 10, marginBottom: 14, fontSize: 12,
              background: 'rgba(232,123,123,0.1)',
              border: '0.5px solid var(--danger)',
              color: 'var(--danger)'
            }}>
              {error}
            </div>
          )}

          {takeoverNote && (
            <div style={{
              padding: 10, marginBottom: 14, fontSize: 12,
              background: 'rgba(212,167,72,0.1)',
              border: '0.5px solid var(--warning)',
              color: 'var(--warning)'
            }}>
              Signed in from this device — previous session has been signed out.
            </div>
          )}

          <button
            type="submit" className="btn-primary"
            disabled={submitting || !email || !password}
            style={{ width: '100%', padding: '12px 0' }}
          >
            {submitting ? 'Signing in...' : 'Sign in'}
          </button>

          <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
            Internal use only — contact admin for an account
          </div>
        </form>
      </div>
    </div>
  );
}
