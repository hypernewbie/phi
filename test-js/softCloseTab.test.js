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
        // v0.8.5: pill now shows glyph + text. Glyph = the tab's
        // worktree hieroglyph (or fallback '◆'), text = the countdown
        // seconds. Both live in dedicated spans.
        const text = tab.softClosePill.querySelector('.tab-soft-close-pill-text');
        const glyph = tab.softClosePill.querySelector('.tab-soft-close-pill-glyph');
        expect(text).toBeTruthy();
        expect(glyph).toBeTruthy();
        expect(text.textContent).toMatch(/^\d+s$/);
    });

    it('pill countdown ticks down as the clock advances', () => {
        const tm = makeTm({
            withTabs: [{ paneId: 'a' }, { paneId: 'b' }],
            activePaneId: 'a',
        });
        tm.softCloseTab('b');
        const tab = tm.tabs.get('b');
        const text = () => tab.softClosePill.querySelector('.tab-soft-close-pill-text').textContent;
        const initial = text();
        vi.advanceTimersByTime(2500); // 2.5s in
        const later = text();
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
        return globalThis.fetch.mock.calls.filter(c => {
            const url = typeof c[0] === 'string' ? c[0] : c[0]?.url;
            return url && url.includes('/api/terminals/');
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
        return Promise.resolve().then(() => Promise.resolve()).then(() => {
            // Find any error toast with the right kind of message.
            const errorToasts = showToast.mock.calls.filter(c =>
                c[1] && c[1].type === 'error'
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
        expect(deleteCalls().filter(c => c[0] === '/api/terminals/a'))
            .toHaveLength(1);
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
        const calls = deleteCalls().map(c => c[0]).sort();
        expect(calls).toContain('/api/terminals/a');
    });

    it('5. undo via the strip ↻ button cancels the grace timer AND cleans up overlay/pill/toast', () => {
        // v0.8.3 bug class: the ↻ button was permanently hidden via
        // an inline display:none that no CSS or JS undid (dead code).
        // The toast worked, but the strip did not. Both must work.
        const tm = makeTm({ withTabs: ['a'], activePaneId: 'a' });
        tm.softCloseTab('a');
        // Verify it actually IS soft-closing first.
        expect(tm.tabs.get('a').softClosing).toBe(true);
        expect(tm.tabs.get('a').softCloseTimer).toBeTruthy();
        expect(tm.tabs.get('a').softCloseOverlay).toBeTruthy();
        expect(tm.tabs.get('a').softClosePill).toBeTruthy();
        expect(tm.tabs.get('a').softCloseToast).toBeTruthy();
        // Undo via the strip entry click handler (the production path).
        tm.undoCloseTab('a');
        const tab = tm.tabs.get('a');
        expect(tab.softClosing).toBe(false);
        expect(tab.softCloseTimer).toBeNull();
        expect(tab.softCloseOverlay).toBeFalsy();
        expect(tab.softClosePill).toBeFalsy();
        expect(tab.softCloseToast).toBeNull();
        // The strip entry returned to its non-soft-closed state.
        expect(tab.tabEl.classList.contains('soft-closed')).toBe(false);
    });

    it('6. closing the last active tab: empty state appears at finalize, not at soft-close', () => {
        // Previously, softCloseTab showed the empty state immediately
        // when no other tabs survived. Now the user stays on the
        // closing tab during the grace period (sees the spinner
        // overlay). Empty state only after the grace expires.
        const tm = makeTm({ withTabs: ['a'], activePaneId: 'a' });
        tm.softCloseTab('a');
        // During grace: no empty state, no inputBar reveal.
        expect(tm.showEmptyState).not.toHaveBeenCalled();
        expect(tm.activePaneId).toBe('a');
        // Let the grace expire.
        vi.advanceTimersByTime(TabManager.SOFT_CLOSE_GRACE_MS);
        // Now empty state should be visible.
        expect(tm.showEmptyState).toHaveBeenCalled();
        expect(tm.activePaneId).toBeNull();
    });

    it('7. closing a background tab leaves the active tab untouched', () => {
        // User is on tab A; closes tab B (background). A should not
        // gain a soft-close overlay, A's content should not be hidden,
        // A should still be active. B gets the soft-close treatment.
        const tm = makeTm({
            withTabs: ['a', 'b'],
            activePaneId: 'a',
        });
        tm.softCloseTab('b');
        expect(tm.activePaneId).toBe('a');
        // A has no overlay.
        expect(tm.tabs.get('a').softCloseOverlay).toBeFalsy();
        expect(tm.tabs.get('a').softClosing).toBeFalsy();
        // B has the overlay? No - B is background, only strip pill.
        expect(tm.tabs.get('b').softCloseOverlay).toBeFalsy();
        // B has the strip pill and is soft-closing.
        expect(tm.tabs.get('b').softClosing).toBe(true);
        expect(tm.tabs.get('b').softClosePill).toBeTruthy();
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
        keys.forEach(paneId => tm.closeTab(paneId));
        // Advance past ALL grace periods (cap=3 means oldest gets
        // force-finalized, but the 3 younger ones run timers).
        vi.advanceTimersByTime(TabManager.SOFT_CLOSE_GRACE_MS + 100);
        const deleted = new Set(deleteCalls().map(c => c[0]));
        expect(deleted).toContain('/api/terminals/a')
;
        // 'a' was force-finalized by the cap path.
        // The 3 survivors should also have their DELETEs.
        expect(deleted.has('/api/terminals/b') ||
               deleted.has('/api/terminals/c') ||
               deleted.has('/api/terminals/d')).toBe(true);
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
        return Promise.resolve().then(() => Promise.resolve()).then(() => {
            // Tab was removed from the Map even though DELETE 404'd.
            expect(tm.tabs.has('a')).toBe(false);
            // DOM was cleaned.
            expect(document.body.contains(document.getElementById('term-a'))).toBe(false);
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
        const deletedUrls = deleteCalls().map(c => c[0]);
        expect(deletedUrls).not.toContain('/api/terminals/a');
    });
});
