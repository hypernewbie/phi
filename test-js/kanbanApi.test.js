// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { KanbanManager } from '../web/kanban.js';

// Covers the kanban transport: apiRequest supports any method (PUT used by
// moveTask/saveTaskDetail), a 401 asks for a new sign-in instead of
// logging in again, error messages are normalized via extractVikunjaError, and
// DELETE/PUT bodies are sent correctly.
//
// The session belongs to the server: the client sends no credential, and the
// path is /api/kanban/v1<path>. Never `new`s the controller: hand-built `this`.

setupDomHarness();

function ctxWithSession() {
    const c = Object.create(KanbanManager.prototype);
    c.buckets = [{ id: 1, title: 'Doing' }];
    c.taskCache = {
        42: { id: 42, title: 'hello', bucket_id: 1, labels: [], assignees: [] },
    };
    c.app = { showToast: vi.fn() };
    return c;
}

beforeEach(() => vi.clearAllMocks());

describe('KanbanManager.apiRequest', () => {
    it('forwards the specified HTTP method to the server-side route', async () => {
        const c = ctxWithSession();
        mockFetch((_url, _opts) => ({
            ok: true,
            status: 200,
            json: { id: 42 },
        }));
        await c.apiPut('/tasks/42', { title: 'hi' });
        const [callUrl, callOpts] = fetch.mock.calls[0];
        expect(callUrl).toContain('/api/kanban/v1/tasks/42');
        expect(callOpts.method).toBe('PUT');
        expect(JSON.parse(callOpts.body)).toEqual({ title: 'hi' });
    });

    it('never sends a Vikunja credential to the client side', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({ ok: true, json: { id: 1 } }));
        await c.apiPost('/projects/1/tasks', { title: 'x' });
        const [callUrl, callOpts] = fetch.mock.calls[0];
        expect(callUrl).toBe('/api/kanban/v1/projects/1/tasks');
        expect(
            callOpts.headers?.['X-Phi-Upstream-Authorization'],
        ).toBeUndefined();
        expect(callOpts.headers?.Authorization).toBeUndefined();
    });

    it('asks for a new sign-in on 401 and never retries', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({
            ok: false,
            status: 401,
            text: '{"message":"unauthorized"}',
        }));
        await expect(c.apiGet('/x')).rejects.toThrow(/Session expired/);
        // One request only: the server already refreshed the session once,
        // and a client-side retry is what used to loop.
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('normalizes Vikunja error envelopes via extractVikunjaError', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({
            ok: false,
            status: 405,
            text: '{"message":"method not allowed error"}',
        }));
        await expect(c.apiPut('/tasks/42', {})).rejects.toThrow(
            'method not allowed error',
        );
    });

    it('truncates raw HTML error pages instead of dumping them', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({
            ok: false,
            status: 502,
            text: '<html><body>502 Bad Gateway</body></html>',
        }));
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

    it('turns a rate limit into a readable sentence with the wait', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({
            ok: false,
            status: 429,
            text: '{"message":"Too Many Requests"}',
            headers: { 'Retry-After': '42' },
        }));
        const err = await c.apiGet('/x').catch((e) => e);
        expect(err.message).toMatch(/rate-limiting/i);
        expect(err.message).toMatch(/42s/);
        expect(err.message).not.toMatch(/Too Many Requests/);
    });
});

describe('KanbanManager.moveTask (uses Vikunja dedicated bucket-move endpoint)', () => {
    it('sends POST /projects/<pid>/views/<vid>/buckets/<bid>/tasks with {task_id}', async () => {
        const c = ctxWithSession();
        c.currentProjectId = 9;
        c.currentViewId = 5;
        mockFetch(() => ({ ok: true, json: null }));
        await c.moveTask(42, 1);
        const [callUrl, callOpts] = fetch.mock.calls[0];
        expect(callUrl).toBe(
            '/api/kanban/v1/projects/9/views/5/buckets/1/tasks',
        );
        expect(callOpts.method).toBe('POST');
        expect(JSON.parse(callOpts.body)).toEqual({ task_id: 42 });
    });

    it('updates local cache bucket_id to mirror the move', async () => {
        const c = ctxWithSession();
        c.currentProjectId = 9;
        c.currentViewId = 5;
        mockFetch(() => ({ ok: true, json: null }));
        await c.moveTask(42, 7);
        expect(c.taskCache[42].bucket_id).toBe(7);
    });

    it('throws if project/view not loaded yet (no cached ids)', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({ ok: true, json: null }));
        await expect(c.moveTask(42, 1)).rejects.toThrow(
            /project or view not loaded/,
        );
    });

    it('throws if the task is not in cache', async () => {
        const c = ctxWithSession();
        c.taskCache = {};
        mockFetch(() => ({ ok: true, json: null }));
        await expect(c.moveTask(999, 1)).rejects.toThrow(/not in cache/);
    });
});

describe('KanbanManager.saveTaskDetail (UPDATE uses POST)', () => {
    it('sends POST /tasks/<id> with the updated fields', async () => {
        const c = ctxWithSession();
        const card = document.createElement('div');
        const container = document.createElement('div');
        c.loadAndRenderBoard = vi.fn(async () => {});
        mockFetch(() => ({ ok: true, json: null }));
        await c.saveTaskDetail(
            { id: 42 },
            {
                title: 'new',
                priority: 2,
                due_date: null,
                done: false,
                description: '',
            },
            card,
            container,
        );
        const [callUrl, callOpts] = fetch.mock.calls[0];
        expect(callUrl).toBe('/api/kanban/v1/tasks/42');
        expect(callOpts.method).toBe('POST');
        expect(JSON.parse(callOpts.body).title).toBe('new');
    });
});
