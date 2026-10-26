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
        commitSelect: { value: 'unstaged' },
        _setPanel: vi.fn(),
        fitTerminal: vi.fn(),
        pendingWrites,
        term: {
            clear: vi.fn(),
            resize: vi.fn(),
            write: vi.fn((_text, done) => {
                if (done) pendingWrites.push(done);
            }),
        },
    });
}

function sendPayload(pty, payload) {
    const frame = TerminalServerFrame.encode(
        TerminalServerFrame.fromPartial({ payload }),
    ).finish();
    pty.ws.onmessage({ data: new Uint8Array(frame).buffer });
}

function attach(pty, withCheckpoint = true) {
    sendPayload(pty, {
        $case: 'attach',
        value: {
            epoch: 7n,
            oldest: 0n,
            head: 40n,
            ...(withCheckpoint
                ? {
                      checkpoint: {
                          kind: 'ansi-v1',
                          through: 40n,
                          cols: 120,
                          rows: 30,
                          data: new TextEncoder().encode(ansi),
                      },
                  }
                : {}),
        },
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    mockFetch(() => ({ pane_id: 'log-pane' }));
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe('diff log attach wiring', () => {
    it('fits before attach, writes the checkpoint, and releases the real socket', async () => {
        const ctx = context();
        await ctx.refreshDiff();
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(1);
        const pty = ctx.currentWs;
        const release = vi.spyOn(pty, 'release');
        expect(fetch).toHaveBeenCalledWith(
            '/api/diff?cwd=%2Flinked%20tree&type=log&commit=unstaged',
        );
        attach(pty);
        expect(ctx.term.resize).toHaveBeenCalledWith(120, 30);
        expect(ctx.term.write).toHaveBeenCalledWith(ansi, expect.any(Function));
        expect(release).toHaveBeenCalledOnce();
        const checkpointOrder = ctx.term.write.mock.invocationCallOrder[1];
        expect(ctx.term.resize.mock.invocationCallOrder[0]).toBeLessThan(
            checkpointOrder,
        );
        expect(checkpointOrder).toBeLessThan(
            release.mock.invocationCallOrder[0],
        );
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(1);
        const live = '\x1b[32mlive output\x1b[0m\r\n';
        sendPayload(pty, {
            $case: 'output',
            value: { start: 40n, data: new TextEncoder().encode(live) },
        });
        expect(ctx.term.write).toHaveBeenLastCalledWith(live);
        expect(
            ctx.term.write.mock.calls.map(([text]) => text).slice(1),
        ).toEqual([ansi, live]);
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(1);
        ctx.pendingWrites.shift()();
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(2);
    });

    it('fits immediately and again after a delayed checkpoint parses', async () => {
        const ctx = context();
        await ctx.refreshDiff();
        vi.advanceTimersByTime(1000);
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(1);
        attach(ctx.currentWs);
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(1);
        ctx.pendingWrites.shift()();
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(2);
    });

    it('fits and releases an attach with no checkpoint', async () => {
        const ctx = context();
        await ctx.refreshDiff();
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(1);
        const release = vi.spyOn(ctx.currentWs, 'release');
        attach(ctx.currentWs, false);
        expect(release).toHaveBeenCalledOnce();
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(2);
        sendPayload(ctx.currentWs, {
            $case: 'output',
            value: { start: 40n, data: new TextEncoder().encode('live') },
        });
        expect(ctx.term.write).toHaveBeenLastCalledWith('live');
    });

    it('ignores a superseded socket attach, release, and fit', async () => {
        const ctx = context();
        await ctx.refreshDiff();
        const first = ctx.currentWs;
        const staleAttach = first.onAttachHead;
        expect(staleAttach).toBeTypeOf('function');
        attach(first);
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
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(1);
        ctx.term.write.mockClear();
        staleAttach({ epoch: 7, oldest: 0, head: 40, ckpt: null });
        expect(ctx.term.write).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(ctx.fitTerminal).toHaveBeenCalledTimes(1);
    });
});
