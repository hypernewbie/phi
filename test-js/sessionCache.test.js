// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionsManager } from '../web/sessions.js';
import { App } from '../web/app.js';
import { setupDomHarness, mockFetch } from './_dom.js';

setupDomHarness();
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

let nextProfile = 0;
const origin = 'http://backend.test:7070';
const sessionURL = (offset = 0, coder = 'pi', cwd = '/work/demo', size = 10) =>
    `/api/sessions?coder=${encodeURIComponent(coder)}&cwd=${encodeURIComponent(cwd)}&limit=${size}&offset=${offset}`;
const worktreeURL = '/api/git/worktrees?cwd=%2Fwork';
const key = (url, profile, backend = origin) =>
    `phi_session_cache_v1:${encodeURIComponent(backend)}:${encodeURIComponent(url)}:${encodeURIComponent(profile)}`;
const envelope = (data, extra = {}) =>
    JSON.stringify({ v: 1, saved_at: 1, data, ...extra });
const session = (id, extra = {}) => ({
    id,
    title: id,
    time_updated: '2026-10-01T12:00:00Z',
    ...extra,
});
function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function fixture({
    profile = `cache-${++nextProfile}`,
    backend = origin,
} = {}) {
    const scope = {
        profileId: profile,
        origin: backend,
        headers: () => ({ 'X-Phi-Backend': profile }),
        signal: new AbortController().signal,
    };
    const store = { responses: new Map() };
    const list = document.createElement('div');
    const section = document.createElement('div');
    section.className = 'worktree-section active expanded';
    section.dataset.worktreePath = '/work/demo';
    const container = document.createElement('div');
    container.className = 'worktree-sessions-container';
    section.append(container);
    list.append(section);
    document.body.append(list);
    const status = document.createElement('div');
    status.id = 'session-refresh-status';
    document.body.append(status);
    const manager = Object.assign(Object.create(SessionsManager.prototype), {
        activeCoder: 'pi',
        activeCWD: '/work/demo',
        activeWorkspace: '/work',
        sessionListPageSize: 10,
        sessionList: list,
        worktreeRootGeneration: 1,
        worktreeLoadRequestId: 0,
        worktreeDirtyRequestId: 0,
        worktreeRootOwner: { scope, coder: 'pi', workspace: '/work' },
        sessionRequests: new Map(),
        worktreeReads: new Map(),
        sessionRefreshGeneration: 0,
        sessionRefreshPromise: null,
        app: {
            scope,
            getActiveStore: () => store,
            tabManager: { tabs: new Map(), getActiveTab: () => null },
            diffController: { refreshDiff: vi.fn() },
        },
        loadWorktreeDirtyStates: vi.fn(),
        highlightActiveSession: vi.fn(),
        updateWorkspaceSelectWidth: vi.fn(),
    });
    return { manager, container, list, store, scope, profile, backend, status };
}

describe('session cache persistence', () => {
    it('paints valid memory without accessing storage before a held refresh completes', async () => {
        const { manager, container, store, profile } = fixture();
        store.responses.set(
            key(sessionURL(), profile),
            envelope([session('memory')]),
        );
        const gate = deferred();
        mockFetch(() => gate.promise);
        const read = vi.spyOn(Storage.prototype, 'getItem');
        const pending = manager.loadWorktreeSessions('/work/demo', container);
        expect(container.textContent).toContain('memory');
        expect(container.querySelector('.session-cache-note')).not.toBeNull();
        expect(read).not.toHaveBeenCalled();
        gate.resolve([]);
        await pending;
    });

    it('restores a fresh manager from disk with titles and resume paths intact', async () => {
        const first = fixture();
        const row = session('stored', {
            title: '<img src=x onerror=alert(1)>',
            session_path: '/work/a b/quoted\".jsonl',
        });
        mockFetch(() => [row]);
        await first.manager.loadWorktreeSessions('/work/demo', first.container);
        const storageKey = key(sessionURL(), first.profile);
        expect(localStorage.getItem(storageKey)).toBeNull();
        await vi.advanceTimersByTimeAsync(0);
        expect(JSON.parse(localStorage.getItem(storageKey)).data).toEqual([
            row,
        ]);
        const fresh = fixture({ profile: first.profile });
        const gate = deferred();
        mockFetch(() => gate.promise);
        const pending = fresh.manager.loadWorktreeSessions(
            '/work/demo',
            fresh.container,
        );
        expect(fresh.container.textContent).toContain(row.title);
        expect(fresh.container.querySelector('img')).toBeNull();
        expect(
            JSON.parse(fresh.store.responses.get(storageKey)).data[0]
                .session_path,
        ).toBe(row.session_path);
        gate.resolve([row]);
        await pending;
    });

    it('falls back from corrupt memory to valid disk without clearing the last good value', async () => {
        const { manager, container, store, profile } = fixture();
        const storageKey = key(sessionURL(), profile);
        localStorage.setItem(storageKey, envelope([session('disk')]));
        store.responses.set(storageKey, 'corrupt');
        const gate = deferred();
        mockFetch(() => gate.promise);
        const pending = manager.loadWorktreeSessions('/work/demo', container);
        expect(container.textContent).toContain('disk');
        gate.resolve({ ok: false, status: 500, text: 'offline' });
        await pending;
        expect(localStorage.getItem(storageKey)).toContain('disk');
    });

    it.each([
        ['bad JSON', '{broken'],
        ['unknown version', envelope([], { v: 2 })],
        ['negative timestamp', envelope([], { saved_at: -1 })],
        ['wrong timestamp', envelope([], { saved_at: 'yesterday' })],
        ['bad rows', envelope([null])],
        [
            'too many rows',
            envelope(Array.from({ length: 11 }, (_, i) => session(String(i)))),
        ],
    ])(
        'ignores %s and keeps a usable placeholder until the request finishes',
        async (_name, raw) => {
            const { manager, container, profile } = fixture();
            localStorage.setItem(key(sessionURL(), profile), raw);
            const gate = deferred();
            mockFetch(() => gate.promise);
            const pending = manager.loadWorktreeSessions(
                '/work/demo',
                container,
            );
            expect(container.querySelector('.session-item')).toBeNull();
            expect(container.textContent).toContain(
                'No saved session list yet.',
            );
            gate.resolve([session('recovered')]);
            await pending;
            expect(container.textContent).toContain('recovered');
        },
    );

    it('keeps large entries in memory without deleting other disk pages', async () => {
        const { manager, container, store, profile, status } = fixture();
        const earlierPage = key(sessionURL(10), profile);
        localStorage.setItem(earlierPage, envelope([session('offline-page')]));
        const writes = vi.spyOn(Storage.prototype, 'setItem');
        mockFetch(() => [session('large', { title: 'x'.repeat(262_144) })]);
        await manager.loadWorktreeSessions('/work/demo', container);
        await vi.advanceTimersByTimeAsync(0);
        expect(
            store.responses.get(key(sessionURL(), profile)).length,
        ).toBeGreaterThan(262_144);
        expect(writes).not.toHaveBeenCalled();
        expect(localStorage.getItem(earlierPage)).toContain('offline-page');
        expect(status.textContent).toContain('this tab only');
    });

    it('preserves prior disk data and current memory/DOM when quota or storage denial rejects a write', async () => {
        const { manager, container, store, profile, status } = fixture();
        const storageKey = key(sessionURL(), profile);
        const previous = envelope([session('previous')]);
        localStorage.setItem(storageKey, previous);
        const write = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(() => {
                throw new DOMException('quota', 'QuotaExceededError');
            });
        mockFetch(() => [session('current')]);
        await manager.loadWorktreeSessions('/work/demo', container, 0, {
            refresh: true,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(write).toHaveBeenCalledOnce();
        expect(localStorage.getItem(storageKey)).toBe(previous);
        expect(store.responses.get(storageKey)).toContain('current');
        expect(container.textContent).toContain('current');
        expect(status.textContent).toContain('this tab only');
    });

    it('lets a newer accepted value defeat an older deferred disk write', async () => {
        const { manager, container, profile } = fixture();
        let version = 0;
        mockFetch(() => [session(`version-${++version}`)]);
        const writes = vi.spyOn(Storage.prototype, 'setItem');
        await manager.loadWorktreeSessions('/work/demo', container);
        await manager.loadWorktreeSessions('/work/demo', container, 0, {
            refresh: true,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(writes).toHaveBeenCalledOnce();
        expect(localStorage.getItem(key(sessionURL(), profile))).toContain(
            'version-2',
        );
    });

    it('persists an accepted worktree answer after its own root rebuild', async () => {
        const { manager, store, profile } = fixture();
        manager.loadWorktreeSessions = vi.fn();
        mockFetch(() => [{ path: '/work/demo', branch: 'main', active: true }]);
        await manager.loadWorktrees();
        expect(manager.worktreeRootGeneration).toBeGreaterThan(1);
        const storageKey = key(worktreeURL, profile);
        expect(store.responses.has(storageKey)).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(localStorage.getItem(storageKey)).toBe(
            store.responses.get(storageKey),
        );
    });
});

describe('cache namespace and purge boundaries', () => {
    it('still cancels a forgotten-profile request when its invalid origin disables caching', async () => {
        const { manager, container, profile } = fixture({
            backend: 'not-an-origin',
        });
        const gate = deferred();
        mockFetch(() => gate.promise);
        const pending = manager.loadWorktreeSessions('/work/demo', container);
        manager.invalidateFeatureCache(profile);
        await expect(pending).resolves.toBe('superseded');
        gate.resolve([session('late')]);
        await Promise.resolve();
        expect(container.textContent).not.toContain('late');
    });

    it('retains the removal-warning status when a whole refresh batch receives 401', async () => {
        const { manager, profile, status } = fixture();
        localStorage.setItem(
            key(sessionURL(), profile),
            envelope([session('saved')]),
        );
        const removal = vi
            .spyOn(Storage.prototype, 'removeItem')
            .mockImplementation(() => {
                throw new DOMException('denied', 'SecurityError');
            });
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: false, status: 401 })),
        );
        await manager.refreshSessions();
        expect(status.textContent).toContain('removal was not confirmed');
        removal.mockRestore();
    });

    it('rejects a response after the configured page size changes', async () => {
        const { manager, container, store } = fixture();
        const gate = deferred();
        mockFetch(() => gate.promise);
        const pending = manager.loadWorktreeSessions('/work/demo', container);
        manager.sessionListPageSize = 5;
        gate.resolve([session('old-page-size')]);
        await expect(pending).resolves.toBe('superseded');
        expect(container.textContent).not.toContain('old-page-size');
        expect(store.responses.size).toBe(0);
    });
    it.each([
        ['origin', { backend: 'http://different.test:7070' }, sessionURL()],
        ['profile', { profile: 'another-profile' }, sessionURL()],
        ['coder', {}, sessionURL(0, 'claude')],
        ['cwd', {}, sessionURL(0, 'pi', '/another')],
        ['page size', {}, sessionURL(0, 'pi', '/work/demo', 5)],
        ['offset', {}, sessionURL(10)],
    ])(
        'does not restore another %s answer',
        async (_name, overrides, storedURL) => {
            const owner = fixture();
            localStorage.setItem(
                key(storedURL, owner.profile),
                envelope([session('wrong-owner')]),
            );
            const fresh = fixture({ profile: owner.profile, ...overrides });
            const gate = deferred();
            mockFetch(() => gate.promise);
            const pending = fresh.manager.loadWorktreeSessions(
                '/work/demo',
                fresh.container,
            );
            expect(fresh.container.textContent).not.toContain('wrong-owner');
            gate.resolve([]);
            await pending;
        },
    );

    it.each(['null', 'not-an-origin'])(
        'disables caching for %s without blocking its request',
        async (backend) => {
            const { manager, container, store } = fixture({ backend });
            const fetcher = mockFetch(() => [session('live')]);
            await manager.loadWorktreeSessions('/work/demo', container);
            await vi.advanceTimersByTimeAsync(0);
            expect(fetcher).toHaveBeenCalledOnce();
            expect(store.responses.size).toBe(0);
            expect(container.textContent).toContain('live');
        },
    );

    it('forgets only the exact encoded profile across every stored origin and cancels deferred writes', async () => {
        const { manager, container, profile } = fixture({
            profile: `with:colon%${++nextProfile}`,
        });
        const otherOrigin = 'http://repointed.test:7070';
        const ownKey = key(sessionURL(), profile);
        const repointedKey = key(worktreeURL, profile, otherOrigin);
        const otherKey = key(sessionURL(), `${profile}:other`);
        localStorage.setItem(repointedKey, envelope([]));
        localStorage.setItem(otherKey, envelope([session('other')]));
        localStorage.setItem(`unrelated:${profile}`, 'legacy');
        mockFetch(() => [session('accepted-before-forget')]);
        await manager.loadWorktreeSessions('/work/demo', container);
        const shell = Object.assign(Object.create(App.prototype), {
            sessionsManager: manager,
        });
        shell.forgetBackend(profile);
        await vi.advanceTimersByTimeAsync(0);
        expect(localStorage.getItem(ownKey)).toBeNull();
        expect(localStorage.getItem(repointedKey)).toBeNull();
        expect(localStorage.getItem(otherKey)).toContain('other');
        expect(localStorage.getItem(`unrelated:${profile}`)).toBeNull();
    });

    it.each(['sessions', 'worktrees'])(
        'recovers only its own origin after failed profile cleanup through %s',
        async (source) => {
            const { manager, container, profile, store, scope } = fixture();
            const otherOrigin = 'http://undiscovered-origin.test';
            const otherScope = { ...scope, origin: otherOrigin };
            const otherKey = key(worktreeURL, profile, otherOrigin);
            const forgotten = [{ path: '/forgotten-origin' }];
            localStorage.setItem(otherKey, envelope(forgotten));
            manager.readCachedWorktrees(store, worktreeURL);
            const denyEnumeration = () =>
                vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
                    throw new DOMException('denied', 'SecurityError');
                });
            let denial = denyEnumeration();
            manager.invalidateFeatureCache(profile);
            denial.mockRestore();

            const freshWorktrees = [{ path: '/work/demo' }];
            const freshSessions = [session('authorized-origin')];
            const fetcher = mockFetch((url) =>
                url.startsWith('/api/sessions')
                    ? freshSessions
                    : freshWorktrees,
            );
            const acceptedKey = key(
                source === 'sessions' ? sessionURL() : worktreeURL,
                profile,
            );
            if (source === 'sessions') {
                await manager.loadWorktreeSessions('/work/demo', container);
            } else {
                manager.loadWorktreeSessions = vi.fn();
                await manager.loadWorktrees();
            }
            expect(JSON.parse(store.responses.get(acceptedKey)).data).toEqual(
                source === 'sessions' ? freshSessions : freshWorktrees,
            );
            await vi.advanceTimersByTimeAsync(0);
            expect(localStorage.getItem(acceptedKey)).not.toBeNull();
            expect(localStorage.getItem(otherKey)).toBe(envelope(forgotten));
            manager.app.scope = otherScope;
            expect(manager.readCachedWorktrees(store, worktreeURL)).toBeNull();
            expect(fetcher).toHaveBeenCalledTimes(1);

            denial = denyEnumeration();
            manager.invalidateFeatureCache(profile);
            denial.mockRestore();
            expect(store.responses.has(acceptedKey)).toBe(false);
            manager.app.scope = scope;
            expect(manager.readCachedWorktrees(store, worktreeURL)).toBeNull();

            manager.app.scope = otherScope;
            manager.loadWorktreeSessions = vi.fn();
            await manager.loadWorktrees();
            expect(manager.readCachedWorktrees(store, worktreeURL)).toEqual(
                freshWorktrees,
            );
            manager.app.scope = scope;
            expect(manager.readCachedWorktrees(store, worktreeURL)).toBeNull();
            expect(fetcher).toHaveBeenCalledTimes(2);
        },
    );

    it('purges immediately on 403 without consuming the body, while other origins survive', async () => {
        const { manager, container, profile } = fixture();
        const ownKey = key(sessionURL(), profile);
        const otherKey = key(sessionURL(), profile, 'http://other-origin.test');
        localStorage.setItem(ownKey, envelope([session('old')]));
        localStorage.setItem(otherKey, envelope([session('other-origin')]));
        const text = vi.fn(() => new Promise(() => {}));
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: false, status: 403, text })),
        );
        await expect(
            manager.loadWorktreeSessions('/work/demo', container, 0, {
                refresh: true,
            }),
        ).resolves.toBe('failed');
        expect(text).not.toHaveBeenCalled();
        expect(localStorage.getItem(ownKey)).toBeNull();
        expect(localStorage.getItem(otherKey)).toContain('other-origin');
        mockFetch(() => [session('authorized')]);
        await manager.loadWorktreeSessions('/work/demo', container, 0, {
            refresh: true,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(localStorage.getItem(ownKey)).toContain('authorized');
    });

    it('blocks cache reads if removal is denied instead of painting undeleted data', () => {
        const { manager, profile, store, status } = fixture();
        const storageKey = key(worktreeURL, profile);
        localStorage.setItem(storageKey, envelope([{ path: '/work/old' }]));
        const removal = vi
            .spyOn(Storage.prototype, 'removeItem')
            .mockImplementation(() => {
                throw new DOMException('denied', 'SecurityError');
            });
        manager.invalidateFeatureCache(profile);
        expect(status.textContent).toContain('not confirmed');
        expect(manager.readCachedWorktrees(store, worktreeURL)).toBeNull();
        removal.mockRestore();
    });
});

describe('last-good sidebar restoration and preference denial', () => {
    it('does not turn a cached pager click into an outside click that closes the drawer', async () => {
        const { manager, container, list, store, profile } = fixture();
        const sidebar = document.createElement('aside');
        sidebar.id = 'sidebar-panel';
        sidebar.className = 'drawer-open';
        list.replaceWith(sidebar);
        sidebar.appendChild(list);
        const outsideClick = (event) => {
            if (!sidebar.contains(event.target))
                sidebar.classList.remove('drawer-open');
        };
        document.addEventListener('click', outsideClick);
        manager.renderWorktreeSessionsList(
            Array.from({ length: 10 }, (_, i) => session(`first-${i}`)),
            '/work/demo',
            container,
        );
        store.responses.set(
            key(sessionURL(10), profile),
            envelope([session('cached-second-page')]),
        );
        const gate = deferred();
        mockFetch(() => gate.promise);
        try {
            container.querySelector('.session-page[data-page="1"]').click();
            expect(container.textContent).toContain('cached-second-page');
            expect(sidebar.classList.contains('drawer-open')).toBe(true);
        } finally {
            document.removeEventListener('click', outsideClick);
            gate.resolve([]);
            await vi.advanceTimersByTimeAsync(0);
        }
    });
    it('bounds worktree body consumption while retaining the current hierarchy', async () => {
        const { manager, container, list } = fixture();
        manager.renderWorktreeSessionsList(
            [session('kept')],
            '/work/demo',
            container,
        );
        const body = deferred();
        const fetcher = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: () => body.promise,
        }));
        vi.stubGlobal('fetch', fetcher);
        const pending = manager.loadWorktrees();
        await vi.advanceTimersByTimeAsync(45_000);
        await pending;
        expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
        expect(list.textContent).toContain('kept');
        expect(list.textContent).toContain('timed out');
        body.resolve([{ path: '/work/late' }]);
        await Promise.resolve();
        expect(list.textContent).not.toContain('/work/late');
    });

    it('rejects dirty-state replies from an old backend even when cwd matches', async () => {
        const { manager, list } = fixture();
        manager.loadWorktreeDirtyStates =
            SessionsManager.prototype.loadWorktreeDirtyStates;
        manager.worktreeDirtyRequestId = 1;
        const indicator = document.createElement('span');
        indicator.className = 'worktree-dirty-indicator hidden';
        list.firstElementChild.append(indicator);
        const gate = deferred();
        mockFetch(() => gate.promise);
        const pending = manager.loadWorktreeDirtyStates('/work', 1);
        manager.app.scope = { ...manager.app.scope, profileId: 'new-owner' };
        gate.resolve({ '/work/demo': true });
        await pending;
        expect(indicator.classList.contains('hidden')).toBe(true);
    });
    it('restores matching hierarchy and pages synchronously without a fetch in backend paint', () => {
        const { manager, profile, store, list } = fixture();
        localStorage.setItem(
            key(worktreeURL, profile),
            envelope([{ path: '/work/demo', active: true, expanded: true }]),
        );
        localStorage.setItem(
            key(sessionURL(), profile),
            envelope([session('saved-row')]),
        );
        store.tabs = null;
        const fetcher = mockFetch(() => {
            throw new Error('cache paint must not fetch');
        });
        const shell = Object.assign(Object.create(App.prototype), {
            sessionsManager: manager,
            tabManager: null,
            syncManager: null,
        });
        shell.paintBackendFromStore(store);
        expect(list.textContent).toContain('saved-row');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('retains hierarchy, expansion, page two, and pager focus across same-owner reconciliation', async () => {
        const { manager, profile, store, list } = fixture();
        store.responses.set(
            key(sessionURL(10), profile),
            envelope([session('page-two')]),
        );
        manager.renderWorktreesList(
            [{ path: '/work/demo', active: true, expanded: true }],
            '/work',
            null,
            { loadSessions: false },
        );
        const oldContainer = list.querySelector('.worktree-sessions-container');
        manager.renderWorktreeSessionsList(
            [session('page-two')],
            '/work/demo',
            oldContainer,
            10,
        );
        oldContainer.querySelector('.session-page[data-page="-1"]').focus();
        mockFetch((url) =>
            String(url).startsWith('/api/git/worktrees')
                ? [
                      { path: '/work/demo', active: true, branch: 'changed' },
                      { path: '/work/new', expanded: false },
                  ]
                : [session('fresh-page-two')],
        );
        await manager.loadWorktrees();
        await vi.advanceTimersByTimeAsync(0);
        const restored = list.querySelector(
            '[data-worktree-path="/work/demo"] .worktree-sessions-container',
        );
        expect(restored.dataset.sessionOffset).toBe('10');
        expect(
            list
                .querySelector('[data-worktree-path="/work/demo"]')
                .classList.contains('expanded'),
        ).toBe(true);
        expect(document.activeElement).toBe(
            restored.querySelector('.session-page[data-page="-1"]'),
        );
        expect(list.textContent).toContain('fresh-page-two');
    });

    it('keeps a collapsed active section collapsed on worktree refresh', async () => {
        const { manager, list } = fixture();
        list.firstElementChild.classList.remove('expanded');
        mockFetch(() => [
            {
                path: '/work/demo',
                active: true,
                expanded: true,
                branch: 'new-branch',
            },
        ]);
        await manager.loadWorktrees();
        expect(
            list
                .querySelector('.worktree-section.active')
                .classList.contains('expanded'),
        ).toBe(false);
    });

    it('preserves an existing hierarchy when revalidation fails', async () => {
        const { manager, container, list } = fixture();
        manager.renderWorktreeSessionsList(
            [session('visible')],
            '/work/demo',
            container,
        );
        mockFetch(() => ({ ok: false, status: 500, text: 'offline' }));
        await manager.loadWorktrees();
        expect(list.textContent).toContain('visible');
        expect(list.textContent).toContain('Error scanning worktrees');
    });

    it('uses a valid in-memory workspace when preference reads are denied', () => {
        const { manager } = fixture();
        manager.workspaceSelect = document.createElement('select');
        const read = vi
            .spyOn(Storage.prototype, 'getItem')
            .mockImplementation(() => {
                throw new DOMException('denied', 'SecurityError');
            });
        manager.applyConfigData({
            workspaces: ['/work', '/other'],
            active_cwd: '/other',
        });
        expect(manager.activeWorkspace).toBe('/work');
        expect(manager.workspaceSelect.value).toBe('/work');
        read.mockRestore();
    });

    it('renders literal worktree names/branches despite denied preference writes', () => {
        const { manager, list } = fixture();
        const write = vi
            .spyOn(Storage.prototype, 'setItem')
            .mockImplementation(() => {
                throw new DOMException('denied', 'SecurityError');
            });
        const path = '/work/<img src=x onerror=alert(1)>';
        manager.renderWorktreesList(
            [{ path, branch: '<b>branch</b>' }],
            '/work',
            null,
            { loadSessions: false },
        );
        expect(list.querySelector('.worktree-section')).not.toBeNull();
        expect(list.textContent).toContain('<img src=x onerror=alert(1)>');
        expect(list.textContent).toContain('<b>branch</b>');
        expect(list.querySelector('img, b')).toBeNull();
        write.mockRestore();
    });
});
