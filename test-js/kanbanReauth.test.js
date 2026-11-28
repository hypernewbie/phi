// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { KanbanManager } from '../web/kanban.js';

// The Kanban session belongs to the server.
//
// It used to belong to the browser: the client held the Vikunja token and
// logged in again whenever the instance expired it. A board refresh fires
// several requests at once, all of them 401 together, and each one started
// its own login: four logins for one board open, and the instance's rate
// limit (10 logins a minute) was reached in three clicks.
//
// Now the client asks the server for a session, the server logs in once per
// token lifetime, and the client never holds a credential.

setupDomHarness();

function manager(
    vault = { hasPassword: true, username: 'me', url: 'http://vik.local' },
) {
    const c = Object.create(KanbanManager.prototype);
    c.app = { showToast: vi.fn() };
    c.taskCache = {};
    c.buckets = [];
    c.currentProjectId = 9;
    c.currentViewId = 5;
    c._initPromise = null;
    c.getSavedVaultCredentials = vi.fn(async () => vault);
    c.loadAndRenderBoard = vi.fn(async () => {});
    c.renderLoading = vi.fn();
    c.renderLoginForm = vi.fn();
    return c;
}

// Counts the session requests the client makes.
function countSessions(handler) {
    const calls = [];
    mockFetch((url, opts) => {
        const target = String(url);
        calls.push({ url: target, method: opts?.method, body: opts?.body });
        if (target.includes('/api/kanban/session')) {
            return handler
                ? handler(target, opts)
                : { ok: true, json: { ok: true } };
        }
        return { ok: true, json: {} };
    });
    return calls;
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
});

describe('the Kanban session lives on the server', () => {
    it('asks the server for a session and never logs in itself', async () => {
        const c = manager();
        const calls = countSessions();
        await c.openServerSession();
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('/api/kanban/session');
        expect(calls[0].method).toBe('POST');
        // No credential anywhere in the request.
        expect(calls[0].body).toBeUndefined();
    });

    it('opens one session for a burst of concurrent requests', async () => {
        const c = manager();
        const calls = countSessions();
        await Promise.all([
            c.openServerSession(),
            c.openServerSession(),
            c.openServerSession(),
        ]);
        expect(calls).toHaveLength(1);
    });

    it('never sends a Vikunja token with a board request', async () => {
        const c = manager();
        countSessions();
        await c.apiGet('/projects');
        const boardCall = fetch.mock.calls.find((call) =>
            String(call[0]).includes('/api/kanban/v1/projects'),
        );
        expect(boardCall).toBeTruthy();
        expect(
            boardCall[1].headers?.['X-Phi-Upstream-Authorization'],
        ).toBeUndefined();
    });

    it('surfaces a rate limit as a sentence with the wait', async () => {
        const c = manager();
        countSessions(() => ({
            ok: false,
            status: 429,
            text: '{"message":"Too Many Requests"}',
            headers: { 'Retry-After': '30' },
        }));
        const err = await c.openServerSession().catch((e) => e);
        expect(err.message).toMatch(/rate-limiting/i);
        expect(err.message).toMatch(/30s/);
        expect(err.message).not.toMatch(/Too Many Requests/);
    });

    it('surfaces a refused sign-in without the raw envelope', async () => {
        const c = manager();
        countSessions(() => ({
            ok: false,
            status: 403,
            text: '{"message":"Wrong username or password."}',
        }));
        const err = await c.openServerSession().catch((e) => e);
        expect(err.message).toBe('Wrong username or password.');
    });
});

describe('a board init asks for one session, not one per click', () => {
    it('connects once and renders the board', async () => {
        const c = manager();
        const calls = countSessions();
        const container = document.createElement('div');
        await c.initTabContainer(container);
        expect(
            calls.filter((call) => call.url.includes('/session')),
        ).toHaveLength(1);
        expect(c.loadAndRenderBoard).toHaveBeenCalledTimes(1);
    });

    it('does not ask twice when an init and a click land together', async () => {
        const c = manager();
        const calls = countSessions();
        const container = document.createElement('div');
        await Promise.all([
            c.initTabContainer(container),
            c.initTabContainer(container),
        ]);
        expect(
            calls.filter((call) => call.url.includes('/session')),
        ).toHaveLength(1);
    });

    it('shows the sign-in form when the session is refused', async () => {
        const c = manager();
        countSessions(() => ({
            ok: false,
            status: 403,
            text: '{"message":"Wrong username or password."}',
        }));
        const container = document.createElement('div');
        await c.initTabContainer(container);
        expect(c.renderLoginForm).toHaveBeenCalledTimes(1);
        expect(c.loadAndRenderBoard).not.toHaveBeenCalled();
    });

    it('shows the sign-in form when no credentials are saved', async () => {
        const c = manager({ hasPassword: false, username: null, url: null });
        const calls = countSessions();
        const container = document.createElement('div');
        await c.initTabContainer(container);
        expect(
            calls.filter((call) => call.url.includes('/session')),
        ).toHaveLength(0);
        expect(c.renderLoginForm).toHaveBeenCalledTimes(1);
    });
});

describe('a backend switch keeps the board', () => {
    it('does not delete the open flag when the backend changes', () => {
        const c = manager();
        c.activeDetailPanel = null;
        c.activeOverlay = null;
        c.escListener = null;
        c._notesSaveTimer = null;
        c.selectedNoteId = null;
        c._notesEditorState = null;
        c.boardContainer = null;
        c.destroyStatsCharts = vi.fn();
        c.unbindBoardDelegates = vi.fn();
        localStorage.setItem('phi_kanban_open', '1');
        c.resetForBackend();
        expect(localStorage.getItem('phi_kanban_open')).toBe('1');
    });

    it('deletes the open flag when the tab is closed for good', () => {
        const c = manager();
        c.activeDetailPanel = null;
        c.activeOverlay = null;
        c.escListener = null;
        c._notesSaveTimer = null;
        c.selectedNoteId = null;
        c._notesEditorState = null;
        c.boardContainer = null;
        c.destroyStatsCharts = vi.fn();
        c.unbindBoardDelegates = vi.fn();
        localStorage.setItem('phi_kanban_open', '1');
        c.cleanup();
        expect(localStorage.getItem('phi_kanban_open')).toBeNull();
    });

    it('keeps the open flag when the tab is only detached', () => {
        const c = manager();
        c.activeDetailPanel = null;
        c.activeOverlay = null;
        c.escListener = null;
        c._notesSaveTimer = null;
        c.selectedNoteId = null;
        c._notesEditorState = null;
        c.boardContainer = null;
        c.destroyStatsCharts = vi.fn();
        c.unbindBoardDelegates = vi.fn();
        localStorage.setItem('phi_kanban_open', '1');
        // A backend switch detaches the tab with the rest; the user did
        // not close the board.
        c.cleanup({ preserveOpenFlag: true });
        expect(localStorage.getItem('phi_kanban_open')).toBe('1');
    });
});
