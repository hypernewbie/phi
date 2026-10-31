// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, setupDomHarness } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';

// Markdown images render at the plain /api/markdown/asset address, so the
// browser sends the scoped `phi_access_asset` cookie and streams the bytes.
// Nothing is fetched into a blob, so replacing or closing the modal needs no
// release bookkeeping; the stale-render guard still keeps a late render out of
// a body that another view already owns.

setupDomHarness();

function makeMm() {
    document.body.innerHTML = `
        <div id="markdown-file-list"></div>
        <div id="md-modal" class="hidden"></div>
        <div id="md-modal-title"></div>
        <div id="md-modal-body"></div>
        <button id="md-modal-close"></button>
    `;
    return new MarkdownManager({
        showToast: vi.fn(),
        markdownDirs: ['.'],
        sessionsManager: { activeCWD: '/w' },
    });
}

function stubMarkdown() {
    vi.stubGlobal('marked', { parse: (s) => s });
    vi.stubGlobal('DOMPurify', { sanitize: (h) => h });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('modal image assets', () => {
    it('renders images at the scoped-cookie asset path', async () => {
        stubMarkdown();
        const fetchSpy = mockFetch(() => ({
            ok: true,
            text: async () => '<img src="pic.png">',
        }));
        const mm = makeMm();
        await mm.openFile({ name: 'x.md', path: '/w/x.md' });
        const img = document.querySelector('#md-modal-body img');
        expect(img.getAttribute('src')).toBe(
            `/api/markdown/asset?path=${encodeURIComponent('/w/pic.png')}&cwd=${encodeURIComponent('/w')}`,
        );
        expect(img.getAttribute('src').startsWith('blob:')).toBe(false);
        // The page never buffers the image itself.
        expect(
            fetchSpy.mock.calls.some(([url]) =>
                String(url).startsWith('/api/markdown/asset'),
            ),
        ).toBe(false);
    });

    it('leaves no blob URLs behind when another view replaces the modal', async () => {
        stubMarkdown();
        mockFetch((url) => {
            if (String(url).startsWith('/api/markdown/file'))
                return { ok: true, text: async () => '<img src="pic.png">' };
            if (String(url) === '/api/diag')
                return {
                    ok: true,
                    json: async () => ({
                        version: 'test',
                        uptime_seconds: 1,
                        goroutines: 1,
                        mem_alloc_mb: 1,
                        pty_count: 0,
                        panes: [],
                    }),
                };
            return { ok: true, text: async () => '' };
        });
        const create = vi.fn();
        const revoke = vi.fn();
        URL.createObjectURL = create;
        URL.revokeObjectURL = revoke;
        try {
            const mm = makeMm();
            await mm.openFile({ name: 'x.md', path: '/w/x.md' });
            void mm.openDiagModal();
            mm.closeModal();
            expect(document.querySelectorAll('img')).toHaveLength(0);
            expect(create).not.toHaveBeenCalled();
            expect(revoke).not.toHaveBeenCalled();
            if (mm._diagInterval) clearInterval(mm._diagInterval);
        } finally {
            delete URL.createObjectURL;
            delete URL.revokeObjectURL;
        }
    });

    it('drops a render that resolves after the modal moved on', async () => {
        stubMarkdown();
        let releaseFile = () => {};
        mockFetch((url) => {
            if (!String(url).startsWith('/api/markdown/file'))
                return { ok: true, text: async () => '' };
            return new Promise((resolve) => {
                releaseFile = () =>
                    resolve({ ok: true, text: async () => '<p>stale</p>' });
            });
        });
        const mm = makeMm();
        const open = mm.openFile({ name: 'x.md', path: '/w/x.md' });
        await vi.waitFor(() => expect(releaseFile).toBeTypeOf('function'));
        mm.closeModal();
        releaseFile();
        await open;
        // The guard still holds after the asset plumbing is gone.
        expect(mm.modalBody.innerHTML).toBe('');
    });
});
