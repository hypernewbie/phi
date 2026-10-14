// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import {
    LOW_POWER_STORAGE_KEY,
    readLowPowerLocal,
    writeLowPowerLocal,
    resolveLowPowerEnabled,
} from '../web/util.js';
import { App } from '../web/app.js';
import { openSettingsModal, broadcastConfigSync } from '../web/settings.js';

setupDomHarness();

beforeEach(() => {
    vi.stubGlobal('navigator', {});
});

describe('low power browser preference (web/util.js)', () => {
    it('exposes the documented storage key', () => {
        expect(LOW_POWER_STORAGE_KEY).toBe('phi_low_power');
    });

    it('readLowPowerLocal returns null when unset', () => {
        expect(readLowPowerLocal()).toBeNull();
    });

    it('write/read round-trips on and off', () => {
        writeLowPowerLocal(true);
        expect(readLowPowerLocal()).toBe(true);
        writeLowPowerLocal(false);
        expect(readLowPowerLocal()).toBe(false);
    });

    it('readLowPowerLocal treats garbage as unset', () => {
        localStorage.setItem(LOW_POWER_STORAGE_KEY, 'yes');
        expect(readLowPowerLocal()).toBeNull();
    });

    it('resolveLowPowerEnabled prefers the browser value both ways', () => {
        localStorage.setItem(LOW_POWER_STORAGE_KEY, '1');
        expect(resolveLowPowerEnabled(false)).toBe(true);
        localStorage.setItem(LOW_POWER_STORAGE_KEY, '0');
        expect(resolveLowPowerEnabled(true)).toBe(false);
    });

    it('resolveLowPowerEnabled migrates a legacy server flag once', () => {
        expect(resolveLowPowerEnabled(true)).toBe(true);
        expect(localStorage.getItem(LOW_POWER_STORAGE_KEY)).toBe('1');
    });

    it('resolveLowPowerEnabled stays off and writes nothing without a flag', () => {
        expect(resolveLowPowerEnabled(false)).toBe(false);
        expect(localStorage.getItem(LOW_POWER_STORAGE_KEY)).toBeNull();
    });
});

describe('App.setLowPowerMode (single writer)', () => {
    it('persists locally, mirrors config in-memory, applies, and broadcasts', () => {
        const posted = [];
        const RealBC = globalThis.BroadcastChannel;
        globalThis.BroadcastChannel = class {
            postMessage(data) {
                posted.push(data);
            }
            close() {}
        };
        try {
            const app = Object.create(App.prototype);
            app.config = { fast_mode: false };
            app.setLowPowerMode(true);
            expect(localStorage.getItem(LOW_POWER_STORAGE_KEY)).toBe('1');
            expect(app.config.fast_mode).toBe(true);
            expect(document.body.classList.contains('fast-mode')).toBe(true);
            expect(posted).toEqual([{ type: 'low-power', enabled: true }]);
            app.setLowPowerMode(false);
            expect(localStorage.getItem(LOW_POWER_STORAGE_KEY)).toBe('0');
            expect(document.body.classList.contains('fast-mode')).toBe(false);
        } finally {
            globalThis.BroadcastChannel = RealBC;
        }
    });
});

describe('settings low power toggle (browser-stored, no server write)', () => {
    const ACCENTS = { purple: { accent: '#7c6af7' } };

    function buildApp() {
        const app = Object.create(App.prototype);
        app.versionInfo = { version: '1.0.0' };
        app.hostname = 'test-host';
        app.accessAuthEnabled = false;
        app.useExistingTerminalTab = false;
        app.config = { fast_mode: false };
        app.uiFontFamily = '';
        app.uiFontSize = 0;
        app.terminalFontFamily = '';
        app.terminalFontSize = 0;
        app.customFontName = '';
        app.sessionsManager = { workspaces: [] };
        app.tabManager = {};
        return app;
    }

    it('seeds the checkbox from the browser preference over the server flag', () => {
        localStorage.setItem(LOW_POWER_STORAGE_KEY, '1');
        const app = buildApp();
        app.config.fast_mode = false;
        openSettingsModal(app, ACCENTS, { standalone: true });
        expect(document.getElementById('settings-fast-mode').checked).toBe(
            true,
        );
        document.querySelector('.settings-overlay')?.remove();

        localStorage.removeItem(LOW_POWER_STORAGE_KEY);
        const app2 = buildApp();
        app2.config.fast_mode = true;
        openSettingsModal(app2, ACCENTS, { standalone: true });
        expect(document.getElementById('settings-fast-mode').checked).toBe(
            true,
        );
        document.querySelector('.settings-overlay')?.remove();
    });

    it('toggling writes local storage and never POSTs to the server', async () => {
        const fetchMock = mockFetch(() => {
            throw new Error('must not fetch');
        });
        const app = buildApp();
        openSettingsModal(app, ACCENTS, { standalone: true });
        const input = document.getElementById('settings-fast-mode');
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // The async change handler runs its broadcast on a fresh channel;
        // flush microtasks so any stray fetch would have fired.
        await new Promise((r) => setTimeout(r, 10));
        expect(localStorage.getItem(LOW_POWER_STORAGE_KEY)).toBe('1');
        expect(app.config.fast_mode).toBe(true);
        expect(document.body.classList.contains('fast-mode')).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
        document.querySelector('.settings-overlay')?.remove();
        vi.unstubAllGlobals();
    });

    it('a same-origin low-power broadcast re-applies on the listening tab', () => {
        const RealBC = globalThis.BroadcastChannel;
        const channels = [];
        globalThis.BroadcastChannel = class {
            constructor(name) {
                this.name = name;
                this.onmessage = null;
                channels.push(this);
            }
            postMessage(data) {
                for (const ch of channels) {
                    if (ch !== this && ch.name === this.name && ch.onmessage)
                        ch.onmessage({ data });
                }
            }
            close() {
                const i = channels.indexOf(this);
                if (i >= 0) channels.splice(i, 1);
            }
        };
        try {
            const app = Object.create(App.prototype);
            app.config = { fast_mode: false };
            app.tabManager = {};
            app.initCrossWindowConfigSync();
            // Another tab enables low power: localStorage is already the
            // new truth when the broadcast lands (same pattern as the
            // desktop tray fan-out script).
            localStorage.setItem(LOW_POWER_STORAGE_KEY, '1');
            broadcastConfigSync('low-power', { enabled: true });
            expect(document.body.classList.contains('fast-mode')).toBe(true);
        } finally {
            globalThis.BroadcastChannel = RealBC;
        }
    });
});
