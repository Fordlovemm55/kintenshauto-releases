import React, { useCallback, useEffect, useMemo, useState } from 'react';

const API = 'http://localhost:3003';

export default function CommentsView({ showToast }) {
  const [pages, setPages] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [selectedPageId, setSelectedPageId] = useState(null);
  const [pageSettings, setPageSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(null);

  const refreshAll = useCallback(async () => {
    try {
      const [pgs, tpls] = await Promise.all([
        fetch(`${API}/api/pages`).then(r => r.json()).catch(() => []),
        fetch(`${API}/api/comment-templates`).then(r => r.json()).catch(() => []),
      ]);
      setPages(Array.isArray(pgs) ? pgs : []);
      setTemplates(Array.isArray(tpls) ? tpls : []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  const loadPageSettings = async (pageId) => {
    if (!pageId) return setPageSettings(null);
    try {
      const data = await fetch(`${API}/api/comment-settings/${pageId}`).then(r => r.json());
      setPageSettings(data);
    } catch { setPageSettings(null); }
  };

  useEffect(() => {
    if (selectedPageId) loadPageSettings(selectedPageId);
  }, [selectedPageId]);

  const deleteTemplate = async (id) => {
    if (!confirm('ลบข้อความตัวอย่างนี้?')) return;
    try {
      await fetch(`${API}/api/comment-templates/${id}`, { method: 'DELETE' });
      showToast?.('ลบแล้ว', '', 'info');
      await refreshAll();
    } catch (e) { showToast?.('ลบไม่สำเร็จ', e.message, 'error'); }
  };

  const filteredTemplates = useMemo(() => {
    if (!selectedPageId) return templates;
    return templates.filter(t => t.page_id === selectedPageId || t.page_id === null);
  }, [templates, selectedPageId]);

  if (loading) {
    return <div className="panel" style={{ padding: 20, color: 'var(--text-muted)' }}>กำลังโหลด...</div>;
  }

  return (
    <div className="fade-in">
      {/* Per-page settings */}
      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="label-jp">言霊 · COMMENT SETTINGS</div>
            <div className="panel-title">ตั้งค่าคอมเม้นต่อเพจ</div>
            <div className="panel-subtitle">
              เลือกเพจเพื่อตั้งค่าการคอมเม้นอัตโนมัติ — หยุดเมื่อโพสต์ครบ / รอเวลา / ปักหมุด
            </div>
          </div>
          <select value={selectedPageId || ''}
                  onChange={e => setSelectedPageId(Number(e.target.value) || null)}
                  style={{ fontSize: 12, padding: '6px 10px',
                           background: 'var(--surface-2)',
                           border: '0.5px solid var(--border-faint)',
                           color: 'var(--text-primary)', minWidth: 220 }}>
            <option value="">— เลือกเพจ —</option>
            {pages.filter(p => p.enabled !== 0).map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {!selectedPageId ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>
            เลือกเพจที่ต้องการตั้งค่า
          </div>
        ) : !pageSettings ? (
          <div style={{ padding: 30, color: 'var(--text-muted)' }}>กำลังโหลด...</div>
        ) : (
          <PageCommentSettings
            pageId={selectedPageId}
            settings={pageSettings}
            onSaved={() => loadPageSettings(selectedPageId)}
            showToast={showToast}
          />
        )}
      </div>

      {/* Templates */}
      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="label-jp">雛形 · TEMPLATES</div>
            <div className="panel-title">
              ข้อความคอมเม้น ({filteredTemplates.length})
              {selectedPageId && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>
                  สำหรับ "{pages.find(p => p.id === selectedPageId)?.name}" + ทั่วไป
                </span>
              )}
            </div>
            <div className="panel-subtitle">
              ใช้ตัวแปร {`{video_title}`}, {`{page_name}`}, {`{clip_number}`} ในข้อความ — ระบบจะแทนค่าให้
            </div>
          </div>
          <button className="btn-primary"
                  onClick={() => setShowCreate(true)}
                  style={{ fontSize: 12, padding: '6px 14px' }}>
            ＋ เพิ่มข้อความ
          </button>
        </div>

        {filteredTemplates.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 13 }}>ยังไม่มีข้อความ — กด "＋ เพิ่มข้อความ" เพื่อเริ่ม</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filteredTemplates.map(t => (
              <TemplateRow key={t.id} template={t} pages={pages}
                           onEdit={() => setEditing(t)}
                           onDelete={() => deleteTemplate(t.id)} />
            ))}
          </div>
        )}
      </div>

      {(showCreate || editing) && (
        <TemplateModal
          pages={pages}
          template={editing}
          defaultPageId={selectedPageId}
          onClose={() => { setShowCreate(false); setEditing(null); }}
          onSaved={async () => {
            setShowCreate(false);
            setEditing(null);
            await refreshAll();
          }}
          showToast={showToast}
        />
      )}
    </div>
  );
}

function PageCommentSettings({ pageId, settings, onSaved, showToast }) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setDraft(settings); }, [settings]);

  const set = (k, v) => setDraft(prev => ({ ...prev, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API}/api/comment-settings/${pageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: draft.enabled ? 1 : 0,
          delay_sec: Number(draft.delay_sec) || 0,
          jitter_sec: Number(draft.jitter_sec) || 0,
          max_per_day: Number(draft.max_per_day) || 0,
          cooldown_min: Number(draft.cooldown_min) || 0,
          enable_self_reply: draft.enable_self_reply ? 1 : 0,
          enable_pin: draft.enable_pin ? 1 : 0,
          detect_removal: draft.detect_removal ? 1 : 0,
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast?.('บันทึกแล้ว', '', 'success');
      onSaved?.();
    } catch (e) { showToast?.('บันทึกไม่สำเร็จ', e.message, 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ padding: 8 }}>
      <Toggle label="เปิดใช้งานคอมเม้นอัตโนมัติ" checked={!!draft.enabled}
              onChange={v => set('enabled', v)} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                    gap: 12, marginTop: 12 }}>
        <NumberField label="หน่วงก่อนคอมเม้น (วินาที)" value={draft.delay_sec}
                     onChange={v => set('delay_sec', v)} placeholder="30"
                     hint="หลังโพสต์เสร็จจะรอกี่วินาทีก่อนคอมเม้น" />
        <NumberField label="สุ่มเพิ่ม +/- (วินาที)" value={draft.jitter_sec}
                     onChange={v => set('jitter_sec', v)} placeholder="15"
                     hint="เพิ่มความสุ่มไม่ให้เหมือนบอท" />
        <NumberField label="คอมเม้นสูงสุดต่อวัน" value={draft.max_per_day}
                     onChange={v => set('max_per_day', v)} placeholder="0 = ไม่จำกัด" />
        <NumberField label="พักระหว่างคอมเม้น (นาที)" value={draft.cooldown_min}
                     onChange={v => set('cooldown_min', v)} placeholder="0" />
      </div>

      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Toggle label="ตอบกลับตัวเอง (chain replies)"
                checked={!!draft.enable_self_reply}
                onChange={v => set('enable_self_reply', v)} />
        <Toggle label="ปักหมุดคอมเม้นบนสุด"
                checked={!!draft.enable_pin}
                onChange={v => set('enable_pin', v)} />
        <Toggle label="ตรวจจับเมื่อ FB ลบคอมเม้น (แล้วแจ้งเตือน)"
                checked={!!draft.detect_removal}
                onChange={v => set('detect_removal', v)} />
      </div>

      <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn-primary" onClick={save} disabled={saving}
                style={{ fontSize: 12, padding: '6px 18px' }}>
          {saving ? 'กำลังบันทึก...' : '💾 บันทึกการตั้งค่า'}
        </button>
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10,
                    cursor: 'pointer', fontSize: 12 }}>
      <input type="checkbox" checked={checked}
             onChange={e => onChange(e.target.checked)} />
      <span style={{ color: checked ? 'var(--success)' : 'var(--text-secondary)' }}>{label}</span>
    </label>
  );
}

function NumberField({ label, value, onChange, placeholder, hint }) {
  return (
    <div>
      <label style={{ fontSize: 11 }}>{label}</label>
      <input type="number" value={value ?? ''}
             onChange={e => onChange(e.target.value)}
             placeholder={placeholder}
             style={{ width: '100%', fontSize: 12, padding: '5px 8px',
                      background: 'var(--surface-2)',
                      border: '0.5px solid var(--border-faint)',
                      color: 'var(--text-primary)', marginTop: 2 }} />
      {hint && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function TemplateRow({ template, pages, onEdit, onDelete }) {
  const pageName = template.page_id
    ? (pages.find(p => p.id === template.page_id)?.name || `เพจ #${template.page_id}`)
    : 'ทุกเพจ (ทั่วไป)';
  return (
    <div style={{
      padding: 10, background: 'var(--surface-2)',
      border: '0.5px solid var(--border-faint)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <strong style={{ fontSize: 13 }}>{template.label || '(ไม่มีชื่อ)'}</strong>
            <span className={`badge ${template.page_id ? 'badge-gold' : 'badge-info'}`}
                  style={{ fontSize: 10 }}>
              {pageName}
            </span>
            {template.weight > 1 && (
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>น้ำหนัก ×{template.weight}</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)',
                        background: 'var(--surface-3)', padding: '6px 8px',
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        maxHeight: 80, overflow: 'auto' }}>
            {template.content || '(ว่าง)'}
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

function TemplateModal({ pages, template, defaultPageId, onClose, onSaved, showToast }) {
  const [form, setForm] = useState({
    label: template?.label || '',
    content: template?.content || '',
    weight: template?.weight ?? 1,
    page_id: template?.page_id ?? defaultPageId ?? null,
  });
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const doPreview = async () => {
    setPreviewLoading(true);
    try {
      const data = await fetch(`${API}/api/comment-templates/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: form.content,
          context: {
            video_title: 'หงส์เหิรฟ้า EP.1',
            page_name: form.page_id
              ? pages.find(p => p.id === form.page_id)?.name || 'เพจตัวอย่าง'
              : 'เพจตัวอย่าง',
            clip_number: 1,
            total_clips: 4
          }
        })
      }).then(r => r.json());
      setPreview(typeof data === 'string' ? data : (data.preview || data.content || JSON.stringify(data)));
    } catch (e) { showToast?.('preview ไม่สำเร็จ', e.message, 'error'); }
    finally { setPreviewLoading(false); }
  };

  const save = async () => {
    if (!form.content.trim()) {
      showToast?.('ใส่ข้อความก่อน', '', 'error');
      return;
    }
    setSaving(true);
    try {
      const url = template
        ? `${API}/api/comment-templates/${template.id}`
        : `${API}/api/comment-templates`;
      const res = await fetch(url, {
        method: template ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: form.page_id || null,
          label: form.label || null,
          content: form.content,
          weight: Number(form.weight) || 1,
        })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      showToast?.(template ? 'อัปเดตแล้ว' : 'เพิ่มแล้ว', '', 'success');
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
             padding: 20, maxWidth: 580, width: '100%',
             maxHeight: '90vh', overflow: 'auto'
           }}>
        <div style={{ display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>
            {template ? 'แก้ข้อความคอมเม้น' : 'เพิ่มข้อความคอมเม้น'}
          </div>
          <button className="btn-ghost" onClick={onClose}
                  style={{ fontSize: 14, padding: '2px 10px' }}>✕</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr',
                      gap: 10, marginBottom: 10 }}>
          <div>
            <label style={{ fontSize: 11 }}>ชื่อย่อ (ทางเลือก)</label>
            <input value={form.label} onChange={e => set('label', e.target.value)}
                   placeholder="เช่น greeting"
                   style={{ width: '100%', fontSize: 12, padding: '5px 8px',
                            background: 'var(--surface-2)',
                            border: '0.5px solid var(--border-faint)',
                            color: 'var(--text-primary)', marginTop: 2 }} />
          </div>
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
        </div>

        <label style={{ fontSize: 11 }}>ข้อความ</label>
        <textarea value={form.content} onChange={e => set('content', e.target.value)}
                  rows={5}
                  placeholder="คอมเม้นแบบไหน? ใช้ตัวแปร {video_title} {page_name} {clip_number}"
                  style={{ width: '100%', fontSize: 12, padding: '6px 8px',
                           background: 'var(--surface-2)',
                           border: '0.5px solid var(--border-faint)',
                           color: 'var(--text-primary)',
                           marginTop: 2, resize: 'vertical' }} />

        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={{ fontSize: 11 }}>น้ำหนัก (1 = ปกติ, 2+ = ออกบ่อยขึ้น)</label>
            <input type="number" min="1" max="10" value={form.weight}
                   onChange={e => set('weight', e.target.value)}
                   style={{ width: '100%', fontSize: 12, padding: '5px 8px',
                            background: 'var(--surface-2)',
                            border: '0.5px solid var(--border-faint)',
                            color: 'var(--text-primary)', marginTop: 2 }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button className="btn-ghost" onClick={doPreview}
                    disabled={previewLoading || !form.content.trim()}
                    style={{ fontSize: 11, padding: '5px 14px' }}>
              {previewLoading ? '⏳ โหลด...' : '👁 ลองดูตัวอย่าง'}
            </button>
          </div>
        </div>

        {preview && (
          <div style={{
            marginTop: 10, padding: 8,
            background: 'var(--surface-3)',
            borderLeft: '2px solid var(--gold)',
            fontSize: 12, whiteSpace: 'pre-wrap'
          }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>ตัวอย่าง:</div>
            {preview}
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
