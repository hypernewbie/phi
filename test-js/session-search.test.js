// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, setupDomHarness } from './_dom.js';

vi.mock('../web/chat-pi/controller.js', () => ({
    mountRpcChat: vi.fn(),
    rpcChatSend: vi.fn(),
    rpcChatSearch: vi.fn(() => () => {}),
    rpcChatReveal: vi.fn(() => true),
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
    rpcChatSetName: vi.fn(),
    subscribePiRpcStatus: vi.fn(() => () => {}),
    syncPiSubagentStrip: vi.fn(),
}));

import { TabManager } from '../web/terminal.js';
import { rpcChatReveal, rpcChatSearch } from '../web/chat-pi/controller.js';

setupDomHarness();
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

function makeTab() {
    const termContainer = document.createElement('div');
    termContainer.className = 'term-container';
    const terminalInput = document.createElement('textarea');
    termContainer.append(terminalInput);
    document.body.append(termContainer);
    const tab = {
        paneId: 'pane-search',
        termContainer,
        term: {
            focus: vi.fn(() => terminalInput.focus()),
            options: { theme: { cursor: '#10b981' } },
        },
        searchAddon: {
            clearDecorations: vi.fn(),
            findNext: vi.fn(() => true),
            findPrevious: vi.fn(() => true),
        },
    };
    return { tab, terminalInput };
}

function makeBridgePiTab() {
    const fixture = makeTab();
    const socket = {};
    Object.assign(fixture.tab, {
        coder: 'pi',
        isDead: false,
        ws: socket,
        _piBridgeFresh: socket,
        piBridge: {
            state: 'managed',
            connected: true,
            generation: '7',
            capabilities: ['pi.transcript-search.v1'],
        },
    });
    return fixture;
}

function makeManager(tab) {
    const composer = document.createElement('textarea');
    composer.id = 'input-textarea';
    document.body.append(composer);
    const manager = Object.create(TabManager.prototype);
    manager.tabs = new Map([[tab.paneId, tab]]);
    manager.inputTextArea = composer;
    manager.getActiveTab = vi.fn(() => tab);
    manager.handleInputToggleShortcut = vi.fn(() => false);
    return { manager, composer };
}

function dispatchKey(target, manager, options = {}) {
    const listener = (event) => manager.handleGlobalTabShortcuts(event);
    document.addEventListener('keydown', listener);
    const event = new KeyboardEvent('keydown', {
        key: 'f',
        bubbles: true,
        cancelable: true,
        ...options,
    });
    target.dispatchEvent(event);
    document.removeEventListener('keydown', listener);
    return event;
}

describe('active terminal find bar', () => {
    it('opens with Ctrl+F, Cmd+F, and Ctrl+Shift+F without toggling closed on repeat', () => {
        for (const modifiers of [
            { ctrlKey: true },
            { metaKey: true },
            { ctrlKey: true, shiftKey: true },
        ]) {
            document.body.innerHTML = '';
            const { tab } = makeTab();
            const { manager, composer } = makeManager(tab);
            const event = dispatchKey(composer, manager, modifiers);
            const bar = tab.termContainer.querySelector('.find-bar');
            expect(event.defaultPrevented).toBe(true);
            expect(bar).not.toBeNull();
            expect(document.activeElement).toBe(
                bar.querySelector('.find-input'),
            );

            const repeated = dispatchKey(
                document.activeElement,
                manager,
                modifiers,
            );
            expect(repeated.defaultPrevented).toBe(true);
            expect(document.activeElement).toBe(
                bar.querySelector('.find-input'),
            );
            expect(
                tab.termContainer.querySelectorAll('.find-bar'),
            ).toHaveLength(1);
        }
    });

    it('keeps the staged draft and restores its focus when Escape closes search', () => {
        const { tab } = makeTab();
        const { manager, composer } = makeManager(tab);
        composer.value = 'keep this draft';
        composer.focus();

        dispatchKey(composer, manager, { ctrlKey: true });
        const bar = tab.termContainer.querySelector('.find-bar');
        const input = bar.querySelector('.find-input');
        input.value = 'needle';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(tab.searchAddon.findNext).toHaveBeenCalledWith(
            'needle',
            expect.objectContaining({
                decorations: {
                    matchBackground: '#10b98140',
                    activeMatchBackground: '#10b981',
                },
            }),
        );

        input.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }),
        );
        input.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(tab.searchAddon.findNext).toHaveBeenCalledTimes(2);
        expect(tab.searchAddon.findPrevious).toHaveBeenCalledTimes(1);

        input.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(tab.termContainer.querySelector('.find-bar')).toBeNull();
        expect(tab.searchAddon.clearDecorations).toHaveBeenCalled();
        expect(composer.value).toBe('keep this draft');
        expect(document.activeElement).toBe(composer);
    });

    it('keeps composing and oversized queries out of typing, navigation, and source changes', () => {
        vi.useFakeTimers();
        const fetchMock = mockFetch();
        const { tab } = makeBridgePiTab();
        const { manager, composer } = makeManager(tab);
        dispatchKey(composer, manager, { ctrlKey: true });
        const bar = tab.termContainer.querySelector('.find-bar');
        const input = bar.querySelector('.find-input');
        const source = bar.querySelector('.find-source-select');
        tab.searchAddon.findNext.mockClear();
        tab.searchAddon.findPrevious.mockClear();
        tab.searchAddon.clearDecorations.mockClear();

        input.dispatchEvent(new Event('compositionstart'));
        input.value = '日本語';
        const composingInput = new Event('input', { bubbles: true });
        Object.defineProperty(composingInput, 'isComposing', { value: true });
        input.dispatchEvent(composingInput);
        expect(tab.searchAddon.findNext).not.toHaveBeenCalled();
        for (const key of ['Enter', 'Escape']) {
            const event = new KeyboardEvent('keydown', {
                key,
                bubbles: true,
                cancelable: true,
                isComposing: true,
            });
            input.dispatchEvent(event);
            expect(event.defaultPrevented).toBe(false);
        }
        expect(bar.isConnected).toBe(true);
        expect(source.disabled).toBe(true);
        expect(bar.querySelector('.find-next').disabled).toBe(true);
        expect(tab.searchAddon.findNext).not.toHaveBeenCalled();
        input.dispatchEvent(new Event('compositionend'));
        expect(tab.searchAddon.findNext).toHaveBeenCalledTimes(1);
        expect(source.disabled).toBe(false);

        input.value = '🙂'.repeat(257);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(tab.searchAddon.findNext).toHaveBeenCalledTimes(1);
        expect(tab.searchAddon.clearDecorations).toHaveBeenCalled();
        expect(bar.querySelector('.find-status').textContent).toContain(
            '256 code points',
        );
        expect(source.disabled).toBe(true);
        for (const button of bar.querySelectorAll('.find-prev, .find-next')) {
            expect(button.disabled).toBe(true);
            button.click();
        }
        input.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
        source.dispatchEvent(new Event('change'));
        expect(tab.searchAddon.findNext).toHaveBeenCalledTimes(1);
        expect(tab.searchAddon.findPrevious).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();

        // The exact code-point/UTF-8 boundary is still searchable.
        input.value = '🙂'.repeat(256);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(source.disabled).toBe(false);
        expect(bar.querySelector('.find-next').disabled).toBe(false);
        expect(tab.searchAddon.findNext).toHaveBeenLastCalledWith(
            input.value,
            expect.any(Object),
        );
        bar.querySelector('.find-close').click();
    });

    it('searches the loaded terminal immediately while Pi transcript search runs', async () => {
        vi.useFakeTimers();
        const { tab } = makeBridgePiTab();
        const { manager, composer } = makeManager(tab);
        const fetchMock = mockFetch(
            (_url, options) =>
                new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () =>
                        reject(new Error('aborted')),
                    );
                }),
        );
        dispatchKey(composer, manager, { ctrlKey: true });
        const bar = tab.termContainer.querySelector('.find-bar');
        const source = bar.querySelector('.find-source-select');
        expect(source.value).toBe('transcript');
        expect(
            Array.from(source.options).map((option) => option.textContent),
        ).toEqual(['Loaded output', 'Pi transcript']);

        const input = bar.querySelector('.find-input');
        input.value = 'bridge needle';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(tab.searchAddon.findNext).toHaveBeenCalledWith(
            'bridge needle',
            expect.any(Object),
        );
        expect(fetchMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(250);
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/pi-bridge/transcript-search',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('bridge needle'),
            }),
        );

        input.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            }),
        );
    });

    it('shows bounded Pi transcript matches in the existing find preview', async () => {
        const { tab } = makeBridgePiTab();
        const { manager, composer } = makeManager(tab);
        const fetchMock = mockFetch((_url, options) => {
            const request = JSON.parse(options.body);
            return {
                session_id: 'session-1',
                anchor_leaf_id: 'leaf-1',
                next_index: 2,
                matches: [
                    {
                        entry_id: `entry-${request.query}`,
                        role: 'assistant',
                        snippet: `Pi said ${request.query}`,
                    },
                ],
                complete: true,
                unavailable: false,
                process_id: 'process-1',
                generation: '7',
            };
        });
        dispatchKey(composer, manager, { metaKey: true });
        const bar = tab.termContainer.querySelector('.find-bar');
        const input = bar.querySelector('.find-input');
        input.value = 'transcript needle';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        await vi.waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                '/api/pi-bridge/transcript-search',
                expect.objectContaining({
                    body: expect.stringContaining('transcript needle'),
                }),
            );
            expect(bar.querySelector('.find-status').textContent).toContain(
                'matches in Pi transcript',
            );
        });
        expect(tab.searchAddon.findNext).toHaveBeenCalledWith(
            'transcript needle',
            expect.any(Object),
        );
        bar.querySelector('.find-next').click();
        expect(bar.querySelector('.find-preview').textContent).toBe(
            'Pi said transcript needle',
        );
        expect(JSON.parse(fetchMock.mock.calls.at(-1)[1].body)).toMatchObject({
            pane: tab.paneId,
            generation: '7',
            initial: true,
        });

        bar.querySelector('.find-close').click();
    });

    it('debounces remote queries and retries a transient read without blocking local search', async () => {
        vi.useFakeTimers();
        const { tab } = makeBridgePiTab();
        const { manager, composer } = makeManager(tab);
        const fetchMock = mockFetch((_url, options) => {
            if (fetchMock.mock.calls.length === 1)
                return { ok: false, status: 503 };
            const { query } = JSON.parse(options.body);
            return {
                session_id: 'session-1',
                anchor_leaf_id: 'leaf-1',
                next_index: 1,
                matches: [
                    { entry_id: 'entry-1', role: 'assistant', snippet: query },
                ],
                complete: true,
                unavailable: false,
                process_id: 'process-1',
                generation: '7',
            };
        });
        dispatchKey(composer, manager, { ctrlKey: true });
        const bar = tab.termContainer.querySelector('.find-bar');
        const input = bar.querySelector('.find-input');
        for (const query of ['n', 'ne', 'needle']) {
            input.value = query;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await vi.advanceTimersByTimeAsync(100);
        }
        expect(fetchMock).not.toHaveBeenCalled();
        expect(tab.searchAddon.findNext).toHaveBeenCalledWith(
            'needle',
            expect.any(Object),
        );
        await vi.advanceTimersByTimeAsync(150);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(500);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(bar.querySelector('.find-status').textContent).toContain(
            '1 matches in Pi transcript',
        );
        bar.querySelector('.find-next').click();
        expect(bar.querySelector('.find-preview').textContent).toBe('needle');
        bar.querySelector('.find-close').click();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([
        [503, 3],
        [400, 1],
    ])(
        'bounds retries for HTTP %s and preserves the query',
        async (status, attempts) => {
            vi.useFakeTimers();
            const { tab } = makeBridgePiTab();
            const { manager, composer } = makeManager(tab);
            const fetchMock = mockFetch(() => ({ ok: false, status }));
            dispatchKey(composer, manager, { ctrlKey: true });
            const bar = tab.termContainer.querySelector('.find-bar');
            const input = bar.querySelector('.find-input');
            input.value = 'preserved query';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await vi.advanceTimersByTimeAsync(15_000);
            expect(fetchMock).toHaveBeenCalledTimes(attempts);
            expect(input.value).toBe('preserved query');
            expect(document.activeElement).toBe(input);
            expect(bar.querySelector('.find-source-select').value).toBe(
                'terminal',
            );
            expect(bar.querySelector('.find-status').textContent).toContain(
                'showing loaded terminal output',
            );
            bar.querySelector('.find-close').click();
        },
    );

    it('cancels a transcript retry when the query changes or search closes', async () => {
        vi.useFakeTimers();
        const { tab } = makeBridgePiTab();
        const { manager, composer } = makeManager(tab);
        const fetchMock = mockFetch(() => {
            throw new TypeError('network unavailable');
        });
        dispatchKey(composer, manager, { ctrlKey: true });
        const bar = tab.termContainer.querySelector('.find-bar');
        const input = bar.querySelector('.find-input');
        input.value = 'old query';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(250);
        input.value = 'new query';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(250);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fetchMock.mock.calls[1][1].body).query).toBe(
            'new query',
        );
        bar.querySelector('.find-close').click();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('accepts Unicode case-folded transcript snippets without falling back', async () => {
        const { tab } = makeBridgePiTab();
        const { manager, composer } = makeManager(tab);
        mockFetch(() => ({
            session_id: 'session-1',
            anchor_leaf_id: 'leaf-1',
            next_index: 1,
            matches: [
                { entry_id: 'entry-1', role: 'assistant', snippet: 'ſ ς Kx' },
            ],
            complete: true,
            unavailable: false,
            process_id: 'process-1',
            generation: '7',
        }));
        dispatchKey(composer, manager, { ctrlKey: true });
        const bar = tab.termContainer.querySelector('.find-bar');
        const input = bar.querySelector('.find-input');
        for (const query of ['s', 'σ', 'kx']) {
            input.value = query;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await vi.waitFor(() => {
                expect(bar.querySelector('.find-status').textContent).toContain(
                    '1 matches in Pi transcript',
                );
            });
            bar.querySelector('.find-next').click();
            expect(bar.querySelector('.find-preview').textContent).toBe(
                'ſ ς Kx',
            );
            expect(bar.querySelector('.find-source-select').value).toBe(
                'transcript',
            );
        }
        bar.querySelector('.find-close').click();
    });

    it('keeps terminal search when the transcript capability is missing at startup', () => {
        const { tab } = makeBridgePiTab();
        tab.piBridge.capabilities = [];
        const { manager, composer } = makeManager(tab);
        const fetchMock = mockFetch();
        dispatchKey(composer, manager, { ctrlKey: true });
        const bar = tab.termContainer.querySelector('.find-bar');
        // One search source needs no selector.
        expect(bar.querySelector('.find-source-select')).toBeNull();
        const input = bar.querySelector('.find-input');
        input.value = 'local only';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(tab.searchAddon.findNext).toHaveBeenCalledWith(
            'local only',
            expect.any(Object),
        );
        expect(fetchMock).not.toHaveBeenCalled();
        bar.querySelector('.find-close').click();
    });

    it('falls back to loaded terminal search when the bridge capability disappears', async () => {
        vi.useFakeTimers();
        const { tab } = makeBridgePiTab();
        const { manager, composer } = makeManager(tab);
        const fetchMock = mockFetch(
            (_url, options) =>
                new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () =>
                        reject(new Error('aborted')),
                    );
                }),
        );
        dispatchKey(composer, manager, { ctrlKey: true });
        const bar = tab.termContainer.querySelector('.find-bar');
        const input = bar.querySelector('.find-input');
        input.value = 'fallback needle';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(250);
        expect(fetchMock).toHaveBeenCalled();

        tab.piBridge.connected = false;
        bar.querySelector('.find-next').click();
        expect(tab.searchAddon.findNext).toHaveBeenCalledWith(
            'fallback needle',
            expect.any(Object),
        );
        expect(bar.querySelector('.find-source-select').value).toBe('terminal');
        expect(bar.querySelector('.find-status').textContent).toContain(
            'showing loaded terminal output',
        );
        expect(bar.querySelector('.find-status').dataset.error).toBeUndefined();
        bar.querySelector('.find-close').click();

        // A new host generation advertises the capability again. Reopening
        // re-detects it and sends the new generation rather than caching the
        // disconnected state.
        tab.piBridge.connected = true;
        tab.piBridge.generation = '8';
        dispatchKey(composer, manager, { ctrlKey: true });
        const reconnectedBar = tab.termContainer.querySelector('.find-bar');
        expect(reconnectedBar.querySelector('.find-source-select').value).toBe(
            'transcript',
        );
        await vi.advanceTimersByTimeAsync(250);
        expect(fetchMock.mock.calls.at(-1)[1].body).toContain(
            '"generation":"8"',
        );
        reconnectedBar.querySelector('.find-close').click();
    });

    it.each(['socket', 'generation'])(
        'does not navigate matches from a replaced bridge %s',
        async (replacement) => {
            vi.useFakeTimers();
            const { tab } = makeBridgePiTab();
            const { manager, composer } = makeManager(tab);
            let host = 'old';
            const fetchMock = mockFetch((_url, options) => {
                const { query, generation } = JSON.parse(options.body);
                return {
                    session_id: 'session-1',
                    anchor_leaf_id: 'leaf-1',
                    next_index: 1,
                    matches: [
                        {
                            entry_id: `${host}-entry`,
                            role: 'assistant',
                            snippet: `${host} host: ${query}`,
                        },
                    ],
                    complete: true,
                    unavailable: false,
                    process_id: 'process-1',
                    generation,
                };
            });
            dispatchKey(composer, manager, { ctrlKey: true });
            const bar = tab.termContainer.querySelector('.find-bar');
            const input = bar.querySelector('.find-input');
            input.value = 'needle';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await vi.advanceTimersByTimeAsync(250);
            bar.querySelector('.find-next').click();
            expect(bar.querySelector('.find-preview').textContent).toBe(
                'old host: needle',
            );

            host = 'new';
            if (replacement === 'socket') {
                tab.ws = {};
                tab._piBridgeFresh = tab.ws;
            } else {
                tab.piBridge.generation = '8';
            }
            bar.querySelector('.find-next').click();
            expect(bar.querySelector('.find-preview').hidden).toBe(true);
            await vi.advanceTimersByTimeAsync(250);
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(bar.querySelector('.find-preview').textContent).toBe(
                'new host: needle',
            );
            expect(input.value).toBe('needle');
            bar.querySelector('.find-close').click();
        },
    );

    it('keeps cached transcript matches and local controls usable through a timed-out refresh', async () => {
        vi.useFakeTimers();
        const { tab } = makeBridgePiTab();
        const { manager, composer } = makeManager(tab);
        const fetchMock = mockFetch((_url, options) => ({
            session_id: 'session-1',
            anchor_leaf_id: 'leaf-1',
            next_index: 1,
            matches: [
                { entry_id: 'entry-1', role: 'assistant', snippet: 'needle' },
            ],
            complete: true,
            unavailable: false,
            process_id: 'process-1',
            generation: JSON.parse(options.body).generation,
        }));
        dispatchKey(composer, manager, { ctrlKey: true });
        let bar = tab.termContainer.querySelector('.find-bar');
        const input = bar.querySelector('.find-input');
        input.value = 'needle';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(250);
        bar.querySelector('.find-next').click();
        bar.querySelector('.find-close').click();

        let heldSignal;
        fetchMock.mockImplementation((_url, { signal }) => {
            heldSignal = signal;
            return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason));
            });
        });
        composer.focus();
        dispatchKey(composer, manager, { ctrlKey: true });
        bar = tab.termContainer.querySelector('.find-bar');
        expect(bar.querySelector('.find-preview').textContent).toBe('needle');
        await vi.advanceTimersByTimeAsync(250);
        expect(heldSignal.aborted).toBe(false);
        bar.querySelector('.find-next').click();
        expect(bar.querySelector('.find-preview').textContent).toBe('needle');
        await vi.advanceTimersByTimeAsync(15_000);
        expect(heldSignal.aborted).toBe(true);
        expect(bar.querySelector('.find-preview').textContent).toBe('needle');
        expect(bar.querySelector('.find-status').textContent).toContain(
            'showing cached matches',
        );
        const source = bar.querySelector('.find-source-select');
        source.value = 'terminal';
        source.dispatchEvent(new Event('change'));
        expect(tab.searchAddon.findNext).toHaveBeenLastCalledWith(
            'needle',
            expect.any(Object),
        );
        bar.querySelector('.find-close').click();
        expect(document.activeElement).toBe(composer);
    });

    it('routes Pi RPC search to the pane transcript and rejects stale query callbacks', () => {
        const termContainer = document.createElement('div');
        const tab = { paneId: 'pane-pi-rpc', coder: 'pi-rpc', termContainer };
        document.body.append(termContainer);
        const { manager, composer } = makeManager(tab);
        const searchCalls = [];
        const cancels = [];
        rpcChatSearch.mockImplementation((paneId, query, onUpdate) => {
            searchCalls.push({ paneId, query, onUpdate });
            const cancel = vi.fn();
            cancels.push(cancel);
            return cancel;
        });

        const shortcut = dispatchKey(composer, manager, { metaKey: true });
        expect(shortcut.defaultPrevented).toBe(true);
        const bar = termContainer.querySelector('.find-bar');
        expect(bar.querySelector('.find-source-label').textContent).toBe(
            'Pi RPC transcript',
        );
        expect(bar.querySelector('.find-preview')).not.toBeNull();

        const input = bar.querySelector('.find-input');
        const firstNewCall = searchCalls.length;
        input.value = 'old query';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.value = 'current query';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(
            searchCalls.slice(firstNewCall).map(({ query }) => query),
        ).toEqual(['old query', 'current query']);
        expect(searchCalls.at(-2).paneId).toBe(tab.paneId);

        const stale = {
            revision: 1,
            results: [
                {
                    revision: 1,
                    combinedIndex: 3,
                    kind: 'message',
                    snippet: 'stale context',
                },
            ],
            scanned: 5,
            complete: true,
            capped: false,
            failed: false,
        };
        searchCalls.at(-2).onUpdate(stale);
        expect(bar.querySelector('.find-preview').hidden).toBe(true);
        searchCalls.at(-1).onUpdate({
            ...stale,
            results: [
                {
                    revision: 1,
                    combinedIndex: 17,
                    kind: 'message',
                    snippet: 'current transcript context',
                },
            ],
        });
        input.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(rpcChatReveal).toHaveBeenCalledWith(
            tab.paneId,
            expect.objectContaining({ combinedIndex: 17 }),
        );
        expect(bar.querySelector('.find-preview').textContent).toBe(
            'current transcript context',
        );
        input.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(cancels.at(-1)).toHaveBeenCalledOnce();
        expect(document.activeElement).toBe(composer);
    });

    it('leaves browser shortcuts and modal/editable controls alone', () => {
        const { tab } = makeTab();
        const { manager, composer } = makeManager(tab);
        const unrelatedInput = document.createElement('input');
        document.body.append(unrelatedInput);
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        document.body.append(modal);

        expect(
            dispatchKey(composer, manager, { ctrlKey: true, altKey: true })
                .defaultPrevented,
        ).toBe(false);
        expect(
            dispatchKey(unrelatedInput, manager, { ctrlKey: true })
                .defaultPrevented,
        ).toBe(false);
        modal.remove();
        expect(
            dispatchKey(composer, manager, { ctrlKey: true, isComposing: true })
                .defaultPrevented,
        ).toBe(false);
        expect(tab.termContainer.querySelector('.find-bar')).toBeNull();
    });
});
