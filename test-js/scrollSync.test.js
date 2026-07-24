// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
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

afterEach(() => vi.unstubAllGlobals());

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
            write: vi.fn((data, cb) => { if (cb) cb(); }),
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
        vi.stubGlobal('requestAnimationFrame', (fn) => { fn(); return 1; });
        const tm = Object.create(TabManager.prototype);
        const tab = makeTab();
        tm.writeToTerminal(tab, 'hello');
        expect(tab.term.write).toHaveBeenCalledTimes(1);
        expect(tab._syncSpy).toHaveBeenCalledWith(true);
    });

    it('still snaps to bottom when following at bottom (existing behavior preserved)', () => {
        vi.stubGlobal('requestAnimationFrame', (fn) => { fn(); return 1; });
        const tm = Object.create(TabManager.prototype);
        const tab = makeTab({ viewportY: 100, baseY: 100, follow: true });
        tm.writeToTerminal(tab, 'hello');
        expect(tab.term.scrollToBottom).toHaveBeenCalled();
    });

    it('does not write or sync on a dead tab', () => {
        vi.stubGlobal('requestAnimationFrame', (fn) => { fn(); return 1; });
        const tm = Object.create(TabManager.prototype);
        const tab = makeTab();
        tab.isDead = true;
        tm.writeToTerminal(tab, 'hello');
        expect(tab.term.write).not.toHaveBeenCalled();
        expect(tab._syncSpy).not.toHaveBeenCalled();
    });

    it('tolerates a term without _core.viewport (optional chain)', () => {
        vi.stubGlobal('requestAnimationFrame', (fn) => { fn(); return 1; });
        const tm = Object.create(TabManager.prototype);
        const tab = makeTab();
        delete tab.term._core;
        expect(() => tm.writeToTerminal(tab, 'hello')).not.toThrow();
    });
});

// Mirrors the viewport-scroll listener policy added in createTab: after the
// rAF settles, update the button and re-engage follow only at the exact
// bottom. (Same simulate-the-policy style as scrollFollow.test.js.)
function simulateViewportScrollTick(tabInfo, updateScrollBtn) {
    updateScrollBtn();
    const b = tabInfo.term && tabInfo.term.buffer && tabInfo.term.buffer.active;
    if (b && b.viewportY >= b.baseY) {
        tabInfo.userFollowBottom = true;
    }
}

describe('DOM scroll listener policy (user scrolls, which never fire term.onScroll)', () => {
    it('re-engages follow at the exact bottom', () => {
        const tab = makeTab({ viewportY: 100, baseY: 100, follow: false });
        const btn = vi.fn();
        simulateViewportScrollTick(tab, btn);
        expect(tab.userFollowBottom).toBe(true);
        expect(btn).toHaveBeenCalledTimes(1);
    });

    it('does NOT re-engage follow above the bottom (strict predicate, no slack)', () => {
        const tab = makeTab({ viewportY: 99, baseY: 100, follow: false });
        simulateViewportScrollTick(tab, vi.fn());
        expect(tab.userFollowBottom).toBe(false);
    });
});

// Mirrors the wheel-down escape hatch added in createTab.
function simulateWheelDown(tabInfo, vp, deltaY) {
    if (deltaY <= 0) return;
    const buf = tabInfo.term && tabInfo.term.buffer && tabInfo.term.buffer.active;
    if (!buf || buf.viewportY >= buf.baseY) return;
    if (!vp) return;
    if (vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 1) {
        const lines = Math.max(1, Math.min(Math.round(deltaY / 40), 8));
        tabInfo.term.scrollLines(lines);
    }
}

describe('wheel-down escape hatch (stale DOM clamp)', () => {
    const clamped = { scrollTop: 968, clientHeight: 32, scrollHeight: 1000 };
    const roomy = { scrollTop: 0, clientHeight: 32, scrollHeight: 1000 };

    it('scrolls the buffer when clamped below the real bottom', () => {
        const tab = makeTab({ viewportY: 50, baseY: 100 });
        simulateWheelDown(tab, clamped, 120);
        expect(tab.term.scrollLines).toHaveBeenCalledWith(3);
    });

    it('does nothing at the real bottom', () => {
        const tab = makeTab({ viewportY: 100, baseY: 100 });
        simulateWheelDown(tab, clamped, 120);
        expect(tab.term.scrollLines).not.toHaveBeenCalled();
    });

    it('does nothing when the DOM still has room to scroll', () => {
        const tab = makeTab({ viewportY: 50, baseY: 100 });
        simulateWheelDown(tab, roomy, 120);
        expect(tab.term.scrollLines).not.toHaveBeenCalled();
    });

    it('does nothing on wheel-up', () => {
        const tab = makeTab({ viewportY: 50, baseY: 100 });
        simulateWheelDown(tab, clamped, -120);
        expect(tab.term.scrollLines).not.toHaveBeenCalled();
    });
});

describe('source contracts', () => {
    it('write path syncs the scroll area, scroll listener + escape hatch exist, no bottom slack', async () => {
        const fs = await import('node:fs');
        const src = fs.readFileSync('web/terminal.js', 'utf8');
        expect(src).toContain('tabInfo.term._core?.viewport?.syncScrollArea(true)');
        expect(src).toContain("termContainer.addEventListener('scroll'");
        expect(src).toContain('vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 1');
        expect(src).not.toContain('baseY - 1');
    });
});
