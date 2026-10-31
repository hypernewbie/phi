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

function installArchiveWorker({ failRange = false, silentInit = false } = {}) {
    const workers = [];
    class ArchiveWorker {
        onmessage = null;
        onerror = null;
        terminated = false;

        constructor() {
            this.failRange = failRange;
            this.silentInit = silentInit;
            workers.push(this);
        }

        postMessage(command) {
            this.jobId = command.jobId;
            const reply = (message) => {
                queueMicrotask(() => {
                    if (!this.terminated)
                        this.onmessage?.({
                            data: { jobId: command.jobId, ...message },
                        });
                });
            };
            if (command.type === 'init') {
                if (!this.silentInit)
                    reply({ type: 'ready', through: command.through });
            } else if (command.type === 'range') {
                if (this.failRange) {
                    reply({ type: 'error', message: 'archive parser failed' });
                    return;
                }
                reply({
                    type: 'matches',
                    through: command.end,
                    matches: [{ id: 1, snippet: 'ARCHIVE needle retained' }],
                    capped: false,
                });
                reply({ type: 'ack', through: command.end });
            } else if (command.type === 'finish') {
                reply({ type: 'complete', through: 2 });
            }
        }

        terminate() {
            this.terminated = true;
        }
    }
    vi.stubGlobal('Worker', ArchiveWorker);
    return workers;
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

            dispatchKey(document.activeElement, manager, modifiers);
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

    it('does not search during IME composition and rejects queries beyond 256 code points', () => {
        const { tab } = makeTab();
        const { manager, composer } = makeManager(tab);
        dispatchKey(composer, manager, { ctrlKey: true });
        const input = tab.termContainer.querySelector('.find-input');
        tab.searchAddon.findNext.mockClear();
        tab.searchAddon.findPrevious.mockClear();
        tab.searchAddon.clearDecorations.mockClear();

        input.dispatchEvent(new Event('compositionstart'));
        input.value = '日本語';
        const composingInput = new Event('input', { bubbles: true });
        Object.defineProperty(composingInput, 'isComposing', { value: true });
        input.dispatchEvent(composingInput);
        expect(tab.searchAddon.findNext).not.toHaveBeenCalled();
        input.dispatchEvent(new Event('compositionend'));
        expect(tab.searchAddon.findNext).toHaveBeenCalledTimes(1);

        input.value = '🙂'.repeat(257);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(tab.searchAddon.findNext).toHaveBeenCalledTimes(1);
        expect(tab.searchAddon.clearDecorations).toHaveBeenCalled();
        expect(
            tab.termContainer.querySelector('.find-status').textContent,
        ).toContain('256 code points');
    });

    it('searches the loaded terminal immediately while Pi transcript search runs', () => {
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
        ).toEqual([
            'Loaded terminal output',
            'Retained terminal output',
            'Pi transcript',
        ]);

        const input = bar.querySelector('.find-input');
        input.value = 'bridge needle';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(tab.searchAddon.findNext).toHaveBeenCalledWith(
            'bridge needle',
            expect.any(Object),
        );
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

    it('keeps terminal search when the transcript capability is missing at startup', () => {
        const { tab } = makeBridgePiTab();
        tab.piBridge.capabilities = [];
        const { manager, composer } = makeManager(tab);
        const fetchMock = mockFetch();
        dispatchKey(composer, manager, { ctrlKey: true });
        const bar = tab.termContainer.querySelector('.find-bar');
        expect(bar.querySelector('.find-source-select').value).toBe('terminal');
        expect(
            Array.from(
                bar.querySelector('.find-source-select').options,
                (option) => option.textContent,
            ),
        ).toEqual(['Loaded terminal output', 'Retained terminal output']);
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

    it('falls back to loaded terminal search when the bridge capability disappears', () => {
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
        expect(fetchMock.mock.calls.at(-1)[1].body).toContain(
            '"generation":"8"',
        );
        reconnectedBar.querySelector('.find-close').click();
    });

    it('keeps cached retained matches visible when a refresh expires', async () => {
        localStorage.clear();
        const { tab } = makeTab();
        Object.assign(tab, {
            coder: 'bash',
            paneEpoch: 1,
            paneOldest: 0,
            drainedSeq: 0,
            sessionId: 'archive-session',
            ws: { mode: 'hot', lastFrameEnd: 2 },
        });
        const { manager, composer } = makeManager(tab);
        const workers = installArchiveWorker();
        manager._fetchTerminalState = vi.fn(async () => ({
            through: 0,
            oldest: 0,
            cols: 80,
            rows: 24,
            bytes: new Uint8Array(),
        }));
        manager._fetchRecordingRangeOnce = vi.fn(async (_pane, start, end) => ({
            start,
            end,
            bytes: new Uint8Array(end - start),
            resizes: [],
        }));

        dispatchKey(composer, manager, { ctrlKey: true });
        let bar = tab.termContainer.querySelector('.find-bar');
        const input = bar.querySelector('.find-input');
        input.value = 'ARCHIVE needle';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.waitFor(() => {
            expect(bar.querySelector('.find-source-select').value).toBe(
                'retained',
            );
            expect(bar.querySelector('.find-status').textContent).toContain(
                'Complete through captured byte 2',
            );
        });
        input.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(bar.querySelector('.find-preview').textContent).toBe(
            'ARCHIVE needle retained',
        );
        expect(workers).toHaveLength(1);
        bar.querySelector('.find-close').click();

        const expired = new Error('expired checkpoint');
        expired.historyPermanent = true;
        manager._fetchTerminalState.mockRejectedValue(expired);
        dispatchKey(composer, manager, { ctrlKey: true });
        bar = tab.termContainer.querySelector('.find-bar');
        await vi.waitFor(() => {
            expect(bar.querySelector('.find-status').textContent).toContain(
                'Retained output search is incomplete',
            );
        });
        expect(bar.querySelector('.find-status').textContent).toContain(
            'Cached results cover output through byte 2',
        );
        expect(bar.querySelector('.find-status').textContent).not.toContain(
            'Complete through',
        );
        bar.querySelector('.find-input').dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(bar.querySelector('.find-preview').textContent).toBe(
            'ARCHIVE needle retained',
        );
        bar.querySelector('.find-close').click();

        manager._fetchTerminalState.mockResolvedValue({
            through: 0,
            oldest: 1,
            cols: 80,
            rows: 24,
            bytes: new Uint8Array(),
        });
        dispatchKey(composer, manager, { ctrlKey: true });
        bar = tab.termContainer.querySelector('.find-bar');
        await vi.waitFor(() => {
            expect(bar.querySelector('.find-status').textContent).toContain(
                'Retained output search is incomplete',
            );
        });
        expect(bar.querySelector('.find-status').textContent).toContain(
            'Cached results cover output through byte 2',
        );
        expect(bar.querySelector('.find-status').textContent).not.toContain(
            'Complete through',
        );
        expect(workers).toHaveLength(1);
        bar.querySelector('.find-close').click();
        localStorage.clear();
    });

    it('finishes an empty retained snapshot without requesting a range', async () => {
        localStorage.clear();
        const { tab } = makeTab();
        Object.assign(tab, {
            coder: 'bash',
            paneEpoch: 3,
            paneOldest: 2,
            drainedSeq: 2,
            sessionId: 'empty-archive-session',
            ws: { mode: 'hot', lastFrameEnd: 2 },
        });
        const { manager, composer } = makeManager(tab);
        const workers = installArchiveWorker();
        manager._fetchTerminalState = vi.fn(async () => ({
            through: 2,
            oldest: 2,
            cols: 80,
            rows: 24,
            bytes: new Uint8Array(),
        }));
        const rangeRead = vi.fn();
        manager._fetchRecordingRangeOnce = rangeRead;

        dispatchKey(composer, manager, { ctrlKey: true });
        const bar = tab.termContainer.querySelector('.find-bar');
        const input = bar.querySelector('.find-input');
        input.value = 'empty archive';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        await vi.waitFor(() => {
            expect(bar.querySelector('.find-status').textContent).toContain(
                'No matches in retained output.',
            );
        });
        expect(bar.querySelector('.find-status').textContent).toContain(
            'Complete through captured byte 2.',
        );
        expect(rangeRead).not.toHaveBeenCalled();
        expect(workers[0].terminated).toBe(true);
        bar.querySelector('.find-close').click();
        localStorage.clear();
    });

    it('terminates a retained worker that misses its acknowledgement deadline', async () => {
        localStorage.clear();
        vi.useFakeTimers();
        const { tab } = makeTab();
        Object.assign(tab, {
            coder: 'bash',
            paneEpoch: 4,
            paneOldest: 0,
            drainedSeq: 0,
            sessionId: 'watchdog-session',
            ws: { mode: 'hot', lastFrameEnd: 2 },
        });
        const { manager, composer } = makeManager(tab);
        const workers = installArchiveWorker({ silentInit: true });
        manager._fetchTerminalState = vi.fn(async () => ({
            through: 0,
            oldest: 0,
            cols: 80,
            rows: 24,
            bytes: new Uint8Array(),
        }));
        manager._fetchRecordingRangeOnce = vi.fn();

        dispatchKey(composer, manager, { ctrlKey: true });
        const bar = tab.termContainer.querySelector('.find-bar');
        const input = bar.querySelector('.find-input');
        input.value = 'watchdog';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(0);
        expect(workers).toHaveLength(1);
        expect(workers[0].terminated).toBe(false);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(workers[0].terminated).toBe(true);
        expect(bar.querySelector('.find-status').textContent).toContain(
            'Retained output unavailable; loaded terminal search remains active.',
        );
        expect(manager._fetchRecordingRangeOnce).not.toHaveBeenCalled();
        bar.querySelector('.find-close').click();
    });

    it('ignores a late archive reply after query and epoch replacement', async () => {
        localStorage.clear();
        const { tab } = makeTab();
        Object.assign(tab, {
            coder: 'bash',
            paneEpoch: 1,
            paneOldest: 0,
            drainedSeq: 0,
            sessionId: 'stale-archive-session',
            ws: { mode: 'hot', lastFrameEnd: 2 },
        });
        const { manager, composer } = makeManager(tab);
        const workers = installArchiveWorker({ silentInit: true });
        manager._fetchTerminalState = vi.fn(async (_pane, _epoch, through) => ({
            through,
            oldest: 0,
            cols: 80,
            rows: 24,
            bytes: new Uint8Array(),
        }));
        const rangeRead = vi.fn(async (_pane, start, end) => ({
            start,
            end,
            bytes: new Uint8Array(end - start),
            resizes: [],
        }));
        manager._fetchRecordingRangeOnce = rangeRead;

        dispatchKey(composer, manager, { ctrlKey: true });
        const bar = tab.termContainer.querySelector('.find-bar');
        const input = bar.querySelector('.find-input');
        input.value = 'old query';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.waitFor(() => expect(workers).toHaveLength(1));
        expect(rangeRead).not.toHaveBeenCalled();

        tab.paneEpoch = 2;
        input.value = 'needle';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await vi.waitFor(() => expect(workers).toHaveLength(2));
        workers[0].onmessage({
            data: { jobId: workers[0].jobId, type: 'ready', through: 0 },
        });
        await Promise.resolve();
        expect(rangeRead).not.toHaveBeenCalled();

        workers[1].onmessage({
            data: { jobId: workers[1].jobId, type: 'ready', through: 0 },
        });
        await vi.waitFor(() => {
            expect(bar.querySelector('.find-source-select').value).toBe(
                'retained',
            );
            expect(bar.querySelector('.find-status').textContent).toContain(
                'matches in retained output',
            );
        });
        expect(rangeRead).toHaveBeenCalledTimes(1);
        expect(workers[0].terminated).toBe(true);
        bar.querySelector('.find-next').click();
        expect(bar.querySelector('.find-preview').textContent).toBe(
            'ARCHIVE needle retained',
        );
        bar.querySelector('.find-close').click();
    });

    it('keeps loaded search available when the retained parser fails', async () => {
        localStorage.clear();
        const { tab } = makeTab();
        Object.assign(tab, {
            coder: 'bash',
            paneEpoch: 1,
            paneOldest: 0,
            drainedSeq: 0,
            sessionId: 'parser-failure-session',
            ws: { mode: 'hot', lastFrameEnd: 2 },
        });
        const { manager, composer } = makeManager(tab);
        const workers = installArchiveWorker({ failRange: true });
        manager._fetchTerminalState = vi.fn(async () => ({
            through: 0,
            oldest: 0,
            cols: 80,
            rows: 24,
            bytes: new Uint8Array(),
        }));
        manager._fetchRecordingRangeOnce = vi.fn(async (_pane, start, end) => ({
            start,
            end,
            bytes: new Uint8Array(end - start),
            resizes: [],
        }));

        dispatchKey(composer, manager, { ctrlKey: true });
        const bar = tab.termContainer.querySelector('.find-bar');
        const input = bar.querySelector('.find-input');
        input.value = 'parser failure';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        await vi.waitFor(() => {
            expect(bar.querySelector('.find-status').textContent).toContain(
                'Retained output unavailable; loaded terminal search remains active.',
            );
        });
        expect(bar.querySelector('.find-source-select').value).toBe('terminal');
        expect(tab.searchAddon.findNext).toHaveBeenCalledWith(
            'parser failure',
            expect.any(Object),
        );
        expect(workers).toHaveLength(1);
        expect(workers[0].terminated).toBe(true);
        bar.querySelector('.find-close').click();
    });

    it('does not retry a permanent retained-range failure', async () => {
        localStorage.clear();
        const { tab } = makeTab();
        Object.assign(tab, {
            coder: 'bash',
            paneEpoch: 1,
            paneOldest: 0,
            drainedSeq: 0,
            sessionId: 'permanent-range-session',
            ws: { mode: 'hot', lastFrameEnd: 2 },
        });
        const { manager, composer } = makeManager(tab);
        const workers = installArchiveWorker();
        manager._fetchTerminalState = vi.fn(async () => ({
            through: 0,
            oldest: 0,
            cols: 80,
            rows: 24,
            bytes: new Uint8Array(),
        }));
        const expired = new Error('recording range expired');
        expired.historyPermanent = true;
        const rangeRead = vi.fn(async () => {
            throw expired;
        });
        manager._fetchRecordingRangeOnce = rangeRead;

        dispatchKey(composer, manager, { ctrlKey: true });
        const bar = tab.termContainer.querySelector('.find-bar');
        const input = bar.querySelector('.find-input');
        input.value = 'expired archive';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        await vi.waitFor(() => {
            expect(bar.querySelector('.find-status').textContent).toContain(
                'Retained output unavailable; loaded terminal search remains active.',
            );
        });
        expect(rangeRead).toHaveBeenCalledTimes(1);
        expect(workers[0].terminated).toBe(true);
        expect(tab.searchAddon.findNext).toHaveBeenCalledWith(
            'expired archive',
            expect.any(Object),
        );
        bar.querySelector('.find-close').click();
        localStorage.clear();
    });

    it('retries the same retained range twice and stops with local fallback', async () => {
        localStorage.clear();
        vi.useFakeTimers();
        const { tab } = makeTab();
        Object.assign(tab, {
            coder: 'bash',
            paneEpoch: 1,
            paneOldest: 0,
            drainedSeq: 0,
            sessionId: 'retry-session',
            ws: { mode: 'hot', lastFrameEnd: 2 },
        });
        const { manager, composer } = makeManager(tab);
        const workers = installArchiveWorker();
        manager._fetchTerminalState = vi.fn(async () => ({
            through: 0,
            oldest: 0,
            cols: 80,
            rows: 24,
            bytes: new Uint8Array(),
        }));
        const rangeRead = vi.fn(async () => null);
        manager._fetchRecordingRangeOnce = rangeRead;

        dispatchKey(composer, manager, { ctrlKey: true });
        const bar = tab.termContainer.querySelector('.find-bar');
        const input = bar.querySelector('.find-input');
        input.value = 'retry range';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        await vi.advanceTimersByTimeAsync(0);
        expect(rangeRead).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(500);
        expect(rangeRead).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1500);
        expect(rangeRead).toHaveBeenCalledTimes(3);
        expect(
            rangeRead.mock.calls.map(([paneId, start, end, epoch]) => [
                paneId,
                start,
                end,
                epoch,
            ]),
        ).toEqual(Array.from({ length: 3 }, () => ['pane-search', 0, 2, 1]));
        expect(bar.querySelector('.find-status').textContent).toContain(
            'Retained output unavailable; loaded terminal search remains active.',
        );
        expect(workers[0].terminated).toBe(true);
        bar.querySelector('.find-close').click();
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
