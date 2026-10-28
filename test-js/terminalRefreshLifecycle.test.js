// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';
setupDomHarness();
afterEach(() => vi.unstubAllGlobals());
function harness() {
    const term = {
        cols: 80,
        rows: 24,
        options: { fontSize: 14 },
        refresh: vi.fn(),
        _core: { _charSizeService: { measure: vi.fn() } },
        buffer: { active: { baseY: 0, viewportY: 0 } },
    };
    const ws = { mode: 'hot', sendResize: vi.fn(() => true) };
    const tab = {
        term,
        ws,
        _sizedWs: ws,
        paneEpoch: 7,
        fitAddon: {
            proposeDimensions: () => ({ cols: 80, rows: 24 }),
            fit: vi.fn(),
        },
    };
    const manager = Object.assign(Object.create(TabManager.prototype), {
        app: {},
        getActiveTab: () => tab,
        resolveTerminalFontSize: () => 14,
        _resyncViewportScroll: vi.fn(),
        _spamScroll: vi.fn(),
        _scheduleCheckpointUpload: vi.fn(),
    });
    const frames = [];
    vi.stubGlobal('requestAnimationFrame', (callback) => {
        frames.push(callback);
        return frames.length;
    });
    return { tab, term, ws, manager, frames };
}
function reloadHarness() {
    const h = harness();
    const active = Object.assign(h.tab, {
        paneId: 'active',
        coder: 'bash',
        isDead: false,
        _historyRequestId: 'active-history',
        _historyBrowsing: true,
        _forceStateRefresh: false,
        userFollowBottom: false,
    });
    const healthyBackground = {
        paneId: 'healthy-background',
        coder: 'bash',
        term: {},
        ws: { close: vi.fn() },
        isDead: false,
        _historyRequestId: 'healthy-history',
        _historyBrowsing: true,
        _forceStateRefresh: 'preserve-healthy',
        userFollowBottom: false,
    };
    const deadBackground = {
        paneId: 'dead-background',
        coder: 'bash',
        term: {},
        ws: { close: vi.fn() },
        isDead: true,
        _historyRequestId: 'dead-history',
        _historyBrowsing: true,
        _forceStateRefresh: 'preserve-dead',
        userFollowBottom: true,
    };
    const tabs = new Map([
        [active.paneId, active],
        [healthyBackground.paneId, healthyBackground],
        [deadBackground.paneId, deadBackground],
    ]);
    Object.assign(h.manager, {
        tabs,
        activePaneId: active.paneId,
        getActiveTab: TabManager.prototype.getActiveTab,
        reconnectTab: vi.fn(),
        _cancelHistoryRequest: vi.fn(),
        restartTab: vi.fn(),
        closeTab: vi.fn(),
        createTab: vi.fn(),
        finalizeCloseTab: vi.fn(),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    return { ...h, active, healthyBackground, deadBackground, tabs, fetchSpy };
}

it.each([
    ['healthy', false],
    ['disconnected', true],
])(
    'reload targets only the %s active terminal without restarting it',
    (_state, isDead) => {
        const h = reloadHarness();
        h.active.isDead = isDead;
        const keys = [...h.tabs.keys()];
        const entries = [...h.tabs.entries()];
        const healthyState = { ...h.healthyBackground };
        const deadState = { ...h.deadBackground };
        const activeSocket = h.active.ws;

        h.manager.refreshConsole();

        expect(h.manager._cancelHistoryRequest.mock.calls).toEqual([
            [h.active],
        ]);
        expect(h.active._forceStateRefresh).toBe(true);
        expect(h.active.userFollowBottom).toBe(true);
        expect(h.manager.reconnectTab.mock.calls).toEqual([[h.active]]);
        expect(h.manager.tabs).toBe(h.tabs);
        expect([...h.manager.tabs.keys()]).toEqual(keys);
        expect([...h.manager.tabs.entries()]).toEqual(entries);
        expect(h.active.paneId).toBe('active');
        expect(h.active.ws).toBe(activeSocket);
        expect(h.healthyBackground).toMatchObject(healthyState);
        expect(h.healthyBackground.ws).toBe(healthyState.ws);
        expect(h.deadBackground).toMatchObject(deadState);
        expect(h.deadBackground.ws).toBe(deadState.ws);
        expect(h.manager.restartTab).not.toHaveBeenCalled();
        expect(h.manager.closeTab).not.toHaveBeenCalled();
        expect(h.manager.createTab).not.toHaveBeenCalled();
        expect(h.manager.finalizeCloseTab).not.toHaveBeenCalled();
        expect(h.fetchSpy).not.toHaveBeenCalled();
    },
);

it('uses the current active selection on each reload call', () => {
    const h = reloadHarness();
    h.manager.refreshConsole();
    h.manager.activePaneId = h.healthyBackground.paneId;
    h.manager.refreshConsole();

    expect(h.manager._cancelHistoryRequest.mock.calls).toEqual([
        [h.active],
        [h.healthyBackground],
    ]);
    expect(h.manager.reconnectTab.mock.calls).toEqual([
        [h.active],
        [h.healthyBackground],
    ]);
    expect(h.deadBackground._forceStateRefresh).toBe('preserve-dead');
    expect(h.deadBackground.userFollowBottom).toBe(true);
    expect(h.fetchSpy).not.toHaveBeenCalled();
});

it.each([
    ['no active ID', undefined, 'eligible'],
    ['unknown active ID', 'missing', 'eligible'],
    ['missing terminal', 'active', 'missing-terminal'],
    ['finalizing tab', 'active', 'finalizing'],
    ['Pi RPC panel', 'active', 'pi-rpc'],
    ['Review panel', 'active', 'review'],
    ['Kanban panel', 'active', 'kanban'],
])('does not reload with %s', (_name, activePaneId, activeKind) => {
    const h = reloadHarness();
    h.manager.activePaneId = activePaneId;
    if (activeKind === 'missing-terminal') h.active.term = null;
    if (activeKind === 'finalizing') h.active.finalizing = true;
    if (['pi-rpc', 'review', 'kanban'].includes(activeKind))
        h.active.coder = activeKind;
    const before = { ...h.active };

    h.manager.refreshConsole();

    expect(h.manager._cancelHistoryRequest).not.toHaveBeenCalled();
    expect(h.manager.reconnectTab).not.toHaveBeenCalled();
    expect(h.active).toMatchObject(before);
    expect(h.manager.restartTab).not.toHaveBeenCalled();
    expect(h.manager.closeTab).not.toHaveBeenCalled();
    expect(h.manager.createTab).not.toHaveBeenCalled();
    expect(h.manager.finalizeCloseTab).not.toHaveBeenCalled();
    expect(h.fetchSpy).not.toHaveBeenCalled();
});

it('a same-size forced refresh repaints xterm, resyncs its viewport and resizes the backend', () => {
    const h = harness();
    h.manager.fitActiveTerminal({ forceResize: true });
    expect(h.term.refresh).toHaveBeenCalledWith(0, 23);
    expect(h.manager._resyncViewportScroll).toHaveBeenCalledWith(h.tab);
    expect(h.term._core._charSizeService.measure).toHaveBeenCalledOnce();
    expect(h.ws.sendResize).toHaveBeenCalledWith(80, 24);
    expect(h.tab.fitAddon.fit).not.toHaveBeenCalled();
});
it('ordinary identical fits stay quiet instead of repeatedly redrawing an idle TUI', () => {
    const h = harness();
    h.manager.fitActiveTerminal();
    expect(h.term.refresh).not.toHaveBeenCalled();
    expect(h.ws.sendResize).not.toHaveBeenCalled();
});
it('activation and wake refreshes coalesce on layout admission, not a guessed timer', () => {
    const h = harness();
    h.manager.activateTabViewport(h.tab, {
        scrollToBottom: false,
        autoReconnect: false,
    });
    h.manager._queueActiveRefresh();
    expect(h.frames).toHaveLength(1);
    expect(h.ws.sendResize).not.toHaveBeenCalled();
    h.frames.shift()();
    expect(h.ws.sendResize).toHaveBeenCalledOnce();
    expect(h.term.refresh).toHaveBeenCalledOnce();
});
it('a force request survives a bootstrap gate and an ordinary observer fit', () => {
    const h = harness();
    h.tab._bootstrapGate = Promise.resolve();
    h.manager._queuePanelFit(h.tab, { forceResize: true });
    h.frames.shift()();
    expect(h.ws.sendResize).not.toHaveBeenCalled();
    expect(h.tab._pendingForceResize).toBe(true);
    h.tab._bootstrapGate = null;
    h.manager._queuePanelFit(h.tab);
    h.frames.shift()();
    expect(h.ws.sendResize).toHaveBeenCalledOnce();
    expect(h.term.refresh).toHaveBeenCalledOnce();
});
it('historical views keep the live process at the actual panel grid on reactivation', () => {
    const h = harness();
    h.tab._historyBrowsing = true;
    h.tab._historyLiveState = { cols: 40, rows: 12 };
    h.manager.fitActiveTerminal({ forceResize: true });
    expect(h.tab._historyLiveState).toEqual({ cols: 80, rows: 24 });
    expect(h.ws.sendResize).toHaveBeenCalledWith(80, 24);
    expect(h.term.refresh).toHaveBeenCalledWith(0, 23);
});
it('zero-delta reconnect refreshes both renderers before releasing live delivery', async () => {
    const h = harness();
    const release = vi.fn();
    expect(
        await h.manager._bootstrapDelta(h.tab, 0, 0, undefined, release),
    ).toEqual({ kind: 'applied', through: 0 });
    expect(h.term.refresh).toHaveBeenCalledWith(0, 23);
    expect(h.ws.sendResize).toHaveBeenCalledWith(80, 24);
    expect(h.ws.sendResize.mock.invocationCallOrder[0]).toBeLessThan(
        release.mock.invocationCallOrder[0],
    );
});
