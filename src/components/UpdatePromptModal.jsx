import React from 'react';

/**
 * Update prompt — supports two modes:
 *   kind='soft'   non-blocking: [Later] [Update Now]
 *   kind='force'  blocking: [Download & Install] only
 *
 * Props:
 *   kind: 'soft' | 'force'
 *   info: { required_version | latest_version, release_notes_md, download_url }
 *   onUpdate(): user clicked install / download
 *   onLater(): user dismissed (only for kind='soft')
 */
export default function UpdatePromptModal({ kind, info, onUpdate, onLater }) {
  if (!info) return null;
  const isForce = kind === 'force';
  const version = isForce ? info.required_version : info.latest_version;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 10000
    }}>
      <div className="panel" style={{ maxWidth: 500, padding: 28 }}>
        <div className="kanji-title" style={{
          fontSize: 32, marginBottom: 8,
          color: isForce ? 'var(--danger)' : 'var(--gold)'
        }}>
          {isForce ? '必須更新' : '更新可能'}
        </div>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>
          {isForce ? 'Required Update' : 'Update Available'}
        </div>
        <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16 }}>
          {isForce
            ? `Your version is no longer supported. Update to ${version} to continue.`
            : `Version ${version} is ready to install.`}
        </div>
        {info.release_notes_md && (
          <div style={{
            padding: 12, marginBottom: 20, fontSize: 12,
            background: 'var(--surface-2)', border: '0.5px solid var(--border-faint)',
            whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto',
            fontFamily: 'monospace'
          }}>
            {info.release_notes_md}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {!isForce && (
            <button onClick={onLater}>Later</button>
          )}
          <button className="btn-primary" onClick={onUpdate}>
            {isForce ? 'Download & Install' : 'Update Now'}
          </button>
        </div>
      </div>
    </div>
  );
}
