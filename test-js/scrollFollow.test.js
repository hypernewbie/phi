// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// User-follow tracking for terminal scroll. The scroll bug being fixed:
// when PTY output arrives, xterm's native syncScrollArea leaves the
// native scrollbar stale until some layout reflow re-syncs it (the
// user reported: "typing in input bar fixes it" — that's adjustInputHeight
// forcing a reflow). The fix tracks whether the user wants to follow the
// bottom and explicitly calls term.scrollToBottom() on writes when they
// do, keeping the scrollbar in sync without a layout reflow.

setupDomHarness();

// Drives the real write-tick path in TabManager.writeToTerminal (the rAF
// callback around web/terminal.js:934-959), not a reimplementation of its
// policy. requestAnimationFrame is stubbed to run synchronously so the
// snap/no-snap decision can be observed within the test body.
function makeTab({ viewportY, baseY, follow = true } = {}) {
    const tab = {
        isDead: false,
        isBusy: true, // skip the busy-transition branch (pin/title side effects need `this.*`)
        pinned: true,
        writeBuffer: '',
        writePending: false,
        userFollowBottom: follow,
        term: {
            // Mutate the buffer the way the real xterm write does: baseY
            // grows past viewportY once the chunk lands. This is what
            // makes preAtBottom's pre-write capture (terminal.js:933)
            // load-bearing — computing it after write() would see the
            // post-write buffer and never snap.
            write: vi.fn((data, cb) => {
                tab.term.buffer.active.baseY += 1;
                if (cb) cb();
            }),
            scrollToBottom: vi.fn(),
            buffer: { active: { viewportY, baseY } },
        },
    };
    return tab;
}

function makeTm() {
    return Object.create(TabManager.prototype);
}

describe('user-follow tracking on PTY writes', () => {
    it('snaps to bottom when user is following and at bottom', () => {
        vi.stubGlobal('requestAnimationFrame', (fn) => {
            fn();
            return 1;
        });
        const tm = makeTm();
        const tab = makeTab({ viewportY: 100, baseY: 100, follow: true });
        tm.writeToTerminal(tab, 'hello');
        expect(tab.term.scrollToBottom).toHaveBeenCalledTimes(1);
    });

    it('does NOT snap when userFollowBottom is false even though at bottom', () => {
        // User has scrolled up (wheel disengages follow). Output arriving
        // at the bottom must NOT yank the viewport back to live tail —
        // that's exactly the "scrollbar snap" bug we're fixing.
        vi.stubGlobal('requestAnimationFrame', (fn) => {
            fn();
            return 1;
        });
        const tm = makeTm();
        const tab = makeTab({ viewportY: 100, baseY: 100, follow: false });
        tm.writeToTerminal(tab, 'hello');
        expect(tab.term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('does NOT snap when user is NOT at bottom (regardless of follow flag)', () => {
        // User scrolled away and is reading history. Output should not
        // pop the viewport back to live tail.
        vi.stubGlobal('requestAnimationFrame', (fn) => {
            fn();
            return 1;
        });
        const tm = makeTm();
        const tab = makeTab({ viewportY: 50, baseY: 100, follow: true });
        tm.writeToTerminal(tab, 'hello');
        expect(tab.term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('uses the strict "viewportY >= baseY" predicate (matches the scroll-to-bottom button)', () => {
        // Regression: the contract pinned by test-js/scrollBugs.test.js
        // requires no "baseY - 1" slack. We use the exact same predicate
        // as the scroll-to-bottom button's onScroll handler.
        vi.stubGlobal('requestAnimationFrame', (fn) => {
            fn();
            return 1;
        });
        const tm = makeTm();
        const tab = makeTab({ viewportY: 99, baseY: 100, follow: true });
        tm.writeToTerminal(tab, 'hello');
        // 99 < 100 → not at bottom → no snap
        expect(tab.term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('_cancelScrollFollowForUserScroll flips userFollowBottom to false and clears spam state', () => {
        const tm = makeTm();
        const tabInfo = {
            spamInterval: setInterval(() => {}, 999999),
            stopSpamTimeout: setTimeout(() => {}, 999999),
            isSpammingBottom: true,
            spamScrollY: 50,
            userFollowBottom: true,
        };
        tm._cancelScrollFollowForUserScroll(tabInfo);
        clearInterval(tabInfo.spamInterval);
        clearTimeout(tabInfo.stopSpamTimeout);
        expect(tabInfo.userFollowBottom).toBe(false);
        expect(tabInfo.spamInterval).toBeNull();
        expect(tabInfo.spamScrollY).toBeUndefined();
        expect(tabInfo.isSpammingBottom).toBeUndefined();
    });
});
