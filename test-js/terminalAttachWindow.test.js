// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

// The v2 attach head carries the replay baseline (initial geometry plus an
// event cursor into the raw journal) instead of a checkpoint. A parser
// already inside the same pane lifetime resumes from its own frontier:
// the journal owns every byte from there to the head, so resetting would
// throw away a coherent view (and a reader's row) for nothing. A new
// lifetime resets and replays from zero.

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
    tm._resetPaneBuffer = vi.fn();
    tm._openTermAndViewport = vi.fn();
    tm._noteReplayDurability = vi.fn();
    tm._queuePanelFit = vi.fn();
    tm._fitVisibleTerminal = vi.fn();
    tm._refreshTerminalScreen = vi.fn();
    tm._terminalPanelVisible = () => true;
    tm._spamScrollToBottom = vi.fn();
    const pty = {
        mode: 'hot',
        hold: vi.fn(),
        release: vi.fn(),
        ws: { close: vi.fn() },
        decoder: new TextDecoder('utf-8'),
    };
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
    initialCols: 120,
    initialRows: 30,
    eventCursor: 'v1.7.400.0',
    ...extra,
});

describe('attach replay window', () => {
    it('resumes from the local frontier instead of resetting', async () => {
        const { tm, tab, pty } = harness({ drainedSeq: 100 });
        await tm._onAttachHead(tab, attach());

        expect(tab.term.reset).not.toHaveBeenCalled();
        expect(tm._resetPaneBuffer).not.toHaveBeenCalled();
        expect(tm._bootstrappedRelease).toHaveBeenCalledWith(
            tab,
            pty,
            100,
            400,
            'v1.7.400.0',
        );
    });

    it('holds the old view and schedules a fresh replay baseline for a new lifetime', async () => {
        const { tm, tab, pty } = harness({ drainedSeq: 100 });
        await tm._onAttachHead(tab, attach({ epoch: 8 }));

        expect(pty.hold).toHaveBeenCalledOnce();
        expect(tm._resetPaneBuffer).not.toHaveBeenCalled();
        expect(tab.term.resize).not.toHaveBeenCalled();
        expect(tab._replayBaseline).toEqual({ cols: 120, rows: 30 });
        expect(tab.drainedSeq).toBe(0);
        expect(tm._bootstrappedRelease).toHaveBeenCalledWith(
            tab,
            pty,
            0,
            400,
            'v1.7.400.0',
        );
    });

    it('a fresh tab opens at the baseline grid and replays from zero', async () => {
        const { tm, tab, pty } = harness({ drainedSeq: 0 });
        tab._termOpened = false;
        await tm._onAttachHead(tab, attach());

        expect(tab.term.resize).toHaveBeenCalledWith(120, 30);
        expect(tm._openTermAndViewport).toHaveBeenCalledWith(tab);
        expect(tm._bootstrappedRelease).toHaveBeenCalledWith(
            tab,
            pty,
            0,
            400,
            'v1.7.400.0',
        );
    });

    it('a regressed frontier closes the socket instead of releasing it', async () => {
        const { tm, tab, pty } = harness({ drainedSeq: 500 });
        tab.queuedSeq = 500;
        await tm._onAttachHead(tab, attach());

        expect(tm._bootstrappedRelease).not.toHaveBeenCalled();
        expect(pty.ws.close).toHaveBeenCalledOnce();
    });

    it('a reading pane keeps its row on a same-pane reconnect', async () => {
        const { tm, tab } = harness({
            drainedSeq: 100,
            viewportY: 10,
            baseY: 40,
        });
        await tm._onAttachHead(tab, attach());
        expect(tab.term.reset).not.toHaveBeenCalled();
        expect(tm._bootstrappedRelease).toHaveBeenCalledWith(
            tab,
            tab.ws,
            100,
            400,
            'v1.7.400.0',
        );
    });
});
