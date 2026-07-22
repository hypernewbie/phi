// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { PTYWebSocket } from '../web/ws.js';

// Milestone 4: the 0x07 md-changed frame case in ws.js's binary frame
// switch. Mirrors the existing 0x04/0x05 handling — decode UTF-8 JSON
// payload, spread it onto {type:'md-changed', ...} and forward to
// onControl. Backward-compat for unknown frame types is untouched (no
// default case), so this only needs to prove the new case decodes.

setupDomHarness();

// Capture-class stub: PTYWebSocket's constructor does `new WebSocket(url)`
// and then assigns onopen/onmessage/onclose/onerror onto the instance —
// we never need a real socket, just something to hang those handlers on.
class FakeWebSocket {
    constructor(url) {
        this.url = url;
        this.binaryType = '';
        this.readyState = FakeWebSocket.OPEN;
    }
    send() {}
    close() {}
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;

function sendFrame(pty, msgType, jsonPayload) {
    const payloadBytes = jsonPayload === undefined
        ? new Uint8Array(0)
        : new TextEncoder().encode(JSON.stringify(jsonPayload));
    const buffer = new ArrayBuffer(1 + payloadBytes.length);
    const view = new Uint8Array(buffer);
    view[0] = msgType;
    view.set(payloadBytes, 1);
    pty.ws.onmessage({ data: buffer });
}

describe('PTYWebSocket 0x07 md-changed frame', () => {
    beforeEach(() => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
    });

    it('decodes the JSON payload into onControl({type: "md-changed", ...})', () => {
        const onControl = vi.fn();
        const pty = new PTYWebSocket('pane-1', () => {}, onControl);

        sendFrame(pty, 0x07, { dir: '/w/research' });

        expect(onControl).toHaveBeenCalledTimes(1);
        expect(onControl).toHaveBeenCalledWith({ type: 'md-changed', dir: '/w/research' });
    });

    it('a malformed 0x07 payload logs and does not throw or call onControl', () => {
        const onControl = vi.fn();
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const pty = new PTYWebSocket('pane-1', () => {}, onControl);

        const buffer = new ArrayBuffer(1 + 3);
        const view = new Uint8Array(buffer);
        view[0] = 0x07;
        view.set(new TextEncoder().encode('{{{'), 1); // invalid JSON

        expect(() => pty.ws.onmessage({ data: buffer })).not.toThrow();
        expect(onControl).not.toHaveBeenCalled();
        expect(errSpy).toHaveBeenCalled();
    });
});
