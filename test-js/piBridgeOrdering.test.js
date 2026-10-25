// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabManager } from '../web/terminal.js';

// Ordering coverage for the retained per-tab bridge view: HTTP seeds
// set the revision floor, WS frames confirm freshness, and older or
// conflicting frames never overwrite newer state. No status-bar
// display is asserted here; the bar is pi-rpc-only.

function testManager() {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;
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

describe('pi bridge ordered views', () => {
    it('seeds the floor from HTTP and confirms freshness on equal attach', () => {
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
        // An HTTP seed sets the floor but never freshness.
        expect(tab._piBridgeFresh).toBeUndefined();

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
        expect(tab.piBridge.model).toBe('provA/modelA');
        expect(tab._piBridgeFresh).toBe(tab.ws);
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
        expect(tab._piBridgeFresh).toBeUndefined();

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
        expect(tab._piBridgeFresh).toBeUndefined();

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
        expect(tab.piBridge.model).toBe('provB/modelB');
        expect(tab._piBridgeFresh).toBe(tab.ws);
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
        expect(tab.piBridge.model).toBe('provB/modelB');
        expect(
            tm._seedHttpPiBridge(tab, {
                state: 'managed',
                telemetry_revision: '5',
                model: 'provA/modelA',
            }),
        ).toBe(false);
        expect(tab.piBridge.model).toBe('provB/modelB');
        expect(tab._piBridgeFresh).toBe(tab.ws);
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
        expect(tab.piBridge.model).toBe('provB/modelB');
    });

    it('rejects conflicting-equal and older revisions', () => {
        const tm = testManager();
        const tab = addPiTab(tm);
        tm.activePaneId = tab.paneId;

        const frame = (rev, model, thinking_level = '') => ({
            type: 'pi-bridge-state',
            pane_id: 'pane-1',
            state: 'managed',
            telemetry_revision: rev,
            model,
            thinking_level,
            capabilities: 'pi.lifecycle.v1,pi.thinking.v1',
        });
        tm._acceptPiBridgeState(
            tab,
            frame('6', 'provB/modelB', 'high'),
            tab.ws,
        );
        tm._acceptPiBridgeState(
            tab,
            frame('6', 'provC/modelC', 'high'),
            tab.ws,
        );
        expect(tab.piBridge.model).toBe('provB/modelB');
        tm._acceptPiBridgeState(tab, frame('6', 'provB/modelB', 'low'), tab.ws);
        expect(tab.piBridge.thinking_level).toBe('high');
        tm._acceptPiBridgeState(tab, frame('7', 'provB/modelB', 'low'), tab.ws);
        expect(tab.piBridge.thinking_level).toBe('low');
        tm._acceptPiBridgeState(tab, frame('5', 'provA/modelA'), tab.ws);
        expect(tab.piBridge.model).toBe('provB/modelB');
        expect(tab.piBridge.thinking_level).toBe('low');
        expect(tab._piBridgeRev).toBe(7n);
        // An unrecognized level name never becomes confirmed UI state.
        tm._acceptPiBridgeState(
            tab,
            frame('8', 'provB/modelB', 'ultra'),
            tab.ws,
        );
        expect(tab.piBridge.thinking_level).toBe('');
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
        expect(tab.piBridge.model).toBe('provA/modelA');
        expect(tab._piBridgeFresh).toBe(tab.ws);
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
        expect(tab.piBridge.model).toBe('provB/modelB');
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
            {
                state: 'managed',
                telemetry_revision: 'abc',
                model: 'provX/modelX',
            },
            {
                state: 'managed',
                telemetry_revision: '0',
                model: 'provX/modelX',
            },
            {
                state: 'managed',
                telemetry_revision: '-1',
                model: 'provX/modelX',
            },
            {
                state: 'managed',
                telemetry_revision: '1.5',
                model: 'provX/modelX',
            },
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
        expect(tab.piBridge.model).toBe('provA/modelA');
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
        expect(tab._piBridgeFresh).toBeUndefined();

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
        // Wrong-pane frame: pane_id mismatch rejects.
        tm._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: 'other-pane',
                state: 'managed',
                telemetry_revision: '6',
                model: 'provB/modelB',
            },
            tab.ws,
        );
        expect(tab.piBridge.model).toBe('provA/modelA');
        expect(tab._piBridgeRev).toBe(5n);
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
        expect(tab.piBridge.model).toBe('provB/modelB');

        // A new server connection never inherits the old counter; the
        // retained view stays but is no longer fresh.
        tm._setCurrentTabSocket(tab, { name: 'ws2' });
        expect(tab._piBridgeRev).toBeNull();
        expect(tab._piBridgeFresh).toBeNull();

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
        expect(tab.piBridge.model).toBe('provC/modelC');
        expect(tab._piBridgeFresh).toBe(tab.ws);
    });

    it('stores unavailable/plain only when no floor is known', () => {
        const tm = testManager();
        const tab = addPiTab(tm);
        tm.activePaneId = tab.paneId;

        expect(
            tm._seedHttpPiBridge(tab, { state: 'unavailable', reason: 'x' }),
        ).toBe(true);
        expect(tab.piBridge.state).toBe('unavailable');
        expect(tab._piBridgeRev).toBeUndefined();
        expect(tab._piBridgeFresh).toBeUndefined();

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
        expect(tab.piBridge.model).toBe('provA/modelA');

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
    });

    it('drops freshness while a reconnect is pending', () => {
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
        expect(tab.piBridge.model).toBe('provA/modelA');
        expect(tab._piBridgeFresh).toBe(tab.ws);

        // A manual refresh swaps the socket: freshness drops until
        // fresh state on the new socket re-confirms the view.
        tm.reconnectTab(tab);
        expect(tab._piBridgeFresh).toBeNull();

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
        expect(tab.piBridge.model).toBe('provB/modelB');
        expect(tab._piBridgeFresh).toBe(tab.ws);
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
    });
});
