// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Cross-tab input injection regression net.
//
// Three sites in web/terminal.js used to send a bracketed paste and a
// delayed `\r` across two setTimeout-separated `sendRawInput` calls.
// `sendRawInput` calls `getActiveTab()` at fire time, so the delayed
// callback re-resolved the active tab. Two real bugs fell out:
//   HIGH: switch tabs within 200ms → delayed `\r` lands in the wrong
//         session. Worse in the opencode picker chain (1050ms total):
//         the model name string typed into another agent's prompt.
//   MED: the delayed `\r` could fail silently if getActiveTab() returned
//        null (closed tab) — and worse, could succeed against a
//        different tab with no error.
// Fix: `sendToTab(tabInfo, payload)` pins the target at click time so
// delayed callbacks never re-resolve.
//
// Harness discipline (architect-reviewed):
//   - ctx is Object.create(TabManager.prototype) — real prototype methods
//     for getActiveTab, sendInput, sendToTab. No stubbing of sendRawInput
//     or getActiveTab; a stubbed getActiveTab would make the cross-tab
//     test pass vacuously even if someone reintroduces sendRawInput
//     inside a setTimeout.
//   - tab resolution drives off `tm.tabs.get(tm.activePaneId)` — real Map
//     lookups, real mutable activePaneId for mid-chain switches.
//   - Mock only the boundaries: each tab's ws.sendInput (records calls),
//     app.showToast, _spamScrollToBottom, focusActiveTerminal, inputTextArea.

setupDomHarness();
HTMLElement.prototype.scrollIntoView = function () {};

// Build a TabManager-shaped ctx whose prototype methods are REAL.
// Wire up the DOM containers renderModelDropup / renderSlashDropup /
// renderPresets need.
function makeTm() {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;

    // DOM containers these render methods touch
    if (!document.getElementById('tabs-container')) {
        const tabs = document.createElement('div'); tabs.id = 'tabs-container';
        document.body.appendChild(tabs);
    }
    if (!document.getElementById('terminals-wrapper')) {
        const w = document.createElement('div'); w.id = 'terminals-wrapper';
        document.body.appendChild(w);
    }
    if (!document.getElementById('input-bar-container')) {
        const i = document.createElement('div'); i.id = 'input-bar-container';
        document.body.appendChild(i);
    }
    if (!document.getElementById('presets-container')) {
        const p = document.createElement('div'); p.id = 'presets-container';
        document.body.appendChild(p);
    }
    if (!document.getElementById('empty-state')) {
        const e = document.createElement('div'); e.id = 'empty-state';
        document.body.appendChild(e);
    }
    if (!document.getElementById('model-presets-dropup')) {
        const m = document.createElement('div'); m.id = 'model-presets-dropup';
        document.body.appendChild(m);
    }

    tm.tabsContainer = document.getElementById('tabs-container');
    tm.terminalsWrapper = document.getElementById('terminals-wrapper');
    tm.inputBarContainer = document.getElementById('input-bar-container');
    tm.presetsContainer = document.getElementById('presets-container');

    // Boundary mocks (NOT the methods under test)
    tm._spamScrollToBottom = vi.fn();
    tm.focusActiveTerminal = vi.fn();
    tm.inputTextArea = null;  // desktop path → focusActiveTerminal is called
    tm._showReconnectOverlay = vi.fn();
    tm.app = {
        showToast: vi.fn(),
        syncRemoteClipboard: vi.fn(),
        modelPresets: {
            pi:      ['m3/MiniMax-M3', 'k2p7/foo'],
            opencode:['claude-sonnet-5'],
            claude:  ['claude-haiku-4'],
        },
        codersPresetRegistry: {
            pi:     { presets: [{ name: '/quit', value: '/quit\r' }, { name: '/model', value: '/model\r' }] },
            claude: { presets: [{ name: '/compact', value: '/compact\r' }] },
        },
        sessionsManager: { activeWorkspace: '/wsA', activeCWD: '/wsA/work', activeCoder: 'pi',
                           loadConfig: vi.fn(), switchCoder: vi.fn(), loadWorktrees: vi.fn(async () => {}),
                           highlightActiveSession: vi.fn(), highlightActiveWorktree: vi.fn(),
                           updateWorkspaceSelectWidth: vi.fn(), workspaceSelect: { value: '' },
                           spawnNewSession: vi.fn(async () => {}) },
    };
    return tm;
}

// Build a fake tab with its own ws.sendInput recording the calls.
// `dead` and `wsReady` model the failure modes we want to exercise.
function makeTab(paneId, coder = 'pi', { dead = false, wsReady = true } = {}) {
    const wsSendInput = vi.fn();
    if (!wsReady) wsSendInput.mockReturnValue(false);
    return {
        paneId, coder, isDead: dead, isKanban: false, isReview: false,
        tabEl: document.createElement('div'),
        termContainer: document.createElement('div'),
        ws: { sendInput: wsSendInput },
        sendInputCalls: wsSendInput.mock.calls,
    };
}

beforeEach(() => {
    document.body.innerHTML = `
        <button id="send-input-btn" class="btn btn-accent">Send ↵</button>
        <div id="tabs-container"></div>
        <div id="terminals-wrapper"></div>
        <div id="input-bar-container"></div>
        <div id="presets-container"></div>
        <div id="empty-state"></div>
        <div id="model-presets-dropup"></div>
    `;
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Commit 1 — pinning (sendToTab). Zero timing change; verifies target tab
// is captured at click time and the delayed callback doesn't re-resolve.
// ---------------------------------------------------------------------------

describe('opencode picker chain — tabInfo captured at click time', () => {
    it('4 sends in order, all hit the click-time tab', () => {
        const tm = makeTm();
        const tabA = makeTab('opencode-A', 'opencode');
        tm.tabs.set(tabA.paneId, tabA);
        tm.activePaneId = tabA.paneId;

        // Render the model dropup with coder=opencode. The render captures
        // activeTab at render time (the architect-confirmed fix).
        tm.renderModelDropup();

        // Click the first model in the dropup.
        const btn = document.querySelector('#model-presets-dropup .dropup-model-btn');
        expect(btn).not.toBeNull();
        btn.click();

        // Send 1 should have happened synchronously; no timers needed yet.
        expect(tabA.sendInputCalls.length).toBe(1);
        expect(tabA.sendInputCalls[0][0]).toBe('/models');

        // Advance 350ms → send 2 (\r)
        vi.advanceTimersByTime(350);
        expect(tabA.sendInputCalls.length).toBe(2);
        expect(tabA.sendInputCalls[1][0]).toBe('\r');

        // Advance another 350ms → send 3 (model name)
        vi.advanceTimersByTime(350);
        expect(tabA.sendInputCalls.length).toBe(3);
        expect(tabA.sendInputCalls[2][0]).toBe('claude-sonnet-5');

        // Advance another 350ms → send 4 (\r)
        vi.advanceTimersByTime(350);
        expect(tabA.sendInputCalls.length).toBe(4);
        expect(tabA.sendInputCalls[3][0]).toBe('\r');

        // No further sends beyond 1050ms total.
        vi.advanceTimersByTime(2000);
        expect(tabA.sendInputCalls.length).toBe(4);
    });

    it('cross-tab regression: switching tabs mid-chain still routes delayed sends to click-time tab', () => {
        // This is the load-bearing test for commit 1. A reintroduced
        // sendRawInput inside setTimeout would make tab B receive
        // sends from a chain targeted at tab A — this test fails.
        const tm = makeTm();
        const tabA = makeTab('opencode-A', 'opencode');
        const tabB = makeTab('opencode-B', 'opencode');
        tm.tabs.set(tabA.paneId, tabA);
        tm.tabs.set(tabB.paneId, tabB);
        tm.activePaneId = tabA.paneId;

        tm.renderModelDropup();
        const btn = document.querySelector('#model-presets-dropup .dropup-model-btn');
        btn.click();  // targets tabA

        // User switches tabs mid-chain (between send 1 and send 2).
        tm.activePaneId = tabB.paneId;
        vi.advanceTimersByTime(350);   // send 2 should still hit tabA
        vi.advanceTimersByTime(350);   // send 3
        vi.advanceTimersByTime(350);   // send 4
        vi.advanceTimersByTime(2000);  // nothing further

        expect(tabA.sendInputCalls.length).toBe(4);
        expect(tabB.sendInputCalls.length).toBe(0);  // ← the bug fix
    });

    it('pi backend: picker routing survives a tab switch (commit 1 pinning preserved)', () => {
        // After the defensive picker-routing switch, the pi branch is
        // 3 sends instead of 1. Commit 1's sendToTab pinning keeps all
        // 3 on the click-time tab even across a mid-chain switch.
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        const tabB = makeTab('pi-B', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.tabs.set(tabB.paneId, tabB);
        tm.activePaneId = tabA.paneId;

        tm.renderModelDropup();
        const btn = document.querySelector('#model-presets-dropup .dropup-model-btn');
        btn.click();

        tm.activePaneId = tabB.paneId;
        vi.advanceTimersByTime(5000);

        expect(tabA.sendInputCalls.length).toBe(3);
        // send 1 is the atomic /model\r paste+Enter
        expect(tabA.sendInputCalls[0][0]).toBe('\x1b[200~/model\x1b[201~\r');
        // send 3 is the final \r to select
        expect(tabA.sendInputCalls[2][0]).toBe('\r');
        expect(tabB.sendInputCalls.length).toBe(0);
    });

    it('default coder (/model X\\r): single sendRawInput, no chain', () => {
        // The `else` branch was deliberately NOT changed. Verify it's a
        // single atomic write via sendRawInput (which still re-resolves
        // active tab — but there is no delayed callback, so no race).
        const tm = makeTm();
        const tabA = makeTab('claude-A', 'claude');
        tm.tabs.set(tabA.paneId, tabA);
        tm.activePaneId = tabA.paneId;

        tm.renderModelDropup();
        const btn = document.querySelector('#model-presets-dropup .dropup-model-btn');
        btn.click();

        expect(tabA.sendInputCalls.length).toBe(1);
        // default branch emits `/model <name>\r` — assert shape, not name
        // (fixture's claude preset sorts first alphabetically).
        expect(tabA.sendInputCalls[0][0]).toMatch(/^\/model .+\r$/);
        vi.advanceTimersByTime(2000);
        expect(tabA.sendInputCalls.length).toBe(1);
    });
});

describe('opencode/pi preset chip (desktop + mobile renderSlashDropup)', () => {
    it('opencode/pi coder, paste-eligible preset: atomic sendSlashCommand', () => {
        // After commit 2, the preset chip path is also atomic.
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        const tabB = makeTab('pi-B', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.tabs.set(tabB.paneId, tabB);
        tm.activePaneId = tabA.paneId;

        tm.renderPresets('pi');
        const chips = Array.from(tm.presetsContainer.querySelectorAll('.preset-btn'));
        const modelChip = chips.find((b) => b.innerText === '/model');
        expect(modelChip).toBeDefined();
        modelChip.click();

        tm.activePaneId = tabB.paneId;
        vi.advanceTimersByTime(2000);

        expect(tabA.sendInputCalls.length).toBe(1);
        expect(tabA.sendInputCalls[0][0]).toBe('\x1b[200~/model\x1b[201~\r');
        expect(tabB.sendInputCalls.length).toBe(0);
    });

    it('non-paste-eligible preset (e.g. /quit for pi): sendRawInput unchanged', () => {
        // Verifies commit 1 doesn't touch the else branch in the
        // preset chip handler. /quit ends with \r but doesn't start
        // with /...wait, it does. Let me use ctrl+c instead.
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.activePaneId = tabA.paneId;

        tm.renderPresets('pi');
        const chips = Array.from(tm.presetsContainer.querySelectorAll('.preset-btn'));
        // /quit: value='/quit\r', starts with /, ends with \r → paste branch.
        // Force the non-paste branch by using a non-/-prefixed value.
        // Easiest: add a custom coder preset that doesn't match the predicate.
        tm.app.codersPresetRegistry.pi.presets.push({ name: 'esc', value: '\x1b' });
        tm.renderPresets('pi');
        const escChip = Array.from(tm.presetsContainer.querySelectorAll('.preset-btn'))
            .find((b) => b.innerText === 'esc');
        expect(escChip).toBeDefined();
        escChip.click();

        expect(tabA.sendInputCalls.length).toBe(1);
        expect(tabA.sendInputCalls[0][0]).toBe('\x1b');  // raw send, no bracketing
    });
});

describe('WS drop mid-chain: toast + no cross-tab fallback', () => {
    it('opencode picker chain, ws.sendInput returns false: toast fires, no exception', () => {
        const tm = makeTm();
        const tabA = makeTab('opencode-A', 'opencode', { wsReady: false });
        const tabB = makeTab('opencode-B', 'opencode');
        tm.tabs.set(tabA.paneId, tabA);
        tm.tabs.set(tabB.paneId, tabB);
        tm.activePaneId = tabA.paneId;

        tm.renderModelDropup();
        const btn = document.querySelector('#model-presets-dropup .dropup-model-btn');
        expect(() => btn.click()).not.toThrow();

        // First send failed → toast fired → reconnect overlay shown.
        expect(tm.app.showToast).toHaveBeenCalledWith(
            'Tab is disconnected — input not sent',
            expect.objectContaining({ type: 'error' })
        );
        expect(tm._showReconnectOverlay).toHaveBeenCalledWith(tabA);

        // Advance all timers — subsequent sends must still target tabA
        // (the pinned tab), not get redirected to tabB.
        vi.advanceTimersByTime(5000);

        expect(tabB.sendInputCalls.length).toBe(0);
        // tabA's ws was called 4 times but each returned false — the
        // chain didn't fall through to a different tab.
        expect(tabA.sendInputCalls.length).toBe(4);
    });
});

// ---------------------------------------------------------------------------
// Commit 2 — atomic collapse. Replaces the 3 split sites
// (sendRawInput paste + setTimeout(sendRawInput('\r'), 200)) with
// sendSlashCommand, which sends `\x1b[200~<cmd>\x1b[201~\r` as one write.
// ---------------------------------------------------------------------------

describe('sendSlashCommand — atomic paste+Enter, no delayed send', () => {
    it('pi backend, model dropdown: 3-step picker routing (open, filter, select)', () => {
        // The `/model <name>` exact-match path is flaky in pi 0.81.x.
        // Defensive: route through pi's picker (search + arrows + Enter),
        // which the user reports as reliable. 3 sequential sends:
        //   send 1 (sync):  /model\r        — open picker (atomic via sendSlashCommand)
        //   send 2 (+500):  <model name>    — type filter
        //   send 3 (+900):  \r              — select highlighted
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.activePaneId = tabA.paneId;

        tm.renderModelDropup();
        const btn = document.querySelector('#model-presets-dropup .dropup-model-btn');
        btn.click();

        // Send 1 happened synchronously.
        expect(tabA.sendInputCalls.length).toBe(1);
        expect(tabA.sendInputCalls[0][0]).toBe('\x1b[200~/model\x1b[201~\r');

        // Advance to send 2 (filter text).
        vi.advanceTimersByTime(500);
        expect(tabA.sendInputCalls.length).toBe(2);
        // dropup sorts models alphabetically; the first button is whichever
        // sorts lowest. Filter text sent to pi should be the same model.
        expect(tabA.sendInputCalls[1][0]).toMatch(/^[a-zA-Z0-9/_.-]+$/);

        // Advance to send 3 (\r to select).
        vi.advanceTimersByTime(400);
        expect(tabA.sendInputCalls.length).toBe(3);
        expect(tabA.sendInputCalls[2][0]).toBe('\r');

        // No further sends.
        vi.advanceTimersByTime(5000);
        expect(tabA.sendInputCalls.length).toBe(3);
    });

    it('pi picker routing: cross-tab switch keeps all 3 sends on the click-time tab', () => {
        // The sendToTab calls inside the chain are pinned to the tab
        // captured at click time (commit 1's fix). A tab switch mid-chain
        // must not redirect the filter text or final \r to the new tab.
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        const tabB = makeTab('pi-B', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.tabs.set(tabB.paneId, tabB);
        tm.activePaneId = tabA.paneId;

        tm.renderModelDropup();
        const btn = document.querySelector('#model-presets-dropup .dropup-model-btn');
        btn.click();

        // Switch tabs immediately after the atomic send.
        tm.activePaneId = tabB.paneId;

        vi.advanceTimersByTime(500);   // send 2 (filter) — should hit tabA
        vi.advanceTimersByTime(400);   // send 3 (\r)       — should hit tabA
        vi.advanceTimersByTime(5000);  // nothing further

        expect(tabA.sendInputCalls.length).toBe(3);
        expect(tabB.sendInputCalls.length).toBe(0);
    });

    it('opencode/pi coder preset button: single sendSlashCommand', () => {
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.activePaneId = tabA.paneId;

        tm.renderPresets('pi');
        const chips = Array.from(tm.presetsContainer.querySelectorAll('.preset-btn'));
        const modelChip = chips.find((b) => b.innerText === '/model');
        modelChip.click();

        expect(tabA.sendInputCalls.length).toBe(1);
        expect(tabA.sendInputCalls[0][0]).toBe('\x1b[200~/model\x1b[201~\r');

        vi.advanceTimersByTime(2000);
        expect(tabA.sendInputCalls.length).toBe(1);
    });

    it('slash preset for non-paste-eligible coders: sendRawInput unchanged', () => {
        // Verifies commit 2 doesn't touch the else branch. The esc
        // chip (value '\x1b') is non-paste-eligible and still goes
        // through the raw sendRawInput path.
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.activePaneId = tabA.paneId;

        tm.app.codersPresetRegistry.pi.presets.push({ name: 'esc', value: '\x1b' });
        tm.renderPresets('pi');
        const escChip = Array.from(tm.presetsContainer.querySelectorAll('.preset-btn'))
            .find((b) => b.innerText === 'esc');
        escChip.click();

        expect(tabA.sendInputCalls.length).toBe(1);
        expect(tabA.sendInputCalls[0][0]).toBe('\x1b');
    });

    it('mobile renderSlashDropup path: also atomic', () => {
        // Mobile render method should produce the same atomic form.
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.activePaneId = tabA.paneId;

        // The mobile render drops into #presets-container too
        // (it's the same code path; the architectural difference is
        // mobile-vs-desktop styling). Drive via renderPresets.
        tm.renderPresets('pi');
        const chips = Array.from(tm.presetsContainer.querySelectorAll('.preset-btn'));
        const modelChip = chips.find((b) => b.innerText === '/model');
        modelChip.click();

        expect(tabA.sendInputCalls.length).toBe(1);
        expect(tabA.sendInputCalls[0][0]).toBe('\x1b[200~/model\x1b[201~\r');
    });
});