# 06 — Common Pitfalls (and the fixes that worked)

Bugs we already hit and resolved. Don't repeat them.

## P1: "Cloud not configured" on login screen (resolved in v1.0.x, very early)

**Symptom:** User installs the app, opens it, login screen shows "cloud not configured" error.

**Root cause:** `.env` is gitignored AND NOT in the `package.json` `files:` array, so it wasn't packaged into the installer. `src/backend/cloud/config.js` looked for `.env` on disk and found nothing.

**Fix:** Embed safe-to-expose defaults directly in `config.js`:
```js
const DEFAULT_SUPABASE_URL = 'https://etutmagymtlfagcsvavk.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_zlRdIib67v6B8cml000r2g_t8Ne-K_0';
// then in getCloudConfig():
const supabaseUrl = process.env.KINTENSHAUTO_SUPABASE_URL
  || (inTest ? null : DEFAULT_SUPABASE_URL);
```

`.env` still wins in dev for staging overrides. `inTest` guard preserves test-mode "missing config" assertions.

## P2: "Node.js detected without native WebSocket support"

**Symptom:** Realtime channels fail to subscribe, log shows the warning above. Device kick + ban don't propagate.

**Root cause:** Electron 32 embeds Node 20, which has no global `WebSocket`. `@supabase/realtime-js` v2.x requires either Node 22+ (with native WebSocket) OR an explicit `transport` option pointing to the `ws` package on Node < 22.

**Fix in `src/backend/cloud/supabaseClient.js`:**
```js
const ws = require('ws');
const REALTIME_OPTIONS = { transport: ws };
// pass to createClient:
createClient(url, key, { realtime: REALTIME_OPTIONS, ... });
```

ALSO add `"ws": "^8.x"` to `package.json` `dependencies` (not just transitive) so electron-builder reliably bundles it into the asar.

## P3: "Update failed: New version is not signed by the application owner"

**Symptom:** Auto-update downloads but refuses to install. App.log shows: `Update error: New version is not signed by the application owner: publisherNames: KINTENSHAUTO`.

**Root cause:** `publisherName: "KINTENSHAUTO"` was set in `package.json` `build.win`. electron-updater verifies the downloaded installer's Authenticode signature against that name. We don't have a code-signing cert, so verification fails.

**Fix:**
1. Remove `publisherName` from `build.win` in `package.json`.
2. In `electron/main.js setupAutoUpdater()`:
   ```js
   autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(null);
   ```

User must install a fixed version manually once to get past it; subsequent updates work.

## P4: Device kick never fires (admin force-logout, ban, takeover)

**Symptom:** Admin clicks "Reset device" or "Ban" on admin panel. Desktop app stays logged in.

**Root cause:** The `execute_claim` RPC + `emit_device_kick` RPC use Postgres `pg_notify(...)`. The desktop client (`deviceGuard.subscribeKick`) was listening for Realtime `broadcast` events. These are two unrelated mechanisms — they never connect.

**Fix:** Switch the client subscription to `postgres_changes` on the `user_devices` table:

```js
client.channel(`user-devices-${userId}`)
  .on('postgres_changes', {
    event: '*', schema: 'public', table: 'user_devices',
    filter: `user_id=eq.${userId}`
  }, (payload) => {
    if (payload.eventType === 'DELETE') fire('admin_force_logout');
    const newToken = payload.new?.session_token;
    if (mySessionToken && newToken && newToken !== mySessionToken) {
      fire('another_device_signed_in');
    }
  })
  .subscribe();
```

Required server-side step: enable the Realtime publication for the table.
```sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.user_devices;
```

For Ban: the admin server action ALSO does `DELETE FROM user_devices WHERE user_id = ?` — triggers the DELETE event so the active session is kicked even though the user's JWT hasn't expired.

## P5: Admin panel `/users` page is slow (~3-4s on each navigation)

**Root cause (Phase 1):** middleware called `supabase.auth.getUser()` on every request — that's a network call to Supabase per page hit. Multiply by US-East Vercel → Seoul Supabase round-trip = 250-400ms baseline overhead.

**Root cause (Phase 2):** `requireAdmin()` in layout AND page both called `getUser()` separately.

**Fixes:**
1. Middleware: `getSession()` (local cookie read) instead of `getUser()` (network call).
2. `requireAdmin()` wrapped in React `cache()` — dedupes per render.
3. Tighter middleware matcher — only protected routes (`/users`, `/sessions`, ...), not everything.
4. Removed `revalidatePath('/', 'layout')` from sign-in action — redirect already triggers fresh render.
5. **Biggest win:** Moved Vercel deployment region to `icn1` (Seoul) via `vercel.json`. Co-locates with Supabase, removes ~250ms RTT on every internal call.

Result: warm `/users` from 421ms → 156ms.

## P6: Realtime kick subscriber needs `mySessionToken` to filter

**Symptom:** When implementing P4, the listener fires on UPDATE events for the same device (e.g. heartbeat). False kicks.

**Fix:** Pass the current device's `session_token` (from `claim.session_token` after device-claim) to `subscribeKick(...)`. Compare against `payload.new?.session_token`. Only fire kick if they differ.

```js
// server.js after login
subscribeKick(result.user.id, result.session.access_token, claim.session_token, async (reason) => {
  // ...kick handler
});
```

## P7: GitHub release creation silently fails

**Symptom:** `POST /repos/.../releases` returns 201 with full JSON body but the release does NOT appear in repo. Subsequent `GET /releases/tags/<tag>` returns 404.

**Root cause:** Missing `target_commitish: "main"` in the payload. Without it, GitHub creates an unattached ref that gets garbage-collected.

**Fix:** Always include `"target_commitish": "main"` in the release create body.

## P8: Supabase Storage rejects > 50MB upload (free tier)

**Symptom:** Uploading the 84MB installer to a Supabase Storage public bucket returns `413 Payload too large` even though the bucket has no file_size_limit set.

**Root cause:** Free-tier Supabase has a global 50MB upload cap regardless of bucket config. Pro plan ($25/mo) raises the limit.

**Fix:** Use GitHub Releases as the host instead (2GB per file, free). Public repo for direct download (no PAT needed). See [04-release-workflow.md](04-release-workflow.md).

## P9: Build fails with "Cannot create symbolic link" from winCodeSign cache

**Symptom:** `npx electron-builder --win` fails repeatedly. Error log mentions `winCodeSign-2.6.0/darwin/10.12/lib/libcrypto.dylib — A required privilege is not held by the client`.

**Root cause:** electron-builder downloads winCodeSign cache, which contains macOS dylib SYMLINKS that Windows can't create without admin or Developer Mode.

**Fix (one-time):** Pre-extract the cache excluding the `darwin/` folder (we don't need it for Windows builds):
```bash
ARCHIVE="C:/Users/Pc2026/AppData/Local/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0.7z"
DEST="C:/Users/Pc2026/AppData/Local/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0"
rm -rf "$DEST"
node_modules/7zip-bin/win/x64/7za.exe x "$ARCHIVE" -o"$DEST" '-x!darwin' '-y'
```

After this, subsequent `electron-builder` runs succeed without needing admin.

## P10: Hardcoded `1.0.0` showing in UI after updates

**Symptom:** User updates to v1.0.7 but the splash screen / setup wizard / login page still displays "v1.0.0".

**Root cause:** Version was hardcoded in multiple places:
- `electron/splash.html:90` — literal `<div class="status">v1.0.0</div>`
- `src/setup-wizard/SetupWizard.jsx:402` — literal `v1.0.0 · ขั้นตอน {step}/5`
- `src/Dashboard.jsx:38` — `useState('1.0.0')` default (visible during the brief getVersion fetch)
- `src/backend/server.js:481` — `/api/health` returned `version: '1.0.0'` hardcoded
- `tests/backend/server.health.test.js` — assertion on the hardcoded string

**Fix pattern:**
- Splash: empty placeholder + `splashWindow.webContents.executeJavaScript('document.getElementById("app-version").textContent = ...')` after splash loads.
- React components: `useState('')` initial + `useEffect(() => window.kintenshauto?.getVersion?.().then(setVersion))`.
- Backend: `require('../../package.json').version`.
- Tests: assert against `require('../../package.json').version` + a semver regex.

After this, `package.json` is the single source of truth — bump it once, every UI surface updates on next build.

## P11: NSIS silent install ignores /D flag

**Symptom:** `KINTENSHAUTO-Setup-1.0.0.exe /S /D=C:\test` exits 0 but no install happens.

**Root cause:** `oneClick: false` in `package.json` `build.nsis` makes the installer wizard-style — `/S` silent mode is partially honored but `/D=` is sometimes ignored. NSIS picks the default install dir.

**Workaround:** Either let the installer use its default `C:/Program Files/KINTENSHAUTO/` location, or change `oneClick: true` temporarily for silent install testing. For production user installs, always go through the wizard.

## P12: Two concurrent backend processes

**Symptom:** App seems duplicated, logs show two parallel `[ChannelWatcher]` ticks, `EADDRINUSE :3003`.

**Root cause:** Backend crashed, electron auto-restarts it (up to 3x in 60s per `electron/main.js`). The kill of the OLD process didn't complete before the NEW one came up.

**Fix:**
- `taskkill /F /IM KINTENSHAUTO.exe /T` (kills tree)
- Then relaunch normally
- If you also see leftover `node.exe` processes spawned as backend: `taskkill /F /IM node.exe /T` (warning: kills ALL node processes on the machine)

## P13: Admin user can't access /users (signed in but redirected to /login)

**Symptom:** Admin logs in successfully (cookies set), but every protected page redirects back to /login.

**Root cause:** `app_metadata.is_admin` not set on the user. `requireAdmin()` checks `user.app_metadata?.is_admin === true` and falls through to /login if false.

**Fix:** Run the promote-admin script:
```bash
cd C:/Users/Pc2026/Desktop/kintenshauto-admin
npx tsx scripts/promote-admin.ts <user-email>
```

Or directly via SQL (using service_role):
```sql
UPDATE auth.users
SET raw_app_meta_data = jsonb_set(raw_app_meta_data, '{is_admin}', 'true'::jsonb)
WHERE email = 'admin@kintenshauto.local';
```

## P14: Vite `emptyOutDir` wiped hand-written injection scripts

**Symptom:** `npm run build-frontend` removed `dist/assets/watcher-injection.js` + `profiles-injection.js`. The Channel Watcher + Profile Manager screens broke.

**Root cause:** Vite's `emptyOutDir: true` (default) clears `dist/` before writing the new bundle. The hand-written files weren't sourced from Vite, so they got nuked.

**Fix:** Move them to `public/assets/`. Vite copies `public/` verbatim into `dist/` on build, so they survive. Source `index.html` references them via `<script defer src="/assets/watcher-injection.js">` — paths are the same.
