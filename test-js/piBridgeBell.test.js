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
        _piBridgeModelsEligible: TabManager.prototype._piBridgeModelsEligible,
        _piBridgeThinkingEligible: () => false,
        _piBridgeKeys: TabManager.prototype._piBridgeKeys,
        _refreshPiBridgeModels: TabManager.prototype._refreshPiBridgeModels,
        _refreshPiBridgeThinking: vi.fn(),
        getActiveTab: () => null,
        renderPresets: vi.fn(),
    };
    return { manager, showToast };
}

function piTab(over = {}) {
    return {
        paneId: 'pane-1',
        title: 'pi',
        coder: 'pi',
        isAttention: false,
        userTaskActive: true,
        busyStartTime: Date.now(),
        tabEl: document.createElement('div'),
        ...over,
    };
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
    it('does not require a bridge capability for ready grouping metadata', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab({
            piBridge: { state: 'managed', capabilities: [] },
            _piBridgeLive: true,
        });
        manager._acceptPiBridgeSettled(tab, {
            type: 'pi-bridge-settled',
            pane_id: 'pane-1',
            run: '1',
            outcome: 'completed',
        });
        expect(showToast.mock.calls[0][1].readyPaneId).toBe(tab.paneId);
    });

    it('rings once per run and ignores duplicates', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab();

        manager._acceptPiBridgeSettled(tab, {
            type: 'pi-bridge-settled',
            pane_id: 'pane-1',
            run: '7',
            outcome: 'completed',
        });
        expect(tab.isAttention).toBe(true);
        expect(tab.userTaskActive).toBe(false);
        expect(showToast).toHaveBeenCalledTimes(1);

        manager._acceptPiBridgeSettled(tab, {
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
        manager._acceptPiBridgeSettled(tab, {
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
            manager._acceptPiBridgeSettled(tab, {
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

    it('never rings for aborted runs', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab();

        manager._acceptPiBridgeSettled(tab, {
            type: 'pi-bridge-settled',
            pane_id: 'pane-1',
            run: '3',
            outcome: 'aborted',
        });
        expect(tab.isAttention).toBe(false);
        expect(showToast).not.toHaveBeenCalled();
        // The aborted run still advances the high-water mark.
        expect(tab._piBridgeLastRun).toBe('3');
    });

    it('rings for completed runs beyond the safe-number range', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab({ _piBridgeLastRun: '9007199254740993' });

        manager._acceptPiBridgeSettled(tab, {
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
        manager._acceptPiBridgeSettled(shell, {
            type: 'pi-bridge-settled',
            pane_id: 'pane-1',
            run: '1',
            outcome: 'completed',
        });
        const tab = piTab();
        manager._acceptPiBridgeSettled(tab, {
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
            manager._acceptPiBridgeSettled(tab, {
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

        manager._acceptPiBridgeState(tab, {
            type: 'pi-bridge-state',
            pane_id: 'pane-1',
            state: 'managed',
            telemetry_revision: '1',
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

        const attach = (run, outcome) =>
            manager._acceptPiBridgeState(tab, {
                type: 'pi-bridge-state',
                pane_id: 'pane-1',
                state: 'managed',
                last_run: run,
                last_outcome: outcome,
            });
        attach('5', 'completed');
        expect(showToast).not.toHaveBeenCalled();

        attach('6', 'completed');
        expect(tab.isAttention).toBe(true);
        expect(showToast).toHaveBeenCalledTimes(1);

        // Re-attach replays the same run without a second bell.
        tab.isAttention = false;
        attach('6', 'completed');
        expect(showToast).toHaveBeenCalledTimes(1);
    });

    it('skips catch-up for aborted retained runs', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab({ _piBridgeLastRun: '5' });
        manager._acceptPiBridgeState(tab, {
            type: 'pi-bridge-state',
            pane_id: 'pane-1',
            state: 'managed',
            last_run: '6',
            last_outcome: 'aborted',
        });
        expect(showToast).not.toHaveBeenCalled();
        expect(tab._piBridgeLastRun).toBe('6');
    });

    it('marks liveness only on post-hello evidence', () => {
        const { manager } = bridgeManager();
        const tab = piTab();
        // Pre-hello state carries no running/last_run: not live.
        manager._acceptPiBridgeState(tab, {
            type: 'pi-bridge-state',
            pane_id: 'pane-1',
            state: 'managed',
        });
        expect(tab._piBridgeLive).toBeUndefined();
        // First running sight proves the hello landed.
        manager._acceptPiBridgeState(tab, {
            type: 'pi-bridge-state',
            pane_id: 'pane-1',
            state: 'managed',
            running: 'false',
        });
        expect(tab._piBridgeLive).toBe(true);
    });

    it('marks liveness on settled frames', () => {
        const { manager } = bridgeManager();
        const tab = piTab();
        manager._acceptPiBridgeSettled(tab, {
            type: 'pi-bridge-settled',
            pane_id: 'pane-1',
            run: '1',
            outcome: 'completed',
        });
        expect(tab._piBridgeLive).toBe(true);
    });

    it('rings reconnect catch-up after a live idle baseline', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab();
        // Attached before any run: live idle establishes a zero baseline.
        manager._acceptPiBridgeState(tab, {
            type: 'pi-bridge-state',
            pane_id: 'pane-1',
            state: 'managed',
            generation: '1',
            running: 'false',
        });
        expect(showToast).not.toHaveBeenCalled();
        expect(tab._piBridgeLastRun).toBe('0');
        // Missed the settlement; the reconnect snapshot must ring once.
        manager._acceptPiBridgeState(tab, {
            type: 'pi-bridge-state',
            pane_id: 'pane-1',
            state: 'managed',
            generation: '1',
            running: 'false',
            last_run: '1',
            last_outcome: 'completed',
        });
        expect(showToast).toHaveBeenCalledTimes(1);
        expect(showToast.mock.calls[0][1].readyPaneId).toBe(tab.paneId);
        // Re-attach replays without a second bell.
        manager._acceptPiBridgeState(tab, {
            type: 'pi-bridge-state',
            pane_id: 'pane-1',
            state: 'managed',
            generation: '1',
            running: 'false',
            last_run: '1',
            last_outcome: 'completed',
        });
        expect(showToast).toHaveBeenCalledTimes(1);
    });

    it('leaves pre-hello state without a baseline', () => {
        const { manager, showToast } = bridgeManager();
        const tab = piTab();
        manager._acceptPiBridgeState(tab, {
            type: 'pi-bridge-state',
            pane_id: 'pane-1',
            state: 'managed',
        });
        expect(tab._piBridgeLastRun).toBeUndefined();
        // First sight of retained history stays silent.
        manager._acceptPiBridgeState(tab, {
            type: 'pi-bridge-state',
            pane_id: 'pane-1',
            state: 'managed',
            generation: '1',
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

        manager._acceptPiBridgeSettled(tab, {
            type: 'pi-bridge-settled',
            pane_id: 'pane-1',
            run: '7',
            outcome: 'completed',
        });
        expect(tab.userTaskActive).toBe(false);
        expect(tab.isAttention).toBe(true);
        expect(showToast).toHaveBeenCalledTimes(1);
        expect(showToast.mock.calls[0][1].readyPaneId).toBe(tab.paneId);
        expect(tab._piBridgeLastRun).toBe('7');
    });

    it('rings for the active tab while the document is hidden', () => {
        const { manager, showToast } = bridgeManager();
        manager.activePaneId = 'pane-1';
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        try {
            const tab = piTab();
            manager._acceptPiBridgeSettled(tab, {
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
        return {
            tabs: new Map([['pane-1', tab]]),
            activePaneId: 'other-pane',
            syncBackendPin: vi.fn(),
            _setTabAttention: TabManager.prototype._setTabAttention,
            updateDocumentTitle: vi.fn(),
            triggerAttentionNotification: vi.fn(),
        };
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

    it('rings heuristically for plain pi tabs', () => {
        const tab = quietPiTab();
        const manager = idleManager(tab);
        TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);
        expect(manager.triggerAttentionNotification).toHaveBeenCalledTimes(1);
    });

    it('suppresses heuristics for live managed panes', () => {
        const tab = quietPiTab({
            piBridge: { state: 'managed' },
            _piBridgeLive: true,
        });
        const manager = idleManager(tab);
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

    it('keeps ready grouping available without a live bridge', () => {
        for (const piBridge of [
            undefined,
            { state: 'unavailable' },
            { state: 'managed' },
        ]) {
            const tab = quietPiTab({ piBridge, _piBridgeLive: false });
            const manager = idleManager(tab);
            const showToast = vi.fn();
            manager.app = { showToast };
            manager.triggerAttentionNotification =
                TabManager.prototype.triggerAttentionNotification;
            manager.switchTab = vi.fn();

            TabManager.prototype.pollTerminalIdleAndNotifications.call(manager);

            expect(showToast).toHaveBeenCalledWith(
                expect.stringContaining('waiting at a prompt'),
                expect.objectContaining({ readyPaneId: tab.paneId }),
            );
        }
    });
});
