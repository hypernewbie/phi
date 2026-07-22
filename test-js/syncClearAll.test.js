// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { SyncManager } from '../web/sync.js';

// Sync "Clear all" button — sweeps every entry on the current
// coordinator. The frontend has no bulk-delete endpoint, so we iterate
// the rendered list and DELETE each key sequentially. These tests pin:
//   - the button is rendered in the sync header (sibling of Add)
//   - clicking it on an empty list short-circuits (no DELETEs, no confirm)
//   - clicking it on a non-empty list confirms, then DELETEs every key,
//     then triggers a refresh
//   - partial failures don't abort the rest (best-effort sweep)
//
// Note: buildProxyUrl wraps every coordinator request inside the local
// /api/proxy?url=<encoded> path, so tests match on the encoded inner
// URL pattern rather than the literal REST path.

setupDomHarness();

function bootstrapDom() {
    document.body.innerHTML = `
        <div id="sync-panel" class="sync-panel"></div>
    `;
}

function buildAppStub() {
    return {
        showToast: vi.fn(),
        sessionsManager: {
            config: { sync_coordinator: 'http://localhost:7070' },
            loadConfig: vi.fn().mockResolvedValue(undefined),
        },
        diffController: { isPanelOpen: true, activeTab: 'sync' },
    };
}

// Inspect a /api/proxy?url=… call: decode the `?url=` param so the
// caller can match on the actual REST path the SyncManager is hitting.
function proxiedTarget(url) {
    const u = String(url);
    const m = u.match(/\/api\/proxy\?url=([^&]+)/);
    if (!m) return u;
    try { return decodeURIComponent(m[1]); } catch { return u; }
}

// Build a JSON Response the mockFetch contract expects. mockFetch()
// turns a truthy value into an OK JSON response; this helper builds
// richer shapes (errors, ok-with-body).
function jsonResponse(body, { ok = true, status = 200 } = {}) {
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('SyncManager — Clear all', () => {
    it('renders a Clear all button next to Add in the header', () => {
        bootstrapDom();
        new SyncManager(buildAppStub());
        const clearBtn = document.getElementById('sync-clear-btn');
        const addBtn = document.getElementById('sync-add-btn');
        expect(clearBtn, 'clear-all button should be in the DOM').toBeTruthy();
        expect(addBtn, 'add button should still be in the DOM').toBeTruthy();
        expect(clearBtn.classList.contains('sync-btn-secondary')).toBe(true);
        expect(clearBtn.parentElement.classList.contains('sync-header-actions')).toBe(true);
        expect(clearBtn.parentElement.children.length).toBe(2);
    });

    it('clicking Clear all on an empty list: read GET happens, but no DELETEs', async () => {
        bootstrapDom();
        const app = buildAppStub();
        const calls = [];
        mockFetch((url, options = {}) => {
            const method = options.method || 'GET';
            const target = proxiedTarget(url);
            calls.push({ target, method });
            if (target.endsWith('/api/sync/messages') && method === 'GET') {
                return [];
            }
            return jsonResponse([]);
        });
        const confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => true);
        new SyncManager(app);
        await new Promise((r) => setTimeout(r, 0));
        const baseline = calls.length;
        document.getElementById('sync-clear-btn').click();
        await new Promise((r) => setTimeout(r, 20));
        const newCalls = calls.slice(baseline);
        // We expect exactly the read GET (for current keys) — no DELETEs.
        expect(newCalls.filter((c) => c.method === 'DELETE').length).toBe(0);
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(app.showToast).toHaveBeenCalledWith(
            'No messages to clear',
            expect.objectContaining({ type: 'info' }),
        );
    });

    it('clicking Clear all with messages: confirms, DELETEs each, then refreshes', async () => {
        bootstrapDom();
        const app = buildAppStub();
        const messages = [
            { key: 'a', value: '1', updated_at: '2026-07-22T00:00:00Z' },
            { key: 'b', value: '2', updated_at: '2026-07-22T00:00:01Z' },
            { key: 'c', value: '3', updated_at: '2026-07-22T00:00:02Z' },
        ];
        const calls = [];
        mockFetch((url, options = {}) => {
            const method = options.method || 'GET';
            const target = proxiedTarget(url);
            calls.push({ target, method });
            if (target.endsWith('/api/sync/messages') && method === 'GET') {
                return messages;
            }
            if (/\/api\/sync\/messages\/[^/]+$/.test(target) && method === 'DELETE') {
                return jsonResponse({});
            }
            return jsonResponse([]);
        });
        const confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => true);
        new SyncManager(app);
        await new Promise((r) => setTimeout(r, 0));
        const baseline = calls.length;
        document.getElementById('sync-clear-btn').click();
        await new Promise((r) => setTimeout(r, 30));
        const newCalls = calls.slice(baseline);
        const deletes = newCalls.filter((c) => c.method === 'DELETE');
        expect(deletes.length).toBe(3);
        expect(confirmSpy).toHaveBeenCalledOnce();
        expect(app.showToast).toHaveBeenCalledWith(
            'Cleared 3 messages',
            expect.objectContaining({ type: 'success' }),
        );
    });

    it('canceling the confirm leaves messages untouched', async () => {
        bootstrapDom();
        const app = buildAppStub();
        const messages = [
            { key: 'a', value: '1', updated_at: '2026-07-22T00:00:00Z' },
        ];
        const calls = [];
        mockFetch((url) => {
            const target = proxiedTarget(url);
            calls.push({ target, method: 'GET' });
            if (target.endsWith('/api/sync/messages')) return messages;
            return jsonResponse([]);
        });
        vi.spyOn(window, 'confirm').mockImplementation(() => false);
        new SyncManager(app);
        await new Promise((r) => setTimeout(r, 0));
        const baseline = calls.length;
        document.getElementById('sync-clear-btn').click();
        await new Promise((r) => setTimeout(r, 20));
        const deletes = calls.slice(baseline).filter((c) => c.method === 'DELETE');
        expect(deletes.length).toBe(0);
        expect(app.showToast).not.toHaveBeenCalledWith(
            expect.stringMatching(/^Cleared/),
            expect.anything(),
        );
    });

    it('partial DELETE failures do not abort the rest and surface a warning toast', async () => {
        bootstrapDom();
        const app = buildAppStub();
        const messages = [
            { key: 'a', value: '1', updated_at: '2026-07-22T00:00:00Z' },
            { key: 'b', value: '2', updated_at: '2026-07-22T00:00:01Z' },
            { key: 'c', value: '3', updated_at: '2026-07-22T00:00:02Z' },
        ];
        const calls = [];
        mockFetch((url, options = {}) => {
            const method = options.method || 'GET';
            const target = proxiedTarget(url);
            calls.push({ target, method });
            if (target.endsWith('/api/sync/messages') && method === 'GET') {
                return messages;
            }
            if (target.includes('/api/sync/messages/a') && method === 'DELETE') {
                throw new Error('boom a');
            }
            if (/\/api\/sync\/messages\/[^/]+$/.test(target) && method === 'DELETE') {
                return jsonResponse({});
            }
            return jsonResponse([]);
        });
        vi.spyOn(window, 'confirm').mockImplementation(() => true);
        new SyncManager(app);
        await new Promise((r) => setTimeout(r, 0));
        const baseline = calls.length;
        document.getElementById('sync-clear-btn').click();
        await new Promise((r) => setTimeout(r, 60));
        const deletes = calls.slice(baseline).filter((c) => c.method === 'DELETE');
        expect(deletes.length).toBe(3);
        expect(app.showToast).toHaveBeenCalledWith(
            expect.stringMatching(/^Cleared; 1 delete failed/),
            expect.objectContaining({ type: 'error' }),
        );
    });
});
