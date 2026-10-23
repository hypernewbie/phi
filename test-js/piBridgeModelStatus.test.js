// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabManager } from '../web/terminal.js';

function testManager() {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;
    tm.piRpcStatusBar = document.createElement('div');
    tm.piRpcStatusBar.id = 'pi-rpc-status-bar';
    tm.piRpcStatusBar.className = 'pi-rpc-status-bar hidden';
    document.body.appendChild(tm.piRpcStatusBar);
    return tm;
}

function addPiTab(tm, paneId = 'pane-1', over = {}) {
    const ws = { name: `${paneId}-ws` };
    const tab = {
        paneId,
        sessionId: 'sess-1',
        title: 'pi',
        coder: 'pi',
        cwd: '/home/u/work',
        ws,
        isDead: false,
        tabEl: document.createElement('div'),
        ...over,
    };
    tm.tabs.set(paneId, tab);
    return tab;
}

function barText(tm) {
    return tm.piRpcStatusBar.textContent;
}

function isBarHidden(tm) {
    return tm.piRpcStatusBar.classList.contains('hidden');
}

const RealWebSocket = globalThis.WebSocket;

// MockWS records instances and never fires on its own: each test
// drives the real PTYWebSocket callbacks explicitly.
class MockWS {
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.onopen = null;
        this.onclose = null;
    }
    close() {
        this.readyState = 3;
    }
}

afterEach(() => {
    document.body.innerHTML = '';
    globalThis.WebSocket = RealWebSocket;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('pi bridge ordered model display', () => {
    it('shows nothing until an equal attach confirms the HTTP baseline', () => {
        const tm = testManager();
        const tab = addPiTab(tm);
        tm.activePaneId = tab.paneId;

        expect(
            tm._seedHttpPiBridge(tab, {
                state: 'managed',
                telemetry_revision: '5',
                model: 'provA/modelA',
                capabilities: ['pi.lifecycle.v1'],
            }),
        ).toBe(true);
        expect(tab._piBridgeRev).toBe(5n);
        expect(tab.piBridge.model).toBe('provA/modelA');
        expect(tab.piBridge.capabilities).toEqual(['pi.lifecycle.v1']);
        expect(isBarHidden(tm)).toBe(true);

        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '5',
                model: 'provA/modelA',
                capabilities: 'pi.lifecycle.v1',
            },
            tab.ws,
        );
        expect(isBarHidden(tm)).toBe(false);
        expect(barText(tm)).toContain('provA/modelA');
        expect(barText(tm)).toContain('~/work');
    });

    it('holds the empty new-lease floor against older frames', () => {
        const tm = testManager();
        const tab = addPiTab(tm);
        tm.activePaneId = tab.paneId;

        expect(
            tm._seedHttpPiBridge(tab, {
                state: 'managed',
                telemetry_revision: '9',
            }),
        ).toBe(true);
        expect(isBarHidden(tm)).toBe(true);

        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '3',
                model: 'provOld/modelOld',
            },
            tab.ws,
        );
        expect(tab._piBridgeRev).toBe(9n);
        expect(tab.piBridge.model).toBeUndefined();
        expect(isBarHidden(tm)).toBe(true);

        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '10',
                model: 'provB/modelB',
            },
            tab.ws,
        );
        expect(isBarHidden(tm)).toBe(false);
        expect(barText(tm)).toContain('provB/modelB');
    });

    it('rejects delayed HTTP older than live WS state', () => {
        const tm = testManager();
        const tab = addPiTab(tm);
        tm.activePaneId = tab.paneId;

        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '8',
                model: 'provB/modelB',
            },
            tab.ws,
        );
        expect(barText(tm)).toContain('provB/modelB');
        expect(tm._seedHttpPiBridge(tab, {
            state: 'managed',
            telemetry_revision: '5',
            model: 'provA/modelA',
        })).toBe(false);
        expect(tab.piBridge.model).toBe('provB/modelB');
        expect(barText(tm)).toContain('provB/modelB');
    });

    it('moves idle A to B on a newer revision', () => {
        const tm = testManager();
        const tab = addPiTab(tm);
        tm.activePaneId = tab.paneId;

        for (const [rev, model] of [
            ['5', 'provA/modelA'],
            ['6', 'provB/modelB'],
        ]) {
            tm._acceptPiBridgeState(
                tab,
                {
                    type: 'pi-bridge-state',
                    pane_id: 'pane-1',
                    state: 'managed',
                    telemetry_revision: rev,
                    model,
                },
                tab.ws,
            );
        }
        expect(tab._piBridgeRev).toBe(6n);
        expect(barText(tm)).toContain('provB/modelB');
        expect(barText(tm)).not.toContain('provA/modelA');
    });

    it('rejects conflicting-equal and older revisions', () => {
        const tm = testManager();
        const tab = addPiTab(tm);
        tm.activePaneId = tab.paneId;

        const frame = (rev, model) => ({
            type: 'pi-bridge-state',
            pane_id: 'pane-1',
            state: 'managed',
            telemetry_revision: rev,
            model,
            capabilities: 'pi.lifecycle.v1',
        });
        tm._acceptPiBridgeState(tab, frame('6', 'provB/modelB'), tab.ws);
        tm._acceptPiBridgeState(tab, frame('6', 'provC/modelC'), tab.ws);
        expect(tab.piBridge.model).toBe('provB/modelB');
        tm._acceptPiBridgeState(tab, frame('5', 'provA/modelA'), tab.ws);
        expect(tab.piBridge.model).toBe('provB/modelB');
        expect(barText(tm)).toContain('provB/modelB');
    });

    it('orders u64 revisions beyond float precision', () => {
        const tm = testManager();
        const tab = addPiTab(tm);
        tm.activePaneId = tab.paneId;

        expect(
            tm._seedHttpPiBridge(tab, {
                state: 'managed',
                telemetry_revision: '9007199254740992',
                model: 'provA/modelA',
            }),
        ).toBe(true);
        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '9007199254740992',
                model: 'provA/modelA',
            },
            tab.ws,
        );
        expect(barText(tm)).toContain('provA/modelA');
        // 2^53+1 differs from 2^53 only past float precision.
        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '9007199254740993',
                model: 'provB/modelB',
            },
            tab.ws,
        );
        expect(tab._piBridgeRev).toBe(9007199254740993n);
        expect(barText(tm)).toContain('provB/modelB');
        // Max u64 is a valid baseline on a fresh tab.
        const tab2 = addPiTab(tm, 'pane-2');
        expect(
            tm._seedHttpPiBridge(tab2, {
                state: 'managed',
                telemetry_revision: '18446744073709551615',
                model: 'provM/modelM',
            }),
        ).toBe(true);
        expect(tab2._piBridgeRev).toBe(18446744073709551615n);
    });

    it('rejects unstamped and malformed managed views', () => {
        const tm = testManager();
        const tab = addPiTab(tm);
        tm.activePaneId = tab.paneId;

        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '5',
                model: 'provA/modelA',
            },
            tab.ws,
        );
        for (const bad of [
            { state: 'managed', model: 'provX/modelX' },
            { state: 'managed', telemetry_revision: '', model: 'provX/modelX' },
            { state: 'managed', telemetry_revision: 'abc', model: 'provX/modelX' },
            { state: 'managed', telemetry_revision: '0', model: 'provX/modelX' },
            { state: 'managed', telemetry_revision: '-1', model: 'provX/modelX' },
            { state: 'managed', telemetry_revision: '1.5', model: 'provX/modelX' },
            { state: 'managed', telemetry_revision: 7, model: 'provX/modelX' },
            {
                state: 'managed',
                telemetry_revision: '18446744073709551616',
                model: 'provX/modelX',
            },
            null,
            'managed',
        ]) {
            tm._acceptPiBridgeState(
                tab,
                { type: 'pi-bridge-state', pane_id: 'pane-1', ...bad },
                tab.ws,
            );
            expect(tab.piBridge.model).toBe('provA/modelA');
            expect(tab._piBridgeRev).toBe(5n);
        }
        expect(tm._seedHttpPiBridge(tab, { state: 'managed' })).toBe(false);
        expect(barText(tm)).toContain('provA/modelA');
    });

    it('lets a newer server revision establish a lower runtime generation', () => {
        const tm = testManager();
        const tab = addPiTab(tm);
        tm.activePaneId = tab.paneId;

        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                generation: '2',
                telemetry_revision: '6',
                model: 'provB/modelB',
            },
            tab.ws,
        );
        // Generation fencing stays in Go; the tab follows revisions.
        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                generation: '1',
                telemetry_revision: '7',
                model: 'provC/modelC',
            },
            tab.ws,
        );
        expect(tab.piBridge.model).toBe('provC/modelC');
        expect(barText(tm)).toContain('provC/modelC');
    });

    it('rejects old-socket and wrong-pane frames', () => {
        const tm = testManager();
        const tab = addPiTab(tm);
        tm.activePaneId = tab.paneId;
        const staleWs = { name: 'stale' };

        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '5',
                model: 'provA/modelA',
            },
            staleWs,
        );
        expect(tab.piBridge).toBeUndefined();
        expect(tab._piBridgeRev).toBeUndefined();
        expect(isBarHidden(tm)).toBe(true);

        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'other-pane',
                state: 'managed',
                telemetry_revision: '5',
                model: 'provA/modelA',
            },
            tab.ws,
        );
        expect(tab.piBridge).toBeUndefined();
        expect(isBarHidden(tm)).toBe(true);
    });

    it('rejects frames for removed tabs', () => {
        const tm = testManager();
        const tab = addPiTab(tm);
        tm.activePaneId = tab.paneId;
        tm.tabs.delete(tab.paneId);

        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '5',
                model: 'provA/modelA',
            },
            tab.ws,
        );
        expect(tab.piBridge).toBeUndefined();
        expect(isBarHidden(tm)).toBe(true);
    });

    it('resets ordering on socket replacement and re-baselines small', () => {
        const tm = testManager();
        const tab = addPiTab(tm);
        tm.activePaneId = tab.paneId;

        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '50',
                model: 'provB/modelB',
            },
            tab.ws,
        );
        expect(barText(tm)).toContain('provB/modelB');

        // A new server connection never inherits the old counter.
        tm._setCurrentTabSocket(tab, { name: 'ws2' });
        expect(tab._piBridgeRev).toBeNull();
        expect(tab._piBridgeFresh).toBeNull();
        tm.renderPiRpcStatusBar();
        expect(isBarHidden(tm)).toBe(true);

        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '3',
                model: 'provC/modelC',
            },
            tab.ws,
        );
        expect(tab._piBridgeRev).toBe(3n);
        expect(barText(tm)).toContain('provC/modelC');
    });

    it('stores unavailable/plain only when no floor is known', () => {
        const tm = testManager();
        const tab = addPiTab(tm);
        tm.activePaneId = tab.paneId;

        expect(tm._seedHttpPiBridge(tab, { state: 'unavailable', reason: 'x' })).toBe(
            true,
        );
        expect(tab.piBridge.state).toBe('unavailable');
        expect(tab._piBridgeRev).toBeUndefined();
        expect(isBarHidden(tm)).toBe(true);

        // A managed baseline still applies afterwards.
        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '5',
                model: 'provA/modelA',
            },
            tab.ws,
        );
        expect(barText(tm)).toContain('provA/modelA');

        // A late unavailable never clears the newer managed view.
        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'unavailable',
                reason: 'late',
            },
            tab.ws,
        );
        expect(tab.piBridge.model).toBe('provA/modelA');
        expect(barText(tm)).toContain('provA/modelA');
    });

    it('hides for dead panes and closed sockets', () => {
        const tm = testManager();
        const tab = addPiTab(tm);
        tm.activePaneId = tab.paneId;

        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '5',
                model: 'provA/modelA',
            },
            tab.ws,
        );
        expect(barText(tm)).toContain('provA/modelA');

        tab.isDead = true;
        tm.renderPiRpcStatusBar();
        expect(isBarHidden(tm)).toBe(true);
        tab.isDead = false;

        const liveWs = tab.ws;
        tab.ws = null;
        tm.renderPiRpcStatusBar();
        expect(isBarHidden(tm)).toBe(true);
        tab.ws = liveWs;
        tm.renderPiRpcStatusBar();
        expect(barText(tm)).toContain('provA/modelA');
    });

    it('follows the active tab across switches', () => {
        const tm = testManager();
        const pi = addPiTab(tm, 'pane-1');
        const bash = {
            paneId: 'pane-2',
            sessionId: 's2',
            title: 'bash',
            coder: 'bash',
            cwd: '/home/u/work',
            ws: { name: 'bash-ws' },
            isDead: false,
            tabEl: document.createElement('div'),
        };
        tm.tabs.set('pane-2', bash);
        tm._seedHttpPiBridge(pi, {
            state: 'managed',
            telemetry_revision: '5',
            model: 'provA/modelA',
        });
        tm._acceptPiBridgeState(
            pi,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '5',
                model: 'provA/modelA',
            },
            pi.ws,
        );

        tm.activePaneId = 'pane-2';
        tm.renderPiRpcStatusBar();
        expect(isBarHidden(tm)).toBe(true);

        tm.activePaneId = 'pane-1';
        tm.renderPiRpcStatusBar();
        expect(isBarHidden(tm)).toBe(false);
        expect(barText(tm)).toContain('provA/modelA');
    });

    it('hides the model when the live reconnect socket closes', () => {
        globalThis.WebSocket = MockWS;
        vi.useFakeTimers();
        const tm = testManager();
        tm.app = {};
        tm.updateDocumentTitle = () => {};
        tm._showReconnectOverlay = () => {};
        tm.maybeAutoReconnect = () => {};
        tm.updateDisconnectBanner = () => {};
        tm._hotOptions = () => ({ hot: false });
        tm.activateTabViewport = () => {};
        const tab = addPiTab(tm);
        tab.ws = { close() {} };
        tab.termContainer = { querySelector: () => null };
        tab.term = { refresh() {}, rows: 24 };
        tm.activePaneId = tab.paneId;

        tm.reconnectTab(tab);
        const pty = tab.ws;
        pty.onOpen();
        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '5',
                model: 'provA/modelA',
            },
            tab.ws,
        );
        expect(barText(tm)).toContain('provA/modelA');

        // The real close closure hides the bar itself: no
        // test-side render call between close and assertion.
        pty.onClose();
        expect(tab.isDead).toBe(true);
        expect(isBarHidden(tm)).toBe(true);
    });

    it('hides the model while a reconnect is pending', () => {
        globalThis.WebSocket = MockWS;
        vi.useFakeTimers();
        const tm = testManager();
        tm.app = {};
        tm.updateDocumentTitle = () => {};
        tm._showReconnectOverlay = () => {};
        tm.maybeAutoReconnect = () => {};
        tm.updateDisconnectBanner = () => {};
        tm._hotOptions = () => ({ hot: false });
        tm.activateTabViewport = () => {};
        const tab = addPiTab(tm);
        tab.ws = { close() {} };
        tab.termContainer = { querySelector: () => null };
        tab.term = { refresh() {}, rows: 24 };
        tm.activePaneId = tab.paneId;

        tm.reconnectTab(tab);
        tab.ws.onOpen();
        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '5',
                model: 'provA/modelA',
            },
            tab.ws,
        );
        expect(barText(tm)).toContain('provA/modelA');

        // A manual refresh swaps the socket: the bar hides until
        // fresh state on the new socket confirms the model.
        tm.reconnectTab(tab);
        expect(tab._piBridgeFresh).toBeNull();
        expect(isBarHidden(tm)).toBe(true);

        tab.ws.onOpen();
        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                telemetry_revision: '7',
                model: 'provB/modelB',
            },
            tab.ws,
        );
        expect(barText(tm)).toContain('provB/modelB');
    });

    it('hides the model when the restart socket closes', async () => {
        globalThis.WebSocket = MockWS;
        const realFetch = globalThis.fetch;
        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({ pane_id: 'pane-1b', session_id: 's2' }),
        });
        try {
            const tm = testManager();
            tm.app = {};
            tm.updateDocumentTitle = () => {};
            tm._showReconnectOverlay = () => {};
            tm.maybeAutoReconnect = () => {};
            tm.updateDisconnectBanner = () => {};
            tm._hotOptions = () => ({ hot: false });
            tm.activateTabViewport = () => {};
            const tab = addPiTab(tm);
            tab.ws = { close() {} };
            tab.termContainer = { querySelector: () => null };
            tab.term = { reset() {}, refresh() {}, rows: 24 };
            tm.activePaneId = tab.paneId;

            tm.restartTab(tab);
            await new Promise((r) => setTimeout(r, 0));
            const pty = tab.ws;
            expect(tab.paneId).toBe('pane-1b');
            pty.onOpen();
            tm._acceptPiBridgeState(
                tab,
                {
                    type: 'pi-bridge-state',
                    pane_id: 'pane-1b',
                    state: 'managed',
                    telemetry_revision: '2',
                    model: 'provA/modelA',
                },
                tab.ws,
            );
            expect(barText(tm)).toContain('provA/modelA');

            pty.onClose();
            expect(tab.isDead).toBe(true);
            expect(isBarHidden(tm)).toBe(true);
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    it('ignores bridge seeds for non-pi tabs', () => {
        const tm = testManager();
        const bash = {
            paneId: 'pane-2',
            sessionId: 's2',
            title: 'bash',
            coder: 'bash',
            cwd: '/home/u/work',
            ws: { name: 'bash-ws' },
            isDead: false,
            tabEl: document.createElement('div'),
        };
        tm.tabs.set('pane-2', bash);
        tm.activePaneId = 'pane-2';

        expect(
            tm._seedHttpPiBridge(bash, {
                state: 'managed',
                telemetry_revision: '5',
                model: 'provA/modelA',
            }),
        ).toBe(false);
        expect(bash.piBridge).toBeUndefined();
        tm.renderPiRpcStatusBar();
        expect(isBarHidden(tm)).toBe(true);
    });
});
