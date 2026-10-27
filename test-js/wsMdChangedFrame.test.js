// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { PTYWebSocket } from '../web/ws.js';
import { TerminalServerFrame } from '../web/proto/terminal.js';
import { installToken, __test__ } from '../web/auth.js';

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
        __test__.resetAccessState();
    });

    it('keeps the pane parameters and adds the v2 token', () => {
        installToken('jwt-a');
        const pty = new PTYWebSocket('pane-1', () => {});
        const url = new URL(pty.ws.url);
        expect(url.pathname).toBe('/ws/pane/pane-1');
        expect(url.searchParams.get('state')).toBe('ansi-v1');
        expect(url.searchParams.get('token')).toBe('jwt-a');
    });

    it('keeps v1 pane URLs cookie-only', () => {
        const pty = new PTYWebSocket('pane-1', () => {});
        const url = new URL(pty.ws.url);
        expect(url.searchParams.get('state')).toBe('ansi-v1');
        expect(url.searchParams.get('token')).toBeNull();
    });

    it('never logs a token-bearing socket target on error', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const pty = new PTYWebSocket('pane-1', () => {});
        pty.ws.onerror({ target: { url: 'ws://x/ws/pane/p1?token=secret' } });
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.mock.calls[0]).toHaveLength(1);
        expect(JSON.stringify(error.mock.calls)).not.toContain('secret');
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
