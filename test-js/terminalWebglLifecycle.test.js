// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { TabManager } from '../web/terminal.js';

// Invariant: a terminal owns a GL context only while it is the visible tab.
// Every live xterm WebglAddon holds a full-window framebuffer (~11 MB of
// pixels at 1x, 4x that on retina) plus Chromium's GPU-side copies, so a
// context that survives a tab switch is the memory regression this guards.

function installAddon() {
    const created = [];
    class FakeWebglAddon {
        constructor() {
            this.disposed = false;
            created.push(this);
        }
        dispose() {
            this.disposed = true;
        }
    }
    window.WebglAddon = { WebglAddon: FakeWebglAddon };
    return created;
}

function context() {
    const c = Object.create(TabManager.prototype);
    c.tabs = new Map();
    c.app = { config: {} };
    c._queuePanelFit = vi.fn();
    c._spamScrollToBottom = vi.fn();
    c.maybeAutoReconnect = vi.fn();
    c.reconnectTab = vi.fn();
    return c;
}

function liveTab(paneId) {
    const loaded = [];
    const tab = {
        paneId,
        coder: 'bash',
        isDead: false,
        term: { loadAddon: (addon) => loaded.push(addon) },
        loaded,
    };
    return tab;
}

const viewportOpts = { scrollToBottom: false, autoReconnect: false };

describe('terminal WebGL lifecycle', () => {
    it('attaches one GL context to the visible tab and never a second', () => {
        const created = installAddon();
        const c = context();
        const tab = liveTab('p1');
        c.tabs.set('p1', tab);

        TabManager.prototype.activateTabViewport.call(c, tab, viewportOpts);
        TabManager.prototype.activateTabViewport.call(c, tab, viewportOpts);

        expect(created).toHaveLength(1);
        expect(tab.loaded).toHaveLength(1);
        expect(tab.term._phiWebgl).toBe(created[0]);
    });

    it('releases the GL context on detach and re-attaches a fresh one on return', () => {
        const created = installAddon();
        const c = context();
        const tab = liveTab('p1');
        c.tabs.set('p1', tab);

        TabManager.prototype.activateTabViewport.call(c, tab, viewportOpts);
        TabManager.prototype._detachTermWebgl.call(c, tab);

        expect(created[0].disposed).toBe(true);
        expect(tab.term._phiWebgl).toBeNull();

        // Detaching twice must not touch an unrelated addon.
        TabManager.prototype._detachTermWebgl.call(c, tab);

        TabManager.prototype.activateTabViewport.call(c, tab, viewportOpts);

        expect(created).toHaveLength(2);
        expect(created[1].disposed).toBe(false);
        expect(tab.term._phiWebgl).toBe(created[1]);
    });

    it('stops attempting WebGL after the first construction failure', () => {
        let attempts = 0;
        window.WebglAddon = {
            WebglAddon: class {
                constructor() {
                    attempts += 1;
                    throw new Error('no usable GL context');
                }
            },
        };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const c = context();
        const tab = liveTab('p1');
        c.tabs.set('p1', tab);

        TabManager.prototype.activateTabViewport.call(c, tab, viewportOpts);
        TabManager.prototype.activateTabViewport.call(c, tab, viewportOpts);

        expect(attempts).toBe(1);
        expect(tab.loaded).toHaveLength(0);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });
});
