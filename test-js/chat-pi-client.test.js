// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectControl, ControlCallTimeout } from '../web/chat-pi/client.js';
import { MaxControlMessageBytes } from '../web/chat-pi/control-wire.js';
import {
    ControlClientFrame,
    ControlServerFrame,
} from '../web/proto/control.js';

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
});

describe('Pi RPC ControlClient', () => {
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

    it('times out a queued call and leaves no outbox timer or pending promise', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        const pending = client.call('hydrate', 'sid-1', {});
        vi.advanceTimersByTime(ControlCallTimeout);
        await expect(pending).rejects.toThrow('control call timeout');
        const socket = FakeWebSocket.instances[0];
        socket.open();
        expect(socket.sent).toHaveLength(1);
        expect(socket.sent[0].payload.$case).toBe('hello');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reports unexpected close or error while idle, but not intentional close', () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const report = vi.fn();

        connectControl(report);
        const remoteSocket = FakeWebSocket.instances[0];
        remoteSocket.open();
        remoteSocket.close();
        expect(report).toHaveBeenCalledTimes(1);
        expect(report).toHaveBeenLastCalledWith('control socket closed');

        connectControl(report);
        const failedSocket = FakeWebSocket.instances[1];
        failedSocket.open();
        failedSocket.fail();
        expect(report).toHaveBeenCalledTimes(2);
        expect(report).toHaveBeenLastCalledWith('control socket error');
        expect(failedSocket.closed).toBe(true);

        connectControl(report).close();
        expect(report).toHaveBeenCalledTimes(2);
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

    it('rejects close-before-open and socket-close pending calls', async () => {
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
        const pending = second.call('prompt', 'sid-2', { message: 'wait' });
        secondSocket.open();
        secondSocket.close();
        await expect(pending).rejects.toThrow('control socket closed');
    });
});
