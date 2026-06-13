import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './theme/samurai.css';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('[App crash]', error, info);
    if (window.kintenshauto?.reportCrash) {
      window.kintenshauto.reportCrash({ message: error.message, stack: error.stack, info });
    }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100vh', padding: 40, textAlign: 'center', background: '#0f172a', color: '#e2e8f0'
        }}>
          <img src="./assets/ui/crest.png" alt="" width={92} height={92} style={{ objectFit: 'cover', borderRadius: '24%', boxShadow: '0 6px 18px rgba(0,0,0,0.5)', marginBottom: 12 }} />
          <div style={{ fontSize: 18, fontWeight: 600, fontFamily: 'IBM Plex Sans Thai, Sarabun, sans-serif', marginBottom: 8 }}>เกิดข้อผิดพลาดในโปรแกรม</div>
          <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 20, maxWidth: 600 }}>
            {this.state.error?.message || 'ไม่ทราบสาเหตุ'}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '11px 26px', background: '#6366f1',
              border: 'none', borderRadius: 10, color: '#ffffff', cursor: 'pointer',
              fontFamily: 'Sarabun', fontSize: 14, fontWeight: 600, letterSpacing: 0
            }}
          >
            ↻ รีโหลดโปรแกรม
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
