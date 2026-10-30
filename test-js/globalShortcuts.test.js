// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { App } from '../web/app.js';

// Review-fixup test: initGlobalShortcuts() is defined in app.js (Ctrl+Shift+D
// opens the diag modal) but was never invoked from init(), making the diag
// panel completely unreachable from the UI. This test guards both that the
// method wires the listener correctly, and that init() actually calls it.

setupDomHarness();

function makeApp() {
    const a = Object.create(App.prototype);
    a.markdownManager = { openDiagModal: vi.fn() };
    return a;
}

describe('App.initGlobalShortcuts', () => {
    it('opens the diag modal on Ctrl+Shift+D', () => {
        const a = makeApp();
        a.initGlobalShortcuts();

        const evt = new KeyboardEvent('keydown', {
            key: 'D',
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        });
        document.dispatchEvent(evt);

        expect(a.markdownManager.openDiagModal).toHaveBeenCalledTimes(1);
    });

    it('is case-insensitive on the key (lowercase d)', () => {
        const a = makeApp();
        a.initGlobalShortcuts();

        const evt = new KeyboardEvent('keydown', {
            key: 'd',
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        });
        document.dispatchEvent(evt);

        expect(a.markdownManager.openDiagModal).toHaveBeenCalledTimes(1);
    });

    it('does not fire without both Ctrl and Shift held', () => {
        const a = makeApp();
        a.initGlobalShortcuts();

        document.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'D',
                ctrlKey: true,
                shiftKey: false,
                bubbles: true,
                cancelable: true,
            }),
        );
        document.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'D',
                ctrlKey: false,
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            }),
        );

        expect(a.markdownManager.openDiagModal).not.toHaveBeenCalled();
    });

    it('mounts controls early but reports readiness only after background initialization', async () => {
        const a = makeApp();
        let finish;
        a.applyFastMode = vi.fn();
        a.initOnce = vi.fn();
        a.revalidate = vi.fn(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const initializing = a.init();
        expect(a.initOnce).toHaveBeenCalledOnce();
        expect(log).not.toHaveBeenCalled();
        finish();
        await initializing;
        expect(log).toHaveBeenCalledWith('[app] Phi initialized successfully');
    });

    it('is actually called from App.init() so the shortcut is live', async () => {
        // Regression guard for the exact bug found in review: the method
        // existed but init() never called it. init() delegates to initOnce()
        // so Settings mounts before background reads; initOnce() must call
        // initGlobalShortcuts.
        const initSrc = App.prototype.init.toString();
        expect(initSrc).toContain('initOnce');
        const onceSrc = App.prototype.initOnce.toString();
        expect(onceSrc).toContain('initGlobalShortcuts');
    });
});
