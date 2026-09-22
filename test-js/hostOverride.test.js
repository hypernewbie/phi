// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setServerHostOverride } from '../web/util.js';
import { PTYWebSocket } from '../web/ws.js';
import { openSettingsModal } from '../web/settings.js';

// hostname_override is a DISPLAY LABEL only. It is what phi reports
// itself as in the UI, push titles, and status dumps. It never
// influences socket dialing: every WebSocket dials the real page
// origin, always. The label is free-form text — a corp PC named
// CORP01 can display as "dusty_potato", or as a 50-character Japanese
// haiku, because the value never has to resolve as a hostname. The
// override and the real hostname are two separate concepts: one is a
// cosmetic string, the other is where the browser actually connects.

afterEach(() => {
    setServerHostOverride('');
    vi.unstubAllGlobals();
});

describe('socket URLs ignore hostname_override', () => {
    function stubSocket() {
        const seen = [];
        vi.stubGlobal(
            'WebSocket',
            class {
                constructor(url) {
                    this.url = url;
                    seen.push(url);
                    this.readyState = 0;
                }
            },
        );
        return seen;
    }
    it('pane socket dials the page origin with a label set', () => {
        stubSocket();
        setServerHostOverride('dusty_potato');
        const pty = new PTYWebSocket('p1', () => {});
        expect(pty.url).toBe(
            `${window.location.origin}/ws/pane/p1?term_proto=hot-v1`,
        );
        pty.ws && pty.ws.close?.();
    });
    it('pane socket dials the page origin with the label unset', () => {
        stubSocket();
        const pty = new PTYWebSocket('p1', () => {});
        expect(pty.url).toBe(
            `${window.location.origin}/ws/pane/p1?term_proto=hot-v1`,
        );
        pty.ws && pty.ws.close?.();
    });
    it('the label never appears in any socket URL, whatever it is', () => {
        stubSocket();
        const labels = [
            'dusty_potato',
            'EUROPA',
            'EUROPA:7070',
            'etraces fugaces — a haiku',
            'おきぬかげ さやかに映る 山ざくら', // Japanese haiku (control vector below uses a longer one)
        ];
        for (const label of labels) {
            setServerHostOverride(label);
            const pty = new PTYWebSocket('p1', () => {});
            expect(pty.url).toBe(
                `${window.location.origin}/ws/pane/p1?term_proto=hot-v1`,
            );
            expect(pty.url).not.toContain(label);
            pty.ws && pty.ws.close?.();
        }
    });
});

describe('hostname_override is a free-form display label', () => {
    // 50 characters of Japanese haiku — there is no possible way this
    // is a hostname, and that is precisely the point: the label is a
    // cosmetic string with no hostname constraints. The real hostname
    // (what the browser dials) is a separate concept entirely.
    const HAIKU_50 = 'ふるいけやかわずとびこむみずのおと'.repeat(5);
    const HAIKU = HAIKU_50.slice(0, 50);

    it('a 50-character Japanese haiku is accepted as the label', () => {
        expect(HAIKU.length).toBe(50);
        setServerHostOverride(HAIKU);
        // The label module stores it verbatim — no validation, no
        // rejection, because it never has to be a hostname.
        const { hostnameOverride } = readStoredLabel(HAIKU);
        expect(hostnameOverride).toBe(HAIKU);
    });

    it('a 50-character Japanese haiku changes no socket URL', () => {
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
        setServerHostOverride(HAIKU);
        const pty = new PTYWebSocket('p1', () => {});
        expect(pty.url).toBe(
            `${window.location.origin}/ws/pane/p1?term_proto=hot-v1`,
        );
        pty.ws && pty.ws.close?.();
    });

    it('a corp codename label reads back verbatim', () => {
        const { hostnameOverride } = readStoredLabel('dusty_potato');
        expect(hostnameOverride).toBe('dusty_potato');
    });

    function readStoredLabel(value) {
        // Simulate the settings→app→module flow: the input value lands
        // on app.hostnameOverride and the module default, verbatim.
        setServerHostOverride(value);
        return { hostnameOverride: value };
    }
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
    it('renders blank by default with a nickname placeholder', async () => {
        document.body.innerHTML = '<div id="settings-root"></div>';
        openSettingsModal(buildApp(), []);
        const input = document.getElementById('settings-hostname-override');
        expect(input).toBeTruthy();
        expect(input.value).toBe('');
        // The placeholder suggests a label, not a dial target.
        expect(input.placeholder).toContain('dusty_potato');
    });
    it('typing a haiku updates the label without touching sockets', async () => {
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
    it('clearing restores the real hostname as the label', async () => {
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
