// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness, stubWebSocket } from './_dom.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

function stubXtermGlobals() {
    vi.stubGlobal('FitAddon', {
        FitAddon: class {
            fit() {}
        },
    });
    vi.stubGlobal('SearchAddon', { SearchAddon: class {} });
    vi.stubGlobal('Unicode11Addon', {
        Unicode11Addon: class {
            activate() {}
        },
    });
    vi.stubGlobal('Terminal', function () {
        const viewportEl = document.createElement('div');
        viewportEl.className = 'xterm-viewport';
        const rootEl = document.createElement('div');
        rootEl.appendChild(viewportEl);
        return {
            element: rootEl,
            buffer: { active: { viewportY: 50, baseY: 100 } },
            open: (container) => {
                if (container) container.appendChild(rootEl);
            },
            loadAddon: () => {},
            attachCustomKeyEventHandler: () => {},
            onSelectionChange: () => {},
            onBell: () => {},
            onScroll: () => {},
            onData: () => {},
            getSelection: () => '',
            write: vi.fn((_data, cb) => {
                if (cb) cb();
            }),
            scrollToBottom: vi.fn(),
            scrollLines: vi.fn(),
            _core: { viewport: { syncScrollArea: vi.fn() } },
        };
    });
}

function mountTab({ coder = 'bash' } = {}) {
    stubWebSocket();
    stubXtermGlobals();
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;
    tm.tabsContainer = document.createElement('div');
    tm.terminalsWrapper = document.createElement('div');
    document.body.appendChild(tm.tabsContainer);
    document.body.appendChild(tm.terminalsWrapper);
    tm.app = {};
    tm.switchTab = vi.fn();
    tm.createTab('p1', 'sess-p1', 'Title', coder, '', '', false);
    const tab = tm.tabs.get('p1');
    tm._openTermAndViewport(tab);
    return tab;
}

function dispatchTouch(target, type, touches) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    event.touches = touches;
    target.dispatchEvent(event);
    return event;
}

describe('touchscreen terminal scrollback', () => {
    it('does not hijack touch on standard terminals (delegating to xterm native gesture engine)', () => {
        const tab = mountTab({ coder: 'bash' });

        // Touch start at Y=200
        dispatchTouch(tab.termContainer, 'touchstart', [{ clientY: 200 }]);

        // Swipe down to Y=248 (+48px)
        const moveEv = dispatchTouch(tab.termContainer, 'touchmove', [
            { clientY: 248 },
        ]);

        // Standard terminals must NOT be intercepted with artificial scrollLines
        // or preventDefault on container; xterm's native Gesture engine handles 1:1 touch.
        expect(tab.term.scrollLines).not.toHaveBeenCalled();
        expect(moveEv.defaultPrevented).toBe(false);
    });

    it('does not hijack touch on agy and pi terminals', () => {
        for (const coder of ['agy', 'pi', 'claude']) {
            const tab = mountTab({ coder });
            dispatchTouch(tab.termContainer, 'touchstart', [{ clientY: 200 }]);
            const moveEv = dispatchTouch(tab.termContainer, 'touchmove', [
                { clientY: 150 },
            ]);
            expect(tab.term.scrollLines).not.toHaveBeenCalled();
            expect(moveEv.defaultPrevented).toBe(false);
        }
    });

    it('preserves OpenCode TUI alternate escape sequence dispatch on swipe down', () => {
        const tab = mountTab({ coder: 'opencode' });
        tab.ws.sendInput = vi.fn();

        dispatchTouch(tab.termContainer, 'touchstart', [{ clientY: 200 }]);

        // Swipe down (+32px = 2 lines) -> sends Ctrl+Y (\x1b\x19)
        const moveEv = dispatchTouch(tab.termContainer, 'touchmove', [
            { clientY: 232 },
        ]);
        expect(tab.ws.sendInput).toHaveBeenCalledWith('\x1b\x19\x1b\x19');
        expect(tab.term.scrollLines).not.toHaveBeenCalled();
        expect(moveEv.defaultPrevented).toBe(true);
    });

    it('preserves OpenCode TUI alternate escape sequence dispatch on swipe up', () => {
        const tab = mountTab({ coder: 'opencode' });
        tab.ws.sendInput = vi.fn();

        dispatchTouch(tab.termContainer, 'touchstart', [{ clientY: 200 }]);

        // Swipe up (-48px = 3 lines) -> sends Ctrl+E (\x1b\x05)
        const moveEv = dispatchTouch(tab.termContainer, 'touchmove', [
            { clientY: 152 },
        ]);
        expect(tab.ws.sendInput).toHaveBeenCalledWith(
            '\x1b\x05\x1b\x05\x1b\x05',
        );
        expect(tab.term.scrollLines).not.toHaveBeenCalled();
        expect(moveEv.defaultPrevented).toBe(true);
    });

    it('accumulates sub-line swipe deltas across touchmove events for opencode', () => {
        const tab = mountTab({ coder: 'opencode' });
        tab.ws.sendInput = vi.fn();

        dispatchTouch(tab.termContainer, 'touchstart', [{ clientY: 200 }]);

        // First move: +10px (less than 16px cellHeight) -> no sendInput yet
        dispatchTouch(tab.termContainer, 'touchmove', [{ clientY: 210 }]);
        expect(tab.ws.sendInput).not.toHaveBeenCalled();

        // Second move: another +10px (total +20px >= 16px) -> 1 line scrolled
        dispatchTouch(tab.termContainer, 'touchmove', [{ clientY: 220 }]);
        expect(tab.ws.sendInput).toHaveBeenCalledWith('\x1b\x19');
    });

    it('ignores multi-touch gestures (e.g. pinch to zoom) without preventing default', () => {
        const tab = mountTab({ coder: 'opencode' });
        tab.ws.sendInput = vi.fn();

        // Two-finger touchstart
        dispatchTouch(tab.termContainer, 'touchstart', [
            { clientY: 200 },
            { clientY: 250 },
        ]);

        // Two-finger touchmove
        const moveEv = dispatchTouch(tab.termContainer, 'touchmove', [
            { clientY: 150 },
            { clientY: 300 },
        ]);

        expect(tab.ws.sendInput).not.toHaveBeenCalled();
        expect(moveEv.defaultPrevented).toBe(false);
    });
});

describe('vendored xterm native touch capabilities', () => {
    it('xterm bundle contains native 1:1 touch scroll methods (PR #5563)', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const xtermSrc = readFileSync(
            join(process.cwd(), 'web', 'vendor', 'xterm.js'),
            'utf8',
        );
        expect(xtermSrc).toContain('handleTouchScroll');
        expect(xtermSrc).toContain('handleTouchScrollAsWheel');
        expect(xtermSrc).toContain('handleTouchScrollAsKeys');
    });
});
