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
    tm.piThinkingBtn = document.createElement('button');
    tm.piThinkingBtn.addEventListener('click', () => tm._cyclePiThinking());
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

    it('cycles through the current supported levels without merging max and xhigh', async () => {
        const { tm, tab } = harness(
            bridgeTab({
                piBridge: {
                    ...bridgeTab().piBridge,
                    thinking_level: 'xhigh',
                },
            }),
        );
        const fetchMock = mockFetch((_url, options) =>
            options?.method === 'POST'
                ? { ok: true, json: { ok: true, reason: '' } }
                : levelsResponse(),
        );
        tm._updatePiThinkingButton();
        expect(tm.piThinkingBtn.title).toBe('Thinking: xhigh');
        tm.piThinkingBtn.click();
        await vi.waitFor(() =>
            expect(
                fetchMock.mock.calls.some(
                    ([, options]) => options?.method === 'POST',
                ),
            ).toBe(true),
        );
        const post = fetchMock.mock.calls.find(
            ([, options]) => options?.method === 'POST',
        );
        expect(JSON.parse(post[1].body).level).toBe('max');
        expect(tm.sendToTab).not.toHaveBeenCalled();
        expect(tab.piBridge.thinking_level).toBe('xhigh');
        expect(tm.app.showToast).not.toHaveBeenCalled();
    });

    it('keeps native picker and backtab fallbacks and preserves the staged draft', () => {
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
        expect(thinkingTrigger(tm).title).toBe(
            'Open Pi native Thinking picker',
        );
        expect(
            tm.presetsContainer.querySelector('.pi-rpc-model-trigger'),
        ).not.toBeNull();
        thinkingTrigger(tm).click();
        expect(tm.sendToTab).toHaveBeenLastCalledWith(
            tab,
            '\x1b[200~/thinking\x1b[201~\r',
        );
        tm.piThinkingBtn.click();
        expect(tm.sendToTab).toHaveBeenLastCalledWith(tab, '\x1b[Z');
        expect(tm.inputTextArea.value).toBe('KEEP THIS PHI DRAFT');
        expect(tm.app.showToast).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('offers the native picker when the bridge has no usable model identity', () => {
        const { tm } = harness(
            bridgeTab({ piBridge: { ...bridgeTab().piBridge, model: '' } }),
        );
        mockFetch(() => {
            throw new Error(
                'should not request levels without a model identity',
            );
        });
        tm.renderPresets('pi');
        thinkingTrigger(tm).click();
        const dropup = document.getElementById('pi-rpc-thinking-dropup');
        expect(dropup.textContent).toContain('Pi thinking levels unavailable');
        expect(dropup.textContent).toContain('Open native Thinking picker');
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
        tm._updatePiThinkingButton();
        tm.piThinkingBtn.click();
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

    it('locks and releases the open picker around a bridge cycle', async () => {
        const { tm } = harness(bridgeTab());
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

        tm.piThinkingBtn.click();
        await vi.waitFor(() => expect(finishSet).toBeTypeOf('function'));
        expect(
            [...dropup.querySelectorAll('.dropup-model-btn')].every(
                (button) => button.disabled,
            ),
        ).toBe(true);
        finishSet();
        await vi.waitFor(() =>
            expect(
                [...dropup.querySelectorAll('.dropup-model-btn')].every(
                    (button) => !button.disabled,
                ),
            ).toBe(true),
        );
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
        tm._updatePiThinkingButton();
        tm.piThinkingBtn.click();
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

    it('repaints the cycle button when the bridge drops in direct mode', async () => {
        const { tm, tab } = harness(bridgeTab({ directMode: true }));
        let failLevels;
        mockFetch(
            () =>
                new Promise((_resolve, reject) => {
                    failLevels = () => reject(new Error('request timed out'));
                }),
        );
        tm._updatePiThinkingButton();
        tm.piThinkingBtn.click();
        await vi.waitFor(() => expect(failLevels).toBeTypeOf('function'));
        expect(tm.piThinkingBtn.disabled).toBe(true);

        tab.piBridge.state = 'plain';
        tm._refreshPiBridgeThinking(tab);
        expect(tm._piRpcThinkingPending).toBeNull();
        expect(tm.piThinkingBtn.disabled).toBe(false);

        failLevels();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(tm.sendToTab).not.toHaveBeenCalled();
        tm.piThinkingBtn.click();
        expect(tm.sendToTab).toHaveBeenCalled();
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

    it('never sends native input from a superseded cycle', async () => {
        const { tm, tab } = harness(bridgeTab());
        let failLevels;
        mockFetch(
            () =>
                new Promise((_resolve, reject) => {
                    failLevels = () => reject(new Error('request timed out'));
                }),
        );
        tm._updatePiThinkingButton();
        tm.piThinkingBtn.click();
        await vi.waitFor(() => expect(failLevels).toBeTypeOf('function'));

        // Another pane's operation takes the singleton pending slot.
        tm._piRpcThinkingPending = { paneId: 'other-pane', level: 'low' };
        failLevels();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(tm.sendToTab).not.toHaveBeenCalled();
        expect(tm.app.showToast).not.toHaveBeenCalled();
        expect(tm._piRpcThinkingPending).toEqual({
            paneId: 'other-pane',
            level: 'low',
        });
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
