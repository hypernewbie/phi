import { PROTOCOL_VERSION } from './constants.js';
export const ControlCallTimeout = 6_000;
const RECONNECT_FLOOR_MS = 1_000;
const RECONNECT_CAP_MS = 20_000;
const RECONNECT_MAX_ATTEMPTS = 10;
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
    op;
    uncertain;
    constructor(op, message, uncertain) {
        super(message || 'control call failed');
        this.name = 'ControlCallError';
        this.op = op;
        this.uncertain = uncertain;
    }
}
function isUncertainWrite(op) {
    return UNCERTAIN_WRITE_OPS.has(op);
}
function controlError(op, message, uncertain = false) {
    return new ControlCallError(op, message, uncertain);
}
function reconnectDelay(attempt) {
    const cap = Math.min(
        RECONNECT_CAP_MS,
        RECONNECT_FLOOR_MS * 2 ** Math.max(0, attempt - 1),
    );
    return Math.max(RECONNECT_FLOOR_MS, Math.floor(Math.random() * cap));
}
/** Opens /ws/control, performs the hello handshake, and correlates calls. */
export function connectControl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const listeners = [];
    const stateListeners = new Set();
    const outbox = [];
    const pending = new Map();
    let nextId = 1;
    let socket = null;
    let opened = false;
    let explicitClosed = false;
    let state = 'connecting';
    let reconnectAttempt = 0;
    let reconnectTimer = null;
    let everOpened = false;
    const setState = (next) => {
        if (state === next) return;
        state = next;
        for (const cb of [...stateListeners]) cb(next);
    };
    const rejectAll = (message, uncertain) => {
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
    const removeOutboxCall = (id) => {
        for (let index = outbox.length - 1; index >= 0; index--) {
            if (outbox[index].id === id) outbox.splice(index, 1);
        }
    };
    const scheduleReconnect = () => {
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
    const handleLoss = (message, lostSocket) => {
        if (explicitClosed) return;
        if (lostSocket && socket !== lostSocket) return;
        opened = false;
        rejectAll(message, true);
        setState('reconnecting');
        scheduleReconnect();
    };
    function openSocket() {
        if (explicitClosed) return;
        if (socket?.readyState === 0) return;
        let nextSocket;
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
            let env;
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
    const handleOnline = () => {
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
    const transmit = (raw, id) => {
        if (explicitClosed) return;
        if (opened && socket) socket.send(raw);
        else outbox.push({ id, raw });
    };
    const call = (op, sid, args) => {
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
        const frame = { t: 'call', id, op };
        if (sid !== undefined) frame.sid = sid;
        if (args !== undefined) frame.args = args;
        return new Promise((resolve, reject) => {
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
