# 04 — Release Workflow

## ⚠️ HARD RULE

**Do NOT execute this workflow without explicit user instruction.**

The user has stated this preference and it is binding. Trigger phrases:
- "อัพ" / "อัพเลย" / "อัพขึ้น git"
- "publish" / "push release" / "release it" / "ship it"

Vague acknowledgment like "OK" or "ดี" after a code change is **NOT** a release trigger. Wait for the explicit phrase.

Why: every published version forces a download + restart on every active install within 5 minutes (continuous polling). Batching multiple changes into one release minimizes user-side churn.

## The 5 steps

### 1. Bump the version

```bash
# Edit package.json: "version": "1.0.X" → "1.0.X+1"
```

Use semver patch (`1.0.7 → 1.0.8`) for normal feature releases. Minor/major only on user request.

### 2. Build the installer

```bash
cd C:/Users/Pc2026/Desktop/KINTENSHAUTO-Source-v1.0.0
rm -rf dist-installer/win-unpacked dist-installer/KINTENSHAUTO-Setup-1.0.* dist-installer/latest.yml
npm run build-frontend
npx electron-builder --win --publish=never
```

Outputs (84MB installer takes ~5 min total):
- `dist-installer/KINTENSHAUTO-Setup-1.0.X.exe`
- `dist-installer/KINTENSHAUTO-Setup-1.0.X.exe.blockmap`
- `dist-installer/latest.yml`

Verify the build:
```bash
ls -lh dist-installer/KINTENSHAUTO-Setup-1.0.*.exe* dist-installer/latest.yml
cat dist-installer/latest.yml  # version should match package.json
```

### 3. Create the GitHub Release

```bash
PAT="<ASK USER FOR GH PAT — see 05-credentials.md>"
OWNER="Fordlovemm55"
REPO="kintenshauto-releases"
VERSION="1.0.X"

curl -s -X POST \
  -H "Authorization: Bearer $PAT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$OWNER/$REPO/releases" \
  -d "{
    \"tag_name\":\"v${VERSION}\",
    \"target_commitish\":\"main\",
    \"name\":\"v${VERSION} - <short description>\",
    \"body\":\"<release notes — kept short, no \\n escapes>\",
    \"draft\":false,
    \"prerelease\":false
  }"
```

**Critical:**
- `target_commitish: "main"` is required — without it, release creation silently fails (returns valid-looking JSON but no release row).
- Body must avoid `\n` literal escapes — they break parsing. Keep body to one paragraph or use literal newlines in the curl heredoc.

### 4. Upload the 3 assets

```bash
RELEASE_ID=$(curl -s -H "Authorization: Bearer $PAT" \
  "https://api.github.com/repos/$OWNER/$REPO/releases/tags/v${VERSION}" \
  | grep -oP '"id":\s*\K\d+' | head -1)

UP="https://uploads.github.com/repos/$OWNER/$REPO/releases/$RELEASE_ID/assets"
DIR="C:/Users/Pc2026/Desktop/KINTENSHAUTO-Source-v1.0.0/dist-installer"

# 1. latest.yml
curl -s -X POST -H "Authorization: Bearer $PAT" \
  -H "Content-Type: application/x-yaml" \
  "$UP?name=latest.yml" \
  --data-binary "@$DIR/latest.yml"

# 2. blockmap
curl -s -X POST -H "Authorization: Bearer $PAT" \
  -H "Content-Type: application/octet-stream" \
  "$UP?name=KINTENSHAUTO-Setup-${VERSION}.exe.blockmap" \
  --data-binary "@$DIR/KINTENSHAUTO-Setup-${VERSION}.exe.blockmap"

# 3. installer (84MB — ~10s)
curl -s -X POST -H "Authorization: Bearer $PAT" \
  -H "Content-Type: application/octet-stream" \
  "$UP?name=KINTENSHAUTO-Setup-${VERSION}.exe" \
  --data-binary "@$DIR/KINTENSHAUTO-Setup-${VERSION}.exe"
```

Verify:
```bash
curl -s "https://api.github.com/repos/$OWNER/$REPO/releases/latest" \
  | grep -E '"(tag_name|name|size)":'
```
Expected: `tag_name: "v1.0.X"`, 3 assets (latest.yml ~350B, blockmap ~90KB, installer ~84MB).

### 5. Insert / update the `app_versions` row

```bash
SUPABASE_PAT="<ASK USER — see 05-credentials.md>"
VERSION="1.0.X"
PREV_VERSION="1.0.X-1"

curl -s "https://api.supabase.com/v1/projects/etutmagymtlfagcsvavk/database/query" \
  -H "Authorization: Bearer $SUPABASE_PAT" \
  -H "Content-Type: application/json" \
  -d "{
    \"query\": \"UPDATE public.app_versions SET min_required = false WHERE version = '${PREV_VERSION}'; INSERT INTO public.app_versions (version, min_required, release_notes_md, download_url) VALUES ('${VERSION}', true, 'v${VERSION} — <notes>', 'https://github.com/Fordlovemm55/kintenshauto-releases/releases/download/v${VERSION}/KINTENSHAUTO-Setup-${VERSION}.exe') RETURNING version, min_required\"
  }"
```

**Set `min_required = true` for force update** (modal blocks until user updates).
**Set `min_required = false` for soft update** (modal has a "Later" button).

The check-version edge function returns the highest `min_required=true` row as `force_update`. To "demote" an old version from force, set its `min_required` back to `false` (as shown above with `PREV_VERSION`).

### 6. Restore version in package.json

This step is so you don't accidentally bump again on the next dev cycle.

```bash
# Edit package.json: "version": "1.0.X" → "1.0.0"
```

### 7. Tell the user

```
v1.0.X published.
URL: https://github.com/Fordlovemm55/kintenshauto-releases/releases/download/v1.0.X/KINTENSHAUTO-Setup-1.0.X.exe
Force: yes/no
Existing installs detect within 5 min via polling.
```

## Stable URLs for end-user distribution

The user's website distribution should link to one of:

| URL | Behavior |
|---|---|
| `https://github.com/Fordlovemm55/kintenshauto-releases/releases/latest` | Browser → latest release page → user clicks .exe in Assets |
| `https://github.com/Fordlovemm55/kintenshauto-releases/releases/download/v1.0.X/KINTENSHAUTO-Setup-1.0.X.exe` | Direct download of a specific version |

There is currently NO version-less stable download URL (e.g. `KINTENSHAUTO-Setup.exe`) because asset names include the version. If the user requests one, the way to add it is to also upload a copy named `KINTENSHAUTO-Setup.exe` (no version) to each release.

## Common publish-time errors

| Error | Cause | Fix |
|---|---|---|
| Release created but ID is empty in response | Missing `target_commitish: "main"` in payload | Re-create with that field |
| `{"errors":[{"resource":"Release","code":"already_exists","field":"tag_name"}]}` | Tag already exists from a previous attempt | Delete via DELETE API or upload assets to existing tag |
| 84MB upload returns no body | Network glitch, or release_id wrong | Re-run upload — assets API is idempotent if you skip duplicate names |
| `app_versions` insert returns empty `[]` | Body of edge-function INSERT had unescaped chars (`\n` mid-string) | Re-run with simpler one-line release_notes_md |
| User reports "update failed: signature" | Old install (< v1.0.5) doesn't have verifyUpdateCodeSignature override | Tell user to manually download the latest installer from the URL above (one-time) |

## When NOT to set `min_required=true` (force update)

- Pre-release / beta version targeting only specific users → release as `prerelease: true` on GitHub AND do NOT insert into `app_versions`. Only force-update via app_versions for stable releases everyone should run.
- Hotfix that's incomplete — set `min_required=false` first; bump to `true` only after smoke-testing in the wild.
- Major behavior change with breaking config → give users a soft-update window first, then escalate to force.

## Rollback

There is no automatic rollback. To recover from a bad release:

1. Build a "fix-forward" patch version (e.g. v1.0.9 if v1.0.8 broke things) with the bug fixed
2. Upload as a NEW GitHub Release
3. Insert into `app_versions` with `min_required=true`
4. Optionally: DELETE the bad release's `app_versions` row so it stops being a candidate
5. Users force-update past the bad version automatically

For nuclear cases (corrupted DB schema, lost data risk): notify users in advance via the modal `release_notes_md` field BEFORE pushing.
