# Consolidate Caption AI page — design

Date: 2026-06-13
Status: approved (frontend-only reorganization)

## Problem

Caption configuration is split across two screens, which confuses users:

- "ตั้งค่า" (`SettingsView.jsx`) holds three AI-related setting groups:
  - แคปชั่น (AI หรือแม่แบบ): `caption_mode`, `caption_template`, `caption_emoji_pool`
  - AI สร้างปกอัตโนมัติ: `cover_enabled`, `cover_model`, `cover_prompt_default`
  - คีย์ API สำหรับแคปชั่น AI (the `AIKeysSection`)
- "แคปชั่น AI" (`AICaptionsView.jsx`) holds the model price table and the per-page caption prompts CRUD.

To set up AI captions a user must hop between both screens, and the prompts list shows even when the
caption mode is not AI. The "แคปชั่น AI" page also tells the user to "go set the key in ตั้งค่า first".

## Goal

Make "แคปชั่น AI" the single, self-contained hub for all caption + cover configuration. Remove the
split, show only what each mode needs, and trim jargon. No backend changes.

## Design

### New "แคปชั่น AI" page (`AICaptionsView.jsx`), three sections top→bottom

1. **คีย์ API** — the `AIKeysSection` (openai/anthropic/gemini) moved from `SettingsView`. Saving a key
   refreshes the model availability list on the same page.
2. **แคปชั่น** — `caption_mode` select drives the conditional body:
   - `ai` → collapsible model-price reference + the prompts CRUD (create/edit/delete/test).
   - `template` → `caption_template` + `caption_emoji_pool`.
   - `source_title` → `caption_emoji_pool` only.
   - `off` → nothing (short note).
3. **ปก (AI สร้างปก)** — `cover_enabled` toggle; `cover_model` + `cover_prompt_default` appear only when enabled.

### Settings persistence

`caption_*` and `cover_*` are key/value settings saved through the existing `/api/settings/:key`
endpoints. They keep a small sticky "บันทึกทั้งหมด" bar (same pattern users already know from ตั้งค่า).
Keys and prompts keep their existing immediate-save behavior.

### Shared kit (avoid duplication)

Extract the reusable settings primitives out of `SettingsView.jsx` into `src/components/settingsKit.jsx`:

- `useSettings(keys)` → `{ values, originalValues, setOne, isDirty, loading, saving, saveAll, resetAll }`
  (loads via `GET /api/settings`, PUTs only changed keys).
- `SettingRow({ item, value, onChange })` — the existing toggle/select/textarea/number/text renderer.
- `SaveBar({ isDirty, saving, onSave, onReset })` — the sticky save bar.

`SettingsView` keeps only system groups (background, clip defaults, copyright, storage, advanced) plus
account, YouTube login, and maintenance, and renders them through the shared kit. `AICaptionsView`
uses `useSettings` + `SettingRow` + `SaveBar` for the caption/cover fields with mode-conditional layout.

### Trimming (easier to understand)

- Prompts list shows only in AI mode (was always visible).
- Model-price table collapses behind "ดูราคารุ่น AI".
- `max_tokens` / `temperature` move behind an "ขั้นสูง" disclosure inside the prompt modal.
- Remove the "ไปตั้งคีย์ที่หน้าตั้งค่าก่อน" banner (keys now live on this page; point to the section above).

## Out of scope / unchanged

- Backend: `/api/settings`, `/api/caption-prompts`, `/api/caption-models`, `/api/ai/keys` unchanged.
- Sidebar nav label stays "แคปชั่น AI"; `Dashboard.jsx` routing unchanged.
- Pre-existing uncommitted Thai-localization work in these files is preserved (built on top of, not reverted).

## Verification

Frontend has no React test harness, so verify by build + manual run:
1. `npm run build-frontend` succeeds.
2. Launch the app: "แคปชั่น AI" shows keys + caption (mode-driven) + cover; "ตั้งค่า" no longer shows
   caption/cover/keys; mode switching reveals the right fields; the save bar persists `caption_*`/`cover_*`;
   prompts/keys still save immediately.
