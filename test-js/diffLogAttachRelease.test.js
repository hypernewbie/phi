// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { DiffController } from '../web/diff.js';
import { TabManager } from '../web/terminal.js';
import { TerminalServerFrame } from '../web/proto/terminal.js';
import { recordingEnvelope } from './_terminalReplayHarness.js';

setupDomHarness();
class FakeWebSocket {
    static OPEN = 1;
    constructor() {
        this.readyState = 1;
    }
    send() {}
    close() {
        this.closed = true;
    }
}
const encode = (text) => new TextEncoder().encode(text);
const ansi = '\x1b[2J\x1b[H\x1b[33mabc1234\x1b[0m\r\n';
function context() {
    const pendingWrites = [];
    return Object.assign(Object.create(DiffController.prototype), {
        app: {
            sessionsManager: { activeCWD: '/linked tree' },
            tabManager: Object.create(TabManager.prototype),
        },
        activeTab: 'log',
        isPanelOpen: true,
        currentWs: null,
        _diffStreamToken: 0,
        gitManageGeneration: 0,
        gitManageContextKey: '',
        gitManageRequestKey: '',
        gitManageMemory: new Map(),
        gitViewMemory: new Map(),
        gitFilesMemory: new Map(),
        gitManageRecord: null,
        gitManageRecordKey: '',
        gitManageInfo: null,
        gitManageInfoKey: '',
        gitFiles: [],
        gitFilesKey: '',
        gitFilesPending: new Set(),
        gitFilesStatus: '',
        gitFilesRequestKey: '',
        gitManageCancels: new Set(),
        gitManageRetryTimer: null,
        gitManageRetryDelay: 1000,
        commitSelect: { value: 'unstaged' },
        _setPanel: vi.fn(),
        fitTerminal: vi.fn(),
        pendingWrites,
        term: {
            clear: vi.fn(),
            reset: vi.fn(),
            resize: vi.fn(),
            write: vi.fn((_text, done) => {
                if (done) pendingWrites.push(done);
            }),
        },
    });
}
function send(pty, type, value) {
    const frame = TerminalServerFrame.encode(
        TerminalServerFrame.fromPartial({ payload: { $case: type, value } }),
    ).finish();
    pty.ws.onmessage({ data: new Uint8Array(frame).buffer });
}
function attach(pty, head, ordinal = 0) {
    send(pty, 'attach', {
        epoch: 7n,
        oldest: 0n,
        head: BigInt(head),
        initialCols: 120,
        initialRows: 30,
        eventCursor: `v1.7.${head}.${ordinal}`,
    });
}
async function tick() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
}
let replayResponder;
beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    replayResponder = async () => ({ ok: false, status: 404 });
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url) => {
            const u = new URL(String(url), window.location.href);
            if (u.pathname.endsWith('/replay')) return replayResponder(u);
            if (u.pathname === '/api/git/raw-log')
                return {
                    ok: false,
                    status: 404,
                    headers: { get: () => null },
                    text: async () => 'Not found',
                };
            const body = { pane_id: 'log-pane' };
            return {
                ok: true,
                status: 200,
                headers: { get: () => 'application/json' },
                json: async () => body,
                text: async () => JSON.stringify(body),
            };
        }),
    );
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('diff log replay', () => {
    it('chains fenced pages only after parsing the prior page, then releases live output', async () => {
        const ctx = context();
        const bytes = encode(ansi);
        const head = bytes.length * 2;
        const queries = [];
        replayResponder = async (u) => {
            queries.push(u.searchParams);
            const from = Number(u.searchParams.get('from'));
            return recordingEnvelope(bytes, from, from + bytes.length, {
                initial_cols: 120,
                initial_rows: 30,
            });
        };
        await ctx.refreshDiff();
        const pty = ctx.currentWs;
        const release = vi.spyOn(pty, 'release');
        attach(pty, head);
        await tick();
        expect(queries).toHaveLength(1);
        expect(release).not.toHaveBeenCalled();
        expect(ctx.term.write).toHaveBeenCalledWith(ansi, expect.any(Function));
        ctx.pendingWrites.shift()();
        await tick();
        expect(queries).toHaveLength(2);
        expect(queries[1].get('after_event_cursor')).toBe(
            `v1.7.${bytes.length}.0`,
        );
        for (const q of queries)
            expect(q.get('through_event_cursor')).toBe(`v1.7.${head}.0`);
        expect(release).not.toHaveBeenCalled();
        ctx.pendingWrites.shift()();
        await tick();
        expect(release).toHaveBeenCalledOnce();
        send(pty, 'output', { start: BigInt(head), data: encode('live') });
        expect(ctx.term.write).toHaveBeenLastCalledWith('live');
    });

    it('applies a page resize after earlier text parses and before later text', async () => {
        const ctx = context();
        replayResponder = async () =>
            recordingEnvelope(encode('abcd'), 0, 4, {
                event_cursor: 'v1.7.4.1',
                resizes: [[2, 100, 20]],
            });
        await ctx.refreshDiff();
        attach(ctx.currentWs, 4, 1);
        await tick();
        expect(ctx.term.write).toHaveBeenLastCalledWith(
            'ab',
            expect.any(Function),
        );
        expect(ctx.term.resize).not.toHaveBeenCalledWith(100, 20);
        ctx.pendingWrites.shift()();
        await tick();
        expect(ctx.term.resize).toHaveBeenCalledWith(100, 20);
        expect(ctx.term.write).toHaveBeenLastCalledWith(
            'cd',
            expect.any(Function),
        );
        ctx.pendingWrites.shift()();
        await tick();
    });

    it('replays geometry even when the attach byte head is zero', async () => {
        const ctx = context();
        replayResponder = async () =>
            recordingEnvelope(new Uint8Array(), 0, 0, {
                event_cursor: 'v1.7.0.1',
                resizes: [[0, 100, 20]],
            });
        await ctx.refreshDiff();
        const release = vi.spyOn(ctx.currentWs, 'release');
        attach(ctx.currentWs, 0, 1);
        await tick();
        expect(ctx.term.resize).toHaveBeenCalledWith(100, 20);
        expect(release).toHaveBeenCalledOnce();
    });

    it('preserves split UTF-8 across replay and live output', async () => {
        const ctx = context();
        const bytes = encode('你');
        replayResponder = async () =>
            recordingEnvelope(bytes.slice(0, 1), 0, 1);
        await ctx.refreshDiff();
        const pty = ctx.currentWs;
        attach(pty, 1);
        await tick();
        ctx.pendingWrites.shift()();
        await tick();
        send(pty, 'output', { start: 1n, data: bytes.slice(1) });
        expect(ctx.term.write).toHaveBeenLastCalledWith('你');
        expect(
            ctx.term.write.mock.calls.map(([s]) => s).join(''),
        ).not.toContain('�');
    });

    it('does not release across a missing prefix or report successful recovery', async () => {
        const ctx = context();
        await ctx.refreshDiff();
        const pty = ctx.currentWs;
        const release = vi.spyOn(pty, 'release');
        attach(pty, 40);
        await tick();
        expect(release).not.toHaveBeenCalled();
        expect(pty.ws.closed).toBe(true);
        expect(ctx.term.write).toHaveBeenLastCalledWith(
            expect.stringContaining('History replay failed'),
        );
    });

    it('does not paint or release a replay superseded by another view', async () => {
        const ctx = context();
        let resolve;
        replayResponder = () =>
            new Promise((done) => {
                resolve = done;
            });
        await ctx.refreshDiff();
        const pty = ctx.currentWs;
        const release = vi.spyOn(pty, 'release');
        attach(pty, 4);
        await tick();
        ctx.currentWs = null;
        ctx.term.write.mockClear();
        resolve(recordingEnvelope(encode('old!'), 0, 4));
        await tick();
        expect(ctx.term.write).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
    });
});
