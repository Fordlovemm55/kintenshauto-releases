import React, { useEffect, useState } from 'react';

const API = 'http://localhost:3003';

const FRIENDLY_NAMES = {
  ffmpeg: 'FFmpeg — ตัด/ต่อวิดีโอ',
  ffprobe: 'FFprobe — อ่าน metadata วิดีโอ',
  'yt-dlp': 'yt-dlp — ดาวน์โหลดคลิปจาก YouTube/TikTok/FB',
  fpcalc: 'fpcalc — หาลายนิ้วมือเสียง (เลือกใช้ได้)',
};

// Full-screen guard that blocks the app until required binaries (ffmpeg +
// yt-dlp) are present on disk. The DB is already up — backend just can't
// spawn anything. Calling the existing app:installDeps IPC re-downloads.
//
// Why a screen instead of a banner: the alternative is letting the user
// click "ดึงเก่า" / Approve and get a confusing "spawn ENOENT" stack trace.
// Better to fail closed at the door.
export default function DepsRequiredScreen({ status, onInstalled }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!window.kintenshauto?.onDepsProgress) return;
    const off = window.kintenshauto.onDepsProgress((p) => setProgress(p));
    return () => { off?.(); };
  }, []);

  const install = async () => {
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const result = await window.kintenshauto?.installDeps?.();
      if (result?.ok === false) throw new Error(result.error || 'install failed');

      // Re-check from backend (now re-resolves from disk on every call, so
      // newly-downloaded files in USER_BIN_DIR are picked up without restart).
      const fresh = await fetch(`${API}/api/system/deps`).then(r => r.json());
      if (fresh.ok) {
        // Even though the check passes, the backend env vars (KINTENSHAUTO_*)
        // were baked in at spawn — yt-dlp / ffmpeg invocations from the
        // running backend still use the old (missing) path. Restart so the
        // backend respawns with the fresh paths. App.jsx will re-mount and
        // sail past the gate.
        setProgress({ step: 'restart', status: 'restarting', message: 'เริ่มต้นแอปใหม่ให้อัตโนมัติ...' });
        await new Promise(r => setTimeout(r, 1500));
        if (window.kintenshauto?.relaunch) {
          await window.kintenshauto.relaunch();
          // process exits before we get here
        } else {
          // Browser-dev mode — no relaunch IPC. Just clear the gate.
          onInstalled?.(fresh);
        }
      } else {
        setError('ติดตั้งแล้วแต่ยังเช็คไม่ผ่าน: ขาด ' + fresh.missing.join(', ')
          + ' — restart แอปแล้วลองอีกครั้ง');
      }
    } catch (e) {
      setError(e.message || 'ดาวน์โหลดไม่สำเร็จ');
    } finally { setBusy(false); }
  };

  const checkAgain = async () => {
    setBusy(true);
    try {
      const fresh = await fetch(`${API}/api/system/deps`).then(r => r.json());
      if (fresh.ok) onInstalled?.(fresh);
      else setError('ยังขาด: ' + fresh.missing.join(', '));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'radial-gradient(ellipse at center, #2a0a1a 0%, #0a0a0d 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
    }}>
      <div className="panel" style={{ maxWidth: 540, width: '100%', padding: 30 }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div className="kanji-title" style={{ fontSize: 56, color: 'var(--danger)' }}>必要</div>
          <div style={{ fontSize: 16, fontWeight: 500, marginTop: 6 }}>
            ขาดไฟล์ระบบที่จำเป็น
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            ต้องดาวน์โหลดให้ครบก่อนใช้งานต่อ
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          {status.missing.map(name => (
            <div key={name} style={{
              padding: '8px 10px', marginBottom: 6,
              background: 'rgba(232,123,123,0.08)',
              borderLeft: '3px solid var(--danger)',
              fontSize: 12
            }}>
              <div style={{ fontWeight: 500 }}>❌ {FRIENDLY_NAMES[name] || name}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2,
                            wordBreak: 'break-all', fontFamily: 'monospace' }}>
                {status.paths?.[name] || '(ไม่ทราบ path)'}
              </div>
            </div>
          ))}
        </div>

        {progress && (
          <div style={{
            padding: 10, marginBottom: 14,
            background: 'var(--surface-2)', border: '0.5px solid var(--border-faint)',
            fontSize: 12
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span>กำลังโหลด: {progress.step}</span>
              <span>{progress.pct != null ? progress.pct + '%' : progress.status}</span>
            </div>
            <div style={{ height: 4, background: 'var(--surface-3)' }}>
              <div style={{
                height: 4,
                width: (progress.pct ?? 0) + '%',
                background: 'var(--gold)',
                transition: 'width 0.2s'
              }} />
            </div>
            {progress.message && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                {progress.message}
              </div>
            )}
          </div>
        )}

        {error && (
          <div style={{
            padding: 10, marginBottom: 14,
            background: 'rgba(232,123,123,0.08)',
            borderLeft: '3px solid var(--danger)',
            fontSize: 12, color: 'var(--danger)'
          }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button className="btn-ghost" onClick={checkAgain} disabled={busy}
                  style={{ fontSize: 12, padding: '8px 16px' }}>
            ↻ เช็คใหม่
          </button>
          <button className="btn-primary" onClick={install} disabled={busy}
                  style={{ fontSize: 13, padding: '8px 24px' }}>
            {busy ? '⏳ กำลังดาวน์โหลด...' : '📥 ดาวน์โหลดทั้งหมด'}
          </button>
        </div>

        <div style={{ fontSize: 10, color: 'var(--text-muted)',
                      marginTop: 14, textAlign: 'center' }}>
          ไฟล์เก็บไว้ที่: <code style={{ fontSize: 10 }}>{status.bin_dir || '(default)'}</code>
        </div>
      </div>
    </div>
  );
}
