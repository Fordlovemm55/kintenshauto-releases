import React, { useEffect, useState } from 'react';
import SetupWizard from './setup-wizard/SetupWizard';
import Dashboard from './Dashboard';

export default function App() {
  const [state, setState] = useState({ loading: true, firstRun: false });

  useEffect(() => {
    (async () => {
      if (window.kintenshauto?.isFirstRun) {
        try {
          const firstRun = await window.kintenshauto.isFirstRun();
          setState({ loading: false, firstRun });
        } catch (e) {
          setState({ loading: false, firstRun: false });
        }
      } else {
        // Dev mode (running in browser) - check hash
        setState({ loading: false, firstRun: window.location.hash.includes('setup') });
      }
    })();
  }, []);

  if (state.loading) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: 'radial-gradient(ellipse at center, #2a0a1a 0%, #0a0a0d 100%)'
      }}>
        <div style={{ fontFamily: 'Noto Serif JP, serif', fontSize: 64, color: '#d4af37', letterSpacing: 4 }}>剣天照</div>
        <div style={{ color: '#8b7355', fontSize: 12, letterSpacing: 3, marginTop: 8 }}>กำลังโหลด...</div>
      </div>
    );
  }

  if (state.firstRun) {
    return <SetupWizard onComplete={() => setState({ loading: false, firstRun: false })} />;
  }

  return <Dashboard />;
}
