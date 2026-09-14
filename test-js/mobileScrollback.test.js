// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { TabManager } from '../web/terminal.js';
import { App } from '../web/app.js';

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

describe('applyFastMode device-mobile input', () => {
    // jsdom has no matchMedia, so the geometry input is always false
    // here — a wide-viewport desktop, exactly the case a massive tablet
    // needs the device flag to override.
    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.classList.remove('fast-mode');
    });

    function apply({ config = {}, userAgentData } = {}) {
        if (userAgentData !== undefined)
            vi.stubGlobal('navigator', { userAgentData });
        else vi.stubGlobal('navigator', {});
        App.prototype.applyFastMode.call({ config });
        return document.body.classList.contains('fast-mode');
    }

    it('wide viewport without the flag stays desktop', () => {
        expect(apply()).toBe(false);
    });

    it('device-mobile flag forces fast-mode on a wide viewport', () => {
        expect(apply({ userAgentData: { mobile: true } })).toBe(true);
    });

    it('flag false or absent falls back to existing logic', () => {
        expect(apply({ userAgentData: { mobile: false } })).toBe(false);
        expect(apply({ userAgentData: {} })).toBe(false);
    });

    it('user fast_mode still wins regardless of the flag', () => {
        expect(apply({ config: { fast_mode: true } })).toBe(true);
        expect(
            apply({
                config: { fast_mode: true },
                userAgentData: { mobile: false },
            }),
        ).toBe(true);
    });
});
