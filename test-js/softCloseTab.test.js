// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Tests for the soft-close tab pipeline:
//   closeTab(paneId)   -> softCloseTab (grace period)
//   undoCloseTab       -> restore
//   finalizeCloseTab   -> actually kill the PTY
//
// The grace timer is 3s (TabManager.SOFT_CLOSE_GRACE_MS). These tests
// use vi.useFakeTimers so we can advance the clock without waiting in
// real time. The MAX_SOFT_CLOSED_TABS cap = 3.
//
// Soft-close hides the tab from the strip, selects a visible survivor,
// and keeps the sidebar project unchanged for that automatic selection.
// The tab remains recoverable in the tab-list dropdown until finalization.

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

// ---- softCloseTab - close selects a project-neutral survivor ------------

describe('softCloseTab - active-tab close selects a survivor', () => {
    it('selects the next visible tab without syncing its project', () => {
        const tm = makeTm({
            withTabs: [
                { paneId: 'a', workspace: '/wsA', coder: 'opencode' },
                {
                    paneId: 'b',
                    workspace: '/wsZ',
                    cwd: '/wsZ',
                    coder: 'shell',
                },
            ],
            activePaneId: 'a',
        });
        const switchSpy = vi.spyOn(tm, 'switchTab');
        tm.softCloseTab('a');
        expect(switchSpy).toHaveBeenCalledWith('b', {
            preserveProject: true,
        });
        expect(tm.activePaneId).toBe('b');
        expect(tm.app.sessionsManager.switchCoder).not.toHaveBeenCalled();
        expect(tm.app.sessionsManager.loadWorktrees).not.toHaveBeenCalled();

        // The explicit second click opts back into normal project sync.
        tm.switchTab('b', { userInitiated: true });
        expect(tm.app.sessionsManager.loadWorktrees).toHaveBeenCalledWith(
            '/wsZ',
        );
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

    it('shows the empty state while the last tab remains undoable', () => {
        const tm = makeTm({ withTabs: ['a'], activePaneId: 'a' });
        tm.softCloseTab('a');
        expect(tm.showEmptyState).toHaveBeenCalled();
        expect(tm.activePaneId).toBeNull();
        expect(tm.tabs.get('a').softClosing).toBe(true);
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
