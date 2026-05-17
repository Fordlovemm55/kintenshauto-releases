import React, { useCallback, useEffect, useMemo, useState } from 'react';

const API = 'http://localhost:3003';

const POSITION_PRESETS = [
  { key: 'top-left',     label: '↖ บน-ซ้าย',    x: 15, y: 15 },
  { key: 'top-center',   label: '↑ บน-กลาง',    x: 50, y: 15 },
  { key: 'top-right',    label: '↗ บน-ขวา',    x: 85, y: 15 },
  { key: 'center-left',  label: '← กลาง-ซ้าย', x: 15, y: 50 },
  { key: 'center',       label: '● กลาง',      x: 50, y: 50 },
  { key: 'center-right', label: '→ กลาง-ขวา', x: 85, y: 50 },
  { key: 'bottom-left',  label: '↙ ล่าง-ซ้าย', x: 15, y: 85 },
  { key: 'bottom-center',label: '↓ ล่าง-กลาง', x: 50, y: 85 },
  { key: 'bottom-right', label: '↘ ล่าง-ขวา', x: 85, y: 85 },
];

export default function BannersView({ showToast }) {
  const [banners, setBanners] = useState([]);
  const [presets, setPresets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [b, p] = await Promise.all([
        fetch(`${API}/api/banners`).then(r => r.json()).catch(() => []),
        fetch(`${API}/api/banner-presets`).then(r => r.json()).catch(() => []),
      ]);
      setBanners(Array.isArray(b) ? b : []);
      setPresets(Array.isArray(p) ? p : []);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const uploadBanner = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast?.('ไฟล์ไม่ถูกต้อง', 'รองรับเฉพาะรูปภาพ (PNG / JPG / WebP)', 'error');
      return;
    }
    setUploading(true);
    try {
      const data_base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = data_base64;
      });
      const res = await fetch(`${API}/api/banners`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: file.name,
          data_base64,
          width: img.naturalWidth,
          height: img.naturalHeight,
        })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      showToast?.('อัปโหลดแล้ว', file.name, 'success');
      await refresh();
    } catch (e) { showToast?.('อัปโหลดไม่สำเร็จ', e.message, 'error'); }
    finally { setUploading(false); }
  };

  const deleteBanner = async (id) => {
    if (!confirm('ลบรูปแบนเนอร์นี้?\nชุดที่ใช้รูปนี้อาจหายไปด้วย')) return;
    try {
      await fetch(`${API}/api/banners/${id}`, { method: 'DELETE' });
      showToast?.('ลบแล้ว', '', 'info');
      await refresh();
    } catch (e) { showToast?.('ลบไม่สำเร็จ', e.message, 'error'); }
  };

  const deletePreset = async (id) => {
    if (!confirm('ลบชุดแบนเนอร์นี้?')) return;
    try {
      await fetch(`${API}/api/banner-presets/${id}`, { method: 'DELETE' });
      showToast?.('ลบแล้ว', '', 'info');
      await refresh();
    } catch (e) { showToast?.('ลบไม่สำเร็จ', e.message, 'error'); }
  };

  if (loading) {
    return <div className="panel" style={{ padding: 20, color: 'var(--text-muted)' }}>กำลังโหลด...</div>;
  }

  return (
    <div className="fade-in">
      {/* Banner images library */}
      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="label-jp">旗 · BANNERS</div>
            <div className="panel-title">รูปแบนเนอร์ที่อัปโหลด ({banners.length})</div>
            <div className="panel-subtitle">
              อัปโหลดรูป PNG / JPG ที่มีพื้นหลังโปร่งใส (ถ้าต้องการ) — ระบบจะนำไปวางทับคลิปตามชุดที่ตั้งไว้
            </div>
          </div>
          <label className="btn-primary" style={{ cursor: 'pointer', fontSize: 12, padding: '6px 14px' }}>
            {uploading ? '⏳ กำลังอัปโหลด...' : '＋ อัปโหลดรูป'}
            <input type="file" accept="image/*"
                   style={{ display: 'none' }}
                   disabled={uploading}
                   onChange={e => uploadBanner(e.target.files?.[0])} />
          </label>
        </div>

        {banners.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 13 }}>ยังไม่มีรูปแบนเนอร์ — กด "＋ อัปโหลดรูป" เพื่อเริ่ม</div>
          </div>
        ) : (
          <div style={{ display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
            {banners.map(b => (
              <BannerCard key={b.id} banner={b} onDelete={() => deleteBanner(b.id)} />
            ))}
          </div>
        )}
      </div>

      {/* Banner presets */}
      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="label-jp">構成 · PRESETS</div>
            <div className="panel-title">ชุดแบนเนอร์ ({presets.length})</div>
            <div className="panel-subtitle">
              ชุดที่กำหนดว่ารูปไหนวางที่ตำแหน่งไหน — แต่ละเพจเลือกใช้ชุดเดียวกัน
            </div>
          </div>
          <button className="btn-primary"
                  onClick={() => setShowCreate(true)}
                  disabled={banners.length === 0}
                  style={{ fontSize: 12, padding: '6px 14px' }}>
            ＋ สร้างชุดใหม่
          </button>
        </div>

        {presets.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 13 }}>ยังไม่มีชุดแบนเนอร์</div>
            <div style={{ fontSize: 11, marginTop: 4 }}>
              {banners.length === 0
                ? 'อัปโหลดรูปก่อน แล้วถึงสร้างชุดได้'
                : 'กด "＋ สร้างชุดใหม่" เพื่อเลือกรูปและตำแหน่ง'}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {presets.map(p => (
              <PresetRow key={p.id} preset={p} banners={banners}
                         onDelete={() => deletePreset(p.id)} />
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <CreatePresetModal
          banners={banners}
          onClose={() => setShowCreate(false)}
          onSaved={async () => { setShowCreate(false); await refresh(); }}
          showToast={showToast}
        />
      )}
    </div>
  );
}

function BannerCard({ banner, onDelete }) {
  const src = `file://${banner.file_path.replace(/\\/g, '/')}`;
  return (
    <div style={{
      position: 'relative',
      background: 'var(--surface-2)', border: '0.5px solid var(--border-faint)',
      padding: 8, display: 'flex', flexDirection: 'column', gap: 6
    }}>
      <div style={{
        height: 100, background: '#1a1a1f',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backgroundImage: 'linear-gradient(45deg, #1a1a1f 25%, transparent 25%, transparent 75%, #1a1a1f 75%), linear-gradient(45deg, #1a1a1f 25%, #222 25%, #222 75%, #1a1a1f 75%)',
        backgroundSize: '12px 12px', backgroundPosition: '0 0, 6px 6px',
      }}>
        <img src={src} alt={banner.name}
             style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
             onError={(e) => { e.currentTarget.style.display = 'none'; }} />
      </div>
      <div style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {banner.name}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
        {banner.width_px}×{banner.height_px}px
      </div>
      <button className="btn-ghost"
              onClick={onDelete}
              style={{ fontSize: 11, padding: '3px 8px', color: 'var(--danger)' }}>
        🗑 ลบ
      </button>
    </div>
  );
}

function PresetRow({ preset, banners, onDelete }) {
  const layers = preset.layers || [];
  const firstBanner = banners.find(b => b.id === layers[0]?.banner_id);
  return (
    <div style={{
      padding: 12, background: 'var(--surface-2)',
      border: '0.5px solid var(--border-faint)',
      display: 'flex', justifyContent: 'space-between',
      alignItems: 'center', gap: 12
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
        {firstBanner && (
          <div style={{ width: 60, height: 40, background: '#222', flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <img src={`file://${firstBanner.file_path.replace(/\\/g, '/')}`}
                 alt="" style={{ maxWidth: '100%', maxHeight: '100%' }} />
          </div>
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{preset.name}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {layers.length} ชั้น
            {layers[0] && <> · ตำแหน่งหลัก: {layers[0].position?.x ?? '?'}%, {layers[0].position?.y ?? '?'}%</>}
          </div>
        </div>
      </div>
      <button className="btn-ghost" onClick={onDelete}
              style={{ fontSize: 11, padding: '4px 10px', color: 'var(--danger)' }}>
        🗑 ลบ
      </button>
    </div>
  );
}

function CreatePresetModal({ banners, onClose, onSaved, showToast }) {
  const [name, setName] = useState('');
  const [layers, setLayers] = useState([
    { banner_id: banners[0]?.id ?? null, position: { x: 50, y: 50 }, size: { width: 30 }, opacity: 100 }
  ]);
  const [saving, setSaving] = useState(false);

  const updateLayer = (i, patch) =>
    setLayers(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l));

  const addLayer = () =>
    setLayers(prev => [...prev,
      { banner_id: banners[0]?.id ?? null, position: { x: 50, y: 50 }, size: { width: 30 }, opacity: 100 }]);

  const removeLayer = (i) =>
    setLayers(prev => prev.filter((_, idx) => idx !== i));

  const save = async () => {
    if (!name.trim()) {
      showToast?.('ใส่ชื่อชุด', 'ตั้งชื่อก่อนบันทึก', 'error');
      return;
    }
    const valid = layers.filter(l => l.banner_id);
    if (!valid.length) {
      showToast?.('เลือกรูปก่อน', 'ต้องมีอย่างน้อย 1 ชั้น', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API}/api/banner-presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), layers: valid })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showToast?.('สร้างแล้ว', `ชุด "${name}" พร้อมใช้`, 'success');
      onSaved?.();
    } catch (e) { showToast?.('สร้างไม่สำเร็จ', e.message, 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           style={{
             background: 'var(--surface-1)',
             border: '1px solid var(--gold)',
             padding: 20, maxWidth: 700, width: '100%',
             maxHeight: '90vh', overflow: 'auto'
           }}>
        <div style={{ display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>สร้างชุดแบนเนอร์ใหม่</div>
          <button className="btn-ghost" onClick={onClose}
                  style={{ fontSize: 14, padding: '2px 10px' }}>✕</button>
        </div>

        <label style={{ fontSize: 12, fontWeight: 500 }}>ชื่อชุด</label>
        <input type="text" value={name} onChange={e => setName(e.target.value)}
               placeholder="เช่น แบนเนอร์ซีรีย์จีน"
               style={{ width: '100%', fontSize: 13, padding: '6px 10px',
                        background: 'var(--surface-2)', border: '0.5px solid var(--border-faint)',
                        color: 'var(--text-primary)', marginTop: 4, marginBottom: 14 }} />

        <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>
          ชั้นแบนเนอร์ ({layers.length})
        </div>
        {layers.map((layer, i) => (
          <LayerEditor key={i} index={i} layer={layer} banners={banners}
                       onChange={patch => updateLayer(i, patch)}
                       onRemove={() => removeLayer(i)}
                       canRemove={layers.length > 1} />
        ))}
        <button className="btn-ghost" onClick={addLayer}
                style={{ fontSize: 11, padding: '6px 14px', marginTop: 6 }}>
          ＋ เพิ่มชั้น
        </button>

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

function LayerEditor({ index, layer, banners, onChange, onRemove, canRemove }) {
  return (
    <div style={{
      padding: 10, marginBottom: 8,
      background: 'var(--surface-2)', border: '0.5px solid var(--border-faint)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 12 }}>ชั้น {index + 1}</strong>
        {canRemove && (
          <button className="btn-ghost" onClick={onRemove}
                  style={{ fontSize: 10, padding: '2px 8px', color: 'var(--danger)' }}>
            ✕ ลบชั้น
          </button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label style={{ fontSize: 11 }}>รูปแบนเนอร์</label>
          <select value={layer.banner_id || ''}
                  onChange={e => onChange({ banner_id: Number(e.target.value) || null })}
                  style={{ width: '100%', fontSize: 12, padding: '4px 6px',
                           background: 'var(--surface-1)', border: '0.5px solid var(--border-faint)',
                           color: 'var(--text-primary)' }}>
            <option value="">— เลือกรูป —</option>
            {banners.map(b => (
              <option key={b.id} value={b.id}>{b.name} ({b.width_px}×{b.height_px})</option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11 }}>ตำแหน่งสำเร็จรูป</label>
          <select onChange={e => {
            const p = POSITION_PRESETS.find(x => x.key === e.target.value);
            if (p) onChange({ position: { x: p.x, y: p.y } });
          }} value=""
                  style={{ width: '100%', fontSize: 12, padding: '4px 6px',
                           background: 'var(--surface-1)', border: '0.5px solid var(--border-faint)',
                           color: 'var(--text-primary)' }}>
            <option value="">— ปรับด่วน —</option>
            {POSITION_PRESETS.map(p => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: 10, marginTop: 8 }}>
        <NumField label="X (%)" value={layer.position?.x ?? 50} min={0} max={100}
                  onChange={v => onChange({ position: { ...layer.position, x: v } })} />
        <NumField label="Y (%)" value={layer.position?.y ?? 50} min={0} max={100}
                  onChange={v => onChange({ position: { ...layer.position, y: v } })} />
        <NumField label="กว้าง (%)" value={layer.size?.width ?? 30} min={1} max={100}
                  onChange={v => onChange({ size: { width: v } })} />
        <NumField label="ความทึบ (%)" value={layer.opacity ?? 100} min={0} max={100}
                  onChange={v => onChange({ opacity: v })} />
      </div>
    </div>
  );
}

function NumField({ label, value, min, max, onChange }) {
  return (
    <div>
      <label style={{ fontSize: 11 }}>{label}</label>
      <input type="number" value={value} min={min} max={max}
             onChange={e => onChange(Number(e.target.value) || 0)}
             style={{ width: '100%', fontSize: 12, padding: '4px 6px',
                      background: 'var(--surface-1)',
                      border: '0.5px solid var(--border-faint)',
                      color: 'var(--text-primary)' }} />
    </div>
  );
}
