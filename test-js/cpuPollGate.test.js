// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

// Only the poll chain is under test: the real prototype methods, a stubbed
// collaborator (fetch), and a plain object for `this` (per _dom.js discipline).
function makeManager() {
    const tm = Object.create(TabManager.prototype);
    tm.app = {};
    tm.lastCpuPercent = null;
    tm.lastCpuSampleAt = 0;
    tm.cpuPollTimer = null;
    return tm;
}

function hideDocument(hidden) {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
}

// Low power mode reaches the page as this body class (App.applyFastMode is its
// single writer), so the gate is exercised through the same signal the app uses.
function setLowPower(on) {
    document.body.classList.toggle('fast-mode', on);
}

describe('CPU poll chain', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // The harness resets innerHTML and storage, not body classes: a test
        // that left low power mode on must not gate the next one.
        setLowPower(false);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('samples immediately on resume, then every 10s', async () => {
        const fetch = mockFetch(() => ({ cpu: 42 }));
        vi.stubGlobal('fetch', fetch);
        const tm = makeManager();

        tm.resumeCpuPolling();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(tm.lastCpuPercent).toBe(42);

        // The old cadence was 2s: nothing may fire before 10s.
        await vi.advanceTimersByTimeAsync(9_999);
        expect(fetch).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(fetch).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('does not arm while the tab is hidden, and stops a running chain', async () => {
        const fetch = mockFetch(() => ({ cpu: 12 }));
        vi.stubGlobal('fetch', fetch);
        hideDocument(true);
        const tm = makeManager();

        tm.resumeCpuPolling();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fetch).not.toHaveBeenCalled();
        expect(tm.cpuPollTimer).toBeNull();

        // Becoming visible revives it.
        hideDocument(false);
        tm.resumeCpuPolling();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledTimes(1);

        // Hiding again stops the pending turn without a further sample.
        hideDocument(true);
        tm._stopCpuPolling();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('does not sample under low power mode, and resumes when it turns off', async () => {
        const fetch = mockFetch(() => ({ cpu: 71 }));
        vi.stubGlobal('fetch', fetch);
        setLowPower(true);
        const tm = makeManager();

        tm.resumeCpuPolling();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fetch).not.toHaveBeenCalled();
        expect(tm.cpuPollTimer).toBeNull();

        // Turning low power off is what App.applyFastMode calls.
        setLowPower(false);
        tm.resumeCpuPolling();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(tm.lastCpuPercent).toBe(71);
    });

    it('keeps sampling after a failed request', async () => {
        const fetch = mockFetch(() => ({ ok: false, status: 503 }));
        vi.stubGlobal('fetch', fetch);
        const tm = makeManager();

        tm.resumeCpuPolling();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(tm.lastCpuPercent).toBeNull();

        // A failed turn must still re-arm rather than end the chain.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('keeps one pending turn: repeat resumes do not stack timers', async () => {
        const fetch = mockFetch(() => ({ cpu: 3 }));
        vi.stubGlobal('fetch', fetch);
        const tm = makeManager();

        tm.resumeCpuPolling();
        tm.resumeCpuPolling();
        tm.resumeCpuPolling();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('drops a turn that was already waiting when the gate closes', async () => {
        const fetch = mockFetch(() => ({ cpu: 64 }));
        vi.stubGlobal('fetch', fetch);
        const tm = makeManager();

        tm.resumeCpuPolling();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledTimes(1);

        // Low power turns on mid-wait; the pending 10s turn must not sample.
        setLowPower(true);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(tm.cpuPollTimer).toBeNull();
    });

    it('does not stack a second turn while a sample is in flight', async () => {
        let settle;
        const fetch = vi.fn(
            () =>
                new Promise((resolve) => {
                    settle = () =>
                        resolve({ ok: true, json: async () => ({ cpu: 22 }) });
                }),
        );
        vi.stubGlobal('fetch', fetch);
        const tm = makeManager();

        tm.resumeCpuPolling();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledTimes(1);

        // A resume that lands while the fetch is still open must be a no-op.
        tm.resumeCpuPolling();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledTimes(1);

        settle();
        await vi.advanceTimersByTimeAsync(0);
        expect(tm.lastCpuPercent).toBe(22);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});

describe('self-HUD CPU line', () => {
    // The HUD shows the last sample because it never fetches on open. Once the
    // chain stops, that number has to expire instead of masquerading as live.
    it('shows a fresh sample, and unknown once the sample is old', () => {
        const tm = makeManager();

        expect(tm._hudCpuPercent()).toBeNull();

        tm.applyCPUIndicator(37);
        expect(tm._hudCpuPercent()).toBe(37);

        // 29s: still current. 31s: past three poll turns, so unknown.
        tm.lastCpuSampleAt = Date.now() - 29_000;
        expect(tm._hudCpuPercent()).toBe(37);

        tm.lastCpuSampleAt = Date.now() - 31_000;
        expect(tm._hudCpuPercent()).toBeNull();
    });
});

describe('low power reconcile', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML =
            '<span class="brand"><span class="logo"></span></span>';
        setLowPower(false);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // Turning low power on must not leave the last reading on screen: a frozen
    // red logo and a frozen HUD number both claim the machine is busy now.
    it('drops the reading and the tint when low power turns on, and resumes off', async () => {
        const fetch = mockFetch(() => ({ cpu: 88 }));
        vi.stubGlobal('fetch', fetch);
        const tm = makeManager();
        const logo = document.querySelector('.brand .logo');

        tm.syncCpuPolling();
        await vi.advanceTimersByTimeAsync(0);
        expect(tm.lastCpuPercent).toBe(88);
        expect(logo.dataset.cpuLevel).toBe('cpu-high');

        setLowPower(true);
        tm.syncCpuPolling();
        expect(tm.lastCpuPercent).toBeNull();
        expect(tm.cpuPollTimer).toBeNull();
        expect(logo.dataset.cpuLevel).toBe('cpu-idle');
        expect(tm._hudCpuPercent()).toBeNull();

        // Nothing samples while it stays on.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fetch).toHaveBeenCalledTimes(1);

        setLowPower(false);
        tm.syncCpuPolling();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(logo.dataset.cpuLevel).toBe('cpu-high');
    });
});
