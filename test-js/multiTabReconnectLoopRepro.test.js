// @vitest-environment jsdom
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TabManager } from '../web/terminal.js';

class NativeSocket {
    static OPEN = 1;
    constructor() {
        this.readyState = 0;
        this.send = vi.fn();
        this.close = vi.fn(() => {
            this.readyState = 3;
        });
    }
}
function harness() {
    const tab = {
        paneId: 'p1',
        isDead: true,
        coder: 'bash',
        exitCode: null,
        reconnectAttempts: 3,
        reconnectInFlight: false,
        termContainer: document.createElement('div'),
        tabEl: document.createElement('div'),
        term: { refresh: vi.fn(), rows: 24 },
        userFollowBottom: false,
    };
    const manager = Object.assign(Object.create(TabManager.prototype), {
        tabs: new Map([['p1', tab]]),
        app: { config: { auto_reconnect: 'visible' }, showToast: vi.fn() },
        getActiveTab: () => tab,
        updateDocumentTitle: vi.fn(),
        updateDisconnectBanner: vi.fn(),
        _refreshPiBridgeModels: vi.fn(),
        _invalidatePiBridgeCompact: vi.fn(),
        _hotOptions: () => ({}),
        _queuePanelFit: vi.fn(),
        _paneData: vi.fn(),
        _spamScrollToBottom: vi.fn(),
    });
    manager._showReconnectOverlay(tab);
    return { manager, tab };
}
function open(socket) {
    expect(typeof socket.ws.onopen).toBe('function');
    socket.ws.readyState = 1;
    socket.ws.onopen();
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', NativeSocket);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
    });
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it('wake preserves a pending retry and never multiplies its timer', () => {
    const { manager, tab } = harness();
    manager.maybeAutoReconnect(tab);
    const timer = tab.autoReconnectTimer;
    manager._reviveActiveTabIfDead();
    manager._reviveActiveTabIfDead();
    expect(tab.autoReconnectTimer).toBe(timer);
    expect(tab.reconnectAttempts).toBe(4);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(tab.reconnectInFlight).toBe(true);
    expect(tab.autoReconnectPending).toBe(false);
    expect(vi.getTimerCount()).toBe(1); // current CONNECTING watchdog
});
it('only a current live attachment resets its budget at five continuous seconds', () => {
    const { manager, tab } = harness();
    manager.reconnectTab(tab, { auto: true });
    open(tab.ws);
    expect(tab.isDead).toBe(false);
    vi.advanceTimersByTime(4999);
    expect(tab.reconnectAttempts).toBe(3);
    vi.advanceTimersByTime(1);
    expect(tab.reconnectAttempts).toBe(0);
    expect(tab.reconnectStableTimer).toBeNull();
    expect(manager._spamScrollToBottom).not.toHaveBeenCalled();
});
it('a short-lived open retains backoff and schedules exactly one next attempt', () => {
    const { manager, tab } = harness();
    manager.reconnectTab(tab, { auto: true });
    open(tab.ws);
    vi.advanceTimersByTime(999);
    expect(typeof tab.ws.onClose).toBe('function');
    tab.ws.onClose();
    expect(tab.isDead).toBe(true);
    expect(tab.reconnectAttempts).toBe(4);
    expect(tab.reconnectStableTimer).toBeNull();
    vi.advanceTimersByTime(4001);
    expect(tab.reconnectAttempts).toBe(4);
});
it.each(['removed', 'finalizing', 'exit'])(
    'stability cannot reset after %s',
    (change) => {
        const { manager, tab } = harness();
        manager.reconnectTab(tab, { auto: true });
        open(tab.ws);
        if (change === 'removed') manager.tabs.clear();
        else if (change === 'exit') tab.exitCode = 0;
        else tab.finalizing = true;
        vi.advanceTimersByTime(5000);
        expect(tab.reconnectAttempts).toBe(3);
    },
);
it('saved old open, close, and stability callbacks cannot change a live successor', () => {
    const { manager, tab } = harness();
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    manager.reconnectTab(tab, { auto: true });
    const old = tab.ws;
    const oldOpen = old.onOpen;
    const oldClose = old.onClose;
    open(old);
    const oldStable = timeouts.mock.calls.find((call) => call[1] === 5000)[0];
    for (const callback of [oldOpen, oldClose, oldStable])
        expect(typeof callback).toBe('function');
    manager.reconnectTab(tab, { auto: true });
    const current = tab.ws;
    expect(current).not.toBe(old);
    open(current);
    expect(tab.isDead).toBe(false);
    expect(tab.reconnectInFlight).toBe(false);
    tab.reconnectAttempts = 7;
    const timer = tab.reconnectStableTimer;
    oldOpen();
    oldClose();
    oldStable();
    expect(tab.ws).toBe(current);
    expect(tab.isDead).toBe(false);
    expect(tab.reconnectInFlight).toBe(false);
    expect(tab.reconnectAttempts).toBe(7);
    expect(tab.reconnectStableTimer).toBe(timer);
});
it('manual Retry resets exhaustion even with automatic recovery off', () => {
    const { manager, tab } = harness();
    manager.app.config.auto_reconnect = 'off';
    tab.reconnectAttempts = 10;
    tab.termContainer.querySelector('.reconnect-btn').click();
    expect(tab.reconnectAttempts).toBe(0);
    expect(tab.reconnectInFlight).toBe(true);
});
it('auto ignores an in-flight connection; explicit manual retry replaces it', () => {
    const { manager, tab } = harness();
    manager.reconnectTab(tab);
    const first = tab.ws;
    manager.reconnectTab(tab, { auto: true });
    expect(tab.ws).toBe(first);
    manager.reconnectTab(tab, { auto: false });
    expect(first.ws.close).toHaveBeenCalledOnce();
    expect(tab.ws).not.toBe(first);
    expect(tab.reconnectInFlight).toBe(true);
});
it.each(['visible', 'off'])(
    'CONNECTING watchdog settles then respects %s retry policy',
    (config) => {
        const { manager, tab } = harness();
        manager.app.config.auto_reconnect = config;
        manager.reconnectTab(tab, { auto: true });
        const first = tab.ws;
        vi.advanceTimersByTime(10000);
        expect(first.ws.close).toHaveBeenCalledOnce();
        expect(tab.reconnectInFlight).toBe(false);
        expect(tab.isDead).toBe(true);
        expect(tab.termContainer.querySelector('.reconnect-btn').disabled).toBe(
            false,
        );
        expect(tab.termContainer.querySelector('.restart-btn').disabled).toBe(
            false,
        );
        if (config === 'off') {
            expect(
                tab.termContainer.querySelector('.reconnect-msg').innerText,
            ).toBe('Connection timed out');
            expect(vi.getTimerCount()).toBe(0);
        } else {
            expect(tab.reconnectAttempts).toBe(4);
            expect(tab.autoReconnectPending).toBe(true);
            expect(vi.getTimerCount()).toBe(1);
            vi.advanceTimersByTime(1000);
            expect(tab.ws).not.toBe(first);
            expect(tab.reconnectInFlight).toBe(true);
        }
    },
);

it.each([false, true])(
    'constructor failure restores a %s live-refresh pane to bounded recovery',
    (live) => {
        const { manager, tab } = harness();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubGlobal(
            'WebSocket',
            class {
                constructor() {
                    throw new Error('offline');
                }
            },
        );
        if (live) {
            tab.isDead = false;
            manager._cancelHistoryRequest = vi.fn();
            manager.refreshConsole();
        } else manager.reconnectTab(tab, { auto: true });
        expect(tab.isDead).toBe(true);
        expect(tab.tabEl.classList.contains('dead')).toBe(true);
        expect(tab.reconnectInFlight).toBe(false);
        expect(tab.autoReconnectPending).toBe(true);
        expect(tab.reconnectAttempts).toBe(live ? 1 : 4);
    },
);
it('ten constructor failures exhaust the series; a real Retry starts a fresh series', () => {
    const { manager, tab } = harness();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const attempts = vi.fn();
    vi.stubGlobal(
        'WebSocket',
        class {
            constructor() {
                attempts();
                throw new Error('offline');
            }
        },
    );
    manager._reviveActiveTabIfDead();
    vi.advanceTimersByTime(10000);
    expect(attempts).toHaveBeenCalledTimes(10);
    expect(tab.reconnectAttempts).toBe(10);
    expect(tab.autoReconnectPending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    tab.termContainer.querySelector('.reconnect-btn').click();
    expect(tab.reconnectAttempts).toBe(1);
    expect(attempts).toHaveBeenCalledTimes(11);
    expect(tab.autoReconnectPending).toBe(true);
});
it('saved watchdog/data/control callbacks cannot mutate a successor', () => {
    const { manager, tab } = harness();
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    manager.reconnectTab(tab, { auto: true });
    const old = tab.ws;
    const data = old.onData;
    const control = old.onControl;
    const watchdog = timeouts.mock.calls.find((call) => call[1] === 10000)[0];
    for (const callback of [data, control, watchdog])
        expect(typeof callback).toBe('function');
    manager.reconnectTab(tab);
    const current = tab.ws;
    open(current);
    const stable = tab.reconnectStableTimer;
    tab.reconnectAttempts = 6;
    data('obsolete');
    control({ type: 'pty-exited', code: 1 });
    watchdog();
    expect(manager._paneData).not.toHaveBeenCalled();
    expect(tab.isDead).toBe(false);
    expect(tab.exitCode).toBeNull();
    expect(tab.reconnectAttempts).toBe(6);
    expect(tab.reconnectStableTimer).toBe(stable);
    expect(tab.ws).toBe(current);
});
it('exit before late close/stability keeps authoritative exit state without retries', () => {
    const { manager, tab } = harness();
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    manager.reconnectTab(tab, { auto: true });
    open(tab.ws);
    const closed = tab.ws.onClose;
    const stable = timeouts.mock.calls.find((call) => call[1] === 5000)[0];
    expect(typeof closed).toBe('function');
    expect(typeof stable).toBe('function');
    manager.handleControlMessage(tab, { type: 'pty-exited', code: 0 });
    closed();
    stable();
    expect(tab.isDead).toBe(true);
    expect(tab.exitCode).toBe(0);
    expect(tab.termContainer.querySelector('.reconnect-msg').textContent).toBe(
        'process exited (code 0)',
    );
    expect(tab.reconnectAttempts).toBe(3);
    expect(tab.reconnectInFlight).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
});
it('a partly transmitted input is never resent by the replacement socket', () => {
    const { manager, tab } = harness();
    manager.inputTextArea = document.createElement('textarea');
    manager.inputTextArea.value = 'x'.repeat(1024 * 1024 + 1);
    manager.reconnectTab(tab);
    open(tab.ws);
    const first = tab.ws;
    first.ws.send
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
            throw new Error('connection lost');
        });
    expect(manager.sendInput(tab, manager.inputTextArea.value)).toBe(false);
    expect(first.ws.send).toHaveBeenCalledTimes(2);
    expect(manager.inputTextArea.value).toHaveLength(1024 * 1024 + 1);
    manager.reconnectTab(tab);
    open(tab.ws);
    expect(tab.ws.ws.send).not.toHaveBeenCalled();
    expect(manager.inputTextArea.value).toHaveLength(1024 * 1024 + 1);
});

it('close-before-open does not claim that the PTY expired', () => {
    const { manager, tab } = harness();
    manager.app.config.auto_reconnect = 'off';
    manager.reconnectTab(tab);
    expect(typeof tab.ws.onClose).toBe('function');
    tab.ws.onClose();
    expect(tab.termContainer.querySelector('.reconnect-msg').innerText).toBe(
        'Connection failed. Retry or check your connection.',
    );
    expect(tab.exitCode).toBeNull();
});
it.each(['open', 'close'])(
    'current %s settles during soft-close and Undo stays usable',
    (event) => {
        const { manager, tab } = harness();
        manager.reconnectTab(tab);
        tab.softClosing = true;
        if (event === 'open') open(tab.ws);
        else tab.ws.onClose();
        expect(tab.reconnectInFlight).toBe(false);
        expect(tab.autoReconnectPending).toBe(false);
        manager.updateTabOverflow = vi.fn();
        manager._refreshOverflowDropdown = vi.fn();
        manager.switchTab = vi.fn(() =>
            manager.activateTabViewport(tab, {
                scrollToBottom: false,
                force: true,
            }),
        );
        manager.undoCloseTab(tab.paneId);
        expect(tab.softClosing).toBe(false);
        expect(manager.switchTab).toHaveBeenCalledWith(tab.paneId, {
            userInitiated: true,
        });
        expect(tab.reconnectInFlight).toBe(event === 'close');
    },
);
