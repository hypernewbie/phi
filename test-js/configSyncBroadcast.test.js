// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { openSettingsModal, broadcastConfigSync } from '../web/settings.js';
import { App } from '../web/app.js';

setupDomHarness();

const ACCENTS = {
    purple: { accent: '#7c6af7' },
    green: { accent: '#2ecc71' },
};

describe('Cross-window config and theme sync via BroadcastChannel', () => {
    let originalBroadcastChannel;
    let mockChannels = [];

    beforeEach(() => {
        mockChannels = [];
        originalBroadcastChannel = globalThis.BroadcastChannel;

        // Custom BroadcastChannel mock that connects all instances with the same name
        globalThis.BroadcastChannel = class MockBroadcastChannel {
            constructor(name) {
                this.name = name;
                this.onmessage = null;
                mockChannels.push(this);
            }
            postMessage(data) {
                for (const ch of mockChannels) {
                    if (
                        ch !== this &&
                        ch.name === this.name &&
                        typeof ch.onmessage === 'function'
                    ) {
                        ch.onmessage({ data });
                    }
                }
            }
            close() {
                const idx = mockChannels.indexOf(this);
                if (idx >= 0) mockChannels.splice(idx, 1);
            }
        };
    });

    afterEach(() => {
        globalThis.BroadcastChannel = originalBroadcastChannel;
    });

    it('broadcastConfigSync posts to phi_config_sync channel', () => {
        const listener = new globalThis.BroadcastChannel('phi_config_sync');
        const messages = [];
        listener.onmessage = (e) => messages.push(e.data);

        broadcastConfigSync('theme', { color: 'green' });
        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual({ type: 'theme', color: 'green' });
    });

    it('swatch click in settings modal triggers broadcastConfigSync', () => {
        const listener = new globalThis.BroadcastChannel('phi_config_sync');
        const messages = [];
        listener.onmessage = (e) => messages.push(e.data);

        const mockApp = {
            applyAccentTheme: vi.fn(),
            saveTheme: vi.fn(),
            versionInfo: { version: '1.0.0' },
            hostname: 'test-host',
            accessAuthEnabled: false,
            useExistingTerminalTab: false,
            config: {},
            uiFontFamily: '',
            uiFontSize: 0,
            terminalFontFamily: '',
            terminalFontSize: 0,
            customFontName: '',
            sessionsManager: { workspaces: [] },
            tabManager: {},
        };

        openSettingsModal(mockApp, ACCENTS, { standalone: true });
        const greenSwatch = document.querySelector(
            '.settings-swatch[data-color="green"]',
        );
        expect(greenSwatch).toBeTruthy();
        greenSwatch.click();

        expect(mockApp.applyAccentTheme).toHaveBeenCalledWith('green');
        expect(mockApp.saveTheme).toHaveBeenCalledWith('green');
        expect(
            messages.some((m) => m.type === 'theme' && m.color === 'green'),
        ).toBe(true);

        document.querySelector('.settings-overlay')?.remove();
    });

    it('App.prototype.initCrossWindowConfigSync updates theme when broadcast received', () => {
        const app = Object.create(App.prototype);
        app.applyAccentTheme = vi.fn();
        app.tabManager = {
            applyThemeToAllActiveTerminals: vi.fn(),
            applyFontToAllActiveTerminals: vi.fn(),
            applyTerminalFontSizeToAll: vi.fn(),
        };

        app.initCrossWindowConfigSync();

        broadcastConfigSync('theme', { color: 'purple' });

        expect(app.applyAccentTheme).toHaveBeenCalledWith('purple');
        expect(
            app.tabManager.applyThemeToAllActiveTerminals,
        ).toHaveBeenCalled();
    });

    it('App.prototype.initCrossWindowConfigSync updates appearance when broadcast received', () => {
        const app = Object.create(App.prototype);
        app.applyUIFont = vi.fn();
        app.tabManager = {
            applyThemeToAllActiveTerminals: vi.fn(),
            applyFontToAllActiveTerminals: vi.fn(),
            applyTerminalFontSizeToAll: vi.fn(),
        };

        localStorage.setItem(
            'phi_appearance',
            JSON.stringify({
                ui_font_family: 'Roboto',
                ui_font_size: 16,
                terminal_font_family: 'Fira Code',
                terminal_font_size: 15,
            }),
        );

        app.initCrossWindowConfigSync();

        broadcastConfigSync('appearance');

        expect(app.uiFontFamily).toBe('Roboto');
        expect(app.uiFontSize).toBe(16);
        expect(app.terminalFontFamily).toBe('Fira Code');
        expect(app.terminalFontSize).toBe(15);
        expect(app.applyUIFont).toHaveBeenCalled();
        expect(
            app.tabManager.applyFontToAllActiveTerminals,
        ).toHaveBeenCalledWith('Fira Code');
        expect(app.tabManager.applyTerminalFontSizeToAll).toHaveBeenCalledWith(
            15,
        );
    });
});
