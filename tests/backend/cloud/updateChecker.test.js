import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

let server;
const SUPA_URL = 'https://test.supabase.co';

beforeEach(() => {
    process.env.KINTENSHAUTO_SUPABASE_URL = SUPA_URL;
    process.env.KINTENSHAUTO_SUPABASE_ANON_KEY = 'anon';
});

afterEach(() => {
    if (server) server.close();
    delete process.env.KINTENSHAUTO_SUPABASE_URL;
    delete process.env.KINTENSHAUTO_SUPABASE_ANON_KEY;
});

describe('updateChecker.checkVersion', () => {
    it('returns ok:true when client is up to date', async () => {
        server = setupServer(
            http.post(`${SUPA_URL}/functions/v1/check-version`, () =>
                HttpResponse.json({ ok: true, force_update: null, soft_update: null }))
        );
        server.listen({ onUnhandledRequest: 'error' });

        const { checkVersion } = await import('../../../src/backend/cloud/updateChecker.js?n=' + Date.now());
        const r = await checkVersion('tok', '1.0.0');
        expect(r.ok).toBe(true);
        expect(r.force_update).toBeNull();
    });

    it('returns force_update when min_required > client_version', async () => {
        server = setupServer(
            http.post(`${SUPA_URL}/functions/v1/check-version`, () =>
                HttpResponse.json({
                    ok: false,
                    force_update: { required_version: '1.2.0', download_url: 'http://x.exe', release_notes_md: 'fix' },
                    soft_update: null
                }))
        );
        server.listen({ onUnhandledRequest: 'error' });
        const { checkVersion } = await import('../../../src/backend/cloud/updateChecker.js?n=' + Date.now());
        const r = await checkVersion('tok', '1.0.0');
        expect(r.ok).toBe(false);
        expect(r.force_update.required_version).toBe('1.2.0');
    });

    it('returns soft_update when latest > client_version (no force)', async () => {
        server = setupServer(
            http.post(`${SUPA_URL}/functions/v1/check-version`, () =>
                HttpResponse.json({
                    ok: true,
                    force_update: null,
                    soft_update: { latest_version: '1.1.0', release_notes_md: 'fixes', download_url: 'http://y.exe' }
                }))
        );
        server.listen({ onUnhandledRequest: 'error' });
        const { checkVersion } = await import('../../../src/backend/cloud/updateChecker.js?n=' + Date.now());
        const r = await checkVersion('tok', '1.0.0');
        expect(r.ok).toBe(true);
        expect(r.soft_update.latest_version).toBe('1.1.0');
    });

    it('treats network error as no-update (does not block app)', async () => {
        server = setupServer(
            http.post(`${SUPA_URL}/functions/v1/check-version`, () => HttpResponse.error())
        );
        server.listen({ onUnhandledRequest: 'error' });
        const { checkVersion } = await import('../../../src/backend/cloud/updateChecker.js?n=' + Date.now());
        const r = await checkVersion('tok', '1.0.0');
        expect(r.ok).toBe(true);
        expect(r.error).toBeDefined();
    });

    it('returns ok:true with reason=not_configured when cloud missing', async () => {
        delete process.env.KINTENSHAUTO_SUPABASE_URL;
        const { checkVersion } = await import('../../../src/backend/cloud/updateChecker.js?n=' + Date.now());
        const r = await checkVersion('tok', '1.0.0');
        expect(r.ok).toBe(true);
        expect(r.reason).toBe('not_configured');
    });

    it('returns ok:true with reason=no_token when token missing', async () => {
        const { checkVersion } = await import('../../../src/backend/cloud/updateChecker.js?n=' + Date.now());
        const r = await checkVersion(null, '1.0.0');
        expect(r.ok).toBe(true);
        expect(r.reason).toBe('no_token');
    });
});
