// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

// The attach frame carries a certified replay window next to the checkpoint.
// A parser already inside that window resumes from its own frontier: the
// recording owns every byte from there to the head, so repainting would throw
// away a coherent view (and a reader's row) for nothing.

function harness({ drainedSeq = 100, viewportY = 40, baseY = 40 } = {}) {
    const term = {
        cols: 80,
        rows: 24,
        buffer: {
            active: { type: 'normal', viewportY, baseY, viewportY_: viewportY },
        },
        reset: vi.fn(),
        resize: vi.fn(),
        write: vi.fn((_data, cb) => cb?.()),
        refresh: vi.fn(),
        scrollToBottom: vi.fn(),
        scrollToLine: vi.fn(),
        _core: { viewport: { syncScrollArea: vi.fn() } },
    };
    const tm = Object.create(TabManager.prototype);
    tm._bootstrappedRelease = vi.fn();
    tm._drainSettled = async () => {};
    tm._clearHistoryAnchors = vi.fn();
    tm._writeAttachCheckpoint = vi.fn();
    tm._queuePanelFit = vi.fn();
    tm._updateHistoryButton = vi.fn();
    tm._fitVisibleTerminal = vi.fn();
    tm._refreshTerminalScreen = vi.fn();
    tm._terminalPanelVisible = () => true;
    tm._spamScrollToBottom = vi.fn();
    const pty = { mode: 'hot', hold: vi.fn(), release: vi.fn(), ws: {} };
    const tab = {
        _termOpened: true,
        isDead: false,
        finalizing: false,
        paneEpoch: 7,
        paneOldest: 0,
        drainedSeq,
        queuedSeq: drainedSeq,
        userFollowBottom: false,
        term,
        ws: pty,
        paneId: 'p1',
    };
    tm.tabs = new Map([['p1', tab]]);
    tm.getActiveTab = () => tab;
    return { tm, tab, pty, term };
}

const attach = (extra = {}) => ({
    epoch: 7,
    oldest: 0,
    head: 400,
    ckpt: {
        bytes: new Uint8Array([65]),
        through: 400,
        cols: 80,
        rows: 24,
    },
    ...extra,
});

describe('attach replay window', () => {
    it('resumes from the local frontier instead of repainting', async () => {
        const { tm, tab, pty } = harness({ drainedSeq: 100 });
        await tm._onAttachHead(
            tab,
            attach({ replayFrom: 64 }),
        );

        expect(tm._writeAttachCheckpoint).not.toHaveBeenCalled();
        expect(tab.term.reset).not.toHaveBeenCalled();
        expect(tm._bootstrappedRelease).toHaveBeenCalledWith(
            tab,
            pty,
            100,
            400,
        );
    });

    it('repaints when the parser sits before the window', async () => {
        const { tm, tab } = harness({ drainedSeq: 10 });
        await tm._onAttachHead(tab, attach({ replayFrom: 64 }));

        expect(tm._writeAttachCheckpoint).toHaveBeenCalled();
        expect(tm._bootstrappedRelease).toHaveBeenCalledWith(
            tab,
            tab.ws,
            400,
            400,
            undefined,
        );
    });

    it('a forced refresh still repaints from the checkpoint', async () => {
        const { tm, tab } = harness({ drainedSeq: 100 });
        tab._forceStateRefresh = true;
        await tm._onAttachHead(tab, attach({ replayFrom: 64 }));

        expect(tm._writeAttachCheckpoint).toHaveBeenCalled();
    });

    it('an attach without a window keeps the checkpoint path', async () => {
        const { tm, tab } = harness({ drainedSeq: 100 });
        await tm._onAttachHead(tab, attach());

        expect(tm._writeAttachCheckpoint).toHaveBeenCalled();
        expect(tm._bootstrappedRelease).toHaveBeenCalledWith(
            tab,
            tab.ws,
            400,
            400,
            undefined,
        );
    });

    it('a reading pane keeps its row whether or not the window is present', async () => {
        const { tm, tab } = harness({
            drainedSeq: 100,
            viewportY: 10,
            baseY: 40,
        });
        await tm._onAttachHead(tab, attach({ replayFrom: 64 }));
        expect(tab.term.reset).not.toHaveBeenCalled();
        expect(tm._bootstrappedRelease).toHaveBeenCalledWith(
            tab,
            tab.ws,
            100,
            400,
        );
    });
});
