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
// Contract tested here:
//   1. renderPresets('pi')   -> chip is appended to presets-container
//   2. renderPresets('bash') -> NO chip (chip is pi-only)
//   3. Send ↵ button is unaffected — never hidden, never replaced.
//   4. Clicking the chip calls sendStagedInput() exactly like Send ↵.

setupDomHarness();

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
            pi:     { presets: [{ name: '/quit',    value: '/quit\r' }] },
            bash:   { presets: [{ name: 'Ctrl+C',   value: '\u0003' }] },
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
    it('renders the Ctrl+Shift+X chip into presets-container when coder is pi', () => {
        const tm = makeTm();
        tm.renderPresets('pi');

        const chip = tm.presetsContainer.querySelector('#pi-shortcut-send-btn');
        expect(chip).not.toBeNull();
        expect(chip.classList.contains('hidden')).toBe(false);
        // The chip should carry the binding label so users see Ctrl+Shift+X.
        expect(chip.textContent).toMatch(/Ctrl/);
        expect(chip.textContent).toMatch(/Shift/);
        expect(chip.textContent).toMatch(/X/);
    });

    it('does NOT render the chip for non-pi coders', () => {
        const tm = makeTm();
        tm.renderPresets('bash');
        expect(tm.presetsContainer.querySelector('#pi-shortcut-send-btn')).toBeNull();

        tm.renderPresets('claude');
        expect(tm.presetsContainer.querySelector('#pi-shortcut-send-btn')).toBeNull();
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

        const chip = tm.presetsContainer.querySelector('#pi-shortcut-send-btn');
        chip.click();

        expect(tm.sendStagedInput).toHaveBeenCalledTimes(1);
    });

    it('re-rendering for a different coder swaps the chip in/out cleanly', () => {
        const tm = makeTm();

        tm.renderPresets('pi');
        const piChip = tm.presetsContainer.querySelector('#pi-shortcut-send-btn');
        expect(piChip).not.toBeNull();

        tm.renderPresets('bash');
        expect(tm.presetsContainer.querySelector('#pi-shortcut-send-btn')).toBeNull();

        tm.renderPresets('pi');
        const piChipAgain = tm.presetsContainer.querySelector('#pi-shortcut-send-btn');
        expect(piChipAgain).not.toBeNull();
        expect(piChipAgain).not.toBe(piChip); // renderPresets rebuilds the row
    });
});