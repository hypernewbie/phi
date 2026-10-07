// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { TabManager } from '../web/terminal.js';

// xterm derives its scrollable position from buffer-level scroll events. A
// bootstrap screen checkpoint resizes the terminal while the buffer is still
// empty, syncing that position to 0; the replay that follows fills the buffer
// without a programmatic scroll, so the derived position stays stale and every
// viewport-path scroll (wheel, PageUp, scrollToBottom) is clamped — the user
// cannot reach history after a reload. _resyncViewportScroll forces the
// position back from the buffer.

function manager() {
    return Object.assign(Object.create(TabManager.prototype), {});
}

function tab({ viewportY = 675, baseY = 675, browsing = false } = {}) {
    const calls = [];
    return {
        calls,
        tab: {
            _historyBrowsing: browsing,
            term: {
                buffer: { active: { viewportY, baseY } },
                scrollToTop: () => calls.push('top'),
                scrollToBottom: () => calls.push('bottom'),
            },
        },
    };
}

describe('_resyncViewportScroll', () => {
    it('re-derives the position when the buffer sits at the bottom', () => {
        const { calls, tab: t } = tab();
        manager()._resyncViewportScroll(t);
        expect(calls).toEqual(['top', 'bottom']);
    });

    it('leaves a viewed historical position alone', () => {
        const { calls, tab: t } = tab({ viewportY: 500, baseY: 675 });
        manager()._resyncViewportScroll(t);
        expect(calls).toEqual([]);
    });

    it('leaves alternate-screen apps and a reset buffer alone', () => {
        const alternate = tab({ viewportY: 0, baseY: 0 });
        manager()._resyncViewportScroll(alternate.tab);
        expect(alternate.calls).toEqual([]);
        const empty = tab({ viewportY: 0, baseY: 0 });
        manager()._resyncViewportScroll(empty.tab);
        expect(empty.calls).toEqual([]);
    });

    it('leaves frozen browsing views alone', () => {
        const { calls, tab: t } = tab({ browsing: true });
        manager()._resyncViewportScroll(t);
        expect(calls).toEqual([]);
    });

    it('is a no-op for a missing or closed terminal', () => {
        const m = manager();
        expect(() => m._resyncViewportScroll(undefined)).not.toThrow();
        expect(() => m._resyncViewportScroll({ term: null })).not.toThrow();
    });

    it('runs as part of the post-fit scroll restore', () => {
        vi.useFakeTimers();
        try {
            const m = manager();
            const spy = vi
                .spyOn(m, '_resyncViewportScroll')
                .mockImplementation(() => {});
            m._spamScroll({ isDead: false }, true);
            expect(spy).toHaveBeenCalledTimes(1);
            vi.clearAllTimers();
        } finally {
            vi.useRealTimers();
        }
    });
});
