// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, setupDomHarness } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';

// A v2 bearer session loads markdown images through the auth bridge, which
// returns an object URL that must be revoked. The image work finishes after
// the render, so a closed or replaced modal must not adopt its result.

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

// The bridge holds every image fetch open until release() runs, so the test
// controls the order of the close and the image result.
function stubDeferredBridge(revoke) {
    const state = { release: null };
    vi.stubGlobal('marked', { parse: (s) => s });
    vi.stubGlobal('DOMPurify', { sanitize: (h) => h });
    window.phiAccessAuth = {
        getAccessToken: () => 'jwt',
        assetURL: () =>
            new Promise((resolve) => {
                state.release = () => resolve({ url: 'blob:pic', revoke });
            }),
    };
    return state;
}

afterEach(() => {
    delete window.phiAccessAuth;
    vi.unstubAllGlobals();
});

describe('modal image assets', () => {
    it('releases a late image result when the modal closed first', async () => {
        const revoke = vi.fn();
        const bridge = stubDeferredBridge(revoke);
        mockFetch(() => ({
            ok: true,
            text: async () => '<img src="pic.png">',
        }));
        const mm = makeMm();
        const open = mm.openFile({ name: 'x.md', path: '/w/x.md' });
        await vi.waitFor(() => expect(bridge.release).toBeTypeOf('function'));

        mm.closeModal();
        bridge.release();
        await open;
        expect(revoke).toHaveBeenCalledTimes(1);
        // Nothing adopted the stale release: a second close has nothing to do.
        mm.closeModal();
        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it('releases a late image result when another view replaces it', async () => {
        const revoke = vi.fn();
        const bridge = stubDeferredBridge(revoke);
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
        const mm = makeMm();
        const open = mm.openFile({ name: 'x.md', path: '/w/x.md' });
        await vi.waitFor(() => expect(bridge.release).toBeTypeOf('function'));

        // The Diagnostics view replaces the body while the image is pending.
        void mm.openDiagModal();
        bridge.release();
        await open;
        expect(revoke).toHaveBeenCalledTimes(1);
        if (mm._diagInterval) clearInterval(mm._diagInterval);
    });
});
