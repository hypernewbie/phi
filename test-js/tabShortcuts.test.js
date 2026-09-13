import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TabManager } from '../web/terminal.js';
import { tabShortcutDigit, isMacPlatform } from '../web/util.js';

describe('tabShortcutDigit', () => {
    it('extracts digits 1 to 9 from standard key values', () => {
        for (let i = 1; i <= 9; i++) {
            expect(tabShortcutDigit({ key: String(i) })).toBe(i);
        }
    });

    it('extracts digits from physical code when macOS Option modifies key', () => {
        const macOptionSamples = [
            { key: '¡', code: 'Digit1', expected: 1 },
            { key: '™', code: 'Digit2', expected: 2 },
            { key: '£', code: 'Digit3', expected: 3 },
            { key: '¢', code: 'Digit4', expected: 4 },
            { key: '∞', code: 'Digit5', expected: 5 },
            { key: '§', code: 'Digit6', expected: 6 },
            { key: '¶', code: 'Digit7', expected: 7 },
            { key: '•', code: 'Digit8', expected: 8 },
            { key: 'ª', code: 'Digit9', expected: 9 },
        ];
        for (const sample of macOptionSamples) {
            expect(tabShortcutDigit(sample)).toBe(sample.expected);
        }
    });

    it('returns null for non-digit keys', () => {
        expect(tabShortcutDigit({ key: '0' })).toBeNull();
        expect(tabShortcutDigit({ key: 'a' })).toBeNull();
        expect(tabShortcutDigit({ code: 'KeyA' })).toBeNull();
        expect(tabShortcutDigit({})).toBeNull();
    });
});

describe('isMacPlatform', () => {
    const originalPlatform = navigator.platform;

    afterEach(() => {
        Object.defineProperty(navigator, 'platform', {
            value: originalPlatform,
            configurable: true,
        });
    });

    it('identifies Mac platform correctly', () => {
        Object.defineProperty(navigator, 'platform', {
            value: 'MacIntel',
            configurable: true,
        });
        expect(isMacPlatform()).toBe(true);
    });

    it('identifies non-Mac platform correctly', () => {
        Object.defineProperty(navigator, 'platform', {
            value: 'Win32',
            configurable: true,
        });
        expect(isMacPlatform()).toBe(false);
    });
});

describe('TabManager.handleGlobalTabShortcuts tab switching', () => {
    const originalPlatform = navigator.platform;

    function makeEvent(over = {}) {
        const e = {
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            shiftKey: false,
            key: '1',
            code: 'Digit1',
            defaultPrevented: false,
            ...over,
        };
        e.preventDefault = vi.fn(() => {
            e.defaultPrevented = true;
        });
        return e;
    }

    function makeCtx(tabCount = 4) {
        const tabs = new Map();
        for (let i = 1; i <= tabCount; i++) {
            tabs.set(`pane-${i}`, { paneId: `pane-${i}` });
        }
        return {
            tabs,
            switchTab: vi.fn(),
            reconnectAllTabsWithToast: vi.fn(),
            getActiveTab: vi.fn(() => null),
        };
    }

    const run = (ctx, e) =>
        TabManager.prototype.handleGlobalTabShortcuts.call(ctx, e);

    beforeEach(() => {
        Object.defineProperty(navigator, 'platform', {
            value: 'MacIntel',
            configurable: true,
        });
    });

    afterEach(() => {
        Object.defineProperty(navigator, 'platform', {
            value: originalPlatform,
            configurable: true,
        });
    });

    it('switches to tab index via Alt+1 on any platform', () => {
        const ctx = makeCtx(4);
        const e = makeEvent({ altKey: true, key: '2', code: 'Digit2' });
        run(ctx, e);
        expect(e.preventDefault).toHaveBeenCalled();
        expect(ctx.switchTab).toHaveBeenCalledWith('pane-2', {
            userInitiated: true,
        });
    });

    it('switches to last tab via Alt+9', () => {
        const ctx = makeCtx(4);
        const e = makeEvent({ altKey: true, key: '9', code: 'Digit9' });
        run(ctx, e);
        expect(e.preventDefault).toHaveBeenCalled();
        expect(ctx.switchTab).toHaveBeenCalledWith('pane-4', {
            userInitiated: true,
        });
    });

    it('switches to tab via Cmd+1..9 on macOS', () => {
        const ctx = makeCtx(4);
        const e = makeEvent({ metaKey: true, key: '3', code: 'Digit3' });
        run(ctx, e);
        expect(e.preventDefault).toHaveBeenCalled();
        expect(ctx.switchTab).toHaveBeenCalledWith('pane-3', {
            userInitiated: true,
        });
    });

    it('switches to last tab via Cmd+9 on macOS', () => {
        const ctx = makeCtx(4);
        const e = makeEvent({ metaKey: true, key: '9', code: 'Digit9' });
        run(ctx, e);
        expect(e.preventDefault).toHaveBeenCalled();
        expect(ctx.switchTab).toHaveBeenCalledWith('pane-4', {
            userInitiated: true,
        });
    });

    it('switches to tab via Option+1 on macOS where key is ¡ and code is Digit1', () => {
        const ctx = makeCtx(4);
        const e = makeEvent({ altKey: true, key: '¡', code: 'Digit1' });
        run(ctx, e);
        expect(e.preventDefault).toHaveBeenCalled();
        expect(ctx.switchTab).toHaveBeenCalledWith('pane-1', {
            userInitiated: true,
        });
    });

    it('switches to last tab via Option+9 on macOS where key is ª and code is Digit9', () => {
        const ctx = makeCtx(4);
        const e = makeEvent({ altKey: true, key: 'ª', code: 'Digit9' });
        run(ctx, e);
        expect(e.preventDefault).toHaveBeenCalled();
        expect(ctx.switchTab).toHaveBeenCalledWith('pane-4', {
            userInitiated: true,
        });
    });

    it('ignores Ctrl+number chords (reserved for rail / control codes)', () => {
        const ctx = makeCtx(4);
        const e = makeEvent({ ctrlKey: true, key: '1', code: 'Digit1' });
        run(ctx, e);
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(ctx.switchTab).not.toHaveBeenCalled();
    });

    it('ignores Shift-modified chords', () => {
        const ctx = makeCtx(4);
        const e = makeEvent({
            altKey: true,
            shiftKey: true,
            key: '1',
            code: 'Digit1',
        });
        run(ctx, e);
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(ctx.switchTab).not.toHaveBeenCalled();
    });

    it('does not switch when tab index is beyond tab count', () => {
        const ctx = makeCtx(2);
        const e = makeEvent({ altKey: true, key: '4', code: 'Digit4' });
        run(ctx, e);
        expect(ctx.switchTab).not.toHaveBeenCalled();
    });
});
