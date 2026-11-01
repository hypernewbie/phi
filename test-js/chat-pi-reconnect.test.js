// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectControl } from '../web/chat-pi/client.js';
import { mountChatPi } from '../web/chat-pi/index.js';
import {
    ControlClientFrame,
    ControlServerFrame,
} from '../web/proto/control.js';

// End-to-end over the real control transport: a mounted chat, a socket that
// drops mid-prompt, and a redial. It exists to prove the delivery contract
// the unit tests only approximate: only never-written work replays, a
// written-but-unacknowledged prompt keeps its text, and the reconnect order
// is prompt-then-hydrate.
class FakeWebSocket {
    static instances = [];

    constructor(url) {
        this.url = url;
        this.binaryType = '';
        this.readyState = 0;
        this.sent = [];
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

    close() {
        this.readyState = 3;
        this.onclose?.({ code: 1006 });
    }
}

function controlState(over = {}) {
    return {
        sid: 's1',
        title: 'demo',
        cwd: '/work/demo',
        skills: [],
        busy: false,
        status: 'live',
        queueDepth: 0,
        ...over,
    };
}

function reply(socket, id, result) {
    socket.receive({ payload: { $case: 'response', value: { id, result } } });
}

function calls(socket, op) {
    return socket.sent
        .filter((frame) => frame.payload?.$case === 'call')
        .map((frame) => frame.payload.value)
        .filter((call) => call.call.$case === op);
}

function promptTexts(socket) {
    return calls(socket, 'prompt').map((call) => call.call.value.message);
}

async function settle() {
    for (let index = 0; index < 4; index++) await Promise.resolve();
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
    document.body.replaceChildren();
});

describe('Pi chat over a real control socket', () => {
    it('replays only never-written work and keeps an unacknowledged prompt on screen', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const client = connectControl();
        const root = document.createElement('div');
        document.body.appendChild(root);
        const chat = mountChatPi(root, '/work/demo', client);
        const socket = FakeWebSocket.instances[0];
        socket.open();

        reply(socket, calls(socket, 'spawn')[0].id, {
            $case: 'spawn',
            value: {
                sid: 's1',
                title: 'demo',
                cwd: '/work/demo',
                session: { messages: [], lastSeq: 0n },
                state: controlState({ busy: true }),
            },
        });
        await settle();
        reply(socket, calls(socket, 'hydrate')[0].id, {
            $case: 'hydrate',
            value: { session: { messages: [], lastSeq: 0n } },
        });
        await settle();

        // A prompt is written, then the socket dies before its acknowledgement.
        expect(chat.send('first')).toBe(true);
        expect(promptTexts(socket)).toEqual(['first']);
        socket.close();
        await settle();
        expect(root.textContent).toContain('first');
        expect(root.textContent).toContain('Not confirmed');

        // A prompt typed during the outage waits in the outbox: nothing is
        // written and nothing is lost.
        expect(chat.send('second')).toBe(true);
        expect(promptTexts(socket)).toEqual(['first']);
        expect(root.textContent).toContain('second');

        // Redial: only the never-written prompt is replayed, and it goes out
        // before the reconnect resync. The advance stays below the dial
        // watchdog, so the first redial is the one that opens.
        await vi.advanceTimersByTimeAsync(5_000);
        const redialed = FakeWebSocket.instances[1];
        redialed.open();
        expect(promptTexts(redialed)).toEqual(['second']);
        const frameCases = redialed.sent
            .map((frame) => frame.payload?.$case)
            .filter(Boolean);
        expect(frameCases.slice(0, 2)).toEqual(['hello', 'call']);
        expect(redialed.sent[1].payload.value.call.$case).toBe('prompt');
        expect(redialed.sent[2].payload.value.call.$case).toBe('hydrate');

        // The accepted prompt settles; the idle snapshot does not contain the
        // unconfirmed one, so its text must stay visible.
        reply(redialed, calls(redialed, 'prompt')[0].id, {
            $case: 'prompt',
            value: { accepted: true },
        });
        reply(redialed, calls(redialed, 'hydrate')[0].id, {
            $case: 'hydrate',
            value: { session: { messages: [], lastSeq: 0n } },
        });
        await settle();
        redialed.receive({
            payload: {
                $case: 'event',
                value: {
                    sid: 's1',
                    seq: 1n,
                    event: {
                        $case: 'stateChanged',
                        value: {
                            change: {
                                $case: 'state',
                                value: controlState({ busy: false }),
                            },
                        },
                    },
                },
            },
        });
        await settle();
        expect(root.textContent).toContain('first');
        expect(root.textContent).toContain('Not confirmed');
        // The acknowledged prompt is retired at the turn boundary.
        expect(root.textContent).not.toContain('second');

        chat.destroy();
        expect(promptTexts(redialed)).toEqual(['second']);
        client.close();
    });

    it('waits for a due refresh before dialing with the current token', async () => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
        const previousBridge = window.phiAccessAuth;
        let releaseRefresh;
        const refresh = new Promise((resolve) => {
            releaseRefresh = resolve;
        });
        window.phiAccessAuth = {
            refreshAccessIfDue: vi.fn(() => refresh),
            webSocketURL: (url) => {
                url.searchParams.set('token', 'refreshed');
                return url;
            },
        };

        const client = connectControl();
        try {
            expect(
                window.phiAccessAuth.refreshAccessIfDue,
            ).toHaveBeenCalledOnce();
            expect(FakeWebSocket.instances).toHaveLength(0);

            releaseRefresh();
            await settle();
            expect(FakeWebSocket.instances).toHaveLength(1);
            expect(
                new URL(FakeWebSocket.instances[0].url).searchParams.get(
                    'token',
                ),
            ).toBe('refreshed');
        } finally {
            client.close();
            if (previousBridge === undefined) delete window.phiAccessAuth;
            else window.phiAccessAuth = previousBridge;
        }
    });
});
