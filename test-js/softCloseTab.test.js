// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Tests for the soft-close tab pipeline:
//   closeTab(paneId)   -> softCloseTab (grace period)
//   undoCloseTab       -> restore
//   finalizeCloseTab   -> actually kill the PTY
//
// The grace timer is 5s (TabManager.SOFT_CLOSE_GRACE_MS). These tests
// use vi.useFakeTimers so we can advance the clock without waiting in
// real time. The MAX_SOFT_CLOSED_TABS cap = 3.
//
// pickNextTab was removed: soft-close never auto-switches the active
// tab. The active tab stays in place with a spinner overlay during the
// grace; only finalize (after grace expires) commits to "tab is gone,"
// and at that point if it's the last tab we show the empty state. This
// is the fix for the user-reported "closing a tab jumps me to a random
// unrelated project" bug, plus the related "big white XX tab" visual
// complaint (line-through on title + still-visible × read as XX).

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

// ---- pickNextTab removed (no auto-switch on close) -----------------

describe('pickNextTab - removed', () => {
    it('pickNextTab no longer exists on TabManager.prototype', () => {
        // The picker was removed in favor of "stay on the closing tab
        // with a spinner overlay". The priority chain was a band-aid
        // for the wrong problem (auto-switching is the problem, not
        // which tab to switch to).
        expect(typeof TabManager.prototype.pickNextTab).toBe('undefined');
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

// ---- softCloseTab - stay-on-closing-tab behavior --------------------

describe('softCloseTab - active-tab close keeps the user where they are', () => {
    it('does NOT switch tabs when the active tab is soft-closed', () => {
        const tm = makeTm({
            withTabs: [
                { paneId: 'a', workspace: '/wsA', coder: 'opencode' },
                { paneId: 'b', workspace: '/wsZ', coder: 'shell' },
            ],
            activePaneId: 'a',
        });
        const switchSpy = vi.spyOn(tm, 'switchTab');
        tm.softCloseTab('a');
        // No surprise jump to an unrelated project.
        expect(switchSpy).not.toHaveBeenCalled();
        expect(tm.activePaneId).toBe('a');
    });

    it('does NOT show the empty state immediately when closing the only tab', () => {
        // The previous behavior surfaced the empty state right away on the
        // last-tab close. New behavior: keep the user on the fading tab
        // with the spinner overlay, and only commit to "empty" when the
        // grace expires (finalizeCloseTab).
        const tm = makeTm({ withTabs: ['a'], activePaneId: 'a' });
        tm.softCloseTab('a');
        expect(tm.showEmptyState).not.toHaveBeenCalled();
        expect(tm.activePaneId).toBe('a');
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
        expect(tm.activePaneId).toBe('a');
    });

    it('active-tab close mounts a content overlay over the terminal', () => {
        const tm = makeTm({
            withTabs: [{ paneId: 'a' }],
            activePaneId: 'a',
        });
        tm.softCloseTab('a');
        const tab = tm.tabs.get('a');
        expect(tab.softCloseOverlay).toBeTruthy();
        // Overlay is appended to the tab's termContainer.
        expect(tab.termContainer.contains(tab.softCloseOverlay)).toBe(true);
        expect(tab.softCloseOverlay.classList.contains('tab-soft-close-overlay')).toBe(true);
        // Overlay shows a countdown + an undo hint.
        const text = tab.softCloseOverlay.textContent;
        expect(text).toMatch(/Closing in/);
        expect(text).toMatch(/undo/i);
    });

    it('background-tab close does NOT mount a content overlay', () => {
        // Background tabs close invisibly — only the strip pill and the
        // toast should appear, no content overlay (the user isn't on
        // that tab).
        const tm = makeTm({
            withTabs: [{ paneId: 'a' }, { paneId: 'b' }],
            activePaneId: 'a',
        });
        tm.softCloseTab('b');
        const tab = tm.tabs.get('b');
        expect(tab.softCloseOverlay).toBeFalsy();
    });

    it('adds a countdown pill to the strip entry', () => {
        const tm = makeTm({
            withTabs: [{ paneId: 'a' }, { paneId: 'b' }],
            activePaneId: 'a',
        });
        tm.softCloseTab('b');
        const tab = tm.tabs.get('b');
        expect(tab.softClosePill).toBeTruthy();
        expect(tab.tabEl.contains(tab.softClosePill)).toBe(true);
        expect(tab.softClosePill.classList.contains('tab-soft-close-pill')).toBe(true);
        // Initial value counts down from the full grace period.
        expect(tab.softClosePill.textContent).toMatch(/^\d+s$/);
    });

    it('pill countdown ticks down as the clock advances', () => {
        const tm = makeTm({
            withTabs: [{ paneId: 'a' }, { paneId: 'b' }],
            activePaneId: 'a',
        });
        tm.softCloseTab('b');
        const tab = tm.tabs.get('b');
        const initial = tab.softClosePill.textContent;
        vi.advanceTimersByTime(2500); // 2.5s in
        const later = tab.softClosePill.textContent;
        // Pill should now show a smaller number.
        const initialSec = parseInt(initial, 10);
        const laterSec = parseInt(later, 10);
        expect(laterSec).toBeLessThan(initialSec);
    });

    it('drops the line-through on the title (no more "X\'d out" visual)', () => {
        // Regression for the "big white XX tab" report: the previous
        // styling put a strikethrough on the title, which literally read
        // as a line through the word plus the still-visible × = an XX
        // shape. The CSS for .tab.soft-closed .tab-title must NOT use
        // text-decoration: line-through anymore.
        const tm = makeTm({ withTabs: ['a'], activePaneId: 'a' });
        tm.softCloseTab('a');
        const tab = tm.tabs.get('a');
        // We can't actually test computed CSS here (jsdom doesn't run
        // our stylesheet), but we can verify the production CSS rule no
        // longer carries line-through by reading the file.
        const fs = require('fs');
        const css = fs.readFileSync('web/style.css', 'utf8');
        // Strip comments so a "/* ... strikethrough ... */" in the comment
        // doesn't trigger a false positive on the literal string.
        const cssStripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
        const ruleMatch = cssStripped.match(/\.tab\.soft-closed\s+\.tab-title\s*\{[^}]*\}/);
        expect(ruleMatch).toBeTruthy();
        expect(ruleMatch[0]).not.toMatch(/line-through/);
    });

    it('CSS toggle hides .tab-close and reveals .tab-reopen on soft-closed tabs', () => {
        // The previous code had inline style="display:none" on .tab-reopen
        // with no JS or CSS to undo it. Now CSS controls visibility based
        // on the .soft-closed class.
        const fs = require('fs');
        const css = fs.readFileSync('web/style.css', 'utf8');
        expect(css).toMatch(/\.tab \.tab-reopen\s*\{\s*display:\s*none/);
        expect(css).toMatch(/\.tab\.soft-closed \.tab-close\s*\{\s*display:\s*none/);
        expect(css).toMatch(/\.tab\.soft-closed \.tab-reopen\s*\{\s*display:\s*flex/);
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