// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveServerHost, setServerHostOverride } from '../web/util.js';
import { PTYWebSocket } from '../web/ws.js';
import { openSettingsModal } from '../web/settings.js';

// Hostname override: blank (default) means the page host — fully backwards
// compatible. Vectors marked [shared] mirror Go's sanitizeHostnameOverride
// (appearance_handlers_test.go); both sides must accept the same values.

afterEach(() => {
    setServerHostOverride('');
    vi.unstubAllGlobals();
});

describe('resolveServerHost', () => {
    const pageHost = window.location.host;
    it('blank means the page host', () => {
        expect(resolveServerHost()).toBe(pageHost);
        expect(resolveServerHost('')).toBe(pageHost);
        expect(resolveServerHost('   ')).toBe(pageHost);
        expect(resolveServerHost(null)).toBe(pageHost);
    });
    it('accepts host and host:port [shared]', () => {
        expect(resolveServerHost('example.com')).toBe('example.com');
        expect(resolveServerHost('example.com:8080')).toBe('example.com:8080');
        expect(resolveServerHost('  example.com:8080  ')).toBe(
            'example.com:8080',
        );
        expect(resolveServerHost('[::1]:9000')).toBe('[::1]:9000');
    });
    it('strips schemes and paths [shared]', () => {
        expect(resolveServerHost('https://example.com:8080/path')).toBe(
            'example.com:8080',
        );
        expect(resolveServerHost('ws://example.com/ws')).toBe('example.com');
        expect(resolveServerHost('example.com/a?b')).toBe('example.com');
    });
    it('garbage fails safe to the page host [shared]', () => {
        for (const bad of [
            'not a host!',
            'user@example.com',
            'example.com:abc',
            'http://',
            '-leading-dash.com',
            'ho st',
            '[]',
        ]) {
            expect(resolveServerHost(bad)).toBe(pageHost);
        }
    });
    it('module default applies when no explicit value is given', () => {
        setServerHostOverride('example.com:1234');
        expect(resolveServerHost()).toBe('example.com:1234');
        // Explicit values win over the default.
        expect(resolveServerHost('other.test')).toBe('other.test');
        expect(resolveServerHost('')).toBe('example.com:1234');
    });
});

describe('socket URLs follow the override', () => {
    function stubSocket() {
        const seen = [];
        vi.stubGlobal(
            'WebSocket',
            class {
                constructor(url) {
                    this.url = url;
                    seen.push(url);
                }
            },
        );
        return seen;
    }
    it('pane socket uses the override host', () => {
        stubSocket();
        const pty = new PTYWebSocket('p1', () => {}, null, null, null, {
            serverHost: 'example.com:1234',
        });
        expect(pty.url).toBe(
            `ws://example.com:1234/ws/pane/p1?term_proto=hot-v1`,
        );
        pty.ws && pty.ws.close?.();
    });
    it('pane socket keeps the page host by default', () => {
        stubSocket();
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const pty = new PTYWebSocket('p1', () => {});
        expect(pty.url).toBe(
            `${proto}//${window.location.host}/ws/pane/p1?term_proto=hot-v1`,
        );
        pty.ws && pty.ws.close?.();
    });
    it('pane socket follows the module default', () => {
        stubSocket();
        setServerHostOverride('example.com:1234');
        const pty = new PTYWebSocket('p1', () => {});
        expect(pty.url).toContain('//example.com:1234/ws/pane/p1');
        pty.ws && pty.ws.close?.();
    });
});

describe('settings hostname row', () => {
    function buildApp() {
        const app = {
            versionInfo: { version: '0.20.6' },
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
        return app;
    }
    it('renders blank by default with the page host as placeholder', () => {
        document.body.innerHTML = '<div id="settings-root"></div>';
        openSettingsModal(buildApp(), []);
        const input = document.getElementById('settings-hostname-override');
        expect(input).toBeTruthy();
        expect(input.value).toBe('');
        expect(input.placeholder).toBe(window.location.host);
    });
    it('typing updates the app, the socket default, and persists', () => {
        document.body.innerHTML = '<div id="settings-root"></div>';
        const app = buildApp();
        openSettingsModal(app, []);
        const input = document.getElementById('settings-hostname-override');
        input.value = 'example.com:1234';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(app.hostnameOverride).toBe('example.com:1234');
        expect(resolveServerHost()).toBe('example.com:1234');
        expect(app._saveAppearanceLocal).toHaveBeenCalled();
    });
    it('clearing restores page-host behavior', () => {
        document.body.innerHTML = '<div id="settings-root"></div>';
        const app = buildApp();
        app.hostnameOverride = 'example.com:1234';
        openSettingsModal(app, []);
        const input = document.getElementById('settings-hostname-override');
        expect(input.value).toBe('example.com:1234');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(app.hostnameOverride).toBe('');
        expect(resolveServerHost()).toBe(window.location.host);
    });
});
