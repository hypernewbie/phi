// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { setupDomHarness, mockFetch } from './_dom.js';
import {
    BackendStore,
    BackendStoreRegistry,
    MAX_BACKEND_STORES,
    SNAPSHOT_SCROLLBACK_ROWS,
} from '../web/backend-store.js';
import { BackendScope } from '../web/backend-scope.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

const indexHtml = fs.readFileSync('web/index.html', 'utf8');

function setupHtml() {
    document.body.innerHTML = indexHtml;
}

function setupVendorStubs() {
    vi.stubGlobal('FitAddon', {
        FitAddon: class {
            fit() {}
        },
    });
    vi.stubGlobal('SearchAddon', {
        SearchAddon: class {},
    });
    vi.stubGlobal('Unicode11Addon', {
        Unicode11Addon: class {},
    });
    vi.stubGlobal('WebglAddon', {
        WebglAddon: class {},
    });
    vi.stubGlobal('Audio', class {
        play() {
            return Promise.resolve();
        }
    });
    vi.stubGlobal('Terminal', function () {
        const rootEl = document.createElement('div');
        const viewportEl = document.createElement('div');
        viewportEl.className = 'xterm-viewport';
        rootEl.appendChild(viewportEl);

        return {
            cols: 80,
            rows: 24,
            element: rootEl,
            unicode: { activeVersion: '6' },
            buffer: {
                active: { type: 'normal', viewportY: 0, baseY: 0 },
                onBufferChange: vi.fn(),
            },
            parser: { registerOscHandler: vi.fn() },
            _core: {
                coreService: { onUserInput: vi.fn() },
                _bufferService: {
                    buffers: {
                        normal: { lines: { onTrim: vi.fn() } },
                    },
                },
                mouseStateService: { activeEncoding: 'SGR' },
            },
            loadAddon: vi.fn(),
            open: vi.fn(),
            focus: vi.fn(),
            dispose: vi.fn(),
            onData: vi.fn(),
            onResize: vi.fn(),
            onBell: vi.fn(),
            onSelectionChange: vi.fn(),
            attachCustomKeyEventHandler: vi.fn(),
            getSelection: vi.fn(() => ''),
            write: vi.fn(),
            writeln: vi.fn(),
            clear: vi.fn(),
            reset: vi.fn(),
            resize: vi.fn(),
            scrollToBottom: vi.fn(),
        };
    });
}

describe('Half-Phase 3A: BackendStore & Terminal Snapshot Write-Through', () => {
    beforeEach(() => {
        setupVendorStubs();
        setupHtml();
    });

    it('1. load() on cold store fetches from network, stores raw JSON text, and renders with stale: false', async () => {
        const store = new BackendStore('test-profile');
        const scope = new BackendScope('test-profile');
        const render = vi.fn();

        const fetchStub = mockFetch((url) => {
            if (url === '/api/data') {
                return { value: 42 };
            }
            return {};
        });
        globalThis.fetch = fetchStub;
        if (typeof global !== 'undefined') global.fetch = fetchStub;
        if (typeof window !== 'undefined') window.fetch = fetchStub;

        const result = await store.load('/api/data', scope, render);

        expect(result).toEqual({ value: 42 });
        expect(store.responses.get('/api/data')).toBe(JSON.stringify({ value: 42 }));
        expect(render).toHaveBeenCalledTimes(1);
        expect(render).toHaveBeenCalledWith({ value: 42 }, { stale: false });
    });

    it('2. load() on warm store calls render(cached, { stale: true }) synchronously before network, then render(fresh, { stale: false }) on change', async () => {
        const store = new BackendStore('test-profile');
        store.responses.set('/api/data', JSON.stringify({ value: 'v1' }));
        const scope = new BackendScope('test-profile');

        const calls = [];
        const render = vi.fn((data, meta) => {
            calls.push({ data, meta });
        });

        let resolveFetch;
        const fetchGate = new Promise((resolve) => {
            resolveFetch = resolve;
        });
        const fetchStub = vi.fn(async () => {
            await fetchGate;
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ value: 'v2' }),
            };
        });
        globalThis.fetch = fetchStub;
        if (typeof global !== 'undefined') global.fetch = fetchStub;
        if (typeof window !== 'undefined') window.fetch = fetchStub;

        const loadPromise = store.load('/api/data', scope, render);

        // Before fetch resolves, stale render must have fired
        expect(calls.length).toBe(1);
        expect(calls[0]).toEqual({ data: { value: 'v1' }, meta: { stale: true } });

        // Resolve network fetch
        resolveFetch();
        const result = await loadPromise;

        expect(result).toEqual({ value: 'v2' });
        expect(calls.length).toBe(2);
        expect(calls[1]).toEqual({ data: { value: 'v2' }, meta: { stale: false } });
        expect(store.responses.get('/api/data')).toBe(JSON.stringify({ value: 'v2' }));
    });

    it('3. load() on warm store skips second render when network response text is identical to cached text', async () => {
        const store = new BackendStore('test-profile');
        const rawJson = JSON.stringify({ value: 'same-data' });
        store.responses.set('/api/data', rawJson);
        const scope = new BackendScope('test-profile');

        const calls = [];
        const render = vi.fn((data, meta) => {
            calls.push({ data, meta });
        });

        const fetchStub = mockFetch(() => ({
            text: rawJson,
        }));
        globalThis.fetch = fetchStub;
        if (typeof global !== 'undefined') global.fetch = fetchStub;
        if (typeof window !== 'undefined') window.fetch = fetchStub;

        const result = await store.load('/api/data', scope, render);

        expect(result).toEqual({ value: 'same-data' });
        // Only stale: true was rendered; stale: false was skipped
        expect(calls.length).toBe(1);
        expect(calls[0]).toEqual({ data: { value: 'same-data' }, meta: { stale: true } });
    });

    it('4. Aborting scope mid-revalidation does NOT overwrite store.responses and does NOT call render with fresh data', async () => {
        const store = new BackendStore('test-profile');
        store.responses.set('/api/data', JSON.stringify({ value: 'initial' }));
        const scope = new BackendScope('test-profile');

        const calls = [];
        const render = vi.fn((data, meta) => {
            calls.push({ data, meta });
        });

        let resolveFetch;
        const fetchStub = vi.fn(async () => {
            return new Promise((resolve, reject) => {
                scope.signal.addEventListener('abort', () => {
                    const err = new DOMException('Aborted', 'AbortError');
                    reject(err);
                });
                resolveFetch = () =>
                    resolve({
                        ok: true,
                        status: 200,
                        text: async () => JSON.stringify({ value: 'fresh' }),
                    });
            });
        });
        globalThis.fetch = fetchStub;
        if (typeof global !== 'undefined') global.fetch = fetchStub;
        if (typeof window !== 'undefined') window.fetch = fetchStub;

        const loadPromise = store.load('/api/data', scope, render);

        expect(calls.length).toBe(1);
        expect(calls[0].meta.stale).toBe(true);

        // Abort mid-flight
        scope.abort();

        const result = await loadPromise;
        expect(result).toBeUndefined();

        // Cached response must remain untouched
        expect(store.responses.get('/api/data')).toBe(JSON.stringify({ value: 'initial' }));
        expect(calls.length).toBe(1);
    });

    it('5. A 401 response during load() evicts and clears the BackendStore from BackendStoreRegistry', async () => {
        const registry = new BackendStoreRegistry();
        const store = registry.get('locked-server');
        store.responses.set('/api/secret', JSON.stringify({ secret: '123' }));
        store.screens.set('pane-1', { ansi: 'hello', cols: 80, rows: 24 });
        const scope = new BackendScope('locked-server');

        const fetchStub = mockFetch(() => ({
            ok: false,
            status: 401,
            text: 'Unauthorized',
        }));
        globalThis.fetch = fetchStub;
        if (typeof global !== 'undefined') global.fetch = fetchStub;
        if (typeof window !== 'undefined') window.fetch = fetchStub;

        const render = vi.fn();
        await expect(store.load('/api/secret', scope, render)).rejects.toThrow();

        // Store contents cleared
        expect(store.responses.size).toBe(0);
        expect(store.screens.size).toBe(0);
        expect(store.tabs).toBeNull();

        // Evicted from registry
        expect(registry.has('locked-server')).toBe(false);
    });

    it('6. BackendStoreRegistry enforces LRU cap of 8 profiles (accessing p1 refreshes recency so p2 is evicted when p9 is added)', () => {
        const registry = new BackendStoreRegistry(8);

        for (let i = 1; i <= 8; i++) {
            registry.get(`p${i}`);
        }
        expect(registry.size).toBe(8);

        // Access p1 to refresh recency
        registry.get('p1');

        // Add 9th profile
        registry.get('p9');
        expect(registry.size).toBe(8);

        // p1 was recently used, so p2 must be the one evicted
        expect(registry.has('p1')).toBe(true);
        expect(registry.has('p2')).toBe(false);
        expect(registry.has('p9')).toBe(true);
    });

    it('7. TabManager.captureBackendState(store) + paintFromStore(store) writes through open tabs and terminal snapshots and restores them', () => {
        const fakeApp = {
            scope: new BackendScope('srv-1'),
            getActiveStore: () => store,
        };
        const tm = new TabManager(fakeApp);
        const store = new BackendStore('srv-1');

        // Populate open tabs
        const tab1 = {
            paneId: 'p-1',
            sessionId: 's-1',
            coder: 'bash',
            title: 'Bash Shell',
            workspace: '/ws1',
            cwd: '/ws1/sub',
            pinned: true,
            marked: false,
            term: {
                cols: 100,
                rows: 30,
                dispose: vi.fn(),
                _core: { mouseStateService: { activeEncoding: 'SGR' } },
            },
            serializeAddon: {
                serialize: vi.fn(() => 'snapshot-data'),
            },
        };
        const tab2 = {
            paneId: 'p-2',
            sessionId: 's-2',
            coder: 'opencode',
            title: 'OpenCode Tab',
            workspace: '/ws2',
            cwd: '/ws2',
            pinned: false,
            marked: true,
            opencodeMode: 'code',
            _cachedScreen: { ansi: 'cached text', cols: 80, rows: 24 },
        };
        const reviewTab = {
            paneId: 'p-rev',
            coder: 'review',
            isReview: true,
        };
        const kanbanTab = {
            paneId: 'p-kan',
            coder: 'kanban',
            isKanban: true,
        };

        tm.tabs.set('p-1', tab1);
        tm.tabs.set('p-2', tab2);
        tm.tabs.set('p-rev', reviewTab);
        tm.tabs.set('p-kan', kanbanTab);

        // Capture outgoing state
        tm.captureBackendState(store);

        expect(store.tabs).toHaveLength(2);
        expect(store.tabs.map((t) => t.paneId)).toEqual(['p-1', 'p-2']);
        expect(store.tabs[0].pinned).toBe(true);
        expect(store.tabs[1].marked).toBe(true);

        expect(store.screens.has('p-1')).toBe(true);
        expect(store.screens.get('p-1').cols).toBe(100);
        expect(store.screens.get('p-1').rows).toBe(30);

        expect(store.screens.has('p-2')).toBe(true);
        expect(store.screens.get('p-2')).toEqual({ ansi: 'cached text', cols: 80, rows: 24 });

        // Detach all
        tm.detachAll();
        expect(tm.tabs.size).toBe(0);

        // Paint from store
        const syncSpy = vi.spyOn(tm, 'syncTabs');
        const painted = tm.paintFromStore(store);

        expect(painted).toBe(true);
        expect(syncSpy).toHaveBeenCalledWith(store.tabs, { live: false, screens: store.screens });
    });
});
