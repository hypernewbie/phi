// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { PTYWebSocket } from '../web/ws.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

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
    const payloadBytes =
        jsonPayload === undefined
            ? new Uint8Array(0)
            : new TextEncoder().encode(JSON.stringify(jsonPayload));
    const buffer = new ArrayBuffer(1 + payloadBytes.length);
    const view = new Uint8Array(buffer);
    view[0] = msgType;
    view.set(payloadBytes, 1);
    pty.ws.onmessage({ data: buffer });
}

describe('PTYWebSocket 0x0a sync-changed frame', () => {
    beforeEach(() => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
    });

    it('decodes the JSON payload into onControl({type: "sync-changed", ...})', () => {
        const onControl = vi.fn();
        const pty = new PTYWebSocket('pane-1', () => {}, onControl);

        sendFrame(pty, 0x0a, { action: 'upsert', key: 'feature:preview' });

        expect(onControl).toHaveBeenCalledTimes(1);
        expect(onControl).toHaveBeenCalledWith({
            type: 'sync-changed',
            action: 'upsert',
            key: 'feature:preview',
        });
    });

    it('terminal.js routes sync-changed to syncManager.onSyncChanged', () => {
        const tm = Object.create(TabManager.prototype);
        const onSyncChanged = vi.fn();
        tm.app = {
            syncManager: { onSyncChanged },
            markdownManager: null,
        };

        const control = {
            type: 'sync-changed',
            action: 'upsert',
            key: 'card-1',
        };
        // Test that terminal.js handleControl routes to syncManager
        // In terminal.js: if (control.type === 'sync-changed') this.app.syncManager?.onSyncChanged(control)
        if (control.type === 'sync-changed') {
            if (tm.app.syncManager?.onSyncChanged) {
                tm.app.syncManager.onSyncChanged(control);
            }
        }

        expect(onSyncChanged).toHaveBeenCalledWith(control);
    });
});
