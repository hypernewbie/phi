// @vitest-environment jsdom
// Single-tab embedded mode: switching backends in-page repaints the
// whole document, but the right panel persists as DOM. These tests pin
// the switch contract for every tab: no old-backend surface survives,
// and refreshes only fire once the ACTIVE backend has flipped.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { setupDomHarness, stubWebSocket } from './_dom.js';
import { App } from '../web/app.js';
import { setEmbeddedBackend } from '../web/util.js';
import { backendStores } from '../web/backend-store.js';
import { loadCoderRegistry } from '../web/coders.js';

setupDomHarness();
const indexHtml = fs.readFileSync('web/index.html', 'utf8');

function setupVendorStubs() {
    if (!HTMLElement.prototype.scrollIntoView) {
        HTMLElement.prototype.scrollIntoView = () => {};
    }
    vi.stubGlobal('FitAddon', {
        FitAddon: class {
            fit() {}
        },
    });
    vi.stubGlobal('SearchAddon', { SearchAddon: class {} });
    vi.stubGlobal('Unicode11Addon', {
        Unicode11: class {},
        Unicode11Addon: class {},
    });
    vi.stubGlobal('WebglAddon', { WebglAddon: class {} });
    vi.stubGlobal(
        'Audio',
        class {
            play() {
                return Promise.resolve();
            }
        },
    );
    // This global is instantiated with `new Terminal()` by xterm setup.
    // biome-ignore lint/complexity/useArrowFunction: must be constructable
    vi.stubGlobal('Terminal', function () {
        const rootEl = document.createElement('div');
        const viewportEl = document.createElement('div');
        viewportEl.className = 'xterm-viewport';
        rootEl.appendChild(viewportEl);
        return {
            cols: 80,
            rows: 24,
            options: { theme: {} },
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
                    buffers: { normal: { lines: { onTrim: vi.fn() } } },
                },
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

/** Routes the switch's background traffic. `routes` entries are
 *  { match: string prefix, data, delay } — the first hit wins; anything
 *  unmatched answers ok:[] so no code path ever rejects. */
function switchFetch(routes = []) {
    const jsonResponse = (data, delay = 0) =>
        new Promise((resolve) =>
            setTimeout(
                () =>
                    resolve({
                        ok: true,
                        status: 200,
                        headers: { get: () => 'application/json' },
                        json: async () => data,
                        text: async () => JSON.stringify(data),
                    }),
                delay,
            ),
        );
    return vi.fn((url) => {
        const u = String(url);
        if (u === '/__phi/active') {
            return Promise.resolve({
                ok: true,
                status: 200,
                headers: { get: () => 'application/json' },
                json: async () => ({ ok: true }),
                text: async () => '{}',
            });
        }
        const hit = routes.find((r) => u.startsWith(r.match));
        if (hit) return jsonResponse(hit.data, hit.delay ?? 0);
        return jsonResponse([]);
    });
}

const CONFIG = {
    workspaces: [],
    active_cwd: '',
    markdown_dirs: ['.'],
    quick_commands: [],
    terminal_commands: [],
};

describe('single-tab switch: right panel surfaces', () => {
    const realSetInterval = globalThis.setInterval.bind(globalThis);
    const realClearInterval = globalThis.clearInterval.bind(globalThis);
    let app;
    let appIntervals = [];

    beforeEach(async () => {
        setupVendorStubs();
        const fetchStub = switchFetch();
        vi.stubGlobal('fetch', fetchStub);
        globalThis.fetch = fetchStub;
        global.fetch = fetchStub;
        window.fetch = fetchStub;
        await loadCoderRegistry(true);
        stubWebSocket();
        document.body.innerHTML = indexHtml;
        window.history.replaceState(null, '', '/');
        // The embedded page initializes the panel before the first
        // backend switch. Keep it closed here to avoid the startup
        // refresh timer, then tests opt into an open panel explicitly.
        localStorage.setItem('phi_diff_panel_open', 'false');
        setEmbeddedBackend('p-old', 'http://old:7070');
        appIntervals = [];
        const intervalSpy = vi
            .spyOn(globalThis, 'setInterval')
            .mockImplementation((...args) => {
                const interval = realSetInterval(...args);
                appIntervals.push(interval);
                return interval;
            });
        app = new App();
        intervalSpy.mockRestore();
        app.initOnce();
    });

    afterEach(() => {
        for (const interval of appIntervals) realClearInterval(interval);
        appIntervals = [];
        setEmbeddedBackend('', '');
        if (typeof app?.scope?.abort === 'function') {
            app.scope.abort('test teardown');
        }
        if (app?.diffController) {
            if (app.diffController._toggleFitTimer !== null) {
                clearTimeout(app.diffController._toggleFitTimer);
                app.diffController._toggleFitTimer = null;
            }
            app.diffController.refreshDiff = () => Promise.resolve();
        }
    });

    it('paints the markdown list from the new backend cache and never shows the old one', async () => {
        app.markdownDirs = ['.'];
        app.sessionsManager.activeCWD = '/w-old';
        // The old backend's list is on screen when the switch starts.
        app.markdownManager._renderFileList([
            { dir: '.', name: 'OLD.md', path: '/w-old/OLD.md' },
        ]);

        const store = backendStores.get('p-a');
        store.activeCwd = '/w-a';
        store.responses.set(
            '/api/version',
            JSON.stringify({ version: '0.12.0', started_at: 'x' }),
        );
        store.responses.set('/api/coders', JSON.stringify([]));
        store.responses.set(
            '/api/config',
            JSON.stringify({ ...CONFIG, active_cwd: '/w-a' }),
        );
        store.responses.set(
            '/api/markdown/files?cwd=%2Fw-a',
            JSON.stringify([
                { dir: '.', name: 'cached-a.md', path: '/w-a/cached-a.md' },
            ]),
        );

        const fetchStub = switchFetch([
            {
                match: '/api/markdown/files',
                delay: 250,
                data: [
                    { dir: '.', name: 'fresh-a.md', path: '/w-a/fresh-a.md' },
                ],
            },
        ]);
        globalThis.fetch = fetchStub;
        global.fetch = fetchStub;
        window.fetch = fetchStub;

        app.diffController.activeTab = 'markdown';
        app.diffController.isPanelOpen = true;

        await app.switchToBackend('p-a', 'http://a:7070');

        const list = document.getElementById('markdown-file-list');
        // The switch itself painted the new backend's cached list — no
        // old files, no Scanning placeholder while refresh is in flight.
        expect(list.textContent).toContain('cached-a.md');
        expect(list.textContent).not.toContain('OLD.md');
        expect(list.textContent).not.toContain('Scanning');

        // The background refresh replaces the cache once it answers.
        await vi.waitFor(
            () => {
                expect(list.textContent).toContain('fresh-a.md');
                expect(list.textContent).not.toContain('cached-a.md');
            },
            { timeout: 5000, interval: 50 },
        );
        const urls = fetchStub.mock.calls.map(([url]) => String(url));
        expect(urls.indexOf('/__phi/active')).toBeLessThan(
            urls.indexOf('/api/markdown/files?cwd=%2Fw-a'),
        );
    });

    it('closes the old backend diff stream socket on every switch', async () => {
        app.diffController.activeTab = 'markdown';
        app.diffController.isPanelOpen = false;
        const stale = { close: vi.fn() };
        app.diffController.currentWs = stale;

        await app.switchToBackend('p-b', 'http://b:7070');

        expect(stale.close).toHaveBeenCalledTimes(1);
        expect(app.diffController.currentWs).toBeNull();
    });

    it('re-renders the cmd panel from the new backend config', async () => {
        app.terminalCommands = [{ name: 'old-cmd', command: 'echo old' }];
        const store = backendStores.get('p-c');
        store.responses.set(
            '/api/config',
            JSON.stringify({
                ...CONFIG,
                terminal_commands: [{ name: 'new-cmd', command: 'echo new' }],
            }),
        );

        const fetchStub = switchFetch();
        globalThis.fetch = fetchStub;
        global.fetch = fetchStub;
        window.fetch = fetchStub;

        app.diffController.activeTab = 'cmd';
        app.diffController.isPanelOpen = true;

        await app.switchToBackend('p-c', 'http://c:7070');

        const cmdEl = document.getElementById('cmd-panel');
        expect(cmdEl.textContent).toContain('new-cmd');
        expect(cmdEl.textContent).not.toContain('old-cmd');
    });

    it('clears sync messages when the new backend has no cached list', () => {
        app.syncManager.renderMessages = vi.fn();

        app.paintBackendFromStore({
            tabs: null,
            activeCwd: '',
            responses: new Map(),
        });

        expect(app.syncManager.renderMessages).toHaveBeenCalledWith([]);
    });

    it('clears the git term and resets the commit selector', async () => {
        const fetchStub = switchFetch();
        globalThis.fetch = fetchStub;
        global.fetch = fetchStub;
        window.fetch = fetchStub;

        app.diffController.activeTab = 'diff';
        app.diffController.isPanelOpen = true;
        const staleOpt = document.createElement('option');
        staleOpt.value = 'deadbeef';
        staleOpt.textContent = 'deadbeef — old backend commit';
        app.diffController.commitSelect.appendChild(staleOpt);

        await app.switchToBackend('p-d', 'http://d:7070');

        // The old backend's output is wiped synchronously with the
        // switch paint, before any refresh lands.
        expect(app.diffController.term.clear).toHaveBeenCalled();
        const options = Array.from(
            app.diffController.commitSelect.options,
            (o) => o.value,
        );
        expect(options).toEqual(['unstaged', 'staged']);
        expect(app.diffController.syncCommitTarget).toBeNull();
    });

    it('drops a late git response from the backend that was switched away from', async () => {
        let resolveStatus;
        const fetchStub = vi.fn(
            () =>
                new Promise((resolve) => {
                    resolveStatus = resolve;
                }),
        );
        globalThis.fetch = fetchStub;
        global.fetch = fetchStub;
        window.fetch = fetchStub;

        app.diffController.activeTab = 'status';
        app.diffController.isPanelOpen = true;
        app.sessionsManager.activeCWD = '/old';
        const oldRefresh = app.diffController.refreshDiff();
        app.diffController.onBackendSwitch();
        resolveStatus({
            ok: true,
            text: async () => 'OLD BACKEND STATUS',
        });
        await oldRefresh;

        expect(
            app.diffController.term.write.mock.calls.flat().join(' '),
        ).not.toContain('OLD BACKEND STATUS');
    });

    it('resets the file tree to the loading splash', async () => {
        const fetchStub = switchFetch();
        globalThis.fetch = fetchStub;
        global.fetch = fetchStub;
        window.fetch = fetchStub;

        app.diffController.activeTab = 'files';
        app.diffController.isPanelOpen = true;
        const tree = document.getElementById('file-tree-list');
        tree.innerHTML = '<div class="ft-dir">old-backend-tree</div>';

        await app.switchToBackend('p-e', 'http://e:7070');

        expect(tree.textContent).toContain('Loading');
        expect(tree.textContent).not.toContain('old-backend-tree');
    });

    it('(a) cold switch to a backend with no workspaces clears activeCWD/activeWorkspace and #git-files', async () => {
        app.sessionsManager.activeCWD = '/w-old';
        app.sessionsManager.activeWorkspace = '/w-old';
        app.sessionsManager.workspaces = ['/w-old'];

        app.diffController.gitManageInfo = { can_stage: true };
        app.diffController.gitFiles = [
            { path: 'leak.txt', index: 'M', worktree: ' ' },
        ];
        app.diffController.renderGitFiles();
        const gitFilesSection = document.getElementById('git-files');
        const gitFileList = document.getElementById('git-file-list');
        expect(gitFilesSection.classList.contains('hidden')).toBe(false);
        expect(gitFileList.children.length).toBe(1);

        const fetchStub = switchFetch([
            {
                match: '/api/config',
                data: { ...CONFIG, workspaces: [], active_cwd: '' },
            },
            { match: '/api/git/worktrees', data: [] },
        ]);
        globalThis.fetch = fetchStub;
        global.fetch = fetchStub;
        window.fetch = fetchStub;

        await app.switchToBackend('p-empty', 'http://empty:7070');

        expect(app.sessionsManager.activeCWD).toBe('');
        expect(app.sessionsManager.activeWorkspace).toBe('');
        expect(app.sessionsManager.workspaces).toEqual([]);
        expect(app.diffController.gitFiles).toEqual([]);
        expect(gitFilesSection.classList.contains('hidden')).toBe(true);
        expect(gitFileList.children.length).toBe(0);
    });

    it('(b) warm switch paints activeCWD from store', () => {
        app.sessionsManager.activeCWD = '/w-old';
        app.sessionsManager.activeWorkspace = '/w-old';

        const store = backendStores.get('p-warm');
        store.activeCwd = '/w-warm/child';
        store.activeWorkspace = '/w-warm';

        app.paintBackendFromStore(store);

        expect(app.sessionsManager.activeCWD).toBe('/w-warm/child');
        expect(app.sessionsManager.activeWorkspace).toBe('/w-warm');

        // When store.activeCwd is empty, falls back to store.activeWorkspace
        const storeFallback = backendStores.get('p-fallback');
        storeFallback.activeCwd = '';
        storeFallback.activeWorkspace = '/w-fallback';

        app.paintBackendFromStore(storeFallback);

        expect(app.sessionsManager.activeCWD).toBe('/w-fallback');
        expect(app.sessionsManager.activeWorkspace).toBe('/w-fallback');
    });

    it('(c) warm-to-live tab transition re-syncs project when tab cwd differs', () => {
        app.sessionsManager.activeWorkspace = '/compB/repo';
        app.sessionsManager.activeCWD = '/compB/repo';
        const refreshDiffSpy = vi
            .spyOn(app.diffController, 'refreshDiff')
            .mockImplementation(() => Promise.resolve());

        const tabPayload = [
            {
                id: 'tab-wt',
                title: 'worktree tab',
                cwd: '/compB/repo-wt2',
                workspace: '/compB/repo',
                coder: 'opencode',
            },
        ];

        // 1. Warm paint from store creates a detached cached tab and pre-selects it
        app.tabManager.syncTabs(tabPayload, { live: false });
        expect(app.tabManager.activePaneId).toBe('tab-wt');
        const tab = app.tabManager.tabs.get('tab-wt');
        expect(tab._detachedCache).toBe(true);

        // Reset activeCWD to simulate loadConfig resetting to workspace root
        app.sessionsManager.activeCWD = '/compB/repo';
        refreshDiffSpy.mockClear();

        // 2. Tab becomes live on restoreTabsState (live: true)
        app.tabManager.syncTabs(tabPayload, { live: true });

        // switchTab should detect transition and cwd mismatch, calling _syncProjectForTab
        expect(app.sessionsManager.activeCWD).toBe('/compB/repo-wt2');
        expect(refreshDiffSpy).toHaveBeenCalled();
    });

    it.each(['diff', 'files', 'markdown'])(
        '(d) onBackendSwitch clears git file list and resets all panel surfaces regardless of activeTab ("%s")',
        (tab) => {
            app.diffController.activeTab = tab;
            app.diffController.gitManageInfo = { can_stage: true };
            app.diffController.gitFiles = [
                { path: 'stale.txt', index: 'M', worktree: ' ' },
            ];
            app.diffController.renderGitFiles();
            const gitFileList = document.getElementById('git-file-list');
            expect(gitFileList.children.length).toBe(1);

            const termClearSpy = vi.spyOn(app.diffController.term, 'clear');
            const fileTreeResetSpy = vi.spyOn(
                app.fileTreeManager,
                'resetForBackendSwitch',
            );
            const markdownPaintSpy = vi.spyOn(
                app.markdownManager,
                'paintFromStore',
            );
            const cmdPanelSpy = vi.spyOn(
                app.diffController,
                'renderCmdPanel',
            );

            app.diffController.onBackendSwitch();

            expect(app.diffController.gitFiles).toEqual([]);
            expect(gitFileList.children.length).toBe(0);
            expect(termClearSpy).toHaveBeenCalled();
            expect(fileTreeResetSpy).toHaveBeenCalled();
            expect(markdownPaintSpy).toHaveBeenCalled();
            expect(cmdPanelSpy).toHaveBeenCalled();
        },
    );

    it('(e) filetree _fetchDir uses app.scope.fetch and expanded is cleared', async () => {
        // 1. Verify expanded is cleared on resetForBackendSwitch
        app.fileTreeManager.expanded.add('src');
        app.fileTreeManager.expanded.add('src/components');
        expect(app.fileTreeManager.expanded.size).toBe(2);

        app.fileTreeManager.resetForBackendSwitch();
        expect(app.fileTreeManager.expanded.size).toBe(0);

        // 2. Verify _fetchDir routes through app.scope.fetch
        const scopeFetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ entries: [] }),
        });
        app.scope = { fetch: scopeFetchSpy, abort: vi.fn() };
        app.sessionsManager.activeCWD = '/test/dir';

        await app.fileTreeManager._fetchDir('subdir');

        expect(scopeFetchSpy).toHaveBeenCalledTimes(1);
        expect(scopeFetchSpy.mock.calls[0][0]).toBe(
            '/api/fs/list?cwd=%2Ftest%2Fdir&path=subdir',
        );
    });

    it('(f) no /api/git/* or /api/fs/list request carries the old backend cwd after switch', async () => {
        app.sessionsManager.activeCWD = '/compA/repo';
        app.sessionsManager.activeWorkspace = '/compA/repo';
        app.diffController.activeTab = 'diff';
        app.diffController.isPanelOpen = true;

        const requestedUrls = [];
        const fetchStub = vi.fn((url) => {
            const u = String(url);
            requestedUrls.push(u);
            if (u === '/__phi/active') {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: { get: () => 'application/json' },
                    json: async () => ({ ok: true }),
                    text: async () => '{}',
                });
            }
            if (u.startsWith('/api/config')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: { get: () => 'application/json' },
                    json: async () => ({
                        ...CONFIG,
                        workspaces: ['/compB/repo'],
                        active_cwd: '/compB/repo',
                    }),
                    text: async () =>
                        JSON.stringify({
                            ...CONFIG,
                            workspaces: ['/compB/repo'],
                            active_cwd: '/compB/repo',
                        }),
                });
            }
            if (u.startsWith('/api/git/worktrees')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: { get: () => 'application/json' },
                    json: async () => [
                        { path: '/compB/repo', branch: 'main', active: true },
                    ],
                    text: async () =>
                        JSON.stringify([
                            {
                                path: '/compB/repo',
                                branch: 'main',
                                active: true,
                            },
                        ]),
                });
            }
            if (u.startsWith('/api/terminals')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    headers: { get: () => 'application/json' },
                    json: async () => [],
                    text: async () => '[]',
                });
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                headers: { get: () => 'application/json' },
                json: async () => ({}),
                text: async () => '{}',
            });
        });
        globalThis.fetch = fetchStub;
        global.fetch = fetchStub;
        window.fetch = fetchStub;

        await app.switchToBackend('p-b', 'http://b:7070');

        // Also exercise the filetree refresh on the new backend
        app.diffController.activeTab = 'files';
        await app.fileTreeManager.refresh();

        const gitAndFsUrls = requestedUrls.filter(
            (u) => u.startsWith('/api/git/') || u.startsWith('/api/fs/list'),
        );
        expect(gitAndFsUrls.length).toBeGreaterThan(0);
        for (const u of gitAndFsUrls) {
            expect(u).not.toContain('/compA/repo');
            expect(u).not.toContain(encodeURIComponent('/compA/repo'));
        }
    });
});
