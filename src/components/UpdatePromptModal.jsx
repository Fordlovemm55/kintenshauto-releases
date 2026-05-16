import React, { useEffect } from 'react';

/**
 * Update prompt — three lifecycle stages driven by `phase`:
 *   'prompt'      Initial — buttons [Later] [Update Now] (force hides Later)
 *   'downloading' Progress bar with %, MB/s, fraction
 *   'downloaded'  [Install & Restart] — quitAndInstall via electron-updater
 *   'error'       Shows error message + [Retry] / [Later] buttons
 *
 * Props:
 *   kind: 'soft' | 'force'
 *   info: { required_version | latest_version, release_notes_md, download_url }
 *   phase: 'prompt' | 'downloading' | 'downloaded' | 'error'
 *   progress: { percent, transferred, total, bytesPerSecond } | null
 *   errorMessage: string | null
 *   onUpdate(): user clicked "Update Now" → start download
 *   onInstall(): user clicked "Install & Restart" → quitAndInstall
 *   onLater(): user dismissed (only for kind='soft' + phase='prompt'|'error')
 *   onRetry(): user clicked Retry after an error
 */
export default function UpdatePromptModal({
  kind, info, phase = 'prompt', progress, errorMessage,
  onUpdate, onInstall, onLater, onRetry
}) {
  // ESC closes soft updates (force updates ignore ESC — user must update)
  useEffect(() => {
    if (kind === 'force') return;
    const handler = (e) => { if (e.key === 'Escape' && onLater) onLater(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [kind, onLater]);

  if (!info) return null;
  const isForce = kind === 'force';
  const version = isForce ? info.required_version : info.latest_version;

  const formatMB = (b) => (b / 1024 / 1024).toFixed(1);
  const formatSpeed = (bps) => {
    if (!bps) return '';
    if (bps > 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
    return `${(bps / 1024).toFixed(0)} KB/s`;
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="update-modal-title"
         style={{
           position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
           display: 'flex', alignItems: 'center', justifyContent: 'center',
           padding: 16, zIndex: 10000
         }}>
      <div className="panel" style={{ width: '100%', maxWidth: 520, padding: 28 }}
           id="update-modal-title">
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

        {/* Release notes — only shown in prompt phase to keep transient phases compact */}
        {phase === 'prompt' && info.release_notes_md && (
          <div style={{
            padding: 12, marginBottom: 20, fontSize: 12,
            background: 'var(--surface-2)', border: '0.5px solid var(--border-faint)',
            whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto',
            fontFamily: 'monospace'
          }}>
            {info.release_notes_md}
          </div>
        )}

        {/* Progress bar */}
        {phase === 'downloading' && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between',
                          fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
              <span>Downloading…</span>
              <span>
                {progress ? `${formatMB(progress.transferred)} / ${formatMB(progress.total)} MB` : ''}
                {progress?.bytesPerSecond ? `  ·  ${formatSpeed(progress.bytesPerSecond)}` : ''}
              </span>
            </div>
            <div style={{
              height: 8, background: 'var(--surface-2)',
              border: '0.5px solid var(--border-faint)', overflow: 'hidden'
            }}>
              <div style={{
                width: `${Math.max(0, Math.min(100, progress?.percent || 0))}%`,
                height: '100%',
                background: 'var(--gold)',
                transition: 'width 0.2s ease-out'
              }} />
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-secondary)', textAlign: 'right' }}>
              {progress?.percent != null ? `${progress.percent.toFixed(1)}%` : ''}
            </div>
          </div>
        )}

        {/* Downloaded — ready to install */}
        {phase === 'downloaded' && (
          <div style={{
            padding: 12, marginBottom: 20, fontSize: 13,
            background: 'var(--surface-2)', border: '0.5px solid var(--border-faint)',
            color: 'var(--text-secondary)'
          }}>
            Update downloaded. The app will close, install the update, and reopen automatically.
          </div>
        )}

        {/* Error */}
        {phase === 'error' && (
          <div style={{
            padding: 12, marginBottom: 20, fontSize: 13,
            background: 'var(--surface-2)', border: '0.5px solid var(--danger)',
            color: 'var(--danger)'
          }}>
            Update failed: {errorMessage || 'unknown error'}
          </div>
        )}

        {/* Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {phase === 'prompt' && (
            <>
              {!isForce && <button onClick={onLater}>Later</button>}
              <button className="btn-primary" onClick={onUpdate}>
                {isForce ? 'Download & Install' : 'Update Now'}
              </button>
            </>
          )}
          {phase === 'downloaded' && (
            <button className="btn-primary" onClick={onInstall}>
              Install &amp; Restart
            </button>
          )}
          {phase === 'error' && (
            <>
              {!isForce && <button onClick={onLater}>Later</button>}
              <button className="btn-primary" onClick={onRetry}>Retry</button>
            </>
          )}
          {/* phase === 'downloading' → no buttons; user must wait */}
        </div>
      </div>
    </div>
  );
}
