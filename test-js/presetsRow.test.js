// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';
import terminalJsSrc from '../web/terminal.js?raw';

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
