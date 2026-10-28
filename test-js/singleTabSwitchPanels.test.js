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
    vi.stubGlobal('Unicode11Addon', { Unicode11: class {} });
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
    let app;

    beforeEach(async () => {
        setupVendorStubs();
        const fetchStub = switchFetch();
        vi.stubGlobal('fetch', fetchStub);
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
        app = new App();
        app.initOnce();
    });

    afterEach(() => {
        setEmbeddedBackend('', '');
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
        await new Promise((r) => setTimeout(r, 450));
        expect(list.textContent).toContain('fresh-a.md');
        expect(list.textContent).not.toContain('cached-a.md');
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
});
