// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Replay bursts must not scroll the reader through the whole buffer. A burst
// (a resumed pi transcript reprint, a large cat, a journal replay) delivers
// megabytes in well under a second; the pane paints once, when the output
// settles, and lands on the tail. Live output keeps its per-batch follow.

setupDomHarness();

// Trigger threshold: 256 KB of arrivals inside one 400 ms window.
const BURST_BYTES = 256 * 1024;

function makeTab({ viewportY = 100, baseY = 100, follow = true } = {}) {
    const termContainer = document.createElement('div');
    termContainer.className = 'term-container';
    document.body.appendChild(termContainer);
    const term = {
        // Grow the buffer the way a real parse does. xterm keeps the viewport
        // pinned to the tail while it is at the bottom, so the fake has to.
        write: vi.fn((_data, cb) => {
            const atBottom =
                term.buffer.active.viewportY >= term.buffer.active.baseY;
            term.buffer.active.baseY += 1;
            if (atBottom)
                term.buffer.active.viewportY = term.buffer.active.baseY;
            if (cb) cb();
        }),
        scrollToBottom: vi.fn(),
        buffer: { active: { viewportY, baseY } },
    };
    return {
        isDead: false,
        isBusy: true, // skip the busy-transition branch
        pinned: true,
        writeBuffer: '',
        writePending: false,
        userFollowBottom: follow,
        term,
        termContainer,
    };
}

function makeTm() {
    return Object.create(TabManager.prototype);
}

// The pump resumes from a microtask after each parsed batch.
async function drain() {
    for (let i = 0; i < 80; i++) await Promise.resolve();
}

// The reveal waits for a short quiet gap (BURST_PAINT_SKIP_REVEAL_MS).
async function settle() {
    await drain();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await drain();
}

function hidden(tab) {
    return tab.termContainer.classList.contains('burst-paint-skip');
}

describe('burst paint skip', () => {
    it('hides the pane during a burst and lands on the tail once it settles', async () => {
        const tm = makeTm();
        const tab = makeTab();
        tm.writeToTerminal(tab, 'x'.repeat(BURST_BYTES * 2));
        expect(hidden(tab)).toBe(true);
        expect(
            tab.termContainer.querySelector('.replay-progress-text')
                ?.textContent,
        ).toBe('Loading output…');
        // The burst paints nothing while the queue is busy.
        expect(tab.term.scrollToBottom).not.toHaveBeenCalled();
        await settle();
        expect(tab.writeBuffer).toBe('');
        expect(hidden(tab)).toBe(false);
        expect(tab.termContainer.querySelector('.replay-progress')).toBeNull();
        expect(tab.term.scrollToBottom).toHaveBeenCalledTimes(1);
    });

    it('keeps per-batch follow for ordinary live output', async () => {
        const tm = makeTm();
        const tab = makeTab();
        tm.writeToTerminal(tab, 'hello');
        await settle();
        expect(hidden(tab)).toBe(false);
        expect(tab.term.scrollToBottom).toHaveBeenCalledTimes(1);
    });

    it('does not hide the pane for a reader who scrolled up', async () => {
        const tm = makeTm();
        const tab = makeTab({ viewportY: 50, follow: false });
        tm.writeToTerminal(tab, 'x'.repeat(BURST_BYTES * 2));
        await settle();
        expect(hidden(tab)).toBe(false);
        expect(tab.term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('a user gesture reveals a burst mid-flight and does not snap back', async () => {
        const tm = makeTm();
        const tab = makeTab();
        tm.writeToTerminal(tab, 'x'.repeat(BURST_BYTES * 2));
        expect(hidden(tab)).toBe(true);
        tm._cancelScrollFollowForUserScroll(tab);
        expect(hidden(tab)).toBe(false);
        expect(tab.termContainer.querySelector('.replay-progress')).toBeNull();
        await settle();
        expect(tab.term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('skips the next burst once output has been quiet since the gesture', async () => {
        const tm = makeTm();
        const tab = makeTab();
        tm.writeToTerminal(tab, 'x'.repeat(BURST_BYTES * 2));
        tm._cancelScrollFollowForUserScroll(tab);
        expect(hidden(tab)).toBe(false);
        // A reader who scrolled back down (or a tab switch back) must not
        // stay muted for the rest of the session.
        await settle();
        await new Promise((resolve) => setTimeout(resolve, 500)); // quiet > window
        tab.userFollowBottom = true;
        tm.writeToTerminal(tab, 'x'.repeat(BURST_BYTES * 2));
        expect(hidden(tab)).toBe(true);
        await settle();
        expect(hidden(tab)).toBe(false);
    });

    it('reveals a burst that outlives the window instead of blanking forever', async () => {
        const tm = makeTm();
        const tab = makeTab();
        tm.writeToTerminal(tab, 'x'.repeat(BURST_BYTES * 2));
        expect(hidden(tab)).toBe(true);
        // Age the burst past BURST_PAINT_SKIP_MAX_MS.
        tab._burstPaintSkip = performance.now() - 20000;
        tm.writeToTerminal(tab, 'y'); // forces another pump step
        await settle();
        expect(hidden(tab)).toBe(false);
    });

    it('re-engages for a later burst after the pane settled', async () => {
        const tm = makeTm();
        const tab = makeTab();
        tm.writeToTerminal(tab, 'x'.repeat(BURST_BYTES * 2));
        await settle();
        expect(hidden(tab)).toBe(false);
        tm.writeToTerminal(tab, 'x'.repeat(BURST_BYTES * 2));
        expect(hidden(tab)).toBe(true);
        await settle();
        expect(hidden(tab)).toBe(false);
    });

    it('does not flash the pane again after a burst expired mid-stream', async () => {
        const tm = makeTm();
        const tab = makeTab();
        tm.writeToTerminal(tab, 'x'.repeat(BURST_BYTES * 2));
        tab._burstPaintSkip = performance.now() - 20000;
        tm.writeToTerminal(tab, 'y'); // expiry is noticed on the next pump step
        await drain();
        expect(hidden(tab)).toBe(false);
        // The same stream keeps arriving: the cooldown holds until it stops.
        tm.writeToTerminal(tab, 'x'.repeat(BURST_BYTES * 2));
        await drain();
        expect(hidden(tab)).toBe(false);
    });

    it('still reveals when the reader stops following mid-burst', async () => {
        const tm = makeTm();
        const tab = makeTab();
        tm.writeToTerminal(tab, 'x'.repeat(BURST_BYTES * 2));
        expect(hidden(tab)).toBe(true);
        // Follow state can flip without the gesture handler (a programmatic
        // scroll, a re-render). The reveal must not depend on it.
        tab.userFollowBottom = false;
        tab.term.buffer.active.viewportY = 10;
        tm.writeToTerminal(tab, 'y'.repeat(1024));
        await settle();
        expect(hidden(tab)).toBe(false);
        expect(tab.termContainer.querySelector('.replay-progress')).toBeNull();
        expect(tab.term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('shows no second pill while a replay pill is still on screen', async () => {
        const tm = makeTm();
        const tab = makeTab();
        const replayPill = document.createElement('div');
        replayPill.className = 'replay-progress';
        replayPill.innerHTML =
            '<span class="replay-progress-text">Replaying history</span>';
        tab.termContainer.appendChild(replayPill);
        tab._replayProgressEl = replayPill;
        tm.writeToTerminal(tab, 'x'.repeat(BURST_BYTES * 2));
        expect(hidden(tab)).toBe(true);
        expect(
            tab.termContainer.querySelectorAll('.replay-progress'),
        ).toHaveLength(1);
        await settle();
        // The replay pill belongs to the replay path and stays.
        expect(replayPill.isConnected).toBe(true);
    });
});
