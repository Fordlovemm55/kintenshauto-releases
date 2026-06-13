import React, { useEffect, useState } from 'react';
import { LogoMark } from './components/Icon';
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
      background: 'radial-gradient(900px 520px at 50% -10%, rgba(99,102,241,0.12), transparent 60%), #0f172a'
    }}>
      <div style={{ marginBottom: 10 }}><LogoMark size={96} radius={22} /></div>
      <div style={{
        fontFamily: 'Mali, Sarabun, sans-serif',
        fontSize: 36, fontWeight: 700, color: '#818cf8', letterSpacing: 0
      }}>ออโต้โพสต์ดีว๊ะ</div>
      <div style={{ color: '#94a3b8', fontSize: 14, letterSpacing: 0, marginTop: 8 }}>
        กำลังโหลด...
      </div>
    </div>
  );
}
