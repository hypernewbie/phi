// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';

// Markdown paste-from-system-clipboard flow.
//
// The manage row's "📋 Paste" button reads text via
// navigator.clipboard.readText(), opens a static modal pre-filled with
// the content (or empty + manual paste if the browser blocked the
// read), and POSTs to /api/markdown/paste. The 409 response path
// transitions Save -> Overwrite without closing the modal, so the
// user can replace an existing file from inside the same flow.

setupDomHarness();

function pasteModalMarkup() {
    // The full static markup the production HTML provides. Each test
    // builds a fresh tree, so the IDs are unique to this document.
    document.body.innerHTML = `
        <div id="md-paste-modal" class="modal-overlay hidden" role="dialog">
            <form id="md-paste-modal-form" class="modal-content md-paste-dialog" novalidate>
                <div class="modal-header">
                    <span id="md-paste-modal-title" class="modal-title">New markdown from clipboard</span>
                    <button type="button" id="md-paste-modal-close" class="md-modal-close">×</button>
                </div>
                <div class="modal-body">
                    <p id="md-paste-modal-hint" class="md-paste-hint"></p>
                    <textarea id="md-paste-modal-content" class="md-paste-textarea"></textarea>
                    <input id="md-paste-modal-name" type="text" class="md-paste-name-input" />
                    <label id="md-paste-modal-dir-label"></label>
                    <div id="md-paste-modal-dir" class="md-paste-dir-field"></div>
                    <div id="md-paste-modal-error" class="md-paste-error" role="alert"></div>
                </div>
                <div class="modal-footer">
                    <button type="button" id="md-paste-modal-cancel" class="btn">Cancel</button>
                    <button type="submit" id="md-paste-modal-save" class="btn btn-accent">Save</button>
                </div>
            </form>
        </div>
        <div id="md-modal-copy-btn"></div>
        <div id="markdown-file-list" class="markdown-file-list"></div>
    `;
}

function makeMm({ dirs = ['./docs'] } = {}) {
    pasteModalMarkup();
    const app = {
        showToast: vi.fn(),
        sessionsManager: { activeCWD: '/test/cwd' },
        markdownDirs: dirs,
    };
    // Prototype-only construction so we don't depend on every DOM id
    // the real constructor looks up; same harness shape as
    // markdownExportImport.test.js.
    const mm = Object.create(MarkdownManager.prototype);
    mm.app = app;
    mm.refreshFiles = vi.fn(async () => {});
    // Hydrate the DOM-bound fields the real constructor would set, so
    // the new methods can read them without going through _setupEventListeners.
    mm.pasteModal = document.getElementById('md-paste-modal');
    mm.pasteModalForm = document.getElementById('md-paste-modal-form');
    mm.pasteModalTitle = document.getElementById('md-paste-modal-title');
    mm.pasteModalHint = document.getElementById('md-paste-modal-hint');
    mm.pasteModalContent = document.getElementById('md-paste-modal-content');
    mm.pasteModalName = document.getElementById('md-paste-modal-name');
    mm.pasteModalDir = document.getElementById('md-paste-modal-dir');
    mm.pasteModalDirLabel = document.getElementById('md-paste-modal-dir-label');
    mm.pasteModalError = document.getElementById('md-paste-modal-error');
    mm.pasteModalCancel = document.getElementById('md-paste-modal-cancel');
    mm.pasteModalSave = document.getElementById('md-paste-modal-save');
    mm.pasteModalClose = document.getElementById('md-paste-modal-close');
    mm._pastePending = false;
    mm._pasteConflict = false;
    // Manually wire the form-submit handler the constructor would have
    // set up; we skipped it on purpose so we don't pull in the rest of
    // MarkdownManager's DOM expectations.
    mm.pasteModalForm.addEventListener('submit', (e) => {
        e.preventDefault();
        mm._submitPaste();
    });
    mm.pasteModalClose.addEventListener('click', () => mm._closePasteModal());
    mm.pasteModalCancel.addEventListener('click', () => mm._closePasteModal());
    mm.pasteModal.addEventListener('click', (e) => {
        if (e.target === mm.pasteModal) mm._closePasteModal();
    });
    mm.pasteModalName.addEventListener('input', () => {
        if (mm._pasteConflict) {
            mm._pasteConflict = false;
            mm.pasteModalSave.textContent = 'Save';
            mm._setPasteError('');
        }
    });
    return { mm, app };
}

function stubClipboard(readTextImpl = async () => '# Hello\n\nbody') {
    const readText = vi.fn(readTextImpl);
    Object.defineProperty(global.navigator, 'clipboard', {
        configurable: true,
        value: { readText },
    });
    return { readText };
}

function defaultName() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `pasted-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.md`;
}

describe('markdown paste-from-system-clipboard', () => {
    let fetchMock;

    beforeEach(() => {
        fetchMock = mockFetch();
    });

    describe('button gating', () => {
        it('does nothing (with toast) when no markdown dirs are configured', async () => {
            const { mm, app } = makeMm({ dirs: [] });
            stubClipboard();
            await mm._pasteFromSystemClipboard();
            expect(fetchMock).not.toHaveBeenCalled();
            expect(app.showToast).toHaveBeenCalledWith(
                expect.stringMatching(/Add a markdown directory/i),
                expect.objectContaining({ type: 'error' })
            );
        });
    });

    describe('happy path', () => {
        it('reads clipboard, opens modal pre-filled, POSTs to /api/markdown/paste on Save', async () => {
            const { mm, app } = makeMm();
            const { readText } = stubClipboard(async () => '# Pasted heading\n\nbody text');
            fetchMock.mockImplementation((url, opts) => {
                if (String(url) === '/api/markdown/paste') {
                    return { ok: true, status: 200, json: async () => ({ name: 'pasted-2026-08-06.md' }) };
                }
                return undefined;
            });

            await mm._pasteFromSystemClipboard();

            // Clipboard read happened exactly once.
            expect(readText).toHaveBeenCalledTimes(1);
            // Modal is open and pre-filled with the clipboard text.
            expect(mm.pasteModal.classList.contains('hidden')).toBe(false);
            expect(mm.pasteModalContent.value).toBe('# Pasted heading\n\nbody text');
            // Hint shows the success path (not the blocked-fallback hint).
            expect(mm.pasteModalHint.textContent).toMatch(/Pasting/);
            // Default filename is the timestamped form.
            expect(mm.pasteModalName.value).toMatch(/^pasted-\d{4}-\d{2}-\d{2}-\d{6}\.md$/);
            // Single configured dir is rendered as plain text (no <select>).
            expect(mm.pasteModalDir.querySelector('select')).toBeNull();
            expect(mm.pasteModalDir.textContent).toBe('./docs');

            // Submit -> fetch, close, refresh, toast.
            mm.pasteModalForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/markdown/paste');
            expect(init.method).toBe('POST');
            const body = JSON.parse(init.body);
            expect(body.cwd).toBe('/test/cwd');
            expect(body.dir).toBe('./docs');
            expect(body.content).toBe('# Pasted heading\n\nbody text');
            expect(body.overwrite).toBe(false);
            expect(body.name).toMatch(/^pasted-/);
            expect(mm.pasteModal.classList.contains('hidden')).toBe(true);
            expect(mm.refreshFiles).toHaveBeenCalledTimes(1);
            expect(app.showToast).toHaveBeenCalledWith(
                expect.stringMatching(/Pasted as "pasted-2026-08-06\.md"/),
                expect.objectContaining({ type: 'info' })
            );
        });

        it('renders a <select> when more than one markdown dir is configured', async () => {
            const { mm } = makeMm({ dirs: ['./docs', './notes'] });
            stubClipboard(async () => 'x');
            await mm._pasteFromSystemClipboard();
            const select = mm.pasteModalDir.querySelector('select');
            expect(select).not.toBeNull();
            expect(select.querySelectorAll('option').length).toBe(2);
            expect(mm.pasteModalDirLabel.textContent).toMatch(/2 configured/);
        });

        it('appends .md to a filename without the extension', async () => {
            const { mm } = makeMm();
            stubClipboard(async () => 'x');
            await mm._pasteFromSystemClipboard();
            // User types a name without .md
            mm.pasteModalName.value = 'meeting-notes';
            fetchMock.mockReturnValue({ ok: true, status: 200, json: async () => ({ name: 'meeting-notes.md' }) });
            mm.pasteModalForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await Promise.resolve();
            await Promise.resolve();
            const body = JSON.parse(fetchMock.mock.calls[0][1].body);
            expect(body.name).toBe('meeting-notes.md');
        });

        it('uses the server-returned normalized name in the success toast', async () => {
            const { mm, app } = makeMm();
            stubClipboard(async () => 'x');
            await mm._pasteFromSystemClipboard();
            fetchMock.mockReturnValue({ ok: true, status: 200, json: async () => ({ name: 'meeting.md' }) });
            mm.pasteModalForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(app.showToast).toHaveBeenCalledWith(
                expect.stringMatching(/Pasted as "meeting\.md"/),
                expect.anything()
            );
        });
    });

    describe('clipboard blocked / empty', () => {
        it('opens the modal with empty textarea + fallback hint when readText throws', async () => {
            const { mm } = makeMm();
            stubClipboard(async () => { throw new Error('permission denied'); });
            await mm._pasteFromSystemClipboard();
            expect(mm.pasteModal.classList.contains('hidden')).toBe(false);
            expect(mm.pasteModalContent.value).toBe('');
            expect(mm.pasteModalHint.textContent).toMatch(/blocked/i);
        });

        it('opens the modal with empty textarea + empty hint when readText returns ""', async () => {
            const { mm } = makeMm();
            stubClipboard(async () => '');
            await mm._pasteFromSystemClipboard();
            expect(mm.pasteModal.classList.contains('hidden')).toBe(false);
            expect(mm.pasteModalContent.value).toBe('');
            expect(mm.pasteModalHint.textContent).toMatch(/empty/i);
        });

        it('opens the modal when navigator.clipboard is undefined (insecure context)', async () => {
            const { mm } = makeMm();
            Object.defineProperty(global.navigator, 'clipboard', {
                configurable: true,
                value: undefined,
            });
            await mm._pasteFromSystemClipboard();
            expect(mm.pasteModal.classList.contains('hidden')).toBe(false);
            expect(mm.pasteModalContent.value).toBe('');
            expect(mm.pasteModalHint.textContent).toMatch(/blocked/i);
        });
    });

    describe('validation', () => {
        beforeEach(() => {
            stubClipboard(async () => 'actual content');
        });

        it('rejects empty content with inline error (no POST)', async () => {
            const { mm } = makeMm();
            await mm._pasteFromSystemClipboard();
            // Erase the clipboard-prefilled content.
            mm.pasteModalContent.value = '   ';
            mm.pasteModalForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            expect(fetchMock).not.toHaveBeenCalled();
            expect(mm.pasteModalError.textContent).toMatch(/Content is empty/);
            // Modal stays open.
            expect(mm.pasteModal.classList.contains('hidden')).toBe(false);
        });

        it('rejects empty filename with inline error (no POST)', async () => {
            const { mm } = makeMm();
            await mm._pasteFromSystemClipboard();
            mm.pasteModalName.value = '';
            mm.pasteModalForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            expect(fetchMock).not.toHaveBeenCalled();
            expect(mm.pasteModalError.textContent).toMatch(/Filename is required/);
        });

        it('rejects filenames with path separators with inline error (no POST)', async () => {
            const { mm } = makeMm();
            await mm._pasteFromSystemClipboard();
            mm.pasteModalName.value = '../escape/notes';
            mm.pasteModalForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            expect(fetchMock).not.toHaveBeenCalled();
            expect(mm.pasteModalError.textContent).toMatch(/path separators/);
        });
    });

    describe('409 overwrite transition', () => {
        it('first 409: button becomes Overwrite + inline conflict; second submit carries overwrite:true', async () => {
            const { mm, app } = makeMm();
            stubClipboard(async () => 'x');
            await mm._pasteFromSystemClipboard();
            // First POST -> 409 (file exists, overwrite:false was sent).
            fetchMock.mockReturnValueOnce({ ok: false, status: 409, text: async () => 'File already exists' });
            mm.pasteModalForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            // No refresh yet, no success toast.
            expect(mm.refreshFiles).not.toHaveBeenCalled();
            expect(app.showToast).not.toHaveBeenCalledWith(
                expect.stringMatching(/Pasted as/),
                expect.anything()
            );
            // Modal stays open; button label changed; inline error set.
            expect(mm.pasteModal.classList.contains('hidden')).toBe(false);
            expect(mm.pasteModalSave.textContent).toBe('Overwrite');
            expect(mm.pasteModalError.textContent).toMatch(/already exists/);
            // First call had overwrite:false.
            const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
            expect(firstBody.overwrite).toBe(false);

            // Second POST -> 200. overwrite:true this time.
            fetchMock.mockReturnValueOnce({ ok: true, status: 200, json: async () => ({ name: 'pasted-2026-08-06.md' }) });
            mm.pasteModalForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
            expect(secondBody.overwrite).toBe(true);
            expect(mm.pasteModal.classList.contains('hidden')).toBe(true);
            expect(mm.refreshFiles).toHaveBeenCalledTimes(1);
        });

        it('changing the filename clears the overwrite transition (next submit is overwrite:false again)', async () => {
            const { mm } = makeMm();
            stubClipboard(async () => 'x');
            await mm._pasteFromSystemClipboard();
            fetchMock.mockReturnValueOnce({ ok: false, status: 409, text: async () => 'File already exists' });
            mm.pasteModalForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await Promise.resolve();
            await Promise.resolve();
            expect(mm.pasteModalSave.textContent).toBe('Overwrite');

            // User edits the filename.
            mm.pasteModalName.value = 'fresh-name.md';
            mm.pasteModalName.dispatchEvent(new Event('input', { bubbles: true }));
            expect(mm.pasteModalSave.textContent).toBe('Save');
            expect(mm._pasteConflict).toBe(false);
            expect(mm.pasteModalError.textContent).toBe('');

            // Next submit: overwrite:false again.
            fetchMock.mockReturnValueOnce({ ok: true, status: 200, json: async () => ({ name: 'fresh-name.md' }) });
            mm.pasteModalForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await Promise.resolve();
            await Promise.resolve();
            const body = JSON.parse(fetchMock.mock.calls[1][1].body);
            expect(body.overwrite).toBe(false);
            expect(body.name).toBe('fresh-name.md');
        });
    });

    describe('server error', () => {
        it('non-409 server error: modal stays open, inline error set, Save re-enabled', async () => {
            const { mm } = makeMm();
            stubClipboard(async () => 'x');
            await mm._pasteFromSystemClipboard();
            fetchMock.mockReturnValue({ ok: false, status: 500, text: async () => 'internal error' });
            mm.pasteModalForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await Promise.resolve();
            await Promise.resolve();
            expect(mm.pasteModal.classList.contains('hidden')).toBe(false);
            expect(mm.pasteModalError.textContent).toMatch(/internal error/);
            expect(mm.pasteModalSave.disabled).toBe(false);
        });
    });

    describe('cancel / close', () => {
        it('cancel button closes the modal without POSTing', async () => {
            const { mm } = makeMm();
            stubClipboard(async () => 'x');
            await mm._pasteFromSystemClipboard();
            mm.pasteModalCancel.click();
            expect(mm.pasteModal.classList.contains('hidden')).toBe(true);
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });

    describe('double-submit guard', () => {
        it('a second submit while pending is a no-op (only one POST)', async () => {
            const { mm } = makeMm();
            stubClipboard(async () => 'x');
            await mm._pasteFromSystemClipboard();
            // Make the first POST hang.
            let resolveFirst;
            fetchMock.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));
            mm.pasteModalForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            // Second submit while the first is still pending.
            mm.pasteModalForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            expect(fetchMock).toHaveBeenCalledTimes(1);
            // Resolve and let microtasks run.
            resolveFirst({ ok: true, status: 200, json: async () => ({ name: 'x.md' }) });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            // Still only one call.
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });
});