import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TabManager } from '../web/terminal.js';

describe('Shift+F5 and Ctrl/Cmd+Shift+R reconnect all in handleGlobalTabShortcuts', () => {
    function makeEvent(over = {}) {
        const e = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: true, key: 'F5', defaultPrevented: false, ...over };
        e.preventDefault = vi.fn(() => { e.defaultPrevented = true; });
        return e;
    }

    function makeCtx() {
        return {
            reconnectAllTabsWithToast: vi.fn(),
            getActiveTab: vi.fn(() => null),
            tabs: new Map(),
        };
    }

    const run = (ctx, e) => TabManager.prototype.handleGlobalTabShortcuts.call(ctx, e);

    it('triggers reconnectAllTabsWithToast on Shift+F5', () => {
        const ctx = makeCtx();
        const e = makeEvent({ shiftKey: true, key: 'F5' });
        run(ctx, e);
        expect(ctx.reconnectAllTabsWithToast).toHaveBeenCalledTimes(1);
        expect(e.preventDefault).toHaveBeenCalled();
    });

    it('triggers reconnectAllTabsWithToast on Ctrl+Shift+R', () => {
        const ctx = makeCtx();
        const e = makeEvent({ ctrlKey: true, shiftKey: true, key: 'r' });
        run(ctx, e);
        expect(ctx.reconnectAllTabsWithToast).toHaveBeenCalledTimes(1);
        expect(e.preventDefault).toHaveBeenCalled();
    });

    it('triggers reconnectAllTabsWithToast on Cmd+Shift+R', () => {
        const ctx = makeCtx();
        const e = makeEvent({ metaKey: true, shiftKey: true, key: 'R' });
        run(ctx, e);
        expect(ctx.reconnectAllTabsWithToast).toHaveBeenCalledTimes(1);
        expect(e.preventDefault).toHaveBeenCalled();
    });

    it('does not trigger on Alt-modified chords', () => {
        const ctx = makeCtx();
        const e = makeEvent({ shiftKey: true, altKey: true, key: 'F5' });
        run(ctx, e);
        expect(ctx.reconnectAllTabsWithToast).not.toHaveBeenCalled();
    });
});
