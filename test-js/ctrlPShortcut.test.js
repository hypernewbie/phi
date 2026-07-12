import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TabManager } from '../web/terminal.js';

// Covers the Ctrl+P capture added to handleGlobalTabShortcuts: it must forward
// \x10 to the active terminal (so opencode/other TUIs get it) and stop the
// browser's print dialog, without double-sending when another handler already
// consumed the key (defaultPrevented).

function makeEvent(over = {}) {
    const e = { ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, key: 'p', defaultPrevented: false, ...over };
    e.preventDefault = vi.fn(() => { e.defaultPrevented = true; });
    return e;
}

const termTab = (over = {}) => ({ isDead: false, coder: 'opencode', ws: { sendInput: vi.fn() }, ...over });

function makeCtx(tab) {
    return { 
        getActiveTab: vi.fn(() => tab), 
        _spamScrollToBottom: vi.fn(),
        sendInput: vi.fn((t, payload) => {
            if (t && t.ws && !t.isDead) t.ws.sendInput(payload);
        })
    };
}

const run = (ctx, e) => TabManager.prototype.handleGlobalTabShortcuts.call(ctx, e);

beforeEach(() => vi.clearAllMocks());

describe('Ctrl+P capture in handleGlobalTabShortcuts', () => {
    it('forwards \\x10 to the active terminal and prevents the browser default', () => {
        const tab = termTab();
        const ctx = makeCtx(tab);
        const e = makeEvent();
        run(ctx, e);
        expect(tab.ws.sendInput).toHaveBeenCalledWith('\x10');
        expect(e.preventDefault).toHaveBeenCalled();
        expect(ctx._spamScrollToBottom).toHaveBeenCalledWith(tab);
    });

    it('handles uppercase key ("P")', () => {
        const tab = termTab();
        run(makeCtx(tab), makeEvent({ key: 'P' }));
        expect(tab.ws.sendInput).toHaveBeenCalledWith('\x10');
    });

    it('works for any live terminal coder (e.g. bash)', () => {
        const tab = termTab({ coder: 'bash' });
        run(makeCtx(tab), makeEvent());
        expect(tab.ws.sendInput).toHaveBeenCalledWith('\x10');
    });

    it('does nothing if the event was already handled (defaultPrevented)', () => {
        const tab = termTab();
        const ctx = makeCtx(tab);
        const e = makeEvent({ defaultPrevented: true });
        run(ctx, e);
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it('does nothing when there is no active tab', () => {
        const ctx = makeCtx(null);
        const e = makeEvent();
        expect(() => run(ctx, e)).not.toThrow();
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it('does nothing for a dead tab', () => {
        const tab = termTab({ isDead: true });
        run(makeCtx(tab), makeEvent());
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
    });

    it('ignores review/kanban tabs (and tabs without a ws)', () => {
        const review = { isDead: false, coder: 'review' };
        const e1 = makeEvent();
        run(makeCtx(review), e1);
        expect(e1.preventDefault).not.toHaveBeenCalled();

        const kanban = termTab({ coder: 'kanban' });
        run(makeCtx(kanban), makeEvent());
        expect(kanban.ws.sendInput).not.toHaveBeenCalled();
    });

    it('does not fire on Ctrl+Shift+P or Meta+P', () => {
        const tab = termTab();
        run(makeCtx(tab), makeEvent({ shiftKey: true }));
        run(makeCtx(tab), makeEvent({ metaKey: true }));
        run(makeCtx(tab), makeEvent({ altKey: true }));
        expect(tab.ws.sendInput).not.toHaveBeenCalled();
    });
});
