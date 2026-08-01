// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { KanbanManager } from '../web/kanban.js';

// Coverage for the v0.7.15 kanban feature-completeness additions:
//   - deleteTask (DELETE /tasks/{id})
//   - createBucket / updateBucket / deleteBucket
//   - fetchAllLabels / addLabelToTask / removeLabelFromTask
//   - that deleteTask also clears the local taskCache
//   - that deleteBucket prunes tasks belonging to it

setupDomHarness();

function ctxWithSession({ projectId = 9, viewId = 5 } = {}) {
    sessionStorage.setItem('vikunja_token', 'tok');
    localStorage.setItem('vikunja_url', 'http://vik.local');
    const c = Object.create(KanbanManager.prototype);
    c.app = { showToast: vi.fn() };
    c.currentProjectId = projectId;
    c.currentViewId = viewId;
    // buckets[].tasks holds the same objects as taskCache, mirroring what
    // loadBoard builds, so incremental state updates can be asserted.
    const tasks = {
        1: { id: 1, title: 'A', bucket_id: 10, labels: [] },
        2: { id: 2, title: 'B', bucket_id: 10, labels: [] },
        3: { id: 3, title: 'C', bucket_id: 20, labels: [] },
    };
    c.taskCache = { ...tasks };
    c.buckets = [
        { id: 10, title: 'Todo', tasks: [tasks[1], tasks[2]] },
        { id: 20, title: 'Done', tasks: [tasks[3]] },
    ];
    c.loadAndRenderBoard = vi.fn(async () => {});
    return c;
}

beforeEach(() => vi.clearAllMocks());

describe('KanbanManager.deleteTask', () => {
    it('sends DELETE /tasks/<id> and clears the task from cache', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({ ok: true, status: 204 }));
        await c.deleteTask(2);
        const [url, opts] = fetch.mock.calls[0];
        const decoded = decodeURIComponent(url.split('url=')[1]);
        expect(decoded).toBe('http://vik.local/api/v1/tasks/2');
        expect(opts.method).toBe('DELETE');
        expect(c.taskCache[2]).toBeUndefined();
        expect(c.taskCache[1]).toBeTruthy();
    });

    it('drops the card without reloading the board', async () => {
        const c = ctxWithSession();
        const container = document.createElement('div');
        mockFetch(() => ({ ok: true, status: 204 }));

        await c.deleteTask(1, container);

        // Deleting one card is a local edit: the board is not refetched.
        expect(c.loadAndRenderBoard).not.toHaveBeenCalled();
        expect(c.taskCache[1]).toBeUndefined();
    });

    it('puts the card back when the delete is rejected', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({ ok: false, status: 500, text: 'nope' }));

        await expect(c.deleteTask(1, null)).rejects.toThrow();

        // Optimistic removal must not survive a failed call.
        expect(c.taskCache[1]).toBeTruthy();
        expect(c.buckets.find(b => b.id === 10).tasks.map(t => t.id)).toContain(1);
    });
});

describe('KanbanManager.createBucket', () => {
    it('sends PUT /projects/<p>/views/<v>/buckets with {title}', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({ ok: true, json: { id: 99, title: 'In Review' } }));
        await c.createBucket('In Review');
        const [url, opts] = fetch.mock.calls[0];
        const decoded = decodeURIComponent(url.split('url=')[1]);
        expect(decoded).toBe('http://vik.local/api/v1/projects/9/views/5/buckets');
        expect(opts.method).toBe('PUT');
        expect(JSON.parse(opts.body)).toEqual({ title: 'In Review' });
    });

    it('rejects empty/whitespace titles', async () => {
        const c = ctxWithSession();
        await expect(c.createBucket('   ')).rejects.toThrow(/empty/);
        await expect(c.createBucket('')).rejects.toThrow(/empty/);
    });

    it('requires project_id and view_id to be cached', async () => {
        const c = ctxWithSession();
        c.currentProjectId = null;
        await expect(c.createBucket('X')).rejects.toThrow(/project or view/);
    });
});

describe('KanbanManager.updateBucket', () => {
    it('sends POST /projects/<p>/views/<v>/buckets/<b> with {title}', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({ ok: true, json: {} }));
        await c.updateBucket(10, 'Renamed');
        const [url, opts] = fetch.mock.calls[0];
        const decoded = decodeURIComponent(url.split('url=')[1]);
        expect(decoded).toBe('http://vik.local/api/v1/projects/9/views/5/buckets/10');
        expect(opts.method).toBe('POST');
        expect(JSON.parse(opts.body)).toEqual({ title: 'Renamed' });
    });

    it('rejects empty titles', async () => {
        const c = ctxWithSession();
        await expect(c.updateBucket(10, '  ')).rejects.toThrow(/empty/);
    });
});

describe('KanbanManager.deleteBucket', () => {
    it('sends DELETE /projects/<p>/views/<v>/buckets/<b> and prunes its tasks', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({ ok: true, status: 204 }));
        await c.deleteBucket(10);
        const [url, opts] = fetch.mock.calls[0];
        const decoded = decodeURIComponent(url.split('url=')[1]);
        expect(decoded).toBe('http://vik.local/api/v1/projects/9/views/5/buckets/10');
        expect(opts.method).toBe('DELETE');
        expect(c.taskCache[1]).toBeUndefined();
        expect(c.taskCache[2]).toBeUndefined();
        expect(c.taskCache[3]).toBeTruthy();
        expect(c.buckets.find(b => b.id === 10)).toBeUndefined();
        expect(c.buckets.find(b => b.id === 20)).toBeTruthy();
    });

    it('rejects when project/view not cached', async () => {
        const c = ctxWithSession();
        c.currentViewId = null;
        await expect(c.deleteBucket(10)).rejects.toThrow(/project or view/);
    });
});

describe('KanbanManager label management', () => {
    it('fetchAllLabels calls GET /labels', async () => {
        const c = ctxWithSession();
        mockFetch(() => [{ id: 1, title: 'bug' }, { id: 2, title: 'wip' }]);
        const labels = await c.fetchAllLabels();
        const [url, opts] = fetch.mock.calls[0];
        const decoded = decodeURIComponent(url.split('url=')[1]);
        expect(decoded).toBe('http://vik.local/api/v1/labels');
        expect(opts.method).toBe('GET');
        expect(labels).toHaveLength(2);
    });

    it('addLabelToTask PUTs /tasks/<id>/labels and updates the cache', async () => {
        const c = ctxWithSession();
        const updated = [{ id: 7, title: 'urgent' }];
        mockFetch(() => ({ ok: true, json: updated }));
        const ret = await c.addLabelToTask(1, 7);
        const [url, opts] = fetch.mock.calls[0];
        const decoded = decodeURIComponent(url.split('url=')[1]);
        expect(decoded).toBe('http://vik.local/api/v1/tasks/1/labels');
        expect(opts.method).toBe('PUT');
        expect(JSON.parse(opts.body)).toEqual({ label_id: 7 });
        expect(ret).toEqual(updated);
        expect(c.taskCache[1].labels).toEqual(updated);
    });

    it('removeLabelFromTask DELETEs /tasks/<id>/labels/<l> and prunes the cache', async () => {
        const c = ctxWithSession();
        c.taskCache[1].labels = [{ id: 7, title: 'a' }, { id: 8, title: 'b' }];
        mockFetch(() => ({ ok: true, status: 204 }));
        await c.removeLabelFromTask(1, 7);
        const [url, opts] = fetch.mock.calls[0];
        const decoded = decodeURIComponent(url.split('url=')[1]);
        expect(decoded).toBe('http://vik.local/api/v1/tasks/1/labels/7');
        expect(opts.method).toBe('DELETE');
        expect(c.taskCache[1].labels).toEqual([{ id: 8, title: 'b' }]);
    });

    it('removeLabelFromTask is a no-op for tasks not in cache', async () => {
        const c = ctxWithSession();
        mockFetch(() => ({ ok: true, status: 204 }));
        await c.removeLabelFromTask(999, 7);
        expect(fetch).toHaveBeenCalledOnce();
    });
});
