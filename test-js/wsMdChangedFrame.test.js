// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { PTYWebSocket } from '../web/ws.js';
import { TerminalServerFrame } from '../web/proto/terminal.js';

// M2: the notification case in ws.js's protobuf frame switch. The
// server wraps the shared Notification in a TerminalServerFrame;
// markdown changes decode into onControl({type:'md-changed', dir}).

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

function sendNotification(pty, kind) {
    const frame = TerminalServerFrame.encode(
        TerminalServerFrame.fromPartial({
            payload: { $case: 'notification', value: kind },
        }),
    ).finish();
    pty.ws.onmessage({ data: new Uint8Array(frame).buffer });
}

describe('PTYWebSocket markdown notification', () => {
    beforeEach(() => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
    });

    it('decodes into onControl({type: "md-changed", dir})', () => {
        const onControl = vi.fn();
        const pty = new PTYWebSocket('pane-1', () => {}, onControl);

        sendNotification(pty, {
            kind: {
                $case: 'markdownChanged',
                value: { dir: '/w/research' },
            },
        });

        expect(onControl).toHaveBeenCalledTimes(1);
        expect(onControl).toHaveBeenCalledWith({
            type: 'md-changed',
            dir: '/w/research',
        });
    });

    it('undecodable bytes close the socket without calling onControl', () => {
        const onControl = vi.fn();
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const pty = new PTYWebSocket('pane-1', () => {}, onControl);
        const close = vi.spyOn(pty.ws, 'close');

        expect(() =>
            pty.ws.onmessage({
                data: new Uint8Array([0x82, 0xff, 0xfe]).buffer,
            }),
        ).not.toThrow();
        expect(onControl).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalled();
        errSpy.mockRestore();
    });

    it('an empty notification is ignored without closing', () => {
        const onControl = vi.fn();
        const pty = new PTYWebSocket('pane-1', () => {}, onControl);
        const close = vi.spyOn(pty.ws, 'close');

        sendNotification(pty, {});

        expect(onControl).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
    });
});
