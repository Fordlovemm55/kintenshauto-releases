// Shared settings primitives used by both SettingsView (system settings) and
// AICaptionsView (caption + cover settings). Keeps the key/value load+save logic
// and the row/save-bar UI in one place so the two screens don't duplicate it.
import React, { useEffect, useMemo, useState } from 'react';

const API = 'http://localhost:3003';

// Load a subset of key/value settings and track unsaved edits.
// `keys` is the list of setting keys this form owns; only changed keys are PUT on save.
export function useSettings(keys, showToast) {
  const keyStr = keys.join(',');
  const allKeys = useMemo(() => keyStr.split(',').filter(Boolean), [keyStr]);

  const [values, setValues] = useState({});
  const [originalValues, setOriginalValues] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rows = await fetch(`${API}/api/settings`).then(r => r.json());
        const map = {};
        for (const r of (Array.isArray(rows) ? rows : [])) map[r.key] = r.value;
        const init = {};
        for (const k of allKeys) init[k] = map[k] ?? '';
        if (!alive) return;
        setValues(init);
        setOriginalValues(init);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
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

  return { values, originalValues, setOne, isDirty, loading, saving, saveAll, resetAll };
}

// Renders one setting based on its declared type (toggle/select/textarea/number/text).
export function SettingRow({ item, value, onChange }) {
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

// Sticky bottom bar showing dirty state + save/reset for a useSettings form.
export function SaveBar({ isDirty, saving, onSave, onReset }) {
  return (
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
        <button className="btn-ghost" onClick={onReset} disabled={!isDirty || saving}
                style={{ fontSize: 12, padding: '6px 14px' }}>
          ↩ ย้อนกลับ
        </button>
        <button className="btn-primary" onClick={onSave} disabled={!isDirty || saving}
                style={{ fontSize: 12, padding: '6px 18px' }}>
          {saving ? 'กำลังบันทึก...' : '💾 บันทึกทั้งหมด'}
        </button>
      </div>
    </div>
  );
}
