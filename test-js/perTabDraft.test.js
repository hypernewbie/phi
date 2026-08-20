// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TabManager } from '../web/terminal.js';

// Tests for per-tab input drafts: the DOM textarea + stagedAttachments hold
// the ACTIVE tab's draft; tabInfo.draft / tabInfo.draftAttachments park it
// while the tab is inactive (written on switch-away, read on switch-in).
// review/kanban tabs hide the input bar and never park or restore a draft.

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
    tm.showEmptyState = vi.fn();
    tm.hideEmptyState = vi.fn();
    tm.updateDisconnectBanner = vi.fn();
    tm.saveTabsState = vi.fn();
    tm.inputTextArea = document.createElement('textarea');
    document.body.appendChild(tm.inputTextArea);
    tm.attachmentStrip = document.createElement('div');
    document.body.appendChild(tm.attachmentStrip);
    tm.stagedAttachments = [];
    tm.lastInputValue = '';
    tm._historyCursor = -1;
    tm._historyPreCycleValue = undefined;
    tm._renderAttachmentStrip = vi.fn();
    tm.adjustInputHeight = vi.fn();
    tm.activateTabViewport = vi.fn();
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
        // switchTab reaches into sessionsManager to coordinate the
        // sidebar; stub it so the switch doesn't throw mid-test.
        sessionsManager: {
            activeCoder: 'shell',
            activeWorkspace: '/wsA',
            activeCWD: '/wsA',
            switchCoder: vi.fn(),
            highlightActiveSession: vi.fn(),
            highlightActiveWorktree: vi.fn(),
            workspaceSelect: { value: '/wsA' },
            updateWorkspaceSelectWidth: vi.fn(),
            loadWorktrees: vi.fn(() => Promise.resolve()),
        },
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
        const isReviewOrKanban =
            meta.coder === 'review' || meta.coder === 'kanban';
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
        if (!isReviewOrKanban) {
            fullMeta.draft = '';
            fullMeta.draftAttachments = [];
        }
        tm.tabs.set(meta.paneId, fullMeta);
    }
    return tm;
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('per-tab input draft', () => {
    it('parks the draft on switch-away and restores it on switch-back', () => {
        const tm = makeTm({ withTabs: ['A', 'B'], activePaneId: 'A' });
        tm.inputTextArea.value = 'draft A';

        tm.switchTab('B');
        expect(tm.inputTextArea.value).toBe('');
        expect(tm.tabs.get('A').draft).toBe('draft A');
        // Restore must re-run autosize or the textarea keeps the
        // previous tab's height.
        expect(tm.adjustInputHeight).toHaveBeenCalled();

        tm.inputTextArea.value = 'draft B';
        tm.switchTab('A');
        expect(tm.inputTextArea.value).toBe('draft A');
        expect(tm.tabs.get('B').draft).toBe('draft B');
        expect(tm.lastInputValue).toBe('draft A');

        // A send clears the DOM; the next switch-away must park the
        // empty draft, not resurrect the sent text as a ghost.
        tm.inputTextArea.value = '';
        tm.lastInputValue = '';
        tm.switchTab('B');
        tm.switchTab('A');
        expect(tm.inputTextArea.value).toBe('');
        expect(tm.tabs.get('A').draft).toBe('');
    });

    it('parks and restores staged attachments per tab', () => {
        const tm = makeTm({ withTabs: ['A', 'B'], activePaneId: 'A' });
        const attachment = { id: 'a1', name: 'x.png', path: '/tmp/x.png' };
        tm.stagedAttachments = [attachment];

        tm.switchTab('B');
        expect(tm.stagedAttachments.length).toBe(0);
        expect(tm.tabs.get('A').draftAttachments.length).toBe(1);

        tm.switchTab('A');
        expect(tm.stagedAttachments[0]).toBe(attachment);
        expect(tm._renderAttachmentStrip).toHaveBeenCalled();
    });

    it('resets prompt-history cycle state on switch', () => {
        const tm = makeTm({ withTabs: ['A', 'B'], activePaneId: 'A' });
        tm._historyCursor = 2;
        tm._historyPreCycleValue = 'stale';

        tm.switchTab('B');
        expect(tm._historyCursor).toBe(-1);
        expect(tm._historyPreCycleValue).toBeUndefined();
    });

    it('kanban tabs neither park nor leak drafts', () => {
        const tm = makeTm({
            withTabs: ['A', { paneId: 'K', coder: 'kanban' }, 'B'],
            activePaneId: 'A',
        });
        tm.inputTextArea.value = 'keep me';

        tm.switchTab('K');
        expect(tm.tabs.get('A').draft).toBe('keep me');
        expect(tm.tabs.get('K').draft).toBeUndefined();

        tm.switchTab('B');
        expect(tm.inputTextArea.value).toBe('');
        expect(tm.tabs.get('K').draft).toBeUndefined();
    });
});

// The inputTextArea guards in switchTab (harnesses without an input bar)
// are covered incidentally but reliably: kanbanTabInteraction.test.js runs
// the real switchTab with no inputTextArea and goes red if either guard is
// removed (mutation-verified 2026-08-03).
