// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { installToken } from '../web/auth.js';
import { mountFileView } from '../web/file-viewer.js';

// Preview/document consumers point at the plain same-origin asset endpoint, so
// the browser itself sends the scoped `phi_access_asset` cookie and streams the
// bytes: Range/206, HEAD, PDF.js and media seeking stay native, and nothing is
// buffered into a blob or authenticated by an in-page fetch.

setupDomHarness();

const ASSET = (path) =>
    `/api/file/asset?path=${encodeURIComponent(path)}&cwd=${encodeURIComponent('/project')}`;

afterEach(() => {
    delete window.phiAccessAuth;
    vi.unstubAllGlobals();
});

describe('protected asset addresses', () => {
    it('mounts an image straight from the asset address', async () => {
        vi.stubGlobal(
            'Viewer',
            class {
                destroy() {}
            },
        );
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const container = document.createElement('div');
        const handle = await mountFileView({
            path: 'pic.png',
            cwd: '/project',
            container,
        });
        const img = container.querySelector('img');
        expect(img.getAttribute('src')).toBe(ASSET('pic.png'));
        // Lazy loading is what keeps a directory full of images cheap.
        expect(img.loading).toBe('lazy');
        expect(handle.imageElement).toBe(img);
        expect(fetchSpy).not.toHaveBeenCalled();
        handle.dispose();
        expect(container.innerHTML).toBe('');
    });

    it('mounts media from the asset address without preloading it', async () => {
        vi.stubGlobal(
            'Plyr',
            class {
                destroy() {}
            },
        );
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const container = document.createElement('div');
        const handle = await mountFileView({
            path: 'clip.mp4',
            cwd: '/project',
            container,
        });
        const video = container.querySelector('video');
        // A plain src is what lets the browser issue Range requests and seek.
        expect(video.getAttribute('src')).toBe(ASSET('clip.mp4'));
        expect(video.getAttribute('preload')).toBe('metadata');
        expect(fetchSpy).not.toHaveBeenCalled();
        handle.dispose();
    });

    it('points the PDF wrapper at the asset address', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const container = document.createElement('div');
        const handle = await mountFileView({
            path: 'doc.pdf',
            cwd: '/project',
            container,
        });
        const iframe = container.querySelector('iframe');
        expect(iframe.getAttribute('src')).toBe(
            `vendor/pdfjs/wrapper.html?file=${encodeURIComponent(ASSET('doc.pdf'))}`,
        );
        expect(fetchSpy).not.toHaveBeenCalled();
        handle.dispose();
        expect(iframe.getAttribute('src')).toBeNull();
    });

    it('renders the download control as a real link and never buffers it', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const container = document.createElement('div');
        const handle = await mountFileView({
            path: 'archive.zip',
            cwd: '/project',
            container,
        });
        const link = container.querySelector('a.file-viewer-download-btn');
        expect(link.getAttribute('href')).toBe(ASSET('archive.zip'));
        expect(link.getAttribute('download')).toBe('archive.zip');
        expect(link.textContent).toBe('Download');
        link.click();
        // Clicking leaves the plain address in place: the browser downloads it
        // with the scoped cookie instead of the page fetching every byte.
        expect(link.getAttribute('href')).toBe(ASSET('archive.zip'));
        expect(fetchSpy).not.toHaveBeenCalled();
        handle.dispose();
    });

    it('keeps addresses credential-free in a v2 session', async () => {
        vi.stubGlobal(
            'Viewer',
            class {
                destroy() {}
            },
        );
        installToken('jwt-a');
        const container = document.createElement('div');
        const handle = await mountFileView({
            path: 'pic.png',
            cwd: '/project',
            container,
        });
        const src = container.querySelector('img').getAttribute('src');
        expect(src).toBe(ASSET('pic.png'));
        expect(src).not.toContain('token');
        expect(src.startsWith('blob:')).toBe(false);
        handle.dispose();
    });
});
