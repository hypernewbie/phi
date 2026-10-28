// @vitest-environment jsdom
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TabManager } from '../web/terminal.js';
let manager;
let banner;
function tab(id, state = {}) {
    const value = {
        paneId: id,
        isDead: true,
        coder: 'bash',
        reconnectAttempts: 0,
        termContainer: document.createElement('div'),
        tabEl: document.createElement('div'),
        ...state,
    };
    manager.tabs.set(id, value);
    return value;
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
    });
    document.body.innerHTML =
        '<div id="disconnect-banner" class="hidden"></div>';
    banner = document.getElementById('disconnect-banner');
    manager = Object.assign(Object.create(TabManager.prototype), {
        tabs: new Map(),
        app: { config: { auto_reconnect: 'visible' }, showToast: vi.fn() },
        reconnectTab: vi.fn((pane) => {
            pane.reconnectInFlight = true;
        }),
        updateDocumentTitle: vi.fn(),
        _updateHistoryButton: vi.fn(),
        _refreshPiBridgeModels: vi.fn(),
        _invalidatePiBridgeCompact: vi.fn(),
        getActiveTab: vi.fn(),
        activateTabViewport: vi.fn(),
    });
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('data-phi-desktop');
});
it.each(['browser', 'desktop'])(
    '%s redials only the active pane unless the desktop shell owns all panes',
    (mode) => {
        if (mode === 'desktop')
            document.documentElement.setAttribute('data-phi-desktop', '');
        const first = tab('p1');
        const second = tab('p2');
        tab('healthy', { isDead: false });
        manager.getActiveTab.mockReturnValue(first);
        manager.activePaneId = first.paneId;
        manager.updateDisconnectBanner();
        expect(banner.textContent).toContain('2 tabs disconnected');
        manager._reviveActiveTabIfDead();
        expect(banner.classList.contains('hidden')).toBe(true);
        expect(manager.reconnectTab).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1000);
        expect(manager.reconnectTab.mock.calls).toEqual(
            mode === 'desktop'
                ? [
                      [first, { auto: true }],
                      [second, { auto: true }],
                  ]
                : [[first, { auto: true }]],
        );
        expect(manager.activateTabViewport).not.toHaveBeenCalled();
    },
);
it('does not redial a background browser pane while visible', () => {
    manager.activePaneId = 'active';
    manager._showReconnectOverlay = vi.fn();
    const pane = tab('background', { isDead: false });
    manager._handleTerminalDisconnect(pane);
    expect(pane.autoReconnectPending).toBe(true);
    expect(manager.maybeAutoReconnect(pane)).toBe(false);
    expect(banner.classList.contains('hidden')).toBe(true);
    expect(manager.app.showToast).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(manager.reconnectTab).not.toHaveBeenCalled();
    expect(manager._showReconnectOverlay).toHaveBeenCalledWith(pane);
});
it('off exposes pending panes immediately; the skipped timer clears pending status', () => {
    const pane = tab('p1');
    manager._reviveActiveTabIfDead();
    manager.app.config.auto_reconnect = 'off';
    manager.updateDisconnectBanner();
    expect(banner.classList.contains('hidden')).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(pane.autoReconnectPending).toBe(false);
    expect(pane.termContainer.querySelector('.reconnect-btn').disabled).toBe(
        false,
    );
    expect(manager.reconnectTab).not.toHaveBeenCalled();
});
it('closing and special panes do not produce banner entries', () => {
    tab('closing', { softClosing: true });
    tab('final', { finalizing: true });
    tab('review', { isReview: true });
    tab('kanban', { isKanban: true });
    tab('exit', { exitCode: 0 });
    manager.updateDisconnectBanner();
    expect(banner.classList.contains('hidden')).toBe(true);
});
