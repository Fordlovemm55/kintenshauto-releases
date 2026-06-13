import React, { useState, useEffect } from 'react';
import { LogoMark } from '../components/Icon';
import SamuraiBackground from '../components/SamuraiBackground';

const API = 'http://localhost:3003';

export default function LoginScreen({ onSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
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
          invalid_credentials: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
          user_suspended: 'บัญชีถูกระงับ — ติดต่อผู้ดูแล',
          device_claim_failed: 'ลงทะเบียนอุปกรณ์ไม่สำเร็จ — ตรวจการเชื่อมต่อ',
          network_error: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจอินเทอร์เน็ต',
          not_configured: 'ระบบคลาวด์ยังไม่ได้ตั้งค่า — ติดต่อผู้ดูแล'
        };
        setError(messages[data.reason] || data.error || 'เข้าสู่ระบบไม่สำเร็จ');
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
      setError('เชื่อมต่อไม่ได้: ' + err.message);
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      width: '100vw', height: '100vh', position: 'relative',
      overflow: 'hidden', background: 'var(--sumi-ink)'
    }}>
      <SamuraiBackground variant="login" opacity={0.75} />
      <div style={{
        position: 'relative', zIndex: 2,
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}>
        <form onSubmit={submit} className="panel"
              style={{ width: '100%', maxWidth: 400, padding: 32, margin: 16 }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div style={{ marginBottom: 4 }}><LogoMark size={76} radius={18} /></div>
            <div className="brand-wordmark" style={{ fontSize: 34 }}>ออโต้โพสต์ดีว๊ะ</div>
            <div style={{ fontSize: 13, color: 'var(--gold)', letterSpacing: 1 }}>
              โพสต์คลิปอัตโนมัติ สไตล์ดีว๊ะ {version && <span style={{ opacity: 0.6 }}>· รุ่น {version}</span>}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>
              เข้าสู่ระบบเพื่อใช้งาน
            </div>
          </div>

          <label htmlFor="login-email">อีเมล</label>
          <input id="login-email"
            type="email" value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="เช่น you@example.com"
            required disabled={submitting}
            style={{ marginBottom: 12 }}
            autoComplete="email"
            autoFocus
          />

          <label htmlFor="login-password">รหัสผ่าน</label>
          <div className="input-with-toggle" style={{ marginBottom: 16 }}>
            <input id="login-password"
              type={showPw ? 'text' : 'password'} value={password}
              onChange={e => setPassword(e.target.value)}
              required disabled={submitting}
              autoComplete="current-password"
            />
            <button type="button" className="toggle-reveal" tabIndex={-1}
                    onClick={() => setShowPw(s => !s)}>
              {showPw ? 'ซ่อน' : 'แสดง'}
            </button>
          </div>

          {error && (
            <div style={{
              padding: 10, marginBottom: 14, fontSize: 13,
              background: 'rgba(232,123,123,0.1)',
              border: '0.5px solid var(--danger)',
              color: 'var(--danger)'
            }}>
              {error}
            </div>
          )}

          {takeoverNote && (
            <div style={{
              padding: 10, marginBottom: 14, fontSize: 13,
              background: 'rgba(212,167,72,0.1)',
              border: '0.5px solid var(--warning)',
              color: 'var(--warning)'
            }}>
              เข้าสู่ระบบจากอุปกรณ์นี้แล้ว — เซสชันก่อนหน้าถูกออกจากระบบ
            </div>
          )}

          <button
            type="submit" className="btn-primary"
            disabled={submitting || !email || !password}
            style={{ width: '100%', padding: '12px 0' }}
          >
            {submitting ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
          </button>

          <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
            สำหรับใช้ภายในเท่านั้น — ติดต่อผู้ดูแลเพื่อขอบัญชี
          </div>

          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
            เข้าไม่ได้? ติดต่อผู้ดูแลระบบ
          </div>
        </form>
      </div>
    </div>
  );
}
