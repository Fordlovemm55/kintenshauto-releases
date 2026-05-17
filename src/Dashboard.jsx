import React, { useEffect, useState, useCallback } from 'react';
import SamuraiBackground from './components/SamuraiBackground';
import ChannelWatcher from './components/ChannelWatcher';
import QueueView from './components/QueueView';
import SettingsView from './components/SettingsView';
import ReviewsView from './components/ReviewsView';

const NAV = [
  { key: 'home',       icon: '⚔', th: 'หน้าหลัก',          jp: '本拠' },
  { key: 'profiles',   icon: '◈', th: 'จัดการเฟส',         jp: '盟友' },
  { key: 'watcher',    icon: '👁', th: 'ตามช่องอัตโนมัติ',  jp: '見張り', alertKey: 'pending_approvals' },
  { key: 'banners',    icon: '❋', th: 'แบนเนอร์',          jp: '旗' },
  { key: 'comments',   icon: '✎', th: 'คอมเม้นอัตโนมัติ',  jp: '言霊' },
  { key: 'ai',         icon: '✦', th: 'AI แคปชั่น',        jp: '知恵' },
  { key: 'queue',      icon: '☷', th: 'คิวงาน',            jp: '待機' },
  { key: 'reviews',    icon: '⚠', th: 'ตรวจสอบ',           jp: '検証', alertKey: 'pending_reviews' },
  { key: 'settings',   icon: '⚙', th: 'ตั้งค่า',            jp: '設定' }
];

const API = 'http://localhost:3003';

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function Dashboard({ user }) {
  const [nav, setNav] = useState('home');
  const [stats, setStats] = useState({ posted_today: 0, in_queue: 0, pending_reviews: 0, pending_approvals: 0 });
  const [pages, setPages] = useState([]);
  const [recentJobs, setRecentJobs] = useState([]);
  const [selectedPage, setSelectedPage] = useState(null);
  const [keyword, setKeyword] = useState('');
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState(null);
  const [version, setVersion] = useState('');
  // Update modal handling lives in App.jsx (renders ABOVE Dashboard so force
  // updates can block login too). Dashboard used to mount its own modal here
  // and double-prompted on every cloud check tick. Don't re-add.

  const showToast = useCallback((title, body, kind = 'info') => {
    setToast({ title, body, kind });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, p, j] = await Promise.all([
        api('/api/stats/daily').catch(() => ({ posted_today: 0, in_queue: 0, pending_reviews: 0, pending_approvals: 0 })),
        api('/api/pages').catch(() => []),
        api('/api/jobs/recent?limit=5').catch(() => [])
      ]);
      setStats(s);
      setPages(p);
      setRecentJobs(j);
      if (p.length > 0 && !selectedPage) setSelectedPage(p[0].id);
    } catch (e) {
      console.error('refresh failed:', e);
    }
  }, [selectedPage]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 10000);
    if (window.kintenshauto?.getVersion) {
      window.kintenshauto.getVersion().then(setVersion);
    }
    return () => clearInterval(iv);
  }, [refresh]);

  // Socket.io: server-initiated kick when another device claims the seat
  useEffect(() => {
    let sock;
    (async () => {
      try {
        const { io } = await import('socket.io-client');
        sock = io('http://localhost:3003');
        sock.on('auth:kicked', (payload) => {
          // Reload — App.jsx will see logged_in=false and show LoginScreen.
          // Intentionally do NOT reveal admin involvement in force-logout —
          // present it as a generic session-ended notice so the desktop user
          // can't distinguish admin kick from another-device signin.
          const msg = payload?.reason === 'user_banned'
            ? 'Your account has been banned. Returning to login.'
            : 'Signed in on another device. Returning to login.';
          alert(msg);
          window.location.reload();
        });
      } catch (e) { console.warn('[socket] connect failed:', e); }
    })();
    return () => { try { sock?.disconnect(); } catch {} };
  }, []);

  const startPipeline = async () => {
    if (!selectedPage) { showToast('เลือกเพจก่อน', 'ต้องเพิ่มเฟส + เพจก่อนเริ่มโพสต์', 'warning'); return; }
    if (!keyword.trim()) { showToast('ใส่ keyword', 'ต้องมี keyword สำหรับค้นคลิป', 'warning'); return; }
    setRunning(true);
    try {
      await api('/api/pipeline/start', {
        method: 'POST',
        body: JSON.stringify({ page_id: selectedPage, keyword: keyword.trim() })
      });
      showToast('เริ่มแล้ว', 'Pipeline กำลังทำงาน ติดตามได้ที่คิวงาน', 'success');
      refresh();
    } catch (e) {
      showToast('ผิดพลาด', e.message, 'danger');
    } finally {
      setRunning(false);
    }
  };

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = () => setSidebarOpen(false);

  return (
    <div className="app-shell">
      <SamuraiBackground opacity={0.25} />

      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button className="hamburger-btn" aria-label="เปิด/ปิดเมนู"
                  onClick={() => setSidebarOpen(o => !o)}>
            {sidebarOpen ? '✕' : '☰'}
          </button>
          <div className="kanji-title" style={{ fontSize: 28 }}>剣天照</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, letterSpacing: 1 }}>KINTENSHAUTO</div>
            <div style={{ fontSize: 10, color: 'var(--gold)', letterSpacing: 1 }}>เครื่องมือโพสต์ Reel · v{version}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }} className="header-chip-row">
          <span className="badge badge-success status-dot header-chip-secondary">ออนไลน์</span>
          {stats.pending_reviews > 0 && (
            <button className="badge badge-danger status-dot"
                    aria-label={`รอตรวจ ${stats.pending_reviews} รายการ ไปหน้าตรวจสอบ`}
                    onClick={() => setNav('reviews')}
                    style={{ cursor: 'pointer', border: 'none' }}>
              รอตรวจ {stats.pending_reviews}
            </button>
          )}
          <span className="badge badge-gold header-chip-secondary">{pages.length} เพจ</span>
        </div>
      </header>

      {sidebarOpen && (
        <div className="sidebar-scrim open" onClick={closeSidebar}
             role="presentation" aria-hidden="true" />
      )}

      <nav className={`app-sidebar${sidebarOpen ? ' open' : ''}`} aria-label="เมนูหลัก">
        <div className="nav-section">メニュー · เมนู</div>
        {NAV.map(item => (
          <button
            key={item.key}
            type="button"
            className={`nav-item ${nav === item.key ? 'active' : ''}`}
            onClick={() => { setNav(item.key); closeSidebar(); }}
            aria-current={nav === item.key ? 'page' : undefined}
            style={{ width: '100%', textAlign: 'left' }}
          >
            <span className="icon" aria-hidden="true">{item.icon}</span>
            <span style={{ flex: 1 }}>{item.th}</span>
            {item.alertKey && stats[item.alertKey] > 0 && (
              <span className="badge badge-danger" aria-label={`${stats[item.alertKey]} alerts`}
                    style={{ fontSize: 10, padding: '1px 6px' }}>{stats[item.alertKey]}</span>
            )}
          </button>
        ))}

        <div style={{ marginTop: 24, padding: '0 14px' }}>
          <div className="jp-divider">快捷</div>
          <button className="btn-ghost" style={{ width: '100%', fontSize: 11, padding: '8px 10px' }}
                  onClick={() => window.kintenshauto?.getPaths().then(p => window.kintenshauto?.openExternal(p.logDir))}>
            📁 เปิดโฟลเดอร์ logs
          </button>
        </div>

        <div style={{ marginTop: 'auto', padding: '14px' }}>
          <div className="jp-divider">退出</div>
          {user?.email && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)',
                          marginBottom: 6, wordBreak: 'break-all', textAlign: 'center' }}>
              {user.email}
            </div>
          )}
          <button
            className="btn-ghost"
            style={{ width: '100%', fontSize: 11, padding: '8px 10px', color: 'var(--danger)' }}
            onClick={async () => {
              if (!confirm('Sign out of KINTENSHAUTO?')) return;
              try {
                await fetch('http://localhost:3003/api/auth/logout', { method: 'POST' });
              } catch {}
              window.location.reload();
            }}>
            ↩ Sign out
          </button>
        </div>
      </nav>

      <main className="app-main">
        {nav === 'home' && (
          <HomeView
            stats={stats} pages={pages} recentJobs={recentJobs}
            selectedPage={selectedPage} setSelectedPage={setSelectedPage}
            keyword={keyword} setKeyword={setKeyword}
            startPipeline={startPipeline} running={running}
          />
        )}
        {nav === 'watcher' && <ChannelWatcher showToast={showToast} />}
        {nav === 'queue' && <QueueView showToast={showToast} />}
        {nav === 'settings' && <SettingsView showToast={showToast} user={user} />}
        {nav === 'reviews' && <ReviewsView showToast={showToast} />}
        {nav !== 'home' && nav !== 'watcher' && nav !== 'queue' && nav !== 'settings' && nav !== 'reviews' && <PlaceholderView section={NAV.find(n => n.key === nav)} />}
      </main>

      {toast && (
        <div className={`toast ${toast.kind}`}>
          <div className="toast-title">{toast.title}</div>
          <div className="toast-body">{toast.body}</div>
        </div>
      )}

    </div>
  );
}

function HomeView({ stats, pages, recentJobs, selectedPage, setSelectedPage, keyword, setKeyword, startPipeline, running }) {
  return (
    <div className="fade-in">
      <div className="home-stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-jp">本日</div>
          <div className="stat-label">วันนี้</div>
          <div className="stat-value">{stats.posted_today}</div>
          <div className="stat-desc">คลิปที่โพสต์แล้ว</div>
        </div>
        <div className="stat-card">
          <div className="stat-jp">待機</div>
          <div className="stat-label">รอคิว</div>
          <div className="stat-value">{stats.in_queue}</div>
          <div className="stat-desc">คลิปในคิว</div>
        </div>
        <div className={`stat-card ${stats.pending_reviews > 0 ? 'warning' : ''}`}>
          <div className="stat-jp">要確認</div>
          <div className="stat-label">รอตรวจสอบ</div>
          <div className="stat-value">{stats.pending_reviews}</div>
          <div className="stat-desc">ติดลิขสิทธิ์</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="label-jp">一閃 · ONE STRIKE</div>
            <div className="panel-title">เริ่มโพสต์ด่วน</div>
            <div className="panel-subtitle">เลือกเพจ ใส่ keyword แล้วกดเริ่ม — ระบบจะค้น ตัด โพสต์ให้อัตโนมัติ</div>
          </div>
        </div>

        {pages.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', background: 'var(--surface-2)', border: '0.5px dashed var(--border-soft)' }}>
            <div style={{ fontSize: 13, marginBottom: 8 }}>ยังไม่มีเพจ</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              ไปเมนู "จัดการเฟส" เพื่อเพิ่มเฟส FB และเพจก่อน
            </div>
          </div>
        ) : (
          <div className="home-quick-grid">
            <div>
              <label htmlFor="qp-page">เลือกเพจ</label>
              <select id="qp-page" value={selectedPage || ''}
                      onChange={e => setSelectedPage(Number(e.target.value))}>
                {pages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="qp-kw">Keyword ค้นคลิป</label>
              <input id="qp-kw" placeholder="เช่น ซีรีย์จีน, ซีรีย์เกาหลี"
                     value={keyword} onChange={e => setKeyword(e.target.value)}/>
            </div>
            <button className="btn-primary" onClick={startPipeline} disabled={running}
                    style={{ padding: '10px 24px', whiteSpace: 'nowrap' }}>
              {running ? '⏳ กำลังเริ่ม...' : '⚔ RUN'}
            </button>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="label-jp">最近</div>
            <div className="panel-title">กิจกรรมล่าสุด</div>
          </div>
        </div>
        {recentJobs.length === 0 ? (
          <div style={{ padding: 20, color: 'var(--text-muted)', textAlign: 'center', fontSize: 12 }}>ยังไม่มีกิจกรรม</div>
        ) : (
          <div>
            {recentJobs.map(j => (
              <div key={j.id} style={{
                display: 'flex', justifyContent: 'space-between', padding: '10px 0',
                borderBottom: '0.5px solid var(--border-faint)'
              }}>
                <div>
                  <div style={{ fontSize: 13 }}>{j.video_title || 'คลิป'} · คลิป {j.clip_index}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{j.page_name} · {j.scheduled_at}</div>
                </div>
                <span className={`badge badge-${j.status === 'posted' ? 'success' : j.status === 'copyright_waiting' ? 'danger' : 'warning'}`}>
                  {j.status === 'posted' ? '✓ สำเร็จ' :
                   j.status === 'copyright_waiting' ? '⚠ ติดลิขสิทธิ์' :
                   j.status === 'pending' ? 'รอคิว' :
                   j.status === 'running' ? 'กำลังโพสต์' : j.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PlaceholderView({ section }) {
  return (
    <div className="panel fade-in">
      <div className="panel-header">
        <div>
          <div className="label-jp">{section?.jp}</div>
          <div className="panel-title">{section?.th}</div>
        </div>
      </div>
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
        <div className="kanji-title" style={{ fontSize: 48, marginBottom: 12, opacity: 0.5 }}>準備中</div>
        <div style={{ fontSize: 13 }}>ส่วนนี้จะเชื่อมกับ backend ที่มีอยู่แล้ว</div>
        <div style={{ fontSize: 11, marginTop: 8 }}>
          (หน้า UI ครบ แต่ route ของ API ในส่วนนี้อยู่ใน backend/server.js ที่สร้างไว้ให้)
        </div>
      </div>
    </div>
  );
}
