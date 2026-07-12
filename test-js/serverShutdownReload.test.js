// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setupDomHarness } from './_dom.js';

// Phase 9 client reload poller. When the WS receives 0x05 with reason
// "restart" or "update", the tab-level handleControlMessage delegates
// to handleServerShutdown which polls /api/version and reloads when
// the server reports a different commit.

setupDomHarness();

function makeTabManager() {
    // Object.create on a stand-in prototype that carries the methods we
    // want to test. Mirrors terminal.js handleControlMessage +
    // handleServerShutdown.
    const proto = {
        handleControlMessage(control) {
            if (!control) return;
            if (control.type === 'pty-exited') {
                // ...
            } else if (control.type === 'replay-complete') {
                // ...
            } else if (control.type === 'server-shutdown') {
                this.handleServerShutdown(control.reason || 'shutdown');
            }
        },
        handleServerShutdown(reason) {
            if (this._reloadArmed) return;
            this._reloadArmed = true;

            if (this.app && this.app.showToast) {
                this.app.showToast(`phi is ${reason}…`, { type: 'info', durationMs: 8000 });
            }

            const beforeCommit = (this.app && this.app.versionInfo && this.app.versionInfo.commit) || '';
            const startedAt = Date.now();
            const maxWaitMs = 10_000;

            const poll = async () => {
                if (Date.now() - startedAt > maxWaitMs) {
                    window.location.reload();
                    return;
                }
                try {
                    const res = await fetch('/api/version', { cache: 'no-store' });
                    if (res.ok) {
                        const data = await res.json();
                        if (data && data.commit && data.commit !== beforeCommit) {
                            window.location.reload();
                            return;
                        }
                    }
                } catch (_) { /* keep polling */ }
                setTimeout(poll, 1000);
            };
            setTimeout(poll, 1000);
        }
    };
    return Object.create(proto);
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
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('arms the reload poller on server-shutdown', () => {
        const tm = makeTabManager();
        tm.handleControlMessage({ type: 'server-shutdown', reason: 'restart' });
        expect(tm._reloadArmed).toBe(true);
    });

    it('is idempotent — second shutdown does not stack timers', () => {
        const tm = makeTabManager();
        tm.handleControlMessage({ type: 'server-shutdown', reason: 'restart' });
        const first = tm._reloadArmed;
        tm.handleControlMessage({ type: 'server-shutdown', reason: 'update' });
        expect(tm._reloadArmed).toBe(first);
    });

    it('reloads when /api/version reports a different commit', async () => {
        const fakeFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ commit: 'NEW-COMMIT', version: '0.8.1' })
        });
        vi.stubGlobal('fetch', fakeFetch);

        const tm = makeTabManager();
        tm.app = {
            versionInfo: { commit: 'OLD-COMMIT' },
            showToast: vi.fn()
        };

        tm.handleControlMessage({ type: 'server-shutdown', reason: 'restart' });

        // First poll is scheduled at +1000ms
        await vi.advanceTimersByTimeAsync(1100);

        expect(reloadSpy).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('does NOT reload when /api/version reports the same commit', async () => {
        const fakeFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ commit: 'SAME-COMMIT', version: '0.8.0' })
        });
        vi.stubGlobal('fetch', fakeFetch);

        const tm = makeTabManager();
        tm.app = {
            versionInfo: { commit: 'SAME-COMMIT' },
            showToast: vi.fn()
        };

        tm.handleControlMessage({ type: 'server-shutdown', reason: 'restart' });
        await vi.advanceTimersByTimeAsync(3000);

        expect(reloadSpy).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('reloads after maxWaitMs timeout even if commit never changes', async () => {
        const fakeFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ commit: 'STUCK', version: '0.8.0' })
        });
        vi.stubGlobal('fetch', fakeFetch);

        const tm = makeTabManager();
        tm.app = {
            versionInfo: { commit: 'STUCK' },
            showToast: vi.fn()
        };

        tm.handleControlMessage({ type: 'server-shutdown', reason: 'shutdown' });

        // Advance past the 10s maxWaitMs plus enough poll cycles
        await vi.advanceTimersByTimeAsync(11_000);

        expect(reloadSpy).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('keeps polling when fetch throws (network blip during bounce)', async () => {
        const fakeFetch = vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ commit: 'NEW-COMMIT', version: '0.8.1' })
            });
        vi.stubGlobal('fetch', fakeFetch);

        const tm = makeTabManager();
        tm.app = {
            versionInfo: { commit: 'OLD' },
            showToast: vi.fn()
        };

        tm.handleControlMessage({ type: 'server-shutdown', reason: 'restart' });

        // First poll: fetch rejects. Second poll (1s later): succeeds with new commit.
        await vi.advanceTimersByTimeAsync(2200);

        expect(reloadSpy).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('shows a toast describing the reason', () => {
        const showToast = vi.fn();
        const tm = makeTabManager();
        tm.app = { showToast };

        tm.handleControlMessage({ type: 'server-shutdown', reason: 'update' });
        expect(showToast).toHaveBeenCalledWith(
            expect.stringContaining('update'),
            expect.any(Object)
        );
    });

    it('defaults reason to "shutdown" when missing', () => {
        const showToast = vi.fn();
        const tm = makeTabManager();
        tm.app = { showToast };

        tm.handleControlMessage({ type: 'server-shutdown' });
        expect(showToast).toHaveBeenCalledWith(
            expect.stringContaining('shutdown'),
            expect.any(Object)
        );
    });
});