// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import { loadCoderRegistry } from '../web/coders.js';

// Focused regression net for the compact command menu: the four exact
// low-frequency values (/quit, /exit, /resume, /sessions + \r) move from
// the preset row into Cmds ▾ → Built-in Commands, only when the active
// coder's effective presets advertise them.
//
// Harness discipline (as in sendSlashCommand.test.js):
//   - ctx is Object.create(TabManager.prototype): getActiveTab,
//     sendInput, sendToTab, sendSlashCommand, sendRawInput are REAL.
//     spies observe collaborator options without replacing behavior.
//   - tab resolution drives off tm.tabs / tm.activePaneId.
//   - Mock only the boundaries: ws.sendInput per tab, focus/scroll
//     helpers, toasts, fetch (record-only: the menu must not call it).

setupDomHarness();
HTMLElement.prototype.scrollIntoView = () => {};

const PI_PRESETS = [
    { name: '/quit', value: '/quit\r' },
    { name: '/resume', value: '/resume\r' },
    { name: '/model', value: '/model\r' },
    { name: '/compact', value: '/compact\r' },
    { name: 'esc', value: '\x1b' },
];

function makeTm() {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;

    tm.tabsContainer = document.getElementById('tabs-container');
    tm.terminalsWrapper = document.getElementById('terminals-wrapper');
    tm.inputBarContainer = document.getElementById('input-bar-container');
    tm.presetsContainer = document.getElementById('presets-container');

    const input = document.createElement('textarea');
    input.id = 'input-textarea';
    document.body.appendChild(input);
    tm.inputTextArea = input;
    tm.lastInputValue = '';

    tm._spamScrollToBottom = vi.fn();
    tm.focusActiveTerminal = vi.fn();
    tm._showReconnectOverlay = vi.fn();
    tm.saveActiveDraft = vi.fn();
    tm.adjustInputHeight = vi.fn();
    tm.app = {
        showToast: vi.fn(),
        syncRemoteClipboard: vi.fn(),
        quickCommands: [
            { name: 'List', command: 'ls' },
            { name: 'Grep', command: 'ps aux | grep {}' },
        ],
        codersPresetRegistry: {
            pi: { presets: PI_PRESETS.map((p) => ({ ...p })) },
            codex: {
                presets: [
                    { name: '/quit', value: '/quit\r' },
                    { name: '/quitall', value: '/quitall\r' },
                    { name: '/model', value: '/model\r' },
                ],
            },
            bash: {
                presets: [
                    { name: 'Ctrl-C', value: '\x03' },
                    { name: 'esc', value: '\x1b' },
                ],
            },
            opencode: {
                presets: [
                    { name: '/sessions', value: '/sessions\r' },
                    { name: '/exit', value: '/exit\r' },
                    { name: '/models', value: '/models\r' },
                ],
            },
            myraw: {
                presets: [
                    { name: '/quit', value: '/quit\r' },
                    { name: 'help', value: 'help\r' },
                ],
            },
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

function makeTab(paneId, coder = 'pi', extra = {}) {
    const wsSendInput = vi.fn();
    wsSendInput.mockReturnValue(true);
    return {
        paneId,
        coder,
        isDead: false,
        isKanban: false,
        isReview: false,
        directMode: false,
        tabEl: document.createElement('div'),
        termContainer: document.createElement('div'),
        ws: { sendInput: wsSendInput, readyState: 1 },
        sendInputCalls: wsSendInput.mock.calls,
        ...extra,
    };
}

function setViewportWidth(width) {
    Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: width,
    });
}

function presetLabels(tm) {
    return Array.from(
        tm.presetsContainer.querySelectorAll(':scope > .preset-btn'),
    ).map((b) => b.innerText);
}

function menuHeaders() {
    return Array.from(
        document.querySelectorAll('#quick-commands-dropup > .dropup-header'),
    ).map((h) => h.innerText);
}

function builtInButtons() {
    const dropup = document.getElementById('quick-commands-dropup');
    const rows = Array.from(dropup.querySelectorAll(':scope > .dropup-row'));
    return rows
        .filter((row) => !row.querySelector('.dropup-row-actions'))
        .map((row) => row.querySelector('.dropup-model-btn'));
}

beforeEach(() => {
    document.body.replaceChildren();
    for (const id of [
        'tabs-container',
        'terminals-wrapper',
        'input-bar-container',
        'presets-container',
        'empty-state',
        'model-presets-dropup',
        'quick-commands-dropup',
        'slash-presets-dropup',
    ]) {
        const el = document.createElement('div');
        el.id = id;
        if (id.endsWith('-dropup')) el.classList.add('hidden');
        document.body.appendChild(el);
    }
    setViewportWidth(1024);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('A1 placement: only the four exact values move', () => {
    it('desktop row keeps common presets and utility keys in order', () => {
        const tm = makeTm();
        const tab = makeTab('pi-1', 'pi');
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;

        tm.renderPresets('pi');
        const labels = presetLabels(tm);
        expect(labels).not.toContain('/quit');
        expect(labels).not.toContain('/resume');
        expect(labels).toContain('/model');
        expect(labels).toContain('/compact');
        expect(labels).toContain('esc');
        expect(labels.indexOf('/model')).toBeLessThan(
            labels.indexOf('/compact'),
        );
    });

    it('menu lists moved values above user commands in registry order', () => {
        const tm = makeTm();
        const tab = makeTab('pi-1', 'pi');
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;

        tm.renderQuickCmdsDropup();
        expect(menuHeaders()).toEqual(['Built-in Commands', 'Quick Commands']);
        expect(builtInButtons().map((b) => b.innerText)).toEqual([
            '/quit',
            '/resume',
        ]);
        const userRows = Array.from(
            document.querySelectorAll(
                '#quick-commands-dropup > .dropup-row:has(.dropup-row-actions)',
            ),
        );
        expect(
            userRows.map((r) => r.querySelector('.dropup-model-btn').innerText),
        ).toEqual(['List', 'Grep']);
    });

    it('built-in rows have no edit/delete actions; user rows keep them', () => {
        const tm = makeTm();
        const tab = makeTab('pi-1', 'pi');
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;

        tm.renderQuickCmdsDropup();
        for (const btn of builtInButtons()) {
            expect(
                btn.closest('.dropup-row').querySelector('.dropup-row-actions'),
            ).toBeNull();
        }
        const userRows = Array.from(
            document.querySelectorAll(
                '#quick-commands-dropup > .dropup-row:has(.dropup-row-actions)',
            ),
        );
        expect(userRows).toHaveLength(2);
        for (const row of userRows) {
            expect(row.querySelector('.dropup-edit-btn')).not.toBeNull();
            expect(row.querySelector('.dropup-del-btn')).not.toBeNull();
        }
        expect(
            document.querySelector('#quick-commands-dropup .dropup-add-row'),
        ).not.toBeNull();
        expect(
            document.querySelector(
                '#quick-commands-dropup .dropup-config-footer',
            ),
        ).not.toBeNull();
    });

    it('omits the built-in section when nothing is advertised', () => {
        const tm = makeTm();
        const tab = makeTab('bash-1', 'bash');
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;

        tm.renderQuickCmdsDropup();
        expect(menuHeaders()).toEqual(['Quick Commands']);
        tm.renderPresets('bash');
        expect(presetLabels(tm)).toContain('Ctrl-C');
        expect(presetLabels(tm)).toContain('esc');
    });

    it('near-miss values stay on the row; only exact matches move', () => {
        const tm = makeTm();
        const tab = makeTab('codex-1', 'codex');
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;

        tm.renderPresets('codex');
        expect(presetLabels(tm)).toContain('/quitall');
        expect(presetLabels(tm)).not.toContain('/quit');
        tm.renderQuickCmdsDropup();
        expect(builtInButtons().map((b) => b.innerText)).toEqual(['/quit']);
    });

    it('compact slash menu excludes moved values; utility chips stay', () => {
        setViewportWidth(400);
        const tm = makeTm();
        const tab = makeTab('pi-1', 'pi');
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        document
            .getElementById('slash-presets-dropup')
            .classList.remove('hidden');

        tm.renderPresets('pi');
        const slashLabels = Array.from(
            document.querySelectorAll(
                '#slash-presets-dropup .dropup-model-btn',
            ),
        ).map((b) => b.innerText);
        expect(slashLabels).not.toContain('/quit');
        expect(slashLabels).not.toContain('/resume');
        expect(slashLabels).toContain('/model');
        expect(slashLabels).toContain('/compact');
        expect(
            tm.presetsContainer.querySelector('.slash-trigger-btn'),
        ).not.toBeNull();
        expect(presetLabels(tm)).toContain('esc');
    });

    it('re-rendering never duplicates rows or headers', () => {
        const tm = makeTm();
        const tab = makeTab('pi-1', 'pi');
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;

        tm.renderQuickCmdsDropup();
        tm.renderQuickCmdsDropup();
        expect(menuHeaders()).toEqual(['Built-in Commands', 'Quick Commands']);
        expect(builtInButtons()).toHaveLength(2);
        tm.renderPresets('pi');
        const first = presetLabels(tm);
        tm.renderPresets('pi');
        expect(presetLabels(tm)).toEqual(first);
    });
});

describe('A2 click-time context: stale menu entries re-resolve', () => {
    it('sends nothing with no active tab', () => {
        const tm = makeTm();
        const tab = makeTab('pi-1', 'pi');
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        tm.renderQuickCmdsDropup();

        tm.activePaneId = 'gone';
        builtInButtons()[0].click();
        expect(tab.sendInputCalls).toHaveLength(0);
    });

    it('sends nothing for direct-mode and pi-rpc tabs', () => {
        const tm = makeTm();
        const pi = makeTab('pi-1', 'pi');
        const direct = makeTab('pi-2', 'pi', { directMode: true });
        const rpc = makeTab('rpc-1', 'pi-rpc');
        tm.tabs.set(pi.paneId, pi);
        tm.tabs.set(direct.paneId, direct);
        tm.tabs.set(rpc.paneId, rpc);
        tm.activePaneId = pi.paneId;
        tm.renderQuickCmdsDropup();

        tm.activePaneId = direct.paneId;
        builtInButtons()[0].click();
        tm.activePaneId = rpc.paneId;
        builtInButtons()[0].click();
        expect(pi.sendInputCalls).toHaveLength(0);
        expect(direct.sendInputCalls).toHaveLength(0);
        expect(rpc.sendInputCalls).toHaveLength(0);
    });

    it('Pi→Bash: stale /quit is rejected', () => {
        const tm = makeTm();
        const pi = makeTab('pi-1', 'pi');
        const bash = makeTab('bash-1', 'bash');
        tm.tabs.set(pi.paneId, pi);
        tm.tabs.set(bash.paneId, bash);
        tm.activePaneId = pi.paneId;
        tm.renderQuickCmdsDropup();

        tm.activePaneId = bash.paneId;
        builtInButtons()[0].click();
        vi.runAllTimers();
        expect(pi.sendInputCalls).toHaveLength(0);
        expect(bash.sendInputCalls).toHaveLength(0);
    });

    it('Pi→Codex: stale /quit targets Codex', () => {
        const tm = makeTm();
        const pi = makeTab('pi-1', 'pi');
        const codex = makeTab('codex-1', 'codex');
        tm.tabs.set(pi.paneId, pi);
        tm.tabs.set(codex.paneId, codex);
        tm.activePaneId = pi.paneId;
        tm.renderQuickCmdsDropup();

        tm.activePaneId = codex.paneId;
        builtInButtons()[0].click();
        vi.runAllTimers();
        expect(pi.sendInputCalls).toHaveLength(0);
        expect(codex.sendInputCalls).toEqual([['\x1b[200~/quit\x1b[201~\r']]);
    });

    it('OpenCode full→Mini: stale /sessions rejected, /exit accepted', async () => {
        mockFetch(() => ({
            opencode: {
                name: 'OpenCode',
                presets: [{ name: '/models', value: '/models\r' }],
                opencode_mini_presets: [
                    { name: '/exit', value: '/exit\r' },
                    { name: 'menu', value: '\x10' },
                ],
            },
        }));
        await loadCoderRegistry();
        const tm = makeTm();
        const full = makeTab('oc-full', 'opencode');
        const mini = makeTab('oc-mini', 'opencode', { opencodeMode: 'mini' });
        tm.tabs.set(full.paneId, full);
        tm.tabs.set(mini.paneId, mini);
        tm.activePaneId = full.paneId;
        tm.renderQuickCmdsDropup();
        expect(builtInButtons().map((b) => b.innerText)).toEqual([
            '/sessions',
            '/exit',
        ]);

        tm.activePaneId = mini.paneId;
        builtInButtons()[0].click(); // stale /sessions
        vi.runAllTimers();
        expect(full.sendInputCalls).toHaveLength(0);
        expect(mini.sendInputCalls).toHaveLength(0);

        builtInButtons()[1].click(); // stale but still advertised /exit
        vi.runAllTimers();
        expect(full.sendInputCalls).toHaveLength(0);
        expect(mini.sendInputCalls).toEqual([['\x1b[200~/exit\x1b[201~\r']]);
    });
});

describe('A3 dispatch and focus match the old preset buttons', () => {
    it('pi/codex/mini built-ins send one atomic paste+Enter', async () => {
        mockFetch(() => ({
            opencode: {
                name: 'OpenCode',
                presets: [{ name: '/models', value: '/models\r' }],
                opencode_mini_presets: [{ name: '/exit', value: '/exit\r' }],
            },
        }));
        await loadCoderRegistry();
        for (const [coder, label, extra] of [
            ['pi', '/quit', {}],
            ['codex', '/quit', {}],
            ['opencode', '/exit', { opencodeMode: 'mini' }],
        ]) {
            document.getElementById('quick-commands-dropup').innerHTML = '';
            const tm = makeTm();
            const tab = makeTab(`${coder}-1`, coder, extra);
            tm.tabs.set(tab.paneId, tab);
            tm.activePaneId = tab.paneId;
            tm.renderQuickCmdsDropup();
            builtInButtons()
                .find((b) => b.innerText === label)
                .click();
            vi.runAllTimers();
            expect(tab.sendInputCalls).toEqual([
                [`\x1b[200~${label}\x1b[201~\r`],
            ]);
        }
    });

    it('legacy opencode pins the delayed Enter to the clicked pane', () => {
        const tm = makeTm();
        const tabA = makeTab('oc-A', 'opencode');
        const tabB = makeTab('oc-B', 'opencode');
        tm.tabs.set(tabA.paneId, tabA);
        tm.tabs.set(tabB.paneId, tabB);
        tm.activePaneId = tabA.paneId;
        tm.renderQuickCmdsDropup();

        builtInButtons()
            .find((b) => b.innerText === '/exit')
            .click();
        expect(tabA.sendInputCalls).toEqual([['\x1b[200~/exit\x1b[201~']]);

        tm.activePaneId = tabB.paneId;
        vi.advanceTimersByTime(199);
        expect(tabA.sendInputCalls).toHaveLength(1);
        expect(tabB.sendInputCalls).toHaveLength(0);
        vi.advanceTimersByTime(1);
        expect(tabA.sendInputCalls).toEqual([
            ['\x1b[200~/exit\x1b[201~'],
            ['\r'],
        ]);
        expect(tabB.sendInputCalls).toHaveLength(0);
    });

    it('non-slash coders keep the raw path', () => {
        const tm = makeTm();
        const tab = makeTab('raw-1', 'myraw');
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        tm.renderQuickCmdsDropup();

        expect(builtInButtons().map((b) => b.innerText)).toEqual(['/quit']);
        builtInButtons()[0].click();
        vi.runAllTimers();
        expect(tab.sendInputCalls).toEqual([['/quit\r']]);
    });

    it('desktop chips keep the default focus tail (no options arg)', () => {
        const tm = makeTm();
        const tab = makeTab('pi-1', 'pi');
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        const spy = vi.spyOn(tm, 'sendSlashCommand');
        tm.renderPresets('pi');

        Array.from(tm.presetsContainer.querySelectorAll('.preset-btn'))
            .find((b) => b.innerText === '/model')
            .click();
        expect(spy).toHaveBeenCalledWith(tab, '/model');
        expect(spy.mock.calls[0]).toHaveLength(2);
        expect(tm.focusActiveTerminal).toHaveBeenCalled();
        expect(tab.sendInputCalls).toEqual([['\x1b[200~/model\x1b[201~\r']]);
    });

    it('menu selections suppress mobile input focus like the old slash menu', () => {
        const tm = makeTm();
        const tab = makeTab('pi-1', 'pi');
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        const spy = vi.spyOn(tm, 'sendSlashCommand');
        tm.renderQuickCmdsDropup();

        builtInButtons()[0].click();
        expect(spy).toHaveBeenCalledWith(tab, '/quit', {
            focusInputOnMobile: false,
        });
        expect(tab.sendInputCalls).toEqual([['\x1b[200~/quit\x1b[201~\r']]);
    });

    it('compact slash selections keep the no-focus option', () => {
        setViewportWidth(400);
        const tm = makeTm();
        const tab = makeTab('pi-1', 'pi');
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        const spy = vi.spyOn(tm, 'sendSlashCommand');
        document
            .getElementById('slash-presets-dropup')
            .classList.remove('hidden');
        tm.renderPresets('pi');

        Array.from(
            document.querySelectorAll(
                '#slash-presets-dropup .dropup-model-btn',
            ),
        )
            .find((b) => b.innerText === '/model')
            .click();
        expect(spy).toHaveBeenCalledWith(tab, '/model', {
            focusInputOnMobile: false,
        });
    });

    it('built-in click closes the menu', () => {
        const tm = makeTm();
        const tab = makeTab('pi-1', 'pi');
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        const dropup = document.getElementById('quick-commands-dropup');
        dropup.classList.remove('hidden');
        tm.renderQuickCmdsDropup();

        builtInButtons()[0].click();
        expect(dropup.classList.contains('hidden')).toBe(true);
    });
});

describe('A4 custom commands and bridge fallback are untouched', () => {
    it('user commands keep order, draft/{}, and clearing behavior', () => {
        const tm = makeTm();
        const tab = makeTab('pi-1', 'pi');
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        tm.sendInput = vi.fn(() => true);
        tm.renderQuickCmdsDropup();

        const userBtns = Array.from(
            document.querySelectorAll(
                '#quick-commands-dropup > .dropup-row:has(.dropup-row-actions) .dropup-model-btn',
            ),
        );
        userBtns[0].click();
        expect(tm.sendInput).toHaveBeenCalledWith(tab, 'ls\r');
        expect(tm.inputTextArea.value).toBe('');

        tm.inputTextArea.value = 'nginx';
        userBtns[1].click();
        // Long substituted commands take the existing bracketed-paste form.
        expect(tm.sendInput).toHaveBeenCalledWith(
            tab,
            '\x1b[200~ps aux | grep nginx\x1b[201~\r',
        );
        expect(tm.inputTextArea.value).toBe('');
    });

    it('rendering never mutates the user command config', () => {
        const tm = makeTm();
        const tab = makeTab('pi-1', 'pi');
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        const before = JSON.parse(JSON.stringify(tm.app.quickCommands));

        tm.renderQuickCmdsDropup();
        tm.renderQuickCmdsDropup();
        expect(tm.app.quickCommands).toEqual(before);
    });

    it.each([
        ['absent', undefined],
        ['live managed with caps', 'live'],
        ['disconnected', 'disconnected'],
        ['missing capabilities', 'nocaps'],
        ['plain', 'plain'],
    ])(
        'bridge %s: built-in keeps the PTY bytes, no bridge request',
        async (_, shape) => {
            const fetchSpy = mockFetch(() => ({}));
            const tm = makeTm();
            const tab = makeTab('pi-1', 'pi');
            if (shape === 'live') {
                tab.piBridge = {
                    state: 'managed',
                    connected: true,
                    capabilities: [
                        'pi.models.v1',
                        'pi.compact.v1',
                        'pi.thinking.v1',
                        'pi.skills.v1',
                        'pi.context.v1',
                    ],
                    generation: 'g1',
                };
                tab._piBridgeFresh = tab.ws;
            } else if (shape === 'disconnected') {
                tab.piBridge = {
                    state: 'managed',
                    connected: false,
                    capabilities: ['pi.models.v1'],
                    generation: 'g1',
                };
            } else if (shape === 'nocaps') {
                tab.piBridge = {
                    state: 'managed',
                    connected: true,
                    capabilities: [],
                    generation: 'g1',
                };
                tab._piBridgeFresh = tab.ws;
            } else if (shape === 'plain') {
                tab.piBridge = { state: 'plain' };
            }
            tm.tabs.set(tab.paneId, tab);
            tm.activePaneId = tab.paneId;
            tm.renderPresets('pi');
            tm.renderQuickCmdsDropup();

            builtInButtons()[0].click();
            vi.runAllTimers();
            expect(tab.sendInputCalls).toEqual([['\x1b[200~/quit\x1b[201~\r']]);
            expect(fetchSpy).not.toHaveBeenCalled();
        },
    );

    it('reconnected bridge: same PTY bytes before and after', () => {
        const fetchSpy = mockFetch(() => ({}));
        const tm = makeTm();
        const tab = makeTab('pi-1', 'pi');
        tab.piBridge = {
            state: 'managed',
            connected: false,
            capabilities: ['pi.models.v1'],
            generation: 'g1',
        };
        tm.tabs.set(tab.paneId, tab);
        tm.activePaneId = tab.paneId;
        tm.renderQuickCmdsDropup();

        builtInButtons()[0].click();
        tab.piBridge.connected = true;
        tab._piBridgeFresh = tab.ws;
        builtInButtons()[0].click();
        vi.runAllTimers();
        expect(tab.sendInputCalls).toEqual([
            ['\x1b[200~/quit\x1b[201~\r'],
            ['\x1b[200~/quit\x1b[201~\r'],
        ]);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
