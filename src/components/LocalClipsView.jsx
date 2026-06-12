import React, { useCallback, useEffect, useState } from 'react';

const API = 'http://localhost:3003';

export default function LocalClipsView({ showToast }) {
  const [folder, setFolder] = useState('');
  const [scan, setScan] = useState(null);          // { count, files, error? } | null
  const [scanning, setScanning] = useState(false);
  const [pages, setPages] = useState([]);
  const [selectedPages, setSelectedPages] = useState([]);
  const [mode, setMode] = useState('distribute');
  const [importing, setImporting] = useState(false);

  const loadPages = useCallback(async () => {
    try {
      const p = await fetch(`${API}/api/pages`).then(r => r.json()).catch(() => []);
      setPages(Array.isArray(p) ? p : []);
    } catch { setPages([]); }
  }, []);
  useEffect(() => { loadPages(); }, [loadPages]);

  const doScan = async (dir) => {
    setScanning(true);
    try {
      const res = await fetch(`${API}/api/local-clips/scan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: dir }),
      }).then(r => r.json());
      setScan(res);
      if (res.error) showToast?.('อ่านโฟลเดอร์ไม่ได้', res.error, 'error');
    } catch (e) { showToast?.('สแกนไม่สำเร็จ', e.message, 'error'); }
    finally { setScanning(false); }
  };

  const pickFolder = async () => {
    if (!window.kintenshauto?.showOpenDialog) {
      showToast?.('ใช้ในแอปเท่านั้น', 'การเลือกโฟลเดอร์ทำได้ในแอปเดสก์ท็อป', 'error');
      return;
    }
    const r = await window.kintenshauto.showOpenDialog({ properties: ['openDirectory'] });
    const dir = r?.filePaths?.[0];
    if (!dir) return;
    setFolder(dir);
    await doScan(dir);
  };

  const togglePage = (id) =>
    setSelectedPages(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const doImport = async () => {
    if (!folder) { showToast?.('เลือกโฟลเดอร์ก่อน', '', 'error'); return; }
    if (!selectedPages.length) { showToast?.('เลือกเพจอย่างน้อย 1 เพจ', '', 'error'); return; }
    setImporting(true);
    try {
      const res = await fetch(`${API}/api/local-clips/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, page_ids: selectedPages, mode }),
      }).then(r => r.json());
      if (res.error) throw new Error(res.error);
      const perPageText = Object.entries(res.perPage || {})
        .map(([pid, n]) => {
          const pg = pages.find(p => p.id === Number(pid));
          return `${pg?.name || pid}: ${n}`;
        })
        .join(' · ');
      showToast?.('เพิ่มเข้าคิวแล้ว', `${res.imported} คลิป${perPageText ? ' — ' + perPageText : ''}`, 'success');
    } catch (e) { showToast?.('เพิ่มไม่สำเร็จ', e.message, 'error'); }
    finally { setImporting(false); }
  };

  return (
    <div className="fade-in">
      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="label-jp">คลิปของฉัน</div>
            <div className="panel-title">เพิ่มคลิปของตัวเอง</div>
            <div className="panel-subtitle">
              เลือกโฟลเดอร์ที่เก็บคลิป → เลือกเพจ → บอทจะเพิ่มคลิปเข้าคิวตามเวลาพีคของแต่ละเพจ (โพสต์คลิปตามต้นฉบับ ไม่ตัด/ไม่ใส่แบนเนอร์)
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
          <button className="btn-primary" onClick={pickFolder} disabled={scanning}
                  style={{ fontSize: 12, padding: '6px 14px' }}>
            📁 เลือกโฟลเดอร์
          </button>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
            {folder || 'ยังไม่ได้เลือกโฟลเดอร์'}
          </div>
        </div>

        {scan && !scan.error && (
          <div style={{ fontSize: 13 }}>
            พบคลิป <strong>{scan.count}</strong> ไฟล์{scanning ? ' (กำลังสแกน...)' : ''}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-title" style={{ fontSize: 14, marginBottom: 8 }}>เลือกเพจที่จะลง</div>
        {pages.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            ยังไม่มีเพจ — เพิ่มเพจก่อนในหน้า "จัดการบัญชี"
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6 }}>
            {pages.map(p => (
              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
                                          padding: '6px 8px', background: 'var(--surface-2)',
                                          border: '0.5px solid var(--border-faint)', cursor: 'pointer' }}>
                <input type="checkbox" checked={selectedPages.includes(p.id)} onChange={() => togglePage(p.id)} />
                {p.name}
              </label>
            ))}
          </div>
        )}

        <div style={{ marginTop: 12, fontSize: 13 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, cursor: 'pointer' }}>
            <input type="radio" name="lcmode" checked={mode === 'distribute'} onChange={() => setMode('distribute')} />
            กระจายคลิปในเพจ (แต่ละคลิปลง 1 เพจ สลับกันไป) — แนะนำ
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="radio" name="lcmode" checked={mode === 'all'} onChange={() => setMode('all')} />
            โพสต์ทุกคลิปลงทุกเพจ
          </label>
        </div>

        <div style={{ marginTop: 14 }}>
          <button className="btn-primary" onClick={doImport}
                  disabled={importing || !folder || !scan?.count || !selectedPages.length}
                  style={{ fontSize: 13, padding: '8px 20px' }}>
            {importing ? 'กำลังเพิ่ม...' : '＋ เพิ่มเข้าคิว'}
          </button>
        </div>
      </div>
    </div>
  );
}
