// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { FileTreeManager } from '../web/filetree.js';

// Files tab: lazy directory tree with per-coder @path insertion. Mirrors
// the fetch-staleness-guard / context-menu patterns already covered for
// MarkdownManager in mdChangedRefresh.test.js and markdownIcons.test.js.

setupDomHarness();

function makeApp({ coder = 'claude', markdownManager } = {}) {
    return {
        sessionsManager: { activeCWD: '/ws' },
        tabManager: { getActiveTab: () => ({ coder }), adjustInputHeight() {} },
        diffController: { isPanelOpen: true, activeTab: 'files' },
        showToast() {},
        // Left-click preview target; tests pass a vi.fn() to spy on it.
        markdownManager: markdownManager ?? { previewFile() {} },
    };
}

function makeManager(app) {
    document.body.innerHTML = `
        <div id="file-tree-list"></div>
        <textarea id="input-textarea"></textarea>
    `;
    return new FileTreeManager(app);
}

// installFetch keys canned responses by whether the requested URL's `path`
// query param matches. `fixtures` maps rel path ('' for root) -> response body.
function installFetch(fixtures) {
    const fn = vi.fn(async (url) => {
        const u = new URL(String(url), 'http://localhost');
        const rel = u.searchParams.get('path') || '';
        const body = fixtures[rel];
        if (body === undefined) {
            throw new Error(`no fixture for path=${rel}`);
        }
        return { ok: true, json: async () => body };
    });
    vi.stubGlobal('fetch', fn);
    return fn;
}

describe('FileTreeManager', () => {
    it('renders root entries, dirs first with collapsed chevron', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [
                    { name: 'src', dir: true },
                    { name: 'main.go', dir: false },
                ],
            },
        });
        const manager = makeManager(makeApp());
        await manager.refresh();

        const rows = manager.treeEl.querySelectorAll('.md-file-row');
        expect(rows.length).toBe(2);
        const firstItem = rows[0].querySelector('.md-file-item');
        expect(firstItem.querySelector('.md-file-name').textContent).toBe(
            'src',
        );
        expect(firstItem.querySelector('.ft-chevron').textContent).toBe('▸');
    });

    it('clicking a file row previews it and never touches the input', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        const md = { previewFile: vi.fn() };
        const manager = makeManager(makeApp({ markdownManager: md }));
        await manager.refresh();

        const fileItem = manager.treeEl.querySelector('.md-file-item');
        fileItem.click();
        await Promise.resolve();

        expect(md.previewFile).toHaveBeenCalledTimes(1);
        expect(md.previewFile).toHaveBeenCalledWith(
            { path: 'main.go', name: 'main.go' },
            '/ws',
        );
        const textarea = document.getElementById('input-textarea');
        expect(textarea.value).toBe('');
    });

    it('click-to-preview is coder-independent: no @path for bash either', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        const md = { previewFile: vi.fn() };
        const manager = makeManager(
            makeApp({ coder: 'bash', markdownManager: md }),
        );
        await manager.refresh();

        const fileItem = manager.treeEl.querySelector('.md-file-item');
        fileItem.click();
        await Promise.resolve();

        expect(md.previewFile).toHaveBeenCalledTimes(1);
        const textarea = document.getElementById('input-textarea');
        expect(textarea.value).toBe('');
    });

    it('clicking a dir row expands it in place: fetches only that dir, existing rows keep their identity', async () => {
        const fetchMock = installFetch({
            '': {
                truncated: false,
                entries: [
                    { name: 'src', dir: true },
                    { name: 'other.go', dir: false },
                ],
            },
            src: {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        const manager = makeManager(makeApp());
        await manager.refresh();

        const dirItem = manager.treeEl.querySelector('.md-file-item');
        const dirRow = dirItem.closest('.md-file-row');
        const siblingRow = manager.treeEl.querySelectorAll('.md-file-row')[1];
        fetchMock.mockClear();
        dirItem.click();

        // Only the clicked directory is fetched — no root refetch, no
        // Loading splash, no panel rebuild.
        await vi.waitFor(() => {
            expect(manager.treeEl.querySelectorAll('.md-file-row').length).toBe(
                3,
            );
        });
        const urls = fetchMock.mock.calls.map((c) => String(c[0]));
        expect(urls).toHaveLength(1);
        expect(urls[0]).toContain('path=src');
        expect(manager.treeEl.querySelector('.md-list-loading')).toBeNull();
        // In-place surgery: the clicked folder row and its sibling keep
        // their DOM identity (a rebuild would have replaced every node).
        expect(dirRow.isConnected).toBe(true);
        expect(manager.treeEl.querySelectorAll('.md-file-row')[0]).toBe(dirRow);
        expect(manager.treeEl.querySelectorAll('.md-file-row')[2]).toBe(
            siblingRow,
        );
        const rows = manager.treeEl.querySelectorAll('.md-file-row');
        expect(rows[0].querySelector('.ft-chevron').textContent).toBe('▾');
        const rootPad = parseInt(
            rows[0].querySelector('.md-file-item').style.paddingLeft,
            10,
        );
        const childPad = parseInt(
            rows[1].querySelector('.md-file-item').style.paddingLeft,
            10,
        );
        expect(childPad).toBeGreaterThan(rootPad);
        // Children are inserted between the folder and its sibling.
        expect(rows[1].dataset.rel).toBe('src/main.go');
        expect(rows[2].dataset.rel).toBe('other.go');
    });

    it('collapsing a dir row removes only its descendants, with no fetch at all', async () => {
        const fetchMock = installFetch({
            '': {
                truncated: false,
                entries: [
                    { name: 'src', dir: true },
                    { name: 'main.go', dir: false },
                ],
            },
            src: {
                truncated: false,
                entries: [
                    { name: 'deep', dir: true },
                    { name: 'a.go', dir: false },
                ],
            },
            'src/deep': {
                truncated: false,
                entries: [{ name: 'b.go', dir: false }],
            },
        });
        const manager = makeManager(makeApp());
        await manager.refresh();

        // Expand src, then its nested dir: src/deep/b.go at depth 2.
        manager.treeEl
            .querySelector('.md-file-row[data-rel="src"] .md-file-item')
            .click();
        await vi.waitFor(() =>
            expect(manager.treeEl.querySelectorAll('.md-file-row').length).toBe(
                4,
            ),
        );
        manager.treeEl
            .querySelector('.md-file-row[data-rel="src/deep"] .md-file-item')
            .click();
        await vi.waitFor(() =>
            expect(manager.treeEl.querySelectorAll('.md-file-row').length).toBe(
                5,
            ),
        );

        fetchMock.mockClear();
        // Collapse src: its whole subtree (deep + b.go) disappears in one
        // DOM pass. Nothing is refetched — the old behavior rebuilt the
        // entire panel from a Loading splash on every collapse.
        manager.treeEl
            .querySelector('.md-file-row[data-rel="src"] .md-file-item')
            .click();
        await vi.waitFor(() =>
            expect(manager.treeEl.querySelectorAll('.md-file-row').length).toBe(
                2,
            ),
        );
        expect(fetchMock).not.toHaveBeenCalled();
        const rows = manager.treeEl.querySelectorAll('.md-file-row');
        expect(rows[0].querySelector('.ft-chevron').textContent).toBe('▸');
        expect(rows[1].dataset.rel).toBe('main.go');

        // Re-expanding src re-fetches it and re-expands the remembered
        // src/deep child in place.
        manager.treeEl
            .querySelector('.md-file-row[data-rel="src"] .md-file-item')
            .click();
        await vi.waitFor(() =>
            expect(manager.treeEl.querySelectorAll('.md-file-row').length).toBe(
                5,
            ),
        );
        const urls = fetchMock.mock.calls.map((c) => String(c[0]));
        expect(
            urls.some((u) => u.includes('path=src&') || u.endsWith('path=src')),
        ).toBe(true);
        expect(
            urls.some(
                (u) =>
                    u.includes('path=src%2Fdeep') ||
                    u.includes('path=src/deep'),
            ),
        ).toBe(true);
    });

    it('refresh() over existing content swaps in place instead of flashing Loading', async () => {
        const fetchMock = installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        const manager = makeManager(makeApp());
        await manager.refresh();
        const row = manager.treeEl.querySelector('.md-file-row');

        // A second refresh (tab re-entry, cwd change) keeps the old tree
        // visible while refetching; the splash only belongs to the empty
        // first load.
        let resolveSecond;
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                await new Promise((r) => {
                    resolveSecond = r;
                });
                return {
                    ok: true,
                    json: async () => ({
                        truncated: false,
                        entries: [{ name: 'renamed.go', dir: false }],
                    }),
                };
            }),
        );
        const second = manager.refresh();
        await Promise.resolve();
        expect(manager.treeEl.querySelector('.md-list-loading')).toBeNull();
        expect(manager.treeEl.querySelector('.md-file-row')).toBe(row);
        resolveSecond();
        await second;
        expect(manager.treeEl.querySelector('.md-file-name').textContent).toBe(
            'renamed.go',
        );
    });

    it('the ⋯ button opens a context menu with Insert + Preview + Open in Explorer for files (Insert closes)', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        const manager = makeManager(makeApp());
        await manager.refresh();

        const actionBtn = manager.treeEl.querySelector('.md-file-action-btn');
        actionBtn.click();

        const menu = document.querySelector('.ft-context-menu');
        expect(menu.classList.contains('hidden')).toBe(false);
        const actions = menu.querySelectorAll('.md-context-action');
        // 4 actions: Insert @path, Preview, Open in Explorer, Open in
        // VS Code (local; the remote action is suppressed because the
        // test app has no hostname).
        expect(actions.length).toBe(4);
        expect(actions[0].classList.contains('insert-path')).toBe(true);
        expect(actions[0].textContent).toContain('Insert @path');
        expect(actions[1].classList.contains('preview')).toBe(true);
        expect(actions[1].textContent).toContain('Preview');
        expect(actions[2].classList.contains('open-explorer')).toBe(true);
        expect(actions[2].textContent).toContain('Open in Explorer');
        expect(actions[3].classList.contains('open-vscode-local')).toBe(true);
        expect(actions[3].textContent).toContain('Open in VS Code');

        actions[0].click();
        await Promise.resolve();

        const textarea = document.getElementById('input-textarea');
        expect(textarea.value).toBe('@main.go');
        expect(menu.classList.contains('hidden')).toBe(true);
    });

    it('right-click on a file row opens the context menu with Open in Explorer below Preview', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        const manager = makeManager(makeApp());
        await manager.refresh();

        const item = manager.treeEl.querySelector('.md-file-item');
        const ev = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
        });
        item.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);

        const menu = document.querySelector('.ft-context-menu');
        expect(menu.classList.contains('hidden')).toBe(false);
        const actions = menu.querySelectorAll('.md-context-action');
        expect(actions.length).toBe(4);
        expect(actions[1].textContent).toContain('Preview');
        expect(actions[2].textContent).toContain('Open in Explorer');
        expect(actions[3].textContent).toContain('Open in VS Code');
    });

    it('clicking Open in Explorer records a folder action on window.__phiFileAction', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        const manager = makeManager(makeApp());
        await manager.refresh();

        delete window.__phiFileAction;
        const actionBtn = manager.treeEl.querySelector('.md-file-action-btn');
        actionBtn.click();

        const menu = document.querySelector('.ft-context-menu');
        const openExplorerBtn = menu.querySelector(
            '.md-context-action.open-explorer',
        );
        openExplorerBtn.click();
        await Promise.resolve();

        expect(window.__phiFileAction).toEqual({
            kind: 'folder',
            rel: 'main.go',
            cwd: '/ws',
        });
        expect(menu.classList.contains('hidden')).toBe(true);
    });

    it('context menu for a directory row includes Insert @path and Open in Explorer', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'src', dir: true }],
            },
        });
        const manager = makeManager(makeApp());
        await manager.refresh();

        const actionBtn = manager.treeEl.querySelector('.md-file-action-btn');
        actionBtn.click();

        const menu = document.querySelector('.ft-context-menu');
        expect(menu.classList.contains('hidden')).toBe(false);
        const actions = menu.querySelectorAll('.md-context-action');
        // 3 actions: Insert @path, Open in Explorer, Open in VS Code
        // (local). No remote action (no hostname); no Preview (file-
        // only).
        expect(actions.length).toBe(3);
        expect(actions[0].textContent).toContain('Insert @path');
        expect(actions[1].textContent).toContain('Open in Explorer');
        expect(actions[2].textContent).toContain('Open in VS Code');
    });

    it('renders a truncated note when the response is marked truncated', async () => {
        installFetch({
            '': { truncated: true, entries: [{ name: 'a.txt', dir: false }] },
        });
        const manager = makeManager(makeApp());
        await manager.refresh();

        expect(manager.treeEl.textContent).toContain('… list truncated');
    });
});

// ---------------------------------------------------------------------------
// Plan 1 + Plan 2: VS Code launch wiring on the Files tab. Pure mock tests:
// we never trigger the actual navigation (window.location.href would tear
// down the jsdom harness) — instead we assert href/tooltip targets and
// that the editor clicks never open the Phi preview, expand folders, or
// insert text into the prompt.
// ---------------------------------------------------------------------------

function makeVSCodeApp({ cwd = '/ws', hostname = '' } = {}) {
    return {
        sessionsManager: { activeCWD: cwd, activeWorkspace: cwd },
        tabManager: {
            getActiveTab: () => ({ coder: 'claude' }),
            adjustInputHeight() {},
        },
        diffController: { isPanelOpen: true, activeTab: 'files' },
        showToast() {},
        markdownManager: { previewFile() {} },
        hostname,
    };
}

describe('FileTreeManager — VS Code launch actions', () => {
    it('renders a local VS Code project button above the tree targeting the active cwd', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        document.body.innerHTML = `
            <div id="file-tree-list"></div>
            <textarea id="input-textarea"></textarea>
            <div id="file-tree-toolbar" class="file-tree-toolbar hidden">
                <a id="ft-vscode-local-btn" class="ft-vscode-btn ft-vscode-local-btn" href="#"></a>
                <a id="ft-vscode-remote-btn" class="ft-vscode-btn ft-vscode-remote-btn" href="#"></a>
            </div>
        `;
        const manager = new FileTreeManager(
            makeVSCodeApp({ cwd: '/Users/alex/code/phi' }),
        );
        await manager.refresh();

        const btn = document.getElementById('ft-vscode-local-btn');
        expect(btn.getAttribute('aria-disabled')).toBeNull();
        expect(btn.getAttribute('href')).toBe(
            'vscode://file/Users/alex/code/phi',
        );
        expect(btn.title).toContain('/Users/alex/code/phi');
    });

    it('disables the project buttons when there is no active cwd', async () => {
        installFetch({
            '': { truncated: false, entries: [] },
        });
        document.body.innerHTML = `
            <div id="file-tree-list"></div>
            <textarea id="input-textarea"></textarea>
            <div id="file-tree-toolbar" class="file-tree-toolbar hidden">
                <a id="ft-vscode-local-btn" class="ft-vscode-btn ft-vscode-local-btn" href="#"></a>
                <a id="ft-vscode-remote-btn" class="ft-vscode-btn ft-vscode-remote-btn" href="#"></a>
            </div>
        `;
        const manager = new FileTreeManager(makeVSCodeApp({ cwd: '' }));
        await manager.refresh();

        const local = document.getElementById('ft-vscode-local-btn');
        const remote = document.getElementById('ft-vscode-remote-btn');
        expect(local.getAttribute('aria-disabled')).toBe('true');
        expect(remote.getAttribute('aria-disabled')).toBe('true');
        expect(local.getAttribute('href')).toBeNull();
        expect(remote.getAttribute('href')).toBeNull();
    });

    it('disables only the remote project button when hostname is invalid', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        document.body.innerHTML = `
            <div id="file-tree-list"></div>
            <textarea id="input-textarea"></textarea>
            <div id="file-tree-toolbar" class="file-tree-toolbar hidden">
                <a id="ft-vscode-local-btn" class="ft-vscode-btn ft-vscode-local-btn" href="#"></a>
                <a id="ft-vscode-remote-btn" class="ft-vscode-btn ft-vscode-remote-btn" href="#"></a>
            </div>
        `;
        const manager = new FileTreeManager(
            makeVSCodeApp({ hostname: 'bad host name' }),
        );
        await manager.refresh();

        const local = document.getElementById('ft-vscode-local-btn');
        const remote = document.getElementById('ft-vscode-remote-btn');
        expect(local.getAttribute('href')).toBe('vscode://file/ws');
        expect(remote.getAttribute('aria-disabled')).toBe('true');
    });

    it('enables the remote project button with the reported hostname as SSH target', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        document.body.innerHTML = `
            <div id="file-tree-list"></div>
            <textarea id="input-textarea"></textarea>
            <div id="file-tree-toolbar" class="file-tree-toolbar hidden">
                <a id="ft-vscode-local-btn" class="ft-vscode-btn ft-vscode-local-btn" href="#"></a>
                <a id="ft-vscode-remote-btn" class="ft-vscode-btn ft-vscode-remote-btn" href="#"></a>
            </div>
        `;
        const manager = new FileTreeManager(
            makeVSCodeApp({
                cwd: '/Users/alex/code/phi',
                hostname: 'JUPITER', // upper-case -> normalized to jupiter
            }),
        );
        await manager.refresh();

        const remote = document.getElementById('ft-vscode-remote-btn');
        expect(remote.getAttribute('href')).toBe(
            'vscode://vscode-remote/ssh-remote+jupiter/Users/alex/code/phi',
        );
        expect(remote.title).toContain('jupiter');
    });

    it('renders per-row local + remote anchors with the row’s relative path', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        document.body.innerHTML = `
            <div id="file-tree-list"></div>
            <textarea id="input-textarea"></textarea>
            <div id="file-tree-toolbar" class="file-tree-toolbar hidden">
                <a id="ft-vscode-local-btn" class="ft-vscode-btn ft-vscode-local-btn" href="#"></a>
                <a id="ft-vscode-remote-btn" class="ft-vscode-btn ft-vscode-remote-btn" href="#"></a>
            </div>
        `;
        const manager = new FileTreeManager(
            makeVSCodeApp({
                cwd: '/Users/alex/code/phi',
                hostname: 'jupiter',
            }),
        );
        await manager.refresh();

        const localBtn = manager.treeEl.querySelector(
            '.ft-vscode-row-local-btn',
        );
        const remoteBtn = manager.treeEl.querySelector(
            '.ft-vscode-row-remote-btn',
        );
        expect(localBtn).not.toBeNull();
        expect(remoteBtn).not.toBeNull();
        expect(localBtn.getAttribute('href')).toBe(
            'vscode://file/Users/alex/code/phi/main.go',
        );
        expect(remoteBtn.getAttribute('href')).toBe(
            'vscode://vscode-remote/ssh-remote+jupiter/Users/alex/code/phi/main.go:1:1',
        );
    });

    it('directory rows use folder-kind remote URIs (no :1:1 suffix)', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'src', dir: true }],
            },
        });
        document.body.innerHTML = `
            <div id="file-tree-list"></div>
            <textarea id="input-textarea"></textarea>
            <div id="file-tree-toolbar" class="file-tree-toolbar hidden">
                <a id="ft-vscode-local-btn" class="ft-vscode-btn ft-vscode-local-btn" href="#"></a>
                <a id="ft-vscode-remote-btn" class="ft-vscode-btn ft-vscode-remote-btn" href="#"></a>
            </div>
        `;
        const manager = new FileTreeManager(
            makeVSCodeApp({
                cwd: '/Users/alex/code/phi',
                hostname: 'jupiter',
            }),
        );
        await manager.refresh();

        const remoteBtn = manager.treeEl.querySelector(
            '.ft-vscode-row-remote-btn',
        );
        expect(remoteBtn.getAttribute('href')).toBe(
            'vscode://vscode-remote/ssh-remote+jupiter/Users/alex/code/phi/src',
        );
        // Folder URIs never have the line suffix.
        expect(remoteBtn.getAttribute('href')).not.toContain(':1:1');
    });

    it('clicking a row VS Code link does NOT open the Phi preview or insert @path', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        const md = { previewFile: vi.fn() };
        document.body.innerHTML = `
            <div id="file-tree-list"></div>
            <textarea id="input-textarea"></textarea>
            <div id="file-tree-toolbar" class="file-tree-toolbar hidden">
                <a id="ft-vscode-local-btn" class="ft-vscode-btn ft-vscode-local-btn" href="#"></a>
                <a id="ft-vscode-remote-btn" class="ft-vscode-btn ft-vscode-remote-btn" href="#"></a>
            </div>
        `;
        const manager = new FileTreeManager({
            ...makeVSCodeApp({ cwd: '/ws', hostname: 'jupiter' }),
            markdownManager: md,
        });
        await manager.refresh();

        // Spy on navigation by stubbing window.location; jsdom allows
        // assignment to .href without actually navigating.
        let navigated = null;
        const origLocation = window.location;
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: {
                get href() {
                    return navigated;
                },
                set href(v) {
                    navigated = v;
                },
            },
        });
        try {
            const localBtn = manager.treeEl.querySelector(
                '.ft-vscode-row-local-btn',
            );
            localBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            expect(navigated).toBe('vscode://file/ws/main.go');
            expect(md.previewFile).not.toHaveBeenCalled();
            const textarea = document.getElementById('input-textarea');
            expect(textarea.value).toBe('');
        } finally {
            Object.defineProperty(window, 'location', {
                configurable: true,
                value: origLocation,
            });
        }
    });

    it('disables row actions whose URI cannot be resolved (stale context)', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        document.body.innerHTML = `
            <div id="file-tree-list"></div>
            <textarea id="input-textarea"></textarea>
            <div id="file-tree-toolbar" class="file-tree-toolbar hidden">
                <a id="ft-vscode-local-btn" class="ft-vscode-btn ft-vscode-local-btn" href="#"></a>
                <a id="ft-vscode-remote-btn" class="ft-vscode-btn ft-vscode-remote-btn" href="#"></a>
            </div>
        `;
        // No cwd — the builders cannot resolve any URI.
        const manager = new FileTreeManager(makeVSCodeApp({ cwd: '' }));
        await manager.refresh();

        const localBtn = manager.treeEl.querySelector(
            '.ft-vscode-row-local-btn',
        );
        const remoteBtn = manager.treeEl.querySelector(
            '.ft-vscode-row-remote-btn',
        );
        expect(localBtn.getAttribute('aria-disabled')).toBe('true');
        expect(remoteBtn.getAttribute('aria-disabled')).toBe('true');
    });

    it('hides the toolbar + row actions in embedded Electron (desktop-root) surfaces', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        document.documentElement.setAttribute('data-phi-desktop-root', '');
        document.body.innerHTML = `
            <div id="file-tree-list"></div>
            <textarea id="input-textarea"></textarea>
            <div id="file-tree-toolbar" class="file-tree-toolbar hidden">
                <a id="ft-vscode-local-btn" class="ft-vscode-btn ft-vscode-local-btn" href="#"></a>
                <a id="ft-vscode-remote-btn" class="ft-vscode-btn ft-vscode-remote-btn" href="#"></a>
            </div>
        `;
        try {
            const manager = new FileTreeManager(
                makeVSCodeApp({ cwd: '/Users/alex/code/phi' }),
            );
            await manager.refresh();
            expect(
                manager.treeEl.querySelector('.ft-vscode-row-actions'),
            ).toBeNull();
        } finally {
            document.documentElement.removeAttribute('data-phi-desktop-root');
        }
    });

    it('recomputes row URIs when activeCWD changes (no stale roots)', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        document.body.innerHTML = `
            <div id="file-tree-list"></div>
            <textarea id="input-textarea"></textarea>
            <div id="file-tree-toolbar" class="file-tree-toolbar hidden">
                <a id="ft-vscode-local-btn" class="ft-vscode-btn ft-vscode-local-btn" href="#"></a>
                <a id="ft-vscode-remote-btn" class="ft-vscode-btn ft-vscode-remote-btn" href="#"></a>
            </div>
        `;
        const manager = new FileTreeManager(
            makeVSCodeApp({ cwd: '/proj-a', hostname: 'jupiter' }),
        );
        await manager.refresh();

        let local = manager.treeEl.querySelector('.ft-vscode-row-local-btn');
        expect(local.getAttribute('href')).toBe('vscode://file/proj-a/main.go');

        // Simulate a server switch: the next refresh picks up the
        // new cwd; the row URIs must follow.
        manager.app.sessionsManager.activeCWD = '/proj-b';
        await manager.refresh();

        local = manager.treeEl.querySelector('.ft-vscode-row-local-btn');
        expect(local.getAttribute('href')).toBe('vscode://file/proj-b/main.go');
        // No element still points at the old project.
        expect(
            Array.from(
                manager.treeEl.querySelectorAll('.ft-vscode-row-local-btn'),
            ).some(
                (b) =>
                    b.getAttribute('href') === 'vscode://file/proj-a/main.go',
            ),
        ).toBe(false);
    });
});
