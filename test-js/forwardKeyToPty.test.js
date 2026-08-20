import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TabManager } from '../web/terminal.js';

// _forwardKeyToPty is the single key→PTY map shared by the staged-input bar
// (empty-value path), the terminal's custom key handler (non-direct mode) and
// the mobile document-level fallback. House pattern: call the prototype method
// on a stub ctx — no DOM needed.

function makeEvent(over = {}) {
    const e = {
        key: '',
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        ...over,
    };
    e.preventDefault = vi.fn();
    return e;
}

const makeTab = () => ({ isDead: false });

function makeCtx() {
    return { sendToTab: vi.fn(() => true) };
}

const run = (ctx, e, tab) =>
    TabManager.prototype._forwardKeyToPty.call(ctx, e, tab);

beforeEach(() => vi.clearAllMocks());

describe('_forwardKeyToPty', () => {
    it.each([
        ['Enter', '\r'],
        ['Escape', '\x1b'],
        ['Backspace', '\x7f'],
        ['ArrowUp', '\u001b[A'],
        ['ArrowDown', '\u001b[B'],
        ['ArrowLeft', '\u001b[D'],
        ['ArrowRight', '\u001b[C'],
        ['PageUp', '\u001b[5~'],
        ['PageDown', '\u001b[6~'],
    ])('forwards %s as %j', (key, bytes) => {
        const ctx = makeCtx();
        const tab = makeTab();
        const e = makeEvent({ key });
        expect(run(ctx, e, tab)).toBe(true);
        expect(ctx.sendToTab).toHaveBeenCalledWith(tab, bytes);
        expect(e.preventDefault).toHaveBeenCalled();
    });

    it('forwards Shift+Tab as backtab', () => {
        const ctx = makeCtx();
        const tab = makeTab();
        const e = makeEvent({ key: 'Tab', shiftKey: true });
        expect(run(ctx, e, tab)).toBe(true);
        expect(ctx.sendToTab).toHaveBeenCalledWith(tab, '\x1b[Z');
    });

    it.each([
        ['c', '\x03'],
        ['o', '\x0f'],
        ['p', '\x10'],
        ['t', '\x14'],
    ])('forwards Ctrl+%s', (key, bytes) => {
        const ctx = makeCtx();
        const tab = makeTab();
        expect(run(ctx, makeEvent({ key, ctrlKey: true }), tab)).toBe(true);
        expect(ctx.sendToTab).toHaveBeenCalledWith(tab, bytes);
    });

    it('ignores unmapped ctrl combos without consuming them', () => {
        const ctx = makeCtx();
        const e = makeEvent({ key: 'q', ctrlKey: true });
        expect(run(ctx, e, makeTab())).toBe(false);
        expect(ctx.sendToTab).not.toHaveBeenCalled();
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it('ignores printable keys — those belong to the redirect/staging paths', () => {
        const ctx = makeCtx();
        const e = makeEvent({ key: 'a' });
        expect(run(ctx, e, makeTab())).toBe(false);
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it('consumes a matched key even with no active tab (original map parity)', () => {
        const ctx = makeCtx();
        const e = makeEvent({ key: 'Enter' });
        expect(run(ctx, e, null)).toBe(true);
        expect(e.preventDefault).toHaveBeenCalled();
        expect(ctx.sendToTab).not.toHaveBeenCalled();
    });

    it('does nothing while IME composition is active', () => {
        const ctx = makeCtx();
        const e = makeEvent({ key: 'Enter', isComposing: true });
        expect(run(ctx, e, makeTab())).toBe(false);
        expect(ctx.sendToTab).not.toHaveBeenCalled();
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it.each([
        ['Home', '\u001b[H'],
        ['End', '\u001b[F'],
        ['Delete', '\u001b[3~'],
        ['Tab', '\t'],
    ])('forwards %s as %j', (key, bytes) => {
        const ctx = makeCtx();
        const tab = makeTab();
        expect(run(ctx, makeEvent({ key }), tab)).toBe(true);
        expect(ctx.sendToTab).toHaveBeenCalledWith(tab, bytes);
    });
});
