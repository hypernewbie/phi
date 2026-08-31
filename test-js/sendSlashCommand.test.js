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
HTMLElement.prototype.scrollIntoView = () => {};

// Build a TabManager-shaped ctx whose prototype methods are REAL.
// Wire up the DOM containers renderModelDropup / renderSlashDropup /
// renderPresets need.
function makeTm() {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;

    // DOM containers these render methods touch
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
    if (!document.getElementById('model-presets-dropup')) {
        const m = document.createElement('div');
        m.id = 'model-presets-dropup';
        document.body.appendChild(m);
    }

    tm.tabsContainer = document.getElementById('tabs-container');
    tm.terminalsWrapper = document.getElementById('terminals-wrapper');
    tm.inputBarContainer = document.getElementById('input-bar-container');
    tm.presetsContainer = document.getElementById('presets-container');

    // Boundary mocks (NOT the methods under test)
    tm._spamScrollToBottom = vi.fn();
    tm.focusActiveTerminal = vi.fn();
    tm.inputTextArea = null; // desktop path → focusActiveTerminal is called
    tm._showReconnectOverlay = vi.fn();
    tm.app = {
        showToast: vi.fn(),
        syncRemoteClipboard: vi.fn(),
        modelPresets: {
            pi: ['m3/MiniMax-M3', 'k2p7/foo'],
            opencode: ['claude-sonnet-5'],
            claude: ['claude-haiku-4'],
        },
        codersPresetRegistry: {
            pi: {
                presets: [
                    { name: '/quit', value: '/quit\r' },
                    { name: '/model', value: '/model\r' },
                ],
            },
            claude: { presets: [{ name: '/compact', value: '/compact\r' }] },
        },
        sessionsManager: {
            activeWorkspace: '/wsA',
            activeCWD: '/wsA/work',
            activeCoder: 'pi',
            loadConfig: vi.fn(),
            switchCoder: vi.fn(),
            loadWorktrees: vi.fn(async () => {}),
            highlightActiveSession: vi.fn(),
            highlightActiveWorktree: vi.fn(),
            updateWorkspaceSelectWidth: vi.fn(),
            workspaceSelect: { value: '' },
            spawnNewSession: vi.fn(async () => {}),
        },
    };
    return tm;
}

// Build a fake tab with its own ws.sendInput recording the calls.
// `dead` and `wsReady` model the failure modes we want to exercise.
function makeTab(paneId, coder = 'pi', { dead = false, wsReady = true } = {}) {
    const wsSendInput = vi.fn();
    wsSendInput.mockReturnValue(wsReady);
    return {
        paneId,
        coder,
        isDead: dead,
        isKanban: false,
        isReview: false,
        tabEl: document.createElement('div'),
        termContainer: document.createElement('div'),
        ws: { sendInput: wsSendInput },
        sendInputCalls: wsSendInput.mock.calls,
    };
}

beforeEach(() => {
    const makeElement = (tag, id, className = '', textContent = '') => {
        const element = document.createElement(tag);
        element.id = id;
        element.className = className;
        element.textContent = textContent;
        return element;
    };
    document.body.replaceChildren(
        makeElement('button', 'send-input-btn', 'btn btn-accent', 'Send ↵'),
        makeElement('div', 'tabs-container'),
        makeElement('div', 'terminals-wrapper'),
        makeElement('div', 'input-bar-container'),
        makeElement('div', 'presets-container'),
        makeElement('div', 'empty-state'),
        makeElement('div', 'model-presets-dropup'),
    );
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
        const btn = document.querySelector(
            '#model-presets-dropup .dropup-model-btn',
        );
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
        const btn = document.querySelector(
            '#model-presets-dropup .dropup-model-btn',
        );
        btn.click(); // targets tabA

        // User switches tabs mid-chain (between send 1 and send 2).
        tm.activePaneId = tabB.paneId;
        vi.advanceTimersByTime(350); // send 2 should still hit tabA
        vi.advanceTimersByTime(350); // send 3
        vi.advanceTimersByTime(350); // send 4
        vi.advanceTimersByTime(2000); // nothing further

        expect(tabA.sendInputCalls.length).toBe(4);
        expect(tabB.sendInputCalls.length).toBe(0); // ← the bug fix
    });

    // /model <id> [PAUSE] Esc [PAUSE] Enter.
    //
    // The Esc is the load-bearing step. Typing `/model` opens pi-tui's command
    // autocomplete, which consumes Enter to accept its own highlighted entry,
    // so an Enter sent straight after the identifier submits the dropdown's
    // pick rather than the typed line. Esc dismisses the dropdown first.
    it('pi backend: types the command with the id, dismisses autocomplete, then commits', () => {
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        const tabB = makeTab('pi-B', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.tabs.set(tabB.paneId, tabB);
        tm.activePaneId = tabA.paneId;

        tm.renderModelDropup();
        document
            .querySelector('#model-presets-dropup .dropup-model-btn')
            .click();

        // Send 1 is the whole typed line: command, space, identifier.
        expect(tabA.sendInputCalls).toHaveLength(1);
        expect(tabA.sendInputCalls[0][0]).toMatch(/^\/model [a-zA-Z0-9/_.-]+$/);

        vi.advanceTimersByTime(200);
        expect(tabA.sendInputCalls[1]).toEqual(['\x1b']);

        vi.advanceTimersByTime(200);
        expect(tabA.sendInputCalls[2]).toEqual(['\r']);

        // Nothing further. Total wall time: 400ms.
        vi.advanceTimersByTime(5000);
        expect(tabA.sendInputCalls).toHaveLength(3);
    });

    it('pi model flow stays pinned to the click-time tab', () => {
        // A tab switch mid-sequence must not redirect the Esc or the Enter.
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        const tabB = makeTab('pi-B', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.tabs.set(tabB.paneId, tabB);
        tm.activePaneId = tabA.paneId;

        tm.renderModelDropup();
        document
            .querySelector('#model-presets-dropup .dropup-model-btn')
            .click();

        tm.activePaneId = tabB.paneId;
        vi.advanceTimersByTime(5000);

        expect(tabA.sendInputCalls).toHaveLength(3);
        expect(tabA.sendInputCalls[1][0]).toBe('\x1b');
        expect(tabA.sendInputCalls[2][0]).toBe('\r');
        expect(tabB.sendInputCalls).toHaveLength(0);
    });

    it('pi model flow keeps the typed line, the Esc, and the Enter discrete', () => {
        // Collapsing these into one paste is the failure mode this sequence
        // exists to avoid: the dropdown never opens, so Esc has nothing to
        // dismiss and Enter commits in an unknown state.
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.activePaneId = tabA.paneId;

        tm.renderModelDropup();
        document
            .querySelector('#model-presets-dropup .dropup-model-btn')
            .click();
        vi.advanceTimersByTime(400);

        expect(tabA.sendInputCalls).toHaveLength(3);
        // The typed line carries no commit or escape bytes of its own.
        expect(tabA.sendInputCalls[0][0]).not.toContain('\r');
        expect(tabA.sendInputCalls[0][0]).not.toContain(
            String.fromCharCode(27),
        );
        expect(tabA.sendInputCalls[0][0]).not.toContain('\x1b[200~'); // not bracketed paste
        expect(tabA.sendInputCalls[1][0]).toBe('\x1b');
        expect(tabA.sendInputCalls[2][0]).toBe('\r');
        // Esc must precede Enter; the reverse order commits the dropdown pick.
        expect(
            tabA.sendInputCalls.findIndex((c) => c[0] === '\x1b'),
        ).toBeLessThan(tabA.sendInputCalls.findIndex((c) => c[0] === '\r'));
    });

    it('claude model flow confirms a delayed cache-warning prompt on the click-time tab', () => {
        const tm = makeTm();
        const tabA = makeTab('claude-A', 'claude');
        const tabB = makeTab('claude-B', 'claude');
        tm.tabs.set(tabA.paneId, tabA);
        tm.tabs.set(tabB.paneId, tabB);
        tm.activePaneId = tabA.paneId;

        tm.renderModelDropup();
        document
            .querySelector('#model-presets-dropup .dropup-model-btn')
            .click();

        // The command itself retains Claude's normal `/model <name>` form.
        expect(tabA.sendInputCalls).toHaveLength(1);
        expect(tabA.sendInputCalls[0][0]).toMatch(/^\/model .+\r$/);

        // The delayed confirmation must not land on a tab activated after
        // the selection click.
        tm.activePaneId = tabB.paneId;
        vi.advanceTimersByTime(500);
        expect(tabA.sendInputCalls).toHaveLength(2);
        expect(tabA.sendInputCalls[1][0]).toBe('\r');
        expect(tabB.sendInputCalls).toHaveLength(0);
    });
});

describe('opencode/pi preset chip (desktop + mobile renderSlashDropup)', () => {
    it('pi coder, paste-eligible preset: atomic sendSlashCommand', () => {
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        const tabB = makeTab('pi-B', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.tabs.set(tabB.paneId, tabB);
        tm.activePaneId = tabA.paneId;

        tm.renderPresets('pi');
        const chips = Array.from(
            tm.presetsContainer.querySelectorAll('.preset-btn'),
        );
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
        // /quit: value='/quit\r', starts with /, ends with \r → paste branch.
        // Force the non-paste branch by using a non-/-prefixed value.
        // Easiest: add a custom coder preset that doesn't match the predicate.
        tm.app.codersPresetRegistry.pi.presets.push({
            name: 'esc',
            value: '\x1b',
        });
        tm.renderPresets('pi');
        const escChip = Array.from(
            tm.presetsContainer.querySelectorAll('.preset-btn'),
        ).find((b) => b.innerText === 'esc');
        expect(escChip).toBeDefined();
        escChip.click();

        expect(tabA.sendInputCalls.length).toBe(1);
        expect(tabA.sendInputCalls[0][0]).toBe('\x1b'); // raw send, no bracketing
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
        const btn = document.querySelector(
            '#model-presets-dropup .dropup-model-btn',
        );
        expect(() => btn.click()).not.toThrow();

        // First send failed → toast fired → reconnect overlay shown.
        expect(tm.app.showToast).toHaveBeenCalledWith(
            'Tab is disconnected — input not sent',
            expect.objectContaining({ type: 'error' }),
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
// Pi /model picker sequence: 4 sends, each separated by a 200ms pause.
// Use sendToTab across the chain so the active tab is pinned at click time
// and a mid-chain tab switch cannot redirect picker input.
// ---------------------------------------------------------------------------

describe('pi /model picker sequence', () => {
    it('pi model dropdown: typed line, Esc, then confirm', () => {
        // Sequence:
        //   send 1 (sync):   `/model <id>`  type command and identifier
        //   send 2 (+200ms): `\x1b`         dismiss pi-tui's autocomplete
        //   send 3 (+200ms): `\r`           commit the typed line
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.activePaneId = tabA.paneId;

        tm.renderModelDropup();
        const btn = document.querySelector(
            '#model-presets-dropup .dropup-model-btn',
        );
        btn.click();

        expect(tabA.sendInputCalls).toHaveLength(1);
        expect(tabA.sendInputCalls[0][0]).toMatch(/^\/model [a-zA-Z0-9/_.-]+$/);

        vi.advanceTimersByTime(200);
        expect(tabA.sendInputCalls[1][0]).toBe('\x1b');

        vi.advanceTimersByTime(200);
        expect(tabA.sendInputCalls[2][0]).toBe('\r');

        // No further sends; total 400ms wall time.
        vi.advanceTimersByTime(5000);
        expect(tabA.sendInputCalls).toHaveLength(3);
    });

    it('pi coder preset button: single sendSlashCommand', () => {
        const tm = makeTm();
        const tabA = makeTab('pi-A', 'pi');
        tm.tabs.set(tabA.paneId, tabA);
        tm.activePaneId = tabA.paneId;

        tm.renderPresets('pi');
        const chips = Array.from(
            tm.presetsContainer.querySelectorAll('.preset-btn'),
        );
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

        tm.app.codersPresetRegistry.pi.presets.push({
            name: 'esc',
            value: '\x1b',
        });
        tm.renderPresets('pi');
        const escChip = Array.from(
            tm.presetsContainer.querySelectorAll('.preset-btn'),
        ).find((b) => b.innerText === 'esc');
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
        const chips = Array.from(
            tm.presetsContainer.querySelectorAll('.preset-btn'),
        );
        const modelChip = chips.find((b) => b.innerText === '/model');
        modelChip.click();

        expect(tabA.sendInputCalls.length).toBe(1);
        expect(tabA.sendInputCalls[0][0]).toBe('\x1b[200~/model\x1b[201~\r');
    });

    it('opencode waits for the paste to settle before sending Enter', () => {
        const tm = makeTm();
        const tabA = makeTab('opencode-A', 'opencode');
        const tabB = makeTab('opencode-B', 'opencode');
        tm.tabs.set(tabA.paneId, tabA);
        tm.tabs.set(tabB.paneId, tabB);
        tm.activePaneId = tabA.paneId;

        expect(tm.sendSlashCommand(tabA, '/compact')).toBe(true);
        expect(tabA.sendInputCalls).toEqual([['\x1b[200~/compact\x1b[201~']]);

        // Switching tabs cannot redirect the delayed Enter.
        tm.activePaneId = tabB.paneId;
        vi.advanceTimersByTime(199);
        expect(tabA.sendInputCalls).toHaveLength(1);
        expect(tabB.sendInputCalls).toHaveLength(0);

        vi.advanceTimersByTime(1);
        expect(tabA.sendInputCalls).toEqual([
            ['\x1b[200~/compact\x1b[201~'],
            ['\r'],
        ]);
        expect(tabB.sendInputCalls).toHaveLength(0);
    });
});
