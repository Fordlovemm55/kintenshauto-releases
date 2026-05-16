// Registry of synced tables. Each entry maps a local SQLite table to its
// Supabase cloud_* counterpart with the columns to push.
//
//   localTable    local SQLite table
//   cloudTable    Supabase mirror table
//   pkLocal       local primary key column ('id' for most, 'page_id' for comment_settings)
//   columns       data fields to sync (excludes id/cloud_uuid/timestamps — handled by engine)
//
// NOTE: page_id is intentionally omitted from caption_prompts and comment_templates
// because it's a local integer FK that doesn't map directly to the cloud's
// page_cloud_uuid (UUID). Cross-table FK syncing is deferred to a later phase.

module.exports = [
  {
    localTable: 'pages',
    cloudTable: 'cloud_pages',
    pkLocal: 'id',
    columns: ['fb_page_id', 'name', 'niche', 'daily_quota', 'cooldown_min',
              'default_keyword', 'enabled']
  },
  {
    localTable: 'banner_presets',
    cloudTable: 'cloud_banner_presets',
    pkLocal: 'id',
    columns: ['name', 'layers_json']
  },
  {
    localTable: 'banners',
    cloudTable: 'cloud_banners',
    pkLocal: 'id',
    columns: ['name', 'width_px', 'height_px']
  },
  {
    localTable: 'caption_prompts',
    cloudTable: 'cloud_caption_prompts',
    pkLocal: 'id',
    columns: ['system_prompt', 'user_prompt', 'max_tokens', 'temperature',
              'selected_model']
  },
  {
    localTable: 'comment_templates',
    cloudTable: 'cloud_comment_templates',
    pkLocal: 'id',
    columns: ['label', 'content', 'weight', 'enabled']
  },
  {
    localTable: 'comment_settings',
    cloudTable: 'cloud_comment_settings',
    pkLocal: 'page_id',
    columns: ['enabled', 'delay_sec', 'jitter_sec', 'max_per_day', 'cooldown_min',
              'enable_self_reply', 'enable_pin', 'detect_removal']
  },
  {
    localTable: 'watched_channels',
    cloudTable: 'cloud_watched_channels',
    pkLocal: 'id',
    columns: ['label', 'platform', 'channel_url', 'content_type', 'interval_hours',
              'min_duration_sec', 'max_duration_sec', 'enabled']
  },
  {
    localTable: 'ai_providers',
    cloudTable: 'cloud_ai_providers',
    pkLocal: 'id',
    columns: ['provider', 'model', 'label', 'enabled'],
    // Special: api_key column on local → encrypted_key column on cloud
    // (the value is already encrypted via captionService.encrypt — we just rename)
    encryptedColumn: { local: 'api_key', cloud: 'encrypted_key' }
  }
];
