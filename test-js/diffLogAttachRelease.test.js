// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { DiffController } from '../web/diff.js';
import { TerminalServerFrame } from '../web/proto/terminal.js';

setupDomHarness();

class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.OPEN;
    }
    send() {}
    close() {}
}

const ansi = '\x1b[2J\x1b[H\x1b[33mabc1234\x1b[0m checkpoint\r\n';

function context() {
    const pendingWrites = [];
    return Object.assign(Object.create(DiffController.prototype), {
        app: { sessionsManager: { activeCWD: '/linked tree' } },
        activeTab: 'log',
        isPanelOpen: true,
        currentWs: null,
        _diffStreamToken: 0,
        gitManageMemory: new Map(),
        gitFiles: [],
        gitFilesKey: '',
        gitFilesMemory: new Map(),
        gitFilesPending: new Set(),
        gitFilesStatus: '',
        gitFilesRequestKey: '',
        gitViewMemory: new Map(),
        gitManageCancels: new Set(),
        gitManageRetryTimer: null,
        gitManageRetryDelay: 1000,
        gitManageGeneration: 0,
        gitManageContextKey: '',
        gitManageRequestKey: '',
        gitManageRecord: null,
        gitManageRecordKey: '',
        gitManageInfo: null,
        gitManageInfoKey: '',
        gitManageBusy: false,
        gitManageStatus: '',
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

function replayEnvelope(bytes, start, end, epoch = 7) {
    const json = new TextEncoder().encode(
        JSON.stringify({
            epoch,
            start,
            end,
            event_cursor: `v1.${epoch}.${end}.0`,
            resizes: [],
            initial_cols: 120,
            initial_rows: 30,
        }),
    );
    const body = new Uint8Array(4 + json.length + bytes.length);
    new DataView(body.buffer).setUint32(0, json.length, false);
    body.set(json, 4);
    body.set(bytes, 4 + json.length);
    return {
        ok: true,
        status: 200,
        arrayBuffer: async () => body.buffer.slice(0),
    };
}

// mockFetch cannot serve binary bodies, so the diff suite stubs fetch
// directly. replayResponder serves /replay; git routes keep the shapes
// the suite always used.
let replayResponder = async () => ({ ok: false, status: 404 });
function stubDiffFetch() {
    const fn = vi.fn(async (url) => {
        const u = new URL(String(url), window.location.href);
        if (u.pathname.endsWith('/replay')) return replayResponder(u);
        if (u.pathname === '/api/git/raw-log') {
            return {
                ok: false,
                status: 404,
                headers: { get: () => null },
                text: async () => 'Not found',
            };
        }
        const body = { pane_id: 'log-pane' };
        return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => body,
            text: async () => JSON.stringify(body),
        };
    });
    vi.stubGlobal('fetch', fn);
    return fn;
}

function sendPayload(pty, payload) {
    const frame = TerminalServerFrame.encode(
        TerminalServerFrame.fromPartial({ payload }),
    ).finish();
    pty.ws.onmessage({ data: new Uint8Array(frame).buffer });
}

function attach(pty, head = 40) {
    sendPayload(pty, {
        $case: 'attach',
        value: {
            epoch: 7n,
            oldest: 0n,
            head: BigInt(head),
            initialCols: 120,
            initialRows: 30,
            eventCursor: `v1.7.${head}.0`,
        },
    });
}

async function flushReplay() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    replayResponder = async () => ({ ok: false, status: 404 });
    stubDiffFetch();
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe('diff log attach wiring', () => {
    it('fits before attach, writes the replay, and releases the real socket', async () => {
        const ctx = context();
        const prefix = new TextEncoder().encode(ansi);
        replayResponder = async () => replayEnvelope(prefix, 0, 40);
        await ctx.refreshDiff();
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(1);
        const pty = ctx.currentWs;
        const release = vi.spyOn(pty, 'release');
        expect(
            fetch.mock.calls.some(
                ([url]) =>
                    url ===
                    '/api/diff?cwd=%2Flinked%20tree&type=log&commit=unstaged',
            ),
        ).toBe(true);
        const head = prefix.length;
        replayResponder = async () => replayEnvelope(prefix, 0, head);
        attach(pty, head);
        await flushReplay();
        expect(ctx.term.resize).toHaveBeenCalledWith(120, 30);
        expect(ctx.term.write).toHaveBeenCalledWith(ansi, expect.any(Function));
        expect(release).toHaveBeenCalledOnce();
        const replayOrder = ctx.term.write.mock.invocationCallOrder[1];
        expect(ctx.term.resize.mock.invocationCallOrder[0]).toBeLessThan(
            replayOrder,
        );
        expect(replayOrder).toBeLessThan(release.mock.invocationCallOrder[0]);
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(1);
        const live = '\x1b[32mlive output\x1b[0m\r\n';
        sendPayload(pty, {
            $case: 'output',
            value: { start: BigInt(head), data: new TextEncoder().encode(live) },
        });
        expect(ctx.term.write).toHaveBeenLastCalledWith(live);
        expect(
            ctx.term.write.mock.calls.map(([text]) => text).slice(1),
        ).toEqual([ansi, live]);
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(1);
        ctx.pendingWrites.shift()();
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(2);
    });

    it('fits immediately and again after a delayed replay parses', async () => {
        const ctx = context();
        const prefix = new TextEncoder().encode(ansi);
        const head = prefix.length;
        replayResponder = async () => replayEnvelope(prefix, 0, head);
        await ctx.refreshDiff();
        vi.advanceTimersByTime(1000);
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(1);
        attach(ctx.currentWs, head);
        await flushReplay();
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(1);
        ctx.pendingWrites.shift()();
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(2);
    });

    it('fits and releases an attach with an empty prefix', async () => {
        const ctx = context();
        await ctx.refreshDiff();
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(1);
        const release = vi.spyOn(ctx.currentWs, 'release');
        attach(ctx.currentWs, 0);
        await flushReplay();
        expect(release).toHaveBeenCalledOnce();
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(2);
        sendPayload(ctx.currentWs, {
            $case: 'output',
            value: { start: 0n, data: new TextEncoder().encode('live') },
        });
        expect(ctx.term.write).toHaveBeenLastCalledWith('live');
    });

    it('ignores a superseded socket attach, release, and fit', async () => {
        const ctx = context();
        const prefix = new TextEncoder().encode(ansi);
        const head = prefix.length;
        replayResponder = async () => replayEnvelope(prefix, 0, head);
        await ctx.refreshDiff();
        const first = ctx.currentWs;
        const staleAttach = first.onAttachHead;
        expect(staleAttach).toBeTypeOf('function');
        attach(first, head);
        await flushReplay();
        ctx.pendingWrites.shift()();
        const close = vi.spyOn(first, 'close');
        const release = vi.spyOn(first, 'release');
        ctx.fitTerminal.mockClear();
        await ctx.refreshDiff();
        expect(close).toHaveBeenCalledOnce();
        expect(close.mock.invocationCallOrder[0]).toBeLessThan(
            ctx.term.clear.mock.invocationCallOrder[1],
        );
        expect(ctx.currentWs).not.toBe(first);
        expect(first.ws.onmessage).toBeNull();
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(2);
        ctx.term.write.mockClear();
        staleAttach({
            epoch: 7,
            oldest: 0,
            head: 40,
            initialCols: 120,
            initialRows: 30,
            eventCursor: 'v1.7.40.0',
        });
        await flushReplay();
        expect(release).not.toHaveBeenCalled();
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(2);
    });

    it('decodes a replay that ends mid-codepoint with the live stream', async () => {
        const ctx = context();
        await ctx.refreshDiff();
        const pty = ctx.currentWs;
        const full = 'bounded screen \u4f60 live\r\n';
        const bytes = new TextEncoder().encode(full);
        const cut = new TextEncoder().encode('bounded screen ').length + 1;
        replayResponder = async () => replayEnvelope(bytes.slice(0, cut), 0, cut);
        attach(pty, cut);
        await flushReplay();
        const replayText = ctx.term.write.mock.calls.at(-1)[0];
        expect(replayText).toBe('bounded screen ');
        expect(replayText).not.toContain('\ufffd');
        sendPayload(pty, {
            $case: 'output',
            value: { start: BigInt(cut), data: bytes.slice(cut) },
        });
        expect(replayText + ctx.term.write.mock.calls.at(-1)[0]).toBe(full);
    });

    it('sends the attach fence with the replay fetch', async () => {
        const ctx = context();
        const prefix = new TextEncoder().encode(ansi);
        const head = prefix.length;
        replayResponder = async () => replayEnvelope(prefix, 0, head);
        await ctx.refreshDiff();
        attach(ctx.currentWs, head);
        await flushReplay();
        const replayUrl = fetch.mock.calls
            .map(([url]) => String(url))
            .find((url) => url.includes('/replay?'));
        expect(replayUrl).toContain(`through_event_cursor=v1.7.${head}.0`);
    });

    it('chains replay pages past the 2 MiB server cap', async () => {
        const ctx = context();
        const full = new TextEncoder().encode(ansi + ansi);
        const cut = new TextEncoder().encode(ansi).length;
        const head = full.length;
        replayResponder = async (u) => {
            const from = Number(u.searchParams.get('from'));
            if (from === 0) return replayEnvelope(full.slice(0, cut), 0, cut);
            return replayEnvelope(full.slice(cut), cut, head);
        };
        await ctx.refreshDiff();
        attach(ctx.currentWs, head);
        await flushReplay();
        expect(ctx.term.write).toHaveBeenCalledWith(
            ansi + ansi,
            expect.any(Function),
        );
    });

    it('shows live output when the replay fetch fails', async () => {
        const ctx = context();
        await ctx.refreshDiff();
        const release = vi.spyOn(ctx.currentWs, 'release');
        attach(ctx.currentWs, 40);
        await flushReplay();
        expect(release).toHaveBeenCalledOnce();
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(2);
        sendPayload(ctx.currentWs, {
            $case: 'output',
            value: { start: 40n, data: new TextEncoder().encode('live') },
        });
        expect(ctx.term.write).toHaveBeenLastCalledWith('live');
    });

    it('drops a streaming response the user already replaced', async () => {
        const ctx = context();
        let resolveLog;
        mockFetch((url) => {
            const path = new URL(url, window.location.href).pathname;
            if (path === '/api/git/raw-log')
                return { ok: false, status: 404, text: 'Not found' };
            if (path === '/api/diff')
                return new Promise((resolve) => {
                    resolveLog = resolve;
                });
            return { text: 'raw diff body' };
        });
        const slow = ctx.refreshDiff();
        await vi.waitFor(() => expect(resolveLog).toBeTypeOf('function'));
        ctx.activeTab = 'diff';
        await ctx.refreshDiff();
        resolveLog({ pane_id: 'stale-pane' });
        await slow;
        expect(ctx.currentWs).toBeNull();
        expect(
            ctx.term.write.mock.calls.map(([text]) => text).join(''),
        ).not.toContain('checkpoint');
    });
});
