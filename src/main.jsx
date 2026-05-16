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
          height: '100vh', padding: 40, textAlign: 'center', background: '#0a0a0d', color: '#f4e8d0'
        }}>
          <div style={{ fontFamily: 'Noto Serif JP, serif', fontSize: 48, color: '#a23b3b', letterSpacing: 3, marginBottom: 12 }}>失敗</div>
          <div style={{ fontSize: 16, marginBottom: 8 }}>เกิดข้อผิดพลาดในโปรแกรม</div>
          <div style={{ fontSize: 12, color: '#8b7355', marginBottom: 20, maxWidth: 600 }}>
            {this.state.error?.message || 'Unknown error'}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '10px 24px', background: 'linear-gradient(180deg,#a23b3b,#6b1a1a)',
              border: '0.5px solid #d4af37', color: '#f4e8d0', cursor: 'pointer',
              fontFamily: 'Sarabun', fontSize: 13, letterSpacing: 2
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
