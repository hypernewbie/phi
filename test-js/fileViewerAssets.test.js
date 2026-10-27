// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { mountFileView } from '../web/file-viewer.js';

// A v2 bearer session has no cookie, so the file viewer cannot point an <img>,
// media element, PDF iframe, or download link at the protected asset endpoint.
// The auth bridge fetches the bytes and the viewer mounts the object URL.

setupDomHarness();

const REVOKE = vi.fn();

function stubBridge() {
    window.phiAccessAuth = {
        installToken: () => true,
        getAccessToken: () => 'jwt-a',
        webSocketURL: (url) => url,
        assetURL: vi.fn(async (url) => ({
            url: `blob:phi/${encodeURIComponent(String(url))}`,
            revoke: REVOKE,
        })),
    };
    return window.phiAccessAuth.assetURL;
}

afterEach(() => {
    delete window.phiAccessAuth;
    REVOKE.mockClear();
});

describe('authenticated file previews', () => {
    it('mounts an image from the authenticated address and releases it', async () => {
        vi.stubGlobal(
            'Viewer',
            class {
                destroy() {}
            },
        );
        const assetURL = stubBridge();
        const container = document.createElement('div');
        const handle = await mountFileView({
            path: 'pic.png',
            cwd: '/project',
            container,
        });
        const img = container.querySelector('img');
        expect(assetURL).toHaveBeenCalledWith(
            '/api/file/asset?path=pic.png&cwd=%2Fproject',
        );
        expect(img.getAttribute('src')).toBe(
            `blob:phi/${encodeURIComponent('/api/file/asset?path=pic.png&cwd=%2Fproject')}`,
        );
        expect(handle.imageElement).toBe(img);
        handle.dispose();
        expect(REVOKE).toHaveBeenCalledTimes(1);
    });

    it('mounts a download link from the authenticated address and releases it', async () => {
        stubBridge();
        const container = document.createElement('div');
        const handle = await mountFileView({
            path: 'archive.zip',
            cwd: '/project',
            container,
        });
        const link = container.querySelector('a.file-viewer-download-btn');
        expect(link.getAttribute('href')).toBe(
            `blob:phi/${encodeURIComponent('/api/file/asset?path=archive.zip&cwd=%2Fproject')}`,
        );
        expect(link.getAttribute('download')).toBe('archive.zip');
        handle.dispose();
        expect(REVOKE).toHaveBeenCalledTimes(1);
    });

    it('keeps the plain address when the page has no auth bridge', async () => {
        const container = document.createElement('div');
        const handle = await mountFileView({
            path: 'archive.zip',
            cwd: '/project',
            container,
        });
        const link = container.querySelector('a.file-viewer-download-btn');
        expect(link.getAttribute('href')).toBe(
            '/api/file/asset?path=archive.zip&cwd=%2Fproject',
        );
        handle.dispose();
        expect(REVOKE).not.toHaveBeenCalled();
    });

    it('fails the preview when the asset cannot be loaded', async () => {
        window.phiAccessAuth = {
            installToken: () => true,
            getAccessToken: () => 'jwt-a',
            webSocketURL: (url) => url,
            assetURL: vi.fn(async () => {
                throw new Error('Unable to load asset (401)');
            }),
        };
        const container = document.createElement('div');
        await expect(
            mountFileView({ path: 'archive.zip', cwd: '/project', container }),
        ).rejects.toThrow('Unable to load asset (401)');
    });
});
