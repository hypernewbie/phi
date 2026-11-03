// @vitest-environment jsdom
//
// Workspace manager: Projects (registered) vs Rest of <root> (live children),
// batch writes, and the offline/confirm rules the UI contract requires.
// These tests cover behavior that can corrupt config or lose a user's change,
// not markup details.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch, setupDomHarness } from './_dom.js';
import { SessionsManager } from '../web/sessions.js';
import { BackendStore } from '../web/backend-store.js';

setupDomHarness();

const managers = new Set();
afterEach(() => {
    for (const manager of managers) manager.workspaceManager.close();
    managers.clear();
    Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        get: () => true,
    });
});

function makeSessions(options = {}) {
    document.body.innerHTML = `
        <div id="session-list"></div>
        <button id="new-session-btn"></button>
        <select id="workspace-select"></select>
        <button id="add-workspace-btn">+</button>
        <button id="remove-workspace-btn">…</button>
        <div id="ws-modal" class="modal-overlay hidden">
            <div class="modal-content" role="dialog" aria-modal="true">
                <button id="ws-modal-close" type="button">×</button>
                <input id="ws-modal-input" type="text">
                <button id="ws-modal-browse-btn" type="button">Reveal</button>
                <div id="ws-modal-tree"></div>
                <div id="ws-modal-path-status" role="status"></div>
                <div id="ws-modal-suggestions" class="hidden"></div>
                <button id="ws-modal-cancel-btn" type="button">Cancel</button>
                <button id="ws-modal-add-btn" type="button">Add</button>
            </div>
        </div>
        <div id="ws-manager-modal" class="modal-overlay hidden">
            <div
                class="modal-content"
                role="dialog"
                aria-modal="true"
                tabindex="-1"
            >
                <button id="ws-manager-close" type="button">×</button>
                <div id="ws-manager-status" role="status" aria-live="polite"></div>
                <input
                    type="text"
                    id="ws-manager-filter"
                    aria-label="Filter projects and folders"
                >
                <div id="ws-manager-projects-section">
                    <h4 id="ws-manager-projects-title">Projects
                        <span id="ws-manager-projects-count"></span>
                    </h4>
                    <input id="ws-manager-projects-all" type="checkbox">
                    <div id="ws-manager-projects"></div>
                    <button id="ws-manager-remove" type="button">Remove</button>
                </div>
                <input id="ws-manager-root-input" type="text">
                <button id="ws-manager-root-add" type="button">Add root</button>
                <div id="ws-manager-roots"></div>
                <button id="ws-manager-done" type="button">Done</button>
            </div>
        </div>
    `;
    const store = options.store ?? null;
    const sessions = new SessionsManager({
        scope: null,
        getActiveStore: store ? () => store : undefined,
    });
    managers.add(sessions);
    sessions.applyConfigData({
        workspaces: options.workspaces ?? [],
        workspace_roots: options.roots ?? [],
        active_cwd: options.activeCwd ?? options.workspaces?.[0] ?? '',
    });
    sessions.loadConfig = options.loadConfig ?? (async () => true);
    sessions.loadSessions = async () => {};
    sessions.loadWorktrees = async () => {};
    return sessions;
}

/** fetch stub: browse/roots/workspaces only. Records every mutation request. */
function installFetch(handlers = {}) {
    const calls = [];
    const fetchMock = mockFetch(async (url, options = {}) => {
        const request = new URL(String(url), 'http://localhost');
        if (request.pathname === '/api/fs/browse') {
            const path = request.searchParams.get('path');
            if (handlers.browse) {
                const result = handlers.browse(path);
                if (result instanceof Error) throw result;
                if (result instanceof Promise) return result;
                return result;
            }
            throw new Error(`Unexpected browse: ${path}`);
        }
        if (request.pathname.startsWith('/api/config/workspace')) {
            calls.push({
                url: request.pathname,
                method: options.method,
                body: JSON.parse(options.body),
            });
            if (handlers.write) {
                const result = handlers.write(request.pathname, options);
                if (result instanceof Error) throw result;
                if (result instanceof Promise) return result;
                return result;
            }
            return { ok: true, status: 200, json: {} };
        }
        if (handlers.other) return handlers.other(request, options);
        return { ok: true, status: 200, json: {} };
    });
    return { fetchMock, calls };
}

function rows(section) {
    return [...document.querySelectorAll(`${section} .ws-manager-row`)].map(
        (row) => ({
            path: row.querySelector('.ws-manager-path').textContent,
            checked: row.querySelector('input').checked,
        }),
    );
}

function projects() {
    return rows('#ws-manager-projects');
}

function rootRows() {
    return [
        ...document.querySelectorAll('#ws-manager-roots .ws-manager-row'),
    ].map((row) => ({
        path: row.querySelector('.ws-manager-path').textContent,
        checked: row.querySelector('input').checked,
    }));
}

function toggle(path, root = false) {
    const row = [
        ...document.querySelectorAll(
            root
                ? '#ws-manager-roots .ws-manager-row'
                : '#ws-manager-projects .ws-manager-row',
        ),
    ].find(
        (candidate) =>
            candidate.querySelector('.ws-manager-path').textContent === path,
    );
    const box = row.querySelector('input');
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
}

function buttonText(id) {
    return document.getElementById(id).textContent;
}

function statusText() {
    return document.getElementById('ws-manager-status').textContent;
}

function setFilter(value) {
    const input = document.getElementById('ws-manager-filter');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function allLabel(selector) {
    return document.querySelector(`${selector} .ws-manager-all span`)
        .textContent;
}

function setOnline(online) {
    Object.defineProperty(window.navigator, 'onLine', {
        configurable: true,
        get: () => online,
    });
}

/** Opens the dialog and waits for every root listing to finish its first read. */
async function openManager(sessions, expectedRoots = 1) {
    sessions.workspaceManager.open();
    await vi.waitFor(() =>
        expect(
            document.querySelectorAll('#ws-manager-roots .ws-manager-section')
                .length,
        ).toBe(expectedRoots),
    );
    await vi.waitFor(() =>
        expect(
            document.querySelector('#ws-manager-roots').textContent,
        ).not.toContain('Reading folder'),
    );
}

const BROWSE_ROOT = '/code';

function browseEntries(...children) {
    return {
        ok: true,
        status: 200,
        json: {
            path: BROWSE_ROOT,
            parent: '/',
            truncated: false,
            entries: children.map((name) => ({
                name,
                path: `${BROWSE_ROOT}/${name}`,
            })),
        },
    };
}

describe('workspace manager', () => {
    it('splits registered projects from the rest of a root, and never registers the root', async () => {
        installFetch({
            browse: () => browseEntries('phi', 'PHI', 'phi2', 'psi'),
        });
        const sessions = makeSessions({
            workspaces: [BROWSE_ROOT, '/code/phi'],
            roots: [BROWSE_ROOT],
        });
        await openManager(sessions);

        expect(projects().map((row) => row.path)).toEqual([
            BROWSE_ROOT,
            '/code/phi',
        ]);
        // Registered children are filtered case-insensitively; a prefix-similar
        // sibling ("phi2") is not confused with the registered "/code/phi".
        expect(rootRows().map((row) => row.path)).toEqual([
            '/code/phi2',
            '/code/psi',
        ]);
        expect(sessions.workspaces).toEqual([BROWSE_ROOT, '/code/phi']);
        expect(sessions.config.workspace_roots).toEqual([BROWSE_ROOT]);
    });

    it('adds selected children in one batch and moves them into Projects', async () => {
        const { calls } = installFetch({
            browse: () => browseEntries('psi', 'theta'),
        });
        const sessions = makeSessions({ workspaces: [], roots: [BROWSE_ROOT] });
        await openManager(sessions);

        toggle('/code/psi', true);
        toggle('/code/theta', true);
        expect(buttonText('ws-manager-remove')).toBe('Remove selected (0)');
        expect(
            document.querySelector('#ws-manager-roots .ws-manager-add-btn')
                .textContent,
        ).toBe('Add selected (2)');

        document.querySelector('#ws-manager-roots .ws-manager-add-btn').click();
        await vi.waitFor(() => expect(calls.length).toBe(1));

        expect(calls[0]).toEqual({
            url: '/api/config/workspaces',
            method: 'POST',
            body: { paths: ['/code/psi', '/code/theta'] },
        });
        await vi.waitFor(() =>
            expect(projects().map((row) => row.path)).toEqual([
                '/code/psi',
                '/code/theta',
            ]),
        );
        // Added children move out of the root section without a reload.
        await vi.waitFor(() => expect(rootRows()).toEqual([]));
        expect(
            [...document.querySelectorAll('#workspace-select option')].map(
                (option) => option.value,
            ),
        ).toEqual(['/code/psi', '/code/theta']);
    });

    it('selects every child through All, then adds them in one batch', async () => {
        const { calls } = installFetch({
            browse: () => browseEntries('psi', 'theta', 'zeta'),
        });
        const sessions = makeSessions({ workspaces: [], roots: [BROWSE_ROOT] });
        await openManager(sessions);

        const allBox = document.querySelector(
            '#ws-manager-roots .ws-manager-all input',
        );
        allBox.click();

        // The click must survive the re-render it triggers.
        expect(
            document.querySelector('#ws-manager-roots .ws-manager-all input')
                .checked,
        ).toBe(true);
        expect(rootRows().map((row) => row.checked)).toEqual([
            true,
            true,
            true,
        ]);
        expect(
            document.querySelector('#ws-manager-roots .ws-manager-add-btn')
                .textContent,
        ).toBe('Add selected (3)');

        document.querySelector('#ws-manager-roots .ws-manager-add-btn').click();
        await vi.waitFor(() => expect(calls.length).toBe(1));
        expect(calls[0].body).toEqual({
            paths: ['/code/psi', '/code/theta', '/code/zeta'],
        });
    });

    it('removes selected projects in one batch and returns them to their root', async () => {
        const { calls } = installFetch({
            browse: () => browseEntries('alpha', 'beta'),
        });
        const sessions = makeSessions({
            workspaces: ['/code/alpha', '/code/beta'],
            roots: [BROWSE_ROOT],
        });
        await openManager(sessions);
        expect(rootRows()).toEqual([]);

        toggle('/code/alpha');
        expect(buttonText('ws-manager-remove')).toBe('Remove selected (1)');
        document.getElementById('ws-manager-remove').click();
        await vi.waitFor(() => expect(calls.length).toBe(1));

        expect(calls[0].method).toBe('DELETE');
        expect(calls[0].body).toEqual({ paths: ['/code/alpha'] });
        await vi.waitFor(() =>
            expect(projects().map((row) => row.path)).toEqual(['/code/beta']),
        );
        await vi.waitFor(() =>
            expect(rootRows().map((row) => row.path)).toEqual(['/code/alpha']),
        );
        expect(sessions.activeWorkspace).toBe('/code/beta');
    });

    it('rolls an HTTP error back and keeps the selection', async () => {
        installFetch({
            browse: () => browseEntries('psi'),
            write: () => ({ ok: false, status: 400, text: 'Path rejected' }),
        });
        const sessions = makeSessions({
            workspaces: ['/code/keep'],
            roots: [BROWSE_ROOT],
        });
        await openManager(sessions);

        toggle('/code/psi', true);
        document.querySelector('#ws-manager-roots .ws-manager-add-btn').click();

        await vi.waitFor(() => expect(statusText()).toContain('Path rejected'));
        expect(sessions.workspaces).toEqual(['/code/keep']);
        expect(projects().map((row) => row.path)).toEqual(['/code/keep']);
        expect(rootRows()).toEqual([{ path: '/code/psi', checked: true }]);
        expect(
            document.querySelector('#ws-manager-roots .ws-manager-add-btn')
                .textContent,
        ).toBe('Add selected (1)');
    });

    it('keeps a never-sent change in the browser and flushes it once online', async () => {
        setOnline(false);
        const { calls, fetchMock } = installFetch({
            browse: () => browseEntries('psi'),
        });
        const sessions = makeSessions({
            workspaces: ['/code/keep'],
            roots: [BROWSE_ROOT],
        });
        await openManager(sessions);

        toggle('/code/keep');
        document.getElementById('ws-manager-remove').click();

        await vi.waitFor(() =>
            expect(statusText()).toContain('Saved in this browser'),
        );
        expect(
            fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE'),
        ).toBe(false);
        expect(sessions.workspaces).toEqual([]);
        expect(
            JSON.parse(localStorage.getItem('phi_workspace_manager_outbox')),
        ).toEqual({ kind: 'remove', paths: ['/code/keep'], state: 'unsent' });

        setOnline(true);
        window.dispatchEvent(new Event('online'));
        await vi.waitFor(() => expect(calls.length).toBe(1));
        expect(calls[0]).toEqual({
            url: '/api/config/workspaces',
            method: 'DELETE',
            body: { paths: ['/code/keep'] },
        });
        await vi.waitFor(() =>
            expect(
                localStorage.getItem('phi_workspace_manager_outbox'),
            ).toBeNull(),
        );
    });

    it('never resends a started write, and reconciles through Check status', async () => {
        let loadConfig = async () => false;
        const { fetchMock } = installFetch({
            browse: () => browseEntries('psi'),
            write: () => new TypeError('network down'),
        });
        const sessions = makeSessions({
            workspaces: ['/code/keep'],
            roots: [BROWSE_ROOT],
            loadConfig: () => loadConfig(),
        });
        await openManager(sessions);

        toggle('/code/psi', true);
        document.querySelector('#ws-manager-roots .ws-manager-add-btn').click();

        await vi.waitFor(() =>
            expect(statusText()).toContain('Change not confirmed'),
        );
        const writes = () =>
            fetchMock.mock.calls.filter(([url]) =>
                String(url).includes('/api/config/workspace'),
            );
        expect(writes().length).toBe(1);
        expect(
            localStorage.getItem('phi_workspace_manager_outbox'),
        ).not.toBeNull();

        loadConfig = async () => true;
        const check = document.querySelector('.ws-manager-check-btn');
        expect(check).not.toBeNull();
        check.click();

        await vi.waitFor(() =>
            expect(document.querySelector('.ws-manager-check-btn')).toBeNull(),
        );
        expect(writes().length).toBe(1);
        expect(localStorage.getItem('phi_workspace_manager_outbox')).toBeNull();
    });

    it('renders cached children when the refresh fails, and notes truncation', async () => {
        const store = new BackendStore('ws-test');
        store.responses.set(
            `/api/fs/browse?path=${encodeURIComponent(BROWSE_ROOT)}`,
            JSON.stringify({
                path: BROWSE_ROOT,
                parent: '/',
                truncated: true,
                entries: [{ name: 'cached', path: '/code/cached' }],
            }),
        );
        const { fetchMock } = installFetch({
            browse: () => {
                throw new Error('offline');
            },
            other: () => {
                throw new Error('offline');
            },
        });
        const sessions = makeSessions({
            workspaces: [],
            roots: [BROWSE_ROOT],
            store,
            loadConfig: async () => false,
        });

        await openManager(sessions);

        await vi.waitFor(() =>
            expect(rootRows().map((row) => row.path)).toEqual(['/code/cached']),
        );
        expect(
            document.querySelector('#ws-manager-roots').textContent,
        ).toContain('more entries than the browser can list');
        expect(projects()).toEqual([]);
        // A failed refresh must not clear the cached rows.
        expect(rootRows().length).toBe(1);
        expect(fetchMock).toHaveBeenCalled();
    });

    it('does not resend a stored write that may already have reached the server', async () => {
        localStorage.setItem(
            'phi_workspace_manager_outbox',
            JSON.stringify({
                kind: 'add',
                paths: ['/code/psi'],
                state: 'unconfirmed',
            }),
        );
        const { fetchMock } = installFetch({
            browse: () => browseEntries('psi'),
        });
        const sessions = makeSessions({ workspaces: [], roots: [BROWSE_ROOT] });
        await openManager(sessions);

        expect(statusText()).toContain('Change not confirmed');
        expect(document.querySelector('.ws-manager-check-btn')).not.toBeNull();
        // The stored result is still shown, but nothing is sent again.
        expect(projects().map((row) => row.path)).toEqual(['/code/psi']);
        window.dispatchEvent(new Event('online'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(
            fetchMock.mock.calls.filter(([url]) =>
                String(url).includes('/api/config/workspace'),
            ).length,
        ).toBe(0);
        expect(
            JSON.parse(localStorage.getItem('phi_workspace_manager_outbox'))
                .state,
        ).toBe('unconfirmed');
    });

    it('keeps one queued change instead of overwriting it with the next one', async () => {
        setOnline(false);
        const { calls } = installFetch({
            browse: () => browseEntries('psi'),
        });
        const sessions = makeSessions({
            workspaces: ['/code/keep'],
            roots: [BROWSE_ROOT],
        });
        await openManager(sessions);

        toggle('/code/keep');
        document.getElementById('ws-manager-remove').click();
        await vi.waitFor(() =>
            expect(statusText()).toContain('Saved in this browser'),
        );

        // The first change still owns the outbox, so a second one cannot start.
        setOnline(true);
        toggle('/code/psi', true);
        document.querySelector('#ws-manager-roots .ws-manager-add-btn').click();
        expect(calls.length).toBe(0);

        window.dispatchEvent(new Event('online'));
        await vi.waitFor(() => expect(calls.length).toBe(1));
        expect(calls[0].body).toEqual({ paths: ['/code/keep'] });
    });

    it('retries a failed root read without touching other roots', async () => {
        let fail = true;
        installFetch({
            browse: (path) => {
                if (path === '/code' && fail) throw new Error('offline');
                return path === '/code'
                    ? browseEntries('psi')
                    : {
                          ok: true,
                          status: 200,
                          json: {
                              path: '/other',
                              parent: '/',
                              truncated: false,
                              entries: [{ name: 'keep', path: '/other/keep' }],
                          },
                      };
            },
        });
        const sessions = makeSessions({
            workspaces: ['/elsewhere'],
            roots: [BROWSE_ROOT, '/other'],
        });
        await openManager(sessions, 2);

        expect(
            document.querySelector('#ws-manager-roots').textContent,
        ).toContain('Could not read this folder.');
        // A failure in one root must not clear another root's rows.
        expect(rootRows().map((row) => row.path)).toEqual(['/other/keep']);

        fail = false;
        document.querySelector('.ws-manager-retry-btn').click();

        await vi.waitFor(() =>
            expect(rootRows().map((row) => row.path)).toEqual([
                '/code/psi',
                '/other/keep',
            ]),
        );
        expect(document.querySelector('.ws-manager-retry-btn')).toBeNull();
    });

    it('drops a child that disappeared from disk on the next read', async () => {
        let children = ['gone', 'stays'];
        installFetch({ browse: () => browseEntries(...children) });
        const sessions = makeSessions({ workspaces: [], roots: [BROWSE_ROOT] });
        await openManager(sessions);
        expect(rootRows().map((row) => row.path)).toEqual([
            '/code/gone',
            '/code/stays',
        ]);

        children = ['stays'];
        sessions.workspaceManager.close();
        await openManager(sessions);
        await vi.waitFor(() =>
            expect(rootRows().map((row) => row.path)).toEqual(['/code/stays']),
        );
    });

    it('filters locally, sends only visible rows, and keeps hidden selections', async () => {
        const { calls } = installFetch({
            browse: () => browseEntries('psi', 'psi-extra', 'theta'),
        });
        const sessions = makeSessions({ workspaces: [], roots: [BROWSE_ROOT] });
        await openManager(sessions);

        toggle('/code/psi', true);
        setFilter('theta');

        expect(rootRows().map((row) => row.path)).toEqual(['/code/theta']);
        expect(allLabel('#ws-manager-roots')).toBe('Select visible');
        // The hidden selection is kept, but it is not counted and would not be
        // part of a batch sent now.
        expect(
            document.querySelector('#ws-manager-roots .ws-manager-add-btn')
                .textContent,
        ).toBe('Add selected (0)');

        toggle('/code/theta', true);
        document.querySelector('#ws-manager-roots .ws-manager-add-btn').click();
        await vi.waitFor(() => expect(calls.length).toBe(1));
        expect(calls[0].body).toEqual({ paths: ['/code/theta'] });

        // Clearing the filter brings the still-selected hidden row back.
        setFilter('');
        await vi.waitFor(() =>
            expect(rootRows().map((row) => [row.path, row.checked])).toEqual([
                ['/code/psi', true],
                ['/code/psi-extra', false],
            ]),
        );
        expect(
            document.querySelector('#ws-manager-roots .ws-manager-add-btn')
                .textContent,
        ).toBe('Add selected (1)');
        expect(allLabel('#ws-manager-roots')).toBe('All');

        // A filter that matches nothing shows an empty list, never stale rows.
        setFilter('zzz');
        expect(rootRows()).toEqual([]);
        expect(projects()).toEqual([]);
        // Filtering never rewrites the registered list.
        expect(sessions.workspaces).toEqual(['/code/theta']);
    });

    it('drops a late root listing after the dialog is closed and reopened', async () => {
        let resolveStale;
        const stale = new Promise((resolve) => {
            resolveStale = resolve;
        });
        let browseCount = 0;
        installFetch({
            browse: () => {
                browseCount += 1;
                if (browseCount === 1) return stale;
                return browseEntries('fresh');
            },
        });
        const sessions = makeSessions({ workspaces: [], roots: [BROWSE_ROOT] });

        void sessions.workspaceManager.open();
        // Let the first open reach its root read, then trap that read.
        await new Promise((resolve) => setTimeout(resolve, 0));
        sessions.workspaceManager.close();
        sessions.workspaceManager.open();
        await vi.waitFor(() =>
            expect(rootRows().map((row) => row.path)).toEqual(['/code/fresh']),
        );

        resolveStale(browseEntries('stale'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(rootRows().map((row) => row.path)).toEqual(['/code/fresh']);
    });

    it('flushes a write queued in an earlier visit as soon as the dialog opens online', async () => {
        localStorage.setItem(
            'phi_workspace_manager_outbox',
            JSON.stringify({
                kind: 'add',
                paths: ['/code/psi'],
                state: 'unsent',
            }),
        );
        const { calls } = installFetch({
            browse: () => browseEntries('psi'),
        });
        const sessions = makeSessions({ workspaces: [], roots: [BROWSE_ROOT] });
        await openManager(sessions);

        // Nothing else retries a never-sent write: no `online` event fires when
        // the browser was already online at load.
        await vi.waitFor(() => expect(calls.length).toBe(1));
        expect(calls[0]).toEqual({
            url: '/api/config/workspaces',
            method: 'POST',
            body: { paths: ['/code/psi'] },
        });
        await vi.waitFor(() =>
            expect(
                localStorage.getItem('phi_workspace_manager_outbox'),
            ).toBeNull(),
        );
    });

    it('says the change was not applied when the reload proves it never landed', async () => {
        const { fetchMock } = installFetch({
            browse: () => browseEntries('psi'),
            write: () => new TypeError('network down'),
        });
        const sessions = makeSessions({ workspaces: [], roots: [BROWSE_ROOT] });
        // The server answers reads normally; it simply never got the write.
        sessions.loadConfig = async () => {
            sessions.applyConfigData({
                workspaces: [],
                workspace_roots: [BROWSE_ROOT],
                active_cwd: '',
            });
            return true;
        };
        await openManager(sessions);

        toggle('/code/psi', true);
        document.querySelector('#ws-manager-roots .ws-manager-add-btn').click();

        // The follow-up read succeeds and shows the old list: the change never
        // reached the server, and the message must not claim it was saved.
        await vi.waitFor(() =>
            expect(statusText()).toContain('did not apply this change'),
        );
        expect(projects()).toEqual([]);
        expect(
            fetchMock.mock.calls.filter(([url]) =>
                String(url).includes('/api/config/workspace'),
            ).length,
        ).toBe(1);
    });

    it('keeps keyboard focus inside the dialog when a retry re-renders it', async () => {
        let fail = true;
        installFetch({
            browse: () => {
                if (fail) throw new Error('offline');
                return browseEntries('psi');
            },
        });
        const sessions = makeSessions({ workspaces: [], roots: [BROWSE_ROOT] });
        await openManager(sessions);

        const retry = document.querySelector('.ws-manager-retry-btn');
        retry.focus();
        expect(document.activeElement).toBe(retry);

        fail = false;
        retry.click();
        await vi.waitFor(() =>
            expect(document.querySelector('.ws-manager-retry-btn')).toBeNull(),
        );

        // The focused button was replaced: focus must land back in the dialog,
        // not on <body> outside the trap.
        expect(document.activeElement).not.toBe(document.body);
        expect(
            document
                .getElementById('ws-manager-modal')
                .contains(document.activeElement),
        ).toBe(true);
    });

    it('adds a root without touching the workspace list', async () => {
        const { calls } = installFetch({
            browse: (path) =>
                path === '/new-root'
                    ? {
                          ok: true,
                          status: 200,
                          json: {
                              path: '/new-root',
                              parent: '/',
                              truncated: false,
                              entries: [{ name: 'one', path: '/new-root/one' }],
                          },
                      }
                    : browseEntries(),
        });
        const sessions = makeSessions({ workspaces: ['/code/keep'] });
        // A real server answers the follow-up config read with the saved root.
        sessions.loadConfig = async () => {
            sessions.applyConfigData({
                workspaces: ['/code/keep'],
                workspace_roots: ['/new-root'],
                active_cwd: '/code/keep',
            });
            return true;
        };
        await openManager(sessions, 0);

        document.getElementById('ws-manager-root-input').value = '/new-root';
        document.getElementById('ws-manager-root-add').click();

        await vi.waitFor(() => expect(calls.length).toBe(1));
        expect(calls[0]).toEqual({
            url: '/api/config/workspace-roots',
            method: 'POST',
            body: { path: '/new-root' },
        });
        await vi.waitFor(() =>
            expect(
                document.querySelector('#ws-manager-roots').textContent,
            ).toContain('Rest of new-root'),
        );
        expect(sessions.workspaces).toEqual(['/code/keep']);
        await vi.waitFor(() =>
            expect(
                document.querySelector('#ws-manager-roots').textContent,
            ).toContain('/new-root/one'),
        );
    });
});
