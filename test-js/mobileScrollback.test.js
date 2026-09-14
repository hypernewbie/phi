// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { TabManager } from '../web/terminal.js';

// Concept 5: the mobile-only scrollback lane. Desktop always keeps the
// full buffer; only the fast-mode gate (forced on for mobile viewports)
// may shrink new tabs, and only to a valid setting — 0/unset/garbage
// fails safe to full history.

function mgr({ fastMode = false, mobileRows } = {}) {
    document.body.classList.toggle('fast-mode', fastMode);
    const m = Object.create(TabManager.prototype);
    m.app = {};
    if (mobileRows !== undefined) m.app.mobileScrollbackRows = mobileRows;
    return m;
}

afterEach(() => {
    document.body.classList.remove('fast-mode');
});

describe('_liveScrollbackRows', () => {
    it('desktop keeps 10000 with no setting', () => {
        expect(mgr()._liveScrollbackRows()).toBe(10000);
    });

    it('desktop ignores the mobile setting entirely', () => {
        expect(mgr({ mobileRows: 2000 })._liveScrollbackRows()).toBe(10000);
    });

    it('fast-mode with unset/zero setting stays full', () => {
        expect(mgr({ fastMode: true })._liveScrollbackRows()).toBe(10000);
        expect(
            mgr({ fastMode: true, mobileRows: 0 })._liveScrollbackRows(),
        ).toBe(10000);
    });

    it('fast-mode with a valid setting shrinks new tabs', () => {
        expect(
            mgr({ fastMode: true, mobileRows: 2000 })._liveScrollbackRows(),
        ).toBe(2000);
        expect(
            mgr({ fastMode: true, mobileRows: 10000 })._liveScrollbackRows(),
        ).toBe(10000);
    });

    it('fast-mode fails safe to full on garbage', () => {
        for (const bad of [499, 10001, -5, 'junk', '2000x', NaN]) {
            expect(
                mgr({ fastMode: true, mobileRows: bad })._liveScrollbackRows(),
            ).toBe(10000);
        }
    });
});
