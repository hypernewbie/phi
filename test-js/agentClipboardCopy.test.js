// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

// Covers the OSC 52 clipboard fix. In insecure contexts (phi served over plain
// HTTP on a LAN address) navigator.clipboard is undefined; the old handler
// called navigator.clipboard.writeText directly, which threw and left nothing
// on the clipboard even though opencode reported a copy. _agentClipboardCopy
// must never throw and must fall back to execCommand / a manual toast.

setupDomHarness();

// Real prototype methods (so this._execCommandCopy resolves), fake app.
function ctx() {
    const c = Object.create(TabManager.prototype);
    c.app = { showToast: vi.fn() };
    return c;
}
const call = (c, text) =>
    TabManager.prototype._agentClipboardCopy.call(c, text);

function setSecureClipboard(writeImpl) {
    Object.defineProperty(window, 'isSecureContext', {
        value: true,
        configurable: true,
    });
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(writeImpl) } });
}
function setInsecureNoClipboard() {
    Object.defineProperty(window, 'isSecureContext', {
        value: false,
        configurable: true,
    });
    vi.stubGlobal('navigator', {}); // no clipboard, as in an insecure context
}

beforeEach(() => {
    vi.clearAllMocks();
    document.execCommand = vi.fn(() => false); // jsdom has no real impl; tests override
});
afterEach(() => {
    delete document.execCommand;
    Object.defineProperty(window, 'isSecureContext', {
        value: false,
        configurable: true,
    });
});

describe('_agentClipboardCopy', () => {
    it('uses the async Clipboard API in a secure context and toasts success', async () => {
        setSecureClipboard(async () => {});
        const c = ctx();
        await call(c, 'hello');
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello');
        expect(c.app.showToast).toHaveBeenCalledWith(
            'Agent copied 5 characters to clipboard',
            expect.objectContaining({ title: 'Clipboard Sync' }),
        );
    });

    it('does NOT throw in an insecure context with no navigator.clipboard', () => {
        setInsecureNoClipboard();
        expect(() => call(ctx(), 'hello')).not.toThrow();
    });

    it('falls back to execCommand in an insecure context and toasts success on copy', () => {
        setInsecureNoClipboard();
        document.execCommand.mockReturnValue(true);
        const c = ctx();
        call(c, 'clipboard text');
        expect(document.execCommand).toHaveBeenCalledWith('copy');
        expect(c.app.showToast).toHaveBeenCalledWith(
            'Agent copied 14 characters to clipboard',
            expect.objectContaining({ title: 'Clipboard Sync' }),
        );
    });

    it('offers a manual copy toast when execCommand also fails', () => {
        setInsecureNoClipboard();
        document.execCommand.mockReturnValue(false);
        const c = ctx();
        call(c, 'x');
        const [, opts] = c.app.showToast.mock.calls[0];
        expect(opts).toMatchObject({ title: 'Clipboard Sync' });
        expect(opts.action).toBeTruthy();
        expect(opts.action.text).toBe('Copy to Clipboard');
        expect(typeof opts.action.callback).toBe('function');
    });

    it('falls back to execCommand when the async writeText rejects', async () => {
        setSecureClipboard(async () => {
            throw new Error('denied');
        });
        document.execCommand.mockReturnValue(true);
        const c = ctx();
        await call(c, 'abc');
        expect(document.execCommand).toHaveBeenCalledWith('copy');
        expect(c.app.showToast).toHaveBeenCalledWith(
            'Agent copied 3 characters to clipboard',
            expect.objectContaining({ title: 'Clipboard Sync' }),
        );
    });
});

describe('_execCommandCopy', () => {
    it('returns execCommand result and cleans up the textarea', () => {
        document.execCommand.mockReturnValue(true);
        const before = document.querySelectorAll('textarea').length;
        const ok = TabManager.prototype._execCommandCopy.call(ctx(), 'data');
        expect(ok).toBe(true);
        expect(document.execCommand).toHaveBeenCalledWith('copy');
        expect(document.querySelectorAll('textarea').length).toBe(before); // removed
    });

    it('returns false (does not throw) when execCommand throws', () => {
        document.execCommand.mockImplementation(() => {
            throw new Error('nope');
        });
        expect(TabManager.prototype._execCommandCopy.call(ctx(), 'data')).toBe(
            false,
        );
    });
});
