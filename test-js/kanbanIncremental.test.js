// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { KanbanManager } from '../web/kanban.js';

// Incremental board rendering.
//
// An edit used to blank the board to a spinner, refetch four endpoints, and
// rebuild every node — losing scroll position, the active filter, and any
// sense that the click did something. The board is single-user in practice,
// so local state is authoritative between refreshes: a mutation now repaints
// the one card it touched and rolls back if the server refuses.
//
// These tests pin the two properties that make that safe:
//   1. a repainted card is still fully interactive (delegated listeners), and
//   2. a rejected mutation leaves no optimistic state behind.

setupDomHarness();

const PROJECTS = [{ id: 9, title: 'Phi' }];
const VIEW = { id: 5, view_kind: 'kanban' };

function task(id, over = {}) {
    return {
        id,
        title: `Task ${id}`,
        done: false,
        labels: [],
        assignees: [],
        bucket_id: 10,
        ...over,
    };
}

// A mounted board with two columns, wired exactly as the real render path
// leaves it (delegates bound, boardContainer set).
function mountBoard({ tasks = [task(1), task(2)] } = {}) {
    sessionStorage.setItem('vikunja_token', 'tok');
    localStorage.setItem('vikunja_url', 'http://vik.local');

    const c = Object.create(KanbanManager.prototype);
    c.app = { showToast: vi.fn() };
    c.taskCache = {};
    c.currentProjectId = 9;
    c.currentViewId = 5;
    c.boardMode = 'board';
    c.showDoneFeatures = false;
    c.statsCharts = [];
    c.filterQuery = '';
    c._dragActive = false;
    c._boardClickHandler = null;
    c._boardDelegateHost = null;
    c.activeDetailPanel = null;
    c.activeOverlay = null;
    c.escListener = null;

    const buckets = [
        {
            id: 10,
            title: 'Todo',
            tasks: tasks.filter((t) => t.bucket_id === 10),
        },
        {
            id: 20,
            title: 'Done',
            tasks: tasks.filter((t) => t.bucket_id === 20),
        },
    ];
    c.buckets = buckets;
    for (const t of tasks) c.taskCache[String(t.id)] = t;

    const container = document.createElement('div');
    document.body.appendChild(container);
    c.boardContainer = container;
    c.renderBoardLayout(container, PROJECTS, PROJECTS[0], VIEW, buckets);

    return { c, container };
}

const cardTitles = (container) =>
    [...container.querySelectorAll('.kanban-card')].map(
        (el) => el.querySelector('.kanban-card-title').textContent,
    );

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
});

// ---------------------------------------------------------------------------
// Card patching
// ---------------------------------------------------------------------------

describe('patching a single card', () => {
    it('repaints only the card that changed', () => {
        const { c, container } = mountBoard();
        const untouched = c.cardEl(2);

        c.upsertTaskState({ ...c.taskCache['1'], title: 'Renamed' });
        c.patchCard(1);

        expect(cardTitles(container)).toEqual(['Renamed', 'Task 2']);
        // Node identity proves the other card was not re-created.
        expect(c.cardEl(2)).toBe(untouched);
    });

    it('keeps buckets[].tasks and taskCache in agreement', () => {
        const { c } = mountBoard();

        c.upsertTaskState({ ...c.taskCache['1'], title: 'Renamed' });

        expect(c.taskCache['1'].title).toBe('Renamed');
        expect(c.buckets[0].tasks.find((t) => t.id === 1).title).toBe(
            'Renamed',
        );
    });

    it('re-applies the active filter to a repainted card', () => {
        const { c } = mountBoard();
        c.filterQuery = 'zzz';

        c.patchCard(1);

        // Without this the patch would resurrect a card the filter had hidden.
        expect(c.cardEl(1).classList.contains('hidden-by-filter')).toBe(true);
    });

    it('is a no-op when the board is not mounted', () => {
        const { c } = mountBoard();
        c.boardContainer = null;
        expect(() => c.patchCard(1)).not.toThrow();
        expect(() => c.removeCard(1)).not.toThrow();
        expect(() => c.insertCard(task(3), 10)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// Delegation — the prerequisite for patching cards at all
// ---------------------------------------------------------------------------

describe('delegated card actions', () => {
    it('delete still fires on a card that was repainted', async () => {
        const { c, container } = mountBoard();
        vi.stubGlobal(
            'confirm',
            vi.fn(() => true),
        );
        c.deleteTask = vi.fn(async () => {});

        // Replace the node, exactly as an optimistic update does.
        c.patchCard(1);
        c.cardEl(1).querySelector('.kanban-card-delete-btn').click();

        await vi.waitFor(() =>
            expect(c.deleteTask).toHaveBeenCalledWith('1', container),
        );
    });

    it('does not stack handlers across re-renders', async () => {
        const { c, container } = mountBoard();
        vi.stubGlobal(
            'confirm',
            vi.fn(() => true),
        );
        c.deleteTask = vi.fn(async () => {});

        // renderBoardLayout reassigns innerHTML, which discards listeners on
        // descendants but not on the container itself.
        c.renderBoardLayout(container, PROJECTS, PROJECTS[0], VIEW, c.buckets);
        c.renderBoardLayout(container, PROJECTS, PROJECTS[0], VIEW, c.buckets);
        c.cardEl(1).querySelector('.kanban-card-delete-btn').click();

        await vi.waitFor(() => expect(c.deleteTask).toHaveBeenCalledTimes(1));
    });

    it('cleanup detaches the delegate', () => {
        const { c, container } = mountBoard();
        vi.stubGlobal(
            'confirm',
            vi.fn(() => true),
        );
        c.deleteTask = vi.fn(async () => {});
        c.destroyStatsCharts = vi.fn();

        const card = c.cardEl(1);
        c.cleanup();
        card.querySelector('.kanban-card-delete-btn').click();

        expect(c.deleteTask).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Optimistic mutations
// ---------------------------------------------------------------------------

describe('optimistic task mutations', () => {
    it('shows a rename before the server answers', async () => {
        const { c, container } = mountBoard();
        let release;
        mockFetch(
            () =>
                new Promise((resolve) => {
                    release = () => resolve({ ok: true, json: {} });
                }),
        );

        const saving = c.saveTaskDetail(
            c.taskCache['1'],
            { title: 'Instant' },
            null,
            container,
        );

        // The point of the exercise: repainted before the round-trip resolves.
        await vi.waitFor(() =>
            expect(cardTitles(container)).toContain('Instant'),
        );
        release();
        await saving;
        expect(cardTitles(container)).toEqual(['Instant', 'Task 2']);
    });

    it('rolls a rejected rename back to the previous title', async () => {
        const { c, container } = mountBoard();
        mockFetch(() => ({ ok: false, status: 500, text: 'boom' }));

        await expect(
            c.saveTaskDetail(
                c.taskCache['1'],
                { title: 'Doomed' },
                null,
                container,
            ),
        ).rejects.toThrow();

        expect(cardTitles(container)).toEqual(['Task 1', 'Task 2']);
        expect(c.taskCache['1'].title).toBe('Task 1');
        expect(c.buckets[0].tasks.find((t) => t.id === 1).title).toBe('Task 1');
    });

    it('refreshes aggregates in Features mode, where there is no card to patch', async () => {
        const { c, container } = mountBoard();
        c.boardMode = 'features';
        c.refreshBoard = vi.fn(async () => {});
        mockFetch(() => ({ ok: true, json: {} }));

        await c.saveTaskDetail(
            c.taskCache['1'],
            { title: 'Renamed' },
            null,
            container,
        );

        expect(c.refreshBoard).toHaveBeenCalled();
    });

    it('marks a card done without reloading the board', async () => {
        const { c, container } = mountBoard();
        c.loadAndRenderBoard = vi.fn(async () => {});
        mockFetch(() => ({ ok: true, json: { id: 1, done: true } }));

        await c.setTaskDone(c.taskCache['1'], true);

        expect(c.cardEl(1).classList.contains('kanban-card--done')).toBe(true);
        expect(c.loadAndRenderBoard).not.toHaveBeenCalled();
    });

    it('restores done state when the update is rejected', async () => {
        const { c } = mountBoard();
        mockFetch(() => ({ ok: false, status: 500, text: 'boom' }));

        await expect(c.setTaskDone(c.taskCache['1'], true)).rejects.toThrow();

        expect(c.taskCache['1'].done).toBe(false);
        expect(c.cardEl(1).classList.contains('kanban-card--done')).toBe(false);
    });

    it('removes a deleted card and restores it on failure', async () => {
        const { c, container } = mountBoard();

        mockFetch(() => ({ ok: true, status: 204 }));
        await c.deleteTask('1', container);
        expect(cardTitles(container)).toEqual(['Task 2']);
        expect(
            container.querySelector('.kanban-column .column-count').textContent,
        ).toBe('1');

        mockFetch(() => ({ ok: false, status: 500, text: 'boom' }));
        await expect(c.deleteTask('2', container)).rejects.toThrow();
        expect(cardTitles(container)).toEqual(['Task 2']);
        expect(c.taskCache['2']).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// Cache integrity
//
// Task writes send the whole object back (taskUpdatePayload spreads ...task),
// so a cached field that disagrees with the server is not a display glitch —
// the NEXT save persists it. These pin the three ways that could happen.
// ---------------------------------------------------------------------------

describe('the cache never keeps a value the server did not accept', () => {
    it('keeps full labels when the server replies 204 with no body', async () => {
        // The wire payload strips labels to bare {id}. Caching those stubs
        // would blank the pills and send the stubs back on the next save.
        const labelled = task(1, {
            labels: [{ id: 7, title: 'bug', hex_color: 'ff0000' }],
        });
        const { c } = mountBoard({ tasks: [labelled, task(2)] });
        mockFetch(() => ({ ok: true, status: 204 }));

        await c.saveTaskDetail(
            c.taskCache['1'],
            { title: 'Renamed' },
            null,
            c.boardContainer,
        );

        expect(c.taskCache['1'].title).toBe('Renamed');
        expect(c.taskCache['1'].labels).toEqual([
            { id: 7, title: 'bug', hex_color: 'ff0000' },
        ]);
    });

    it('re-reads the task from the server after a rejected write', async () => {
        // A write can land and still surface as a failure (response lost). The
        // snapshot would then silently revert a change the user really saved,
        // so the task is re-read rather than assumed either way.
        const { c } = mountBoard();
        const calls = [];
        mockFetch((url, opts) => {
            const target = decodeURIComponent(
                String(url).split('url=')[1] || '',
            );
            calls.push(
                `${opts?.method || 'GET'} ${target.replace(/^.*\/api\/v1/, '')}`,
            );
            if ((opts?.method || 'GET') === 'GET') {
                return {
                    ok: true,
                    json: {
                        id: 1,
                        title: 'Server Won',
                        labels: [],
                        assignees: [],
                    },
                };
            }
            return { ok: false, status: 500, text: 'boom' };
        });

        await expect(
            c.saveTaskDetail(
                c.taskCache['1'],
                { title: 'Doomed' },
                null,
                c.boardContainer,
            ),
        ).rejects.toThrow();

        expect(calls).toContain('GET /tasks/1');
        expect(c.taskCache['1'].title).toBe('Server Won');
    });

    it('serializes overlapping writes so a rollback cannot discard the next edit', async () => {
        const { c } = mountBoard();
        const sent = [];
        let firstReject;
        mockFetch((_url, opts) => {
            if ((opts?.method || 'GET') === 'GET') {
                return {
                    ok: true,
                    json: { id: 1, title: 'Task 1', labels: [], assignees: [] },
                };
            }
            const body = JSON.parse(opts.body);
            sent.push(body.title);
            if (sent.length === 1) {
                return new Promise((_, reject) => {
                    firstReject = () => reject(new Error('boom'));
                });
            }
            return {
                ok: true,
                json: { id: 1, title: body.title, labels: [], assignees: [] },
            };
        });

        const first = c.saveTaskDetail(
            c.taskCache['1'],
            { title: 'First' },
            null,
            c.boardContainer,
        );
        const second = c.saveTaskDetail(
            c.taskCache['1'],
            { title: 'Second' },
            null,
            c.boardContainer,
        );

        // The second write must not begin until the first has settled.
        await vi.waitFor(() => expect(sent).toEqual(['First']));
        firstReject();

        await expect(first).rejects.toThrow();
        await second;

        // The winner is the last write the server accepted, not a rollback.
        expect(sent).toEqual(['First', 'Second']);
        expect(c.taskCache['1'].title).toBe('Second');
    });

    it('setTaskDone keeps server fields merged by the mutation', async () => {
        const { c } = mountBoard();
        mockFetch(() => ({
            ok: true,
            json: { id: 1, done: true, identifier: 'PHI-1', index: 4 },
        }));

        const next = await c.setTaskDone(c.taskCache['1'], true);

        // Built from the cache, not the caller's pre-write snapshot.
        expect(next.identifier).toBe('PHI-1');
        expect(c.taskCache['1'].index).toBe(4);
    });
});

// ---------------------------------------------------------------------------
// Feature rows
//
// A roll-up is derived from its subtasks, so a subtask change only moves the
// parent's progress — that is a repaint. Completing the parent is structural:
// done features are hidden by default, so the row leaves the list and the
// "Show done" count changes with it.
// ---------------------------------------------------------------------------

describe('feature roll-ups', () => {
    const sub = (id, done) => ({ id, title: `Sub ${id}`, done });

    function mountFeatures() {
        const parent = {
            id: 1,
            title: 'Ship it',
            done: false,
            labels: [],
            assignees: [],
            related_tasks: { subtask: [sub(2, true), sub(3, false)] },
        };
        const { c, container } = mountBoard({ tasks: [parent] });
        c.boardMode = 'features';
        c.renderBoardLayout(container, PROJECTS, PROJECTS[0], VIEW, c.buckets);
        return { c, container, parent };
    }

    const rowText = (container) =>
        container.querySelector('.kanban-feature-row')?.textContent || '';

    it('repaints the row when a subtask completes, without refetching', async () => {
        const { c, container, parent } = mountFeatures();
        expect(rowText(container)).toContain('1/2');

        c.refreshBoard = vi.fn(async () => {});
        c.setTaskDone = vi.fn(async (task, done) => ({ ...task, done }));

        const next = c.withSubtask(parent, { ...sub(3, true) });
        c.patchFeatureRow(next.id);

        expect(rowText(container)).toContain('2/2');
        expect(c.refreshBoard).not.toHaveBeenCalled();
    });

    it('keeps a repainted row clickable', () => {
        const { c, container, parent } = mountFeatures();
        c.openTaskDetail = vi.fn();

        // Replace the node, then interact with the replacement.
        c.withSubtask(parent, { ...sub(3, true) });
        c.patchFeatureRow(1);
        container.querySelector('.kanban-feature-row').click();

        expect(c.openTaskDetail).toHaveBeenCalledWith(
            '1',
            expect.anything(),
            container,
        );
    });

    it('keeps keyboard activation working on a repainted row', () => {
        const { c, container } = mountFeatures();
        c.openTaskDetail = vi.fn();
        c.patchFeatureRow(1);

        const row = container.querySelector('.kanban-feature-row');
        row.dispatchEvent(
            new window.KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
            }),
        );

        expect(c.openTaskDetail).toHaveBeenCalledWith('1', row, container);
    });

    it('still refreshes when the parent itself is completed', async () => {
        const { c, container } = mountFeatures();
        vi.stubGlobal(
            'confirm',
            vi.fn(() => true),
        );
        c.setTaskDone = vi.fn(async (task, done) => ({ ...task, done }));
        c.refreshBoard = vi.fn(async () => {});

        container.querySelector('.kanban-feature-done-btn').click();

        await vi.waitFor(() =>
            expect(c.refreshBoard).toHaveBeenCalledWith(container),
        );
    });

    it('does not stack feature delegates across re-renders', async () => {
        const { c, container } = mountFeatures();
        c.openTaskDetail = vi.fn();

        c.renderBoardLayout(container, PROJECTS, PROJECTS[0], VIEW, c.buckets);
        c.renderBoardLayout(container, PROJECTS, PROJECTS[0], VIEW, c.buckets);
        container.querySelector('.kanban-feature-row').click();

        expect(c.openTaskDetail).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// Refresh without blanking
// ---------------------------------------------------------------------------

describe('refreshBoard', () => {
    function stubBoardFetch(_c, tasks) {
        mockFetch((url) => {
            const target = decodeURIComponent(
                String(url).split('url=')[1] || '',
            );
            if (target.includes('/views?')) return { ok: true, json: [VIEW] };
            if (target.includes('/views/5/tasks')) {
                return {
                    ok: true,
                    json: [
                        {
                            id: 10,
                            title: 'Todo',
                            tasks: tasks.filter((t) => t.bucket_id === 10),
                        },
                        {
                            id: 20,
                            title: 'Done',
                            tasks: tasks.filter((t) => t.bucket_id === 20),
                        },
                    ],
                };
            }
            if (target.includes('expand=subtasks'))
                return { ok: true, json: tasks };
            if (target.includes('/projects?'))
                return { ok: true, json: PROJECTS };
            return { ok: true, json: [] };
        });
    }

    it('never blanks the board to a spinner', async () => {
        const { c, container } = mountBoard();
        stubBoardFetch(c, [task(1), task(2)]);

        const refreshing = c.refreshBoard(container);
        // The old path assigned a loading wrapper synchronously.
        expect(container.querySelector('.kanban-loading-wrapper')).toBeNull();
        expect(container.querySelectorAll('.kanban-card').length).toBe(2);
        await refreshing;

        expect(container.querySelector('.kanban-loading-wrapper')).toBeNull();
        expect(cardTitles(container)).toEqual(['Task 1', 'Task 2']);
    });

    it('keeps the filter text and re-applies it after the swap', async () => {
        const { c, container } = mountBoard();
        const input = container.querySelector('#kanban-search-input');
        input.value = 'Task 2';
        stubBoardFetch(c, [task(1), task(2)]);

        await c.refreshBoard(container);

        expect(container.querySelector('#kanban-search-input').value).toBe(
            'Task 2',
        );
        expect(c.cardEl(1).classList.contains('hidden-by-filter')).toBe(true);
        expect(c.cardEl(2).classList.contains('hidden-by-filter')).toBe(false);
    });

    it('restores column scroll position', async () => {
        const { c, container } = mountBoard();
        const list = container.querySelector(
            '.kanban-cards-list[data-bucket-id="10"]',
        );
        list.scrollTop = 120;
        stubBoardFetch(c, [task(1), task(2)]);

        await c.refreshBoard(container);

        expect(
            container.querySelector('.kanban-cards-list[data-bucket-id="10"]')
                .scrollTop,
        ).toBe(120);
    });

    it('clears the syncing indicator even when the load fails', async () => {
        const { c, container } = mountBoard();
        mockFetch(() => ({ ok: false, status: 500, text: 'boom' }));

        await c.refreshBoard(container);

        const pip = container.querySelector('#kanban-sync-indicator');
        expect(pip === null || !pip.classList.contains('is-syncing')).toBe(
            true,
        );
    });

    it('is a no-op when no board is mounted', async () => {
        const { c } = mountBoard();
        mockFetch(() => ({ ok: true, json: [] }));
        c.boardContainer = null;

        await expect(c.refreshBoard(null)).resolves.toBeUndefined();

        // A mutation fired from a detached drawer must not refetch blindly.
        expect(fetch).not.toHaveBeenCalled();
    });
});
