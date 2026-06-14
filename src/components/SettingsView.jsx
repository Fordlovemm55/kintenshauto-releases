import React, { useCallback, useEffect, useState } from 'react';
import { useSettings, SettingRow, SaveBar } from './settingsKit';

const API = 'http://localhost:3003';

// Settings sections — kept declarative so the renderer below is one loop.
// `key` matches the backend ALLOWED_SETTING_KEYS allowlist exactly; the server
// rejects anything else. Add new keys on both sides when expanding.
const SETTING_GROUPS = [
  {
    title: 'การทำงานเบื้องหลัง',
    items: [
      { key: 'close_to_tray', label: 'กดปิดแล้วทำงานเบื้องหลัง', type: 'toggle',
        defaultValue: '1',
        desc: 'เปิด (ค่าเริ่มต้น) = กดกากบาทแล้วซ่อนลงถาดระบบ ยังโพสต์อยู่ · ปิด = กดปิดแล้วออกจากโปรแกรมจริง' },
      { key: 'chrome_headless', label: 'ซ่อนโครมตอนทำงาน', type: 'toggle',
        defaultValue: '0',
        desc: 'เปิด = โครมทำงานเงียบๆ ไม่โผล่ขึ้นมาเกะกะ · ปิด (ค่าเริ่มต้น) = เห็นโครมทำงานอยู่ ตรวจสอบได้ง่าย · มีผลตอนโครมเปิดครั้งถัดไป' },
    ]
  },
  {
    title: 'ค่าเริ่มต้นคลิปและวิดีโอ',
    items: [
      { key: 'default_clips_per_video',  label: 'จำนวนคลิปต่อวิดีโอ',           type: 'number', placeholder: '5',  desc: 'ระบบจะแบ่ง 1 วิดีโอเป็นกี่คลิป' },
      { key: 'default_clip_duration_sec', label: 'ความยาวคลิป (วินาที)',         type: 'number', placeholder: '90' },
      { key: 'warmup_duration_sec',       label: 'อุ่นเครื่องก่อนโพสต์ (วินาที)',  type: 'number', placeholder: '4' },
      { key: 'copyright_monitor_sec',     label: 'รอตรวจลิขสิทธิ์ (วินาที)',       type: 'number', placeholder: '90' },
      { key: 'slice_speed_factor',        label: 'ตัวคูณเร่งความเร็ว (1.0–2.0)',  type: 'number', step: 0.05, placeholder: '1.0',
        desc: 'เร่งความเร็วคลิปเพื่อเลี่ยงระบบจับลิขสิทธิ์ — 1.0 = ปกติ' },
      { key: 'strict_copyright_wait',     label: 'เข้มงวดเรื่องลิขสิทธิ์', type: 'toggle',
        desc: 'เปิด = หยุดถ้าตรวจไม่ทันเวลา · ปิด = ยังโพสต์ต่อ (ค่าเริ่มต้น)' },
    ]
  },
  {
    title: 'ที่อยู่ไฟล์และการจัดเก็บ',
    items: [
      { key: 'storage_videos_dir', label: 'โฟลเดอร์เก็บวิดีโอต้นฉบับ', type: 'text', placeholder: 'ว่าง = ค่าระบบ (AppData)' },
      { key: 'storage_clips_dir',  label: 'โฟลเดอร์เก็บคลิปตัดแล้ว',   type: 'text', placeholder: 'ว่าง = ค่าระบบ' },
      { key: 'storage_covers_dir', label: 'โฟลเดอร์เก็บปก',             type: 'text', placeholder: 'ว่าง = ค่าระบบ' },
    ]
  },
  {
    title: 'ตั้งค่าขั้นสูง',
    items: [
      { key: 'chrome_executable_path', label: 'ที่อยู่ไฟล์โครม (กำหนดเอง)', type: 'text',
        placeholder: 'ว่าง = ตรวจหาอัตโนมัติ',
        desc: 'ใช้เมื่อโครมไม่ได้อยู่ที่ตำแหน่งเริ่มต้น' },
    ]
  },
];

export default function SettingsView({ showToast, user }) {
  return (
    <div className="fade-in">
      <AccountSection user={user} showToast={showToast} />
      <YouTubeLoginSection showToast={showToast} />
      <SettingsSections showToast={showToast} />
      <MaintenanceSection showToast={showToast} />
    </div>
  );
}

// ============================================================
// YouTube login — captures cookies into a dedicated Chrome profile
// so yt-dlp can use --cookies <file> on every download.
// ============================================================
function YouTubeLoginSection({ showToast }) {
  const [status, setStatus] = useState({ logged_in: false });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('http://localhost:3003/api/system/youtube-login-status');
      setStatus(await r.json());
    } catch (e) {
      setStatus({ logged_in: false });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onLogin = async () => {
    setBusy(true);
    showToast('เปิดหน้าต่างโครม', 'กรุณาเข้าสู่ระบบยูทูบในหน้าต่างที่เด้งขึ้นมา', 'info');
    try {
      const r = await fetch('http://localhost:3003/api/system/youtube-login', { method: 'POST' });
      const data = await r.json();
      if (data.ok) {
        showToast('เข้าสู่ระบบสำเร็จ', `บันทึกคุกกี้ ${data.cookies_count || 0} รายการ — yt-dlp ใช้ได้ทุกคลิปแล้ว`, 'success');
      } else {
        showToast('เข้าสู่ระบบไม่สำเร็จ', data.error || 'ไม่ทราบสาเหตุ', 'danger');
      }
    } catch (e) {
      showToast('เข้าสู่ระบบไม่สำเร็จ', e.message, 'danger');
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const onCancel = async () => {
    try { await fetch('http://localhost:3003/api/system/youtube-login-cancel', { method: 'POST' }); }
    catch {}
    setBusy(false);
  };

  const onLogout = async () => {
    if (!confirm('ออกจากระบบยูทูบ? — ระบบจะลบคุกกี้ออก และคลิปที่ต้องยืนยันตัวตนอาจดูดไม่ได้')) return;
    try {
      await fetch('http://localhost:3003/api/system/youtube-logout', { method: 'POST' });
      showToast('ออกจากระบบสำเร็จ', 'ลบคุกกี้ยูทูบแล้ว', 'success');
      refresh();
    } catch (e) {
      showToast('ออกจากระบบไม่สำเร็จ', e.message, 'danger');
    }
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <div className="label-jp">เข้าสู่ระบบยูทูบ</div>
          <div className="panel-title">เข้าสู่ระบบยูทูบ</div>
          <div className="panel-subtitle">
            เข้าสู่ระบบบัญชีกูเกิลในโครมเฉพาะของแอป เพื่อให้ yt-dlp ใช้คุกกี้ดูดคลิป
            ที่ต้องยืนยันตัวตน (18+ / จำกัดภูมิภาค / Music Premium) ได้
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center',
                    padding: '14px 18px', background: 'var(--surface-2)',
                    border: '0.5px solid var(--border-soft)' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          {status.logged_in ? (
            <>
              <div style={{ fontSize: 14, color: 'var(--success)', fontWeight: 500 }}>
                ✓ เข้าสู่ระบบแล้ว
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                บันทึกล่าสุด: {status.last_login_at
                  ? new Date(status.last_login_at).toLocaleString('th-TH')
                  : '—'}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 14, color: 'var(--danger)', fontWeight: 500 }}>
                ❌ ยังไม่เข้าสู่ระบบ
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                คลิปยูทูบบางตัวอาจดูดไม่ได้จนกว่าจะเข้าสู่ระบบ
              </div>
            </>
          )}
        </div>

        {busy ? (
          <>
            <span style={{ fontSize: 12, color: 'var(--gold)' }}>⏳ รอเข้าสู่ระบบในหน้าต่างโครม...</span>
            <button className="btn-ghost" onClick={onCancel}>ยกเลิก</button>
          </>
        ) : status.logged_in ? (
          <>
            <button className="btn-ghost" onClick={onLogin}>↻ เข้าสู่ระบบใหม่</button>
            <button className="btn-ghost" onClick={onLogout}
                    style={{ color: 'var(--danger)' }}>🗑 ออกจากระบบยูทูบ</button>
          </>
        ) : (
          <button className="btn-primary" onClick={onLogin}>🔐 เข้าสู่ระบบยูทูบ</button>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Account / version / logout
// ============================================================
function AccountSection({ user, showToast }) {
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    window.kintenshauto?.getVersion?.().then(setVersion).catch(() => {});
  }, []);

  const checkUpdate = async () => {
    setChecking(true);
    try {
      const res = await fetch(`${API}/api/version/check`).then(r => r.json());
      if (res.force_update) showToast?.('มีอัปเดตบังคับ', `v${res.force_update.version} — ระบบจะแจ้งทันที`, 'warning');
      else if (res.soft_update) showToast?.('มีเวอร์ชันใหม่', `v${res.soft_update.version} พร้อมให้อัปเดต`, 'info');
      else showToast?.('ใช้เวอร์ชันล่าสุดแล้ว', `v${version}`, 'success');
    } catch (e) { showToast?.('ตรวจสอบไม่สำเร็จ', e.message, 'error'); }
    finally { setChecking(false); }
  };

  const openLogs = () => window.kintenshauto?.openLogs?.();

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <div className="label-jp">บัญชี</div>
          <div className="panel-title">บัญชี · เวอร์ชัน · บันทึกการทำงาน</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        <KV label="อีเมล" value={user?.email || '—'} />
        <KV label="เวอร์ชันปัจจุบัน" value={version ? `v${version}` : '...'} />
      </div>
      <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn-ghost" onClick={checkUpdate} disabled={checking}>
          {checking ? '⏳ กำลังตรวจ...' : '🔄 ตรวจสอบอัปเดต'}
        </button>
        <button className="btn-ghost" onClick={openLogs}>📁 เปิดโฟลเดอร์บันทึกการทำงาน</button>
      </div>
    </div>
  );
}

function KV({ label, value }) {
  return (
    <div style={{ padding: '8px 10px', background: 'var(--surface-2)', border: '0.5px solid var(--border-faint)' }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{value}</div>
    </div>
  );
}

// ============================================================
// Generic settings sections (drives off SETTING_GROUPS)
// ============================================================
function SettingsSections({ showToast }) {
  const allKeys = SETTING_GROUPS.flatMap(g => g.items.map(it => it.key));
  const { values, setOne, isDirty, loading, saving, saveAll, resetAll } = useSettings(allKeys, showToast);

  if (loading) {
    return <div className="panel" style={{ padding: 16, color: 'var(--text-muted)' }}>กำลังโหลดค่าการตั้งค่า...</div>;
  }

  return (
    <>
      {SETTING_GROUPS.map(group => (
        <div className="panel" key={group.title}>
          <div className="panel-header">
            <div>
              <div className="panel-title">{group.title}</div>
            </div>
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            {group.items.map(item => (
              <SettingRow key={item.key} item={item}
                          value={values[item.key]}
                          onChange={(v) => setOne(item.key, v)} />
            ))}
          </div>
        </div>
      ))}

      <SaveBar isDirty={isDirty} saving={saving} onSave={saveAll} onReset={resetAll} />
    </>
  );
}

// ============================================================
// Maintenance — log tail + clean downloads
// ============================================================
function MaintenanceSection({ showToast }) {
  const [busy, setBusy] = useState(null);
  const [logLines, setLogLines] = useState(null);

  const showLogTail = async () => {
    setBusy('log');
    try {
      const res = await fetch(`${API}/api/admin/log-tail?lines=80`).then(r => r.json());
      setLogLines(res.lines || []);
    } catch (e) { showToast?.('โหลดบันทึกการทำงานไม่ได้', e.message, 'error'); }
    finally { setBusy(null); }
  };

  const cleanDownloads = async () => {
    if (!confirm('ลบไฟล์ดาวน์โหลดเก่าทั้งหมด?\n(ลบเฉพาะไฟล์ในโฟลเดอร์ดาวน์โหลด — ไม่กระทบคลิปที่ใช้แล้ว)')) return;
    setBusy('clean');
    try {
      const res = await fetch(`${API}/api/admin/clean-downloads`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showToast?.('ทำความสะอาดแล้ว', `ลบ ${data.deleted || 0} ไฟล์`, 'success');
    } catch (e) { showToast?.('ลบไม่สำเร็จ', e.message, 'error'); }
    finally { setBusy(null); }
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <div className="label-jp">บำรุงรักษา</div>
          <div className="panel-title">บำรุงรักษา</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn-ghost" onClick={showLogTail} disabled={!!busy}>
          {busy === 'log' ? '⏳ โหลด...' : '📜 ดูบันทึกการทำงานล่าสุด (80 บรรทัด)'}
        </button>
        <button className="btn-ghost" onClick={cleanDownloads} disabled={!!busy}
                style={{ color: 'var(--danger)' }}>
          {busy === 'clean' ? '⏳ ลบ...' : '🧹 ล้างโฟลเดอร์ดาวน์โหลด'}
        </button>
      </div>
      {logLines && (
        <pre style={{
          marginTop: 12, padding: 10, maxHeight: 360, overflow: 'auto',
          background: 'var(--surface-3)', border: '0.5px solid var(--border-faint)',
          fontSize: 10, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all'
        }}>
          {logLines.length ? logLines.join('\n') : '(ไม่มีบันทึกการทำงาน)'}
        </pre>
      )}
    </div>
  );
}
