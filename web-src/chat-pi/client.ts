/* Φ phi — chat control transport (phi.websocket.control.v1).

   One binary generated frame per message. Calls are encoded and checked
   before they enter the outbox, then correlated by id against the pending
   operation. Results and sequenced events are converted back to the plain
   shapes the chat UI consumes.

   The stream heals itself: a dropped socket is redialed with backoff, and a
   call that never reached a socket stays in the outbox and goes out on the
   next open. Only a protocol fault ends the stream for good. */

import { PROTOCOL_VERSION } from './constants.js';
import {
    buildCall,
    ControlConversionError,
    decodeServerFrame,
    encodeCall,
    encodeHello,
    eventFromWire,
    MaxControlMessageBytes,
    resultFromWire,
} from './control-wire.js';
import type { WireEvent } from './control-wire.js';
import { controlSubprotocol } from '../ws-protocols.js';
import { wsUrl } from '../util.js';

export const ControlCallTimeout = 35_000;

// Compaction runs a summary LLM call; Pi answers only when it finishes. The
// client stays awake slightly past the server's CompactOperationTimeout so
// the server's own deadline surfaces as the error.
export const CompactCallTimeout = 605_000;

// Redial bounds. This stream carries the whole chat, so a dropped or slow
// link must heal without user action. A capped delay keeps a long outage
// cheap; a short blip still retries within about a second.
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
// A socket that upgrades and dies again must not reset the backoff: only a
// connection that stays usable this long counts as recovery.
const RECONNECT_STABLE_MS = 10_000;
// A WebSocket handshake that has not completed by now is treated as a dead
// link, so a stuck CONNECTING socket cannot hold the stream down for good.
// The bound is generous: a slow link still gets its handshake.
const DIAL_TIMEOUT_MS = 30_000;

// Close codes the Phi server sends when this stream cannot work at all:
// 1002 protocol error, 1009 message too big, 1011 event conversion/encoding
// failure. See pkg/ws/control.go.
const SERVER_FAULT_CLOSE_CODES = new Set([1002, 1009, 1011]);

export interface CallOptions {
    timeoutMs?: number;
}

export interface ControlClient {
    call<T = any>(
        op: string,
        sid?: string,
        args?: unknown,
        opts?: CallOptions,
    ): Promise<T>;
    /** Receives sequenced events only; responses belong to call(). */
    onMessage(cb: (env: WireEvent) => void): () => void;
    /** Fires on every connect and every drop. Safe to repeat. */
    onState(cb: (connected: boolean) => void): () => void;
    close(): void;
}

type PendingCall = {
    timer: ReturnType<typeof setTimeout> | null;
    timeoutMs: number;
    /** Written to a socket. Its outcome is unknown across a drop. */
    sent: boolean;
    resolve: (value: any) => void;
    reject: (reason?: unknown) => void;
    op: string;
};

type OutboxFrame = {
    id?: string;
    raw: Uint8Array<ArrayBuffer>;
};

export type ControlError = Error & { transport?: boolean };

function controlError(message: string): Error {
    return new Error(message || 'control call failed');
}

function transportError(message: string): ControlError {
    const error = controlError(message) as ControlError;
    error.transport = true;
    return error;
}

/**
 * Opens /ws/control, performs the hello handshake, and correlates calls.
 *
 * `onStreamFailure` reports a protocol fault that stops the stream for good.
 * A plain network drop is not reported there: `onState(false)` covers it and
 * the client redials.
 */
export function connectControl(
    onStreamFailure?: (message: string) => void,
): ControlClient {
    const listeners: Array<(env: WireEvent) => void> = [];
    const stateListeners = new Set<(connected: boolean) => void>();
    const outbox: OutboxFrame[] = [];
    const pending = new Map<string, PendingCall>();
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stableTimer: ReturnType<typeof setTimeout> | null = null;
    let dialTimer: ReturnType<typeof setTimeout> | null = null;
    let retry = 0;
    let nextId = 1;
    let dialing = false;
    let opened = false;
    // Explicit close. Nothing more is sent and no redial follows.
    let closed = false;
    // Protocol fault. The stream is unusable, so it is not redialed.
    let broken = false;

    const emitState = (connected: boolean): void => {
        for (const cb of [...stateListeners]) cb(connected);
    };

    const removeOutboxCall = (id: string): void => {
        for (let index = outbox.length - 1; index >= 0; index--) {
            if (outbox[index].id === id) outbox.splice(index, 1);
        }
    };

    const armTimer = (id: string, call: PendingCall): void => {
        if (call.timer !== null) return;
        call.timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            call.timer = null;
            removeOutboxCall(id);
            call.reject(controlError('control call timeout'));
        }, call.timeoutMs);
    };

    const reportStreamFailure = (reason: Error): void => {
        try {
            onStreamFailure?.(reason.message);
        } catch (_error) {}
    };

    // A frame that never left the browser is safe to replay. One written to a
    // dead socket is not: the server may have acted on it, so its caller gets
    // a transport error and decides.
    const rejectSent = (reason: Error): void => {
        for (const [id, call] of [...pending]) {
            if (!call.sent) continue;
            pending.delete(id);
            if (call.timer !== null) clearTimeout(call.timer);
            call.timer = null;
            call.reject(reason);
        }
    };

    const rejectAll = (reason: Error): void => {
        for (const [id, call] of [...pending]) {
            pending.delete(id);
            if (call.timer !== null) clearTimeout(call.timer);
            call.timer = null;
            call.reject(reason);
        }
        outbox.length = 0;
    };

    const detach = (): void => {
        const socket = ws;
        ws = null;
        opened = false;
        dialing = false;
        if (stableTimer !== null) {
            clearTimeout(stableTimer);
            stableTimer = null;
        }
        if (dialTimer !== null) {
            clearTimeout(dialTimer);
            dialTimer = null;
        }
        if (!socket) return;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try {
            socket.close();
        } catch (_error) {
            /* already closed */
        }
    };

    const scheduleReconnect = (): void => {
        if (closed || broken || retryTimer !== null) return;
        const backoff = Math.min(
            RECONNECT_MAX_MS,
            RECONNECT_BASE_MS * 2 ** retry,
        );
        const delay = Math.round(backoff * (0.7 + Math.random() * 0.6));
        retry += 1;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            dial();
        }, delay);
    };

    // Conversion or framing faults are not fixed by redialing: end the
    // stream and let the view drop to a clear error.
    const failStream = (reason: Error): void => {
        if (closed || broken) return;
        broken = true;
        if (retryTimer !== null) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
        const wasOpen = opened;
        detach();
        rejectAll(reason);
        if (wasOpen) emitState(false);
        reportStreamFailure(reason);
    };

    // A native WebSocket buffers `send()` silently once it leaves OPEN, so
    // the frame would be lost while we still believed it was written.
    const writable = (socket: WebSocket): boolean => socket.readyState === 1;

    const flushOutbox = (socket: WebSocket): boolean => {
        const frames = outbox.splice(0);
        for (let index = 0; index < frames.length; index++) {
            const frame = frames[index];
            const call =
                frame.id === undefined ? undefined : pending.get(frame.id);
            // A call that timed out or was cancelled has no pending entry;
            // its frame must not reach the server.
            if (frame.id !== undefined && !call) continue;
            if (!writable(socket)) {
                outbox.push(...frames.slice(index));
                dropSocket();
                return false;
            }
            try {
                socket.send(frame.raw);
            } catch (_error) {
                outbox.push(...frames.slice(index));
                dropSocket();
                return false;
            }
            if (call) {
                call.sent = true;
                armTimer(frame.id as string, call);
            }
        }
        return true;
    };

    const dropSocket = (): void => {
        if (closed || broken) return;
        const wasOpen = opened;
        detach();
        rejectSent(transportError('control connection lost'));
        if (wasOpen) emitState(false);
        scheduleReconnect();
    };

    const dial = (): void => {
        if (closed || broken || dialing || opened) return;
        dialing = true;
        let socket: WebSocket;
        try {
            socket = new WebSocket(
                wsUrl('/ws/control'),
                controlSubprotocol,
            );
        } catch (error) {
            dialing = false;
            reportStreamFailure(
                error instanceof Error
                    ? error
                    : controlError('control socket error'),
            );
            return;
        }
        ws = socket;
        socket.binaryType = 'arraybuffer';
        // A handshake that never completes is a dead link too: the browser
        // reports neither open nor error when the network is gone.
        dialTimer = setTimeout(() => {
            dialTimer = null;
            if (socket === ws && !opened) dropSocket();
        }, DIAL_TIMEOUT_MS);
        socket.onopen = () => {
            dialing = false;
            if (closed || broken || socket !== ws) return;
            if (dialTimer !== null) {
                clearTimeout(dialTimer);
                dialTimer = null;
            }
            if (stableTimer !== null) clearTimeout(stableTimer);
            stableTimer = setTimeout(() => {
                stableTimer = null;
                retry = 0;
            }, RECONNECT_STABLE_MS);
            let hello: Uint8Array<ArrayBuffer>;
            try {
                hello = encodeHello(PROTOCOL_VERSION);
            } catch (_error) {
                failStream(controlError('control hello could not be encoded'));
                return;
            }
            try {
                socket.send(hello);
            } catch (_error) {
                // The socket died mid-open: keep the queued frames for the
                // next socket instead of failing them.
                dropSocket();
                return;
            }
            opened = true;
            if (!flushOutbox(socket)) return;
            emitState(true);
        };
        socket.onerror = () => {
            // Browsers follow onerror with onclose; closing here fails a
            // half-open socket now instead of after a transport timeout.
            try {
                socket.close();
            } catch (_error) {
                dialing = false;
                if (socket === ws) dropSocket();
            }
        };
        socket.onclose = (event) => {
            dialing = false;
            if (socket !== ws) return;
            // The server closes with a protocol/internal code when it cannot
            // speak this stream at all. Redialing would only loop, so those
            // are reported; every other close is a transport problem worth
            // retrying.
            if (SERVER_FAULT_CLOSE_CODES.has(event?.code)) {
                failStream(controlError('control stream refused'));
                return;
            }
            dropSocket();
        };
        socket.onmessage = (ev) => {
            if (closed || broken) return;
            const data = ev.data;
            if (!(data instanceof ArrayBuffer)) {
                failStream(controlError('control frame is not binary'));
                return;
            }
            // Only the server->client direction reaches this reader. The
            // 16 MiB bound in the plan caps one inbound call; a legitimate
            // aggregate hydrate may be larger, so it must not be refused
            // here.
            if (data.byteLength === 0) {
                failStream(controlError('control frame is empty'));
                return;
            }
            let frame: ReturnType<typeof decodeServerFrame>;
            try {
                frame = decodeServerFrame(new Uint8Array(data));
            } catch (_error) {
                failStream(controlError('control frame is malformed'));
                return;
            }
            const payload = frame.payload;
            if (payload === undefined) {
                failStream(controlError('control frame has no payload'));
                return;
            }
            if (payload.$case === 'welcome') return;
            if (payload.$case === 'response') {
                const response = payload.value;
                const call = pending.get(response.id);
                // A late response for an expired or unknown id is ignored.
                if (!call) return;
                let value: unknown;
                try {
                    value = resultFromWire(call.op, response);
                } catch (error) {
                    pending.delete(response.id);
                    if (call.timer !== null) clearTimeout(call.timer);
                    call.timer = null;
                    call.reject(error);
                    // A server ControlError rejects this call only; a wrong
                    // variant or malformed result ends the whole stream.
                    if (error instanceof ControlConversionError)
                        failStream(error as Error);
                    return;
                }
                pending.delete(response.id);
                if (call.timer !== null) clearTimeout(call.timer);
                call.timer = null;
                call.resolve(value);
                return;
            }
            let envelope: WireEvent;
            try {
                envelope = eventFromWire(payload.value);
            } catch (_error) {
                failStream(controlError('control event is malformed'));
                return;
            }
            for (const cb of [...listeners]) cb(envelope);
        };
    };

    const onOnline = (): void => {
        if (closed || broken || opened) return;
        if (retryTimer !== null) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
        retry = 0;
        // A dial that is still connecting must not block the redial a
        // network change is meant to trigger.
        if (dialing) dropSocket();
        dial();
    };

    if (typeof window !== 'undefined')
        window.addEventListener('online', onOnline);

    const transmit = (raw: Uint8Array<ArrayBuffer>, id?: string): void => {
        if (closed || broken) return;
        const call = id === undefined ? undefined : pending.get(id);
        if (opened && ws && writable(ws)) {
            try {
                ws.send(raw);
            } catch (_error) {
                outbox.push({ id, raw });
                dropSocket();
                return;
            }
            if (call) {
                call.sent = true;
                armTimer(id as string, call);
            }
            return;
        }
        outbox.push({ id, raw });
        // A socket that is no longer OPEN will never write this frame: drop
        // it now so the redial can replay the frame.
        if (opened) dropSocket();
    };

    const call = <T = any>(
        op: string,
        sid?: string,
        args?: unknown,
        opts?: CallOptions,
    ): Promise<T> => {
        if (closed || broken)
            return Promise.reject(controlError('control socket closed'));
        const id = `c${nextId++}`;
        let raw: Uint8Array<ArrayBuffer>;
        try {
            raw = encodeCall(buildCall(id, op, sid, args));
        } catch (error) {
            // A call that cannot be encoded never reaches the outbox.
            return Promise.reject(error);
        }
        if (raw.byteLength > MaxControlMessageBytes)
            return Promise.reject(
                controlError('control request exceeds message limit'),
            );
        return new Promise<T>((resolve, reject) => {
            pending.set(id, {
                timer: null,
                timeoutMs: opts?.timeoutMs ?? ControlCallTimeout,
                sent: false,
                resolve,
                reject,
                op,
            });
            transmit(raw, id);
        });
    };

    dial();

    return {
        call,
        close: () => {
            if (closed) return;
            closed = true;
            if (retryTimer !== null) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
            if (typeof window !== 'undefined')
                window.removeEventListener('online', onOnline);
            const wasOpen = opened;
            detach();
            rejectAll(controlError('control client closed'));
            if (wasOpen) emitState(false);
        },
        onMessage: (cb) => {
            listeners.push(cb);
            return () => {
                const index = listeners.indexOf(cb);
                if (index >= 0) listeners.splice(index, 1);
            };
        },
        onState: (cb) => {
            stateListeners.add(cb);
            return () => {
                stateListeners.delete(cb);
            };
        },
    };
}
