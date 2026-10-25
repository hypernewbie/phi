// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch, stubWebSocket } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// The reconnect and restart sockets get their own close callbacks, so
// the lifecycle regressions below drive those real callbacks instead
// of _handleTerminalDisconnect. Nothing else in this file constructs a
// PTYWebSocket, so the stub stays inert for the rest of the suite.
const socketLog = vi.hoisted(() => ({ made: [] }));
vi.mock('../web/ws.js', () => ({
    PTYWebSocket: class {
        constructor(paneId, onData, onControl, onClose, onOpen, opts) {
            Object.assign(this, {
                paneId,
                onData,
                onControl,
                onClose,
                onOpen,
                opts,
            });
            this.close = vi.fn();
            this.sendInput = vi.fn(() => true);
            socketLog.made.push(this);
        }
    },
}));

// Lane C browser coverage: bridge context meter reuse plus native
// Compact dispatch through the shared slash path.
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
    { name: '/copy', value: '/copy\r' },
];

const READY = {
    compact_idle: true,
    compact_queued: false,
    compact_active: false,
    compact_pending: false,
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
    tm.piThinkingBtn = document.createElement('button');
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

// HTTP-shaped managed view: numbers for context, bools for readiness.
function httpView(over = {}) {
    return {
        state: 'managed',
        generation: '2',
        telemetry_revision: '7',
        model: 'prov/model',
        capabilities: ['pi.context.v1', 'pi.compact.v1'],
        connected: true,
        context_tokens: 4000,
        context_window: 10000,
        context_percent: 40,
        ...READY,
        ...over,
    };
}

// WS-shaped frame: decimal strings for context, true/false strings
// for readiness, comma-joined capabilities.
function wsFrame(tab, over = {}) {
    return {
        type: 'pi-bridge-state',
        pane_id: tab.paneId,
        state: 'managed',
        generation: '2',
        telemetry_revision: '7',
        model: 'prov/model',
        capabilities: 'pi.context.v1,pi.compact.v1',
        connected: 'true',
        context_tokens: '4000',
        context_window: '10000',
        context_percent: '40',
        compact_idle: 'true',
        compact_queued: 'false',
        compact_active: 'false',
        compact_pending: 'false',
        ...over,
    };
}

// Seed HTTP (floor, never fresh) then confirm on the current socket.
function baseline(tm, tab, view = httpView(), frameOver = {}) {
    tm._seedHttpPiBridge(tab, view);
    tm._acceptPiBridgeState(tab, wsFrame(tab, frameOver), tab.ws);
}

function meter() {
    const bar = document.getElementById('pi-rpc-status-bar');
    const el = bar.querySelector('.pi-rpc-context-meter');
    return {
        bar,
        el,
        fill: el?.querySelector('.pi-rpc-context-meter-fill'),
        text: el?.querySelector('.pi-rpc-context-meter-text'),
    };
}

function desktopCompact(tm) {
    // Buttons are labelled via innerText; this jsdom keeps the
    // innerText value without materializing text nodes.
    return Array.from(tm.presetsContainer.querySelectorAll('.preset-btn')).find(
        (b) => b.innerText === '/compact',
    );
}

function slashDropup() {
    let dropup = document.getElementById('slash-presets-dropup');
    if (!dropup) {
        dropup = document.createElement('div');
        dropup.id = 'slash-presets-dropup';
        document.body.appendChild(dropup);
    }
    return dropup;
}

function mobileCompact() {
    return Array.from(
        slashDropup().querySelectorAll('button.dropup-model-btn'),
    ).find((b) => b.innerText === '/compact');
}

function deferred() {
    let resolve;
    const promise = new Promise((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

beforeEach(() => {
    vi.useRealTimers();
});

afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: 1024,
    });
});

describe('context telemetry normalization', () => {
    it('accepts HTTP numbers and WS decimal strings under the same names', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;

        expect(tm._seedHttpPiBridge(tab, httpView())).toBe(true);
        expect(tab.piBridge.context_tokens).toBe(4000);
        expect(tab.piBridge.context_window).toBe(10000);
        expect(tab.piBridge.context_percent).toBe(40);
        expect(tab.piBridge.compact_idle).toBe(true);
        expect(tab.piBridge.compact_pending).toBe(false);

        const tab2 = makePiTab('pi-2');
        tm.tabs.set(tab2.paneId, tab2);
        tm._acceptPiBridgeState(tab2, wsFrame(tab2), tab2.ws);
        expect(tab2.piBridge.context_tokens).toBe(4000);
        expect(tab2.piBridge.context_window).toBe(10000);
        expect(tab2.piBridge.context_percent).toBe(40);
        expect(tab2.piBridge.compact_idle).toBe(true);
        expect(tab2.piBridge.compact_queued).toBe(false);
    });

    it('treats absence as unknown and explicit zero tokens as known', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                context_tokens: '0',
                context_window: '10000',
                context_percent: '0',
            }),
            tab.ws,
        );
        expect(tab.piBridge.context_tokens).toBe(0);
        expect(tab.piBridge.context_window).toBe(10000);
        expect(tab.piBridge.context_percent).toBe(0);

        const absent = makePiTab('pi-absent');
        tm.tabs.set(absent.paneId, absent);
        tm._acceptPiBridgeState(
            absent,
            {
                type: 'pi-bridge-state',
                pane_id: absent.paneId,
                state: 'managed',
                generation: '2',
                telemetry_revision: '7',
            },
            absent.ws,
        );
        expect('context_tokens' in absent.piBridge).toBe(false);
        expect('context_window' in absent.piBridge).toBe(false);
        expect('context_percent' in absent.piBridge).toBe(false);
        expect('compact_idle' in absent.piBridge).toBe(false);
    });

    it('fails closed on invalid samples without coercing to zero', () => {
        const tm = makeTm();
        const cases = [
            [{ context_tokens: true }, 'context_tokens'],
            [{ context_tokens: 'abc' }, 'context_tokens'],
            [{ context_tokens: '' }, 'context_tokens'],
            [{ context_tokens: null }, 'context_tokens'],
            [{ context_tokens: -5 }, 'context_tokens'],
            [{ context_tokens: Number.NaN }, 'context_tokens'],
            [{ context_tokens: Number.POSITIVE_INFINITY }, 'context_tokens'],
            [{ context_tokens: 9007199254740992 }, 'context_tokens'],
            [{ context_window: 0 }, 'context_window'],
            [{ context_window: -1 }, 'context_window'],
            [{ context_window: 9007199254740992 }, 'context_window'],
            [{ context_percent: -1 }, 'context_percent'],
            // Percent without known tokens is omitted even when valid.
            [{ context_percent: 40 }, 'context_percent'],
        ];
        let i = 0;
        for (const [fields, missing] of cases) {
            const tab = makePiTab(`pi-inv-${i++}`);
            tm.tabs.set(tab.paneId, tab);
            const view = httpView();
            delete view.context_tokens;
            delete view.context_window;
            delete view.context_percent;
            Object.assign(view, fields);
            tm._seedHttpPiBridge(tab, view);
            expect(tab.piBridge[missing]).toBeUndefined();
        }
        // Boundary magnitude stays accepted.
        const edge = makePiTab('pi-edge');
        tm.tabs.set(edge.paneId, edge);
        tm._seedHttpPiBridge(
            edge,
            httpView({
                context_tokens: 9007199254740991,
                context_window: 9007199254740991,
            }),
        );
        expect(edge.piBridge.context_tokens).toBe(9007199254740991);
        expect(edge.piBridge.context_window).toBe(9007199254740991);
    });

    it('keeps readiness unknown unless the group is complete and valid', () => {
        const tm = makeTm();
        const good = makePiTab('pi-good');
        tm.tabs.set(good.paneId, good);
        tm._seedHttpPiBridge(tm.tabs.get('pi-good'), httpView());
        expect(good.piBridge.compact_idle).toBe(true);

        const drops = [
            { compact_idle: undefined },
            { compact_queued: 'yes' },
            { compact_active: 1 },
            { compact_pending: '' },
            { compact_idle: null },
        ];
        let i = 0;
        for (const fields of drops) {
            const tab = makePiTab(`pi-r-${i++}`);
            tm.tabs.set(tab.paneId, tab);
            const view = httpView();
            for (const [k, v] of Object.entries(fields)) {
                if (v === undefined) delete view[k];
                else view[k] = v;
            }
            tm._seedHttpPiBridge(tab, view);
            expect('compact_idle' in tab.piBridge).toBe(false);
            expect('compact_queued' in tab.piBridge).toBe(false);
            expect('compact_active' in tab.piBridge).toBe(false);
            expect('compact_pending' in tab.piBridge).toBe(false);
        }
    });
});

describe('ordered context/readiness updates', () => {
    it('confirms freshness on an agreeing equal revision, rejects conflicts', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        tm._seedHttpPiBridge(tab, httpView());
        expect(tab._piBridgeFresh).toBeUndefined();

        // Conflicting tokens at equal rev: rejected, still unfresh.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, { context_tokens: '5000' }),
            tab.ws,
        );
        expect(tab.piBridge.context_tokens).toBe(4000);
        expect(tab._piBridgeFresh).toBeUndefined();

        // Conflicting readiness at equal rev: rejected.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, { compact_idle: 'false' }),
            tab.ws,
        );
        expect(tab.piBridge.compact_idle).toBe(true);
        expect(tab._piBridgeFresh).toBeUndefined();

        // Conflicting generation at equal rev: rejected.
        tm._acceptPiBridgeState(tab, wsFrame(tab, { generation: '3' }), tab.ws);
        expect(tab.piBridge.generation).toBe('2');
        expect(tab._piBridgeFresh).toBeUndefined();

        // Agreeing equal rev: accepted, fresh.
        tm._acceptPiBridgeState(tab, wsFrame(tab), tab.ws);
        expect(tab._piBridgeFresh).toBe(tab.ws);
        expect(tab.piBridge.context_tokens).toBe(4000);
    });

    it('propagates an equal-revision peer-down and hides the meter', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        expect(meter().el).not.toBeNull();

        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, { connected: 'false' }),
            tab.ws,
        );
        expect(tab.piBridge.connected).toBe(false);
        expect(tab._piBridgeFresh).toBe(tab.ws);
        expect(meter().el).toBeNull();
        expect(meter().bar.classList.contains('hidden')).toBe(true);
        // Legacy controls return while the peer is down.
        tm.renderPresets('pi');
        expect(desktopCompact(tm).disabled).toBe(false);
    });

    it('adopts newer revisions and rejects stale-socket frames', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '8',
                context_tokens: '9000',
                context_window: '10000',
            }),
            tab.ws,
        );
        expect(tab.piBridge.context_tokens).toBe(9000);
        expect(meter().text.textContent).toBe('9K / 10K');

        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '9',
                context_tokens: '9500',
            }),
            { sendInput: vi.fn() },
        );
        expect(tab.piBridge.context_tokens).toBe(9000);
        expect(tab._piBridgeRev).toBe(8n);
    });

    it('waits for a current-WS baseline after HTTP seed and reconnect', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;

        // HTTP alone is not fresh: no meter.
        tm._seedHttpPiBridge(tab, httpView());
        tm.renderPiRpcStatusBar();
        expect(meter().el).toBeNull();

        // Current-socket baseline shows it.
        tm._acceptPiBridgeState(tab, wsFrame(tab), tab.ws);
        expect(meter().el).not.toBeNull();

        // A new socket drops freshness until it re-baselines small.
        const ws2 = { sendInput: vi.fn(() => true) };
        tm._setCurrentTabSocket(tab, ws2);
        expect(tab._piBridgeFresh).toBeNull();
        expect(meter().el).toBeNull();
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '3',
                context_tokens: '1000',
            }),
            tab.ws,
        );
        expect(meter().el).not.toBeNull();
        expect(meter().text.textContent).toBe('1K / 10K');
    });

    it('keeps two panes and both capabilities independent', () => {
        const tm = makeTm();
        const ctxOnly = makePiTab('pi-ctx');
        const compactOnly = makePiTab('pi-compact');
        tm.tabs.set(ctxOnly.paneId, ctxOnly);
        tm.tabs.set(compactOnly.paneId, compactOnly);
        tm.activePaneId = ctxOnly.paneId;

        tm._seedHttpPiBridge(
            ctxOnly,
            httpView({ capabilities: ['pi.context.v1'] }),
        );
        tm._acceptPiBridgeState(
            ctxOnly,
            wsFrame(ctxOnly, { capabilities: 'pi.context.v1' }),
            ctxOnly.ws,
        );
        tm._seedHttpPiBridge(
            compactOnly,
            httpView({ capabilities: ['pi.compact.v1'] }),
        );
        tm._acceptPiBridgeState(
            compactOnly,
            wsFrame(compactOnly, { capabilities: 'pi.compact.v1' }),
            compactOnly.ws,
        );

        expect(tm._piBridgeContextEligible(ctxOnly)).toBe(true);
        expect(tm._piBridgeCompactEligible(ctxOnly)).toBe(false);
        expect(tm._piBridgeContextEligible(compactOnly)).toBe(false);
        expect(tm._piBridgeCompactEligible(compactOnly)).toBe(true);

        // Context-only pane shows the meter but keeps legacy Compact.
        expect(meter().el).not.toBeNull();
        tm.renderPresets('pi');
        expect(desktopCompact(tm).disabled).toBe(false);
        expect(desktopCompact(tm).title).toBe('');
        expect(tm.sendSlashCommand(ctxOnly, '/compact')).toBe(true);
        expect(ctxOnly.ws.sendInput).toHaveBeenCalledWith(
            '\x1b[200~/compact\x1b[201~\r',
        );

        // Compact-only pane hides the meter.
        tm.activePaneId = compactOnly.paneId;
        tm.renderPiRpcStatusBar();
        expect(meter().el).toBeNull();
    });
});

describe('reused context meter', () => {
    it('renders known usage with exact color, text, and ARIA', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        const m = meter();
        expect(m.bar.classList.contains('hidden')).toBe(false);
        expect(m.el.getAttribute('role')).toBe('progressbar');
        expect(m.el.getAttribute('aria-valuemin')).toBe('0');
        expect(m.el.getAttribute('aria-valuemax')).toBe('100');
        expect(m.el.getAttribute('aria-valuenow')).toBe('40');
        expect(m.el.getAttribute('aria-label')).toBe('Context: 4K / 10K');
        expect(m.fill.style.width).toBe('40%');
        expect(
            m.fill.classList.contains('pi-rpc-context-meter-fill--mid'),
        ).toBe(true);
        expect(
            m.fill.classList.contains('pi-rpc-context-meter-fill--yellow'),
        ).toBe(true);
        expect(m.text.textContent).toBe('4K / 10K');
        // Real cwd/model ride the shared rows.
        expect(m.bar.querySelector('.pi-rpc-status-cwd').textContent).toBe(
            '~/work',
        );
        expect(m.bar.querySelector('.pi-rpc-status-model').textContent).toBe(
            'prov/model',
        );
    });

    it('pins low/high thresholds exactly like the RPC meter', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;

        baseline(
            tm,
            tab,
            httpView({ context_tokens: 3999, context_window: 10000 }),
            { context_tokens: '3999', context_window: '10000' },
        );
        let m = meter();
        expect(m.el.getAttribute('aria-valuenow')).toBe('40');
        expect(
            m.fill.classList.contains('pi-rpc-context-meter-fill--low'),
        ).toBe(true);

        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '8',
                context_tokens: '7010',
                context_window: '10000',
            }),
            tab.ws,
        );
        m = meter();
        expect(m.el.getAttribute('aria-valuenow')).toBe('70.1');
        expect(
            m.fill.classList.contains('pi-rpc-context-meter-fill--high'),
        ).toBe(true);
        expect(
            m.fill.classList.contains('pi-rpc-context-meter-fill--red'),
        ).toBe(true);
    });

    it('shows a dash for unknown occupancy and keeps a known window', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        const view = httpView();
        delete view.context_tokens;
        delete view.context_percent;
        tm._seedHttpPiBridge(tab, view);
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                context_tokens: undefined,
                context_percent: undefined,
            }),
            tab.ws,
        );
        // The frame above carries explicit undefined fields; rebuild
        // without them to assert true absence end to end.
        const tab2 = makePiTab('pi-2');
        tm.tabs.set(tab2.paneId, tab2);
        tm.activePaneId = tab2.paneId;
        const sparse = httpView();
        delete sparse.context_tokens;
        delete sparse.context_percent;
        tm._seedHttpPiBridge(tab2, sparse);
        tm._acceptPiBridgeState(
            tab2,
            {
                type: 'pi-bridge-state',
                pane_id: tab2.paneId,
                state: 'managed',
                generation: '2',
                telemetry_revision: '7',
                model: 'prov/model',
                capabilities: 'pi.context.v1,pi.compact.v1',
                connected: 'true',
                context_window: '10000',
                compact_idle: 'true',
                compact_queued: 'false',
                compact_active: 'false',
                compact_pending: 'false',
            },
            tab2.ws,
        );
        const m = meter();
        expect(m.el).not.toBeNull();
        expect(m.el.hasAttribute('aria-valuenow')).toBe(false);
        expect(m.fill.style.width).toBe('0%');
        expect(m.text.textContent).toBe('— / 10K');
        expect(m.el.getAttribute('aria-label')).toBe('Context: — / 10K');
        for (const cls of [
            '--low',
            '--mid',
            '--high',
            '--green',
            '--yellow',
            '--red',
        ]) {
            expect(
                m.fill.classList.contains(`pi-rpc-context-meter-fill${cls}`),
            ).toBe(false);
        }
    });

    it('never fabricates RPC totals, cache, cost, or thinking', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        const bar = document.getElementById('pi-rpc-status-bar');
        expect(bar.querySelector('.pi-rpc-status-tokens').textContent).toBe('');
        expect(bar.querySelector('.pi-rpc-status-model').textContent).toBe(
            'prov/model',
        );
        expect(tm.piThinkingBtn.classList.contains('hidden')).toBe(true);
    });

    it('treats explicit zero tokens as known with a zero fill', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab, httpView({ context_tokens: 0, context_percent: 0 }), {
            context_tokens: '0',
            context_percent: '0',
        });
        const m = meter();
        expect(m.el.getAttribute('aria-valuenow')).toBe('0');
        expect(m.fill.style.width).toBe('0%');
        expect(m.text.textContent).toBe('0 / 10K');
        expect(
            m.fill.classList.contains('pi-rpc-context-meter-fill--low'),
        ).toBe(true);
    });
});

describe('meter and control lifecycle', () => {
    it('hides the meter on PTY exit and restores legacy controls', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        expect(meter().el).not.toBeNull();

        tm.handleControlMessage(tab, { type: 'pty-exited', code: 0 }, tab.ws);
        expect(tab.isDead).toBe(true);
        expect(meter().el).toBeNull();
        expect(desktopCompact(tm).disabled).toBe(false);
        expect(desktopCompact(tm).title).toBe('');
    });

    it('hides the meter on socket disconnect without killing the tab', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        expect(meter().el).not.toBeNull();

        tm._handleTerminalDisconnect(tab);
        expect(tab.isDead).toBe(true);
        expect(meter().el).toBeNull();
    });

    it('hides the meter on restart and re-baselines on the new lease', async () => {
        stubWebSocket();
        const fetchMock = mockFetch((url) => {
            if (String(url).includes('/api/terminals'))
                return { pane_id: 'pi-2', session_id: 'sess-2' };
            return undefined;
        });
        const tm = makeTm();
        tm.app.sessionsManager = { loadSessions: vi.fn() };
        const tab = makePiTab();
        tab.sessionId = 'sess-1';
        tab.term = { reset: vi.fn() };
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        expect(meter().el).not.toBeNull();

        tm.restartTab(tab);
        await vi.waitFor(() => expect(tab.paneId).toBe('pi-2'));
        expect(fetchMock).toHaveBeenCalled();
        expect(tab.piBridge).toBeUndefined();
        expect(tab._piBridgeRev).toBeNull();
        expect(meter().el).toBeNull();
        // Legacy controls until the new lease baselines.
        expect(desktopCompact(tm).disabled).toBe(false);
    });

    it('follows the active tab across a real tab switch', () => {
        const tm = makeTm();
        tm.inputBarContainer = document.createElement('div');
        tm.saveTabsState = vi.fn();
        tm.activateTabViewport = vi.fn();
        tm._syncProjectForTab = vi.fn(() => false);
        const termStub = () => ({
            buffer: { active: { viewportY: 0, baseY: 0 } },
        });
        const live = makePiTab('pi-live');
        live.term = termStub();
        const plain = makePiTab('pi-plain');
        plain.term = termStub();
        for (const tab of [live, plain]) {
            const title = document.createElement('span');
            title.className = 'tab-title';
            tab.tabEl.appendChild(title);
            document.body.appendChild(tab.tabEl);
            document.body.appendChild(tab.termContainer);
            tm.tabs.set(tab.paneId, tab);
        }
        tm.activePaneId = live.paneId;
        baseline(tm, live);
        expect(meter().el).not.toBeNull();

        tm.switchTab(plain.paneId);
        expect(meter().el).toBeNull();
        expect(desktopCompact(tm).disabled).toBe(false);

        tm.switchTab(live.paneId);
        expect(meter().el).not.toBeNull();
    });

    it('refreshes the meter on context-only updates without model churn', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        expect(meter().text.textContent).toBe('4K / 10K');

        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '8',
                context_tokens: '2000',
                context_window: '10000',
            }),
            tab.ws,
        );
        expect(meter().text.textContent).toBe('2K / 10K');
    });
});

describe('native compact dispatch', () => {
    it('posts exact fields from the desktop preset and reports completion', async () => {
        const fetchMock = mockFetch(() => ({
            ok: true,
            status: 200,
            json: { outcome: 'completed', request_id: '9' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.inputTextArea.value = 'staged draft';
        tm.stagedAttachments = [
            {
                id: 'a1',
                name: 'shot.png',
                path: '/tmp/shot.png',
                type: 'image/png',
                sizeBytes: 3,
                source: 'paste',
            },
        ];

        tm.renderPresets('pi');
        const btn = desktopCompact(tm);
        expect(btn.disabled).toBe(false);
        expect(btn.title).toBe('Compact via bridge');
        btn.click();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/pi-bridge/compact');
        expect(options.method).toBe('POST');
        expect(options.headers).toEqual({
            'Content-Type': 'application/json',
        });
        expect(options.cache).toBe('no-store');
        expect(options.signal).toBeInstanceOf(AbortSignal);
        const body = JSON.parse(options.body);
        expect(Object.keys(body).sort()).toEqual([
            'generation',
            'pane',
            'telemetry_revision',
        ]);
        expect(body).toEqual({
            pane: 'pi-1',
            generation: '2',
            telemetry_revision: '7',
        });
        // Pending disables the control synchronously; the PTY stays quiet.
        expect(desktopCompact(tm).disabled).toBe(true);
        expect(desktopCompact(tm).title).toBe('Compacting…');
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
        expect(tm.focusActiveTerminal).toHaveBeenCalled();

        await vi.waitFor(() =>
            expect(tm.app.showToast).toHaveBeenCalledWith(
                'Compaction complete',
                { type: 'success', title: 'Compact' },
            ),
        );
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
        expect(tm.inputTextArea.value).toBe('staged draft');
        expect(tm.stagedAttachments).toHaveLength(1);
        expect(desktopCompact(tm).disabled).toBe(false);
    });

    it('dispatches from the real mobile slash dropup and keeps it blurred', async () => {
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: 400,
        });
        const fetchMock = mockFetch(() => ({
            ok: true,
            status: 200,
            json: { outcome: 'completed' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        const slashPresets = PI_PRESETS.filter((p) => p.value.startsWith('/'));
        slashDropup();
        tm.renderSlashDropup(slashPresets);
        const btn = mobileCompact();
        expect(btn).toBeTruthy();
        expect(btn.disabled).toBe(false);
        expect(btn.title).toBe('Compact via bridge');
        tm.inputTextArea.focus();
        btn.click();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
        // Mobile slash callers pass focusInputOnMobile:false.
        expect(document.activeElement).not.toBe(tm.inputTextArea);
        expect(tm.focusActiveTerminal).not.toHaveBeenCalled();
        await vi.waitFor(() =>
            expect(tm.app.showToast).toHaveBeenCalledWith(
                'Compaction complete',
                expect.anything(),
            ),
        );
    });

    it('maps refusal, failure, unknown, and invalid replies safely', async () => {
        const replies = [
            {
                status: 409,
                json: { outcome: 'rejected-before-start', reason: 'busy' },
                toast: ['Compaction refused: busy', 'info'],
            },
            {
                status: 409,
                json: { outcome: 'rejected-before-start', reason: '' },
                toast: ['Compaction refused', 'info'],
            },
            {
                status: 503,
                json: { outcome: 'rejected-before-start' },
                toast: ['Compaction unavailable', 'info'],
            },
            {
                status: 502,
                json: { outcome: 'failed', reason: 'cancelled' },
                toast: ['Compaction failed: cancelled', 'error'],
            },
            {
                status: 504,
                json: { outcome: 'unknown', request_id: '3' },
                toast: ['Compaction outcome unknown', 'error'],
            },
            {
                status: 200,
                json: { outcome: 'completed', extra: 'ignored' },
                toast: ['Compaction complete', 'success'],
            },
            {
                status: 200,
                json: { outcome: 'bogus' },
                toast: ['Compaction outcome unknown', 'error'],
            },
            {
                status: 500,
                json: { outcome: 'failed', reason: 'boom' },
                toast: ['Compaction outcome unknown', 'error'],
            },
        ];
        let i = 0;
        for (const { status, json, toast } of replies) {
            document.body.innerHTML = '';
            const fetchMock = mockFetch(() => ({
                ok: status === 200,
                status,
                json,
            }));
            const tm = makeTm();
            const tab = makePiTab(`pi-map-${i++}`);
            tm.tabs.set(tab.paneId, tab);
            tm.activePaneId = tab.paneId;
            baseline(tm, tab);
            expect(tm.sendSlashCommand(tab, '/compact')).toBe(true);
            await vi.waitFor(() =>
                expect(tm.app.showToast).toHaveBeenCalledWith(toast[0], {
                    type: toast[1],
                    title: 'Compact',
                }),
            );
            expect(tab.ws.sendInput).not.toHaveBeenCalled();
            expect(fetchMock).toHaveBeenCalledTimes(1);
            vi.unstubAllGlobals();
        }
    });

    it('drops rogue reason text instead of rendering provider errors', async () => {
        mockFetch(() => ({
            ok: false,
            status: 502,
            json: {
                outcome: 'failed',
                reason: 'provider exploded: <script>alert(1)</script>',
            },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.sendSlashCommand(tab, '/compact');
        await vi.waitFor(() =>
            expect(tm.app.showToast).toHaveBeenCalledWith('Compaction failed', {
                type: 'error',
                title: 'Compact',
            }),
        );
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
    });

    it('reports unknown on network failure without PTY replay', async () => {
        mockFetch(() => {
            throw new Error('socket dead');
        });
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.inputTextArea.value = 'keep me';
        expect(tm.sendSlashCommand(tab, '/compact')).toBe(true);
        await vi.waitFor(() =>
            expect(tm.app.showToast).toHaveBeenCalledWith(
                'Compaction outcome unknown',
                { type: 'error', title: 'Compact' },
            ),
        );
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
        expect(tm.inputTextArea.value).toBe('keep me');
    });

    it('expires the browser wait at 125s and ignores the late reply', async () => {
        vi.useFakeTimers();
        const gate = deferred();
        mockFetch(() => gate.promise);
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.renderPresets('pi');

        expect(tm.sendSlashCommand(tab, '/compact')).toBe(true);
        expect(desktopCompact(tm).disabled).toBe(true);
        await vi.advanceTimersByTimeAsync(124_999);
        expect(tm.app.showToast).not.toHaveBeenCalled();
        expect(desktopCompact(tm).disabled).toBe(true);

        await vi.advanceTimersByTimeAsync(1);
        expect(tm.app.showToast).toHaveBeenCalledWith(
            'Compaction outcome unknown',
            { type: 'error', title: 'Compact' },
        );
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
        expect(desktopCompact(tm).disabled).toBe(false);

        // The late reply cannot resurrect the superseded op.
        gate.resolve({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ outcome: 'completed' }),
            text: async () => '{}',
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(tm.app.showToast).toHaveBeenCalledTimes(1);
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
    });

    it('blocks duplicate desktop/mobile clicks while one request runs', async () => {
        const gate = deferred();
        const fetchMock = mockFetch(() => gate.promise);
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.renderPresets('pi');
        slashDropup();
        tm.renderSlashDropup(PI_PRESETS.filter((p) => p.value.startsWith('/')));

        desktopCompact(tm).click();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // Both surfaces disable synchronously; clicks cannot redispatch.
        expect(desktopCompact(tm).disabled).toBe(true);
        expect(mobileCompact().disabled).toBe(true);
        desktopCompact(tm).click();
        mobileCompact().click();
        expect(tm.sendSlashCommand(tab, '/compact')).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(tab.ws.sendInput).not.toHaveBeenCalled();

        gate.resolve({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ outcome: 'completed' }),
            text: async () => '{}',
        });
        await vi.waitFor(() =>
            expect(tm.app.showToast).toHaveBeenCalledTimes(1),
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('sends neither api nor PTY while busy, queued, active, pending, or unknown', () => {
        const states = [
            [
                { ...READY, compact_idle: false },
                'Compact unavailable: Pi is busy',
            ],
            [
                { ...READY, compact_queued: true },
                'Compact unavailable: messages queued',
            ],
            [
                { ...READY, compact_active: true },
                'Compact unavailable: compaction active',
            ],
            [
                { ...READY, compact_pending: true },
                'Compact unavailable: compaction pending',
            ],
        ];
        let i = 0;
        for (const [readiness, title] of states) {
            document.body.innerHTML = '';
            const fetchMock = mockFetch(() => ({
                ok: true,
                status: 200,
                json: { outcome: 'completed' },
            }));
            const tm = makeTm();
            const tab = makePiTab(`pi-g-${i++}`);
            tm.tabs.set(tab.paneId, tab);
            tm.activePaneId = tab.paneId;
            const view = httpView({ ...readiness });
            const frame = wsFrame(tab, {
                compact_idle: String(readiness.compact_idle),
                compact_queued: String(readiness.compact_queued),
                compact_active: String(readiness.compact_active),
                compact_pending: String(readiness.compact_pending),
            });
            tm._seedHttpPiBridge(tab, view);
            tm._acceptPiBridgeState(tab, frame, tab.ws);
            tm.renderPresets('pi');
            slashDropup();
            tm.renderSlashDropup(
                PI_PRESETS.filter((p) => p.value.startsWith('/')),
            );
            expect(desktopCompact(tm).disabled).toBe(true);
            expect(desktopCompact(tm).title).toBe(title);
            expect(mobileCompact().disabled).toBe(true);
            expect(mobileCompact().title).toBe(title);
            expect(tm.sendSlashCommand(tab, '/compact')).toBe(true);
            expect(fetchMock).not.toHaveBeenCalled();
            expect(tab.ws.sendInput).not.toHaveBeenCalled();
            expect(tm.app.showToast).not.toHaveBeenCalled();
            vi.unstubAllGlobals();
        }
    });

    it('disables controls while readiness is unknown', () => {
        mockFetch(() => ({
            ok: true,
            status: 200,
            json: { outcome: 'completed' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        const view = httpView();
        for (const k of [
            'compact_idle',
            'compact_queued',
            'compact_active',
            'compact_pending',
        ])
            delete view[k];
        tm._seedHttpPiBridge(tab, view);
        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: tab.paneId,
                state: 'managed',
                generation: '2',
                telemetry_revision: '7',
                model: 'prov/model',
                capabilities: 'pi.context.v1,pi.compact.v1',
                connected: 'true',
                context_tokens: '4000',
                context_window: '10000',
                context_percent: '40',
            },
            tab.ws,
        );
        tm.renderPresets('pi');
        expect(desktopCompact(tm).disabled).toBe(true);
        expect(desktopCompact(tm).title).toBe(
            'Compact unavailable: unknown Pi state',
        );
        expect(tm.sendSlashCommand(tab, '/compact')).toBe(true);
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
    });

    it('reports unknown once on disconnect and keeps a later explicit click on legacy PTY', async () => {
        const gate = deferred();
        const fetchMock = mockFetch(() => gate.promise);
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        expect(tm.sendSlashCommand(tab, '/compact')).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(true);

        // The socket drops while the HTTP request is still pending:
        // the waiter is invalidated and unknown is reported exactly
        // once for the still-current tab.
        tm._setCurrentTabSocket(tab, { sendInput: vi.fn(() => true) });
        expect(tm.app.showToast).toHaveBeenCalledWith(
            'Compaction outcome unknown',
            { type: 'error', title: 'Compact' },
        );
        expect(tm.app.showToast).toHaveBeenCalledTimes(1);
        expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(false);
        expect(tm._piBridgeCompactEligible(tab)).toBe(false);
        tm.renderPresets('pi');
        expect(desktopCompact(tm).disabled).toBe(false);

        // Eligibility precedes the native-pending guard: legacy PTY.
        expect(tm.sendSlashCommand(tab, '/compact')).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(tab.ws.sendInput).toHaveBeenCalledWith(
            '\x1b[200~/compact\x1b[201~\r',
        );

        // The late HTTP reply for the invalidated waiter stays silent.
        gate.resolve({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ outcome: 'completed' }),
            text: async () => '{}',
        });
        await new Promise((r) => setTimeout(r, 20));
        expect(tm.app.showToast).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(tab.ws.sendInput).toHaveBeenCalledTimes(1);
    });

    it('leaves custom args, other commands, RPC, and backends on legacy paths', () => {
        mockFetch(() => ({
            ok: true,
            status: 200,
            json: { outcome: 'completed' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        expect(tm.sendSlashCommand(tab, '/compact --force')).toBe(true);
        expect(tm.sendSlashCommand(tab, '/model')).toBe(true);
        expect(tm.sendSlashCommand(tab, '/quit')).toBe(true);
        expect(tab.ws.sendInput.mock.calls).toEqual([
            ['\x1b[200~/compact --force\x1b[201~\r'],
            ['\x1b[200~/model\x1b[201~\r'],
            ['\x1b[200~/quit\x1b[201~\r'],
        ]);

        const rpc = makePiTab('rpc-1', { coder: 'pi-rpc' });
        expect(tm.sendSlashCommand(rpc, '/compact')).toBe(false);

        const codex = makePiTab('codex-1', { coder: 'codex' });
        tm.tabs.set(codex.paneId, codex);
        expect(tm.sendSlashCommand(codex, '/compact')).toBe(true);
        expect(codex.ws.sendInput).toHaveBeenCalledWith(
            '\x1b[200~/compact\x1b[201~\r',
        );
    });

    it('uses legacy paste+Enter exactly when the bridge is absent', () => {
        mockFetch(() => {
            throw new Error('must not be called');
        });
        for (const [name, view] of [
            ['plain', { state: 'plain' }],
            ['unstamped', { state: 'managed' }],
            ['no-cap', httpView({ capabilities: ['pi.lifecycle.v1'] })],
            ['peer-down', httpView({ connected: false })],
        ]) {
            document.body.innerHTML = '';
            const inner = makeTm();
            const tab = makePiTab(`pi-${name}`);
            inner.tabs.set(tab.paneId, tab);
            inner.activePaneId = tab.paneId;
            inner._seedHttpPiBridge(tab, view);
            inner.renderPresets('pi');
            const btn = desktopCompact(inner);
            expect(btn.disabled).toBe(false);
            expect(btn.title).toBe('');
            btn.click();
            expect(tab.ws.sendInput).toHaveBeenCalledWith(
                '\x1b[200~/compact\x1b[201~\r',
            );
            expect(inner.app.showToast).not.toHaveBeenCalledWith(
                expect.stringContaining('Compaction'),
                expect.anything(),
            );
        }
    });
});

describe('stale replies and finalizers', () => {
    it('stays silent for a closed pane and clears only its own op', async () => {
        const gate = deferred();
        mockFetch(() => gate.promise);
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.sendSlashCommand(tab, '/compact');
        expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(true);

        tm.tabs.delete(tab.paneId);
        gate.resolve({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ outcome: 'completed' }),
            text: async () => '{}',
        });
        await vi.waitFor(() =>
            expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(false),
        );
        expect(tm.app.showToast).not.toHaveBeenCalled();
    });

    it('ignores a replaced tab object on the same pane id', async () => {
        const gate = deferred();
        mockFetch(() => gate.promise);
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.sendSlashCommand(tab, '/compact');

        const replacement = makePiTab(tab.paneId);
        tm.tabs.set(tab.paneId, replacement);
        gate.resolve({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ outcome: 'completed' }),
            text: async () => '{}',
        });
        await vi.waitFor(() =>
            expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(false),
        );
        expect(tm.app.showToast).not.toHaveBeenCalled();
        expect(replacement.ws.sendInput).not.toHaveBeenCalled();
    });

    it('never lets a late reply disturb a newer pending op', async () => {
        vi.useFakeTimers();
        const first = deferred();
        const second = deferred();
        let calls = 0;
        mockFetch(() => (++calls === 1 ? first.promise : second.promise));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);

        tm.sendSlashCommand(tab, '/compact');
        await vi.advanceTimersByTimeAsync(125_000);
        expect(tm.app.showToast).toHaveBeenCalledTimes(1);

        tm.sendSlashCommand(tab, '/compact');
        expect(calls).toBe(2);
        first.resolve({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ outcome: 'completed' }),
            text: async () => '{}',
        });
        await vi.advanceTimersByTimeAsync(10);
        // The late first reply changes nothing about the second op.
        expect(tm.app.showToast).toHaveBeenCalledTimes(1);
        expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(true);

        second.resolve({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ outcome: 'completed' }),
            text: async () => '{}',
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(tm.app.showToast).toHaveBeenCalledTimes(2);
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
    });
});

describe('socket close and pane disposal lifecycle', () => {
    beforeEach(() => {
        socketLog.made.length = 0;
    });

    it('reports unknown once when a reconnect socket closes', () => {
        const gate = deferred();
        mockFetch(() => gate.promise);
        const tm = makeTm();
        const tab = makePiTab('pi-1', {
            ws: { sendInput: vi.fn(() => true), close: vi.fn() },
            term: { refresh: vi.fn(), reset: vi.fn(), rows: 24, cols: 80 },
        });
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;

        tm.reconnectTab(tab);
        const ws = socketLog.made[0];
        expect(ws).toBeTruthy();
        ws.onOpen();
        baseline(tm, tab);
        // Dispatch on the reconnect socket, then lose that socket.
        tm.sendSlashCommand(tab, '/compact');
        expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(true);

        ws.onClose();
        expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(false);
        expect(tm.app.showToast).toHaveBeenCalledWith(
            'Compaction outcome unknown',
            { type: 'error', title: 'Compact' },
        );
    });

    it('reports unknown once when a restart socket closes', async () => {
        const gate = deferred();
        mockFetch((url) =>
            String(url).includes('/api/pi-bridge/compact')
                ? gate.promise
                : { json: { pane_id: 'pi-2', session_id: 's2' } },
        );
        const tm = makeTm();
        const tab = makePiTab('pi-1', {
            ws: { sendInput: vi.fn(() => true), close: vi.fn() },
            term: { refresh: vi.fn(), reset: vi.fn(), rows: 24, cols: 80 },
        });
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;

        tm.restartTab(tab);
        await vi.waitFor(() => expect(socketLog.made).toHaveLength(1));
        const ws = socketLog.made[0];
        ws.onOpen();
        baseline(tm, tab);
        tm.sendSlashCommand(tab, '/compact');
        expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(true);

        ws.onClose();
        expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(false);
        expect(tm.app.showToast).toHaveBeenCalledWith(
            'Compaction outcome unknown',
            { type: 'error', title: 'Compact' },
        );
    });

    it('drops the pending op when the pane is disposed', async () => {
        const gate = deferred();
        mockFetch(() => gate.promise);
        const tm = makeTm();
        const tab = makePiTab('pi-1', {
            ws: { sendInput: vi.fn(() => true), close: vi.fn() },
        });
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.sendSlashCommand(tab, '/compact');
        const op = tm._piBridgeCompactPending.get(tab.paneId);
        expect(op).toBeTruthy();

        tm.disposeTabClient(tab.paneId);
        // The waiter is pane-keyed, so disposal must retire it: a later
        // tab on the same pane id may not inherit it.
        expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(false);
        expect(op.controller.signal.aborted).toBe(true);

        const reused = makePiTab('pi-1');
        tm.tabs.set('pi-1', reused);
        tm.activePaneId = 'pi-1';
        gate.resolve({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ outcome: 'completed' }),
            text: async () => '{}',
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(tm.app.showToast).not.toHaveBeenCalled();
        expect(tm._piBridgeCompactPending.has('pi-1')).toBe(false);
    });
});

describe('compact control keyboard semantics', () => {
    it('keeps native button focus for enabled controls and skips disabled ones', () => {
        mockFetch(() => ({
            ok: true,
            status: 200,
            json: { outcome: 'completed' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.renderPresets('pi');

        const btn = desktopCompact(tm);
        expect(btn.tagName).toBe('BUTTON');
        expect(btn.disabled).toBe(false);
        btn.focus();
        expect(document.activeElement).toBe(btn);

        // Busy readiness disables the same native control.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '8',
                compact_idle: 'false',
            }),
            tab.ws,
        );
        const busy = desktopCompact(tm);
        expect(busy.tagName).toBe('BUTTON');
        expect(busy.disabled).toBe(true);
        busy.focus();
        expect(document.activeElement).not.toBe(busy);
    });

    it('keeps preset focus across a context-only telemetry frame', () => {
        mockFetch(() => ({ ok: true, status: 200 }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.renderPresets('pi');

        const btn = desktopCompact(tm);
        btn.focus();
        expect(document.activeElement).toBe(btn);

        // Context occupancy rides the meter alone: the row must not be
        // rebuilt per turn, or the keyboard user loses their place.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '8',
                context_tokens: '9100',
                context_percent: '91',
            }),
            tab.ws,
        );
        expect(desktopCompact(tm)).toBe(btn);
        expect(document.activeElement).toBe(btn);
        expect(meter().text.textContent).toBe('9.1K / 10K');
    });
});

describe('correction cycle 1 regressions', () => {
    it('C1: adopts equal-revision peer-down after a settlement without a new snapshot', () => {
        mockFetch(() => {
            throw new Error('must not dispatch');
        });
        const tm = makeTm();
        tm._ringPiBridgeBell = vi.fn();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        expect(meter().el).not.toBeNull();

        // A run starts on a newer revision, then settles: the browser
        // clears running without any new state snapshot.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '8',
                running: 'true',
                compact_idle: 'false',
            }),
            tab.ws,
        );
        tm._acceptPiBridgeSettled(tab, {
            type: 'pi-bridge-settled',
            pane_id: tab.paneId,
            generation: '2',
            run: '1',
            outcome: 'completed',
        });
        expect(tab.piBridge.running).toBe(false);

        // The peer drops, carrying newer settlement metadata at the
        // same revision. Lifecycle fields must not veto adoption.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, {
                telemetry_revision: '8',
                running: 'true',
                compact_idle: 'false',
                connected: 'false',
                last_run: '1',
                last_outcome: 'completed',
            }),
            tab.ws,
        );
        expect(tab.piBridge.connected).toBe(false);
        expect(meter().el).toBeNull();

        // A later explicit Compact is legacy PTY, not native.
        tm.renderPresets('pi');
        expect(desktopCompact(tm).disabled).toBe(false);
        expect(tm.sendSlashCommand(tab, '/compact')).toBe(true);
        expect(tab.ws.sendInput).toHaveBeenCalledWith(
            '\x1b[200~/compact\x1b[201~\r',
        );
    });

    it('C1: still rejects equal-revision conflicts on publication fields', () => {
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        for (const over of [
            { model: 'other/model' },
            { capabilities: 'pi.context.v1' },
            { generation: '9' },
            { context_tokens: '4100' },
            { compact_queued: 'true' },
        ]) {
            tm._acceptPiBridgeState(tab, wsFrame(tab, over), tab.ws);
        }
        expect(tab.piBridge.model).toBe('prov/model');
        expect(tab.piBridge.capabilities).toEqual([
            'pi.context.v1',
            'pi.compact.v1',
        ]);
        expect(tab.piBridge.generation).toBe('2');
        expect(tab.piBridge.context_tokens).toBe(4000);
        expect(tab.piBridge.compact_queued).toBe(false);
        expect(tab._piBridgeFresh).toBe(tab.ws);
        expect(meter().el).not.toBeNull();
    });

    it('C2: dispatches neither API nor PTY from an obsolete exact-Compact target', () => {
        const fetchMock = mockFetch(() => ({
            ok: true,
            status: 200,
            json: { outcome: 'completed' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        const oldSend = tab.ws.sendInput;

        // The pane is adopted by a replacement tab object.
        tm.tabs.set(tab.paneId, {
            ...tab,
            ws: { sendInput: vi.fn(() => true) },
        });
        expect(tm.sendSlashCommand(tab, '/compact')).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(oldSend).not.toHaveBeenCalled();

        // Other commands on the same stale object keep legacy behavior.
        expect(tm.sendSlashCommand(tab, '/model')).toBe(true);
        expect(oldSend).toHaveBeenCalledWith('\x1b[200~/model\x1b[201~\r');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('C2: finalizer stays silent when the socket was swapped without invalidation', async () => {
        const gate = deferred();
        mockFetch(() => gate.promise);
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.sendSlashCommand(tab, '/compact');
        expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(true);

        // A direct swap bypasses the socket hook: only the finalizer
        // fence can catch the stale waiter.
        tab.ws = { sendInput: vi.fn(() => true) };
        gate.resolve({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ outcome: 'completed' }),
            text: async () => '{}',
        });
        await vi.waitFor(() =>
            expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(false),
        );
        expect(tm.app.showToast).not.toHaveBeenCalled();
    });

    it('C2: drops the waiter silently on an accepted newer generation and re-enables after a ready baseline', async () => {
        const gate = deferred();
        const fetchMock = mockFetch(() => gate.promise);
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.sendSlashCommand(tab, '/compact');
        expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(true);

        // A newer runtime generation baselines as ready: the gen-2
        // waiter is dropped silently and controls re-enable for gen 3.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, { telemetry_revision: '9', generation: '3' }),
            tab.ws,
        );
        expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(false);
        expect(tm.app.showToast).not.toHaveBeenCalled();
        tm.renderPresets('pi');
        expect(desktopCompact(tm).disabled).toBe(false);
        expect(desktopCompact(tm).title).toBe('Compact via bridge');

        // The late gen-2 reply cannot toast into the gen-3 session...
        gate.resolve({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ outcome: 'completed' }),
            text: async () => '{}',
        });
        await new Promise((r) => setTimeout(r, 20));
        expect(tm.app.showToast).not.toHaveBeenCalled();

        // ...but a fresh gen-3 dispatch still works.
        desktopCompact(tm).click();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const body = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(body.generation).toBe('3');
        expect(body.telemetry_revision).toBe('9');
    });

    it('C2: reports unknown once when peer-loss interrupts the current native request', async () => {
        const gate = deferred();
        const fetchMock = mockFetch(() => gate.promise);
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.sendSlashCommand(tab, '/compact');
        expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(true);

        // Same-revision peer-down on the current identity: the waiter
        // is dropped and unknown is reported exactly once.
        const loss = wsFrame(tab, { connected: 'false' });
        tm._acceptPiBridgeState(tab, loss, tab.ws);
        expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(false);
        expect(tm.app.showToast).toHaveBeenCalledWith(
            'Compaction outcome unknown',
            { type: 'error', title: 'Compact' },
        );
        expect(tm.app.showToast).toHaveBeenCalledTimes(1);
        expect(meter().el).toBeNull();

        // A repeated loss frame cannot duplicate the notice.
        tm._acceptPiBridgeState(tab, loss, tab.ws);
        expect(tm.app.showToast).toHaveBeenCalledTimes(1);

        // The late HTTP success for the dropped waiter stays silent:
        // no second toast, no fetch replay, no PTY replay.
        gate.resolve({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ outcome: 'completed' }),
            text: async () => '{}',
        });
        await new Promise((r) => setTimeout(r, 20));
        expect(tm.app.showToast).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
    });

    it('C2: reports unknown once when Compact-capability loss interrupts the current native request', async () => {
        const gate = deferred();
        const fetchMock = mockFetch(() => gate.promise);
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.sendSlashCommand(tab, '/compact');
        expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(true);

        // A newer revision drops the Compact capability on the current
        // socket/runtime: unknown exactly once.
        const loss = wsFrame(tab, {
            telemetry_revision: '8',
            capabilities: 'pi.context.v1',
        });
        tm._acceptPiBridgeState(tab, loss, tab.ws);
        expect(tm._piBridgeCompactPending.has(tab.paneId)).toBe(false);
        expect(tm.app.showToast).toHaveBeenCalledWith(
            'Compaction outcome unknown',
            { type: 'error', title: 'Compact' },
        );
        expect(tm.app.showToast).toHaveBeenCalledTimes(1);
        // The context meter survives: only the Compact cap was lost.
        expect(meter().el).not.toBeNull();

        // A repeated loss frame cannot duplicate the notice.
        tm._acceptPiBridgeState(tab, loss, tab.ws);
        expect(tm.app.showToast).toHaveBeenCalledTimes(1);

        // The late success stays silent; an explicit later click is
        // legacy PTY with no fetch replay.
        gate.resolve({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({ outcome: 'completed' }),
            text: async () => '{}',
        });
        await new Promise((r) => setTimeout(r, 20));
        expect(tm.app.showToast).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        tm.renderPresets('pi');
        expect(desktopCompact(tm).disabled).toBe(false);
        expect(tm.sendSlashCommand(tab, '/compact')).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(tab.ws.sendInput).toHaveBeenCalledWith(
            '\x1b[200~/compact\x1b[201~\r',
        );
    });

    it('C3: blocks logically running native Compact even if sampled idle is true', () => {
        const fetchMock = mockFetch(() => ({
            ok: true,
            status: 200,
            json: { outcome: 'completed' },
        }));
        const tm = makeTm();
        const tab = makePiTab();
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        baseline(tm, tab);
        tm.renderPresets('pi');
        slashDropup();
        tm.renderSlashDropup(PI_PRESETS.filter((p) => p.value.startsWith('/')));
        // Absent running is not a requirement: still enabled.
        expect(desktopCompact(tm).disabled).toBe(false);

        // A running-only update immediately disables both surfaces.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, { telemetry_revision: '8', running: 'true' }),
            tab.ws,
        );
        expect(desktopCompact(tm).disabled).toBe(true);
        expect(desktopCompact(tm).title).toBe(
            'Compact unavailable: Pi is busy',
        );
        expect(mobileCompact().disabled).toBe(true);
        expect(mobileCompact().title).toBe('Compact unavailable: Pi is busy');
        expect(tm.sendSlashCommand(tab, '/compact')).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(tab.ws.sendInput).not.toHaveBeenCalled();

        // A running-clear update re-enables without touching idle.
        tm._acceptPiBridgeState(
            tab,
            wsFrame(tab, { telemetry_revision: '9', running: 'false' }),
            tab.ws,
        );
        expect(desktopCompact(tm).disabled).toBe(false);
        expect(desktopCompact(tm).title).toBe('Compact via bridge');
    });

    it('C4: treats non-200 success statuses as unknown, never completed', async () => {
        for (const status of [201, 202, 204, 206]) {
            document.body.innerHTML = '';
            mockFetch(() => ({
                ok: true,
                status,
                json: { outcome: 'completed', request_id: '1' },
            }));
            const tm = makeTm();
            const tab = makePiTab(`pi-c4-${status}`);
            tm.tabs.set(tab.paneId, tab);
            tm.activePaneId = tab.paneId;
            baseline(tm, tab);
            expect(tm.sendSlashCommand(tab, '/compact')).toBe(true);
            await vi.waitFor(() =>
                expect(tm.app.showToast).toHaveBeenCalledWith(
                    'Compaction outcome unknown',
                    { type: 'error', title: 'Compact' },
                ),
            );
            expect(tab.ws.sendInput).not.toHaveBeenCalled();
            vi.unstubAllGlobals();
        }
    });

    it('C4: renders only the fixed reason vocabulary', async () => {
        const cases = [
            [502, 'failed', 'stale', 'Compaction failed: stale', 'error'],
            [
                502,
                'failed',
                'already-compacted',
                'Compaction failed: already-compacted',
                'error',
            ],
            [
                502,
                'failed',
                'uncertain',
                'Compaction failed: uncertain',
                'error',
            ],
            [
                502,
                'failed',
                'provider-secret-text',
                'Compaction failed',
                'error',
            ],
            [502, 'failed', 'word-shaped-rogue', 'Compaction failed', 'error'],
            [502, 'failed', 'Stale', 'Compaction failed', 'error'],
            [502, 'failed', '', 'Compaction failed', 'error'],
            [
                409,
                'rejected-before-start',
                'duplicate',
                'Compaction refused: duplicate',
                'info',
            ],
            [
                409,
                'rejected-before-start',
                'compaction-active',
                'Compaction refused: compaction-active',
                'info',
            ],
            [
                409,
                'rejected-before-start',
                'not-in-vocabulary',
                'Compaction refused',
                'info',
            ],
        ];
        let i = 0;
        for (const [status, outcome, reason, message, type] of cases) {
            document.body.innerHTML = '';
            mockFetch(() => ({
                ok: status === 200,
                status,
                json: { outcome, reason },
            }));
            const tm = makeTm();
            const tab = makePiTab(`pi-v-${i++}`);
            tm.tabs.set(tab.paneId, tab);
            tm.activePaneId = tab.paneId;
            baseline(tm, tab);
            expect(tm.sendSlashCommand(tab, '/compact')).toBe(true);
            await vi.waitFor(() =>
                expect(tm.app.showToast).toHaveBeenCalledWith(message, {
                    type,
                    title: 'Compact',
                }),
            );
            expect(tab.ws.sendInput).not.toHaveBeenCalled();
            vi.unstubAllGlobals();
        }
    });
});
