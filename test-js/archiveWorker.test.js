// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { startArchiveWorker } from '../web/archive.js';

// TERMPERF §5 parsing tier: the harness spawns a real Web Worker when
// the browser provides one and never blocks the live terminal on
// archive work. These tests pin the message-routing contract using a
// stub Worker so jsdom (which doesn't ship OffscreenCanvas + headless
// init) can still drive the harness end-to-end.

class FakeWorker {
    static instances = [];
    constructor(url) {
        this.url = url;
        this.onmessage = null;
        this.onerror = null;
        this.sent = [];
        FakeWorker.instances.push(this);
    }
    postMessage(message, transfer) {
        this.sent.push({ message, transfer });
    }
    terminate() {
        this.terminated = true;
    }
    emit(message) {
        if (this.onmessage) this.onmessage({ data: message });
    }
    emitError(message) {
        if (this.onerror) this.onerror({ message });
    }
}

describe('startArchiveWorker', () => {
    it('routes "rows", "done", and "error" worker messages to their callbacks', () => {
        FakeWorker.instances.length = 0;
        vi.stubGlobal('Worker', FakeWorker);
        const onRows = vi.fn();
        const onDone = vi.fn();
        const onError = vi.fn();
        const handle = startArchiveWorker(
            [
                {
                    paneId: 'p',
                    cols: 80,
                    rows: 24,
                    chunks: [{ start: 0, end: 5, bytes: 'hello' }],
                },
            ],
            { onRows, onDone, onError },
        );
        const w = FakeWorker.instances[0];
        expect(w.url).toBe('history-worker.js');
        w.emit({
            type: 'rows',
            paneId: 'p',
            blocks: [{ start: 0, end: 5, lines: ['hello'] }],
        });
        w.emit({ type: 'done', paneId: 'p', lines: 1 });
        w.emit({ type: 'error', paneId: 'p', message: 'boom' });
        expect(onRows).toHaveBeenCalledWith('p', [
            { start: 0, end: 5, lines: ['hello'] },
        ]);
        expect(onDone).toHaveBeenCalledWith('p', 1);
        expect(onError).toHaveBeenCalledWith('p', 'boom');
        handle.cancel();
        expect(w.terminated).toBe(true);
    });

    it('transfers ArrayBuffer byte chunks (and copies TypedArray views) for performance', () => {
        FakeWorker.instances.length = 0;
        vi.stubGlobal('Worker', FakeWorker);
        const buf1 = new ArrayBuffer(8);
        const view = new Uint8Array(16); // a TypedArray view
        startArchiveWorker(
            [
                {
                    paneId: 'p',
                    cols: 80,
                    rows: 24,
                    chunks: [
                        { start: 0, end: 8, bytes: buf1 },
                        { start: 8, end: 24, bytes: view },
                    ],
                },
            ],
            { onRows: () => {}, onError: () => {} },
        );
        const w = FakeWorker.instances[0];
        const transfers = w.sent[0].transfer;
        expect(transfers).toContain(buf1);
        expect(transfers.length).toBe(2);
        // The TypedArray must be detached from its original buffer; verify
        // by checking that the transferred buffer is a fresh ArrayBuffer
        // and not the original.
        expect(transfers[1]).not.toBe(view.buffer);
        expect(transfers[1] instanceof ArrayBuffer).toBe(true);
    });

    it('surfaces worker construction failures through onError', () => {
        class FailingWorker {
            constructor() {
                throw new Error('blocked');
            }
        }
        vi.stubGlobal('Worker', FailingWorker);
        const onError = vi.fn();
        startArchiveWorker(
            [
                {
                    paneId: 'p',
                    cols: 80,
                    rows: 24,
                    chunks: [{ start: 0, end: 1, bytes: 'x' }],
                },
            ],
            { onError, onRows: () => {} },
        );
        expect(onError).toHaveBeenCalledWith(
            'p',
            expect.stringContaining('blocked'),
        );
    });

    it('does not deliver rows after cancel()', () => {
        FakeWorker.instances.length = 0;
        vi.stubGlobal('Worker', FakeWorker);
        const onRows = vi.fn();
        const handle = startArchiveWorker(
            [
                {
                    paneId: 'p',
                    cols: 80,
                    rows: 24,
                    chunks: [{ start: 0, end: 1, bytes: 'x' }],
                },
            ],
            { onRows, onError: () => {} },
        );
        const w = FakeWorker.instances[0];
        handle.cancel();
        w.emit({ type: 'rows', paneId: 'p', blocks: [] });
        expect(onRows).not.toHaveBeenCalled();
    });
});
