-- ============================================================
-- KINTENSHAUTO Database Schema v2
-- รองรับ: multi-layer banner, manual Set 2, multi AI provider,
--         auto-comment templates, copyright blacklist
-- ============================================================

-- ---------- 1. PROFILES (เฟส Facebook) ----------
CREATE TABLE IF NOT EXISTS profiles (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,               -- ชื่อกำกับ เช่น "เฟสหลัก 1"
    fb_username     TEXT NOT NULL,
    fb_password     TEXT NOT NULL,               -- encrypted
    fb_2fa_secret   TEXT,                        -- encrypted, nullable
    proxy_type      TEXT DEFAULT 'http',         -- http | socks5
    proxy_host      TEXT,
    proxy_port      INTEGER,
    proxy_user      TEXT,
    proxy_pass      TEXT,                        -- encrypted
    fingerprint     TEXT,                        -- JSON: ua, canvas, webgl, tz, resolution
    user_data_dir   TEXT NOT NULL,               -- path สำหรับ Chrome แยกต่อเฟส
    status          TEXT DEFAULT 'idle',         -- idle | active | blocked | checkpoint
    last_login_at   DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------- 2. PAGES (เพจของแต่ละเฟส) ----------
CREATE TABLE IF NOT EXISTS pages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id      INTEGER NOT NULL,
    fb_page_id      TEXT NOT NULL,
    name            TEXT NOT NULL,
    avatar_url      TEXT,
    daily_quota     INTEGER DEFAULT 5,           -- คลิปต่อวัน default
    cooldown_min    INTEGER DEFAULT 30,          -- นาทีระหว่างโพสต์
    niche           TEXT,                        -- เช่น "ซีรีย์จีน" ใช้กับ AI prompt
    enabled         INTEGER DEFAULT 1,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- Plan 2 sync columns
    cloud_uuid      TEXT UNIQUE,
    cloud_synced_at DATETIME,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at      DATETIME,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- ---------- 3. BANNER LIBRARY ----------
CREATE TABLE IF NOT EXISTS banners (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,               -- "โลโก้ Telegram"
    file_path       TEXT NOT NULL,               -- path รูป
    width_px        INTEGER,
    height_px       INTEGER,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- Plan 2 sync columns
    cloud_uuid      TEXT UNIQUE,
    cloud_synced_at DATETIME,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at      DATETIME
);

-- ---------- 4. BANNER PRESETS (config การวาง) ----------
CREATE TABLE IF NOT EXISTS banner_presets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,               -- "Telegram + โปรโมท ฿99"
    layers_json     TEXT NOT NULL,               -- array ของ layer config (unlimited)
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- Plan 2 sync columns
    cloud_uuid      TEXT UNIQUE,
    cloud_synced_at DATETIME,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at      DATETIME
);
-- layers_json structure:
-- [
--   {
--     "banner_id": 1,
--     "z_index": 1,
--     "position": {"x": 15, "y": 68},     -- %
--     "size": {"width": 70},               -- % of frame width
--     "opacity": 100,
--     "rotation": 0,
--     "timing": {"start": 0, "end": -1, "fade_in": 300, "fade_out": 300}
--   }
-- ]

-- ---------- 5. COMMENT TEMPLATES ----------
CREATE TABLE IF NOT EXISTS comment_templates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id         INTEGER,                     -- NULL = ใช้กับทุกเพจ
    label           TEXT,                        -- "Template 1"
    content         TEXT NOT NULL,               -- ข้อความ + variables
    enabled         INTEGER DEFAULT 1,
    weight          INTEGER DEFAULT 1,           -- น้ำหนักสำหรับสุ่ม (ยิ่งสูง ยิ่งโอกาสมาก)
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- Plan 2 sync columns
    cloud_uuid      TEXT UNIQUE,
    cloud_synced_at DATETIME,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at      DATETIME,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

-- ---------- 6. COMMENT SETTINGS (ต่อเพจ) ----------
CREATE TABLE IF NOT EXISTS comment_settings (
    page_id             INTEGER PRIMARY KEY,
    enabled             INTEGER DEFAULT 1,
    delay_sec           INTEGER DEFAULT 20,
    jitter_sec          INTEGER DEFAULT 10,
    max_per_day         INTEGER DEFAULT 30,
    cooldown_min        INTEGER DEFAULT 5,
    enable_self_reply   INTEGER DEFAULT 0,
    enable_pin          INTEGER DEFAULT 0,
    detect_removal      INTEGER DEFAULT 1,
    -- Plan 2 sync columns
    cloud_uuid          TEXT UNIQUE,
    cloud_synced_at     DATETIME,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at          DATETIME,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

-- ---------- 7. AI PROVIDERS (รองรับหลายเจ้า) ----------
CREATE TABLE IF NOT EXISTS ai_providers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    provider        TEXT NOT NULL,               -- openai | anthropic | gemini
    api_key         TEXT NOT NULL,               -- encrypted
    model           TEXT NOT NULL,               -- gpt-4o | claude-opus-4-7 | gemini-2.0
    label           TEXT,                        -- user-friendly name
    enabled         INTEGER DEFAULT 1,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- Plan 2 sync columns
    cloud_uuid      TEXT UNIQUE,
    cloud_synced_at DATETIME,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at      DATETIME
);

-- ---------- 8. CAPTION PROMPTS (ต่อเพจ) ----------
CREATE TABLE IF NOT EXISTS caption_prompts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id         INTEGER,                     -- NULL = default
    ai_provider_id  INTEGER,                     -- เลือก provider ต่อเพจได้
    system_prompt   TEXT NOT NULL,
    user_prompt     TEXT NOT NULL,               -- template with {video_title}, {niche}, etc.
    max_tokens      INTEGER DEFAULT 200,
    temperature     REAL DEFAULT 0.8,
    -- Plan 2 sync columns
    cloud_uuid      TEXT UNIQUE,
    cloud_synced_at DATETIME,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at      DATETIME,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
    FOREIGN KEY (ai_provider_id) REFERENCES ai_providers(id)
);

-- ---------- 9. SCOUTED VIDEOS (ต้นฉบับจาก bilibili) ----------
CREATE TABLE IF NOT EXISTS scouted_videos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source          TEXT NOT NULL,               -- bilibili | youtube | manual
    source_url      TEXT NOT NULL UNIQUE,        -- กัน dedup
    url_hash        TEXT NOT NULL UNIQUE,
    title           TEXT,
    duration_sec    INTEGER,
    view_count      INTEGER,
    thumbnail_url   TEXT,
    file_path       TEXT,                        -- path หลัง download
    file_size       INTEGER,
    keyword         TEXT,                        -- keyword ที่ค้นเจอ
    downloaded_at   DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------- 10. CLIPS (คลิปย่อยที่ตัดแล้ว) ----------
CREATE TABLE IF NOT EXISTS clips (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    scouted_id      INTEGER NOT NULL,
    clip_index      INTEGER NOT NULL,            -- ลำดับ 1, 2, 3...
    start_sec       REAL NOT NULL,
    end_sec         REAL NOT NULL,
    set1_path       TEXT,                        -- คลิปปกติ + banner
    set2_path       TEXT,                        -- แก้กันลิขสิทธิ์ + banner
    audio_fp        TEXT,                        -- audio fingerprint ของ Set 1
    caption         TEXT,                        -- AI generated
    status          TEXT DEFAULT 'ready',        -- ready | posting | posted | copyright_block | failed
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (scouted_id) REFERENCES scouted_videos(id) ON DELETE CASCADE
);

-- ---------- 11. COPYRIGHT BLACKLIST ----------
CREATE TABLE IF NOT EXISTS copyright_blacklist (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    audio_fp        TEXT NOT NULL UNIQUE,        -- audio fingerprint hash
    source_url      TEXT,                        -- clip ที่โดน
    detected_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    note            TEXT
);

-- ---------- 12. JOBS QUEUE (คิวโพสต์) ----------
CREATE TABLE IF NOT EXISTS jobs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    clip_id             INTEGER NOT NULL,
    page_id             INTEGER NOT NULL,
    scheduled_at        DATETIME NOT NULL,
    use_set              INTEGER DEFAULT 1,       -- 1 หรือ 2 (user กดเลือก)
    status              TEXT DEFAULT 'pending',  -- pending | running | posted | copyright_waiting | failed | cancelled
    fb_post_id          TEXT,                    -- post ID หลังโพสต์สำเร็จ
    copyright_blocked   INTEGER DEFAULT 0,       -- ถ้าติด ตั้งเป็น 1 รอ user กด Set 2
    error_message       TEXT,
    retry_count         INTEGER DEFAULT 0,
    started_at          DATETIME,
    finished_at         DATETIME,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (clip_id) REFERENCES clips(id),
    FOREIGN KEY (page_id) REFERENCES pages(id)
);

-- ---------- 13. POST LOG (audit trail) ----------
CREATE TABLE IF NOT EXISTS post_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id          INTEGER,
    event           TEXT NOT NULL,               -- navigate, upload, publish, copyright_detected, comment_posted
    detail          TEXT,                        -- JSON
    screenshot_path TEXT,                        -- เก็บ screenshot ถ้า error
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

-- ---------- 14. DAILY STATS (per page) ----------
CREATE TABLE IF NOT EXISTS daily_stats (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id         INTEGER NOT NULL,
    date            DATE NOT NULL,
    posts_count     INTEGER DEFAULT 0,
    comments_count  INTEGER DEFAULT 0,
    copyright_blocks INTEGER DEFAULT 0,
    UNIQUE(page_id, date),
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

-- ---------- 15. SETTINGS (key-value global) ----------
CREATE TABLE IF NOT EXISTS settings (
    key             TEXT PRIMARY KEY,
    value           TEXT
);

-- ---------- INDEXES ----------
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled ON jobs(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_jobs_copyright ON jobs(copyright_blocked);
CREATE INDEX IF NOT EXISTS idx_clips_status ON clips(status);
CREATE INDEX IF NOT EXISTS idx_scouted_hash ON scouted_videos(url_hash);
CREATE INDEX IF NOT EXISTS idx_blacklist_fp ON copyright_blacklist(audio_fp);
CREATE INDEX IF NOT EXISTS idx_pages_profile ON pages(profile_id);

-- ============================================================
-- ADDED: Channel Watcher feature (additive — won't affect existing)
-- ============================================================

-- 16. WATCHED CHANNELS
CREATE TABLE IF NOT EXISTS watched_channels (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    label               TEXT NOT NULL,
    platform            TEXT NOT NULL,
    channel_url         TEXT NOT NULL,
    content_type        TEXT NOT NULL DEFAULT 'all',
    interval_hours      REAL NOT NULL DEFAULT 5,
    min_duration_sec    INTEGER DEFAULT 0,
    max_duration_sec    INTEGER DEFAULT 0,
    download_dir        TEXT NOT NULL,
    last_checked_at     DATETIME,
    last_seen_video_id  TEXT,
    next_check_at       DATETIME,
    enabled             INTEGER DEFAULT 1,
    error_count         INTEGER DEFAULT 0,
    last_error          TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- Plan 2 sync columns
    cloud_uuid          TEXT UNIQUE,
    cloud_synced_at     DATETIME,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at          DATETIME
);

-- 16b. WATCHED_CHANNEL_PAGES (junction: 1 ช่อง → หลายเพจ)
CREATE TABLE IF NOT EXISTS watched_channel_pages (
    watched_id      INTEGER NOT NULL,
    page_id         INTEGER NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (watched_id, page_id),
    FOREIGN KEY (watched_id) REFERENCES watched_channels(id) ON DELETE CASCADE,
    FOREIGN KEY (page_id)    REFERENCES pages(id)            ON DELETE CASCADE
);

-- 17. PENDING APPROVALS
-- ✅ UNIQUE composite (watched_id, video_id) — รองรับเคสเพิ่มช่องเดียวกัน 2 รายการ (label ต่างกัน)
--    เดิม UNIQUE บน source_url ทำให้ user เพิ่มช่องเดียวกัน 2 ครั้งไม่ได้ → INSERT skip ทั้งหมด
CREATE TABLE IF NOT EXISTS pending_approvals (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    watched_id          INTEGER NOT NULL,
    video_id            TEXT NOT NULL,
    source_url          TEXT NOT NULL,
    title               TEXT,
    duration_sec        INTEGER,
    thumbnail_url       TEXT,
    upload_date         TEXT,
    detected_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    status              TEXT DEFAULT 'pending',
    scouted_id          INTEGER,
    download_progress   INTEGER DEFAULT 0,
    download_error      TEXT,
    orchestrator_run_id TEXT,
    UNIQUE(watched_id, video_id),
    FOREIGN KEY (watched_id) REFERENCES watched_channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_watched_next_check ON watched_channels(next_check_at);
CREATE INDEX IF NOT EXISTS idx_watched_enabled ON watched_channels(enabled);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON pending_approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_watched ON pending_approvals(watched_id);
CREATE INDEX IF NOT EXISTS idx_wcp_page ON watched_channel_pages(page_id);

-- =============================================================================
-- 18. DEFAULT SETTINGS (seeded for first-run — INSERT OR IGNORE = idempotent)
-- กัน feature ที่อ่าน settings ครั้งแรกเจอ NULL → silent fail
-- =============================================================================
INSERT OR IGNORE INTO settings (key, value) VALUES
  -- Pipeline timing
  ('default_clips_per_video',     '4'),
  ('default_clip_duration_sec',   '900'),
  ('warmup_duration_sec',         '60'),
  ('copyright_monitor_sec',       '60'),
  -- Posting safety
  ('strict_copyright_wait',       '0'),
  -- Watcher AI caption (ใช้กับทุกเพจ — user ปรับเองในเมนู AI แคปชั่นได้)
  ('watcher_caption_user_prompt',
   'เขียนแคปชั่น Facebook Reel ภาษาไทย จากชื่อคลิป: "{video_title}"

โครงสร้าง:
- บรรทัดแรก: hook กระตุกคนหยุดเลื่อน (≤60 ตัวอักษร) ใส่อิโมจิ 1 ตัว
- บรรทัด 2-3: เกริ่นเรื่องคลิปแบบไม่สปอยล์ ใช้คำถาม/ตัวเลข/คำว่า "ห้ามพลาด"
- บรรทัดสุดท้าย: CTA สั้น (เช่น "ดูคลิปเต็มในโพสต์") + แฮชแท็ก 4-6 อัน

กฎเข้ม: โทนเป็นกันเอง ห้าม "สวัสดีค่ะ/ครับ" · อิโมจิ 3-6 ตัวกระจาย · ห้ามใส่ link/ชื่อเพจ/AI · ออกผลลัพธ์เป็นแคปชั่นล้วน ห้ามอธิบาย'),
  ('watcher_caption_system_prompt',
   'คุณเป็น caption writer ที่เขียนแคปชั่น Facebook Reel ภาษาไทยสำหรับช่องแชร์คลิปสั้น โทนเป็นกันเอง โน้มน้าวให้คนหยุดเลื่อน ส่งออกข้อความล้วน ไม่ใส่คำขึ้นต้น "นี่คือ" หรืออธิบายตัวเอง'),
  ('watcher_caption_temperature', '0.85'),
  ('watcher_caption_max_tokens',  '300'),
  -- Watcher auto-edit (slice + banner) toggle. '1' = เปิด (default), '0' = ปิด → โพสต์ raw clip ตรงๆ
  ('watcher_auto_edit_enabled',   '1'),
  -- Cover/Banner defaults
  ('cover_enabled',               '0'),
  -- Chrome path override (ว่างไว้ → ใช้ auto-detect ของ poster.js)
  ('chrome_executable_path',      '');

-- =============================================================================
-- 19. AUDIT QUEUE — buffer for cloud audit_log events when offline (Plan 2)
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event       TEXT NOT NULL,
    detail_json TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    flushed_at  DATETIME
);
CREATE INDEX IF NOT EXISTS idx_audit_queue_unflushed ON audit_queue(flushed_at) WHERE flushed_at IS NULL;

-- =============================================================================
-- Plan 2: triggers to bump updated_at on every UPDATE for synced tables
-- WHEN clause prevents recursive trigger when our own UPDATE sets updated_at
-- =============================================================================
CREATE TRIGGER IF NOT EXISTS trg_pages_updated_at             AFTER UPDATE ON pages             FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE pages             SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_banners_updated_at           AFTER UPDATE ON banners           FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE banners           SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_banner_presets_updated_at    AFTER UPDATE ON banner_presets    FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE banner_presets    SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_caption_prompts_updated_at   AFTER UPDATE ON caption_prompts   FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE caption_prompts   SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_comment_templates_updated_at AFTER UPDATE ON comment_templates FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE comment_templates SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_comment_settings_updated_at  AFTER UPDATE ON comment_settings  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE comment_settings  SET updated_at = CURRENT_TIMESTAMP WHERE page_id = NEW.page_id; END;
CREATE TRIGGER IF NOT EXISTS trg_watched_channels_updated_at  AFTER UPDATE ON watched_channels  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE watched_channels  SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS trg_ai_providers_updated_at      AFTER UPDATE ON ai_providers      FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN UPDATE ai_providers      SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
