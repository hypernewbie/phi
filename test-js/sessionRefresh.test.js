// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { SessionsManager } from '../web/sessions.js';
import { App } from '../web/app.js';

setupDomHarness();
afterEach(() => vi.useRealTimers());

const sessionUrl = (offset = 0, coder = 'pi', cwd = '/work/demo', limit = 10) =>
    `/api/sessions?coder=${encodeURIComponent(coder)}&cwd=${encodeURIComponent(cwd)}&limit=${limit}&offset=${offset}`;
const cacheKey = (url, profile = '') =>
    `phi_session_cache_v1:${encodeURIComponent(window.location.origin)}:${encodeURIComponent(url)}:${encodeURIComponent(profile)}`;
const cacheValue = (data) =>
    JSON.stringify({ v: 1, saved_at: 1, data });
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
        manager.renderWorktreeSessionsList([session('old')], '/work/demo', container);

        const pending = manager.loadWorktreeSessions('/work/demo', container, 0, {
            refresh: true,
        });
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
        manager.renderWorktreeSessionsList([session('kept')], '/work/demo', container);

        await expect(
            manager.loadWorktreeSessions('/work/demo', container, 0, {
                refresh: true,
            }),
        ).resolves.toBe('failed');
        expect(container.textContent).toContain('kept');
        expect(container.querySelector('.error-sessions b')).toBeNull();
        expect(container.querySelector('.error-sessions').textContent).toContain(
            '<b>offline</b>',
        );
    });

    it('treats an empty refreshed page as success', async () => {
        mockFetch(() => []);
        const { manager, container } = makeManager();
        manager.renderWorktreeSessionsList([session('old')], '/work/demo', container);

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
        manager.renderWorktreeSessionsList([session('old', 'Old title')], '/work/demo', container);
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
        manager.renderWorktreeSessionsList([session('kept')], '/work/demo', container);

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
        manager.renderWorktreeSessionsList([session('kept')], '/work/demo', container);

        const pending = manager.loadWorktreeSessions('/work/demo', container, 0, {
            refresh: true,
        });
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
        vi.stubGlobal('fetch', vi.fn(() => gate));
        const { manager, container, store } = makeManager({ scope });
        manager.renderWorktreeSessionsList([session('kept')], '/work/demo', container);
        const pending = manager.loadWorktreeSessions('/work/demo', container, 0, {
            refresh: true,
        });
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
        manager.renderWorktreeSessionsList([session('old')], '/work/demo', container);

        await manager.refreshSessions();
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([sessionUrl(0)]);
    });

    it('does not cache or render a late reply after owner cancellation', async () => {
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        const fetchMock = vi.fn(() => gate);
        vi.stubGlobal('fetch', fetchMock);
        const { manager, container, store } = makeManager();
        manager.renderWorktreeSessionsList([session('kept')], '/work/demo', container);

        const pending = manager.loadWorktreeSessions('/work/demo', container, 0, {
            refresh: true,
        });
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
            vi.fn(async () => ({ ok: false, status: 401, text, json: async () => null })),
        );
        const { manager, container, store } = makeManager();
        const key = cacheKey(sessionUrl(0));
        store.responses.set(key, cacheValue([session('saved')]));
        manager.renderWorktreeSessionsList([session('visible')], '/work/demo', container);

        await expect(
            manager.loadWorktreeSessions('/work/demo', container, 0, {
                refresh: true,
            }),
        ).resolves.toBe('failed');
        expect(text).not.toHaveBeenCalled();
        expect(store.responses.has(key)).toBe(false);
        expect(container.textContent).toContain('visible');
        expect(document.getElementById('session-refresh-status')?.textContent).toContain(
            'Authentication is required',
        );
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
        expect(manager.sessionList.querySelector('[data-worktree-path="/work/legacy"]')).toBeNull();
    });

    it('accepts a later authorized response after namespace rejection', async () => {
        const { manager, container, store } = makeManager();
        const key = cacheKey(sessionUrl(0));
        store.responses.set(key, cacheValue([session('saved')]));
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: false, status: 403, text: async () => 'denied' })),
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
        expect(manager.readCachedWorktrees(store, '/api/git/worktrees?cwd=%2Fwork')).toBeNull();
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
        store.responses.set(worktreeUrl, JSON.stringify([{ path: '/work/demo' }]));
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
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        expect(row.querySelector('.rename-input')).toBeNull();
        expect(row.querySelector('.session-title').textContent).toBe('Original');
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
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        input.dispatchEvent(new FocusEvent('blur'));
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(row.querySelector('.rename-input')).toBeNull());

        expect(fetchMock.mock.calls[0][1].method).toBe('POST');
        expect(row.querySelector('.session-title').textContent).toBe('Renamed');
        expect(loadSessions).toHaveBeenCalledOnce();
    });
});
