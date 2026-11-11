// @vitest-environment jsdom
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

function mockApiFetch(routes = []) {
    return vi.fn((url, opts) => {
        const u = String(url);
        const hit = routes.find((r) => u.startsWith(r.match));
        if (hit) {
            const data =
                typeof hit.data === 'function' ? hit.data(u, opts) : hit.data;
            return Promise.resolve({
                ok: true,
                status: 200,
                headers: { get: () => 'application/json' },
                json: async () => data,
                text: async () => JSON.stringify(data),
            });
        }
        return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => [],
            text: async () => '[]',
        });
    });
}

describe('worktree auto-selection on tab switch', () => {
    let app;

    beforeEach(async () => {
        setupVendorStubs();
        const fetchStub = mockApiFetch([
            {
                match: '/api/git/worktrees',
                data: (url) => {
                    if (url.includes('repo2')) {
                        return [
                            {
                                path: '/work/repo2',
                                branch: 'main',
                                active: true,
                            },
                            {
                                path: '/work/repo2-wt',
                                branch: 'feat2',
                                active: false,
                            },
                        ];
                    }
                    return [
                        { path: '/work/repo1', branch: 'main', active: true },
                        {
                            path: '/work/repo1-wt',
                            branch: 'feat1',
                            active: false,
                        },
                    ];
                },
            },
            {
                match: '/api/config',
                data: {
                    workspaces: ['/work/repo1', '/work/repo2'],
                    active_cwd: '/work/repo1',
                },
            },
        ]);
        vi.stubGlobal('fetch', fetchStub);
        globalThis.fetch = fetchStub;
        global.fetch = fetchStub;
        window.fetch = fetchStub;
        await loadCoderRegistry(true);
        stubWebSocket();
        document.body.innerHTML = indexHtml;
        window.history.replaceState(null, '', '/');
        localStorage.setItem('phi_diff_panel_open', 'false');
    });

    afterEach(() => {
        setEmbeddedBackend('', '');
        backendStores.clear();
        if (typeof app?.scope?.abort === 'function') {
            app.scope.abort('test teardown');
        }
    });

    it('normal mode: switching tabs across different worktrees auto-picks the worktree', async () => {
        setEmbeddedBackend('', '');
        app = new App();
        app.sessionsManager.workspaces = ['/work/repo1'];
        app.sessionsManager.activeWorkspace = '/work/repo1';
        app.sessionsManager.activeCWD = '/work/repo1';

        // Render worktrees in DOM
        app.sessionsManager.renderWorktreesList(
            [
                { path: '/work/repo1', branch: 'main', active: true },
                { path: '/work/repo1-wt', branch: 'feat1', active: false },
            ],
            '/work/repo1',
            '/work/repo1',
        );

        const secMain = document.querySelector(
            '.worktree-section[data-worktree-path="/work/repo1"]',
        );
        const secWt = document.querySelector(
            '.worktree-section[data-worktree-path="/work/repo1-wt"]',
        );
        expect(secMain.classList.contains('active')).toBe(true);
        expect(secWt.classList.contains('active')).toBe(false);

        // Create two tabs
        app.tabManager.createTab(
            't1',
            's1',
            'Tab 1',
            'shell',
            '/work/repo1',
            '/work/repo1',
        );
        app.tabManager.createTab(
            't2',
            's2',
            'Tab 2',
            'shell',
            '/work/repo1',
            '/work/repo1-wt',
        );
        await new Promise((r) => setTimeout(r, 20));

        app.tabManager.switchTab('t1');
        await new Promise((r) => setTimeout(r, 20));

        const secMainAfter1 = document.querySelector(
            '.worktree-section[data-worktree-path="/work/repo1"]',
        );
        const secWtAfter1 = document.querySelector(
            '.worktree-section[data-worktree-path="/work/repo1-wt"]',
        );
        expect(secMainAfter1?.classList?.contains('active')).toBe(true);
        expect(secWtAfter1?.classList?.contains('active')).toBe(false);

        // Switch to tab 2
        app.tabManager.switchTab('t2', { userInitiated: true });
        await new Promise((r) => setTimeout(r, 20));

        const secMainAfter2 = document.querySelector(
            '.worktree-section[data-worktree-path="/work/repo1"]',
        );
        const secWtAfter2 = document.querySelector(
            '.worktree-section[data-worktree-path="/work/repo1-wt"]',
        );
        expect(app.sessionsManager.activeCWD).toBe('/work/repo1-wt');
        expect(secWtAfter2?.classList?.contains('active')).toBe(true);
        expect(secMainAfter2?.classList?.contains('active')).toBe(false);
    });

    it('low-memory mode (detachedCache): switching tabs across different worktrees in same workspace auto-picks the worktree', async () => {
        setEmbeddedBackend('prof-lowmem', 'http://lowmem:7070');
        window.history.replaceState(
            null,
            '',
            '?desktop=1&embedded=1&profile=prof-lowmem&origin=http%3A%2F%2Flowmem%3A7070',
        );
        app = new App();
        app.sessionsManager.workspaces = ['/work/repo1'];
        app.sessionsManager.activeWorkspace = '/work/repo1';
        app.sessionsManager.activeCWD = '/work/repo1';

        // Render worktrees for repo1
        app.sessionsManager.renderWorktreesList(
            [
                { path: '/work/repo1', branch: 'main', active: true },
                { path: '/work/repo1-wt', branch: 'feat1', active: false },
            ],
            '/work/repo1',
            '/work/repo1',
        );

        const secMain = document.querySelector(
            '.worktree-section[data-worktree-path="/work/repo1"]',
        );
        const secWt = document.querySelector(
            '.worktree-section[data-worktree-path="/work/repo1-wt"]',
        );
        expect(secMain?.classList.contains('active')).toBe(true);

        const tabPayload = [
            {
                id: 't1',
                session_id: 's1',
                title: 'Tab 1',
                coder: 'shell',
                workspace: '/work/repo1',
                cwd: '/work/repo1',
            },
            {
                id: 't2',
                session_id: 's2',
                title: 'Tab 2',
                coder: 'shell',
                workspace: '/work/repo1',
                cwd: '/work/repo1-wt',
            },
        ];
        app.tabManager.syncTabs(tabPayload, { live: false });
        expect(app.tabManager.tabs.get('t2')._detachedCache).toBe(true);

        // Switch to tab 2
        app.tabManager.switchTab('t2', { userInitiated: true });
        await new Promise((r) => setTimeout(r, 20));

        expect(app.sessionsManager.activeCWD).toBe('/work/repo1-wt');
        expect(secWt?.classList.contains('active')).toBe(true);
        expect(secMain?.classList.contains('active')).toBe(false);
    });

    it('switching to a tab with no worktree clears the active worktree selection', async () => {
        setEmbeddedBackend('', '');
        app = new App();
        app.sessionsManager.workspaces = ['/work/repo1'];
        app.sessionsManager.activeWorkspace = '/work/repo1';
        app.sessionsManager.activeCWD = '/work/repo1';

        app.sessionsManager.renderWorktreesList(
            [
                { path: '/work/repo1', branch: 'main', active: true },
                { path: '/work/repo1-wt', branch: 'feat1', active: false },
            ],
            '/work/repo1',
            '/work/repo1',
        );

        app.tabManager.createTab(
            't1',
            's1',
            'Tab 1',
            'shell',
            '/work/repo1',
            '/work/repo1-wt',
        );
        app.tabManager.createTab(
            't2',
            's2',
            'Tab 2 (no wt)',
            'shell',
            '/work/repo1',
            '',
        );
        const tab2 = app.tabManager.tabs.get('t2');
        tab2.cwd = '';
        await new Promise((r) => setTimeout(r, 20));

        app.tabManager.switchTab('t1');
        await new Promise((r) => setTimeout(r, 20));

        const secWt = document.querySelector(
            '.worktree-section[data-worktree-path="/work/repo1-wt"]',
        );
        expect(secWt?.classList.contains('active')).toBe(true);

        // Switch to tab 2 with no cwd / no worktree
        app.tabManager.switchTab('t2', { userInitiated: true });
        await new Promise((r) => setTimeout(r, 20));

        // activeCWD should be empty and secWt should no longer be active
        expect(app.sessionsManager.activeCWD).toBe('');
        expect(secWt?.classList.contains('active')).toBe(false);
    });

    it('rapid switching: fast consecutive tab switches converge on the final active tab worktree', async () => {
        setEmbeddedBackend('', '');
        app = new App();
        app.sessionsManager.workspaces = ['/work/repo1', '/work/repo2'];
        app.sessionsManager.activeWorkspace = '/work/repo1';
        app.sessionsManager.activeCWD = '/work/repo1';

        app.tabManager.createTab(
            't1',
            's1',
            'Tab 1',
            'shell',
            '/work/repo1',
            '/work/repo1',
        );
        app.tabManager.createTab(
            't2',
            's2',
            'Tab 2',
            'shell',
            '/work/repo1',
            '/work/repo1-wt',
        );
        app.tabManager.createTab(
            't3',
            's3',
            'Tab 3',
            'shell',
            '/work/repo2',
            '/work/repo2-wt',
        );
        await new Promise((r) => setTimeout(r, 20));

        // Rapidly switch t1 -> t2 -> t3 without waiting
        app.tabManager.switchTab('t1', { userInitiated: true });
        app.tabManager.switchTab('t2', { userInitiated: true });
        app.tabManager.switchTab('t3', { userInitiated: true });
        await new Promise((r) => setTimeout(r, 50));

        expect(app.tabManager.activePaneId).toBe('t3');
        expect(app.sessionsManager.activeWorkspace).toBe('/work/repo2');
        expect(app.sessionsManager.activeCWD).toBe('/work/repo2-wt');
        const secWt3 = document.querySelector(
            '.worktree-section[data-worktree-path="/work/repo2-wt"]',
        );
        expect(secWt3).not.toBeNull();
        expect(secWt3?.classList.contains('active')).toBe(true);
    });

    it('low-memory mode (detachedCache): switching tabs across different coders auto-picks the worktree for the newly active tab', async () => {
        setEmbeddedBackend('prof-lowmem', 'http://lowmem:7070');
        window.history.replaceState(
            null,
            '',
            '?desktop=1&embedded=1&profile=prof-lowmem&origin=http%3A%2F%2Flowmem%3A7070',
        );
        app = new App();
        app.sessionsManager.workspaces = ['/work/repo1'];
        app.sessionsManager.activeWorkspace = '/work/repo1';
        app.sessionsManager.activeCoder = 'shell';
        app.sessionsManager.activeCWD = '/work/repo1';

        // Render worktrees for repo1
        app.sessionsManager.renderWorktreesList(
            [
                { path: '/work/repo1', branch: 'main', active: true },
                { path: '/work/repo1-wt', branch: 'feat1', active: false },
            ],
            '/work/repo1',
            '/work/repo1',
        );

        const tabPayload = [
            {
                id: 't1',
                session_id: 's1',
                title: 'Tab 1',
                coder: 'shell',
                workspace: '/work/repo1',
                cwd: '/work/repo1',
            },
            {
                id: 't2',
                session_id: 's2',
                title: 'Tab 2',
                coder: 'claude',
                workspace: '/work/repo1',
                cwd: '/work/repo1-wt',
            },
        ];
        app.tabManager.syncTabs(tabPayload, { live: false });
        expect(app.tabManager.tabs.get('t2')._detachedCache).toBe(true);

        // Switch to tab 2 with different coder
        app.tabManager.switchTab('t2', { userInitiated: true });
        await new Promise((r) => setTimeout(r, 20));

        expect(app.sessionsManager.activeCoder).toBe('claude');
        expect(app.sessionsManager.activeCWD).toBe('/work/repo1-wt');
        const secWt = document.querySelector(
            '.worktree-section[data-worktree-path="/work/repo1-wt"]',
        );
        expect(secWt?.classList?.contains('active')).toBe(true);
    });

    it('low-memory mode (detachedCache): switching tabs across different workspaces auto-picks the worktree for the newly active tab', async () => {
        setEmbeddedBackend('prof-lowmem', 'http://lowmem:7070');
        window.history.replaceState(
            null,
            '',
            '?desktop=1&embedded=1&profile=prof-lowmem&origin=http%3A%2F%2Flowmem%3A7070',
        );
        app = new App();
        app.sessionsManager.workspaces = ['/work/repo1', '/work/repo2'];
        app.sessionsManager.activeWorkspace = '/work/repo1';
        app.sessionsManager.activeCWD = '/work/repo1';

        // Render worktree for repo1
        app.sessionsManager.renderWorktreesList(
            [
                { path: '/work/repo1', branch: 'main', active: true },
                { path: '/work/repo1-wt', branch: 'feat1', active: false },
            ],
            '/work/repo1',
            '/work/repo1',
        );

        // Warm paint tabs in detached state
        const tabPayload = [
            {
                id: 't1',
                session_id: 's1',
                title: 'Tab 1',
                coder: 'shell',
                workspace: '/work/repo1',
                cwd: '/work/repo1',
            },
            {
                id: 't2',
                session_id: 's2',
                title: 'Tab 2',
                coder: 'shell',
                workspace: '/work/repo2',
                cwd: '/work/repo2-wt',
            },
        ];
        app.tabManager.syncTabs(tabPayload, { live: false });
        expect(app.tabManager.tabs.get('t2')._detachedCache).toBe(true);

        // Switch to tab 2
        app.tabManager.switchTab('t2', { userInitiated: true });
        await new Promise((r) => setTimeout(r, 30));

        // In low-memory mode, switching to tab 2 should pick repo2 and repo2-wt
        expect(app.sessionsManager.activeWorkspace).toBe('/work/repo2');
        expect(app.sessionsManager.activeCWD).toBe('/work/repo2-wt');

        // And worktree for repo2-wt should be rendered / active
        const secWt2 = document.querySelector(
            '.worktree-section[data-worktree-path="/work/repo2-wt"]',
        );
        expect(secWt2).not.toBeNull();
        expect(secWt2?.classList?.contains('active')).toBe(true);
    });
});
