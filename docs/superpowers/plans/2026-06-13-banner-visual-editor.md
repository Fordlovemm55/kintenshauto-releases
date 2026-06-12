# Banner Visual Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the numeric-only banner preset modal into a visual editor — drag a banner over a 9:16 preview to position it, drag a corner to resize, sliders for rotation/opacity — plus the ability to re-open and edit existing presets, and a Save button.

**Architecture:** Frontend-only. A new pure helper `src/lib/bannerGeometry.js` does the px↔% math (matching the existing ffmpeg overlay formula) and is unit-tested. `src/components/BannersView.jsx` gains a `BannerPreviewCanvas` drag surface inside `CreatePresetModal`, a rotation slider, and an edit mode (PUT). No backend/schema/ffmpeg changes — the modal still emits the same `layers[]` array the API already accepts.

**Tech Stack:** React 18, vitest (for the pure helper only), existing Express endpoints (`POST`/`PUT /api/banner-presets`).

Spec: `docs/superpowers/specs/2026-06-13-banner-visual-editor-design.md`.

---

## Ground rules

- Run everything from `kintenshauto-releases/`. Tests: `npm test -- <pattern>` (scoped). PowerShell shows npm stderr in red — harmless; judge by the vitest summary.
- The banner layer shape is unchanged: `{ banner_id, z_index, position:{x,y}, size:{width}, opacity, rotation, timing }`. `position.x/y` and `size.width` are 0–100 (%). `x=0` flush-left, `100` flush-right, `50` centered (same for y).
- React lives in `src/`; the app loads the built bundle in `dist/`, so **React changes require `npm run build-frontend` + app relaunch to see** (Task 5). The pure helper is testable without building.
- `banners` rows already carry `file_path`, `width_px`, `height_px`. `imgAspect = height_px / width_px`.
- Comments + new UI strings in English (project rule); existing Thai UI strings stay.

## File structure

| File | Responsibility |
|---|---|
| `src/lib/bannerGeometry.js` (new) | pure `clamp`, `layerToBox`, `boxToLayer` (px↔%); ESM |
| `tests/frontend/bannerGeometry.test.js` (new) | unit tests for the helper |
| `src/components/BannersView.jsx` (modify) | `BannerPreviewCanvas`, modal canvas + edit mode, rotation slider, PresetRow edit button |

---

## Task 1: `bannerGeometry.js` — the tested px↔% core

**Files:**
- Create: `src/lib/bannerGeometry.js`
- Test: `tests/frontend/bannerGeometry.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/frontend/bannerGeometry.test.js
import { describe, it, expect } from 'vitest';
import { clamp, layerToBox, boxToLayer } from '../../src/lib/bannerGeometry.js';

const frame = { w: 270, h: 480 };
const aspect = 0.5; // banner intrinsic height = 0.5 * width

describe('clamp', () => {
  it('bounds values', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe('layerToBox', () => {
  it('centers at x=50,y=50 and sizes by width% + aspect', () => {
    const b = layerToBox({ position: { x: 50, y: 50 }, size: { width: 50 } }, frame, aspect);
    expect(b.width).toBeCloseTo(135);   // 50% of 270
    expect(b.height).toBeCloseTo(67.5); // 135 * 0.5
    expect(b.left).toBeCloseTo(67.5);   // (270-135)*0.5
    expect(b.top).toBeCloseTo(206.25);  // (480-67.5)*0.5
  });
  it('is flush left/top at x=0,y=0', () => {
    const b = layerToBox({ position: { x: 0, y: 0 }, size: { width: 50 } }, frame, aspect);
    expect(b.left).toBe(0);
    expect(b.top).toBe(0);
  });
  it('is flush right/bottom at x=100,y=100', () => {
    const b = layerToBox({ position: { x: 100, y: 100 }, size: { width: 50 } }, frame, aspect);
    expect(b.left).toBeCloseTo(135);
    expect(b.top).toBeCloseTo(412.5);
  });
  it('applies defaults when fields are missing', () => {
    const b = layerToBox({}, frame, aspect);
    expect(b.width).toBeCloseTo(81);    // default 30% of 270
    expect(b.rotation).toBe(0);
  });
});

describe('boxToLayer', () => {
  it('is the inverse of layerToBox (round-trip)', () => {
    const layer = { position: { x: 30, y: 70 }, size: { width: 40 } };
    const box = layerToBox(layer, frame, aspect);
    expect(boxToLayer(box, frame, aspect)).toEqual({ x: 30, y: 70, width: 40 });
  });
  it('clamps out-of-range pixels to 0..100', () => {
    const back = boxToLayer({ left: -50, top: 9999, width: 100 }, frame, aspect);
    expect(back.x).toBe(0);
    expect(back.y).toBe(100);
  });
  it('returns x=0 when the banner fills the frame width (no slack)', () => {
    const back = boxToLayer({ left: 0, top: 0, width: 270 }, frame, aspect);
    expect(back.x).toBe(0);
    expect(back.width).toBe(100);
  });
  it('clamps width to 5..100', () => {
    expect(boxToLayer({ left: 0, top: 0, width: 5 }, frame, aspect).width).toBe(5);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- bannerGeometry`
Expected: FAIL — `Cannot find module '.../src/lib/bannerGeometry.js'`.

- [ ] **Step 3: Implement the helper**

```javascript
// src/lib/bannerGeometry.js
// Pure px <-> percentage conversions for the banner preview canvas.
// Mirrors bannerLayerSystem.js / ffmpeg overlay math so the preview matches output:
//   banner width(px) = frameW * size.width/100   (height preserves the image aspect)
//   overlay x(px)    = (frameW - bannerW) * position.x/100   (0 = flush left, 100 = flush right)
//   overlay y(px)    = (frameH - bannerH) * position.y/100

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// layer -> pixel box on a frame {w,h}; imgAspect = imgHeightPx / imgWidthPx
export function layerToBox(layer, frame, imgAspect) {
  const widthPct = layer?.size?.width ?? 30;
  const xPct = layer?.position?.x ?? 50;
  const yPct = layer?.position?.y ?? 50;
  const width = frame.w * (widthPct / 100);
  const height = width * imgAspect;
  const slackX = frame.w - width;
  const slackY = frame.h - height;
  return {
    left: slackX * (xPct / 100),
    top: slackY * (yPct / 100),
    width,
    height,
    rotation: layer?.rotation ?? 0,
  };
}

// pixel box (from a drag/resize) -> layer percentages, clamped to valid ranges
export function boxToLayer(box, frame, imgAspect) {
  const width = box.width;
  const height = width * imgAspect;
  const slackX = frame.w - width;
  const slackY = frame.h - height;
  return {
    x: slackX > 0 ? Math.round(clamp((box.left / slackX) * 100, 0, 100)) : 0,
    y: slackY > 0 ? Math.round(clamp((box.top / slackY) * 100, 0, 100)) : 0,
    width: Math.round(clamp((width / frame.w) * 100, 5, 100)),
  };
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npm test -- bannerGeometry`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git -C "<rel>" add src/lib/bannerGeometry.js tests/frontend/bannerGeometry.test.js
git -C "<rel>" commit -m "feat(banner): pure px<->% geometry helper for the visual editor"
```

---

## Task 2: `BannerPreviewCanvas` — drag + resize on a 9:16 frame

**Files:**
- Modify: `src/components/BannersView.jsx`

> No automated test (React pointer UI; this project has no jsdom harness). Verified manually in Task 5. Provide the complete component and wire it in.

- [ ] **Step 1: Import the helper**

At the top of `src/components/BannersView.jsx`, below the existing `import React ...` line, add:

```javascript
import { layerToBox, boxToLayer } from '../lib/bannerGeometry.js';
```

- [ ] **Step 2: Add the `BannerPreviewCanvas` component**

Add this function in `BannersView.jsx` (e.g. just above `function CreatePresetModal`):

```javascript
const FRAME_W = 270;
const FRAME_H = 480;

// 9:16 drag surface. Renders one box per layer; drag to move, drag the corner to resize.
function BannerPreviewCanvas({ layers, banners, selectedIndex, onSelect, onLayerChange }) {
  const drag = React.useRef(null);
  const bannerById = (id) => banners.find(b => b.id === id);

  const startDrag = (e, i, mode) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect(i);
    const layer = layers[i];
    const banner = bannerById(layer.banner_id);
    if (!banner) return;
    const aspect = (banner.height_px || 1) / (banner.width_px || 1);
    const startBox = layerToBox(layer, { w: FRAME_W, h: FRAME_H }, aspect);
    drag.current = { mode, startX: e.clientX, startY: e.clientY, startBox, index: i, aspect };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    let box;
    if (d.mode === 'move') {
      box = { left: d.startBox.left + dx, top: d.startBox.top + dy, width: d.startBox.width };
    } else {
      box = { left: d.startBox.left, top: d.startBox.top, width: Math.max(13, d.startBox.width + dx) };
    }
    const patch = boxToLayer(box, { w: FRAME_W, h: FRAME_H }, d.aspect);
    onLayerChange(d.index, { position: { x: patch.x, y: patch.y }, size: { width: patch.width } });
  };

  const onUp = () => {
    drag.current = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };

  return (
    <div onPointerDown={() => onSelect(-1)}
         style={{
           position: 'relative', width: FRAME_W, height: FRAME_H, flexShrink: 0,
           background: '#101015', border: '1px solid var(--border-faint)', overflow: 'hidden',
           touchAction: 'none',
         }}>
      <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.12)' }} />
      <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 1, background: 'rgba(255,255,255,0.12)' }} />
      {layers.map((layer, i) => {
        const banner = bannerById(layer.banner_id);
        if (!banner) return null;
        const aspect = (banner.height_px || 1) / (banner.width_px || 1);
        const box = layerToBox(layer, { w: FRAME_W, h: FRAME_H }, aspect);
        const selected = i === selectedIndex;
        const src = `file://${banner.file_path.replace(/\\/g, '/')}`;
        return (
          <div key={i} onPointerDown={(e) => startDrag(e, i, 'move')}
               style={{
                 position: 'absolute', left: box.left, top: box.top, width: box.width, height: box.height,
                 transform: `rotate(${box.rotation}deg)`, transformOrigin: 'center',
                 opacity: (layer.opacity ?? 100) / 100,
                 outline: selected ? '2px solid var(--gold)' : '1px dashed rgba(255,255,255,0.45)',
                 cursor: 'move', touchAction: 'none',
               }}>
            <img src={src} alt="" draggable={false}
                 style={{ width: '100%', height: '100%', objectFit: 'fill', pointerEvents: 'none' }}
                 onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
            {selected && (
              <div onPointerDown={(e) => startDrag(e, i, 'resize')}
                   style={{ position: 'absolute', right: -6, bottom: -6, width: 12, height: 12,
                            background: 'var(--gold)', borderRadius: '50%', cursor: 'nwse-resize' }} />
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Wire the canvas into `CreatePresetModal`**

In `CreatePresetModal`, add a selected-layer state next to the existing `useState` hooks:

```javascript
  const [selectedIndex, setSelectedIndex] = useState(0);
```

Then, inside the modal body, render the canvas beside the layer list. Replace the block that currently renders the `ชั้นแบนเนอร์ ({layers.length})` heading + the `layers.map(...)` LayerEditor list with a two-column layout that keeps that list and adds the canvas:

```javascript
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <BannerPreviewCanvas
            layers={layers}
            banners={banners}
            selectedIndex={selectedIndex}
            onSelect={setSelectedIndex}
            onLayerChange={(i, patch) => updateLayer(i, patch)}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>
              ชั้นแบนเนอร์ ({layers.length}) — ลากในพรีวิวเพื่อจัดวาง
            </div>
            {layers.map((layer, i) => (
              <div key={i} onClick={() => setSelectedIndex(i)}
                   style={{ outline: i === selectedIndex ? '1px solid var(--gold)' : 'none' }}>
                <LayerEditor index={i} layer={layer} banners={banners}
                             onChange={patch => updateLayer(i, patch)}
                             onRemove={() => { removeLayer(i); setSelectedIndex(0); }}
                             canRemove={layers.length > 1} />
              </div>
            ))}
            <button className="btn-ghost" onClick={addLayer}
                    style={{ fontSize: 11, padding: '6px 14px', marginTop: 6 }}>
              ＋ เพิ่มชั้น
            </button>
          </div>
        </div>
```

(Widen the modal so the two columns fit: change the modal inner `maxWidth: 700` to `maxWidth: 860`.)

- [ ] **Step 4: Commit**

```bash
git -C "<rel>" add src/components/BannersView.jsx
git -C "<rel>" commit -m "feat(banner): drag/resize preview canvas in the preset editor"
```

---

## Task 3: Rotation slider in `LayerEditor`

**Files:**
- Modify: `src/components/BannersView.jsx`

- [ ] **Step 1: Add a rotation slider to `LayerEditor`**

In `LayerEditor`, after the grid of `NumField`s (the `<div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)' ...}}>` block that holds X/Y/width/opacity), add a rotation row:

```javascript
      <div style={{ marginTop: 10 }}>
        <label style={{ fontSize: 11 }}>หมุน ({layer.rotation ?? 0}°)</label>
        <input type="range" min={-180} max={180} value={layer.rotation ?? 0}
               onChange={e => onChange({ rotation: Number(e.target.value) })}
               style={{ width: '100%' }} />
      </div>
```

- [ ] **Step 2: Commit**

```bash
git -C "<rel>" add src/components/BannersView.jsx
git -C "<rel>" commit -m "feat(banner): rotation slider per layer (canvas reflects it live)"
```

---

## Task 4: Edit an existing preset (load → adjust → PUT)

**Files:**
- Modify: `src/components/BannersView.jsx`

- [ ] **Step 1: Make `CreatePresetModal` accept an `editing` preset and use PUT**

Change the `CreatePresetModal` signature and its initial state + save:

```javascript
function CreatePresetModal({ banners, editing, onClose, onSaved, showToast }) {
  const [name, setName] = useState(editing?.name ?? '');
  const [layers, setLayers] = useState(
    editing?.layers?.length
      ? editing.layers.map(l => ({ ...l }))
      : [{ banner_id: banners[0]?.id ?? null, position: { x: 50, y: 50 }, size: { width: 30 }, opacity: 100, rotation: 0 }]
  );
```

In `save`, swap the request to POST-or-PUT:

```javascript
      const url = editing
        ? `${API}/api/banner-presets/${editing.id}`
        : `${API}/api/banner-presets`;
      const res = await fetch(url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), layers: valid })
      });
```

And update the modal title + success copy to reflect edit vs create:

```javascript
          <div style={{ fontSize: 16, fontWeight: 500 }}>
            {editing ? 'แก้ไขชุดแบนเนอร์' : 'สร้างชุดแบนเนอร์ใหม่'}
          </div>
```
```javascript
      showToast?.(editing ? 'บันทึกแล้ว' : 'สร้างแล้ว', `ชุด "${name}" พร้อมใช้`, 'success');
```

- [ ] **Step 2: Add an Edit button to `PresetRow` and wire `BannersView` state**

In `PresetRow`, add an `onEdit` prop and a button before the delete button:

```javascript
function PresetRow({ preset, banners, onEdit, onDelete }) {
```
```javascript
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn-ghost" onClick={onEdit}
                style={{ fontSize: 11, padding: '4px 10px' }}>✏️ แก้ไข</button>
        <button className="btn-ghost" onClick={onDelete}
                style={{ fontSize: 11, padding: '4px 10px', color: 'var(--danger)' }}>🗑 ลบ</button>
      </div>
```
(remove the old standalone delete button that this replaces.)

In `BannersView`, add edit state and pass it through:

```javascript
  const [editingPreset, setEditingPreset] = useState(null);
```

Change the preset list render to pass `onEdit`:

```javascript
              <PresetRow key={p.id} preset={p} banners={banners}
                         onEdit={() => { setEditingPreset(p); setShowCreate(true); }}
                         onDelete={() => deletePreset(p.id)} />
```

And the modal mount to pass `editing` + clear it on close:

```javascript
      {showCreate && (
        <CreatePresetModal
          banners={banners}
          editing={editingPreset}
          onClose={() => { setShowCreate(false); setEditingPreset(null); }}
          onSaved={async () => { setShowCreate(false); setEditingPreset(null); await refresh(); }}
          showToast={showToast}
        />
      )}
```

- [ ] **Step 3: Commit**

```bash
git -C "<rel>" add src/components/BannersView.jsx
git -C "<rel>" commit -m "feat(banner): edit existing presets (load + PUT)"
```

---

## Task 5: Build + manual E2E verification

- [ ] **Step 1: Helper tests still green**

Run: `npm test -- bannerGeometry`
Expected: PASS.

- [ ] **Step 2: Build the frontend + relaunch**

```powershell
Set-Location "<rel>"
npm run build-frontend
taskkill /F /IM electron.exe /T 2>$null
$env:KINTENSHAUTO_SKIP_AUTH='1'
Start-Process "<rel>\node_modules\electron\dist\electron.exe" -ArgumentList "." -WorkingDirectory "<rel>"
```

- [ ] **Step 3: Manual E2E**

1. Upload a banner image (if none) → go to **แบนเนอร์** → **สร้างชุดใหม่**.
2. Confirm the 9:16 canvas shows the banner; **drag** it → the X/Y numbers update; **drag the gold corner** → width updates; move the **หมุน** slider → the banner rotates in the preview.
3. **บันทึก** → the preset appears in the list with the dragged position.
4. Click **✏️ แก้ไข** on that preset → the modal re-opens pre-filled; move the banner; **บันทึก** → reopen to confirm the change persisted.
5. (Optional) Post a test clip with that preset and confirm the rendered overlay matches the previewed position (rotation 0).

- [ ] **Step 4: Update CHANGELOG + commit**

```bash
git -C "<rel>" add CHANGELOG.md
git -C "<rel>" commit -m "docs(changelog): banner visual editor"
```

---

## Self-review

- **Spec coverage:** 9:16 canvas (T2) · drag-move + corner-resize (T1 math, T2 UI) · rotation slider (T3) · opacity (existing field, reflected live on canvas T2) · numeric fields stay synced (T2 wiring) · Save POST + edit PUT (T4) · edit-existing button (T4) · tested geometry helper (T1). ✔
- **Types consistent:** helper API `layerToBox(layer,frame,imgAspect)→{left,top,width,height,rotation}`, `boxToLayer(box,frame,imgAspect)→{x,y,width}` used identically in T2. Layer shape unchanged from the backend.
- **No placeholders:** every code step is complete; React UI steps are explicitly manual-verify with concrete steps.
- **No backend changes:** confirmed — POST/PUT `/api/banner-presets` already accept `{name, layers}`.
