// @vitest-environment jsdom
//
// The shared modal focus trap is the keyboard contract for every dialog that
// uses it (workspace manager, Add Workspace). A regression here strands
// keyboard users outside the dialog or makes Escape leak to other handlers,
// so the contract is pinned directly instead of through one consumer.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { trapModalFocus } from '../web/modal-focus.js';

setupDomHarness();

function makeDialog(open = true) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-content" tabindex="-1">
            <input id="first" />
            <button id="middle">Middle</button>
            <button id="last">Last</button>
        </div>
    `;
    document.body.appendChild(overlay);
    const onEscape = vi.fn();
    const trap = trapModalFocus(overlay, {
        onEscape,
        isOpen: () => open,
        initialFocus: () => overlay.querySelector('.modal-content'),
    });
    return {
        overlay,
        trap,
        onEscape,
        dialog: overlay.querySelector('.modal-content'),
    };
}

function key(target, key, shiftKey = false) {
    target.dispatchEvent(
        new KeyboardEvent('keydown', {
            key,
            shiftKey,
            bubbles: true,
            cancelable: true,
        }),
    );
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('trapModalFocus', () => {
    it('Escape runs onEscape once, and only Escape is stopped', () => {
        const { overlay, trap, onEscape } = makeDialog();
        const seen = [];
        document.addEventListener('keydown', (event) => seen.push(event.key));
        key(overlay, 'Escape');
        // The trap's capture-phase stopPropagation cuts the event off before
        // bubble-phase document handlers see it, so one Escape cannot close
        // two dialogs at once.
        expect(onEscape).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([]);
        key(overlay, 'a');
        expect(seen).toEqual(['a']);
        expect(onEscape).toHaveBeenCalledTimes(1);
        trap.dispose();
    });

    it('Tab wraps from the last focusable to the first and back', () => {
        const { overlay, trap } = makeDialog();
        const first = overlay.querySelector('#first');
        const last = overlay.querySelector('#last');
        last.focus();
        key(last, 'Tab');
        expect(document.activeElement).toBe(first);
        key(first, 'Tab', true);
        expect(document.activeElement).toBe(last);
        trap.dispose();
    });

    it('focus that lands outside an open dialog is pulled back inside', () => {
        const { trap, dialog } = makeDialog();
        const outside = document.createElement('input');
        document.body.appendChild(outside);
        outside.focus();
        outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(document.activeElement).toBe(dialog);
        trap.dispose();
    });

    it('focus outside is left alone once the dialog reports closed', () => {
        const { trap } = makeDialog(false);
        const outside = document.createElement('input');
        document.body.appendChild(outside);
        outside.focus();
        outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        expect(document.activeElement).toBe(outside);
        trap.dispose();
    });

    it('dispose removes both listeners', () => {
        const { trap } = makeDialog();
        trap.dispose();
        // A Tab after dispose must reach the browser default: no crash and no
        // focus jump from the trap.
        const probe = document.createElement('input');
        document.body.appendChild(probe);
        probe.focus();
        key(probe, 'Tab');
        expect(document.activeElement).toBe(probe);
    });
});
