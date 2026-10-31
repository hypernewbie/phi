// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TabManager } from '../web/terminal.js';

function harness(overrides = {}) {
    const tab = {
        paneId: 'p1',
        isDead: true,
        coder: 'bash',
        exitCode: null,
        reconnectAttempts: 0,
        termContainer: document.createElement('div'),
        ...overrides,
    };
    const manager = Object.assign(Object.create(TabManager.prototype), {
        tabs: new Map([[tab.paneId, tab]]),
        app: { config: { auto_reconnect: 'visible' } },
        reconnectTab: vi.fn(),
        updateDisconnectBanner: vi.fn(),
        _showReconnectOverlay: vi.fn(),
        _queuePanelFit: vi.fn(),
        getActiveTab: () => tab,
    });
    return { manager, tab };
}
function visibility(value) {
    Object.defineProperty(document, 'visibilityState', {
        value,
        configurable: true,
    });
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    document.documentElement.setAttribute('data-phi-desktop', '');
    visibility('visible');
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('data-phi-desktop');
    visibility('visible');
});

describe('all-tab wake and shared scheduler', () => {
    it('schedules both dead panes, preserves a healthy pane, and deduplicates overlapping hints', () => {
        const { manager, tab } = harness({ reconnectAttempts: 10 });
        const background = { ...tab, paneId: 'p2' };
        const healthy = { ...tab, paneId: 'p3', isDead: false };
        manager.tabs.set('p2', background).set('p3', healthy);
        manager._reviveActiveTabIfDead();
        const timer = tab.autoReconnectTimer;
        expect(tab.reconnectAttempts).toBe(1);
        expect(background.reconnectAttempts).toBe(1);
        manager._reviveActiveTabIfDead();
        manager.activateTabViewport(tab, { scrollToBottom: false });
        expect(tab.autoReconnectTimer).toBe(timer);
        expect(tab.reconnectAttempts).toBe(1);
        expect(manager.reconnectTab).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1000);
        expect(manager.reconnectTab.mock.calls).toEqual([
            [tab, { auto: true }],
            [background, { auto: true }],
        ]);
        expect(healthy.autoReconnectTimer).toBeUndefined();
    });
    it('redials active and background panes outside desktop shells', () => {
        document.documentElement.removeAttribute('data-phi-desktop');
        const { manager, tab } = harness();
        manager.activePaneId = tab.paneId;
        const background = { ...tab, paneId: 'p2' };
        manager.tabs.set(background.paneId, background);

        manager._reviveActiveTabIfDead();
        vi.advanceTimersByTime(1000);

        expect(manager.reconnectTab.mock.calls).toEqual([
            [tab, { auto: true }],
            [background, { auto: true }],
        ]);
        expect(manager._showReconnectOverlay).not.toHaveBeenCalled();
    });
    it.each([false, true])(
        'waits for auth refresh before redialing all panes (desktop shell=%s)',
        async (desktopShell) => {
            if (!desktopShell)
                document.documentElement.removeAttribute('data-phi-desktop');
            const { manager, tab } = harness();
            manager.activePaneId = tab.paneId;
            const background = { ...tab, paneId: 'p2' };
            manager.tabs.set(background.paneId, background);
            const previousBridge = window.phiAccessAuth;
            let releaseRefresh;
            const refresh = new Promise((resolve) => {
                releaseRefresh = resolve;
            });
            window.phiAccessAuth = {
                refreshAccessIfDue: vi.fn(() => refresh),
            };

            try {
                manager._reviveActiveTabIfDead();
                await vi.advanceTimersByTimeAsync(1000);
                expect(manager.reconnectTab).not.toHaveBeenCalled();
                releaseRefresh();
                await vi.advanceTimersByTimeAsync(0);
                expect(manager.reconnectTab.mock.calls).toEqual([
                    [tab, { auto: true }],
                    [background, { auto: true }],
                ]);
            } finally {
                if (previousBridge === undefined) delete window.phiAccessAuth;
                else window.phiAccessAuth = previousBridge;
            }
        },
    );
    it.each([
        { isDead: false },
        { reconnectInFlight: true },
        { softClosing: true },
        { finalizing: true },
        { coder: 'review' },
        { coder: 'kanban' },
        { coder: 'pi-rpc' },
        { isReview: true },
        { isKanban: true },
        { exitCode: 0 },
    ])('does not schedule excluded pane %j', (state) => {
        const { manager, tab } = harness(state);
        manager._reviveActiveTabIfDead();
        expect(manager.maybeAutoReconnect(tab)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['off', undefined])('does not schedule with config %s', (value) => {
        const { manager, tab } = harness();
        manager.app.config.auto_reconnect = value;
        manager._reviveActiveTabIfDead();
        expect(manager.maybeAutoReconnect(tab)).toBe(false);
    });
    it('does not schedule hidden pages or an empty catalog', () => {
        const { manager, tab } = harness();
        visibility('hidden');
        manager._reviveActiveTabIfDead();
        expect(manager.maybeAutoReconnect(tab)).toBe(false);
        visibility('visible');
        manager.tabs.clear();
        manager._reviveActiveTabIfDead();
        expect(manager.maybeAutoReconnect(tab)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each([
        'hidden',
        'off',
        'removed',
        'replaced',
        'softClosing',
        'finalizing',
        'exit',
    ])('rechecks %s before dialing', (change) => {
        const { manager, tab } = harness();
        manager.maybeAutoReconnect(tab);
        if (change === 'hidden') visibility('hidden');
        else if (change === 'off') manager.app.config.auto_reconnect = 'off';
        else if (change === 'removed') manager.tabs.clear();
        else if (change === 'replaced') manager.tabs.set('p1', { ...tab });
        else if (change === 'exit') tab.exitCode = 0;
        else tab[change] = true;
        vi.advanceTimersByTime(1000);
        expect(manager.reconnectTab).not.toHaveBeenCalled();
        if (change !== 'removed' && change !== 'replaced') {
            expect(tab.autoReconnectPending).toBe(false);
            expect(tab.autoReconnectTimer).toBeNull();
            expect(manager.updateDisconnectBanner).toHaveBeenCalled();
        }
    });
    it('an obsolete retry callback cannot erase a newer timer', () => {
        const { manager, tab } = harness();
        const schedule = vi.spyOn(globalThis, 'setTimeout');
        manager.maybeAutoReconnect(tab);
        const oldCallback = schedule.mock.calls[0][0];
        expect(typeof oldCallback).toBe('function');
        clearTimeout(tab.autoReconnectTimer);
        tab.autoReconnectTimer = null;
        tab.autoReconnectPending = false;
        manager.maybeAutoReconnect(tab);
        const currentTimer = tab.autoReconnectTimer;
        const attempts = tab.reconnectAttempts;
        oldCallback();
        expect(tab.autoReconnectTimer).toBe(currentTimer);
        expect(tab.autoReconnectPending).toBe(true);
        expect(tab.reconnectAttempts).toBe(attempts);
        expect(manager.reconnectTab).not.toHaveBeenCalled();
    });
});

describe('grace, jitter, budget, and manual intent', () => {
    it.each([
        [0, 1, 2000],
        [5, 1, 21000],
        [1, 0.5, 2000],
        [0, 0, 1000],
    ])('attempts=%i jitter=%f waits %i ms', (attempts, jitter, delay) => {
        vi.mocked(Math.random).mockReturnValue(jitter);
        const { manager, tab } = harness({ reconnectAttempts: attempts });
        expect(manager.maybeAutoReconnect(tab)).toBe(true);
        vi.advanceTimersByTime(delay - 1);
        expect(manager.reconnectTab).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(manager.reconnectTab).toHaveBeenCalledWith(tab, { auto: true });
    });
    it('executes attempt ten, refuses eleven, and leaves manual recovery actionable', () => {
        const { manager, tab } = harness({ reconnectAttempts: 9 });
        tab.termContainer.innerHTML =
            '<div class="reconnect-overlay"><span class="reconnect-msg"></span><button class="reconnect-btn" disabled></button><button class="restart-btn" disabled></button></div>';
        expect(manager.maybeAutoReconnect(tab)).toBe(true);
        vi.advanceTimersByTime(1000);
        expect(manager.reconnectTab).toHaveBeenCalledOnce();
        expect(tab.reconnectAttempts).toBe(10);
        expect(manager.maybeAutoReconnect(tab)).toBe(false);
        expect(tab.reconnectAttempts).toBe(10);
        expect(vi.getTimerCount()).toBe(0);
        expect(
            tab.termContainer.querySelector('.reconnect-msg').innerText,
        ).toBe('Auto-reconnect failed. Please retry manually.');
        expect(tab.termContainer.querySelector('.reconnect-btn').disabled).toBe(
            false,
        );
        expect(tab.termContainer.querySelector('.restart-btn').disabled).toBe(
            false,
        );
        manager.activateTabViewport(tab, { scrollToBottom: false });
        expect(tab.reconnectAttempts).toBe(10);
        manager._reviveActiveTabIfDead();
        expect(tab.reconnectAttempts).toBe(1);
    });
    it('keeps the scheduled attempt number in the overlay', () => {
        const { manager, tab } = harness({ reconnectAttempts: 2 });
        tab.termContainer.innerHTML =
            '<div class="reconnect-overlay"><span class="reconnect-msg"></span></div>';
        manager.maybeAutoReconnect(tab);
        expect(
            tab.termContainer.querySelector('.reconnect-msg').innerText,
        ).toBe('auto-reconnecting (attempt 3/10)...');
    });
});
