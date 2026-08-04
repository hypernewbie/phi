// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Phase 9 client reload poller. When the WS receives 0x05 with reason
// "restart" or "update", the tab-level handleControlMessage delegates
// to handleServerShutdown which polls /api/version and reloads when
// the server reports a different commit.

setupDomHarness();

// Harness idiom (matches autoReconnect.test.js): bare prototype + hand-mocked
// collaborators, calling the real terminal.js methods with an explicit ctx.
function ctx() {
    return Object.create(TabManager.prototype);
}

// The server-shutdown branch of handleControlMessage never touches tabInfo,
// but the real signature is (tabInfo, control) — pass a stub to match it.
function tabInfo() {
    return { paneId: 'p1' };
}

describe('handleServerShutdown reload poller', () => {
    let reloadSpy;

    beforeEach(() => {
        reloadSpy = vi.fn();
        // jsdom doesn't allow replacing window.location; stub .reload
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: { reload: reloadSpy, href: 'http://localhost/' }
        });
        vi.useFakeTimers();
    });

    afterEach(() => {
        // Only useRealTimers is load-bearing here — setupDomHarness's own
        // afterEach (_dom.js:15) already calls restoreAllMocks() +
        // unstubAllGlobals() unconditionally, so this file doesn't need to.
        vi.useRealTimers();
    });

    it('arms the reload poller once — a second shutdown does not stack timers', () => {
        const tm = ctx();
        tm.handleControlMessage(tabInfo(), { type: 'server-shutdown', reason: 'restart' });
        expect(tm._reloadArmed).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
        tm.handleControlMessage(tabInfo(), { type: 'server-shutdown', reason: 'update' });
        expect(vi.getTimerCount()).toBe(1);
    });

    it('reloads when /api/version reports a different commit', async () => {
        const fakeFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ commit: 'NEW-COMMIT', version: '0.8.1' })
        });
        vi.stubGlobal('fetch', fakeFetch);

        const tm = ctx();
        tm.app = {
            versionInfo: { commit: 'OLD-COMMIT' },
            showToast: vi.fn()
        };

        tm.handleControlMessage(tabInfo(), { type: 'server-shutdown', reason: 'restart' });

        // First poll is scheduled at +1000ms
        await vi.advanceTimersByTimeAsync(1100);

        expect(reloadSpy).toHaveBeenCalled();
    });

    it('does NOT reload when /api/version reports the same commit', async () => {
        const fakeFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ commit: 'SAME-COMMIT', version: '0.8.0' })
        });
        vi.stubGlobal('fetch', fakeFetch);

        const tm = ctx();
        tm.app = {
            versionInfo: { commit: 'SAME-COMMIT' },
            showToast: vi.fn()
        };

        tm.handleControlMessage(tabInfo(), { type: 'server-shutdown', reason: 'restart' });
        await vi.advanceTimersByTimeAsync(3000);

        expect(reloadSpy).not.toHaveBeenCalled();
    });

    it('reloads after maxWaitMs timeout even if commit never changes', async () => {
        const fakeFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ commit: 'STUCK', version: '0.8.0' })
        });
        vi.stubGlobal('fetch', fakeFetch);

        const tm = ctx();
        tm.app = {
            versionInfo: { commit: 'STUCK' },
            showToast: vi.fn()
        };

        tm.handleControlMessage(tabInfo(), { type: 'server-shutdown', reason: 'shutdown' });

        // Advance past the 10s maxWaitMs plus enough poll cycles
        await vi.advanceTimersByTimeAsync(11_000);

        expect(reloadSpy).toHaveBeenCalled();
    });

    it('keeps polling when fetch throws (network blip during bounce)', async () => {
        const fakeFetch = vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ commit: 'NEW-COMMIT', version: '0.8.1' })
            });
        vi.stubGlobal('fetch', fakeFetch);

        const tm = ctx();
        tm.app = {
            versionInfo: { commit: 'OLD' },
            showToast: vi.fn()
        };

        tm.handleControlMessage(tabInfo(), { type: 'server-shutdown', reason: 'restart' });

        // First poll: fetch rejects. Second poll (1s later): succeeds with new commit.
        await vi.advanceTimersByTimeAsync(2200);

        expect(reloadSpy).toHaveBeenCalled();
    });

    it('shows a toast describing the reason', () => {
        const showToast = vi.fn();
        const tm = ctx();
        tm.app = { showToast };

        tm.handleControlMessage(tabInfo(), { type: 'server-shutdown', reason: 'update' });
        expect(showToast).toHaveBeenCalledWith(
            expect.stringContaining('update'),
            expect.any(Object)
        );
    });

    it('defaults reason to "shutdown" when missing', () => {
        const showToast = vi.fn();
        const tm = ctx();
        tm.app = { showToast };

        tm.handleControlMessage(tabInfo(), { type: 'server-shutdown' });
        expect(showToast).toHaveBeenCalledWith(
            expect.stringContaining('shutdown'),
            expect.any(Object)
        );
    });
});
