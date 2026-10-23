// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();
afterEach(() => vi.useRealTimers());

function makeTab(paneId = 'p1', coder = 'pi') {
    const tabEl = document.createElement('div');
    tabEl.scrollIntoView = vi.fn();
    return {
        paneId,
        coder,
        isDead: false,
        tabEl,
        termContainer: document.createElement('div'),
        ws: { sendInput: vi.fn(() => true) },
        piBridge: {
            state: 'managed',
            generation: '1',
            connected: true,
            capabilities: ['pi.lifecycle.v1', 'pi.history.v1'],
        },
    };
}

function makeTm(value = '') {
    const tm = Object.create(TabManager.prototype);
    const tab = makeTab();
    tm.tabs = new Map([[tab.paneId, tab]]);
    tm.activePaneId = tab.paneId;
    tm.app = { showToast: vi.fn(), sessionsManager: { activeCWD: '/project' } };
    tm.inputTextArea = document.createElement('textarea');
    tm.inputTextArea.value = value;
    document.body.appendChild(tm.inputTextArea);
    tm.sendInputBtn = document.createElement('button');
    tm.directModeToggle = document.createElement('button');
    tm.inputBarContainer = document.createElement('div');
    tm.stagedAttachments = [];
    tm._piRecall = null;
    tm._historyCache = [];
    tm._historyCursor = -1;
    tm._historyPreCycleValue = undefined;
    tm._historyLoaded = false;
    // Keep production textarea handlers and PTY writers, but isolate other UI.
    for (const method of [
        '_initHieroPreview',
        '_setupContainerDragHandlers',
        '_initAttachmentDropZone',
        '_initAttachmentPasteHandler',
        '_initBrandHud',
        'adjustInputHeight',
        '_spamScrollToBottom',
        '_renderAttachmentStrip',
        'focusActiveTerminal',
        '_closePiRpcDropups',
        '_setPiRpcActionVisibility',
        'renderPiRpcStatusBar',
        'saveTabsState',
        'updateTabOverflow',
        '_refreshOverflowDropdown',
        '_syncProjectForTab',
        'activateTabViewport',
        'updateDocumentTitle',
    ])
        tm[method] = vi.fn();
    vi.spyOn(document, 'addEventListener').mockImplementation(() => {});
    vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
    tm.setupEventListeners();
    return tm;
}

function key(tm, key, modifiers = {}) {
    const e = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...modifiers,
    });
    tm.inputTextArea.dispatchEvent(e);
    return e;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const writes = (tab) => tab.ws.sendInput.mock.calls.map(([text]) => text);
function deferred() {
    let resolve, reject;
    const response = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    const fetch = mockFetch(() => response);
    return { resolve, reject, fetch };
}

describe('production Pi recall keyboard flow', () => {
    it('browses the snapshot through multiline entries and restores the draft', async () => {
        const fetch = mockFetch(() => ({
            entries: ['one\ntwo', '!echo older'],
        }));
        const tm = makeTm('draft');
        const tab = tm.getActiveTab();
        expect(key(tm, 'ArrowUp').defaultPrevented).toBe(false);
        await flush();
        expect(tm.inputTextArea.value).toBe('one\ntwo');
        expect(tm._piRecall.cursor).toBe(0);
        expect(key(tm, 'ArrowUp').defaultPrevented).toBe(true);
        expect(tm.inputTextArea.value).toBe('!echo older');
        key(tm, 'ArrowUp'); // clamp at oldest
        expect(tm.inputTextArea.value).toBe('!echo older');
        key(tm, 'ArrowDown');
        expect(tm.inputTextArea.value).toBe('one\ntwo');
        key(tm, 'ArrowDown');
        expect(tm.inputTextArea.value).toBe('draft');
        expect(tm._piRecall).toBeNull();
        key(tm, 'ArrowUp');
        await flush();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(writes(tab)).toEqual([]);
    });

    it('defers an empty Up, fetches the pane, and changes only the Phi box', async () => {
        const fetch = mockFetch(() => ({ entries: ['newest'] }));
        const tm = makeTm();
        expect(key(tm, 'ArrowUp').defaultPrevented).toBe(true);
        expect(writes(tm.getActiveTab())).toEqual([]);
        await flush();
        expect(fetch.mock.calls[0][0]).toBe('/api/pi-history?pane=p1');
        expect(tm.inputTextArea.value).toBe('newest');
        expect(writes(tm.getActiveTab())).toEqual([]);
    });

    it('fresh Down keeps old behavior and does not start a cycle', () => {
        const fetch = mockFetch(() => ({ entries: ['one'] }));
        const tm = makeTm();
        key(tm, 'ArrowDown');
        expect(fetch).not.toHaveBeenCalled();
        expect(writes(tm.getActiveTab())).toEqual(['\x1b[B']);
        tm.inputTextArea.value = 'draft';
        expect(key(tm, 'ArrowDown').defaultPrevented).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each(['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'isComposing'])(
        'does not start recall for %s',
        (modifier) => {
            const fetch = mockFetch(() => ({ entries: ['one'] }));
            const tm = makeTm('draft');
            key(tm, 'ArrowUp', {
                [modifier]: true,
                ...(modifier === 'altKey' ? { ctrlKey: true } : {}),
            });
            expect(fetch).not.toHaveBeenCalled();
            expect(tm.inputTextArea.value).toBe('draft');
        },
    );

    it('keeps selections and multiline draft caret movement native', () => {
        const fetch = mockFetch(() => ({ entries: ['one'] }));
        const tm = makeTm('first\nlast');
        tm.inputTextArea.setSelectionRange(6, 6);
        expect(key(tm, 'ArrowUp').defaultPrevented).toBe(false);
        tm.inputTextArea.setSelectionRange(0, 2);
        expect(key(tm, 'ArrowUp').defaultPrevented).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
        'plain',
        'unavailable',
        'disconnected',
        'old peer',
        'pi-rpc',
        'bash',
    ])('%s retains old arrow behavior', (state) => {
        const fetch = mockFetch(() => ({ entries: ['one'] }));
        const tm = makeTm();
        const tab = tm.getActiveTab();
        if (state === 'plain') tab.piBridge = undefined;
        if (state === 'unavailable') tab.piBridge.state = 'unavailable';
        if (state === 'disconnected') tab.piBridge.connected = false;
        if (state === 'old peer')
            tab.piBridge.capabilities = ['pi.lifecycle.v1'];
        if (state === 'pi-rpc' || state === 'bash') tab.coder = state;
        key(tm, 'ArrowUp');
        expect(fetch).not.toHaveBeenCalled();
        expect(writes(tab)).toEqual(state === 'pi-rpc' ? [] : ['\x1b[A']);
    });

    it('leaves Pi RPC per-chat history intact', () => {
        const tm = makeTm();
        const tab = tm.getActiveTab();
        tab.coder = 'pi-rpc';
        tab.promptHistory = ['chat one', 'chat two'];
        key(tm, 'ArrowUp');
        expect(tm.inputTextArea.value).toBe('chat one');
        key(tm, 'ArrowUp');
        expect(tm.inputTextArea.value).toBe('chat two');
        key(tm, 'ArrowDown');
        key(tm, 'ArrowDown');
        expect(tm.inputTextArea.value).toBe('');
        expect(writes(tab)).toEqual([]);
    });
});

describe('failure and key ordering', () => {
    it.each([
        { ok: false, status: 503, json: {} },
        { entries: [], unavailable: true },
        { entries: [] },
        { entries: ['one', 42] },
        {},
    ])(
        'falls back on unavailable/empty/malformed replies: %j',
        async (reply) => {
            mockFetch(() => reply);
            const tm = makeTm();
            key(tm, 'ArrowUp');
            await flush();
            expect(tm.inputTextArea.value).toBe('');
            expect(tm._piRecall).toBeNull();
            expect(writes(tm.getActiveTab())).toEqual(['\x1b[A']);
            expect(tm.app.showToast).not.toHaveBeenCalled();
        },
    );

    it('does not suppress native movement on a failed read with a draft', async () => {
        mockFetch(() => {
            throw new Error('offline');
        });
        const tm = makeTm('draft');
        expect(key(tm, 'ArrowUp').defaultPrevented).toBe(false);
        await flush();
        expect(tm.inputTextArea.value).toBe('draft');
        expect(tm._piRecall).toBeNull();
        expect(writes(tm.getActiveTab())).toEqual([]);
    });

    it('bounds a stalled network request to one second', async () => {
        vi.useFakeTimers();
        mockFetch(() => new Promise(() => {}));
        const tm = makeTm();
        key(tm, 'ArrowUp');
        await vi.advanceTimersByTimeAsync(1000);
        expect(tm._piRecall).toBeNull();
        expect(writes(tm.getActiveTab())).toEqual(['\x1b[A']);
    });

    it.each(['Enter', 'ArrowUp'])(
        'Up then %s preserves PTY key order',
        async (next) => {
            const pending = deferred();
            const tm = makeTm();
            key(tm, 'ArrowUp');
            key(tm, next);
            const expected = ['\x1b[A', next === 'Enter' ? '\r' : '\x1b[A'];
            expect(writes(tm.getActiveTab())).toEqual(expected);
            pending.reject(new Error('late failure'));
            await flush();
            expect(writes(tm.getActiveTab())).toEqual(expected);
            expect(tm._piRecall).toBeNull();
        },
    );

    it('flushes Up before any direct PTY write, not only mapped keys', async () => {
        const pending = deferred();
        const tm = makeTm();
        key(tm, 'ArrowUp');
        tm.sendInput(tm.getActiveTab(), 'typed into terminal');
        expect(writes(tm.getActiveTab())).toEqual([
            '\x1b[A',
            'typed into terminal',
        ]);
        pending.resolve({ entries: ['late'] });
        await flush();
        expect(tm.inputTextArea.value).toBe('');
    });

    it('aborts on typing and does not overwrite or flush twice on late arrival', async () => {
        const pending = deferred();
        const tm = makeTm();
        key(tm, 'ArrowUp');
        tm.inputTextArea.value = 'typed draft';
        tm.inputTextArea.dispatchEvent(new Event('input', { bubbles: true }));
        expect(writes(tm.getActiveTab())).toEqual(['\x1b[A']);
        pending.resolve({ entries: ['late'] });
        await flush();
        expect(tm.inputTextArea.value).toBe('typed draft');
        expect(tm._piRecall).toBeNull();
        expect(writes(tm.getActiveTab())).toEqual(['\x1b[A']);
    });
});

describe('context and programmatic replacement fences', () => {
    it('switches to a review pane without a late response changing its box', async () => {
        const pending = deferred();
        const tm = makeTm();
        const oldTab = tm.getActiveTab();
        tm.tabs.set('review', makeTab('review', 'review'));
        key(tm, 'ArrowUp');
        tm.switchTab('review');
        expect(tm._piRecall).toBeNull();
        expect(writes(oldTab)).toEqual(['\x1b[A']);
        pending.resolve({ entries: ['wrong pane'] });
        await flush();
        expect(tm.inputTextArea.value).toBe('');
    });

    it('checks the active pane again on arrival even if a caller missed reset', async () => {
        const pending = deferred();
        const tm = makeTm();
        tm.tabs.set('p2', makeTab('p2'));
        key(tm, 'ArrowUp');
        tm.activePaneId = 'p2';
        pending.resolve({ entries: ['wrong pane'] });
        await flush();
        expect(tm.inputTextArea.value).toBe('');
        expect(tm._piRecall).toBeNull();
        expect(writes(tm.getActiveTab())).toEqual([]);
    });

    it.each(['failure', 'success'])(
        'fences a replaced tab/socket on %s',
        async (outcome) => {
            const pending = deferred();
            const tm = makeTm();
            key(tm, 'ArrowUp');
            const replacement = makeTab(); // same pane id and generation
            tm.tabs.set('p1', replacement);
            if (outcome === 'failure') pending.reject(new Error('old process'));
            else pending.resolve({ entries: ['old process'] });
            await flush();
            expect(writes(replacement)).toEqual([]);
            expect(tm.inputTextArea.value).toBe('');
            expect(tm._piRecall).toBeNull();
        },
    );

    it('fences a generation replacement and a disconnected bridge', async () => {
        const pending = deferred();
        const tm = makeTm();
        const tab = tm.getActiveTab();
        key(tm, 'ArrowUp');
        tm._acceptPiBridgeState(tab, {
            state: 'managed',
            generation: '2',
            telemetry_revision: '5',
            model: 'prov/model',
            connected: 'false',
            capabilities: 'pi.lifecycle.v1,pi.history.v1',
        });
        expect(tm._piRecall).toBeNull();
        pending.resolve({ entries: ['old runtime'] });
        await flush();
        expect(tm.inputTextArea.value).toBe('');
        expect(writes(tab)).toEqual([]);
        expect(tm._piRecallEligible(tab)).toBe(false);
    });

    it('plain Up / Alt+Up / plain Down keeps the Alt replacement', async () => {
        mockFetch((url) =>
            url.includes('/api/pi-history')
                ? { entries: ['pi entry'] }
                : [{ text: 'alt entry' }],
        );
        const tm = makeTm();
        key(tm, 'ArrowUp');
        await flush();
        key(tm, 'ArrowUp', { altKey: true });
        await flush();
        expect(tm.inputTextArea.value).toBe('alt entry');
        expect(tm._piRecall).toBeNull();
        expect(key(tm, 'ArrowDown').defaultPrevented).toBe(false);
        await flush();
        expect(tm.inputTextArea.value).toBe('alt entry');
        expect(tm._piRecall).toBeNull();
    });

    it('queued-prompt restoration invalidates a completed cycle', async () => {
        mockFetch(() => ({ entries: ['pi entry'] }));
        const tm = makeTm();
        key(tm, 'ArrowUp');
        await flush();
        tm._restoreInterruptedPrompt(tm.getActiveTab(), {
            restored: ['queued'],
        });
        expect(tm._piRecall).toBeNull();
        expect(tm.inputTextArea.value).toBe('queued\n\npi entry');
        key(tm, 'ArrowDown');
        expect(tm.inputTextArea.value).toBe('queued\n\npi entry');
    });
});
