// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import { KanbanManager } from '../web/kanban.js';

// Regression net for the kanban <-> terminal tab interactions:
//   - BUG-1 (P0): switching back to a kanban tab must NOT clobber the sidebar's
//     workspace/CWD with the kanban tab's stale snapshot from when it opened.
//   - BUG-2 (P0): reloading the page with the kanban tab open must restore it.
//   - BUG-3 (P1): closing the kanban tab must tear down its listeners/overlays
//     and clear the phi_kanban_open marker.
//   - BUG-4 (P1): the kanban container must re-init if it ever becomes empty.

setupDomHarness();

// Minimal fixtures: sessionsManager + diffController + markdownManager + a few
// DOM nodes the tab manager needs. Never `new` TabManager or KanbanManager —
// we exercise individual methods against a hand-built ctx.
function fixtures({
    currentWorkspace = '/wsA',
    currentCwd = '/wsA/work',
} = {}) {
    const sessionsManager = {
        activeWorkspace: currentWorkspace,
        activeCWD: currentCwd,
        activeCoder: 'opencode',
        config: {},
        switchCoder: vi.fn(),
        loadWorktrees: vi.fn(async () => {}),
        highlightActiveSession: vi.fn(),
        highlightActiveWorktree: vi.fn(),
        updateWorkspaceSelectWidth: vi.fn(),
        workspaceSelect: { value: '' },
        spawnNewSession: vi.fn(async () => {}),
    };
    const diffController = { refreshDiff: vi.fn() };
    const markdownManager = { refreshFiles: vi.fn() };
    return { sessionsManager, diffController, markdownManager };
}

function makeApp(fx) {
    // DOM nodes TabManager's ctor / createTab touches
    if (!document.getElementById('tabs-container')) {
        const tabs = document.createElement('div');
        tabs.id = 'tabs-container';
        document.body.appendChild(tabs);
    }
    if (!document.getElementById('terminals-wrapper')) {
        const w = document.createElement('div');
        w.id = 'terminals-wrapper';
        document.body.appendChild(w);
    }
    if (!document.getElementById('input-bar-container')) {
        const i = document.createElement('div');
        i.id = 'input-bar-container';
        document.body.appendChild(i);
    }
    if (!document.getElementById('presets-container')) {
        const p = document.createElement('div');
        p.id = 'presets-container';
        document.body.appendChild(p);
    }
    if (!document.getElementById('empty-state')) {
        const e = document.createElement('div');
        e.id = 'empty-state';
        document.body.appendChild(e);
    }
    // TabManager reads these in setupEventListeners via constructors etc.
    return {
        sessionsManager: fx.sessionsManager,
        diffController: fx.diffController,
        markdownManager: fx.markdownManager,
        kanbanManager: Object.create(KanbanManager.prototype),
        hostname: 'test',
    };
}

// jsdom elements don't implement scrollIntoView; stub it on every test's tabEls
HTMLElement.prototype.scrollIntoView = () => {};

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    // Soft-close uses setTimeout(SOFT_CLOSE_GRACE_MS=3000). Tests that
    // exercise the finalize path advance the fake clock; tests that
    // exercise the undo path clear it.
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

// -- BUG-1 ----------------------------------------------------------------
describe('BUG-1: switching to kanban must NOT touch sidebar workspace/CWD', () => {
    it('does not call loadWorktrees or change activeWorkspace when returning to kanban', async () => {
        const fx = fixtures({
            currentWorkspace: '/wsB',
            currentCwd: '/wsB/work',
        });
        const app = makeApp(fx);

        // Build a kanban tab (paneId 'kanban-board') that was opened with
        // workspace/cwd from when it was first created — these are STALE
        // relative to the user's current terminal context.
        const ctx = Object.create(TabManager.prototype);
        Object.assign(ctx, {
            app,
            tabs: new Map(),
            activePaneId: null,
            inputBarContainer: document.getElementById('input-bar-container'),
            presetsContainer: document.getElementById('presets-container'),
            saveTabsState: vi.fn(),
            activateTabViewport: vi.fn(),
            updateDirectModeUI: vi.fn(),
            _spamScrollToBottom: vi.fn(),
        });
        // Simulate a terminal tab currently active in workspace B
        ctx.tabs.set('term-b', {
            paneId: 'term-b',
            sessionId: 'term-b',
            title: 't1',
            coder: 'opencode',
            workspace: '/wsB',
            cwd: '/wsB/work',
            tabEl: document.createElement('div'),
            termContainer: document.createElement('div'),
            isDead: false,
            term: null,
            ws: null,
        });
        // Now user opens kanban — its tab has the OLD workspace/cwd
        ctx.tabs.set('kanban-board', {
            paneId: 'kanban-board',
            sessionId: 'kanban-board',
            title: 'Kanban',
            coder: 'kanban',
            workspace: '/wsA',
            cwd: '/wsA/work', // STALE snapshot
            tabEl: document.createElement('div'),
            termContainer: document.createElement('div'),
            isDead: true,
            isKanban: true,
        });
        ctx.activePaneId = 'term-b';

        // User clicks the kanban tab
        await ctx.switchTab('kanban-board');

        // The sidebar must NOT have been clobbered back to wsA
        expect(fx.sessionsManager.activeWorkspace).toBe('/wsB');
        expect(fx.sessionsManager.activeCWD).toBe('/wsB/work');
        // loadWorktrees must NOT have been called (the old bug)
        expect(fx.sessionsManager.loadWorktrees).not.toHaveBeenCalled();
        // highlightActiveSession still called (it's the benign session highlight)
        expect(fx.sessionsManager.highlightActiveSession).toHaveBeenCalled();
    });

    it('also short-circuits for review tabs (same class of bug)', async () => {
        const fx = fixtures({
            currentWorkspace: '/wsB',
            currentCwd: '/wsB/work',
        });
        const app = makeApp(fx);
        const ctx = Object.create(TabManager.prototype);
        Object.assign(ctx, {
            app,
            tabs: new Map(),
            activePaneId: null,
            inputBarContainer: document.getElementById('input-bar-container'),
            presetsContainer: document.getElementById('presets-container'),
            saveTabsState: vi.fn(),
            activateTabViewport: vi.fn(),
            updateDirectModeUI: vi.fn(),
            _spamScrollToBottom: vi.fn(),
        });
        ctx.tabs.set('term-b', {
            paneId: 'term-b',
            sessionId: 'term-b',
            title: 't1',
            coder: 'opencode',
            workspace: '/wsB',
            cwd: '/wsB/work',
            tabEl: document.createElement('div'),
            termContainer: document.createElement('div'),
            isDead: false,
            term: null,
            ws: null,
        });
        ctx.tabs.set('review', {
            paneId: 'review',
            sessionId: 'review',
            title: 'Review',
            coder: 'review',
            workspace: '/wsA',
            cwd: '/wsA/work',
            tabEl: document.createElement('div'),
            termContainer: document.createElement('div'),
            isDead: true,
            isReview: true,
        });
        ctx.activePaneId = 'term-b';

        await ctx.switchTab('review');
        expect(fx.sessionsManager.activeWorkspace).toBe('/wsB');
        expect(fx.sessionsManager.loadWorktrees).not.toHaveBeenCalled();
    });
});

// -- BUG-3 ----------------------------------------------------------------
describe('BUG-3: closing the kanban tab cleans up listeners + marker', () => {
    // Soft-close: with the grace period in place, closeTab() now does the
    // kanban cleanup only when the tab FINALIZES (after 3s) - not on the
    // initial soft-close. So this test calls closeTab + advances the
    // timers past the grace to exercise the finalize path.
    it('calls kanbanManager.cleanup() and removes phi_kanban_open (after grace)', async () => {
        const fx = fixtures();
        const app = makeApp(fx);
        let cleaned = false;
        app.kanbanManager.cleanup = vi.fn(() => {
            cleaned = true;
            localStorage.removeItem('phi_kanban_open');
        });
        localStorage.setItem('phi_kanban_open', '1');

        const ctx = Object.create(TabManager.prototype);
        Object.assign(ctx, {
            app,
            tabs: new Map(),
            activePaneId: null,
            inputBarContainer: document.getElementById('input-bar-container'),
            presetsContainer: document.getElementById('presets-container'),
            tabsContainer: document.getElementById('tabs-container'),
            terminalsWrapper: document.getElementById('terminals-wrapper'),
            saveTabsState: vi.fn(),
            switchTab: vi.fn(),
            showEmptyState: vi.fn(),
            hideEmptyState: vi.fn(),
        });
        const tabEl = document.createElement('div');
        const termContainer = document.createElement('div');
        ctx.tabs.set('kanban-board', {
            paneId: 'kanban-board',
            coder: 'kanban',
            isKanban: true,
            isDead: true,
            tabEl,
            termContainer,
        });
        ctx.activePaneId = 'kanban-board';

        await ctx.closeTab('kanban-board');
        // closeTab is now soft-close: cleanup happens when the grace
        // timer fires (finalizeCloseTab). Advance fake timers past the
        // 3s grace to drive the finalize path.
        await vi.advanceTimersByTimeAsync(TabManager.SOFT_CLOSE_GRACE_MS);
        expect(app.kanbanManager.cleanup).toHaveBeenCalled();
        expect(cleaned).toBe(true);
        expect(localStorage.getItem('phi_kanban_open')).toBeNull();
        expect(ctx.tabs.has('kanban-board')).toBe(false);
    });

    it('kanbanManager.cleanup() removes the ESC listener and any open overlays', () => {
        const fx = fixtures();
        const _app = makeApp(fx);
        const km = Object.create(KanbanManager.prototype);
        const escHandler = vi.fn();
        km.escListener = escHandler;
        const overlay = document.createElement('div');
        document.body.appendChild(overlay);
        km.activeOverlay = overlay;
        const panel = document.createElement('div');
        document.body.appendChild(panel);
        km.activeDetailPanel = panel;

        const removeSpy = vi.spyOn(document, 'removeEventListener');
        km.cleanup();

        expect(removeSpy).toHaveBeenCalledWith('keydown', escHandler);
        expect(km.escListener).toBeNull();
        expect(km.activeOverlay).toBeNull();
        expect(km.activeDetailPanel).toBeNull();
        expect(document.body.contains(overlay)).toBe(false);
        expect(document.body.contains(panel)).toBe(false);
    });
});

// -- BUG-4 ----------------------------------------------------------------
describe('BUG-4: openBoard re-initializes an empty kanban container', () => {
    it('re-inits the container if the tab exists but has no children', async () => {
        const fx = fixtures();
        const app = makeApp(fx);

        // Stub out the heavy bits of initTabContainer
        const km = Object.create(KanbanManager.prototype);
        km.app = app;
        km.activeDetailPanel = null;
        km.activeOverlay = null;
        km.escListener = null;
        km.taskCache = {};
        km._dragActive = false;
        km.initTabContainer = vi.fn();
        km.openBoard = KanbanManager.prototype.openBoard;

        // Pre-existing kanban tab but its container was wiped (e.g. hot reload)
        const tc = document.createElement('div');
        app.tabManager = {
            tabs: new Map([
                ['kanban-board', { termContainer: tc, isKanban: true }],
            ]),
            switchTab: vi.fn(),
        };

        await km.openBoard();

        expect(km.initTabContainer).toHaveBeenCalledWith(tc);
        expect(app.tabManager.switchTab).toHaveBeenCalledWith('kanban-board');
    });
});

// -- BUG-2 (partial coverage here; full restore flow is integration) ------
describe('BUG-2: phi_kanban_open is set on openBoard and cleared on cleanup', () => {
    it('sets the marker when opening the kanban tab', async () => {
        const fx = fixtures();
        const app = makeApp(fx);
        const km = Object.create(KanbanManager.prototype);
        km.app = app;
        km.activeDetailPanel = null;
        km.activeOverlay = null;
        km.escListener = null;
        km.taskCache = {};
        km._dragActive = false;
        km.initTabContainer = vi.fn();
        km.openBoard = KanbanManager.prototype.openBoard;

        const tc = document.createElement('div');
        app.tabManager = {
            tabs: new Map(),
            createTab: vi.fn(
                (paneId, _sessionId, _title, _coder, _ws, _cwd) => {
                    app.tabManager.tabs.set(paneId, { termContainer: tc });
                },
            ),
        };

        await km.openBoard();
        expect(localStorage.getItem('phi_kanban_open')).toBe('1');
    });
});

// -- BUG-5 ----------------------------------------------------------------
// First-click black screen: initTabContainer used to overwrite className
// with `term-container kanban-panel`, which wiped the `.active` class that
// createTab → switchTab had just added. .kanban-panel alone is
// `display:none`, so the kanban panel was invisible even though its
// content (loading wrapper / login form / board) rendered correctly.
// Clicking the kanban button or tab again hit switchTab's `activePaneId
// === paneId` early-return at terminal.js:~1640, which never re-added
// `.active` — so the black screen was permanent until hard-refresh.
//
// Regression net: the first-open path with the REAL initTabContainer (not
// stubbed) must leave .active on the termContainer.
describe('BUG-5: openBoard (real initTabContainer) preserves .active on first open', () => {
    function buildRealTabManager(app) {
        app.tabManager = Object.create(TabManager.prototype);
        Object.assign(app.tabManager, {
            app,
            tabs: new Map(),
            activePaneId: null,
            inputBarContainer: document.getElementById('input-bar-container'),
            presetsContainer: document.getElementById('presets-container'),
            tabsContainer: document.getElementById('tabs-container'),
            terminalsWrapper: document.getElementById('terminals-wrapper'),
            emptyState: document.getElementById('empty-state'),
            saveTabsState: vi.fn(),
            hideEmptyState: vi.fn(),
            updateTabOverflowChip: vi.fn(),
            updateSidebarLegend: vi.fn(),
            switchTab: TabManager.prototype.switchTab,
            createTab: TabManager.prototype.createTab,
        });
        app.tabManager.setupEventListeners = vi.fn();
    }

    it('first-open: termContainer has .active AND children (no black screen)', async () => {
        const fx = fixtures();
        const app = makeApp(fx);
        buildRealTabManager(app);
        const km = Object.create(KanbanManager.prototype);
        km.app = app;
        km.activeDetailPanel = null;
        km.activeOverlay = null;
        km.escListener = null;
        km.taskCache = {};
        km._dragActive = false;
        // Real methods — no stubs.
        km.openBoard = KanbanManager.prototype.openBoard;
        km.initTabContainer = KanbanManager.prototype.initTabContainer;

        sessionStorage.clear();
        localStorage.clear();
        global.fetch = vi.fn(async () => ({ ok: false }));

        await km.openBoard();

        const tab = app.tabManager.tabs.get('kanban-board');
        expect(tab).toBeDefined();
        const tc = tab.termContainer;
        expect(tc.classList.contains('kanban-panel')).toBe(true);
        expect(tc.classList.contains('active')).toBe(true);
        // Either loading wrapper, login form, or board — never empty.
        expect(tc.children.length).toBeGreaterThan(0);
    });

    it('second openBoard (existing-tab path) keeps .active after re-init', async () => {
        const fx = fixtures();
        const app = makeApp(fx);
        buildRealTabManager(app);
        const km = Object.create(KanbanManager.prototype);
        km.app = app;
        km.activeDetailPanel = null;
        km.activeOverlay = null;
        km.escListener = null;
        km.taskCache = {};
        km._dragActive = false;
        km.openBoard = KanbanManager.prototype.openBoard;
        km.initTabContainer = KanbanManager.prototype.initTabContainer;

        sessionStorage.clear();
        localStorage.clear();
        global.fetch = vi.fn(async () => ({ ok: false }));

        // First open
        await km.openBoard();
        const tc = app.tabManager.tabs.get('kanban-board').termContainer;
        expect(tc.classList.contains('active')).toBe(true);

        // Second click — BUG-4 path: openBoard sees existing tab, calls
        // initTabContainer again. The .active class must survive.
        await km.openBoard();
        expect(tc.classList.contains('kanban-panel')).toBe(true);
        expect(tc.classList.contains('active')).toBe(true);
        expect(tc.children.length).toBeGreaterThan(0);
    });

    it('clicking the kanban tab element does not lose .active', async () => {
        const fx = fixtures();
        const app = makeApp(fx);
        buildRealTabManager(app);
        const km = Object.create(KanbanManager.prototype);
        km.app = app;
        km.activeDetailPanel = null;
        km.activeOverlay = null;
        km.escListener = null;
        km.taskCache = {};
        km._dragActive = false;
        km.openBoard = KanbanManager.prototype.openBoard;
        km.initTabContainer = KanbanManager.prototype.initTabContainer;

        sessionStorage.clear();
        localStorage.clear();
        global.fetch = vi.fn(async () => ({ ok: false }));

        await km.openBoard();
        const tab = app.tabManager.tabs.get('kanban-board');
        const tc = tab.termContainer;
        // After first open, .active is present.
        expect(tc.classList.contains('active')).toBe(true);

        // Switch to a non-existent tab — no-op in this fixture (activePaneId
        // unchanged), so .active stays. The point of the test is the
        // already-active click path: when user clicks the active kanban tab,
        // switchTab's early-return must not strip .active.
        await app.tabManager.switchTab('kanban-board');
        expect(tc.classList.contains('active')).toBe(true);
    });
});
