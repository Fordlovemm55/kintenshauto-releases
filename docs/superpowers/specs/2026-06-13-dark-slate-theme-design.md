# Dark Slate Professional Theme — Design

> Date: 2026-06-13 · Status: Approved (user picked option 1 "Dark Slate" from mockups) · Owner: KINTENSHAUTO

## 1. Goal

Re-skin the app from the current "candy purple-gold" (cute) look to a **dark, professional,
trustworthy** look (Dark Slate): slate-dark surfaces, a disciplined indigo accent, crisp
typography, flat panels, no falling-petal/candy decoration. Same structure, same components —
only the visual tokens change.

## 2. Approach

The whole app (React + both vanilla overlays) is driven by CSS variables in
`src/theme/samurai.css`. Re-theming is mainly **swapping the `:root` tokens** (keeping the
existing token names like `--samurai-red` so every consumer re-skins automatically) plus a few
spots that hard-code candy colors, and replacing the colorful PNG background with a flat dark CSS
scene. No class names are renamed; no behavior changes.

## 3. Token mapping (Dark Slate)

| Token | New value |
|---|---|
| body background | flat `#0f172a` (slate-900) with a faint top vignette — no candy gradient |
| `--samurai-red` / `-deep` / `-bright` (primary accent) | `#6366f1` / `#4f46e5` / `#818cf8` (indigo) |
| `--gold` / `-dark` / `-bright` | keep but mute: `#eab308` / `#ca8a04` / `#facc15` (used sparingly for badges) |
| `--text-primary / secondary / muted / dim` | `#e2e8f0` / `#94a3b8` / `#64748b` / `#475569` |
| `--surface-1 / 2 / 3` | `#1e293b` / `#182234` / `rgba(99,102,241,0.10)` (solid, not frosted) |
| `--surface-hover / active` | `rgba(148,163,184,0.08)` / `rgba(99,102,241,0.16)` |
| `--border-faint / soft / strong` | `rgba(148,163,184,0.14)` / `0.26` / `0.4` |
| `--success / warning / danger / info` | `#22c55e` / `#f59e0b` / `#f43f5e` / `#6366f1` |
| `--radius-sm / md / lg` | `8px` / `10px` / `12px` (down from 10/16/22) |
| `--shadow-panel / glow` | subtle dark: `0 1px 0 rgba(0,0,0,.25), 0 6px 20px rgba(0,0,0,.35)` / `0 6px 22px rgba(99,102,241,.30)` |
| `--font-display` | `'IBM Plex Sans Thai','Inter',sans-serif` (crisp, not the rounded Mali) |
| `--font-th` (body) | keep `'Sarabun'` (clean, professional Thai) |

Removed decoration: the `sakura-fall` petals, candy `text-shadow` on titles/wordmark, gradient
buttons (→ solid indigo), heavy `backdrop-filter` blur (→ flat solid panels). `.btn-primary` =
solid indigo + light text + subtle hover; `.btn-ghost` = transparent + slate border.

## 4. Files touched

| File | Change |
|---|---|
| `src/theme/samurai.css` | rewrite `:root` tokens (§3), body bg, flatten panels, solid indigo buttons, drop petals/text-shadows/gradients, tighten radii, update fonts import |
| `src/components/SamuraiBackground.jsx` | render a flat dark CSS scene (slate base + faint radial glow) instead of the candy PNG |
| `src/App.jsx` (`LoadingScreen`) | inline pink gradient + purple text → dark slate bg + light text |
| `src/main.jsx` (`ErrorBoundary` card) | pink crash card → dark slate |
| `electron/splash.html` | pink/purple gradient + petals → dark slate splash |
| `electron/main.js` | window `backgroundColor` `#f3e6fb` → `#0f172a` (no white flash on launch) |
| `index.html` | boot-screen placeholder bg → dark |

## 5. Non-goals / notes

- No layout, copy, or behavior changes — purely visual tokens.
- Keep all class names (`.panel`, `.btn-primary`, `.nav-item`, `.app-sidebar`, `.badge`, …) so
  the React views and the two vanilla overlays re-skin without edits.
- The candy PNG assets (`public/assets/ui/bg-*.png`) are left on disk but no longer referenced.
- Verification: `npm run build-frontend` must pass; relaunch and confirm the app is dark and
  legible across Dashboard, Queue, Banners, Settings, login, and the watcher/profiles overlays.

## 6. Out of scope (future)

- Per-user light/dark toggle · custom accent picker · new illustrated empty-states matching the
  dark theme (current empty-state PNGs stay; they read acceptably on dark).
