// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';

vi.mock('../web/chat-pi/controller.js', () => ({
    rpcChatSend: vi.fn(() => true),
    destroyRpcChat: vi.fn(),
    getPiRpcStatus: vi.fn(() => null),
    getPiRpcControls: vi.fn(() => null),
    rpcChatModels: vi.fn(() => Promise.resolve([])),
    rpcChatThinkingLevels: vi.fn(() => Promise.resolve([])),
    rpcChatSetModel: vi.fn(() => Promise.resolve()),
    rpcChatSetThinking: vi.fn(() => Promise.resolve()),
    rpcChatReset: vi.fn(() => Promise.resolve()),
    rpcChatCompact: vi.fn(() => Promise.resolve()),
    rpcChatInterrupt: vi.fn(() => Promise.resolve()),
    closePiSubagentViewer: vi.fn(() => false),
    subscribePiRpcStatus: vi.fn(() => () => {}),
}));

import { TabManager } from '../web/terminal.js';
import { getPiRpcControls } from '../web/chat-pi/controller.js';

setupDomHarness();

afterEach(() => {
    vi.clearAllMocks();
    // Each test is a fresh browser: no cached model list carries over.
    window.localStorage.clear();
});

function bridgeTab(over = {}) {
    const ws = {};
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
            model: 'a/x',
            capabilities: ['pi.lifecycle.v1', 'pi.models.v1'],
        },
        ...over,
    };
}

function harness(tab) {
    const tm = Object.create(TabManager.prototype);
    tm.presetsContainer = document.createElement('div');
    tm.presetsContainer.className = 'presets-container';
    document.body.appendChild(tm.presetsContainer);
    const dropup = document.createElement('div');
    dropup.id = 'pi-rpc-model-dropup';
    dropup.className = 'model-presets-dropup hidden';
    document.body.appendChild(dropup);
    tm.getActiveTab = vi.fn(() => tab);
    tm.tabs = new Map([[tab.paneId, tab]]);
    tm.app = { showToast: vi.fn(), codersPresetRegistry: {} };
    tm.piThinkingBtn = document.createElement('button');
    tm._piRpcMenuRequest = 0;
    return { tm, dropup };
}

// Generic row order: Cmds, Models, Keys. Text matching is
// impossible here: the row sets innerText, which jsdom leaves
// unreadable, so the position plus the marker class identify it.
function modelsTrigger(tm) {
    return tm.presetsContainer.querySelectorAll('.model-trigger-btn')[1];
}

describe('bridge models trigger', () => {
    it('opens the shared picker on bridge-live Pi tabs', async () => {
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        const fetchMock = mockFetch((url) => {
            if (url.includes('/api/pi-bridge/models'))
                return {
                    models: [
                        { provider: 'a', id: 'x' },
                        { provider: 'b', id: 'y' },
                    ],
                    truncated: false,
                    unavailable: false,
                };
            return undefined;
        });

        tm.renderPresets('pi');
        const trigger = modelsTrigger(tm);
        expect(trigger).not.toBeUndefined();
        expect(trigger.classList.contains('pi-rpc-model-trigger')).toBe(true);
        expect(trigger.title).toBe('a/x');
        trigger.click();

        await vi.waitFor(() => {
            expect(dropup.querySelector('.pi-rpc-model-row')).not.toBeNull();
        });
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/api/pi-bridge/models?pane=pi-pane-1'),
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(dropup.textContent).toContain('Model · a/x');
        expect(dropup.textContent).toContain('a/x');
        expect(dropup.textContent).toContain('b/y');
    });

    it('keeps the legacy static list when the bridge is absent', () => {
        const tab = bridgeTab({ piBridge: { state: 'plain' } });
        const { tm } = harness(tab);
        const legacy = document.createElement('div');
        legacy.id = 'model-presets-dropup';
        legacy.className = 'model-presets-dropup hidden';
        document.body.appendChild(legacy);
        tm.renderModelDropup = vi.fn();
        const fetchMock = mockFetch(() => undefined);

        tm.renderPresets('pi');
        const trigger = modelsTrigger(tm);
        expect(trigger).not.toBeUndefined();
        expect(trigger.classList.contains('pi-rpc-model-trigger')).toBe(false);
        trigger.click();

        expect(tm.renderModelDropup).toHaveBeenCalledTimes(1);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps the legacy static list without the models capability', () => {
        const tab = bridgeTab();
        tab.piBridge.capabilities = ['pi.lifecycle.v1', 'pi.history.v1'];
        const { tm } = harness(tab);
        const legacy = document.createElement('div');
        legacy.id = 'model-presets-dropup';
        legacy.className = 'model-presets-dropup hidden';
        document.body.appendChild(legacy);
        tm.renderModelDropup = vi.fn();
        mockFetch(() => undefined);

        tm.renderPresets('pi');
        const trigger = modelsTrigger(tm);
        expect(trigger.classList.contains('pi-rpc-model-trigger')).toBe(false);
        trigger.click();
        expect(tm.renderModelDropup).toHaveBeenCalledTimes(1);
    });
});

describe('bridge models picker', () => {
    it('shares favorites with the Pi RPC picker', async () => {
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        mockFetch(() => ({
            models: [
                { provider: 'a', id: 'x' },
                { provider: 'b', id: 'y' },
            ],
            truncated: false,
            unavailable: false,
        }));

        tm.renderPresets('pi');
        modelsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.querySelectorAll('.pi-rpc-model-row')).toHaveLength(
                2,
            );
        });
        const stars = dropup.querySelectorAll('.pi-rpc-model-star');
        expect(stars).toHaveLength(2);
        stars[1].click();

        expect(JSON.parse(localStorage.getItem('phi.piRpc.favorites'))).toEqual(
            ['b/y'],
        );
        expect(dropup.textContent).toContain('Favorites');
    });

    it('applies only the newest pick when two land while one is in flight', async () => {
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        const posted = [];
        const finishes = [];
        mockFetch((_url, options) => {
            if (options?.method === 'POST') {
                posted.push(JSON.parse(options.body).model);
                return new Promise((resolve) => {
                    finishes.push(() => resolve({ json: { ok: true } }));
                });
            }
            return {
                models: [
                    { provider: 'b', id: 'y' },
                    { provider: 'b', id: 'z' },
                ],
                truncated: false,
                unavailable: false,
            };
        });

        tm.renderPresets('pi');
        modelsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.querySelectorAll('.dropup-model-btn')).toHaveLength(
                2,
            );
        });
        const [first] = dropup.querySelectorAll('.dropup-model-btn');
        first.click();
        await vi.waitFor(() => expect(posted).toEqual(['y']));
        // Reopen while the first pick is still in flight and pick again.
        modelsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(
                [...dropup.querySelectorAll('.dropup-model-btn')].some(
                    (button) => button.textContent === 'z',
                ),
            ).toBe(true);
        });
        [...dropup.querySelectorAll('.dropup-model-btn')]
            .find((button) => button.textContent === 'z')
            .click();
        // The second pick waits its turn instead of racing the first.
        expect(posted).toEqual(['y']);
        finishes[0]();
        await vi.waitFor(() => expect(posted).toEqual(['y', 'z']));
        finishes[1]();
        await vi.waitFor(() => expect(tm._piRpcModelPending).toBeNull());
        expect(tm.app.showToast).not.toHaveBeenCalled();
    });

    it('keeps the cached rows when the bridge reports the list unavailable', async () => {
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        let unavailable = false;
        mockFetch(() => ({
            models: unavailable ? [] : [{ provider: 'b', id: 'y' }],
            truncated: false,
            unavailable,
        }));

        tm.renderPresets('pi');
        modelsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.querySelector('.dropup-model-btn')).not.toBeNull();
        });

        unavailable = true;
        dropup.classList.add('hidden');
        modelsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('Pi model list unavailable');
        });
        // An unusable registry answer is not proof that the catalog is empty.
        expect(dropup.querySelector('.dropup-model-btn')).not.toBeNull();
    });

    it('switches through the bridge and closes on ok', async () => {
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        const fetchMock = mockFetch((_url, options) => {
            if (options?.method === 'POST')
                return { json: { ok: true, reason: '' } };
            return {
                models: [{ provider: 'b', id: 'y' }],
                truncated: false,
                unavailable: false,
            };
        });

        tm.renderPresets('pi');
        modelsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.querySelector('.dropup-model-btn')).not.toBeNull();
        });
        dropup.querySelector('.dropup-model-btn').click();
        await vi.waitFor(() => {
            expect(dropup.classList.contains('hidden')).toBe(true);
        });

        const post = fetchMock.mock.calls.find(
            ([url, options]) =>
                String(url) === '/api/pi-bridge/model' &&
                options?.method === 'POST',
        );
        expect(post).not.toBeUndefined();
        expect(JSON.parse(post[1].body)).toEqual({
            pane: 'pi-pane-1',
            provider: 'b',
            model: 'y',
        });
        expect(tm.app.showToast).not.toHaveBeenCalled();
    });

    it('closes the picker on a pick and reports the refusal as a toast', async () => {
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        mockFetch((_url, options) => {
            if (options?.method === 'POST')
                return { json: { ok: false, reason: 'no-auth' } };
            return {
                models: [{ provider: 'b', id: 'y' }],
                truncated: false,
                unavailable: false,
            };
        });

        tm.renderPresets('pi');
        modelsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.querySelector('.dropup-model-btn')).not.toBeNull();
        });
        dropup.querySelector('.dropup-model-btn').click();
        // The pick is local: the menu closes on the click, not on the reply.
        expect(dropup.classList.contains('hidden')).toBe(true);
        await vi.waitFor(() => {
            expect(tm.app.showToast).toHaveBeenCalledWith(
                'Switch refused: provider has no credentials (no-auth)',
                { type: 'error', title: 'Pi model' },
            );
        });
        expect(dropup.textContent).not.toContain(
            'Switch refused: provider has no credentials (no-auth)',
        );
    });

    it('reports unknown state when the switch round trip fails', async () => {
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        mockFetch((_url, options) => {
            if (options?.method === 'POST') return { ok: false, status: 503 };
            return {
                models: [{ provider: 'b', id: 'y' }],
                truncated: false,
                unavailable: false,
            };
        });

        tm.renderPresets('pi');
        modelsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.querySelector('.dropup-model-btn')).not.toBeNull();
        });
        dropup.querySelector('.dropup-model-btn').click();
        await vi.waitFor(() => {
            expect(tm.app.showToast).toHaveBeenCalledWith(
                'unknown — reopen the picker',
                { type: 'error', title: 'Pi model' },
            );
        });
        expect(dropup.classList.contains('hidden')).toBe(true);
    });

    it('reports unknown state when the switch errors without a reason', async () => {
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        mockFetch((_url, options) => {
            if (options?.method === 'POST')
                return { json: { ok: false, reason: '' } };
            return {
                models: [{ provider: 'b', id: 'y' }],
                truncated: false,
                unavailable: false,
            };
        });

        tm.renderPresets('pi');
        modelsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.querySelector('.dropup-model-btn')).not.toBeNull();
        });
        dropup.querySelector('.dropup-model-btn').click();
        await vi.waitFor(() => {
            expect(tm.app.showToast).toHaveBeenCalledWith(
                'unknown — reopen the picker',
                { type: 'error', title: 'Pi model' },
            );
        });
        expect(dropup.classList.contains('hidden')).toBe(true);
    });

    it('keeps a pick made while the bridge is away and sends it when it returns', async () => {
        const tab = bridgeTab();
        const { tm } = harness(tab);
        const posts = [];
        mockFetch((url, options) => {
            if (options?.method === 'POST') {
                posts.push(JSON.parse(options.body));
                return { json: { ok: true, reason: '' } };
            }
            return {
                models: [
                    { provider: 'b', id: 'y' },
                    { provider: 'b', id: 'z' },
                ],
                truncated: false,
                unavailable: false,
            };
        });

        // First pick is written and stays pending.
        tm._setPiRpcModel(tab.paneId, 'pi', 'b', 'y');
        // Second pick queues behind it.
        tm._setPiRpcModel(tab.paneId, 'pi', 'b', 'z');
        expect(tm._piRpcModelNextByPane.get(tab.paneId)).toMatchObject({
            provider: 'b',
            modelId: 'z',
        });

        // The bridge drops: the unknown outcome goes, the queued pick stays.
        tab.piBridge = {
            ...tab.piBridge,
            state: 'unavailable',
            connected: false,
        };
        tm._refreshPiBridgeModels(tab);
        expect(tm._piRpcModelPending).toBeNull();
        expect(tm._piRpcModelNextByPane.get(tab.paneId)).toMatchObject({
            modelId: 'z',
        });

        // Bridge returns: the queued pick is what the user last asked for.
        tab.piBridge = {
            state: 'managed',
            connected: true,
            model: 'a/x',
            capabilities: ['pi.lifecycle.v1', 'pi.models.v1'],
        };
        tm._refreshPiBridgeModels(tab);
        await vi.waitFor(() => {
            expect(posts.at(-1)).toMatchObject({ provider: 'b', model: 'z' });
        });
        expect(tm._piRpcModelNextByPane.has(tab.paneId)).toBe(false);
    });

    it('scopes the cached catalog to its pane instead of the coder', async () => {
        const tabA = bridgeTab();
        const { tm } = harness(tabA);
        const tabB = bridgeTab({
            paneId: 'pi-pane-2',
            piBridge: {
                state: 'managed',
                connected: true,
                model: 'a/x',
                capabilities: ['pi.lifecycle.v1', 'pi.models.v1'],
            },
        });
        tm.tabs.set(tabB.paneId, tabB);
        tm._savePiRpcModelCache('pi', tabA.paneId, [
            { provider: 'a', id: 'only-a' },
        ]);
        tm._savePiRpcModelCache('pi', tabB.paneId, [
            { provider: 'b', id: 'only-b' },
        ]);

        expect(tm._loadPiRpcModelCache('pi', tabA.paneId).models).toEqual([
            { provider: 'a', id: 'only-a' },
        ]);
        expect(tm._loadPiRpcModelCache('pi', tabB.paneId).models).toEqual([
            { provider: 'b', id: 'only-b' },
        ]);
    });

    it('keeps a successful empty answer and a partial-list flag across a reopen', async () => {
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        let fail = false;
        let truncated = true;
        let empty = false;
        mockFetch((url, options) => {
            if (String(url).includes('/api/pi-bridge/models')) {
                if (fail)
                    return new Promise((_resolve, reject) => {
                        options.signal?.addEventListener('abort', () =>
                            reject(new DOMException('Aborted', 'AbortError')),
                        );
                    });
                return {
                    models: empty ? [] : [{ provider: 'b', id: 'y' }],
                    truncated,
                    unavailable: false,
                };
            }
            return undefined;
        });

        tm.renderPresets('pi');
        modelsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('Partial model list');
        });

        // Reopen from the persisted copy with the refresh blocked: the
        // warning belongs to the rows, so it must come back with them.
        tm._piRpcModelMemory = null;
        fail = true;
        dropup.classList.add('hidden');
        vi.useFakeTimers();
        try {
            modelsTrigger(tm).click();
            expect(dropup.querySelector('.dropup-model-btn')).not.toBeNull();
            expect(dropup.textContent).toContain('Partial model list');
            await vi.advanceTimersByTimeAsync(15000);
            expect(dropup.textContent).toContain('Partial model list');
            expect(dropup.querySelector('.dropup-model-btn')).not.toBeNull();
        } finally {
            vi.useRealTimers();
        }

        // A successful empty answer is proof, not a failure to keep rows for.
        fail = false;
        truncated = false;
        empty = true;
        tm._piRpcModelsNote = null;
        dropup.classList.add('hidden');
        modelsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.querySelector('.dropup-model-btn')).toBeNull();
        });

        // Reopening from the persisted empty answer must not resurrect the
        // rows it replaced.
        tm._piRpcModelMemory = null;
        fail = true;
        dropup.classList.add('hidden');
        modelsTrigger(tm).click();
        expect(dropup.querySelector('.dropup-model-btn')).toBeNull();
    });

    it('drops a deleted pane catalog and bounds the persisted ones', async () => {
        const tab = bridgeTab();
        const { tm } = harness(tab);
        tm._savePiRpcModelCache('pi', tab.paneId, [{ provider: 'b', id: 'y' }]);
        const key = 'phi.piRpc.models.pi:pi-pane-1';
        expect(window.localStorage.getItem(key)).not.toBeNull();

        tm._forgetPiRpcModelCache('pi', tab.paneId);
        expect(window.localStorage.getItem(key)).toBeNull();
        expect(tm._loadPiRpcModelCache('pi', tab.paneId)).toBeNull();

        // A temporary detach keeps the catalog for the reconnect; a real close
        // drops it with the pane.
        tm._savePiRpcModelCache('pi', tab.paneId, [
            { provider: 'b', id: 'y' },
        ]);
        tm.tabs = new Map([[tab.paneId, tab]]);
        tm.disposeTabClient(tab.paneId, { preserveStorage: true });
        expect(window.localStorage.getItem(key)).not.toBeNull();
        tab.finalizing = false;
        tm.tabs = new Map([[tab.paneId, tab]]);
        tm.disposeTabClient(tab.paneId, { preserveStorage: false });
        expect(window.localStorage.getItem(key)).toBeNull();

        // A pane id changes with its session: old entries beyond the bound go.
        for (let index = 0; index < 25; index++) {
            tm._savePiRpcModelCache('pi', `old-pane-${index}`, [
                { provider: 'b', id: `y${index}` },
            ]);
        }
        const keys = Object.keys(window.localStorage).filter((name) =>
            name.startsWith('phi.piRpc.models.'),
        );
        expect(keys.length).toBeLessThanOrEqual(20);
    });

    it('keeps the last list when a refresh fails', async () => {
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        let fail = false;
        mockFetch((url, options) => {
            if (String(url).includes('/api/pi-bridge/models')) {
                if (fail)
                    return new Promise((_resolve, reject) => {
                        options.signal?.addEventListener('abort', () =>
                            reject(new DOMException('Aborted', 'AbortError')),
                        );
                    });
                return {
                    models: [{ provider: 'b', id: 'y' }],
                    truncated: false,
                    unavailable: false,
                };
            }
            return undefined;
        });

        tm.renderPresets('pi');
        modelsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.querySelector('.dropup-model-btn')).not.toBeNull();
        });

        fail = true;
        dropup.classList.add('hidden');
        vi.useFakeTimers();
        try {
            // Reopen: the cached rows render at once, then the stalled
            // refresh aborts. The list must not empty itself.
            modelsTrigger(tm).click();
            expect(dropup.querySelector('.dropup-model-btn')).not.toBeNull();
            await vi.advanceTimersByTimeAsync(15000);
            expect(dropup.querySelector('.dropup-model-btn')).not.toBeNull();
            expect(dropup.textContent).toContain(
                'Could not refresh: Pi models unavailable (request timed out)',
            );
            expect(tm.app.showToast).toHaveBeenCalledWith(
                'Pi models unavailable (request timed out)',
                { type: 'error', title: 'Pi models' },
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds a stalled switch request to fifteen seconds', async () => {
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        mockFetch((_url, options) => {
            if (options?.method === 'POST')
                return new Promise((_resolve, reject) => {
                    options.signal?.addEventListener('abort', () =>
                        reject(new DOMException('Aborted', 'AbortError')),
                    );
                });
            return {
                models: [{ provider: 'b', id: 'y' }],
                truncated: false,
                unavailable: false,
            };
        });

        tm.renderPresets('pi');
        modelsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.querySelector('.dropup-model-btn')).not.toBeNull();
        });
        vi.useFakeTimers();
        try {
            dropup.querySelector('.dropup-model-btn').click();
            await vi.advanceTimersByTimeAsync(15000);
            expect(tm.app.showToast).toHaveBeenCalledWith(
                'unknown — reopen the picker',
                { type: 'error', title: 'Pi model' },
            );
            expect(tm._piRpcModelPending).toBeNull();
            expect(dropup.classList.contains('hidden')).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        ['_piBridgeModelsFetch', 'Pi models unavailable (request timed out)'],
        ['_piBridgeModelSwitch', 'unknown — reopen the picker'],
    ])(
        'keeps the %s deadline armed while reading the body',
        async (method, message) => {
            const { tm } = harness(bridgeTab());
            vi.useFakeTimers();
            try {
                const readBody = vi.fn();
                vi.stubGlobal(
                    'fetch',
                    vi.fn(async (_url, options) => ({
                        ok: true,
                        json: () => {
                            readBody();
                            return new Promise((_resolve, reject) => {
                                options.signal.addEventListener('abort', () =>
                                    reject(
                                        new DOMException(
                                            'Aborted',
                                            'AbortError',
                                        ),
                                    ),
                                );
                            });
                        },
                    })),
                );
                const result = tm[method]('pi-pane-1', 'b', 'y');
                const rejected = expect(result).rejects.toThrow(message);
                await vi.advanceTimersByTimeAsync(0);
                expect(readBody).toHaveBeenCalledTimes(1);
                expect(vi.getTimerCount()).toBe(1);
                await vi.advanceTimersByTimeAsync(15000);
                await rejected;
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                vi.useRealTimers();
            }
        },
    );

    it('reports an unknown switch outcome for malformed JSON', async () => {
        const { tm } = harness(bridgeTab());
        mockFetch(() => ({ text: '{' }));
        await expect(
            tm._piBridgeModelSwitch('pi-pane-1', 'b', 'y'),
        ).rejects.toThrow('unknown — reopen the picker');
    });

    it('shows the truncation footer and the unavailable copy', async () => {
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        let truncated = true;
        mockFetch(() => ({
            models: [{ provider: 'a', id: 'x' }],
            truncated,
            unavailable: false,
        }));

        tm.renderPresets('pi');
        modelsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.textContent).toContain('Partial model list');
        });

        truncated = false;
        tm._piBridgeModelsUnavailable = true;
        tm._piRpcModels = [];
        tm._buildPiRpcModelList();
        expect(dropup.textContent).toContain('Pi model list unavailable');

        tm._piBridgeModelsUnavailable = false;
        tm._piRpcModels = [];
        tm._buildPiRpcModelList();
        expect(dropup.textContent).toContain('No Pi models available');
    });
});

describe('model provider collisions', () => {
    it.each(['pi', 'pi-rpc'])(
        'uses the %s model format to choose the active provider',
        (coder) => {
            const tab = bridgeTab({ coder });
            const { tm, dropup } = harness(tab);
            const direct = { provider: 'anthropic', id: 'claude-sonnet-4-5' };
            const routed = {
                provider: 'openrouter',
                id: 'anthropic/claude-sonnet-4-5',
            };
            tab.piBridge.model = routed.id;
            getPiRpcControls.mockReturnValue({ model: routed.id });
            tm._piRpcModels =
                coder === 'pi' ? [routed, direct] : [direct, routed];
            tm._piRpcModelQuery = '';
            dropup.innerHTML =
                '<div class="pi-rpc-model-list-container"></div>';

            tm._buildPiRpcModelList();

            const expected = coder === 'pi' ? direct : routed;
            expect(dropup.querySelectorAll('.is-active')).toHaveLength(1);
            expect(
                dropup.querySelector('.is-active .pi-rpc-dropup-meta')
                    .textContent,
            ).toBe(`${expected.provider}/${expected.id}`);
        },
    );
});

describe('bridge picker availability loss', () => {
    it.each(['disconnect', 'replacement'])(
        'invalidates the picker on browser socket %s',
        async (edge) => {
            const tab = bridgeTab();
            tab.tabEl = document.createElement('div');
            const { tm, dropup } = harness(tab);
            for (const name of [
                '_updateHistoryButton',
                'updateDocumentTitle',
                '_showReconnectOverlay',
                'maybeAutoReconnect',
                'updateDisconnectBanner',
            ])
                tm[name] = vi.fn();
            const live = { ...tab.piBridge, telemetry_revision: '3' };
            tm._acceptPiBridgeState(tab, live);
            mockFetch(() => ({ models: [{ provider: 'b', id: 'fresh' }] }));
            let finish;
            tm._piBridgeModelSwitch = vi.fn(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            );
            tm.renderPresets('pi');
            modelsTrigger(tm).click();
            await vi.waitFor(() =>
                expect(
                    dropup.querySelector('.dropup-model-btn'),
                ).not.toBeNull(),
            );
            dropup.querySelector('.dropup-model-btn').click();
            const request = tm._piRpcMenuRequest;
            if (edge === 'disconnect') tm._handleTerminalDisconnect(tab);
            else tm._setCurrentTabSocket(tab, {});

            expect(dropup.classList.contains('hidden')).toBe(true);
            expect(tm._piRpcModels).toBeNull();
            expect(tm._piRpcModelPending).toBeNull();
            expect(tm._piRpcMenuRequest).toBeGreaterThan(request);
            expect(
                modelsTrigger(tm).classList.contains('pi-rpc-model-trigger'),
            ).toBe(false);

            if (edge === 'disconnect') tm._setCurrentTabSocket(tab, {});
            tab.isDead = false;
            tm._acceptPiBridgeState(tab, live);
            expect(
                modelsTrigger(tm).classList.contains('pi-rpc-model-trigger'),
            ).toBe(true);
            modelsTrigger(tm).click();
            await vi.waitFor(() =>
                expect(
                    dropup.querySelector('.dropup-model-btn'),
                ).not.toBeNull(),
            );
            finish();
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(dropup.classList.contains('hidden')).toBe(false);
        },
    );

    it.each([
        { connected: false },
        { capabilities: ['pi.lifecycle.v1'] },
        { state: 'plain' },
    ])('closes and restores legacy controls on %j', async (loss) => {
        const tab = bridgeTab();
        const { tm, dropup } = harness(tab);
        const live = { ...tab.piBridge };
        const fetchMock = mockFetch(() => ({
            models: [{ provider: 'b', id: 'y' }],
            truncated: false,
            unavailable: false,
        }));
        const legacy = document.createElement('div');
        legacy.id = 'model-presets-dropup';
        legacy.className = 'model-presets-dropup hidden';
        document.body.appendChild(legacy);
        tm.renderModelDropup = vi.fn();
        tm.renderPresets('pi');
        modelsTrigger(tm).click();
        await vi.waitFor(() => {
            expect(dropup.querySelector('.dropup-model-btn')).not.toBeNull();
        });
        const search = dropup.querySelector('input');
        const staleChoice = dropup.querySelector('.dropup-model-btn');
        tm._acceptPiBridgeState(tab, {
            ...live,
            ...loss,
            telemetry_revision: '4',
        });

        expect(dropup.classList.contains('hidden')).toBe(true);
        expect(dropup.children).toHaveLength(0);
        expect(tm._piRpcModels).toBeNull();
        expect(
            modelsTrigger(tm).classList.contains('pi-rpc-model-trigger'),
        ).toBe(false);
        search.dispatchEvent(new Event('input'));
        staleChoice.click();
        tm._renderPiRpcModelsDropup(true);
        modelsTrigger(tm).click();
        expect(tm.renderModelDropup).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(tm.app.showToast).not.toHaveBeenCalled();

        tm._acceptPiBridgeState(tab, { ...live, telemetry_revision: '5' });
        expect(
            modelsTrigger(tm).classList.contains('pi-rpc-model-trigger'),
        ).toBe(true);
        modelsTrigger(tm).click();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => {
            expect(dropup.querySelector('.dropup-model-btn')).not.toBeNull();
        });
    });

    it.each([
        ['list', false],
        ['switch', false],
        ['switch', true],
    ])(
        'ignores a late %s reply after reconnect (background=%s)',
        async (kind, background) => {
            const tab = bridgeTab();
            const { tm, dropup } = harness(tab);
            const live = { ...tab.piBridge };
            const fetchMock = mockFetch(() => ({
                models: [{ provider: 'b', id: 'fresh' }],
                truncated: false,
                unavailable: false,
            }));
            let finish;
            if (kind === 'list') {
                tm._piBridgeModelsFetch = vi
                    .fn()
                    .mockImplementationOnce(
                        () =>
                            new Promise((resolve) => {
                                finish = resolve;
                            }),
                    )
                    .mockResolvedValue({
                        models: [{ provider: 'b', id: 'fresh' }],
                    });
            } else {
                tm._piBridgeModelSwitch = vi.fn(
                    () =>
                        new Promise((resolve) => {
                            finish = resolve;
                        }),
                );
            }
            tm.renderPresets('pi');
            modelsTrigger(tm).click();
            if (kind === 'switch') {
                await vi.waitFor(() => {
                    expect(
                        dropup.querySelector('.dropup-model-btn'),
                    ).not.toBeNull();
                });
                dropup.querySelector('.dropup-model-btn').click();
            }
            if (background) {
                tm.getActiveTab.mockReturnValue(bridgeTab({ paneId: 'other' }));
                tm._closePiRpcDropups(true);
            }
            tm._acceptPiBridgeState(tab, {
                ...live,
                connected: false,
                telemetry_revision: '4',
            });
            tm._acceptPiBridgeState(tab, { ...live, telemetry_revision: '5' });
            if (background) {
                tm.getActiveTab.mockReturnValue(tab);
                tm.renderPresets('pi');
            }
            modelsTrigger(tm).click();
            await vi.waitFor(() => {
                expect(dropup.textContent).toContain('b/fresh');
            });
            const calls = fetchMock.mock.calls.length;
            finish({
                models: [{ provider: 'old', id: 'stale' }],
                truncated: true,
            });
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(dropup.classList.contains('hidden')).toBe(false);
            expect(tm._piRpcModels).toEqual([{ provider: 'b', id: 'fresh' }]);
            expect(tm._piBridgeModelsTruncated).toBe(false);
            expect(fetchMock).toHaveBeenCalledTimes(calls);
            expect(tm.app.showToast).not.toHaveBeenCalled();
        },
    );

    it.each(['list', 'switch'])(
        'silences a late %s error after bridge loss',
        async (kind) => {
            const tab = bridgeTab();
            const { tm, dropup } = harness(tab);
            const live = { ...tab.piBridge };
            mockFetch(() => ({ models: [{ provider: 'b', id: 'y' }] }));
            let fail;
            tm[
                kind === 'list'
                    ? '_piBridgeModelsFetch'
                    : '_piBridgeModelSwitch'
            ] = vi.fn(
                () =>
                    new Promise((_resolve, reject) => {
                        fail = reject;
                    }),
            );
            tm.renderPresets('pi');
            modelsTrigger(tm).click();
            if (kind === 'switch') {
                await vi.waitFor(() => {
                    expect(
                        dropup.querySelector('.dropup-model-btn'),
                    ).not.toBeNull();
                });
                dropup.querySelector('.dropup-model-btn').click();
            }
            tm._acceptPiBridgeState(tab, {
                ...live,
                connected: false,
                telemetry_revision: '4',
            });
            fail(new Error('bridge unavailable'));
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(dropup.classList.contains('hidden')).toBe(true);
            expect(tm._piRpcModelPending ?? null).toBeNull();
            expect(tm.app.showToast).not.toHaveBeenCalled();
        },
    );
});

describe('bridge state transitions', () => {
    it('re-renders presets only when model, availability, or caps move', () => {
        const tab = bridgeTab({ piBridge: undefined });
        const { tm } = harness(tab);
        tm.renderPresets = vi.fn();

        const frame = (over = {}) => ({
            type: 'pi-bridge-state',
            state: 'managed',
            telemetry_revision: '3',
            connected: true,
            model: 'a/x',
            capabilities: ['pi.lifecycle.v1', 'pi.models.v1'],
            running: false,
            ...over,
        });

        tm._acceptPiBridgeState(tab, frame());
        expect(tm.renderPresets).toHaveBeenCalledTimes(1);

        // Same revision, same model/caps: no re-render.
        tm._acceptPiBridgeState(tab, frame());
        expect(tm.renderPresets).toHaveBeenCalledTimes(1);

        // Stale revision: rejected, no re-render.
        tm._acceptPiBridgeState(tab, frame({ telemetry_revision: '2' }));
        expect(tm.renderPresets).toHaveBeenCalledTimes(1);

        // Model move on a newer revision: re-render.
        tm._acceptPiBridgeState(
            tab,
            frame({ telemetry_revision: '4', model: 'b/y' }),
        );
        expect(tm.renderPresets).toHaveBeenCalledTimes(2);
    });

    it('leaves other tabs presets alone', () => {
        const tab = bridgeTab({ piBridge: undefined });
        const other = bridgeTab({ paneId: 'other' });
        const { tm } = harness(other);
        tm.tabs.set(tab.paneId, tab);
        tm.renderPresets = vi.fn();

        tm._acceptPiBridgeState(tab, {
            type: 'pi-bridge-state',
            state: 'managed',
            telemetry_revision: '3',
            connected: true,
            model: 'a/x',
            capabilities: ['pi.lifecycle.v1', 'pi.models.v1'],
            running: false,
        });
        expect(tm.renderPresets).not.toHaveBeenCalled();
    });
});
