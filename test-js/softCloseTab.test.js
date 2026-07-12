// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Tests for the soft-close tab pipeline:
//   closeTab(paneId)   -> softCloseTab (grace period)
//   undoCloseTab       -> restore
//   finalizeCloseTab   -> actually kill the PTY
//   pickNextTab        -> smart next-tab selection (workspace + coder)
//
// The grace timer is 5s (TabManager.SOFT_CLOSE_GRACE_MS). These tests
// use vi.useFakeTimers so we can advance the clock without waiting in
// real time. The MAX_SOFT_CLOSED_TABS cap = 3.

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
    tm.showEmptyState = vi.fn();
    tm.hideEmptyState = vi.fn();
    tm.updateDisconnectBanner = vi.fn();
    tm.saveTabsState = vi.fn();
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
        const meta = (typeof id === 'string') ? { paneId: id } : id;
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
                cols: 80, rows: 24,
            },
            fitAddon: { fit: vi.fn() },
        };
        tm.tabs.set(meta.paneId, fullMeta);
    }
    return tm;
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
        const tm = makeTm({ withTabs: [{ paneId: 'a', title: 'My Cool Shell' }] });
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
        // (no need to wait the full 5s grace).
        const tm = makeTm({ withTabs: ['a'] });
        const finalizeSpy = vi.spyOn(tm, 'finalizeCloseTab');
        tm.softCloseTab('a'); // first ×
        tm.closeTab('a');      // second × = finalize now
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
        expect(tm.tabs.get('a').tabEl.classList.contains('soft-closed')).toBe(false);
        // Advance past the grace - finalize should NOT fire because we undid.
        vi.advanceTimersByTime(TabManager.SOFT_CLOSE_GRACE_MS + 1000);
        expect(finalizeSpy).not.toHaveBeenCalled();
        expect(tm.tabs.has('a')).toBe(true);
    });

    it('invokes the toast callback when called via the Undo button', () => {
        const tm = makeTm({ withTabs: ['a'] });
        let capturedCallback = null;
        tm.app.showToast = vi.fn((msg, opts) => {
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

// ---- pickNextTab - the bug fix --------------------------------------

describe('pickNextTab - smart next-tab selection', () => {
    it('prefers same workspace + same coder over everything else', () => {
        const tm = makeTm({
            withTabs: [
                { paneId: 'a', workspace: '/wsA', coder: 'opencode' },
                { paneId: 'b', workspace: '/wsB', coder: 'opencode' },
                { paneId: 'c', workspace: '/wsA', coder: 'opencode' }, // best match
                { paneId: 'd', workspace: '/wsA', coder: 'shell' },
            ],
        });
        const closed = tm.tabs.get('a');
        expect(tm.pickNextTab(closed)).toBe('c');
    });

    it('falls back to same workspace, any coder', () => {
        const tm = makeTm({
            withTabs: [
                { paneId: 'a', workspace: '/wsA', coder: 'opencode' },
                { paneId: 'b', workspace: '/wsB', coder: 'opencode' },
                { paneId: 'c', workspace: '/wsA', coder: 'shell' }, // only same workspace
            ],
        });
        expect(tm.pickNextTab(tm.tabs.get('a'))).toBe('c');
    });

    it('falls back to same coder, any workspace', () => {
        const tm = makeTm({
            withTabs: [
                { paneId: 'a', workspace: '/wsA', coder: 'opencode' },
                { paneId: 'b', workspace: '/wsB', coder: 'opencode' }, // same coder
                { paneId: 'c', workspace: '/wsC', coder: 'shell' },
            ],
        });
        expect(tm.pickNextTab(tm.tabs.get('a'))).toBe('b');
    });

    it('falls back to last remaining tab when nothing matches (this was the bug)', () => {
        const tm = makeTm({
            withTabs: [
                { paneId: 'a', workspace: '/wsA', coder: 'opencode' },
                { paneId: 'b', workspace: '/wsZ', coder: 'shell' },  // unrelated
            ],
        });
        expect(tm.pickNextTab(tm.tabs.get('a'))).toBe('b');
    });

    it('returns null when no other tabs survive', () => {
        const tm = makeTm({ withTabs: ['a'] });
        expect(tm.pickNextTab(tm.tabs.get('a'))).toBeNull();
    });

    it('excludes other soft-closing tabs so we never auto-jump onto a fading tab', () => {
        const tm = makeTm({
            withTabs: [
                { paneId: 'a', workspace: '/wsA', coder: 'opencode' },
                { paneId: 'b', workspace: '/wsA', coder: 'opencode' }, // best match BUT soft-closing
                { paneId: 'c', workspace: '/wsZ', coder: 'shell' },
            ],
        });
        // Mark b as already soft-closing (user is in the middle of closing it).
        tm.tabs.get('b').softClosing = true;
        expect(tm.pickNextTab(tm.tabs.get('a'))).toBe('c');
    });

    // The whole point: this is the exact user-reported symptom.
    it('REGRESSION: closing a tab in wsA does NOT jump to an unrelated wsZ tab when a same-workspace tab exists', () => {
        const tm = makeTm({
            withTabs: [
                { paneId: 'project-shell-1', workspace: '/my-project', coder: 'shell' },
                { paneId: 'old-wsZ-tab', workspace: '/wsZ', coder: 'shell' }, // unrelated
                { paneId: 'project-shell-2', workspace: '/my-project', coder: 'shell' }, // same project
            ],
        });
        // User closes project-shell-1 while looking at /my-project. The
        // bug would jump to old-wsZ-tab (last in Map). The fix jumps to
        // project-shell-2 (same workspace).
        expect(tm.pickNextTab(tm.tabs.get('project-shell-1'))).toBe('project-shell-2');
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

// ---- softCloseTab - auto-switch behavior ----------------------------

describe('softCloseTab - auto-switch on active-tab close', () => {
    it('switches to the most-related tab when the active tab is soft-closed', () => {
        const tm = makeTm({
            withTabs: [
                { paneId: 'a', workspace: '/wsA', coder: 'opencode' },
                { paneId: 'b', workspace: '/wsA', coder: 'opencode' },
            ],
            activePaneId: 'a',
        });
        const switchSpy = vi.spyOn(tm, 'switchTab');
        tm.softCloseTab('a');
        expect(switchSpy).toHaveBeenCalledWith('b');
    });

    it('shows the empty state when closing the last tab', () => {
        const tm = makeTm({ withTabs: ['a'], activePaneId: 'a' });
        tm.softCloseTab('a');
        // No tab to switch to - activePaneId cleared, empty state shown.
        expect(tm.activePaneId).toBeNull();
        expect(tm.showEmptyState).toHaveBeenCalled();
    });

    it('does NOT auto-switch when closing a background (non-active) tab', () => {
        const tm = makeTm({
            withTabs: [
                { paneId: 'a', workspace: '/wsA', coder: 'opencode' },
                { paneId: 'b', workspace: '/wsB', coder: 'shell' },
            ],
            activePaneId: 'a',
        });
        const switchSpy = vi.spyOn(tm, 'switchTab');
        tm.softCloseTab('b'); // closing the background tab
        expect(switchSpy).not.toHaveBeenCalled();
        expect(tm.activePaneId).toBe('a'); // still on a
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