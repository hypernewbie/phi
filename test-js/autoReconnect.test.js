// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TabManager } from '../web/terminal.js';

// Harness idiom (matches deadTabClickReconnect.test.js): bare prototype +
// hand-mocked collaborators, calling prototype methods with an explicit ctx.

function ctx(config = { auto_reconnect: 'visible' }) {
    const c = Object.create(TabManager.prototype);
    c.app = { config };
    c.reconnectTab = vi.fn();
    c.getActiveTab = vi.fn(() => null);
    return c;
}

function deadTab(overrides = {}) {
    return {
        paneId: 'p1',
        isDead: true,
        coder: 'opencode',
        reconnectInFlight: false,
        exitCode: null,
        reconnectAttempts: 0,
        termContainer: { querySelector: () => null },
        ...overrides,
    };
}

describe('_reviveActiveTabIfDead (wake / online / pageshow trigger)', () => {
    it('revives a dead active tab and resets the attempt budget', () => {
        const c = ctx();
        const tab = deadTab({ reconnectAttempts: 7 });
        c.getActiveTab = vi.fn(() => tab);
        TabManager.prototype._reviveActiveTabIfDead.call(c);
        expect(tab.reconnectAttempts).toBe(0);
        expect(c.reconnectTab).toHaveBeenCalledWith(tab, { auto: true });
    });

    it('does nothing when auto_reconnect is off', () => {
        const c = ctx({ auto_reconnect: 'off' });
        c.getActiveTab = vi.fn(() => deadTab());
        TabManager.prototype._reviveActiveTabIfDead.call(c);
        expect(c.reconnectTab).not.toHaveBeenCalled();
    });

    it('does nothing while the document is hidden (online fires in background windows)', () => {
        const c = ctx();
        c.getActiveTab = vi.fn(() => deadTab());
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        try {
            TabManager.prototype._reviveActiveTabIfDead.call(c);
            expect(c.reconnectTab).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        }
    });

    it('does nothing when config never loaded (app.config undefined)', () => {
        const c = ctx(undefined);
        c.app = {};
        c.getActiveTab = vi.fn(() => deadTab());
        TabManager.prototype._reviveActiveTabIfDead.call(c);
        expect(c.reconnectTab).not.toHaveBeenCalled();
    });

    it('skips a live tab', () => {
        const c = ctx();
        c.getActiveTab = vi.fn(() => deadTab({ isDead: false }));
        TabManager.prototype._reviveActiveTabIfDead.call(c);
        expect(c.reconnectTab).not.toHaveBeenCalled();
    });

    it('skips when no active tab exists', () => {
        const c = ctx();
        TabManager.prototype._reviveActiveTabIfDead.call(c);
        expect(c.reconnectTab).not.toHaveBeenCalled();
    });

    it('skips while a reconnect is already in flight', () => {
        const c = ctx();
        c.getActiveTab = vi.fn(() => deadTab({ reconnectInFlight: true }));
        TabManager.prototype._reviveActiveTabIfDead.call(c);
        expect(c.reconnectTab).not.toHaveBeenCalled();
    });

    it('skips review/kanban panels', () => {
        for (const coder of ['review', 'kanban']) {
            const c = ctx();
            c.getActiveTab = vi.fn(() => deadTab({ coder }));
            TabManager.prototype._reviveActiveTabIfDead.call(c);
            expect(c.reconnectTab).not.toHaveBeenCalled();
        }
    });

    it('does not resurrect a tab whose process exited', () => {
        const c = ctx();
        c.getActiveTab = vi.fn(() => deadTab({ exitCode: 0 }));
        TabManager.prototype._reviveActiveTabIfDead.call(c);
        expect(c.reconnectTab).not.toHaveBeenCalled();
    });
});

describe('maybeAutoReconnect retry policy (full jitter, 10 attempts, 20s cap)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    function armedCtx(tab) {
        const c = ctx();
        c.activePaneId = tab.paneId;
        c.reconnectTab = vi.fn();
        return c;
    }

    // Every delay is now AUTO_RECONNECT_GRACE_MS (1000) + jittered backoff.
    // The grace is a floor: full jitter alone can return ~0ms, which let a
    // flapping pane redial almost instantly.
    it('attempt 1 with jitter=1 schedules 1000ms grace + 1000ms backoff', () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        const tab = deadTab();
        const c = armedCtx(tab);
        expect(TabManager.prototype.maybeAutoReconnect.call(c, tab)).toBe(true);
        vi.advanceTimersByTime(1999);
        expect(c.reconnectTab).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(c.reconnectTab).toHaveBeenCalledWith(tab, { auto: true });
    });

    it('never redials inside the grace window, even with zero jitter', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const tab = deadTab();
        const c = armedCtx(tab);
        expect(TabManager.prototype.maybeAutoReconnect.call(c, tab)).toBe(true);
        vi.advanceTimersByTime(999);
        expect(c.reconnectTab).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(c.reconnectTab).toHaveBeenCalled();
    });

    it('attempt 6+ is capped at 20s pre-jitter (not 32s, not the old 30s)', () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        const tab = deadTab({ reconnectAttempts: 5 });
        const c = armedCtx(tab);
        expect(TabManager.prototype.maybeAutoReconnect.call(c, tab)).toBe(true);
        expect(tab.reconnectAttempts).toBe(6);
        vi.advanceTimersByTime(20999); // 1000 grace + 20000 cap
        expect(c.reconnectTab).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(c.reconnectTab).toHaveBeenCalled();
    });

    it('jitter scales the delay (random=0.5 halves it)', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const tab = deadTab({ reconnectAttempts: 1 });
        const c = armedCtx(tab);
        TabManager.prototype.maybeAutoReconnect.call(c, tab); // attempt 2: 2000ms pre-jitter
        vi.advanceTimersByTime(1999); // 1000 grace + 2000*0.5
        expect(c.reconnectTab).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(c.reconnectTab).toHaveBeenCalled();
    });

    it('hard-stops after 10 attempts and resets the counter', () => {
        const tab = deadTab({ reconnectAttempts: 10 });
        const c = armedCtx(tab);
        expect(TabManager.prototype.maybeAutoReconnect.call(c, tab)).toBe(false);
        expect(tab.reconnectAttempts).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('allows attempt 10 itself (only >= 10 pre-increment blocks)', () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        const tab = deadTab({ reconnectAttempts: 9 });
        const c = armedCtx(tab);
        expect(TabManager.prototype.maybeAutoReconnect.call(c, tab)).toBe(true);
        expect(tab.reconnectAttempts).toBe(10);
    });

    it('overlay message reports the 10-attempt budget', () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        const msgEl = { innerText: '' };
        const overlay = { querySelector: (sel) => (sel === '.reconnect-msg' ? msgEl : null) };
        const tab = deadTab({
            reconnectAttempts: 2,
            termContainer: { querySelector: (sel) => (sel === '.reconnect-overlay' ? overlay : null) },
        });
        const c = armedCtx(tab);
        TabManager.prototype.maybeAutoReconnect.call(c, tab);
        expect(msgEl.innerText).toBe('auto-reconnecting (attempt 3/10)...');
    });

    it('stays gated off when auto_reconnect is off', () => {
        const tab = deadTab();
        const c = armedCtx(tab);
        c.app = { config: { auto_reconnect: 'off' } };
        expect(TabManager.prototype.maybeAutoReconnect.call(c, tab)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
});
