// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

afterEach(() => vi.clearAllMocks());

function bridgeTab(over = {}) {
    const ws = { readyState: 1 };
    return {
        ws,
        _piBridgeFresh: ws,
        paneId: 'pi-pane-1',
        coder: 'pi',
        isDead: false,
        directMode: false,
        piBridge: {
            state: 'managed',
            connected: true,
            generation: '9',
            telemetry_revision: '12',
            model: 'a/x',
            thinking_level: 'high',
            capabilities: ['pi.lifecycle.v1', 'pi.thinking.v1'],
        },
        ...over,
    };
}

function harness(tab) {
    document.body.innerHTML = `
        <div class="terminal-content"></div>
        <div id="model-presets-dropup" class="model-presets-dropup hidden"></div>
        <div id="pi-rpc-model-dropup" class="model-presets-dropup hidden"></div>
        <div id="pi-rpc-thinking-dropup" class="model-presets-dropup hidden"></div>
    `;
    const tm = Object.create(TabManager.prototype);
    tm.presetsContainer = document.createElement('div');
    document.body.appendChild(tm.presetsContainer);
    tm.thinkingPresetStore = {
        start: vi.fn(),
        subscribe: vi.fn(() => () => {}),
        ownerId: 'test-owner',
        getState: () => ({
            confirmed: [],
            desired: [],
            dirty: false,
            saveRequired: false,
            attempt: null,
            writing: false,
            error: '',
            storageWarning: '',
        }),
        setLevels: vi.fn(),
        saveAgain: vi.fn(),
        useServerList: vi.fn(),
        refresh: vi.fn(async () => true),
        ensureLoaded: vi.fn(),
    };
    tm._piRpcMenuRequest = 0;
    tm._piBridgeThinkingMenuRequest = 0;
    tm._piRpcThinkingPending = null;
    tm._piRpcModelPending = null;
    tm.tabs = new Map([[tab.paneId, tab]]);
    tm.activePaneId = tab.paneId;
    tm.getActiveTab = vi.fn(() => tab);
    tm.sendToTab = vi.fn(() => true);
    tm.focusActiveTerminal = vi.fn();
    tm.inputTextArea = document.createElement('textarea');
    tm.inputTextArea.value = 'KEEP THIS PHI DRAFT';
    tm.app = {
        codersPresetRegistry: { pi: { presets: [] } },
        openConfigEditor: vi.fn(),
        showToast: vi.fn(),
    };
    tm.renderModelDropup = vi.fn();
    return { tm, tab };
}

function thinkingTrigger(tm) {
    return tm.presetsContainer.querySelector('.pi-rpc-thinking-trigger');
}

// Real switchTab navigation with the viewport/session glue stubbed out.
function navHarness(first, second) {
    const { tm, tab } = harness(first);
    const all = second ? [first, second] : [first];
    if (second) tm.tabs.set(second.paneId, second);
    for (const each of all) {
        each.tabEl = document.createElement('div');
        each.tabEl.scrollIntoView = vi.fn();
        each.termContainer = document.createElement('div');
    }
    tm.getActiveTab = vi.fn(() => tm.tabs.get(tm.activePaneId));
    tm._closePiRpcDropups = vi.fn();
    tm._resetPiRecall = vi.fn();
    tm.saveTabDraft = vi.fn();
    tm._setPiRpcActionVisibility = vi.fn();
    tm.renderPiRpcStatusBar = vi.fn();
    tm.updateDirectModeUI = vi.fn();
    tm._renderAttachmentStrip = vi.fn();
    tm.adjustInputHeight = vi.fn();
    tm.updateDocumentTitle = vi.fn();
    tm.saveTabsState = vi.fn();
    tm.activateTabViewport = vi.fn();
    tm._syncProjectForTab = vi.fn(() => true);
    tm.inputBarContainer = document.createElement('div');
    tm.stagedAttachments = [];
    tm.lastInputValue = '';
    return { tm, tab };
}

const otherTab = () => bridgeTab({ paneId: 'pi-pane-2' });

const abortError = () =>
    Object.assign(new Error('aborted'), { name: 'AbortError' });

// mockFetch ignores options.signal, so deadline tests need their own stub.
function abortAwareFetch(handler) {
    const fn = vi.fn(
        (url, options = {}) =>
            new Promise((resolve, reject) => {
                const { signal } = options;
                const abort = () => reject(abortError());
                if (signal?.aborted) return abort();
                signal?.addEventListener?.('abort', abort, { once: true });
                handler(resolve, url, options);
            }),
    );
    vi.stubGlobal('fetch', fn);
    return fn;
}

function errorToasts(tm) {
    return tm.app.showToast.mock.calls
        .filter(([, options]) => options?.type === 'error')
        .map(([message]) => message);
}

const levelsResponse = (over = {}) => ({
    levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    provider: 'a',
    model: 'x',
    process_id: 'proc-a',
    generation: '9',
    unavailable: false,
    ...over,
});

describe('Pi bridge Thinking controls', () => {
    it('uses the independent Thinking capability and sends origin-fenced max without optimistic state', async () => {
        const { tm, tab } = harness(bridgeTab());
        let finishSet;
        const fetchMock = mockFetch((_url, options) => {
            if (options?.method === 'POST')
                return new Promise((resolve) => {
                    finishSet = () =>
                        resolve({ ok: true, json: { ok: true, reason: '' } });
                });
            return levelsResponse();
        });

        tm.renderPresets('pi');
        expect(thinkingTrigger(tm)).not.toBeNull();
        expect(
            tm.presetsContainer.querySelector('.pi-rpc-model-trigger'),
        ).toBeNull();
        thinkingTrigger(tm).click();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        await vi.waitFor(() =>
            expect(
                [...dropup.querySelectorAll('.dropup-model-btn')].map(
                    (button) => button.textContent,
                ),
            ).toContain('max'),
        );
        const max = [...dropup.querySelectorAll('.dropup-model-btn')].find(
            (button) => button.textContent === 'max',
        );
        max.click();
        await vi.waitFor(() => expect(finishSet).toBeTypeOf('function'));

        const post = fetchMock.mock.calls.find(
            ([, options]) => options?.method === 'POST',
        );
        expect(JSON.parse(post[1].body)).toEqual({
            pane: 'pi-pane-1',
            level: 'max',
            provider: 'a',
            model: 'x',
            process_id: 'proc-a',
            generation: '9',
        });
        expect(tab.piBridge.thinking_level).toBe('high');
        expect(tm.inputTextArea.value).toBe('KEEP THIS PHI DRAFT');
        finishSet();
        await vi.waitFor(() =>
            expect(dropup.classList.contains('hidden')).toBe(true),
        );
        expect(tab.piBridge.thinking_level).toBe('high');
        expect(tm.app.showToast).not.toHaveBeenCalled();
    });

    it('closes the picker on setter success after a telemetry re-render reassigns the menu request', async () => {
        const { tm, tab } = harness(bridgeTab());
        let finishSet;
        mockFetch((_url, options) => {
            if (options?.method === 'POST')
                return new Promise((resolve) => {
                    finishSet = () =>
                        resolve({ ok: true, json: { ok: true, reason: '' } });
                });
            return levelsResponse();
        });
        tm.renderPresets('pi');
        thinkingTrigger(tm).click();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        await vi.waitFor(() =>
            expect(
                [...dropup.querySelectorAll('.dropup-model-btn')].map(
                    (button) => button.textContent,
                ),
            ).toContain('max'),
        );
        [...dropup.querySelectorAll('.dropup-model-btn')]
            .find((button) => button.textContent === 'max')
            .click();
        await vi.waitFor(() => expect(finishSet).toBeTypeOf('function'));

        // Telemetry arrives between setter dispatch and ack, re-rendering the
        // open picker and reassigning _piBridgeThinkingMenuRequest (BA-02).
        tm._refreshPiBridgeModels(tab);
        await vi.waitFor(() =>
            expect(
                [...dropup.querySelectorAll('.dropup-model-btn')].map(
                    (button) => button.textContent,
                ),
            ).toContain('max'),
        );
        finishSet();
        await vi.waitFor(() =>
            expect(dropup.classList.contains('hidden')).toBe(true),
        );
        expect(tm.inputTextArea.value).toBe('KEEP THIS PHI DRAFT');
        expect(tm.app.showToast).not.toHaveBeenCalled();
    });

    it('opens the fallback menu without sending and keeps the staged draft', () => {
        const tab = bridgeTab({
            piBridge: {
                state: 'managed',
                connected: true,
                generation: '9',
                model: 'a/x',
                capabilities: ['pi.lifecycle.v1', 'pi.models.v1'],
            },
        });
        const { tm } = harness(tab);
        const fetchMock = mockFetch(() => undefined);
        tm.renderPresets('pi');

        expect(thinkingTrigger(tm)).not.toBeNull();
        expect(thinkingTrigger(tm).title).toBe('Thinking · saved options');
        expect(
            tm.presetsContainer.querySelector('.pi-rpc-model-trigger'),
        ).not.toBeNull();

        // Opening the menu must not touch the PTY; the native picker is an
        // explicit row the user chooses.
        thinkingTrigger(tm).click();
        expect(tm.sendToTab).not.toHaveBeenCalled();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        expect(dropup.classList.contains('hidden')).toBe(false);
        expect(dropup.textContent).toContain('No saved Thinking options yet');
        expect(dropup.querySelector('.dropup-add-row')).not.toBeNull();

        dropup.querySelector('.pi-thinking-native-picker').click();
        expect(tm.sendToTab).toHaveBeenLastCalledWith(
            tab,
            '\x1b[200~/thinking\x1b[201~\r',
        );
        expect(dropup.classList.contains('hidden')).toBe(true);
        expect(tm.inputTextArea.value).toBe('KEEP THIS PHI DRAFT');
        expect(tm.app.showToast).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('recognizes the underlying live WebSocket in the PTY wrapper', () => {
        const tab = bridgeTab({ ws: { ws: { readyState: 1 } } });
        const { tm } = harness(tab);
        expect(tm._piThinkingPtyLive(tab)).toBe(true);
    });

    it('keeps fallback management available with a closed socket and a pending settings write', () => {
        const tab = bridgeTab({
            ws: null,
            _piBridgeFresh: null,
            isDead: true,
            piBridge: null,
        });
        const { tm } = harness(tab);
        tm.thinkingPresetStore.getState = () => ({
            confirmed: null,
            desired: [],
            dirty: false,
            saveRequired: false,
            attempt: null,
            writing: true,
            error: '',
            storageWarning: '',
        });
        tm.renderPresets('pi');
        const trigger = thinkingTrigger(tm);
        expect(trigger.disabled).toBe(false);
        trigger.click();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        expect(dropup.classList.contains('hidden')).toBe(false);
        expect(dropup.querySelector('.dropup-add-btn').disabled).toBe(false);
        expect(
            dropup.querySelector('.pi-thinking-native-picker').disabled,
        ).toBe(true);
        expect(tm.sendToTab).not.toHaveBeenCalled();
    });

    it('preserves an open same-pane fallback through routine ineligible bridge refresh', () => {
        const tab = bridgeTab({
            piBridge: {
                state: 'managed',
                connected: true,
                generation: '9',
                model: 'a/x',
                capabilities: ['pi.lifecycle.v1'],
            },
        });
        const { tm } = harness(tab);
        tm.renderPresets('pi');
        thinkingTrigger(tm).click();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        expect(dropup.classList.contains('hidden')).toBe(false);
        tm._refreshPiBridgeThinking(tab);
        expect(dropup.classList.contains('hidden')).toBe(false);
        expect(dropup.querySelector('.dropup-add-row')).not.toBeNull();
    });

    it('refuses a saved row when Thinking capability becomes live and opens the live picker', () => {
        const tab = bridgeTab({
            piBridge: {
                state: 'managed',
                connected: true,
                generation: '9',
                model: 'a/x',
                capabilities: ['pi.lifecycle.v1'],
            },
        });
        const { tm } = harness(tab);
        tm.thinkingPresetStore.getState = () => ({
            confirmed: ['high'],
            desired: ['high'],
            dirty: false,
            saveRequired: false,
            attempt: null,
            writing: false,
            error: '',
            storageWarning: '',
        });
        tm._piBridgeThinkingEligible = vi.fn().mockReturnValue(false);
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        dropup.classList.remove('hidden');
        tm._renderPiPtyThinkingFallback(dropup, tab);
        tm._piBridgeThinkingEligible.mockReturnValue(true);
        tm._renderPiRpcThinkingDropup = vi.fn();
        dropup.querySelector('.pi-thinking-saved-level').click();
        expect(tm._renderPiRpcThinkingDropup).toHaveBeenCalledOnce();
        expect(tm.sendToTab).not.toHaveBeenCalled();
    });

    it('revalidates owner, tab, socket, and capability after an editor completes', async () => {
        const mutations = [
            (tm) => {
                tm.thinkingPresetStore.ownerId = 'another-owner';
            },
            (_tm, tab) => {
                tab.ws = { readyState: 1 };
            },
            (_tm, tab) => {
                tab.paneId = 'replacement-pane';
            },
            (tm) => {
                tm.getActiveTab = () => null;
            },
            (tm) => {
                tm._piBridgeThinkingEligible = () => true;
            },
        ];
        for (const invalidate of mutations) {
            const tab = bridgeTab({
                piBridge: {
                    state: 'managed',
                    connected: true,
                    generation: '9',
                    model: 'a/x',
                    capabilities: ['pi.lifecycle.v1'],
                },
            });
            const { tm } = harness(tab);
            let finishEditor;
            tm.app.openConfigEditor = vi.fn(
                () => new Promise((resolve) => (finishEditor = resolve)),
            );
            const editing = tm._addThinkingPreset(tab);
            await vi.waitFor(() => expect(finishEditor).toBeTypeOf('function'));
            invalidate(tm, tab);
            finishEditor({ level: 'high' });
            await editing;
            expect(tm.thinkingPresetStore.setLevels).not.toHaveBeenCalled();
        }
    });

    it('confirms draft discard and refreshes before using the server list', async () => {
        const tab = bridgeTab({
            piBridge: {
                state: 'managed',
                connected: true,
                generation: '9',
                model: 'a/x',
                capabilities: ['pi.lifecycle.v1'],
            },
        });
        const { tm } = harness(tab);
        const state = {
            confirmed: ['old'],
            desired: ['draft'],
            dirty: true,
            saveRequired: true,
            attempt: null,
            writing: false,
            error: '',
            storageWarning: '',
        };
        const order = [];
        tm.thinkingPresetStore.getState = () => state;
        tm.thinkingPresetStore.refresh = vi.fn(async () => {
            order.push('refresh');
            state.confirmed = ['fresh'];
            return true;
        });
        tm.thinkingPresetStore.useServerList = vi.fn(() => {
            order.push('use');
            state.desired = [...state.confirmed];
        });
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        dropup.classList.remove('hidden');
        tm._renderPiPtyThinkingFallback(dropup, tab);
        const confirmMock = vi.fn().mockReturnValue(false);
        vi.stubGlobal('confirm', confirmMock);
        const useServer = dropup.querySelector('.pi-thinking-use-server');
        useServer.click();
        expect(confirmMock).toHaveBeenCalledOnce();
        expect(tm.thinkingPresetStore.refresh).not.toHaveBeenCalled();
        expect(tm.thinkingPresetStore.useServerList).not.toHaveBeenCalled();

        confirmMock.mockReturnValue(true);
        useServer.click();
        await vi.waitFor(() => expect(order).toEqual(['refresh', 'use']));
        expect(state.desired).toEqual(['fresh']);
    });

    it('uses the fallback when model identity is missing and dispatches a saved level', () => {
        const { tm, tab } = harness(
            bridgeTab({ piBridge: { ...bridgeTab().piBridge, model: '' } }),
        );
        tm.thinkingPresetStore.getState = () => ({
            confirmed: ['high'],
            desired: ['high'],
            dirty: false,
            saveRequired: false,
            attempt: null,
            writing: false,
            error: '',
            storageWarning: '',
        });
        mockFetch(() => {
            throw new Error(
                'should not request levels without a model identity',
            );
        });
        tm.renderPresets('pi');
        thinkingTrigger(tm).click();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        // Capability without a usable model still selects the PTY fallback.
        expect(dropup.textContent).toContain('Open native Thinking picker');
        expect(dropup.querySelector('.dropup-add-row')).not.toBeNull();
        dropup.querySelector('.pi-thinking-saved-level').click();
        expect(tm.sendToTab).toHaveBeenCalledWith(
            tab,
            '\x1b[200~/thinking high\x1b[201~\r',
        );
        expect(dropup.classList.contains('hidden')).toBe(true);
    });

    it('ignores a setter completion after the bridge generation changes', async () => {
        const { tm, tab } = harness(bridgeTab());
        let finishSet;
        mockFetch((_url, options) =>
            options?.method === 'POST'
                ? new Promise((resolve) => {
                      finishSet = () =>
                          resolve({ ok: true, json: { ok: true, reason: '' } });
                  })
                : levelsResponse(),
        );
        tm.renderPresets('pi');
        thinkingTrigger(tm).click();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        await vi.waitFor(() =>
            expect(
                [...dropup.querySelectorAll('.dropup-model-btn')].map(
                    (button) => button.textContent,
                ),
            ).toContain('max'),
        );
        [...dropup.querySelectorAll('.dropup-model-btn')]
            .find((button) => button.textContent === 'max')
            .click();
        await vi.waitFor(() => expect(finishSet).toBeTypeOf('function'));

        tab.piBridge.generation = '10';
        tm._refreshPiBridgeModels(tab);
        // The context looks valid again (a reconnect can restore the same
        // numbers), so only the revoked owner keeps the stale ack inert.
        tab.piBridge.generation = '9';
        tm._refreshPiBridgeModels(tab);
        // Finish inside the setter's 1s deadline so the ack really arrives.
        finishSet();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(dropup.classList.contains('hidden')).toBe(false);
        expect(tm._piRpcThinkingPending).toBeNull();
        expect(tab.piBridge.thinking_level).toBe('high');
        expect(tm.app.showToast).not.toHaveBeenCalled();
    });

    it('revokes a pending operation when the user navigates away and back', async () => {
        const { tm, tab } = navHarness(bridgeTab(), otherTab());
        let failLevels;
        let call = 0;
        mockFetch(() => {
            call++;
            if (call === 1)
                return new Promise((_resolve, reject) => {
                    failLevels = () => reject(new Error('request timed out'));
                });
            return levelsResponse();
        });
        tm.renderPresets('pi');
        thinkingTrigger(tm).click();
        await vi.waitFor(() => expect(failLevels).toBeTypeOf('function'));

        tm.switchTab('pi-pane-2');
        tm.switchTab('pi-pane-1');
        expect(tm.getActiveTab()).toBe(tab);
        failLevels();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(tm.sendToTab).not.toHaveBeenCalled();
        expect(tm.app.showToast).not.toHaveBeenCalled();
    });

    it('revokes a pending setter when the user navigates away', async () => {
        const { tm } = navHarness(bridgeTab(), otherTab());
        let finishSet;
        mockFetch((_url, options) =>
            options?.method === 'POST'
                ? new Promise((resolve) => {
                      finishSet = () =>
                          resolve({ ok: true, json: { ok: true, reason: '' } });
                  })
                : levelsResponse(),
        );
        tm.renderPresets('pi');
        thinkingTrigger(tm).click();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        await vi.waitFor(() =>
            expect(
                [...dropup.querySelectorAll('.dropup-model-btn')].map(
                    (button) => button.textContent,
                ),
            ).toContain('max'),
        );
        [...dropup.querySelectorAll('.dropup-model-btn')]
            .find((button) => button.textContent === 'max')
            .click();
        await vi.waitFor(() => expect(finishSet).toBeTypeOf('function'));

        tm.switchTab('pi-pane-2');
        tm.switchTab('pi-pane-1');
        // Reopening the picker proves the stale ack cannot close it.
        thinkingTrigger(tm).click();
        await vi.waitFor(() =>
            expect(
                [...dropup.querySelectorAll('.dropup-model-btn')].map(
                    (button) => button.textContent,
                ),
            ).toContain('max'),
        );
        finishSet();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(dropup.classList.contains('hidden')).toBe(false);
        expect(tm._piRpcThinkingPending).toBeNull();
        expect(tm.app.showToast).not.toHaveBeenCalled();
    });

    it('revokes a pending operation when the last tab is closed and undone', async () => {
        const { tm, tab } = navHarness(bridgeTab());
        tm._startSoftCloseCountdown = vi.fn();
        tm.app.showToast.mockReturnValue(document.createElement('div'));
        let failLevels;
        let call = 0;
        mockFetch(() => {
            call++;
            if (call === 1)
                return new Promise((_resolve, reject) => {
                    failLevels = () => reject(new Error('request timed out'));
                });
            return levelsResponse();
        });
        tm.renderPresets('pi');
        thinkingTrigger(tm).click();
        await vi.waitFor(() => expect(failLevels).toBeTypeOf('function'));

        tm.softCloseTab('pi-pane-1');
        expect(tm.activePaneId).toBeNull();
        tm.undoCloseTab('pi-pane-1');
        expect(tm.getActiveTab()).toBe(tab);
        failLevels();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(tm.sendToTab).not.toHaveBeenCalled();
        expect(
            tm.app.showToast.mock.calls.filter(
                ([, options]) => options?.type === 'error',
            ),
        ).toEqual([]);
        clearTimeout(tab.softCloseTimer);
    });

    it('reports an unknown outcome when the setter reply is not valid JSON', async () => {
        const { tm, tab } = harness(bridgeTab());
        // mockFetch returns the json value as-is, so a throwing body needs a
        // direct stub to model a truncated reply.
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url, options = {}) => ({
                ok: true,
                json: async () => {
                    if (options.method === 'POST')
                        throw new SyntaxError('Unexpected end of JSON input');
                    return levelsResponse();
                },
            })),
        );
        tm.renderPresets('pi');
        thinkingTrigger(tm).click();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        await vi.waitFor(() =>
            expect(
                [...dropup.querySelectorAll('.dropup-model-btn')].map(
                    (button) => button.textContent,
                ),
            ).toContain('max'),
        );
        [...dropup.querySelectorAll('.dropup-model-btn')]
            .find((button) => button.textContent === 'max')
            .click();
        await vi.waitFor(() =>
            expect(errorToasts(tm)).toContain('unknown — reopen the picker'),
        );
        expect(tab.piBridge.thinking_level).toBe('high');
        expect(tm.sendToTab).not.toHaveBeenCalled();
    });

    it('reports an unknown outcome when the setter times out', async () => {
        vi.useFakeTimers();
        const { tm, tab } = harness(bridgeTab());
        abortAwareFetch((resolve, _url, options) => {
            if (options.method !== 'POST')
                resolve({ ok: true, json: () => levelsResponse() });
        });
        tm.renderPresets('pi');
        thinkingTrigger(tm).click();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        await vi.advanceTimersByTimeAsync(0);
        expect(dropup.querySelectorAll('.dropup-model-btn')).toHaveLength(7);

        [...dropup.querySelectorAll('.dropup-model-btn')]
            .find((button) => button.textContent === 'max')
            .click();
        expect(tm._piRpcThinkingPending).not.toBeNull();
        await vi.advanceTimersByTimeAsync(15100);

        expect(tm._piRpcThinkingPending).toBeNull();
        expect(tm.sendToTab).not.toHaveBeenCalled();
        expect(tab.piBridge.thinking_level).toBe('high');
        expect(errorToasts(tm)).toEqual(['unknown — reopen the picker']);
        expect(
            [...dropup.querySelectorAll('.dropup-model-btn')].every(
                (button) => !button.disabled,
            ),
        ).toBe(true);
        vi.useRealTimers();
    });

    it('releases a pending setter when an HTTP baseline moves the model', async () => {
        const { tm, tab } = harness(bridgeTab());
        let failSetter;
        mockFetch((_url, options) =>
            options?.method === 'POST'
                ? new Promise((_resolve, reject) => {
                      failSetter = () => reject(new Error('request timed out'));
                  })
                : levelsResponse(),
        );
        tm.renderPresets('pi');
        thinkingTrigger(tm).click();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        await vi.waitFor(() =>
            expect(
                [...dropup.querySelectorAll('.dropup-model-btn')].map(
                    (button) => button.textContent,
                ),
            ).toContain('max'),
        );
        [...dropup.querySelectorAll('.dropup-model-btn')]
            .find((button) => button.textContent === 'max')
            .click();
        await vi.waitFor(() => expect(failSetter).toBeTypeOf('function'));
        expect(tm._piRpcThinkingPending).not.toBeNull();

        const baseline = {
            pane_id: tab.paneId,
            state: 'managed',
            generation: '9',
            telemetry_revision: '13',
            model: 'b/y',
            thinking_level: 'high',
            connected: true,
            capabilities: ['pi.lifecycle.v1', 'pi.thinking.v1'],
        };
        expect(tm._seedHttpPiBridge(tab, baseline)).toBe(true);
        expect(tm._piRpcThinkingPending).toBeNull();
        // An equal-revision confirmation keeps the baseline, and a newer frame
        // that returns to the old model must not revive the released owner.
        tm._acceptPiBridgeState(tab, baseline);
        expect(tm._piRpcThinkingPending).toBeNull();
        tm._acceptPiBridgeState(tab, {
            ...baseline,
            telemetry_revision: '14',
            model: 'a/x',
        });
        failSetter();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(tm.sendToTab).not.toHaveBeenCalled();
        expect(tm.app.showToast).not.toHaveBeenCalled();
    });

    it('releases a pending setter before a restart swaps the pane id', async () => {
        const ws = { readyState: 1, close: vi.fn() };
        const { tm, tab } = navHarness(bridgeTab({ ws, _piBridgeFresh: ws }));
        let failSetter;
        mockFetch((_url, options) =>
            options?.method === 'POST'
                ? new Promise((_resolve, reject) => {
                      failSetter = () => reject(new Error('request timed out'));
                  })
                : levelsResponse(),
        );
        tm.renderPresets('pi');
        thinkingTrigger(tm).click();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        await vi.waitFor(() =>
            expect(
                [...dropup.querySelectorAll('.dropup-model-btn')].map(
                    (button) => button.textContent,
                ),
            ).toContain('max'),
        );
        [...dropup.querySelectorAll('.dropup-model-btn')]
            .find((button) => button.textContent === 'max')
            .click();
        await vi.waitFor(() => expect(failSetter).toBeTypeOf('function'));
        expect(tm._piRpcThinkingPending).not.toBeNull();

        tm.restartTab(tab);
        expect(tm._piRpcThinkingPending).toBeNull();
        expect(tab.paneId).toBe('pi-pane-1');
        failSetter();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(tm.sendToTab).not.toHaveBeenCalled();
    });

    it('revokes a pending operation when a Pi tab is disposed', async () => {
        const ws = { readyState: 1, close: vi.fn() };
        const { tm, tab } = navHarness(bridgeTab({ ws, _piBridgeFresh: ws }));
        tab.term = { dispose: vi.fn() };
        mockFetch((_url, options) =>
            options?.method === 'POST'
                ? new Promise(() => {})
                : levelsResponse(),
        );
        tm.renderPresets('pi');
        thinkingTrigger(tm).click();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        await vi.waitFor(() =>
            expect(
                [...dropup.querySelectorAll('.dropup-model-btn')].map(
                    (button) => button.textContent,
                ),
            ).toContain('max'),
        );
        [...dropup.querySelectorAll('.dropup-model-btn')]
            .find((button) => button.textContent === 'max')
            .click();
        expect(tm._piRpcThinkingPending).not.toBeNull();

        tm.disposeTabClient('pi-pane-1', { preserveStorage: true });
        expect(tm._piRpcThinkingPending).toBeNull();
        expect(tm.sendToTab).not.toHaveBeenCalled();
    });

    it('discards a list response after the tab model changes', async () => {
        const { tm, tab } = harness(bridgeTab());
        let finishOld;
        let call = 0;
        mockFetch(() => {
            call++;
            if (call === 1)
                return new Promise((resolve) => {
                    finishOld = () => resolve(levelsResponse());
                });
            return levelsResponse({ model: 'y', levels: ['off', 'high'] });
        });
        tm.renderPresets('pi');
        thinkingTrigger(tm).click();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        await vi.waitFor(() => expect(finishOld).toBeTypeOf('function'));

        tab.piBridge.model = 'a/y';
        tm._refreshPiBridgeModels(tab);
        await vi.waitFor(() => expect(call).toBe(2));
        finishOld();
        await vi.waitFor(() =>
            expect(
                [...dropup.querySelectorAll('.dropup-model-btn')].map(
                    (button) => button.textContent,
                ),
            ).toEqual(['off', 'high']),
        );
        expect(dropup.textContent).not.toContain('max');
    });

    it('accepts a provider identity that itself contains a slash', async () => {
        const { tm } = harness(
            bridgeTab({
                piBridge: {
                    ...bridgeTab().piBridge,
                    model: 'team/a/x',
                },
            }),
        );
        mockFetch(() => levelsResponse({ provider: 'team/a', model: 'x' }));
        tm.renderPresets('pi');
        thinkingTrigger(tm).click();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        await vi.waitFor(() =>
            expect(
                [...dropup.querySelectorAll('.dropup-model-btn')].map(
                    (button) => button.textContent,
                ),
            ).toContain('max'),
        );
        expect(dropup.textContent).not.toContain('unavailable');
    });

    it('does not let a superseded setter completion close a newer picker', async () => {
        const { tm, tab } = harness(bridgeTab());
        let finishSet;
        mockFetch((_url, options) =>
            options?.method === 'POST'
                ? new Promise((resolve) => {
                      finishSet = () =>
                          resolve({ ok: true, json: { ok: true, reason: '' } });
                  })
                : levelsResponse(),
        );
        tm.renderPresets('pi');
        thinkingTrigger(tm).click();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        await vi.waitFor(() =>
            expect(
                [...dropup.querySelectorAll('.dropup-model-btn')].map(
                    (button) => button.textContent,
                ),
            ).toContain('max'),
        );
        [...dropup.querySelectorAll('.dropup-model-btn')]
            .find((button) => button.textContent === 'max')
            .click();
        await vi.waitFor(() => expect(finishSet).toBeTypeOf('function'));

        // A newer operation for another pane replaces this one.
        const newer = { paneId: 'other-pane', level: 'low' };
        tm._piRpcThinkingPending = newer;
        await vi.waitFor(() =>
            expect(dropup.classList.contains('hidden')).toBe(false),
        );
        finishSet();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(dropup.classList.contains('hidden')).toBe(false);
        expect(tm._piRpcThinkingPending).toBe(newer);
        expect(tab.piBridge.thinking_level).toBe('high');
        expect(tm.app.showToast).not.toHaveBeenCalled();
    });
});
