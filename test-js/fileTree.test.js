// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { FileTreeManager } from '../web/filetree.js';

// Files tab: lazy directory tree with per-coder @path insertion. Mirrors
// the fetch-staleness-guard / context-menu patterns already covered for
// MarkdownManager in mdChangedRefresh.test.js and markdownIcons.test.js.

setupDomHarness();

function makeApp({ coder = 'claude' } = {}) {
    return {
        sessionsManager: { activeCWD: '/ws' },
        tabManager: { getActiveTab: () => ({ coder }), adjustInputHeight() {} },
        diffController: { isPanelOpen: true, activeTab: 'files' },
        showToast() {},
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

    it('clicking a file row inserts @path for the claude coder', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        const manager = makeManager(makeApp({ coder: 'claude' }));
        await manager.refresh();

        const fileItem = manager.treeEl.querySelector('.md-file-item');
        fileItem.click();
        await Promise.resolve();

        const textarea = document.getElementById('input-textarea');
        expect(textarea.value).toBe('@main.go');
    });

    it('clicking a file row inserts a raw path for a non-mention coder', async () => {
        installFetch({
            '': {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        const manager = makeManager(makeApp({ coder: 'bash' }));
        await manager.refresh();

        const fileItem = manager.treeEl.querySelector('.md-file-item');
        fileItem.click();
        await Promise.resolve();

        const textarea = document.getElementById('input-textarea');
        expect(textarea.value).toBe('main.go');
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
        expect(actions.length).toBe(3);
        expect(actions[0].classList.contains('insert-path')).toBe(true);
        expect(actions[0].textContent).toContain('Insert @path');
        expect(actions[1].classList.contains('preview')).toBe(true);
        expect(actions[1].textContent).toContain('Preview');
        expect(actions[2].classList.contains('open-explorer')).toBe(true);
        expect(actions[2].textContent).toContain('Open in Explorer');

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
        expect(actions.length).toBe(3);
        expect(actions[1].textContent).toContain('Preview');
        expect(actions[2].textContent).toContain('Open in Explorer');
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
        expect(actions.length).toBe(2);
        expect(actions[0].textContent).toContain('Insert @path');
        expect(actions[1].textContent).toContain('Open in Explorer');
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
