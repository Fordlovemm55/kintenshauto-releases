# Banner Visual Editor — Design

> Date: 2026-06-13 · Status: Draft for review · Owner: KINTENSHAUTO

## 1. Goal

Let the operator place a banner over the 9:16 Reel **visually** — drag to position,
drag a corner to resize, a slider to rotate, a slider for opacity — instead of typing
X/Y/width numbers. A **Save** button persists the layout, and existing presets can be
**re-opened and edited**. This is a usability upgrade over the current numeric-only
`CreatePresetModal`.

## 2. Scope & non-goals

**In scope (frontend only):**
- A **9:16 preview canvas** inside the preset modal showing each layer's banner image at
  its real position/size/rotation/opacity.
- **Drag to move** (updates `position.x/y` %), **drag a corner to resize** (updates
  `size.width` %), **rotation slider** (−180…180, updates `rotation`), **opacity slider**.
- The existing **numeric fields stay**, kept in sync with the canvas (drag OR type).
- **Save** (existing `POST /api/banner-presets`) and **Edit existing preset** (existing
  `PUT /api/banner-presets/:id`) — add an "แก้ไข" (Edit) action to each preset row that
  re-opens the modal pre-loaded with that preset's layers.
- A small **pure-geometry helper** (`src/lib/bannerGeometry.js`) for px↔% conversion that
  matches the ffmpeg overlay math, **unit-tested**.

**Explicit non-goals:**
- **No backend / schema / ffmpeg changes.** The layer model
  (`{banner_id, z_index, position:{x,y}, size:{width}, opacity, rotation, timing}`),
  `BannerPresetService` (save/update/delete) and `BannerFFmpegBuilder` already exist and
  are unchanged. The editor only produces the same `layers[]` array the API already takes.
- **9:16 only** (Reels). No multiple aspect ratios.
- **Rotation preview is approximate.** ffmpeg rotates the banner and recomputes its
  bounding box, then overlays at `(main−overlay)*pct`. The CSS preview rotates around the
  element's center. For `rotation === 0` (the common case) the preview matches the output
  exactly; for rotated banners the preview can be slightly off. Documented in the UI.

## 3. The geometry contract (the one piece worth testing)

ffmpeg places a banner (from `bannerLayerSystem.buildCommand`) as:
- width in px = `frameW * size.width/100`, height = preserve aspect (`scale=W:-1`)
- overlay at `x_px = (frameW − bannerW) * position.x/100`,
  `y_px = (frameH − bannerH) * position.y/100`

So `position.x = 0` → flush left, `100` → flush right, `50` → centered (same for y).
`src/lib/bannerGeometry.js` mirrors this exactly:

- `layerToBox(layer, frame, imgAspect) → { left, top, width, height, rotation }`
  where `imgAspect = imgHeightPx / imgWidthPx`, `frame = { w, h }` in canvas px.
- `boxToLayer({ left, top, width }, frame, imgAspect) → { x, y, width }` (the inverse,
  clamped to 0–100). When `bannerW === frameW` (no horizontal slack) `x` falls back to the
  previous value / 0 to avoid divide-by-zero; same for y.

The React canvas only does pointer math + calls these helpers; all the arithmetic that
must match ffmpeg lives in one tested module.

## 4. Components (all in `src/components/BannersView.jsx`, + the helper)

| Unit | Responsibility |
|---|---|
| `src/lib/bannerGeometry.js` (new) | pure px↔% conversions (§3), unit-tested |
| `BannerPreviewCanvas` (new, in BannersView) | renders the 9:16 frame + one draggable/resizable/rotatable box per layer; emits layer patches on drag/resize; highlights the selected layer |
| `CreatePresetModal` (modify) | gains the canvas beside the layer list; gains an `editing` prop (preset to edit); Save calls POST (create) or PUT (edit); rotation slider added to `LayerEditor` |
| `LayerEditor` (modify) | add a **rotation** slider + an **opacity** slider; existing X/Y/width number fields stay and stay synced |
| `PresetRow` (modify) | add an "แก้ไข" button that opens the modal in edit mode |
| `BannersView` (modify) | hold `editingPreset` state; pass it to the modal; on save, refresh |

## 5. Interaction / data flow

1. User clicks "สร้างชุดใหม่" (create) or "แก้ไข" on a preset (edit → modal pre-filled from
   `preset.layers`).
2. The modal keeps `layers[]` state (unchanged shape). Selecting a layer in the list or
   clicking its box on the canvas marks it active.
3. Dragging/resizing a box → `boxToLayer(...)` → `updateLayer(i, {position/size})`.
   Rotation/opacity sliders → `updateLayer(i, {rotation/opacity})`. Numeric fields do the
   same. Canvas re-renders from `layers[]` via `layerToBox(...)`. Single source of truth =
   `layers[]`.
4. Save → `POST /api/banner-presets` (create) or `PUT /api/banner-presets/:id` (edit) with
   `{ name, layers }` — exactly today's payload.

To draw a banner the canvas needs its image + intrinsic aspect ratio. The banner list
(`banners`) already carries `file_path`, `width_px`, `height_px`; `imgAspect =
height_px/width_px`. Images load via the existing `file://` path scheme.

## 6. Error handling

- Layer with no `banner_id` → not drawn on canvas; Save filters it out (existing behavior).
- Image fails to load → box shows a labeled placeholder rectangle (still draggable).
- Resize clamps width to 5–100%; drag clamps x/y to 0–100% (via `boxToLayer`).
- Edit of a preset whose banner was deleted → that layer shows a placeholder; user can
  re-pick or remove it before saving.

## 7. Testing

- **`bannerGeometry` unit tests** (vitest, `tests/frontend/bannerGeometry.test.js`):
  - `layerToBox` centers at x=y=50; flush-left at x=0; flush-right at x=100.
  - `layerToBox` width/height honor `size.width` and `imgAspect`.
  - `boxToLayer` is the inverse of `layerToBox` (round-trip within rounding).
  - `boxToLayer` clamps out-of-range px to 0–100 and handles `bannerW === frameW`.
- **Manual verification** (the React canvas itself, no jsdom harness in this project):
  create a preset by dragging a banner, save, confirm it appears in the list with the
  dragged position; re-open via Edit, move it, save, confirm the change persisted; post a
  test clip and confirm the rendered overlay matches the previewed position (rotation 0).

## 8. Out of scope (future)

- Sample-video-frame background behind the canvas (v1 uses a dark frame + center guide).
- A true rotate-handle (v1 uses a slider).
- Snap-to-grid / alignment guides.
