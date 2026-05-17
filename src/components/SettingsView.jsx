import React, { useEffect, useMemo, useState } from 'react';

const API = 'http://localhost:3003';

const PROVIDERS = [
  { key: 'openai',    label: 'OpenAI',              placeholder: 'sk-...' },
  { key: 'anthropic', label: 'Anthropic (Claude)',  placeholder: 'sk-ant-...' },
  { key: 'gemini',    label: 'Google Gemini',       placeholder: 'AIza...' },
];

// Settings sections — kept declarative so the renderer below is one loop.
// `key` matches the backend ALLOWED_SETTING_KEYS allowlist exactly; the server
// rejects anything else. Add new keys on both sides when expanding.
const SETTING_GROUPS = [
  {
    title: 'การทำงานเบื้องหลัง', jp: '裏方',
    items: [
      { key: 'close_to_tray', label: 'กดปิดแล้วทำงานเบื้องหลัง', type: 'toggle',
        defaultValue: '1',
        desc: 'เปิด (ค่า default) = กดกากบาทแล้วซ่อนลง tray ระบบยังโพสต์อยู่ · ปิด = กดปิดแล้วออกจากโปรแกรมจริง' },
      { key: 'chrome_headless', label: 'ซ่อน Chrome ตอนทำงาน', type: 'toggle',
        defaultValue: '0',
        desc: 'เปิด = Chrome ทำงานเงียบๆ ไม่โผล่ขึ้นมาเกะกะ · ปิด (default) = เห็น Chrome ทำงานอยู่ ตรวจสอบได้ง่าย · มีผลตอน Chrome เปิดครั้งถัดไป' },
    ]
  },
  {
    title: 'ค่าเริ่มต้นคลิป + วิดีโอ', jp: '初期値',
    items: [
      { key: 'default_clips_per_video',  label: 'จำนวนคลิปต่อวิดีโอ',           type: 'number', placeholder: '5',  desc: 'ระบบจะแบ่ง 1 วิดีโอเป็นกี่คลิป' },
      { key: 'default_clip_duration_sec', label: 'ความยาวคลิป (วินาที)',         type: 'number', placeholder: '90' },
      { key: 'warmup_duration_sec',       label: 'Warmup ก่อนโพสต์ (วินาที)',    type: 'number', placeholder: '4' },
      { key: 'copyright_monitor_sec',     label: 'รอตรวจลิขสิทธิ์ (วินาที)',       type: 'number', placeholder: '90' },
      { key: 'slice_speed_factor',        label: 'Speed-up factor (1.0–2.0)',  type: 'number', step: 0.05, placeholder: '1.0',
        desc: 'เร่งความเร็วคลิปเพื่อเลี่ยงระบบจับลิขสิทธิ์ — 1.0 = ปกติ' },
      { key: 'strict_copyright_wait',     label: 'เข้มงวดเรื่องลิขสิทธิ์', type: 'toggle',
        desc: 'เปิด = บล็อกถ้าตรวจ timeout · ปิด = ยังโพสต์ต่อ (default)' },
    ]
  },
  {
    title: 'AI สร้างปกอัตโนมัติ', jp: '表紙',
    items: [
      { key: 'cover_enabled',         label: 'เปิดใช้ AI สร้างปก',  type: 'toggle',
        desc: 'ปิด = ใช้ thumbnail จากคลิป · เปิด = สร้างปกใหม่ด้วย AI' },
      { key: 'cover_model',           label: 'รุ่น AI ที่ใช้สร้างปก', type: 'select',
        options: [
          { value: '',           label: '(ไม่ตั้ง — ใช้ default ของระบบ)' },
          { value: 'dalle-3',    label: 'DALL·E 3 (OpenAI)' },
          { value: 'gpt-image-1', label: 'GPT Image 1 (OpenAI)' },
          { value: 'imagen-4',   label: 'Imagen 4 (Gemini)' },
        ] },
      { key: 'cover_prompt_default',  label: 'Default prompt', type: 'textarea',
        placeholder: 'เช่น "ภาพปกซีรีย์จีน สีสันสด ตัวอักษรไทยใหญ่..."' },
    ]
  },
  {
    title: 'ที่อยู่ไฟล์ · Storage', jp: '保管',
    items: [
      { key: 'storage_videos_dir', label: 'โฟลเดอร์เก็บวิดีโอต้นฉบับ', type: 'text', placeholder: 'ว่าง = ค่าระบบ (AppData)' },
      { key: 'storage_clips_dir',  label: 'โฟลเดอร์เก็บคลิปตัดแล้ว',   type: 'text', placeholder: 'ว่าง = ค่าระบบ' },
      { key: 'storage_covers_dir', label: 'โฟลเดอร์เก็บปก',             type: 'text', placeholder: 'ว่าง = ค่าระบบ' },
    ]
  },
  {
    title: 'ตั้งค่าขั้นสูง', jp: '高度',
    items: [
      { key: 'chrome_executable_path', label: 'Chrome path (override)', type: 'text',
        placeholder: 'ว่าง = auto-detect',
        desc: 'ใช้เมื่อ Chrome ไม่ได้อยู่ที่ default path' },
      { key: 'watcher_auto_edit_enabled', label: 'Channel Watcher ตัด+แบนเนอร์อัตโนมัติ', type: 'toggle',
        desc: 'ปิด = โพสต์ raw clip ที่ดาวน์โหลดมาตรงๆ · เปิด = ตัด + แปะแบนเนอร์ (default)' },
    ]
  },
];

export default function SettingsView({ showToast, user }) {
  return (
    <div className="fade-in">
      <AccountSection user={user} showToast={showToast} />
      <AIKeysSection showToast={showToast} />
      <SettingsSections showToast={showToast} />
      <MaintenanceSection showToast={showToast} />
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
      else if (res.soft_update) showToast?.('มีเวอร์ชั่นใหม่', `v${res.soft_update.version} พร้อมให้อัปเดต`, 'info');
      else showToast?.('ใช้เวอร์ชั่นล่าสุดแล้ว', `v${version}`, 'success');
    } catch (e) { showToast?.('ตรวจสอบไม่สำเร็จ', e.message, 'error'); }
    finally { setChecking(false); }
  };

  const openLogs = () => window.kintenshauto?.openLogs?.();

  const signOut = async () => {
    if (!confirm('ออกจากระบบ?')) return;
    try {
      await fetch(`${API}/api/auth/logout`, { method: 'POST' });
      window.location.reload();
    } catch (e) { showToast?.('ออกไม่สำเร็จ', e.message, 'error'); }
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <div className="label-jp">情報 · ACCOUNT</div>
          <div className="panel-title">บัญชี · เวอร์ชั่น · Logs</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        <KV label="อีเมล" value={user?.email || '—'} />
        <KV label="เวอร์ชั่นปัจจุบัน" value={version ? `v${version}` : '...'} />
      </div>
      <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn-ghost" onClick={checkUpdate} disabled={checking}>
          {checking ? '⏳ กำลังตรวจ...' : '🔄 ตรวจสอบอัปเดต'}
        </button>
        <button className="btn-ghost" onClick={openLogs}>📁 เปิดโฟลเดอร์ logs</button>
        <button className="btn-ghost" onClick={signOut} style={{ marginLeft: 'auto', color: 'var(--danger)' }}>
          ↩ ออกจากระบบ
        </button>
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
// AI provider keys (OpenAI / Anthropic / Gemini)
// ============================================================
function AIKeysSection({ showToast }) {
  const [keys, setKeys] = useState({});
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({ openai: '', anthropic: '', gemini: '' });
  const [busy, setBusy] = useState({});
  const [show, setShow] = useState({});

  const refresh = async () => {
    try {
      const data = await fetch(`${API}/api/ai/keys`).then(r => r.json());
      setKeys(data || {});
    } finally { setLoading(false); }
  };

  useEffect(() => { refresh(); }, []);

  const setBusyFor = (p, v) => setBusy(prev => ({ ...prev, [p]: v }));

  const save = async (p) => {
    const api_key = draft[p]?.trim();
    if (!api_key || api_key.length < 10) {
      showToast?.('คีย์สั้นเกินไป', 'กรอกรหัสให้ครบ', 'error');
      return;
    }
    setBusyFor(p, 'save');
    try {
      const res = await fetch(`${API}/api/ai/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: p, api_key })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDraft(prev => ({ ...prev, [p]: '' }));
      showToast?.('บันทึกแล้ว', `${PROVIDERS.find(x => x.key === p).label} พร้อมใช้งาน`, 'success');
      await refresh();
    } catch (e) { showToast?.('บันทึกไม่สำเร็จ', e.message, 'error'); }
    finally { setBusyFor(p, null); }
  };

  const test = async (p) => {
    setBusyFor(p, 'test');
    try {
      const res = await fetch(`${API}/api/ai/keys/${p}/test`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showToast?.('ทดสอบสำเร็จ', data.sample || 'AI ตอบกลับเรียบร้อย', 'success');
    } catch (e) { showToast?.('ทดสอบไม่ผ่าน', e.message, 'error'); }
    finally { setBusyFor(p, null); }
  };

  const remove = async (p) => {
    if (!confirm(`ลบ API key ของ ${PROVIDERS.find(x => x.key === p).label}?`)) return;
    setBusyFor(p, 'delete');
    try {
      await fetch(`${API}/api/ai/keys/${p}`, { method: 'DELETE' });
      showToast?.('ลบแล้ว', '', 'info');
      await refresh();
    } catch (e) { showToast?.('ลบไม่สำเร็จ', e.message, 'error'); }
    finally { setBusyFor(p, null); }
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <div className="label-jp">知恵の鍵 · AI KEYS</div>
          <div className="panel-title">API Keys สำหรับ AI Caption</div>
          <div className="panel-subtitle">
            เลือกผู้ให้บริการอย่างน้อย 1 ตัว — ระบบจะใช้ตัวที่ตั้งก่อนหน้าตามลำดับ OpenAI → Anthropic → Gemini
            {keys.primary && <span style={{ color: 'var(--gold)', marginLeft: 8 }}>· ตอนนี้ใช้: {PROVIDERS.find(p => p.key === keys.primary)?.label}</span>}
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 20, color: 'var(--text-muted)' }}>กำลังโหลด...</div>
      ) : (
        PROVIDERS.map(p => {
          const info = keys[p.key] || { configured: false, model: '' };
          const isBusy = busy[p.key];
          return (
            <div key={p.key} style={{
              padding: 12, marginBottom: 8,
              background: 'var(--surface-2)',
              border: '0.5px solid ' + (info.configured ? 'var(--success)' : 'var(--border-faint)')
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
                <div>
                  <strong style={{ fontSize: 13 }}>{p.label}</strong>
                  <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                    รุ่น: {info.model || '—'}
                  </span>
                </div>
                {info.configured ? (
                  <span className="badge badge-success" style={{ fontSize: 10 }}>✓ ตั้งค่าแล้ว</span>
                ) : (
                  <span className="badge" style={{ fontSize: 10, background: 'var(--surface-3)', color: 'var(--text-muted)' }}>ยังไม่ได้ตั้ง</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input
                  type={show[p.key] ? 'text' : 'password'}
                  value={draft[p.key] || ''}
                  onChange={e => setDraft(prev => ({ ...prev, [p.key]: e.target.value }))}
                  placeholder={info.configured ? '(เก็บไว้แล้ว — กรอกใหม่เพื่อเปลี่ยน)' : p.placeholder}
                  style={{ flex: '1 1 280px', minWidth: 200, fontSize: 12, padding: '6px 8px',
                           background: 'var(--surface-1)', border: '0.5px solid var(--border-faint)',
                           color: 'var(--text-primary)' }}
                  disabled={!!isBusy}
                />
                <button className="btn-ghost"
                        onClick={() => setShow(prev => ({ ...prev, [p.key]: !prev[p.key] }))}
                        style={{ fontSize: 11, padding: '4px 10px' }}>
                  {show[p.key] ? '🙈 ซ่อน' : '👁 แสดง'}
                </button>
                <button className="btn-primary"
                        onClick={() => save(p.key)}
                        disabled={!!isBusy || !(draft[p.key] || '').trim()}
                        style={{ fontSize: 11, padding: '4px 14px' }}>
                  {isBusy === 'save' ? 'กำลังบันทึก...' : '💾 บันทึก'}
                </button>
                {info.configured && (
                  <>
                    <button className="btn-ghost"
                            onClick={() => test(p.key)}
                            disabled={!!isBusy}
                            style={{ fontSize: 11, padding: '4px 10px' }}>
                      {isBusy === 'test' ? '⏳ ทดสอบ...' : '🧪 ทดสอบ'}
                    </button>
                    <button className="btn-ghost"
                            onClick={() => remove(p.key)}
                            disabled={!!isBusy}
                            style={{ fontSize: 11, padding: '4px 10px', color: 'var(--danger)' }}>
                      {isBusy === 'delete' ? 'ลบ...' : '🗑 ลบ'}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ============================================================
// Generic settings sections (drives off SETTING_GROUPS)
// ============================================================
function SettingsSections({ showToast }) {
  const [values, setValues] = useState({});
  const [originalValues, setOriginalValues] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const allKeys = useMemo(
    () => SETTING_GROUPS.flatMap(g => g.items.map(it => it.key)),
    []
  );

  useEffect(() => {
    (async () => {
      try {
        const rows = await fetch(`${API}/api/settings`).then(r => r.json());
        const map = {};
        for (const r of (Array.isArray(rows) ? rows : [])) map[r.key] = r.value;
        const init = {};
        for (const k of allKeys) init[k] = map[k] ?? '';
        setValues(init);
        setOriginalValues(init);
      } finally { setLoading(false); }
    })();
  }, [allKeys]);

  const isDirty = useMemo(
    () => allKeys.some(k => (values[k] ?? '') !== (originalValues[k] ?? '')),
    [values, originalValues, allKeys]
  );

  const setOne = (k, v) => setValues(prev => ({ ...prev, [k]: v }));

  const saveAll = async () => {
    setSaving(true);
    try {
      const changed = allKeys.filter(k => (values[k] ?? '') !== (originalValues[k] ?? ''));
      for (const k of changed) {
        const res = await fetch(`${API}/api/settings/${k}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: values[k] ?? '' })
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(`${k}: ${data.error || res.status}`);
        }
      }
      setOriginalValues(values);
      showToast?.('บันทึกแล้ว', `${changed.length} ค่าได้รับการอัปเดต`, 'success');
    } catch (e) {
      showToast?.('บันทึกไม่สำเร็จ', e.message, 'error');
    } finally { setSaving(false); }
  };

  const resetAll = () => setValues(originalValues);

  if (loading) {
    return <div className="panel" style={{ padding: 16, color: 'var(--text-muted)' }}>กำลังโหลดค่าการตั้งค่า...</div>;
  }

  return (
    <>
      {SETTING_GROUPS.map(group => (
        <div className="panel" key={group.title}>
          <div className="panel-header">
            <div>
              <div className="label-jp">{group.jp}</div>
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

      <div style={{
        position: 'sticky', bottom: 12,
        padding: 12, marginTop: 12,
        background: 'var(--surface-1)',
        border: '1px solid ' + (isDirty ? 'var(--gold)' : 'var(--border-faint)'),
        boxShadow: '0 -4px 12px rgba(0,0,0,0.3)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8
      }}>
        <div style={{ fontSize: 12, color: isDirty ? 'var(--gold)' : 'var(--text-muted)' }}>
          {isDirty ? '● มีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก' : '✓ บันทึกไว้แล้ว'}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn-ghost" onClick={resetAll} disabled={!isDirty || saving}
                  style={{ fontSize: 12, padding: '6px 14px' }}>
            ↩ ย้อนกลับ
          </button>
          <button className="btn-primary" onClick={saveAll} disabled={!isDirty || saving}
                  style={{ fontSize: 12, padding: '6px 18px' }}>
            {saving ? 'กำลังบันทึก...' : '💾 บันทึกทั้งหมด'}
          </button>
        </div>
      </div>
    </>
  );
}

function SettingRow({ item, value, onChange }) {
  const v = value ?? '';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) 1fr',
                  gap: 12, alignItems: 'start', padding: '8px 0',
                  borderBottom: '0.5px solid var(--border-faint)' }}
         className="setting-row">
      <div>
        <label style={{ fontSize: 12, fontWeight: 500 }}>{item.label}</label>
        {item.desc && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{item.desc}</div>
        )}
      </div>
      <div>
        {item.type === 'toggle' ? (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={v === '1'}
                   onChange={e => onChange(e.target.checked ? '1' : '0')} />
            <span style={{ fontSize: 12, color: v === '1' ? 'var(--success)' : 'var(--text-muted)' }}>
              {v === '1' ? 'เปิด' : 'ปิด'}
            </span>
          </label>
        ) : item.type === 'select' ? (
          <select value={v} onChange={e => onChange(e.target.value)}
                  style={{ fontSize: 12, padding: '5px 8px', minWidth: 200,
                           background: 'var(--surface-2)', border: '0.5px solid var(--border-faint)',
                           color: 'var(--text-primary)' }}>
            {item.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : item.type === 'textarea' ? (
          <textarea value={v} onChange={e => onChange(e.target.value)}
                    rows={3} placeholder={item.placeholder}
                    style={{ width: '100%', fontSize: 12, padding: '6px 8px',
                             background: 'var(--surface-2)', border: '0.5px solid var(--border-faint)',
                             color: 'var(--text-primary)', resize: 'vertical' }} />
        ) : (
          <input type={item.type === 'number' ? 'number' : 'text'}
                 step={item.step}
                 value={v} onChange={e => onChange(e.target.value)}
                 placeholder={item.placeholder}
                 style={{ width: '100%', maxWidth: 360, fontSize: 12, padding: '6px 8px',
                          background: 'var(--surface-2)', border: '0.5px solid var(--border-faint)',
                          color: 'var(--text-primary)' }} />
        )}
      </div>
    </div>
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
    } catch (e) { showToast?.('โหลด log ไม่ได้', e.message, 'error'); }
    finally { setBusy(null); }
  };

  const cleanDownloads = async () => {
    if (!confirm('ลบไฟล์ดาวน์โหลดเก่าทั้งหมด?\n(ลบเฉพาะไฟล์ใน downloads folder — ไม่กระทบคลิปที่ใช้แล้ว)')) return;
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
          <div className="label-jp">保守 · MAINTENANCE</div>
          <div className="panel-title">บำรุงรักษา</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn-ghost" onClick={showLogTail} disabled={!!busy}>
          {busy === 'log' ? '⏳ โหลด...' : '📜 ดู log ล่าสุด (80 บรรทัด)'}
        </button>
        <button className="btn-ghost" onClick={cleanDownloads} disabled={!!busy}
                style={{ color: 'var(--danger)' }}>
          {busy === 'clean' ? '⏳ ลบ...' : '🧹 ล้าง downloads folder'}
        </button>
      </div>
      {logLines && (
        <pre style={{
          marginTop: 12, padding: 10, maxHeight: 360, overflow: 'auto',
          background: 'var(--surface-3)', border: '0.5px solid var(--border-faint)',
          fontSize: 10, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all'
        }}>
          {logLines.length ? logLines.join('\n') : '(ไม่มี log)'}
        </pre>
      )}
    </div>
  );
}
