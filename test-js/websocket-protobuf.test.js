// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { PTYWebSocket } from '../web/ws.js';
import {
    TerminalClientFrame,
    TerminalServerFrame,
} from '../web/proto/terminal.js';
import { Notification } from '../web/proto/events.js';
import { decodeNotificationDir } from '../web/md-view.js';

// M2 pane/event adapters over generated protobuf: drop/title/bridge/
// settlement/notification decode into the control shapes the host
// consumes, input chunking reassembles byte-exactly, unsafe integers
// never reach the UI, and reserved payloads close the socket.

setupDomHarness();

class FakeWebSocket {
    constructor(url) {
        this.url = url;
        this.binaryType = '';
        this.readyState = FakeWebSocket.OPEN;
        this.sent = [];
    }
    send(b) {
        this.sent.push(b);
    }
    close() {}
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;

function sendPayload(pty, payload) {
    const frame = TerminalServerFrame.encode(
        TerminalServerFrame.fromPartial({ payload }),
    ).finish();
    pty.ws.onmessage({ data: new Uint8Array(frame).buffer });
}

describe('pane notification adapters', () => {
    beforeEach(() => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
    });

    it('drop notice decodes into onControl({type: "output-dropped"})', () => {
        const onControl = vi.fn();
        const pty = new PTYWebSocket('pane-1', () => {}, onControl);
        sendPayload(pty, { $case: 'dropNotice', value: {} });
        expect(onControl).toHaveBeenCalledTimes(1);
        expect(onControl).toHaveBeenCalledWith({ type: 'output-dropped' });
    });

    it('title decodes with its revision as a safe integer', () => {
        const onControl = vi.fn();
        const pty = new PTYWebSocket('pane-1', () => {}, onControl);
        sendPayload(pty, {
            $case: 'title',
            value: {
                paneId: 'pane-1',
                sessionId: 'native-id',
                title: 'Native title',
                revision: BigInt(7),
            },
        });
        expect(onControl).toHaveBeenCalledTimes(1);
        expect(onControl).toHaveBeenCalledWith({
            type: 'session-title',
            pane_id: 'pane-1',
            session_id: 'native-id',
            title: 'Native title',
            revision: 7,
        });
    });

    it('an unsafe title revision is ignored without closing', () => {
        const onControl = vi.fn();
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const pty = new PTYWebSocket('pane-1', () => {}, onControl);
        const close = vi.spyOn(pty.ws, 'close');
        sendPayload(pty, {
            $case: 'title',
            value: { paneId: 'pane-1', revision: BigInt(2) ** BigInt(53) },
        });
        expect(onControl).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        errSpy.mockRestore();
    });

    it('bridge state keeps identifiers exact and presence intact', () => {
        const onControl = vi.fn();
        const pty = new PTYWebSocket('pane-1', () => {}, onControl);
        sendPayload(pty, {
            $case: 'bridgeState',
            value: {
                paneId: 'pane-1',
                state: 'managed',
                generation: BigInt('18446744073709551615'),
                telemetryRevision: BigInt(9),
                lastRun: BigInt(7),
                lastOutcome: 'completed',
                running: false,
                model: 'prov/model',
                capabilities: ['pi.lifecycle.v1', 'pi.history.v1'],
            },
        });
        expect(onControl).toHaveBeenCalledTimes(1);
        expect(onControl).toHaveBeenCalledWith({
            type: 'pi-bridge-state',
            pane_id: 'pane-1',
            state: 'managed',
            generation: '18446744073709551615',
            telemetry_revision: '9',
            last_run: '7',
            last_outcome: 'completed',
            running: false,
            model: 'prov/model',
            capabilities: ['pi.lifecycle.v1', 'pi.history.v1'],
        });
        // connected was absent: the key stays absent rather than false.
        expect(onControl.mock.calls[0][0]).not.toHaveProperty('connected');
        expect(onControl.mock.calls[0][0]).not.toHaveProperty('reason');
    });

    it('settlement decodes with exact decimal identifiers', () => {
        const onControl = vi.fn();
        const pty = new PTYWebSocket('pane-1', () => {}, onControl);
        sendPayload(pty, {
            $case: 'settlement',
            value: {
                paneId: 'pane-1',
                generation: BigInt(3),
                run: BigInt(9),
                outcome: 'completed',
            },
        });
        expect(onControl).toHaveBeenCalledTimes(1);
        expect(onControl).toHaveBeenCalledWith({
            type: 'pi-bridge-settled',
            pane_id: 'pane-1',
            generation: '3',
            run: '9',
            outcome: 'completed',
        });
    });

    it('shutdown notification decodes with its reason', () => {
        const onControl = vi.fn();
        const pty = new PTYWebSocket('pane-1', () => {}, onControl);
        sendPayload(pty, {
            $case: 'notification',
            value: {
                kind: { $case: 'shutdown', value: { reason: 'restart' } },
            },
        });
        expect(onControl).toHaveBeenCalledTimes(1);
        expect(onControl).toHaveBeenCalledWith({
            type: 'server-shutdown',
            reason: 'restart',
        });
    });
});

describe('reserved payload rejection', () => {
    beforeEach(() => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
    });

    it('an unknown-field-only message closes the socket', () => {
        const onControl = vi.fn();
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const pty = new PTYWebSocket('pane-1', () => {}, onControl);
        const close = vi.spyOn(pty.ws, 'close');
        // Field 1 varint: unknown to TerminalServerFrame, so the
        // payload stays empty and the socket fails closed.
        pty.ws.onmessage({ data: new Uint8Array([0x08, 0x01]).buffer });
        expect(onControl).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalled();
        errSpy.mockRestore();
    });

    it('an oversize message closes the socket before decoding', () => {
        const onControl = vi.fn();
        const pty = new PTYWebSocket('pane-1', () => {}, onControl);
        const close = vi.spyOn(pty.ws, 'close');
        pty.ws.onmessage({ data: new ArrayBuffer(4 * 1024 * 1024 + 1) });
        expect(onControl).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalled();
    });
});

describe('input chunking', () => {
    beforeEach(() => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
    });

    it('a large paste goes out as ordered frames that reassemble exactly', () => {
        const pty = new PTYWebSocket('pane-1', () => {});
        const paste = 'x'.repeat(2 * 1024 * 1024 + 7) + 'héllo-🙂';
        expect(pty.sendInput(paste)).toBe(true);
        expect(pty.ws.sent.length).toBeGreaterThan(1);
        const parts = pty.ws.sent.map(
            (b) => TerminalClientFrame.decode(new Uint8Array(b)).payload,
        );
        expect(parts.every((p) => p.$case === 'input')).toBe(true);
        const raw = Buffer.concat(
            parts.map((p) => Buffer.from(p.value)),
        ).toString('utf8');
        expect(raw).toBe(paste);
        for (const b of pty.ws.sent) {
            expect(b.byteLength).toBeLessThanOrEqual(1024 * 1024 + 16);
        }
    });
});

describe('events notification adapter', () => {
    it('decodes a markdown notification to its dir', () => {
        const bytes = Notification.encode(
            Notification.fromPartial({
                kind: {
                    $case: 'markdownChanged',
                    value: { dir: '/tmp/docs' },
                },
            }),
        ).finish();
        expect(decodeNotificationDir(bytes)).toBe('/tmp/docs');
    });

    it('ignores non-markdown and undecodable payloads', () => {
        const sync = Notification.encode(
            Notification.fromPartial({
                kind: {
                    $case: 'syncChanged',
                    value: { action: 'upsert', key: 'k' },
                },
            }),
        ).finish();
        expect(decodeNotificationDir(sync)).toBeNull();
        expect(decodeNotificationDir(new Uint8Array([0xff, 0xff]))).toBeNull();
    });
});
