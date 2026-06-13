import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ClipPreviewModal from './ClipPreviewModal';
import Icon from './Icon';

const FRESH_DURATION_MS = 15000; // job pulses + shows "ใหม่" badge for 15s

const API = 'http://localhost:3003';

const STATUS_LABEL = {
  pending: 'รอคิว',
  processing: 'กำลังเตรียมคลิป',
  running: 'กำลังโพสต์',
  posted: 'โพสต์เสร็จแล้ว',
  failed: 'ผิดพลาด',
  cancelled: 'ยกเลิก',
  copyright_waiting: 'ติดลิขสิทธิ์',
};

const STATUS_BADGE = (s) => {
  if (s === 'posted') return 'success';
  if (s === 'running') return 'gold';
  if (s === 'pending') return 'warning';
  if (s === 'processing') return 'info';
  if (s === 'failed' || s === 'copyright_waiting') return 'danger';
  return 'muted';
};

export default function QueueView({ showToast }) {
  const [groups, setGroups] = useState([]);
  const [worker, setWorker] = useState({ paused: false, pausedUntil: null });
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState(new Set());
  const [editingPageId, setEditingPageId] = useState(null);
  const [previewJob, setPreviewJob] = useState(null);
  const [previewClip, setPreviewClip] = useState(null);
  const [previewPageName, setPreviewPageName] = useState(null);
  const [previewVideoTitle, setPreviewVideoTitle] = useState(null);

  // "Fresh" tracking — items that just appeared since the last refresh get a
  // pulsing border + "✨ ใหม่" badge for 15s so users notice them when the
  // queue is long. On first mount we seed the seen-set silently so existing
  // items don't all flash at once.
  const seenJobIdsRef = useRef(null);
  const [freshJobs, setFreshJobs] = useState(() => new Set());

  const markFresh = useCallback((newIds) => {
    if (!newIds.length) return;
    const setter = setFreshJobs;
    setter(prev => {
      const next = new Set(prev);
      for (const id of newIds) next.add(id);
      return next;
    });
    // Drop the fresh flag after FRESH_DURATION_MS — clip can still be
    // looked up normally, just no longer pulsing
    setTimeout(() => {
      setter(prev => {
        const next = new Set(prev);
        for (const id of newIds) next.delete(id);
        return next;
      });
    }, FRESH_DURATION_MS);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [g, w] = await Promise.all([
        fetch(`${API}/api/queue/grouped`).then(r => r.json()).catch(() => []),
        fetch(`${API}/api/worker/status`).then(r => r.json()).catch(() => ({})),
      ]);
      const groupsArr = Array.isArray(g) ? g : [];

      // Diff job IDs vs the seen-set from the previous tick
      const currentJobIds = new Set();
      for (const pg of groupsArr) for (const s of pg.sets) for (const j of s.jobs) {
        currentJobIds.add(j.job_id);
      }
      if (seenJobIdsRef.current === null) {
        // First-mount seed — don't flash anything, just record what's here
        seenJobIdsRef.current = currentJobIds;
      } else {
        const newJobIds = [];
        for (const id of currentJobIds) {
          if (!seenJobIdsRef.current.has(id)) newJobIds.push(id);
        }
        for (const id of newJobIds) seenJobIdsRef.current.add(id);
        markFresh(newJobIds);
      }

      setGroups(groupsArr);
      setWorker(w || {});
    } catch (e) { console.error('queue refresh:', e); }
  }, [markFresh]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 5000);
    return () => clearInterval(iv);
  }, [refresh]);

  const totals = useMemo(() => {
    let clips = 0, sets = 0, pending = 0, running = 0, posted = 0, failed = 0, nextAt = null;
    for (const p of groups) {
      sets += p.set_count;
      for (const s of p.sets) {
        for (const j of s.jobs) {
          clips++;
          if (j.status === 'pending') {
            pending++;
            if (j.scheduled_at) {
              const t = new Date(j.scheduled_at).getTime();
              if (Number.isFinite(t) && (!nextAt || t < nextAt)) nextAt = t;
            }
          } else if (j.status === 'running') running++;
          else if (j.status === 'posted') posted++;
          else if (j.status === 'failed') failed++;
        }
      }
    }
    return { clips, sets, pending, running, posted, failed, nextAt };
  }, [groups]);

  const filteredGroups = useMemo(() => {
    if (filter === 'all') return groups;
    return groups.map(p => ({
      ...p,
      sets: p.sets.map(s => ({
        ...s,
        jobs: s.jobs.filter(j => j.status === filter),
      })).filter(s => s.jobs.length > 0),
    })).filter(p => p.sets.length > 0);
  }, [groups, filter]);

  const togglePage = (id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      const key = `page-${id}`;
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const toggleSet = (sid) => {
    setExpanded(prev => {
      const next = new Set(prev);
      const key = `set-${sid}`;
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const pauseAction = async (minutes) => {
    try {
      await fetch(`${API}/api/worker/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes }),
      });
      showToast?.('หยุดแล้ว', minutes > 0 ? `หยุด ${minutes} นาที` : 'หยุดไม่มีกำหนด', 'warning');
      await refresh();
    } catch { showToast?.('ผิดพลาด', 'หยุดไม่สำเร็จ', 'error'); }
  };
  const resumeAction = async () => {
    try {
      await fetch(`${API}/api/worker/resume`, { method: 'POST' });
      showToast?.('กลับมาทำงาน', 'ระบบโพสต์ทำงานต่อ', 'success');
      await refresh();
    } catch { showToast?.('ผิดพลาด', 'กลับมาทำงานไม่สำเร็จ', 'error'); }
  };

  const pauseCountdown = useCountdown(worker.pausedUntil);
  const nextPostCountdown = useCountdown(totals.nextAt);

  const filters = [
    { key: 'all', th: 'ทั้งหมด' },
    { key: 'pending', th: 'รอคิว' },
    { key: 'running', th: 'กำลังโพสต์' },
    { key: 'posted', th: 'สำเร็จ' },
    { key: 'failed', th: 'ผิดพลาด' },
    { key: 'cancelled', th: 'ยกเลิก' },
  ];

  return (
    <div className="fade-in">
      {/* HEADER BAR — worker status + pause controls */}
      <div className="panel" style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            {worker.paused ? (
              <span className="badge badge-danger" style={{ fontSize: 13, padding: '4px 12px' }}>
                ⏸ ระบบหยุดอยู่{worker.pausedUntil && pauseCountdown ? ` · เหลือ ${pauseCountdown}` : ''}
              </span>
            ) : (
              <span className="badge badge-success" style={{ fontSize: 13, padding: '4px 12px' }}>
                ▶ ระบบโพสต์กำลังทำงาน
              </span>
            )}
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              <strong>☷ รอคิว {totals.pending}</strong>
              {' · '}🔄 กำลังโพสต์ {totals.running}
              {' · '}<span style={{ color: 'var(--success)' }}>✓ วันนี้โพสต์แล้ว {worker.posted_today ?? totals.posted}</span>
              {' · '}<span style={{ color: 'var(--danger)' }}>✗ ล้มเหลว {totals.failed}</span>
            </span>
          </div>
          <div className="queue-pause-group">
            {worker.paused ? (
              <button className="btn-primary" style={{ fontSize: 12, padding: '6px 14px' }}
                      onClick={resumeAction}>▶ ทำงานต่อ</button>
            ) : (
              <>
                <button className="btn-ghost" style={{ fontSize: 12, padding: '6px 12px' }}
                        onClick={() => pauseAction(0)}>⏸ หยุดไม่มีกำหนด</button>
                <button className="btn-ghost" style={{ fontSize: 12, padding: '6px 12px' }}
                        onClick={() => pauseAction(30)}>⏸ พัก 30 นาที</button>
                <button className="btn-ghost" style={{ fontSize: 12, padding: '6px 12px' }}
                        onClick={() => pauseAction(180)}>⏸ พัก 3 ชม.</button>
              </>
            )}
          </div>
        </div>

        {/* Next post indicator */}
        {!worker.paused && totals.nextAt && (
          <div style={{
            marginTop: 10, padding: 8,
            background: 'var(--surface-2)', borderLeft: '2px solid var(--gold)',
            fontSize: 12, display: 'flex', justifyContent: 'space-between'
          }}>
            <span>📤 <strong>โพสต์ถัดไป:</strong> {formatDate(totals.nextAt)}</span>
            <span style={{ color: 'var(--gold)' }}>
              {nextPostCountdown ? `อีก ${nextPostCountdown}` : 'กำลังโพสต์...'}
            </span>
          </div>
        )}
      </div>

      {/* Pending approvals live in the Channel Watcher overlay — that is the
          authoritative approve/reject UI. We only point users there. */}
      <div style={{
        marginBottom: 12, padding: '8px 12px',
        background: 'var(--surface-2)', borderLeft: '3px solid var(--info)',
        borderRadius: 4, fontSize: 11, color: 'var(--text-muted)'
      }}>
        ℹ️ คลิปที่รออนุมัติ ดูได้ที่เมนู "ตามช่องอัตโนมัติ"
      </div>

      {/* QUEUE BODY */}
      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="label-jp">คิวงาน</div>
            <div className="panel-title">
              คิวงาน — จัดเป็นเซ็ตตามเรื่อง
              {freshJobs.size > 0 && (
                <span className="queue-fresh-pill"
                      onClick={() => {
                        // Scroll to the first fresh row
                        const el = document.querySelector('.queue-fresh-row');
                        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }}>
                  ✨ มี {freshJobs.size} คลิปใหม่ — คลิกเพื่อเลื่อนไปดู
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              ทั้งหมด {totals.clips} คลิป · {totals.sets} เซ็ต · รีเฟรชอัตโนมัติทุก 5 วินาที
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={filter} onChange={e => setFilter(e.target.value)}
                    style={{ fontSize: 12, padding: '4px 8px',
                             background: 'var(--surface-2)', color: 'var(--text-primary)',
                             border: '1px solid var(--border-faint)' }}>
              {filters.map(f => <option key={f.key} value={f.key}>{f.th}</option>)}
            </select>
          </div>
        </div>

        {filteredGroups.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            <Icon name="empty-queue" className="empty-icon" size={56} />
            <div style={{ fontSize: 13 }}>ยังไม่มีงานในคิว</div>
          </div>
        ) : (
          filteredGroups.map(page => (
            <PageGroup
              key={page.page_id ?? 'orphan'}
              page={page}
              expanded={expanded}
              toggleSet={toggleSet}
              editingPageId={editingPageId}
              setEditingPageId={setEditingPageId}
              showToast={showToast}
              refresh={refresh}
              freshJobs={freshJobs}
              onPreview={(job, set) => {
                setPreviewJob(job);
                setPreviewClip({ id: job.clip_id, clip_index: job.clip_index,
                                 caption: job.caption, set1_path: job.set1_path,
                                 set2_path: job.set2_path });
                setPreviewPageName(page.page_name);
                setPreviewVideoTitle(set.video_title);
              }}
            />
          ))
        )}
      </div>

      {previewJob && (
        <ClipPreviewModal
          job={previewJob}
          clip={previewClip}
          pageName={previewPageName}
          videoTitle={previewVideoTitle}
          onClose={() => { setPreviewJob(null); setPreviewClip(null); }}
          onSaved={async () => { await refresh(); }}
          showToast={showToast}
        />
      )}
    </div>
  );
}

function PageGroup({ page, expanded, toggleSet, editingPageId, setEditingPageId,
                     showToast, refresh, onPreview, freshJobs }) {
  const noSchedule = page.post_times.length === 0;
  // Has any fresh clip inside this page? Used to auto-expand its sets so the
  // pulse is visible without the user manually clicking ▶
  const pageHasFreshJob = page.sets.some(s => s.jobs.some(j => freshJobs?.has(j.job_id)));
  return (
    <div style={{ borderBottom: '1px solid var(--border-faint)', padding: '14px 0' }}>
      {/* Page header — name + counts + ⚙ button */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', padding: '0 4px 6px', flexWrap: 'wrap', gap: 8
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ width: 6, height: 18, background: 'var(--danger)', borderRadius: 1 }} />
          <strong style={{ fontSize: 14 }}>{page.page_name}</strong>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {page.sets.length} เรื่อง · {page.total_clips} คลิป · โพสต์แล้ว {page.posted_clips}/{page.total_clips}
          </span>
          {pageHasFreshJob && (
            <span className="queue-fresh-badge" style={{ position: 'static' }}>✨ คลิปใหม่</span>
          )}
        </div>
        <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 10px' }}
                onClick={() => setEditingPageId(editingPageId === page.page_id ? null : page.page_id)}
                aria-label={`แก้ตั้งค่าเพจ ${page.page_name}`}>
          {editingPageId === page.page_id ? '✕ ปิด' : '⚙ แก้ตั้งค่า'}
        </button>
      </div>

      {/* Always-visible schedule strip — daily quota + post times.
          When unscheduled, show a friendly inline warning banner. */}
      {noSchedule ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', margin: '0 4px 8px',
          background: 'var(--warning-bg, var(--surface-2))',
          border: '1px solid var(--warning)',
          borderRadius: 8, fontSize: 11, color: 'var(--text-secondary)'
        }}>
          <span style={{ fontSize: 14, lineHeight: 1 }}>⚠️</span>
          <span>
            ยังไม่ได้ตั้งเวลาโพสต์ — คลิปจะไม่เข้าคิว · กด <strong>⚙ แก้ตั้งค่า</strong> ด้านขวาเพื่อตั้งเวลา
          </span>
        </div>
      ) : (
        <div style={{
          padding: '6px 10px', margin: '0 4px 8px',
          background: 'var(--surface-2)',
          border: '0.5px solid var(--border-faint)',
          borderRadius: 4, fontSize: 11
        }}>
          <span style={{ color: 'var(--gold)' }}>📅 ลงวันละ {page.daily_quota} คลิป</span>
          <span style={{ color: 'var(--text-muted)', margin: '0 6px' }}>·</span>
          <span style={{ color: 'var(--text-secondary)' }}>
            เวลาโพสต์: {page.post_times.join(' · ')}
          </span>
        </div>
      )}

      {editingPageId === page.page_id && (
        <PageSettingsEditor page={page} showToast={showToast}
                            onSaved={() => { setEditingPageId(null); refresh(); }} />
      )}

      {/* Sets (scouted_videos) */}
      {page.sets.map(set => {
        // Auto-open the set if it has any fresh clip — saves the user a click
        const setHasFreshJob = set.jobs.some(j => freshJobs?.has(j.job_id));
        const setOpen = expanded.has(`set-${set.scouted_id}`) || setHasFreshJob;
        const earliest = set.jobs[0]?.scheduled_at;
        return (
          <div key={set.scouted_id ?? Math.random()}
               className={setHasFreshJob ? 'queue-fresh-row' : ''}
               style={{
                 margin: '6px 0', padding: 10,
                 background: 'var(--surface-2)', border: '0.5px solid var(--border-faint)',
                 borderRadius: 4, position: 'relative'
               }}>
            <div style={{ display: 'flex', justifyContent: 'space-between',
                          alignItems: 'flex-start', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                   onClick={() => toggleSet(set.scouted_id)}>
                <div style={{ fontSize: 13, fontWeight: 500,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {setOpen ? '▼' : '▶'} 📺 {set.video_title}
                  <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)', fontWeight: 'normal' }}>
                    คลิป 1-{set.jobs.length} ({set.jobs.length} คลิป)
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  {earliest && <>🕒 เข้าวันที่ {formatDate(earliest)} · </>}
                  <span className="badge badge-success" style={{ fontSize: 10, padding: '1px 6px' }}>
                    ✓ โพสต์แล้ว {set.posted_count}/{set.jobs.length}
                  </span>
                </div>
              </div>
              {setHasFreshJob && <span className="queue-fresh-badge">✨ ใหม่</span>}
            </div>

            {/* Per-clip rows when expanded */}
            {setOpen && (
              <div style={{ marginTop: 10, borderTop: '0.5px solid var(--border-faint)', paddingTop: 8 }}>
                {set.jobs.map(j => (
                  <ClipRow key={j.job_id} job={j} onPreview={() => onPreview(j, set)}
                           showToast={showToast} refresh={refresh}
                           isFresh={freshJobs?.has(j.job_id)} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ClipRow({ job, onPreview, showToast, refresh, isFresh }) {
  const [busy, setBusy] = useState(false);
  const isPending = job.status === 'pending';
  const isRunning = job.status === 'running';
  const isFailable = job.status === 'failed' || job.status === 'cancelled';

  const action = async (path, opts = {}) => {
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/jobs/${job.job_id}${path}`,
        { method: opts.method || 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast?.('สำเร็จ', opts.successMsg || 'อัปเดตคิวแล้ว', 'success');
      await refresh();
    } catch (e) { showToast?.('ผิดพลาด', e.message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className={isFresh ? 'queue-fresh-row' : ''}
         style={{
           padding: '6px 8px', display: 'grid',
           gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center',
           borderBottom: '0.5px solid var(--border-faint)',
           position: 'relative'
         }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>
        ตอน {job.clip_index}
        {isFresh && <span className="queue-fresh-badge"
                          style={{ position: 'static', marginLeft: 6 }}>✨ ใหม่</span>}
      </div>
      <div style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className={`badge badge-${STATUS_BADGE(job.status)}`} style={{ fontSize: 10 }}>
          {STATUS_LABEL[job.status] || job.status}
        </span>
        {job.fb_post_id && (
          <span style={{ fontSize: 10, color: 'var(--success)' }}>
            ✓ เฟซบุ๊ก: {job.fb_post_id.slice(0, 20)}...
          </span>
        )}
        {job.error_message && (
          <span style={{ fontSize: 10, color: 'var(--danger)' }}>{job.error_message}</span>
        )}
      </div>
      <div className="btn-row-dense" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }}
                onClick={onPreview} title="ดู / แก้แคปชั่น" aria-label={`ดูคลิป ตอน ${job.clip_index}`}>👁 ดู</button>
        {isPending && (
          <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }}
                  disabled={busy}
                  onClick={() => action('/post-now', { successMsg: 'สั่งโพสต์ทันที' })}>
            โพสต์เลย
          </button>
        )}
        {isRunning && (
          <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px', color: 'var(--danger)' }}
                  disabled={busy}
                  onClick={() => action('/kill', { successMsg: 'หยุดแล้ว' })}>
            หยุด
          </button>
        )}
        {isFailable && (
          <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }}
                  disabled={busy}
                  onClick={() => action('/retry', { successMsg: 'จะลองใหม่' })}>
            ลองใหม่
          </button>
        )}
        <button className="btn-ghost"
                style={{ fontSize: 11, padding: '3px 8px', color: 'var(--text-muted)' }}
                disabled={busy}
                onClick={() => {
                  if (!confirm('ลบงานนี้?')) return;
                  action('', { method: 'DELETE', successMsg: 'ลบแล้ว' });
                }}>✕</button>
      </div>
    </div>
  );
}

function PageSettingsEditor({ page, showToast, onSaved }) {
  const [quota, setQuota] = useState(page.daily_quota || 5);
  const [times, setTimes] = useState(
    page.post_times.length ? page.post_times : ['07:00', '12:30', '18:00', '20:00', '22:00']
  );
  const [saving, setSaving] = useState(false);

  const updateTime = (i, val) => {
    setTimes(prev => prev.map((t, idx) => idx === i ? val : t));
  };
  const addTime = () => setTimes(prev => [...prev, '12:00']);
  const removeTime = (i) => setTimes(prev => prev.filter((_, idx) => idx !== i));

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API}/api/pages/${page.page_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          daily_quota: Number(quota) || 5,
          post_times: times.filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast?.('บันทึกแล้ว', `${page.page_name}: ${quota}/วัน · ${times.length} เวลา`, 'success');
      onSaved?.();
    } catch (e) {
      showToast?.('ผิดพลาด', e.message, 'error');
    } finally { setSaving(false); }
  };

  return (
    <div style={{ padding: 12, margin: '6px 0', background: 'var(--surface-2)',
                  border: '0.5px solid var(--gold)', borderRadius: 4 }}>
      <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 8 }}>
        ตั้งค่าเพจ: {page.page_name}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <label style={{ fontSize: 12, minWidth: 110 }}>คลิปต่อวัน:</label>
        <input type="number" min="1" max="24" value={quota}
               onChange={e => setQuota(e.target.value)}
               style={{ width: 60, fontSize: 12, padding: '3px 6px' }} />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          (ระบบจะลงคลิปวันละ {quota} ครั้ง)
        </span>
      </div>
      <div style={{ fontSize: 12, marginBottom: 6 }}>
        เวลาโพสต์ในแต่ละวัน:
        <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          ใส่ได้สูงสุด 24 เวลา · คลิปใหม่จะลงคิวที่เวลาว่างวันถัดไป
        </span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
        รูปแบบ 24 ชั่วโมง (00:00–23:59) — เช่น 14:30 = บ่าย 2 ครึ่ง · 20:00 = 2 ทุ่ม
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        {times.map((t, i) => (
          <TimePicker24 key={i} value={t}
                        onChange={(v) => updateTime(i, v)}
                        onRemove={() => removeTime(i)} />
        ))}
        <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 10px' }}
                onClick={addTime}>+ เพิ่มเวลา</button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={onSaved} disabled={saving}>ยกเลิก</button>
        <button className="btn-primary" style={{ fontSize: 12, padding: '4px 14px' }}
                onClick={save} disabled={saving}>
          {saving ? 'กำลังบันทึก...' : '💾 บันทึก'}
        </button>
      </div>
    </div>
  );
}

// 24-hour HH:MM picker using two <select>s. <input type="time"> falls back
// to OS locale on Chromium and shows AM/PM on English Windows — explicit
// hour + minute selects guarantee 24-hour everywhere.
function TimePicker24({ value, onChange, onRemove }) {
  const safe = /^(\d{1,2}):(\d{1,2})$/.exec(value || '');
  const hour = safe ? String(Math.min(23, parseInt(safe[1], 10))).padStart(2, '0') : '12';
  const minute = safe ? String(Math.min(59, parseInt(safe[2], 10))).padStart(2, '0') : '00';
  const set = (h, m) => onChange(`${h}:${m}`);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2,
                  background: 'var(--surface-1)',
                  border: '0.5px solid var(--border-faint)', padding: '1px 4px' }}>
      <select value={hour} onChange={e => set(e.target.value, minute)}
              style={{ fontSize: 12, padding: '2px 4px', border: 'none',
                       background: 'transparent', color: 'var(--text-primary)' }}>
        {Array.from({ length: 24 }, (_, h) => {
          const v = String(h).padStart(2, '0');
          return <option key={v} value={v}>{v}</option>;
        })}
      </select>
      <span style={{ color: 'var(--text-muted)' }}>:</span>
      <select value={minute} onChange={e => set(hour, e.target.value)}
              style={{ fontSize: 12, padding: '2px 4px', border: 'none',
                       background: 'transparent', color: 'var(--text-primary)' }}>
        {Array.from({ length: 60 }, (_, m) => {
          const v = String(m).padStart(2, '0');
          return <option key={v} value={v}>{v}</option>;
        })}
      </select>
      <button className="btn-ghost"
              style={{ fontSize: 11, padding: '2px 6px',
                       color: 'var(--danger)', border: 'none' }}
              onClick={onRemove} title="ลบเวลานี้">✕</button>
    </div>
  );
}

// ---- helpers ----
function useCountdown(targetMs) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!targetMs) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [targetMs]);
  if (!targetMs) return null;
  const diff = targetMs - now;
  if (diff <= 0) return null;
  const totalSec = Math.floor(diff / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h} ชม. ${m} น.`;
  if (m > 0) return `${m} น. ${s} วิ`;
  return `${s} วิ`;
}

function formatDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(date.getTime())) return String(d);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
