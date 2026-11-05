// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import { PTYWebSocket, terminalSubprotocol } from '../web/ws.js';
import {
    TerminalClientFrame,
    TerminalServerFrame,
} from '../web/proto/terminal.js';

// Hot terminal client contract (see temp/SUPERHIGHWAY.md). These tests pin the
// e2e behavior: fresh attach replays the raw prefix BEFORE open, reconnects
// resume from the drain watermark without resetting, and gap repairs flush
// in order. No snapshot is ever served: geometry rides the attach and the
// replay pages.

setupDomHarness();

class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
        this.url = url;
        this.binaryType = '';
        this.readyState = 1;
        this.protocol = terminalSubprotocol;
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
        this.onmessage({ data: buf });
    }
    emitFrame(bytes) {
        this.onmessage({ data: new Uint8Array(bytes).buffer });
    }
    emitHot(startSeq, text) {
        const bytes =
            typeof text === 'string' ? new TextEncoder().encode(text) : text;
        this.emitFrame(
            TerminalServerFrame.encode(
                TerminalServerFrame.fromPartial({
                    payload: {
                        $case: 'output',
                        value: { start: BigInt(startSeq), data: bytes },
                    },
                }),
            ).finish(),
        );
    }
    emitAttachHead(hdr, extra) {
        const ckpt = hdr.ckpt
            ? {
                  ...(hdr.ckpt.kind !== undefined
                      ? { kind: hdr.ckpt.kind }
                      : {}),
                  through: BigInt(hdr.ckpt.through ?? 0),
                  cols: hdr.ckpt.cols ?? 0,
                  rows: hdr.ckpt.rows ?? 0,
                  data:
                      extra ??
                      (hdr.ckpt.ansi
                          ? new TextEncoder().encode(hdr.ckpt.ansi)
                          : new Uint8Array()),
                  ...(hdr.ckpt.eventCursor
                      ? { eventCursor: hdr.ckpt.eventCursor }
                      : {}),
              }
            : undefined;
        const epoch = hdr.epoch ?? 0;
        const head = hdr.head ?? 0;
        this.emitFrame(
            TerminalServerFrame.encode(
                TerminalServerFrame.fromPartial({
                    payload: {
                        $case: 'attach',
                        value: {
                            epoch: BigInt(epoch),
                            oldest: BigInt(hdr.oldest ?? 0),
                            head: BigInt(head),
                            ...(ckpt ? { checkpoint: ckpt } : {}),
                            ...(hdr.replay_from !== undefined
                                ? { replayFrom: BigInt(hdr.replay_from) }
                                : {}),
                            initialCols: hdr.initialCols ?? 80,
                            initialRows: hdr.initialRows ?? 24,
                            eventCursor:
                                hdr.eventCursor ?? `v1.${epoch}.${head}.0`,
                            ...(hdr.historyIncomplete !== undefined
                                ? { historyIncomplete: hdr.historyIncomplete }
                                : {}),
                            ...(hdr.ephemeral !== undefined
                                ? { ephemeral: hdr.ephemeral }
                                : {}),
                            floorEventCursor:
                                hdr.floorEventCursor ??
                                `v1.${epoch}.${hdr.oldest ?? 0}.0`,
                            floorCols: hdr.floorCols ?? hdr.initialCols ?? 80,
                            floorRows: hdr.floorRows ?? hdr.initialRows ?? 24,
                            ...(hdr.headCols !== undefined
                                ? { headCols: hdr.headCols }
                                : {}),
                            ...(hdr.headRows !== undefined
                                ? { headRows: hdr.headRows }
                                : {}),
                        },
                    },
                }),
            ).finish(),
        );
    }
    emitRefreshResult(result) {
        this.emitFrame(
            TerminalServerFrame.encode(
                TerminalServerFrame.fromPartial({
                    payload: {
                        $case: 'refreshResult',
                        value: {
                            ...(result.requestId !== undefined
                                ? { requestId: result.requestId }
                                : {}),
                            ...(result.outcome !== undefined
                                ? { outcome: result.outcome }
                                : {}),
                            ...(result.reason !== undefined
                                ? { reason: result.reason }
                                : {}),
                        },
                    },
                }),
            ).finish(),
        );
    }
}

function makeTm() {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;
    tm.tabsContainer = document.createElement('div');
    tm.terminalsWrapper = document.createElement('div');
    document.body.appendChild(tm.tabsContainer);
    document.body.appendChild(tm.terminalsWrapper);
    tm.app = {};
    tm.switchTab = vi.fn();
    tm.updateDocumentTitle = () => {};
    tm.syncBackendPin = () => {};
    return tm;
}

function stubTerminalGlobal() {
    const opened = [];
    const Terminal = function () {
        this.cols = 80;
        this.rows = 24;
        this.options = {};
        this.buffer = { active: { viewportY: 0, baseY: 0 } };
        this.writes = [];
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
        this.scrollToBottom = () => {};
        this.refresh = () => {};
        this._core = { viewport: { syncScrollArea: () => {} } };
    };
    vi.stubGlobal('Terminal', Terminal);
    vi.stubGlobal('FitAddon', { FitAddon: class {} });
    vi.stubGlobal('SearchAddon', { SearchAddon: class {} });
    return opened;
}

async function flushBootstrap(tab) {
    await Promise.all(tab._pendingBootstraps || []);
    await new Promise((r) => setTimeout(r, 0));
}

function recordingResponse(text, start, end, epoch = 7) {
    const bytes = new TextEncoder().encode(text.padEnd(end - start, ' '));
    const json = new TextEncoder().encode(
        JSON.stringify({
            epoch,
            start,
            end,
            event_cursor: `v1.${epoch}.${end}.0`,
            through: end,
            through_event_cursor: `v1.${epoch}.${end}.0`,
            resizes: [],
            initial_cols: 80,
            initial_rows: 24,
        }),
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

describe('PTYWebSocket hot framing', () => {
    it('parses ATTACH_HEAD and holds live frames until release', () => {
        const data = vi.fn();
        const onAttachHead = vi.fn();
        const pty = new PTYWebSocket('p', data, null, null, null, {
            onAttachHead,
        });
        const ws = pty.ws;

        ws.emitAttachHead({ epoch: 7, oldest: 0, head: 10 });
        expect(pty.mode).toBe('hot');
        expect(onAttachHead).toHaveBeenCalledWith(
            {
                epoch: 7,
                oldest: 0,
                head: 10,
                floorEventCursor: 'v1.7.0.0',
                floorCols: 80,
                floorRows: 24,
                ckpt: null,
                initialCols: 80,
                initialRows: 24,
                eventCursor: 'v1.7.10.0',
                historyIncomplete: false,
                ephemeral: false,
            },
            pty,
        );

        // Held: not delivered until release.
        ws.emitHot(10, 'hello');
        expect(data).not.toHaveBeenCalled();
        pty.release();
        expect(data).toHaveBeenCalledWith('hello');
        expect(pty.liveSeq).toBe(15);
        expect(pty.lastFrameEnd).toBe(15);

        // Post-release frames flow immediately and in order.
        ws.emitHot(15, '!');
        expect(data).toHaveBeenCalledWith('!');
    });

    it('ATTACH_HEAD carries the replay baseline and durability flags', () => {
        const onAttachHead = vi.fn();
        const pty = new PTYWebSocket('p', () => {}, null, null, null, {
            onAttachHead,
        });
        const ansi = new TextEncoder().encode('\x1b[2Jscreen');
        pty.ws.emitAttachHead(
            {
                epoch: 7,
                oldest: 0,
                head: 100,
                initialCols: 120,
                initialRows: 40,
                eventCursor: 'v1.7.100.3',
                historyIncomplete: true,
                ckpt: { through: 60, cols: 120, rows: 40, len: ansi.length },
            },
            ansi,
        );
        const info = onAttachHead.mock.calls[0][0];
        expect(info.initialCols).toBe(120);
        expect(info.initialRows).toBe(40);
        expect(info.eventCursor).toBe('v1.7.100.3');
        expect(info.historyIncomplete).toBe(true);
        expect(info.ephemeral).toBe(false);
        // The snapshot still parses for tolerance, but the client never
        // serves it: recovery always replays the raw prefix.
        expect(info.ckpt.through).toBe(60);
    });

    it('reports gaps, patches them, and flushes held frames in order', async () => {
        const data = vi.fn();
        const onGap = vi.fn();
        const pty = new PTYWebSocket('p', data, null, null, null, { onGap });
        pty.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 0 });
        pty.release();

        pty.ws.emitHot(0, 'a'); // 0..1
        pty.ws.emitHot(5, 'fghi'); // gap 1..5 held
        expect(onGap).toHaveBeenCalledWith(1, 5, pty);
        expect(data).toHaveBeenCalledTimes(1);

        pty.applyGapPatch(new TextEncoder().encode('bcde'));
        expect(data.mock.calls[1]).toEqual(['bcde']);
        expect(data.mock.calls[2]).toEqual(['fghi']);
        expect(pty.liveSeq).toBe(9);
    });

    it('flush stops at an internal gap instead of skipping bytes', () => {
        // Backpressure drops (deliverOrDrop) strand held frames across a
        // hole. Flushing across it would lose [102,110) silently; the
        // flush must stop and re-fire onGap so the host patches it.
        const data = vi.fn();
        const onGap = vi.fn();
        const pty = new PTYWebSocket('p', data, null, null, null, { onGap });
        pty.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 100 });
        pty.ws.emitHot(100, 'aa'); // held (pre-release)
        pty.ws.emitHot(110, 'bb'); // held; no gap decision before release
        expect(onGap).not.toHaveBeenCalled();
        pty.release();
        expect(data.mock.calls.map((c) => c[0])).toEqual(['aa']);
        expect(onGap).toHaveBeenCalledExactlyOnceWith(102, 110, pty);
        expect(pty.liveSeq).toBe(102);
        // Host patches the remainder; the held tail flushes in order.
        pty.applyGapPatch(new TextEncoder().encode('01234567'));
        expect(data.mock.calls.map((c) => c[0])).toEqual([
            'aa',
            '01234567',
            'bb',
        ]);
        expect(pty.liveSeq).toBe(112);
    });

    it('gap patch seq accounting uses raw byte length, not text length', () => {
        // Invalid UTF-8 re-encoded would be 6 bytes for 2 raw bytes and
        // drift liveSeq by 4, misaligning every frame after it.
        const data = vi.fn();
        const pty = new PTYWebSocket('p', data, null, null, null, {});
        pty.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 100 });
        pty.release();
        pty.applyGapPatch(new Uint8Array([0xff, 0xfe]));
        expect(pty.liveSeq).toBe(102);
        expect(pty.lastFrameEnd).toBe(102);
    });

    it('a rejecting gap host cannot break the socket pump', async () => {
        const data = vi.fn();
        const onGap = vi.fn(async () => {
            throw new Error('host boom');
        });
        const pty = new PTYWebSocket('p', data, null, null, null, { onGap });
        pty.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 0 });
        pty.release();
        pty.ws.emitHot(0, 'a');
        pty.ws.emitHot(5, 'fghi'); // gap 1..5, host rejects
        expect(onGap).toHaveBeenCalledWith(1, 5, pty);
        await new Promise((r) => setTimeout(r, 10));
        // Rejection observed internally: no unhandled error fails the run,
        // and the stream is intact for a later healthy patch.
        expect(data.mock.calls[0]).toEqual(['a']);
        expect(pty.liveSeq).toBe(1);
    });

    it('a throwing attach host cannot break the socket pump', () => {
        const data = vi.fn();
        const onAttachHead = vi.fn(() => {
            throw new Error('host boom');
        });
        const pty = new PTYWebSocket('p', data, null, null, null, {
            onAttachHead,
        });
        expect(() =>
            pty.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 0 }),
        ).not.toThrow();
        expect(onAttachHead).toHaveBeenCalled();
    });

    it('abandonGap skips the range and keeps live contiguous', () => {
        const data = vi.fn();
        const pty = new PTYWebSocket('p', data, null, null, null, {});
        pty.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 0 });
        pty.release();
        pty.ws.emitHot(0, 'a');
        pty.ws.emitHot(9, 'z');
        pty.abandonGap(9);
        expect(data.mock.calls[1]).toEqual(['z']);
        expect(pty.liveSeq).toBe(10);
    });

    it('preserves max-safe-integer epochs exactly (server masks to doublesafe)', () => {
        // Companion to the Go epoch-range gate: the wire carries epochs
        // as 64-bit integers decoded to bigint, so the client must not
        // lose low bits on the way in. MAX_SAFE_INTEGER has every low
        // bit set — the critical shape. Anything above it is a server
        // bug, not a client one.
        const data = vi.fn();
        let seen = null;
        const pty = new PTYWebSocket('p', data, null, null, null, {
            onAttachHead: (info) => {
                seen = info;
            },
        });
        pty.ws.emitAttachHead({
            epoch: Number.MAX_SAFE_INTEGER,
            oldest: 0,
            head: 10,
        });
        expect(seen.epoch).toBe(Number.MAX_SAFE_INTEGER);
        expect(pty.liveSeq).toBe(10);
    });

    it('a malformed ATTACH_HEAD closes so the host reconnects instead of holding forever', () => {
        const data = vi.fn();
        const onClose = vi.fn();
        const pty = new PTYWebSocket('p', data, null, onClose, null, {});
        const closeSpy = vi.spyOn(pty.ws, 'close');
        pty.ws.onmessage({ data: new Uint8Array([0xff, 0xff]).buffer }); // not a frame: malformed
        expect(closeSpy).toHaveBeenCalled();
        expect(pty.mode).toBe('unknown'); // never entered hot on garbage
        // The close event reaches the host, which owns reconnect/backoff.
        pty.ws.onclose();
        expect(onClose).toHaveBeenCalled();
    });

    it('superseded leading-byte frames close the socket instead of delivering', () => {
        // Old leading-byte terminal frames are not valid protobuf: an
        // old server fails closed so the host reconnect path (against
        // a matching server) can redial.
        const data = vi.fn();
        const onControl = vi.fn();
        const pty = new PTYWebSocket('p', data, onControl);
        const closeSpy = vi.spyOn(pty.ws, 'close');
        pty.ws.emit(0x01, new TextEncoder().encode('replay'));
        expect(closeSpy).toHaveBeenCalled();
        expect(pty.mode).toBe('unknown');
        expect(data).not.toHaveBeenCalled();
        pty.ws.emit(0x06, new Uint8Array(0));
        expect(onControl).not.toHaveBeenCalled();
    });

    it('encodes input, resize, and chunked pastes as generated frames', () => {
        const pty = new PTYWebSocket('p', () => {});
        const frames = () =>
            pty.ws.sent.map((b) =>
                TerminalClientFrame.decode(new Uint8Array(b)),
            );

        expect(pty.sendInput('hi')).toBe(true);
        expect(pty.sendResize(120, 40)).toBe(true);
        expect(pty.sendResize(0, 40)).toBe(false);
        expect(pty.sendResize(120, 70000)).toBe(false);
        let decoded = frames();
        expect(decoded).toHaveLength(2);
        expect(decoded[0].payload.$case).toBe('input');
        expect(Array.from(decoded[0].payload.value)).toEqual([
            ...new TextEncoder().encode('hi'),
        ]);
        expect(decoded[1].payload).toEqual({
            $case: 'resize',
            value: { cols: 120, rows: 40 },
        });

        // A paste larger than the chunk span goes out ordered and
        // byte-exact, with a multi-byte sequence straddling a boundary.
        const span = 1 * 1024 * 1024;
        const prefix = 'a'.repeat(span - 1);
        const paste = `${prefix}é${'b'.repeat(10)}`;
        pty.ws.sent.length = 0;
        expect(pty.sendInput(paste)).toBe(true);
        decoded = frames();
        expect(decoded.length).toBeGreaterThan(1);
        const total = decoded.reduce(
            (n, f) => n + f.payload.value.byteLength,
            0,
        );
        const joined = new Uint8Array(total);
        let at = 0;
        for (const f of decoded) {
            joined.set(f.payload.value, at);
            at += f.payload.value.byteLength;
        }
        expect(new TextDecoder().decode(joined)).toBe(paste);
        for (const f of decoded) {
            expect(f.payload.$case).toBe('input');
            expect(f.payload.value.byteLength).toBeLessThanOrEqual(span);
        }
    });
});

describe('TabManager hot attach bootstrap', () => {
    it('holds live until the replay enqueues: replay, live in order', async () => {
        // Busy-pane attach: live frames arriving during the replay fetch
        // must not jump ahead of it, or older bytes land below newer
        // ones and watermarks regress. A served snapshot, if any, is
        // ignored: recovery always replays the raw prefix.
        stubTerminalGlobal();
        const tm = makeTm();
        let resolveFetch;
        const gate = new Promise((r) => {
            resolveFetch = r;
        });
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(() => gate),
        );
        tm.createTab('p9', 's9', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p9');
        const ansi = new TextEncoder().encode('CHECKPOINT-ANSI');
        tab.ws.ws.emitAttachHead(
            {
                epoch: 7,
                oldest: 0,
                head: 100,
                ckpt: { through: 60, cols: 120, rows: 40, len: ansi.length },
            },
            ansi,
        );
        // Live arrives while the replay fetch is still in flight: held.
        tab.ws.ws.emitHot(100, 'live!');
        await new Promise((r) => setTimeout(r, 0));
        expect(tab.term.writes).toEqual([]);
        // Replay resolves: enqueued before the held live frames release.
        // The snapshot never paints.
        resolveFetch(recordingResponse('replay-bytes', 0, 100));
        await flushBootstrap(tab);
        expect(tab.term.writes).toEqual([
            'replay-bytes'.padEnd(100, ' '),
            'live!',
        ]);
        expect(tab.queuedSeq).toBe(105);
    });

    it('gap during the bootstrap window heals in order after release', async () => {
        // The exact tablet scenario: busy attach (live held for the
        // replay) plus a backpressure drop inside the held frames.
        // Expected stream: replay [0,100), live [100,102),
        // patch [102,110), held tail [110,112) — fully contiguous,
        // zero loss, zero duplication.
        stubTerminalGlobal();
        const tm = makeTm();
        const seenRanges = [];
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation((url) => {
                const m = String(url).match(/from=(\d+).*through=([^&]+)/);
                const from = Number(m[1]);
                seenRanges.push([from, m[2]]);
                if (from === 0)
                    return gateDelta.then(() =>
                        recordingResponse('D'.repeat(100), 0, 100),
                    );
                return Promise.resolve(
                    recordingResponse('P'.repeat(8), 102, 110),
                );
            }),
        );
        let resolveDelta;
        const gateDelta = new Promise((r) => {
            resolveDelta = r;
        });
        tm.createTab('p11', 's11', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p11');
        tab.ws.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 100 });
        tab.ws.ws.emitHot(100, 'aa');
        tab.ws.ws.emitHot(110, 'bb'); // dropped [102,110) behind it
        await new Promise((r) => setTimeout(r, 0));
        expect(tab.term.writes).toEqual([]);
        resolveDelta();
        await flushBootstrap(tab);
        // The gap-patch tail crosses fetch + message-callback chains;
        // poll for the settled write list instead of assuming tick
        // counts (fixed sleeps flake under parallel-suite load).
        {
            const deadline = Date.now() + 5000;
            for (;;) {
                if (tab.term.writes.length === 4) break;
                if (Date.now() > deadline) {
                    throw new Error(
                        `gap tail never settled (writes=${JSON.stringify(tab.term.writes)})`,
                    );
                }
                await new Promise((r) => setTimeout(r, 10));
            }
        }
        expect(seenRanges).toContainEqual([0, '100']);
        // Gap repair drains without a fence: through=latest, trimmed.
        expect(seenRanges).toContainEqual([102, 'latest']);
        // The superseded [100,110) gate-waiter dissolves: never fetched.
        expect(seenRanges).not.toContainEqual([100, 'latest']);
        expect(tab.term.writes).toEqual([
            'D'.repeat(100),
            'aa',
            'P'.repeat(8),
            'bb',
        ]);
        expect(tab.ws.liveSeq).toBe(112);
        expect(tab.queuedSeq).toBe(112);
    });

    it('stale bootstrap on socket swap writes nothing and releases nothing', async () => {
        stubTerminalGlobal();
        const tm = makeTm();
        let resolveFetch;
        const gate = new Promise((r) => {
            resolveFetch = r;
        });
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(() => gate),
        );
        tm.createTab('p10', 's10', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p10');
        const oldPty = tab.ws;
        const releaseSpy = vi.spyOn(oldPty, 'release');
        tab.ws.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 100 });
        // Reconnect swaps the socket while the delta fetch is in flight.
        tab.ws = { mode: 'hot', release: vi.fn() };
        resolveFetch(recordingResponse('stale-delta', 0, 100));
        await flushBootstrap(tab);
        await new Promise((r) => setTimeout(r, 0));
        expect(tab.term.writes).toEqual([]);
        // An advertised head is not a parsed frontier when its recording
        // request was superseded before any bytes reached xterm.
        expect(tab.queuedSeq).toBe(0);
        expect(tab.drainedSeq).toBe(0);
        expect(releaseSpy).not.toHaveBeenCalled();
    });

    it('writes the replay before open, then live continues', async () => {
        stubTerminalGlobal();
        const tm = makeTm();
        const fetchMock = vi
            .fn()
            .mockResolvedValue(recordingResponse('replay-bytes', 0, 100));
        vi.stubGlobal('fetch', fetchMock);

        tm.createTab('p1', 's1', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p1');
        expect(tab._termOpened).toBe(false);

        tab.ws.ws.emitAttachHead({
            epoch: 7,
            oldest: 0,
            head: 100,
            initialCols: 120,
            initialRows: 40,
        });
        await flushBootstrap(tab);

        // Terminal sized to the recorded geometry before anything renders.
        expect(tab.term.cols).toBe(120);
        expect(tab.term.writes).toEqual(['replay-bytes'.padEnd(100, ' ')]);
        expect(tab.term.opened).toBe(true);
        expect(tab.drainedSeq).toBe(100);

        // Live frames continue in order after release.
        tab.ws.ws.emitHot(100, 'live!');
        expect(tab.term.writes[1]).toBe('live!');
        expect(tab.queuedSeq).toBe(105);
    });

    it('without checkpoint applies the complete retained history', async () => {
        stubTerminalGlobal();
        const tm = makeTm();
        const history = 'x'.repeat(64 * 1024 - 10);
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                recordingResponse(history, 0, history.length, 9),
            );
        vi.stubGlobal('fetch', fetchMock);

        tm.createTab('p2', 's2', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p2');
        tab.ws.ws.emitAttachHead({
            epoch: 9,
            oldest: 0,
            head: history.length,
        });
        await new Promise((r) => setTimeout(r, 0));

        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('from=0'),
            expect.anything(),
        );
        expect(tab.term.writes).toEqual([history]);
        expect(tab.term.opened).toBe(true);
    });

    it('never queues a delta larger than the cap', async () => {
        stubTerminalGlobal();
        const tm = makeTm();
        const huge = 'y'.repeat(3 * 1024 * 1024);
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(recordingResponse(huge, 0, huge.length)),
        );

        tm.createTab('p3', 's3', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p3');
        tab.ws.ws.emitAttachHead({ epoch: 9, oldest: 0, head: 10 });
        await flushBootstrap(tab);
        expect(tab.term.writes).toEqual([]);
        expect(tab.term.opened).toBe(true);
    });

    it('reconnect with same epoch applies the small delta without reset', async () => {
        stubTerminalGlobal();
        const tm = makeTm();
        const fetchMock = vi.fn(async (url) => {
            const from = Number(
                new URL(url, 'http://localhost').searchParams.get('from'),
            );
            return from === 0
                ? recordingResponse('initial', 0, 50)
                : recordingResponse('missed', 50, 60);
        });
        vi.stubGlobal('fetch', fetchMock);

        tm.createTab('p4', 's4', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p4');
        tab.ws.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 50 });
        await flushBootstrap(tab);
        expect(tab.term.writes).toEqual(['initial'.padEnd(50, ' ')]);
        expect(tab.drainedSeq).toBe(50);

        // Reconnect resumes from the parser-confirmed frontier.
        const priorWrites = tab.term.writes.length;
        tab._termOpened = true; // reconnect: terminal already open

        tab.ws.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 60 });
        await new Promise((r) => setTimeout(r, 0));

        expect(tab.term.resetCount || 0).toBe(0);
        expect(tab.term.writes.length).toBe(priorWrites + 1);
        expect(tab.term.writes[tab.term.writes.length - 1]).toBe(
            'missed'.padEnd(10, ' '),
        );
        expect(tab.drainedSeq).toBe(60);
    });

    it('reconnect with a new epoch resets and re-bootstraps', async () => {
        stubTerminalGlobal();
        const tm = makeTm();
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(recordingResponse('fresh', 0, 5, 99)),
        );

        tm.createTab('p5', 's5', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p5');
        tab.ws.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 50 });
        await new Promise((r) => setTimeout(r, 0));
        tab.drainedSeq = 50;
        tab._termOpened = true;

        tab.ws.ws.emitAttachHead({ epoch: 99, oldest: 0, head: 5 });
        await new Promise((r) => setTimeout(r, 0));

        expect(tab.term.resetCount).toBe(1);
        expect(tab.term.writes).toEqual(['fresh']);
    });

    it('live output without attach closes instead of delivering', () => {
        // Without the atomic attach frontier no live byte is safe to
        // deliver: close so the host redials for an authoritative head.
        stubTerminalGlobal();
        const tm = makeTm();
        tm.createTab('p6', 's6', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p6');
        const closeSpy = vi.spyOn(tab.ws.ws, 'close');
        tab.awaitingReplay = true; // reconnectTab sets this
        tab.ws.ws.emitHot(0, 'full replay');
        expect(closeSpy).toHaveBeenCalled();
        expect(tab.term.writes).toEqual([]);
    });
});

describe('checkpoint upload', () => {
    it('uploads a scrollback snapshot preserving history with the drain watermark', async () => {
        stubTerminalGlobal();
        const tm = makeTm();
        let serializeOpts;
        const fakeAddon = {
            serialize: (o) => {
                serializeOpts = o;
                return 'SNAPSHOT';
            },
        };
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);

        tm.createTab('p7', 's7', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p7');
        tab.ws.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 50 });
        tab.serializeAddon = fakeAddon;
        tab.paneEpoch = 7;
        tab.drainedSeq = 4321;
        tab.term.cols = 100;
        tab.term.rows = 30;

        tm._uploadCheckpoint(tab);
        await new Promise((r) => setTimeout(r, 0));

        expect(serializeOpts).toEqual({ scrollback: 10000 });
        const request = fetchMock.mock.calls.find(
            ([url, init]) =>
                String(url).includes('/api/terminals/p7/checkpoint') &&
                init?.method === 'POST',
        );
        expect(request).toBeDefined();
        const [url, init] = request;
        expect(url).toContain('/api/terminals/p7/checkpoint');
        const body = JSON.parse(init.body);
        expect(body.epoch).toBe(7);
        expect(body.through).toBe(4321);
        expect(body.cols).toBe(100);
        expect(body.rows).toBe(30);
        expect(body.ansi).toBe('SNAPSHOT');
    });

    it('keeps uploading on a coarse pointer even when the server owns the state', () => {
        stubTerminalGlobal();
        const tm = makeTm();
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        // A phone cannot scroll a restored screen: its own snapshot is the
        // only ANSI state that carries scrollback, so it must keep refreshing
        // the stored checkpoint even after a server-state attach.
        const originalMatchMedia = window.matchMedia;
        window.matchMedia = (query) => ({
            matches: query === '(pointer: coarse)',
            media: query,
        });

        tm.createTab('p9', 's9', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p9');
        tab.ws.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 50 });
        tab.serializeAddon = { serialize: () => 'SNAPSHOT' };
        tab.paneEpoch = 7;
        tab.drainedSeq = 50;
        tab.term.cols = 63;
        tab.term.rows = 56;
        tab._serverStateAvailable = true;

        tm._uploadCheckpoint(tab);

        if (originalMatchMedia === undefined) delete window.matchMedia;
        else window.matchMedia = originalMatchMedia;
        const request = fetchMock.mock.calls.find(
            ([url, init]) =>
                String(url).includes('/api/terminals/p9/checkpoint') &&
                init?.method === 'POST',
        );
        expect(request).toBeDefined();
    });

    it('keeps a coarse snapshot inside the beacon body limit', async () => {
        stubTerminalGlobal();
        const tm = makeTm();
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        const sent = [];
        Object.defineProperty(window.navigator, 'sendBeacon', {
            configurable: true,
            value: (url, body) => {
                sent.push({ url, body });
                return true;
            },
        });
        const originalMatchMedia = window.matchMedia;
        window.matchMedia = (query) => ({
            matches: query === '(pointer: coarse)',
            media: query,
        });
        // Real output runs several hundred bytes per dense colored row, so a
        // 256-row phone snapshot can exceed the 64 KiB a beacon carries.
        let usedScrollback = 0;
        const rows = 56;

        try {
            tm.createTab('p10', 's10', 'T', 'bash', '', '', false);
            const tab = tm.tabs.get('p10');
            tab.ws.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 50 });
            tab.serializeAddon = {
                serialize: ({ scrollback }) => {
                    usedScrollback = scrollback;
                    return 'X'.repeat((scrollback + rows) * 400);
                },
            };
            tab.paneEpoch = 7;
            tab.drainedSeq = 50;
            tab.term.cols = 120;
            tab.term.rows = rows;
            tab._serverStateAvailable = true;

            tm._uploadCheckpoint(tab);
            await new Promise((r) => setTimeout(r, 0));
        } finally {
            delete window.navigator.sendBeacon;
            if (originalMatchMedia === undefined) delete window.matchMedia;
            else window.matchMedia = originalMatchMedia;
        }

        // A body the beacon refuses falls back to a fetch the browser aborts
        // on the next navigation, which is the whole point of the beacon.
        expect(
            fetchMock.mock.calls.filter(([url]) =>
                String(url).includes('/checkpoint'),
            ),
        ).toHaveLength(0);
        expect(sent).toHaveLength(1);
        expect(sent[0].url).toContain('/api/terminals/p10/checkpoint');
        expect(sent[0].body.size).toBeLessThanOrEqual(64 * 1024);
        expect(usedScrollback).toBeLessThan(256);
    });

    it('leaves a snapshot behind during output that never goes quiet', () => {
        stubTerminalGlobal();
        const tm = makeTm();
        const upload = vi
            .spyOn(tm, '_uploadCheckpoint')
            .mockImplementation(() => {});
        vi.useFakeTimers();
        const originalMatchMedia = window.matchMedia;
        window.matchMedia = (query) => ({
            matches: query === '(pointer: coarse)',
            media: query,
        });

        try {
            tm.createTab('p11', 's11', 'T', 'bash', '', '', false);
            const tab = tm.tabs.get('p11');
            tab.serializeAddon = { serialize: () => 'SNAPSHOT' };
            tab._ckptEnabled = true;
            // Every parsed batch re-arms the quiet timer, so continuous
            // output would otherwise never store a snapshot.
            for (let i = 0; i < 60; i++) {
                tm._scheduleCheckpointUpload(tab);
                vi.advanceTimersByTime(100);
            }
        } finally {
            vi.useRealTimers();
            if (originalMatchMedia === undefined) delete window.matchMedia;
            else window.matchMedia = originalMatchMedia;
        }

        expect(upload).toHaveBeenCalled();
    });

    it('drops the upload when the terminal is gone instead of throwing', () => {
        stubTerminalGlobal();
        const tm = makeTm();
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);

        tm.createTab('p8', 's8', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p8');
        tab.serializeAddon = { serialize: () => 'SNAPSHOT' };
        tab.paneEpoch = 7;
        tab.drainedSeq = 50;
        tab.term = undefined; // torn-down tab racing the quiet timer
        tab.ws = { mode: 'hot' };

        expect(() => tm._uploadCheckpoint(tab)).not.toThrow();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('a held live queue is bounded', () => {
    it('reconnects when held output exceeds the cap instead of growing without limit', () => {
        const data = vi.fn();
        const pty = new PTYWebSocket('p', data, null, null, null, {});
        const ws = pty.ws;
        ws.emitAttachHead({ epoch: 7, oldest: 0, head: 0 });
        const close = vi.spyOn(ws, 'close');
        pty.hold();

        // 2 MiB cap at 256 spans: 300 spans of 8 KiB must trip one of them.
        const chunk = new Uint8Array(8 * 1024).fill(65);
        let start = 0;
        for (let i = 0; i < 300; i++) {
            ws.emitHot(start, chunk);
            start += chunk.byteLength;
        }

        expect(close).toHaveBeenCalled();
        expect(data).not.toHaveBeenCalled();
    });
});

describe('PTYWebSocket head geometry framing', () => {
    it('parses head geometry only when the server sends it', () => {
        const pty = new PTYWebSocket('p', () => {}, null, null, null, {
            onAttachHead: () => {},
        });
        const seen = [];
        pty.onAttachHead = (info) => seen.push(info);
        pty.ws.emitAttachHead({ epoch: 7, oldest: 300, head: 400 });
        expect(seen[0].headCols).toBeUndefined();

        pty.ws.emitAttachHead({
            epoch: 7,
            oldest: 300,
            head: 400,
            headCols: 100,
            headRows: 40,
        });
        expect(seen[1].headCols).toBe(100);
        expect(seen[1].headRows).toBe(40);
    });
});
