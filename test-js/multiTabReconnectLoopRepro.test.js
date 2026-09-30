// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TabManager } from '../web/terminal.js';
import { PTYWebSocket } from '../web/ws.js';

describe('multi-tab reconnect failure loop reproduction', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('reproduces orphaned timer multiplication when reconnectTab is called during pending auto-reconnect', () => {
        const c = Object.create(TabManager.prototype);
        c.app = { config: { auto_reconnect: 'visible' }, isDesktop: true };
        c.tabs = new Map();
        c.getActiveTab = vi.fn();
        c.updateDocumentTitle = vi.fn();
        c._showReconnectOverlay = vi.fn();
        c.updateDisconnectBanner = vi.fn();

        const tab = {
            paneId: 'p1',
            isDead: true,
            coder: 'bash',
            reconnectAttempts: 0,
            reconnectInFlight: false,
            autoReconnectPending: false,
            termContainer: { querySelector: () => null },
            tabEl: { classList: { add: vi.fn(), remove: vi.fn() } },
        };
        c.tabs.set('p1', tab);

        // 1. Connection drops -> maybeAutoReconnect is called
        TabManager.prototype.maybeAutoReconnect.call(c, tab);
        expect(tab.autoReconnectPending).toBe(true);
        expect(tab.reconnectAttempts).toBe(1);
        expect(vi.getTimerCount()).toBe(1);

        // 2. User wakes laptop or switches tabs or clicks reconnect before timer expires
        // reconnectTab is called
        let reconnectCalls = 0;
        c.reconnectTab = vi.fn(() => {
            reconnectCalls++;
            tab.reconnectInFlight = true;
            tab.autoReconnectPending = false;
        });

        // Wake / focus triggers revival
        tab.reconnectAttempts = 0;
        tab.autoReconnectPending = false;
        c.reconnectTab(tab, { auto: true });
        expect(reconnectCalls).toBe(1);

        // Simulate reconnect failing (server was unreachable)
        tab.reconnectInFlight = false;
        tab.isDead = true;
        // On failure, maybeAutoReconnect is called again!
        TabManager.prototype.maybeAutoReconnect.call(c, tab);
        expect(tab.reconnectAttempts).toBe(1);

        // With the fix, Timer 1 was properly cancelled when maybeAutoReconnect was called!
        // At most 1 timer ever exists per tab.
        expect(vi.getTimerCount()).toBe(1);

        // Advance time so Timer 2 fires
        vi.advanceTimersByTime(2500);

        // Reconnect was called exactly once by Timer 2
        expect(reconnectCalls).toBe(2);
    });

    it('old socket onClose callback must NOT clobber new socket state or trigger reconnect loops', () => {
        // Mock WebSocket
        class MockWS {
            constructor(url) {
                this.url = url;
                this.readyState = 0; // CONNECTING
                this.onclose = null;
                this.onopen = null;
                this.onerror = null;
                this.onmessage = null;
            }
            close() {
                this.readyState = 3; // CLOSED
                // In real browsers, onclose fires asynchronously
                setTimeout(() => {
                    if (this.onclose)
                        this.onclose({ code: 1000, reason: 'Normal Closure' });
                }, 0);
            }
        }
        globalThis.WebSocket = MockWS;

        const c = Object.create(TabManager.prototype);
        c.app = { config: { auto_reconnect: 'visible' }, isDesktop: true };
        c.tabs = new Map();
        c.getActiveTab = vi.fn();
        c.updateDocumentTitle = vi.fn();
        c._showReconnectOverlay = vi.fn();
        c.updateDisconnectBanner = vi.fn();
        c._hotOptions = vi.fn(() => ({ hot: false }));

        const tab = {
            paneId: 'p1',
            isDead: false,
            coder: 'bash',
            reconnectAttempts: 0,
            reconnectInFlight: false,
            autoReconnectPending: false,
            termContainer: { querySelector: () => null },
            tabEl: { classList: { add: vi.fn(), remove: vi.fn() } },
        };
        c.tabs.set('p1', tab);

        // 1. Initial reconnect
        TabManager.prototype.reconnectTab.call(c, tab);
        const socket1 = tab.ws;
        expect(socket1).toBeDefined();
        // Emulate socket1 connecting successfully
        socket1.onOpen?.();
        expect(tab.isDead).toBe(false);

        // 2. Tab is reconnected again (e.g. desktop focus / wake / user retry)
        TabManager.prototype.reconnectTab.call(c, tab);
        const socket2 = tab.ws;
        expect(socket2).not.toBe(socket1);

        // Now socket2 opens successfully
        socket2.onOpen?.();
        expect(tab.isDead).toBe(false);

        // Now simulate the asynchronous close event on socket1 firing!
        // In the unpatched code, socket1.close() fired socket1's onClose callback,
        // which marked tab.isDead = true and called maybeAutoReconnect even though socket2 is alive!
        vi.advanceTimersByTime(10);

        // With the bug, socket1's onClose marked tab.isDead = true!
        // We assert that the old socket's close event MUST NOT mark the tab as dead!
        expect(tab.isDead).toBe(false);
    });

    it('exhausting max attempts re-enables Retry button and does not enter infinite loop', () => {
        const c = Object.create(TabManager.prototype);
        c.app = { config: { auto_reconnect: 'visible' }, isDesktop: true };
        c.tabs = new Map();
        c.getActiveTab = vi.fn();
        c.updateDocumentTitle = vi.fn();
        c._showReconnectOverlay = vi.fn();
        c.updateDisconnectBanner = vi.fn();

        const msgEl = document.createElement('div');
        msgEl.className = 'reconnect-msg';
        const btnEl = document.createElement('button');
        btnEl.className = 'reconnect-btn';
        btnEl.disabled = true;
        const restartBtn = document.createElement('button');
        restartBtn.className = 'restart-btn';
        restartBtn.disabled = true;

        const overlay = document.createElement('div');
        overlay.className = 'reconnect-overlay';
        overlay.appendChild(msgEl);
        overlay.appendChild(btnEl);
        overlay.appendChild(restartBtn);

        const termContainer = document.createElement('div');
        termContainer.appendChild(overlay);

        const tab = {
            paneId: 'p1',
            isDead: true,
            coder: 'bash',
            reconnectAttempts: 10,
            reconnectInFlight: false,
            autoReconnectPending: true,
            termContainer,
            tabEl: { classList: { add: vi.fn(), remove: vi.fn() } },
        };

        // When attempt 10 fails, maybeAutoReconnect is called with attempts >= 10
        const result = TabManager.prototype.maybeAutoReconnect.call(c, tab);
        expect(result).toBe(false);
        expect(tab.autoReconnectPending).toBe(false);

        // Buttons MUST be re-enabled so user is not locked out until page reload
        expect(btnEl.disabled).toBe(false);
        expect(restartBtn.disabled).toBe(false);
        expect(msgEl.innerText).toContain('Auto-reconnect failed');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('multiple tabs disconnecting at the same time do not multiply timers or enter loops', () => {
        const c = Object.create(TabManager.prototype);
        c.app = { config: { auto_reconnect: 'visible' }, isDesktop: true };
        c.tabs = new Map();
        c.getActiveTab = vi.fn();
        c.updateDocumentTitle = vi.fn();
        c._showReconnectOverlay = vi.fn();
        c.updateDisconnectBanner = vi.fn();

        const tabs = ['p1', 'p2', 'p3'].map((id) => ({
            paneId: id,
            isDead: true,
            coder: 'bash',
            reconnectAttempts: 0,
            reconnectInFlight: false,
            autoReconnectPending: false,
            termContainer: { querySelector: () => null },
            tabEl: { classList: { add: vi.fn(), remove: vi.fn() } },
        }));

        for (const t of tabs) {
            c.tabs.set(t.paneId, t);
        }

        // All 3 tabs disconnect simultaneously
        for (const t of tabs) {
            TabManager.prototype.maybeAutoReconnect.call(c, t);
        }

        // Exactly 3 timers scheduled (1 per tab)
        expect(vi.getTimerCount()).toBe(3);

        // Desktop wakes or focus occurs - revives all dead tabs
        let reconnectCalls = 0;
        c.reconnectTab = vi.fn((t) => {
            reconnectCalls++;
            t.reconnectInFlight = true;
        });

        TabManager.prototype._reviveActiveTabIfDead.call(c);

        // All 3 tabs have reconnectTab called, and their autoReconnectTimers are cleared!
        expect(reconnectCalls).toBe(3);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('manual retry aborts stalled in-flight connection and re-triggers connection', () => {
        class MockWS {
            constructor(url) {
                this.url = url;
                this.readyState = 0; // CONNECTING forever (stalled)
                this.close = vi.fn();
            }
        }
        globalThis.WebSocket = MockWS;

        const c = Object.create(TabManager.prototype);
        c.app = { config: { auto_reconnect: 'visible' }, isDesktop: true };
        c.tabs = new Map();
        c.getActiveTab = vi.fn();
        c.updateDocumentTitle = vi.fn();
        c._showReconnectOverlay = vi.fn();
        c.updateDisconnectBanner = vi.fn();
        c._hotOptions = vi.fn(() => ({ hot: false }));

        const tab = {
            paneId: 'p1',
            isDead: true,
            coder: 'bash',
            reconnectAttempts: 0,
            reconnectInFlight: false,
            autoReconnectPending: false,
            termContainer: { querySelector: () => null },
            tabEl: { classList: { add: vi.fn(), remove: vi.fn() } },
        };

        // 1. Initial reconnect starts and hangs in flight
        TabManager.prototype.reconnectTab.call(c, tab, { auto: true });
        expect(tab.reconnectInFlight).toBe(true);
        const ws1 = tab.ws;
        expect(ws1).toBeDefined();

        // 2. An auto reconnect call while in flight is ignored
        TabManager.prototype.reconnectTab.call(c, tab, { auto: true });
        expect(tab.ws).toBe(ws1); // unchanged

        // 3. User clicks Retry manually (!auto) -> forces abort and initiates new connection
        TabManager.prototype.reconnectTab.call(c, tab, { auto: false });
        expect(ws1.ws.close).toHaveBeenCalled();
        expect(tab.ws).not.toBe(ws1);
        expect(tab.reconnectInFlight).toBe(true);
    });

    it('watchdog timer triggers after 10s if WebSocket hangs, re-enables Retry button and cleans up inFlight', () => {
        class MockWS {
            constructor(url) {
                this.url = url;
                this.readyState = 0; // CONNECTING forever (stalled)
                this.close = vi.fn();
            }
        }
        globalThis.WebSocket = MockWS;

        const c = Object.create(TabManager.prototype);
        c.app = { config: { auto_reconnect: 'visible' }, isDesktop: true };
        c.tabs = new Map();
        c.getActiveTab = vi.fn();
        c.updateDocumentTitle = vi.fn();
        c._showReconnectOverlay = vi.fn();
        c.updateDisconnectBanner = vi.fn();
        c._hotOptions = vi.fn(() => ({ hot: false }));

        const msgEl = document.createElement('div');
        msgEl.className = 'reconnect-msg';
        const btnEl = document.createElement('button');
        btnEl.className = 'reconnect-btn';
        btnEl.disabled = true;
        const restartBtn = document.createElement('button');
        restartBtn.className = 'restart-btn';
        restartBtn.disabled = true;

        const overlay = document.createElement('div');
        overlay.className = 'reconnect-overlay';
        overlay.appendChild(msgEl);
        overlay.appendChild(btnEl);
        overlay.appendChild(restartBtn);

        const termContainer = document.createElement('div');
        termContainer.appendChild(overlay);

        const tab = {
            paneId: 'p1',
            isDead: true,
            coder: 'bash',
            reconnectAttempts: 0,
            reconnectInFlight: false,
            autoReconnectPending: false,
            termContainer,
            tabEl: { classList: { add: vi.fn(), remove: vi.fn() } },
        };

        TabManager.prototype.reconnectTab.call(c, tab, { auto: true });
        expect(tab.reconnectInFlight).toBe(true);
        expect(tab.reconnectWatchdogTimer).toBeDefined();

        // Advance 10s to trigger watchdog
        vi.advanceTimersByTime(10_000);

        expect(tab.reconnectInFlight).toBe(false);
        expect(tab.isDead).toBe(true);
        expect(msgEl.innerText).toBe('Connection timed out');
        expect(btnEl.disabled).toBe(false);
        expect(restartBtn.disabled).toBe(false);
        expect(c.updateDisconnectBanner).toHaveBeenCalled();
    });

    it('activateTabViewport resets reconnectAttempts on dead tab with visible auto_reconnect', () => {
        const c = Object.create(TabManager.prototype);
        c.app = { config: { auto_reconnect: 'visible' }, isDesktop: true };
        c.tabs = new Map();
        c.getActiveTab = vi.fn();
        c.reconnectTab = vi.fn();
        c.fitActiveTerminal = vi.fn();
        c._spamScrollToBottom = vi.fn();

        const tab = {
            paneId: 'p1',
            isDead: true,
            coder: 'bash',
            reconnectAttempts: 10,
            reconnectInFlight: false,
            autoReconnectPending: false,
            autoReconnectTimer: setTimeout(() => {}, 5000),
            tabEl: { classList: { add: vi.fn(), remove: vi.fn() } },
        };

        TabManager.prototype.activateTabViewport.call(c, tab, {
            autoReconnect: true,
        });

        expect(tab.reconnectAttempts).toBe(0);
        expect(tab.autoReconnectTimer).toBeNull();
        expect(c.reconnectTab).toHaveBeenCalledWith(tab, { auto: true });
    });
});
