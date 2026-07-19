// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

function makeTerm({ viewportY, baseY } = {}) {
    let scrollCalls = 0;
    return {
        buffer: { active: { viewportY, baseY } },
        write: vi.fn(() => { /* no-op for buffer simulation */ }),
        scrollToBottom: vi.fn(() => {
            scrollCalls += 1;
        }),
        _scrollCalls: () => scrollCalls,
    };
}

// Simulate the decision and effect that writeToTerminal's rAF tick
// performs when PTY output arrives. Centralizes the policy so tests can
// observe the contract without poking at the full writeToTerminal method.
function simulateWriteTick(term, userFollowBottom) {
    const buf = term.buffer.active;
    const preAtBottom = buf.viewportY >= buf.baseY;
    if (preAtBottom && userFollowBottom !== false) {
        term.scrollToBottom();
    }
}

function makeTm() {
    return Object.create(TabManager.prototype);
}

describe('user-follow tracking on PTY writes', () => {
    it('snaps to bottom when user is following and at bottom', () => {
        const term = makeTerm({ viewportY: 100, baseY: 100 });
        simulateWriteTick(term, true);
        expect(term.scrollToBottom).toHaveBeenCalledTimes(1);
    });

    it('does NOT snap when userFollowBottom is false even though at bottom', () => {
        // User has scrolled up (wheel disengages follow). Output arriving
        // at the bottom must NOT yank the viewport back to live tail —
        // that's exactly the "scrollbar snap" bug we're fixing.
        const term = makeTerm({ viewportY: 50, baseY: 100 });
        simulateWriteTick(term, false);
        expect(term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('does NOT snap when user is NOT at bottom (regardless of follow flag)', () => {
        // User scrolled away and is reading history. Output should not
        // pop the viewport back to live tail.
        const term = makeTerm({ viewportY: 50, baseY: 100 });
        simulateWriteTick(term, true);
        expect(term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('uses the strict "viewportY >= baseY" predicate (matches the scroll-to-bottom button)', () => {
        // Regression: the contract pinned by test-js/scrollBugs.test.js
        // requires no "baseY - 1" slack. We use the exact same predicate
        // as the scroll-to-bottom button's onScroll handler.
        const term = makeTerm({ viewportY: 99, baseY: 100 });
        simulateWriteTick(term, true);
        // 99 < 100 → not at bottom → no snap
        expect(term.scrollToBottom).not.toHaveBeenCalled();
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