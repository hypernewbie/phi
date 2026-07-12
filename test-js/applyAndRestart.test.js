// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';

// Phase 9 T3: 'Apply & restart now' chains Phase 8 apply + Phase 9
// restart. Polls /api/update/progress until phase==done, then POSTs
// /api/restart. The 0x05 frame handler arms the reload poller; we
// also fire a hard reload as backup.

setupDomHarness();

function makeMarkdownManager(app = {}) {
    const mm = Object.create({
        _formatProgress(p) {
            if (!p || !p.phase) return '';
            switch (p.phase) {
                case 'downloading': return `Downloading… ${p.pct}%`;
                case 'verifying':   return 'Verifying checksum…';
                case 'extracting':  return 'Extracting binary…';
                case 'staging':     return 'Staging swap…';
                case 'done':        return `Staged.`;
                case 'error':       return `Error: ${p.error || 'unknown'}`;
                default:            return p.phase;
            }
        },
        async _startUpdateApplyAndRestart(version, restartBtn, applyBtn, banner) {
            restartBtn.disabled = true;
            applyBtn.disabled = true;
            restartBtn.textContent = 'Staging…';
            const progressEl = banner.querySelector('.update-banner-progress');
            if (progressEl) progressEl.textContent = 'staging…';

            try {
                const res = await fetch('/api/update/apply', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ version })
                });
                if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
            } catch (err) {
                restartBtn.disabled = false;
                applyBtn.disabled = false;
                restartBtn.textContent = 'Apply & restart now';
                if (progressEl) {
                    progressEl.textContent = `Error: ${err.message}`;
                    progressEl.classList.add('error');
                }
                return;
            }

            const waitForStaged = async () => {
                const r = await fetch('/api/update/progress');
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const p = await r.json();
                if (progressEl) {
                    progressEl.textContent = this._formatProgress(p);
                    progressEl.classList.toggle('error', p.phase === 'error');
                }
                if (p.phase === 'done') return true;
                if (p.phase === 'error') throw new Error(p.error || 'staging failed');
                return false;
            };

            try {
                for (;;) {
                    if (await waitForStaged()) break;
                    await new Promise(r => setTimeout(r, 500));
                }
            } catch (err) {
                restartBtn.disabled = false;
                applyBtn.disabled = false;
                restartBtn.textContent = 'Apply & restart now';
                return;
            }

            restartBtn.textContent = 'Restarting…';
            if (progressEl) progressEl.textContent = 'staged, restarting…';
            try {
                await fetch('/api/restart', { method: 'POST' });
            } catch (_) { /* server dying, expected */ }
            setTimeout(() => window.location.reload(), 2500);
        },
        showToast: vi.fn(),
        app
    });
    return mm;
}

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
        const fakeFetch = vi.fn()
            .mockResolvedValueOnce({ ok: true }) // /api/update/apply
            .mockResolvedValueOnce({ ok: true, json: async () => ({ phase: 'downloading', pct: 50 }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ phase: 'done' }) })
            .mockResolvedValueOnce({ ok: true }); // /api/restart
        vi.stubGlobal('fetch', fakeFetch);

        const reloadSpy = vi.fn();
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: { reload: reloadSpy, href: 'http://localhost/' }
        });
        vi.useFakeTimers();

        const mm = makeMarkdownManager();
        const banner = makeBanner();
        const restartBtn = banner.querySelector('.update-banner-btn-restart');
        const applyBtn = banner.querySelector('.update-banner-btn');

        // Kick off the chain (don't await)
        const promise = mm._startUpdateApplyAndRestart('v0.8.2', restartBtn, applyBtn, banner);

        // Let microtasks + the 500ms inter-poll delay advance
        await vi.advanceTimersByTimeAsync(600);
        await promise;
        await vi.advanceTimersByTimeAsync(3000); // for the 2500 reload fallback

        // Sequence check
        const urls = fakeFetch.mock.calls.map(c => c[0]);
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
        const fakeFetch = vi.fn()
            .mockResolvedValueOnce({ ok: true }) // /api/update/apply
            .mockResolvedValueOnce({ ok: true, json: async () => ({ phase: 'error', error: 'checksum mismatch' }) });
        vi.stubGlobal('fetch', fakeFetch);

        const mm = makeMarkdownManager();
        const banner = makeBanner();
        const restartBtn = banner.querySelector('.update-banner-btn-restart');
        const applyBtn = banner.querySelector('.update-banner-btn');

        await mm._startUpdateApplyAndRestart('v0.8.2', restartBtn, applyBtn, banner);

        // Buttons re-enabled for retry
        expect(restartBtn.disabled).toBe(false);
        expect(restartBtn.textContent).toBe('Apply & restart now');
        expect(applyBtn.disabled).toBe(false);

        // /api/restart was NOT called
        const urls = fakeFetch.mock.calls.map(c => c[0]);
        expect(urls).not.toContain('/api/restart');

        vi.unstubAllGlobals();
    });

    it('does NOT restart if /api/update/apply itself errors', async () => {
        const fakeFetch = vi.fn().mockResolvedValueOnce({
            ok: false,
            text: async () => 'Forbidden: install method not eligible'
        });
        vi.stubGlobal('fetch', fakeFetch);

        const mm = makeMarkdownManager();
        const banner = makeBanner();
        const restartBtn = banner.querySelector('.update-banner-btn-restart');
        const applyBtn = banner.querySelector('.update-banner-btn');

        await mm._startUpdateApplyAndRestart('v0.8.2', restartBtn, applyBtn, banner);

        expect(restartBtn.disabled).toBe(false);
        const progress = banner.querySelector('.update-banner-progress');
        expect(progress.textContent).toContain('Forbidden');

        const urls = fakeFetch.mock.calls.map(c => c[0]);
        expect(urls).not.toContain('/api/restart');

        vi.unstubAllGlobals();
    });
});