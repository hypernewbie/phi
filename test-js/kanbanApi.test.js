// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { KanbanManager } from '../web/kanban.js';

// Covers the kanban API/transport fixes: apiRequest supports any method
// (PUT used by moveTask/saveTaskDetail), 401 -> drop token, error messages
// are normalized via extractVikunjaError, and DELETE/PUT bodies are sent
// correctly. Never `new`s the controller: hand-built `this`.

setupDomHarness();

function ctxWithSession({ token = 'tok', url = 'http://vik.local' } = {}) {
    sessionStorage.setItem('vikunja_token', token);
    localStorage.setItem('vikunja_url', url);
    const c = Object.create(KanbanManager.prototype);
    c.buckets = [{ id: 1, title: 'Doing' }];
    c.taskCache = {
        42: { id: 42, title: 'hello', bucket_id: 1, labels: [], assignees: [] }
    };
    c.app = { showToast: vi.fn() };
    return c;
}

beforeEach(() => vi.clearAllMocks());

describe('KanbanManager.apiRequest', () => {
    it('forwards the specified HTTP method to /api/proxy', async () => {
        const c = ctxWithSession();
        mockFetch((url, opts) => ({ ok: true, status: 200, json: { id: 42 } }));
        await c.apiPut('/tasks/42', { title: 'hi' });
        const [callUrl, callOpts] = fetch.mock.calls[0];
        // proxy URL encodes the upstream URL
        expect(callUrl).toContain('/api/proxy?url=');
        expect(callOpts.method).toBe('PUT');
        expect(callOpts.headers.Authorization).toBe('Bearer tok');
        expect(JSON.parse(callOpts.body)).toEqual({ title: 'hi' });
    });

    it('builds the upstream URL as <vikunja_url>/api/v1<path>', async () => {
        const c = ctxWithSession({ url: 'http://vik.local' });
        mockFetch(() => ({ ok: true, json: { id: 1 } }));
        await c.apiPost('/projects/1/tasks', { title: 'x' });
        const decoded = decodeURIComponent(fetch.mock.calls[0][0].split('url=')[1]);
        expect(decoded).toBe('http://vik.local/api/v1/projects/1/tasks');
    });

    it('drops the token and throws on 401', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({ ok: false, status: 401, text: '{"message":"unauthorized"}' }));
        await expect(c.apiGet('/x')).rejects.toThrow(/Session expired/);
        expect(sessionStorage.getItem('vikunja_token')).toBeNull();
    });

    it('normalizes Vikunja error envelopes via extractVikunjaError', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({ ok: false, status: 405, text: '{"message":"method not allowed error"}' }));
        await expect(c.apiPut('/tasks/42', {})).rejects.toThrow('method not allowed error');
    });

    it('truncates raw HTML error pages instead of dumping them', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({ ok: false, status: 502, text: '<html><body>502 Bad Gateway</body></html>' }));
        await expect(c.apiGet('/x')).rejects.toThrow(/502 Bad Gateway/);
        const msg = await c.apiGet('/x').catch((e) => e.message);
        expect(msg).not.toMatch(/<html/);
    });

    it('sends a JSON body only when one is provided', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({ ok: true, json: null }));
        await c.apiDelete('/tasks/42');
        expect(fetch.mock.calls[0][1].body).toBeUndefined();
    });

    it('returns null on 204 No Content', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({ ok: true, status: 204 }));
        expect(await c.apiPut('/tasks/42', {})).toBeNull();
    });

    it('omits Authorization when no token is in sessionStorage', async () => {
        const c = ctxWithSession({ token: null });
        mockFetch(() => ({ ok: true, json: {} }));
        await c.apiGet('/x');
        const headers = fetch.mock.calls[0][1].headers;
        expect(headers.Authorization).toBeUndefined();
    });
});

describe('KanbanManager.moveTask (was POST, should be PUT)', () => {
    it('sends PUT to /tasks/<id> with the new bucket', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({ ok: true, status: 200, json: null }));
        await c.moveTask(42, 1);
        const [callUrl, callOpts] = fetch.mock.calls[0];
        const decoded = decodeURIComponent(callUrl.split('url=')[1]);
        expect(decoded).toBe('http://vik.local/api/v1/tasks/42');
        expect(callOpts.method).toBe('PUT');
        const body = JSON.parse(callOpts.body);
        expect(body.bucket_id).toBe(1);
    });

    it('sets done:true when the target bucket is the done bucket', async () => {
        const c = ctxWithSession();
        c.buckets = [{ id: 7, title: 'Done', is_done: true }];
        mockFetch(() => ({ ok: true, json: null }));
        await c.moveTask(42, 7);
        expect(JSON.parse(fetch.mock.calls[0][1].body).done).toBe(true);
    });

    it('throws if the task is not in cache', async () => {
        const c = ctxWithSession();
        c.taskCache = {};
        await expect(c.moveTask(999, 1)).rejects.toThrow(/not in cache/);
    });
});

describe('KanbanManager.saveTaskDetail (was POST, should be PUT)', () => {
    it('sends PUT /tasks/<id> with the updated fields', async () => {
        const c = ctxWithSession();
        const card = document.createElement('div');
        const container = document.createElement('div');
        c.loadAndRenderBoard = vi.fn(async () => {});
        mockFetch(() => ({ ok: true, json: null }));
        await c.saveTaskDetail({ id: 42 }, { title: 'new', priority: 2, due_date: null, done: false, description: '' }, card, container);
        const [callUrl, callOpts] = fetch.mock.calls[0];
        expect(decodeURIComponent(callUrl.split('url=')[1])).toBe('http://vik.local/api/v1/tasks/42');
        expect(callOpts.method).toBe('PUT');
        expect(JSON.parse(callOpts.body).title).toBe('new');
    });
});