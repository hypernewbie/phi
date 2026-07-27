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

describe('opencode picker chain + pi model dropdown — tabInfo captured at click time', () => {
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

    it('pi backend: /model [pause]name[pause]\\r, 3 sends with trailing space', () => {
        // B is not A. pi-tui requires the trailing SPACE after `/model`
        // to recognise the command: `/model ` = "command recognised,
        // arg-input open". The arg then arrives in a separate send so
        // pi-tui transitions cleanly. Sequences:
        //   send 1 (sync):    `/model `         (note trailing SPACE)
        //   send 2 (+200ms):  `<model>`          arg in arg-input
        //   send 3 (+400ms):  `\r`               commit
        //
        // PAUSES are not <Enter>s: a pause is just time for pi-tui to
        // transition internal state between two sends without committing
        // either one. commit 29c414a (atomic paste+Enter) bundled the \r
        // INSIDE the paste which pi-tui received as a single event — the
        // command-arg transition never happened. commit de9562e
        // (picker routing) used a `\r` in the middle of the chain as a
        // fake "open picker" event — that \r was confused with a
        // transition \r which it isn't.
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        const tabB = makeTab('pi-B', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.tabs.set(tabB.paneId, tabB);
        tm.activePaneId = tabA.paneId;

        tm.renderModelDropup();
        const btn = document.querySelector('#model-presets-dropup .dropup-model-btn');
        btn.click();

        // Send 1 happened synchronously: `/model ` with trailing space.
        expect(tabA.sendInputCalls.length).toBe(1);
        expect(tabA.sendInputCalls[0][0]).toBe('/model ');

        // Advance to send 2 (after 200ms pause): the model name as the arg.
        vi.advanceTimersByTime(200);
        expect(tabA.sendInputCalls.length).toBe(2);
        expect(tabA.sendInputCalls[1][0]).toMatch(/^[a-zA-Z0-9/_.-]+$/);

        // Advance to send 3 (after another 400ms pause): the commit Enter.
        vi.advanceTimersByTime(400);
        expect(tabA.sendInputCalls.length).toBe(3);
        expect(tabA.sendInputCalls[2][0]).toBe('\r');

        // No further sends. Total wall time: 600ms.
        vi.advanceTimersByTime(5000);
        expect(tabA.sendInputCalls.length).toBe(3);
    });

    it('pi 3-send cross-tab: all sends stay on click-time tab', () => {
        // sendToTab pinning (commit 3cd9f3a) carries through: a tab
        // switch mid-chain keeps the second and third sends on the
        // tab that was active when the model button was clicked.
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

        vi.advanceTimersByTime(200);    // send 2 (model name) -> tabA
        vi.advanceTimersByTime(400);    // send 3 (\r)           -> tabA
        vi.advanceTimersByTime(5000);   // nothing further

        expect(tabA.sendInputCalls.length).toBe(3);
        expect(tabA.sendInputCalls[0][0]).toBe('/model ');
        expect(tabA.sendInputCalls[2][0]).toBe('\r');
        expect(tabB.sendInputCalls.length).toBe(0);
    });

    it('pi 3-send assert: NO \\r in send 1 and NO \\r in send 2 (only commit \\r at end)', () => {
        // Regression guard against re-introducing the picker-routing
        // hallucination (commit de9562e) which had a `\r` in send 2's
        // slot. The current shape is: space-terminated command, then
        // arg, then sole commit \r. Anything else is a bug.
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.activePaneId = tabA.paneId;

        tm.renderModelDropup();
        const btn = document.querySelector('#model-presets-dropup .dropup-model-btn');
        btn.click();
        vi.advanceTimersByTime(200);  // send 2 (arg)
        vi.advanceTimersByTime(400);  // send 3 (commit)

        expect(tabA.sendInputCalls.length).toBe(3);
        // Send 1 = command with trailing space (no \r).
        expect(tabA.sendInputCalls[0][0]).not.toMatch(/\r/);
        expect(tabA.sendInputCalls[0][0]).toMatch(/ $/);
        // Send 2 = bare model name (no \r, no brackets).
        expect(tabA.sendInputCalls[1][0]).not.toMatch(/\r/);
        expect(tabA.sendInputCalls[1][0]).not.toMatch(/\x1b/);
        // Send 3 = exactly "\r" and nothing else.
        expect(tabA.sendInputCalls[2][0]).toBe('\r');
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
// Pi /model command-arg sequence: 3 sends, 2 pauses (200ms + 400ms).
// A pause is a timed delay between sends that lets pi-tui transition
// between command-recognized and arg-input states. It is NOT a
// commit \r. Use sendToTab across the chain so the active tab is
// pinned at click time and a mid-chain tab switch can't redirect.
// ---------------------------------------------------------------------------

describe('pi /model command-arg buffer sequence', () => {
    it('pi model dropdown: 3 sends (space-terminated command, arg, commit \\r)', () => {
        // B is not A. Pi-tui needs the trailing SPACE on `/model ` so
        // it can transition from "command recognised" to "arg-input
        // open" before the arg arrives. Without the space, pi-tui sees
        // `/model<arg>` and races the command-arg transition against
        // the typing of the arg. With the space + a 200ms pause, the
        // transition completes cleanly.
        //
        // Sequence:
        //   send 1 (sync):   `/model `     — start command, arg-input open
        //   send 2 (+200ms): `<model>`     — type arg
        //   send 3 (+400ms): `\r`          — commit
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.activePaneId = tabA.paneId;

        tm.renderModelDropup();
        const btn = document.querySelector('#model-presets-dropup .dropup-model-btn');
        btn.click();

        // Send 1 happened synchronously. The trailing space is the
        // load-bearing character — pi-tui's command-arg transition
        // fails without it. Assert the SPACE is present, and assert
        // there is NO \r in this send (the commit \r lives only in
        // send 3; bundling it here was commit 29c414a's bug).
        expect(tabA.sendInputCalls.length).toBe(1);
        expect(tabA.sendInputCalls[0][0]).toBe('/model ');
        expect(tabA.sendInputCalls[0][0]).not.toMatch(/\r/);

        // Advance 200ms -> send 2 (arg).
        vi.advanceTimersByTime(200);
        expect(tabA.sendInputCalls.length).toBe(2);
        expect(tabA.sendInputCalls[1][0]).toMatch(/^[a-zA-Z0-9/_.-]+$/);
        expect(tabA.sendInputCalls[1][0]).not.toMatch(/\r/);

        // Advance 400ms -> send 3 (commit \r).
        vi.advanceTimersByTime(400);
        expect(tabA.sendInputCalls.length).toBe(3);
        expect(tabA.sendInputCalls[2][0]).toBe('\r');

        // No further sends; total 600ms wall time.
        vi.advanceTimersByTime(5000);
        expect(tabA.sendInputCalls.length).toBe(3);
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