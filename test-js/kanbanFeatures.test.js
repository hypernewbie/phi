// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { KanbanManager } from '../web/kanban.js';
import { buildFeatures, featureProgress, featureTimeline } from '../web/kanban-features.js';

setupDomHarness();

const child = (id, done, created, doneAt) => ({ id, title: `Child ${id}`, done, created, done_at: doneAt });

function manager() {
    const c = Object.create(KanbanManager.prototype);
    c.app = { showToast: vi.fn() };
    c.taskCache = {};
    c.buckets = [];
    c.currentProjectId = 9;
    c.currentViewId = 5;
    c.boardMode = 'features';
    return c;
}

beforeEach(() => vi.clearAllMocks());

describe('native Vikunja feature helpers', () => {
    it('treats only a task with direct subtask relations as a feature', () => {
        const feature = {
            id: 1,
            title: 'Feature',
            related_tasks: { subtask: [child(2, true), child(3, false), child(3, false)] }
        };
        const unrelated = { id: 4, related_tasks: { related: [child(5, false)] } };

        expect(featureProgress(feature)).toMatchObject({ total: 2, completed: 1, percent: 50 });
        expect(buildFeatures([feature, unrelated])).toHaveLength(1);
    });

    it('builds a cumulative filed/completed timeline from created and done_at', () => {
        const series = featureTimeline([
            child(1, true, '2026-07-01T10:00:00Z', '2026-07-03T10:00:00Z'),
            child(2, false, '2026-07-02T10:00:00Z'),
            child(3, true, 'not a date', '2026-07-03T18:00:00Z'),
        ]);

        expect(series).toEqual([
            { date: '2026-07-01', filed: 1, completed: 0 },
            { date: '2026-07-02', filed: 2, completed: 0 },
            { date: '2026-07-03', filed: 2, completed: 2 },
        ]);
    });

    it('does not count a stale done_at for a task that was reopened', () => {
        expect(featureTimeline([child(1, false, '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z')]))
            .toEqual([{ date: '2026-07-01', filed: 1, completed: 0 }]);
    });
});

describe('Feature surface', () => {
    it('switches to Features and renders native roll-up progress', () => {
        const c = manager();
        c.taskCache = {
            1: { id: 1, title: 'Ship it', identifier: 'PHI-1', done: false, related_tasks: { subtask: [child(2, true), child(3, false)] } },
            2: child(2, true),
            3: child(3, false),
        };
        const container = document.createElement('div');
        document.body.appendChild(container);
        c.openTaskDetail = vi.fn();

        c.renderBoardLayout(container, [{ id: 9, title: 'Phi' }], { id: 9, title: 'Phi' }, { id: 5 }, []);

        const featureRow = container.querySelector('.kanban-feature-row');
        expect(featureRow).toBeTruthy();
        featureRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(c.openTaskDetail).toHaveBeenCalledWith('1', featureRow, container);
        expect(container.querySelector('.kanban-feature-progress-meta').textContent).toContain('1/2');
        expect(container.querySelector('.kanban-feature-progress-meta').textContent).toContain('50%');
        expect(container.querySelector('#kanban-add-column-btn')).toBeNull();

        container.querySelector('[data-kanban-mode="board"]').click();
        expect(container.querySelector('.kanban-view-btn.active').dataset.kanbanMode).toBe('board');
    });

    it('renders subtasks and their burn-up chart in the detail drawer', () => {
        const c = manager();
        const html = c.renderFeatureDetailSection({
            id: 1,
            related_tasks: { subtask: [child(2, true, '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z')] }
        });

        expect(html).toContain('kdp-subtask-row done');
        expect(html).toContain('<svg');
        expect(html).toContain('Filed 1');
        expect(html).toContain('Completed 1');
    });

    it('marks the parent done without mutating its subtasks', async () => {
        const c = manager();
        const feature = { id: 1, title: 'Ship it', done: false, related_tasks: { subtask: [child(2, true)] } };
        c.taskCache = { 1: feature, 2: feature.related_tasks.subtask[0] };
        c.setTaskDone = vi.fn(async () => ({ ...feature, done: true }));
        c.loadAndRenderBoard = vi.fn(async () => {});
        const container = document.createElement('div');
        document.body.appendChild(container);

        c.renderBoardLayout(container, [{ id: 9, title: 'Phi' }], { id: 9, title: 'Phi' }, { id: 5 }, []);
        container.querySelector('.kanban-feature-done-btn').click();
        await vi.waitFor(() => expect(c.setTaskDone).toHaveBeenCalledWith(feature, true));

        expect(feature.related_tasks.subtask[0].done).toBe(true);
        expect(c.loadAndRenderBoard).toHaveBeenCalledWith(container);
    });

    it('does not mark an incomplete feature done without confirmation', () => {
        const c = manager();
        const feature = { id: 1, title: 'Ship it', done: false, related_tasks: { subtask: [child(2, false)] } };
        c.taskCache = { 1: feature, 2: feature.related_tasks.subtask[0] };
        c.setTaskDone = vi.fn();
        vi.stubGlobal('confirm', vi.fn(() => false));
        const container = document.createElement('div');
        document.body.appendChild(container);

        c.renderBoardLayout(container, [{ id: 9, title: 'Phi' }], { id: 9, title: 'Phi' }, { id: 5 }, []);
        container.querySelector('.kanban-feature-done-btn').click();

        expect(confirm).toHaveBeenCalledOnce();
        expect(c.setTaskDone).not.toHaveBeenCalled();
    });
});

describe('Feature loading keeps the Kanban bucket view authoritative', () => {
    it('loads hierarchy separately without changing bucket task state', async () => {
        const c = manager();
        c.boardMode = 'board';
        c.renderBoardLayout = vi.fn();
        sessionStorage.setItem('vikunja_token', 'tok');
        localStorage.setItem('vikunja_url', 'http://vik.local');
        mockFetch(url => {
            const upstream = decodeURIComponent(url.split('url=')[1]);
            if (upstream.endsWith('/projects?per_page=500')) return [{ id: 9, title: 'Phi' }];
            if (upstream.endsWith('/projects/9/views?per_page=500')) return [{ id: 5, view_kind: 'kanban' }];
            if (upstream.endsWith('/projects/9/views/5/tasks?per_page=500')) {
                return [{ id: 10, title: 'Todo', tasks: [{ id: 1, title: 'Feature', bucket_id: 10, done: false }] }];
            }
            if (upstream.endsWith('/projects/9/tasks?per_page=500&expand=subtasks')) {
                return [{ id: 1, related_tasks: { subtask: [child(2, false)] } }];
            }
            throw new Error(`Unexpected URL: ${upstream}`);
        });

        await c.loadAndRenderBoard(document.createElement('div'));

        const upstreamUrls = fetch.mock.calls.map(([url]) => decodeURIComponent(url.split('url=')[1]));
        expect(upstreamUrls).toContain('http://vik.local/api/v1/projects/9/views/5/tasks?per_page=500');
        expect(upstreamUrls).toContain('http://vik.local/api/v1/projects/9/tasks?per_page=500&expand=subtasks');
        expect(c.buckets[0].tasks[0]).toMatchObject({ id: 1, bucket_id: 10, related_tasks: { subtask: [{ id: 2 }] } });
        expect(c.taskCache[1].bucket_id).toBe(10);
    });
});

describe('Feature API operations', () => {
    it('creates a task, then links it as a native subtask relation', async () => {
        const c = manager();
        sessionStorage.setItem('vikunja_token', 'tok');
        localStorage.setItem('vikunja_url', 'http://vik.local');
        mockFetch((_, options) => options.method === 'PUT' && fetch.mock.calls.length === 1
            ? { id: 22, title: 'Child' }
            : { id: 1 });

        await c.createSubtask({ id: 1, title: 'Parent', bucket_id: 7 }, ' Child ');

        expect(fetch).toHaveBeenCalledTimes(2);
        const [createUrl, createOpts] = fetch.mock.calls[0];
        expect(decodeURIComponent(createUrl.split('url=')[1])).toBe('http://vik.local/api/v1/projects/9/tasks');
        expect(createOpts.method).toBe('PUT');
        expect(JSON.parse(createOpts.body)).toEqual({ title: 'Child', project_id: 9, bucket_id: 7 });
        const [relationUrl, relationOpts] = fetch.mock.calls[1];
        expect(decodeURIComponent(relationUrl.split('url=')[1])).toBe('http://vik.local/api/v1/tasks/1/relations');
        expect(relationOpts.method).toBe('PUT');
        expect(JSON.parse(relationOpts.body)).toEqual({ other_task_id: 22, relation_kind: 'subtask' });
    });

    it('uses the existing POST task update endpoint for completion', async () => {
        const c = manager();
        sessionStorage.setItem('vikunja_token', 'tok');
        localStorage.setItem('vikunja_url', 'http://vik.local');
        mockFetch(() => ({ id: 2, done: true, done_at: '2026-07-03T00:00:00Z' }));

        const updated = await c.setTaskDone({ id: 2, title: 'Child', labels: [], assignees: [] }, true);

        const [url, opts] = fetch.mock.calls[0];
        expect(decodeURIComponent(url.split('url=')[1])).toBe('http://vik.local/api/v1/tasks/2');
        expect(opts.method).toBe('POST');
        expect(JSON.parse(opts.body).done).toBe(true);
        expect(updated.done_at).toBe('2026-07-03T00:00:00Z');
    });
});
