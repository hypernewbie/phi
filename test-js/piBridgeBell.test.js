// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabManager } from '../web/terminal.js';

function bridgeManager() {
    const showToast = vi.fn();
    const manager = {
        app: { showToast },
        tabs: new Map(),
        switchTab: vi.fn(),
        updateDocumentTitle: vi.fn(),
        triggerAttentionNotification:
            TabManager.prototype.triggerAttentionNotification,
        _piBridgeRunIsNew: TabManager.prototype._piBridgeRunIsNew,
        _piBridgeHasBaseline: TabManager.prototype._piBridgeHasBaseline,
        _ringPiBridgeBell: TabManager.prototype._ringPiBridgeBell,
        _setTabAttention: TabManager.prototype._setTabAttention,
        _acceptPiBridgeState: TabManager.prototype._acceptPiBridgeState,
        _acceptPiBridgeSettled: TabManager.prototype._acceptPiBridgeSettled,
        _acceptOrderedBridgeView: TabManager.prototype._acceptOrderedBridgeView,
        _normalizePiBridgeView: TabManager.prototype._normalizePiBridgeView,
        _piBridgeRevValue: TabManager.prototype._piBridgeRevValue,
        _piBridgeCapabilityEligible:
            TabManager.prototype._piBridgeCapabilityEligible,
        _piBridgeModelsEligible: TabManager.prototype._piBridgeModelsEligible,
        _refreshPiBridgeModels: TabManager.prototype._refreshPiBridgeModels,
        getActiveTab: () => null,
        renderPresets: vi.fn(),
    };
    return { manager, showToast };
}

function settle(manager, tab, control) {
    manager.tabs.set(tab.paneId, tab);
    return manager._acceptPiBridgeSettled(tab, control);
}

function piTab(over = {}) {
    return {
        paneId: 'pane-1',
        title: 'pi',
        coder: 'pi',
        ws: { name: 'pane-1-ws' },
        isAttention: false,
        userTaskActive: true,
        busyStartTime: Date.now(),
        tabEl: document.createElement('div'),
        ...over,
    };
}

function acceptState(manager, tab, revision, over = {}) {
    manager.tabs.set(tab.paneId, tab);
    return manager._acceptPiBridgeState(
        tab,
        {
            type: 'pi-bridge-state',
            pane_id: tab.paneId,
            state: 'managed',
            telemetry_revision: String(revision),
            generation: '1',
            model: 'provider/model',
            capabilities: 'pi.lifecycle.v1',
            connected: true,
            ...over,
        },
        tab.ws,
    );
}

beforeEach(() => {
    vi.stubGlobal(
        'Audio',
        class {
            play() {
                return Promise.resolve();
            }
        },
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('pi-bridge settled bell', () => {
    it('rings once per run and ignores duplicates', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab();

        settle(manager, tab, {
            type: 'pi-bridge-settled',
            pane_id: 'pane-1',
            run: '7',
            outcome: 'completed',
        });
        expect(tab.isAttention).toBe(true);
        expect(tab.userTaskActive).toBe(false);
        expect(showToast).toHaveBeenCalledTimes(1);

        settle(manager, tab, {
            type: 'pi-bridge-settled',
            pane_id: 'pane-1',
            run: '7',
            outcome: 'completed',
        });
        expect(showToast).toHaveBeenCalledTimes(1);
    });

    it('rings with the ready-at-prompt message, never a success claim', () => {
        const { manager } = bridgeManager();
        manager.triggerAttentionNotification = vi.fn();
        const tab = piTab();
        settle(manager, tab, {
            type: 'pi-bridge-settled',
            pane_id: 'pane-1',
            run: '7',
            outcome: 'completed',
        });
        expect(manager.triggerAttentionNotification).toHaveBeenCalledWith(
            tab,
            true,
        );
    });

    it('rings for error and unknown outcomes without claiming success', () => {
        const { manager } = bridgeManager();
        manager.triggerAttentionNotification = vi.fn();
        for (const outcome of ['error', 'unknown']) {
            const tab = piTab();
            settle(manager, tab, {
                type: 'pi-bridge-settled',
                pane_id: 'pane-1',
                run: '7',
                outcome,
            });
            expect(manager.triggerAttentionNotification).toHaveBeenCalledWith(
                tab,
                true,
            );
        }
    });

    it('clears fallback task state for a new aborted run without ringing', () => {
        const { manager, showToast } = bridgeManager();
        const pending = { isLongTask: true };
        const tab = piTab({
            _piBridgeLastRun: '2',
            _piBridgeGeneration: '1',
            _piBridgeHeuristicPending: pending,
            piBridge: { running: true },
        });

        settle(manager, tab, {
            type: 'pi-bridge-settled',
            pane_id: 'pane-1',
            generation: '1',
            run: '3',
            outcome: 'aborted',
        });
        expect(tab.isAttention).toBe(false);
        expect(showToast).not.toHaveBeenCalled();
        expect(tab._piBridgeLastRun).toBe('3');
        expect(tab.piBridge.running).toBe(false);
        expect(tab.userTaskActive).toBe(false);
        expect(tab.busyStartTime).toBeNull();
        expect(tab._piBridgeHeuristicPending).toBeNull();
    });

    it('does not let stale or duplicate aborts cancel a newer task', () => {
        const { manager, showToast } = bridgeManager();
        const pending = { isLongTask: true };
        const tab = piTab({
            _piBridgeLastRun: '5',
            _piBridgeGeneration: '2',
            _piBridgeHeuristicPending: pending,
        });
        const busyStartTime = tab.busyStartTime;

        for (const run of ['4', '5']) {
            settle(manager, tab, {
                type: 'pi-bridge-settled',
                pane_id: 'pane-1',
                generation: '2',
                run,
                outcome: 'aborted',
            });
        }

        expect(tab._piBridgeLastRun).toBe('5');
        expect(tab.userTaskActive).toBe(true);
        expect(tab.busyStartTime).toBe(busyStartTime);
        expect(tab._piBridgeHeuristicPending).toBe(pending);
        expect(showToast).not.toHaveBeenCalled();
    });

    it('rings for completed runs beyond the safe-number range', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab({ _piBridgeLastRun: '9007199254740993' });

        settle(manager, tab, {
            type: 'pi-bridge-settled',
            pane_id: 'pane-1',
            run: '9007199254740994',
            outcome: 'completed',
        });
        expect(showToast).toHaveBeenCalledTimes(1);
    });

    it('ignores non-pi tabs and malformed runs', () => {
        const { manager, showToast } = bridgeManager();
        const shell = piTab({ coder: 'bash' });
        settle(manager, shell, {
            type: 'pi-bridge-settled',
            pane_id: 'pane-1',
            run: '1',
            outcome: 'completed',
        });
        const tab = piTab();
        settle(manager, tab, {
            type: 'pi-bridge-settled',
            pane_id: 'pane-1',
            outcome: 'completed',
        });
        expect(showToast).not.toHaveBeenCalled();
        expect(shell.isAttention).toBe(false);
        expect(tab.isAttention).toBe(false);
    });

    it('scopes the high-water mark to the runtime generation', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab();
        const settled = (generation, run) =>
            settle(manager, tab, {
                type: 'pi-bridge-settled',
                pane_id: 'pane-1',
                generation,
                run,
                outcome: 'completed',
            });
        settled('1', '1');
        expect(showToast).toHaveBeenCalledTimes(1);
        settled('1', '1');
        expect(showToast).toHaveBeenCalledTimes(1);
        settled('1', '2');
        expect(showToast).toHaveBeenCalledTimes(2);
        // A new runtime restarts numbering: run 1 in generation 2 is
        // new even though it is numerically below the old water mark.
        settled('2', '1');
        expect(showToast).toHaveBeenCalledTimes(3);
        settled('2', '1');
        expect(showToast).toHaveBeenCalledTimes(3);
        // A delayed old-generation edge is stale, never a bell.
        settled('1', '3');
        expect(showToast).toHaveBeenCalledTimes(3);
        expect(tab._piBridgeGeneration).toBe('2');
        expect(tab._piBridgeLastRun).toBe('1');
    });
});

describe('pi-bridge attach state', () => {
    it('records state and establishes a silent baseline on first sight', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab();
        manager.tabs.set(tab.paneId, tab);

        acceptState(manager, tab, 1, {
            last_run: '5',
            last_outcome: 'completed',
        });
        expect(tab.piBridge.state).toBe('managed');
        // A new browser never bells for retained history.
        expect(showToast).not.toHaveBeenCalled();
        expect(tab._piBridgeLastRun).toBe('5');
    });

    it('rings catch-up once for a newer retained run after a baseline', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab();

        const attach = (revision, run, outcome) =>
            acceptState(manager, tab, revision, {
                last_run: run,
                last_outcome: outcome,
            });
        attach(1, '5', 'completed');
        expect(showToast).not.toHaveBeenCalled();

        attach(2, '6', 'completed');
        expect(tab.isAttention).toBe(true);
        expect(showToast).toHaveBeenCalledTimes(1);

        // Re-attach replays the same run without a second bell.
        tab.isAttention = false;
        attach(2, '6', 'completed');
        expect(showToast).toHaveBeenCalledTimes(1);
    });

    it('clears fallback task state for a new retained abort known to be idle', () => {
        const { manager, showToast } = bridgeManager();
        const pending = { isLongTask: true };
        const tab = piTab({ _piBridgeHeuristicPending: pending });
        acceptState(manager, tab, 1, {
            running: 'false',
            last_run: '5',
            last_outcome: 'completed',
        });
        tab.userTaskActive = true;
        tab.busyStartTime = 123;
        tab._piBridgeHeuristicPending = pending;

        acceptState(manager, tab, 2, {
            running: 'false',
            last_run: '6',
            last_outcome: 'aborted',
        });

        expect(showToast).not.toHaveBeenCalled();
        expect(tab._piBridgeLastRun).toBe('6');
        expect(tab.userTaskActive).toBe(false);
        expect(tab.busyStartTime).toBeNull();
        expect(tab._piBridgeHeuristicPending).toBeNull();
    });

    it('keeps a silent initial abort baseline from ending local task state', () => {
        const { manager, showToast } = bridgeManager();
        const pending = { isLongTask: true };
        const tab = piTab({ _piBridgeHeuristicPending: pending });

        acceptState(manager, tab, 1, {
            running: 'false',
            last_run: '5',
            last_outcome: 'aborted',
        });

        expect(showToast).not.toHaveBeenCalled();
        expect(tab._piBridgeLastRun).toBe('5');
        expect(tab.userTaskActive).toBe(true);
        expect(tab._piBridgeHeuristicPending).toBe(pending);
    });

    it('does not cancel current work for a retained previous abort while running', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab();
        acceptState(manager, tab, 1, {
            running: 'false',
            last_run: '5',
            last_outcome: 'aborted',
        });
        const pending = { isLongTask: true };
        tab.userTaskActive = true;
        tab.busyStartTime = 123;
        tab._piBridgeHeuristicPending = pending;

        acceptState(manager, tab, 2, {
            running: 'true',
            last_run: '5',
            last_outcome: 'aborted',
        });

        expect(showToast).not.toHaveBeenCalled();
        expect(tab.userTaskActive).toBe(true);
        expect(tab.busyStartTime).toBe(123);
        expect(tab._piBridgeHeuristicPending).toBe(pending);
    });

    it('does not treat unknown retained running state as an aborted completion', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab();
        acceptState(manager, tab, 1, {
            running: 'false',
            last_run: '5',
            last_outcome: 'completed',
        });
        const pending = { isLongTask: true };
        tab.userTaskActive = true;
        tab.busyStartTime = 123;
        tab._piBridgeHeuristicPending = pending;

        acceptState(manager, tab, 2, {
            last_run: '6',
            last_outcome: 'aborted',
        });

        expect(showToast).not.toHaveBeenCalled();
        expect(tab._piBridgeLastRun).toBe('6');
        expect(tab.userTaskActive).toBe(true);
        expect(tab.busyStartTime).toBe(123);
        expect(tab._piBridgeHeuristicPending).toBe(pending);
    });

    it('ignores settled frames from another pane or a stale socket', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab();
        manager.tabs.set(tab.paneId, tab);
        manager._acceptPiBridgeSettled(
            tab,
            { type: 'pi-bridge-settled', pane_id: 'other-pane', run: '1' },
            tab.ws,
        );
        manager._acceptPiBridgeSettled(
            tab,
            { type: 'pi-bridge-settled', pane_id: tab.paneId, run: '1' },
            { name: 'replaced-ws' },
        );
        // Removed from the tab map: the pane is gone, so nothing rings.
        manager.tabs.delete(tab.paneId);
        manager._acceptPiBridgeSettled(
            tab,
            { type: 'pi-bridge-settled', pane_id: tab.paneId, run: '1' },
            tab.ws,
        );
        expect(showToast).not.toHaveBeenCalled();
        expect(tab._piBridgeLastRun).toBeUndefined();
    });

    it('rings reconnect catch-up after a live idle baseline', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab();
        // Attached before any run: live idle establishes a zero baseline.
        acceptState(manager, tab, 1, { running: 'false' });
        expect(showToast).not.toHaveBeenCalled();
        expect(tab._piBridgeLastRun).toBe('0');
        // Missed the settlement; the reconnect snapshot must ring once.
        acceptState(manager, tab, 2, {
            running: 'false',
            last_run: '1',
            last_outcome: 'completed',
        });
        expect(showToast).toHaveBeenCalledTimes(1);
        // Re-attach replays without a second bell.
        acceptState(manager, tab, 2, {
            running: 'false',
            last_run: '1',
            last_outcome: 'completed',
        });
        expect(showToast).toHaveBeenCalledTimes(1);
    });

    it('leaves pre-hello state without a baseline', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab();
        acceptState(manager, tab, 1);
        expect(tab._piBridgeLastRun).toBeUndefined();
        // First sight of retained history stays silent.
        acceptState(manager, tab, 2, {
            running: 'false',
            last_run: '5',
            last_outcome: 'completed',
        });
        expect(showToast).not.toHaveBeenCalled();
        expect(tab._piBridgeLastRun).toBe('5');
    });
});

describe('pi-bridge always-ring policy', () => {
    it('rings for the active visible tab', () => {
        const { manager, showToast } = bridgeManager();
        manager.activePaneId = 'pane-1';
        const tab = piTab();

        settle(manager, tab, {
            type: 'pi-bridge-settled',
            pane_id: 'pane-1',
            run: '7',
            outcome: 'completed',
        });
        expect(tab.userTaskActive).toBe(false);
        expect(tab.isAttention).toBe(true);
        expect(showToast).toHaveBeenCalledTimes(1);
        expect(tab._piBridgeLastRun).toBe('7');
    });

    it('rings for the active tab while the document is hidden', () => {
        const { manager, showToast } = bridgeManager();
        manager.activePaneId = 'pane-1';
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        try {
            const tab = piTab();
            settle(manager, tab, {
                type: 'pi-bridge-settled',
                pane_id: 'pane-1',
                run: '7',
                outcome: 'completed',
            });
            expect(tab.isAttention).toBe(true);
            expect(showToast).toHaveBeenCalledTimes(1);
        } finally {
            vi.restoreAllMocks();
        }
    });
});

describe('heuristic suppression for managed panes', () => {
    function idleManager(tab) {
        const manager = Object.create(TabManager.prototype);
        Object.assign(manager, {
            tabs: new Map([[tab.paneId, tab]]),
            activePaneId: 'other-pane',
            syncBackendPin: vi.fn(),
            updateDocumentTitle: vi.fn(),
            triggerAttentionNotification: vi.fn(),
            renderPresets: vi.fn(),
        });
        return manager;
    }

    function quietPiTab(over = {}) {
        return {
            paneId: 'pane-1',
            title: 'pi',
            coder: 'pi',
            isDead: false,
            isBusy: true,
            lastOutputAt: Date.now() - 10_000,
            userTaskActive: true,
            pinned: true,
            tabEl: document.createElement('div'),
            term: {
                buffer: {
                    active: {
                        length: 2,
                        baseY: 0,
                        cursorY: 1,
                        cursorX: 2,
                        getLine: (idx) => ({
                            translateToString: () =>
                                idx === 1 ? '❯ ' : 'done',
                        }),
                    },
                },
            },
            ...over,
        };
    }

    function livePiTab(over = {}) {
        const ws = { sendInput: vi.fn(() => true) };
        const { bridge = {}, ...tabOverrides } = over;
        return quietPiTab({
            ws,
            _piBridgeFresh: ws,
            _piBridgeRev: 1n,
            piBridge: {
                state: 'managed',
                generation: '1',
                telemetry_revision: '1',
                model: 'provider/model',
                connected: true,
                capabilities: ['pi.lifecycle.v1'],
                ...bridge,
            },
            ...tabOverrides,
        });
    }

    it('rings heuristically for plain pi tabs', () => {
        const tab = quietPiTab();
        const manager = idleManager(tab);
        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);
        expect(manager.triggerAttentionNotification).toHaveBeenCalledTimes(1);
    });

    it('suppresses heuristics only for a fresh lifecycle-capable pane', () => {
        const tab = livePiTab();
        const manager = idleManager(tab);
        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);
        expect(manager.triggerAttentionNotification).not.toHaveBeenCalled();
    });

    it.each([
        ['peer-down', { bridge: { connected: false } }],
        ['missing lifecycle capability', { bridge: { capabilities: [] } }],
        ['stale socket', { _piBridgeFresh: {} }],
    ])('restores heuristics for a historically live %s pane', (_name, over) => {
        const tab = livePiTab(over);
        const manager = idleManager(tab);
        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);
        expect(manager.triggerAttentionNotification).toHaveBeenCalledTimes(1);
    });

    it('reconsiders an outstanding task after peer-down follows the idle poll', () => {
        const tab = livePiTab();
        const manager = idleManager(tab);
        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);
        expect(tab.isBusy).toBe(false);
        expect(tab.userTaskActive).toBe(true);
        expect(manager.triggerAttentionNotification).not.toHaveBeenCalled();

        manager._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: tab.paneId,
                state: 'managed',
                telemetry_revision: '1',
                generation: '1',
                model: 'provider/model',
                capabilities: 'pi.lifecycle.v1',
                connected: false,
            },
            tab.ws,
        );
        expect(manager.triggerAttentionNotification).not.toHaveBeenCalled();
        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);

        expect(manager.triggerAttentionNotification).toHaveBeenCalledTimes(1);
        expect(tab.userTaskActive).toBe(false);
    });

    it('does not fabricate native Pi completion without a recognized prompt', () => {
        const lines = ['╭──────────────╮', '', '╰──────────────╯'];
        const tab = quietPiTab({
            term: {
                buffer: {
                    active: {
                        length: lines.length,
                        baseY: 0,
                        cursorY: 1,
                        getLine: (index) => ({
                            translateToString: () => lines[index],
                        }),
                    },
                },
            },
        });
        const manager = idleManager(tab);

        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);

        expect(manager.triggerAttentionNotification).not.toHaveBeenCalled();
        expect(tab.userTaskActive).toBe(true);
    });

    it('does not reconsider a direct aborted task after bridge loss', () => {
        const tab = livePiTab();
        const manager = idleManager(tab);
        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);
        expect(tab._piBridgeHeuristicPending).not.toBeNull();

        settle(manager, tab, {
            type: 'pi-bridge-settled',
            pane_id: tab.paneId,
            generation: '1',
            run: '1',
            outcome: 'aborted',
        });
        manager._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: tab.paneId,
                state: 'managed',
                telemetry_revision: '1',
                generation: '1',
                model: 'provider/model',
                capabilities: 'pi.lifecycle.v1',
                connected: false,
            },
            tab.ws,
        );
        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);

        expect(tab.userTaskActive).toBe(false);
        expect(tab._piBridgeHeuristicPending).toBeNull();
        expect(manager.triggerAttentionNotification).not.toHaveBeenCalled();
    });

    it('does not reconsider a retained aborted task after bridge loss', () => {
        const tab = livePiTab();
        const manager = idleManager(tab);
        tab._piBridgeLastRun = '0';
        tab._piBridgeGeneration = '1';
        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);
        expect(tab._piBridgeHeuristicPending).not.toBeNull();

        manager._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: tab.paneId,
                state: 'managed',
                telemetry_revision: '2',
                generation: '1',
                model: 'provider/model',
                capabilities: 'pi.lifecycle.v1',
                connected: true,
                running: false,
                last_run: '1',
                last_outcome: 'aborted',
            },
            tab.ws,
        );
        expect(tab.userTaskActive).toBe(false);
        expect(tab._piBridgeHeuristicPending).toBeNull();

        manager._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: tab.paneId,
                state: 'managed',
                telemetry_revision: '2',
                generation: '1',
                model: 'provider/model',
                capabilities: 'pi.lifecycle.v1',
                connected: false,
                running: false,
                last_run: '1',
                last_outcome: 'aborted',
            },
            tab.ws,
        );
        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);

        expect(tab.userTaskActive).toBe(false);
        expect(tab._piBridgeHeuristicPending).toBeNull();
        expect(manager.triggerAttentionNotification).not.toHaveBeenCalled();
    });

    it('does not create attention for bridge loss without an outstanding task', () => {
        const tab = livePiTab({ isBusy: false, userTaskActive: false });
        const manager = idleManager(tab);
        manager._acceptPiBridgeState(
            tab,
            {
                type: 'pi-bridge-state',
                pane_id: tab.paneId,
                state: 'managed',
                telemetry_revision: '1',
                generation: '1',
                model: 'provider/model',
                capabilities: 'pi.lifecycle.v1',
                connected: false,
            },
            tab.ws,
        );
        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);
        expect(manager.triggerAttentionNotification).not.toHaveBeenCalled();
    });

    it('falls back to heuristics for managed-but-never-connected panes', () => {
        const tab = quietPiTab({ piBridge: { state: 'managed' } });
        const manager = idleManager(tab);
        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);
        expect(manager.triggerAttentionNotification).toHaveBeenCalledTimes(1);
    });

    it('falls back to heuristics for unavailable panes', () => {
        const tab = quietPiTab({ piBridge: { state: 'unavailable' } });
        const manager = idleManager(tab);
        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);
        expect(manager.triggerAttentionNotification).toHaveBeenCalledTimes(1);
    });
});
