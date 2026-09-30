// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';

setupDomHarness();

function stubModalDom() {
    const ids = [
        'markdown-file-list',
        'md-modal',
        'md-modal-title',
        'md-modal-body',
        'md-modal-close',
        'md-modal-actions',
        'md-modal-btn-group',
        'md-modal-copy-btn',
        'md-modal-dropdown-btn',
    ];
    for (const id of ids) {
        if (!document.getElementById(id)) {
            const el =
                id === 'md-modal-copy-btn' || id === 'md-modal-dropdown-btn'
                    ? document.createElement('button')
                    : document.createElement('div');
            el.id = id;
            document.body.appendChild(el);
        }
    }
}

function makeMm() {
    stubModalDom();
    const app = {
        showToast: vi.fn(),
        markdownDirs: [],
        sessionsManager: { activeCWD: '/workspace' },
        tabManager: {
            getActiveTab: () => ({ coder: 'claude' }),
            adjustInputHeight: vi.fn(),
        },
    };
    const mm = new MarkdownManager(app);
    return { mm, app };
}

describe('md-modal context-aware actions', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('updates action button labels according to modal context file kind', () => {
        const { mm } = makeMm();

        // Default / null
        mm._currentModalContext = null;
        mm._updateModalActions();
        expect(mm.modalCopyBtn.textContent).toBe('Copy Markdown');

        // Image kind
        mm._currentModalContext = {
            kind: 'image',
            path: 'assets/logo.png',
            name: 'logo.png',
            cwd: '/workspace',
        };
        mm._updateModalActions();
        expect(mm.modalCopyBtn.textContent).toBe('Copy Image');
        expect(mm.modalCopyBtn.title).toBe('Copy image to clipboard');
        expect(mm.modalDropdownBtn.style.display).toBe('');

        // Code kind
        mm._currentModalContext = {
            kind: 'code',
            path: 'src/main.rs',
            name: 'main.rs',
            cwd: '/workspace',
        };
        mm._updateModalActions();
        expect(mm.modalCopyBtn.textContent).toBe('Copy Code');

        // JSON kind
        mm._currentModalContext = {
            kind: 'json',
            path: 'data.json',
            name: 'data.json',
            cwd: '/workspace',
        };
        mm._updateModalActions();
        expect(mm.modalCopyBtn.textContent).toBe('Copy JSON');

        // Video / Audio / PDF / Download
        for (const kind of ['video', 'audio', 'pdf', 'download']) {
            mm._currentModalContext = {
                kind,
                path: `file.${kind}`,
                name: `file.${kind}`,
                cwd: '/workspace',
            };
            mm._updateModalActions();
            expect(mm.modalCopyBtn.textContent).toBe('Download');
        }

        // Diag kind hides actions
        mm._currentModalContext = { kind: 'diag', name: 'Diagnostics' };
        mm._updateModalActions();
        expect(mm.modalActions.style.display).toBe('none');
    });

    it('dispatches primary action according to file kind', async () => {
        const { mm } = makeMm();
        mm._copyImageToClipboard = vi.fn();
        mm._copyToClipboard = vi.fn();
        mm._downloadFile = vi.fn();

        // Image primary action calls _copyImageToClipboard
        mm._currentModalContext = {
            kind: 'image',
            url: '/api/file/asset?path=test.png',
            name: 'test.png',
        };
        await mm._onModalPrimaryAction();
        expect(mm._copyImageToClipboard).toHaveBeenCalledWith(
            '/api/file/asset?path=test.png',
            'Copied image to clipboard',
        );

        // Code primary action copies raw text
        mm._currentModalContext = { kind: 'code', name: 'test.ts' };
        mm.currentRawContent = 'const x = 1;';
        await mm._onModalPrimaryAction();
        expect(mm._copyToClipboard).toHaveBeenCalledWith(
            'const x = 1;',
            'Copied code to clipboard',
        );

        // Download primary action triggers file download
        mm._currentModalContext = {
            kind: 'pdf',
            url: '/api/file/asset?path=doc.pdf',
            name: 'doc.pdf',
        };
        await mm._onModalPrimaryAction();
        expect(mm._downloadFile).toHaveBeenCalledWith(
            '/api/file/asset?path=doc.pdf',
            'doc.pdf',
        );
    });

    it('opens dropdown with rich actions for images and relative paths', () => {
        const { mm } = makeMm();
        mm._currentModalContext = {
            kind: 'image',
            path: '/workspace/docs/diagram.png',
            name: 'diagram.png',
            cwd: '/workspace',
            url: '/api/file/asset?path=docs/diagram.png',
        };

        mm._openModalDropdown();
        expect(mm.contextMenuEl.classList.contains('hidden')).toBe(false);

        const actions = Array.from(
            mm.contextMenuEl.querySelectorAll('.md-context-action'),
        );
        const labels = actions.map(
            (a) => a.querySelector('.md-context-label')?.textContent,
        );

        expect(labels).toContain('Copy Image');
        expect(labels).toContain('Copy Markdown Embed');
        expect(labels).toContain('Copy Relative Path');
        expect(labels).toContain('Download Image');
    });

    it('shows context menu on image right-click inside modal body', () => {
        const { mm } = makeMm();
        mm._openModalDropdown = vi.fn();

        mm._currentModalContext = { kind: 'image', path: 'img.png' };

        const event = new MouseEvent('contextmenu', {
            clientX: 100,
            clientY: 150,
            bubbles: true,
            cancelable: true,
        });

        mm.modalBody.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(mm._openModalDropdown).toHaveBeenCalledWith(undefined, {
            x: 100,
            y: 150,
        });
    });

    it('gracefully falls back to copying image URL when ClipboardItem is unavailable', async () => {
        const { mm, app } = makeMm();
        const originalClipboardItem = window.ClipboardItem;
        try {
            // Simulate insecure HTTP context where ClipboardItem is undefined
            delete window.ClipboardItem;

            const fakeBlob = new Blob(['image data'], { type: 'image/png' });
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                blob: () => Promise.resolve(fakeBlob),
            });

            mm._copyToClipboard = vi.fn();

            await mm._copyImageToClipboard(
                'http://charon.local:7070/assets/logo.png',
            );

            expect(mm._copyToClipboard).toHaveBeenCalledWith(
                'http://charon.local:7070/assets/logo.png',
                expect.stringContaining('Copied image URL instead'),
            );
            expect(app.showToast).not.toHaveBeenCalledWith(
                expect.stringContaining(
                    'Image clipboard copying is not supported',
                ),
                expect.anything(),
            );
        } finally {
            if (originalClipboardItem) {
                window.ClipboardItem = originalClipboardItem;
            }
        }
    });

    it('shows Toast with title "Error" instead of "Couldn\'t open session" for generic errors', async () => {
        const { App } = await import('../web/app.js');
        const app = Object.create(App.prototype);
        app.showToast('Something went wrong', { type: 'error' });

        const toast = document.querySelector('.toast-error');
        expect(toast).not.toBeNull();
        const titleEl = toast?.querySelector('.toast-title');
        expect(titleEl?.textContent).toBe('Error');
        expect(titleEl?.textContent).not.toBe("Couldn't open session");
    });
});
