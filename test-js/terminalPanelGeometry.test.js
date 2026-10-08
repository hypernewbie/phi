// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();
afterEach(() => vi.unstubAllGlobals());

function geometryHarness() {
    const frames = new Map();
    let next = 0;
    vi.stubGlobal('requestAnimationFrame', (callback) => {
        frames.set(++next, callback);
        return next;
    });
    vi.stubGlobal('cancelAnimationFrame', (id) => frames.delete(id));
    let observer;
    vi.stubGlobal(
        'ResizeObserver',
        class {
            constructor(callback) {
                this.callback = callback;
                this.observe = vi.fn();
                this.disconnect = vi.fn();
                observer = this;
            }
        },
    );
    const desired = { cols: 80, rows: 24 };
    const tab = {
        termContainer: document.createElement('div'),
        term: {
            cols: 80,
            rows: 24,
            options: { fontSize: 14 },
            buffer: { active: { viewportY: 0, baseY: 0, length: 24 } },
        },
        ws: { sendResize: vi.fn(() => true) },
        fitAddon: {
            proposeDimensions: () => ({ ...desired }),
            fit: vi.fn(() => {
                Object.assign(tab.term, desired);
            }),
        },
    };
    tab._sizedWs = tab.ws;
    let active = tab;
    const m = Object.assign(Object.create(TabManager.prototype), {
        getActiveTab: () => active,
        resolveTerminalFontSize: () => 14,
        _spamScroll: vi.fn(),
    });
    m._observeTerminalPanel(tab);
    return {
        m,
        tab,
        desired,
        get observer() {
            return observer;
        },
        frames,
        inactive() {
            active = {};
        },
        flush() {
            const pending = [...frames.values()];
            frames.clear();
            for (const callback of pending) callback();
        },
    };
}

it('actual panel dimensions reach the backend without a window resize', () => {
    const h = geometryHarness();
    h.desired.cols = 61;
    h.desired.rows = 17;
    h.observer.callback([]);
    h.flush();
    expect(h.tab.fitAddon.fit).toHaveBeenCalledOnce();
    expect(h.tab.ws.sendResize).toHaveBeenCalledExactlyOnceWith(61, 17);
    expect(h.observer.observe).toHaveBeenCalledExactlyOnceWith(
        h.tab.termContainer,
    );
});

it('panel drags coalesce to the latest dimensions without a periodic timer', () => {
    const h = geometryHarness();
    for (const cols of [70, 62, 55, 49]) {
        h.desired.cols = cols;
        h.observer.callback([]);
    }
    expect(h.frames.size).toBe(1);
    h.flush();
    expect(h.tab.ws.sendResize).toHaveBeenCalledExactlyOnceWith(49, 24);
    h.observer.callback([]);
    h.flush();
    expect(h.tab.ws.sendResize).toHaveBeenCalledOnce();
    expect(h.frames.size).toBe(0);
});

it('activation/refresh forces a backend resize even after a same-grid fit was skipped', () => {
    const h = geometryHarness();
    h.m.fitActiveTerminal();
    expect(h.tab.ws.sendResize).not.toHaveBeenCalled();
    h.m.fitActiveTerminal({ forceResize: true });
    expect(h.tab.fitAddon.fit).not.toHaveBeenCalled();
    expect(h.tab.ws.sendResize).toHaveBeenCalledExactlyOnceWith(80, 24);
});

it('unsent forced sizing stays retryable', () => {
    const h = geometryHarness();
    h.tab._sizedWs = null;
    h.tab.ws.sendResize.mockReturnValueOnce(false);
    h.m.fitActiveTerminal({ forceResize: true });
    expect(h.tab._sizedWs).toBeNull();
    h.m.fitActiveTerminal({ forceResize: true });
    expect(h.tab._sizedWs).toBe(h.tab.ws);
});

it('panel sizing waits for replay and ignores inactive or finalized tabs', () => {
    const h = geometryHarness();
    h.desired.cols = 60;
    h.tab._bootstrapGate = Promise.resolve();
    h.observer.callback([]);
    h.flush();
    expect(h.tab.ws.sendResize).not.toHaveBeenCalled();
    expect(h.tab._pendingPanelFit).toBe(true);
    h.tab._bootstrapGate = null;
    h.m._queuePanelFit(h.tab);
    h.flush();
    expect(h.tab.ws.sendResize).toHaveBeenCalledExactlyOnceWith(60, 24);
    h.inactive();
    h.desired.cols = 50;
    h.observer.callback([]);
    h.flush();
    expect(h.tab.ws.sendResize).toHaveBeenCalledOnce();
    h.tab.finalizing = true;
    h.observer.callback([]);
    h.flush();
    expect(h.tab.ws.sendResize).toHaveBeenCalledOnce();
});

it('viewport changes alone stay quiet, but actual panel rows still synchronize on mobile', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const h = geometryHarness();
    vi.stubGlobal('innerHeight', window.innerHeight - 100);
    h.observer.callback([]);
    h.flush();
    expect(h.tab.ws.sendResize).not.toHaveBeenCalled();
    h.desired.rows = 18;
    h.observer.callback([]);
    h.flush();
    expect(h.tab.ws.sendResize).toHaveBeenCalledExactlyOnceWith(80, 18);
});
