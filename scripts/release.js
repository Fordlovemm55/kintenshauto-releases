#!/usr/bin/env node
/**
 * Release build with embedded GH_TOKEN.
 *
 * What this does
 *   1. Reads GH_TOKEN from process.env
 *   2. Temporarily replaces the REDACTED_GH_PAT placeholder in electron/main.js
 *      with the real token (so the auto-updater in the shipped installer
 *      can authenticate against the private GitHub release repo).
 *   3. Runs the frontend build + electron-builder. Any args you pass through
 *      are forwarded to electron-builder. Use `--publish always` to also
 *      upload the installer + latest.yml to GitHub Releases.
 *   4. Restores the placeholder in electron/main.js — even if the build
 *      throws — so the token never gets committed.
 *
 * Why a script instead of an env-var read at runtime
 *   The user's machine has no way to set GH_TOKEN before running the .exe.
 *   The token MUST be baked into the bundle. We just don't want it in git.
 *
 * Usage
 *   PowerShell:  $env:GH_TOKEN = "ghp_..."; npm run release -- --publish always
 *   Cmd:         set GH_TOKEN=ghp_... && npm run release -- --publish always
 *   Bash:        GH_TOKEN=ghp_... npm run release -- --publish always
 *
 * After a successful release, REVOKE the token at https://github.com/settings/tokens
 * if it was a one-shot — long-lived tokens are a risk if this machine is
 * ever compromised.
 */

const { spawnSync } = require('child_process');

function fail(msg) {
    console.error('[release] ' + msg);
    process.exit(1);
}

// GH_TOKEN is needed for the --publish step (write access to create the release
// + upload assets) but is NO LONGER baked into the installer — the release
// repo is public, so electron-updater fetches anonymously. This removes the
// chicken-and-egg where revoking the embedded token broke auto-update for
// every installed user.
const token = process.env.GH_TOKEN;
if (!token) {
    fail('GH_TOKEN env var must be set (PAT with repo scope to publish the release)');
}
if (!/^(ghp_|github_pat_)/.test(token)) {
    fail('GH_TOKEN does not look like a GitHub PAT (expected ghp_... or github_pat_...)');
}

let exitCode = 0;
try {
    console.log('[release] Building frontend...');
    let result = spawnSync('npm', ['run', 'build-frontend'], {
        stdio: 'inherit',
        shell: true
    });
    if (result.status !== 0) {
        exitCode = result.status || 1;
        throw new Error('build-frontend failed with exit ' + exitCode);
    }

    const extraArgs = process.argv.slice(2);
    const args = extraArgs.length ? extraArgs : ['--win'];
    console.log('[release] Running: electron-builder ' + args.join(' '));
    result = spawnSync('npx', ['electron-builder', ...args], {
        stdio: 'inherit',
        shell: true,
        env: { ...process.env } // GH_TOKEN inherited for --publish auth only
    });
    if (result.status !== 0) {
        exitCode = result.status || 1;
        throw new Error('electron-builder failed with exit ' + exitCode);
    }
    console.log('[release] Build + publish succeeded');
} catch (e) {
    console.error('[release] ' + e.message);
}

process.exit(exitCode);
