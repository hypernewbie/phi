// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { SessionsManager } from '../web/sessions.js';
import { App } from '../web/app.js';
import { rebuildRegistry, seedBuiltins } from '../web/coders.js';

setupDomHarness();
afterEach(() => {
    vi.useRealTimers();
    seedBuiltins();
});

const sessionUrl = (offset = 0, coder = 'pi', cwd = '/work/demo', limit = 10) =>
    `/api/sessions?coder=${encodeURIComponent(coder)}&cwd=${encodeURIComponent(cwd)}&limit=${limit}&offset=${offset}`;
const cacheKey = (url, profile = '') =>
    `phi_session_cache_v1:${encodeURIComponent(window.location.origin)}:${encodeURIComponent(url)}:${encodeURIComponent(profile)}`;
const cacheValue = (data) => JSON.stringify({ v: 1, saved_at: 1, data });
const session = (id, title = id) => ({
    id,
    title,
    cwd: '/work/demo',
    coder: 'pi',
    time_updated: '2026-10-01T12:00:00Z',
});

function makeManager({ coder = 'pi', scope: suppliedScope } = {}) {
    const scope = suppliedScope ?? {
        profileId: '',
        origin: window.location.origin,
        headers: () => ({}),
        signal: new AbortController().signal,
    };
    const store = { responses: new Map() };
    const list = document.createElement('div');
    const section = document.createElement('div');
    section.className = 'worktree-section active expanded';
    section.dataset.worktreePath = '/work/demo';
    const container = document.createElement('div');
    container.className = 'worktree-sessions-container';
    section.appendChild(container);
    list.appendChild(section);
    document.body.appendChild(list);
    const status = document.createElement('div');
    status.id = 'session-refresh-status';
    document.body.appendChild(status);
    const app = {
        scope,
        getActiveStore: () => store,
        tabManager: {
            tabs: new Map(),
            getActiveTab: vi.fn(() => null),
        },
        diffController: { refreshDiff: vi.fn() },
        showToast: vi.fn(),
    };
    const manager = Object.assign(Object.create(SessionsManager.prototype), {
        app,
        activeCoder: coder,
        activeWorkspace: '/work',
        activeCWD: '/work/demo',
        sessionListPageSize: 10,
        sessionList: list,
        worktreeLoadRequestId: 0,
        worktreeDirtyRequestId: 0,
        worktreeRootGeneration: 1,
        worktreeRootOwner: { scope, coder, workspace: '/work' },
        sessionRequests: new Map(),
        worktreeReads: new Map(),
        sessionRefreshPromise: null,
        sessionRefreshGeneration: 0,
    });
    return { manager, container, list, store, scope, app, section };
}

describe('Refresh Sessions MVP loader', () => {
    it('refreshes offset zero in place and keeps the old rows while waiting', async () => {
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        const fetchMock = mockFetch(() => gate);
        const { manager, container, store } = makeManager();
        manager.renderWorktreeSessionsList(
            [session('old')],
            '/work/demo',
            container,
        );

        const pending = manager.loadWorktreeSessions(
            '/work/demo',
            container,
            0,
            {
                refresh: true,
            },
        );
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
        expect(fetchMock.mock.calls[0][0]).toBe(sessionUrl(0));
        expect(container.textContent).toContain('old');
        expect(fetchMock.mock.calls[0][1]).toMatchObject({
            cache: 'no-store',
            credentials: 'same-origin',
        });

        release([session('new', 'New session')]);
        await expect(pending).resolves.toBe('updated');
        expect(container.textContent).toContain('New session');
        expect(container.textContent).not.toContain('old');
        expect(store.responses.has(cacheKey(sessionUrl(0)))).toBe(true);
    });

    it('keeps rows and reports a failed refresh', async () => {
        mockFetch(() => ({ ok: false, status: 500, text: '<b>offline</b>' }));
        const { manager, container } = makeManager();
        manager.renderWorktreeSessionsList(
            [session('kept')],
            '/work/demo',
            container,
        );

        await expect(
            manager.loadWorktreeSessions('/work/demo', container, 0, {
                refresh: true,
            }),
        ).resolves.toBe('failed');
        expect(container.textContent).toContain('kept');
        expect(container.querySelector('.error-sessions b')).toBeNull();
        expect(
            container.querySelector('.error-sessions').textContent,
        ).toContain('<b>offline</b>');
    });

    it('treats an empty refreshed page as success', async () => {
        mockFetch(() => []);
        const { manager, container } = makeManager();
        manager.renderWorktreeSessionsList(
            [session('old')],
            '/work/demo',
            container,
        );

        await expect(
            manager.loadWorktreeSessions('/work/demo', container, 0, {
                refresh: true,
            }),
        ).resolves.toBe('updated');
        expect(container.querySelector('.session-item')).toBeNull();
        expect(container.textContent).toContain('No sessions found');
    });

    it('does not send a manual refresh while an inline draft is open', async () => {
        const fetchMock = mockFetch(() => [session('unexpected')]);
        const { manager, container } = makeManager();
        const draft = document.createElement('input');
        draft.className = 'rename-input';
        draft.value = 'Unsaved title';
        container.appendChild(draft);

        await expect(
            manager.loadWorktreeSessions('/work/demo', container, 0, {
                refresh: true,
            }),
        ).resolves.toBe('editing');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(container.querySelector('.rename-input')).toBe(draft);
    });

    it('does not replace an edit when an older session reply arrives', async () => {
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        mockFetch(() => gate);
        const { manager, container, store } = makeManager();
        manager.renderWorktreeSessionsList(
            [session('old', 'Old title')],
            '/work/demo',
            container,
        );
        const row = container.querySelector('.session-item');
        const pending = manager.loadWorktreeSessions('/work/demo', container);
        manager.openInlineRenamer(row, 'old', 'Old title');
        const input = row.querySelector('.rename-input');
        input.value = 'Unsaved title';

        release([session('fresh')]);
        await expect(pending).resolves.toBe('editing');
        expect(row.querySelector('.rename-input')).toBe(input);
        expect(input.value).toBe('Unsaved title');
        expect(store.responses.has(cacheKey(sessionUrl(0)))).toBe(true);
    });

    it('rejects malformed pages without replacing the displayed rows', async () => {
        mockFetch(() => [session('valid'), null]);
        const { manager, container, store } = makeManager();
        manager.renderWorktreeSessionsList(
            [session('kept')],
            '/work/demo',
            container,
        );

        await expect(
            manager.loadWorktreeSessions('/work/demo', container, 0, {
                refresh: true,
            }),
        ).resolves.toBe('failed');
        expect(container.textContent).toContain('kept');
        expect(store.responses.has(cacheKey(sessionUrl(0)))).toBe(false);
    });

    it('times out and clears pending state even when fetch ignores abort', async () => {
        const fetchMock = vi.fn(() => new Promise(() => {}));
        vi.stubGlobal('fetch', fetchMock);
        vi.useFakeTimers();
        const { manager, container } = makeManager();
        manager.renderWorktreeSessionsList(
            [session('kept')],
            '/work/demo',
            container,
        );

        const pending = manager.loadWorktreeSessions(
            '/work/demo',
            container,
            0,
            {
                refresh: true,
            },
        );
        expect(fetchMock).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(45_000);
        await expect(pending).resolves.toBe('failed');
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
        expect(container.dataset.sessionPendingOffset).toBeUndefined();
        expect(container.textContent).toContain('kept');
        expect(container.querySelector('.error-sessions')).not.toBeNull();
    });

    it('does not send a request for an already-aborted backend scope', async () => {
        const controller = new AbortController();
        controller.abort();
        const scope = {
            profileId: '',
            origin: window.location.origin,
            headers: () => ({}),
            signal: controller.signal,
        };
        const fetchMock = mockFetch(() => [session('unexpected')]);
        const { manager, container } = makeManager({ scope });

        await expect(
            manager.loadWorktreeSessions('/work/demo', container, 0, {
                refresh: true,
            }),
        ).resolves.toBe('superseded');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps an open draft when a same-owner worktree load starts and replies', async () => {
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        const fetchMock = mockFetch(() => gate);
        const { manager, container } = makeManager();
        const input = document.createElement('input');
        input.className = 'rename-input';
        input.value = 'Unsaved title';
        container.appendChild(input);

        const pending = manager.loadWorktrees();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(container.querySelector('.rename-input')).toBe(input);

        input.remove();
        const next = manager.loadWorktrees();
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
        const draft = document.createElement('input');
        draft.className = 'rename-input';
        draft.value = 'New draft';
        container.appendChild(draft);
        release([{ path: '/work/demo', active: true }]);
        await Promise.all([pending, next]);
        expect(container.querySelector('.rename-input')).toBe(draft);
    });

    it('invalidates an active profile before a forgotten reply can restore its cache', async () => {
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        const profileId = 'refresh-profile';
        const scope = {
            profileId,
            origin: window.location.origin,
            headers: () => ({ 'X-Phi-Backend': profileId }),
            signal: new AbortController().signal,
        };
        vi.stubGlobal(
            'fetch',
            vi.fn(() => gate),
        );
        const { manager, container, store } = makeManager({ scope });
        manager.renderWorktreeSessionsList(
            [session('kept')],
            '/work/demo',
            container,
        );
        const pending = manager.loadWorktreeSessions(
            '/work/demo',
            container,
            0,
            {
                refresh: true,
            },
        );
        const app = Object.assign(Object.create(App.prototype), {
            sessionsManager: manager,
        });

        app.forgetBackend(profileId);
        await expect(pending).resolves.toBe('superseded');
        release({ ok: true, status: 200, json: async () => [session('late')] });
        await Promise.resolve();
        await Promise.resolve();
        expect(container.textContent).toContain('kept');
        expect(container.textContent).not.toContain('late');
        expect(store.responses.size).toBe(0);
    });

    it('does not send a worktree-state write when Refresh Sessions is activated', async () => {
        const button = document.createElement('button');
        button.id = 'refresh-sessions-btn';
        document.body.appendChild(button);
        const status = document.createElement('div');
        status.id = 'session-refresh-status';
        document.body.appendChild(status);
        const fetchMock = mockFetch(() => [session('fresh')]);
        const { manager, container } = makeManager();
        manager.renderWorktreeSessionsList(
            [session('old')],
            '/work/demo',
            container,
        );

        await manager.refreshSessions();
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            sessionUrl(0),
        ]);
    });

    it('does not cache or render a late reply after owner cancellation', async () => {
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        const fetchMock = vi.fn(() => gate);
        vi.stubGlobal('fetch', fetchMock);
        const { manager, container, store } = makeManager();
        manager.renderWorktreeSessionsList(
            [session('kept')],
            '/work/demo',
            container,
        );

        const pending = manager.loadWorktreeSessions(
            '/work/demo',
            container,
            0,
            {
                refresh: true,
            },
        );
        manager.onSessionContextChange();
        await expect(pending).resolves.toBe('superseded');
        release({
            ok: true,
            status: 200,
            json: async () => [session('late')],
            text: async () => '',
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(container.textContent).toContain('kept');
        expect(container.textContent).not.toContain('late');
        expect(store.responses.has(cacheKey(sessionUrl(0)))).toBe(false);
    });

    it('invalidates the namespace on 401 before reading a stalled error body', async () => {
        const text = vi.fn(() => new Promise(() => {}));
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 401,
                text,
                json: async () => null,
            })),
        );
        const { manager, container, store } = makeManager();
        const key = cacheKey(sessionUrl(0));
        store.responses.set(key, cacheValue([session('saved')]));
        manager.renderWorktreeSessionsList(
            [session('visible')],
            '/work/demo',
            container,
        );

        await expect(
            manager.loadWorktreeSessions('/work/demo', container, 0, {
                refresh: true,
            }),
        ).resolves.toBe('failed');
        expect(text).not.toHaveBeenCalled();
        expect(store.responses.has(key)).toBe(false);
        expect(container.textContent).toContain('visible');
        expect(
            document.getElementById('session-refresh-status')?.textContent,
        ).toContain('Authentication is required');
        store.responses.set(
            '/api/git/worktrees?cwd=%2Fwork',
            JSON.stringify([{ path: '/work/legacy' }]),
        );
        const app = Object.assign(Object.create(App.prototype), {
            sessionsManager: manager,
            tabManager: null,
            syncManager: null,
        });
        app.paintBackendFromStore(store);
        expect(container.textContent).toContain('visible');
        expect(
            manager.sessionList.querySelector(
                '[data-worktree-path="/work/legacy"]',
            ),
        ).toBeNull();
    });

    it('accepts a later authorized response after namespace rejection', async () => {
        const { manager, container, store } = makeManager();
        const key = cacheKey(sessionUrl(0));
        store.responses.set(key, cacheValue([session('saved')]));
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 403,
                text: async () => 'denied',
            })),
        );
        await manager.loadWorktreeSessions('/work/demo', container, 0, {
            refresh: true,
        });

        mockFetch(() => [session('recovered')]);
        await expect(
            manager.loadWorktreeSessions('/work/demo', container, 0, {
                refresh: true,
            }),
        ).resolves.toBe('updated');
        expect(
            manager.readCachedWorktrees(
                store,
                '/api/git/worktrees?cwd=%2Fwork',
            ),
        ).toBeNull();
        expect(store.responses.get(key)).toContain('recovered');
    });
});

describe('Refresh Sessions cache painting', () => {
    it('paints matching namespaced worktree and session data synchronously without fetch', () => {
        const { manager, list, store } = makeManager();
        const worktreeUrl = '/api/git/worktrees?cwd=%2Fwork';
        store.responses.set(
            cacheKey(worktreeUrl),
            cacheValue([{ path: '/work/demo', active: true, expanded: true }]),
        );
        store.responses.set(
            cacheKey(sessionUrl(0)),
            cacheValue([session('cached', 'Cached session')]),
        );
        store.tabs = null;
        const app = Object.assign(Object.create(App.prototype), {
            sessionsManager: manager,
            tabManager: null,
            syncManager: null,
        });
        const fetchMock = mockFetch(() => {
            throw new Error('cache paint must not fetch');
        });

        expect(app.paintBackendFromStore(store)).toBe(true);
        expect(list.querySelector('.session-item')?.textContent).toContain(
            'Cached session',
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ignores raw URL cache entries instead of painting them', () => {
        const { manager, list, store } = makeManager();
        list.replaceChildren();
        const worktreeUrl = '/api/git/worktrees?cwd=%2Fwork';
        store.responses.set(
            worktreeUrl,
            JSON.stringify([{ path: '/work/demo' }]),
        );
        store.tabs = null;
        const app = Object.assign(Object.create(App.prototype), {
            sessionsManager: manager,
            tabManager: null,
            syncManager: null,
        });

        app.paintBackendFromStore(store);
        expect(list.querySelector('.worktree-section')).toBeNull();
    });
});

describe('inline rename finish behavior', () => {
    it('Escape restores the title locally without a POST', () => {
        const { manager, container } = makeManager();
        const row = document.createElement('div');
        row.innerHTML = '<span class="session-title"></span>';
        row.querySelector('.session-title').textContent = 'Original';
        container.appendChild(row);
        const loadSessions = vi.fn();
        manager.loadSessions = loadSessions;
        const fetchMock = mockFetch(() => ({ ok: true, json: {} }));

        manager.openInlineRenamer(row, 'id-1', 'Original');
        const input = row.querySelector('.rename-input');
        input.value = 'Draft';
        input.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );

        expect(row.querySelector('.rename-input')).toBeNull();
        expect(row.querySelector('.session-title').textContent).toBe(
            'Original',
        );
        expect(fetchMock).not.toHaveBeenCalled();
        expect(loadSessions).toHaveBeenCalledOnce();
    });

    it('Enter followed by blur sends one save and restores the edited title', async () => {
        const { manager, container } = makeManager();
        const row = document.createElement('div');
        row.innerHTML = '<span class="session-title"></span>';
        row.querySelector('.session-title').textContent = 'Original';
        container.appendChild(row);
        const loadSessions = vi.fn();
        manager.loadSessions = loadSessions;
        const fetchMock = mockFetch(() => ({ ok: true, json: {} }));

        manager.openInlineRenamer(row, 'id-1', 'Original');
        const input = row.querySelector('.rename-input');
        input.value = 'Renamed';
        input.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
        input.dispatchEvent(new FocusEvent('blur'));
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
        await vi.waitFor(() =>
            expect(row.querySelector('.rename-input')).toBeNull(),
        );

        expect(fetchMock.mock.calls[0][1].method).toBe('POST');
        expect(row.querySelector('.session-title').textContent).toBe('Renamed');
        expect(loadSessions).toHaveBeenCalledOnce();
    });
});

function addTarget(manager, path, expanded = true) {
    const section = document.createElement('div');
    section.className = `worktree-section${expanded ? ' expanded' : ''}`;
    section.dataset.worktreePath = path;
    const container = document.createElement('div');
    container.className = 'worktree-sessions-container';
    section.appendChild(container);
    manager.sessionList.appendChild(section);
    return { section, container };
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('Refresh Sessions complete batch behavior', () => {
    it('deduplicates expanded plus active targets without expanding the collapsed active section', async () => {
        const { manager, section } = makeManager();
        section.classList.remove('expanded');
        addTarget(manager, '/work/expanded');
        addTarget(manager, '/work/expanded');
        addTarget(manager, '/work/hidden', false);
        const fetcher = mockFetch(() => []);
        await manager.refreshSessions();
        expect(
            fetcher.mock.calls.map(([url]) =>
                new URL(url, location.origin).searchParams.get('cwd'),
            ),
        ).toEqual(['/work/demo', '/work/expanded']);
        expect(section.classList.contains('expanded')).toBe(false);
        expect(manager.activeCWD).toBe('/work/demo');
        expect(
            document.getElementById('session-refresh-status').textContent,
        ).toBe('Sessions refreshed.');
    });

    it('refreshes the expanded Agy no-workspace section', async () => {
        const { manager } = makeManager({ coder: 'agy' });
        addTarget(manager, '--no-workspace--');
        const fetcher = mockFetch(() => []);
        await manager.refreshSessions();
        expect(
            fetcher.mock.calls.map(([url]) =>
                new URL(url, location.origin).searchParams.get('cwd'),
            ),
        ).toEqual(['/work/demo', '--no-workspace--']);
    });

    it('shows a no-target note without a request', async () => {
        const { manager, list } = makeManager();
        list.replaceChildren();
        const fetcher = mockFetch(() => []);
        await manager.refreshSessions();
        expect(fetcher).not.toHaveBeenCalled();
        expect(
            document.getElementById('session-refresh-status').textContent,
        ).toBe('No worktree to refresh.');
    });

    it('hides the control for a non-list source and uses a custom list-capable coder ID', async () => {
        const button = document.createElement('button');
        button.id = 'refresh-sessions-btn';
        document.body.appendChild(button);
        const { manager } = makeManager({ coder: 'bash' });
        const fetcher = mockFetch(() => []);
        await manager.refreshSessions();
        expect(button.hidden).toBe(true);
        expect(fetcher).not.toHaveBeenCalled();
        rebuildRegistry({
            'custom & profile': {
                name: 'Custom',
                capabilities: { list: true },
            },
        });
        manager.activeCoder = 'custom & profile';
        manager.worktreeRootOwner.coder = manager.activeCoder;
        await manager.refreshSessions();
        expect(button.hidden).toBe(false);
        expect(fetcher.mock.calls[0][0]).toBe(
            sessionUrl(0, manager.activeCoder),
        );
    });

    it('bounds the batch to four workers, coalesces clicks, and skips a queued target paged after activation', async () => {
        const { manager } = makeManager();
        for (let i = 1; i < 4; i++) addTarget(manager, `/work/${i}`);
        const fifth = addTarget(manager, '/work/fifth').container;
        const gates = [];
        const fetcher = mockFetch((url) => {
            const query = new URL(url, location.origin).searchParams;
            if (query.get('offset') === '10') return [];
            const gate = deferred();
            gates.push(gate);
            return gate.promise;
        });
        const batch = manager.refreshSessions();
        const duplicate = manager.refreshSessions();
        expect(fetcher).toHaveBeenCalledTimes(4);
        await manager.loadWorktreeSessions('/work/fifth', fifth, 10);
        expect(fifth.dataset.sessionOffset).toBe('10');
        for (const gate of gates) gate.resolve([]);
        await Promise.all([batch, duplicate]);
        expect(fetcher).toHaveBeenCalledTimes(5);
        expect(fetcher.mock.calls.map(([url]) => url)).not.toContain(
            sessionUrl(0, 'pi', '/work/fifth'),
        );
        expect(fifth.dataset.sessionOffset).toBe('10');
        expect(
            document.getElementById('session-refresh-status').textContent,
        ).toContain('1 changed');
    });

    it('drops queued work and obsolete status on owner change even if transport ignores abort', async () => {
        const { manager, container } = makeManager();
        for (let i = 1; i < 6; i++) addTarget(manager, `/work/${i}`);
        const gates = [];
        const fetcher = mockFetch(() => {
            const gate = deferred();
            gates.push(gate);
            return gate.promise;
        });
        const batch = manager.refreshSessions();
        expect(fetcher).toHaveBeenCalledTimes(4);
        manager.onSessionContextChange();
        await batch;
        for (const gate of gates) gate.resolve([session('late')]);
        await Promise.resolve();
        expect(fetcher).toHaveBeenCalledTimes(4);
        expect(container.textContent).not.toContain('late');
        expect(
            document.getElementById('session-refresh-status').textContent,
        ).toBe('');
    });

    it('retires an interrupted refresh before replacing the sidebar root', async () => {
        const button = document.createElement('button');
        button.id = 'refresh-sessions-btn';
        document.body.appendChild(button);
        const { manager, list } = makeManager();
        const gate = deferred();
        mockFetch(() => gate.promise);
        const interrupted = manager.refreshSessions();
        expect(button.getAttribute('aria-busy')).toBe('true');

        manager.renderWorktreesList(
            [{ path: '/work/demo', active: true, branch: 'changed' }],
            '/work',
            null,
            { loadSessions: false },
        );
        expect(manager.sessionRefreshPromise).toBeNull();
        expect(button.hasAttribute('aria-busy')).toBe(false);
        expect(
            document.getElementById('session-refresh-status').textContent,
        ).toBe('');

        const nextGate = deferred();
        mockFetch(() => nextGate.promise);
        const next = manager.refreshSessions();
        await interrupted;
        expect(manager.sessionRefreshPromise).not.toBeNull();
        expect(button.getAttribute('aria-busy')).toBe('true');
        nextGate.resolve([session('new-root')]);
        await next;
        expect(list.textContent).toContain('new-root');
        expect(
            document.getElementById('session-refresh-status').textContent,
        ).toBe('Sessions refreshed.');
        gate.resolve([session('obsolete-root')]);
        await Promise.resolve();
        expect(list.textContent).not.toContain('obsolete-root');
    });

    it('clears refresh state immediately on a cache-miss workspace change from a tab', async () => {
        const button = document.createElement('button');
        button.id = 'refresh-sessions-btn';
        document.body.appendChild(button);
        const { manager } = makeManager();
        const sessions = deferred();
        const worktrees = deferred();
        mockFetch((url) =>
            url.startsWith('/api/sessions')
                ? sessions.promise
                : worktrees.promise,
        );
        const interrupted = manager.refreshSessions();
        // Tab activation assigns the workspace directly before loading its tree.
        manager.activeWorkspace = '/other';
        const loading = manager.loadWorktrees();
        expect(manager.sessionRefreshPromise).toBeNull();
        expect(button.hasAttribute('aria-busy')).toBe(false);
        expect(
            document.getElementById('session-refresh-status').textContent,
        ).toBe('');
        await interrupted;
        worktrees.resolve([]);
        await loading;
        sessions.resolve([session('obsolete-workspace')]);
        await Promise.resolve();
        expect(manager.sessionList.textContent).not.toContain(
            'obsolete-workspace',
        );
    });

    it('lets manual refresh supersede ordinary same-page reads, then lets page navigation win', async () => {
        const { manager, container, store } = makeManager();
        const gates = [deferred(), deferred()];
        let calls = 0;
        mockFetch(() => (calls < 2 ? gates[calls++].promise : []));
        const ordinary = manager.loadWorktreeSessions('/work/demo', container);
        const batch = manager.refreshSessions();
        await expect(ordinary).resolves.toBe('superseded');
        await manager.loadWorktreeSessions('/work/demo', container, 10);
        await batch;
        gates[0].resolve([session('older')]);
        gates[1].resolve([session('obsolete')]);
        await Promise.resolve();
        expect(container.dataset.sessionOffset).toBe('10');
        expect(container.textContent).not.toContain('obsolete');
        expect(store.responses.has(cacheKey(sessionUrl(0)))).toBe(false);
    });

    it('reports partial failure and an editing target while allowing another target to update', async () => {
        const { manager, container } = makeManager();
        const edit = document.createElement('input');
        edit.className = 'rename-input';
        edit.value = 'Unsaved';
        container.appendChild(edit);
        const failed = addTarget(manager, '/work/failed').container;
        const fresh = addTarget(manager, '/work/fresh').container;
        mockFetch((url) =>
            url.includes('failed')
                ? { ok: false, status: 429, text: 'busy' }
                : [session('fresh')],
        );
        await manager.refreshSessions();
        expect(container.querySelector('input')).toBe(edit);
        expect(failed.textContent).toContain('busy');
        expect(fresh.textContent).toContain('fresh');
        expect(
            document.getElementById('session-refresh-status').textContent,
        ).toBe('1 refreshed; 1 failed; 1 editing; 0 changed.');
    });

    it.each([
        'managed',
        'plain',
        'unavailable',
        'missing-capability',
        'disconnected',
        'reconnected',
    ])('works independently of the %s bridge state', async (state) => {
        const { manager, app } = makeManager();
        app.piBridge = {
            state,
            request: vi.fn(() => {
                throw new Error('bridge must not be used');
            }),
        };
        const fetcher = mockFetch(() => []);
        await manager.refreshSessions();
        expect(fetcher).toHaveBeenCalledOnce();
        expect(app.piBridge.request).not.toHaveBeenCalled();
    });
});

describe('Refresh Sessions network and cached-page boundaries', () => {
    it('aborts the actual transport when ownership changes', async () => {
        const { manager, container } = makeManager();
        const aborted = vi.fn();
        vi.stubGlobal(
            'fetch',
            vi.fn(
                (_url, options) =>
                    new Promise((_resolve, reject) => {
                        options.signal.addEventListener(
                            'abort',
                            () => {
                                aborted();
                                reject(
                                    new DOMException('cancelled', 'AbortError'),
                                );
                            },
                            { once: true },
                        );
                    }),
            ),
        );
        const pending = manager.loadWorktreeSessions('/work/demo', container);
        manager.onSessionContextChange();
        await expect(pending).resolves.toBe('superseded');
        expect(aborted).toHaveBeenCalledOnce();
    });

    it('keeps an args draft across refresh and preserves explicit Enter/Escape behavior', async () => {
        const { manager, container } = makeManager();
        manager.launchSession = vi.fn();
        manager.renderWorktreeSessionsList(
            [session('draft-session')],
            '/work/demo',
            container,
        );
        const row = container.querySelector('.session-item');
        manager._openArgsInput(row, session('draft-session'));
        const input = container.querySelector('.args-input');
        input.value = '--model example';
        const fetcher = mockFetch(() => []);
        await manager.refreshSessions();
        expect(fetcher).not.toHaveBeenCalled();
        expect(input.value).toBe('--model example');
        expect(manager.launchSession).not.toHaveBeenCalled();
        input.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
        expect(container.querySelector('.args-input')).toBeNull();
        manager._openArgsInput(row, session('draft-session'));
        const committed = container.querySelector('.args-input');
        committed.value = '--model example';
        committed.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
        expect(manager.launchSession).toHaveBeenCalledWith(
            'draft-session',
            'draft-session',
            ['--model', 'example'],
        );
        expect(container.querySelector('.args-input')).toBeNull();
    });
    it.each([
        ['invalid JSON', () => Promise.reject(new SyntaxError('bad json'))],
        ['non-array', async () => ({ sessions: [] })],
        [
            'too many rows',
            async () =>
                Array.from({ length: 11 }, (_, i) => session(String(i))),
        ],
        [
            'invalid date',
            async () => [{ ...session('bad'), time_updated: 'not-a-date' }],
        ],
    ])('retains empty state on %s', async (_label, json) => {
        const { manager, container } = makeManager();
        manager.renderWorktreeSessionsList([], '/work/demo', container);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, status: 200, json })),
        );
        await expect(
            manager.loadWorktreeSessions('/work/demo', container, 0, {
                refresh: true,
            }),
        ).resolves.toBe('failed');
        expect(container.querySelector('.no-sessions-found').textContent).toBe(
            'No sessions found',
        );
        expect(container.querySelectorAll('.error-sessions')).toHaveLength(1);
    });

    it.each([500, 429])(
        'permits user retry after HTTP %s without an automatic retry',
        async (status) => {
            const { manager, container } = makeManager();
            const fetcher = mockFetch(() => ({
                ok: false,
                status,
                text: 'unavailable',
            }));
            await manager.refreshSessions();
            expect(fetcher).toHaveBeenCalledOnce();
            mockFetch(() => [session('recovered')]);
            await manager.refreshSessions();
            expect(container.textContent).toContain('recovered');
        },
    );

    it('times out a stalled body and rejects its late data', async () => {
        const { manager, container, store } = makeManager();
        const body = deferred();
        const fetcher = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: () => body.promise,
        }));
        vi.stubGlobal('fetch', fetcher);
        vi.useFakeTimers();
        const pending = manager.loadWorktreeSessions(
            '/work/demo',
            container,
            0,
            { refresh: true },
        );
        await vi.advanceTimersByTimeAsync(45_000);
        await expect(pending).resolves.toBe('failed');
        expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
        body.resolve([session('late')]);
        await Promise.resolve();
        expect(store.responses.size).toBe(0);
        expect(container.textContent).not.toContain('late');
        expect(container.dataset.sessionPendingOffset).toBeUndefined();
    });

    it('retains page two as stale after a successful page-one refresh and failed revalidation', async () => {
        const { manager, container, store } = makeManager();
        mockFetch(() => [session('page-two')]);
        await manager.loadWorktreeSessions('/work/demo', container, 10);
        mockFetch(() => [session('page-one')]);
        await manager.refreshSessions();
        expect(store.responses.has(cacheKey(sessionUrl(10)))).toBe(true);
        const gate = deferred();
        mockFetch(() => gate.promise);
        const pending = manager.loadWorktreeSessions(
            '/work/demo',
            container,
            10,
        );
        expect(container.textContent).toContain('page-two');
        expect(
            container.querySelector('.session-cache-note').textContent,
        ).toContain('out of date');
        gate.resolve({ ok: false, status: 500, text: 'offline' });
        await pending;
        expect(container.textContent).toContain('page-two');
        expect(container.querySelector('.session-cache-note')).not.toBeNull();
        mockFetch(() => [session('current')]);
        await manager.loadWorktreeSessions('/work/demo', container, 10);
        expect(container.querySelector('.session-cache-note')).toBeNull();
    });
});
