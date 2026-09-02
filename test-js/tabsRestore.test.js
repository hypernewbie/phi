// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Tab restoration across server reload. The user's question: "now it
// DOES save leftover sessions and CAN restart the tabs on restart yes?"
// — the answer needs to be backed by tests that actually exercise the
// save → reload → restore path.
//
// Two halves:
//   - SERVER side: sessions.json round-trip (proven in pkg/session tests:
//     TestSessionMeta_RoundTripAcrossRestart, +LoadOnEmptyFileDoesNotCrash,
//     +LoadOnCorruptFileDoesNotLoseData).
//   - CLIENT side: restoreTabsState fetches /api/terminals and rebuilds
//     tabs from the response. Tests here close that gap. We spy on
//     createTab to assert it's called with the right arguments per
//     server-side entry — without going through the full createTab body
//     that touches DOM elements this test doesn't fully wire up.

setupDomHarness();

function makeTm() {
    document.body.innerHTML = `<div id="tabs-container"></div>`;
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;
    tm.app = {
        showToast: vi.fn(),
        hideEmptyState: vi.fn(),
        sessionsManager: { activeCoder: 'shell' },
    };
    // TabManager methods called by restoreTabsState — spy on them so we
    // can assert call shape without invoking their (DOM-heavy) bodies.
    tm.showEmptyState = vi.fn();
    tm.switchTab = vi.fn();
    tm.applySavedTabOrder = vi.fn();
    // createTab spy mirrors just enough of its real behaviour to keep
    // restoreTabsState's downstream logic working: it adds a stub entry
    // to tm.tabs so the "saved active pane present?" check works. The
    // *call shape* is still asserted via the spy, so we test what the
    // production code passes without invoking the DOM-heavy body.
    tm.createTab = vi.fn((paneId) => {
        tm.tabs.set(paneId, { paneId });
    });
    return { tm };
}

function jsonResp(obj, ok = true, status = 200) {
    return {
        ok,
        status,
        headers: { get: () => null },
        json: async () => obj,
        text: async () => '',
    };
}

describe('restoreTabsState rebuilds tabs from /api/terminals', () => {
    it('GETs /api/terminals on startup', async () => {
        let sawUrl = null;
        const { tm } = makeTm();
        mockFetch((url) => {
            sawUrl = url;
            return [];
        });
        await tm.restoreTabsState();
        expect(sawUrl).toBe('/api/terminals');
    });

    it('calls createTab once per server-side terminal entry, in order', async () => {
        const { tm } = makeTm();
        mockFetch(() => [
            {
                id: 'p1',
                session_id: 's1',
                title: 'pi:tab',
                coder: 'pi',
                workspace: '/w',
                cwd: '/w',
                pinned: false,
                marked: false,
            },
            {
                id: 'p2',
                session_id: 's2',
                title: 'claude',
                coder: 'claude',
                workspace: '/w',
                cwd: '/w',
                pinned: false,
                marked: false,
            },
            {
                id: 'p3',
                session_id: 's3',
                title: 'shell',
                coder: 'bash',
                workspace: '/w',
                cwd: '/w',
                pinned: false,
                marked: false,
            },
        ]);
        await tm.restoreTabsState();

        expect(tm.createTab).toHaveBeenCalledTimes(3);
        const calls = tm.createTab.mock.calls.map((c) => c.join('|'));
        expect(calls[0]).toBe('p1|s1|pi:tab|pi|/w|/w|false|false');
        expect(calls[1]).toBe('p2|s2|claude|claude|/w|/w|false|false');
        expect(calls[2]).toBe('p3|s3|shell|bash|/w|/w|false|false');
    });

    it('forwards pinned and marked flags so the tab UI renders them', async () => {
        const { tm } = makeTm();
        mockFetch(() => [
            {
                id: 'p1',
                session_id: 's1',
                title: 'x',
                coder: 'pi',
                workspace: '/w',
                cwd: '/w',
                pinned: true,
                marked: true,
            },
        ]);
        await tm.restoreTabsState();
        expect(tm.createTab.mock.calls[0].slice(6, 8)).toEqual([true, true]);
    });

    it('shows empty state when the server has no terminals', async () => {
        const { tm } = makeTm();
        mockFetch(() => []);
        await tm.restoreTabsState();
        expect(tm.showEmptyState).toHaveBeenCalled();
        expect(tm.createTab).not.toHaveBeenCalled();
    });

    it('clears the legacy "phi_tabs" localStorage entry on startup', async () => {
        // An earlier phi stored tabs in localStorage. The current
        // server-side model replaces that, but a stale phi_tabs entry
        // would persist if we didn't sweep it.
        localStorage.setItem('phi_tabs', '[]');
        const { tm } = makeTm();
        mockFetch(() => []);
        await tm.restoreTabsState();
        expect(localStorage.getItem('phi_tabs')).toBeNull();
    });

    it("calls applySavedTabOrder so the user's drag-reorder is restored", async () => {
        const { tm } = makeTm();
        const applySpy = vi.spyOn(tm, 'applySavedTabOrder');
        mockFetch(() => [
            {
                id: 'p1',
                session_id: 's1',
                title: 'a',
                coder: 'pi',
                workspace: '/w',
                cwd: '/w',
            },
            {
                id: 'p2',
                session_id: 's2',
                title: 'b',
                coder: 'bash',
                workspace: '/w',
                cwd: '/w',
            },
        ]);
        await tm.restoreTabsState();
        expect(applySpy).toHaveBeenCalledTimes(1);
    });

    it('preserves the saved active pane from phi_active_pane localStorage', async () => {
        const { tm } = makeTm();
        localStorage.setItem('phi_active_pane', 'p2');
        mockFetch(() => [
            {
                id: 'p1',
                session_id: 's1',
                title: 'a',
                coder: 'pi',
                workspace: '/w',
                cwd: '/w',
            },
            {
                id: 'p2',
                session_id: 's2',
                title: 'b',
                coder: 'bash',
                workspace: '/w',
                cwd: '/w',
            },
        ]);
        await tm.restoreTabsState();
        // switchTab('p2') should be called last to focus the saved pane.
        const switchCalls = tm.switchTab.mock.calls;
        expect(switchCalls.some((c) => c[0] === 'p2')).toBe(true);
    });

    it('falls back to switching the first tab when no saved active pane exists', async () => {
        const { tm } = makeTm();
        localStorage.removeItem('phi_active_pane');
        mockFetch(() => [
            {
                id: 'p1',
                session_id: 's1',
                title: 'a',
                coder: 'pi',
                workspace: '/w',
                cwd: '/w',
            },
            {
                id: 'p2',
                session_id: 's2',
                title: 'b',
                coder: 'bash',
                workspace: '/w',
                cwd: '/w',
            },
        ]);
        await tm.restoreTabsState();
        expect(tm.switchTab).toHaveBeenCalledWith('p1');
    });

    it('does not crash when /api/terminals returns a non-OK status', async () => {
        const { tm } = makeTm();
        mockFetch(() => jsonResp({}, false, 500));
        // Production catches + console.errors, then resolves normally
        // (so app.js:179's await doesn't throw). Crucially, no tabs
        // should be created and no switching should happen.
        let threw = false;
        try {
            await tm.restoreTabsState();
        } catch (_) {
            threw = true;
        }
        expect(threw).toBe(false);
        expect(tm.createTab).not.toHaveBeenCalled();
        expect(tm.switchTab).not.toHaveBeenCalled();
    });

    it('handles titled-as-coder fallback: t.title || t.coder', async () => {
        const { tm } = makeTm();
        mockFetch(() => [
            {
                id: 'p1',
                session_id: 's1',
                title: '',
                coder: 'pi',
                workspace: '/w',
                cwd: '/w',
            },
        ]);
        await tm.restoreTabsState();
        // Title falls back to the coder name.
        expect(tm.createTab.mock.calls[0][2]).toBe('pi');
    });
});
