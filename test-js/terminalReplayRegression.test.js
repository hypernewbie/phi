// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { createHeadlessSandbox } from './_xtermHeadless.js';
import { TabManager } from '../web/terminal.js';
import { PTYWebSocket } from '../web/ws.js';

setupDomHarness();
const { Terminal } = createHeadlessSandbox();
const encode = (s) => new TextEncoder().encode(s);

class WireSocket {
    constructor() {
        this.readyState = 1;
    }
    send() {}
    close() {
        this.closed = true;
    }
    emit(type, payload) {
        const frame = new Uint8Array(1 + payload.byteLength);
        frame[0] = type;
        frame.set(payload, 1);
        this.onmessage({ data: frame.buffer });
    }
    head(head = 0) {
        const json = encode(JSON.stringify({ epoch: 7, oldest: 0, head }));
        const payload = new Uint8Array(4 + json.length);
        new DataView(payload.buffer).setUint32(0, json.length, false);
        payload.set(json, 4);
        this.emit(0x08, payload);
    }
    output(start, bytes) {
        const payload = new Uint8Array(8 + bytes.length);
        new DataView(payload.buffer).setBigUint64(0, BigInt(start), false);
        payload.set(bytes, 8);
        this.emit(0x09, payload);
    }
}

function recording(bytes, start, end) {
    const json = encode(JSON.stringify({ epoch: 7, start, end, resizes: [] }));
    const body = new Uint8Array(4 + json.length + bytes.length);
    new DataView(body.buffer).setUint32(0, json.length, false);
    body.set(json, 4);
    body.set(bytes, 4 + json.length);
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer };
}

beforeEach(() => {
    vi.stubGlobal('WebSocket', WireSocket);
});

function framed(onData = vi.fn(), onGap = vi.fn(), head = 0) {
    const pty = new PTYWebSocket('p', onData, null, null, null, { onGap });
    pty.ws.head(head);
    return pty;
}

function screen(term) {
    return Array.from({ length: term.buffer.active.length }, (_, i) =>
        term.buffer.active.getLine(i).translateToString(true),
    );
}

function harness(source, head = 0) {
    const term = new Terminal({ cols: 80, rows: 8, scrollback: 2000 });
    const manager = Object.assign(Object.create(TabManager.prototype), {
        updateDocumentTitle: vi.fn(),
        _scheduleCheckpointUpload: vi.fn(),
    });
    const tab = {
        paneId: 'p',
        paneEpoch: 7,
        isDead: false,
        isBusy: true,
        writeBuffer: '',
        writePending: false,
        queuedSeq: 0,
        drainedSeq: 0,
        term,
        userFollowBottom: false,
    };
    const gaps = [];
    const pty = framed(
        (text) => manager._paneData(tab, text),
        (from, to) => {
            const task = manager._onLiveGap(tab, from, to);
            gaps.push(task);
            return task;
        },
        head,
    );
    tab.ws = pty;
    const fetch = vi.fn(async (url) => {
        const params = new URL(url, 'http://localhost').searchParams;
        const from = Number(params.get('from'));
        const to = Number(params.get('through'));
        return recording(source.slice(from, to), from, to);
    });
    vi.stubGlobal('fetch', fetch);
    return {
        manager,
        tab,
        pty,
        fetch,
        term,
        async settle() {
            let seen = 0;
            while (seen < gaps.length) {
                const pending = gaps.slice(seen);
                seen = gaps.length;
                await Promise.all(pending);
            }
            await manager._drainSettled(tab);
        },
    };
}

describe('overlap accounting', () => {
    it('never regresses the byte frontier when a live frame overlaps already delivered bytes', () => {
        const data = vi.fn();
        const gap = vi.fn();
        const pty = framed(data, gap);
        pty.release();
        pty.ws.output(0, encode('abc'));
        pty.ws.output(1, encode('bcdef'));
        expect(pty.liveSeq).toBe(6);
        expect(pty.lastFrameEnd).toBe(6);
        pty.ws.output(6, encode('!'));
        expect(data.mock.calls.map(([s]) => s).join('')).toBe('abcdef!');
        expect(gap).not.toHaveBeenCalled();
    });

    it('does not let a UTF-8 prefix cross an irreparable hole', () => {
        const data = vi.fn();
        const pty = framed(data);
        pty.release();
        pty.ws.output(0, new Uint8Array([0xe4]));
        pty.ws.output(2, new Uint8Array([0xbd, 0xa0]));
        pty.abandonGap(2);
        expect(data.mock.calls.map(([s]) => s).join('')).not.toContain('你');
        expect(pty.liveSeq).toBe(4);
    });

    it('does not trim an overlapping held frame twice on release', () => {
        const data = vi.fn();
        const pty = framed(data, vi.fn(), 5);
        pty.ws.output(3, encode('deFG'));
        pty.release();
        expect(data.mock.calls.map(([s]) => s).join('')).toBe('FG');
        expect(pty.liveSeq).toBe(7);
    });
});

describe('actual xterm byte-stream recovery', () => {
    const text = Array.from(
        { length: 32 },
        (_, i) =>
            `\x1b[3${i % 8}mrow ${i}: terminal capacity, overflow — 你好 🙂\x1b[0m\r\n`,
    ).join('');

    it.each([2, 70, 74, 106, 107, 108, 468])(
        'repairs a %i-byte hole without notices or screen corruption',
        async (gapSize) => {
            const source = encode(text);
            const h = harness(source);
            const baseline = new Terminal({
                cols: 80,
                rows: 8,
                scrollback: 2000,
            });
            try {
                await new Promise((resolve) => baseline.write(text, resolve));
                h.pty.release();
                h.pty.ws.output(0, source.slice(0, 17));
                h.pty.ws.output(17 + gapSize, source.slice(17 + gapSize));
                await h.settle();
                expect(h.fetch).toHaveBeenCalledOnce();
                expect(h.pty.liveSeq).toBe(source.length);
                expect(h.tab.drainedSeq).toBe(source.length);
                expect(screen(h.term)).toEqual(screen(baseline));
                expect(screen(h.term).join('\n')).not.toContain(
                    'output bytes dropped',
                );
            } finally {
                h.term.dispose();
                baseline.dispose();
            }
        },
    );

    it('serializes a burst of tiny holes and renders the original screen exactly once', async () => {
        const source = encode(text);
        const h = harness(source);
        const baseline = new Terminal({ cols: 80, rows: 8, scrollback: 2000 });
        try {
            await new Promise((resolve) => baseline.write(text, resolve));
            h.pty.release();
            h.pty.ws.output(0, source.slice(0, 17));
            let cursor = 17;
            for (const size of [2, 70, 74, 106, 107, 108, 468]) {
                cursor += size;
                h.pty.ws.output(cursor, source.slice(cursor, cursor + 13));
                cursor += 13;
            }
            h.pty.ws.output(cursor, source.slice(cursor));
            await h.settle();
            expect(h.fetch).toHaveBeenCalledTimes(7);
            expect(h.pty.liveSeq).toBe(source.length);
            expect(screen(h.term)).toEqual(screen(baseline));
        } finally {
            h.term.dispose();
            baseline.dispose();
        }
    });

    it('handles arbitrary UTF-8/ANSI chunk boundaries plus repeated overlaps without false gaps', async () => {
        const source = encode(text);
        const h = harness(source);
        const baseline = new Terminal({ cols: 80, rows: 8, scrollback: 2000 });
        try {
            await new Promise((resolve) => baseline.write(text, resolve));
            h.pty.release();
            for (let end = 7; end < source.length + 7; end += 7) {
                const through = Math.min(end, source.length);
                const from = Math.max(0, end - 10);
                h.pty.ws.output(from, source.slice(from, through));
                expect(h.pty.liveSeq).toBe(through);
            }
            await h.settle();
            expect(h.fetch).not.toHaveBeenCalled();
            expect(screen(h.term)).toEqual(screen(baseline));
        } finally {
            h.term.dispose();
            baseline.dispose();
        }
    });

    it('same-pane reconnect preserves scrollback and the reading position while recovering missed bytes', async () => {
        const before = 'old history\r\n'.repeat(24);
        const missed = 'missed 你好 🙂\r\n';
        const live = 'live tail\r\n';
        const source = encode(before + missed + live);
        const h = harness(source);
        try {
            h.pty.release();
            h.pty.ws.output(0, encode(before));
            await h.settle();
            h.tab._termOpened = true;
            h.term.scrollToLine(3);
            const reset = vi.spyOn(h.term, 'reset');
            const head = encode(before + missed).length;
            const next = framed(
                (s) => h.manager._paneData(h.tab, s),
                vi.fn(),
                head,
            );
            h.tab.ws = next;
            next.ws.output(head, encode(live));
            await h.manager._onAttachHead(h.tab, { epoch: 7, oldest: 0, head });
            await Promise.all(h.tab._pendingBootstraps || []);
            await h.manager._drainSettled(h.tab);
            const output = screen(h.term).join('\n');
            expect(output.match(/old history/g)).toHaveLength(24);
            expect(output.match(/missed 你好 🙂/g)).toHaveLength(1);
            expect(output.match(/live tail/g)).toHaveLength(1);
            expect(h.term.buffer.active.viewportY).toBe(3);
            expect(reset).not.toHaveBeenCalled();
            expect(h.tab.drainedSeq).toBe(source.length);
            next.close();
        } finally {
            h.term.dispose();
        }
    });

    it('waits for an outstanding parse before choosing the reconnect frontier, without replaying queued text twice', async () => {
        const before = 'already queued\r\n';
        const source = encode(`${before}missed while disconnected\r\n`);
        const h = harness(source);
        const write = h.term.write.bind(h.term);
        let parseFirst;
        let first = true;
        h.term.write = (data, callback) => {
            if (first) {
                first = false;
                parseFirst = () => write(data, callback);
            } else {
                write(data, callback);
            }
        };
        try {
            h.pty.release();
            h.pty.ws.output(0, encode(before));
            h.tab._termOpened = true;
            expect(h.tab.writePending).toBe(true);
            const next = framed(
                (s) => h.manager._paneData(h.tab, s),
                vi.fn(),
                source.length,
            );
            h.tab.ws = next;
            const attaching = h.manager._onAttachHead(h.tab, {
                epoch: 7,
                oldest: 0,
                head: source.length,
            });
            expect(h.fetch).not.toHaveBeenCalled();
            parseFirst();
            await attaching;
            await Promise.all(h.tab._pendingBootstraps || []);
            await h.manager._drainSettled(h.tab);
            expect(
                screen(h.term).filter((s) => s === 'already queued'),
            ).toHaveLength(1);
            expect(
                screen(h.term).filter((s) => s === 'missed while disconnected'),
            ).toHaveLength(1);
            expect(h.tab.drainedSeq).toBe(source.length);
            const request = new URL(
                h.fetch.mock.calls[0][0],
                'http://localhost',
            );
            expect(request.searchParams.get('from')).toBe(
                String(encode(before).length),
            );
            next.close();
        } finally {
            h.term.dispose();
        }
    });

    it('same-pane reconnect retains an unfinished UTF-8 prefix from the old socket', async () => {
        const source = encode('prefix 你好 🙂 ready\r\n');
        const cut = encode('prefix ').length + 1;
        const h = harness(source);
        try {
            h.pty.release();
            h.pty.ws.output(0, source.slice(0, cut));
            await h.settle();
            h.tab._termOpened = true;
            expect(h.tab.drainedSeq).toBe(cut);
            const next = framed(
                (s) => h.manager._paneData(h.tab, s),
                vi.fn(),
                source.length,
            );
            h.tab.ws = next;
            await h.manager._onAttachHead(h.tab, {
                epoch: 7,
                oldest: 0,
                head: source.length,
            });
            await Promise.all(h.tab._pendingBootstraps || []);
            await h.manager._drainSettled(h.tab);
            expect(screen(h.term)[0]).toBe('prefix 你好 🙂 ready');
            expect(h.tab.drainedSeq).toBe(source.length);
            next.close();
        } finally {
            h.term.dispose();
        }
    });

    it('keeps one UTF-8 decoder across a bootstrap/live boundary inside a character', async () => {
        const source = encode('你好 🙂 ready\r\n');
        const h = harness(source, 1); // attach head falls inside the first glyph
        try {
            h.pty.ws.output(1, source.slice(1)); // held behind the bootstrap
            h.manager._bootstrappedRelease(h.tab, h.pty, 0, 1);
            await Promise.all(h.tab._pendingBootstraps || []);
            await h.settle();
            expect(screen(h.term)[0]).toBe('你好 🙂 ready');
            expect(h.pty.liveSeq).toBe(source.length);
            expect(screen(h.term).join('\n')).not.toContain('\uFFFD');
        } finally {
            h.term.dispose();
        }
    });

    it.each(['\x1b[', '\x1b]0;unfinished title'])(
        'an unavailable gap reconnects without corrupting a partial escape or skipping its tail (%j)',
        async (prefix) => {
            const from = encode(prefix).length;
            const source = encode(`${prefix}XXOK\r\n`);
            const h = harness(source);
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => ({ ok: false, status: 404 })),
            );
            try {
                h.pty.release();
                h.pty.ws.output(0, encode(prefix));
                h.pty.ws.output(from + 2, encode('OK\r\n'));
                await h.settle();
                const output = screen(h.term).join('\n');
                expect(h.pty.ws.closed).toBe(true);
                expect(h.pty.liveSeq).toBe(from);
                expect(output).not.toContain('output bytes dropped');
                expect(output).not.toContain('OK');
                expect(h.tab.drainedSeq).toBe(from);
            } finally {
                h.term.dispose();
            }
        },
    );
});
