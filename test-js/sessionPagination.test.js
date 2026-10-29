// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { SessionsManager } from '../web/sessions.js';

setupDomHarness();

const PAGE_URL = (offset, size = 10) =>
    `/api/sessions?coder=pi&cwd=%2Fwork%2Fdemo&limit=${size}&offset=${offset}`;
const CACHE_KEY = (url) =>
    `phi_session_cache_v1:${encodeURIComponent(window.location.origin)}:${encodeURIComponent(url)}:`;
const CACHE_VALUE = (data) =>
    JSON.stringify({ v: 1, saved_at: 1, data });

function sessionsPage(from, count) {
    return Array.from({ length: count }, (_, i) => {
        const n = from + i;
        return {
            id: `session-${n}`,
            title: `Session ${n}`,
            cwd: '/work/demo',
            coder: 'pi',
            time_updated: '2026-10-01T12:00:00Z',
        };
    });
}

function makeCtx(over = {}) {
    const container = document.createElement('div');
    const sessionList = document.createElement('div');
    document.body.appendChild(sessionList);
    sessionList.appendChild(container);
    const store = { responses: new Map() };
    const scope = {
        profileId: '',
        origin: window.location.origin,
        headers: () => ({}),
    };
    const ctx = Object.assign(Object.create(SessionsManager.prototype), {
        activeCoder: 'pi',
        activeCWD: '/work/demo',
        activeWorkspace: '/work',
        sessionListPageSize: 10,
        worktreeDirtyRequestId: 0,
        worktreeLoadRequestId: 0,
        worktreeRootGeneration: 0,
        worktreeRootOwner: { scope, coder: 'pi', workspace: '/work' },
        sessionRequests: new Map(),
        sessionRefreshPromise: null,
        sessionRefreshGeneration: 0,
        launchSession: vi.fn(),
        highlightActiveSession: vi.fn(),
        loadWorktreeDirtyStates: vi.fn(),
        saveWorktreeState: vi.fn(async () => {}),
        sessionList,
        app: {
            scope,
            tabManager: { tabs: new Map(), getActiveTab: vi.fn(() => null) },
            getActiveStore: () => store,
            diffController: { refreshDiff: vi.fn() },
            showToast: vi.fn(),
        },
        ...over,
    });
    ctx.worktreeRootOwner = {
        scope: ctx.app.scope,
        coder: ctx.activeCoder,
        workspace: ctx.activeWorkspace,
    };
    return { ctx, container, store };
}

function rows(container) {
    return Array.from(container.querySelectorAll('.session-item'));
}

function pageButton(container, delta) {
    return container.querySelector(`.session-page[data-page="${delta}"]`);
}

function pageLabel(container) {
    return container.querySelector('.session-page-label')?.textContent;
}

function pageOf(count, from = 0) {
    let call = 0;
    return mockFetch(() => sessionsPage(from + call++ * count, count));
}

describe('sidebar session pagination', () => {
    it('pages forward and back 10 at a time with arrows', async () => {
        const pages = [
            sessionsPage(0, 10),
            sessionsPage(10, 10),
            sessionsPage(20, 3),
        ];
        const calls = [];
        const fetchMock = mockFetch((url) => {
            calls.push(url);
            return pages[calls.length - 1] ?? [];
        });
        const { ctx, container } = makeCtx();

        await ctx.loadWorktreeSessions('/work/demo', container);

        expect(calls).toEqual([PAGE_URL(0)]);
        expect(rows(container)).toHaveLength(10);
        expect(pageLabel(container)).toBe('Page 1');
        expect(pageButton(container, '-1').disabled).toBe(true);
        expect(pageButton(container, '1').disabled).toBe(false);

        pageButton(container, '1').click();
        await vi.waitFor(() => expect(pageLabel(container)).toBe('Page 2'));

        expect(calls[1]).toBe(PAGE_URL(10));
        expect(rows(container)).toHaveLength(10);
        expect(rows(container)[0].textContent).toContain('Session 10');
        expect(pageButton(container, '-1').disabled).toBe(false);
        expect(pageButton(container, '1').disabled).toBe(false);

        pageButton(container, '1').click();
        await vi.waitFor(() => expect(pageLabel(container)).toBe('Page 3'));

        expect(calls[2]).toBe(PAGE_URL(20));
        expect(rows(container)).toHaveLength(3);
        expect(pageButton(container, '1').disabled).toBe(true);
        expect(pageButton(container, '-1').disabled).toBe(false);

        // Page 2 paints from cache and then revalidates in the background.
        pageButton(container, '-1').click();
        expect(pageLabel(container)).toBe('Page 2');
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
        expect(rows(container)).toHaveLength(10);
    });

    it('shows the empty message and no pager for an empty first page', async () => {
        mockFetch(() => []);
        const { ctx, container } = makeCtx();

        await ctx.loadWorktreeSessions('/work/demo', container);

        expect(rows(container)).toHaveLength(0);
        expect(container.querySelector('.session-pager')).toBeNull();
        expect(container.textContent).toContain('No sessions found');
    });

    it('keeps rows and shows escaped page errors, then retries', async () => {
        let attempts = 0;
        const calls = [];
        mockFetch((url) => {
            calls.push(url);
            if (calls.length === 1) return sessionsPage(0, 10);
            attempts++;
            if (attempts === 1) {
                return { ok: false, status: 500, text: '<b>boom</b>' };
            }
            return sessionsPage(10, 3);
        });
        const { ctx, container } = makeCtx();

        await ctx.loadWorktreeSessions('/work/demo', container);
        pageButton(container, '1').click();
        await vi.waitFor(() =>
            expect(container.querySelector('.error-sessions')).not.toBeNull(),
        );

        const error = container.querySelector('.error-sessions');
        expect(error.querySelector('b')).toBeNull();
        expect(error.textContent).toContain('<b>boom</b>');
        expect(rows(container)).toHaveLength(10);
        expect(pageLabel(container)).toBe('Page 1');
        expect(pageButton(container, '1').disabled).toBe(false);

        pageButton(container, '1').click();
        await vi.waitFor(() => expect(rows(container)).toHaveLength(3));
        expect(calls.at(-1)).toBe(PAGE_URL(10));
        expect(container.querySelector('.error-sessions')).toBeNull();
        expect(pageLabel(container)).toBe('Page 2');
    });

    it('ignores a second click while a page is loading', async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        let calls = 0;
        mockFetch(() => {
            calls++;
            if (calls === 1) return sessionsPage(0, 10);
            return gate.then(() => sessionsPage(10, 10));
        });
        const { ctx, container } = makeCtx();

        await ctx.loadWorktreeSessions('/work/demo', container);
        const button = pageButton(container, '1');
        button.click();
        button.click();
        await vi.waitFor(() => expect(calls).toBe(2));
        release();
        await vi.waitFor(() => expect(pageLabel(container)).toBe('Page 2'));
        expect(calls).toBe(2);
    });

    it('drops a slower page when the first page is reloaded', async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        let calls = 0;
        let resolvedPage = 0;
        mockFetch(() => {
            calls++;
            if (calls === 1) return sessionsPage(0, 10);
            if (calls === 2) {
                return gate.then(() => {
                    resolvedPage++;
                    return sessionsPage(10, 10);
                });
            }
            return sessionsPage(0, 3);
        });
        const { ctx, container } = makeCtx();

        await ctx.loadWorktreeSessions('/work/demo', container);
        pageButton(container, '1').click();
        await vi.waitFor(() => expect(calls).toBe(2));

        await ctx.loadWorktreeSessions('/work/demo', container);
        expect(rows(container)).toHaveLength(3);

        release();
        await vi.waitFor(() => expect(resolvedPage).toBe(1));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(rows(container)).toHaveLength(3);
        expect(container.querySelector('.session-pager')).toBeNull();
    });

    it('caches every loaded page and restores page one without a fetch', async () => {
        const pages = [sessionsPage(0, 10), sessionsPage(10, 10)];
        let calls = 0;
        mockFetch(() => pages[calls++] ?? []);
        const { ctx, container, store } = makeCtx();

        await ctx.loadWorktreeSessions('/work/demo', container);
        expect([...store.responses.keys()]).toEqual([CACHE_KEY(PAGE_URL(0))]);

        pageButton(container, '1').click();
        await vi.waitFor(() => expect(pageLabel(container)).toBe('Page 2'));
        expect([...store.responses.keys()]).toEqual([
            CACHE_KEY(PAGE_URL(0)),
            CACHE_KEY(PAGE_URL(10)),
        ]);

        const fetchMock = mockFetch(() => {
            throw new Error('restore must not fetch');
        });
        const restore = makeCtx();
        for (const [url, body] of store.responses) {
            restore.store.responses.set(url, body);
        }
        await SessionsManager.prototype.renderWorktreesList.call(
            restore.ctx,
            [{ path: '/work/demo', active: true, expanded: true }],
            '/work',
            null,
            { loadSessions: false },
        );

        const restored = restore.ctx.sessionList.querySelectorAll(
            '.worktree-sessions-container .session-item',
        );
        expect(restored).toHaveLength(10);
        expect(
            restore.ctx.sessionList.querySelector('.session-pager'),
        ).not.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('invalidates a pending refresh when a cached page opens', async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        let calls = 0;
        let staleServed = 0;
        mockFetch(() => {
            calls++;
            if (calls === 1) return sessionsPage(0, 10);
            if (calls === 2) return sessionsPage(10, 10);
            if (calls === 3) {
                return gate.then(() => {
                    staleServed++;
                    return sessionsPage(0, 2);
                });
            }
            return sessionsPage(10, 10);
        });
        const { ctx, container } = makeCtx();

        await ctx.loadWorktreeSessions('/work/demo', container);
        pageButton(container, '1').click();
        await vi.waitFor(() => expect(pageLabel(container)).toBe('Page 2'));

        // Back to cached page 1; its refresh is held open.
        pageButton(container, '-1').click();
        expect(pageLabel(container)).toBe('Page 1');
        await vi.waitFor(() => expect(calls).toBe(3));

        // Open cached page 2 before that refresh lands.
        pageButton(container, '1').click();
        expect(pageLabel(container)).toBe('Page 2');

        release();
        await vi.waitFor(() => expect(staleServed).toBe(1));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(pageLabel(container)).toBe('Page 2');
        expect(rows(container)).toHaveLength(10);
        expect(rows(container)[0].textContent).toContain('Session 10');
    });

    it('revalidates a cached page and keeps its rows when that fails', async () => {
        let calls = 0;
        mockFetch(() => {
            calls++;
            if (calls === 1) return sessionsPage(0, 10);
            if (calls === 2) return sessionsPage(10, 10);
            return { ok: false, status: 500, text: 'offline' };
        });
        const { ctx, container } = makeCtx();

        await ctx.loadWorktreeSessions('/work/demo', container);
        pageButton(container, '1').click();
        await vi.waitFor(() => expect(pageLabel(container)).toBe('Page 2'));

        pageButton(container, '-1').click();
        pageButton(container, '1').click();
        await vi.waitFor(() => expect(calls).toBe(4));
        await vi.waitFor(() =>
            expect(container.querySelector('.error-sessions')).not.toBeNull(),
        );

        expect(pageLabel(container)).toBe('Page 2');
        expect(rows(container)).toHaveLength(10);
        expect(rows(container)[0].textContent).toContain('Session 10');
    });

    it('does not steal focus when the user moved on during a load', async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        let calls = 0;
        mockFetch(() => {
            calls++;
            if (calls === 1) return sessionsPage(0, 10);
            return gate.then(() => sessionsPage(10, 10));
        });
        const { ctx, container } = makeCtx();

        await ctx.loadWorktreeSessions('/work/demo', container);
        const next = pageButton(container, '1');
        next.focus();
        next.click();

        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        textarea.focus();
        release();
        await vi.waitFor(() => expect(pageLabel(container)).toBe('Page 2'));

        expect(document.activeElement).toBe(textarea);
    });

    it('recovers from corrupt cached rows by refreshing', async () => {
        const fetchMock = mockFetch(() => sessionsPage(0, 10));
        const { ctx, container, store } = makeCtx();
        store.responses.set(
            CACHE_KEY(PAGE_URL(0)),
            CACHE_VALUE([null]),
        );

        await ctx.loadWorktreeSessions('/work/demo', container);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(rows(container)).toHaveLength(10);
        expect(store.responses.get(CACHE_KEY(PAGE_URL(0)))).toContain('session-0');
    });

    it('shows one inline note for repeated page failures', async () => {
        let calls = 0;
        mockFetch(() => {
            calls++;
            if (calls === 1) return sessionsPage(0, 10);
            return { ok: false, status: 500, text: 'offline' };
        });
        const { ctx, container } = makeCtx();

        await ctx.loadWorktreeSessions('/work/demo', container);
        pageButton(container, '1').click();
        await vi.waitFor(() =>
            expect(container.querySelector('.error-sessions')).not.toBeNull(),
        );
        pageButton(container, '1').click();
        await vi.waitFor(() => expect(calls).toBe(3));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(container.querySelectorAll('.error-sessions')).toHaveLength(1);
        expect(rows(container)).toHaveLength(10);
    });

    it('keeps rendered rows when a first-page refresh fails', async () => {
        const { ctx, container, store } = makeCtx();
        store.responses.set(
            CACHE_KEY(PAGE_URL(0)),
            CACHE_VALUE(sessionsPage(0, 10)),
        );
        mockFetch(() => ({ ok: false, status: 500, text: 'offline' }));

        await ctx.loadWorktreeSessions('/work/demo', container);

        expect(rows(container)).toHaveLength(10);
        const error = container.querySelector('.error-sessions');
        expect(error).not.toBeNull();
        expect(error.textContent).toContain('offline');
    });

    it('ignores a duplicate loader call for the page in flight', async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        let calls = 0;
        mockFetch(() => {
            calls++;
            if (calls === 1) return sessionsPage(0, 10);
            return gate.then(() => sessionsPage(10, 10));
        });
        const { ctx, container } = makeCtx();

        await ctx.loadWorktreeSessions('/work/demo', container);
        const pending = ctx.loadWorktreeSessions('/work/demo', container, 10);
        const duplicate = ctx.loadWorktreeSessions('/work/demo', container, 10);
        await vi.waitFor(() => expect(calls).toBe(2));
        release();
        await Promise.all([pending, duplicate]);

        expect(calls).toBe(2);
        expect(pageLabel(container)).toBe('Page 2');
        expect(rows(container)).toHaveLength(10);
    });

    it('keeps keyboard focus on the arrow after paging', async () => {
        pageOf(10);
        const { ctx, container } = makeCtx();

        await ctx.loadWorktreeSessions('/work/demo', container);
        const next = pageButton(container, '1');
        next.focus();
        expect(document.activeElement).toBe(next);

        next.click();
        await vi.waitFor(() => expect(pageLabel(container)).toBe('Page 2'));

        expect(document.activeElement).toBe(pageButton(container, '1'));
    });

    it('encodes coder and cwd in the request URL', async () => {
        const calls = [];
        mockFetch((url) => {
            calls.push(url);
            return [];
        });
        const { ctx, container } = makeCtx({ activeCoder: 'codex & co' });

        await ctx.loadWorktreeSessions('/work/a b&c', container);

        expect(calls[0]).toBe(
            '/api/sessions?coder=codex%20%26%20co&cwd=%2Fwork%2Fa%20b%26c&limit=10&offset=0',
        );
    });

    it('keeps titles literal and row clicks launching on later pages', async () => {
        const payload = '<img src=x onerror=alert(1)>';
        const page = sessionsPage(0, 10);
        page[0].title = payload;
        let calls = 0;
        mockFetch(() => {
            calls++;
            return calls === 1 ? page : sessionsPage(10, 2);
        });
        const { ctx, container } = makeCtx();

        await ctx.loadWorktreeSessions('/work/demo', container);
        const first = rows(container)[0];
        expect(first.querySelector('img')).toBeNull();
        expect(first.querySelector('.session-title').textContent).toBe(payload);

        first.click();
        expect(ctx.launchSession).toHaveBeenCalledWith('session-0', payload);

        pageButton(container, '1').click();
        await vi.waitFor(() => expect(rows(container)).toHaveLength(2));
        rows(container)[0].click();
        expect(ctx.launchSession).toHaveBeenCalledWith(
            'session-10',
            'Session 10',
        );
    });
});

describe('sidebar session page size config', () => {
    it('uses the configured size and falls back to 10 without it', async () => {
        const calls = [];
        mockFetch((url) => {
            calls.push(url);
            return calls.length === 1 ? sessionsPage(0, 7) : sessionsPage(7, 3);
        });
        const { ctx, container } = makeCtx();
        const applyConfig = SessionsManager.prototype.applyConfigData;

        // An appearance blob must not be able to shrink the page size.
        localStorage.setItem(
            'phi_appearance',
            JSON.stringify({ session_list_page_size: 3 }),
        );
        applyConfig.call(ctx, { session_list_page_size: 7 });
        expect(ctx.sessionListPageSize).toBe(7);

        await ctx.loadWorktreeSessions('/work/demo', container);
        expect(calls[0]).toBe(PAGE_URL(0, 7));
        expect(rows(container)).toHaveLength(7);

        pageButton(container, '1').click();
        await vi.waitFor(() => expect(rows(container)).toHaveLength(3));
        expect(calls[1]).toBe(PAGE_URL(7, 7));
        expect(pageButton(container, '1').disabled).toBe(true);

        applyConfig.call(ctx, {});
        expect(ctx.sessionListPageSize).toBe(10);
    });
});
