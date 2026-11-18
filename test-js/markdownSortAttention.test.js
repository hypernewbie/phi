// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';
import { BackendScope } from '../web/backend-scope.js';

// Focused coverage for the markdown panel's name/modified sort control and
// the changed-file attention cue. These tests drive the real manager and DOM;
// only storage failures, clocks, and network responses are mocked.

setupDomHarness();

const managers = [];

function makeMm({
    markdownDirs = ['./docs'],
    activeCWD = '/w',
    scope = null,
    store = null,
    appExtra = {},
} = {}) {
    document.body.innerHTML = `
        <div id="markdown-file-list"></div>
        <div id="md-modal" class="hidden"></div>
        <div id="md-modal-title"></div>
        <div id="md-modal-body"></div>
        <button id="md-modal-close"></button>
    `;
    const app = {
        showToast: vi.fn(),
        markdownDirs,
        sessionsManager: { activeCWD },
        ...appExtra,
    };
    if (scope) app.scope = scope;
    if (store) app.getActiveStore = () => store;
    const mm = new MarkdownManager(app);
    managers.push(mm);
    return { mm, app };
}

afterEach(() => {
    for (const mm of managers) {
        window.removeEventListener('online', mm._onOnline);
        window.removeEventListener('resize', mm._onSortMenuLayout);
        mm.fileListEl.removeEventListener('scroll', mm._onSortMenuLayout);
        document.removeEventListener('visibilitychange', mm._onVisibility);
        mm._abortListing();
        mm._abortPreview();
        if (mm._externalDebounce) {
            clearTimeout(mm._externalDebounce);
            mm._externalDebounce = null;
        }
    }
    managers.length = 0;
    vi.useRealTimers();
});

function response(body) {
    return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

function jsonFetch(body) {
    return vi.fn(async () => response(body));
}

function rowNames(mm) {
    return Array.from(
        mm.fileListEl.querySelectorAll('.md-file-name'),
        (el) => el.textContent,
    );
}

function groupLabels(mm) {
    return Array.from(
        mm.fileListEl.querySelectorAll('.md-dir-label > span'),
        (el) => el.textContent,
    );
}

function file(name, dir, modTime) {
    const entry = { path: `${dir}/${name}`, name, dir };
    if (modTime) entry.mod_time = modTime;
    return entry;
}

function routeFetch({ list, file: fileResponse }) {
    const fetchMock = vi.fn(async (url, options) => {
        const target = String(url);
        if (target.includes('/api/markdown/file?')) {
            return typeof fileResponse === 'function'
                ? fileResponse(target, options)
                : fileResponse;
        }
        const body =
            typeof list === 'function' ? await list(target, options) : list;
        return response(body);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function rowFor(mm, path) {
    return Array.from(mm.fileListEl.querySelectorAll('.md-file-row')).find(
        (row) => row.dataset.path === path,
    );
}

function attentionPaths(mm) {
    return Array.from(
        mm.fileListEl.querySelectorAll('.md-file-row.has-attention'),
        (row) => row.dataset.path,
    );
}

describe('markdown sort menu', () => {
    it('sorts modified inside a group while leaving raw cache order alone', async () => {
        const raw = [
            file('old.md', './docs', '2024-01-01T00:00:00Z'),
            file('new.md', './docs', '2024-03-01T00:00:00Z'),
            file('mid.md', './docs', '2024-02-01T00:00:00Z'),
        ];
        const store = { responses: new Map() };
        vi.stubGlobal('fetch', jsonFetch(raw));

        const { mm } = makeMm({ store });
        await mm.refreshFiles({ force: true });
        expect(rowNames(mm)).toEqual(['mid.md', 'new.md', 'old.md']);

        mm._setSortMode('modified');
        expect(rowNames(mm)).toEqual(['new.md', 'mid.md', 'old.md']);

        const url = '/api/markdown/files?cwd=%2Fw';
        expect(
            JSON.parse(store.responses.get(url)).map((entry) => entry.name),
        ).toEqual(['old.md', 'new.md', 'mid.md']);
    });

    it('handles ties, unknown, invalid, epoch, and pre-epoch timestamps', async () => {
        const raw = [
            file('alpha.md', './docs', '2024-01-01T00:00:00Z'),
            file('beta.md', './docs', '2024-01-01T00:00:00Z'),
            file('epoch.md', './docs', '1970-01-01T00:00:00Z'),
            file('pre.md', './docs', '1960-01-01T00:00:00Z'),
            file('unknown.md', './docs'),
            file('bad.md', './docs', 'not-a-date'),
        ];
        vi.stubGlobal('fetch', jsonFetch(raw));

        const { mm } = makeMm();
        await mm.refreshFiles({ force: true });
        expect(rowNames(mm)).toEqual([
            'alpha.md',
            'bad.md',
            'beta.md',
            'epoch.md',
            'pre.md',
            'unknown.md',
        ]);

        mm._setSortMode('modified');
        expect(rowNames(mm)).toEqual([
            'alpha.md',
            'beta.md',
            'epoch.md',
            'pre.md',
            'bad.md',
            'unknown.md',
        ]);
        expect(mm.fileListEl.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('keeps configured group order for numeric and prototype-like names', async () => {
        const raw = [
            file('ten.md', '10', '2024-01-01T00:00:00Z'),
            file('two.md', '2', '2024-02-01T00:00:00Z'),
            file('proto.md', '__proto__', '2024-03-01T00:00:00Z'),
            file('extra.md', './extra', '2024-04-01T00:00:00Z'),
        ];
        vi.stubGlobal('fetch', jsonFetch(raw));

        const { mm } = makeMm({
            markdownDirs: ['10', '2', '__proto__'],
        });
        await mm.refreshFiles({ force: true });
        expect(groupLabels(mm)).toEqual(['10', '2', '__proto__', './extra']);
        expect(rowNames(mm)).toEqual([
            'ten.md',
            'two.md',
            'proto.md',
            'extra.md',
        ]);

        mm._setSortMode('modified');
        expect(groupLabels(mm)).toEqual(['10', '2', '__proto__', './extra']);
        expect(rowNames(mm)).toEqual([
            'ten.md',
            'two.md',
            'proto.md',
            'extra.md',
        ]);
    });

    it('restores a saved choice and survives unavailable storage', async () => {
        localStorage.setItem('phi-md-sort', 'modified');
        const raw = [
            file('old.md', './docs', '2024-01-01T00:00:00Z'),
            file('new.md', './docs', '2024-03-01T00:00:00Z'),
        ];
        vi.stubGlobal('fetch', jsonFetch(raw));
        const first = makeMm();
        await first.mm.refreshFiles({ force: true });
        expect(first.mm.sortMode).toBe('modified');
        expect(rowNames(first.mm)).toEqual(['new.md', 'old.md']);

        localStorage.setItem('phi-md-sort', 'nonsense');
        const second = makeMm();
        expect(second.mm.sortMode).toBe('name');

        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('storage denied');
        });
        const third = makeMm();
        expect(third.mm.sortMode).toBe('name');

        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('storage denied');
        });
        expect(() => third.mm._setSortMode('modified')).not.toThrow();
        expect(third.mm.sortMode).toBe('modified');
    });

    it('keeps the chosen order across an identical silent response', async () => {
        const raw = [
            file('old.md', './docs', '2024-01-01T00:00:00Z'),
            file('new.md', './docs', '2024-03-01T00:00:00Z'),
        ];
        const fetchMock = jsonFetch(raw);
        vi.stubGlobal('fetch', fetchMock);

        const { mm } = makeMm();
        await mm.refreshFiles({ force: true });
        mm._setSortMode('modified');
        const renderSpy = vi.spyOn(mm, '_renderFileList');
        renderSpy.mockClear();

        await mm.refreshFiles({ force: false, silent: true });

        expect(renderSpy).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(rowNames(mm)).toEqual(['new.md', 'old.md']);
    });

    it.each([
        '.md-sort-btn',
        '.md-dir-del-btn',
        '.md-file-item',
        '.md-file-action-btn',
        '#md-paste-btn',
        '.md-manage-row > button:last-child',
    ])(
        'preserves keyboard focus on %s through a changed silent listing',
        async (selector) => {
            const first = [file('a.md', './docs', '2024-01-01T00:00:00Z')];
            routeFetch({ list: first });
            const { mm } = makeMm();
            await mm.refreshFiles();
            mm.fileListEl.querySelector(selector).focus();
            routeFetch({
                list: [
                    ...first,
                    file('b.md', './docs', '2024-02-01T00:00:00Z'),
                ],
            });
            await mm.refreshFiles({ silent: true });
            expect(document.activeElement).toBe(
                mm.fileListEl.querySelector(selector),
            );
        },
    );

    it('opens with the keyboard, changes the radio choice, and restores focus', async () => {
        const raw = [
            file('a.md', './docs', '2024-01-01T00:00:00Z'),
            file('b.md', './docs', '2024-02-01T00:00:00Z'),
        ];
        vi.stubGlobal('fetch', jsonFetch(raw));
        const { mm } = makeMm();
        await mm.refreshFiles({ force: true });

        const button = mm.fileListEl.querySelector('.md-sort-btn');
        expect(button.getAttribute('aria-label')).toBe('Sort markdown files');
        expect(button.getAttribute('aria-haspopup')).toBe('menu');
        expect(button.getAttribute('aria-expanded')).toBe('false');

        button.click();
        expect(mm._sortMenuEl.classList.contains('hidden')).toBe(false);
        expect(button.getAttribute('aria-expanded')).toBe('true');
        const options = mm._sortMenuItems();
        expect(options.map((item) => item.dataset.sort)).toEqual([
            'name',
            'modified',
        ]);
        expect(options[0].getAttribute('aria-checked')).toBe('true');
        expect(options[0].getAttribute('role')).toBe('menuitemradio');

        options[1].click();
        expect(mm.sortMode).toBe('modified');
        expect(localStorage.getItem('phi-md-sort')).toBe('modified');
        expect(mm._sortMenuEl.classList.contains('hidden')).toBe(true);
        expect(document.activeElement).toBe(mm._sortButton);
        expect(rowNames(mm)).toEqual(['b.md', 'a.md']);

        mm._sortButton.click();
        const reopened = mm._sortMenuItems();
        expect(reopened[1].getAttribute('aria-checked')).toBe('true');
        reopened[1].focus();
        reopened[1].dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
        );
        expect(document.activeElement).toBe(reopened[0]);
        reopened[0].dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
        expect(mm._sortMenuEl.classList.contains('hidden')).toBe(true);
        expect(document.activeElement).toBe(mm._sortButton);

        mm._sortButton.click();
        document.body.click();
        expect(mm._sortMenuEl.classList.contains('hidden')).toBe(true);
        expect(mm.contextMenuEl.classList.contains('hidden')).toBe(true);
    });
});

describe('markdown scoped reads', () => {
    it('drops a late listing body after the captured backend is aborted', async () => {
        const scope = new BackendScope('backend-a');
        const store = { responses: new Map() };
        const base = [file('a.md', './docs', '2024-01-01T00:00:00Z')];
        routeFetch({ list: base });
        const { mm } = makeMm({ scope, store });
        await mm.refreshFiles();
        const cached = store.responses.get('/api/markdown/files?cwd=%2Fw');

        const body = deferred();
        const readBody = vi.fn(() => body.promise);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, json: readBody })),
        );
        const pending = mm.refreshFiles({ silent: true });
        await Promise.resolve();
        expect(readBody).toHaveBeenCalledOnce();
        scope.abort();
        body.resolve([file('private.md', './docs', '2024-02-01T00:00:00Z')]);
        await pending;

        expect(rowNames(mm)).toEqual(['a.md']);
        expect(store.responses.get('/api/markdown/files?cwd=%2Fw')).toBe(
            cached,
        );
        expect(attentionPaths(mm)).toEqual([]);
    });

    it.each(['abort', 'backend', 'store', 'cwd'])(
        'drops a late preview after %s invalidates its captured context',
        async (change) => {
            const scope = new BackendScope('backend-a');
            const store = { responses: new Map() };
            const base = [file('a.md', './docs', '2024-01-01T00:00:00Z')];
            routeFetch({ list: base });
            const { mm, app } = makeMm({ scope, store });
            await mm.refreshFiles();
            routeFetch({
                list: [file('a.md', './docs', '2024-02-01T00:00:00Z')],
            });
            await mm.refreshFiles({ silent: true });

            const body = deferred();
            const readBody = vi.fn(() => body.promise);
            routeFetch({ file: { ok: true, text: readBody } });
            const pending = mm.openFile({ name: 'a.md', path: './docs/a.md' });
            await Promise.resolve();
            expect(readBody).toHaveBeenCalledOnce();
            if (change === 'abort') scope.abort();
            if (change === 'backend') app.scope = new BackendScope('backend-b');
            if (change === 'store')
                app.getActiveStore = () => ({ responses: new Map() });
            if (change === 'cwd') app.sessionsManager.activeCWD = '/other';
            body.resolve('# private stale preview');
            await pending;

            expect(mm.modalBody.textContent).not.toContain(
                'private stale preview',
            );
            expect(mm.currentRawContent).toBe('');
            expect(attentionPaths(mm)).toEqual(['./docs/a.md']);
        },
    );

    it.each(['headers', 'body'])(
        'times out a stalled preview %s without clearing attention and allows retry',
        async (stage) => {
            vi.useFakeTimers();
            const scope = new BackendScope('backend-a');
            const base = [file('a.md', './docs', '2024-01-01T00:00:00Z')];
            const changed = [file('a.md', './docs', '2024-02-01T00:00:00Z')];
            routeFetch({ list: base });
            const { mm } = makeMm({ scope });
            await mm.refreshFiles();
            routeFetch({ list: changed });
            await mm.refreshFiles({ silent: true });

            const fetchMock = routeFetch({
                file: (_url, options) => {
                    const stalled = new Promise((_resolve, reject) => {
                        options.signal.addEventListener('abort', () => {
                            reject(new DOMException('Aborted', 'AbortError'));
                        });
                    });
                    return stage === 'headers'
                        ? stalled
                        : { ok: true, text: () => stalled };
                },
            });
            const pending = mm.openFile({ name: 'a.md', path: './docs/a.md' });
            await vi.advanceTimersByTimeAsync(10_000);
            await pending;
            expect(fetchMock.mock.calls[0][1].headers).toEqual({
                'X-Phi-Backend': 'backend-a',
            });
            expect(mm.modalBody.textContent).toContain(
                'Preview request timed out',
            );
            expect(mm.currentRawContent).toBe('');
            expect(attentionPaths(mm)).toEqual(['./docs/a.md']);

            routeFetch({ file: { ok: true, text: async () => '# retried' } });
            await mm.openFile({ name: 'a.md', path: './docs/a.md' });
            expect(mm.modalBody.textContent).toContain('retried');
            expect(attentionPaths(mm)).toEqual([]);
        },
    );

    it.each(['listing', 'preview'])(
        'fails closed when %s backend headers cannot be captured',
        async (kind) => {
            const scope = new BackendScope('backend-a');
            const { mm } = makeMm({ scope });
            routeFetch({
                list: [file('a.md', './docs', '2024-01-01T00:00:00Z')],
            });
            await mm.refreshFiles();
            const fetchMock = routeFetch({
                list: [file('private.md', './docs')],
                file: { ok: true, text: async () => '# private preview' },
            });
            vi.spyOn(scope, 'headers').mockImplementation(() => {
                throw new Error('backend headers unavailable');
            });

            if (kind === 'listing') await mm.refreshFiles({ silent: true });
            else await mm.openFile({ name: 'a.md', path: './docs/a.md' });

            expect(fetchMock).not.toHaveBeenCalled();
            expect(rowNames(mm)).toEqual(['a.md']);
            expect(
                (kind === 'listing' ? mm.fileListEl : mm.modalBody).textContent,
            ).toContain('backend headers unavailable');
        },
    );
});

describe('markdown changed-file attention', () => {
    it('establishes a silent first baseline and marks only later changes', async () => {
        const first = [
            file('a.md', './docs', '2024-01-01T00:00:00Z'),
            file('b.md', './docs', '2024-01-02T00:00:00Z'),
        ];
        const changed = [
            file('a.md', './docs', '2024-03-01T00:00:00Z'),
            file('b.md', './docs', '2024-01-02T00:00:00Z'),
            file('c.md', './docs', '2024-03-02T00:00:00Z'),
        ];
        routeFetch({ list: first });
        const { mm } = makeMm();
        await mm.refreshFiles({ force: true });
        expect(attentionPaths(mm)).toEqual([]);

        routeFetch({ list: changed });
        await mm.refreshFiles({ force: false, silent: true });
        expect(attentionPaths(mm)).toEqual(['./docs/a.md', './docs/c.md']);
        expect(
            rowFor(mm, './docs/a.md').querySelector('.md-file-attention-dot'),
        ).not.toBeNull();
        expect(
            rowFor(mm, './docs/a.md').querySelector('.md-file-icon-doc'),
        ).toBeNull();
        expect(
            rowFor(mm, './docs/b.md').querySelector('.md-file-icon-doc'),
        ).not.toBeNull();
        expect(
            rowFor(mm, './docs/a.md')
                .querySelector('.md-file-item')
                .getAttribute('aria-label'),
        ).toBe('a.md (changed)');
    });

    it('keeps attention through identical lists, sort changes, and failed refreshes', async () => {
        const base = [file('a.md', './docs', '2024-01-01T00:00:00Z')];
        const changed = [file('a.md', './docs', '2024-02-01T00:00:00Z')];
        routeFetch({ list: base });
        const { mm } = makeMm();
        await mm.refreshFiles({ force: true });
        routeFetch({ list: changed });
        await mm.refreshFiles({ force: false, silent: true });
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);

        routeFetch({ list: changed });
        await mm.refreshFiles({ force: true });
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);

        mm._setSortMode('modified');
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);
        expect(
            mm.fileListEl.querySelector('.md-file-attention-dot'),
        ).not.toBeNull();

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 500,
                text: async () => 'down',
            })),
        );
        await mm.refreshFiles({ force: true });
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);
        expect(mm.fileListEl.textContent).toContain('down');
    });

    it('marks a new path after an empty baseline and prunes on a successful empty list', async () => {
        routeFetch({ list: [] });
        const { mm } = makeMm();
        await mm.refreshFiles({ force: true });
        expect(attentionPaths(mm)).toEqual([]);

        routeFetch({
            list: [file('new.md', './docs', '2024-01-01T00:00:00Z')],
        });
        await mm.refreshFiles({ force: false, silent: true });
        expect(attentionPaths(mm)).toEqual(['./docs/new.md']);

        routeFetch({ list: [] });
        await mm.refreshFiles({ force: false, silent: true });
        expect(mm.fileListEl.querySelector('.md-file-row')).toBeNull();
        expect(mm._pathState.size).toBe(0);
        expect(mm._attention.size).toBe(0);
    });

    it('acknowledges only after a successful in-panel preview without a listing GET', async () => {
        const base = [file('a.md', './docs', '2024-01-01T00:00:00Z')];
        const changed = [file('a.md', './docs', '2024-02-01T00:00:00Z')];
        routeFetch({ list: base });
        const { mm } = makeMm();
        await mm.refreshFiles({ force: true });
        routeFetch({ list: changed });
        await mm.refreshFiles({ force: false, silent: true });
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);

        let listingCalls = 0;
        const fetchMock = routeFetch({
            list: () => {
                listingCalls++;
                return changed;
            },
            file: {
                ok: false,
                status: 500,
                text: async () => 'preview failed',
            },
        });
        await mm.openFile({ name: 'a.md', path: './docs/a.md' });
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);
        expect(mm.modalBody.textContent).toContain('preview failed');

        fetchMock.mockImplementation(async (url) => {
            const target = String(url);
            if (target.includes('/api/markdown/file?')) {
                return { ok: true, text: async () => '# a' };
            }
            listingCalls++;
            return response(changed);
        });
        await mm.openFile({ name: 'a.md', path: './docs/a.md' });
        expect(mm.modalBody.textContent).toContain('a');
        expect(attentionPaths(mm)).toEqual([]);
        expect(
            mm.fileListEl.querySelector('.md-file-attention-dot'),
        ).toBeNull();
        expect(
            rowFor(mm, './docs/a.md').querySelector('.md-file-icon-doc'),
        ).not.toBeNull();
        expect(listingCalls).toBe(0);

        await mm.refreshFiles({ force: true });
        expect(attentionPaths(mm)).toEqual([]);
    });

    it('keeps an unchanged delayed preview and its acknowledgment intact', async () => {
        const base = [file('a.md', './docs', '2024-01-01T00:00:00Z')];
        const changed = [file('a.md', './docs', '2024-02-01T00:00:00Z')];
        routeFetch({ list: base });
        const { mm } = makeMm();
        await mm.refreshFiles({ force: true });
        routeFetch({ list: changed });
        await mm.refreshFiles({ force: false, silent: true });

        const body = deferred();
        routeFetch({
            list: changed,
            file: { ok: true, text: () => body.promise },
        });
        const preview = mm.openFile({ name: 'a.md', path: './docs/a.md' });
        await mm.refreshFiles({ force: false, silent: true });
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);

        body.resolve('# current');
        await preview;
        expect(mm.modalBody.textContent).toContain('current');
        expect(attentionPaths(mm)).toEqual([]);
    });

    it('does not acknowledge when a newer listed timestamp lands during the preview', async () => {
        const base = [file('a.md', './docs', '2024-01-01T00:00:00Z')];
        const firstChange = [file('a.md', './docs', '2024-02-01T00:00:00Z')];
        const secondChange = [file('a.md', './docs', '2024-03-01T00:00:00Z')];
        routeFetch({ list: base });
        const { mm } = makeMm();
        await mm.refreshFiles({ force: true });
        routeFetch({ list: firstChange });
        await mm.refreshFiles({ force: false, silent: true });

        const body = deferred();
        routeFetch({
            list: firstChange,
            file: { ok: true, text: () => body.promise },
        });
        const preview = mm.openFile({ name: 'a.md', path: './docs/a.md' });
        routeFetch({ list: secondChange });
        await mm.refreshFiles({ force: false, silent: true });
        body.resolve('# first change');
        await preview;
        expect(mm.modalBody.textContent).toContain('first change');
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);
    });

    it('rejects acknowledgment after an observed timestamp reversal or recreation', async () => {
        const base = [file('a.md', './docs', '2024-01-01T00:00:00Z')];
        const changed = [file('a.md', './docs', '2024-02-01T00:00:00Z')];
        const later = [file('a.md', './docs', '2024-03-01T00:00:00Z')];
        routeFetch({ list: base });
        const { mm } = makeMm();
        await mm.refreshFiles({ force: true });
        routeFetch({ list: changed });
        await mm.refreshFiles({ force: false, silent: true });

        const body = deferred();
        routeFetch({
            list: changed,
            file: { ok: true, text: () => body.promise },
        });
        const preview = mm.openFile({ name: 'a.md', path: './docs/a.md' });
        routeFetch({ list: later });
        await mm.refreshFiles({ force: false, silent: true });
        routeFetch({ list: changed });
        await mm.refreshFiles({ force: false, silent: true });
        body.resolve('# changed');
        await preview;
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);

        const secondBody = deferred();
        routeFetch({
            list: changed,
            file: { ok: true, text: () => secondBody.promise },
        });
        const secondPreview = mm.openFile({
            name: 'a.md',
            path: './docs/a.md',
        });
        routeFetch({ list: [] });
        await mm.refreshFiles({ force: false, silent: true });
        routeFetch({ list: changed });
        await mm.refreshFiles({ force: false, silent: true });
        secondBody.resolve('# recreated');
        await secondPreview;
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);
    });

    it('treats missing metadata as unknown for acknowledgment but keeps the last known value', async () => {
        const base = [file('a.md', './docs', '2024-01-01T00:00:00Z')];
        const changed = [file('a.md', './docs', '2024-02-01T00:00:00Z')];
        routeFetch({ list: base });
        const { mm } = makeMm();
        await mm.refreshFiles({ force: true });
        routeFetch({ list: changed });
        await mm.refreshFiles({ force: false, silent: true });

        routeFetch({ list: [file('a.md', './docs')] });
        await mm.refreshFiles({ force: false, silent: true });
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);
        expect(mm._pathState.get('./docs/a.md').lastKnown).toBe(
            '2024-02-01T00:00:00Z',
        );

        routeFetch({
            list: [file('a.md', './docs')],
            file: { ok: true, text: async () => '# unknown' },
        });
        await mm.openFile({ name: 'a.md', path: './docs/a.md' });
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);

        routeFetch({ list: changed });
        await mm.refreshFiles({ force: false, silent: true });
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);

        routeFetch({
            list: changed,
            file: { ok: true, text: async () => '# known again' },
        });
        await mm.openFile({ name: 'a.md', path: './docs/a.md' });
        expect(attentionPaths(mm)).toEqual([]);
    });

    it.each([
        [undefined, '2024-01-01T00:00:00Z', false],
        [undefined, '2024-02-01T00:00:00Z', true],
        ['not-a-date', '2024-01-01T00:00:00Z', false],
        ['not-a-date', '2024-02-01T00:00:00Z', true],
    ])(
        'compares recovered metadata %s → %s with the last known timestamp',
        async (unknown, recovered, changed) => {
            routeFetch({
                list: [file('a.md', './docs', '2024-01-01T00:00:00Z')],
            });
            const { mm } = makeMm();
            await mm.refreshFiles();
            routeFetch({ list: [file('a.md', './docs', unknown)] });
            await mm.refreshFiles({ silent: true });
            expect(attentionPaths(mm)).toEqual([]);
            routeFetch({ list: [file('a.md', './docs', recovered)] });
            await mm.refreshFiles({ silent: true });
            expect(attentionPaths(mm)).toEqual(changed ? ['./docs/a.md'] : []);
        },
    );

    it('treats the first known timestamp for an unknown path as neutral', async () => {
        routeFetch({ list: [file('a.md', './docs')] });
        const { mm } = makeMm();
        await mm.refreshFiles({ force: true });
        routeFetch({ list: [file('a.md', './docs', '2024-01-01T00:00:00Z')] });
        await mm.refreshFiles({ force: false, silent: true });
        expect(attentionPaths(mm)).toEqual([]);

        routeFetch({ list: [file('a.md', './docs', '2024-02-01T00:00:00Z')] });
        await mm.refreshFiles({ force: false, silent: true });
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);
    });

    it('resets attention and blocks stale previews across a hidden cwd round-trip', async () => {
        const scopeA = { aborted: false, headers: () => ({}) };
        const scopeB = { aborted: false, headers: () => ({}) };
        const storeA = { responses: new Map() };
        const storeB = { responses: new Map() };
        const base = [file('a.md', './docs', '2024-01-01T00:00:00Z')];
        const changed = [file('a.md', './docs', '2024-02-01T00:00:00Z')];
        routeFetch({ list: base });
        const { mm, app } = makeMm({
            activeCWD: '/w',
            appExtra: {
                scope: scopeA,
                getActiveStore: () => storeA,
            },
        });
        await mm.refreshFiles({ force: true });
        routeFetch({ list: changed });
        await mm.refreshFiles({ force: false, silent: true });
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);

        const body = deferred();
        routeFetch({
            list: changed,
            file: { ok: true, text: () => body.promise },
        });
        const preview = mm.openFile({ name: 'a.md', path: './docs/a.md' });

        app.sessionsManager.activeCWD = '/b';
        app.scope = scopeB;
        app.getActiveStore = () => storeB;
        mm.syncContext();
        app.sessionsManager.activeCWD = '/w';
        app.scope = scopeA;
        app.getActiveStore = () => storeA;
        mm.syncContext();
        body.resolve('# stale');
        await preview;

        expect(attentionPaths(mm)).toEqual([]);
        expect(mm.fileListEl.querySelector('.md-file-row')).toBeNull();
        expect(mm._attention.size).toBe(0);
    });

    it('keeps cached paint deduplication tied to the rows it actually displays', async () => {
        const base = [file('a.md', './docs', '2024-01-01T00:00:00Z')];
        const newer = [...base, file('b.md', './docs', '2024-02-01T00:00:00Z')];
        const store = { responses: new Map() };
        routeFetch({ list: base });
        const { mm } = makeMm({ store });
        await mm.refreshFiles();
        routeFetch({ list: newer });
        await mm.refreshFiles({ silent: true });
        store.responses.set(
            '/api/markdown/files?cwd=%2Fw',
            JSON.stringify(base),
        );

        mm.paintFromStore();
        expect(rowNames(mm)).toEqual(['a.md', 'b.md']);
        expect(attentionPaths(mm)).toEqual(['./docs/b.md']);

        routeFetch({ list: base });
        await mm.refreshFiles({ silent: true });
        expect(rowNames(mm)).toEqual(['a.md']);
        expect(attentionPaths(mm)).toEqual([]);
    });

    it('does not paint another backend cache with inherited attention', async () => {
        const scopeA = { aborted: false, headers: () => ({}) };
        const scopeB = { aborted: false, headers: () => ({}) };
        const storeA = { responses: new Map() };
        const storeB = { responses: new Map() };
        const base = [file('a.md', './docs', '2024-01-01T00:00:00Z')];
        const changed = [file('a.md', './docs', '2024-02-01T00:00:00Z')];
        routeFetch({ list: base });
        const { mm, app } = makeMm({
            activeCWD: '/w',
            appExtra: {
                scope: scopeA,
                getActiveStore: () => storeA,
            },
        });
        await mm.refreshFiles({ force: true });
        routeFetch({ list: changed });
        await mm.refreshFiles({ force: false, silent: true });
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);

        storeB.responses.set(
            '/api/markdown/files?cwd=%2Fw-b',
            JSON.stringify([file('b.md', './docs', '2024-05-01T00:00:00Z')]),
        );
        app.sessionsManager.activeCWD = '/w-b';
        app.scope = scopeB;
        app.getActiveStore = () => storeB;
        expect(mm.paintFromStore()).toBe(true);
        expect(rowNames(mm)).toEqual(['b.md']);
        expect(attentionPaths(mm)).toEqual([]);
    });

    it('drops a superseded preview before it can acknowledge or repaint', async () => {
        const base = [
            file('a.md', './docs', '2024-01-01T00:00:00Z'),
            file('b.md', './docs', '2024-01-01T00:00:00Z'),
        ];
        const changed = [
            file('a.md', './docs', '2024-02-01T00:00:00Z'),
            file('b.md', './docs', '2024-02-01T00:00:00Z'),
        ];
        routeFetch({ list: base });
        const { mm } = makeMm();
        await mm.refreshFiles({ force: true });
        routeFetch({ list: changed });
        await mm.refreshFiles({ force: false, silent: true });
        expect(attentionPaths(mm)).toEqual(['./docs/a.md', './docs/b.md']);

        const bodyA = deferred();
        const fetchMock = routeFetch({
            list: changed,
            file: { ok: true, text: () => bodyA.promise },
        });
        const stale = mm.openFile({ name: 'a.md', path: './docs/a.md' });
        fetchMock.mockImplementation(async (url) => {
            const target = String(url);
            if (target.includes('/api/markdown/file?')) {
                return { ok: true, text: async () => '# b' };
            }
            return response(changed);
        });
        await mm.openFile({ name: 'b.md', path: './docs/b.md' });
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);

        bodyA.resolve('# stale a');
        await stale;
        expect(mm.modalBody.textContent).toContain('b');
        expect(mm.modalBody.textContent).not.toContain('stale a');
        expect(attentionPaths(mm)).toEqual(['./docs/a.md']);
    });
});

describe('markdown catch-up triggers', () => {
    it('coalesces online, visible-again, and reconnect signals into one refresh', async () => {
        vi.useFakeTimers();
        const fetchMock = routeFetch({ list: [] });
        const { mm } = makeMm({
            appExtra: {
                diffController: { isPanelOpen: true, activeTab: 'markdown' },
            },
        });
        window.dispatchEvent(new Event('online'));
        document.dispatchEvent(new Event('visibilitychange'));
        mm.onExternalChange({});
        await vi.advanceTimersByTimeAsync(250);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not start a background refresh while the panel is hidden', async () => {
        vi.useFakeTimers();
        const fetchMock = routeFetch({ list: [] });
        makeMm({
            appExtra: {
                diffController: { isPanelOpen: false, activeTab: 'git' },
            },
        });
        window.dispatchEvent(new Event('online'));
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(300);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reads the context that is current when the debounce fires', async () => {
        vi.useFakeTimers();
        const fetchMock = routeFetch({ list: [] });
        const { mm, app } = makeMm({
            activeCWD: '/a',
            appExtra: {
                diffController: { isPanelOpen: true, activeTab: 'markdown' },
            },
        });
        mm.onExternalChange({});
        app.sessionsManager.activeCWD = '/b';
        await vi.advanceTimersByTimeAsync(250);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('/api/markdown/files?cwd=%2Fb');
    });
});
