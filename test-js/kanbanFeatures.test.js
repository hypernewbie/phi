// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import createDOMPurify from 'dompurify';
import { setupDomHarness, mockFetch } from './_dom.js';
import { KanbanManager } from '../web/kanban.js';
import { buildFeatures, featureProgress, featureStats, featureTimeline, portfolioTimeline, taskStats, cumulativeTimeline } from '../web/kanban-features.js';

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
    c.showDoneFeatures = false;
    return c;
}

beforeEach(() => vi.clearAllMocks());

describe('whole-board task stats', () => {
    const now = new Date('2026-07-30T12:00:00Z');

    it('counts every task, not only feature parents', () => {
        const stats = taskStats([
            { id: 1, done: true, created: '2026-07-20T00:00:00Z', done_at: '2026-07-25T00:00:00Z' },
            { id: 2, done: false, created: '2026-07-21T00:00:00Z' },
            { id: 3, done: false, created: '2026-07-22T00:00:00Z' },
            { id: 4, done: true, created: '2026-07-23T00:00:00Z', done_at: '2026-07-26T00:00:00Z' },
        ], now);

        expect(stats).toMatchObject({ totalTasks: 4, completedTasks: 2, openTasks: 2, taskPercent: 50 });
    });

    it('de-duplicates tasks that appear as both board card and feature parent', () => {
        const stats = taskStats([{ id: 1, done: true }, { id: 1, done: true }], now);
        expect(stats.totalTasks).toBe(1);
    });

    it('derives velocity and a forecast from the rolling window', () => {
        const stats = taskStats([
            { id: 1, done: true, done_at: '2026-07-24T00:00:00Z' },
            { id: 2, done: true, done_at: '2026-07-25T00:00:00Z' },
            { id: 3, done: false },
            { id: 4, done: false },
        ], now, 28);

        expect(stats.completedInWindow).toBe(2);
        expect(stats.velocityPerDay).toBeCloseTo(2 / 28);
        // 2 open at 2/28 per day rounds up to 28 days.
        expect(stats.estimatedDaysRemaining).toBe(28);
        expect(stats.projectedCompletionDate).toBe('2026-08-27');
    });

    it('reports no forecast when nothing was completed in the window', () => {
        const stats = taskStats([{ id: 1, done: false }], now);
        expect(stats.estimatedDaysRemaining).toBeNull();
        expect(stats.projectedCompletionDate).toBeNull();
    });

    it('reports a finished board as zero days remaining', () => {
        const stats = taskStats([{ id: 1, done: true, done_at: '2026-07-25T00:00:00Z' }], now);
        expect(stats.openTasks).toBe(0);
        expect(stats.estimatedDaysRemaining).toBe(0);
    });

    it('compares incoming work against completed work', () => {
        const stats = taskStats([
            { id: 1, created: '2026-07-25T00:00:00Z', done: true, done_at: '2026-07-26T00:00:00Z' },
            { id: 2, created: '2026-07-26T00:00:00Z', done: false },
            { id: 3, created: '2026-07-27T00:00:00Z', done: false },
            // Filed before the window opened, so it is not incoming work.
            { id: 4, created: '2026-01-01T00:00:00Z', done: false },
        ], now, 28);

        expect(stats.createdInWindow).toBe(3);
        expect(stats.completedInWindow).toBe(1);
        expect(stats.netFlow).toBe(-2);
    });

    it('ignores a stale done_at on a reopened task', () => {
        const stats = taskStats([
            { id: 1, done: false, done_at: '2026-07-25T00:00:00Z' },
        ], now);
        expect(stats.completedTasks).toBe(0);
        expect(stats.completedInWindow).toBe(0);
    });

    it('handles an empty board', () => {
        expect(taskStats([], now)).toMatchObject({ totalTasks: 0, taskPercent: 0, openTasks: 0 });
    });

    it('builds a board-wide burn-up from the same cumulative series', () => {
        const tasks = [
            { id: 1, created: '2026-07-01T00:00:00Z', done: true, done_at: '2026-07-03T00:00:00Z' },
            { id: 2, created: '2026-07-02T00:00:00Z', done: false },
        ];
        expect(cumulativeTimeline(tasks)).toEqual([
            { date: '2026-07-01', filed: 1, completed: 0 },
            { date: '2026-07-02', filed: 2, completed: 0 },
            { date: '2026-07-03', filed: 2, completed: 1 },
        ]);
    });
});

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

    it('builds a project burn-up from feature parent dates', () => {
        const features = buildFeatures([
            { id: 1, created: '2026-07-01T00:00:00Z', done: true, done_at: '2026-07-03T00:00:00Z', related_tasks: { subtask: [child(2, true)] } },
            { id: 3, created: '2026-07-02T00:00:00Z', done: false, related_tasks: { subtask: [child(4, false)] } },
        ]);
        expect(portfolioTimeline(features)).toEqual([
            { date: '2026-07-01', filed: 1, completed: 0 },
            { date: '2026-07-02', filed: 2, completed: 0 },
            { date: '2026-07-03', filed: 2, completed: 1 },
        ]);
    });

    it('calculates 28-day feature velocity and a forecast from parent completion', () => {
        const features = buildFeatures([
            { id: 1, done: true, done_at: '2026-07-27T10:00:00Z', related_tasks: { subtask: [child(2, true)] } },
            { id: 3, done: false, related_tasks: { subtask: [child(4, false)] } },
        ]);
        const stats = featureStats(features, new Date('2026-07-28T12:00:00Z'));

        expect(stats).toMatchObject({
            totalFeatures: 2,
            completedFeatures: 1,
            featurePercent: 50,
            totalSubtasks: 2,
            completedSubtasks: 1,
            velocityPerDay: 1 / 28,
            remainingFeatures: 1,
            estimatedDaysRemaining: 28,
            projectedCompletionDate: '2026-08-25'
        });
        expect(stats.dailyCompletions.find(day => day.date === '2026-07-27')).toMatchObject({ completed: 1 });
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

    it('hides completed features until explicitly shown', () => {
        const c = manager();
        c.taskCache = {
            1: { id: 1, title: 'Done', done: true, related_tasks: { subtask: [child(2, true)] } },
            3: { id: 3, title: 'Open', done: false, related_tasks: { subtask: [child(4, false)] } },
        };
        const container = document.createElement('div');
        document.body.appendChild(container);

        c.renderBoardLayout(container, [{ id: 9, title: 'Phi' }], { id: 9, title: 'Phi' }, { id: 5 }, []);
        expect(container.querySelectorAll('.kanban-feature-row')).toHaveLength(1);
        expect(container.querySelector('#kanban-show-done-features-btn').textContent).toContain('Show done (1)');

        container.querySelector('#kanban-show-done-features-btn').click();
        expect(container.querySelectorAll('.kanban-feature-row')).toHaveLength(2);
        expect(container.querySelector('#kanban-show-done-features-btn').textContent).toContain('Hide done');
    });

    it('renders a whole-board Stats view without task search controls', () => {
        const c = manager();
        c.boardMode = 'stats';
        c.taskCache = {
            1: { id: 1, done: true, done_at: new Date().toISOString(), related_tasks: { subtask: [child(2, true)] } },
            3: { id: 3, done: false, related_tasks: { subtask: [child(4, false)] } },
        };
        const container = document.createElement('div');
        document.body.appendChild(container);

        c.renderBoardLayout(container, [{ id: 9, title: 'Phi' }], { id: 9, title: 'Phi' }, { id: 5 }, []);

        expect(container.querySelector('.kanban-stats-view')).toBeTruthy();
        expect(container.textContent).toContain('Tasks done');
        expect(container.textContent).toContain('Scope burn-up');
        expect(container.querySelectorAll('.kanban-chart-wrap canvas')).toHaveLength(4);
        expect(container.querySelector('#kanban-search-input')).toBeNull();
    });

    it('reports on a board that has no features at all', () => {
        // The view used to be gated entirely on feature parents, so a board of
        // plain tasks rendered "No feature stats yet" and no charts.
        const c = manager();
        c.boardMode = 'stats';
        c.taskCache = {
            1: { id: 1, title: 'A', created: '2026-07-01T00:00:00Z', done: true, done_at: '2026-07-02T00:00:00Z' },
            2: { id: 2, title: 'B', created: '2026-07-01T00:00:00Z', done: false },
            3: { id: 3, title: 'C', created: '2026-07-02T00:00:00Z', done: false },
        };
        const container = document.createElement('div');
        document.body.appendChild(container);

        c.renderBoardLayout(container, [{ id: 9, title: 'Phi' }], { id: 9, title: 'Phi' }, { id: 5 }, []);

        expect(container.querySelector('.kanban-stats-view')).toBeTruthy();
        expect(container.textContent).toContain('1/3');
        expect(container.textContent).not.toContain('No task stats yet');
        // Features are absent, so that card is omitted rather than shown as 0/0.
        expect(container.textContent).not.toContain('subtasks done');
        expect(container.querySelectorAll('.kanban-chart-wrap canvas')).toHaveLength(4);
    });

    it('keeps features as a secondary card when they exist', () => {
        const c = manager();
        c.boardMode = 'stats';
        c.taskCache = {
            1: { id: 1, done: false, related_tasks: { subtask: [child(2, true), child(3, false)] } },
            4: { id: 4, done: false },
        };
        const container = document.createElement('div');
        document.body.appendChild(container);

        c.renderBoardLayout(container, [{ id: 9, title: 'Phi' }], { id: 9, title: 'Phi' }, { id: 5 }, []);

        expect(container.textContent).toContain('Features');
        expect(container.textContent).toContain('1/2 subtasks done');
    });

    it('uses the active Phi theme for all Stats charts', () => {
        const c = manager();
        c.boardMode = 'stats';
        c.taskCache = {
            1: { id: 1, created: '2026-07-01T00:00:00Z', done: true, done_at: new Date().toISOString(), related_tasks: { subtask: [child(2, true)] } },
            3: { id: 3, created: '2026-07-02T00:00:00Z', done: false, related_tasks: { subtask: [child(4, false)] } },
        };
        c.buckets = [{ id: 10, title: 'Review', tasks: [{ id: 1 }] }];
        document.documentElement.style.setProperty('--accent', '#123456');
        document.documentElement.style.setProperty('--text-muted', '#777777');
        document.documentElement.style.setProperty('--bg-border', '#333333');
        document.documentElement.style.setProperty('--bg-panel', '#111111');
        document.documentElement.style.setProperty('--text-primary', '#eeeeee');
        const Chart = vi.fn(function () { return { destroy: vi.fn() }; });
        vi.stubGlobal('Chart', Chart);
        const container = document.createElement('div');
        document.body.appendChild(container);

        c.renderBoardLayout(container, [{ id: 9, title: 'Phi' }], { id: 9, title: 'Phi' }, { id: 5 }, []);

        expect(Chart).toHaveBeenCalledTimes(4);
        expect(Chart.mock.calls[0][1].data.datasets[0].backgroundColor[0]).toBe('#123456');
        expect(c.statsCharts).toHaveLength(4);
    });

    it('renders Vikunja HTML descriptions through the one shared safe component', () => {
        const c = manager();
        vi.stubGlobal('DOMPurify', createDOMPurify(window));
        const source = '<h3>Plan</h3><p><strong>Ship</strong> it</p><img src="x" onerror="alert(1)"><script>alert(2)</script>';
        const host = document.createElement('div');
        host.innerHTML = c.renderTaskDescriptionField(source);
        document.body.appendChild(host);
        c.wireTaskDescriptionField(host);

        expect(host.querySelector('.kdp-description-view h3').textContent).toBe('Plan');
        expect(host.querySelector('.kdp-description-view strong').textContent).toBe('Ship');
        expect(host.querySelector('.kdp-description-view script')).toBeNull();
        expect(host.querySelector('.kdp-description-view img').hasAttribute('onerror')).toBe(false);
        expect(host.querySelector('.kdp-description-input').value).toBe(source);

        host.querySelector('.kdp-description-toggle').click();
        const editor = host.querySelector('.kdp-description-input');
        editor.value = '<p>Updated <em>HTML</em></p><iframe src="x"></iframe>';
        host.querySelector('.kdp-description-toggle').click();
        expect(host.querySelector('.kdp-description-view em').textContent).toBe('HTML');
        expect(host.querySelector('.kdp-description-view iframe')).toBeNull();
        expect(c.taskDescriptionValue(host)).toBe(editor.value);
    });

    it('renders subtasks and their burn-up chart in the detail drawer', () => {
        const c = manager();
        const html = c.renderFeatureDetailSection({
            id: 1,
            related_tasks: { subtask: [child(2, true, '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z')] }
        });

        expect(html).toContain('kdp-subtask-row done');
        expect(html).toContain('kdp-subtask-open');
        expect(html).toContain('<svg');
        expect(html).toContain('Filed 1');
        expect(html).toContain('Completed 1');

        const panel = document.createElement('div');
        const container = document.createElement('div');
        panel.innerHTML = html;
        c.openTaskDetail = vi.fn();
        c.wireFeatureDetailSection(panel, {
            id: 1,
            related_tasks: { subtask: [child(2, true, '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z')] }
        }, panel, container);
        panel.querySelector('.kdp-subtask-open').click();
        expect(c.openTaskDetail).toHaveBeenCalledWith('2', panel.querySelector('.kdp-subtask-open'), container);
    });

    it('marks the parent done without mutating its subtasks', async () => {
        const c = manager();
        const feature = { id: 1, title: 'Ship it', done: false, related_tasks: { subtask: [child(2, true)] } };
        c.taskCache = { 1: feature, 2: feature.related_tasks.subtask[0] };
        c.setTaskDone = vi.fn(async () => ({ ...feature, done: true }));
        c.loadAndRenderBoard = vi.fn(async () => {});
        c.refreshBoard = vi.fn(async () => {});
        const container = document.createElement('div');
        document.body.appendChild(container);

        c.renderBoardLayout(container, [{ id: 9, title: 'Phi' }], { id: 9, title: 'Phi' }, { id: 5 }, []);
        container.querySelector('.kanban-feature-done-btn').click();
        await vi.waitFor(() => expect(c.setTaskDone).toHaveBeenCalledWith(feature, true));

        expect(feature.related_tasks.subtask[0].done).toBe(true);
        // A feature roll-up is re-derived in place, never by blanking the board.
        expect(c.refreshBoard).toHaveBeenCalledWith(container);
        expect(c.loadAndRenderBoard).not.toHaveBeenCalled();
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
