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
    it('scrolls UP into history when swiping down on a standard terminal (bash)', () => {
        const tab = mountTab({ coder: 'bash' });

        // Touch start at Y=200
        dispatchTouch(tab.termContainer, 'touchstart', [{ clientY: 200 }]);

        // Swipe down to Y=248 (+48px = 3 lines at 16px/line)
        const moveEv = dispatchTouch(tab.termContainer, 'touchmove', [
            { clientY: 248 },
        ]);

        // Must scroll up into history (negative lines) and prevent default
        expect(tab.term.scrollLines).toHaveBeenCalledTimes(1);
        expect(tab.term.scrollLines).toHaveBeenCalledWith(-3);
        expect(moveEv.defaultPrevented).toBe(true);
    });

    it('scrolls DOWN towards bottom when swiping up on a standard terminal (claude)', () => {
        const tab = mountTab({ coder: 'claude' });

        // Touch start at Y=200
        dispatchTouch(tab.termContainer, 'touchstart', [{ clientY: 200 }]);

        // Swipe up to Y=152 (-48px = -3 lines at 16px/line)
        const moveEv = dispatchTouch(tab.termContainer, 'touchmove', [
            { clientY: 152 },
        ]);

        // Must scroll down towards bottom (positive lines) and prevent default
        expect(tab.term.scrollLines).toHaveBeenCalledTimes(1);
        expect(tab.term.scrollLines).toHaveBeenCalledWith(3);
        expect(moveEv.defaultPrevented).toBe(true);
    });

    it('accumulates sub-line swipe deltas across touchmove events', () => {
        const tab = mountTab({ coder: 'bash' });

        dispatchTouch(tab.termContainer, 'touchstart', [{ clientY: 200 }]);

        // First move: +10px (less than 16px cellHeight) -> no scroll yet
        dispatchTouch(tab.termContainer, 'touchmove', [{ clientY: 210 }]);
        expect(tab.term.scrollLines).not.toHaveBeenCalled();

        // Second move: another +10px (total +20px >= 16px) -> 1 line scrolled
        dispatchTouch(tab.termContainer, 'touchmove', [{ clientY: 220 }]);
        expect(tab.term.scrollLines).toHaveBeenCalledTimes(1);
        expect(tab.term.scrollLines).toHaveBeenCalledWith(-1);
    });

    it('preserves OpenCode TUI alternate escape sequence dispatch', () => {
        const tab = mountTab({ coder: 'opencode' });
        tab.ws.sendInput = vi.fn();

        dispatchTouch(tab.termContainer, 'touchstart', [{ clientY: 200 }]);

        // Swipe down (+32px = 2 lines) -> sends Ctrl+Y (\x1b\x19)
        dispatchTouch(tab.termContainer, 'touchmove', [{ clientY: 232 }]);
        expect(tab.ws.sendInput).toHaveBeenCalledWith('\x1b\x19\x1b\x19');
        expect(tab.term.scrollLines).not.toHaveBeenCalled();
    });

    it('ignores multi-touch gestures (e.g. pinch to zoom) without preventing default', () => {
        const tab = mountTab({ coder: 'bash' });

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

        expect(tab.term.scrollLines).not.toHaveBeenCalled();
        expect(moveEv.defaultPrevented).toBe(false);
    });
});
