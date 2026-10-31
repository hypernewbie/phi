// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import { setEmbeddedBackend } from '../web/util.js';
import { BackendScope } from '../web/backend-scope.js';
import {
    DSH_PANE_ID,
    __resetDshTabForTest,
    destroyDshPreview,
    mountDshPreview,
    openDshPreviewTab,
    refreshDshLauncher,
} from '../web/dsh-tab.js';

// DSH preview tab: one app tab per browser/server identity, no PTY.
// The iframe src is set once per mount; sync, soft-close/Undo, and
// final close must never touch /api/terminals.

setupDomHarness();
afterEach(() => {
    __resetDshTabForTest();
    setEmbeddedBackend('', '');
    vi.useRealTimers();
});

const MOUNT = '/api/dsh/abcdefghijklmnopqrstuv/';

const tick = () => new Promise((r) => setTimeout(r, 0));

function deferredFetch() {
    let resolve;
    const gate = new Promise((r) => {
        resolve = r;
    });
    mockFetch(() => gate.then(() => readyStatus()));
    return { resolve };
}

function readyStatus(mount = MOUNT) {
    return { enabled: true, state: 'ready', mount };
}

function makeTabManagerStub() {
    const tabs = new Map();
    return {
        tabs,
        switchTab: vi.fn(),
        createTab: vi.fn((paneId) => {
            const termContainer = document.createElement('div');
            document.body.appendChild(termContainer);
            tabs.set(paneId, { paneId, termContainer });
        }),
        app: { sessionsManager: { activeWorkspace: 'ws', activeCWD: '/tmp' } },
    };
}

describe('openDshPreviewTab', () => {
    it('opens exactly one frame on duplicate opens', async () => {
        __resetDshTabForTest();
        const fetchMock = mockFetch(() => readyStatus());
        const tm = makeTabManagerStub();
        await openDshPreviewTab(tm);
        await openDshPreviewTab(tm);
        expect(tm.createTab).toHaveBeenCalledTimes(1);
        expect(tm.switchTab).toHaveBeenCalledWith(DSH_PANE_ID);
        const frames = document.querySelectorAll('iframe.dsh-frame');
        expect(frames).toHaveLength(1);
        expect(frames[0].getAttribute('src')).toBe(MOUNT);
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/dsh/status',
            expect.anything(),
        );
    });

    it('never navigates to an invalid mount', async () => {
        __resetDshTabForTest();
        mockFetch(() => ({
            enabled: true,
            state: 'ready',
            mount: 'https://evil.example/phish',
        }));
        const tm = makeTabManagerStub();
        await openDshPreviewTab(tm);
        expect(document.querySelectorAll('iframe.dsh-frame')).toHaveLength(0);
        const retry = document.querySelector('.dsh-retry');
        expect(retry).not.toBeNull();
        expect(retry.style.display).not.toBe('none');
    });

    it('creates the tab and shell before status resolves', async () => {
        __resetDshTabForTest();
        const { resolve } = deferredFetch();
        const tm = makeTabManagerStub();
        const opened = openDshPreviewTab(tm);
        await tick();
        expect(tm.createTab).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.dsh-shell')).not.toBeNull();
        expect(document.querySelectorAll('iframe.dsh-frame')).toHaveLength(0);
        resolve();
        await opened;
        expect(document.querySelectorAll('iframe.dsh-frame')).toHaveLength(1);
    });

    it('serializes concurrent opens into one tab', async () => {
        __resetDshTabForTest();
        const { resolve } = deferredFetch();
        const tm = makeTabManagerStub();
        const both = Promise.all([
            openDshPreviewTab(tm),
            openDshPreviewTab(tm),
        ]);
        await tick();
        resolve();
        await both;
        expect(tm.createTab).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('iframe.dsh-frame')).toHaveLength(1);
    });

    it('ignores a late ready reply after the tab closed', async () => {
        __resetDshTabForTest();
        const { resolve } = deferredFetch();
        const tm = makeTabManagerStub();
        const opened = openDshPreviewTab(tm);
        await tick();
        tm.tabs.delete(DSH_PANE_ID);
        resolve();
        await opened;
        expect(document.querySelectorAll('iframe.dsh-frame')).toHaveLength(0);
    });

    it('shows cached status offline without navigating a stale mount', async () => {
        __resetDshTabForTest();
        localStorage.setItem('phi_dsh_preview', JSON.stringify(readyStatus()));
        mockFetch(() => {
            throw new Error('offline');
        });
        const tm = makeTabManagerStub();
        await openDshPreviewTab(tm);
        expect(document.querySelectorAll('iframe.dsh-frame')).toHaveLength(0);
        expect(document.querySelector('.dsh-shell-text').textContent).toMatch(
            /cached.*unavailable/,
        );
    });

    it('ignores a malformed cache and shows retry', async () => {
        __resetDshTabForTest();
        localStorage.setItem('phi_dsh_preview', '{broken');
        mockFetch(() => {
            throw new Error('offline');
        });
        const tm = makeTabManagerStub();
        await openDshPreviewTab(tm);
        expect(document.querySelectorAll('iframe.dsh-frame')).toHaveLength(0);
        const retry = document.querySelector('.dsh-retry');
        expect(retry).not.toBeNull();
        expect(retry.style.display).not.toBe('none');
    });

    it('shows an unreachable retry on 401', async () => {
        __resetDshTabForTest();
        mockFetch(() => ({ ok: false, status: 401 }));
        const tm = makeTabManagerStub();
        await openDshPreviewTab(tm);
        expect(document.querySelectorAll('iframe.dsh-frame')).toHaveLength(0);
        expect(document.querySelector('.dsh-shell-text')?.textContent).toMatch(
            /unreachable/,
        );
    });

    it('is unavailable in the desktop shell', async () => {
        __resetDshTabForTest();
        setEmbeddedBackend('pet-profile', 'http://localhost:1');
        try {
            mockFetch(() => readyStatus());
            const tm = makeTabManagerStub();
            await openDshPreviewTab(tm);
            expect(document.querySelectorAll('iframe.dsh-frame')).toHaveLength(
                0,
            );
            expect(
                document.querySelector('.dsh-shell-text')?.textContent,
            ).toMatch(/desktop shell/);
        } finally {
            setEmbeddedBackend(null, null);
        }
    });

    it('survives quota-exceeded storage writes', async () => {
        __resetDshTabForTest();
        mockFetch(() => readyStatus());
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('quota exceeded');
        });
        const tm = makeTabManagerStub();
        await openDshPreviewTab(tm);
        expect(document.querySelectorAll('iframe.dsh-frame')).toHaveLength(1);
    });

    it('shows a retryable state when the server disables the preview', async () => {
        __resetDshTabForTest();
        mockFetch(() => ({ enabled: false, state: 'disabled' }));
        const tm = makeTabManagerStub();
        await openDshPreviewTab(tm);
        expect(document.querySelectorAll('iframe.dsh-frame')).toHaveLength(0);
        expect(document.querySelector('.dsh-shell-text')?.textContent).toMatch(
            /off on this server/,
        );
    });
});

describe('mountDshPreview', () => {
    it('never re-navigates a live frame', () => {
        __resetDshTabForTest();
        const container = document.createElement('div');
        document.body.appendChild(container);
        mountDshPreview('dsh-preview', container, MOUNT);
        mountDshPreview(
            'dsh-preview',
            container,
            '/api/dsh/wwwwwwwwwwwwwwwwwwwwww/',
        );
        const frames = container.querySelectorAll('iframe.dsh-frame');
        expect(frames).toHaveLength(1);
        expect(frames[0].getAttribute('src')).toBe(MOUNT);
    });

    it('keeps the same frame node across launcher refresh and reopen', async () => {
        __resetDshTabForTest();
        document.body.innerHTML =
            '<button id="dsh-preview-btn" class="hidden"></button>';
        mockFetch(() => readyStatus());
        const tm = makeTabManagerStub();
        await openDshPreviewTab(tm);
        const before = document.querySelector('iframe.dsh-frame');
        await refreshDshLauncher();
        await openDshPreviewTab(tm);
        const after = document.querySelector('iframe.dsh-frame');
        expect(after).toBe(before);
        expect(after.getAttribute('src')).toBe(MOUNT);
    });

    it('destroyDshPreview removes the frame and stops the load', () => {
        __resetDshTabForTest();
        const container = document.createElement('div');
        document.body.appendChild(container);
        mountDshPreview('dsh-preview', container, MOUNT);
        const frame = container.querySelector('iframe.dsh-frame');
        expect(frame).not.toBeNull();
        destroyDshPreview('dsh-preview');
        expect(container.querySelector('iframe.dsh-frame')).toBeNull();
        expect(frame.getAttribute('src')).toBeNull();
    });
});

describe('refreshDshLauncher', () => {
    it('shows the launcher only when the server enables the preview', async () => {
        __resetDshTabForTest();
        document.body.innerHTML =
            '<button id="dsh-preview-btn" class="hidden"></button>';
        const btn = document.getElementById('dsh-preview-btn');
        mockFetch(() => readyStatus());
        await refreshDshLauncher();
        expect(btn.classList.contains('hidden')).toBe(false);
    });

    it('hides the launcher in the desktop shell', async () => {
        __resetDshTabForTest();
        document.body.innerHTML = '<button id="dsh-preview-btn"></button>';
        const btn = document.getElementById('dsh-preview-btn');
        setEmbeddedBackend('pet-profile', 'http://localhost:1');
        try {
            mockFetch(() => readyStatus());
            await refreshDshLauncher();
            expect(btn.classList.contains('hidden')).toBe(true);
        } finally {
            setEmbeddedBackend(null, null);
        }
    });

    it('hides the launcher when the preview is off', async () => {
        __resetDshTabForTest();
        document.body.innerHTML = '<button id="dsh-preview-btn"></button>';
        const btn = document.getElementById('dsh-preview-btn');
        mockFetch(() => ({ enabled: false, state: 'disabled' }));
        await refreshDshLauncher();
        expect(btn.classList.contains('hidden')).toBe(true);
    });
});

describe('TabManager DSH lifecycle', () => {
    function makeDshTab() {
        const tabEl = document.createElement('div');
        const termContainer = document.createElement('div');
        document.body.appendChild(tabEl);
        document.body.appendChild(termContainer);
        return {
            paneId: DSH_PANE_ID,
            sessionId: '',
            title: 'DSH preview',
            coder: 'dsh-preview',
            workspace: '',
            cwd: '',
            tabEl,
            termContainer,
            isDead: true,
            isDsh: true,
        };
    }

    it('syncTabs preserves the DSH tab and never reattaches it', async () => {
        const tab = makeDshTab();
        const tm = Object.create(TabManager.prototype);
        tm.tabs = new Map([[DSH_PANE_ID, tab]]);
        tm.activePaneId = DSH_PANE_ID;
        tm.app = {};
        tm.disposeTabClient = vi.fn();
        tm._connectTabSocket = vi.fn();
        tm.createTab = vi.fn();
        tm.switchTab = vi.fn();
        tm.showEmptyState = vi.fn();
        tm.applySavedTabOrder = vi.fn();
        tm.saveTabOrder = vi.fn();
        await tm.syncTabs([], { live: true });
        expect(tm.tabs.has(DSH_PANE_ID)).toBe(true);
        expect(tm.disposeTabClient).not.toHaveBeenCalled();
        expect(tm._connectTabSocket).not.toHaveBeenCalled();
        expect(tm.createTab).not.toHaveBeenCalled();
    });

    it('soft-close + Undo retains the live frame', () => {
        const tab = makeDshTab();
        mountDshPreview(DSH_PANE_ID, tab.termContainer, MOUNT);
        const tm = Object.create(TabManager.prototype);
        tm.tabs = new Map([[DSH_PANE_ID, tab]]);
        tm.activePaneId = 'other-pane';
        tm.app = {
            showToast: vi.fn(() => document.createElement('div')),
            dismissToast: vi.fn(),
        };
        tm._startSoftCloseCountdown = vi.fn();
        tm._stopSoftCloseCountdown = vi.fn();
        tm._selectTabAfterClose = vi.fn();
        tm.switchTab = vi.fn();
        tm.updateTabOverflow = vi.fn();
        tm._refreshOverflowDropdown = vi.fn();
        tm._refreshHostnameTabsDropdown = vi.fn();
        tm.softCloseTab(DSH_PANE_ID);
        expect(tab.softClosing).toBe(true);
        tm.undoCloseTab(DSH_PANE_ID);
        expect(tab.softClosing).toBe(false);
        expect(tm.tabs.has(DSH_PANE_ID)).toBe(true);
        const frame = tab.termContainer.querySelector('iframe.dsh-frame');
        expect(frame).not.toBeNull();
        expect(frame.getAttribute('src')).toBe(MOUNT);
        __resetDshTabForTest();
    });

    it('real final close skips terminal DELETE and Pi RPC persistence', async () => {
        __resetDshTabForTest();
        const fetchMock = mockFetch(() => ({}));
        const tab = makeDshTab();
        mountDshPreview(DSH_PANE_ID, tab.termContainer, MOUNT);
        const tm = Object.create(TabManager.prototype);
        tm.tabs = new Map([[DSH_PANE_ID, tab]]);
        tm.activePaneId = DSH_PANE_ID;
        tm.app = {};
        tm._clearReaderAnchor = vi.fn();
        tm._invalidatePiBridgeThinking = vi.fn();
        tm._clearPiRpcModelPending = vi.fn();
        tm.savePiRpcTabs = vi.fn();
        tm.saveDshTabs = vi.fn();
        tm.finalizeCloseTab(DSH_PANE_ID);
        await tick();
        const terminalCalls = fetchMock.mock.calls.filter(([url]) =>
            String(url).startsWith('/api/terminals'),
        );
        expect(terminalCalls).toHaveLength(0);
        expect(tm.savePiRpcTabs).not.toHaveBeenCalled();
        expect(tm.saveDshTabs).toHaveBeenCalledTimes(1);
        expect(tm.tabs.has(DSH_PANE_ID)).toBe(false);
        expect(tab.termContainer.querySelector('iframe.dsh-frame')).toBeNull();
        __resetDshTabForTest();
    });

    it('terminal metadata controls never write DSH state to PTY APIs', async () => {
        const fetchMock = mockFetch(() => ({}));
        const tm = Object.create(TabManager.prototype);
        tm.tabs = new Map([[DSH_PANE_ID, makeDshTab()]]);
        tm.syncBackendPin(DSH_PANE_ID, true);
        tm.syncBackendMark(DSH_PANE_ID, true);
        await tm.syncBackendTitle(DSH_PANE_ID, 'local title');
        expect(fetchMock).not.toHaveBeenCalled();
        tm.tabs.set('shell', { coder: 'bash' });
        tm.syncBackendPin('shell', true);
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/terminals/shell/pin',
            expect.anything(),
        );
    });

    it('a closed tab does not restore on reload', () => {
        const tm = Object.create(TabManager.prototype);
        tm.tabs = new Map([[DSH_PANE_ID, makeDshTab()]]);
        tm.saveDshTabs();
        tm.tabs.delete(DSH_PANE_ID);
        tm.saveDshTabs();
        const fresh = Object.create(TabManager.prototype);
        fresh.tabs = new Map();
        fresh.createTab = vi.fn();
        fresh.restoreDshTabs();
        expect(fresh.createTab).not.toHaveBeenCalled();
    });
});

describe('fetchStatus resilience', () => {
    it('times out stalled JSON and owns one refresh timer after repeated retries', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn(async (_url, init) => ({
            ok: true,
            json: () =>
                new Promise((_resolve, reject) => {
                    init.signal.addEventListener(
                        'abort',
                        () => reject(new DOMException('aborted', 'AbortError')),
                        { once: true },
                    );
                }),
        }));
        vi.stubGlobal('fetch', fetchMock);
        const tm = makeTabManagerStub();
        const pending = openDshPreviewTab(tm);
        await vi.advanceTimersByTimeAsync(4999);
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
        expect(document.querySelector('.dsh-shell-text').textContent).toMatch(
            /unreachable/,
        );
        const retryFetch = mockFetch(() => readyStatus());
        const retry = document.querySelector('.dsh-retry');
        for (let i = 0; i < 5; i++) retry.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(
            document.querySelector('iframe.dsh-frame').getAttribute('src'),
        ).toBe(MOUNT);
        expect(retryFetch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);
        destroyDshPreview(DSH_PANE_ID);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('disposal aborts the pending request and a reopened tab gets a new request', async () => {
        const first = deferredFetch();
        const oldFetch = globalThis.fetch;
        const tm = makeTabManagerStub();
        const pending = openDshPreviewTab(tm);
        const signal = oldFetch.mock.calls[0][1].signal;
        destroyDshPreview(DSH_PANE_ID);
        tm.tabs.delete(DSH_PANE_ID);
        expect(signal.aborted).toBe(true);
        const nextFetch = mockFetch(() => readyStatus());
        await openDshPreviewTab(tm);
        first.resolve();
        await pending;
        expect(nextFetch).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('iframe.dsh-frame')).toHaveLength(1);
        expect(
            tm.tabs.get(DSH_PANE_ID).termContainer.querySelector('iframe'),
        ).not.toBeNull();
    });

    it('scope abort discards the answer and cancels tab work', async () => {
        const gate = deferredFetch();
        const fetchMock = globalThis.fetch;
        const tm = makeTabManagerStub();
        tm.app.scope = new BackendScope();
        const pending = openDshPreviewTab(tm);
        tm.app.scope.abort();
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
        gate.resolve();
        await pending;
        expect(document.querySelectorAll('iframe.dsh-frame')).toHaveLength(0);
        expect(localStorage.getItem('phi_dsh_preview')).toBeNull();
    });

    it('keeps a live frame offline and requires confirmed reload after generation change', async () => {
        vi.useFakeTimers();
        mockFetch(() => readyStatus());
        const tm = makeTabManagerStub();
        await openDshPreviewTab(tm);
        const frame = document.querySelector('iframe.dsh-frame');
        expect(JSON.parse(localStorage.getItem('phi_dsh_preview'))).toEqual({
            enabled: true,
            state: 'ready',
        });
        mockFetch(() => {
            throw new Error('offline');
        });
        await vi.advanceTimersByTimeAsync(15000);
        expect(document.querySelector('iframe.dsh-frame')).toBe(frame);
        const nextMount = '/api/dsh/wwwwwwwwwwwwwwwwwwwwww/';
        mockFetch(() => readyStatus(nextMount));
        await vi.advanceTimersByTimeAsync(15000);
        expect(document.querySelector('iframe.dsh-frame')).toBe(frame);
        expect(frame.getAttribute('src')).toBe(MOUNT);
        const reload = document.querySelector('.dsh-reload');
        reload.focus();
        await vi.advanceTimersByTimeAsync(15000);
        expect(document.querySelector('.dsh-reload')).toBe(reload);
        expect(document.activeElement).toBe(reload);
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        document.querySelector('.dsh-reload').click();
        expect(document.querySelector('iframe.dsh-frame')).toBe(frame);
        confirm.mockReturnValue(true);
        document.querySelector('.dsh-reload').click();
        await vi.advanceTimersByTimeAsync(0);
        expect(document.querySelector('iframe.dsh-frame')).not.toBe(frame);
        expect(
            document.querySelector('iframe.dsh-frame').getAttribute('src'),
        ).toBe(nextMount);
    });

    it('treats an aborted status fetch as unreachable', async () => {
        __resetDshTabForTest();
        mockFetch(() =>
            Promise.reject(new DOMException('aborted', 'AbortError')),
        );
        const tm = makeTabManagerStub();
        await openDshPreviewTab(tm);
        expect(document.querySelectorAll('iframe.dsh-frame')).toHaveLength(0);
        expect(document.querySelector('.dsh-shell-text')?.textContent).toMatch(
            /unreachable/,
        );
    });

    it('discards a status answer after a backend switch', async () => {
        __resetDshTabForTest();
        setEmbeddedBackend('', '');
        const gate = deferredFetch();
        const tm = makeTabManagerStub();
        const pending = openDshPreviewTab(tm);
        setEmbeddedBackend('profile-b', 'http://127.0.0.1:1');
        gate.resolve();
        await pending;
        await tick();
        expect(document.querySelectorAll('iframe.dsh-frame')).toHaveLength(0);
        setEmbeddedBackend('', '');
    });
});
