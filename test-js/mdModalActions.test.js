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
        vi.stubGlobal(
            'ClipboardItem',
            class {
                constructor(data) {
                    this.data = data;
                }
            },
        );
        vi.stubGlobal('navigator', {
            clipboard: {
                write: vi.fn(async (items) => {
                    await items[0].data['image/png'];
                }),
                writeText: vi.fn(),
            },
        });
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
            'test.png',
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

    it.each(['item', 'write'])(
        'offers an explicit download, never a URL copy, when %s is unavailable',
        async (missing) => {
            const { mm, app } = makeMm();
            if (missing === 'item') vi.stubGlobal('ClipboardItem', undefined);
            else navigator.clipboard.write = undefined;
            const fetcher = vi.fn();
            vi.stubGlobal('fetch', fetcher);
            mm._copyToClipboard = vi.fn();
            mm._downloadFile = vi.fn();
            const url = '/api/file/asset?path=diagram.png';
            await mm._copyImageToClipboard(url, undefined, 'diagram.png');

            expect(fetcher).not.toHaveBeenCalled();
            expect(mm._copyToClipboard).not.toHaveBeenCalled();
            expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
            expect(mm._downloadFile).not.toHaveBeenCalled();
            const [message, options] = app.showToast.mock.calls[0];
            expect(message).toContain('download');
            expect(options.title).toBe('Image not copied');
            expect(options.action.text).toBe('Download Image');
            options.action.callback();
            expect(mm._downloadFile).toHaveBeenCalledWith(url, 'diagram.png');
        },
    );

    it('shows Download Image instead of an impossible copy action', async () => {
        const { mm } = makeMm();
        vi.stubGlobal('ClipboardItem', undefined);
        mm._currentModalContext = {
            kind: 'image',
            url: '/api/file/asset?path=diagram.png',
            name: 'diagram.png',
        };
        mm._downloadFile = vi.fn();
        mm._copyImageToClipboard = vi.fn();
        mm._updateModalActions();
        expect(mm.modalCopyBtn.textContent).toBe('Download Image');
        await mm._onModalPrimaryAction();
        expect(mm._copyImageToClipboard).not.toHaveBeenCalled();
        expect(mm._downloadFile).toHaveBeenCalledWith(
            '/api/file/asset?path=diagram.png',
            'diagram.png',
        );
        mm._openModalDropdown();
        expect(mm.contextMenuEl.querySelector('.copy-image')).toBeNull();
        expect(
            mm.contextMenuEl.querySelector('.download-image'),
        ).not.toBeNull();
    });

    it('does not offer image copying in the inline image menu without clipboard support', () => {
        const { mm } = makeMm();
        vi.stubGlobal('ClipboardItem', undefined);
        mm._currentModalContext = { kind: 'markdown', name: 'Guide.md' };
        mm.modalBody.innerHTML = '<img src="/diagram.png" alt="diagram.png">';
        mm.modalBody.querySelector('img').dispatchEvent(
            new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(mm.contextMenuEl.querySelector('.copy-image')).toBeNull();
        expect(
            mm.contextMenuEl.querySelector('.download-image'),
        ).not.toBeNull();
    });

    it('starts the clipboard write in the click turn, before image loading finishes', async () => {
        const { mm, app } = makeMm();
        let resolveFetch;
        vi.stubGlobal(
            'fetch',
            vi.fn(
                () =>
                    new Promise((resolve) => {
                        resolveFetch = resolve;
                    }),
            ),
        );
        const copying = mm._copyImageToClipboard('/diagram.png');
        expect(navigator.clipboard.write).toHaveBeenCalledTimes(1);
        expect(app.showToast).not.toHaveBeenCalled();
        const png = new Blob(['png'], { type: 'image/png' });
        resolveFetch({ ok: true, blob: async () => png });
        await copying;
        const item = navigator.clipboard.write.mock.calls[0][0][0];
        expect(await item.data['image/png']).toBe(png);
        expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
        expect(app.showToast).toHaveBeenCalledWith(
            'Copied image to clipboard',
            { type: 'info', title: 'Clipboard' },
        );
    });

    it('preserves the clipboard on denied writes and offers the original image, not the next preview', async () => {
        const { mm, app } = makeMm();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                blob: async () => new Blob(['png'], { type: 'image/png' }),
            })),
        );
        navigator.clipboard.write.mockRejectedValue(
            new DOMException('Denied', 'NotAllowedError'),
        );
        mm._copyToClipboard = vi.fn();
        mm._downloadFile = vi.fn();
        await mm._copyImageToClipboard(
            '/original.png',
            undefined,
            'original.png',
        );
        mm._currentModalContext = {
            kind: 'image',
            url: '/other.png',
            name: 'other.png',
        };
        expect(mm._copyToClipboard).not.toHaveBeenCalled();
        expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
        expect(mm._downloadFile).not.toHaveBeenCalled();
        const options = app.showToast.mock.calls[0][1];
        expect(options.title).toBe('Image not copied');
        options.action.callback();
        expect(mm._downloadFile).toHaveBeenCalledWith(
            '/original.png',
            'original.png',
        );
    });

    it('offers a download without touching text when image loading fails', async () => {
        const { mm, app } = makeMm();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: false })),
        );
        mm._copyToClipboard = vi.fn();
        await mm._copyImageToClipboard('/missing.png');
        expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
        expect(mm._copyToClipboard).not.toHaveBeenCalled();
        expect(app.showToast.mock.calls[0][1].action.text).toBe(
            'Download Image',
        );
    });

    it('handles constructor failure even when pending image loading also fails', async () => {
        const { mm, app } = makeMm();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubGlobal(
            'ClipboardItem',
            class {
                constructor() {
                    throw new Error('Clipboard unavailable');
                }
            },
        );
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('Network unavailable');
            }),
        );
        await mm._copyImageToClipboard('/diagram.png');
        expect(navigator.clipboard.write).not.toHaveBeenCalled();
        expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
        expect(app.showToast.mock.calls[0][1].action.text).toBe(
            'Download Image',
        );
    });

    it('converts other image formats to PNG for the clipboard', async () => {
        const { mm } = makeMm();
        const jpeg = new Blob(['jpeg'], { type: 'image/jpeg' });
        const png = new Blob(['png'], { type: 'image/png' });
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, blob: async () => jpeg })),
        );
        mm._convertBlobToPng = vi.fn(async () => png);
        await mm._copyImageToClipboard('/diagram.jpg');
        expect(mm._convertBlobToPng).toHaveBeenCalledWith(jpeg);
        expect(
            await navigator.clipboard.write.mock.calls[0][0][0].data[
                'image/png'
            ],
        ).toBe(png);
    });

    it('uses the captured displayed image when fetching fails', async () => {
        const { mm } = makeMm();
        const original = document.createElement('img');
        const other = document.createElement('img');
        mm._currentFileView = { imageElement: original };
        let resolveFetch;
        vi.stubGlobal(
            'fetch',
            vi.fn(
                () =>
                    new Promise((resolve) => {
                        resolveFetch = resolve;
                    }),
            ),
        );
        mm._canvasToPngBlob = vi.fn(
            async () => new Blob(['png'], { type: 'image/png' }),
        );
        const copying = mm._copyImageToClipboard('/original.png');
        mm._currentFileView = { imageElement: other };
        resolveFetch({ ok: false });
        await copying;
        expect(mm._canvasToPngBlob).toHaveBeenCalledWith(original);
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
