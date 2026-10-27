// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectControl, ControlCallTimeout } from '../web/chat-pi/client.js';
import { MaxControlMessageBytes } from '../web/chat-pi/control-wire.js';
import {
    ControlClientFrame,
    ControlServerFrame,
} from '../web/proto/control.js';
import { installToken, __test__ } from '../web/auth.js';

class FakeWebSocket {
    static instances = [];

    constructor(url) {
        this.url = url;
        this.binaryType = '';
        this.readyState = 0;
        this.sent = [];
        this.closed = false;
        FakeWebSocket.instances.push(this);
    }

    send(raw) {
        this.sent.push(ControlClientFrame.decode(new Uint8Array(raw)));
    }

    open() {
        this.readyState = 1;
        this.onopen?.();
    }

    receive(frame) {
        const bytes = ControlServerFrame.encode(
            ControlServerFrame.fromPartial(frame),
        ).finish();
        this.onmessage?.({ data: new Uint8Array(bytes).buffer });
    }

    receiveRaw(chunk) {
        this.onmessage?.({ data: chunk });
    }

    fail() {
        this.onerror?.(new Error('socket failed'));
    }

    close() {
        this.readyState = 3;
        this.closed = true;
        this.onclose?.();
    }
}

function response(id, result) {
    return {
        payload: { $case: 'response', value: { id, result } },
    };
}

function stateFields(state) {
    return {
        sid: '',
        title: '',
        cwd: '',
        model: undefined,
        thinking: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
        contextUsedTokens: undefined,
        contextWindowTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
        skills: [],
        busy: false,
        status: '',
        queueDepth: 0,
        sessionPath: undefined,
        ...state,
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
    __test__.resetAccessState();
});

describe('Pi RPC ControlClient', () => {
    it('carries the v2 token on the control socket and omits it in v1', () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
        connectControl();
        const v1URL = new URL(FakeWebSocket.instances[0].url);
        expect(v1URL.pathname).toBe('/ws/control');
        expect(v1URL.searchParams.get('token')).toBeNull();

        FakeWebSocket.instances = [];
        installToken('jwt-a');
        connectControl();
        const v2URL = new URL(FakeWebSocket.instances[0].url);
        expect(v2URL.searchParams.get('token')).toBe('jwt-a');
    });

    it('correlates calls by unique ids and delivers only sequenced events to listeners', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        const socket = FakeWebSocket.instances[0];
        const events = [];
        client.onMessage((event) => events.push(event));

        const spawn = client.call('spawn', undefined, { cwd: '/work/demo' });
        const prompt = client.call('prompt', 'sid-1', { message: 'hello' });
        socket.open();

        expect(socket.sent).toHaveLength(3);
        expect(socket.sent[0].payload).toEqual({
            $case: 'hello',
            value: { version: 1 },
        });
        expect(socket.sent[1].payload).toEqual({
            $case: 'call',
            value: {
                id: 'c1',
                call: { $case: 'spawn', value: { cwd: '/work/demo' } },
            },
        });
        expect(socket.sent[2].payload).toEqual({
            $case: 'call',
            value: {
                id: 'c2',
                call: {
                    $case: 'prompt',
                    value: { sid: 'sid-1', message: 'hello' },
                },
            },
        });

        socket.receive(
            response('c2', { $case: 'prompt', value: { accepted: true } }),
        );
        await expect(prompt).resolves.toEqual({ accepted: true });

        socket.receive(
            response('c1', {
                $case: 'spawn',
                value: {
                    sid: 'sid-1',
                    title: 'demo',
                    cwd: '/work/demo',
                    session: { messages: [], lastSeq: 2n },
                    state: stateFields({
                        sid: 'sid-1',
                        title: 'demo',
                        cwd: '/work/demo',
                    }),
                },
            }),
        );
        await expect(spawn).resolves.toMatchObject({
            sid: 'sid-1',
            title: 'demo',
            snapshot: { lastSeq: 2, messages: [] },
            state: { sid: 'sid-1', title: 'demo', cwd: '/work/demo' },
        });

        socket.receive({
            payload: {
                $case: 'event',
                value: {
                    sid: 'sid-1',
                    seq: 3n,
                    event: {
                        $case: 'rpcExited',
                        value: { reason: 'done' },
                    },
                },
            },
        });
        expect(events).toEqual([
            {
                t: 'evt',
                sid: 'sid-1',
                seq: 3,
                evt: 'rpcExited',
                data: { reason: 'done' },
            },
        ]);
    });

    it('rejects a Pi/control response with its exact error and removes the pending call', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        const socket = FakeWebSocket.instances[0];
        const pending = client.call('setModel', 'sid-1', {
            provider: 'p',
            modelId: 'm',
        });
        socket.open();
        socket.receive(
            response('c1', {
                $case: 'error',
                value: { reason: 'pi rejected model' },
            }),
        );
        await expect(pending).rejects.toThrow('pi rejected model');
        expect(socket.closed).toBe(false);

        const next = client.call('getState', 'sid-1', {});
        socket.receive(
            response('c2', {
                $case: 'getState',
                value: { state: stateFields({ sid: 'sid-1', model: 'fresh' }) },
            }),
        );
        await expect(next).resolves.toMatchObject({ model: 'fresh' });
    });

    it('closes the stream and rejects every pending call on a mismatched variant', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        const socket = FakeWebSocket.instances[0];
        const pending = client.call('prompt', 'sid-1', { message: 'x' });
        const other = client.call('getState', 'sid-1', {});
        socket.open();
        socket.receive(
            response('c1', {
                $case: 'getState',
                value: { state: stateFields({ sid: 'sid-1' }) },
            }),
        );
        await expect(pending).rejects.toThrow(/does not match prompt/);
        await expect(other).rejects.toThrow(/does not match prompt/);
        expect(socket.closed).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('ignores late responses for expired or unknown request ids', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        const socket = FakeWebSocket.instances[0];
        socket.open();
        const events = [];
        client.onMessage((event) => events.push(event));
        socket.receive(
            response('gone', { $case: 'prompt', value: { accepted: true } }),
        );
        expect(socket.closed).toBe(false);
        expect(events).toEqual([]);
    });

    it('rejects an unknown operation or bad argument without sending it', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        const socket = FakeWebSocket.instances[0];
        socket.open();
        await expect(client.call('nope', 'sid-1', {})).rejects.toThrow(
            /unknown control operation/,
        );
        await expect(
            client.call('prompt', 'sid-1', { message: 42 }),
        ).rejects.toThrow(/message must be a string/);
        expect(socket.sent).toHaveLength(1);
        expect(socket.sent[0].payload.$case).toBe('hello');
        // Only the stability timer is armed; the refused calls armed nothing.
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('closes the stream on malformed or non-binary frames', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const frameClient = connectControl();
        const frameSocket = FakeWebSocket.instances[0];
        const pending = frameClient.call('getState', 'sid-1', {});
        frameSocket.open();
        frameSocket.receiveRaw(new Uint8Array([0xff, 0xff, 0xff]).buffer);
        await expect(pending).rejects.toThrow(/control frame is malformed/);
        expect(frameSocket.closed).toBe(true);

        const textClient = connectControl();
        const textSocket = FakeWebSocket.instances[1];
        const textPending = textClient.call('getState', 'sid-1', {});
        textSocket.open();
        textSocket.receiveRaw('{"t":"res"}');
        await expect(textPending).rejects.toThrow(/not binary/);
        expect(textSocket.closed).toBe(true);

        const emptyClient = connectControl();
        const emptySocket = FakeWebSocket.instances[2];
        const emptyPending = emptyClient.call('getState', 'sid-1', {});
        emptySocket.open();
        emptySocket.receiveRaw(new ArrayBuffer(0));
        await expect(emptyPending).rejects.toThrow(/control frame is empty/);
        expect(emptySocket.closed).toBe(true);
    });

    it('accepts an aggregate hydrate larger than the inbound call limit', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        const socket = FakeWebSocket.instances[0];
        const pending = client.call('hydrate', 'sid-1', {});
        socket.open();

        // The 16 MiB bound caps one inbound call. An aggregate transcript
        // snapshot is not capped, so the reader must not mirror that bound.
        const content = 'x'.repeat(16 * 1024 * 1024 + 1);
        socket.receive({
            payload: {
                $case: 'response',
                value: {
                    id: 'c1',
                    result: {
                        $case: 'hydrate',
                        value: {
                            session: {
                                messages: [
                                    {
                                        role: 'assistant',
                                        content: {
                                            kind: {
                                                $case: 'stringValue',
                                                value: content,
                                            },
                                        },
                                        ts: 1n,
                                    },
                                ],
                                lastSeq: 3n,
                                state: stateFields({ sid: 'sid-1' }),
                            },
                        },
                    },
                },
            },
        });

        const result = await pending;
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0].content).toBe(content);
        expect(result.lastSeq).toBe(3);
        expect(socket.closed).toBe(false);
    });

    it('keeps a call queued while the socket is down and times out only once it is written', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        const pending = client.call('hydrate', 'sid-1', {});
        // Offline is not a failure: the frame waits in the outbox, so its
        // deadline only starts when it reaches a socket.
        vi.advanceTimersByTime(ControlCallTimeout * 2);
        // The watchdog recycled the handshake that never opened; the call is
        // still queued, not failed.
        const socket = FakeWebSocket.instances.at(-1);
        socket.open();
        expect(socket.sent).toHaveLength(2);
        expect(socket.sent[0].payload.$case).toBe('hello');
        vi.advanceTimersByTime(ControlCallTimeout);
        await expect(pending).rejects.toThrow('control call timeout');
        expect(vi.getTimerCount()).toBe(0);
        client.close();
    });

    it('redials a dropped socket and reports only protocol faults', () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const report = vi.fn();
        const client = connectControl(report);
        const socket = FakeWebSocket.instances[0];
        const states = [];
        client.onState((connected) => states.push(connected));
        socket.open();

        // A dropped link is expected: report the state, then redial.
        socket.close();
        expect(report).not.toHaveBeenCalled();
        expect(states).toEqual([true, false]);
        vi.advanceTimersByTime(5_000);
        expect(FakeWebSocket.instances).toHaveLength(2);
        client.close();
        expect(report).not.toHaveBeenCalled();

        // A protocol fault is not fixed by redialing, so it is reported.
        const broken = connectControl(report);
        const brokenSocket = FakeWebSocket.instances.at(-1);
        brokenSocket.open();
        brokenSocket.receiveRaw(new ArrayBuffer(0));
        expect(report).toHaveBeenCalledTimes(1);
        expect(report).toHaveBeenLastCalledWith('control frame is empty');
        broken.close();
    });

    it('backs off further when a socket opens and drops again instead of recovering', () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        const delays = [];
        for (let attempt = 0; attempt < 3; attempt++) {
            const socket = FakeWebSocket.instances[attempt];
            socket.open();
            socket.close();
            const before = FakeWebSocket.instances.length;
            let waited = 0;
            // 0.7–1.3 jitter straddles the nominal delay.
            while (FakeWebSocket.instances.length === before) {
                vi.advanceTimersByTime(100);
                waited += 100;
                if (waited > 20_000) break;
            }
            delays.push(waited);
        }
        client.close();
        expect(FakeWebSocket.instances).toHaveLength(4);
        // Each reopen/close cycle costs more than the one before it.
        expect(delays[1]).toBeGreaterThan(delays[0]);
        expect(delays[2]).toBeGreaterThan(delays[1]);
    });

    it('resets the backoff once a socket stays up long enough to count', () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        FakeWebSocket.instances[0].open();
        FakeWebSocket.instances[0].close();
        vi.advanceTimersByTime(5_000);
        const second = FakeWebSocket.instances[1];
        second.open();
        // Hold this one well past the stability window, then drop it.
        vi.advanceTimersByTime(30_000);
        second.close();
        const before = FakeWebSocket.instances.length;
        let waited = 0;
        while (FakeWebSocket.instances.length === before) {
            vi.advanceTimersByTime(100);
            waited += 100;
            if (waited > 20_000) break;
        }
        client.close();
        // First-attempt delay again, not the third step of the backoff.
        expect(waited).toBeLessThanOrEqual(1_500);
    });

    it('rejects oversized outbound calls without closing the shared stream', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        const socket = FakeWebSocket.instances[0];
        socket.open();

        const oversized = client.call(
            'prompt',
            'sid-1',
            { message: 'x'.repeat(MaxControlMessageBytes) },
            { timeoutMs: 1 },
        );
        const result = oversized.then(
            () => null,
            (error) => error,
        );
        const sentBeforeTimeout = socket.sent.length;
        await vi.advanceTimersByTimeAsync(1);
        const error = await result;
        expect(sentBeforeTimeout).toBe(1);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toMatch(/message limit/);
        expect(socket.closed).toBe(false);

        const next = client.call('getState', 'sid-1', {});
        socket.receive(
            response('c2', {
                $case: 'getState',
                value: { state: stateFields({ sid: 'sid-1', model: 'fresh' }) },
            }),
        );
        await expect(next).resolves.toMatchObject({ model: 'fresh' });
        client.close();
    });

    it('keeps a frame the socket can no longer write instead of losing it', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        const socket = FakeWebSocket.instances[0];
        socket.open();
        // CLOSING: a native WebSocket buffers send() silently here, so the
        // frame must be held for the next socket instead.
        socket.readyState = 2;
        const pending = client.call('getState', 'sid-1', {});
        expect(socket.sent).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(5_000);
        const redialed = FakeWebSocket.instances[1];
        redialed.open();
        expect(redialed.sent.map((frame) => frame.payload.$case)).toEqual([
            'hello',
            'call',
        ]);
        redialed.receive(
            response(redialed.sent[1].payload.value.id, {
                $case: 'getState',
                value: { state: stateFields({ sid: 'sid-1' }) },
            }),
        );
        await expect(pending).resolves.toMatchObject({ sid: 'sid-1' });
        client.close();
    });

    it('redials on the browser online event even when a dial is stuck connecting', () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        FakeWebSocket.instances[0].open();
        FakeWebSocket.instances[0].close();
        // The redial never finishes its handshake: the network is gone, so
        // the browser neither opens nor fails the socket.
        vi.advanceTimersByTime(1_500);
        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(FakeWebSocket.instances[1].readyState).toBe(0);

        // The link returns and the browser says so.
        window.dispatchEvent(new Event('online'));
        expect(FakeWebSocket.instances.length).toBeGreaterThan(2);
        const fresh = FakeWebSocket.instances.at(-1);
        fresh.open();
        expect(fresh.sent[0].payload.$case).toBe('hello');
        client.close();
    });

    it('rejects written calls on a drop, keeps queued work, and replays it after the redial', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const first = connectControl();
        const firstSocket = FakeWebSocket.instances[0];
        const queued = first.call('spawn', undefined, { cwd: '/work/one' });
        first.close();
        await expect(queued).rejects.toThrow('control client closed');
        firstSocket.open();
        expect(firstSocket.sent).toEqual([]);

        const second = connectControl();
        const secondSocket = FakeWebSocket.instances[1];
        secondSocket.open();
        const written = second.call('prompt', 'sid-2', { message: 'wait' });
        secondSocket.close();
        // Written before the drop: its outcome is unknown, never replayed.
        await expect(written).rejects.toMatchObject({ transport: true });

        const later = second.call('prompt', 'sid-2', { message: 'later' });
        vi.advanceTimersByTime(5_000);
        const redialed = FakeWebSocket.instances[2];
        redialed.open();
        expect(redialed.sent).toHaveLength(2);
        const replayed = redialed.sent[1].payload.value;
        expect(replayed.call).toEqual({
            $case: 'prompt',
            value: { sid: 'sid-2', message: 'later' },
        });
        redialed.receive(
            response(replayed.id, {
                $case: 'prompt',
                value: { accepted: true },
            }),
        );
        await expect(later).resolves.toEqual({ accepted: true });
        second.close();
    });
});
