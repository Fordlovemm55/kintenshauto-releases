import React, { useEffect, useState } from 'react';
import LoginScreen from './login/LoginScreen';
import SetupWizard from './setup-wizard/SetupWizard';
import Dashboard from './Dashboard';
import UpdatePromptModal from './components/UpdatePromptModal';

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
