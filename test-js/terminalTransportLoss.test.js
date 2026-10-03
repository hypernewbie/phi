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
        ['negative oldest', { epoch: 7, oldest: -1, head: 1 }],
        ['oldest after head', { epoch: 7, oldest: 2, head: 1 }],
        [
            'unsafe head integer',
            { epoch: 7, oldest: 0, head: Number.MAX_SAFE_INTEGER + 1 },
        ],
        ['fractional epoch', { epoch: 1.5, oldest: 0, head: 1 }],
    ])('does not pin the stream to an invalid frontier: %s', (_name, head) => {
        vi.stubGlobal('WebSocket', ReplayWire);
        const pty = new PTYWebSocket('p', vi.fn());
        pty.ws.head(head);
        expect(
            pty.ws.closed,
            'invalid frontiers must not poison sequence accounting permanently',
        ).toBe(true);
    });
});
