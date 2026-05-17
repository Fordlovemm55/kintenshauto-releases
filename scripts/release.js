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

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAIN_PATH = path.join(__dirname, '..', 'electron', 'main.js');
const PLACEHOLDER = 'REDACTED_GH_PAT';

function fail(msg) {
    console.error('[release] ' + msg);
    process.exit(1);
}

const token = process.env.GH_TOKEN;
if (!token) {
    fail('GH_TOKEN env var must be set (PAT with repo scope on the release repo)');
}
if (!/^(ghp_|github_pat_)/.test(token)) {
    fail('GH_TOKEN does not look like a GitHub PAT (expected ghp_... or github_pat_...)');
}

const original = fs.readFileSync(MAIN_PATH, 'utf-8');
if (!original.includes(PLACEHOLDER)) {
    fail(`Placeholder "${PLACEHOLDER}" not found in electron/main.js — already injected? Restore from git first.`);
}

// Inject. Single occurrence by design — fail loudly if there are multiple.
const occurrences = original.split(PLACEHOLDER).length - 1;
if (occurrences !== 1) {
    fail(`Expected exactly 1 placeholder, found ${occurrences}. Aborting to avoid partial injection.`);
}

const injected = original.replace(PLACEHOLDER, token);
fs.writeFileSync(MAIN_PATH, injected);
console.log('[release] Injected GH_TOKEN into electron/main.js');

let exitCode = 0;
try {
    // 1. Frontend (vite). Cheap to re-run; ensures dist/ matches HEAD source.
    console.log('[release] Building frontend...');
    let result = spawnSync('npm', ['run', 'build-frontend'], {
        stdio: 'inherit',
        shell: true
    });
    if (result.status !== 0) {
        exitCode = result.status || 1;
        throw new Error('build-frontend failed with exit ' + exitCode);
    }

    // 2. Electron-builder. Forward CLI args; default to --win if none given.
    const extraArgs = process.argv.slice(2);
    const args = extraArgs.length ? extraArgs : ['--win'];
    console.log('[release] Running: electron-builder ' + args.join(' '));
    result = spawnSync('npx', ['electron-builder', ...args], {
        stdio: 'inherit',
        shell: true,
        env: { ...process.env } // GH_TOKEN inherited for --publish auth
    });
    if (result.status !== 0) {
        exitCode = result.status || 1;
        throw new Error('electron-builder failed with exit ' + exitCode);
    }
    console.log('[release] Build + publish succeeded');
} catch (e) {
    console.error('[release] ' + e.message);
} finally {
    fs.writeFileSync(MAIN_PATH, original);
    console.log('[release] Restored placeholder in electron/main.js');
}

process.exit(exitCode);
