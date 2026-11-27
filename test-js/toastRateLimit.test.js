// Congressional toast discipline — term-limit half.
//
// Same key (or same unkeyed title+message) twice within 2s: dropped in
// production, THROWS in tests. The global setup
// (test-js/toast-discipline-setup.js) arms strict mode for every test
// file, so any suite that double-fires a toast fails here or at the
// emission site. Time is controlled via Date.now mocking (no fake
// timers: NotificationManager arms real deadlines).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { NotificationManager } from '../web/notifications.js';

setupDomHarness();

let managers = [];
let dateNowSpy = null;

function makeManager() {
    const manager = new NotificationManager({});
    managers.push(manager);
    return manager;
}

function freezeTime(t) {
    if (dateNowSpy) dateNowSpy.mockReturnValue(t);
    else dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(t);
}

beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
});

afterEach(() => {
    for (const manager of managers) manager.destroy();
    managers = [];
    if (dateNowSpy) {
        dateNowSpy.mockRestore();
        dateNowSpy = null;
    }
});

describe('toast discipline: 2s duplicate-emission term limit', () => {
    it('throws in strict mode when the same toast fires twice within 2s', () => {
        freezeTime(1_000_000);
        const manager = makeManager();
        expect(window.__phiToastStrict).toBe(true);
        manager.show('same thing', { title: 'Same' });
        expect(() => manager.show('same thing', { title: 'Same' })).toThrow(
            /toast discipline/,
        );
        expect(window.__phiToastViolations.length).toBe(1);
        expect(window.__phiToastViolations[0].sig).toContain('same thing');
        // Intentional violation, already asserted: clear so the global
        // afterEach backstop stays silent.
        window.__phiToastViolations = [];
    });

    it('keys scope the limit: same key twice throws even with different text', () => {
        freezeTime(2_000_000);
        const manager = makeManager();
        manager.show('first wording', { title: 'T', key: 'test-key-a' });
        expect(() =>
            manager.show('second wording', { title: 'T', key: 'test-key-a' }),
        ).toThrow(/toast discipline/);
        // Intentional violation, already asserted: clear so the global
        // afterEach backstop stays silent.
        window.__phiToastViolations = [];
    });

    it('allows the same toast again after 2s', () => {
        freezeTime(3_000_000);
        const manager = makeManager();
        manager.show('repeat me', { title: 'R' });
        freezeTime(3_000_000 + 2001);
        expect(() => manager.show('repeat me', { title: 'R' })).not.toThrow();
        expect(document.querySelectorAll('.toast').length).toBe(2);
        expect(window.__phiToastViolations.length).toBe(0);
    });

    it('drops (not throws) duplicates outside strict mode and returns the live popup', () => {
        freezeTime(4_000_000);
        window.__phiToastStrict = false;
        const manager = makeManager();
        const first = manager.show('quiet dup', { title: 'Q' });
        const second = manager.show('quiet dup', { title: 'Q' });
        expect(second).toBe(first);
        expect(document.querySelectorAll('.toast').length).toBe(1);
        // This test deliberately triggered a handled violation: clear the
        // log so the global afterEach backstop stays silent.
        window.__phiToastViolations = [];
    });
});
