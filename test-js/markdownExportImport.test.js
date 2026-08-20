// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';

// Markdown bundle export/import via clipboard. The frontend posts to
// /api/markdown/export-bundle and copies the resulting PHIMD: blob
// (server-side gzip + base64) to the clipboard. Import reads from
// clipboard, validates the prefix, posts to
// /api/markdown/import-bundle, then refreshes the file list.

setupDomHarness();

// Install a navigator.clipboard stub that jsdom ships empty. Each test
// customizes the readText/writeText fn via resetClipboard().
function stubClipboard() {
    const writeText = vi.fn(async () => {});
    const readText = vi.fn(async () => '');
    Object.defineProperty(global.navigator, 'clipboard', {
        configurable: true,
        value: { writeText, readText },
    });
    return { writeText, readText };
}

function makeMm() {
    document.body.innerHTML = `
        <div id="md-modal-copy-btn"></div>
        <div id="markdown-file-list" class="markdown-file-list"></div>
    `;
    const app = {
        showToast: vi.fn(),
        sessionsManager: { activeCWD: '/test/cwd' },
    };
    // Construct via prototype to avoid the real constructor's
    // _setupEventListeners, which would crash on missing modalClose
    // / modal / modalCopyBtn elements that aren't relevant to
    // these tests.
    const mm = Object.create(MarkdownManager.prototype);
    mm.app = app;
    mm.refreshFiles = vi.fn(async () => {});
    return { mm, app };
}

function fakeResponse(body, opts = {}) {
    return {
        ok: opts.ok ?? true,
        status: opts.status ?? 200,
        headers: { get: () => null },
        json: async () => body,
        text: async () => opts.text ?? '',
    };
}

describe('markdown bundle export', () => {
    let clipboard;

    beforeEach(() => {
        clipboard = stubClipboard();
        global.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('exports: POSTs to /api/markdown/export-bundle and copies the PHIMD blob to clipboard', async () => {
        const blob = 'PHIMD:abcdef1234567890:ZmFrZS1iNjQ=';
        global.fetch.mockResolvedValue(fakeResponse({ blob, count: 5 }));

        const { mm, app } = makeMm();
        await mm._exportMarkdownBundle();

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe('/api/markdown/export-bundle');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ cwd: '/test/cwd' });
        // The blob must have landed in the clipboard.
        expect(clipboard.writeText).toHaveBeenCalledWith(blob);
        expect(app.showToast).toHaveBeenCalledWith(
            expect.stringMatching(/Exported 5 markdown files/),
            expect.objectContaining({ type: 'info' }),
        );
    });

    it('exports: "no markdown files to export" toast when server returns empty blob', async () => {
        global.fetch.mockResolvedValue(fakeResponse({ blob: '', count: 0 }));

        const { mm, app } = makeMm();
        await mm._exportMarkdownBundle();

        expect(clipboard.writeText).not.toHaveBeenCalled();
        expect(app.showToast).toHaveBeenCalledWith(
            'No markdown files to export',
            expect.objectContaining({ type: 'info' }),
        );
    });

    it('exports: surfaces server-side errors via toast (no clipboard call)', async () => {
        global.fetch.mockResolvedValue(
            fakeResponse(
                {},
                { ok: false, status: 500, text: 'internal error' },
            ),
        );

        const { mm, app } = makeMm();
        await mm._exportMarkdownBundle();

        expect(clipboard.writeText).not.toHaveBeenCalled();
        expect(app.showToast).toHaveBeenCalledWith(
            expect.stringMatching(/Export failed.*500/),
            expect.objectContaining({ type: 'error' }),
        );
    });
});

describe('markdown bundle import', () => {
    let clipboard;
    let refreshSpy;

    beforeEach(() => {
        clipboard = stubClipboard();
        clipboard.readText.mockResolvedValue(
            'PHIMD:abcdef1234567890:ZmFrZS1iNjQ=',
        );
        global.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function makeMmWith(confirmImpl) {
        const ctx = makeMm();
        refreshSpy = ctx.mm.refreshFiles;
        global.confirm = confirmImpl;
        return ctx;
    }

    it('imports: reads clipboard, posts PHIMD blob with overwrite=false (safe default)', async () => {
        const blob = 'PHIMD:abcdef1234567890:ZmFrZS1iNjQ=';
        clipboard.readText.mockResolvedValue(blob);
        global.confirm = () => false; // user says: skip existing (safe default)

        global.fetch.mockResolvedValue(
            fakeResponse({ written: ['alpha.md', 'beta.md'], skipped: [] }),
        );

        const { mm, app } = makeMmWith(() => false);
        await mm._importMarkdownBundle();

        // Two fetches? No — only the import endpoint should be hit. Verify.
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe('/api/markdown/import-bundle');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body).blob).toBe(blob);
        expect(JSON.parse(init.body).overwrite).toBe(false);
        // File list must refresh after a successful import.
        expect(refreshSpy).toHaveBeenCalledWith({ force: true });
        expect(app.showToast).toHaveBeenCalledWith(
            expect.stringMatching(/Imported 2/),
            expect.any(Object),
        );
    });

    it('imports: overwrite flag mirrors confirm() callback result', async () => {
        global.confirm = () => true; // user says: overwrite
        global.fetch.mockResolvedValue(
            fakeResponse({ written: ['x.md'], skipped: [] }),
        );

        const { mm } = makeMmWith(() => true);
        await mm._importMarkdownBundle();

        expect(JSON.parse(global.fetch.mock.calls[0][1].body).overwrite).toBe(
            true,
        );
    });

    it('imports: rejects non-PHIMD clipboard text without hitting the server', async () => {
        clipboard.readText.mockResolvedValue('PHICONFIG:abc:def');

        const { mm, app } = makeMmWith(() => false);
        await mm._importMarkdownBundle();

        expect(global.fetch).not.toHaveBeenCalled();
        expect(app.showToast).toHaveBeenCalledWith(
            expect.stringMatching(/does not contain a markdown bundle/),
            expect.objectContaining({ type: 'error' }),
        );
    });

    it('imports: falls back to prompt() when clipboard read returns empty', async () => {
        clipboard.readText.mockResolvedValue('');
        // After an empty clipboard read, code falls through to prompt().
        const origPrompt = global.prompt;
        let prompted = false;
        global.prompt = (msg) => {
            prompted = true;
            return 'PHIMD:fromprompt:aGVsbG8=';
        };

        global.fetch.mockResolvedValue(
            fakeResponse({ written: ['a.md'], skipped: [] }),
        );

        const { mm } = makeMmWith(() => false);
        await mm._importMarkdownBundle();

        expect(prompted).toBe(true);
        expect(JSON.parse(global.fetch.mock.calls[0][1].body).blob).toMatch(
            /^PHIMD:fromprompt:/,
        );
        global.prompt = origPrompt;
    });

    it('imports: shows info toast (no error) when clipboard is empty AND user cancels prompt', async () => {
        clipboard.readText.mockResolvedValue('');
        global.prompt = () => null; // cancel prompt

        const { mm, app } = makeMmWith(() => false);
        await mm._importMarkdownBundle();

        expect(global.fetch).not.toHaveBeenCalled();
        expect(app.showToast).toHaveBeenCalledWith(
            'No bundle text to import',
            expect.objectContaining({ type: 'info' }),
        );
    });

    it('imports: surfaces server-side decode errors as an error toast', async () => {
        global.fetch.mockResolvedValue(
            fakeResponse(
                {},
                {
                    ok: false,
                    status: 400,
                    text: 'bundle signature verification failed',
                },
            ),
        );

        const { mm, app } = makeMmWith(() => false);
        await mm._importMarkdownBundle();

        expect(app.showToast).toHaveBeenCalledWith(
            expect.stringMatching(/Import failed.*signature/),
            expect.objectContaining({ type: 'error' }),
        );
    });

    it('imports: reports skipped count in the toast when server skips files', async () => {
        global.fetch.mockResolvedValue(
            fakeResponse({
                written: ['a.md'],
                skipped: ['b.md: already exists', 'c.md: invalid name'],
            }),
        );

        const { mm, app } = makeMmWith(() => false);
        await mm._importMarkdownBundle();

        expect(app.showToast).toHaveBeenCalledWith(
            expect.stringMatching(/Imported 1.*skipped 2/),
            expect.any(Object),
        );
    });
});
