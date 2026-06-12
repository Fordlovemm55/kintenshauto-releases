# Local Clips Import — Design

> Date: 2026-06-13 · Status: Draft (designed autonomously — user asleep; decisions documented for review) · Owner: KINTENSHAUTO

## 1. Goal

Let the operator post **their own clips** instead of (or alongside) the scout/channel-watcher
pipeline: pick a **folder** of video files, choose **which page(s)** to post to, click Import,
and the bot drops each clip into the posting **queue**, scheduled to the pages' peak slots.

## 2. Design decisions (made autonomously — flag any you'd change)

1. **Post clips AS-IS.** No slicing, no speed-change, no re-encode — the clip's `set1_path`
   points directly at the user's file. Rationale: these are the operator's finished clips;
   altering them would be surprising. (Banner/cover are NOT applied in v1.)
2. **Distribution across selected pages — default round-robin** (each clip → one page, spread
   evenly), with an explicit **"post every clip to every page"** option. Rationale: round-robin
   avoids duplicate-content across pages (an FB spam signal); the all-pages mode is there when
   the operator genuinely wants the same clip on each page.
3. **Caption follows each page's existing caption settings** (`captionService.generateForPage`,
   with the file name as the title). Falls back to the file name if generation returns empty,
   so the worker preflight (which needs a non-null caption) always passes.
4. **Scheduling reuses `peakSchedule.planClipSchedule`** per page — continues from the page's
   last scheduled job + its cooldown, exactly like the orchestrator, so own-clips interleave
   correctly with any scouted clips.
5. **No changes to `core/` (DO-NOT-touch).** A self-contained `services/localClips.js` does its
   own inserts, mirroring the orchestrator's clip/job insert columns. The existing worker posts
   the resulting `pending` jobs with no changes.

## 3. Data created per (file → page) assignment

- `scouted_videos`: `source='local'`, `source_url='local://<path>#<importStamp>_<i>'` (unique),
  `url_hash=sha1(source_url)`, `title=<filename without ext>`, `file_path=<user file>`,
  `file_size`, `downloaded_at=now`.
- `clips`: `scouted_id`, `clip_index=1`, `start_sec=0`, `end_sec=0` (whole file, not sliced),
  `set1_path=<user file>`, `caption=<generated or filename>`, `status='ready'`,
  `assigned_page_id=<page>`.
- `jobs`: `clip_id`, `page_id`, `scheduled_at=<peak slot>`, `use_set=1`, `status='pending'`.

(`end_sec=0` is cosmetic only — the poster uploads the whole `set1_path`; start/end are slice
bounds that don't apply to a whole-file clip.)

## 4. Architecture / units

| Unit | Responsibility |
|---|---|
| `src/backend/services/localClips.js` (new) | `scanFolder(dir)` → video files; `planAssignments(files, pageIds, mode)` → `[{file,pageId}]`; `importToQueue(db, captionService, assignments, opts)` → inserts + per-page scheduling |
| `tests/backend/services/localClips.test.js` (new) | unit-tests `scanFolder` (temp dir) + `planAssignments` (round-robin/all/short) |
| `src/backend/server.js` (modify) | `POST /api/local-clips/scan` (preview) + `POST /api/local-clips/import` |
| `tests/backend/api/local-clips.test.js` (new) | supertest: scan + import create pending jobs |
| `src/components/LocalClipsView.jsx` (new) | folder picker (IPC `showOpenDialog`), page multi-select, mode toggle, scan preview, Import |
| `src/Dashboard.jsx` (modify) | add a nav item + render the new view |

## 5. Pure functions (the tested core)

- `scanFolder(dir) → { files: [{ path, name, size }], error? }` — reads the directory, keeps
  files whose extension is in `['.mp4','.mov','.m4v','.webm','.mkv','.avi']` (case-insensitive),
  sorted by name. Non-existent dir → `{ files: [], error }`.
- `planAssignments(files, pageIds, mode) → [{ file, pageId }]`:
  - `mode==='distribute'` (default): `files[i] → pageIds[i % pageIds.length]`.
  - `mode==='all'`: every file → every page (`files × pageIds`).
  - empty files or pageIds → `[]`.

`importToQueue` groups assignments by page, computes `startFrom` from the page's last future
job + cooldown, calls `planClipSchedule(countForPage, startFrom, cooldown, customTimes)`, and
writes the rows in §3 inside one transaction per page. Returns `{ imported, perPage: {pageId:n} }`.

## 6. UI flow

1. New nav item **"เพิ่มคลิปเอง"**. The view: a **"เลือกโฟลเดอร์"** button →
   `window.kintenshauto.showOpenDialog({ properties:['openDirectory'] })` → shows the path +
   the scanned file count (calls `/api/local-clips/scan`).
2. A **page multi-select** (checkbox list from `/api/pages`).
3. A **mode** toggle: "กระจายคลิปในเพจ (แนะนำ)" / "โพสต์ทุกคลิปลงทุกเพจ".
4. **"เพิ่มเข้าคิว"** → `POST /api/local-clips/import` → toast summary
   ("เพิ่ม N คลิปเข้าคิว · เพจ A: x, เพจ B: y"). Queue view then shows the pending jobs.

## 7. Error handling

- Folder with no videos → scan returns count 0; Import button disabled.
- No page selected → Import blocked with a message.
- A file that disappears between scan and import → that insert is skipped and counted as
  `skipped` in the response (the rest still import).
- Caption generation failure for a page → fall back to the file name; never block the import.

## 8. Testing

- `scanFolder`: temp dir with mixed files → only videos returned, sorted; missing dir → error.
- `planAssignments`: distribute round-robins; all = files×pages; short pages; empty inputs.
- API: `/scan` returns count; `/import` creates the right number of `pending` jobs with
  non-null captions and future `scheduled_at` (MSW not needed — local DB only; set
  `KINTENSHAUTO_SKIP_AUTH=1`).
- Manual: pick a real folder of clips, import, confirm jobs appear in the Queue scheduled to
  peak slots, then (optionally) let one post.

## 9. Out of scope (future)

- Applying banner/cover to own clips · per-clip caption editing before queueing ·
  recursive folder scan · drag-drop files · watching the folder for new files automatically.
