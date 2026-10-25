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
        finishSet();
        await Promise.resolve();
        await Promise.resolve();
        expect(tab.piBridge.thinking_level).toBe('high');
        expect(tm.app.showToast).not.toHaveBeenCalled();
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
});
