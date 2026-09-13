// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Archive UI (TERMPERF §5 presentation tier): the archive button must
// wire through to a worker-driven overlay without ever sending archive
// bytes into the live terminal. This pins the surface contract.

setupDomHarness();
beforeEach(() => {
    // Minimal Terminal stub — the archive wiring only checks the
    // overlay DOM + tabInfo state, not the live terminal itself.
    vi.stubGlobal('Terminal', function () {
        return {
            options: {},
            cols: 80,
            rows: 24,
            buffer: { active: { viewportY: 0, baseY: 0 } },
            writes: [],
            open() {},
            write(_d, cb) {
                if (cb) cb();
            },
            reset() {},
            resize() {},
            loadAddon() {},
            attachCustomKeyEventHandler() {},
            onSelectionChange() {},
            onBell() {},
            onScroll() {},
            onData() {},
            parser: { registerOscHandler() {} },
            getSelection: () => '',
            scrollToBottom: () => {},
            refresh: () => {},
            _core: { viewport: { syncScrollArea: () => {} } },
        };
    });
    vi.stubGlobal('FitAddon', { FitAddon: class {} });
    vi.stubGlobal('SearchAddon', { SearchAddon: class {} });
});

function makeTm() {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;
    tm.tabsContainer = document.createElement('div');
    tm.terminalsWrapper = document.createElement('div');
    document.body.appendChild(tm.tabsContainer);
    document.body.appendChild(tm.terminalsWrapper);
    tm.app = { config: {} };
    tm.switchTab = vi.fn();
    tm.updateDocumentTitle = () => {};
    tm.syncBackendPin = () => {};
    return tm;
}

// Build a Worker stub that, on receipt of a message, immediately
// posts an error back. Drives the reject() path of _loadArchiveRows.
function erroringWorkerClass() {
    return class {
        constructor() {
            this.onmessage = null;
            this.sent = [];
        }
        postMessage(message) {
            this.sent.push(message);
            queueMicrotask(() => {
                if (this.onmessage)
                    this.onmessage({
                        data: {
                            type: 'error',
                            paneId: message.paneId,
                            message: 'simulated worker failure',
                        },
                    });
            });
        }
        terminate() {}
    };
}

// Build a Worker stub that emits an empty rows array + done so the
// happy path can be exercised in jsdom too.
function successWorkerClass() {
    return class {
        constructor() {
            this.onmessage = null;
            this.sent = [];
        }
        postMessage(message) {
            this.sent.push(message);
            queueMicrotask(() => {
                if (this.onmessage)
                    this.onmessage({
                        data: {
                            type: 'rows',
                            paneId: message.paneId,
                            blocks: [],
                        },
                    });
                if (this.onmessage)
                    this.onmessage({
                        data: {
                            type: 'done',
                            paneId: message.paneId,
                            lines: 0,
                        },
                    });
            });
        }
        terminate() {}
    };
}

describe('archive overlay wiring', () => {
    it('creates an archive button on each tab and toggles the overlay on click', () => {
        vi.stubGlobal('Worker', successWorkerClass());
        const tm = makeTm();
        tm.createTab('p1', 's1', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p1');
        const btn = tab.archiveBtn;
        expect(btn).toBeTruthy();
        expect(btn.classList.contains('hidden')).toBe(true);
        // Mirror ATTACH_HEAD state so the overlay toggles open.
        tab.paneEpoch = 7;
        tab.paneOldest = 0;
        tab.queuedSeq = 5000; // > paneOldest → open is allowed
        btn.dispatchEvent(new Event('click', { bubbles: true }));
        expect(tab.archiveOpen).toBe(true);
        expect(tab.archiveOverlay).toBeTruthy();
        expect(tab.archiveOutput).toBeTruthy();
        // second click closes
        btn.dispatchEvent(new Event('click', { bubbles: true }));
        expect(tab.archiveOpen).toBe(false);
        expect(tab.archiveOverlay).toBe(null);
    });

    it('does not open the archive when no hot-v1 epoch is recorded', () => {
        vi.stubGlobal('Worker', successWorkerClass());
        const tm = makeTm();
        tm.createTab('p2', 's2', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p2');
        tab.paneEpoch = undefined;
        tab.paneOldest = undefined;
        tab.queuedSeq = undefined;
        tab.archiveBtn.dispatchEvent(new Event('click', { bubbles: true }));
        expect(tab.archiveOpen).toBeFalsy();
        expect(tab.archiveOverlay).toBeFalsy();
    });

    it('does not reject paneEpoch = 0', () => {
        // Round 1 of this commit caught !epoch dropping 0. pin that fix.
        vi.stubGlobal('Worker', successWorkerClass());
        const tm = makeTm();
        tm.createTab('p0', 's0', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p0');
        tab.paneEpoch = 0;
        tab.paneOldest = 0;
        tab.queuedSeq = 1000;
        tab.archiveBtn.dispatchEvent(new Event('click', { bubbles: true }));
        expect(tab.archiveOpen).toBe(true);
    });

    it('escape key closes the open overlay', () => {
        vi.stubGlobal('Worker', successWorkerClass());
        const tm = makeTm();
        tm.createTab('p3', 's3', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p3');
        tab.paneEpoch = 7;
        tab.paneOldest = 0;
        tab.queuedSeq = 100;
        tab.archiveBtn.dispatchEvent(new Event('click', { bubbles: true }));
        expect(tab.archiveOpen).toBe(true);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(tab.archiveOpen).toBe(false);
    });

    it('worker error reaches the overlay (Loading→error text)', async () => {
        vi.stubGlobal('Worker', erroringWorkerClass());

        // Stub the recording fetch to return a non-empty buffer so the
        // loader's `if (!fetched || fetched.bytes.byteLength === 0)
        // return ''` early-exit does NOT fire; this forces the code
        // path through startArchiveWorker and the onError→reject
        // contract that this test exercises.
        const recordingBytes = new TextEncoder().encode('archive-bytes');
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                arrayBuffer: async () => {
                    const json = new TextEncoder().encode(
                        JSON.stringify({
                            epoch: 7,
                            start: 0,
                            end: recordingBytes.byteLength,
                            resizes: [],
                        }),
                    );
                    const buf = new Uint8Array(
                        4 + json.byteLength + recordingBytes.byteLength,
                    );
                    new DataView(buf.buffer).setUint32(
                        0,
                        json.byteLength,
                        false,
                    );
                    buf.set(json, 4);
                    buf.set(recordingBytes, 4 + json.byteLength);
                    return buf.buffer.slice(0);
                },
            }),
        );

        const tm = makeTm();
        tm.createTab('p4', 's4', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p4');
        tab.paneEpoch = 7;
        tab.paneOldest = 0;
        tab.queuedSeq = 5000;

        // Drive the loader directly. Awaiting _loadArchiveRows and
        // attaching .then/.catch separately produces a test that
        // actually distinguishes resolution from rejection; the
        // previous chained-after-await pattern silently masked
        // rejections by skipping the .catch altogether. Promise.allSettled
        // observes the settled state without short-circuiting.
        const fulfilled = vi.fn();
        const rejected = vi.fn();
        const p = tm._loadArchiveRows(tab, 5000);
        p.then(fulfilled).catch(rejected);
        // The chain crosses three async boundaries: dynamic
        // import('./history.js'), fetchRange, and startArchiveWorker's
        // Worker.postMessage microtask. Give them ample room in jsdom.
        await new Promise((r) => setTimeout(r, 200));
        expect(fulfilled).not.toHaveBeenCalled();
        expect(rejected).toHaveBeenCalledTimes(1);
        const err = rejected.mock.calls[0]?.[0];
        expect(err).toBeInstanceOf(Error);
        expect(String(err.message)).toContain('simulated worker failure');
    });

    it('loads deep history from the oldest retained byte, not a 64 KiB tail', async () => {
        // UX-law regression: the archive once fetched [head-65536, head),
        // duplicating what scroll-up already shows. It must fetch from
        // paneOldest so beyond-scrollback history is actually visible.
        vi.stubGlobal('Worker', successWorkerClass());
        const seenUrls = [];
        const payload = new TextEncoder().encode('old-bytes');
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(async (url) => {
                seenUrls.push(String(url));
                const hdr = new TextEncoder().encode(
                    JSON.stringify({
                        epoch: 7,
                        start: 0,
                        end: payload.byteLength,
                        resizes: [],
                    }),
                );
                const buf = new Uint8Array(
                    4 + hdr.byteLength + payload.byteLength,
                );
                new DataView(buf.buffer).setUint32(0, hdr.byteLength, false);
                buf.set(hdr, 4);
                buf.set(payload, 4 + hdr.byteLength);
                return {
                    ok: true,
                    arrayBuffer: async () => buf.buffer.slice(0),
                };
            }),
        );
        const tm = makeTm();
        tm.createTab('p5', 's5', 'T', 'bash', '', '', false);
        const tab = tm.tabs.get('p5');
        tab.paneEpoch = 7;
        tab.paneOldest = 0;
        tab.queuedSeq = 500000; // >> 64 KiB: old code fetched from 434464
        await tm._loadArchiveRows(tab, 500000);
        expect(seenUrls.length).toBeGreaterThan(0);
        expect(seenUrls[0]).toContain('from=0');
        expect(seenUrls[0]).toContain('through=500000');
    });
});
