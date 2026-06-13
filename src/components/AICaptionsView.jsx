import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './Icon';

const API = 'http://localhost:3003';

export default function AICaptionsView({ showToast }) {
  const [prompts, setPrompts] = useState([]);
  const [pages, setPages] = useState([]);
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [p, pg, m] = await Promise.all([
        fetch(`${API}/api/caption-prompts`).then(r => r.json()).catch(() => []),
        fetch(`${API}/api/pages`).then(r => r.json()).catch(() => []),
        fetch(`${API}/api/caption-models`).then(r => r.json()).catch(() => ({ models: [] })),
      ]);
      setPrompts(Array.isArray(p) ? p : []);
      setPages(Array.isArray(pg) ? pg : []);
      setModels(m.models || []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const deletePrompt = async (id) => {
    if (!confirm('ลบพรอมต์นี้?')) return;
    try {
      await fetch(`${API}/api/caption-prompts/${id}`, { method: 'DELETE' });
      showToast?.('ลบแล้ว', '', 'info');
      await refresh();
    } catch (e) { showToast?.('ลบไม่สำเร็จ', e.message, 'error'); }
  };

  const hasAnyKey = models.some(m => m.available);

  if (loading) {
    return <div className="panel" style={{ padding: 20, color: 'var(--text-muted)' }}>กำลังโหลด...</div>;
  }

  return (
    <div className="fade-in">
      {!hasAnyKey && (
        <div className="panel" style={{
          padding: 14, marginBottom: 12,
          borderLeft: '3px solid var(--danger)',
          background: 'rgba(232,123,123,0.06)'
        }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
            ⚠ ยังไม่ได้ตั้งคีย์ API
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            ต้องไปตั้งคีย์ API (โอเพนเอไอ / แอนโทรปิก / เจมิไน) ที่หน้า "ตั้งค่า" ก่อน
            แล้วถึงจะใช้ AI สร้างแคปชั่นได้
          </div>
        </div>
      )}

      {/* Available models with cost */}
      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="label-jp">ราคา</div>
            <div className="panel-title">รุ่น AI ที่ใช้ได้ + ราคาประมาณ</div>
            <div className="panel-subtitle">
              ราคาต่อแคปชั่น 1 ตัว (≈ โทเคนเข้า 250 + โทเคนออก 80) — ใช้เลือกในพรอมต์ด้านล่าง
            </div>
          </div>
        </div>
        {models.length === 0 ? (
          <div style={{ padding: 14, color: 'var(--text-muted)' }}>โหลดรุ่น AI ไม่สำเร็จ</div>
        ) : (
          <div style={{ display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
            {models.map(m => (
              <div key={m.id} style={{
                padding: 10, background: 'var(--surface-2)',
                border: '0.5px solid ' + (m.available ? 'var(--success)' : 'var(--border-faint)'),
                opacity: m.available ? 1 : 0.5,
              }}>
                <div style={{ fontSize: 12, fontWeight: 500 }}>{m.label}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                  {m.provider} · {m.available ? '✓ ใช้ได้' : '× ยังไม่ได้ตั้งคีย์'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--gold)', marginTop: 4 }}>
                  ≈ {m.cost_per_caption_thb?.toFixed?.(4) || '?'} บาท/แคปชั่น
                  {' '}<span style={{ color: 'var(--text-muted)' }}>
                    ({m.cost_per_1000_captions_thb?.toFixed?.(2) || '?'} บาท/1000)
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Prompts */}
      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="label-jp">พรอมต์</div>
            <div className="panel-title">พรอมต์สำหรับสร้างแคปชั่น ({prompts.length})</div>
            <div className="panel-subtitle">
              กำหนดสไตล์การเขียนแคปชั่น — แต่ละเพจมีพรอมต์ของตัวเอง หรือใช้พรอมต์ทั่วไป (ไม่ระบุเพจ)
            </div>
          </div>
          <button className="btn-primary" onClick={() => setShowCreate(true)}
                  style={{ fontSize: 12, padding: '6px 14px' }}>
            ＋ สร้างพรอมต์
          </button>
        </div>

        {prompts.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>
            <Icon name="empty-comments" className="empty-icon" size={56} />
            <div style={{ fontSize: 13 }}>ยังไม่มีพรอมต์ — กด "＋ สร้างพรอมต์" เพื่อเริ่ม</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {prompts.map(p => (
              <PromptRow key={p.id} prompt={p} pages={pages} models={models}
                         onEdit={() => setEditing(p)}
                         onDelete={() => deletePrompt(p.id)} />
            ))}
          </div>
        )}
      </div>

      {(showCreate || editing) && (
        <PromptModal
          pages={pages}
          models={models}
          prompt={editing}
          onClose={() => { setShowCreate(false); setEditing(null); }}
          onSaved={async () => {
            setShowCreate(false);
            setEditing(null);
            await refresh();
          }}
          showToast={showToast}
        />
      )}
    </div>
  );
}

function PromptRow({ prompt, pages, models, onEdit, onDelete }) {
  const pageName = prompt.page_id
    ? (pages.find(p => p.id === prompt.page_id)?.name || `เพจ #${prompt.page_id}`)
    : 'ทุกเพจ (ทั่วไป)';
  const modelInfo = models.find(m => m.id === prompt.selected_model);

  return (
    <div style={{
      padding: 12, background: 'var(--surface-2)',
      border: '0.5px solid var(--border-faint)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8,
                        flexWrap: 'wrap', marginBottom: 6 }}>
            <span className={`badge ${prompt.page_id ? 'badge-gold' : 'badge-info'}`}
                  style={{ fontSize: 10 }}>
              {pageName}
            </span>
            {modelInfo && (
              <span className="badge badge-success" style={{ fontSize: 10 }}>
                {modelInfo.label}
              </span>
            )}
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              สูงสุด {prompt.max_tokens} โทเคน · อุณหภูมิ={prompt.temperature}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
            <strong>พรอมต์ระบบ:</strong>
          </div>
          <div style={{
            fontSize: 11, color: 'var(--text-secondary)',
            background: 'var(--surface-3)', padding: '6px 8px',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 60, overflow: 'auto', marginBottom: 6
          }}>
            {prompt.system_prompt}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
            <strong>แม่แบบพรอมต์ผู้ใช้:</strong>
          </div>
          <div style={{
            fontSize: 11, color: 'var(--text-secondary)',
            background: 'var(--surface-3)', padding: '6px 8px',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 60, overflow: 'auto'
          }}>
            {prompt.user_prompt}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button className="btn-ghost" onClick={onEdit}
                  style={{ fontSize: 11, padding: '3px 10px' }}>✎ แก้</button>
          <button className="btn-ghost" onClick={onDelete}
                  style={{ fontSize: 11, padding: '3px 10px', color: 'var(--danger)' }}>🗑</button>
        </div>
      </div>
    </div>
  );
}

const DEFAULT_SYSTEM = `คุณเป็นผู้เขียนแคปชั่นเฟซบุ๊กรีลภาษาไทยที่สั้น กระชับ ดึงดูดให้คนคลิกดู
- 1-2 บรรทัด ไม่ยาว
- ใส่ #hashtag 2-3 ตัวที่เกี่ยวข้อง
- ไม่ใช้คำหยาบ ไม่สแปม`;

const DEFAULT_USER = `เขียนแคปชั่นให้คลิป "{video_title}" คลิปที่ {clip_number} จาก {total_clips} ตอน
ประเภท: {niche}
สำหรับเพจ: {page_name}`;

function PromptModal({ pages, models, prompt, onClose, onSaved, showToast }) {
  const isEdit = !!prompt;
  const [form, setForm] = useState({
    page_id: prompt?.page_id ?? null,
    system_prompt: prompt?.system_prompt ?? DEFAULT_SYSTEM,
    user_prompt: prompt?.user_prompt ?? DEFAULT_USER,
    max_tokens: prompt?.max_tokens ?? 200,
    temperature: prompt?.temperature ?? 0.8,
    selected_model: prompt?.selected_model ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${API}/api/caption-prompts/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_prompt: form.system_prompt,
          user_prompt: form.user_prompt,
          max_tokens: Number(form.max_tokens) || 200,
          temperature: Number(form.temperature) || 0.8,
          variables: {
            video_title: 'หงส์เหิรฟ้า EP.1',
            niche: 'ซีรีส์จีนย้อนยุค',
            clip_number: 1, total_clips: 4,
            page_name: form.page_id
              ? pages.find(p => p.id === form.page_id)?.name || 'เพจตัวอย่าง'
              : 'เพจตัวอย่าง'
          }
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setTestResult(data.caption || data.result || data.text || JSON.stringify(data));
    } catch (e) { showToast?.('ทดสอบไม่สำเร็จ', e.message, 'error'); }
    finally { setTesting(false); }
  };

  const save = async () => {
    if (!form.system_prompt.trim() || !form.user_prompt.trim()) {
      showToast?.('ใส่พรอมต์ให้ครบทั้งสอง', 'พรอมต์ระบบและพรอมต์ผู้ใช้ต้องไม่ว่าง', 'error');
      return;
    }
    setSaving(true);
    try {
      const url = isEdit
        ? `${API}/api/caption-prompts/${prompt.id}`
        : `${API}/api/caption-prompts`;
      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: form.page_id || null,
          system_prompt: form.system_prompt,
          user_prompt: form.user_prompt,
          max_tokens: Number(form.max_tokens) || 200,
          temperature: Number(form.temperature) || 0.8,
          selected_model: form.selected_model || null,
        })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      showToast?.(isEdit ? 'อัปเดตแล้ว' : 'สร้างแล้ว', '', 'success');
      onSaved?.();
    } catch (e) { showToast?.('บันทึกไม่สำเร็จ', e.message, 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           style={{
             background: 'var(--surface-1)', border: '1px solid var(--gold)',
             padding: 20, maxWidth: 720, width: '100%',
             maxHeight: '92vh', overflow: 'auto'
           }}>
        <div style={{ display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>
            {isEdit ? 'แก้พรอมต์' : 'สร้างพรอมต์ใหม่'}
          </div>
          <button className="btn-ghost" onClick={onClose}
                  style={{ fontSize: 14, padding: '2px 10px' }}>✕</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr',
                      gap: 10, marginBottom: 10 }}>
          <div>
            <label style={{ fontSize: 11 }}>เพจ</label>
            <select value={form.page_id || ''}
                    onChange={e => set('page_id', Number(e.target.value) || null)}
                    style={{ width: '100%', fontSize: 12, padding: '5px 8px',
                             background: 'var(--surface-2)',
                             border: '0.5px solid var(--border-faint)',
                             color: 'var(--text-primary)', marginTop: 2 }}>
              <option value="">ทุกเพจ (ทั่วไป)</option>
              {pages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11 }}>รุ่น AI</label>
            <select value={form.selected_model || ''}
                    onChange={e => set('selected_model', e.target.value)}
                    style={{ width: '100%', fontSize: 12, padding: '5px 8px',
                             background: 'var(--surface-2)',
                             border: '0.5px solid var(--border-faint)',
                             color: 'var(--text-primary)', marginTop: 2 }}>
              <option value="">— ใช้รุ่นที่ตั้งไว้ในคีย์ API —</option>
              {models.filter(m => m.available).map(m => (
                <option key={m.id} value={m.id}>{m.label} (~{m.cost_per_caption_thb?.toFixed?.(4) || '?'} ฿)</option>
              ))}
            </select>
          </div>
        </div>

        <label style={{ fontSize: 11 }}>พรอมต์ระบบ (คำสั่งหลัก)</label>
        <textarea value={form.system_prompt}
                  onChange={e => set('system_prompt', e.target.value)}
                  rows={4}
                  style={{ width: '100%', fontSize: 12, padding: '6px 8px',
                           background: 'var(--surface-2)',
                           border: '0.5px solid var(--border-faint)',
                           color: 'var(--text-primary)', marginTop: 2,
                           resize: 'vertical' }} />

        <label style={{ fontSize: 11, marginTop: 10, display: 'block' }}>
          พรอมต์ผู้ใช้ (ข้อความที่ส่งให้ AI · ใช้ตัวแปร {`{video_title}`}, {`{page_name}`} ฯลฯ)
        </label>
        <textarea value={form.user_prompt}
                  onChange={e => set('user_prompt', e.target.value)}
                  rows={4}
                  style={{ width: '100%', fontSize: 12, padding: '6px 8px',
                           background: 'var(--surface-2)',
                           border: '0.5px solid var(--border-faint)',
                           color: 'var(--text-primary)', marginTop: 2,
                           resize: 'vertical' }} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
                      gap: 10, marginTop: 10 }}>
          <div>
            <label style={{ fontSize: 11 }}>โทเคนสูงสุด</label>
            <input type="number" min="50" max="2000" value={form.max_tokens}
                   onChange={e => set('max_tokens', e.target.value)}
                   style={{ width: '100%', fontSize: 12, padding: '5px 8px',
                            background: 'var(--surface-2)',
                            border: '0.5px solid var(--border-faint)',
                            color: 'var(--text-primary)', marginTop: 2 }} />
          </div>
          <div>
            <label style={{ fontSize: 11 }}>อุณหภูมิ (0–1)</label>
            <input type="number" min="0" max="1" step="0.1" value={form.temperature}
                   onChange={e => set('temperature', e.target.value)}
                   style={{ width: '100%', fontSize: 12, padding: '5px 8px',
                            background: 'var(--surface-2)',
                            border: '0.5px solid var(--border-faint)',
                            color: 'var(--text-primary)', marginTop: 2 }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button className="btn-ghost" onClick={test} disabled={testing}
                    style={{ fontSize: 11, padding: '5px 14px', width: '100%' }}>
              {testing ? '⏳ ทดสอบ...' : '🧪 ทดสอบพรอมต์'}
            </button>
          </div>
        </div>

        {testResult && (
          <div style={{
            marginTop: 12, padding: 10,
            background: 'var(--surface-3)',
            borderLeft: '2px solid var(--success)',
            fontSize: 12, whiteSpace: 'pre-wrap'
          }}>
            <div style={{ fontSize: 10, color: 'var(--success)', marginBottom: 4 }}>✓ AI ตอบ:</div>
            {testResult}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end',
                      gap: 6, marginTop: 16 }}>
          <button className="btn-ghost" onClick={onClose} disabled={saving}
                  style={{ fontSize: 12, padding: '6px 14px' }}>ยกเลิก</button>
          <button className="btn-primary" onClick={save} disabled={saving}
                  style={{ fontSize: 12, padding: '6px 18px' }}>
            {saving ? 'กำลังบันทึก...' : '💾 บันทึก'}
          </button>
        </div>
      </div>
    </div>
  );
}
