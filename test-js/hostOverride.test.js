// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PTYWebSocket } from '../web/ws.js';
import { openSettingsModal } from '../web/settings.js';

// hostname_override is a DISPLAY LABEL only: server state that rides the
// config payload. Socket dialing always uses the real page origin, and the
// client keeps no copy of the label at all — so no label value, however
// absurd, can reach a socket URL. The label is free-form text: a corp PC
// named CORP01 can display as "dusty_potato" or a 50-character haiku
// because it never has to resolve as a hostname.

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('socket URLs use the page origin', () => {
    function stubSocket() {
        const seen = [];
        vi.stubGlobal(
            'WebSocket',
            class {
                constructor(url, protocols) {
                    this.url = url;
                    seen.push([url, protocols]);
                    this.readyState = 0;
                }
            },
        );
        return seen;
    }

    it('pane socket dials the page origin', () => {
        const seen = stubSocket();
        const pty = new PTYWebSocket('p1', () => {});
        expect(pty.url).toBe(
            `${window.location.origin}/ws/pane/p1?state=ansi-v1`,
        );
        expect(seen[0][1]).toBe('phi.terminal.protobuf.v3');
        pty.ws?.close?.();
    });
});

describe('settings hostname row', () => {
    function buildApp() {
        return {
            versionInfo: { version: '0.21.0' },
            hostname: 'server',
            uiFontFamily: '',
            uiFontSize: 0,
            terminalFontFamily: '',
            terminalFontSize: 0,
            mobileScrollbackRows: 0,
            hostnameOverride: '',
            useExistingTerminalTab: false,
            useHiddenTerminal: false,
            terminalActivity: false,
            accessAuthEnabled: false,
            codersPresetRegistry: {},
            sessionsManager: { workspaces: [] },
            tabManager: {},
            applyAccentTheme: vi.fn(),
            applyUIFont: vi.fn(),
            saveTheme: vi.fn().mockResolvedValue(undefined),
            persistAppearance: vi.fn().mockResolvedValue(undefined),
            _saveAppearanceLocal: vi.fn(),
        };
    }

    it('renders blank by default with a nickname placeholder', () => {
        document.body.innerHTML = '<div id="settings-root"></div>';
        openSettingsModal(buildApp(), []);
        const input = document.getElementById('settings-hostname-override');
        expect(input).toBeTruthy();
        expect(input.value).toBe('');
        // The placeholder suggests a label, not a dial target.
        expect(input.placeholder).toContain('dusty_potato');
    });

    it('typing a haiku updates the label without touching sockets', () => {
        const seen = [];
        vi.stubGlobal(
            'WebSocket',
            class {
                constructor(url) {
                    seen.push(url);
                    this.readyState = 0;
                }
            },
        );
        document.body.innerHTML = '<div id="settings-root"></div>';
        const app = buildApp();
        openSettingsModal(app, []);
        const input = document.getElementById('settings-hostname-override');
        const haiku = 'ふるいけや'.repeat(10).slice(0, 50);
        input.value = haiku;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(app.hostnameOverride).toBe(haiku);
        expect(app._saveAppearanceLocal).toHaveBeenCalled();
        // No socket was constructed by typing a label.
        expect(seen.length).toBe(0);
    });

    it('clearing restores the real hostname as the label', () => {
        document.body.innerHTML = '<div id="settings-root"></div>';
        const app = buildApp();
        app.hostnameOverride = 'dusty_potato';
        openSettingsModal(app, []);
        const input = document.getElementById('settings-hostname-override');
        expect(input.value).toBe('dusty_potato');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(app.hostnameOverride).toBe('');
    });
});
