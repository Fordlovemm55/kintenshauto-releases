import React, { useEffect, useState } from 'react';
import LoginScreen from './login/LoginScreen';
import SetupWizard from './setup-wizard/SetupWizard';
import Dashboard from './Dashboard';

const API = 'http://localhost:3003';

export default function App() {
  const [state, setState] = useState({
    loading: true, loggedIn: false, firstRun: false, user: null
  });

  useEffect(() => {
    (async () => {
      let firstRun = false;
      let loggedIn = false;
      let user = null;

      try {
        // First-run flag from Electron (or hash fallback for browser dev)
        if (window.kintenshauto?.isFirstRun) {
          firstRun = await window.kintenshauto.isFirstRun();
        } else {
          firstRun = window.location.hash.includes('setup');
        }

        // Login status from backend
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

  if (state.loading) return <LoadingScreen />;

  if (!state.loggedIn) {
    return (
      <LoginScreen onSuccess={(user) =>
        setState(s => ({ ...s, loggedIn: true, user }))
      } />
    );
  }

  if (state.firstRun) {
    return (
      <SetupWizard onComplete={() =>
        setState(s => ({ ...s, firstRun: false }))
      } />
    );
  }

  return <Dashboard user={state.user} />;
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
