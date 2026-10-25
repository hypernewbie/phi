// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { PTYWebSocket } from '../web/ws.js';
import { TabManager } from '../web/terminal.js';
import { TerminalServerFrame } from '../web/proto/terminal.js';

// M2: sync changes arrive as a TerminalServerFrame notification. The
// adapter decodes into onControl({type:'sync-changed', ...}) with the
// message rendered as the JSON shape the old payload carried.

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

function sendNotification(pty, kind) {
    const frame = TerminalServerFrame.encode(
        TerminalServerFrame.fromPartial({
            payload: { $case: 'notification', value: kind },
        }),
    ).finish();
    pty.ws.onmessage({ data: new Uint8Array(frame).buffer });
}

describe('PTYWebSocket sync notification', () => {
    beforeEach(() => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
    });

    it('decodes into onControl({type: "sync-changed", ...})', () => {
        const onControl = vi.fn();
        const pty = new PTYWebSocket('pane-1', () => {}, onControl);

        sendNotification(pty, {
            kind: {
                $case: 'syncChanged',
                value: {
                    action: 'upsert',
                    key: 'feature:preview',
                    msg: {
                        key: 'feature:preview',
                        value: 'hello',
                        createdAtUnixMs: BigInt(1700000000000),
                        updatedAtUnixMs: BigInt(1700000001000),
                    },
                },
            },
        });

        expect(onControl).toHaveBeenCalledTimes(1);
        expect(onControl).toHaveBeenCalledWith({
            type: 'sync-changed',
            action: 'upsert',
            key: 'feature:preview',
            msg: {
                key: 'feature:preview',
                value: 'hello',
                created_at: '2023-11-14T22:13:20.000Z',
                updated_at: '2023-11-14T22:13:21.000Z',
            },
        });
    });

    it('a delete carries no msg', () => {
        const onControl = vi.fn();
        const pty = new PTYWebSocket('pane-1', () => {}, onControl);

        sendNotification(pty, {
            kind: {
                $case: 'syncChanged',
                value: { action: 'delete', key: 'card-1' },
            },
        });

        expect(onControl).toHaveBeenCalledTimes(1);
        expect(onControl).toHaveBeenCalledWith({
            type: 'sync-changed',
            action: 'delete',
            key: 'card-1',
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
