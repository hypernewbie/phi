// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectControl, ControlCallTimeout } from '../web/chat-pi/client.js';

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

    it('rejects a Pi/control response with its exact error and removes the pending call', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
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
        const client = connectControl();
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
