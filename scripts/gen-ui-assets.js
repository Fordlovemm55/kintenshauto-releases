/**
 * KINTENSHAUTO — UI art-asset generator (Google Imagen).
 *
 * Generates every visual element of the redesigned UI as text-free art via the
 * Google Generative Language image API. Backgrounds are full cinematic images;
 * icons / crest / empty-state art are luminous GOLD line-art on PURE BLACK so the
 * UI can drop the black out with CSS `mix-blend-mode: screen` on the dark theme.
 *
 * Key is read from env IMG_API_KEY (never hard-coded / committed).
 * Model defaults to the highest-quality Imagen (override with IMG_MODEL).
 *
 *   IMG_API_KEY=...  node scripts/gen-ui-assets.js                # generate all (skip existing)
 *   IMG_API_KEY=...  node scripts/gen-ui-assets.js --only bg-app,crest
 *   IMG_API_KEY=...  node scripts/gen-ui-assets.js --force        # regenerate all
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY = process.env.IMG_API_KEY || process.env.GEMINI_API_KEY || '';
if (!KEY) { console.error('NO KEY: set IMG_API_KEY and re-run.'); process.exit(2); }
const MODEL = process.env.IMG_MODEL || 'imagen-4.0-ultra-generate-001';
const FALLBACK_MODELS = ['imagen-4.0-generate-001', 'imagen-4.0-fast-generate-001'];
const OUT_DIR = path.join(__dirname, '..', 'public', 'assets', 'ui');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const onlyArg = args.find(a => a.startsWith('--only'));
const ONLY = onlyArg ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1] || '').split(',').filter(Boolean) : null;

const mask = KEY.length > 8 ? `${KEY.slice(0, 4)}…${KEY.slice(-4)}` : '(short)';

// ---- Shared style language: glossy 3D candy, PURPLE + GOLD + pink ----------
// Theme "ออโต้โพสต์ดีว๊ะ": bright candy palette — purple #7c3aed/#a855f7, magenta-pink
// #ff6fb5, warm gold #f5c542, soft lavender/pink backgrounds. All assets are
// real 3D renders (NOT flat illustration/line-art). Icons are self-contained
// rounded "app-icon" tiles (object + soft gradient baked in) so no transparency
// trick is needed on the light theme — the UI just clips corners with CSS radius.
const ICON_STYLE = 'a cute glossy 3D rendered mobile-app icon, soft inflated rounded shapes, smooth shiny candy/plastic material with subtle subsurface scattering and glossy highlights, vibrant purple and magenta with warm gold accents and a touch of pink, soft bright studio lighting with gentle reflections and a soft drop shadow, centered with even padding, sitting on a soft rounded-square background gradient going from light lavender to soft pink, modern playful premium 3D icon set aesthetic, Blender / Octane render, ultra clean and bright, NO text, NO letters, NO numbers, NO words, NO watermark';
const ART_STYLE = 'a cute glossy 3D rendered object floating with a soft drop shadow, soft inflated candy style, smooth shiny material, vibrant purple and gold with pink accents, soft bright studio lighting, on a clean soft light-lavender background, playful and friendly, Blender / Octane render, NO text, NO letters, NO words, NO watermark';

function bg(desc) {
  return `A soft dreamy bright 3D rendered background. ${desc}. Bright candy palette: light pink, lavender and soft purple with warm gold sparkles, floating glossy translucent purple-and-gold 3D spheres and gentle bokeh, very bright airy and clean, lots of soft open space in the centre so overlaid UI panels and text stay readable, modern playful premium aesthetic, Blender / Octane render. Absolutely NO text, NO letters, NO numbers, NO logos, NO characters, NO watermark, NO UI elements.`;
}

const SPECS = [
  // ---- Backgrounds (bright 3D candy, opaque) ----
  { name: 'bg-app', aspect: '16:9', prompt: bg('floating glossy purple and gold 3D spheres of varying sizes drifting near the corners, small gold star sparkles, soft pastel clouds, a gentle gradient from light pink at the top to soft lavender at the bottom, the whole centre kept bright soft and open') },
  { name: 'bg-login', aspect: '16:9', prompt: bg('a few large soft glossy purple-and-gold 3D spheres clustered toward the corners with gold sparkles, a dreamy soft pink-to-lavender gradient, the centre kept bright clean and open for a login card') },
  { name: 'bg-setup', aspect: '16:9', prompt: bg('a welcoming cheerful scene with soft floating glossy purple-gold 3D spheres and scattered gold confetti sparkles, a soft pink-lavender gradient, bright open and clean in the centre') },

  // ---- Brand emblem (3D, shown as a round badge) ----
  { name: 'crest', aspect: '1:1', prompt: `A cute glossy 3D emblem: a shiny golden crown topped with a sparkling purple star gem, surrounded by a few tiny gold sparkles, premium and adorable (a 'diva' crown). ${ICON_STYLE}` },

  // ---- Navigation icons (glossy 3D app-icon tiles) ----
  { name: 'icon-home', aspect: '1:1', prompt: `A cute glossy 3D little house with a small heart, home theme. ${ICON_STYLE}` },
  { name: 'icon-profiles', aspect: '1:1', prompt: `A cute glossy 3D ID card with a friendly round user avatar, accounts/profiles theme. ${ICON_STYLE}` },
  { name: 'icon-banners', aspect: '1:1', prompt: `A cute glossy 3D picture frame / image banner, image overlay theme. ${ICON_STYLE}` },
  { name: 'icon-comments', aspect: '1:1', prompt: `A cute glossy 3D chat speech bubble with a tiny heart, comments theme. ${ICON_STYLE}` },
  { name: 'icon-ai', aspect: '1:1', prompt: `A cute glossy 3D magic wand with sparkle stars, AI magic theme. ${ICON_STYLE}` },
  { name: 'icon-queue', aspect: '1:1', prompt: `A cute glossy 3D clipboard checklist / stack of layered cards, task queue theme. ${ICON_STYLE}` },
  { name: 'icon-reviews', aspect: '1:1', prompt: `A cute glossy 3D magnifying glass with a small shield-check, inspection theme. ${ICON_STYLE}` },
  { name: 'icon-settings', aspect: '1:1', prompt: `A cute glossy 3D gear / cog wheel, settings theme. ${ICON_STYLE}` },
  { name: 'icon-watcher', aspect: '1:1', prompt: `A cute glossy 3D radar dish with a small bell, channel-watching/notify theme. ${ICON_STYLE}` },

  // ---- Empty-state illustrations (glossy 3D, light bg) ----
  { name: 'empty-queue', aspect: '1:1', prompt: `An empty open glossy 3D box / tray with nothing inside, idle and tidy. ${ART_STYLE}` },
  { name: 'empty-reviews', aspect: '1:1', prompt: `A glossy 3D shield with a big gold check mark, everything clear. ${ART_STYLE}` },
  { name: 'empty-comments', aspect: '1:1', prompt: `A single glossy 3D empty chat speech bubble, no messages yet. ${ART_STYLE}` },
  { name: 'empty-banners', aspect: '1:1', prompt: `A glossy 3D empty picture frame, no banners yet. ${ART_STYLE}` },
  { name: 'empty-watcher', aspect: '1:1', prompt: `A glossy 3D radar dish with a tiny floating 'zzz' sleep symbol, quiet and waiting. ${ART_STYLE}` },
  { name: 'empty-generic', aspect: '1:1', prompt: `A single cute glossy 3D star with a sparkle, friendly and simple. ${ART_STYLE}` },
];

async function callImagen(model, prompt, aspect) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${encodeURIComponent(KEY)}`;
  const body = { instances: [{ prompt: prompt.slice(0, 2000) }], parameters: { sampleCount: 1, aspectRatio: aspect } };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const t = await res.text().catch(() => res.statusText); const e = new Error(`HTTP ${res.status}: ${t.slice(0, 250)}`); e.status = res.status; throw e; }
  const data = await res.json();
  const b64 = data?.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error('no image bytes: ' + JSON.stringify(data).slice(0, 200));
  return Buffer.from(b64, 'base64');
}

async function generate(prompt, aspect) {
  const models = [MODEL, ...FALLBACK_MODELS].filter((m, i, a) => a.indexOf(m) === i);
  let lastErr;
  for (const model of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return { buf: await callImagen(model, prompt, aspect), model }; }
      catch (e) {
        lastErr = e;
        if (e.status && e.status < 500 && e.status !== 429) break; // bad request/auth → try next model, not retry
        await new Promise(r => setTimeout(r, attempt * 1500));
      }
    }
  }
  throw lastErr;
}

function loadManifest() { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return { generatedWith: MODEL, keyFingerprint: mask, assets: {} }; } }

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = loadManifest();
  manifest.assets = manifest.assets || {};
  const targets = SPECS.filter(s => (ONLY ? ONLY.includes(s.name) : true));
  console.log(`Key ${mask} · model ${MODEL} · ${targets.length} asset(s) · out ${OUT_DIR}`);
  let done = 0, skipped = 0, failed = 0;

  for (const spec of targets) {
    const file = path.join(OUT_DIR, `${spec.name}.png`);
    if (!FORCE && !ONLY && fs.existsSync(file) && manifest.assets[spec.name]?.status === 'ok') { skipped++; console.log(`  skip   ${spec.name} (exists)`); continue; }
    process.stdout.write(`  gen    ${spec.name} (${spec.aspect}) ... `);
    try {
      const { buf, model } = await generate(spec.prompt, spec.aspect);
      fs.writeFileSync(file, buf);
      manifest.assets[spec.name] = { file: `assets/ui/${spec.name}.png`, model, aspect: spec.aspect, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16), status: buf.length > 8000 ? 'ok' : 'flagged', at: new Date().toISOString().slice(0, 19) };
      console.log(`${(buf.length / 1024).toFixed(0)} KB via ${model}${buf.length <= 8000 ? ' [FLAGGED tiny]' : ''}`);
      done++;
    } catch (e) { failed++; console.log(`FAILED: ${e.message}`); manifest.assets[spec.name] = { status: 'failed', error: String(e.message).slice(0, 200), at: new Date().toISOString().slice(0, 19) }; }
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  }
  console.log(`\nDone: ${done} generated, ${skipped} skipped, ${failed} failed. Manifest: ${MANIFEST}`);
  process.exit(failed && !done ? 1 : 0);
})();
