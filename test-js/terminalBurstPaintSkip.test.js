// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

const BURST_BYTES = 256 * 1024;
const burst = 'x'.repeat(BURST_BYTES * 2);

function makeTab({
    viewportY = 100,
    baseY = 100,
    follow = true,
    type = 'normal',
} = {}) {
    const termContainer = document.createElement('div');
    termContainer.className = 'term-container';
    document.body.appendChild(termContainer);
    const term = {
        write: vi.fn((_data, cb) => {
            const buffer = term.buffer.active;
            const atBottom = buffer.viewportY >= buffer.baseY;
            buffer.baseY++;
            if (atBottom) buffer.viewportY = buffer.baseY;
            cb?.();
        }),
        scrollToTop: vi.fn(() => {
            term.buffer.active.viewportY = 0;
        }),
        scrollToBottom: vi.fn(() => {
            term.buffer.active.viewportY = term.buffer.active.baseY;
            // The real onScroll listener re-enables follow at the live tail.
            tab.userFollowBottom = true;
        }),
        buffer: { active: { viewportY, baseY, type } },
        dispose: vi.fn(),
    };
    const tab = {
        paneId: 'burst-pane',
        isBusy: true,
        pinned: true,
        writeBuffer: '',
        writePending: false,
        userFollowBottom: follow,
        term,
        termContainer,
    };
    return tab;
}

function makeTm() {
    return Object.create(TabManager.prototype);
}

// The parser pump advances in microtasks; fake time advances separately.
async function drain() {
    for (let i = 0; i < 80; i++) await Promise.resolve();
}

async function settle() {
    await drain();
    await vi.advanceTimersByTimeAsync(400);
}

function hidden(tab) {
    return tab.termContainer.classList.contains('burst-paint-skip');
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe('burst paint skip', () => {
    it('parses every byte without intermediate follow, then reveals at the tail', async () => {
        const tm = makeTm();
        const tab = makeTab();
        tm.writeToTerminal(tab, burst);
        expect(hidden(tab)).toBe(true);
        expect(
            tab.termContainer.querySelector('.replay-progress-text')
                ?.textContent,
        ).toBe('Loading output…');
        await drain();
        expect(tab.term.write.mock.calls.map(([data]) => data).join('')).toBe(
            burst,
        );
        expect(tab.term.scrollToBottom).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(399);
        expect(hidden(tab)).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(hidden(tab)).toBe(false);
        expect(tab.termContainer.querySelector('.replay-progress')).toBeNull();
        expect(tab.term.scrollToBottom).toHaveBeenCalled();
        expect(tab.term.buffer.active.viewportY).toBe(
            tab.term.buffer.active.baseY,
        );
        expect(vi.getTimerCount()).toBe(0);
    });

    it('counts arrivals across drained batches, but not across slow network gaps', async () => {
        const tm = makeTm();
        const tab = makeTab();
        for (let i = 0; i < 3; i++) {
            tm.writeToTerminal(tab, 'x'.repeat(BURST_BYTES / 2));
            await drain();
            expect(hidden(tab)).toBe(false);
            await vi.advanceTimersByTimeAsync(401);
        }
        tm.writeToTerminal(tab, 'y'.repeat(BURST_BYTES / 2));
        await drain();
        expect(hidden(tab)).toBe(false);
        tm.writeToTerminal(tab, 'z'.repeat(BURST_BYTES / 2));
        expect(hidden(tab)).toBe(true);
        await settle();
    });

    it.each([
        ['scrolled-up reader', { viewportY: 50 }],
        ['reader who disabled follow', { follow: false }],
        ['alternate-screen TUI', { type: 'alternate' }],
        ['bootstrap replay', { _bootstrapGate: Promise.resolve() }],
    ])('does not hide a %s', async (_name, options) => {
        const tm = makeTm();
        const tab = Object.assign(makeTab(options), options);
        tm.writeToTerminal(tab, burst);
        expect(hidden(tab)).toBe(false);
        await settle();
        if (options.viewportY === 50 || options.follow === false)
            expect(tab.term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('leaves ordinary output and cached-screen restores on the normal paint path', async () => {
        const tm = makeTm();
        const tab = makeTab();
        tm.writeToTerminal(tab, 'hello');
        await drain();
        expect(hidden(tab)).toBe(false);
        expect(tab.term.scrollToBottom).toHaveBeenCalledOnce();
        tm._enqueueTerminalWrite(tab, burst);
        await drain();
        expect(hidden(tab)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reveals at five seconds even when the parser stops, then recovers without losing bytes', async () => {
        const tm = makeTm();
        const tab = makeTab();
        let release;
        tab.term.write.mockImplementationOnce((_data, cb) => {
            release = cb;
        });
        tm.writeToTerminal(tab, burst);
        await vi.advanceTimersByTimeAsync(4999);
        expect(hidden(tab)).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(hidden(tab)).toBe(false);
        // The same unfinished stream must not hide again after the deadline.
        tm.writeToTerminal(tab, burst);
        expect(hidden(tab)).toBe(false);
        release();
        await settle();
        expect(tab.term.write.mock.calls.map(([data]) => data).join('')).toBe(
            burst + burst,
        );
        // A later stream can engage after the pane has been readable a moment.
        await vi.advanceTimersByTimeAsync(1200);
        tm.writeToTerminal(tab, burst);
        expect(hidden(tab)).toBe(true);
        await settle();
    });

    it('a small arrival resets quiet reveal, not the hard deadline', async () => {
        const tm = makeTm();
        const tab = makeTab();
        tm.writeToTerminal(tab, burst);
        await drain();
        for (let i = 0; i < 50; i++) {
            await vi.advanceTimersByTimeAsync(100);
            tm.writeToTerminal(tab, 'y');
            await drain();
        }
        expect(hidden(tab)).toBe(false);
        tm.writeToTerminal(tab, burst);
        expect(hidden(tab)).toBe(false);
        await settle();
    });

    it('does not reveal while a local write is still parsing', async () => {
        const tm = makeTm();
        const tab = makeTab();
        tm.writeToTerminal(tab, burst);
        await drain();
        await vi.advanceTimersByTimeAsync(100);
        let release;
        tab.term.write.mockImplementationOnce((_data, cb) => {
            release = cb;
        });
        tm._enqueueTerminalWrite(tab, 'local banner');
        await vi.advanceTimersByTimeAsync(30);
        expect(hidden(tab)).toBe(true);
        release();
        await settle();
        expect(hidden(tab)).toBe(false);
    });

    it('does not pulse: a chunked stream stays readable between chunks', async () => {
        const tm = makeTm();
        const tab = makeTab();
        tm.writeToTerminal(tab, burst);
        await settle();
        expect(hidden(tab)).toBe(false);
        // Same stream, next chunk after a pause too short to read anything.
        await vi.advanceTimersByTimeAsync(600);
        tm.writeToTerminal(tab, burst);
        await drain();
        expect(hidden(tab)).toBe(false);
        // A pause long enough to read is treated as a new burst.
        await vi.advanceTimersByTimeAsync(1200);
        tm.writeToTerminal(tab, burst);
        expect(hidden(tab)).toBe(true);
        await settle();
        expect(hidden(tab)).toBe(false);
    });

    it('a gesture after drain reveals without snapping back or muting the next burst', async () => {
        const tm = makeTm();
        const tab = makeTab();
        tm.writeToTerminal(tab, burst);
        await drain();
        tm._cancelScrollFollowForUserScroll(tab);
        expect(hidden(tab)).toBe(false);
        expect(tab.userFollowBottom).toBe(false);
        await vi.advanceTimersByTimeAsync(500);
        expect(tab.term.scrollToBottom).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(800); // past the readable window
        tab.userFollowBottom = true;
        tm.writeToTerminal(tab, burst);
        expect(hidden(tab)).toBe(true);
        await settle();
    });

    it('a quiet-pane gesture does not disable the next burst', async () => {
        const tm = makeTm();
        const tab = makeTab();
        tm._cancelScrollFollowForUserScroll(tab);
        tab.userFollowBottom = true;
        tm.writeToTerminal(tab, burst);
        expect(hidden(tab)).toBe(true);
        await settle();
    });

    it('still reveals without following if the reader moves mid-burst', async () => {
        const tm = makeTm();
        const tab = makeTab();
        tm.writeToTerminal(tab, burst);
        tab.userFollowBottom = false;
        tab.term.buffer.active.viewportY = 10;
        await settle();
        expect(hidden(tab)).toBe(false);
        expect(tab.term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('never removes or duplicates a pill owned by replay', async () => {
        const tm = makeTm();
        const tab = makeTab();
        const replayPill = document.createElement('div');
        replayPill.className = 'replay-progress';
        tab.termContainer.appendChild(replayPill);
        tab._replayProgressEl = replayPill;
        tm.writeToTerminal(tab, burst);
        expect(
            tab.termContainer.querySelectorAll('.replay-progress'),
        ).toHaveLength(1);
        await settle();
        expect(replayPill.isConnected).toBe(true);
    });

    it.each(['active', 'settling', 'cooldown'])(
        'disposal cancels all burst work in %s state',
        async (state) => {
            const tm = makeTm();
            const tab = makeTab();
            tm.tabs = new Map([[tab.paneId, tab]]);
            tm._invalidatePiBridgeThinking = vi.fn();
            tm._clearPiRpcModelPending = vi.fn();
            tm.writeToTerminal(tab, burst);
            if (state !== 'active') await drain();
            if (state === 'cooldown') {
                tm._cancelScrollFollowForUserScroll(tab);
                tm._settleBurst(tab);
            }
            const refresh = vi.spyOn(tm, '_refreshTerminalScreen');
            tm.disposeTabClient(tab.paneId, { preserveStorage: true });
            const callsAtDisposal = refresh.mock.calls.length;
            await drain();
            await vi.advanceTimersByTimeAsync(10000);
            expect(refresh).toHaveBeenCalledTimes(callsAtDisposal);
            expect(vi.getTimerCount()).toBe(0);
            expect(tab.term.dispose).toHaveBeenCalledOnce();
            expect(hidden(tab)).toBe(false);
        },
    );
});
