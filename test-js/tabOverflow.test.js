// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Tab strip overflow affordances: tab-list arrow, workspace/worktree
// disclosures, closing-tab recovery rows, mouse-wheel horizontal scroll,
// edge auto-scroll during drag, and drop-into-whitespace for the far edge.
//
// Layout is faked via a customRect helper that returns predictable
// widths; jsdom doesn't do real layout, so we override
// getBoundingClientRect + scrollWidth/clientWidth per fixture.

setupDomHarness();

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollIntoView',
);
beforeEach(() => {
    if (!HTMLElement.prototype.scrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            value: vi.fn(),
        });
    }
});
afterEach(() => {
    if (!originalScrollIntoView) {
        delete HTMLElement.prototype.scrollIntoView;
    }
});

// Mount all the DOM nodes the new methods read via getElementById.
function mountChromeDom() {
    document.body.innerHTML = `
        <div id="tabs-container"></div>
        <button id="sort-tabs-btn" type="button"></button>
        <button
            id="tab-overflow-btn"
            class="tab-overflow-btn"
            type="button"
            aria-controls="tab-overflow-dropdown"
            aria-expanded="false"
        ></button>
        <div
            id="tab-overflow-dropdown"
            class="tab-overflow-dropdown hidden"
            role="group"
            aria-label="Open tabs"
            tabindex="-1"
        ></div>
        <div id="worktree-legend"></div>
    `;
}

function makeTabManager({ withTabs = [], width = 800 } = {}) {
    mountChromeDom();
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;
    tm.dragSourceId = null;
    tm.tabsContainer = document.getElementById('tabs-container');
    document.body.appendChild(tm.tabsContainer);
    // Layout: tabs each "150px" wide, container total clientWidth 800.
    // If total tab width > clientWidth, the strip is overflowing.
    tm._layoutWidth = width;
    tm._layoutTabWidth = 150;
    let cursor = 0;
    for (const id of withTabs) {
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.setAttribute('data-pane-id', id);
        tabEl.dataset.worktreeGlyph = id.startsWith('A:')
            ? '◆'
            : id.startsWith('B:')
              ? '◇'
              : id.startsWith('C:')
                ? '▣'
                : '★';
        // Capture layout values at iteration time. Without this, the
        // closure would resolve `cursor` at call time when the loop
        // has already advanced past this tab.
        const tabLeft = cursor;
        const tabRight = cursor + tm._layoutTabWidth;
        tabEl.getBoundingClientRect = vi.fn(() => ({
            left: tabLeft,
            right: tabRight,
            top: 0,
            bottom: 34,
            width: tm._layoutTabWidth,
            height: 34,
            x: tabLeft,
            y: 0,
            toJSON: () => ({}),
        }));
        cursor += tm._layoutTabWidth;
        tm.tabsContainer.appendChild(tabEl);
        tm.tabs.set(id, {
            paneId: id,
            title: id,
            coder: 'shell',
            cwd: id,
            faviconUrl: '',
            tabEl,
            termContainer: document.createElement('div'),
            isDead: false,
            isReview: false,
            isKanban: false,
            pinned: false,
            marked: false,
        });
    }
    // Container bounding rect: full bar at left=0.
    tm.tabsContainer.getBoundingClientRect = vi.fn(() => ({
        left: 0,
        right: tm._layoutWidth,
        top: 0,
        bottom: 42,
        width: tm._layoutWidth,
        height: 42,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    }));
    // scrollWidth = total width of all tabs.
    Object.defineProperty(tm.tabsContainer, 'scrollWidth', {
        configurable: true,
        get: () => withTabs.length * tm._layoutTabWidth,
    });
    Object.defineProperty(tm.tabsContainer, 'clientWidth', {
        configurable: true,
        get: () => tm._layoutWidth,
    });
    // Stub the worktree-label helper.
    tm.getProjectWorktreeLabel = vi.fn((cwd) =>
        cwd === 'A:tab1' ? 'A/tab1' : cwd,
    );
    return tm;
}

function setTabIdentity(
    tm,
    paneId,
    { workspace, cwd = '', title = paneId, glyph } = {},
) {
    const tab = tm.tabs.get(paneId);
    if (workspace === undefined) delete tab.workspace;
    else tab.workspace = workspace;
    tab.cwd = cwd;
    tab.title = title;
    if (glyph) tab.tabEl.dataset.worktreeGlyph = glyph;
    return tab;
}

function makePopupLifecycleManager({
    withTabs = [],
    activePaneId = null,
} = {}) {
    const tm = makeTabManager({ withTabs });
    tm.activePaneId = activePaneId;
    tm.terminalsWrapper = document.createElement('div');
    tm.terminalsWrapper.id = 'terminals-wrapper';
    document.body.appendChild(tm.terminalsWrapper);
    tm.inputBarContainer = document.createElement('div');
    tm.inputTextArea = document.createElement('textarea');
    tm.presetsContainer = document.createElement('div');
    document.body.append(
        tm.inputBarContainer,
        tm.inputTextArea,
        tm.presetsContainer,
    );
    tm.stagedAttachments = [];
    tm._closePiRpcDropups = vi.fn();
    tm._setPiRpcActionVisibility = vi.fn();
    tm.renderPiRpcStatusBar = vi.fn();
    tm._syncProjectForTab = vi.fn(() => true);
    tm.activateTabViewport = vi.fn();
    tm.saveTabsState = vi.fn();
    tm.saveTabDraft = vi.fn();
    tm._renderAttachmentStrip = vi.fn();
    tm.adjustInputHeight = vi.fn();
    tm.updateDirectModeUI = vi.fn();
    tm.updateDocumentTitle = vi.fn();
    tm.updateDisconnectBanner = vi.fn();
    tm._cancelHistoryRequest = vi.fn();
    tm.hideEmptyState = vi.fn();
    tm.showEmptyState = vi.fn();
    tm.loadTabDraft = vi.fn(() => null);
    tm.app = {
        showToast: vi.fn(() => document.createElement('div')),
    };
    return tm;
}

function setupEventListenersWithCleanup(tm) {
    const listeners = [];
    const spies = [];
    for (const target of [document, window]) {
        const originalAdd = target.addEventListener.bind(target);
        spies.push(
            vi
                .spyOn(target, 'addEventListener')
                .mockImplementation((type, listener, options) => {
                    listeners.push({ target, type, listener, options });
                    return originalAdd(type, listener, options);
                }),
        );
    }
    try {
        tm.setupEventListeners();
    } catch (error) {
        for (const { target, type, listener, options } of listeners) {
            target.removeEventListener(type, listener, options);
        }
        for (const spy of spies) spy.mockRestore();
        throw error;
    }
    return () => {
        for (const { target, type, listener, options } of listeners) {
            target.removeEventListener(type, listener, options);
        }
        for (const spy of spies) spy.mockRestore();
    };
}

function makePartialListenerManager() {
    mountChromeDom();
    const controls = document.createElement('div');
    const inputTextArea = document.createElement('textarea');
    inputTextArea.id = 'input-textarea';
    const inputBarContainer = document.createElement('div');
    inputBarContainer.id = 'input-bar-container';
    const sendInputBtn = document.createElement('button');
    sendInputBtn.id = 'send-input-btn';
    const directModeToggle = document.createElement('button');
    directModeToggle.id = 'direct-mode-toggle';
    controls.append(
        inputTextArea,
        inputBarContainer,
        sendInputBtn,
        directModeToggle,
    );
    document.body.appendChild(controls);
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map([
        ['bash', { paneId: 'bash', coder: 'bash', isDead: false }],
    ]);
    tm.tabsContainer = document.getElementById('tabs-container');
    tm.activePaneId = 'bash';
    tm.inputTextArea = inputTextArea;
    tm.inputBarContainer = inputBarContainer;
    tm.sendInputBtn = sendInputBtn;
    tm.directModeToggle = directModeToggle;
    tm.app = {};
    tm.sendToTab = vi.fn();
    tm.handleGlobalTabShortcuts = vi.fn();
    tm._handlePiRpcEscape = vi.fn();
    tm._handlePiRpcKeydown = vi.fn();
    tm.updateTabShortcutHints = vi.fn();
    tm._initHieroPreview = vi.fn();
    tm._setupContainerDragHandlers = vi.fn();
    tm._initAttachmentDropZone = vi.fn();
    tm._initAttachmentPasteHandler = vi.fn();
    tm._initPromptHistoryKeydown = vi.fn();
    tm._initBrandHud = vi.fn();
    tm.saveActiveDraft = vi.fn();
    tm.adjustInputHeight = vi.fn();
    tm.handleWindowResize = vi.fn();
    tm.getProjectWorktreeLabel = vi.fn((cwd) => cwd);
    return tm;
}

// ---- Tab-list selector: presence + status --------------------------

describe('updateTabOverflow', () => {
    it('keeps the selector visible when there are zero tabs', () => {
        const tm = makeTabManager({ withTabs: [], width: 1200 });
        tm.updateTabOverflow();
        const btn = document.getElementById('tab-overflow-btn');
        expect(btn.classList.contains('hidden')).toBe(false);
        expect(btn.title).toBe('Show tab list');
    });

    it('keeps the selector visible when tabs fit in the visible area', () => {
        const tm = makeTabManager({
            withTabs: ['t1', 't2', 't3'],
            width: 1200,
        });
        tm.updateTabOverflow();
        const btn = document.getElementById('tab-overflow-btn');
        expect(btn.classList.contains('hidden')).toBe(false);
        expect(btn.title).toBe('Show tab list');
    });

    it('keeps the open dropdown after a resize makes tabs fit', () => {
        const tm = makeTabManager({
            withTabs: ['t1', 't2', 't3', 't4', 't5', 't6'],
            width: 600,
        });
        const dropdown = document.getElementById('tab-overflow-dropdown');
        dropdown.classList.remove('hidden');
        document
            .getElementById('tab-overflow-btn')
            .setAttribute('aria-expanded', 'true');
        tm._layoutWidth = 1200;

        tm.updateTabOverflow();

        expect(dropdown.classList.contains('hidden')).toBe(false);
        expect(
            document
                .getElementById('tab-overflow-btn')
                .classList.contains('hidden'),
        ).toBe(false);
        expect(
            document
                .getElementById('tab-overflow-btn')
                .getAttribute('aria-expanded'),
        ).toBe('true');
    });

    it('shows the selector when tabs overflow', () => {
        // 8 tabs × 150 = 1200, clientWidth=800 -> overflow.
        const tm = makeTabManager({
            withTabs: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
            width: 800,
        });
        tm.updateTabOverflow();
        const btn = document.getElementById('tab-overflow-btn');
        expect(btn.classList.contains('hidden')).toBe(false);
    });

    it('selector title counts how many tabs are past the right edge', () => {
        // 8 tabs at 150 each = 1200, clientWidth 800. Tabs t1..t5 are
        // visible (0..750). Tabs t6,t7,t8 are at 750..1200 (past 800).
        // So 3 hidden tabs.
        const tm = makeTabManager({
            withTabs: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
            width: 800,
        });
        tm.updateTabOverflow();
        const btn = document.getElementById('tab-overflow-btn');
        expect(btn.title).toContain('3 more tabs');
    });

    it('shows the selector when a tab is in the close grace period', () => {
        const tm = makeTabManager({ withTabs: ['a'], width: 1200 });
        tm.tabs.get('a').softClosing = true;
        tm.tabs.get('a').tabEl.classList.add('soft-closed');
        tm.updateTabOverflow();
        const btn = document.getElementById('tab-overflow-btn');
        expect(btn.classList.contains('hidden')).toBe(false);
        expect(btn.title).toContain('1 closing tab');
    });
});

describe('production sort control and coarse-pointer fallback', () => {
    it('binds the sort control and keeps an open dropdown available', () => {
        const tm = makePartialListenerManager();
        tm.tabs.clear();
        tm.activePaneId = 'b';
        for (const [paneId, workspace] of [
            ['b', '/repo/Beta'],
            ['a', '/repo/alpha'],
        ]) {
            const tabEl = document.createElement('div');
            tabEl.className = 'tab';
            tabEl.dataset.paneId = paneId;
            tm.tabsContainer.appendChild(tabEl);
            tm.tabs.set(paneId, {
                paneId,
                workspace,
                cwd: workspace,
                title: paneId,
                coder: 'bash',
                tabEl,
                termContainer: document.createElement('div'),
            });
        }
        const dropdown = document.getElementById('tab-overflow-dropdown');
        dropdown.classList.remove('hidden');
        const applySpy = vi.spyOn(tm, 'applyTabOrder');
        const statusSpy = vi.spyOn(tm, 'updateTabOverflow');
        const popupSpy = vi.spyOn(tm, '_refreshOverflowDropdown');
        const cleanup = setupEventListenersWithCleanup(tm);
        try {
            document
                .getElementById('sort-tabs-btn')
                .dispatchEvent(new MouseEvent('click', { bubbles: true }));
            expect(Array.from(tm.tabs.keys())).toEqual(['a', 'b']);
            expect(applySpy).toHaveBeenCalledTimes(1);
            expect(statusSpy).toHaveBeenCalledTimes(1);
            expect(popupSpy).toHaveBeenCalledTimes(1);
            expect(dropdown.classList.contains('hidden')).toBe(false);
            expect(
                Array.from(
                    dropdown.querySelectorAll('.hostname-dropdown-row'),
                ).map((row) => row.dataset.paneId),
            ).toEqual(['a', 'b']);
        } finally {
            cleanup();
        }
    });

    it('does not forward navigator keys on coarse pointers, but forwards normal targets', () => {
        const tm = makePartialListenerManager();
        const originalMatchMedia = window.matchMedia;
        window.matchMedia = vi.fn(() => ({ matches: true }));
        const dropdown = document.getElementById('tab-overflow-dropdown');
        const popupButton = document.createElement('button');
        dropdown.appendChild(popupButton);
        const controls = [
            popupButton,
            document.getElementById('tab-overflow-btn'),
            document.getElementById('sort-tabs-btn'),
        ];
        const cleanup = setupEventListenersWithCleanup(tm);
        try {
            for (const control of controls) {
                for (const [key, shiftKey] of [
                    ['Enter', false],
                    ['Tab', false],
                    ['Tab', true],
                ]) {
                    const event = new KeyboardEvent('keydown', {
                        key,
                        shiftKey,
                        bubbles: true,
                        cancelable: true,
                    });
                    control.dispatchEvent(event);
                    expect(event.defaultPrevented).toBe(false);
                }
            }
            expect(tm.sendToTab).not.toHaveBeenCalled();

            const ordinaryEvent = new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            });
            document.body.dispatchEvent(ordinaryEvent);
            expect(ordinaryEvent.defaultPrevented).toBe(true);
            expect(tm.sendToTab).toHaveBeenCalledOnce();
            expect(tm.sendToTab).toHaveBeenCalledWith(
                tm.tabs.get('bash'),
                '\r',
            );
        } finally {
            cleanup();
            if (originalMatchMedia === undefined) delete window.matchMedia;
            else window.matchMedia = originalMatchMedia;
        }
    });

    it('Escape closes from popup or trigger, restores trigger focus, and stops before Pi handling', () => {
        const tm = makePartialListenerManager();
        const cleanup = setupEventListenersWithCleanup(tm);
        const trigger = document.getElementById('tab-overflow-btn');
        const dropdown = document.getElementById('tab-overflow-dropdown');
        try {
            tm._toggleOverflowDropdown();
            const leaf = dropdown.querySelector(
                '.hostname-dropdown-select-btn',
            );
            leaf.focus();
            const popupEscape = new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            });
            leaf.dispatchEvent(popupEscape);
            expect(popupEscape.defaultPrevented).toBe(true);
            expect(dropdown.classList.contains('hidden')).toBe(true);
            expect(document.activeElement).toBe(trigger);
            expect(tm._handlePiRpcEscape).not.toHaveBeenCalled();

            const triggerEscape = new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            });
            trigger.dispatchEvent(triggerEscape);
            expect(triggerEscape.defaultPrevented).toBe(true);
            expect(document.activeElement).toBe(trigger);
            expect(tm._handlePiRpcEscape).not.toHaveBeenCalled();
        } finally {
            cleanup();
        }
    });

    it('Escape from sort dismisses an open navigator but keeps global Escape when closed', () => {
        const tm = makePartialListenerManager();
        const cleanup = setupEventListenersWithCleanup(tm);
        const trigger = document.getElementById('tab-overflow-btn');
        const sortButton = document.getElementById('sort-tabs-btn');
        const dropdown = document.getElementById('tab-overflow-dropdown');
        try {
            tm._toggleOverflowDropdown();
            sortButton.focus();
            const openEscape = new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            });
            sortButton.dispatchEvent(openEscape);

            expect(openEscape.defaultPrevented).toBe(true);
            expect(dropdown.classList.contains('hidden')).toBe(true);
            expect(document.activeElement).toBe(trigger);
            expect(tm._handlePiRpcEscape).not.toHaveBeenCalled();

            tm._handlePiRpcEscape.mockClear();
            sortButton.focus();
            const closedEscape = new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            });
            sortButton.dispatchEvent(closedEscape);

            expect(closedEscape.defaultPrevented).toBe(false);
            expect(dropdown.classList.contains('hidden')).toBe(true);
            expect(tm._handlePiRpcEscape).toHaveBeenCalledOnce();
        } finally {
            cleanup();
        }
    });
});

// ---- Overflow dropdown: hierarchy + click-to-switch ----------------

describe('_buildOverflowDropdown', () => {
    it('renders a single workspace and worktree as an expanded path to tabs', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        setTabIdentity(tm, 'a', {
            workspace: '/repo/alpha',
            cwd: '/repo/alpha',
        });
        setTabIdentity(tm, 'b', {
            workspace: '/repo/alpha',
            cwd: '/repo/alpha',
        });
        tm.activePaneId = 'a';

        tm._buildOverflowDropdown();

        const dropdown = document.getElementById('tab-overflow-dropdown');
        const workspace = dropdown.querySelector(
            'details.tab-overflow-workspace',
        );
        const worktree = dropdown.querySelector(
            'details.tab-overflow-worktree',
        );
        expect(dropdown.querySelectorAll('details')).toHaveLength(2);
        expect(workspace.open).toBe(true);
        expect(worktree.open).toBe(true);
        expect(
            workspace.querySelector(':scope > summary').textContent,
        ).toContain('alpha');
        expect(
            worktree.querySelector(':scope > summary').textContent,
        ).toContain('repo/alpha');
        expect(
            workspace.querySelector(':scope > summary').textContent,
        ).toContain('2 tabs');
        expect(
            worktree.querySelector(':scope > summary').textContent,
        ).toContain('2 tabs');
        expect(
            Array.from(dropdown.querySelectorAll('.hostname-dropdown-row')).map(
                (row) => row.dataset.paneId,
            ),
        ).toEqual(['a', 'b']);
        expect(
            dropdown.querySelector('.hostname-dropdown-row.active'),
        ).toBeTruthy();
        expect(workspace.hasAttribute('name')).toBe(false);
        expect(worktree.hasAttribute('name')).toBe(false);
    });

    it('nests workspace groups and preserves worktree first-appearance order and counts', () => {
        const tm = makeTabManager({ withTabs: ['b1', 'b2', 'a1', 'b3'] });
        setTabIdentity(tm, 'b1', {
            workspace: '/repo/Beta',
            cwd: '/repo/Beta',
        });
        setTabIdentity(tm, 'b2', {
            workspace: '/repo/Beta',
            cwd: '/tmp/Beta-wt',
        });
        setTabIdentity(tm, 'a1', {
            workspace: '/repo/alpha',
            cwd: '/repo/alpha',
        });
        setTabIdentity(tm, 'b3', {
            workspace: '/repo/Beta',
            cwd: '/repo/Beta',
        });

        tm._buildOverflowDropdown();

        const workspaces = Array.from(
            document.querySelectorAll('details.tab-overflow-workspace'),
        );
        expect(workspaces.map((group) => group.dataset.workspace)).toEqual([
            '/repo/alpha',
            '/repo/Beta',
        ]);
        const beta = workspaces[1];
        expect(
            Array.from(
                beta.querySelectorAll('details.tab-overflow-worktree'),
            ).map((group) => group.dataset.cwd),
        ).toEqual(['/repo/Beta', '/tmp/Beta-wt']);
        expect(
            Array.from(beta.querySelectorAll('.hostname-dropdown-row')).map(
                (row) => row.dataset.paneId,
            ),
        ).toEqual(['b1', 'b3', 'b2']);
        expect(
            Array.from(
                beta.querySelectorAll('details.tab-overflow-worktree'),
            ).map(
                (group) => group.querySelector(':scope > summary').textContent,
            ),
        ).toEqual(['›★repo/Beta2 tabs', '›★tmp/Beta-wt1 tab']);
    });

    it('keeps exact roots and directories distinct across labels, glyphs, and unusual paths', () => {
        const ids = [
            'project1',
            'project2',
            'project3',
            'orphan',
            'noDir',
            'case1',
            'case2',
            "q'[x]",
        ];
        const tm = makeTabManager({ withTabs: ids });
        setTabIdentity(tm, 'project1', {
            workspace: '/one/team/project',
            cwd: '/x/team/work',
            glyph: '★',
        });
        setTabIdentity(tm, 'project2', {
            workspace: '/one/team/project',
            cwd: '/y/team/work',
            glyph: '★',
        });
        setTabIdentity(tm, 'project3', {
            workspace: '/two/team/project',
            cwd: '/other/project',
        });
        setTabIdentity(tm, 'noDir', {
            workspace: '/repo/Case',
            cwd: '',
        });
        setTabIdentity(tm, 'case1', {
            workspace: '/repo/Case',
            cwd: '/tmp/Work',
        });
        setTabIdentity(tm, 'case2', {
            workspace: '/repo/case',
            cwd: '/tmp/work',
        });
        setTabIdentity(tm, 'orphan', { cwd: '/orphan/cwd' });
        setTabIdentity(tm, "q'[x]", {
            workspace: '/quote/"[project]',
            cwd: "/dir/'[x]",
            title: 'quoted [session] "name"',
        });

        tm._buildOverflowDropdown();

        const workspaces = Array.from(
            document.querySelectorAll('details.tab-overflow-workspace'),
        );
        const workspacePaths = workspaces.map(
            (group) => group.dataset.workspace,
        );
        expect(workspacePaths).toContain('/one/team/project');
        expect(workspacePaths).toContain('/two/team/project');
        expect(workspacePaths).toContain('');
        const projectLabels = workspaces
            .filter((group) =>
                ['/one/team/project', '/two/team/project'].includes(
                    group.dataset.workspace,
                ),
            )
            .map(
                (group) => group.querySelector(':scope > summary').textContent,
            );
        expect(projectLabels[0]).toContain('/one/team/project');
        expect(projectLabels[1]).toContain('/two/team/project');
        const one = workspaces.find(
            (group) => group.dataset.workspace === '/one/team/project',
        );
        const worktrees = Array.from(
            one.querySelectorAll('details.tab-overflow-worktree'),
        );
        expect(worktrees.map((group) => group.dataset.cwd)).toEqual([
            '/x/team/work',
            '/y/team/work',
        ]);
        expect(
            worktrees.map(
                (group) => group.querySelector(':scope > summary').textContent,
            ),
        ).toEqual(['›★/x/team/work1 tab', '›★/y/team/work1 tab']);
        expect(worktrees[0].dataset.cwd).not.toBe(worktrees[1].dataset.cwd);
        expect(
            document.querySelector(
                'details.tab-overflow-workspace[data-workspace=""] > summary',
            ).textContent,
        ).toContain('No workspace');
        expect(
            Array.from(
                document.querySelectorAll('.hostname-dropdown-row'),
            ).find((row) => row.dataset.paneId === 'orphan'),
        ).toBeTruthy();
        expect(
            Array.from(
                document.querySelectorAll('.hostname-dropdown-row'),
            ).find((row) => row.dataset.paneId === "q'[x]"),
        ).toBeTruthy();
        const quotedRow = Array.from(
            document.querySelectorAll('.hostname-dropdown-row'),
        ).find((row) => row.dataset.paneId === "q'[x]");
        expect(
            quotedRow.querySelector('.hostname-dropdown-title').textContent,
        ).toBe('quoted [session] "name"');
        const caseWorkspace = workspaces.find(
            (group) => group.dataset.workspace === '/repo/Case',
        );
        expect(
            Array.from(
                caseWorkspace.querySelectorAll('details.tab-overflow-worktree'),
            )
                .find((group) => group.dataset.cwd === '')
                .querySelector(':scope > summary').textContent,
        ).toContain('No directory');
        expect(
            document.querySelector(
                '.hostname-dropdown-row[data-pane-id="case1"]',
            ),
        ).toBeTruthy();
        expect(
            document.querySelector(
                '.hostname-dropdown-row[data-pane-id="case2"]',
            ),
        ).toBeTruthy();
    });

    it('preserves collapse, scroll, and visible focus when refreshing an open popup', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'] });
        setTabIdentity(tm, 'a', { workspace: '/one', cwd: '/one' });
        setTabIdentity(tm, 'b', { workspace: '/one', cwd: '/tmp/one' });
        setTabIdentity(tm, 'c', { workspace: '/two', cwd: '/two' });
        tm.activePaneId = 'a';
        tm._toggleOverflowDropdown();
        const dropdown = document.getElementById('tab-overflow-dropdown');
        const workspaces = () =>
            Array.from(
                dropdown.querySelectorAll('details.tab-overflow-workspace'),
            );
        workspaces().find((group) => group.dataset.workspace === '/two').open =
            false;
        dropdown.scrollTop = 37;
        const focused = Array.from(
            dropdown.querySelectorAll('.hostname-dropdown-select-btn'),
        ).find(
            (button) =>
                button.dataset.overflowFocusKey ===
                JSON.stringify(['select', 'b']),
        );
        focused.focus();

        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.dataset.paneId = 'd';
        tm.tabsContainer.appendChild(tabEl);
        tm.tabs.set('d', {
            paneId: 'd',
            title: 'new workspace',
            cwd: '/three',
            workspace: '/three',
            tabEl,
            termContainer: document.createElement('div'),
        });
        tm._refreshOverflowDropdown();

        expect(dropdown.scrollTop).toBe(37);
        expect(document.activeElement.dataset.overflowFocusKey).toBe(
            JSON.stringify(['select', 'b']),
        );
        expect(
            workspaces().find((group) => group.dataset.workspace === '/two')
                .open,
        ).toBe(false);
        expect(
            workspaces().find((group) => group.dataset.workspace === '/three')
                .open,
        ).toBe(true);
    });

    it('restores focus to a collapsed disclosure summary but not a hidden descendant', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        setTabIdentity(tm, 'a', { workspace: '/one', cwd: '/one' });
        setTabIdentity(tm, 'b', { workspace: '/two', cwd: '/two' });
        tm.activePaneId = 'b';
        tm._toggleOverflowDropdown();
        const dropdown = document.getElementById('tab-overflow-dropdown');
        let one = Array.from(
            dropdown.querySelectorAll('details.tab-overflow-workspace'),
        ).find((group) => group.dataset.workspace === '/one');
        one.open = false;
        const summary = one.querySelector(':scope > summary');
        summary.focus();

        tm._refreshOverflowDropdown();

        one = Array.from(
            dropdown.querySelectorAll('details.tab-overflow-workspace'),
        ).find((group) => group.dataset.workspace === '/one');
        expect(one.open).toBe(false);
        expect(document.activeElement).toBe(
            one.querySelector(':scope > summary'),
        );

        const hiddenLeaf = Array.from(
            dropdown.querySelectorAll('.hostname-dropdown-select-btn'),
        ).find(
            (button) =>
                button.dataset.overflowFocusKey ===
                JSON.stringify(['select', 'a']),
        );
        hiddenLeaf.focus();
        tm._refreshOverflowDropdown();
        expect(document.activeElement.dataset.overflowFocusKey).toBe(
            JSON.stringify(['select', 'b']),
        );
    });

    it('does not steal outside focus and falls back after a focused row disappears', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        setTabIdentity(tm, 'a', { workspace: '/one', cwd: '/one' });
        setTabIdentity(tm, 'b', { workspace: '/one', cwd: '/one' });
        tm.activePaneId = 'b';
        tm._toggleOverflowDropdown();
        const dropdown = document.getElementById('tab-overflow-dropdown');
        const outside = document.createElement('button');
        document.body.appendChild(outside);
        outside.focus();
        tm._refreshOverflowDropdown();
        expect(document.activeElement).toBe(outside);

        const focused = Array.from(
            dropdown.querySelectorAll('.hostname-dropdown-select-btn'),
        ).find(
            (button) =>
                button.dataset.overflowFocusKey ===
                JSON.stringify(['select', 'a']),
        );
        focused.focus();
        tm.tabs.delete('a');
        tm._refreshOverflowDropdown();
        expect(document.activeElement.dataset.overflowFocusKey).toBe(
            JSON.stringify(['select', 'b']),
        );
    });

    it('uses Undo and then the popup as focus fallbacks for closing-only and empty lists', () => {
        const tm = makeTabManager({ withTabs: ['closing'] });
        tm.tabs.get('closing').softClosing = true;
        tm._toggleOverflowDropdown();
        const dropdown = document.getElementById('tab-overflow-dropdown');
        expect(dropdown.querySelectorAll('details')).toHaveLength(0);
        expect(
            dropdown.querySelector('.tab-overflow-closing-row'),
        ).toBeTruthy();
        expect(
            dropdown.querySelector('.tab-overflow-closing-countdown')
                .textContent,
        ).toMatch(/^Closing in \d+s$/);
        dropdown.querySelector('.hostname-dropdown-select-btn').focus();
        tm.tabs.clear();
        tm._refreshOverflowDropdown();
        expect(document.activeElement).toBe(dropdown);
        expect(dropdown.textContent).toContain('No tabs open');
    });

    it('reopens every disclosure expanded and scrolls the chosen live row nearest', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        setTabIdentity(tm, 'a', { workspace: '/one', cwd: '/one' });
        setTabIdentity(tm, 'b', { workspace: '/two', cwd: '/two' });
        tm.activePaneId = 'b';
        const scrollIntoView = vi.spyOn(
            HTMLElement.prototype,
            'scrollIntoView',
        );
        tm._toggleOverflowDropdown();
        const dropdown = document.getElementById('tab-overflow-dropdown');
        const one = Array.from(
            dropdown.querySelectorAll('details.tab-overflow-workspace'),
        ).find((group) => group.dataset.workspace === '/one');
        one.open = false;
        tm._toggleOverflowDropdown();
        tm._toggleOverflowDropdown();
        expect(
            Array.from(dropdown.querySelectorAll('details')).every(
                (group) => group.open,
            ),
        ).toBe(true);
        expect(document.activeElement.dataset.overflowFocusKey).toBe(
            JSON.stringify(['select', 'b']),
        );
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    });

    it('runs live close through its lifecycle once without selecting the closing row', () => {
        vi.useFakeTimers();
        const tm = makeTabManager({ withTabs: ['a', 'b'] });
        setTabIdentity(tm, 'a', { workspace: '/one', cwd: '/one' });
        setTabIdentity(tm, 'b', { workspace: '/one', cwd: '/one' });
        tm.activePaneId = 'a';
        tm.app = { showToast: vi.fn() };
        tm._startSoftCloseCountdown = vi.fn();
        tm.updateTabOverflow = vi.fn();
        const switchSpy = vi.spyOn(tm, 'switchTab');
        const refreshSpy = vi.spyOn(tm, '_refreshOverflowDropdown');
        try {
            tm._toggleOverflowDropdown();
            const action = Array.from(
                document.querySelectorAll('.hostname-dropdown-row'),
            )
                .find((row) => row.dataset.paneId === 'b')
                .querySelector('.hostname-dropdown-close-btn');
            action.click();
            expect(tm.tabs.get('b').softClosing).toBe(true);
            expect(
                document.querySelector('.tab-overflow-closing-row').dataset
                    .paneId,
            ).toBe('b');
            expect(switchSpy).not.toHaveBeenCalled();
            expect(refreshSpy).toHaveBeenCalledOnce();
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('keeps closing tabs out of live worktree groups', () => {
        const tm = makeTabManager({
            withTabs: ['A:a', 'A:b'],
            width: 800,
        });
        tm.tabs.get('A:b').softClosing = true;
        tm._buildOverflowDropdown();
        const dropdown = document.getElementById('tab-overflow-dropdown');
        expect(
            dropdown.querySelector('.tab-overflow-closing-group'),
        ).toBeTruthy();
        expect(
            dropdown.querySelector('.tab-overflow-closing-row').dataset.paneId,
        ).toBe('A:b');
        expect(dropdown.querySelectorAll('.hostname-dropdown-row').length).toBe(
            2,
        );
        expect(
            dropdown.querySelector('.tab-overflow-closing-countdown')
                .textContent,
        ).toMatch(/^Closing in \d+s$/);
    });

    it('clicking a closing tab row invokes Undo and removes the row menu', () => {
        const tm = makeTabManager({ withTabs: ['a'], width: 800 });
        tm.tabs.get('a').softClosing = true;
        const activation = document.createElement('button');
        document.body.appendChild(activation);
        tm.undoCloseTab = vi.fn(() => activation.focus());
        tm._buildOverflowDropdown();
        const row = document.querySelector('.tab-overflow-closing-row');
        row.querySelector('.hostname-dropdown-select-btn').click();
        expect(tm.undoCloseTab).toHaveBeenCalledWith('a');
        expect(document.activeElement).toBe(activation);
        expect(
            document
                .getElementById('tab-overflow-dropdown')
                .classList.contains('hidden'),
        ).toBe(true);
    });

    it('renders an empty-state message when no tabs are open', () => {
        const tm = makeTabManager({ withTabs: [], width: 800 });
        tm._buildOverflowDropdown();
        const dropdown = document.getElementById('tab-overflow-dropdown');
        expect(dropdown.textContent).toMatch(/No tabs open/i);
    });

    it('dropdown toggle shows/hides via aria-expanded', () => {
        const tm = makeTabManager({ withTabs: ['A:a'], width: 800 });
        const btn = document.getElementById('tab-overflow-btn');
        // Start hidden.
        expect(
            document
                .getElementById('tab-overflow-dropdown')
                .classList.contains('hidden'),
        ).toBe(true);
        tm._toggleOverflowDropdown();
        expect(
            document
                .getElementById('tab-overflow-dropdown')
                .classList.contains('hidden'),
        ).toBe(false);
        expect(btn.getAttribute('aria-expanded')).toBe('true');
        tm._toggleOverflowDropdown();
        expect(
            document
                .getElementById('tab-overflow-dropdown')
                .classList.contains('hidden'),
        ).toBe(true);
        expect(btn.getAttribute('aria-expanded')).toBe('false');
    });

    it('clicking a row closes the dropdown and switches the active tab', () => {
        const tm = makeTabManager({ withTabs: ['A:a', 'A:b'], width: 800 });
        // Spy on switchTab to verify the click handler calls it.
        const activation = document.createElement('button');
        document.body.appendChild(activation);
        const switchSpy = vi
            .spyOn(tm, 'switchTab')
            .mockImplementation(() => activation.focus());
        tm._buildOverflowDropdown();
        const dd = document.getElementById('tab-overflow-dropdown');
        const row = dd.querySelector('.hostname-dropdown-row');
        // First row's select button should call switchTab and close.
        const selectBtn = row.querySelector('.hostname-dropdown-select-btn');
        selectBtn.click();
        expect(switchSpy).toHaveBeenCalledWith(
            'A:a',
            expect.objectContaining({ userInitiated: true }),
        );
        expect(dd.classList.contains('hidden')).toBe(true);
        expect(document.activeElement).toBe(activation);
    });
});

describe('workspace navigator lifecycle refresh', () => {
    it('refreshes a visible popup after real client-tab creation and selection', () => {
        const tm = makePopupLifecycleManager({
            withTabs: ['a', 'b'],
            activePaneId: 'a',
        });
        setTabIdentity(tm, 'a', {
            workspace: '/repo/alpha',
            cwd: '/repo/alpha',
        });
        setTabIdentity(tm, 'b', {
            workspace: '/repo/Beta',
            cwd: '/repo/Beta',
        });
        tm._toggleOverflowDropdown();
        const dropdown = document.getElementById('tab-overflow-dropdown');
        expect(
            dropdown.querySelectorAll('.hostname-dropdown-row'),
        ).toHaveLength(2);

        tm.createTab(
            'panel',
            '',
            'Client panel',
            'kanban',
            '/repo/alpha',
            '/repo/alpha',
        );

        expect(tm.tabs.has('panel')).toBe(true);
        expect(dropdown.classList.contains('hidden')).toBe(false);
        expect(
            dropdown.querySelectorAll('.hostname-dropdown-row'),
        ).toHaveLength(3);
        expect(
            Array.from(
                dropdown.querySelectorAll('details.tab-overflow-workspace'),
            ).find((group) => group.dataset.workspace === '/repo/alpha')
                .textContent,
        ).toContain('2 tabs');
        expect(
            dropdown.querySelector(
                '.hostname-dropdown-row[data-pane-id="panel"].active',
            ),
        ).toBeTruthy();

        tm.switchTab('a');

        expect(
            dropdown.querySelector(
                '.hostname-dropdown-row[data-pane-id="a"].active',
            ),
        ).toBeTruthy();
        expect(
            dropdown.querySelector(
                '.hostname-dropdown-row[data-pane-id="panel"].active',
            ),
        ).toBeNull();
    });

    it('refreshes moved leaf order while preserving another workspace collapse', () => {
        const tm = makeTabManager({ withTabs: ['b1', 'b2', 'a1'] });
        setTabIdentity(tm, 'b1', {
            workspace: '/repo/Beta',
            cwd: '/repo/Beta',
        });
        setTabIdentity(tm, 'b2', {
            workspace: '/repo/Beta',
            cwd: '/repo/Beta',
        });
        setTabIdentity(tm, 'a1', {
            workspace: '/repo/alpha',
            cwd: '/repo/alpha',
        });
        tm._toggleOverflowDropdown();
        const dropdown = document.getElementById('tab-overflow-dropdown');
        const alpha = Array.from(
            dropdown.querySelectorAll('details.tab-overflow-workspace'),
        ).find((group) => group.dataset.workspace === '/repo/alpha');
        alpha.open = false;

        expect(tm.moveTabTo('b1', 'b2', false)).toBe(true);

        const beta = Array.from(
            dropdown.querySelectorAll('details.tab-overflow-workspace'),
        ).find((group) => group.dataset.workspace === '/repo/Beta');
        expect(
            Array.from(beta.querySelectorAll('.hostname-dropdown-row')).map(
                (row) => row.dataset.paneId,
            ),
        ).toEqual(['b2', 'b1']);
        expect(
            Array.from(
                dropdown.querySelectorAll('details.tab-overflow-workspace'),
            ).find((group) => group.dataset.workspace === '/repo/alpha').open,
        ).toBe(false);
    });

    it('uses current pane IDs when reopening the navigator after a replacement', () => {
        const tm = makePopupLifecycleManager({
            withTabs: ['old'],
            activePaneId: 'old',
        });
        setTabIdentity(tm, 'old', {
            workspace: '/repo/alpha',
            cwd: '/repo/alpha',
        });
        tm._toggleOverflowDropdown();
        tm._toggleOverflowDropdown();

        const replacement = tm.tabs.get('old');
        tm.tabs.delete('old');
        replacement.paneId = 'new';
        replacement.tabEl.dataset.paneId = 'new';
        tm.tabs.set('new', replacement);
        tm.activePaneId = null;
        tm._toggleOverflowDropdown();

        const dropdown = document.getElementById('tab-overflow-dropdown');
        expect(
            dropdown.querySelector(
                '.hostname-dropdown-row[data-pane-id="old"]',
            ),
        ).toBeNull();
        expect(
            dropdown.querySelector(
                '.hostname-dropdown-row[data-pane-id="new"]',
            ),
        ).toBeTruthy();
        dropdown
            .querySelector(
                '.hostname-dropdown-row[data-pane-id="new"] .hostname-dropdown-select-btn',
            )
            .click();
        expect(tm.activePaneId).toBe('new');
    });

    it('keeps close, Undo, closing-only recovery, and final empty state usable', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-18T12:00:00.000Z'));
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, status: 200 })),
        );
        const tm = makePopupLifecycleManager({
            withTabs: ['a', 'b'],
            activePaneId: 'a',
        });
        try {
            tm._toggleOverflowDropdown();
            let dropdown = document.getElementById('tab-overflow-dropdown');
            dropdown
                .querySelector(
                    '.hostname-dropdown-row[data-pane-id="b"] .hostname-dropdown-close-btn',
                )
                .click();
            expect(tm.tabs.get('b').softClosing).toBe(true);
            expect(
                dropdown.querySelector(
                    '.tab-overflow-closing-row[data-pane-id="b"]',
                ),
            ).toBeTruthy();

            dropdown
                .querySelector(
                    '.tab-overflow-closing-row[data-pane-id="b"] .hostname-dropdown-select-btn',
                )
                .click();
            expect(tm.tabs.get('b').softClosing).toBe(false);
            expect(tm.activePaneId).toBe('b');
            expect(dropdown.classList.contains('hidden')).toBe(true);

            tm._toggleOverflowDropdown();
            dropdown = document.getElementById('tab-overflow-dropdown');
            dropdown
                .querySelector(
                    '.hostname-dropdown-row[data-pane-id="a"] .hostname-dropdown-close-btn',
                )
                .click();
            dropdown
                .querySelector(
                    '.hostname-dropdown-row[data-pane-id="b"] .hostname-dropdown-close-btn',
                )
                .click();
            expect(
                dropdown.querySelectorAll('.tab-overflow-closing-row'),
            ).toHaveLength(2);
            expect(
                dropdown.querySelectorAll('details.tab-overflow-workspace'),
            ).toHaveLength(0);
            expect(dropdown.classList.contains('hidden')).toBe(false);
            expect(tm.showEmptyState).toHaveBeenCalledOnce();
            dropdown
                .querySelector(
                    '.tab-overflow-closing-row[data-pane-id="a"] .hostname-dropdown-select-btn',
                )
                .click();
            expect(tm.activePaneId).toBe('a');
            expect(tm.tabs.get('a').softClosing).toBe(false);
            expect(dropdown.classList.contains('hidden')).toBe(true);

            tm._toggleOverflowDropdown();
            dropdown = document.getElementById('tab-overflow-dropdown');
            dropdown
                .querySelector(
                    '.hostname-dropdown-row[data-pane-id="a"] .hostname-dropdown-close-btn',
                )
                .click();
            expect(
                dropdown.querySelectorAll('.tab-overflow-closing-row'),
            ).toHaveLength(2);
            expect(
                dropdown.querySelectorAll('details.tab-overflow-workspace'),
            ).toHaveLength(0);
            expect(tm.showEmptyState).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(TabManager.SOFT_CLOSE_GRACE_MS);
            expect(tm.tabs.size).toBe(0);
            expect(dropdown.textContent).toContain('No tabs open');
            expect(dropdown.classList.contains('hidden')).toBe(false);
            expect(tm.showEmptyState).toHaveBeenCalledTimes(3);
        } finally {
            vi.clearAllTimers();
            vi.unstubAllGlobals();
            vi.useRealTimers();
        }
    });

    it('updates the visible countdown and undoes through the popup row action', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-18T12:00:00.000Z'));
        const tm = makePopupLifecycleManager({
            withTabs: ['a', 'b'],
            activePaneId: 'a',
        });
        try {
            tm._toggleOverflowDropdown();
            const dropdown = document.getElementById('tab-overflow-dropdown');
            dropdown
                .querySelector(
                    '.hostname-dropdown-row[data-pane-id="b"] .hostname-dropdown-close-btn',
                )
                .click();
            const tab = tm.tabs.get('b');
            expect(
                dropdown.querySelector(
                    '.tab-overflow-closing-row[data-pane-id="b"] .tab-overflow-closing-countdown',
                ).textContent,
            ).toBe('Closing in 3s');
            expect(tab.softCloseTimer).not.toBeNull();
            expect(tab.softCloseCountdownTimer).not.toBeNull();

            vi.advanceTimersByTime(1000);
            expect(
                dropdown.querySelector(
                    '.tab-overflow-closing-row[data-pane-id="b"] .tab-overflow-closing-countdown',
                ).textContent,
            ).toBe('Closing in 2s');

            dropdown
                .querySelector(
                    '.tab-overflow-closing-row[data-pane-id="b"] .hostname-dropdown-select-btn',
                )
                .click();
            expect(
                dropdown.querySelector('.tab-overflow-closing-row'),
            ).toBeNull();
            expect(tab.softCloseTimer).toBeNull();
            expect(tab.softCloseCountdownTimer).toBeNull();
            vi.advanceTimersByTime(TabManager.SOFT_CLOSE_GRACE_MS + 1000);
            expect(tm.tabs.get('b')).toBe(tab);
            expect(tab.softClosing).toBe(false);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });
});

// ---- Mouse-wheel horizontal scroll ----------------------------------

describe('wheel -> horizontal scroll', () => {
    function dispatchWheel(
        tm,
        { deltaX = 0, deltaY = 0, cancelable = true } = {},
    ) {
        const ev = new WheelEvent('wheel', {
            deltaX,
            deltaY,
            bubbles: true,
            cancelable,
        });
        tm.tabsContainer.dispatchEvent(ev);
        return ev;
    }

    it('translates vertical wheel to horizontal scroll when strip overflows', () => {
        const tm = makeTabManager({
            withTabs: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
            width: 600,
        });
        tm._setupContainerDragHandlers();
        const ev = dispatchWheel(tm, { deltaY: 100 });
        expect(ev.defaultPrevented).toBe(true);
        // scrollLeft should have advanced by exactly deltaY.
        expect(tm.tabsContainer.scrollLeft).toBe(100);
    });

    it('does NOT preventDefault when the strip has no overflow', () => {
        const tm = makeTabManager({ withTabs: ['t1', 't2'], width: 1200 });
        tm._setupContainerDragHandlers();
        const ev = dispatchWheel(tm, { deltaY: 100 });
        expect(ev.defaultPrevented).toBe(false);
    });

    it('respects the scrollLeft upper bound (does not over-scroll)', () => {
        const tm = makeTabManager({
            withTabs: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
            width: 600,
        });
        tm._setupContainerDragHandlers();
        // totalScroll = 8*150 - 600 = 600. Push past the limit.
        const ev = dispatchWheel(tm, { deltaY: 9999 });
        expect(tm.tabsContainer.scrollLeft).toBe(600);
        expect(ev.defaultPrevented).toBe(true);
    });

    it('accepts deltaX (trackpad horizontal gesture) directly', () => {
        const tm = makeTabManager({
            withTabs: ['t1', 't2', 't3', 't4', 't5', 't6'],
            width: 600,
        });
        tm._setupContainerDragHandlers();
        const ev = dispatchWheel(tm, { deltaX: 50, deltaY: 0 });
        expect(ev.defaultPrevented).toBe(true);
        expect(tm.tabsContainer.scrollLeft).toBe(50);
    });
});

// ---- Edge auto-scroll during drag ----------------------------------

describe('edge auto-scroll during drag', () => {
    function dragOver(tm, clientX) {
        const ev = new Event('dragover', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clientX', { value: clientX });
        Object.defineProperty(ev, 'dataTransfer', {
            value: { dropEffect: '', effectAllowed: '' },
        });
        tm.tabsContainer.dispatchEvent(ev);
        return ev;
    }

    it('sets scroll direction + velocity when cursor is in the right edge zone', () => {
        const tm = makeTabManager({
            withTabs: ['t1', 't2', 't3', 't4', 't5', 't6'],
            width: 800,
        });
        tm.dragSourceId = 't1';
        tm._setupContainerDragHandlers();
        // Cursor at clientX = 800-10 = 790. Edge zone is 48px from right
        // (800-48 = 752). 790 > 752 → right direction.
        dragOver(tm, 790);
        expect(tm._dragScrollDir).toBe(1);
        expect(tm._dragScrollVel).toBeGreaterThan(0);
        expect(tm._dragScrollVel).toBeLessThanOrEqual(15);
    });

    it('sets scroll direction -1 when cursor is in the left edge zone', () => {
        const tm = makeTabManager({
            withTabs: ['t1', 't2', 't3', 't4', 't5', 't6'],
            width: 800,
        });
        tm.dragSourceId = 't1';
        tm._setupContainerDragHandlers();
        // Cursor at clientX = 10. Edge zone is 48px from left.
        // 10 < 48 → left direction.
        dragOver(tm, 10);
        expect(tm._dragScrollDir).toBe(-1);
        expect(tm._dragScrollVel).toBeGreaterThan(0);
    });

    it('sets velocity to zero when cursor is in the middle of the strip', () => {
        const tm = makeTabManager({
            withTabs: ['t1', 't2', 't3', 't4', 't5', 't6'],
            width: 800,
        });
        tm.dragSourceId = 't1';
        tm._setupContainerDragHandlers();
        // Mid-strip: clientX=400 (well past both edge zones).
        dragOver(tm, 400);
        expect(tm._dragScrollDir).toBe(0);
        expect(tm._dragScrollVel).toBe(0);
    });

    it('does not act when no drag is in progress', () => {
        const tm = makeTabManager({
            withTabs: ['t1', 't2', 't3', 't4', 't5', 't6'],
            width: 800,
        });
        tm.dragSourceId = null;
        tm._setupContainerDragHandlers();
        dragOver(tm, 790);
        expect(tm._dragScrollDir).toBe(0);
    });

    it('preventDefaults so dragover keeps firing over whitespace', () => {
        const tm = makeTabManager({
            withTabs: ['t1', 't2'],
            width: 1200,
        });
        tm.dragSourceId = 't1';
        tm._setupContainerDragHandlers();
        const ev = dragOver(tm, 0);
        expect(ev.defaultPrevented).toBe(true);
    });

    it('_stopDragAutoScroll clears state and cancels the rAF', () => {
        const tm = makeTabManager({ withTabs: ['t1'], width: 800 });
        tm._dragScrollDir = 1;
        tm._dragScrollVel = 10;
        tm._dragScrollRaf = 123; // truthy stub
        tm._stopDragAutoScroll();
        expect(tm._dragScrollDir).toBe(0);
        expect(tm._dragScrollVel).toBe(0);
        expect(tm._dragScrollRaf).toBe(null);
    });

    it('handleTabDragEnd clears auto-scroll state (cleanup)', () => {
        const tm = makeTabManager({ withTabs: ['t1'], width: 800 });
        tm.dragSourceId = 't1';
        tm._dragScrollDir = 1;
        tm._dragScrollVel = 8;
        tm._dragScrollRaf = 456;
        // jsdom doesn't supply e.currentTarget here, but handleTabDragEnd
        // only touches it if present.
        tm.handleTabDragEnd({ currentTarget: null });
        expect(tm.dragSourceId).toBe(null);
        expect(tm._dragScrollDir).toBe(0);
        expect(tm._dragScrollVel).toBe(0);
    });
});

// ---- Container-level drop on whitespace ----------------------------

describe('container drop on whitespace', () => {
    function fireDropOnStrip(tm, clientX) {
        const ev = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clientX', { value: clientX });
        // Pretend the drop landed on the strip itself, not a child.
        Object.defineProperty(ev, 'target', {
            value: tm.tabsContainer,
        });
        tm.tabsContainer.dispatchEvent(ev);
        return ev;
    }

    it('appends source tab to end when dropping past the right edge of strip', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'], width: 800 });
        tm.dragSourceId = 'a';
        tm._setupContainerDragHandlers();
        // Mock tabsContainer.contains to return false (drop on whitespace, not a tab).
        tm.tabsContainer.contains = vi.fn(() => false);
        fireDropOnStrip(tm, 850); // past the right edge (800-4=796)
        expect(tm.tabs.has('a')).toBe(true);
        // 'a' should now be last in the Map order.
        const order = Array.from(tm.tabs.keys());
        expect(order[order.length - 1]).toBe('a');
    });

    it('prepends source tab to start when dropping before the left edge', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b', 'c'], width: 800 });
        tm.dragSourceId = 'c';
        tm._setupContainerDragHandlers();
        tm.tabsContainer.contains = vi.fn(() => false);
        fireDropOnStrip(tm, -10); // before the left edge
        // 'c' should now be first.
        const order = Array.from(tm.tabs.keys());
        expect(order[0]).toBe('c');
    });

    it('stops auto-scroll on whitespace drop', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'], width: 800 });
        tm.dragSourceId = 'a';
        tm._dragScrollDir = 1;
        tm._dragScrollVel = 5;
        tm._setupContainerDragHandlers();
        tm.tabsContainer.contains = vi.fn(() => false);
        fireDropOnStrip(tm, 850);
        expect(tm._dragScrollDir).toBe(0);
        expect(tm._dragScrollVel).toBe(0);
    });

    it('is a no-op if no tab is being dragged', () => {
        const tm = makeTabManager({ withTabs: ['a', 'b'], width: 800 });
        tm.dragSourceId = null;
        tm._setupContainerDragHandlers();
        tm.tabsContainer.contains = vi.fn(() => false);
        const orderBefore = Array.from(tm.tabs.keys());
        fireDropOnStrip(tm, 850);
        const orderAfter = Array.from(tm.tabs.keys());
        expect(orderAfter).toEqual(orderBefore);
    });
});

// ---- Regression: updateTabOverflow must run AFTER this.tabs.set
// in createTab(), not before. v0.8.4 had this call ~300 lines before
// tabs.set which made the tab-list selector always one tab behind until
// some unrelated event triggered a re-render. (The worktree-legend
// sibling check was removed when the legend itself was removed.)

describe('overflow refresh timing in createTab', () => {
    it('updateTabOverflow appears AFTER tabs.set, not before', () => {
        const fs = require('node:fs');
        const src = fs.readFileSync('web/terminal.js', 'utf8');

        const tabsSetIdx = src.indexOf('this.tabs.set(paneId, tabInfo)');
        expect(tabsSetIdx).toBeGreaterThan(0);

        const overflowCallIdx = src.indexOf(
            'this.updateTabOverflow()',
            tabsSetIdx,
        );
        expect(overflowCallIdx).toBeGreaterThan(tabsSetIdx);
    });

    it('createTab does NOT call updateTabOverflow before tabs.set', () => {
        const fs = require('node:fs');
        const src = fs.readFileSync('web/terminal.js', 'utf8');

        const sigMatch = src.match(
            /createTab\(\s*paneId,\s*sessionId,\s*title,\s*coder,/,
        );
        const sigIdx = sigMatch?.index ?? -1;
        expect(sigIdx).toBeGreaterThan(0);
        const openIdx = src.indexOf('{', sigIdx);
        let depth = 0;
        let endIdx = -1;
        for (let i = openIdx; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') {
                depth--;
                if (depth === 0) {
                    endIdx = i;
                    break;
                }
            }
        }
        expect(endIdx).toBeGreaterThan(openIdx);
        const body = src.slice(openIdx, endIdx);

        const tabsSetIdx = body.indexOf('this.tabs.set(paneId, tabInfo)');
        expect(tabsSetIdx).toBeGreaterThan(0);
        const beforeSet = body.slice(0, tabsSetIdx);

        expect(beforeSet.includes('this.updateTabOverflow()')).toBe(false);
    });
});
