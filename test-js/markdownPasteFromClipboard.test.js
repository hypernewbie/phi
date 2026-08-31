// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';

// Markdown single-file copy/paste via header "# temp/A.md"
//
// Copy: right-click -> Copy to clipboard puts "# rel/path.md\n<content>" on clipboard.
// Paste: Bottom "📋 Paste" reads clipboard, parses first line "# rel/path.md",
// splits into dir/name, POSTs to /api/markdown/paste. On 409 it confirms
// overwrite. If the target dir is missing the backend returns 400.

setupDomHarness();

function makeMm({ dirs = ['./docs'] } = {}) {
    document.body.innerHTML = `
        <div id="md-modal-copy-btn"></div>
        <div id="markdown-file-list" class="markdown-file-list"></div>
        <div id="md-modal" class="hidden"></div>
        <div id="md-modal-title"></div>
        <div id="md-modal-body"></div>
        <button id="md-modal-close"></button>
        <div id="md-paste-modal" class="modal-overlay hidden"><form id="md-paste-modal-form"><textarea id="md-paste-modal-content"></textarea><input id="md-paste-modal-name"/><div id="md-paste-modal-dir"></div><div id="md-paste-modal-error"></div><button id="md-paste-modal-save"></button><button id="md-paste-modal-close"></button><button id="md-paste-modal-cancel"></button><div id="md-paste-modal-hint"></div><label id="md-paste-modal-dir-label"></label></form></div>
    `;
    const app = {
        showToast: vi.fn(),
        sessionsManager: { activeCWD: '/test/cwd' },
        markdownDirs: dirs,
    };
    const mm = Object.create(MarkdownManager.prototype);
    mm.app = app;
    mm.refreshFiles = vi.fn(async () => {});
    // minimal fields some methods touch
    mm._pastePending = false;
    mm._pasteConflict = false;
    mm.pasteModal = document.getElementById('md-paste-modal');
    mm.pasteModalForm = document.getElementById('md-paste-modal-form');
    mm.pasteModalContent = document.getElementById('md-paste-modal-content');
    mm.pasteModalName = document.getElementById('md-paste-modal-name');
    mm.pasteModalDir = document.getElementById('md-paste-modal-dir');
    mm.pasteModalDirLabel = document.getElementById('md-paste-modal-dir-label');
    mm.pasteModalError = document.getElementById('md-paste-modal-error');
    mm.pasteModalSave = document.getElementById('md-paste-modal-save');
    mm.pasteModalClose = document.getElementById('md-paste-modal-close');
    mm.pasteModalCancel = document.getElementById('md-paste-modal-cancel');
    mm.pasteModalHint = document.getElementById('md-paste-modal-hint');
    mm.fileListEl = document.getElementById('markdown-file-list');
    mm.modal = document.getElementById('md-modal');
    mm.modalTitle = document.getElementById('md-modal-title');
    mm.modalBody = document.getElementById('md-modal-body');
    mm.modalCopyBtn = document.getElementById('md-modal-copy-btn');
    mm.modalClose = document.getElementById('md-modal-close');
    mm.refreshRequestId = 0;
    mm._lastRenderedKey = '';
    return { mm, app };
}

function stubClipboard(readTextImpl = async () => '# temp/A.md\nbody') {
    const readText = vi.fn(readTextImpl);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(global.navigator, 'clipboard', {
        configurable: true,
        value: { readText, writeText },
    });
    return { readText, writeText };
}

describe('markdown paste-from-system-clipboard', () => {
    let fetchMock;

    beforeEach(() => {
        fetchMock = mockFetch();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('button gating', () => {
        it('does nothing (with toast) when no markdown dirs are configured', async () => {
            const { mm, app } = makeMm({ dirs: [] });
            stubClipboard();
            await mm._pasteFromSystemClipboard();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(app.showToast).toHaveBeenCalledWith(
                expect.stringMatching(/Add a markdown directory/i),
                expect.objectContaining({ type: 'error' }),
            );
        });
    });

    describe('happy path', () => {
        it('reads clipboard header, splits dir/name, POSTs to /api/markdown/paste and toasts', async () => {
            const { mm, app } = makeMm();
            stubClipboard(
                async () => '# temp/A.md\n# Pasted heading\n\nbody text',
            );
            fetchMock.mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({ name: 'A.md' }),
                text: async () => '',
            });

            await mm._pasteFromSystemClipboard();

            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/markdown/paste');
            expect(init.method).toBe('POST');
            const body = JSON.parse(init.body);
            expect(body.cwd).toBe('/test/cwd');
            expect(body.dir).toBe('temp');
            expect(body.name).toBe('A.md');
            expect(body.content).toBe('# Pasted heading\n\nbody text');
            expect(body.overwrite).toBe(false);
            expect(mm.refreshFiles).toHaveBeenCalledTimes(1);
            expect(app.showToast).toHaveBeenCalledWith(
                expect.stringMatching(/Pasted to "temp\/A\.md"/),
                expect.objectContaining({ type: 'info' }),
            );
        });

        it('strips leading ./ from header', async () => {
            const { mm } = makeMm();
            stubClipboard(async () => '# ./temp/A.md\nhello');
            fetchMock.mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({}),
                text: async () => '',
            });
            await mm._pasteFromSystemClipboard();
            const body = JSON.parse(fetchMock.mock.calls[0][1].body);
            expect(body.dir).toBe('temp');
            expect(body.name).toBe('A.md');
        });

        it('handles header without dir (root file)', async () => {
            const { mm } = makeMm();
            stubClipboard(async () => '# notes.md\ncontent');
            fetchMock.mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({}),
                text: async () => '',
            });
            await mm._pasteFromSystemClipboard();
            const body = JSON.parse(fetchMock.mock.calls[0][1].body);
            expect(body.dir).toBe('.');
            expect(body.name).toBe('notes.md');
        });

        it('appends .md if header lacks extension', async () => {
            const { mm } = makeMm();
            stubClipboard(async () => '# temp/notes\ncontent');
            fetchMock.mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({}),
                text: async () => '',
            });
            await mm._pasteFromSystemClipboard();
            const body = JSON.parse(fetchMock.mock.calls[0][1].body);
            expect(body.name).toBe('notes.md');
            expect(body.dir).toBe('temp');
        });
    });

    describe('clipboard blocked / empty', () => {
        it('toasts when readText throws', async () => {
            const { mm, app } = makeMm();
            stubClipboard(async () => {
                throw new Error('permission denied');
            });
            await mm._pasteFromSystemClipboard();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(app.showToast).toHaveBeenCalledWith(
                expect.stringMatching(/Failed to read clipboard/i),
                expect.objectContaining({ type: 'error' }),
            );
        });

        it('toasts when clipboard is empty', async () => {
            const { mm, app } = makeMm();
            stubClipboard(async () => '   ');
            await mm._pasteFromSystemClipboard();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(app.showToast).toHaveBeenCalledWith(
                expect.stringMatching(/Clipboard is empty/i),
                expect.objectContaining({ type: 'error' }),
            );
        });

        it('toasts when clipboard is undefined (insecure context)', async () => {
            const { mm, app } = makeMm();
            Object.defineProperty(global.navigator, 'clipboard', {
                configurable: true,
                value: undefined,
            });
            await mm._pasteFromSystemClipboard();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(app.showToast).toHaveBeenCalledWith(
                expect.stringMatching(/Clipboard API not available/i),
                expect.objectContaining({ type: 'error' }),
            );
        });
    });

    describe('validation', () => {
        it('rejects header not starting with "# " (no POST)', async () => {
            const { mm, app } = makeMm();
            stubClipboard(async () => 'temp/A.md\ncontent');
            await mm._pasteFromSystemClipboard();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(app.showToast).toHaveBeenCalledWith(
                expect.stringMatching(/# path\/to\/file\.md/i),
                expect.objectContaining({ type: 'error' }),
            );
        });

        it('rejects empty header path (no POST)', async () => {
            const { mm, app } = makeMm();
            stubClipboard(async () => '#   \ncontent');
            await mm._pasteFromSystemClipboard();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(app.showToast).toHaveBeenCalledWith(
                expect.stringMatching(/Invalid path/i),
                expect.objectContaining({ type: 'error' }),
            );
        });
    });

    describe('409 overwrite', () => {
        it('first 409 with confirm true -> retries with overwrite:true', async () => {
            const { mm, app } = makeMm();
            stubClipboard(async () => '# temp/A.md\nhello');
            fetchMock
                .mockResolvedValueOnce({
                    ok: false,
                    status: 409,
                    text: async () => 'File already exists',
                })
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({}),
                    text: async () => '',
                });
            global.confirm = vi.fn(() => true);

            await mm._pasteFromSystemClipboard();

            expect(fetchMock).toHaveBeenCalledTimes(2);
            const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
            expect(firstBody.overwrite).toBe(false);
            const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
            expect(secondBody.overwrite).toBe(true);
            expect(app.showToast).toHaveBeenCalledWith(
                expect.stringMatching(/Pasted to/),
                expect.anything(),
            );
        });

        it('first 409 with confirm false -> no retry', async () => {
            const { mm, app } = makeMm();
            stubClipboard(async () => '# temp/A.md\nhello');
            fetchMock.mockResolvedValueOnce({
                ok: false,
                status: 409,
                text: async () => 'File already exists',
            });
            global.confirm = vi.fn(() => false);

            await mm._pasteFromSystemClipboard();

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(app.showToast).not.toHaveBeenCalledWith(
                expect.stringMatching(/Pasted to/),
                expect.anything(),
            );
        });
    });

    describe('server error', () => {
        it('non-409 server error toasts Paste failed', async () => {
            const { mm, app } = makeMm();
            stubClipboard(async () => '# temp/A.md\nhello');
            fetchMock.mockResolvedValue({
                ok: false,
                status: 400,
                text: async () => 'Directory does not exist: temp',
            });
            await mm._pasteFromSystemClipboard();
            expect(app.showToast).toHaveBeenCalledWith(
                expect.stringMatching(/Paste failed.*Directory does not exist/),
                expect.objectContaining({ type: 'error' }),
            );
        });
    });
});
