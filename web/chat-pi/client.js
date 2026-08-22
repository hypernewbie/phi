import { PROTOCOL_VERSION } from './constants.js';
export const ControlCallTimeout = 6_000;
function controlError(message) {
    return new Error(message || 'control call failed');
}
/** Opens /ws/control, performs the hello handshake, and correlates calls. */
export function connectControl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/control`);
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
    const transmit = (raw, id) => {
        if (closed) return;
        if (opened) ws.send(raw);
        else outbox.push({ id, raw });
    };
    const removeOutboxCall = (id) => {
        for (let index = outbox.length - 1; index >= 0; index--) {
            if (outbox[index].id === id) outbox.splice(index, 1);
        }
    };
    ws.onopen = () => {
        if (closed) return;
        opened = true;
        ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
        for (const frame of outbox.splice(0)) {
            if (frame.id !== undefined && !pending.has(frame.id)) continue;
            ws.send(frame.raw);
        }
    };
    ws.onerror = () => rejectAll(controlError('control socket error'));
    ws.onclose = () => {
        opened = false;
        closed = true;
        rejectAll(controlError('control socket closed'));
    };
    ws.onmessage = (ev) => {
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
                    controlError(String(env.error ?? 'control call failed')),
                );
            return;
        }
        if (env?.t !== 'evt') return;
        for (const cb of [...listeners]) cb(env);
    };
    const call = (op, sid, args) => {
        if (closed)
            return Promise.reject(controlError('control socket closed'));
        const id = `c${nextId++}`;
        const frame = { t: 'call', id, op };
        if (sid !== undefined) frame.sid = sid;
        if (args !== undefined) frame.args = args;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!pending.delete(id)) return;
                removeOutboxCall(id);
                reject(controlError('control call timeout'));
            }, ControlCallTimeout);
            pending.set(id, { timer, resolve, reject });
            transmit(JSON.stringify(frame), id);
        });
    };
    return {
        call,
        send: (frame) => {
            if (closed) return;
            transmit(JSON.stringify(frame));
        },
        close: () => {
            if (closed) return;
            closed = true;
            opened = false;
            rejectAll(controlError('control client closed'));
            ws.close();
        },
        onMessage: (cb) => {
            listeners.push(cb);
            return () => {
                const index = listeners.indexOf(cb);
                if (index >= 0) listeners.splice(index, 1);
            };
        },
    };
}
