import React, { useEffect, useState } from 'react';
import LoginScreen from './login/LoginScreen';
import SetupWizard from './setup-wizard/SetupWizard';
import Dashboard from './Dashboard';
import UpdatePromptModal from './components/UpdatePromptModal';
import DepsRequiredScreen from './components/DepsRequiredScreen';

const API = 'http://localhost:3003';

export default function App() {
  const [state, setState] = useState({
    loading: true, loggedIn: false, firstRun: false, user: null
  });

  // Update modal state. `update` holds version metadata sourced from the cloud
  // version check (release notes, force flag, version string). `phase` drives
  // the modal lifecycle through electron-updater's download → install flow.
  const [update, setUpdate] = useState(null);
  const [phase, setPhase] = useState('prompt');
  const [progress, setProgress] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  // System binary deps (ffmpeg + yt-dlp). If anything required is missing
  // the user sees a blocking install screen — better than letting them click
  // approve/scout and getting a raw "spawn ENOENT" error.
  const [deps, setDeps] = useState(null); // null = unchecked, { ok, missing, ... } = checked

  // YouTube cookies — gates the app so users can't scrape without authenticated
  // cookies. Eliminates the "Sign in to confirm you're not a bot" failures by
  // forcing the dedicated Chrome login flow up front.
  const [ytLogin, setYtLogin] = useState(null); // null = unchecked, { logged_in } = checked
  const [ytBusy, setYtBusy] = useState(false);

  useEffect(() => {
    (async () => {
      let firstRun = false;
      let loggedIn = false;
      let user = null;

      try {
        if (window.kintenshauto?.isFirstRun) {
          firstRun = await window.kintenshauto.isFirstRun();
        } else {
          firstRun = window.location.hash.includes('setup');
        }

        const statusRes = await fetch(`${API}/api/auth/status`);
        const statusData = await statusRes.json();
        loggedIn = statusData.logged_in === true;
        user = statusData.user || null;

        // Probe binary deps in parallel (cheap, ~10 ms) — non-fatal if it fails.
        try {
          const depsRes = await fetch(`${API}/api/system/deps`).then(r => r.json());
          setDeps(depsRes);
        } catch { setDeps({ ok: true, missing: [] }); }

        // YouTube login status — gates Dashboard behind a login screen so the
        // user MUST authenticate before scraping. yt-dlp without cookies hits
        // "Sign in to confirm you're not a bot" → unrecoverable in-app, so we
        // make this a setup prerequisite, same shape as deps gate.
        try {
          const ytRes = await fetch(`${API}/api/system/youtube-login-status`).then(r => r.json());
          setYtLogin(ytRes);
        } catch { setYtLogin({ logged_in: true }); /* network fail → don't block */ }
      } catch {
        loggedIn = false;
      }

      setState({ loading: false, loggedIn, firstRun, user });
    })();
  }, []);

  // Subscribe to update lifecycle. Cloud check (main process polls
  // /api/version/check) tells us IF there's an update and whether it's force.
  // electron-updater handles the actual download → install mechanics.
  useEffect(() => {
    const k = window.kintenshauto;
    if (!k?.onCloudUpdateForce) {
      // Browser-dev mode — poll the backend directly, no electron-updater.
      fetch(`${API}/api/version/check`).then(r => r.json()).then(data => {
        if (data.force_update) setUpdate({ ...data.force_update, kind: 'force' });
        else if (data.soft_update) setUpdate({ ...data.soft_update, kind: 'soft' });
      }).catch(() => {});
      return;
    }

    k.onCloudUpdateForce(info => setUpdate({ ...info, kind: 'force' }));
    k.onCloudUpdateSoft(info => setUpdate({ ...info, kind: 'soft' }));
    k.onUpdateProgress(p => { setPhase('downloading'); setProgress(p); });
    k.onUpdateDownloaded(() => { setPhase('downloaded'); setProgress(null); });
    k.onUpdateError(msg => { setPhase('error'); setErrorMsg(msg); });
  }, []);

  const handleUpdate = async () => {
    setErrorMsg(null);
    setPhase('downloading');
    setProgress({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    try {
      // Ensure electron-updater has fetched latest.yml before downloadUpdate()
      // — without a prior checkForUpdates() it has no manifest to download.
      await window.kintenshauto?.checkUpdate?.();
      await window.kintenshauto?.downloadUpdate?.();
    } catch (e) {
      setPhase('error');
      setErrorMsg(e?.message || 'download failed');
    }
  };

  const handleInstall = async () => {
    try {
      await window.kintenshauto?.installUpdate?.();
    } catch (e) {
      setPhase('error');
      setErrorMsg(e?.message || 'install failed');
    }
  };

  const handleLater = () => {
    setUpdate(null);
    setPhase('prompt');
    setProgress(null);
    setErrorMsg(null);
  };

  const handleRetry = () => {
    setErrorMsg(null);
    setPhase('prompt');
  };

  // ---- Render decision ----
  const isForce = update?.kind === 'force';

  // Force update blocks everything — even the loading splash sits behind the modal
  if (update && isForce) {
    return (
      <>
        <LoadingScreen />
        <UpdatePromptModal
          kind="force" info={update} phase={phase}
          progress={progress} errorMessage={errorMsg}
          onUpdate={handleUpdate} onInstall={handleInstall} onRetry={handleRetry}
        />
      </>
    );
  }

  if (state.loading) return <LoadingScreen />;

  // Block app behind a "install dependencies" screen if any required binary
  // (yt-dlp / ffmpeg) is missing on disk. Calling endpoints like /api/watcher/
  // check-now would otherwise spawn nothing and surface a confusing ENOENT.
  if (deps && !deps.ok && deps.missing?.length) {
    return (
      <DepsRequiredScreen
        status={deps}
        onInstalled={(fresh) => setDeps(fresh)}
      />
    );
  }

  // Block app behind a "YouTube login required" screen if no cookies file has
  // been captured yet. Only gates AFTER login (no point asking an unauthed
  // user to do additional auth). Skipping the gate isn't allowed — clicking
  // anywhere outside the launch button is a no-op.
  if (state.loggedIn && ytLogin && !ytLogin.logged_in) {
    return (
      <YouTubeLoginRequiredScreen
        busy={ytBusy}
        onLogin={async () => {
          setYtBusy(true);
          try {
            const r = await fetch(`${API}/api/system/youtube-login`, { method: 'POST' });
            const data = await r.json();
            if (data.ok) {
              setYtLogin({ logged_in: true, last_login_at: new Date().toISOString() });
            } else {
              alert('Login ไม่สำเร็จ: ' + (data.error || 'ไม่ทราบสาเหตุ'));
            }
          } catch (e) {
            alert('Login ไม่สำเร็จ: ' + e.message);
          } finally {
            setYtBusy(false);
          }
        }}
        onCancel={async () => {
          try { await fetch(`${API}/api/system/youtube-login-cancel`, { method: 'POST' }); }
          catch {}
          setYtBusy(false);
        }}
      />
    );
  }

  let main;
  if (!state.loggedIn) {
    main = (
      <LoginScreen onSuccess={(user) =>
        setState(s => ({ ...s, loggedIn: true, user }))
      } />
    );
  } else if (state.firstRun) {
    main = (
      <SetupWizard onComplete={() =>
        setState(s => ({ ...s, firstRun: false }))
      } />
    );
  } else {
    main = <Dashboard user={state.user} />;
  }

  return (
    <>
      {main}
      {update && !isForce && (
        <UpdatePromptModal
          kind="soft" info={update} phase={phase}
          progress={progress} errorMessage={errorMsg}
          onUpdate={handleUpdate} onInstall={handleInstall}
          onLater={handleLater} onRetry={handleRetry}
        />
      )}
    </>
  );
}

function LoadingScreen() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      height: '100vh',
      background: 'radial-gradient(ellipse at center, #2a0a1a 0%, #0a0a0d 100%)'
    }}>
      <div style={{
        fontFamily: 'Noto Serif JP, serif',
        fontSize: 64, color: '#d4af37', letterSpacing: 4
      }}>剣天照</div>
      <div style={{ color: '#8b7355', fontSize: 12, letterSpacing: 3, marginTop: 8 }}>
        Loading...
      </div>
    </div>
  );
}

// Blocking gate shown when no YouTube cookies file has been captured yet.
// Clicking "Login" spawns a dedicated Chrome window (separate profile from
// the user's real browser) and waits until SAPISID cookies appear.
function YouTubeLoginRequiredScreen({ busy, onLogin, onCancel }) {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: 32,
      background: 'radial-gradient(ellipse at center, #2a0a1a 0%, #0a0a0d 100%)'
    }}>
      <div style={{
        maxWidth: 560, width: '100%',
        background: 'var(--surface-1)',
        border: '1px solid var(--gold)',
        padding: '36px 40px',
        boxShadow: '0 24px 48px rgba(0,0,0,0.6)',
        color: 'var(--text-primary)'
      }}>
        <div style={{ fontSize: 11, letterSpacing: 4, color: 'var(--gold)', marginBottom: 8 }}>
          認証必要 · YOUTUBE LOGIN REQUIRED
        </div>
        <div style={{ fontSize: 26, fontWeight: 600, marginBottom: 14 }}>
          จำเป็นต้อง Login YouTube ก่อน
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--text-muted)', marginBottom: 22 }}>
          YouTube กำลังบล็อกการดูดคลิปแบบไม่ login ระบบจึงบังคับให้ทุกคน login บัญชี Google
          ใน Chrome เฉพาะของแอปก่อน — login ครั้งเดียว cookies ใช้ได้ยาวนาน
        </div>

        <ol style={{
          fontSize: 13, lineHeight: 1.9, margin: '0 0 26px 22px', color: 'var(--text-primary)'
        }}>
          <li>กดปุ่ม <strong>"🔐 Login YouTube"</strong> ด้านล่าง</li>
          <li>หน้าต่าง Chrome เด้งขึ้นมา — login บัญชี Google ของคุณ (บัญชีอะไรก็ได้ที่ดู YouTube ได้)</li>
          <li>หลัง login สำเร็จ — ระบบจะปิด Chrome อัตโนมัติแล้วเข้าหน้าหลัก</li>
        </ol>

        {busy ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, fontSize: 13, color: 'var(--gold)' }}>
              ⏳ รอ login ในหน้าต่าง Chrome ที่เพิ่งเปิด...
            </div>
            <button className="btn-ghost" onClick={onCancel}>ยกเลิก</button>
          </div>
        ) : (
          <button className="btn-primary" onClick={onLogin}
                  style={{ width: '100%', padding: '14px 24px', fontSize: 15 }}>
            🔐 Login YouTube
          </button>
        )}

        <div style={{
          marginTop: 20, paddingTop: 16, borderTop: '0.5px solid var(--border-faint)',
          fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6
        }}>
          ⚠️ ใช้ Chrome แยกของแอป (ไม่ใช่ Chrome หลักของคุณ) — บัญชีและ cookies
          ของ Chrome หลักไม่ถูกแตะต้อง
        </div>
      </div>
    </div>
  );
}
