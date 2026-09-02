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

    it('clicking a dir row expands it, fetches its children, and indents them', async () => {
        const fetchMock = installFetch({
            '': { truncated: false, entries: [{ name: 'src', dir: true }] },
            src: {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        const manager = makeManager(makeApp());
        await manager.refresh();

        const dirItem = manager.treeEl.querySelector('.md-file-item');
        dirItem.click();

        await vi.waitFor(() => {
            const urls = fetchMock.mock.calls.map((c) => String(c[0]));
            expect(urls.some((u) => u.includes('path=src'))).toBe(true);
        });
        await vi.waitFor(() => {
            expect(manager.treeEl.querySelectorAll('.md-file-row').length).toBe(
                2,
            );
        });

        // refresh() rebuilds treeEl from scratch, so the pre-click `dirItem`
        // reference is now a detached node — re-query the live row.
        const rows = manager.treeEl.querySelectorAll('.md-file-row');
        const rootItem = rows[0].querySelector('.md-file-item');
        const childItem = rows[1].querySelector('.md-file-item');
        expect(rootItem.querySelector('.ft-chevron').textContent).toBe('▾');
        const rootPad = parseInt(rootItem.style.paddingLeft, 10);
        const childPad = parseInt(childItem.style.paddingLeft, 10);
        expect(childPad).toBeGreaterThan(rootPad);
    });

    it('collapsing a dir row removes its children and refetches root', async () => {
        const fetchMock = installFetch({
            '': { truncated: false, entries: [{ name: 'src', dir: true }] },
            src: {
                truncated: false,
                entries: [{ name: 'main.go', dir: false }],
            },
        });
        const manager = makeManager(makeApp());
        await manager.refresh();

        manager.treeEl.querySelector('.md-file-item').click();
        await vi.waitFor(() => {
            expect(manager.treeEl.querySelectorAll('.md-file-row').length).toBe(
                2,
            );
        });

        fetchMock.mockClear();
        manager.treeEl.querySelector('.md-file-item').click(); // collapse

        await vi.waitFor(() => {
            expect(manager.treeEl.querySelectorAll('.md-file-row').length).toBe(
                1,
            );
        });
        const urls = fetchMock.mock.calls.map((c) => String(c[0]));
        expect(
            urls.some((u) => u.includes('path=') && !u.includes('path=src')),
        ).toBe(true);
    });

    it('the ⋯ button opens a one-action context menu that inserts the path and closes', async () => {
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
        expect(actions.length).toBe(1);
        expect(actions[0].classList.contains('insert-path')).toBe(true);
        expect(actions[0].textContent).toContain('Insert @path');

        actions[0].click();
        await Promise.resolve();

        const textarea = document.getElementById('input-textarea');
        expect(textarea.value).toBe('@main.go');
        expect(menu.classList.contains('hidden')).toBe(true);
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
