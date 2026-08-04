// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { MarkdownManager } from '../web/markdown.js';

// Phase 10: diag modal fetches /api/diag and renders a structured
// table (version, goroutines, mem, panes). Auto-refreshes every 2s.

setupDomHarness();

// Real MarkdownManager via its constructor (same pattern as
// mdChangedRefresh.test.js's makeMm). fileListEl/modal/modalTitle/modalBody/
// modalClose are the five ids the constructor dereferences un-guarded.
function makeMm(app = {}) {
    document.body.innerHTML = `
        <div id="markdown-file-list"></div>
        <div id="md-modal" class="hidden"></div>
        <div id="md-modal-title"></div>
        <div id="md-modal-body"></div>
        <button id="md-modal-close"></button>
    `;
    return new MarkdownManager({ showToast: vi.fn(), ...app });
}

describe('openDiagModal', () => {
    it('fetches /api/diag and renders tables', async () => {
        const fakeFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                version: 'v0.8.0',
                install_method: 'standalone',
                uptime_seconds: 123,
                goroutines: 42,
                mem_alloc_mb: 12.5,
                pty_count: 1,
                panes: [
                    { id: 'abcd1234', title: 'opencode-1', coder: 'opencode',
                      client_count: 1, ring_bytes: 1024, ring_capacity: 1048576, busy: false }
                ]
            })
        });
        vi.stubGlobal('fetch', fakeFetch);

        const mm = makeMm();
        await mm.openDiagModal();

        expect(fakeFetch).toHaveBeenCalledWith('/api/diag');
        expect(mm.modalTitle.innerText).toBe('Phi Diagnostics');
        const html = mm.modalBody.innerHTML;
        expect(html).toContain('v0.8.0');
        expect(html).toContain('standalone');
        expect(html).toContain('42'); // goroutines
        expect(html).toContain('opencode-1');
    });

    it('shows an error message when fetch fails', async () => {
        const fakeFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
        vi.stubGlobal('fetch', fakeFetch);

        const mm = makeMm();
        await mm.openDiagModal();

        expect(mm.modalBody.innerHTML).toContain('md-list-error');
        expect(mm.modalBody.innerHTML).toContain('HTTP 500');
    });

    it('shows an error when fetch throws, HTML-escaped', async () => {
        const fakeFetch = vi.fn().mockRejectedValue(new Error('offline & <broken>'));
        vi.stubGlobal('fetch', fakeFetch);

        const mm = makeMm();
        await mm.openDiagModal();

        // markdown.js wraps err.message in escapeHtml before interpolating
        // (the catch branch is shared with the HTTP-status path above, but
        // only a message with HTML-sensitive chars exercises the escaping).
        // The escaped substring alone subsumes "no raw <broken> element"
        // and "textContent still reads the literal message" — either
        // failing would require this substring to be absent first. The
        // 'md-list-error' wrapper is already covered by the test above on
        // the same shared catch-block line, so it's not re-asserted here.
        expect(mm.modalBody.innerHTML).toContain('offline &amp; &lt;broken&gt;');
    });

    it('handles empty panes list cleanly', async () => {
        const fakeFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                version: 'dev', install_method: 'dev', uptime_seconds: 0,
                goroutines: 5, mem_alloc_mb: 1.0, pty_count: 0, panes: []
            })
        });
        vi.stubGlobal('fetch', fakeFetch);

        const mm = makeMm();
        await mm.openDiagModal();

        expect(mm.modalBody.innerHTML).toContain('(no panes)');
    });

    it('escapes pane title to prevent XSS via /api/diag', async () => {
        const fakeFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                version: 'v0.8.0', install_method: 'standalone',
                uptime_seconds: 1, goroutines: 1, mem_alloc_mb: 1.0,
                pty_count: 1,
                panes: [{
                    id: 'xx', title: '<img src=x onerror=alert(1)>',
                    coder: 'opencode', client_count: 0,
                    ring_bytes: 0, ring_capacity: 100, busy: false
                }]
            })
        });
        vi.stubGlobal('fetch', fakeFetch);

        const mm = makeMm();
        await mm.openDiagModal();

        // No actual <img> tag should be created
        expect(mm.modalBody.querySelector('img')).toBeFalsy();
        // But the literal text should be present in the DOM as text content
        expect(mm.modalBody.textContent).toContain('<img src=x onerror=alert(1)>');
    });
});
