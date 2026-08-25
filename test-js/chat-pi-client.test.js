// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    connectControl,
    ControlCallTimeout,
    ControlCallError,
} from '../web/chat-pi/client.js';

const liveClients = [];

function trackedClient() {
    const client = connectControl();
    liveClients.push(client);
    return client;
}

class FakeWebSocket {
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        FakeWebSocket.instances.push(this);
    }

    send(raw) {
        this.sent.push(JSON.parse(raw));
    }

    open() {
        this.readyState = 1;
        this.onopen?.();
    }

    receive(frame) {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }

    fail() {
        this.onerror?.(new Error('socket failed'));
    }

    close() {
        this.readyState = 3;
        this.onclose?.();
    }
}

afterEach(() => {
    for (const client of liveClients.splice(0)) client.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
});

describe('Pi RPC ControlClient', () => {
    it('correlates calls by unique ids and delivers only sequenced events to listeners', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = trackedClient();
        const socket = FakeWebSocket.instances[0];
        const events = [];
        client.onMessage((event) => events.push(event));

        const spawn = client.call('spawn', undefined, { cwd: '/work/demo' });
        const prompt = client.call('prompt', 'sid-1', { message: 'hello' });
        socket.open();

        expect(socket.sent).toEqual([
            { t: 'hello', v: 1 },
            { t: 'call', id: 'c1', op: 'spawn', args: { cwd: '/work/demo' } },
            {
                t: 'call',
                id: 'c2',
                op: 'prompt',
                sid: 'sid-1',
                args: { message: 'hello' },
            },
        ]);
        socket.receive({
            t: 'res',
            id: 'c2',
            ok: true,
            data: { accepted: true },
        });
        await expect(prompt).resolves.toEqual({ accepted: true });
        socket.receive({
            t: 'evt',
            sid: 'sid-1',
            seq: 1,
            evt: 'stateChanged',
            data: {},
        });
        socket.receive({
            t: 'res',
            id: 'c1',
            ok: true,
            data: { sid: 'sid-1' },
        });
        await expect(spawn).resolves.toEqual({ sid: 'sid-1' });
        expect(events).toEqual([
            { t: 'evt', sid: 'sid-1', seq: 1, evt: 'stateChanged', data: {} },
        ]);
    });

    it('sends hello before a connected-state call can send hydrate', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = trackedClient();
        const socket = FakeWebSocket.instances[0];
        let hydrate;
        client.onConnectionState((state) => {
            if (state === 'connected')
                hydrate = client.call('hydrate', 'sid-1', {});
        });
        socket.open();

        expect(socket.sent).toEqual([
            { t: 'hello', v: 1 },
            { t: 'call', id: 'c1', op: 'hydrate', sid: 'sid-1', args: {} },
        ]);
        socket.receive({
            t: 'res',
            id: 'c1',
            ok: true,
            data: { lastSeq: 0 },
        });
        await expect(hydrate).resolves.toEqual({ lastSeq: 0 });
    });

    it('rejects a Pi/control response with its exact error and removes the pending call', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = trackedClient();
        const socket = FakeWebSocket.instances[0];
        const pending = client.call('setModel', 'sid-1', {
            provider: 'p',
            modelId: 'm',
        });
        socket.open();
        socket.receive({
            t: 'res',
            id: 'c1',
            ok: false,
            error: 'pi rejected model',
        });
        await expect(pending).rejects.toThrow('pi rejected model');

        const next = client.call('getState', 'sid-1', {});
        socket.receive({
            t: 'res',
            id: 'c2',
            ok: true,
            data: { model: 'fresh' },
        });
        await expect(next).resolves.toEqual({ model: 'fresh' });
    });

    it('times out a queued call and leaves no outbox timer or pending promise', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = trackedClient();
        const pending = client.call('hydrate', 'sid-1', {});
        vi.advanceTimersByTime(ControlCallTimeout);
        await expect(pending).rejects.toThrow('control call timeout');
        const socket = FakeWebSocket.instances[0];
        socket.open();
        expect(socket.sent).toEqual([{ t: 'hello', v: 1 }]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects close-before-open and socket-close pending calls', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const first = trackedClient();
        const firstSocket = FakeWebSocket.instances[0];
        const queued = first.call('spawn', undefined, { cwd: '/work/one' });
        first.close();
        await expect(queued).rejects.toThrow('control client closed');
        firstSocket.open();
        expect(firstSocket.sent).toEqual([]);

        const second = trackedClient();
        const secondSocket = FakeWebSocket.instances[1];
        const pending = second.call('prompt', 'sid-2', { message: 'wait' });
        secondSocket.open();
        secondSocket.close();
        await expect(pending).rejects.toThrow('control socket closed');
    });

    it('reconnects after transport loss, classifies ambiguity, and never replays the outbox', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const states = [];
        const client = trackedClient();
        const off = client.onConnectionState((state) => states.push(state));
        const first = FakeWebSocket.instances[0];
        first.open();
        const read = client.call('hydrate', 'sid-1', {});
        const write = client.call('queueSubmit', 'sid-1', {
            itemId: 'item-1',
        });
        first.fail();

        await expect(read).rejects.toMatchObject({
            op: 'hydrate',
            uncertain: false,
        });
        await expect(write).rejects.toMatchObject({
            op: 'queueSubmit',
            uncertain: true,
        });
        expect(states).toEqual(['connecting', 'connected', 'reconnecting']);

        vi.advanceTimersByTime(1000);
        const second = FakeWebSocket.instances[1];
        second.open();
        expect(second.sent).toEqual([{ t: 'hello', v: 1 }]);
        expect(states.at(-1)).toBe('connected');
        expect(second.sent.some((frame) => frame.op === 'queueSubmit')).toBe(
            false,
        );

        const next = client.call('getState', 'sid-1', {});
        expect(second.sent.at(-1)).toMatchObject({ op: 'getState' });
        second.receive({
            t: 'res',
            id: second.sent.at(-1).id,
            ok: true,
            data: { ready: true },
        });
        await expect(next).resolves.toEqual({ ready: true });

        off();
        const closedStates = [];
        const offClosed = client.onConnectionState((state) =>
            closedStates.push(state),
        );
        client.close();
        expect(closedStates.at(-1)).toBe('closed');
        offClosed();
        vi.advanceTimersByTime(30_000);
        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(ControlCallError).toBeDefined();
    });

    it('retries immediately when the browser reports that it is online', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const states = [];
        const client = trackedClient();
        client.onConnectionState((state) => states.push(state));
        const first = FakeWebSocket.instances[0];
        first.open();
        first.close();

        expect(FakeWebSocket.instances).toHaveLength(1);
        window.dispatchEvent(new Event('online'));

        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(states).toEqual(['connecting', 'connected', 'reconnecting']);
        client.close();
    });

    it('retries when the initial WebSocket constructor throws', async () => {
        vi.useFakeTimers();
        let attempts = 0;
        class ThrowOnceWebSocket extends FakeWebSocket {
            constructor(url) {
                attempts += 1;
                if (attempts === 1) throw new Error('not listening');
                super(url);
            }
        }
        vi.stubGlobal('WebSocket', ThrowOnceWebSocket);
        const states = [];
        const client = trackedClient();
        client.onConnectionState((state) => states.push(state));
        vi.advanceTimersByTime(1000);
        expect(ThrowOnceWebSocket.instances).toHaveLength(1);
        expect(states).toContain('reconnecting');
        client.close();
    });
});
