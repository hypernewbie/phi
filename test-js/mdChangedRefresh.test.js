// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';

// Milestone 4/6: silent-refresh + fsnotify push handling in
// MarkdownManager. Covers the two bugs from
// research/2026-07-22-1500-markdown-panel-not-refreshing-on-tab-click.md:
//   1. refreshFiles({force:false}) no longer swallows a same-cwd rescan
//      (the removed lastRefreshCwd gate) but a *silent* rescan skips the
//      re-render (and the "Scanning..." flash) when nothing changed.
//   2. onExternalChange (the md-changed notification handler) debounces
//      bursts and filters events to dirs this browser actually cares
//      about.

setupDomHarness();

// Full constructor this time (not the Object.create shortcut used by
// markdownExportImport.test.js) — refreshFiles/_renderFileList exercise
// real DOM writes, so fileListEl must be a live element. The five ids
// below are exactly what the constructor dereferences directly; every
// other lookup in the class is null-guarded.
function makeMm({ markdownDirs = [], activeCWD = '/w', appExtra = {} } = {}) {
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
    const mm = new MarkdownManager(app);
    return { mm, app };
}

describe('MarkdownManager silent refresh', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('silent skip: identical fetch result does not re-render', async () => {
        const files = [
            { path: '/w/research/a.md', name: 'a.md', dir: './research' },
        ];
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => files,
            text: async () => '',
        }));
        vi.stubGlobal('fetch', fetchMock);

        const { mm } = makeMm();
        const renderSpy = vi.spyOn(mm, '_renderFileList');

        await mm.refreshFiles({ force: true }); // seeds _lastRenderedKey
        expect(renderSpy).toHaveBeenCalledTimes(1);
        const htmlAfterFirst = mm.fileListEl.innerHTML;

        await mm.refreshFiles({ force: false, silent: true }); // same data

        expect(renderSpy).toHaveBeenCalledTimes(1); // no second render
        expect(mm.fileListEl.innerHTML).toBe(htmlAfterFirst);
    });

    it('silent re-render on change: differing fetch result re-renders', async () => {
        const first = [
            { path: '/w/research/a.md', name: 'a.md', dir: './research' },
        ];
        const second = [
            { path: '/w/research/a.md', name: 'a.md', dir: './research' },
            { path: '/w/research/b.md', name: 'b.md', dir: './research' },
        ];
        let files = first;
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => files,
            text: async () => '',
        }));
        vi.stubGlobal('fetch', fetchMock);

        const { mm } = makeMm();
        const renderSpy = vi.spyOn(mm, '_renderFileList');

        await mm.refreshFiles({ force: true });
        expect(renderSpy).toHaveBeenCalledTimes(1);

        files = second;
        await mm.refreshFiles({ force: false, silent: true });

        expect(renderSpy).toHaveBeenCalledTimes(2);
    });

    it('debounces onExternalChange bursts into a single fetch', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => [],
            text: async () => '',
        }));
        vi.stubGlobal('fetch', fetchMock);

        const { mm } = makeMm();
        mm.onExternalChange({});
        await vi.advanceTimersByTimeAsync(100);
        mm.onExternalChange({}); // resets the debounce timer
        await vi.advanceTimersByTimeAsync(100);
        expect(fetchMock).not.toHaveBeenCalled(); // still within the 250ms window

        await vi.advanceTimersByTimeAsync(250);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('dir filter: ignores events for a dir this browser is not looking at', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => [],
            text: async () => '',
        }));
        vi.stubGlobal('fetch', fetchMock);

        const { mm } = makeMm({
            markdownDirs: ['./research'],
            activeCWD: '/w',
        });

        mm.onExternalChange({ dir: '/other/research' });
        await vi.advanceTimersByTimeAsync(300);
        expect(fetchMock).not.toHaveBeenCalled();

        mm.onExternalChange({ dir: '/w/research' });
        await vi.advanceTimersByTimeAsync(300);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('no-placeholder: a silent refresh never writes the Scanning... placeholder', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => [],
            text: async () => '',
        }));
        vi.stubGlobal('fetch', fetchMock);

        const { mm } = makeMm();
        mm.fileListEl.innerHTML = '<div class="prior">prior content</div>';

        const pending = mm.refreshFiles({ force: true, silent: true });
        expect(mm.fileListEl.innerHTML).not.toContain('Scanning');
        await pending;
        expect(mm.fileListEl.innerHTML).not.toContain('Scanning');
    });

    it('keeps accepted rows through an HTTP failure and recovers through Retry', async () => {
        const first = [
            { path: '/w/research/a.md', name: 'a.md', dir: './research' },
        ];
        const second = [
            { path: '/w/research/a.md', name: 'a.md', dir: './research' },
            { path: '/w/research/b.md', name: 'b.md', dir: './research' },
        ];
        let mode = 'ok';
        let files = first;
        const fetchMock = vi.fn(async () => {
            if (mode === 'fail') {
                return {
                    ok: false,
                    status: 500,
                    text: async () => 'backend exploded',
                };
            }
            return {
                ok: true,
                json: async () => files,
                text: async () => JSON.stringify(files),
            };
        });
        vi.stubGlobal('fetch', fetchMock);

        const { mm } = makeMm({ markdownDirs: ['./research'] });
        await mm.refreshFiles({ force: true });
        expect(mm.fileListEl.textContent).toContain('a.md');

        mode = 'fail';
        await mm.refreshFiles({ force: true });
        expect(mm.fileListEl.textContent).toContain('a.md');
        expect(mm.fileListEl.textContent).toContain('backend exploded');
        expect(
            mm.fileListEl.querySelector('.md-list-error-inline .md-list-retry'),
        ).not.toBeNull();

        mode = 'ok';
        files = second;
        mm.fileListEl.querySelector('.md-list-retry').click();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(mm.fileListEl.textContent).not.toContain('backend exploded');
        expect(mm.fileListEl.textContent).toContain('b.md');
    });

    it('ignores a slow older response and its late body', async () => {
        const oldFiles = [
            { path: '/w/research/old.md', name: 'old.md', dir: './research' },
        ];
        const newFiles = [
            { path: '/w/research/new.md', name: 'new.md', dir: './research' },
        ];
        let resolveOld;
        const oldBody = new Promise((resolve) => {
            resolveOld = resolve;
        });
        const fetchMock = vi
            .fn()
            .mockImplementationOnce(async () => ({
                ok: true,
                json: () => oldBody,
                text: async () => '',
            }))
            .mockImplementation(async () => ({
                ok: true,
                json: async () => newFiles,
                text: async () => JSON.stringify(newFiles),
            }));
        vi.stubGlobal('fetch', fetchMock);

        const store = { responses: new Map() };
        const { mm } = makeMm({
            markdownDirs: ['./research'],
            appExtra: { getActiveStore: () => store },
        });
        const older = mm.refreshFiles({ force: true });
        const newer = mm.refreshFiles({ force: true });
        await newer;
        expect(mm.fileListEl.textContent).toContain('new.md');
        expect(mm.fileListEl.textContent).not.toContain('old.md');

        resolveOld(oldFiles);
        await older;
        expect(mm.fileListEl.textContent).toContain('new.md');
        expect(mm.fileListEl.textContent).not.toContain('old.md');
        const cached = store.responses.get('/api/markdown/files?cwd=%2Fw');
        expect(cached).toBe(JSON.stringify(newFiles));
    });

    it('turns a stalled response body into a visible Retry state within ten seconds', async () => {
        const fetchMock = vi.fn((_url, options) =>
            Promise.resolve({
                ok: true,
                json: () =>
                    new Promise((_resolve, reject) => {
                        options.signal.addEventListener('abort', () => {
                            const error = new Error('aborted');
                            error.name = 'AbortError';
                            reject(error);
                        });
                    }),
                text: async () => '',
            }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const { mm } = makeMm({ markdownDirs: ['./research'] });
        const pending = mm.refreshFiles({ force: true });
        await vi.advanceTimersByTimeAsync(10_000);
        await pending;

        expect(mm.fileListEl.textContent).toContain('Request timed out');
        expect(mm.fileListEl.querySelector('.md-list-retry')).not.toBeNull();
        expect(mm.fileListEl.textContent).not.toContain('Scanning');
    });

    it('resets a hidden cwd round-trip without fetching and drops late results', async () => {
        const scopeA = {
            aborted: false,
            signal: new AbortController().signal,
            headers: () => ({}),
        };
        const scopeB = {
            aborted: false,
            signal: new AbortController().signal,
            headers: () => ({}),
        };
        const storeA = { responses: new Map() };
        const storeB = { responses: new Map() };
        let resolveOld;
        const oldBody = new Promise((resolve) => {
            resolveOld = resolve;
        });
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: () => oldBody,
            text: async () => '',
        }));
        vi.stubGlobal('fetch', fetchMock);

        const appExtra = {
            scope: scopeA,
            getActiveStore: () => storeA,
        };
        const { mm, app } = makeMm({
            markdownDirs: ['./research'],
            appExtra,
        });
        const pending = mm.refreshFiles({ force: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        app.sessionsManager.activeCWD = '/b';
        app.scope = scopeB;
        app.getActiveStore = () => storeB;
        expect(mm.syncContext()).toBe(true);
        app.sessionsManager.activeCWD = '/w';
        app.scope = scopeA;
        app.getActiveStore = () => storeA;
        expect(mm.syncContext()).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(mm.fileListEl.textContent).toContain('Scanning');
        expect(mm.fileListEl.querySelector('.md-file-row')).toBeNull();

        resolveOld([
            { path: '/w/research/old.md', name: 'old.md', dir: './research' },
        ]);
        await pending;
        expect(mm.fileListEl.querySelector('.md-file-row')).toBeNull();
        expect(storeA.responses.size).toBe(0);
        expect(storeB.responses.size).toBe(0);
    });
});
