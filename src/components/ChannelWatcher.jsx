import React, { useEffect, useState, useCallback } from 'react';

const API = 'http://localhost:3003';

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

const PLATFORM_LABEL = {
  youtube:  'YouTube',
  bilibili: 'Bilibili',
  tiktok:   'TikTok',
  facebook: 'Facebook',
  other:    'อื่นๆ'
};

const CONTENT_TYPE_OPTIONS = [
  { value: 'all',      label: 'ทุกคลิปทั่วไป (Videos / TikTok)' },
  { value: 'shorts',   label: 'Shorts (YouTube)' },
  { value: 'reels',    label: 'Reels (Facebook / Shorts ของ YouTube)' },
  { value: 'longform', label: 'คลิปยาว (>1 นาที)' },
  { value: 'live',     label: 'Live / Streams' }
];

function detectPlatform(url) {
  const u = (url || '').toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('bilibili.com')) return 'bilibili';
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('facebook.com') || u.includes('fb.com') || u.includes('fb.watch')) return 'facebook';
  return 'other';
}

function fmtDuration(sec) {
  if (!sec) return '-';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDateTime(s) {
  if (!s) return '-';
  return s.replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 16);
}

function timeFromNow(iso) {
  if (!iso) return '-';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  const diff = (d.getTime() - Date.now()) / 1000;
  if (isNaN(diff)) return '-';
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60);
  const hrs  = Math.round(abs / 3600);
  const txt = abs < 60 ? `${Math.round(abs)} วิ`
            : abs < 3600 ? `${mins} นาที`
            : `${hrs} ชม.`;
  return diff > 0 ? `อีก ${txt}` : `เมื่อ ${txt} ที่แล้ว`;
}

export default function ChannelWatcher({ showToast }) {
  const [channels, setChannels] = useState([]);
  const [pending, setPending]   = useState([]);
  const [pages, setPages]       = useState([]);
  const [showAdd, setShowAdd]   = useState(false);
  const [editing, setEditing]   = useState(null);
  const [busy, setBusy]         = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [c, p, pg] = await Promise.all([
        api('/api/watcher/channels').catch(() => []),
        api('/api/watcher/pending').catch(() => []),
        api('/api/pages').catch(() => [])
      ]);
      setChannels(c);
      setPending(p);
      setPages(pg);
    } catch (e) {
      console.error(e);
    }
  }, []);

  // โพลเร็วขึ้นตอนมีคลิป downloading (เพื่อ progress bar update ทัน)
  const hasDownloading = pending.some(p => p.status === 'downloading');
  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, hasDownloading ? 2500 : 12000);
    return () => clearInterval(iv);
  }, [refresh, hasDownloading]);

  const onCheckNow = async (id) => {
    setBusy(true);
    try {
      const r = await api(`/api/watcher/channels/${id}/check-now`, { method: 'POST' });
      showToast?.('เช็คแล้ว',
        r.error ? `ผิดพลาด: ${r.error}` : `เพิ่ม ${r.added || 0} คลิป (ข้าม ${r.skipped || 0})`,
        r.error ? 'danger' : 'success');
      refresh();
    } catch (e) {
      showToast?.('ผิดพลาด', e.message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  const onToggleEnabled = async (ch) => {
    try {
      await api(`/api/watcher/channels/${ch.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: ch.enabled ? 0 : 1 })
      });
      refresh();
    } catch (e) {
      showToast?.('ผิดพลาด', e.message, 'danger');
    }
  };

  const onDelete = async (ch) => {
    if (!confirm(`ลบช่อง "${ch.label}"? โฟลเดอร์คลิปที่ดาวน์โหลดแล้วจะยังอยู่`)) return;
    try {
      await api(`/api/watcher/channels/${ch.id}`, { method: 'DELETE' });
      showToast?.('ลบแล้ว', ch.label, 'success');
      refresh();
    } catch (e) {
      showToast?.('ผิดพลาด', e.message, 'danger');
    }
  };

  const onApprove = async (p) => {
    try {
      await api(`/api/watcher/pending/${p.id}/approve`, { method: 'POST' });
      showToast?.('อนุมัติแล้ว', `กำลังดาวน์โหลด: ${p.title || p.video_id}`, 'success');
      refresh();
    } catch (e) {
      showToast?.('ผิดพลาด', e.message, 'danger');
    }
  };

  const onReject = async (p) => {
    try {
      await api(`/api/watcher/pending/${p.id}/reject`, { method: 'POST' });
      refresh();
    } catch (e) {
      showToast?.('ผิดพลาด', e.message, 'danger');
    }
  };

  const onRetry = async (p) => {
    try {
      await api(`/api/watcher/pending/${p.id}/retry`, { method: 'POST' });
      refresh();
    } catch (e) {
      showToast?.('ผิดพลาด', e.message, 'danger');
    }
  };

  const onApproveAll = async () => {
    const pendingOnly = pending.filter(p => p.status === 'pending');
    if (pendingOnly.length === 0) return;
    if (!confirm(`อนุมัติทั้งหมด ${pendingOnly.length} คลิป?\nทั้งหมดจะถูกดาวน์โหลดและเตรียมลงทุกเพจที่ผูกไว้`)) return;
    setBusy(true);
    try {
      const r = await api('/api/watcher/pending/approve-all', { method: 'POST' });
      showToast?.('อนุมัติทั้งหมด',
        `สำเร็จ ${r.approved} | ข้าม ${r.skipped}`,
        r.skipped > 0 ? 'warning' : 'success');
      refresh();
    } catch (e) {
      showToast?.('ผิดพลาด', e.message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fade-in">
      {/* ===================== ช่องที่ตามดู ===================== */}
      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="label-jp">見張り · WATCHED CHANNELS</div>
            <div className="panel-title">ช่องที่บอทคอยตามดู</div>
            <div className="panel-subtitle">
              บอทเช็คทุก N ชั่วโมงตามที่ตั้ง — เจอคลิปใหม่ไหม → รอ Approve →
              ดาวน์โหลดเข้าโฟลเดอร์เฉพาะของช่องนั้น (กันคลิปปนเพจ)
            </div>
          </div>
          <button className="btn-primary" onClick={() => setShowAdd(true)}>
            ＋ เพิ่มช่อง
          </button>
        </div>

        {channels.length === 0 ? (
          <EmptyState
            jp="空"
            text="ยังไม่มีช่องที่ตามดู"
            sub='กด "＋ เพิ่มช่อง" แล้วใส่ลิงก์ช่อง YouTube / TikTok / Bilibili / Facebook'
          />
        ) : (
          <ChannelTable
            channels={channels}
            onCheckNow={onCheckNow}
            onToggleEnabled={onToggleEnabled}
            onDelete={onDelete}
            onEdit={setEditing}
            busy={busy}
          />
        )}
      </div>

      {/* ===================== คลิปรอตรวจสอบ ===================== */}
      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="label-jp">承認待ち · PENDING APPROVAL</div>
            <div className="panel-title">
              คลิปใหม่ ({pending.length})
              {pending.filter(p => p.status === 'downloading').length > 0 && (
                <span className="badge badge-info" style={{ marginLeft: 8, fontSize: 10 }}>
                  ⏬ กำลังโหลด {pending.filter(p => p.status === 'downloading').length}
                </span>
              )}
              {pending.filter(p => p.status === 'failed').length > 0 && (
                <span className="badge badge-danger" style={{ marginLeft: 4, fontSize: 10 }}>
                  ✗ ล้มเหลว {pending.filter(p => p.status === 'failed').length}
                </span>
              )}
            </div>
            <div className="panel-subtitle">
              อนุมัติ → ดาวน์โหลดเต็ม + เตรียม clip & jobs ให้ pipeline | ปฏิเสธ → ข้ามถาวร
            </div>
          </div>
          {pending.filter(p => p.status === 'pending').length > 0 && (
            <button className="btn-gold" onClick={onApproveAll} disabled={busy}>
              ✓✓ อนุมัติทั้งหมด ({pending.filter(p => p.status === 'pending').length})
            </button>
          )}
        </div>

        {pending.length === 0 ? (
          <EmptyState jp="無し" text="ไม่มีคลิปใหม่" sub="บอทจะแจ้งเมื่อเจอคลิปใหม่" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {pending.map(p => (
              <PendingCard key={p.id} p={p}
                onApprove={onApprove} onReject={onReject} onRetry={onRetry} />
            ))}
          </div>
        )}
      </div>

      {showAdd && (
        <AddChannelModal
          pages={pages}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); refresh(); showToast?.('เพิ่มช่องแล้ว', '', 'success'); }}
          showToast={showToast}
        />
      )}

      {editing && (
        <EditChannelModal
          channel={editing}
          pages={pages}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); showToast?.('บันทึกแล้ว', '', 'success'); }}
          showToast={showToast}
        />
      )}
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================

function EmptyState({ jp, text, sub }) {
  return (
    <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
      <div className="kanji-title" style={{ fontSize: 36, opacity: 0.5, marginBottom: 8 }}>{jp}</div>
      <div style={{ fontSize: 13 }}>{text}</div>
      {sub && <div style={{ fontSize: 11, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

function ChannelTable({ channels, onCheckNow, onToggleEnabled, onDelete, onEdit, busy }) {
  return (
    <div style={{ overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '0.5px solid var(--border-soft)', color: 'var(--text-muted)' }}>
            <Th>ช่อง</Th>
            <Th>แพลตฟอร์ม</Th>
            <Th>ประเภท</Th>
            <Th>เพจปลายทาง</Th>
            <Th>เช็คทุก</Th>
            <Th>เช็คล่าสุด</Th>
            <Th>เช็คถัดไป</Th>
            <Th>สถานะ</Th>
            <Th style={{ textAlign: 'right' }}>จัดการ</Th>
          </tr>
        </thead>
        <tbody>
          {channels.map(ch => (
            <tr key={ch.id} style={{ borderBottom: '0.5px solid var(--border-faint)' }}>
              <Td>
                <div style={{ fontWeight: 500 }}>{ch.label}</div>
                <a href={ch.channel_url} target="_blank" rel="noreferrer"
                   style={{ fontSize: 10, color: 'var(--text-muted)', textDecoration: 'none' }}>
                  {ch.channel_url.length > 50 ? ch.channel_url.slice(0, 50) + '…' : ch.channel_url}
                </a>
              </Td>
              <Td><span className="badge badge-info">{PLATFORM_LABEL[ch.platform] || ch.platform}</span></Td>
              <Td>{contentTypeLabel(ch.content_type)}</Td>
              <Td>
                {(ch.pages || []).length === 0
                  ? <span className="badge badge-warning">ยังไม่ผูกเพจ</span>
                  : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {ch.pages.map(p => (
                        <span key={p.id} className="badge badge-gold" style={{ fontSize: 10 }}>{p.name}</span>
                      ))}
                    </div>}
              </Td>
              <Td>{ch.interval_hours} ชม.</Td>
              <Td>{ch.last_checked_at ? fmtDateTime(ch.last_checked_at) : 'ยังไม่เคย'}</Td>
              <Td>{ch.next_check_at ? timeFromNow(ch.next_check_at) : '-'}</Td>
              <Td>
                {ch.enabled
                  ? <span className="badge badge-success">เปิด</span>
                  : <span className="badge badge-danger">ปิด</span>}
                {ch.error_count > 0 && (
                  <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 4 }}>
                    error ×{ch.error_count}
                  </div>
                )}
              </Td>
              <Td style={{ textAlign: 'right' }}>
                <button className="btn-ghost" style={{ padding: '4px 8px', fontSize: 11, marginRight: 4 }}
                        onClick={() => onCheckNow(ch.id)} disabled={busy}>เช็คเลย</button>
                <button className="btn-ghost" style={{ padding: '4px 8px', fontSize: 11, marginRight: 4 }}
                        onClick={() => onEdit(ch)}>แก้</button>
                <button className="btn-ghost" style={{ padding: '4px 8px', fontSize: 11, marginRight: 4 }}
                        onClick={() => onToggleEnabled(ch)}>{ch.enabled ? 'ปิด' : 'เปิด'}</button>
                <button className="btn-danger" style={{ padding: '4px 8px', fontSize: 11 }}
                        onClick={() => onDelete(ch)}>ลบ</button>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const Th = ({ children, style }) => (
  <th style={{ textAlign: 'left', padding: '10px 8px', fontWeight: 500, fontSize: 11, letterSpacing: 0.5, ...style }}>
    {children}
  </th>
);
const Td = ({ children, style }) => (
  <td style={{ padding: '10px 8px', verticalAlign: 'top', ...style }}>{children}</td>
);

function contentTypeLabel(t) {
  const o = CONTENT_TYPE_OPTIONS.find(x => x.value === t);
  return o ? o.label : t;
}

function PendingCard({ p, onApprove, onReject, onRetry }) {
  const status = p.status || 'pending';
  const borderColor =
    status === 'failed'      ? 'var(--danger)'
    : status === 'downloading' ? 'var(--info)'
    : 'var(--border-soft)';

  return (
    <div style={{
      background: 'var(--surface-2)', border: `0.5px solid ${borderColor}`,
      borderRadius: 'var(--radius-md)', overflow: 'hidden',
      opacity: status === 'failed' ? 0.85 : 1
    }}>
      {p.thumbnail_url ? (
        <div style={{ width: '100%', aspectRatio: '16/9', background: '#000', position: 'relative' }}>
          <img src={p.thumbnail_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
               onError={(e) => { e.target.style.display = 'none'; }} />
          {p.duration_sec > 0 && (
            <span style={{
              position: 'absolute', bottom: 6, right: 6,
              background: 'rgba(0,0,0,0.7)', color: '#fff',
              padding: '2px 6px', fontSize: 10, borderRadius: 2
            }}>{fmtDuration(p.duration_sec)}</span>
          )}
        </div>
      ) : (
        <div style={{ width: '100%', aspectRatio: '16/9', background: 'var(--surface-3)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'var(--text-muted)', fontSize: 11 }}>
          ไม่มี thumbnail
        </div>
      )}

      <div style={{ padding: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4,
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                      overflow: 'hidden' }}>
          {p.title || p.video_id}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8 }}>
          จาก: <strong>{p.channel_label}</strong>
          {p.upload_date && <> · {p.upload_date.slice(0,4)}-{p.upload_date.slice(4,6)}-{p.upload_date.slice(6,8)}</>}
        </div>
        {(p.target_pages || []).length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>จะลงเพจ:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {p.target_pages.map(pg => (
                <span key={pg.id} className="badge badge-gold" style={{ fontSize: 10 }}>{pg.name}</span>
              ))}
            </div>
          </div>
        )}

        {/* === Status-specific UI === */}
        {status === 'pending' && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-primary" style={{ flex: 1, padding: '6px 10px', fontSize: 12 }}
                    onClick={() => onApprove(p)}>✓ อนุมัติ</button>
            <button className="btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }}
                    onClick={() => onReject(p)}>✗ ปฏิเสธ</button>
            <a href={p.source_url} target="_blank" rel="noreferrer"
               className="btn-ghost" style={{ padding: '6px 10px', fontSize: 12,
                                              textDecoration: 'none', display: 'inline-block' }}>
              ดู
            </a>
          </div>
        )}

        {status === 'downloading' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between',
                          fontSize: 11, marginBottom: 4 }}>
              <span style={{ color: 'var(--info)' }}>⏬ กำลังดาวน์โหลด...</span>
              <span style={{ color: 'var(--text-secondary)' }}>{p.download_progress || 0}%</span>
            </div>
            <ProgressBar percent={p.download_progress || 0} />
          </div>
        )}

        {status === 'failed' && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--danger)', marginBottom: 6,
                          padding: 6, background: 'rgba(232,123,123,0.08)', borderRadius: 2,
                          maxHeight: 60, overflow: 'auto' }}>
              ✗ ดาวน์โหลดไม่สำเร็จ: {p.download_error || 'unknown error'}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn-ghost" style={{ flex: 1, padding: '6px 10px', fontSize: 12,
                                                      borderColor: 'var(--gold)', color: 'var(--gold)' }}
                      onClick={() => onRetry(p)}>↻ ลองใหม่</button>
              <button className="btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }}
                      onClick={() => onReject(p)}>✗ ทิ้ง</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProgressBar({ percent }) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  return (
    <div style={{
      width: '100%', height: 6, background: 'var(--surface-3)',
      borderRadius: 3, overflow: 'hidden'
    }}>
      <div style={{
        width: `${pct}%`, height: '100%',
        background: 'linear-gradient(90deg, var(--gold-dark), var(--gold))',
        transition: 'width 0.3s ease'
      }}/>
    </div>
  );
}

// ============================================================
// Modals
// ============================================================

function ChannelForm({ initial, pages, onSubmit, onCancel, submitting }) {
  const [label, setLabel]                 = useState(initial?.label || '');
  const [channelUrl, setChannelUrl]       = useState(initial?.channel_url || '');
  const [contentType, setContentType]     = useState(initial?.content_type || 'all');
  const [intervalHours, setIntervalHours] = useState(initial?.interval_hours ?? 5);
  const [minDur, setMinDur]               = useState(initial?.min_duration_sec ?? 0);
  const [maxDur, setMaxDur]               = useState(initial?.max_duration_sec ?? 0);
  const [pageIds, setPageIds]             = useState(
    initial ? (initial.pages || []).map(p => p.id) : []
  );

  const platform = detectPlatform(channelUrl);
  const isEdit = !!initial;
  const isTikTok = platform === 'tiktok';

  // TikTok ดึง "ทุกคลิป" เท่านั้น (ไม่มี Shorts/Reels/Live แยกแบบ YouTube)
  // → บังคับ content_type = 'all' อัตโนมัติเมื่อ user ใส่ลิงก์ TikTok
  useEffect(() => {
    if (isTikTok && contentType !== 'all') setContentType('all');
  }, [isTikTok, contentType]);

  const togglePage = (id) => {
    setPageIds(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  };

  const submit = (e) => {
    e.preventDefault();
    if (!label.trim()) return alert('ใส่ชื่อกำกับช่อง');
    if (!channelUrl.trim()) return alert('ใส่ลิงก์ช่อง');
    if (pageIds.length === 0) return alert('เลือกเพจปลายทางอย่างน้อย 1 เพจ');
    onSubmit({
      label: label.trim(),
      channel_url: channelUrl.trim(),
      target_page_ids: pageIds,
      content_type: contentType,
      interval_hours: Number(intervalHours),
      min_duration_sec: Number(minDur),
      max_duration_sec: Number(maxDur)
    });
  };

  return (
    <form onSubmit={submit}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label>ชื่อกำกับ <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="เช่น ช่องซีรีย์จีน A" />
        </div>
        <div>
          <label>เช็คทุกกี่ชั่วโมง <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input type="number" min="0.5" step="0.5" value={intervalHours}
                 onChange={e => setIntervalHours(e.target.value)} />
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <label>ลิงก์ช่อง <span style={{ color: 'var(--danger)' }}>*</span></label>
        <input type="url" value={channelUrl} onChange={e => setChannelUrl(e.target.value)}
               placeholder="https://www.youtube.com/@channel · https://www.tiktok.com/@user · https://vt.tiktok.com/xxxx"
               disabled={isEdit} />
        {channelUrl && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            แพลตฟอร์มที่ตรวจพบ: <span className="badge badge-info" style={{ fontSize: 10 }}>
              {PLATFORM_LABEL[platform] || platform}
            </span>
          </div>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <label>ประเภทคลิปที่จะดึง <span style={{ color: 'var(--danger)' }}>*</span></label>
        <select value={contentType} onChange={e => setContentType(e.target.value)}
                disabled={isTikTok}>
          {CONTENT_TYPE_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
          {isTikTok
            ? 'TikTok ดึงทุกคลิปวิดีโอของช่อง (ข้ามโพสต์รูปภาพ/สไลด์โชว์ให้อัตโนมัติ)'
            : 'เลือกประเภทเดียวเพื่อกันบอทดูดคลิปข้ามประเภท'}
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <label>เพจปลายทาง <span style={{ color: 'var(--danger)' }}>*</span> (เลือกได้หลายเพจ)</label>
        {pages.length === 0 ? (
          <div style={{ padding: 12, background: 'var(--surface-2)', fontSize: 12, color: 'var(--text-muted)' }}>
            ยังไม่มีเพจในระบบ — ไปเพิ่มเพจในเมนู "จัดการเฟส" ก่อน
          </div>
        ) : (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 6, padding: 8, background: 'var(--surface-2)', borderRadius: 4,
            maxHeight: 160, overflow: 'auto'
          }}>
            {pages.map(p => (
              <label key={p.id} style={{
                display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                padding: '4px 6px', fontSize: 12, marginBottom: 0,
                background: pageIds.includes(p.id) ? 'var(--surface-active)' : 'transparent',
                borderRadius: 2
              }}>
                <input type="checkbox" checked={pageIds.includes(p.id)}
                       onChange={() => togglePage(p.id)} style={{ width: 'auto' }} />
                <span style={{ flex: 1 }}>{p.name}</span>
              </label>
            ))}
          </div>
        )}
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
          เลือก {pageIds.length} เพจ — คลิปใหม่จะถูกเตรียมลงทุกเพจที่เลือกไว้
        </div>
      </div>

      <details style={{ marginTop: 12 }}>
        <summary style={{ fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          ตั้งค่าขั้นสูง (กรองความยาวคลิป)
        </summary>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
          <div>
            <label>ความยาวขั้นต่ำ (วินาที, 0 = ไม่จำกัด)</label>
            <input type="number" min="0" value={minDur} onChange={e => setMinDur(e.target.value)} />
          </div>
          <div>
            <label>ความยาวสูงสุด (วินาที, 0 = ไม่จำกัด)</label>
            <input type="number" min="0" value={maxDur} onChange={e => setMaxDur(e.target.value)} />
          </div>
        </div>
      </details>

      <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
        <button type="button" className="btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? '⏳ กำลังบันทึก...' : (isEdit ? '✓ บันทึก' : '＋ เพิ่ม + Baseline')}
        </button>
      </div>
    </form>
  );
}

function Modal({ title, subtitle, jp, onClose, children }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 2000, padding: 20
    }} onClick={onClose}>
      <div className="panel" style={{ maxWidth: 640, width: '100%', maxHeight: '90vh',
                                       overflow: 'auto', margin: 0 }}
           onClick={e => e.stopPropagation()}>
        <div className="panel-header">
          <div>
            <div className="label-jp">{jp}</div>
            <div className="panel-title">{title}</div>
            {subtitle && <div className="panel-subtitle">{subtitle}</div>}
          </div>
          <button className="btn-ghost" onClick={onClose} style={{ padding: '4px 10px' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AddChannelModal({ pages, onClose, onSaved, showToast }) {
  const [submitting, setSubmitting] = useState(false);

  const handle = async (data) => {
    setSubmitting(true);
    try {
      const ch = await api('/api/watcher/channels', { method: 'POST', body: JSON.stringify(data) });
      onSaved();
      // R7: addChannel สร้าง channel เสมอ แม้ baseline (ดึงคลิปครั้งแรก) ล้มเหลว
      // → ถ้ามี error เตือนให้ user รู้ว่าช่องถูกเพิ่มแต่ยังดึงคลิปไม่ได้ (เช่น ลิงก์ผิด/ช่องส่วนตัว)
      if (ch && ch.error_count > 0 && ch.last_error) {
        showToast?.('เพิ่มช่องแล้ว แต่ดึงคลิปครั้งแรกไม่สำเร็จ', ch.last_error, 'warning');
      }
    } catch (e) {
      showToast?.('เพิ่มไม่สำเร็จ', e.message, 'danger');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="เพิ่มช่องใหม่" jp="新規追加"
           subtitle='ใส่ลิงก์ช่อง + เลือกเพจ + ประเภทคลิป — บอทจะ baseline แล้วเริ่มตามดูทันที'
           onClose={onClose}>
      <ChannelForm pages={pages} onSubmit={handle} onCancel={onClose} submitting={submitting} />
    </Modal>
  );
}

function EditChannelModal({ channel, pages, onClose, onSaved, showToast }) {
  const [submitting, setSubmitting] = useState(false);

  const handle = async (data) => {
    setSubmitting(true);
    try {
      // อย่าส่ง channel_url ตอนแก้ (immutable เพราะผูกกับ folder)
      const { channel_url, ...patch } = data;
      await api(`/api/watcher/channels/${channel.id}`, {
        method: 'PUT', body: JSON.stringify(patch)
      });
      onSaved();
    } catch (e) {
      showToast?.('บันทึกไม่สำเร็จ', e.message, 'danger');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title={`แก้ไข: ${channel.label}`} jp="編集"
           subtitle="แก้ไขประเภทคลิป / interval / เพจปลายทาง (ลิงก์ช่องเปลี่ยนไม่ได้)"
           onClose={onClose}>
      <ChannelForm initial={channel} pages={pages} onSubmit={handle}
                   onCancel={onClose} submitting={submitting} />
    </Modal>
  );
}
