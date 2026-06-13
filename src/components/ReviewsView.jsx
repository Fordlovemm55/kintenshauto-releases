import React, { useCallback, useEffect, useState } from 'react';
import Icon from './Icon';

const API = 'http://localhost:3003';

export default function ReviewsView({ showToast }) {
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState({});

  const refresh = useCallback(async () => {
    try {
      const data = await fetch(`${API}/api/copyright/pending`).then(r => r.json());
      setPending(Array.isArray(data) ? data : []);
    } catch (e) { console.error('reviews refresh:', e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 8000);
    return () => clearInterval(iv);
  }, [refresh]);

  const setBusyFor = (id, v) => setBusy(prev => ({ ...prev, [id]: v }));

  const retrySet2 = async (jobId) => {
    setBusyFor(jobId, 'retry');
    try {
      const res = await fetch(`${API}/api/copyright/retry-set2/${jobId}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showToast?.('สร้างงานใหม่แล้ว',
        `เปลี่ยนใช้ชุด 2 — งานใหม่ #${data.new_job_id}`, 'success');
      await refresh();
    } catch (e) { showToast?.('ลองใหม่ไม่สำเร็จ', e.message, 'error'); }
    finally { setBusyFor(jobId, null); }
  };

  const dismiss = async (jobId) => {
    if (!confirm('ยกเลิกการรอตรวจสอบ?\nงานจะกลายเป็น "ผิดพลาด" และจะไม่ลองอีก')) return;
    setBusyFor(jobId, 'dismiss');
    try {
      const res = await fetch(`${API}/api/copyright/dismiss/${jobId}`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast?.('ยกเลิกแล้ว', '', 'info');
      await refresh();
    } catch (e) { showToast?.('ยกเลิกไม่สำเร็จ', e.message, 'error'); }
    finally { setBusyFor(jobId, null); }
  };

  if (loading) {
    return <div className="panel" style={{ padding: 20, color: 'var(--text-muted)' }}>กำลังโหลด...</div>;
  }

  return (
    <div className="fade-in">
      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="label-jp">ตรวจลิขสิทธิ์</div>
            <div className="panel-title">คลิปที่รอตัดสินใจเรื่องลิขสิทธิ์</div>
            <div className="panel-subtitle">
              คลิปที่โดนเฟซบุ๊กขึ้นว่าติดลิขสิทธิ์ระหว่างโพสต์ — เลือก "ลองชุด 2" เพื่อใช้คลิปสำรอง
              หรือ "ยกเลิก" เพื่อทิ้งงาน · รีเฟรชอัตโนมัติทุก 8 วินาที
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className={`badge badge-${pending.length > 0 ? 'danger' : 'success'}`}
                  style={{ fontSize: 12, padding: '4px 12px' }}>
              {pending.length} รายการ
            </span>
            <button className="btn-ghost" onClick={refresh}
                    style={{ fontSize: 11, padding: '4px 10px' }}>
              🔄 รีเฟรช
            </button>
          </div>
        </div>

        {pending.length === 0 ? (
          <div style={{ padding: 50, textAlign: 'center', color: 'var(--text-muted)' }}>
            <Icon name="empty-reviews" className="empty-icon" size={56} />
            <div style={{ fontSize: 14, marginBottom: 4 }}>ไม่มีคลิปที่รอตรวจสอบ</div>
            <div style={{ fontSize: 11 }}>ดีมาก — คลิปทั้งหมดผ่านการตรวจลิขสิทธิ์</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {pending.map(job => (
              <ReviewCard key={job.id} job={job} busy={busy[job.id]}
                          onRetry={() => retrySet2(job.id)}
                          onDismiss={() => dismiss(job.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewCard({ job, busy, onRetry, onDismiss }) {
  const hasSet2 = !!job.set2_path;
  return (
    <div style={{
      padding: 12,
      background: 'var(--surface-2)',
      borderLeft: '3px solid var(--danger)',
      border: '0.5px solid var(--border-faint)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            ⚠ {job.video_title || `คลิป ${job.clip_id}`}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex',
                        gap: 10, flexWrap: 'wrap' }}>
            <span>📄 เพจ: <strong style={{ color: 'var(--text-secondary)' }}>{job.page_name}</strong></span>
            <span>🎬 ใช้: ชุด {job.use_set || 1}</span>
            <span>🕒 บล็อก: {formatTime(job.finished_at || job.created_at)}</span>
            {job.retry_count > 0 && <span>🔁 ลองมาแล้ว {job.retry_count} ครั้ง</span>}
          </div>
          {job.error_message && (
            <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6,
                          padding: 6, background: 'rgba(232,123,123,0.08)',
                          borderLeft: '2px solid var(--danger)' }}>
              {job.error_message}
            </div>
          )}
          {job.caption && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6,
                          padding: 6, background: 'var(--surface-3)',
                          maxHeight: 60, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              📝 {job.caption}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 130 }}>
          <button className="btn-primary"
                  onClick={onRetry}
                  disabled={!!busy || !hasSet2}
                  title={hasSet2 ? 'โพสต์ใหม่ด้วยชุด 2' : 'ยังไม่มีชุด 2 — กดเพื่อสร้างก่อน'}
                  style={{ fontSize: 12, padding: '6px 12px' }}>
            {busy === 'retry' ? '⏳ กำลังสร้าง...' : `🔄 ลองชุด ${job.use_set === 1 ? 2 : 1}`}
          </button>
          <button className="btn-ghost"
                  onClick={onDismiss}
                  disabled={!!busy}
                  style={{ fontSize: 11, padding: '5px 10px', color: 'var(--danger)' }}>
            {busy === 'dismiss' ? 'กำลังยกเลิก...' : '✕ ยกเลิก'}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatTime(d) {
  if (!d) return '—';
  const date = new Date(d);
  if (!Number.isFinite(date.getTime())) return String(d);
  const pad = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  if (isToday) return `${pad(date.getHours())}:${pad(date.getMinutes())} น.`;
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
