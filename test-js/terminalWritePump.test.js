// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

function makeHarness({ viewportY = 100, baseY = 100, follow = true } = {}) {
    const callbacks = [];
    const syncScrollArea = vi.fn();
    const tab = {
        isDead: false,
        isBusy: true,
        pinned: true,
        writeBuffer: '',
        writePending: false,
        userFollowBottom: follow,
        term: {
            buffer: { active: { viewportY, baseY } },
            write: vi.fn((_data, callback) => callbacks.push(callback)),
            scrollToBottom: vi.fn(),
            _core: { viewport: { syncScrollArea } },
        },
    };
    return {
        callbacks,
        syncScrollArea,
        tab,
        manager: Object.create(TabManager.prototype),
    };
}

describe('single-flight terminal write pump', () => {
    it('keeps one xterm write in flight and coalesces pending output in order', async () => {
        const { callbacks, manager, tab } = makeHarness();

        manager.writeToTerminal(tab, 'one');
        manager.writeToTerminal(tab, 'two');
        manager.writeToTerminal(tab, 'three');

        expect(tab.term.write).toHaveBeenCalledTimes(1);
        expect(tab.term.write.mock.calls[0][0]).toBe('one');
        expect(tab.writeBuffer).toBe('twothree');
        expect(tab.writePending).toBe(true);

        callbacks.shift()();
        expect(tab.term.write).toHaveBeenCalledTimes(1);
        expect(tab.writePending).toBe(true);
        await Promise.resolve();

        expect(tab.term.write).toHaveBeenCalledTimes(2);
        expect(tab.term.write.mock.calls[1][0]).toBe('twothree');
        expect(tab.writeBuffer).toBe('');
        expect(tab.writePending).toBe(true);

        callbacks.shift()();
        await Promise.resolve();
        expect(tab.writePending).toBe(false);
    });

    it('a refused write stays queued and retries without losing its place', async () => {
        vi.useFakeTimers();
        const { manager, tab } = makeHarness();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            let failOnce = true;
            const written = [];
            tab.term.write = vi.fn((data, cb) => {
                if (failOnce) {
                    failOnce = false;
                    throw new Error('flood');
                }
                written.push(data);
                if (cb) cb();
            });
            manager.writeToTerminal(tab, 'retained');
            expect(tab.writePending).toBe(false);
            manager.writeToTerminal(tab, 'tail');
            expect(written).toEqual([]);
            expect(tab.writeBuffer).toBe('retainedtail');
            vi.advanceTimersByTime(50);
            expect(written).toEqual(['retainedtail']);
            expect(tab.writePending).toBe(true);
            await Promise.resolve();
            expect(tab.writePending).toBe(false);
            expect(errors).toHaveBeenCalledTimes(1);
        } finally {
            errors.mockRestore();
            vi.useRealTimers();
        }
    });

    it('retries queued output after a post-parse error without replaying parsed bytes', async () => {
        vi.useFakeTimers();
        const { callbacks, manager, tab } = makeHarness();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        tab.term.scrollToBottom.mockImplementationOnce(() => {
            throw new Error('scroll failed');
        });

        try {
            manager.writeToTerminal(tab, 'first');
            manager.writeToTerminal(tab, 'second');
            callbacks.shift()();
            await Promise.resolve();

            expect(errors).toHaveBeenCalledOnce();
            expect(tab.term.write.mock.calls.map(([data]) => data)).toEqual([
                'first',
            ]);
            expect(tab.writePending).toBe(false);
            expect(tab.writeBuffer).toBe('second');

            vi.advanceTimersByTime(50);
            expect(tab.term.write.mock.calls.map(([data]) => data)).toEqual([
                'first',
                'second',
            ]);
            callbacks.shift()();
            await Promise.resolve();
            expect(tab.writePending).toBe(false);
        } finally {
            errors.mockRestore();
            vi.useRealTimers();
        }
    });

    it('preserves ordering when output arrives during a later batch', async () => {
        const { callbacks, manager, tab } = makeHarness();

        manager.writeToTerminal(tab, 'a');
        manager.writeToTerminal(tab, 'b');
        callbacks.shift()();
        manager.writeToTerminal(tab, 'c');

        expect(tab.term.write.mock.calls.map(([data]) => data)).toEqual(['a']);
        expect(tab.writeBuffer).toBe('bc');
        await Promise.resolve();
        expect(tab.term.write.mock.calls.map(([data]) => data)).toEqual([
            'a',
            'bc',
        ]);

        callbacks.shift()();
        await Promise.resolve();
        expect(tab.term.write.mock.calls.map(([data]) => data)).toEqual([
            'a',
            'bc',
        ]);
        expect(tab.writeBuffer).toBe('');
    });

    it('applies a pending visible fit and sends resize before the next batch', async () => {
        const { callbacks, manager, tab } = makeHarness();
        const order = [];
        tab.term.cols = 80;
        tab.term.rows = 24;
        tab.term.options = { fontSize: 14 };
        tab.term.write = vi.fn((data, callback) => {
            order.push(`write:${data}`);
            callbacks.push(callback);
        });
        tab.fitAddon = {
            proposeDimensions: () => ({ cols: 90, rows: 24 }),
            fit: vi.fn(() => {
                order.push('fit');
                tab.term.cols = 90;
            }),
        };
        tab.ws = {
            sendResize: vi.fn((cols, rows) => {
                order.push(`resize:${cols}x${rows}`);
                return true;
            }),
        };
        tab._sizedWs = tab.ws;
        manager.getActiveTab = () => tab;
        manager._terminalPanelVisible = () => true;
        manager.resolveTerminalFontSize = () => 14;
        manager._spamScroll = vi.fn();
        manager._refreshTerminalScreen = vi.fn();
        manager.syncBackendPin = vi.fn();
        manager.updateDocumentTitle = vi.fn();

        manager.writeToTerminal(tab, 'first');
        manager.writeToTerminal(tab, 'second');
        manager.fitActiveTerminal({ forceResize: true });

        expect(tab._pendingPanelFit).toBe(true);
        expect(tab.fitAddon.fit).not.toHaveBeenCalled();
        expect(tab.ws.sendResize).not.toHaveBeenCalled();
        callbacks.shift()();
        expect(order).toEqual(['write:first']);
        expect(tab.writePending).toBe(true);

        await Promise.resolve();

        expect(order).toEqual([
            'write:first',
            'fit',
            'resize:90x24',
            'write:second',
        ]);
        expect(tab._pendingPanelFit).toBe(false);
        expect(tab._pendingForceResize).toBe(false);
    });

    it('keeps output moving for a hidden fit and applies the latest fit on activation', async () => {
        const { callbacks, manager, tab } = makeHarness();
        const order = [];
        let visible = false;
        tab.term.cols = 80;
        tab.term.rows = 24;
        tab.term.options = { fontSize: 14 };
        tab.term.write = vi.fn((data, callback) => {
            order.push(`write:${data}`);
            callbacks.push(callback);
        });
        tab.fitAddon = {
            proposeDimensions: () => ({ cols: 70, rows: 20 }),
            fit: vi.fn(() => {
                order.push('fit');
                tab.term.cols = 70;
                tab.term.rows = 20;
            }),
        };
        tab.ws = {
            sendResize: vi.fn((cols, rows) => {
                order.push(`resize:${cols}x${rows}`);
                return true;
            }),
        };
        tab._sizedWs = tab.ws;
        manager.getActiveTab = () => tab;
        manager._terminalPanelVisible = () => visible;
        manager.resolveTerminalFontSize = () => 14;
        manager._spamScroll = vi.fn();
        manager._refreshTerminalScreen = vi.fn();
        manager.syncBackendPin = vi.fn();
        manager.updateDocumentTitle = vi.fn();

        manager.writeToTerminal(tab, 'first');
        manager.writeToTerminal(tab, 'second');
        manager.fitActiveTerminal({ forceResize: true });
        callbacks.shift()();
        await Promise.resolve();

        expect(order).toEqual(['write:first', 'write:second']);
        expect(tab._pendingPanelFit).toBe(true);
        expect(tab.fitAddon.fit).not.toHaveBeenCalled();
        expect(tab.ws.sendResize).not.toHaveBeenCalled();

        visible = true;
        callbacks.shift()();
        await Promise.resolve();

        expect(order).toEqual([
            'write:first',
            'write:second',
            'fit',
            'resize:70x20',
        ]);
        expect(tab._pendingPanelFit).toBe(false);
        expect(tab._pendingForceResize).toBe(false);
    });

    it('queues the local replay divider without PTY activity bookkeeping', async () => {
        const { callbacks, manager, tab } = makeHarness();
        const key = 'phi_replay_divider';
        const previous = localStorage.getItem(key);
        localStorage.setItem(key, 'true');
        tab.awaitingReplay = true;
        tab.lastOutputAt = 123;
        tab.isBusy = false;
        tab.busyStartTime = 456;
        tab.pinned = false;
        tab.queuedSeq = 10;
        tab.drainedSeq = 8;
        manager.syncBackendPin = vi.fn();
        manager.updateDocumentTitle = vi.fn();

        try {
            manager.handleControlMessage(tab, { type: 'replay-complete' });
            expect(tab.awaitingReplay).toBe(false);
            expect(tab.term.write).toHaveBeenCalledOnce();
            expect(tab.term.write.mock.calls[0][0]).toBe(
                '\r\n\x1b[33m─── live ───\x1b[0m\r\n',
            );
            expect(tab.writePending).toBe(true);
            expect(tab.writeBuffer).toBe('');
            expect(tab.lastOutputAt).toBe(123);
            expect(tab.isBusy).toBe(false);
            expect(tab.busyStartTime).toBe(456);
            expect(tab.pinned).toBe(false);
            expect(tab.queuedSeq).toBe(10);
            expect(tab.drainedSeq).toBe(8);
            expect(manager.syncBackendPin).not.toHaveBeenCalled();
            expect(manager.updateDocumentTitle).not.toHaveBeenCalled();
            callbacks.shift()();
            await Promise.resolve();
        } finally {
            if (previous === null) localStorage.removeItem(key);
            else localStorage.setItem(key, previous);
        }
    });

    it('syncs and follows bottom only after xterm completes the batch', async () => {
        const { callbacks, manager, syncScrollArea, tab } = makeHarness();

        manager.writeToTerminal(tab, 'output');
        expect(syncScrollArea).not.toHaveBeenCalled();
        expect(tab.term.scrollToBottom).not.toHaveBeenCalled();

        callbacks.shift()();
        expect(syncScrollArea).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(syncScrollArea).toHaveBeenCalledWith(true);
        expect(tab.term.scrollToBottom).toHaveBeenCalledOnce();
    });

    it('syncs the native scroll area after following a newly grown tail', async () => {
        const { callbacks, manager, tab } = makeHarness({
            viewportY: 800,
            baseY: 800,
        });
        const syncedViewportY = [];
        tab.term.write = vi.fn((_data, callback) => {
            tab.term.buffer.active.baseY = 1800;
            callbacks.push(callback);
        });
        tab.term.scrollToBottom = vi.fn(() => {
            tab.term.buffer.active.viewportY = tab.term.buffer.active.baseY;
        });
        tab.term._core.viewport.syncScrollArea = vi.fn(() => {
            syncedViewportY.push(tab.term.buffer.active.viewportY);
        });

        manager.writeToTerminal(tab, '1000 new lines');
        callbacks.shift()();
        await Promise.resolve();

        expect(tab.term.scrollToBottom).toHaveBeenCalledOnce();
        expect(syncedViewportY).toEqual([1800]);
    });

    it('does not yank the viewport down if the user scrolls before completion', async () => {
        const { callbacks, manager, tab } = makeHarness();

        manager.writeToTerminal(tab, 'output');
        tab.userFollowBottom = false;
        callbacks.shift()();
        await Promise.resolve();

        expect(tab.term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('cancels pending rendering only after the tab is finalized', async () => {
        const { callbacks, manager, tab } = makeHarness();

        manager.writeToTerminal(tab, 'submitted');
        manager.writeToTerminal(tab, 'pending');
        tab.finalizing = true;
        callbacks.shift()();
        await Promise.resolve();

        expect(tab.term.write).toHaveBeenCalledTimes(1);
        expect(tab.writeBuffer).toBe('');
        expect(tab.writePending).toBe(false);
    });
});
