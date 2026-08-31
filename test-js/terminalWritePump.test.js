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
    it('keeps one xterm write in flight and coalesces pending output in order', () => {
        const { callbacks, manager, tab } = makeHarness();

        manager.writeToTerminal(tab, 'one');
        manager.writeToTerminal(tab, 'two');
        manager.writeToTerminal(tab, 'three');

        expect(tab.term.write).toHaveBeenCalledTimes(1);
        expect(tab.term.write.mock.calls[0][0]).toBe('one');
        expect(tab.writeBuffer).toBe('twothree');
        expect(tab.writePending).toBe(true);

        callbacks.shift()();

        expect(tab.term.write).toHaveBeenCalledTimes(2);
        expect(tab.term.write.mock.calls[1][0]).toBe('twothree');
        expect(tab.writeBuffer).toBe('');
        expect(tab.writePending).toBe(true);

        callbacks.shift()();
        expect(tab.writePending).toBe(false);
    });

    it('preserves ordering when output arrives during a later batch', () => {
        const { callbacks, manager, tab } = makeHarness();

        manager.writeToTerminal(tab, 'a');
        manager.writeToTerminal(tab, 'b');
        callbacks.shift()();
        manager.writeToTerminal(tab, 'c');

        expect(tab.term.write.mock.calls.map(([data]) => data)).toEqual([
            'a',
            'b',
        ]);
        expect(tab.writeBuffer).toBe('c');

        callbacks.shift()();
        expect(tab.term.write.mock.calls.map(([data]) => data)).toEqual([
            'a',
            'b',
            'c',
        ]);
    });

    it('syncs and follows bottom only after xterm completes the batch', () => {
        const { callbacks, manager, syncScrollArea, tab } = makeHarness();

        manager.writeToTerminal(tab, 'output');
        expect(syncScrollArea).not.toHaveBeenCalled();
        expect(tab.term.scrollToBottom).not.toHaveBeenCalled();

        callbacks.shift()();
        expect(syncScrollArea).toHaveBeenCalledWith(true);
        expect(tab.term.scrollToBottom).toHaveBeenCalledOnce();
    });

    it('syncs the native scroll area after following a newly grown tail', () => {
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

        expect(tab.term.scrollToBottom).toHaveBeenCalledOnce();
        expect(syncedViewportY).toEqual([1800]);
    });

    it('does not yank the viewport down if the user scrolls before completion', () => {
        const { callbacks, manager, tab } = makeHarness();

        manager.writeToTerminal(tab, 'output');
        tab.userFollowBottom = false;
        callbacks.shift()();

        expect(tab.term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('drops only unsubmitted output when the tab dies', () => {
        const { callbacks, manager, tab } = makeHarness();

        manager.writeToTerminal(tab, 'submitted');
        manager.writeToTerminal(tab, 'pending');
        tab.isDead = true;
        callbacks.shift()();

        expect(tab.term.write).toHaveBeenCalledTimes(1);
        expect(tab.writeBuffer).toBe('');
        expect(tab.writePending).toBe(false);
    });
});
