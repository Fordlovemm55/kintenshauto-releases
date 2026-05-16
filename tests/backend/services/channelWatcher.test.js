import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
const require = createRequire(import.meta.url);

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CHANNEL_WATCHER_PATH = path.join(REPO_ROOT, 'src/backend/services/channelWatcher.js');
const CORE_ORCHESTRATOR_PATH = path.join(REPO_ROOT, 'src/backend/core/orchestrator.js');
const CORE_PEAKSCHEDULE_PATH = path.join(REPO_ROOT, 'src/backend/core/peakSchedule.js');

function purgeRelatedFromRequireCache() {
    // Clear cached modules so that re-requiring channelWatcher re-executes its
    // top-level require()s. Without this, a previously-cached module would mask
    // path regressions in subsequent test runs within the same vitest worker.
    for (const key of Object.keys(require.cache)) {
        if (
            key === CHANNEL_WATCHER_PATH ||
            key === CORE_ORCHESTRATOR_PATH ||
            key === CORE_PEAKSCHEDULE_PATH
        ) {
            delete require.cache[key];
        }
    }
}

describe('channelWatcher module loading', () => {
    beforeEach(() => {
        purgeRelatedFromRequireCache();
    });

    it('loads its real orchestrator + peakSchedule deps from src/backend/core/', () => {
        // Sanity: the destination modules at src/backend/core/ exist and expose
        // the helpers channelWatcher destructures off them.
        const orch = require(CORE_ORCHESTRATOR_PATH);
        expect(typeof orch.hashUrl).toBe('function');
        expect(typeof orch.canonicalUrl).toBe('function');
        expect(typeof orch.ffprobeDuration).toBe('function');

        const peak = require(CORE_PEAKSCHEDULE_PATH);
        expect(typeof peak.toSqlLocal).toBe('function');

        // Re-purge so channelWatcher.js actually re-runs its top-level requires
        // (otherwise it would just hit the cached versions we loaded above).
        purgeRelatedFromRequireCache();

        // Load channelWatcher — its top-level try/catch silently swallows
        // require errors and falls back to stubs, so this never throws even if
        // the paths are wrong. Instead we verify the side-effect: after load,
        // src/backend/core/orchestrator.js MUST be in require.cache.
        const watcherModule = require(CHANNEL_WATCHER_PATH);

        // Regression assertion: channelWatcher must have successfully required
        // the real orchestrator/peakSchedule from src/backend/core/. If the
        // require paths regress (e.g. back to '../orchestrator' which no longer
        // exists), the try/catch falls back to stubs and these cache entries
        // are absent.
        expect(require.cache[CORE_ORCHESTRATOR_PATH]).toBeDefined();
        expect(require.cache[CORE_PEAKSCHEDULE_PATH]).toBeDefined();

        // Sanity: the SUPPORTED_PLATFORMS export is reachable (means the module
        // fully loaded).
        expect(watcherModule.SUPPORTED_PLATFORMS).toContain('youtube');
    });
});
