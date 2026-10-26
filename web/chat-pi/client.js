/* Φ phi — chat control transport (phi.websocket.control.v1).

   One binary generated frame per message. Calls are encoded and checked
   before they enter the outbox, then correlated by id against the pending
   operation. Results and sequenced events are converted back to the plain
   shapes the chat UI consumes. */
import { PROTOCOL_VERSION } from './constants.js';
import { buildCall, ControlConversionError, decodeServerFrame, encodeCall, encodeHello, eventFromWire, MaxControlMessageBytes, resultFromWire, } from './control-wire.js';
import { controlSubprotocol } from '../ws-protocols.js';
export const ControlCallTimeout = 35_000;
// Compaction runs a summary LLM call; Pi answers only when it finishes. The
// client stays awake slightly past the server's CompactOperationTimeout so
// the server's own deadline surfaces as the error.
export const CompactCallTimeout = 605_000;
function controlError(message) {
    return new Error(message || 'control call failed');
}
/**
 * Opens /ws/control, performs the hello handshake, and correlates calls.
 *
 * `onStreamFailure` reports a refused stream even when no call is pending:
 * during streamed output the chat has nothing to reject, and without this
 * callback the view would keep claiming it is ready after delivery stopped.
 */
export function connectControl(onStreamFailure) {
    const ws = new WebSocket(new URL('/ws/control', window.location.origin).href, controlSubprotocol);
    ws.binaryType = 'arraybuffer';
    const listeners = [];
    const outbox = [];
    const pending = new Map();
    let nextId = 1;
    let opened = false;
    let closed = false;
    const rejectAll = (reason) => {
        for (const [id, call] of pending) {
            clearTimeout(call.timer);
            pending.delete(id);
            call.reject(reason);
        }
        outbox.length = 0;
    };
    // A conversion or send failure ends this stream: pending calls are
    // rejected through the existing callbacks instead of hanging.
    const reportStreamFailure = (reason) => {
        if (closed)
            return;
        closed = true;
        try {
            onStreamFailure?.(reason.message);
        }
        catch (_error) { }
    };
    const failStream = (reason) => {
        rejectAll(reason);
        reportStreamFailure(reason);
        try {
            ws.close();
        }
        catch (_error) { }
    };
    const transmit = (raw, id) => {
        if (closed)
            return;
        if (!opened) {
            outbox.push({ id, raw });
            return;
        }
        try {
            ws.send(raw);
        }
        catch (_error) {
            failStream(controlError('control socket error'));
        }
    };
    const removeOutboxCall = (id) => {
        for (let index = outbox.length - 1; index >= 0; index--) {
            if (outbox[index].id === id)
                outbox.splice(index, 1);
        }
    };
    ws.onopen = () => {
        if (closed)
            return;
        opened = true;
        try {
            ws.send(encodeHello(PROTOCOL_VERSION));
        }
        catch (_error) {
            failStream(controlError('control socket error'));
            return;
        }
        for (const frame of outbox.splice(0)) {
            if (frame.id !== undefined && !pending.has(frame.id))
                continue;
            try {
                ws.send(frame.raw);
            }
            catch (_error) {
                failStream(controlError('control socket error'));
                return;
            }
        }
    };
    ws.onerror = () => failStream(controlError('control socket error'));
    ws.onclose = () => {
        opened = false;
        const reason = controlError('control socket closed');
        rejectAll(reason);
        reportStreamFailure(reason);
    };
    ws.onmessage = (ev) => {
        if (closed)
            return;
        const data = ev.data;
        if (!(data instanceof ArrayBuffer)) {
            failStream(controlError('control frame is not binary'));
            return;
        }
        // Only the server->client direction reaches this reader. The 16 MiB
        // bound in the plan caps one inbound call; a legitimate aggregate
        // hydrate may be larger, so it must not be refused here.
        if (data.byteLength === 0) {
            failStream(controlError('control frame is empty'));
            return;
        }
        let frame;
        try {
            frame = decodeServerFrame(new Uint8Array(data));
        }
        catch (_error) {
            failStream(controlError('control frame is malformed'));
            return;
        }
        const payload = frame.payload;
        if (payload === undefined) {
            failStream(controlError('control frame has no payload'));
            return;
        }
        if (payload.$case === 'welcome')
            return;
        if (payload.$case === 'response') {
            const response = payload.value;
            const call = pending.get(response.id);
            // A late response for an expired or unknown id is ignored.
            if (!call)
                return;
            let value;
            try {
                value = resultFromWire(call.op, response);
            }
            catch (error) {
                pending.delete(response.id);
                clearTimeout(call.timer);
                call.reject(error);
                // A server ControlError rejects this call only; a wrong
                // variant or malformed result ends the whole stream.
                if (error instanceof ControlConversionError)
                    failStream(error);
                return;
            }
            pending.delete(response.id);
            clearTimeout(call.timer);
            call.resolve(value);
            return;
        }
        let envelope;
        try {
            envelope = eventFromWire(payload.value);
        }
        catch (_error) {
            failStream(controlError('control event is malformed'));
            return;
        }
        for (const cb of [...listeners])
            cb(envelope);
    };
    const call = (op, sid, args, opts) => {
        if (closed)
            return Promise.reject(controlError('control socket closed'));
        const id = `c${nextId++}`;
        let raw;
        try {
            raw = encodeCall(buildCall(id, op, sid, args));
        }
        catch (error) {
            // A call that cannot be encoded never reaches the outbox.
            return Promise.reject(error);
        }
        if (raw.byteLength > MaxControlMessageBytes)
            return Promise.reject(controlError('control request exceeds message limit'));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!pending.delete(id))
                    return;
                removeOutboxCall(id);
                reject(controlError('control call timeout'));
            }, opts?.timeoutMs ?? ControlCallTimeout);
            pending.set(id, { timer, resolve, reject, op });
            transmit(raw, id);
        });
    };
    return {
        call,
        close: () => {
            if (closed)
                return;
            closed = true;
            opened = false;
            rejectAll(controlError('control client closed'));
            ws.close();
        },
        onMessage: (cb) => {
            listeners.push(cb);
            return () => {
                const index = listeners.indexOf(cb);
                if (index >= 0)
                    listeners.splice(index, 1);
            };
        },
    };
}
