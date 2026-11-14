// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionsManager } from '../web/sessions.js';
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

function fixture() {
    const profile = `schema-${++nextProfile}`;
    const scope = {
        profileId: profile,
        origin,
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
    return { manager, container, store, profile };
}

function cacheWorktrees(store, profile, data) {
    store.responses.set(key(worktreeURL, profile), envelope(data));
}

describe('cached worktree list', () => {
    it('accepts a well-formed list and returns it unchanged', () => {
        const { manager, store, profile } = fixture();
        const data = [
            { path: '/work', extra: 'kept' },
            { path: '/work/b', branch: 'main', active: true, expanded: false },
        ];
        cacheWorktrees(store, profile, data);
        expect(manager.readCachedWorktrees(store, worktreeURL)).toEqual(data);
    });

    it('treats a cached null list as a miss, not as empty', () => {
        // normalizeWorktrees(null) is [] for the validator, but the reader
        // cannot tell that apart from "nothing cached", so it refetches.
        const { manager, store, profile } = fixture();
        cacheWorktrees(store, profile, null);
        expect(manager.readCachedWorktrees(store, worktreeURL)).toBeNull();
    });

    const rejected = {
        'a non-array list': { path: '/work' },
        'an entry without a path': [{ branch: 'main' }],
        'an empty path': [{ path: '' }],
        'a non-string path': [{ path: 7 }],
        'a non-string branch': [{ path: '/work', branch: 7 }],
        'a non-boolean active': [{ path: '/work', active: 'yes' }],
        'a non-boolean expanded': [{ path: '/work', expanded: 1 }],
        'a null entry': [null],
        'an array entry': [[]],
    };
    for (const [name, data] of Object.entries(rejected)) {
        it(`rejects ${name}`, () => {
            const { manager, store, profile } = fixture();
            cacheWorktrees(store, profile, data);
            expect(manager.readCachedWorktrees(store, worktreeURL)).toBeNull();
        });
    }

    it('rejects an envelope it cannot trust', () => {
        const { manager, store, profile } = fixture();
        const storageKey = key(worktreeURL, profile);
        const valid = [{ path: '/work' }];
        for (const raw of [
            'corrupt',
            'null',
            '[]',
            JSON.stringify({ v: 2, saved_at: 1, data: valid }),
            JSON.stringify({ v: '1', saved_at: 1, data: valid }),
            JSON.stringify({ v: 1, data: valid }),
            JSON.stringify({ v: 1, saved_at: -1, data: valid }),
            JSON.stringify({ v: 1, saved_at: 'now', data: valid }),
            JSON.stringify({ v: 1, saved_at: Number.NaN, data: valid }),
        ]) {
            store.responses.set(storageKey, raw);
            expect(
                manager.readCachedWorktrees(store, worktreeURL),
                raw,
            ).toBeNull();
        }
    });
});

describe('cached session page', () => {
    // The cached page is painted before the network answers, so its presence in
    // the container proves the cache entry was accepted.
    async function cacheIsAccepted(data) {
        const { manager, container, store, profile } = fixture();
        store.responses.set(key(sessionURL(), profile), envelope(data));
        // The cached page is painted before the network answers, so hold the
        // request open for the assertion and then release it, leaving no
        // promise pending after the test.
        let release;
        mockFetch(() => new Promise((resolve) => (release = resolve)));
        const pending = manager.loadWorktreeSessions('/work/demo', container);
        const accepted = container.textContent.includes('cached-title');
        release([]);
        await pending.catch(() => {});
        return accepted;
    }

    const good = [session('cached', { title: 'cached-title' })];

    it('accepts a well-formed page', async () => {
        expect(await cacheIsAccepted(good)).toBe(true);
    });

    it('accepts the optional string fields', async () => {
        expect(
            await cacheIsAccepted([
                session('cached', {
                    title: 'cached-title',
                    cwd: '/work/demo',
                    coder: 'pi',
                    session_path: '/work/demo/a.jsonl',
                }),
            ]),
        ).toBe(true);
    });

    const rejected = {
        'a missing id': [{ title: 'cached-title', time_updated: 'x' }],
        'an empty id': [session('', { title: 'cached-title' })],
        'a non-string title': [session('a', { title: 7 })],
        'a missing time_updated': [{ id: 'a', title: 'cached-title' }],
        'an unparseable time_updated': [
            session('a', { title: 'cached-title', time_updated: 'never' }),
        ],
        'a non-string cwd': [session('a', { title: 'cached-title', cwd: 7 })],
        'a non-string coder': [
            session('a', { title: 'cached-title', coder: 7 }),
        ],
        'a non-string session_path': [
            session('a', { title: 'cached-title', session_path: 7 }),
        ],
        'a non-object entry': ['cached-title'],
        'an array entry': [[]],
    };
    for (const [name, data] of Object.entries(rejected)) {
        it(`rejects ${name}`, async () => {
            expect(await cacheIsAccepted(data)).toBe(false);
        });
    }

    it('accepts a page of exactly the requested limit', async () => {
        const full = Array.from({ length: 10 }, (_, index) =>
            session(`id-${index}`, { title: 'cached-title' }),
        );
        expect(await cacheIsAccepted(full)).toBe(true);
    });

    it('rejects a page one longer than the requested limit', async () => {
        const long = Array.from({ length: 11 }, (_, index) =>
            session(`id-${index}`, { title: 'cached-title' }),
        );
        expect(await cacheIsAccepted(long)).toBe(false);
    });
});
