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
//   2. onExternalChange (the 0x07 md-changed WS push handler) debounces
//      bursts and filters events to dirs this browser actually cares
//      about.

setupDomHarness();

// Full constructor this time (not the Object.create shortcut used by
// markdownExportImport.test.js) — refreshFiles/_renderFileList exercise
// real DOM writes, so fileListEl must be a live element. The five ids
// below are exactly what the constructor dereferences directly; every
// other lookup in the class is null-guarded.
function makeMm({ markdownDirs = [], activeCWD = '/w' } = {}) {
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
});
