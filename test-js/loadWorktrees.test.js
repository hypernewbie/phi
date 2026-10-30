// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { SessionsManager } from '../web/sessions.js';
import { worktreeGlyph } from '../web/util.js';

// B2: exercises the REAL SessionsManager.loadWorktrees against a real jsdom
// DOM, with a hand-built `this` (never `new` the controller) so we only
// declare the small surface the method actually depends on. This is the exact
// logic behind the worktree/tab-sync fixes (d862975 / bcb3ee5): active-CWD
// selection precedence and which .worktree-section gets .active/.expanded.

setupDomHarness();

// Build the minimal `this` loadWorktrees needs. Collaborators are spies;
// sessionList is a real jsdom node so we can assert on produced DOM.
function makeCtx(over = {}) {
    const sessionList = document.createElement('div');
    document.body.appendChild(sessionList);
    return Object.assign(Object.create(SessionsManager.prototype), {
        sessionList,
        activeWorkspace: '/ws',
        activeCWD: '',
        activeCoder: 'opencode',
        worktreeDirtyRequestId: 0,
        worktreeLoadRequestId: 0,
        worktreeRootGeneration: 0,
        worktreeRootOwner: null,
        sessionRequests: new Map(),
        worktreeReads: new Map(),
        sessionRefreshPromise: null,
        sessionRefreshGeneration: 0,
        sessionListPageSize: 10,
        loadWorktreeSessions: vi.fn(),
        loadWorktreeDirtyStates: vi.fn(),
        highlightActiveSession: vi.fn(),
        saveWorktreeState: vi.fn(async () => {}),
        app: {
            scope: null,
            diffController: { refreshDiff: vi.fn() },
            tabManager: {
                tabs: new Map(),
                getActiveTab: vi.fn(() => null),
            },
        },
        ...over,
    });
}

async function run(ctx, targetCwd, worktrees) {
    mockFetch(() => worktrees);
    await SessionsManager.prototype.loadWorktrees.call(ctx, targetCwd);
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function pendingFetches() {
    const requests = [];
    vi.stubGlobal(
        'fetch',
        vi.fn((url) => {
            const response = deferred();
            requests.push({ url: String(url), ...response });
            return response.promise;
        }),
    );
    return requests;
}

function startLoad(ctx, targetCwd = null) {
    return SessionsManager.prototype.loadWorktrees.call(ctx, targetCwd);
}

function worktreeResponse(worktrees) {
    return { ok: true, json: vi.fn(async () => worktrees) };
}

const sections = (ctx) =>
    Array.from(ctx.sessionList.querySelectorAll('.worktree-section'));
const paths = (ctx) =>
    sections(ctx).map((s) => s.getAttribute('data-worktree-path'));
const activePath = (ctx) => {
    const s = ctx.sessionList.querySelector('.worktree-section.active');
    return s ? s.getAttribute('data-worktree-path') : null;
};
const SESSION_URL = (cwd) =>
    `/api/sessions?coder=pi&cwd=${encodeURIComponent(cwd)}&limit=10&offset=0`;
const FEATURE_CACHE_KEY = (url) =>
    `phi_session_cache_v1:${encodeURIComponent(window.location.origin)}:${encodeURIComponent(url)}:`;
const FEATURE_CACHE_VALUE = (data) =>
    JSON.stringify({ v: 1, saved_at: 1, data });
const fixtureSession = (id) => ({
    id,
    title: id,
    cwd: '/ws/target',
    coder: 'pi',
    time_updated: '2026-10-01T12:00:00Z',
});

beforeEach(() => vi.clearAllMocks());

describe('loadWorktrees — empty / missing', () => {
    it('shows "No worktrees found" and renders no sections', async () => {
        const ctx = makeCtx();
        await run(ctx, null, []);
        expect(sections(ctx)).toHaveLength(0);
        expect(ctx.sessionList.textContent).toContain('No worktrees found');
    });

    it('handles a null response the same way', async () => {
        const ctx = makeCtx();
        await run(ctx, null, null);
        expect(sections(ctx)).toHaveLength(0);
    });
});

describe('loadWorktrees — active-CWD selection precedence', () => {
    const wts = [{ path: '/a' }, { path: '/b', active: true }, { path: '/c' }];

    it('1. targetCwd argument wins', async () => {
        const ctx = makeCtx({ activeCWD: '/c' });
        await run(ctx, '/a', wts);
        expect(ctx.activeCWD).toBe('/a');
        expect(activePath(ctx)).toBe('/a');
    });

    it('2. keeps an existing activeCWD that is still present', async () => {
        const ctx = makeCtx({ activeCWD: '/c' });
        await run(ctx, null, wts);
        expect(ctx.activeCWD).toBe('/c'); // not overridden by the active:true /b
        expect(activePath(ctx)).toBe('/c');
    });

    it('3. falls back to the active worktree when activeCWD is gone', async () => {
        const ctx = makeCtx({ activeCWD: '/gone' });
        await run(ctx, null, wts);
        expect(ctx.activeCWD).toBe('/b');
    });

    it('4. falls back to worktrees[0] when nothing matches and none active', async () => {
        const ctx = makeCtx({ activeCWD: '/gone' });
        await run(ctx, null, [{ path: '/a' }, { path: '/c' }]);
        expect(ctx.activeCWD).toBe('/a');
    });
});

describe('loadWorktrees — produced DOM', () => {
    it('marks exactly the current-CWD section active + expanded', async () => {
        const ctx = makeCtx({ activeCWD: '' });
        await run(ctx, '/b', [{ path: '/a' }, { path: '/b' }, { path: '/c' }]);
        const active = ctx.sessionList.querySelectorAll(
            '.worktree-section.active',
        );
        expect(active).toHaveLength(1);
        expect(active[0].getAttribute('data-worktree-path')).toBe('/b');
        expect(active[0].classList.contains('expanded')).toBe(true);
    });

    it('expands wt.expanded sections even when not current', async () => {
        const ctx = makeCtx();
        await run(ctx, '/a', [{ path: '/a' }, { path: '/b', expanded: true }]);
        const b = ctx.sessionList.querySelector('[data-worktree-path="/b"]');
        expect(b.classList.contains('expanded')).toBe(true);
        expect(b.classList.contains('active')).toBe(false);
    });

    it('renders one section per worktree with the right data-worktree-path', async () => {
        const ctx = makeCtx();
        await run(ctx, '/a', [{ path: '/a' }, { path: '/b' }]);
        expect(paths(ctx)).toEqual(['/a', '/b']);
    });

    it('matches current CWD across separators/case via normalizePath', async () => {
        const ctx = makeCtx();
        await run(ctx, 'C:\\Proj', [{ path: 'c:/proj' }, { path: '/other' }]);
        expect(activePath(ctx)).toBe('c:/proj');
    });
});

describe('loadWorktrees — no-workspace section', () => {
    it('is NOT appended for non-agy coders', async () => {
        const ctx = makeCtx({ activeCoder: 'opencode' });
        await run(ctx, '/a', [{ path: '/a' }]);
        expect(paths(ctx)).not.toContain('--no-workspace--');
    });

    it('IS appended for the agy coder', async () => {
        const ctx = makeCtx({ activeCoder: 'agy' });
        await run(ctx, '/a', [{ path: '/a' }]);
        expect(paths(ctx)).toContain('--no-workspace--');
    });
});

describe('loadWorktrees — collaborators + side effects', () => {
    it('persists the chosen workspace to localStorage', async () => {
        const ctx = makeCtx({ activeWorkspace: '/ws' });
        await run(ctx, '/a', [{ path: '/a' }]);
        expect(localStorage.getItem('phi_last_chosen_project')).toBe('/ws');
    });

    it('kicks off dirty-state loading with an incremented request id', async () => {
        const ctx = makeCtx({
            activeWorkspace: '/ws',
            worktreeDirtyRequestId: 0,
        });
        await run(ctx, '/a', [{ path: '/a' }]);
        expect(ctx.loadWorktreeDirtyStates).toHaveBeenCalledWith('/ws', 1);
        expect(ctx.worktreeDirtyRequestId).toBe(1);
    });

    it('loads sessions for the active (expanded) worktree', async () => {
        const ctx = makeCtx();
        await run(ctx, '/b', [{ path: '/a' }, { path: '/b' }]);
        const calledPaths = ctx.loadWorktreeSessions.mock.calls.map(
            (c) => c[0],
        );
        expect(calledPaths).toContain('/b');
        expect(calledPaths).not.toContain('/a');
    });
});

describe('loadWorktrees — section opening under slow state saves', () => {
    function setupCollapsedTarget() {
        const ctx = makeCtx({ activeCWD: '/ws/main', activeCoder: 'pi' });
        const scope = {
            profileId: '',
            origin: window.location.origin,
            headers: () => ({}),
            signal: new AbortController().signal,
        };
        const store = { responses: new Map() };
        ctx.app.scope = scope;
        ctx.app.getActiveStore = () => store;
        ctx.loadWorktreeSessions =
            SessionsManager.prototype.loadWorktreeSessions;
        ctx.saveWorktreeState = SessionsManager.prototype.saveWorktreeState;
        store.responses.set(
            FEATURE_CACHE_KEY(SESSION_URL('/ws/target')),
            FEATURE_CACHE_VALUE([fixtureSession('cached-target')]),
        );
        SessionsManager.prototype.renderWorktreesList.call(
            ctx,
            [
                { path: '/ws/main', active: true, expanded: true },
                { path: '/ws/target', expanded: false },
            ],
            '/ws',
            null,
            { loadSessions: false, startingCwd: '/ws/main' },
        );
        return { ctx, store };
    }

    it('shows cached rows before a held worktree-state POST resolves', async () => {
        let releaseSave;
        let releaseList;
        const saveGate = new Promise((resolve) => (releaseSave = resolve));
        const listGate = new Promise((resolve) => (releaseList = resolve));
        const fetchMock = vi.fn((url) =>
            String(url) === '/api/config/worktree-state' ? saveGate : listGate,
        );
        vi.stubGlobal('fetch', fetchMock);
        const { ctx } = setupCollapsedTarget();

        ctx.sessionList
            .querySelector('[data-worktree-path="/ws/target"] .worktree-header')
            .click();

        expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
            '/api/config/worktree-state',
            SESSION_URL('/ws/target'),
        ]);
        expect(
            ctx.sessionList.querySelector(
                '[data-worktree-path="/ws/target"] .session-item',
            )?.textContent,
        ).toContain('cached-target');

        releaseSave({ ok: true });
        releaseList({
            ok: true,
            status: 200,
            json: async () => [fixtureSession('fresh-target')],
        });
    });

    it('starts session loading even when the state-save POST fails', async () => {
        const fetchMock = vi.fn((url) =>
            String(url) === '/api/config/worktree-state'
                ? Promise.reject(new Error('offline'))
                : Promise.resolve({
                      ok: true,
                      status: 200,
                      json: async () => [fixtureSession('fresh-target')],
                  }),
        );
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { ctx } = setupCollapsedTarget();

        ctx.sessionList
            .querySelector('[data-worktree-path="/ws/target"] .worktree-header')
            .click();
        await vi.waitFor(() =>
            expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
                SESSION_URL('/ws/target'),
            ),
        );
        expect(
            ctx.sessionList.querySelector(
                '[data-worktree-path="/ws/target"] .session-item',
            )?.textContent,
        ).toContain('cached-target');
    });

    it('ignores a worktree reply started before session authentication failed', async () => {
        let releaseWorktrees;
        const worktreeGate = new Promise((resolve) => {
            releaseWorktrees = resolve;
        });
        const fetchMock = vi.fn((url) =>
            String(url).startsWith('/api/git/worktrees')
                ? worktreeGate
                : Promise.resolve({
                      ok: false,
                      status: 401,
                      text: async () => 'unauthorized',
                  }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const { ctx, store } = setupCollapsedTarget();
        const url = '/api/git/worktrees?cwd=%2Fws';
        const pendingWorktrees = ctx.loadWorktrees();
        const target = ctx.sessionList.querySelector(
            '[data-worktree-path="/ws/target"] .worktree-sessions-container',
        );
        await expect(
            ctx.loadWorktreeSessions('/ws/target', target, 0, {
                refresh: true,
            }),
        ).resolves.toBe('failed');

        let parsed = false;
        releaseWorktrees({
            ok: true,
            json: async () => {
                parsed = true;
                return [{ path: '/ws/replacement' }];
            },
        });
        await pendingWorktrees;
        expect(parsed).toBe(false);
        expect(paths(ctx)).toContain('/ws/target');
        expect(paths(ctx)).not.toContain('/ws/replacement');
        expect(store.responses.has(FEATURE_CACHE_KEY(url))).toBe(false);
    });
});

describe('loadWorktrees — stale requests', () => {
    it('keeps the newest successful response when request contexts are identical', async () => {
        const requests = pendingFetches();
        const ctx = makeCtx({ activeCWD: '/ws/missing' });
        const olderLoad = startLoad(ctx);
        const newerLoad = startLoad(ctx);

        expect(requests.map((request) => request.url)).toEqual([
            '/api/git/worktrees?cwd=%2Fws',
            '/api/git/worktrees?cwd=%2Fws',
        ]);

        requests[1].resolve(
            worktreeResponse([{ path: '/ws/new', active: true }]),
        );
        await newerLoad;
        requests[0].resolve(
            worktreeResponse([{ path: '/ws/old', active: true }]),
        );
        await olderLoad;

        expect(paths(ctx)).toEqual(['/ws/new']);
        expect(ctx.activeCWD).toBe('/ws/new');
        expect(
            ctx.loadWorktreeSessions.mock.calls.map(([path]) => path),
        ).toEqual(['/ws/new']);
        expect(ctx.loadWorktreeDirtyStates).toHaveBeenCalledTimes(1);
    });

    it.each(['HTTP error', 'fetch rejection'])(
        'does not let a stale %s replace the latest sidebar',
        async (failure) => {
            const requests = pendingFetches();
            const ctx = makeCtx({ activeCWD: '/ws/missing' });
            const olderLoad = startLoad(ctx);
            const newerLoad = startLoad(ctx);

            requests[1].resolve(
                worktreeResponse([{ path: '/ws/new', active: true }]),
            );
            await newerLoad;

            if (failure === 'HTTP error') {
                requests[0].resolve({ ok: false, json: vi.fn() });
            } else {
                requests[0].reject(new Error('old network failure'));
            }
            await olderLoad;

            expect(paths(ctx)).toEqual(['/ws/new']);
            expect(ctx.activeCWD).toBe('/ws/new');
            expect(ctx.sessionList.textContent).not.toContain(
                'Error scanning worktrees',
            );
        },
    );

    it('does not let a stale JSON rejection replace the latest sidebar', async () => {
        const requests = pendingFetches();
        const jsonBody = deferred();
        const ctx = makeCtx({ activeCWD: '/ws/missing' });
        const json = vi.fn(() => jsonBody.promise);
        const olderLoad = startLoad(ctx);

        requests[0].resolve({ ok: true, json });
        await Promise.resolve();
        expect(json).toHaveBeenCalledTimes(1);

        const newerLoad = startLoad(ctx);
        requests[1].resolve(
            worktreeResponse([{ path: '/ws/new', active: true }]),
        );
        await newerLoad;

        jsonBody.reject(new Error('old JSON failure'));
        await olderLoad;

        expect(paths(ctx)).toEqual(['/ws/new']);
        expect(ctx.activeCWD).toBe('/ws/new');
        expect(ctx.sessionList.textContent).not.toContain(
            'Error scanning worktrees',
        );
        expect(ctx.loadWorktreeDirtyStates).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['workspace', 'activeWorkspace', '/ws/changed'],
        ['coder', 'activeCoder', 'shell'],
    ])(
        'ignores a response when the %s changes before fetch completes',
        async (_label, key, changedValue) => {
            const requests = pendingFetches();
            const ctx = makeCtx({ activeCWD: '/ws/main' });
            const load = startLoad(ctx);
            const json = vi.fn(async () => [
                { path: '/ws/other', active: true },
            ]);

            ctx[key] = changedValue;
            requests[0].resolve({ ok: true, json });
            await load;

            expect(json).not.toHaveBeenCalled();
            expect(ctx[key]).toBe(changedValue);
            expect(ctx.sessionList.textContent).toContain(
                'Scanning git worktrees',
            );
            expect(ctx.loadWorktreeDirtyStates).not.toHaveBeenCalled();
        },
    );

    it('renders a valid list after CWD changes before fetch completes without applying the old target', async () => {
        const requests = pendingFetches();
        const ctx = makeCtx({ activeCWD: '/ws/main' });
        const load = startLoad(ctx, '/ws/target');
        const json = vi.fn(async () => [
            { path: '/ws/target', active: true },
            { path: '/ws/other' },
        ]);

        ctx.activeCWD = '/ws/other';
        requests[0].resolve({ ok: true, json });
        await load;

        expect(json).toHaveBeenCalledTimes(1);
        expect(ctx.activeCWD).toBe('/ws/other');
        expect(paths(ctx)).toEqual(['/ws/target', '/ws/other']);
        expect(activePath(ctx)).toBe('/ws/other');
        expect(ctx.sessionList.textContent).not.toContain(
            'Scanning git worktrees',
        );
        expect(ctx.loadWorktreeDirtyStates).toHaveBeenCalledTimes(1);
    });

    it('renders parsed worktrees after CWD changes during JSON reading without applying the fallback', async () => {
        const requests = pendingFetches();
        const jsonBody = deferred();
        const ctx = makeCtx({ activeCWD: '/ws/missing' });
        const json = vi.fn(() => jsonBody.promise);
        const load = startLoad(ctx);

        requests[0].resolve({ ok: true, json });
        await Promise.resolve();
        expect(json).toHaveBeenCalledTimes(1);

        ctx.activeCWD = '/ws/other';
        jsonBody.resolve([{ path: '/ws/fallback', active: true }]);
        await load;

        expect(ctx.activeCWD).toBe('/ws/other');
        expect(paths(ctx)).toEqual(['/ws/fallback']);
        expect(activePath(ctx)).toBeNull();
        expect(ctx.sessionList.textContent).not.toContain(
            'Scanning git worktrees',
        );
        expect(ctx.loadWorktreeDirtyStates).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['workspace', 'activeWorkspace', '/ws/changed'],
        ['coder', 'activeCoder', 'shell'],
    ])(
        'ignores parsed worktrees when the %s changes during JSON reading',
        async (_label, key, changedValue) => {
            const requests = pendingFetches();
            const jsonBody = deferred();
            const ctx = makeCtx({ activeCWD: '/ws/main' });
            const json = vi.fn(() => jsonBody.promise);
            const load = startLoad(ctx);

            requests[0].resolve({ ok: true, json });
            await Promise.resolve();
            expect(json).toHaveBeenCalledTimes(1);

            ctx[key] = changedValue;
            jsonBody.resolve([{ path: '/ws/other', active: true }]);
            await load;

            expect(ctx[key]).toBe(changedValue);
            expect(ctx.sessionList.textContent).toContain(
                'Scanning git worktrees',
            );
            expect(ctx.loadWorktreeDirtyStates).not.toHaveBeenCalled();
        },
    );

    it('renders a current request error normally', async () => {
        const ctx = makeCtx();
        mockFetch(() => ({ ok: false }));

        await startLoad(ctx);

        expect(ctx.sessionList.textContent).toContain(
            'Error scanning worktrees',
        );
    });
});

describe('loadWorktrees — worktree glyph matches tab glyph', () => {
    // The user pointed out they can't visually match tabs to worktree
    // sections in the left panel. The fix: render the same worktree-
    // glyph (worktreeGlyph(cwd)) in the section header next to the
    // folder name, so a section header ◆ visually pairs with a tab ◆.

    it('renders the section-glyph span with the same hash-derived glyph as the tab', async () => {
        const ctx = makeCtx();
        await run(ctx, null, [{ path: '/Users/dev/code/phi/feature-x' }]);
        const glyphEl = ctx.sessionList.querySelector(
            '.worktree-section .worktree-section-glyph',
        );
        expect(glyphEl).toBeTruthy();
        expect(glyphEl.textContent).toBe(
            worktreeGlyph('/Users/dev/code/phi/feature-x'),
        );
    });

    it('different worktree paths get different glyphs in the section header', async () => {
        const ctx = makeCtx();
        await run(ctx, null, [
            { path: '/Users/dev/code/phi/feature-x' },
            { path: '/Users/dev/code/otherrepo/main' },
        ]);
        const glyphEls = ctx.sessionList.querySelectorAll(
            '.worktree-section .worktree-section-glyph',
        );
        expect(glyphEls.length).toBe(2);
        // Sanity: at least one pair of distinct glyphs (pool size 12,
        // two worktrees should never collide without a contrived case).
        expect(glyphEls[0].textContent).not.toBe(glyphEls[1].textContent);
    });

    it('aria-hides the glyph so screen readers skip it (text label follows)', async () => {
        const ctx = makeCtx();
        await run(ctx, null, [{ path: '/some/path/here' }]);
        const glyphEl = ctx.sessionList.querySelector(
            '.worktree-section .worktree-section-glyph',
        );
        expect(glyphEl.getAttribute('aria-hidden')).toBe('true');
    });
});
