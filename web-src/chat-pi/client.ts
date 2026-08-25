import { PROTOCOL_VERSION } from './constants.js';

export const ControlCallTimeout = 6_000;
const RECONNECT_FLOOR_MS = 1_000;
const RECONNECT_CAP_MS = 20_000;
const RECONNECT_MAX_ATTEMPTS = 10;

export type ControlConnectionState =
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'closed'
    | 'unavailable';

const UNCERTAIN_WRITE_OPS = new Set([
    'queueSubmit',
    'prompt',
    'steer',
    'follow_up',
    'abort',
    'setModel',
    'setThinking',
    'newSession',
    'setSessionName',
    'extensionUiResponse',
    'extensionUiCancel',
]);

export class ControlCallError extends Error {
    readonly op: string;
    readonly uncertain: boolean;

    constructor(op: string, message: string, uncertain: boolean) {
        super(message || 'control call failed');
        this.name = 'ControlCallError';
        this.op = op;
        this.uncertain = uncertain;
    }
}

export interface ControlClient {
    call<T = any>(op: string, sid?: string, args?: unknown): Promise<T>;
    /** Legacy fire-and-forget transport for callers outside the chat controller. */
    send(frame: unknown): void;
    /** Receives sequenced events only; responses belong to call(). */
    onMessage(cb: (env: any) => void): () => void;
    onConnectionState(cb: (state: ControlConnectionState) => void): () => void;
    close(): void;
}

type PendingCall = {
    op: string;
    timer: ReturnType<typeof setTimeout>;
    resolve: (value: any) => void;
    reject: (reason?: unknown) => void;
};

type OutboxFrame = {
    id?: string;
    raw: string;
};

function isUncertainWrite(op: string): boolean {
    return UNCERTAIN_WRITE_OPS.has(op);
}

function controlError(
    op: string,
    message: string,
    uncertain = false,
): ControlCallError {
    return new ControlCallError(op, message, uncertain);
}

function reconnectDelay(attempt: number): number {
    const cap = Math.min(
        RECONNECT_CAP_MS,
        RECONNECT_FLOOR_MS * 2 ** Math.max(0, attempt - 1),
    );
    return Math.max(RECONNECT_FLOOR_MS, Math.floor(Math.random() * cap));
}

/** Opens /ws/control, performs the hello handshake, and correlates calls. */
export function connectControl(): ControlClient {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const listeners: Array<(env: any) => void> = [];
    const stateListeners = new Set<(state: ControlConnectionState) => void>();
    const outbox: OutboxFrame[] = [];
    const pending = new Map<string, PendingCall>();
    let nextId = 1;
    let socket: WebSocket | null = null;
    let opened = false;
    let explicitClosed = false;
    let state: ControlConnectionState = 'connecting';
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let everOpened = false;

    const setState = (next: ControlConnectionState): void => {
        if (state === next) return;
        state = next;
        for (const cb of [...stateListeners]) cb(next);
    };

    const rejectAll = (message: string, uncertain: boolean): void => {
        for (const [id, call] of pending) {
            clearTimeout(call.timer);
            pending.delete(id);
            call.reject(
                controlError(
                    call.op,
                    message,
                    uncertain && isUncertainWrite(call.op),
                ),
            );
        }
        outbox.length = 0;
    };

    const removeOutboxCall = (id: string): void => {
        for (let index = outbox.length - 1; index >= 0; index--) {
            if (outbox[index].id === id) outbox.splice(index, 1);
        }
    };

    const scheduleReconnect = (): void => {
        if (explicitClosed || reconnectTimer !== null) return;
        if (reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
            setState('unavailable');
            return;
        }
        reconnectAttempt += 1;
        const delay = reconnectDelay(reconnectAttempt);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (explicitClosed) return;
            setState('reconnecting');
            openSocket();
        }, delay);
    };

    const handleLoss = (message: string, lostSocket?: WebSocket): void => {
        if (explicitClosed) return;
        if (lostSocket && socket !== lostSocket) return;
        opened = false;
        rejectAll(message, true);
        setState('reconnecting');
        scheduleReconnect();
    };

    function openSocket(): void {
        if (explicitClosed) return;
        if (socket?.readyState === 0) return;
        let nextSocket: WebSocket;
        try {
            nextSocket = new WebSocket(
                `${proto}://${location.host}/ws/control`,
            );
        } catch {
            handleLoss('control socket failed to open');
            return;
        }
        socket = nextSocket;
        nextSocket.onopen = () => {
            if (explicitClosed || socket !== nextSocket) return;
            opened = true;
            everOpened = true;
            reconnectAttempt = 0;
            // Complete the protocol handshake before publishing `connected`:
            // the mount listener may issue hydrate synchronously from that
            // state transition, and the server requires hello as frame one.
            nextSocket.send(
                JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }),
            );
            setState('connected');
            // A loss clears the outbox. Only frames queued before the first
            // successful open are eligible for this initial handshake.
            for (const frame of outbox.splice(0)) {
                if (frame.id !== undefined && !pending.has(frame.id)) continue;
                nextSocket.send(frame.raw);
            }
        };
        nextSocket.onerror = () =>
            handleLoss('control socket error', nextSocket);
        nextSocket.onclose = () => {
            if (socket !== nextSocket) return;
            if (explicitClosed) {
                opened = false;
                setState('closed');
                return;
            }
            handleLoss('control socket closed', nextSocket);
        };
        nextSocket.onmessage = (ev) => {
            if (socket !== nextSocket) return;
            let env: any;
            try {
                env = JSON.parse(ev.data);
            } catch {
                return;
            }
            if (env?.t === 'res' && typeof env.id === 'string') {
                const call = pending.get(env.id);
                if (!call) return;
                pending.delete(env.id);
                clearTimeout(call.timer);
                if (env.ok) call.resolve(env.data);
                else
                    call.reject(
                        controlError(
                            call.op,
                            String(env.error ?? 'control call failed'),
                        ),
                    );
                return;
            }
            if (env?.t !== 'evt') return;
            for (const cb of [...listeners]) cb(env);
        };
    }

    const handleOnline = (): void => {
        if (explicitClosed || opened) return;
        if (socket?.readyState === 0) return;
        if (reconnectTimer !== null) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        // An online transition is a new connectivity signal, but it does not
        // replay pending calls or bypass the normal attempt counter. Once the
        // bounded attempt budget has reported unavailable, a later online
        // transition starts a fresh connectivity episode.
        if (state === 'unavailable') reconnectAttempt = 0;
        setState('reconnecting');
        openSocket();
    };
    window.addEventListener('online', handleOnline);
    openSocket();

    const transmit = (raw: string, id?: string): void => {
        if (explicitClosed) return;
        if (opened && socket) socket.send(raw);
        else outbox.push({ id, raw });
    };

    const call = <T = any>(
        op: string,
        sid?: string,
        args?: unknown,
    ): Promise<T> => {
        if (explicitClosed || state === 'closed') {
            return Promise.reject(controlError(op, 'control socket closed'));
        }
        if (
            state === 'unavailable' ||
            (everOpened && state === 'reconnecting')
        ) {
            return Promise.reject(
                controlError(
                    op,
                    'control socket is reconnecting',
                    isUncertainWrite(op),
                ),
            );
        }
        const id = `c${nextId++}`;
        const frame: Record<string, unknown> = { t: 'call', id, op };
        if (sid !== undefined) frame.sid = sid;
        if (args !== undefined) frame.args = args;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!pending.delete(id)) return;
                removeOutboxCall(id);
                reject(
                    controlError(
                        op,
                        'control call timeout',
                        isUncertainWrite(op),
                    ),
                );
            }, ControlCallTimeout);
            pending.set(id, { op, timer, resolve, reject });
            transmit(JSON.stringify(frame), id);
        });
    };

    return {
        call,
        send: (frame) => {
            if (explicitClosed || (everOpened && state === 'reconnecting'))
                return;
            transmit(JSON.stringify(frame));
        },
        onMessage: (cb) => {
            listeners.push(cb);
            return () => {
                const index = listeners.indexOf(cb);
                if (index >= 0) listeners.splice(index, 1);
            };
        },
        onConnectionState: (cb) => {
            stateListeners.add(cb);
            cb(state);
            return () => stateListeners.delete(cb);
        },
        close: () => {
            if (explicitClosed) return;
            explicitClosed = true;
            opened = false;
            if (reconnectTimer !== null) clearTimeout(reconnectTimer);
            reconnectTimer = null;
            window.removeEventListener('online', handleOnline);
            rejectAll('control client closed', false);
            setState('closed');
            socket?.close();
        },
    };
}
