import React, { useEffect, useRef, useState } from 'react';

const API = 'http://localhost:3003';

/**
 * Clip preview + caption editor + banner re-render.
 *
 * Scheduled time is read-only — the queue scheduler owns it (driven by the
 * page's daily_quota + post_times configuration).
 */
export default function ClipPreviewModal({
  job, clip, pageName, videoTitle, onClose, onSaved, showToast,
}) {
  const [caption, setCaption] = useState(clip?.caption || '');
  const [tab, setTab] = useState('manual'); // manual | auto | ai-prompt
  const [aiPrompt, setAiPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banners, setBanners] = useState([]);
  const [selectedBanner, setSelectedBanner] = useState('');
  const [rendering, setRendering] = useState(false);
  const closeBtnRef = useRef(null);

  useEffect(() => { setCaption(clip?.caption || ''); }, [clip?.caption]);

  useEffect(() => {
    fetch(`${API}/api/banner-presets`).then(r => r.json())
      .then(d => setBanners(Array.isArray(d) ? d : []))
      .catch(() => setBanners([]));
  }, []);

  // ESC to close + focus the close button on open so keyboard users have
  // an obvious starting focus point.
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    closeBtnRef.current?.focus();
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const videoSrc = clip?.set1_path
    ? `file://${clip.set1_path.replace(/\\/g, '/')}`
    : null;

  const charCount = (caption || '').length;

  const saveCaption = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API}/api/clips/${clip.id}/caption`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast?.('บันทึกแล้ว', 'อัปเดตแคปชั่น', 'success');
      onSaved?.();
    } catch (e) { showToast?.('ผิดพลาด', e.message, 'error'); }
    finally { setSaving(false); }
  };

  const regenerateAuto = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`${API}/api/clips/${clip.id}/regenerate-caption`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.caption) setCaption(data.caption);
      showToast?.('สร้างแล้ว', 'AI ใช้พรอมต์ของเพจ', 'success');
    } catch (e) { showToast?.('ผิดพลาด', e.message, 'error'); }
    finally { setGenerating(false); }
  };

  const generateFromPrompt = async () => {
    if (!aiPrompt.trim()) {
      showToast?.('ว่างเปล่า', 'พิมพ์คำสั่งให้ AI ก่อน', 'warning');
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch(`${API}/api/ai/generate-caption`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: aiPrompt }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.caption) setCaption(data.caption);
      showToast?.('สร้างแล้ว', data.provider || 'AI', 'success');
    } catch (e) { showToast?.('ผิดพลาด', e.message, 'error'); }
    finally { setGenerating(false); }
  };

  const reRender = async () => {
    if (!selectedBanner) {
      showToast?.('เลือกแบนเนอร์', 'หรือเลือก "ไม่ใส่แบนเนอร์" ก็ได้', 'warning');
      return;
    }
    setRendering(true);
    try {
      const body = selectedBanner === 'none'
        ? { preset_id: null }
        : { preset_id: Number(selectedBanner) };
      const res = await fetch(`${API}/api/clips/${clip.id}/re-render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showToast?.('กำลังสร้าง', 'คลิปใหม่กำลังเรนเดอร์ — อาจใช้เวลาครู่หนึ่ง', 'info');
      onSaved?.();
    } catch (e) { showToast?.('ผิดพลาด', e.message, 'error'); }
    finally { setRendering(false); }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="clip-preview-title"
         style={{
           position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
           display: 'flex', alignItems: 'center', justifyContent: 'center',
           padding: 16, zIndex: 1000
         }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="panel preview-grid" style={{
        width: '100%', maxWidth: 1100, maxHeight: '90vh',
        padding: 18, overflow: 'auto'
      }}>
        {/* LEFT — video preview */}
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
            คลิปที่จะโพสต์ (ชุดที่ {job.use_set || 1})
          </div>
          <div style={{ background: '#000', borderRadius: 4, overflow: 'hidden', aspectRatio: '9/16' }}>
            {videoSrc ? (
              <video src={videoSrc} controls title={videoTitle || 'คลิปพรีวิว'}
                     style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
                            height: '100%', color: 'var(--text-muted)', fontSize: 12 }}>
                ไม่มีคลิป
              </div>
            )}
          </div>
          {clip?.set1_path && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)',
                          marginTop: 6, wordBreak: 'break-all', fontFamily: 'monospace' }}>
              📁 {clip.set1_path}
            </div>
          )}
        </div>

        {/* RIGHT — metadata + caption + banner */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>เรื่อง</div>
            <div id="clip-preview-title" style={{ fontSize: 15, fontWeight: 500, wordBreak: 'break-word' }}>
              {videoTitle}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              ตอน {clip?.clip_index} · เพจ {pageName}
            </div>
          </div>

          <div style={{ padding: 8, background: 'var(--surface-2)',
                        border: '0.5px solid var(--border-faint)' }}>
            <div style={{ fontSize: 12 }}>
              📅 <strong>เวลาลง:</strong> {formatThaiDate(job.scheduled_at)}
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                ระบบจัดตารางตามค่าตั้งของเพจ (คลิปต่อวัน + เวลาที่ตั้งไว้)
              </div>
            </div>
          </div>

          {/* Caption editor */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center',
                          justifyContent: 'space-between', marginBottom: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 500 }}>
                ✏️ แคปชั่น (มี 3 วิธีสร้าง)
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {charCount} ตัวอักษร
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
              <TabBtn active={tab === 'manual'} onClick={() => setTab('manual')}>📝 พิมพ์เอง</TabBtn>
              <TabBtn active={tab === 'auto'} onClick={() => setTab('auto')}>+ อัตโนมัติ</TabBtn>
              <TabBtn active={tab === 'ai-prompt'} onClick={() => setTab('ai-prompt')}>🤖 AI ตามสั่ง</TabBtn>
            </div>

            {tab === 'manual' && (
              <textarea value={caption} onChange={e => setCaption(e.target.value)}
                        style={{ width: '100%', minHeight: 140, fontSize: 13,
                                 padding: 8, fontFamily: 'inherit',
                                 background: 'var(--surface-2)',
                                 border: '0.5px solid var(--border-faint)',
                                 color: 'var(--text-primary)' }} />
            )}

            {tab === 'auto' && (
              <div>
                <textarea value={caption} readOnly
                          style={{ width: '100%', minHeight: 100, fontSize: 13,
                                   padding: 8, fontFamily: 'inherit', opacity: 0.7,
                                   background: 'var(--surface-2)',
                                   border: '0.5px solid var(--border-faint)',
                                   color: 'var(--text-primary)' }} />
                <button className="btn-primary" disabled={generating}
                        style={{ width: '100%', marginTop: 6, fontSize: 12, padding: '6px' }}
                        onClick={regenerateAuto}>
                  {generating ? 'กำลังสร้าง...' : '+ สร้างใหม่ด้วยพรอมต์ของเพจ'}
                </button>
              </div>
            )}

            {tab === 'ai-prompt' && (
              <div>
                <textarea value={aiPrompt} onChange={e => setAiPrompt(e.target.value)}
                          placeholder='พิมพ์คำสั่งให้ AI เช่น "เขียนแคปชั่นชวนดูสั้นๆ ใส่ emoji 1-2 ตัว"'
                          style={{ width: '100%', minHeight: 60, fontSize: 12,
                                   padding: 8, fontFamily: 'inherit',
                                   background: 'var(--surface-2)',
                                   border: '0.5px solid var(--border-faint)',
                                   color: 'var(--text-primary)' }} />
                <button className="btn-primary" disabled={generating}
                        style={{ width: '100%', marginTop: 6, fontSize: 12, padding: '6px' }}
                        onClick={generateFromPrompt}>
                  {generating ? 'กำลังสร้าง...' : '🤖 ให้ AI เขียนตามนี้'}
                </button>
                {caption && (
                  <textarea value={caption} onChange={e => setCaption(e.target.value)}
                            style={{ width: '100%', marginTop: 8, minHeight: 80, fontSize: 13,
                                     padding: 8, fontFamily: 'inherit',
                                     background: 'var(--surface-2)',
                                     border: '0.5px solid var(--gold)',
                                     color: 'var(--text-primary)' }} />
                )}
              </div>
            )}

            <button className="btn-primary" disabled={saving}
                    style={{ width: '100%', marginTop: 8, fontSize: 13, padding: '8px' }}
                    onClick={saveCaption}>
              {saving ? 'กำลังบันทึก...' : '💾 บันทึกแคปชั่น'}
            </button>
          </div>

          {/* Banner picker + re-render */}
          <div style={{ borderTop: '0.5px solid var(--border-faint)', paddingTop: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>
              🎨 เปลี่ยนแบนเนอร์ + สร้างคลิปใหม่
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={selectedBanner} onChange={e => setSelectedBanner(e.target.value)}
                      style={{ flex: 1, fontSize: 12, padding: '4px 6px',
                               background: 'var(--surface-2)',
                               color: 'var(--text-primary)',
                               border: '0.5px solid var(--border-faint)' }}>
                <option value="">— เลือกแบนเนอร์ —</option>
                <option value="none">— ไม่ใส่แบนเนอร์ —</option>
                {banners.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <button className="btn-primary" disabled={rendering || !selectedBanner}
                      style={{ fontSize: 12, padding: '4px 14px' }}
                      onClick={reRender}>
                {rendering ? '...' : '🎨 สร้างใหม่'}
              </button>
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
              ต้องการแก้ภายในแบนเนอร์? ไปเมนู "แบนเนอร์" → แก้ชุดแบนเนอร์ → กลับมากดสร้างใหม่
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'auto', gap: 6 }}>
            <button ref={closeBtnRef} className="btn-ghost"
                    style={{ fontSize: 13, padding: '6px 18px' }}
                    onClick={onClose} aria-label="ปิดหน้าต่างพรีวิว">
              ปิด (ESC)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick}
            style={{
              flex: 1, fontSize: 11, padding: '6px 8px',
              background: active ? 'var(--gold)' : 'var(--surface-2)',
              color: active ? '#000' : 'var(--text-primary)',
              border: '0.5px solid ' + (active ? 'var(--gold)' : 'var(--border-faint)'),
              cursor: 'pointer', fontWeight: active ? 600 : 400,
            }}>
      {children}
    </button>
  );
}

function formatThaiDate(s) {
  if (!s) return '(ยังไม่ตั้งเวลา)';
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  const days = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const pad = n => String(n).padStart(2, '0');
  return `${days[d.getDay()]}. ${d.getDate()} ${months[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
