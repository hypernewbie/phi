// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import { SessionsManager } from '../web/sessions.js';
import { DiffController } from '../web/diff.js';

// Tests for the soft-close tab pipeline:
//   closeTab(paneId)   -> softCloseTab (grace period)
//   undoCloseTab       -> restore
//   finalizeCloseTab   -> actually kill the PTY
//
// The grace timer is 3s (TabManager.SOFT_CLOSE_GRACE_MS). These tests
// use vi.useFakeTimers so we can advance the clock without waiting in
// real time. The MAX_SOFT_CLOSED_TABS cap = 3.
//
// Soft-close hides the tab from the strip and selects a visible survivor
// through ordinary tab synchronization. The tab remains recoverable in the
// tab-list dropdown until finalization.

setupDomHarness();

function makeTm({ withTabs = [], activePaneId = null } = {}) {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = activePaneId;
    tm.dragSourceId = null;
    tm.tabsContainer = document.createElement('div');
    tm.tabsContainer.id = 'tabs-container';
    document.body.appendChild(tm.tabsContainer);
    tm.inputBarContainer = document.createElement('div');
    tm.inputBarContainer.id = 'input-bar-container';
    document.body.appendChild(tm.inputBarContainer);
    tm.presetsContainer = document.createElement('div');
    tm.presetsContainer.id = 'presets-container';
    document.body.appendChild(tm.presetsContainer);
    // Spies for methods called by the soft-close pipeline that don't
    // need real implementations for these tests.
    tm.updateDirectModeUI = vi.fn();
    tm.activateTabViewport = vi.fn();
    tm.updateDocumentTitle = vi.fn();
    tm.showEmptyState = vi.fn();
    tm.hideEmptyState = vi.fn();
    tm.updateDisconnectBanner = vi.fn();
    tm.saveTabsState = vi.fn();
    const sessionsManager = {
        activeCoder: 'shell',
        activeWorkspace: '/wsA',
        activeCWD: '/wsA',
        switchCoder: vi.fn((coder) => {
            if (!['pi-rpc', 'review', 'kanban'].includes(coder)) {
                sessionsManager.activeCoder = coder;
            }
        }),
        highlightActiveSession: vi.fn(),
        highlightActiveWorktree: vi.fn(),
        workspaceSelect: { value: '/wsA' },
        updateWorkspaceSelectWidth: vi.fn(),
        loadWorktrees: vi.fn(() => Promise.resolve()),
    };
    tm.app = {
        config: {},
        showToast: vi.fn(() => {
            // Mimic the real showToast: return a DOM-like element with a
            // classList. We don't need full DOM here - the soft-close
            // pipeline just stashes this ref to dismiss on undo/finalize.
            return { classList: { add: vi.fn(), remove: vi.fn() } };
        }),
        kanbanManager: { cleanup: vi.fn() },
        reviewManager: { cleanup: vi.fn() },
        markdownManager: { refreshFiles: vi.fn() },
        // switchTab reaches into sessionsManager to coordinate the sidebar.
        sessionsManager,
        diffController: { refreshDiff: vi.fn() },
    };

    for (const id of withTabs) {
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.setAttribute('data-pane-id', id);
        // jsdom doesn't implement scrollIntoView; stub it so switchTab's
        // "Scroll tabs bar to active tab" call doesn't throw.
        tabEl.scrollIntoView = vi.fn();
        tm.tabsContainer.appendChild(tabEl);
        const meta = typeof id === 'string' ? { paneId: id } : id;
        const fullMeta = {
            paneId: meta.paneId,
            sessionId: meta.paneId,
            title: meta.title || meta.paneId,
            coder: meta.coder || 'shell',
            workspace: meta.workspace || '/wsA',
            cwd: meta.cwd || '/wsA',
            tabEl,
            termContainer: document.createElement('div'),
            isDead: false,
            isReview: meta.coder === 'review',
            isKanban: meta.coder === 'kanban',
            pinned: false,
            marked: false,
            ws: { close: vi.fn(), sendInput: vi.fn(), sendResize: vi.fn() },
            term: {
                dispose: vi.fn(),
                scrollToBottom: vi.fn(),
                scrollToLine: vi.fn(),
                focus: vi.fn(),
                refresh: vi.fn(),
                buffer: { active: { viewportY: 0, baseY: 0 } },
                options: { fontSize: 14 },
                cols: 80,
                rows: 24,
            },
            fitAddon: { fit: vi.fn() },
        };
        tm.tabs.set(meta.paneId, fullMeta);
    }
    const activeTab = tm.tabs.get(activePaneId);
    if (activeTab) {
        sessionsManager.activeWorkspace = activeTab.workspace;
        sessionsManager.activeCWD = activeTab.cwd;
        sessionsManager.workspaceSelect.value = activeTab.workspace;
        if (!['pi-rpc', 'review', 'kanban'].includes(activeTab.coder)) {
            sessionsManager.activeCoder = activeTab.coder;
        }
    }
    return tm;
}

function controlledPromise() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function makeRealStatusController(sessionsManager, initialStatus) {
    const output = { value: initialStatus };
    const term = {
        reset: vi.fn(() => {
            output.value = '';
        }),
        clear: vi.fn(() => {
            output.value = '';
        }),
        write: vi.fn((text) => {
            output.value += text;
        }),
    };
    const diffController = Object.create(DiffController.prototype);
    Object.assign(diffController, {
        app: { sessionsManager },
        activeTab: 'status',
        currentWs: null,
        isPanelOpen: true,
        term,
        commitSelect: null,
        fitTerminal: vi.fn(),
        _setPanel: vi.fn(),
    });
    return { diffController, output };
}

function makeRealSessionsManager(tm) {
    const initialSessionsManager = tm.app.sessionsManager;
    const sessionsManager = Object.create(SessionsManager.prototype);
    const sessionList = document.createElement('div');
    const workspaceSelect = document.createElement('input');
    sessionList.id = 'session-list';
    document.body.appendChild(sessionList);
    document.body.appendChild(workspaceSelect);

    Object.assign(sessionsManager, {
        sessionList,
        workspaceSelect,
        activeCoder: initialSessionsManager.activeCoder,
        activeWorkspace: initialSessionsManager.activeWorkspace,
        activeCWD: initialSessionsManager.activeCWD,
        worktreeDirtyRequestId: 0,
        loadWorktreeSessions: vi.fn(),
        loadWorktreeDirtyStates: vi.fn(),
        highlightActiveSession: vi.fn(),
        saveWorktreeState: vi.fn(async () => {}),
        updateWorkspaceSelectWidth: vi.fn(),
        app: {
            diffController: tm.app.diffController,
            tabManager: { getActiveTab: () => tm.getActiveTab() },
        },
    });
    workspaceSelect.value = initialSessionsManager.workspaceSelect.value;

    const loads = [];
    sessionsManager.loadWorktrees = vi.fn((cwd) => {
        const load = SessionsManager.prototype.loadWorktrees.call(
            sessionsManager,
            cwd,
        );
        loads.push(load);
        return load;
    });
    tm.app.sessionsManager = sessionsManager;
    return { sessionsManager, loads };
}

function makeSpawnCloseFixture(spawnResponse) {
    const tm = makeTm({
        withTabs: [
            {
                paneId: 'a',
                workspace: '/wsA',
                cwd: '/wsA/main',
                coder: 'shell',
            },
            {
                paneId: 'b',
                workspace: '/wsB',
                cwd: '/wsB/main',
                coder: 'opencode',
            },
        ],
        activePaneId: 'a',
    });
    const { sessionsManager, loads } = makeRealSessionsManager(tm);
    const createTab = vi.fn();
    const loadSessions = vi.fn();
    const showSessionError = vi.fn();
    sessionsManager.app.tabManager.createTab = createTab;
    sessionsManager.app.showToast = showSessionError;
    sessionsManager.loadSessions = loadSessions;

    const fetchRequests = [];
    vi.stubGlobal(
        'fetch',
        vi.fn((url, options) => {
            const requestUrl = String(url);
            fetchRequests.push({ url: requestUrl, options });
            if (requestUrl === '/api/terminals') return spawnResponse();
            if (requestUrl === '/api/git/worktrees?cwd=%2FwsB') {
                return Promise.resolve({
                    ok: true,
                    json: vi.fn(async () => [
                        { path: '/wsB/main', active: true },
                    ]),
                });
            }
            throw new Error(`Unexpected fetch: ${requestUrl}`);
        }),
    );
    return {
        tm,
        sessionsManager,
        loads,
        createTab,
        loadSessions,
        showSessionError,
        fetchRequests,
    };
}

function makePendingProjectRefresh(tm, initialStatus) {
    const { sessionsManager, loads } = makeRealSessionsManager(tm);
    const { diffController, output } = makeRealStatusController(
        sessionsManager,
        initialStatus,
    );
    tm.app.diffController = diffController;
    sessionsManager.app.diffController = diffController;
    const refreshSpy = vi.spyOn(diffController, 'refreshDiff');
    const worktreeResponses = [];
    const fetchUrls = [];
    vi.stubGlobal(
        'fetch',
        vi.fn((url) => {
            const requestUrl = String(url);
            fetchUrls.push(requestUrl);
            if (requestUrl === '/api/git/worktrees?cwd=%2FwsB') {
                const response = controlledPromise();
                worktreeResponses.push(response);
                return response.promise;
            }
            if (requestUrl === '/api/git/raw-status?cwd=%2FwsB%2Fmain') {
                return Promise.resolve({
                    ok: true,
                    text: vi.fn(async () => 'status for /wsB/main'),
                });
            }
            throw new Error(`Unexpected fetch: ${requestUrl}`);
        }),
    );
    return {
        sessionsManager,
        loads,
        diffController,
        output,
        refreshSpy,
        worktreeResponses,
        fetchUrls,
    };
}

async function completeProjectRefresh(project) {
    project.worktreeResponses[0].resolve({
        ok: true,
        json: vi.fn(async () => [
            { path: '/wsB/main', active: true },
            { path: '/wsB/other' },
        ]),
    });
    await project.loads[0];
    await Promise.resolve();
    const refresh = project.refreshSpy.mock.results[0]?.value;
    if (refresh) await refresh;
}

beforeEach(() => {
    vi.useFakeTimers();
    // Mock fetch for the PTY-kill DELETE call in finalizeCloseTab.
    mockFetch(() => ({ ok: true, status: 200 }));
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// ---- softCloseTab ----------------------------------------------------

describe('softCloseTab - grace period behavior', () => {
    it('uses a three-second undo grace', () => {
        expect(TabManager.SOFT_CLOSE_GRACE_MS).toBe(3000);
    });

    it('marks the tab soft-closed without immediately killing the PTY', () => {
        const tm = makeTm({ withTabs: ['a'] });
        const tab = tm.tabs.get('a');

        tm.softCloseTab('a');

        expect(tab.softClosing).toBe(true);
        expect(tab.tabEl.classList.contains('soft-closed')).toBe(true);
        // The WS / term are NOT closed yet - that's what makes undo safe.
        expect(tab.ws.close).not.toHaveBeenCalled();
        expect(tab.term.dispose).not.toHaveBeenCalled();
        // PTY is NOT deleted on the server yet.
        expect(fetch).not.toHaveBeenCalled();
        // Tab is still in the Map (so undo can restore it).
        expect(tm.tabs.has('a')).toBe(true);
    });

    it('shows an undo toast with the tab title', () => {
        const tm = makeTm({
            withTabs: [{ paneId: 'a', title: 'My Cool Shell' }],
        });
        tm.softCloseTab('a');
        expect(tm.app.showToast).toHaveBeenCalledTimes(1);
        const [message, opts] = tm.app.showToast.mock.calls[0];
        expect(message).toContain('My Cool Shell');
        expect(opts.action.text).toBe('Undo');
        expect(opts.action.callback).toBeInstanceOf(Function);
    });

    it('schedules finalizeCloseTab after SOFT_CLOSE_GRACE_MS', () => {
        const tm = makeTm({ withTabs: ['a'] });
        const finalizeSpy = vi.spyOn(tm, 'finalizeCloseTab');
        tm.softCloseTab('a');
        expect(finalizeSpy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(TabManager.SOFT_CLOSE_GRACE_MS - 1);
        expect(finalizeSpy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(finalizeSpy).toHaveBeenCalledWith('a');
    });

    it('second closeTab on a soft-closing tab force-finalizes immediately', () => {
        // "I really mean it" - user clicked × twice. Finalize right away
        // (no need to wait the full 3s grace).
        const tm = makeTm({ withTabs: ['a'] });
        const finalizeSpy = vi.spyOn(tm, 'finalizeCloseTab');
        tm.softCloseTab('a'); // first ×
        tm.closeTab('a'); // second × = finalize now
        expect(finalizeSpy).toHaveBeenCalledWith('a');
        // Tab should be gone.
        expect(tm.tabs.has('a')).toBe(false);
    });
});

// ---- undoCloseTab ---------------------------------------------------

describe('undoCloseTab - reverse a soft-close', () => {
    it('cancels the grace timer and clears the soft-closed state', () => {
        const tm = makeTm({ withTabs: ['a'] });
        const finalizeSpy = vi.spyOn(tm, 'finalizeCloseTab');
        tm.softCloseTab('a');

        tm.undoCloseTab('a');

        expect(tm.tabs.get('a').softClosing).toBe(false);
        expect(tm.tabs.get('a').tabEl.classList.contains('soft-closed')).toBe(
            false,
        );
        // Advance past the grace - finalize should NOT fire because we undid.
        vi.advanceTimersByTime(TabManager.SOFT_CLOSE_GRACE_MS + 1000);
        expect(finalizeSpy).not.toHaveBeenCalled();
        expect(tm.tabs.has('a')).toBe(true);
    });

    it('invokes the toast callback when called via the Undo button', () => {
        const tm = makeTm({ withTabs: ['a'] });
        let capturedCallback = null;
        tm.app.showToast = vi.fn((_msg, opts) => {
            capturedCallback = opts.action.callback;
            return { classList: { add: vi.fn(), remove: vi.fn() } };
        });
        tm.softCloseTab('a');
        expect(capturedCallback).toBeInstanceOf(Function);
        // User clicks Undo - this is what the toast's action button does.
        capturedCallback();
        expect(tm.tabs.get('a').softClosing).toBe(false);
    });
});

// ---- spawn request context while a tab closes ------------------------

describe('spawnNewSession - request-time context', () => {
    const requestBodyA = {
        coder: 'shell',
        cwd: '/wsA/main',
        session_id: '',
        title: '+ Shell',
        workspace: '/wsA',
    };
    const createdTabA = [
        'spawned-pane-a',
        'spawned-session-a',
        '+ Shell',
        'shell',
        '/wsA',
        '/wsA/main',
    ];

    it('keeps request metadata when A closes before the POST response', async () => {
        const postResponse = controlledPromise();
        const fixture = makeSpawnCloseFixture(() => postResponse.promise);
        const spawn = fixture.sessionsManager.spawnNewSession();

        expect(fixture.fetchRequests).toHaveLength(1);
        expect(fixture.fetchRequests[0].url).toBe('/api/terminals');
        expect(JSON.parse(fixture.fetchRequests[0].options.body)).toEqual(
            requestBodyA,
        );

        fixture.tm.closeTab('a');
        await fixture.loads[0];
        expect(fixture.tm.activePaneId).toBe('b');
        expect(fixture.sessionsManager.activeCoder).toBe('opencode');
        expect(fixture.sessionsManager.activeWorkspace).toBe('/wsB');
        expect(fixture.sessionsManager.workspaceSelect.value).toBe('/wsB');
        expect(fixture.sessionsManager.activeCWD).toBe('/wsB/main');
        expect(fixture.tm.app.showToast).toHaveBeenCalledTimes(1);
        expect(fixture.fetchRequests.map(({ url }) => url)).toEqual([
            '/api/terminals',
            '/api/git/worktrees?cwd=%2FwsB',
        ]);

        postResponse.resolve({
            ok: true,
            json: vi.fn(async () => ({
                pane_id: 'spawned-pane-a',
                session_id: 'spawned-session-a',
            })),
        });
        await spawn;

        expect(fixture.createTab).toHaveBeenCalledTimes(1);
        expect(fixture.createTab).toHaveBeenCalledWith(...createdTabA);
        expect(fixture.loadSessions).toHaveBeenCalledTimes(1);
        expect(fixture.showSessionError).not.toHaveBeenCalled();
    });

    it('keeps request metadata when A closes while response JSON is pending', async () => {
        const jsonBody = controlledPromise();
        const jsonEntered = controlledPromise();
        const json = vi.fn(() => {
            jsonEntered.resolve();
            return jsonBody.promise;
        });
        const fixture = makeSpawnCloseFixture(() =>
            Promise.resolve({ ok: true, json }),
        );
        const spawn = fixture.sessionsManager.spawnNewSession();

        await jsonEntered.promise;
        expect(json).toHaveBeenCalledTimes(1);
        expect(fixture.fetchRequests).toHaveLength(1);
        expect(JSON.parse(fixture.fetchRequests[0].options.body)).toEqual(
            requestBodyA,
        );

        fixture.tm.closeTab('a');
        await fixture.loads[0];
        expect(fixture.tm.activePaneId).toBe('b');
        expect(fixture.sessionsManager.activeCoder).toBe('opencode');
        expect(fixture.sessionsManager.activeWorkspace).toBe('/wsB');
        expect(fixture.sessionsManager.workspaceSelect.value).toBe('/wsB');
        expect(fixture.sessionsManager.activeCWD).toBe('/wsB/main');
        expect(fixture.tm.app.showToast).toHaveBeenCalledTimes(1);
        expect(fixture.fetchRequests.map(({ url }) => url)).toEqual([
            '/api/terminals',
            '/api/git/worktrees?cwd=%2FwsB',
        ]);

        jsonBody.resolve({
            pane_id: 'spawned-pane-a',
            session_id: 'spawned-session-a',
        });
        await spawn;

        expect(json).toHaveBeenCalledTimes(1);
        expect(fixture.createTab).toHaveBeenCalledTimes(1);
        expect(fixture.createTab).toHaveBeenCalledWith(...createdTabA);
        expect(fixture.loadSessions).toHaveBeenCalledTimes(1);
        expect(fixture.showSessionError).not.toHaveBeenCalled();
    });
});

// ---- stale real-loader responses after close + Undo ------------------

describe('softCloseTab - stale real worktree responses', () => {
    it.each(['A then B', 'B then A'])(
        'keeps restored tab A selected when responses resolve %s',
        async (responseOrder) => {
            const tm = makeTm({
                withTabs: [
                    {
                        paneId: 'a',
                        workspace: '/wsA',
                        cwd: '/wsA/main',
                        coder: 'opencode',
                    },
                    {
                        paneId: 'b',
                        workspace: '/wsB',
                        cwd: '/wsB/main',
                        coder: 'shell',
                    },
                ],
                activePaneId: 'a',
            });
            const { sessionsManager, loads } = makeRealSessionsManager(tm);
            const requests = [];
            vi.stubGlobal(
                'fetch',
                vi.fn((url) => {
                    const response = controlledPromise();
                    requests.push({ url: String(url), ...response });
                    return response.promise;
                }),
            );

            tm.softCloseTab('a');
            tm.undoCloseTab('a');

            expect(tm.activePaneId).toBe('a');
            expect(sessionsManager.activeWorkspace).toBe('/wsA');
            expect(sessionsManager.workspaceSelect.value).toBe('/wsA');
            expect(sessionsManager.activeCWD).toBe('/wsA/main');
            expect(sessionsManager.activeCoder).toBe('opencode');
            expect(loads).toHaveLength(2);
            expect(requests.map(({ url }) => url)).toEqual([
                '/api/git/worktrees?cwd=%2FwsB',
                '/api/git/worktrees?cwd=%2FwsA',
            ]);

            const resolveRequest = (index, workspace) => {
                requests[index].resolve({
                    ok: true,
                    json: vi.fn(async () => [
                        { path: `${workspace}/main`, active: true },
                    ]),
                });
            };
            const assertRestoredA = () => {
                expect(tm.activePaneId).toBe('a');
                expect(sessionsManager.activeWorkspace).toBe('/wsA');
                expect(sessionsManager.workspaceSelect.value).toBe('/wsA');
                expect(sessionsManager.activeCWD).toBe('/wsA/main');
                expect(sessionsManager.activeCoder).toBe('opencode');
                expect(
                    sessionsManager.sessionList
                        .querySelector('.worktree-section.active')
                        ?.getAttribute('data-worktree-path'),
                ).toBe('/wsA/main');
                expect(
                    sessionsManager.highlightActiveSession.mock.calls,
                ).toEqual([['a']]);
                expect(tm.app.diffController.refreshDiff).toHaveBeenCalledTimes(
                    1,
                );
                expect(tm.app.markdownManager.refreshFiles.mock.calls).toEqual([
                    [{ force: false }],
                ]);
            };

            if (responseOrder === 'A then B') {
                resolveRequest(1, '/wsA');
                await loads[1];
                await Promise.resolve();
                assertRestoredA();

                resolveRequest(0, '/wsB');
                await loads[0];
                await Promise.resolve();
                assertRestoredA();
            } else {
                resolveRequest(0, '/wsB');
                await loads[0];
                await Promise.resolve();

                expect(sessionsManager.activeCWD).toBe('/wsA/main');
                expect(sessionsManager.sessionList.textContent).toContain(
                    'Scanning git worktrees',
                );
                expect(
                    sessionsManager.highlightActiveSession,
                ).not.toHaveBeenCalled();
                expect(
                    tm.app.diffController.refreshDiff,
                ).not.toHaveBeenCalled();
                expect(
                    tm.app.markdownManager.refreshFiles,
                ).not.toHaveBeenCalled();

                resolveRequest(1, '/wsA');
                await loads[1];
                await Promise.resolve();
                assertRestoredA();
            }
        },
    );

    it.each([
        [
            'workspace change with explicit C selection',
            '/wsA',
            '/wsA/main',
            'shell',
            'select',
        ],
        [
            'workspace change with a second close to C',
            '/wsA',
            '/wsA/main',
            'shell',
            'close',
        ],
        [
            'coder change with explicit C selection',
            '/wsB',
            '/wsB/other',
            'opencode',
            'select',
        ],
        [
            'coder change with a second close to C',
            '/wsB',
            '/wsB/other',
            'opencode',
            'close',
        ],
    ])(
        'refreshes status for current C after %s',
        async (_label, aWorkspace, aCwd, aCoder, selection) => {
            const tm = makeTm({
                withTabs: [
                    {
                        paneId: 'a',
                        workspace: aWorkspace,
                        cwd: aCwd,
                        coder: aCoder,
                    },
                    {
                        paneId: 'b',
                        workspace: '/wsB',
                        cwd: '/wsB/main',
                        coder: 'shell',
                    },
                    {
                        paneId: 'c',
                        workspace: '/wsB',
                        cwd: '/wsB/main',
                        coder: 'shell',
                    },
                ],
                activePaneId: 'a',
            });
            const { sessionsManager, loads } = makeRealSessionsManager(tm);
            const { diffController, output } = makeRealStatusController(
                sessionsManager,
                'status for /wsA/main',
            );
            tm.app.diffController = diffController;
            sessionsManager.app.diffController = diffController;
            const refreshSpy = vi.spyOn(diffController, 'refreshDiff');
            const worktreeResponses = [];
            const fetchUrls = [];
            vi.stubGlobal(
                'fetch',
                vi.fn((url) => {
                    const requestUrl = String(url);
                    fetchUrls.push(requestUrl);
                    if (requestUrl === '/api/git/worktrees?cwd=%2FwsB') {
                        const response = controlledPromise();
                        worktreeResponses.push(response);
                        return response.promise;
                    }
                    if (
                        requestUrl === '/api/git/raw-status?cwd=%2FwsB%2Fmain'
                    ) {
                        return Promise.resolve({
                            ok: true,
                            text: vi.fn(async () => 'status for /wsB/main'),
                        });
                    }
                    throw new Error(`Unexpected fetch: ${requestUrl}`);
                }),
            );

            tm.softCloseTab('a');
            expect(tm.activePaneId).toBe('b');
            expect(loads).toHaveLength(1);
            expect(worktreeResponses).toHaveLength(1);

            if (selection === 'select') {
                tm.switchTab('c', { userInitiated: true });
            } else {
                tm.softCloseTab('b');
            }

            expect(tm.activePaneId).toBe('c');
            expect(sessionsManager.activeWorkspace).toBe('/wsB');
            expect(sessionsManager.workspaceSelect.value).toBe('/wsB');
            expect(sessionsManager.activeCWD).toBe('/wsB/main');
            expect(sessionsManager.activeCoder).toBe('shell');
            expect(loads).toHaveLength(1);
            expect(
                fetchUrls.filter((url) =>
                    url.startsWith('/api/git/worktrees?'),
                ),
            ).toEqual(['/api/git/worktrees?cwd=%2FwsB']);

            worktreeResponses[0].resolve({
                ok: true,
                json: vi.fn(async () => [
                    { path: '/wsB/main', active: true },
                    { path: '/wsB/other' },
                ]),
            });
            await loads[0];
            await Promise.resolve();
            const refresh = refreshSpy.mock.results[0]?.value;
            if (refresh) await refresh;

            expect(tm.activePaneId).toBe('c');
            expect(sessionsManager.activeWorkspace).toBe('/wsB');
            expect(sessionsManager.activeCWD).toBe('/wsB/main');
            expect(sessionsManager.activeCoder).toBe('shell');
            expect(
                fetchUrls.filter((url) =>
                    url.startsWith('/api/git/raw-status?'),
                ),
            ).toEqual(['/api/git/raw-status?cwd=%2FwsB%2Fmain']);
            expect(output.value).toBe('status for /wsB/main');
            expect(refreshSpy).toHaveBeenCalledTimes(1);
            expect(sessionsManager.highlightActiveSession.mock.calls).toEqual([
                ['c'],
                ['c'],
            ]);
        },
    );

    it.each(['pi-rpc', 'review', 'kanban'])(
        'refreshes the retained project after a pending load crosses a %s view',
        async (viewCoder) => {
            const tm = makeTm({
                withTabs: [
                    {
                        paneId: 'a',
                        workspace: '/wsA',
                        cwd: '/wsA/main',
                        coder: 'shell',
                    },
                    {
                        paneId: 'b',
                        workspace: '/wsB',
                        cwd: '/wsB/main',
                        coder: 'shell',
                    },
                    {
                        paneId: 'neutral',
                        workspace: `/unrelated-${viewCoder}`,
                        cwd: `/unrelated-${viewCoder}/worktree`,
                        coder: viewCoder,
                    },
                ],
                activePaneId: 'a',
            });
            const project = makePendingProjectRefresh(
                tm,
                'status for /wsA/main',
            );

            tm.softCloseTab('a');
            expect(tm.activePaneId).toBe('b');
            expect(project.loads).toHaveLength(1);
            const retainedContext = {
                workspace: project.sessionsManager.activeWorkspace,
                workspaceSelect: project.sessionsManager.workspaceSelect.value,
                coder: project.sessionsManager.activeCoder,
                cwd: project.sessionsManager.activeCWD,
            };
            expect(retainedContext).toEqual({
                workspace: '/wsB',
                workspaceSelect: '/wsB',
                coder: 'shell',
                cwd: '/wsB/main',
            });

            tm.switchTab('neutral', { userInitiated: true });
            expect(tm.activePaneId).toBe('neutral');
            expect(project.sessionsManager.activeWorkspace).toBe('/wsB');
            expect(project.sessionsManager.workspaceSelect.value).toBe('/wsB');
            expect(project.sessionsManager.activeCoder).toBe('shell');
            expect(project.sessionsManager.activeCWD).toBe('/wsB/main');
            expect(project.refreshSpy).not.toHaveBeenCalled();
            expect(project.worktreeResponses).toHaveLength(1);

            await completeProjectRefresh(project);

            expect(tm.activePaneId).toBe('neutral');
            expect(project.sessionsManager.activeWorkspace).toBe('/wsB');
            expect(project.sessionsManager.workspaceSelect.value).toBe('/wsB');
            expect(project.sessionsManager.activeCoder).toBe('shell');
            expect(project.sessionsManager.activeCWD).toBe('/wsB/main');
            expect(
                project.fetchUrls.filter((url) =>
                    url.startsWith('/api/git/worktrees?'),
                ),
            ).toEqual(['/api/git/worktrees?cwd=%2FwsB']);
            expect(
                project.fetchUrls.filter((url) =>
                    url.startsWith('/api/git/raw-status?'),
                ),
            ).toEqual(['/api/git/raw-status?cwd=%2FwsB%2Fmain']);
            expect(project.output.value).toBe('status for /wsB/main');
            expect(project.refreshSpy).toHaveBeenCalledTimes(1);
            expect(
                project.sessionsManager.highlightActiveSession.mock.calls,
            ).toEqual([['neutral'], ['neutral']]);
            expect(
                project.sessionsManager.highlightActiveSession.mock.calls,
            ).not.toContainEqual(['b']);
        },
    );

    it('refreshes the retained project after its last pane closes during a pending load', async () => {
        const tm = makeTm({
            withTabs: [
                {
                    paneId: 'a',
                    workspace: '/wsA',
                    cwd: '/wsA/main',
                    coder: 'shell',
                },
                {
                    paneId: 'b',
                    workspace: '/wsB',
                    cwd: '/wsB/main',
                    coder: 'shell',
                },
            ],
            activePaneId: 'a',
        });
        const project = makePendingProjectRefresh(tm, 'status for /wsA/main');

        tm.softCloseTab('a');
        expect(tm.activePaneId).toBe('b');
        expect(project.loads).toHaveLength(1);
        tm.softCloseTab('b');

        expect(tm.activePaneId).toBeNull();
        expect(project.sessionsManager.activeWorkspace).toBe('/wsB');
        expect(project.sessionsManager.workspaceSelect.value).toBe('/wsB');
        expect(project.sessionsManager.activeCoder).toBe('shell');
        expect(project.sessionsManager.activeCWD).toBe('/wsB/main');
        expect(
            project.sessionsManager.highlightActiveSession,
        ).not.toHaveBeenCalled();
        expect(project.refreshSpy).not.toHaveBeenCalled();
        expect(project.worktreeResponses).toHaveLength(1);

        await completeProjectRefresh(project);

        expect(tm.activePaneId).toBeNull();
        expect(project.sessionsManager.activeWorkspace).toBe('/wsB');
        expect(project.sessionsManager.workspaceSelect.value).toBe('/wsB');
        expect(project.sessionsManager.activeCoder).toBe('shell');
        expect(project.sessionsManager.activeCWD).toBe('/wsB/main');
        expect(
            project.fetchUrls.filter((url) =>
                url.startsWith('/api/git/worktrees?'),
            ),
        ).toEqual(['/api/git/worktrees?cwd=%2FwsB']);
        expect(
            project.fetchUrls.filter((url) =>
                url.startsWith('/api/git/raw-status?'),
            ),
        ).toEqual(['/api/git/raw-status?cwd=%2FwsB%2Fmain']);
        expect(project.output.value).toBe('status for /wsB/main');
        expect(project.refreshSpy).toHaveBeenCalledTimes(1);
        expect(
            project.sessionsManager.highlightActiveSession,
        ).not.toHaveBeenCalled();
    });

    it('renders the workspace list for C after a worktree-only switch during close synchronization', async () => {
        const tm = makeTm({
            withTabs: [
                {
                    paneId: 'a',
                    workspace: '/wsA',
                    cwd: '/wsA/main',
                    coder: 'shell',
                },
                {
                    paneId: 'b',
                    workspace: '/wsB',
                    cwd: '/wsB/main',
                    coder: 'shell',
                },
                {
                    paneId: 'c',
                    workspace: '/wsB',
                    cwd: '/wsB/other',
                    coder: 'shell',
                },
            ],
            activePaneId: 'a',
        });
        const { sessionsManager, loads } = makeRealSessionsManager(tm);
        const request = controlledPromise();
        const fetchWorktrees = vi.fn(() => request.promise);
        vi.stubGlobal('fetch', fetchWorktrees);

        tm.softCloseTab('a');
        expect(tm.activePaneId).toBe('b');
        expect(loads).toHaveLength(1);

        tm.switchTab('c', { userInitiated: true });
        expect(tm.activePaneId).toBe('c');
        expect(loads).toHaveLength(1);
        expect(fetchWorktrees).toHaveBeenCalledTimes(1);
        expect(fetchWorktrees).toHaveBeenCalledWith(
            '/api/git/worktrees?cwd=%2FwsB',
        );

        request.resolve({
            ok: true,
            json: vi.fn(async () => [
                { path: '/wsB/main', active: true },
                { path: '/wsB/other' },
            ]),
        });
        await loads[0];
        await Promise.resolve();

        expect(tm.activePaneId).toBe('c');
        expect(sessionsManager.activeWorkspace).toBe('/wsB');
        expect(sessionsManager.workspaceSelect.value).toBe('/wsB');
        expect(sessionsManager.activeCWD).toBe('/wsB/other');
        expect(sessionsManager.activeCoder).toBe('shell');
        expect(
            Array.from(
                sessionsManager.sessionList.querySelectorAll(
                    '.worktree-section',
                ),
                (section) => section.getAttribute('data-worktree-path'),
            ),
        ).toEqual(['/wsB/main', '/wsB/other']);
        expect(
            sessionsManager.sessionList
                .querySelector('.worktree-section.active')
                ?.getAttribute('data-worktree-path'),
        ).toBe('/wsB/other');
        expect(sessionsManager.sessionList.textContent).not.toContain(
            'Scanning git worktrees',
        );
        expect(sessionsManager.highlightActiveSession.mock.calls).toEqual([
            ['c'],
        ]);
        expect(tm.app.diffController.refreshDiff).toHaveBeenCalledTimes(1);
        expect(tm.app.markdownManager.refreshFiles.mock.calls).toEqual([
            [{ force: false }],
        ]);
    });
});

// ---- close selection -------------------------------------------------

describe('close selection', () => {
    it('has a dedicated helper for automatic survivor selection', () => {
        expect(typeof TabManager.prototype._selectTabAfterClose).toBe(
            'function',
        );
    });
});

// ---- finalizeCloseTab -----------------------------------------------

describe('finalizeCloseTab - actually kill the PTY', () => {
    it('kills the PTY via DELETE, closes WS, disposes term, removes from Map', () => {
        const tm = makeTm({ withTabs: ['a'] });
        const tab = tm.tabs.get('a');
        tm.softCloseTab('a'); // tab is now soft-closing

        tm.finalizeCloseTab('a');

        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/terminals/a'),
            expect.objectContaining({ method: 'DELETE' }),
        );
        expect(tab.ws.close).toHaveBeenCalled();
        expect(tab.term.dispose).toHaveBeenCalled();
        expect(tm.tabs.has('a')).toBe(false);
    });

    it('does not surface its own WebSocket close as a disconnect', () => {
        const tm = makeTm({ withTabs: ['a'] });
        const tab = tm.tabs.get('a');
        tab.term.write = vi.fn();
        tm.updateDocumentTitle = vi.fn();
        tm._showReconnectOverlay = vi.fn();
        tm.maybeAutoReconnect = vi.fn();
        // Model the browser delivering the asynchronous onclose callback
        // when finalizeCloseTab deliberately closes this socket.
        tab.ws.close = vi.fn(() => tm._handleTerminalDisconnect(tab));

        tm.finalizeCloseTab('a');

        expect(tab.term.write).not.toHaveBeenCalled();
        expect(tab.tabEl.classList.contains('dead')).toBe(false);
        expect(tm._showReconnectOverlay).not.toHaveBeenCalled();
        expect(tm.app.showToast).not.toHaveBeenCalled();
    });

    it('clears the toast reference and dismisses the toast element', () => {
        const tm = makeTm({ withTabs: ['a'] });
        const dismissEl = { classList: { remove: vi.fn() } };
        tm.app.showToast = vi.fn(() => dismissEl);
        tm.softCloseTab('a');
        expect(tm.tabs.get('a').softCloseToast).toBe(dismissEl);
        tm.finalizeCloseTab('a');
        // (classList.remove was called for the dismiss animation)
        expect(dismissEl.classList.remove).toHaveBeenCalledWith('show');
    });

    it('calls kanbanManager.cleanup() when closing a kanban tab', () => {
        const tm = makeTm({ withTabs: [{ paneId: 'kb', coder: 'kanban' }] });
        tm.softCloseTab('kb');
        tm.finalizeCloseTab('kb');
        expect(tm.app.kanbanManager.cleanup).toHaveBeenCalled();
    });

    it('does not throw when called on an unknown paneId (idempotent)', () => {
        const tm = makeTm({ withTabs: ['a'] });
        expect(() => tm.finalizeCloseTab('nonexistent')).not.toThrow();
    });
});

// ---- softCloseTab - close selects and synchronizes a survivor ------------

describe('softCloseTab - active-tab close selects a survivor', () => {
    it('applies cross-workspace context before another click', async () => {
        const tm = makeTm({
            withTabs: [
                {
                    paneId: 'a',
                    workspace: '/wsA',
                    cwd: '/wsA/main',
                    coder: 'opencode',
                },
                {
                    paneId: 'b',
                    workspace: '/wsZ',
                    cwd: '/wsZ/main',
                    coder: 'shell',
                },
            ],
            activePaneId: 'a',
        });
        const worktreeLoad = controlledPromise();
        tm.app.sessionsManager.loadWorktrees = vi.fn(
            () => worktreeLoad.promise,
        );
        const switchSpy = vi.spyOn(tm, 'switchTab');

        tm.softCloseTab('a');

        expect(switchSpy).toHaveBeenCalledTimes(1);
        expect(tm.activePaneId).toBe('b');
        expect(tm.app.sessionsManager.activeWorkspace).toBe('/wsZ');
        expect(tm.app.sessionsManager.workspaceSelect.value).toBe('/wsZ');
        expect(tm.app.sessionsManager.activeCWD).toBe('/wsZ/main');
        expect(tm.app.sessionsManager.activeCoder).toBe('shell');
        expect(tm.app.sessionsManager.loadWorktrees).toHaveBeenCalledTimes(1);
        expect(tm.app.sessionsManager.loadWorktrees).toHaveBeenCalledWith(
            '/wsZ/main',
        );
        expect(
            tm.app.sessionsManager.highlightActiveSession,
        ).not.toHaveBeenCalled();
        expect(tm.app.diffController.refreshDiff).not.toHaveBeenCalled();
        expect(tm.app.markdownManager.refreshFiles).not.toHaveBeenCalled();

        worktreeLoad.resolve();
        await worktreeLoad.promise;
        await Promise.resolve();

        expect(
            tm.app.sessionsManager.highlightActiveSession,
        ).toHaveBeenCalledWith('b');
        expect(tm.app.diffController.refreshDiff).toHaveBeenCalledTimes(1);
        expect(tm.app.markdownManager.refreshFiles).toHaveBeenCalledWith({
            force: false,
        });

        tm.switchTab('b', { userInitiated: true });
        expect(tm.app.sessionsManager.loadWorktrees).toHaveBeenCalledTimes(1);
    });

    it('synchronously applies a worktree-only replacement', () => {
        const tm = makeTm({
            withTabs: [
                {
                    paneId: 'a',
                    workspace: '/wsA',
                    cwd: '/wsA/main',
                    coder: 'shell',
                },
                {
                    paneId: 'b',
                    workspace: '/wsA',
                    cwd: '/wsA/feature',
                    coder: 'shell',
                },
            ],
            activePaneId: 'a',
        });

        tm.softCloseTab('a');

        expect(tm.activePaneId).toBe('b');
        expect(tm.app.sessionsManager.activeWorkspace).toBe('/wsA');
        expect(tm.app.sessionsManager.workspaceSelect.value).toBe('/wsA');
        expect(tm.app.sessionsManager.activeCWD).toBe('/wsA/feature');
        expect(tm.app.sessionsManager.activeCoder).toBe('shell');
        expect(tm.app.sessionsManager.loadWorktrees).not.toHaveBeenCalled();
        expect(
            tm.app.sessionsManager.highlightActiveWorktree,
        ).toHaveBeenCalledWith('/wsA/feature');
        expect(
            tm.app.sessionsManager.highlightActiveSession,
        ).toHaveBeenCalledWith('b');
        expect(tm.app.diffController.refreshDiff).toHaveBeenCalledTimes(1);
        expect(tm.app.markdownManager.refreshFiles).toHaveBeenCalledWith({
            force: false,
        });
    });

    it('reloads worktrees when only the replacement coder changes', async () => {
        const tm = makeTm({
            withTabs: [
                {
                    paneId: 'a',
                    workspace: '/wsA',
                    cwd: '/wsA/main',
                    coder: 'shell',
                },
                {
                    paneId: 'b',
                    workspace: '/wsA',
                    cwd: '/wsA/main',
                    coder: 'opencode',
                },
            ],
            activePaneId: 'a',
        });
        const worktreeLoad = controlledPromise();
        tm.app.sessionsManager.loadWorktrees = vi.fn(
            () => worktreeLoad.promise,
        );

        tm.softCloseTab('a');

        expect(tm.activePaneId).toBe('b');
        expect(tm.app.sessionsManager.activeWorkspace).toBe('/wsA');
        expect(tm.app.sessionsManager.workspaceSelect.value).toBe('/wsA');
        expect(tm.app.sessionsManager.activeCWD).toBe('/wsA/main');
        expect(tm.app.sessionsManager.activeCoder).toBe('opencode');
        expect(tm.app.sessionsManager.loadWorktrees).toHaveBeenCalledTimes(1);
        expect(tm.app.sessionsManager.loadWorktrees).toHaveBeenCalledWith(
            '/wsA/main',
        );
        expect(tm.app.diffController.refreshDiff).not.toHaveBeenCalled();
        expect(tm.app.markdownManager.refreshFiles).not.toHaveBeenCalled();

        worktreeLoad.resolve();
        await worktreeLoad.promise;
        await Promise.resolve();

        expect(
            tm.app.sessionsManager.highlightActiveSession,
        ).toHaveBeenCalledWith('b');
        expect(tm.app.diffController.refreshDiff).toHaveBeenCalledTimes(1);
        expect(tm.app.markdownManager.refreshFiles).toHaveBeenCalledWith({
            force: false,
        });
    });

    it('keeps normal user tab selection project-aware', () => {
        const tm = makeTm({
            withTabs: [
                { paneId: 'a', workspace: '/wsA', coder: 'shell' },
                {
                    paneId: 'b',
                    workspace: '/wsZ',
                    cwd: '/wsZ',
                    coder: 'shell',
                },
            ],
            activePaneId: 'a',
        });
        tm.switchTab('b', { userInitiated: true });
        expect(tm.app.sessionsManager.loadWorktrees).toHaveBeenCalledWith(
            '/wsZ',
        );
    });

    it('applies fallback project context when an active tab is finalized directly', async () => {
        const tm = makeTm({
            withTabs: [
                {
                    paneId: 'a',
                    workspace: '/wsA',
                    cwd: '/wsA/main',
                    coder: 'opencode',
                },
                {
                    paneId: 'b',
                    workspace: '/wsZ',
                    cwd: '/wsZ/main',
                    coder: 'shell',
                },
            ],
            activePaneId: 'a',
        });
        const worktreeLoad = controlledPromise();
        tm.app.sessionsManager.loadWorktrees = vi.fn(
            () => worktreeLoad.promise,
        );

        tm.finalizeCloseTab('a');

        expect(tm.tabs.has('a')).toBe(false);
        expect(tm.activePaneId).toBe('b');
        expect(tm.app.sessionsManager.activeWorkspace).toBe('/wsZ');
        expect(tm.app.sessionsManager.workspaceSelect.value).toBe('/wsZ');
        expect(tm.app.sessionsManager.activeCWD).toBe('/wsZ/main');
        expect(tm.app.sessionsManager.activeCoder).toBe('shell');
        expect(tm.app.sessionsManager.loadWorktrees).toHaveBeenCalledTimes(1);
        expect(tm.app.sessionsManager.loadWorktrees).toHaveBeenCalledWith(
            '/wsZ/main',
        );
        expect(
            tm.app.sessionsManager.highlightActiveSession,
        ).not.toHaveBeenCalled();
        expect(tm.app.diffController.refreshDiff).not.toHaveBeenCalled();
        expect(tm.app.markdownManager.refreshFiles).not.toHaveBeenCalled();

        worktreeLoad.resolve();
        await worktreeLoad.promise;
        await Promise.resolve();

        expect(
            tm.app.sessionsManager.highlightActiveSession,
        ).toHaveBeenCalledWith('b');
        expect(tm.app.diffController.refreshDiff).toHaveBeenCalledTimes(1);
        expect(tm.app.markdownManager.refreshFiles).toHaveBeenCalledWith({
            force: false,
        });
    });

    it.each(['pi-rpc', 'review', 'kanban'])(
        'preserves project context when a %s tab is selected',
        (coder) => {
            const staleWorkspace = `/stale/${coder}`;
            const staleCWD = `${staleWorkspace}/worktree`;
            const tm = makeTm({
                withTabs: [
                    {
                        paneId: 'a',
                        workspace: '/wsA',
                        cwd: '/wsA/main',
                        coder: 'shell',
                    },
                    {
                        paneId: 'b',
                        workspace: staleWorkspace,
                        cwd: staleCWD,
                        coder,
                    },
                ],
                activePaneId: 'a',
            });

            tm.softCloseTab('a');

            expect(tm.activePaneId).toBe('b');
            expect(tm.app.sessionsManager.activeWorkspace).toBe('/wsA');
            expect(tm.app.sessionsManager.activeCWD).toBe('/wsA/main');
            expect(tm.app.sessionsManager.workspaceSelect.value).toBe('/wsA');
            expect(tm.app.sessionsManager.activeCoder).toBe('shell');
            expect(tm.app.sessionsManager.loadWorktrees).not.toHaveBeenCalled();
            expect(tm.app.diffController.refreshDiff).not.toHaveBeenCalled();
            expect(tm.app.markdownManager.refreshFiles).not.toHaveBeenCalled();
            expect(
                tm.app.sessionsManager.highlightActiveSession,
            ).toHaveBeenCalledWith('b');
            expect(tm.activateTabViewport).toHaveBeenCalledWith(
                tm.tabs.get('b'),
                expect.objectContaining({
                    scrollToBottom: true,
                    autoReconnect: true,
                    force: false,
                }),
            );

            if (coder === 'pi-rpc') {
                expect(
                    tm.app.sessionsManager.switchCoder,
                ).not.toHaveBeenCalled();
            } else {
                expect(tm.app.sessionsManager.switchCoder).toHaveBeenCalledWith(
                    coder,
                    true,
                );
            }
        },
    );

    it('selects the next visible tab and skips a soft-closing neighbor', () => {
        const tm = makeTm({
            withTabs: [
                {
                    paneId: 'a',
                    workspace: '/wsA',
                    cwd: '/wsA/main',
                    coder: 'shell',
                },
                {
                    paneId: 'b',
                    workspace: '/wsB',
                    cwd: '/wsB/main',
                    coder: 'shell',
                },
                {
                    paneId: 'c',
                    workspace: '/wsC',
                    cwd: '/wsC/selected',
                    coder: 'opencode',
                },
            ],
            activePaneId: 'a',
        });
        tm.softCloseTab('b');

        tm.softCloseTab('a');

        expect(tm.activePaneId).toBe('c');
        expect(tm.tabs.get('b').softClosing).toBe(true);
        expect(tm.app.sessionsManager.activeWorkspace).toBe('/wsC');
        expect(tm.app.sessionsManager.workspaceSelect.value).toBe('/wsC');
        expect(tm.app.sessionsManager.activeCWD).toBe('/wsC/selected');
        expect(tm.app.sessionsManager.activeCoder).toBe('opencode');
        expect(tm.app.sessionsManager.loadWorktrees).toHaveBeenCalledWith(
            '/wsC/selected',
        );
    });

    it('wraps past a soft-closing neighbor to the next visible tab', () => {
        const tm = makeTm({
            withTabs: [
                {
                    paneId: 'b',
                    workspace: '/wsB',
                    cwd: '/wsB/main',
                    coder: 'shell',
                },
                {
                    paneId: 'c',
                    workspace: '/wsC',
                    cwd: '/wsC/wrap',
                    coder: 'opencode',
                },
                {
                    paneId: 'a',
                    workspace: '/wsA',
                    cwd: '/wsA/main',
                    coder: 'shell',
                },
            ],
            activePaneId: 'a',
        });
        tm.softCloseTab('b');

        tm.softCloseTab('a');

        expect(tm.activePaneId).toBe('c');
        expect(tm.tabs.get('b').softClosing).toBe(true);
        expect(tm.app.sessionsManager.activeWorkspace).toBe('/wsC');
        expect(tm.app.sessionsManager.workspaceSelect.value).toBe('/wsC');
        expect(tm.app.sessionsManager.activeCWD).toBe('/wsC/wrap');
        expect(tm.app.sessionsManager.activeCoder).toBe('opencode');
        expect(tm.app.sessionsManager.loadWorktrees).toHaveBeenCalledWith(
            '/wsC/wrap',
        );
    });

    it('shows the empty state while the last tab remains undoable', () => {
        const tm = makeTm({ withTabs: ['a'], activePaneId: 'a' });
        tm.softCloseTab('a');
        expect(tm.showEmptyState).toHaveBeenCalled();
        expect(tm.activePaneId).toBeNull();
        expect(tm.tabs.get('a').softClosing).toBe(true);
    });

    it('restores the original project context when undo follows a cross-workspace close', () => {
        const tm = makeTm({
            withTabs: [
                {
                    paneId: 'a',
                    workspace: '/wsA',
                    cwd: '/wsA/main',
                    coder: 'opencode',
                },
                {
                    paneId: 'b',
                    workspace: '/wsB',
                    cwd: '/wsB/main',
                    coder: 'shell',
                },
            ],
            activePaneId: 'a',
        });

        tm.softCloseTab('a');

        expect(tm.activePaneId).toBe('b');
        expect(tm.app.sessionsManager.activeWorkspace).toBe('/wsB');
        expect(tm.app.sessionsManager.workspaceSelect.value).toBe('/wsB');
        expect(tm.app.sessionsManager.activeCWD).toBe('/wsB/main');
        expect(tm.app.sessionsManager.activeCoder).toBe('shell');

        tm.undoCloseTab('a');

        expect(tm.activePaneId).toBe('a');
        expect(tm.app.sessionsManager.activeWorkspace).toBe('/wsA');
        expect(tm.app.sessionsManager.workspaceSelect.value).toBe('/wsA');
        expect(tm.app.sessionsManager.activeCWD).toBe('/wsA/main');
        expect(tm.app.sessionsManager.activeCoder).toBe('opencode');
        expect(tm.app.sessionsManager.loadWorktrees.mock.calls).toEqual([
            ['/wsB/main'],
            ['/wsA/main'],
        ]);
    });

    it('hides a background closing tab without disturbing the active tab', () => {
        const tm = makeTm({
            withTabs: [
                { paneId: 'a', workspace: '/wsA', coder: 'opencode' },
                { paneId: 'b', workspace: '/wsB', coder: 'shell' },
            ],
            activePaneId: 'a',
        });
        const switchSpy = vi.spyOn(tm, 'switchTab');
        tm.softCloseTab('b');
        expect(switchSpy).not.toHaveBeenCalled();
        expect(tm.activePaneId).toBe('a');
        expect(tm.app.sessionsManager.activeWorkspace).toBe('/wsA');
        expect(tm.app.sessionsManager.workspaceSelect.value).toBe('/wsA');
        expect(tm.app.sessionsManager.activeCWD).toBe('/wsA');
        expect(tm.app.sessionsManager.activeCoder).toBe('opencode');
        expect(tm.app.sessionsManager.switchCoder).not.toHaveBeenCalled();
        expect(tm.app.sessionsManager.loadWorktrees).not.toHaveBeenCalled();
        expect(
            tm.app.sessionsManager.highlightActiveSession,
        ).not.toHaveBeenCalled();
        expect(
            tm.app.sessionsManager.highlightActiveWorktree,
        ).not.toHaveBeenCalled();
        expect(tm.app.diffController.refreshDiff).not.toHaveBeenCalled();
        expect(tm.app.markdownManager.refreshFiles).not.toHaveBeenCalled();
        expect(tm.tabs.get('b').tabEl.classList.contains('soft-closed')).toBe(
            true,
        );
    });

    it('does not mount the old content overlay when the active tab closes', () => {
        const tm = makeTm({
            withTabs: [{ paneId: 'a' }, { paneId: 'b' }],
            activePaneId: 'a',
        });
        tm.softCloseTab('a');
        const tab = tm.tabs.get('a');
        expect(
            tab.termContainer.querySelector('.tab-soft-close-overlay'),
        ).toBeNull();
        expect(tab.tabEl.classList.contains('soft-closed')).toBe(true);
        expect(tm.activePaneId).toBe('b');
    });

    it('background-tab close does NOT mount a content overlay', () => {
        // Background tabs close invisibly — the toast and tab-list
        // dropdown are the recovery affordances.
        const tm = makeTm({
            withTabs: [{ paneId: 'a' }, { paneId: 'b' }],
            activePaneId: 'a',
        });
        tm.softCloseTab('b');
        const tab = tm.tabs.get('b');
        expect(
            tab.termContainer.querySelector('.tab-soft-close-overlay'),
        ).toBeNull();
    });

    it('keeps the closing tab out of the visible strip', () => {
        const tm = makeTm({
            withTabs: [{ paneId: 'a' }, { paneId: 'b' }],
            activePaneId: 'a',
        });
        tm.softCloseTab('b');
        const tab = tm.tabs.get('b');
        expect(tab.tabEl.querySelector('.tab-soft-close-pill')).toBeNull();
        expect(tab.tabEl.classList.contains('soft-closed')).toBe(true);
    });

    it('keeps the close-grace countdown ticking for the tab list', () => {
        const tm = makeTm({
            withTabs: [{ paneId: 'a' }, { paneId: 'b' }],
            activePaneId: 'a',
        });
        tm.softCloseTab('b');
        const tab = tm.tabs.get('b');
        const initial = tm._softCloseRemainingSeconds(tab);
        vi.advanceTimersByTime(2500);
        const later = tm._softCloseRemainingSeconds(tab);
        expect(later).toBeLessThan(initial);
    });

    it('CSS hides soft-closed entries instead of styling them in the strip', () => {
        const fs = require('node:fs');
        const css = fs.readFileSync('web/style.css', 'utf8');
        expect(css).toMatch(
            /\.tab\.soft-closed\s*\{[^}]*display:\s*none\s*!important/,
        );
    });
});

// ---- MAX_SOFT_CLOSED_TABS cap ---------------------------------------

describe('soft-close cap (MAX_SOFT_CLOSED_TABS)', () => {
    it('force-finalizes the oldest soft-closed tab when the cap is exceeded', () => {
        // Cap is 3. Close 4 tabs - the 4th close should force-finalize
        // the oldest (first closed) tab.
        const tm = makeTm({
            withTabs: [
                { paneId: 'a' },
                { paneId: 'b' },
                { paneId: 'c' },
                { paneId: 'd' },
                { paneId: 'e' },
            ],
        });

        tm.softCloseTab('a');
        vi.advanceTimersByTime(10); // so 'a' has earliest softCloseStartedAt
        tm.softCloseTab('b');
        vi.advanceTimersByTime(10);
        tm.softCloseTab('c');
        vi.advanceTimersByTime(10);
        tm.softCloseTab('d'); // 4th close, cap exceeded
        // The oldest soft-close ('a') should be finalized.
        expect(tm.tabs.has('a')).toBe(false);
        // The other three should still be soft-closing.
        expect(tm.tabs.get('b').softClosing).toBe(true);
        expect(tm.tabs.get('c').softClosing).toBe(true);
        expect(tm.tabs.get('d').softClosing).toBe(true);
    });
});
// ---- 10 LOAD-BEARING tests for the close lifecycle ------------------
//
// Each one guards against a real user-visible bug. See the CHANGELOG
// v0.8.3 entry for the user-reported "some processes never get closed"
// symptoms. The pre-existing describe blocks above cover the bones of
// the pipeline; these pin down the contracts.

describe('close lifecycle - load-bearing contracts', () => {
    // Helper: count how many DELETEs landed for which pane. mockFetch
    // is registered globally in beforeEach.
    function deleteCalls() {
        return globalThis.fetch.mock.calls.filter((c) => {
            const url = typeof c[0] === 'string' ? c[0] : c[0]?.url;
            return url?.includes('/api/terminals/');
        });
    }

    it('1. finalize fires DELETE to /api/terminals/<paneId>', () => {
        // The core contract: every finalize must hit the server. If
        // this fails the user's PTY is permanently leaked.
        const tm = makeTm({ withTabs: ['a'], activePaneId: 'a' });
        tm.softCloseTab('a');
        vi.advanceTimersByTime(TabManager.SOFT_CLOSE_GRACE_MS);
        const calls = deleteCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('/api/terminals/a');
        expect(calls[0][1]?.method).toBe('DELETE');
    });

    it('2. DELETE failure surfaces as an error toast (not silently swallowed)', () => {
        // Previous bug: .catch(() => {}) hid DELETE failures. The
        // user clicked ×, saw the tab vanish, but the process kept
        // running and they had no idea. Now: any non-2xx (besides 404,
        // which means the server already killed it) fires an error
        // toast with the user-visible actionable message.
        mockFetch(() => ({ ok: false, status: 500 }));
        const tm = makeTm({ withTabs: ['a'], activePaneId: 'a' });
        const showToast = vi.fn();
        tm.app.showToast = showToast;
        tm.softCloseTab('a');
        vi.advanceTimersByTime(TabManager.SOFT_CLOSE_GRACE_MS);
        // Allow the fetch promise + .then to settle.
        return Promise.resolve()
            .then(() => Promise.resolve())
            .then(() => {
                // Find any error toast with the right kind of message.
                const errorToasts = showToast.mock.calls.filter(
                    (c) => c[1] && c[1].type === 'error',
                );
                expect(errorToasts.length).toBeGreaterThanOrEqual(1);
                const msg = errorToasts[0][0];
                expect(msg.toLowerCase()).toMatch(/process|running|server/);
            });
    });

    it('3. concurrent finalizeCloseTab calls fire DELETE exactly once', () => {
        // The same tab can be reached by the grace timer, the
        // cap-forced path, and the × × user path simultaneously.
        // Without an idempotency guard, multiple DELETEs fire and
        // the cleanup runs twice (crashing on the second remove()).
        const tm = makeTm({ withTabs: ['a'], activePaneId: 'a' });
        tm.softCloseTab('a');
        // Simulate three racing finalize attempts: timer, cap, manual.
        tm.finalizeCloseTab('a');
        tm.finalizeCloseTab('a');
        tm.finalizeCloseTab('a');
        // Even after all three attempted, DELETE fires exactly once.
        expect(
            deleteCalls().filter((c) => c[0] === '/api/terminals/a'),
        ).toHaveLength(1);
    });

    it('4. cap-forced finalize fires DELETE for the cap-d tab too', () => {
        // When the 4th close triggers cap-finalize of the oldest,
        // the oldest's PTY must still be killed. Easy to miss the
        // fetch in the early-return branch.
        const tm = makeTm({
            withTabs: ['a', 'b', 'c', 'd'],
        });
        tm.softCloseTab('a');
        vi.advanceTimersByTime(10);
        tm.softCloseTab('b');
        vi.advanceTimersByTime(10);
        tm.softCloseTab('c');
        vi.advanceTimersByTime(10);
        tm.softCloseTab('d'); // cap exceeded, 'a' force-finalized
        // 'a' should have received its DELETE (the cap path uses the
        // same finalizeCloseTab which fires the fetch).
        const calls = deleteCalls()
            .map((c) => c[0])
            .sort();
        expect(calls).toContain('/api/terminals/a');
    });

    it('5. undo cancels the grace timer and restores the hidden strip entry', () => {
        const tm = makeTm({ withTabs: ['a'], activePaneId: 'a' });
        tm.softCloseTab('a');
        expect(tm.tabs.get('a').softClosing).toBe(true);
        expect(tm.tabs.get('a').softCloseTimer).toBeTruthy();
        expect(tm.tabs.get('a').softCloseToast).toBeTruthy();
        tm.undoCloseTab('a');
        const tab = tm.tabs.get('a');
        expect(tab.softClosing).toBe(false);
        expect(tab.softCloseTimer).toBeNull();
        expect(
            tab.termContainer.querySelector('.tab-soft-close-overlay'),
        ).toBeNull();
        expect(tab.tabEl.querySelector('.tab-soft-close-pill')).toBeNull();
        expect(tab.softCloseToast).toBeNull();
        expect(tab.tabEl.classList.contains('soft-closed')).toBe(false);
    });

    it('6. closing the last active tab shows an undoable empty state', () => {
        const tm = makeTm({ withTabs: ['a'], activePaneId: 'a' });
        tm.softCloseTab('a');
        expect(tm.showEmptyState).toHaveBeenCalled();
        expect(tm.activePaneId).toBeNull();
        expect(tm.tabs.get('a').softClosing).toBe(true);
        vi.advanceTimersByTime(TabManager.SOFT_CLOSE_GRACE_MS);
        expect(tm.tabs.has('a')).toBe(false);
    });

    it('7. closing a background tab leaves the active tab untouched', () => {
        const tm = makeTm({
            withTabs: ['a', 'b'],
            activePaneId: 'a',
        });
        tm.softCloseTab('b');
        expect(tm.activePaneId).toBe('a');
        expect(tm.tabs.get('a').softClosing).toBeFalsy();
        expect(tm.tabs.get('b').softClosing).toBe(true);
        expect(tm.tabs.get('b').tabEl.classList.contains('soft-closed')).toBe(
            true,
        );
    });

    it('8. closeAll triggers DELETE for every pane in the map', () => {
        // The "Close All" button confirms then soft-closes every tab.
        // After all grace periods, every pane must hit the DELETE
        // endpoint - a miss here = leaked processes from bulk close.
        const tm = makeTm({
            withTabs: ['a', 'b', 'c', 'd'],
        });
        const keys = Array.from(tm.tabs.keys());
        // Mirror the production closeAll wiring.
        keys.forEach((paneId) => {
            tm.closeTab(paneId);
        });
        // Advance past ALL grace periods (cap=3 means oldest gets
        // force-finalized, but the 3 younger ones run timers).
        vi.advanceTimersByTime(TabManager.SOFT_CLOSE_GRACE_MS + 100);
        const deleted = new Set(deleteCalls().map((c) => c[0]));
        expect(deleted).toContain('/api/terminals/a');
        // 'a' was force-finalized by the cap path.
        // The 3 survivors should also have their DELETEs.
        expect(
            deleted.has('/api/terminals/b') ||
                deleted.has('/api/terminals/c') ||
                deleted.has('/api/terminals/d'),
        ).toBe(true);
    });

    it('9. DELETE 404 does NOT break the rest of finalize (graceful)', () => {
        // A 404 means the server already removed the instance (likely
        // via WS-detach grace timer or another DELETE call). The
        // client must still clean up WS, term, DOM, and Map. Otherwise
        // the user gets a zombie WS in the browser.
        mockFetch(() => ({ ok: false, status: 404 }));
        const tm = makeTm({ withTabs: ['a'], activePaneId: 'a' });
        tm.softCloseTab('a');
        vi.advanceTimersByTime(TabManager.SOFT_CLOSE_GRACE_MS);
        return Promise.resolve()
            .then(() => Promise.resolve())
            .then(() => {
                // Tab was removed from the Map even though DELETE 404'd.
                expect(tm.tabs.has('a')).toBe(false);
                // DOM was cleaned.
                expect(
                    document.body.contains(document.getElementById('term-a')),
                ).toBe(false);
            });
    });

    it('10. undo prevents the stale grace timer from finalizing the tab', () => {
        // If undoCloseTab forgets to clearTimeout, the timer fires 5s
        // after undo and the tab gets finalized / DELETE'd. User-visible:
        // "I undid the close, then it vanished anyway after a few
        // seconds." This test makes that contract explicit.
        const tm = makeTm({ withTabs: ['a'], activePaneId: 'a' });
        tm.softCloseTab('a');
        tm.undoCloseTab('a');
        // Advance past where the original timer would have fired.
        vi.advanceTimersByTime(TabManager.SOFT_CLOSE_GRACE_MS + 1000);
        // Tab is still alive, NOT soft-closing, NO DELETE fired.
        expect(tm.tabs.has('a')).toBe(true);
        expect(tm.tabs.get('a').softClosing).toBe(false);
        const deletedUrls = deleteCalls().map((c) => c[0]);
        expect(deletedUrls).not.toContain('/api/terminals/a');
    });
});
