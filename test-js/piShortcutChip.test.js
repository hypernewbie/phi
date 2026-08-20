// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// The Ctrl+Shift+X chip is additive discoverability for the pi coder.
// It lives in the presets-container row (the same row as /quit /resume
// /model /compact / ⚡ Cmds ▾ / 🤖 Models ▾), NOT next to the primary
// Send ↵ button. The keyboard shortcut itself is global; the chip is
// only rendered when the active tab's coder is pi.
//
// The chip is a strict member of the preset-btn family — no id, no
// title attribute, lowercase label matching the existing binding
// convention (`ctrl+c`, `ctrl+o`, `esc`). The discoverability lives
// entirely in the visible label and the click handler doing the same
// `sendStagedInput()` call as Send ↵.
//
// Contract tested here:
//   1. renderPresets('pi')   -> chip is appended to presets-container
//   2. renderPresets('bash') -> NO chip (chip is pi-only)
//   3. Send ↵ button is unaffected — never hidden, never replaced.
//   4. Clicking the chip calls sendStagedInput() exactly like Send ↵.
//   5. The chip is found by its label (preset-btn with `ctrl+shift+x`),
//      NOT by an id. Locks the strict-subset invariant: no special
//      hooks into the DOM.

setupDomHarness();

// The chip is found only by its preset-btn class + label content.
// This locks the contract: no id, no title, no data-* — just another
// preset-btn in the row.
function findCtrlShiftXChip(container) {
    return (
        Array.from(container.querySelectorAll('.preset-btn')).find(
            (b) => b.innerText === 'ctrl+shift+x',
        ) || null
    );
}

function makeTm() {
    const tm = Object.create(TabManager.prototype);
    tm.tabs = new Map();
    tm.activePaneId = null;
    tm.presetsContainer = document.createElement('div');
    tm.presetsContainer.id = 'presets-container';
    document.body.appendChild(tm.presetsContainer);
    tm.sendStagedInput = vi.fn();
    // Minimal app surface for renderPresets().
    tm.app = {
        codersPresetRegistry: {
            pi: { presets: [{ name: '/quit', value: '/quit\r' }] },
            bash: { presets: [{ name: 'Ctrl+C', value: '\u0003' }] },
            claude: { presets: [{ name: '/compact', value: '/compact\r' }] },
        },
    };
    return tm;
}

beforeEach(() => {
    document.body.innerHTML = `
        <button id="send-input-btn" class="btn btn-accent">Send ↵</button>
        <div id="presets-container"></div>
    `;
});

describe('pi shortcut chip placement', () => {
    it('renders the ctrl+shift+x chip into presets-container when coder is pi', () => {
        const tm = makeTm();
        tm.renderPresets('pi');

        const chip = findCtrlShiftXChip(tm.presetsContainer);
        expect(
            chip,
            'chip should be the preset-btn labeled ctrl+shift+x',
        ).not.toBeNull();
        expect(chip.classList.contains('hidden')).toBe(false);
        // Label uses the lowercase binding convention matching ctrl+c / ctrl+o / esc.
        expect(chip.innerText).toBe('ctrl+shift+x');
    });

    it('does NOT render the chip for non-pi coders', () => {
        const tm = makeTm();
        tm.renderPresets('bash');
        expect(findCtrlShiftXChip(tm.presetsContainer)).toBeNull();

        tm.renderPresets('claude');
        expect(findCtrlShiftXChip(tm.presetsContainer)).toBeNull();
    });

    it('leaves Send ↵ visible and untouched when the chip appears or disappears', () => {
        const tm = makeTm();
        const sendBtn = document.getElementById('send-input-btn');
        expect(sendBtn.classList.contains('hidden')).toBe(false);

        tm.renderPresets('pi');
        expect(sendBtn.classList.contains('hidden')).toBe(false);
        expect(document.getElementById('send-input-btn')).toBe(sendBtn);

        tm.renderPresets('bash');
        expect(sendBtn.classList.contains('hidden')).toBe(false);
        expect(document.getElementById('send-input-btn')).toBe(sendBtn);
    });

    it('clicking the chip calls sendStagedInput — same path as Send ↵', () => {
        const tm = makeTm();
        tm.renderPresets('pi');

        const chip = findCtrlShiftXChip(tm.presetsContainer);
        chip.click();

        expect(tm.sendStagedInput).toHaveBeenCalledTimes(1);
    });

    it('re-rendering for a different coder swaps the chip in/out cleanly', () => {
        const tm = makeTm();

        tm.renderPresets('pi');
        const piChip = findCtrlShiftXChip(tm.presetsContainer);
        expect(piChip).not.toBeNull();

        tm.renderPresets('bash');
        expect(findCtrlShiftXChip(tm.presetsContainer)).toBeNull();

        tm.renderPresets('pi');
        const piChipAgain = findCtrlShiftXChip(tm.presetsContainer);
        expect(piChipAgain).not.toBeNull();
        expect(piChipAgain).not.toBe(piChip); // renderPresets rebuilds the row
    });

    it('chip is a strict member of the preset-btn family — no id, no title, just preset-btn class + label', () => {
        // Locks in: the chip carries no special DOM hooks. Discoverability
        // lives in the label alone; the keyboard binding stays discoverable
        // through help.md rather than a tooltip on the chip itself.
        const tm = makeTm();
        tm.renderPresets('pi');
        const chip = findCtrlShiftXChip(tm.presetsContainer);

        expect(chip.id).toBe('');
        expect(chip.getAttribute('title')).toBeNull();
        // className is exactly 'preset-btn' (no extra modifiers).
        expect(chip.className).toBe('preset-btn');
        // Matches its sibling presets' text styling: lowercase, no separator.
        expect(chip.innerText).toMatch(/^[a-z+]+$/);
    });
});
