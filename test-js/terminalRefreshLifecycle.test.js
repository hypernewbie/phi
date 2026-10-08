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
    ).toBe(true);
    expect(h.term.refresh).toHaveBeenCalledWith(0, 23);
    expect(h.ws.sendResize).toHaveBeenCalledWith(80, 24);
    expect(h.ws.sendResize.mock.invocationCallOrder[0]).toBeLessThan(
        release.mock.invocationCallOrder[0],
    );
});
