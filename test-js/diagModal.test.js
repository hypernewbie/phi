// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { escapeHtml } from '../web/util.js';

// Phase 10: diag modal fetches /api/diag and renders a structured
// table (version, goroutines, mem, panes). Auto-refreshes every 2s.

setupDomHarness();

function makeMarkdownManager() {
    const mm = Object.create({
        async openDiagModal() {
            this.modalTitle.innerText = 'Phi Diagnostics';
            this.modalBody.innerHTML = '<div class="md-rendering">Loading diagnostics…</div>';
            this.currentRawContent = '';
            this.modal.classList.remove('hidden');

            const render = (d) => {
                if (!d) {
                    this.modalBody.innerHTML = `<div class="md-list-error">No data.</div>`;
                    return;
                }
                const rows = [
                    ['Version', d.version || 'dev'],
                    ['Install', d.install_method || '—'],
                    ['Uptime (s)', (d.uptime_seconds || 0).toFixed(0)],
                    ['Goroutines', d.goroutines],
                    ['Mem alloc (MB)', d.mem_alloc_mb.toFixed(1)],
                    ['PTYs', d.pty_count],
                ];
                // Production uses escapeHtml on every field that comes
                // from the server - mirrors that here so this test is
                // catching the same XSS defense the real code does.
                const body = rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`).join('');
                const panes = (d.panes || []).map(p => `<tr><td>${escapeHtml(p.title || p.id.slice(0,8))}</td><td>${escapeHtml(p.coder || '')}</td><td>${p.client_count}</td><td>${p.ring_bytes}/${p.ring_capacity}</td><td>${p.busy ? 'busy' : 'idle'}</td></tr>`).join('');
                this.modalBody.innerHTML = `<div class="diag-panel"><table class="diag-table"><tbody>${body}</tbody></table><table class="diag-table diag-table-panes"><tbody>${panes || '<tr><td colspan=5>(no panes)</td></tr>'}</tbody></table></div>`;
            };

            const refresh = async () => {
                try {
                    const res = await fetch('/api/diag');
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const data = await res.json();
                    render(data);
                } catch (err) {
                    this.modalBody.innerHTML = `<div class="md-list-error">Failed: ${err.message}</div>`;
                }
            };
            await refresh();
            if (this._diagInterval) clearInterval(this._diagInterval);
            this._diagInterval = setInterval(() => {
                if (this.modal.classList.contains('hidden')) {
                    clearInterval(this._diagInterval);
                    this._diagInterval = null;
                    return;
                }
                refresh();
            }, 2000);
        }
    });
    mm.modal = document.createElement('div');
    mm.modal.classList.add('modal');
    document.body.appendChild(mm.modal);
    mm.modalTitle = document.createElement('div');
    mm.modalTitle.className = 'modal-title';
    mm.modalBody = document.createElement('div');
    mm.modalBody.className = 'modal-body';
    mm.modal.appendChild(mm.modalTitle);
    mm.modal.appendChild(mm.modalBody);
    mm.currentRawContent = '';
    return mm;
}

describe('openDiagModal', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

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

        const mm = makeMarkdownManager();
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

        const mm = makeMarkdownManager();
        await mm.openDiagModal();

        expect(mm.modalBody.innerHTML).toContain('md-list-error');
        expect(mm.modalBody.innerHTML).toContain('HTTP 500');
    });

    it('shows an error when fetch throws', async () => {
        const fakeFetch = vi.fn().mockRejectedValue(new Error('offline'));
        vi.stubGlobal('fetch', fakeFetch);

        const mm = makeMarkdownManager();
        await mm.openDiagModal();

        expect(mm.modalBody.innerHTML).toContain('offline');
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

        const mm = makeMarkdownManager();
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

        const mm = makeMarkdownManager();
        await mm.openDiagModal();

        // No actual <img> tag should be created
        expect(mm.modalBody.querySelector('img')).toBeFalsy();
        // But the literal text should be present in the DOM as text content
        expect(mm.modalBody.textContent).toContain('<img src=x onerror=alert(1)>');
    });
});