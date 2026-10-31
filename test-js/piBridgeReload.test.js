// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Browser coverage for native Reload dispatch through the shared
// slash path: normalization, readiness, delivery core, persistence,
// retirement, and the blocked-legacy rule.
//
// Harness discipline: Object.create(TabManager.prototype) with the
// REAL getActiveTab/sendSlashCommand/render methods driving off a
// real tabs Map + mutable activePaneId. Only boundaries are mocked:
// tab ws.sendInput, fetch, timers, focus, toasts.

setupDomHarness();
HTMLElement.prototype.scrollIntoView = () => {};

const PI_PRESETS = [
    { name: '/quit', value: '/quit\r' },
    { name: '/resume', value: '/resume\r' },
    { name: '/model', value: '/model\r' },
    { name: '/compact', value: '/compact\r' },
    { name: '/reload', value: '/reload\r' },
];

const READY = {
    process_id: 'proc-1',
    run_id: '0',
    context_revision: '0',
    reload_idle: true,
    reload_queued: false,
    reload_active: false,
    reload_compact_pending: false,
    reload_pending: false,
};

function makeTm() {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;
    tm.presetsContainer = document.createElement('div');
    tm.presetsContainer.id = 'presets-container';
    document.body.appendChild(tm.presetsContainer);
    const bar = document.createElement('div');
    bar.id = 'pi-rpc-status-bar';
    bar.className = 'pi-rpc-status-bar hidden';
    document.body.appendChild(bar);
    tm.piRpcStatusBar = bar;
    tm.copyInputBtn = document.createElement('button');
    tm.directModeToggle = document.createElement('button');
    const input = document.createElement('textarea');
    input.id = 'input-textarea';
    document.body.appendChild(input);
    tm.inputTextArea = input;
    tm.stagedAttachments = [];
    tm._spamScrollToBottom = vi.fn();
    tm.focusActiveTerminal = vi.fn();
    tm.updateDocumentTitle = vi.fn();
    tm._showReconnectOverlay = vi.fn();
    tm._updateHistoryButton = vi.fn();
    tm.maybeAutoReconnect = vi.fn();
    tm.updateDisconnectBanner = vi.fn();
    tm._piThinkingLevels = new Map();
    tm.app = {
        showToast: vi.fn(),
        codersPresetRegistry: { pi: { presets: [...PI_PRESETS] } },
    };
    return tm;
}

function makePiTab(paneId = 'pi-1', over = {}) {
    const ws = { sendInput: vi.fn(() => true) };
    return {
        paneId,
        coder: 'pi',
        cwd: '/home/u/work',
        title: 'pi',
        ws,
        isDead: false,
        directMode: false,
        tabEl: document.createElement('div'),
        termContainer: document.createElement('div'),
        ...over,
    };
}

// HTTP-shaped managed view with reload readiness.
function httpView(over = {}) {
    return {
        state: 'managed',
        generation: '2',
        telemetry_revision: '7',
        model: 'prov/model',
        capabilities: ['pi.reload.v1'],
        connected: true,
        ...READY,
        ...over,
    };
}

// WS-shaped frame: decimal strings stay strings, booleans arrive as
// true/false strings, capabilities comma-joined.
function wsFrame(tab, over = {}) {
    return {
        type: 'pi-bridge-state',
        pane_id: tab.paneId,
        state: 'managed',
        generation: '2',
        telemetry_revision: '7',
        model: 'prov/model',
        capabilities: 'pi.reload.v1',
        connected: 'true',
        process_id: 'proc-1',
        run_id: '0',
        context_revision: '0',
        reload_idle: 'true',
        reload_queued: 'false',
        reload_active: 'false',
        reload_compact_pending: 'false',
        reload_pending: 'false',
        ...over,
    };
}

// Seed HTTP (floor, never fresh) then confirm on the current socket.
function baseline(tm, tab, view = httpView(), frameOver = {}) {
    tm._seedHttpPiBridge(tab, view);
    tm._acceptPiBridgeState(tab, wsFrame(tab, frameOver), tab.ws);
}

function toasts(tm) {
    return tm.app.showToast.mock.calls.map(([message]) => message);
}

function deferred() {
    let resolve;
    const promise = new Promise((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

const tick = () => new Promise((res) => setTimeout(res, 0));

beforeEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 1024,
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('reload view normalization', () => {
    it('accepts the HTTP reload group with explicit zero counters', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;

        expect(tm._seedHttpPiBridge(tab, httpView())).toBe(true);
        expect(tab.piBridge.process_id).toBe('proc-1');
        expect(tab.piBridge.run_id).toBe('0');
        expect(tab.piBridge.context_revision).toBe('0');
        expect(tab.piBridge.reload_idle).toBe(true);
        expect(tab.piBridge.reload_queued).toBe(false);
        expect(tab.piBridge.reload_active).toBe(false);
        expect(tab.piBridge.reload_compact_pending).toBe(false);
        expect(tab.piBridge.reload_pending).toBe(false);
        expect(tab.piBridge.reload_high_water).toBeUndefined();
    });

    it('accepts WS string forms and an explicit high-water mark', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab, httpView(), {
            telemetry_revision: '8',
            run_id: '3',
            context_revision: '9',
            reload_high_water: '12',
        });
        expect(tab.piBridge.run_id).toBe('3');
        expect(tab.piBridge.context_revision).toBe('9');
        expect(tab.piBridge.reload_high_water).toBe('12');
        expect(tab.piBridge.reload_idle).toBe(true);
    });

    it('leaves partial groups unknown, never idle', () => {
        for (const over of [
            { reload_pending: undefined },
            { reload_idle: 'yes' },
            { run_id: '' },
            { run_id: undefined },
            { context_revision: undefined },
        ]) {
            const tm = makeTm();
            const tab = makePiTab();
            tm.tabs.set(tab.paneId, tab);
            tm.activePaneId = tab.paneId;
            baseline(tm, tab, httpView(), {
                telemetry_revision: '8',
                ...over,
            });
            expect(tab.piBridge.run_id).toBeUndefined();
            expect(tab.piBridge.reload_idle).toBeUndefined();
            expect(tab.piBridge.reload_pending).toBeUndefined();
        }
    });
});

describe('reload dispatch', () => {
    it('dispatches idle with fenced stamps and reports the receipt', async () => {
        const fetchSpy = mockFetch(() => ({
            status: 202,
            json: { outcome: 'dispatched', request_id: '1' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        tm.inputTextArea.value = 'kept draft';
        baseline(tm, tab);

        expect(tm.sendSlashCommand(tab, '/reload')).toBe(true);
        await tick();
        await tick();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, options] = fetchSpy.mock.calls[0];
        expect(url).toBe('/api/pi-bridge/reload');
        expect(options.method).toBe('POST');
        expect(JSON.parse(options.body)).toEqual({
            pane: 'pi-1',
            process_id: 'proc-1',
            generation: '2',
            telemetry_revision: '7',
            run_id: '0',
            context_revision: '0',
        });
        expect(toasts(tm)).toEqual(['Reload requested — check Pi']);
        expect(tab._piReloadIntent?.phase).toBe('requested');
        expect(tab._piReloadIntent?.requestId).toBe('1');
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
        expect(tm.inputTextArea.value).toBe('kept draft');
        expect(tm.focusActiveTerminal).toHaveBeenCalled();
    });

    it('a second press reports the marker instead of redispatching', async () => {
        const fetchSpy = mockFetch(() => ({
            status: 202,
            json: { outcome: 'dispatched', request_id: '1' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        tm.sendSlashCommand(tab, '/reload');
        await tick();
        await tick();
        tm.sendSlashCommand(tab, '/reload');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(toasts(tm)).toEqual([
            'Reload requested — check Pi',
            'Reload requested — check Pi',
        ]);
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
    });

    it('a refusal clears the marker for a new explicit decision', async () => {
        const fetchSpy = mockFetch(() => ({
            status: 409,
            json: { outcome: 'rejected-before-start', reason: 'busy' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        tm.sendSlashCommand(tab, '/reload');
        await tick();
        await tick();
        expect(toasts(tm)).toEqual(['Reload refused: busy']);
        expect(tab._piReloadIntent).toBeNull();
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
        // A later press is a new decision, not a replay.
        tm.sendSlashCommand(tab, '/reload');
        await tick();
        await tick();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('unavailable and hostile reasons stay in the safe vocabulary', async () => {
        const fetchSpy = mockFetch(() => ({
            status: 503,
            json: { outcome: 'rejected-before-start', reason: 'whatever' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        tm.sendSlashCommand(tab, '/reload');
        await tick();
        await tick();
        expect(toasts(tm)).toEqual(['Reload unavailable']);
        expect(tab._piReloadIntent).toBeNull();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('a failed round trip stays unconfirmed and persisted', async () => {
        mockFetch(() => {
            throw new Error('socket dead');
        });
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        tm.sendSlashCommand(tab, '/reload');
        await tick();
        await tick();
        expect(toasts(tm)).toEqual([
            'Reload unconfirmed — check Pi. Not retried.',
        ]);
        expect(tab._piReloadIntent?.phase).toBe('unconfirmed');
        const stored = JSON.parse(
            localStorage.getItem('phi.piBridge.reload.v1.pi-1'),
        );
        expect(stored.phase).toBe('unconfirmed');
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
    });

    it('a 202 without the opaque ID is unconfirmed, not requested', async () => {
        mockFetch(() => ({ status: 202, json: { outcome: 'dispatched' } }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        tm.sendSlashCommand(tab, '/reload');
        await tick();
        await tick();
        expect(toasts(tm)).toEqual([
            'Reload unconfirmed — check Pi. Not retried.',
        ]);
        expect(tab._piReloadIntent?.phase).toBe('unconfirmed');
        expect(tab._piReloadIntent?.requestId).toBeNull();
    });

    it('expiry reports unconfirmed once; the late reply stays silent', async () => {
        vi.useFakeTimers();
        const gate = deferred();
        mockFetch(() => gate.promise);
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        tm.sendSlashCommand(tab, '/reload');
        await vi.advanceTimersByTimeAsync(45_000);
        expect(toasts(tm)).toEqual([
            'Reload unconfirmed — check Pi. Not retried.',
        ]);
        gate.resolve({
            status: 202,
            json: { outcome: 'dispatched', request_id: '9' },
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(toasts(tm)).toHaveLength(1);
        expect(tab._piReloadIntent?.phase).toBe('unconfirmed');
    });
});

describe('reload readiness and fallback', () => {
    it('a busy press explains itself without sending', () => {
        const fetchSpy = mockFetch(() => ({}));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab, httpView(), {
            telemetry_revision: '8',
            reload_idle: 'false',
        });

        tm.sendSlashCommand(tab, '/reload');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
        expect(toasts(tm)).toEqual(['Reload not sent — Pi is busy']);
    });

    it('an unknown sample explains itself without sending', () => {
        const fetchSpy = mockFetch(() => ({}));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab, httpView(), {
            telemetry_revision: '8',
            reload_idle: undefined,
        });

        tm.sendSlashCommand(tab, '/reload');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
        expect(toasts(tm)).toEqual(['Reload not sent — Pi state is unknown']);
    });

    it('an unsupported press keeps the legacy atomic paste', () => {
        const fetchSpy = mockFetch(() => ({}));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        // Managed but without the reload capability.
        baseline(tm, tab, httpView({ capabilities: ['pi.context.v1'] }), {
            capabilities: 'pi.context.v1',
        });

        expect(tm.sendSlashCommand(tab, '/reload')).toBe(true);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(tab.ws.sendInput).toHaveBeenCalledTimes(1);
        expect(tab.ws.sendInput).toHaveBeenCalledWith(
            '\x1b[200~/reload\x1b[201~\r',
        );
        expect(toasts(tm)).toEqual([]);
    });

    it('a marker blocks the legacy path when capability is lost', async () => {
        const fetchSpy = mockFetch(() => ({
            status: 202,
            json: { outcome: 'dispatched', request_id: '1' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        tm.sendSlashCommand(tab, '/reload');
        await tick();
        await tick();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        // The capability drops but the process/runtime stand: the
        // marker still blocks a silent PTY duplicate.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '8',
                capabilities: 'pi.context.v1',
            }),
            tab.ws,
        );
        tm.sendSlashCommand(tab, '/reload');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
        expect(toasts(tm)).toEqual([
            'Reload requested — check Pi',
            'Reload requested — check Pi',
        ]);
    });

    it('a stale tab object dispatches nowhere', () => {
        const fetchSpy = mockFetch(() => ({}));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        const orphan = { ...tab };

        expect(tm.sendSlashCommand(orphan, '/reload')).toBe(true);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
        expect(toasts(tm)).toEqual([]);
    });
});

describe('reload persistence and retirement', () => {
    it('a restored sending marker weakens to unconfirmed', () => {
        const fetchSpy = mockFetch(() => ({}));
        localStorage.setItem(
            'phi.piBridge.reload.v1.pi-1',
            JSON.stringify({
                v: 1,
                id: 'r-old',
                phase: 'sending',
                paneId: 'pi-1',
                processId: 'proc-1',
                generation: '2',
                pubRev: '7',
                runId: '0',
                contextRevision: '0',
                requestId: null,
            }),
        );
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        tm.sendSlashCommand(tab, '/reload');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(toasts(tm)).toEqual([
            'Reload unconfirmed — check Pi. Not retried.',
        ]);
        expect(tab._piReloadIntent?.phase).toBe('unconfirmed');
    });

    it('malformed records are ignored without executing', () => {
        const fetchSpy = mockFetch(() => ({
            status: 409,
            json: { outcome: 'rejected-before-start', reason: 'busy' },
        }));
        for (const raw of [
            'not json',
            JSON.stringify({ v: 2, id: 'x' }),
            JSON.stringify({
                v: 1,
                id: 'x',
                phase: 'requested',
                paneId: 'other-pane',
                processId: 'proc-1',
                generation: '2',
                pubRev: '7',
                runId: '0',
                contextRevision: '0',
                requestId: null,
            }),
            JSON.stringify({
                v: 1,
                id: 'x',
                phase: 'requested',
                paneId: 'pi-1',
                processId: 'proc-1',
                generation: '02',
                pubRev: '7',
                runId: '0',
                contextRevision: '0',
                requestId: null,
            }),
        ]) {
            localStorage.clear();
            localStorage.setItem('phi.piBridge.reload.v1.pi-1', raw);
            const tm = makeTm();
            const tab = makePiTab();
            tm.tabs.set(tab.paneId, tab);
            tm.activePaneId = tab.paneId;
            baseline(tm, tab);
            tm.sendSlashCommand(tab, '/reload');
            expect(tab._piReloadIntent?.phase).not.toBe('requested');
        }
        expect(fetchSpy).toHaveBeenCalled();
    });

    it('release evidence retires the marker; a new press dispatches', async () => {
        const fetchSpy = mockFetch(() => ({
            status: 202,
            json: { outcome: 'dispatched', request_id: '1' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        tm.sendSlashCommand(tab, '/reload');
        await tick();
        await tick();
        expect(tab._piReloadIntent?.phase).toBe('requested');
        // Still pending: no retirement.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '8',
                reload_pending: 'true',
                reload_high_water: '1',
            }),
            tab.ws,
        );
        expect(tab._piReloadIntent?.phase).toBe('requested');
        // Released with a covering high-water mark: retired.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '9',
                reload_high_water: '1',
            }),
            tab.ws,
        );
        expect(tab._piReloadIntent).toBeNull();
        expect(localStorage.getItem('phi.piBridge.reload.v1.pi-1')).toBeNull();
        tm.sendSlashCommand(tab, '/reload');
        await tick();
        await tick();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('uses release evidence that arrived before a delayed receipt', async () => {
        const gate = deferred();
        const fetchSpy = mockFetch(() => gate.promise);
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.sendSlashCommand(tab, '/reload');

        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '8',
                reload_high_water: '1',
            }),
            tab.ws,
        );
        expect(tab._piReloadIntent?.phase).toBe('sending');
        gate.resolve({
            status: 202,
            json: { outcome: 'dispatched', request_id: '1' },
        });
        await tick();
        await tick();
        expect(tab._piReloadIntent).toBeNull();
        expect(localStorage.getItem('phi.piBridge.reload.v1.pi-1')).toBeNull();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
    });

    it('a marker for a replaced runtime clears for a new decision', async () => {
        const fetchSpy = mockFetch(() => ({
            status: 409,
            json: { outcome: 'rejected-before-start', reason: 'busy' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tab._piReloadIntent = {
            v: 1,
            id: 'r-old',
            phase: 'unconfirmed',
            paneId: 'pi-1',
            processId: 'proc-1',
            generation: '2',
            pubRev: '7',
            runId: '0',
            contextRevision: '0',
            requestId: null,
        };
        // A new runtime generation spends the old marker.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, { generation: '3', telemetry_revision: '8' }),
            tab.ws,
        );
        tm.sendSlashCommand(tab, '/reload');
        await tick();
        await tick();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(toasts(tm)).toEqual(['Reload refused: busy']);
    });
});

describe('reload lifecycle invalidation', () => {
    it('a socket swap keeps the waiter; the late receipt lands', async () => {
        const gate = deferred();
        mockFetch(() => gate.promise);
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        tm.sendSlashCommand(tab, '/reload');
        await tick();
        // Transport churn never orphans the receipt: the reload
        // replaces its own runtime, so invalidating there would
        // destroy the expected answer.
        const replacement = { sendInput: vi.fn(() => true) };
        tm._setCurrentTabSocket(tab, replacement);
        expect(toasts(tm)).toEqual([]);
        gate.resolve({
            status: 202,
            json: { outcome: 'dispatched', request_id: '9' },
        });
        await tick();
        await tick();
        expect(toasts(tm)).toEqual(['Reload requested — check Pi']);
        expect(tab._piReloadIntent?.phase).toBe('requested');
    });

    it('a newer idle snapshot never retires an ID-less marker', async () => {
        const gate = deferred();
        mockFetch(() => gate.promise);
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        tm.sendSlashCommand(tab, '/reload');
        await tick();
        expect(tab._piReloadIntent?.phase).toBe('sending');
        // A queue-delayed pre-dispatch snapshot carries a newer
        // revision with no pending work: without a receipt anchor
        // it proves nothing and must not retire.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, { telemetry_revision: '8' }),
            tab.ws,
        );
        expect(tab._piReloadIntent?.phase).toBe('sending');
        gate.resolve({
            status: 202,
            json: { outcome: 'dispatched', request_id: '1' },
        });
        await tick();
        await tick();
        expect(toasts(tm)).toEqual(['Reload requested — check Pi']);
    });

    it('an ID-less unconfirmed marker survives release-looking state', async () => {
        mockFetch(() => {
            throw new Error('socket dead');
        });
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        tm.sendSlashCommand(tab, '/reload');
        await tick();
        await tick();
        expect(tab._piReloadIntent?.phase).toBe('unconfirmed');
        expect(tab._piReloadIntent?.requestId).toBeNull();
        // No receipt anchor: even a covering high-water mark cannot
        // prove this operation released. The marker stands until its
        // target is spent or a new decision supersedes it.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '9',
                reload_high_water: '7',
            }),
            tab.ws,
        );
        expect(tab._piReloadIntent?.phase).toBe('unconfirmed');
        tm.sendSlashCommand(tab, '/reload');
        expect(toasts(tm)).toEqual([
            'Reload unconfirmed — check Pi. Not retried.',
            'Reload unconfirmed — check Pi. Not retried.',
        ]);
    });
});

describe('reload turn-scoped queue', () => {
    function runningBaseline(tm, tab) {
        tm._seedHttpPiBridge(tab, httpView({ running: true }));
        tm._acceptPiBridgeState(tab, wsFrame(tab, { running: 'true' }), tab.ws);
    }

    it('queues during the turn and cancels on a second press', () => {
        const fetchSpy = mockFetch(() => ({}));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        runningBaseline(tm, tab);

        tm.sendSlashCommand(tab, '/reload');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
        expect(toasts(tm)).toEqual(['Reload queued — runs when Pi is idle']);
        expect(tab._piReloadIntent?.phase).toBe('queued');
        expect(tab._piReloadIntent?.runId).toBe('0');
        expect(tab._piReloadIntent?.contextRevision).toBe('0');
        const stored = JSON.parse(
            localStorage.getItem('phi.piBridge.reload.v1.pi-1'),
        );
        expect(stored.phase).toBe('queued');

        tm.sendSlashCommand(tab, '/reload');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(toasts(tm)).toEqual([
            'Reload queued — runs when Pi is idle',
            'Queued reload cancelled',
        ]);
        expect(tab._piReloadIntent).toBeNull();
        expect(localStorage.getItem('phi.piBridge.reload.v1.pi-1')).toBeNull();
    });

    it('flushes once after the queued turn settles, without stealing focus', async () => {
        const fetchSpy = mockFetch(() => ({
            status: 202,
            json: { outcome: 'dispatched', request_id: '1' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        runningBaseline(tm, tab);
        tm.sendSlashCommand(tab, '/reload');
        expect(tab._piReloadIntent?.phase).toBe('queued');
        tm.focusActiveTerminal.mockClear();

        // A newer run starting first spends the wait into review.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, { telemetry_revision: '8', running: 'true' }),
            tab.ws,
        );
        expect(tab._piReloadIntent?.phase).toBe('queued');
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '9',
                running: 'false',
                run_id: '0',
                context_revision: '0',
            }),
            tab.ws,
        );
        await tick();
        await tick();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(toasts(tm)).toEqual([
            'Reload queued — runs when Pi is idle',
            'Reload requested — check Pi',
        ]);
        expect(tab._piReloadIntent?.phase).toBe('requested');
        expect(tm.focusActiveTerminal).not.toHaveBeenCalled();
    });

    it('a newer context spends the wait into review, never a later turn', async () => {
        const fetchSpy = mockFetch(() => ({
            status: 409,
            json: { outcome: 'rejected-before-start', reason: 'busy' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        runningBaseline(tm, tab);
        tm.sendSlashCommand(tab, '/reload');

        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '8',
                running: 'false',
                run_id: '1',
                context_revision: '0',
            }),
            tab.ws,
        );
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(tab._piReloadIntent?.phase).toBe('review');
        expect(toasts(tm)).toEqual([
            'Reload queued — runs when Pi is idle',
            'Reload not sent — review the current Pi session',
        ]);
        // A second press dismisses; only a later press dispatches.
        tm.sendSlashCommand(tab, '/reload');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(tab._piReloadIntent).toBeNull();
        tm.sendSlashCommand(tab, '/reload');
        await tick();
        await tick();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('observed queueing invalidates the wait even if it later clears', () => {
        mockFetch(() => ({}));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        runningBaseline(tm, tab);
        tm.sendSlashCommand(tab, '/reload');

        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '8',
                running: 'true',
                reload_queued: 'true',
            }),
            tab.ws,
        );
        expect(tab._piReloadIntent?.phase).toBe('review');
        // The queue draining does not revalidate the spent wait.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, { telemetry_revision: '9', running: 'false' }),
            tab.ws,
        );
        expect(tab._piReloadIntent?.phase).toBe('review');
    });

    it.each([
        ['peer disconnect', { connected: 'false' }],
        ['capability loss', { capabilities: '' }],
    ])(
        'keeps never-sent work queued through %s',
        async (_name, unavailable) => {
            const fetchSpy = mockFetch(() => ({
                status: 202,
                json: { outcome: 'dispatched', request_id: '1' },
            }));
            const tm = makeTm();
            const tab = makePiTab();
            tm.tabs.set(tab.paneId, tab);
            tm.activePaneId = tab.paneId;
            runningBaseline(tm, tab);
            tm.sendSlashCommand(tab, '/reload');

            tm._acceptPiBridgeState(
                tab,
                wsFrame(tab, {
                    telemetry_revision: '8',
                    running: 'false',
                    ...unavailable,
                }),
                tab.ws,
            );
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(tab._piReloadIntent?.phase).toBe('queued');
            expect(tab.ws.sendInput).not.toHaveBeenCalled();

            tm._acceptPiBridgeState(
                tab,
                wsFrame(tab, { telemetry_revision: '9', running: 'false' }),
                tab.ws,
            );
            await tick();
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        },
    );

    it('an HTTP seed alone never flushes the queue', async () => {
        const fetchSpy = mockFetch(() => ({
            status: 202,
            json: { outcome: 'dispatched', request_id: '1' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        runningBaseline(tm, tab);
        tm.sendSlashCommand(tab, '/reload');

        tm._seedHttpPiBridge(tab, httpView({ telemetry_revision: '9' }));
        await tick();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(tab._piReloadIntent?.phase).toBe('queued');
        // The matching current-socket sample flushes.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, { telemetry_revision: '9', running: 'false' }),
            tab.ws,
        );
        await tick();
        await tick();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});

describe('reload offline hold and restore', () => {
    it('holds a press while the socket is away and flushes on return', async () => {
        const fetchSpy = mockFetch(() => ({
            status: 202,
            json: { outcome: 'dispatched', request_id: '1' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        // The browser socket drops; the retained view stands.
        tab.ws = null;
        tab._piBridgeFresh = null;

        tm.sendSlashCommand(tab, '/reload');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(toasts(tm)).toEqual(['Reload queued — waiting for connection']);
        expect(tab._piReloadIntent?.phase).toBe('queued');
        // A stall without the socket never dispatches.
        tm._flushPiBridgeReloadQueue(tab);
        expect(fetchSpy).not.toHaveBeenCalled();

        const replacement = { sendInput: vi.fn(() => true) };
        tm._setCurrentTabSocket(tab, replacement);
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, { telemetry_revision: '8', running: 'false' }),
            tab.ws,
        );
        await tick();
        await tick();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(tab._piReloadIntent?.phase).toBe('requested');
    });

    it('a restored wait is review, never automatic work', () => {
        const fetchSpy = mockFetch(() => ({}));
        localStorage.setItem(
            'phi.piBridge.reload.v1.pi-1',
            JSON.stringify({
                v: 1,
                id: 'r-restored',
                phase: 'queued',
                paneId: 'pi-1',
                processId: 'proc-1',
                generation: '2',
                pubRev: '7',
                runId: '0',
                contextRevision: '0',
                requestId: null,
            }),
        );
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        tm.sendSlashCommand(tab, '/reload');
        expect(fetchSpy).not.toHaveBeenCalled();
        // Restored as review, dismissed by the press.
        expect(tab._piReloadIntent).toBeNull();
        expect(toasts(tm)).toEqual([]);
        // The turn settling now dispatches nothing by itself.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, { telemetry_revision: '8', running: 'false' }),
            tab.ws,
        );
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('a slow response body still finalizes exactly once', async () => {
        const gate = deferred();
        mockFetch(() => ({ status: 202, json: gate.promise }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        tm.sendSlashCommand(tab, '/reload');
        await tick();
        expect(toasts(tm)).toEqual([]);
        expect(tab._piReloadIntent?.phase).toBe('sending');
        gate.resolve({ outcome: 'dispatched', request_id: '4' });
        await tick();
        await tick();
        expect(toasts(tm)).toEqual(['Reload requested — check Pi']);
        expect(tab._piReloadIntent?.phase).toBe('requested');
        expect(tab._piReloadIntent?.requestId).toBe('4');
    });

    it('failed storage keeps memory authoritative without executing', async () => {
        mockFetch(() => ({
            status: 202,
            json: { outcome: 'dispatched', request_id: '1' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        const setItem = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(() => {
                throw new Error('quota exceeded');
            });
        try {
            tm.sendSlashCommand(tab, '/reload');
            await tick();
            await tick();
        } finally {
            setItem.mockRestore();
        }
        expect(toasts(tm)).toEqual(['Reload requested — check Pi']);
        expect(tab._piReloadIntent?.phase).toBe('requested');
        expect(localStorage.getItem('phi.piBridge.reload.v1.pi-1')).toBeNull();
        // The memory marker still blocks a duplicate dispatch.
        tm.sendSlashCommand(tab, '/reload');
        expect(toasts(tm)).toEqual([
            'Reload requested — check Pi',
            'Reload requested — check Pi',
        ]);
    });
});

describe('reload Cmds row states', () => {
    function openMenu(tm) {
        let dropup = document.getElementById('quick-commands-dropup');
        if (!dropup) {
            dropup = document.createElement('div');
            dropup.id = 'quick-commands-dropup';
            dropup.classList.add('hidden');
            document.body.appendChild(dropup);
        }
        tm.renderQuickCmdsDropup();
        dropup.classList.remove('hidden');
        return dropup;
    }

    function reloadRow() {
        const btn = document.querySelector(
            '#quick-commands-dropup .pi-reload-btn',
        );
        return {
            btn,
            row: btn?.closest('.dropup-row'),
            dismiss: document.querySelector(
                '#quick-commands-dropup .pi-reload-dismiss-btn',
            ),
            status: document.querySelector(
                '#quick-commands-dropup #pi-reload-status',
            ),
        };
    }

    it('shows restored uncertainty as soon as Cmds opens, without a send', () => {
        const fetchSpy = mockFetch(() => ({}));
        localStorage.setItem(
            'phi.piBridge.reload.v1.pi-1',
            JSON.stringify({
                v: 1,
                id: 'r-restored',
                phase: 'sending',
                paneId: 'pi-1',
                processId: 'proc-1',
                generation: '2',
                pubRev: '7',
                runId: '0',
                contextRevision: '0',
                requestId: null,
            }),
        );
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        openMenu(tm);

        expect(reloadRow().status?.textContent).toBe(
            'Reload unconfirmed — check Pi. Not retried.',
        );
        expect(reloadRow().dismiss).not.toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
    });

    it('renders queued state with no dismiss control', () => {
        mockFetch(() => ({}));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        tm._seedHttpPiBridge(tab, httpView({ running: true }));
        tm._acceptPiBridgeState(tab, wsFrame(tab, { running: 'true' }), tab.ws);
        tm.sendSlashCommand(tab, '/reload');
        openMenu(tm);

        const { btn, dismiss, status } = reloadRow();
        expect(btn?.innerText).toBe('/reload');
        expect(btn?.title).toBe('Reload queued — press to cancel');
        expect(btn?.classList.contains('pi-reload-queued')).toBe(true);
        expect(dismiss).toBeNull();
        expect(status).toBeNull();
        // The ::after queued marker itself renders in the browser;
        // the e2e queue spec asserts its visible text there.
    });

    it('renders unconfirmed state with a working dismiss control', async () => {
        mockFetch(() => {
            throw new Error('socket dead');
        });
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.sendSlashCommand(tab, '/reload');
        await tick();
        await tick();
        openMenu(tm);

        const first = reloadRow();
        expect(first.btn?.innerText).toBe('/reload');
        expect(first.btn?.title).toBe(
            'Reload unconfirmed — check Pi. Not retried.',
        );
        expect(first.btn?.classList.contains('pi-reload-queued')).toBe(false);
        expect(first.btn?.getAttribute('aria-describedby')).toBe(
            'pi-reload-status',
        );
        expect(first.status?.textContent).toBe(
            'Reload unconfirmed — check Pi. Not retried.',
        );
        expect(first.dismiss?.textContent).toBe('Dismiss');
        expect(first.dismiss?.getAttribute('aria-label')).toBe(
            'Dismiss reload status',
        );
        expect(first.dismiss?.closest('.dropup-row-actions')).not.toBeNull();
        expect(first.dismiss?.closest('button.pi-reload-btn')).toBeNull();

        first.dismiss?.click();
        expect(tab._piReloadIntent).toBeNull();
        expect(localStorage.getItem('phi.piBridge.reload.v1.pi-1')).toBeNull();
        const second = reloadRow();
        expect(second.btn?.title).toBe('');
        expect(second.dismiss).toBeNull();
        expect(second.status).toBeNull();
        // Dismissal keeps the menu open for the next decision.
        const dropup = document.getElementById('quick-commands-dropup');
        expect(dropup.classList.contains('hidden')).toBe(false);
    });

    it('patches the open row in place without replacing focus', async () => {
        const gate = deferred();
        mockFetch(() => gate.promise);
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.sendSlashCommand(tab, '/reload');
        await tick();
        openMenu(tm);

        const before = reloadRow();
        expect(before.btn?.title).toBe('Reload sending…');
        before.btn?.focus();
        gate.resolve({
            status: 202,
            json: { outcome: 'dispatched', request_id: '1' },
        });
        await tick();
        await tick();
        const after = reloadRow();
        expect(after.btn).toBe(before.btn);
        expect(after.btn?.title).toBe('Reload requested — check Pi');
        expect(after.dismiss?.textContent).toBe('Dismiss');
        expect(document.activeElement).toBe(after.btn);

        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '8',
                reload_high_water: '1',
            }),
            tab.ws,
        );
        expect(reloadRow().btn).toBe(before.btn);
        expect(reloadRow().btn?.title).toBe('');
        expect(reloadRow().dismiss).toBeNull();
        expect(document.activeElement).toBe(before.btn);
    });
});

describe('reload explicit offline signal', () => {
    it('holds an eligible press while navigator reports offline', async () => {
        const fetchSpy = mockFetch(() => ({
            status: 202,
            json: { outcome: 'dispatched', request_id: '1' },
        }));
        Object.defineProperty(window.navigator, 'onLine', {
            configurable: true,
            value: false,
        });
        try {
            const tm = makeTm();
            const tab = makePiTab();
            tm.tabs.set(tab.paneId, tab);
            tm.activePaneId = tab.paneId;
            baseline(tm, tab);

            tm.sendSlashCommand(tab, '/reload');
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(toasts(tm)).toEqual([
                'Reload queued — waiting for connection',
            ]);
            expect(tab._piReloadIntent?.phase).toBe('queued');
            // Established sockets can still deliver state while the
            // browser reports offline. Such a frame is not a send gate.
            tm._acceptPiBridgeState(
                tab,
                wsFrame(tab, { telemetry_revision: '8' }),
                tab.ws,
            );
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(tab._piReloadIntent?.phase).toBe('queued');
        } finally {
            Object.defineProperty(window.navigator, 'onLine', {
                configurable: true,
                value: true,
            });
        }
    });
});
