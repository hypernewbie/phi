// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness, stubWebSocket } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Scroll-area desync fixes (2026-07-24):
// (1) writeToTerminal must force xterm's DOM scroll area back in sync after
//     each write batch (the vendored xterm leaves it stale during streaming,
//     which made wheel-up jump to a stale coordinate and wheel-down clamp
//     before the real bottom).
// (2) User wheel/scrollbar scrolls never fire xterm's public onScroll
//     (suppressScrollEvent=true in Viewport._handleScroll), so a DOM scroll
//     listener must drive the scroll-to-bottom button and follow
//     re-engagement.
// (3) Wheel-down against a stale, clamped DOM viewport must still reach the
//     true bottom via term.scrollLines.

// setupDomHarness()'s afterEach also clears localStorage (createTab's
// saveTabsState() writes phi_active_pane/phi_tab_order on every mount) and
// calls vi.restoreAllMocks() — inert here since nothing in this file uses
// vi.spyOn; restoreAllMocks only undoes spies, not plain vi.fn() mocks
// (verified against @vitest/spy: mockRestore == mockReset + an optional
// spyOn-only restore callback), and every mock here is fresh per test.
setupDomHarness();

function makeTab({ viewportY = 100, baseY = 100, follow = true } = {}) {
    const syncSpy = vi.fn();
    return {
        isDead: false,
        isBusy: true, // skip the busy-transition branch (pin/title side effects)
        pinned: true,
        writeBuffer: '',
        writePending: false,
        userFollowBottom: follow,
        term: {
            // baseY advances on write, like a real terminal growing its
            // buffer. This is what makes preAtBottom's capture point (before
            // the rAF/write, per terminal.js:932-933) observable: capturing
            // it late (after write) would see the new, taller baseY and
            // wrongly conclude the user isn't at bottom.
            write: vi.fn(function (data, cb) {
                this.buffer.active.baseY += 1;
                if (cb) cb();
            }),
            scrollToBottom: vi.fn(),
            scrollLines: vi.fn(),
            buffer: { active: { viewportY, baseY } },
            _core: { viewport: { syncScrollArea: syncSpy } },
        },
        _syncSpy: syncSpy,
    };
}

describe('write batches sync the DOM scroll area', () => {
    it('calls _core.viewport.syncScrollArea(true) via the write callback', () => {
        vi.stubGlobal('requestAnimationFrame', (fn) => {
            fn();
            return 1;
        });
        const tm = Object.create(TabManager.prototype);
        const tab = makeTab();
        tm.writeToTerminal(tab, 'hello');
        expect(tab.term.write).toHaveBeenCalledTimes(1);
        expect(tab._syncSpy).toHaveBeenCalledWith(true);
    });

    it('still snaps to bottom when following at bottom (existing behavior preserved)', () => {
        vi.stubGlobal('requestAnimationFrame', (fn) => {
            fn();
            return 1;
        });
        const tm = Object.create(TabManager.prototype);
        const tab = makeTab({ viewportY: 100, baseY: 100, follow: true });
        tm.writeToTerminal(tab, 'hello');
        expect(tab.term.scrollToBottom).toHaveBeenCalled();
    });

    it('does not write or sync on a dead tab', () => {
        vi.stubGlobal('requestAnimationFrame', (fn) => {
            fn();
            return 1;
        });
        const tm = Object.create(TabManager.prototype);
        const tab = makeTab();
        tab.isDead = true;
        tm.writeToTerminal(tab, 'hello');
        expect(tab.term.write).not.toHaveBeenCalled();
        expect(tab._syncSpy).not.toHaveBeenCalled();
    });

    it('tolerates a term without _core.viewport (optional chain)', () => {
        vi.stubGlobal('requestAnimationFrame', (fn) => {
            fn();
            return 1;
        });
        const tm = Object.create(TabManager.prototype);
        const tab = makeTab();
        delete tab.term._core;
        expect(() => tm.writeToTerminal(tab, 'hello')).not.toThrow();
    });
});

// The viewport-scroll listener and the wheel-down escape hatch (both added
// in createTab) are anonymous closures registered as a side effect of
// createTab, not named TabManager methods — there's no prototype method to
// call directly the way scrollFollow.test.js calls
// _cancelScrollFollowForUserScroll. Reaching them means actually running
// createTab() and dispatching the real DOM events it listens for.
//
// createTab() goes on to call this.switchTab(paneId), which pulls in
// sessionsManager / diffController / markdownManager — a large, separately
// tested surface (scrollBugs.test.js) that has nothing to do with
// scrolling. switchTab() is the LAST thing createTab does before
// saveTabsState(), i.e. strictly after both listeners under test are
// already wired to the real termContainer — so stubbing it as a no-op
// isolates the two closures under test without faking their behavior.
function stubXtermGlobals() {
    vi.stubGlobal('FitAddon', {
        FitAddon: class {
            fit() {}
        },
    });
    vi.stubGlobal('SearchAddon', { SearchAddon: class {} });
    vi.stubGlobal('Terminal', function () {
        // Mirrors real xterm.js DOM shape: term.element with a
        // .xterm-viewport child, which is what both listeners query.
        const viewportEl = document.createElement('div');
        viewportEl.className = 'xterm-viewport';
        const rootEl = document.createElement('div');
        rootEl.appendChild(viewportEl);
        return {
            element: rootEl,
            buffer: { active: { viewportY: 100, baseY: 100 } },
            // Real xterm.js renders term.element into the container passed
            // to open() — without this, .xterm-viewport is never actually a
            // descendant of termContainer, and the capture-phase listener
            // createTab installs on termContainer would silently never fire.
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
            write: vi.fn((data, cb) => {
                if (cb) cb();
            }),
            scrollToBottom: vi.fn(),
            scrollLines: vi.fn(),
            _core: { viewport: { syncScrollArea: vi.fn() } },
        };
    });
}

// Runs the real createTab() and returns the resulting tabInfo. Its
// termContainer and the fake term's .xterm-viewport child are wired up
// exactly as production does, so dispatching real 'scroll'/'wheel' DOM
// events exercises the actual listeners createTab installs. Every call
// gets its own TabManager with a fresh `tabs` Map, so a fixed paneId
// never collides across tests — no caller needs to pick one.
function mountRealTab({ coder = 'bash' } = {}) {
    vi.stubGlobal('requestAnimationFrame', (fn) => {
        fn();
        return 1;
    });
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
    // pinned:false skips the fire-and-forget backend pin fetch(), which
    // has nothing to do with the listeners under test and would otherwise
    // reject noisily against jsdom's relative-URL fetch.
    tm.createTab('p1', 'sess-p1', 'Title', coder, '', '', false);
    return tm.tabs.get('p1');
}

describe('DOM scroll listener installed by createTab (drives the real handler)', () => {
    it('re-engages follow at the exact bottom, and hides the scroll-to-bottom button', () => {
        const tabInfo = mountRealTab();
        tabInfo.userFollowBottom = false;
        Object.assign(tabInfo.term.buffer.active, {
            viewportY: 100,
            baseY: 100,
        });
        tabInfo.term.element
            .querySelector('.xterm-viewport')
            .dispatchEvent(new Event('scroll', { bubbles: false }));
        expect(tabInfo.userFollowBottom).toBe(true);
        expect(tabInfo.scrollToBottomBtn.classList.contains('hidden')).toBe(
            true,
        );
    });

    it('does NOT re-engage follow above the bottom (strict predicate, no slack), and shows the button', () => {
        const tabInfo = mountRealTab();
        tabInfo.userFollowBottom = false;
        Object.assign(tabInfo.term.buffer.active, {
            viewportY: 99,
            baseY: 100,
        });
        tabInfo.term.element
            .querySelector('.xterm-viewport')
            .dispatchEvent(new Event('scroll', { bubbles: false }));
        expect(tabInfo.userFollowBottom).toBe(false);
        expect(tabInfo.scrollToBottomBtn.classList.contains('hidden')).toBe(
            false,
        );
    });

    it('defers the re-engage decision to the next animation frame, coalescing repeat scrolls into one frame', () => {
        const tabInfo = mountRealTab();
        // Override mountRealTab's synchronous rAF stub: the write-path
        // block above needs the synchronous form, so this is a local,
        // post-mount override rather than a change to mountRealTab.
        const frames = [];
        vi.stubGlobal('requestAnimationFrame', (fn) => {
            frames.push(fn);
            return frames.length;
        });
        tabInfo.userFollowBottom = false;
        Object.assign(tabInfo.term.buffer.active, {
            viewportY: 100,
            baseY: 100,
        });
        const vp = tabInfo.term.element.querySelector('.xterm-viewport');
        vp.dispatchEvent(new Event('scroll', { bubbles: false }));
        vp.dispatchEvent(new Event('scroll', { bubbles: false }));
        // Coalescing guard (viewportScrollRafPending): two scroll events
        // before the frame runs queue exactly one frame, not two.
        expect(frames.length).toBe(1);
        // Deferred: the decision hasn't run yet, so follow is still off.
        expect(tabInfo.userFollowBottom).toBe(false);
        frames.forEach((f) => {
            f();
        });
        expect(tabInfo.userFollowBottom).toBe(true);
    });
});

// clientHeight/scrollHeight are getter-only in jsdom (no layout engine), so
// they need defineProperty; scrollTop is a plain writable property.
function setViewportScrollMetrics(
    tabInfo,
    { scrollTop, clientHeight, scrollHeight },
) {
    const vp = tabInfo.term.element.querySelector('.xterm-viewport');
    vp.scrollTop = scrollTop;
    Object.defineProperty(vp, 'clientHeight', {
        value: clientHeight,
        configurable: true,
    });
    Object.defineProperty(vp, 'scrollHeight', {
        value: scrollHeight,
        configurable: true,
    });
    return vp;
}

describe('wheel-down escape hatch installed by createTab (drives the real handler)', () => {
    it('scrolls the buffer exactly once when clamped below the real bottom', () => {
        const tabInfo = mountRealTab();
        Object.assign(tabInfo.term.buffer.active, {
            viewportY: 50,
            baseY: 100,
        });
        setViewportScrollMetrics(tabInfo, {
            scrollTop: 968,
            clientHeight: 32,
            scrollHeight: 1000,
        });
        tabInfo.termContainer.dispatchEvent(
            new WheelEvent('wheel', { deltaY: 120, bubbles: true }),
        );
        expect(tabInfo.term.scrollLines).toHaveBeenCalledWith(3);
        expect(tabInfo.term.scrollLines).toHaveBeenCalledTimes(1);
    });

    it('does nothing at the real bottom', () => {
        const tabInfo = mountRealTab();
        Object.assign(tabInfo.term.buffer.active, {
            viewportY: 100,
            baseY: 100,
        });
        setViewportScrollMetrics(tabInfo, {
            scrollTop: 968,
            clientHeight: 32,
            scrollHeight: 1000,
        });
        tabInfo.termContainer.dispatchEvent(
            new WheelEvent('wheel', { deltaY: 120, bubbles: true }),
        );
        expect(tabInfo.term.scrollLines).not.toHaveBeenCalled();
    });

    it('does nothing when the DOM still has room to scroll', () => {
        const tabInfo = mountRealTab();
        Object.assign(tabInfo.term.buffer.active, {
            viewportY: 50,
            baseY: 100,
        });
        setViewportScrollMetrics(tabInfo, {
            scrollTop: 0,
            clientHeight: 32,
            scrollHeight: 1000,
        });
        tabInfo.termContainer.dispatchEvent(
            new WheelEvent('wheel', { deltaY: 120, bubbles: true }),
        );
        expect(tabInfo.term.scrollLines).not.toHaveBeenCalled();
    });

    it('does nothing on wheel-up', () => {
        const tabInfo = mountRealTab();
        Object.assign(tabInfo.term.buffer.active, {
            viewportY: 50,
            baseY: 100,
        });
        setViewportScrollMetrics(tabInfo, {
            scrollTop: 968,
            clientHeight: 32,
            scrollHeight: 1000,
        });
        tabInfo.termContainer.dispatchEvent(
            new WheelEvent('wheel', { deltaY: -120, bubbles: true }),
        );
        expect(tabInfo.term.scrollLines).not.toHaveBeenCalled();
    });

    // Bubble-phase registration (web/terminal.js:1503) is load-bearing, not
    // cosmetic: the comment at :1490-1491 documents that it's what lets the
    // opencode capture-phase handler's stopPropagation exclude opencode
    // tabs from this path. A mirror-style test can't see event phase at
    // all, so this regression (escape hatch silently firing for opencode
    // tabs too) was uncatchable before driving the real listeners.
    it('is excluded for opencode tabs by the capture-phase handler stopping propagation first', () => {
        const tabInfo = mountRealTab({ coder: 'opencode' });
        Object.assign(tabInfo.term.buffer.active, {
            viewportY: 50,
            baseY: 100,
        });
        setViewportScrollMetrics(tabInfo, {
            scrollTop: 968,
            clientHeight: 32,
            scrollHeight: 1000,
        });
        tabInfo.termContainer.dispatchEvent(
            new WheelEvent('wheel', {
                deltaY: 120,
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(tabInfo.term.scrollLines).not.toHaveBeenCalled();
    });
});

describe('source contracts', () => {
    it('write path syncs the scroll area, scroll listener + escape hatch exist, no bottom slack', async () => {
        const fs = await import('node:fs');
        const src = fs.readFileSync('web/terminal.js', 'utf8');
        expect(src).toContain(
            'tabInfo.term._core?.viewport?.syncScrollArea(true)',
        );
        expect(src).toMatch(/termContainer\.addEventListener\(\s*'scroll'/);
        expect(src).toContain(
            'vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 1',
        );
        expect(src).not.toContain('baseY - 1');
    });
});
