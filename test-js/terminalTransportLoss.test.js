// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { ReplayWire, encode } from './_terminalReplayHarness.js';
import { PTYWebSocket } from '../web/ws.js';

setupDomHarness();

describe('transport cannot silently strand a terminal', () => {
    it('reconnects when backpressure dropped ATTACH_HEAD but live output still arrives', () => {
        vi.stubGlobal('WebSocket', ReplayWire);
        const data = vi.fn();
        const pty = new PTYWebSocket('p', data);
        pty.ws.output(32000, encode('still live\r\n'));
        expect(
            pty.ws.closed,
            'an unknown byte frontier needs a new atomic head, not silent frame deletion',
        ).toBe(true);
    });

    it.each([
        ['missing head', { epoch: 7, oldest: 0 }],
        // A hostile -1 arrives as the max-uint64 varint, never a
        // negative: still outside every safe-integer window.
        ['negative oldest', { epoch: 7, oldest: 2n ** 64n - 1n, head: 1 }],
        ['oldest after head', { epoch: 7, oldest: 2, head: 1 }],
        [
            'unsafe head integer',
            { epoch: 7, oldest: 0, head: Number.MAX_SAFE_INTEGER + 1 },
        ],
        // No fractional-epoch row: varints are integers, so that JSON-only
        // hazard has no protobuf encoding. Undecodable bytes are pinned below.
    ])('does not pin the stream to an invalid frontier: %s', (_name, head) => {
        vi.stubGlobal('WebSocket', ReplayWire);
        const pty = new PTYWebSocket('p', vi.fn());
        pty.ws.head(head);
        expect(
            pty.ws.closed,
            'invalid frontiers must not poison sequence accounting permanently',
        ).toBe(true);
    });

    it('does not pin the stream to undecodable bytes', () => {
        vi.stubGlobal('WebSocket', ReplayWire);
        const pty = new PTYWebSocket('p', vi.fn());
        pty.ws.onmessage({ data: new Uint8Array([0xff, 0xff]).buffer });
        expect(pty.ws.closed).toBe(true);
        expect(pty.mode).toBe('unknown');
    });
});
