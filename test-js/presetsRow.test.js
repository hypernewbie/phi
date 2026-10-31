// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import terminalJsSrc from '../web/terminal.js?raw';
import indexHtml from '../web/index.html?raw';

// The presets row is a single line: command chips, then the pickers.
// Control-key presets send a bare byte, so they render as icon-only
// buttons with the key name in the tooltip; slash commands keep text.
// Ctrl+Shift+X still sends the staged input, but it has no chip.
//
// Contract tested here:
//   1. No ctrl+shift+x chip for any coder.
//   2. Control-key presets render as icon buttons (aria-label + title).
//   3. Slash commands keep their text label.
//   4. The Ctrl+Shift+X keyboard binding survives the chip removal.

setupDomHarness();

function makeTm() {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;
    tm.presetsContainer = document.createElement('div');
    tm.presetsContainer.id = 'presets-container';
    document.body.appendChild(tm.presetsContainer);
    tm.sendStagedInput = vi.fn();
    tm.app = {
        codersPresetRegistry: {
            pi: {
                presets: [
                    { name: '/compact', value: '/compact\r' },
                    { name: 'ctrl+c', value: '\u0003' },
                    { name: 'ctrl+o', value: '\u000f' },
                ],
            },
            bash: {
                presets: [
                    { name: 'ctrl+c', value: '\u0003' },
                    { name: 'ctrl+d', value: '\u0004' },
                    { name: 'clear', value: 'clear\r' },
                ],
            },
        },
    };
    return tm;
}

function buttons(tm) {
    return [...tm.presetsContainer.querySelectorAll('.preset-btn')];
}

beforeEach(() => {
    document.body.innerHTML = `
        <button id="send-input-btn" class="btn btn-accent">Send ↵</button>
        <div id="presets-container"></div>
    `;
});

describe('presets row', () => {
    it.each([390, 1440])(
        'keeps one icon-only paperclip in its responsive location at %ipx',
        (width) => {
            Object.defineProperty(window, 'innerWidth', {
                value: width,
                configurable: true,
            });
            const tm = makeTm();
            document.body.insertAdjacentHTML(
                'afterbegin',
                '<div id="input-bar-container"><div class="input-actions"></div></div>',
            );
            const markup = new DOMParser().parseFromString(
                indexHtml,
                'text/html',
            );
            tm.attachInputBtn = markup.getElementById('attach-input-btn');
            expect(
                tm.attachInputBtn.closest('#presets-container'),
            ).not.toBeNull();
            expect(tm.attachInputBtn.querySelector('svg.icon')).not.toBeNull();
            expect(tm.attachInputBtn.textContent.trim()).toBe('');
            expect(tm.attachInputBtn.getAttribute('aria-label')).toBe(
                'Attach files',
            );
            const clicked = vi.fn();
            tm.attachInputBtn.addEventListener('click', clicked);
            tm.renderPresets('pi');
            tm.renderPresets('pi');
            const actions = document.querySelector('.input-actions');
            const host = width === 390 ? actions : tm.presetsContainer;
            expect(host.firstElementChild).toBe(tm.attachInputBtn);
            if (width === 390) {
                expect(tm.attachInputBtn.nextElementSibling).toBe(
                    actions.querySelector('.slash-trigger-btn'),
                );
                expect(
                    tm.presetsContainer.querySelector('#attach-input-btn'),
                ).toBeNull();
            }
            expect(document.querySelectorAll('#attach-input-btn')).toHaveLength(
                1,
            );
            tm.attachInputBtn.click();
            expect(clicked).toHaveBeenCalledTimes(1);
            tm.renderPresets('bash');
            expect(document.querySelector('#attach-input-btn')).toBeNull();
            tm.renderPresets('pi');
            expect(host.firstElementChild).toBe(tm.attachInputBtn);
            tm.attachInputBtn.click();
            expect(clicked).toHaveBeenCalledTimes(2);
            for (const nextWidth of [width === 390 ? 1440 : 390, width]) {
                Object.defineProperty(window, 'innerWidth', {
                    value: nextWidth,
                    configurable: true,
                });
                tm.renderPresets('pi');
                expect(
                    (nextWidth === 390 ? actions : tm.presetsContainer)
                        .firstElementChild,
                ).toBe(tm.attachInputBtn);
                expect(
                    document.querySelectorAll('#attach-input-btn'),
                ).toHaveLength(1);
                expect(
                    tm.attachInputBtn.classList.contains('input-quick-chip'),
                ).toBe(nextWidth === 390);
            }
            tm.attachInputBtn.click();
            expect(clicked).toHaveBeenCalledTimes(3);
        },
    );

    it.each([390, 1440])(
        'hides the paperclip while folded and restores its existing handler on expand at %ipx',
        (width) => {
            Object.defineProperty(window, 'innerWidth', {
                value: width,
                configurable: true,
            });
            document.body.insertAdjacentHTML(
                'afterbegin',
                '<div id="input-bar-container"><div class="input-actions"></div></div>',
            );
            const tm = makeTm();
            tm.attachInputBtn = new DOMParser()
                .parseFromString(indexHtml, 'text/html')
                .getElementById('attach-input-btn');
            tm.directModeToggle = document.createElement('button');
            tm.inputBarContainer = document.getElementById(
                'input-bar-container',
            );
            const clicked = vi.fn();
            tm.attachInputBtn.addEventListener('click', clicked);
            const button = tm.attachInputBtn;
            tm.renderPresets('pi');
            tm.updateDirectModeUI(
                { coder: 'pi', directMode: true, isAtBottom: true },
                true,
            );
            expect(tm.presetsContainer.classList.contains('hidden')).toBe(true);
            expect(tm.directModeToggle.getAttribute('aria-expanded')).toBe(
                'false',
            );
            expect(
                document.querySelector('.input-actions #attach-input-btn'),
            ).toBeNull();
            tm.updateDirectModeUI(
                { coder: 'pi', directMode: false, isAtBottom: true },
                true,
            );
            expect(tm.presetsContainer.classList.contains('hidden')).toBe(
                false,
            );
            expect(tm.directModeToggle.getAttribute('aria-expanded')).toBe(
                'true',
            );
            expect(document.querySelectorAll('#attach-input-btn')).toHaveLength(
                1,
            );
            expect(
                (width === 390
                    ? document.querySelector('.input-actions')
                    : tm.presetsContainer
                ).firstElementChild,
            ).toBe(button);
            button.click();
            expect(clicked).toHaveBeenCalledTimes(1);
        },
    );

    it('renders no ctrl+shift+x chip for any coder', () => {
        const tm = makeTm();
        for (const coder of ['pi', 'bash']) {
            tm.renderPresets(coder);
            expect(
                buttons(tm).filter((b) => b.innerText === 'ctrl+shift+x'),
                coder,
            ).toEqual([]);
        }
    });

    it('renders control-key presets as icon buttons with the key in the tooltip', () => {
        const tm = makeTm();
        tm.renderPresets('pi');

        const icons = buttons(tm).filter((b) =>
            b.classList.contains('btn-icon'),
        );
        expect(icons.map((b) => b.getAttribute('aria-label'))).toEqual([
            'ctrl+c',
            'ctrl+o',
        ]);
        for (const icon of icons) {
            expect(icon.querySelector('svg')).not.toBeNull();
            expect(icon.textContent.trim()).toBe('');
            expect(icon.title).toBe(
                `Send ${icon.getAttribute('aria-label')} to the terminal`,
            );
        }
    });

    it('keeps text labels for slash commands and plain-word presets', () => {
        const tm = makeTm();
        tm.renderPresets('bash');

        expect(buttons(tm).map((b) => b.innerText)).toContain('clear');
        expect(
            buttons(tm).filter((b) => b.classList.contains('btn-icon')),
        ).toHaveLength(2);
    });

    it('keeps a custom preset whose value inherits an Object key as text', () => {
        const tm = makeTm();
        tm.app.codersPresetRegistry.myraw = {
            presets: [{ name: 'toString', value: 'toString' }],
        };
        tm.renderPresets('myraw');

        const [button] = buttons(tm);
        expect(button.classList.contains('btn-icon')).toBe(false);
        expect(button.innerText).toBe('toString');
    });

    it('keeps the legacy Models button state for shells, Agy, and restored unknown tabs', () => {
        const tm = makeTm();
        for (const [coder, disabled, title] of [
            ['bash', false, 'Select the model for this session'],
            ['pwsh', false, 'Select the model for this session'],
            ['agy', true, 'Model selection not supported for Antigravity'],
            ['old-coder', false, 'Select the model for this session'],
        ]) {
            tm.activePaneId = 'pane';
            tm.tabs.set('pane', { coder });
            tm.renderPresets(coder);
            // Cmds, Models and Keys share the class; Models is the second
            // one and the only one carrying this title.
            const models = [
                ...tm.presetsContainer.querySelectorAll('.model-trigger-btn'),
            ].find((button) => button.title === title);
            expect(models, coder).toBeTruthy();
            expect(models.disabled, coder).toBe(disabled);
        }
    });

    it('keeps the Ctrl+Shift+X handler itself wired to sendStagedInput', () => {
        const start = terminalJsSrc.indexOf("(e.key === 'X' || e.key === 'x')");
        expect(start).toBeGreaterThan(-1);
        const handler = terminalJsSrc.slice(
            start,
            terminalJsSrc.indexOf('});', start),
        );
        expect(handler).toContain('this.sendStagedInput();');
    });

    it('keeps the Ctrl+Shift+X binding wired to sendStagedInput', () => {
        expect(terminalJsSrc).toContain('this.sendStagedInput();');
        expect(terminalJsSrc).toMatch(
            /e\.ctrlKey &&\s*e\.shiftKey &&\s*!e\.altKey &&\s*!e\.metaKey &&\s*\(e\.key === 'X' \|\| e\.key === 'x'\)/,
        );
    });
});

// Compact strips the row down to the pickers: the slash trigger and the
// control-key chips move up next to the input controls, so a phone keeps a
// single row of dropdowns at the bottom.
describe('compact presets row', () => {
    function compactTm(width) {
        document.body.innerHTML = `
            <div id="input-bar-container">
                <div class="input-actions"></div>
            </div>
        `;
        Object.defineProperty(window, 'innerWidth', {
            value: width,
            configurable: true,
        });
        return makeTm();
    }

    const labels = (root) =>
        [...root.querySelectorAll('.input-quick-chip')].map(
            (btn) => btn.title || btn.getAttribute('aria-label'),
        );

    it('moves the slash and control-key chips into the input actions', () => {
        const tm = compactTm(390);
        tm.renderPresets('pi');
        const actions = document.querySelector('.input-actions');
        // ctrl+c stays out: the ✕ cancel button is the one interrupt.
        expect(labels(actions)).toEqual([
            'Open slash commands',
            'Send ctrl+o to the terminal',
        ]);
        expect(
            tm.presetsContainer.querySelectorAll('.slash-trigger-btn'),
        ).toHaveLength(0);
        expect(tm.presetsContainer.querySelectorAll('.btn-icon')).toHaveLength(
            0,
        );
    });

    it('puts them back in the row when the viewport widens', () => {
        const tm = compactTm(390);
        tm.renderPresets('pi');
        expect(
            document.querySelectorAll('.input-actions .input-quick-chip'),
        ).toHaveLength(2);
        Object.defineProperty(window, 'innerWidth', {
            value: 1200,
            configurable: true,
        });
        tm.renderPresets('pi');
        expect(document.querySelectorAll('.input-quick-chip')).toHaveLength(0);
        expect(
            tm.presetsContainer.querySelectorAll('.preset-btn.btn-icon'),
        ).toHaveLength(2);
        // Desktop has no slash trigger: its slash presets are chips.
        expect(rowLabels(tm).join(' ')).toContain('/compact');
    });

    // jsdom has no innerText: fall back to the expando.
    const rowLabels = (tm) =>
        [...tm.presetsContainer.children].map((el) =>
            (
                el.textContent ||
                el.innerText ||
                el.getAttribute('aria-label') ||
                ''
            ).trim(),
        );

    it('starts the picker row with the robot and drops the words', () => {
        const tm = compactTm(390);
        tm.renderPresets('pi');
        const row = rowLabels(tm);
        expect(row.slice(0, 3)).toEqual([
            '🤖',
            'Cmds ▾',
            'Virtual Keyboard and Shortcuts',
        ]);
        expect(row.slice(4)).toEqual(['▲', '▼', '◀', '▶']);
        // Icon-only chips still answer to their function.
        expect(
            tm.presetsContainer.querySelector(
                '.model-trigger-btn[aria-label="Select the model for this session"]',
            ),
        ).not.toBeNull();
    });

    it('keeps the words on a desktop render', () => {
        const tm = compactTm(1200);
        tm.renderPresets('pi');
        const row = rowLabels(tm);
        expect(row).toContain('/compact');
        expect(row).toContain('Cmds ▾');
        expect(row).toContain('🤖 Models ▾');
    });

    it('drops parked chips when a Pi RPC tab takes over the row', () => {
        const tm = compactTm(390);
        tm.renderPresets('pi');
        expect(
            document.querySelectorAll('.input-actions .input-quick-chip'),
        ).toHaveLength(2);
        // The switch path: switchTab hands the new tab to updateDirectModeUI.
        const piRpcTab = {
            coder: 'pi-rpc',
            paneId: 'p1',
            directMode: false,
            isAtBottom: true,
        };
        tm.getActiveTab = () => piRpcTab;
        tm._renderPiRpcPresets = vi.fn();
        tm.directModeToggle = document.createElement('button');
        tm.inputBarContainer = document.getElementById('input-bar-container');
        tm.updateDirectModeUI(piRpcTab, true);
        expect(tm._renderPiRpcPresets).toHaveBeenCalled();
        expect(document.querySelectorAll('.input-quick-chip')).toHaveLength(0);
    });

    it('drops parked chips when the pane enters direct mode', () => {
        const tm = compactTm(390);
        tm.renderPresets('pi');
        expect(
            document.querySelectorAll('.input-actions .input-quick-chip'),
        ).toHaveLength(2);
        tm.directModeToggle = document.createElement('button');
        tm.inputBarContainer = document.getElementById('input-bar-container');
        tm.updateDirectModeUI(
            { coder: 'pi', directMode: true, isAtBottom: true },
            true,
        );
        expect(document.querySelectorAll('.input-quick-chip')).toHaveLength(0);
    });

    it('does not duplicate chips across renders', () => {
        const tm = compactTm(390);
        tm.renderPresets('pi');
        tm.renderPresets('pi');
        expect(
            document.querySelectorAll('.input-actions .input-quick-chip'),
        ).toHaveLength(2);
    });

    // The bridge-live pi tab the row reads. The predicates are not mocked:
    // this object is their input.
    function bridgeTab(piBridge) {
        const ws = { readyState: 1 };
        return {
            paneId: 'order-pane',
            coder: 'pi',
            ws,
            _piBridgeFresh: ws,
            piBridge,
        };
    }

    // The compact row shows emoji, so the pickers are found by class.
    const pickerNames = (tm) =>
        [...tm.presetsContainer.querySelectorAll('.model-trigger-btn')].map(
            (button) => {
                if (button.classList.contains('pi-rpc-model-trigger'))
                    return 'Model';
                if (button.classList.contains('pi-rpc-thinking-trigger'))
                    return 'Thinking';
                if (button.classList.contains('pi-rpc-skills-trigger'))
                    return 'Skills';
                if (button.classList.contains('keys-trigger-btn'))
                    return 'Keys';
                if (button.title === 'Open quick commands') return 'Cmds';
                // The legacy Models button, for a tab without the bridge.
                if (button.title === 'Select the model for this session')
                    return 'Model';
                return 'unknown';
            },
        );

    it('orders the pickers Model, Thinking, Skills, Cmds, Keys', () => {
        const live = {
            state: 'managed',
            connected: true,
            model: 'fixture/model',
            thinking_level: 'high',
            capabilities: ['pi.models.v1', 'pi.thinking.v1', 'pi.skills.v1'],
        };

        for (const width of [1200, 390]) {
            const tm = compactTm(width);
            const tab = bridgeTab(live);
            tm.activePaneId = tab.paneId;
            tm.tabs.set(tab.paneId, tab);
            tm.renderPresets('pi');

            expect(pickerNames(tm), `width ${width}`).toEqual([
                'Model',
                'Thinking',
                'Skills',
                'Cmds',
                'Keys',
            ]);

            // The keyboard chip keeps its name and its 14px icon.
            const keys = tm.presetsContainer.querySelector('.keys-trigger-btn');
            expect(keys.getAttribute('aria-label')).toBe(
                'Virtual Keyboard and Shortcuts',
            );
            const icon = keys.querySelector('svg');
            expect(icon.getAttribute('class')).toBe('icon');
            expect(icon.getAttribute('style')).toContain('width: 14px');
            expect(icon.getAttribute('style')).toContain('height: 14px');

            // One divider: the compact row adds its own, the desktop row
            // keeps the coder one.
            expect(
                tm.presetsContainer.querySelectorAll('.presets-divider'),
                `width ${width}`,
            ).toHaveLength(1);

            if (width === 390) {
                const navs = [
                    ...tm.presetsContainer.querySelectorAll('.mobile-nav-btn'),
                ];
                expect(navs.map((nav) => nav.innerText)).toEqual([
                    '▲',
                    '▼',
                    '◀',
                    '▶',
                ]);
                const children = [...tm.presetsContainer.children];
                navs.forEach((nav, index) => {
                    expect(
                        children[children.length - navs.length + index],
                    ).toBe(nav);
                });
            }
        }
    });

    it('keeps the picker order through every bridge state', () => {
        const live = {
            state: 'managed',
            connected: true,
            model: 'fixture/model',
            thinking_level: 'high',
            capabilities: ['pi.models.v1', 'pi.thinking.v1', 'pi.skills.v1'],
        };
        const states = [
            [
                'live',
                live,
                ['Model', 'Thinking', 'Skills', 'Cmds', 'Keys'],
                'Thinking · high',
            ],
            [
                'absent at startup',
                undefined,
                ['Model', 'Thinking', 'Cmds', 'Keys'],
                'Thinking · saved options',
            ],
            [
                'injection disabled',
                { state: 'plain', connected: false, capabilities: [] },
                ['Model', 'Thinking', 'Cmds', 'Keys'],
                'Thinking · saved options',
            ],
            [
                'disconnected',
                { ...live, connected: false },
                ['Model', 'Thinking', 'Cmds', 'Keys'],
                'Thinking · saved options',
            ],
            [
                'capability missing',
                { ...live, capabilities: ['pi.models.v1'] },
                ['Model', 'Thinking', 'Cmds', 'Keys'],
                'Thinking · saved options',
            ],
            [
                'reconnected',
                live,
                ['Model', 'Thinking', 'Skills', 'Cmds', 'Keys'],
                'Thinking · high',
            ],
        ];

        for (const [name, piBridge, expected, thinkingTitle] of states) {
            for (const width of [1200, 390]) {
                const tm = compactTm(width);
                const tab = bridgeTab(piBridge);
                tm.activePaneId = tab.paneId;
                tm.tabs.set(tab.paneId, tab);
                tm.renderPresets('pi');
                tm.renderPresets('pi');

                expect(pickerNames(tm), `${name} at ${width}`).toEqual(
                    expected,
                );
                expect(
                    tm.presetsContainer.querySelectorAll('.presets-divider'),
                    `${name} at ${width}`,
                ).toHaveLength(1);

                // Without the capability, Thinking keeps its saved options.
                const thinking = tm.presetsContainer.querySelector(
                    '.pi-rpc-thinking-trigger',
                );
                expect(thinking.title, `${name} at ${width}`).toBe(
                    thinkingTitle,
                );
            }
        }
    });
});
