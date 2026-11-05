// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

// Pi fast path: a capable pane initializes at the certified HEAD grid and
// asks the host for one in-place repaint instead of downloading history.
// The receipt decides; a refusal or silence falls back to one bounded
// history replay inside a 10-second, two-attempt recovery episode.

afterEach(() => {
    vi.useRealTimers();
});

function harness({ opened = true, drainedSeq = 100 } = {}) {
    const term = {
        cols: 80,
        rows: 24,
        buffer: {
            active: { type: 'normal', viewportY: 5, baseY: 40 },
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
    tm._trackBootstrap = vi.fn();
    tm.reconnectTab = vi.fn();
    tm.app = { showToast: vi.fn() };
    const pty = {
        mode: 'hot',
        hold: vi.fn(),
        release: vi.fn(),
        ws: { close: vi.fn() },
        decoder: new TextDecoder('utf-8'),
    };
    const tab = {
        _termOpened: opened,
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
    headCols: 100,
    headRows: 40,
    eventCursor: 'v1.7.400.0',
    ...extra,
});

const refreshAttach = (extra = {}) =>
    attach({ terminalRefreshAvailable: true, ...extra });

describe('Pi repaint fast path', () => {
    it('opens a fresh viewer at the certified head without replay', async () => {
        const { tm, tab, pty } = harness({ opened: false, drainedSeq: 0 });
        await tm._onAttachHead(tab, refreshAttach());

        expect(tab.paneEpoch).toBe(7);
        expect(tab._piRefreshNext).toBe(true);
        expect(tab._recovery).toMatchObject({
            attempts: 1,
            suppressFastPath: false,
        });
        expect(tm._resetPaneBuffer).toHaveBeenCalledOnce();
        expect(tab.term.resize).toHaveBeenCalledWith(100, 40);
        expect(tm._bootstrappedRelease).toHaveBeenCalledWith(
            tab,
            pty,
            400,
            400,
            'v1.7.400.0',
        );
    });

    it('replaces a dead lifetime screen at the head grid', async () => {
        const { tm, tab, pty } = harness();
        await tm._onAttachHead(tab, refreshAttach({ epoch: 8 }));

        expect(pty.hold).toHaveBeenCalledOnce();
        expect(tm._resetPaneBuffer).toHaveBeenCalledOnce();
        expect(tab.term.resize).toHaveBeenCalledWith(100, 40);
        expect(tab.drainedSeq).toBe(400);
        expect(tm._bootstrappedRelease).toHaveBeenCalledWith(
            tab,
            pty,
            400,
            400,
            'v1.7.400.0',
        );
    });

    it('keeps the history path when the pane cannot repaint', async () => {
        const { tm, tab, pty } = harness({ drainedSeq: 0 });
        tab._termOpened = false;
        await tm._onAttachHead(tab, attach());

        expect(tab._piRefreshNext).toBeUndefined();
        expect(tab._recovery).toBeUndefined();
        expect(tm._bootstrappedRelease).toHaveBeenCalledWith(
            tab,
            pty,
            0,
            400,
            'v1.7.400.0',
        );
    });

    it('repairs only the missing range on a same-epoch reconnect', async () => {
        const { tm, tab, pty } = harness({ drainedSeq: 100 });
        await tm._onAttachHead(tab, refreshAttach());

        expect(tm._resetPaneBuffer).not.toHaveBeenCalled();
        expect(tm._bootstrappedRelease).toHaveBeenCalledWith(
            tab,
            pty,
            100,
            400,
            'v1.7.400.0',
        );
    });

    it('uses the repaint path for an explicit Refresh Console', async () => {
        const { tm, tab, pty } = harness({ drainedSeq: 100 });
        tab._forceRedraw = true;
        await tm._onAttachHead(tab, refreshAttach());

        expect(tab._forceRedraw).toBe(false);
        expect(tab._piRefreshNext).toBe(true);
        expect(tm._bootstrappedRelease).toHaveBeenCalledWith(
            tab,
            pty,
            400,
            400,
            'v1.7.400.0',
        );
    });

    it('does not repaint while the recovery episode is suppressed or spent', async () => {
        for (const recovery of [
            {
                deadline: Date.now() + 10_000,
                attempts: 1,
                suppressFastPath: true,
            },
            {
                deadline: Date.now() + 10_000,
                attempts: 2,
                suppressFastPath: false,
            },
            { deadline: Date.now() - 1, attempts: 1, suppressFastPath: false },
        ]) {
            const { tm, tab } = harness();
            tab._recovery = recovery;
            await tm._onAttachHead(tab, refreshAttach({ epoch: 8 }));
            expect(tab._piRefreshNext).toBeUndefined();
        }
    });
});

describe('Pi repaint receipts', () => {
    function pending(tab, pty, over = {}) {
        tab._bootstrapGen = 3;
        tab._recovery = {
            deadline: Date.now() + 10_000,
            attempts: 1,
            suppressFastPath: false,
        };
        return setRequest(tab, pty, over);
    }

    function setRequest(tab, pty, over = {}) {
        tab._refreshRequest = {
            id: '5',
            socket: pty,
            gen: tab._bootstrapGen,
            head: 400,
            dispatched: false,
            timer: null,
            ...over,
        };
        return tab._refreshRequest;
    }

    it('counts one repaint and keeps live delivery after DISPATCHED', () => {
        const { tm, tab, pty } = harness();
        pending(tab, pty);
        tm._onRefreshResult(tab, pty, {
            requestId: '5',
            outcome: 'dispatched',
            reason: '',
        });

        expect(tab._redrawLog).toEqual([
            { outcome: 'painted', key: '7:400:80x24' },
        ]);
        expect(tab._redraws).toBe(1);
        expect(tab._refreshRequest.dispatched).toBe(true);
        expect(tab._recovery).not.toBeNull();
        expect(tm.reconnectTab).not.toHaveBeenCalled();

        // The episode ends only after a drained frame passes the head.
        tm._advanceDrained(tab, 400);
        expect(tab._recovery).not.toBeNull();
        tm._advanceDrained(tab, 401);
        expect(tab._recovery).toBeNull();
        expect(tab._refreshRequest).toBeNull();
    });

    it('ignores late, foreign, and stale-generation receipts', () => {
        const { tm, tab, pty } = harness();
        pending(tab, pty);
        const before = JSON.stringify(tab._refreshRequest);

        tm._onRefreshResult(tab, pty, {
            requestId: '6',
            outcome: 'not-sent',
            reason: 'pending',
        });
        tm._onRefreshResult(tab, {}, { requestId: '5', outcome: 'dispatched' });
        tab._bootstrapGen = 4;
        tm._onRefreshResult(tab, pty, {
            requestId: '5',
            outcome: 'dispatched',
            reason: '',
        });

        expect(JSON.stringify(tab._refreshRequest)).toBe(before);
        expect(tm.reconnectTab).not.toHaveBeenCalled();
        expect(tab._redrawLog).toBeUndefined();
    });

    it('falls back to one replay attach when the repaint was not sent', () => {
        const { tm, tab, pty } = harness();
        pending(tab, pty);
        tm._onRefreshResult(tab, pty, {
            requestId: '5',
            outcome: 'not-sent',
            reason: 'unavailable',
        });

        expect(tm.reconnectTab).toHaveBeenCalledWith(tab, { auto: true });
        expect(tab._recovery).toMatchObject({
            attempts: 2,
            suppressFastPath: true,
        });
        expect(tab._refreshRequest).toBeNull();
    });

    it('never retries an UNKNOWN receipt beyond the attempt budget', () => {
        const { tm, tab, pty } = harness();
        pending(tab, pty);
        tm._onRefreshResult(tab, pty, {
            requestId: '5',
            outcome: 'unknown',
            reason: 'error',
        });
        expect(tm.reconnectTab).toHaveBeenCalledOnce();

        // The fallback attach is the second and last attempt.
        tab._bootstrapGen = 4;
        setRequest(tab, pty, { gen: 4, id: '6' });
        tm._onRefreshResult(tab, pty, {
            requestId: '6',
            outcome: 'unknown',
            reason: 'error',
        });
        expect(tm.reconnectTab).toHaveBeenCalledOnce();
        expect(tm.app.showToast).toHaveBeenCalledWith(
            expect.stringContaining('History could not be recovered'),
            expect.objectContaining({ type: 'info' }),
        );
        expect(tab._recovery).toBeNull();
        expect(pty.release).toHaveBeenCalled();
    });

    it('bounds the receipt wait by the remaining episode budget', () => {
        vi.useFakeTimers();
        const { tm, tab, pty } = harness();
        pending(tab, pty);
        tab._recovery.deadline = Date.now() + 50;
        tm._armRefreshDeadline(tab);

        vi.advanceTimersByTime(49);
        expect(tm.reconnectTab).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(tm.reconnectTab).toHaveBeenCalledWith(tab, { auto: true });
        expect(tab._refreshRequest).toBeNull();
    });
});
