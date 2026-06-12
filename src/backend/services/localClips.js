// Local Clips Import — post the operator's own video files instead of scouted/downloaded ones.
// Self-contained: scans a folder, assigns clips to pages, and writes scouted_videos/clips/jobs
// mirroring the orchestrator's insert columns. Does NOT touch core/ behavior.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { planClipSchedule, toSqlLocal } = require('../core/peakSchedule');

const VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'];

// List the video files in a folder (non-recursive), sorted by name.
function scanFolder(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = entries
      .filter(e => e.isFile() && VIDEO_EXTS.includes(path.extname(e.name).toLowerCase()))
      .map(e => {
        const p = path.join(dir, e.name);
        let size = 0;
        try { size = fs.statSync(p).size; } catch { /* ignore */ }
        return { path: p, name: e.name, size };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { files };
  } catch (e) {
    return { files: [], error: e.message };
  }
}

// Map files to pages. 'distribute' = round-robin (1 clip -> 1 page); 'all' = every clip -> every page.
function planAssignments(files, pageIds, mode = 'distribute') {
  if (!files?.length || !pageIds?.length) return [];
  const out = [];
  if (mode === 'all') {
    for (const file of files) for (const pageId of pageIds) out.push({ file, pageId });
  } else {
    files.forEach((file, i) => out.push({ file, pageId: pageIds[i % pageIds.length] }));
  }
  return out;
}

// Insert scouted_videos + clips + jobs for each assignment, scheduling per page into peak slots.
// captionService is used per page settings (falls back to the file name). Returns counts.
async function importToQueue(db, captionService, assignments, opts = {}) {
  const stamp = opts.stamp || Date.now();

  const byPage = new Map();
  assignments.forEach((a, i) => {
    if (!byPage.has(a.pageId)) byPage.set(a.pageId, []);
    byPage.get(a.pageId).push({ ...a, globalIndex: i });
  });

  let imported = 0;
  let skipped = 0;
  const perPage = {};

  for (const [pageId, items] of byPage) {
    const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId);
    if (!page) { skipped += items.length; continue; }

    const cooldownMin = page.cooldown_min || 30;
    const last = db.prepare(`
      SELECT MAX(scheduled_at) AS t FROM jobs
      WHERE page_id = ? AND status IN ('pending','running','posted','processing','copyright_waiting')
        AND datetime(scheduled_at) > datetime('now','localtime','-1 day')
    `).get(pageId);
    let startFrom;
    if (last?.t) {
      const lastDate = new Date(last.t.replace(' ', 'T'));
      startFrom = new Date(Math.max(Date.now(), lastDate.getTime() + cooldownMin * 60 * 1000));
    } else {
      startFrom = new Date();
    }
    let customTimes;
    try { if (page.post_times) customTimes = JSON.parse(page.post_times); } catch { /* ignore */ }

    const schedule = planClipSchedule(items.length, startFrom, cooldownMin, customTimes);

    for (let i = 0; i < items.length; i++) {
      const { file, globalIndex } = items[i];
      if (!fs.existsSync(file.path)) { skipped++; continue; }

      const title = path.basename(file.name, path.extname(file.name));
      let caption = '';
      try {
        caption = await captionService.generateForPage(pageId, {
          videoTitle: title, clipNumber: 1, totalClips: items.length,
        });
      } catch { caption = ''; }
      if (!caption || !String(caption).trim()) caption = title;

      const sourceUrl = `local://${file.path}#${stamp}_${globalIndex}`;
      const urlHash = crypto.createHash('sha1').update(sourceUrl).digest('hex').slice(0, 16);
      let size = file.size || 0;
      try { size = fs.statSync(file.path).size; } catch { /* ignore */ }

      const tx = db.transaction(() => {
        const sv = db.prepare(`
          INSERT INTO scouted_videos (source, source_url, url_hash, title, file_path, file_size, keyword, downloaded_at)
          VALUES ('local', ?, ?, ?, ?, ?, 'local', datetime('now','localtime'))
        `).run(sourceUrl, urlHash, title, file.path, size);
        const clip = db.prepare(`
          INSERT INTO clips (scouted_id, clip_index, start_sec, end_sec, set1_path, caption, status, assigned_page_id)
          VALUES (?, 1, 0, 0, ?, ?, 'ready', ?)
        `).run(sv.lastInsertRowid, file.path, caption, pageId);
        db.prepare(`
          INSERT INTO jobs (clip_id, page_id, scheduled_at, use_set, status)
          VALUES (?, ?, ?, 1, 'pending')
        `).run(clip.lastInsertRowid, pageId, toSqlLocal(schedule[i].date));
      });
      tx();
      imported++;
      perPage[pageId] = (perPage[pageId] || 0) + 1;
    }
  }
  return { imported, skipped, perPage };
}

module.exports = { scanFolder, planAssignments, importToQueue, VIDEO_EXTS };
