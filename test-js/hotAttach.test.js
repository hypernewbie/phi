// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import { PTYWebSocket } from '../web/ws.js';

// Hot-v1 client contract (see temp/TERMPERF.md). These tests pin the
// e2e behavior: fresh attach with checkpoint queues the snapshot and a
// bounded delta BEFORE open, reconnects resume from the drain watermark
// without resetting, gap repairs flush in order, and the legacy replay
// path is preserved for old servers.

setupDomHarness();

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
        this.onmessage({ data: buf });
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

describe('PTYWebSocket hot-v1 framing', () => {
    it('parses ATTACH_HEAD and holds live frames until release', () => {
        const data = vi.fn();
        const onAttachHead = vi.fn();
        const pty = new PTYWebSocket('p', data, null, null, null, {
            onAttachHead,
        });
        const ws = pty.ws;

        ws.emitAttachHead({ epoch: 7, oldest: 0, head: 10 });
        expect(pty.mode).toBe('hot');
        expect(onAttachHead).toHaveBeenCalledWith({
            epoch: 7,
            oldest: 0,
            head: 10,
            ckpt: null,
        });

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

    it('ATTACH_HEAD carries the opaque checkpoint', () => {
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
                ckpt: { through: 60, cols: 120, rows: 40, len: ansi.length },
            },
            ansi,
        );
        const info = onAttachHead.mock.calls[0][0];
        expect(info.ckpt.through).toBe(60);
        expect(info.ckpt.cols).toBe(120);
        expect(info.ckpt.ansi).toBe('\x1b[2Jscreen');
    });

    it('reports gaps, patches them, and flushes held frames in order', async () => {
        const data = vi.fn();
        const onGap = vi.fn();
        const pty = new PTYWebSocket('p', data, null, null, null, { onGap });
        pty.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 0 });
        pty.release();

        pty.ws.emitHot(0, 'a'); // 0..1
        pty.ws.emitHot(5, 'fghi'); // gap 1..5 held
        expect(onGap).toHaveBeenCalledWith(1, 5);
        expect(data).toHaveBeenCalledTimes(1);

        pty.applyGapPatch(new TextEncoder().encode('bcde'));
        expect(data.mock.calls[1]).toEqual(['bcde']);
        expect(data.mock.calls[2]).toEqual(['fghi']);
        expect(pty.liveSeq).toBe(9);
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

    it('legacy frames flip the mode and deliver like the old protocol', () => {
        const data = vi.fn();
        const onControl = vi.fn();
        const pty = new PTYWebSocket('p', data, onControl);
        pty.ws.emit(0x01, new TextEncoder().encode('replay'));
        expect(pty.mode).toBe('legacy');
        expect(data).toHaveBeenCalledWith('replay');
        pty.ws.emit(0x06, new Uint8Array(0));
        expect(onControl).toHaveBeenCalledWith({ type: 'replay-complete' });
    });
});

describe('TabManager hot attach bootstrap', () => {
    it('writes checkpoint + delta before open, then live continues', async () => {
        stubTerminalGlobal();
        const tm = makeTm();
        const fetchMock = vi
            .fn()
            .mockResolvedValue(recordingResponse('delta-bytes', 60, 100));
        vi.stubGlobal('fetch', fetchMock);

        tm.createTab('p1', 's1', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p1');
        expect(tab._termOpened).toBe(false);

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
        await flushBootstrap(tab);

        // Terminal sized to the checkpoint before anything renders.
        expect(tab.term.cols).toBe(120);
        // Order: checkpoint, then the fetched delta [60,100).
        expect(tab.term.writes).toEqual(['CHECKPOINT-ANSI', 'delta-bytes']);
        expect(tab.term.opened).toBe(true);
        expect(tab.drainedSeq).toBe(100);

        // Live frames continue in order after release.
        tab.ws.ws.emitHot(100, 'live!');
        expect(tab.term.writes[2]).toBe('live!');
        expect(tab.queuedSeq).toBe(105);
    });

    it('without checkpoint applies only a bounded tail delta', async () => {
        stubTerminalGlobal();
        const tm = makeTm();
        const tail = 'x'.repeat(64 * 1024 - 10);
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                recordingResponse(tail, 1_000_000 - 64 * 1024, 1_000_000),
            );
        vi.stubGlobal('fetch', fetchMock);

        tm.createTab('p2', 's2', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p2');
        tab.ws.ws.emitAttachHead({
            epoch: 9,
            oldest: 0,
            head: 1_000_000,
        });
        await new Promise((r) => setTimeout(r, 0));

        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining(`from=${1_000_000 - 64 * 1024}`),
            expect.anything(),
        );
        expect(tab.term.writes).toEqual([tail]);
        expect(tab.term.opened).toBe(true);
    });

    it('never queues a delta larger than the cap', async () => {
        stubTerminalGlobal();
        const tm = makeTm();
        const huge = 'y'.repeat(200 * 1024);
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
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(recordingResponse('missed', 50, 60)),
        );

        tm.createTab('p4', 's4', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p4');
        tab.ws.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 50 });
        await new Promise((r) => setTimeout(r, 0));
        expect(tab.term.writes).toEqual([]);

        // Simulate the pre-disconnect watermark.
        tab.drainedSeq = 50;
        tab.paneEpoch = 7;
        const priorWrites = tab.term.writes.length;
        tab._termOpened = true; // reconnect: terminal already open

        tab.ws.ws.emitAttachHead({ epoch: 7, oldest: 0, head: 60 });
        await new Promise((r) => setTimeout(r, 0));

        expect(tab.term.resetCount || 0).toBe(0);
        expect(tab.term.writes.length).toBe(priorWrites + 1);
        expect(tab.term.writes[tab.term.writes.length - 1]).toBe('missed');
        expect(tab.drainedSeq).toBe(60);
    });

    it('reconnect with a new epoch resets and re-bootstraps', async () => {
        stubTerminalGlobal();
        const tm = makeTm();
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(recordingResponse('fresh', 0, 5)),
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

    it('legacy replay keeps the reset-on-first-byte behavior', () => {
        stubTerminalGlobal();
        const tm = makeTm();
        tm.createTab('p6', 's6', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p6');

        // Server ignores term_proto: legacy frames only.
        tab.awaitingReplay = true; // reconnectTab sets this
        tab.ws.ws.emit(0x01, new TextEncoder().encode('full replay'));
        expect(tab.term.resetCount).toBe(1);
        expect(tab.term.writes).toEqual(['full replay']);
        expect(tab.term.opened).toBe(true);
    });
});

describe('checkpoint upload', () => {
    it('uploads a scrollback:0 snapshot with the drain watermark', async () => {
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

        expect(serializeOpts).toEqual({ scrollback: 0 });
        const [url, init] =
            fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
        expect(url).toContain('/api/terminals/p7/checkpoint');
        const body = JSON.parse(init.body);
        expect(body.epoch).toBe(7);
        expect(body.through).toBe(4321);
        expect(body.cols).toBe(100);
        expect(body.rows).toBe(30);
        expect(body.ansi).toBe('SNAPSHOT');
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
