// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';

// Phase 9 T3: 'Apply & restart now' chains Phase 8 apply + Phase 9
// restart. Polls /api/update/progress until phase==done, then POSTs
// /api/restart. The 0x05 frame handler arms the reload poller; we
// also fire a hard reload as backup.

setupDomHarness();

// Construct via prototype (per markdownExportImport.test.js) to avoid the
// real constructor's DOM wiring (_setupEventListeners etc.), which isn't
// relevant here. _startUpdateApplyAndRestart and its _formatProgress
// helper are driven straight off MarkdownManager.prototype — no copy.
// Neither method reads any instance field (only this._formatProgress),
// so there's nothing to seed on the fake `this`.
function makeMarkdownManager() {
    return Object.create(MarkdownManager.prototype);
}

// Models the banner AFTER _startUpdateApply has already run once — that's
// the method that creates .update-banner-progress (web/markdown.js:566-569);
// _buildUpdateBanner itself never does. Apply and Restart get independent
// click listeners (web/markdown.js:544 and :556), so a user can click
// "Apply & restart now" first on a freshly built banner, with no
// .update-banner-progress element yet. That progressEl === null path is
// real, and production guards every dereference with `if (progressEl)`
// for exactly that reason — it is NOT covered by this fixture or these
// tests.
function makeBanner() {
    const banner = document.createElement('div');
    banner.className = 'update-banner';
    banner.innerHTML = `
        <div class="update-banner-actions">
            <button class="update-banner-btn apply">Apply</button>
            <button class="update-banner-btn update-banner-btn-restart">Apply &amp; restart now</button>
        </div>
        <div class="update-banner-progress"></div>
    `;
    document.body.appendChild(banner);
    return banner;
}

describe('Phase 9 T3: Apply & restart now', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('chains apply -> poll-until-done -> restart', async () => {
        // Mock fetch: first call returns apply-OK, then 2 progress polls
        // (downloading then done), then restart-OK.
        const fakeFetch = vi
            .fn()
            .mockResolvedValueOnce({ ok: true }) // /api/update/apply
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ phase: 'downloading', pct: 50 }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ phase: 'done' }),
            })
            .mockResolvedValueOnce({ ok: true }); // /api/restart
        vi.stubGlobal('fetch', fakeFetch);

        const reloadSpy = vi.fn();
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: { reload: reloadSpy, href: 'http://localhost/' },
        });
        vi.useFakeTimers();

        const mm = makeMarkdownManager();
        const banner = makeBanner();
        const restartBtn = banner.querySelector('.update-banner-btn-restart');
        const applyBtn = banner.querySelector('.update-banner-btn');

        // Kick off the chain (don't await)
        const promise = mm._startUpdateApplyAndRestart(
            'v0.8.2',
            restartBtn,
            applyBtn,
            banner,
        );

        // Let microtasks + the 500ms inter-poll delay advance
        await vi.advanceTimersByTimeAsync(600);
        await promise;
        await vi.advanceTimersByTimeAsync(3000); // for the 2500 reload fallback

        // Sequence check
        const urls = fakeFetch.mock.calls.map((c) => c[0]);
        expect(urls[0]).toBe('/api/update/apply');
        expect(urls[1]).toBe('/api/update/progress');
        expect(urls[2]).toBe('/api/update/progress');
        expect(urls[3]).toBe('/api/restart');

        // Buttons end up disabled (chain succeeded; we are restarting)
        expect(restartBtn.disabled).toBe(true);
        expect(restartBtn.textContent).toBe('Restarting…');

        expect(reloadSpy).toHaveBeenCalled();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('does NOT restart if staging fails (phase=error)', async () => {
        const fakeFetch = vi
            .fn()
            .mockResolvedValueOnce({ ok: true }) // /api/update/apply
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    phase: 'error',
                    error: 'checksum mismatch',
                }),
            });
        vi.stubGlobal('fetch', fakeFetch);

        const mm = makeMarkdownManager();
        const banner = makeBanner();
        const restartBtn = banner.querySelector('.update-banner-btn-restart');
        const applyBtn = banner.querySelector('.update-banner-btn');

        await mm._startUpdateApplyAndRestart(
            'v0.8.2',
            restartBtn,
            applyBtn,
            banner,
        );

        // Exactly apply + one progress poll: the error phase must stop the
        // loop immediately (web/markdown.js:673-674), not fall through to
        // `return false` and poll again. Pins the guard itself rather than
        // an accidental TypeError from a 3rd call hitting exhausted mocks.
        expect(fakeFetch).toHaveBeenCalledTimes(2);

        // Buttons re-enabled for retry
        expect(restartBtn.disabled).toBe(false);
        expect(restartBtn.textContent).toBe('Apply & restart now');
        expect(applyBtn.disabled).toBe(false);

        // /api/restart was NOT called
        const urls = fakeFetch.mock.calls.map((c) => c[0]);
        expect(urls).not.toContain('/api/restart');

        vi.unstubAllGlobals();
    });

    it('does NOT restart if /api/update/apply itself errors', async () => {
        const fakeFetch = vi.fn().mockResolvedValueOnce({
            ok: false,
            text: async () => 'Forbidden: install method not eligible',
        });
        vi.stubGlobal('fetch', fakeFetch);

        const mm = makeMarkdownManager();
        const banner = makeBanner();
        const restartBtn = banner.querySelector('.update-banner-btn-restart');
        const applyBtn = banner.querySelector('.update-banner-btn');

        await mm._startUpdateApplyAndRestart(
            'v0.8.2',
            restartBtn,
            applyBtn,
            banner,
        );

        expect(restartBtn.disabled).toBe(false);
        const progress = banner.querySelector('.update-banner-progress');
        expect(progress.textContent).toContain('Forbidden');

        const urls = fakeFetch.mock.calls.map((c) => c[0]);
        expect(urls).not.toContain('/api/restart');

        vi.unstubAllGlobals();
    });
});

// _formatProgress backs the progress text in every case above, but none of
// those scenarios observe its output long enough to assert on it (the
// 'done' text is overwritten by 'staged, restarting…' before the promise
// resolves — see the file-level comment history). It's a pure function, so
// test it directly rather than trying to catch it in flight.
//
// Scoped to the two branches with a `||` fallback default: 'done' (falls
// back to 'phi.old') and 'error' (falls back to 'unknown'). That's exactly
// the shape of the drift the hand-copied version of this method had before
// this file was rewired onto the real class ('done' silently dropped the
// old-binary-path text). The other four branches ('downloading',
// 'verifying', 'extracting', 'staging') have no `||` fallback to get
// wrong — 'downloading' does interpolate server data (`${p.pct}%`) but
// didn't drift in the hand-copy either — so testing them here would be
// reflexive coverage.
describe('_formatProgress', () => {
    it('formats the staged phase with the kept-binary path', () => {
        const mm = makeMarkdownManager();
        expect(
            mm._formatProgress({ phase: 'done', old_path: '/opt/phi/phi.old' }),
        ).toBe('Staged. Old binary kept at /opt/phi/phi.old.');
    });

    it('falls back to phi.old when old_path is missing', () => {
        const mm = makeMarkdownManager();
        expect(mm._formatProgress({ phase: 'done' })).toBe(
            'Staged. Old binary kept at phi.old.',
        );
    });

    it('formats the error phase with the server-provided message', () => {
        const mm = makeMarkdownManager();
        expect(
            mm._formatProgress({ phase: 'error', error: 'checksum mismatch' }),
        ).toBe('Error: checksum mismatch');
    });

    it('falls back to "unknown" when the error phase has no message', () => {
        const mm = makeMarkdownManager();
        expect(mm._formatProgress({ phase: 'error' })).toBe('Error: unknown');
    });
});
