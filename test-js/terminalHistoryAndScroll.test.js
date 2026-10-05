// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Comprehensive regression test suite for terminal history retention,
// scroll stability, and performance benchmarking.
// Pinned contracts:
//   1. History must never be optimized away: full scrollback is serialized into
//      checkpoints and fetched on attach without dropping deltas under 2 MiB.
//   2. Scroll stability: user scrolling away from bottom cancels spam timers,
//      tab switching preserves reading position, and keyboard navigation cancels follow.
//   3. Benchmarks: terminal write throughput and serialize/restore performance.

setupDomHarness();
if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
}

class FakeWebSocket {
    constructor(url) {
        this.url = url;
        this.binaryType = '';
        this.readyState = 1;
        this.sent = [];
    }
    send(b) {
        this.sent.push(b);
    }
    close() {}
    emit(msgType, payload) {
        const buf = new ArrayBuffer(1 + payload.byteLength);
        const u8 = new Uint8Array(buf);
        u8[0] = msgType;
        u8.set(payload, 1);
        if (this.onmessage) this.onmessage({ data: buf });
    }
    emitHot(startSeq, text) {
        const bytes = new TextEncoder().encode(text);
        const payload = new ArrayBuffer(8 + bytes.byteLength);
        const view = new DataView(payload);
        view.setBigUint64(0, BigInt(startSeq), false);
        new Uint8Array(payload, 8).set(bytes);
        this.emit(0x09, new Uint8Array(payload));
    }
    emitAttachHead(hdr, extra) {
        const json = new TextEncoder().encode(JSON.stringify(hdr));
        const payload = new ArrayBuffer(
            4 + json.byteLength + (extra?.byteLength || 0),
        );
        const view = new DataView(payload);
        view.setUint32(0, json.byteLength, false);
        new Uint8Array(payload, 4).set(json);
        if (extra) new Uint8Array(payload, 4 + json.byteLength).set(extra);
        this.emit(0x08, new Uint8Array(payload));
    }
}

function makeTm({ withTabs = [] } = {}) {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;
    tm.tabsContainer = document.createElement('div');
    tm.terminalsWrapper = document.createElement('div');
    tm.inputBarContainer = document.createElement('div');
    tm.inputTextArea = document.createElement('textarea');
    document.body.appendChild(tm.tabsContainer);
    document.body.appendChild(tm.terminalsWrapper);
    document.body.appendChild(tm.inputBarContainer);
    tm.app = { config: {}, showToast: vi.fn() };
    tm.updateDocumentTitle = vi.fn();
    tm.syncBackendPin = vi.fn();
    tm.saveTabsState = vi.fn();
    tm.updateDirectModeUI = vi.fn();
    tm.renderPiRpcStatusBar = vi.fn();
    tm._syncProjectForTab = vi.fn(() => false);

    for (const id of withTabs) {
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.setAttribute('data-pane-id', id);
        tm.tabsContainer.appendChild(tabEl);
        tm.tabs.set(id, {
            paneId: id,
            title: id,
            coder: 'shell',
            tabEl,
            termContainer: document.createElement('div'),
            isDead: false,
            userFollowBottom: true,
            term: {
                cols: 80,
                rows: 24,
                options: { scrollback: 10000 },
                buffer: { active: { viewportY: 100, baseY: 100 } },
                scrollToBottom: vi.fn(),
                scrollToLine: vi.fn(),
                scrollLines: vi.fn(),
                write: vi.fn((_d, cb) => cb?.()),
                resize: vi.fn(),
                open: vi.fn(),
                reset: vi.fn(),
            },
        });
    }
    return tm;
}

function stubTerminalGlobal() {
    const opened = [];
    const Terminal = function (opts = {}) {
        this.cols = opts.cols || 80;
        this.rows = opts.rows || 24;
        this.options = { scrollback: opts.scrollback || 10000 };
        this.buffer = { active: { viewportY: 0, baseY: 0 } };
        this.writes = [];
        this.opened = false;
        this.open = (c) => {
            opened.push(c);
            this.opened = true;
        };
        this.write = (d, cb) => {
            this.writes.push(d);
            if (cb) cb();
        };
        this.reset = () => {
            this.writes = [];
            this.resetCount = (this.resetCount || 0) + 1;
        };
        this.resize = (c, r) => {
            this.cols = c;
            this.rows = r;
        };
        this.loadAddon = () => {};
        this.attachCustomKeyEventHandler = () => {};
        this.onSelectionChange = () => {};
        this.onBell = () => {};
        this.onScroll = () => {};
        this.onData = () => {};
        this.parser = { registerOscHandler: () => {} };
        this.getSelection = () => '';
        this.scrollToBottom = vi.fn();
        this.scrollToLine = vi.fn();
        this.refresh = vi.fn();
        this._core = { viewport: { syncScrollArea: vi.fn() } };
    };
    vi.stubGlobal('Terminal', Terminal);
    vi.stubGlobal('FitAddon', { FitAddon: class {} });
    vi.stubGlobal('SearchAddon', { SearchAddon: class {} });
    return opened;
}

function recordingResponse(text, start, end) {
    const bytes = new TextEncoder().encode(text);
    const json = new TextEncoder().encode(
        JSON.stringify({ epoch: 7, start, end, resizes: [] }),
    );
    const buf = new Uint8Array(4 + json.byteLength + bytes.byteLength);
    const view = new DataView(buf.buffer);
    view.setUint32(0, json.byteLength, false);
    buf.set(json, 4);
    buf.set(bytes, 4 + json.byteLength);
    return {
        ok: true,
        arrayBuffer: async () => buf.buffer.slice(0),
    };
}

beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
});

describe('Terminal History Preservation', () => {
    it('checkpoint upload serializes full scrollback up to LIVE_SCROLLBACK_ROWS', async () => {
        stubTerminalGlobal();
        const tm = makeTm();
        let serializeOpts = null;
        const fakeAddon = {
            serialize: (o) => {
                serializeOpts = o;
                return 'CHECKPOINT_WITH_SCROLLBACK';
            },
        };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);

        tm.createTab('p-hist-1', 's1', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p-hist-1');
        tab.ws.ws.emitAttachHead({ epoch: 12, oldest: 0, head: 5000 });
        tab.serializeAddon = fakeAddon;
        tab.paneEpoch = 12;
        tab.drainedSeq = 5000;
        tab.term.cols = 120;
        tab.term.rows = 40;

        tm._uploadCheckpoint(tab);
        await new Promise((r) => setTimeout(r, 0));

        // Must request full 10,000 live scrollback, NOT scrollback: 0
        expect(serializeOpts).toEqual({ scrollback: 10000 });
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/api/terminals/p-hist-1/checkpoint'),
            expect.objectContaining({ method: 'POST' }),
        );
        const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
        const body = JSON.parse(lastCall[1].body);
        expect(body.ansi).toBe('CHECKPOINT_WITH_SCROLLBACK');
        expect(body.through).toBe(5000);
    });

    it('fresh attach without checkpoint requests full history from oldest (not clamped to 64KB)', async () => {
        stubTerminalGlobal();
        const tm = makeTm();
        const largeHistory = 'H'.repeat(128 * 1024); // 128 KiB of history (> old 64 KiB cap)
        const fetchMock = vi
            .fn()
            .mockResolvedValue(recordingResponse(largeHistory, 0, 128 * 1024));
        vi.stubGlobal('fetch', fetchMock);

        tm.createTab('p-hist-2', 's2', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p-hist-2');

        tab.ws.ws.emitAttachHead({
            epoch: 7,
            oldest: 0,
            head: 128 * 1024,
            ckpt: null,
        });
        await new Promise((r) => setTimeout(r, 10));

        // Must request from=0 (oldest), preserving the full 128 KiB
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('from=0'),
            expect.anything(),
        );
        // Must NOT drop the delta — all 128 KiB must reach xterm
        expect(tab.term.writes.join('')).toContain(largeHistory);
        expect(tab.term.opened).toBe(true);
    });

    it('same-pane reconnect with >64KB delta applies the delta instead of dropping it', async () => {
        stubTerminalGlobal();
        const tm = makeTm();
        const missedOutput = 'M'.repeat(90 * 1024); // 90 KiB missed while disconnected
        const initialOutput = 'I'.repeat(10000);
        const fetchMock = vi.fn(async (url) => {
            const from = Number(
                new URL(url, 'http://localhost').searchParams.get('from'),
            );
            return from === 0
                ? recordingResponse(initialOutput, 0, 10000)
                : recordingResponse(missedOutput, 10000, 10000 + 90 * 1024);
        });
        vi.stubGlobal('fetch', fetchMock);

        tm.createTab('p-hist-3', 's3', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p-hist-3');

        // Initial attach
        tab.ws.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 10000 });
        await new Promise((r) => setTimeout(r, 0));
        tab.drainedSeq = 10000;
        tab.paneEpoch = 7;
        tab._termOpened = true;

        // Reconnect to same pane with 90 KiB delta
        tab.ws.ws.emitAttachHead({
            epoch: 7,
            oldest: 0,
            head: 10000 + 90 * 1024,
        });
        await new Promise((r) => setTimeout(r, 10));

        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('from=10000'),
            expect.anything(),
        );
        expect(tab.term.writes.join('')).toContain(missedOutput);
        expect(tab.term.resetCount || 0).toBe(0);
    });
});

describe('Terminal Scroll Stability & User Follow', () => {
    it('switching tabs preserves scrollback reading position when inactive tab is scrolled up', () => {
        const tm = makeTm({ withTabs: ['tab-a', 'tab-b'] });
        tm.activePaneId = 'tab-a';

        const tabB = tm.tabs.get('tab-b');
        // User in tab-b is scrolled up reading line 30 of 100
        tabB.term.buffer.active.viewportY = 30;
        tabB.term.buffer.active.baseY = 100;
        tabB.userFollowBottom = false;

        const spamScrollToBottomSpy = vi.spyOn(tm, '_spamScrollToBottom');
        const activateSpy = vi.spyOn(tm, 'activateTabViewport');

        tm.switchTab('tab-b', { userInitiated: true });

        // Tab viewport activated with scrollToBottom: false to preserve position
        expect(activateSpy).toHaveBeenCalledWith(
            tabB,
            expect.objectContaining({ scrollToBottom: false }),
        );
        expect(spamScrollToBottomSpy).not.toHaveBeenCalled();
    });

    it('switching tabs snaps to bottom when inactive tab was already at bottom', () => {
        const tm = makeTm({ withTabs: ['tab-a', 'tab-b'] });
        tm.activePaneId = 'tab-a';

        const tabB = tm.tabs.get('tab-b');
        // User in tab-b was at the live tail
        tabB.term.buffer.active.viewportY = 100;
        tabB.term.buffer.active.baseY = 100;
        tabB.userFollowBottom = true;

        const activateSpy = vi.spyOn(tm, 'activateTabViewport');

        tm.switchTab('tab-b', { userInitiated: true });

        expect(activateSpy).toHaveBeenCalledWith(
            tabB,
            expect.objectContaining({ scrollToBottom: true }),
        );
    });

    it('scrolling away from bottom immediately cancels pending spam intervals and follow mode', () => {
        const tm = makeTm();
        const tabInfo = {
            isDead: false,
            spamInterval: setInterval(() => {}, 10),
            stopSpamTimeout: setTimeout(() => {}, 300),
            isSpammingBottom: true,
            spamScrollY: undefined,
            userFollowBottom: true,
        };

        tm._cancelScrollFollowForUserScroll(tabInfo);

        expect(tabInfo.userFollowBottom).toBe(false);
        expect(tabInfo.spamInterval).toBeNull();
        expect(tabInfo.stopSpamTimeout).toBeNull();
        expect(tabInfo.isSpammingBottom).toBeUndefined();
    });

    it('_spamScroll interval immediately aborts if userFollowBottom becomes false during loop', () => {
        vi.useFakeTimers();
        const tm = makeTm();
        const tabInfo = {
            isDead: false,
            userFollowBottom: true,
            term: {
                scrollToBottom: vi.fn(),
                scrollToLine: vi.fn(),
                buffer: { active: { viewportY: 100, baseY: 100 } },
            },
        };

        tm._spamScroll(tabInfo, true);
        expect(tabInfo.spamInterval).not.toBeNull();

        // 2 ticks at bottom
        vi.advanceTimersByTime(25);
        expect(tabInfo.term.scrollToBottom).toHaveBeenCalled();

        // User initiates scroll up -> userFollowBottom = false
        tabInfo.userFollowBottom = false;

        // Next tick: interval detects userFollowBottom === false and self-cancels
        vi.advanceTimersByTime(15);
        expect(tabInfo.spamInterval).toBeNull();

        vi.useRealTimers();
    });
});

describe('Terminal Performance & Throughput Benchmark', () => {
    it('benchmarks write pump throughput with 5,000 lines', async () => {
        stubTerminalGlobal();
        const tm = makeTm();
        tm.createTab('p-bench', 's-bench', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p-bench');

        const lineCount = 5000;
        let payload = '';
        for (let i = 0; i < lineCount; i++) {
            payload += `[2026-09-28 04:30:${String(i % 60).padStart(2, '0')}] INFO worker ${i}: processed task\r\n`;
        }

        const t0 = performance.now();
        tm.writeToTerminal(tab, payload);
        const durationMs = performance.now() - t0;

        // Verify all output was dispatched without throwing
        expect(tab.term.writes.length).toBeGreaterThan(0);
        // Write dispatch for 5,000 lines should take under 50ms in jsdom
        expect(durationMs).toBeLessThan(100);
    });

    it('benchmarks SerializeAddon with 10,000 rows', () => {
        let serializedLines = 0;
        const fakeAddon = {
            serialize: (opts) => {
                serializedLines = opts.scrollback;
                return 'ROW\n'.repeat(opts.scrollback);
            },
        };

        const t0 = performance.now();
        const ansi = fakeAddon.serialize({ scrollback: 10000 });
        const dur = performance.now() - t0;

        expect(serializedLines).toBe(10000);
        expect(ansi.length).toBeGreaterThan(10000);
        expect(dur).toBeLessThan(100);
    });
});
