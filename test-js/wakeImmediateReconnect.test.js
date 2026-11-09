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
        reconnectInFlight: false,
        termContainer: document.createElement('div'),
        tabEl: document.createElement('div'),
        ...overrides,
    };
    const manager = Object.assign(Object.create(TabManager.prototype), {
        tabs: new Map([[tab.paneId, tab]]),
        app: {
            config: { auto_reconnect: 'visible' },
            showToast: vi.fn(),
        },
        reconnectTab: vi.fn((t) => {
            t.reconnectInFlight = true;
        }),
        updateDisconnectBanner: vi.fn(),
        _showReconnectOverlay: vi.fn(),
        _queuePanelFit: vi.fn(),
        getActiveTab: () => tab,
        _resetPiRecall: vi.fn(),
    });
    return { manager, tab };
}

describe('immediate wake reconnect and input toast suppression', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        Object.defineProperty(document, 'visibilityState', {
            value: 'visible',
            configurable: true,
        });
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('wake redials immediately without timer', () => {
        const { manager, tab } = harness({ reconnectAttempts: 5 });

        manager._reviveActiveTabIfDead();

        expect(manager.reconnectTab).toHaveBeenCalledWith(tab, { auto: true });
        expect(tab.autoReconnectTimer).toBeFalsy();
        expect(tab.reconnectAttempts).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('wake preempts a pending backoff timer', () => {
        const { manager, tab } = harness({ reconnectAttempts: 3 });
        const oldTimerCallback = vi.fn();
        tab.autoReconnectTimer = setTimeout(oldTimerCallback, 15000);
        tab.autoReconnectPending = true;

        manager._reviveActiveTabIfDead();

        expect(tab.autoReconnectTimer).toBeNull();
        expect(tab.autoReconnectPending).toBe(false);
        expect(tab.reconnectAttempts).toBe(0);
        expect(manager.reconnectTab).toHaveBeenCalledWith(tab, { auto: true });

        vi.advanceTimersByTime(20000);
        expect(oldTimerCallback).not.toHaveBeenCalled();
    });

    it('sendInput during in-flight reconnect shows no toast', () => {
        const { manager, tab } = harness({
            isDead: true,
            reconnectInFlight: true,
        });

        const result = manager.sendInput(tab, 'echo hello\r');

        expect(result).toBe(false);
        expect(manager.app.showToast).not.toHaveBeenCalled();
    });

    it('sendInput during pending reconnect timer shows no toast', () => {
        const { manager, tab } = harness({
            isDead: true,
            autoReconnectPending: true,
            autoReconnectTimer: setTimeout(() => {}, 5000),
        });

        const result = manager.sendInput(tab, 'echo hello\r');

        expect(result).toBe(false);
        expect(manager.app.showToast).not.toHaveBeenCalled();
    });

    it('sendInput on plain dead tab still toasts', () => {
        const { manager, tab } = harness({
            isDead: true,
            reconnectInFlight: false,
            autoReconnectPending: false,
            autoReconnectTimer: null,
        });

        const result = manager.sendInput(tab, 'echo hello\r');

        expect(result).toBe(false);
        expect(manager.app.showToast).toHaveBeenCalledWith(
            'Tab is disconnected — input not sent',
            expect.objectContaining({ type: 'error' }),
        );
        expect(manager._showReconnectOverlay).toHaveBeenCalled();
    });
});
