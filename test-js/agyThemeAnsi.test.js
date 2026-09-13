// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import {
    DEFAULT_ANSI_THEME,
    getTerminalTheme,
    TabManager,
} from '../web/terminal.js';
import { ACCENT_COLORS } from '../web/theme.js';
import { openSettingsModal } from '../web/settings.js';

setupDomHarness();

describe('getTerminalTheme', () => {
    beforeEach(() => {
        document.documentElement.setAttribute('data-theme-color', 'purple');
        document.documentElement.style.setProperty('--accent', '#7c6af7');
    });

    it('returns default ANSI theme for non-agy coders even when agy_theme_ansi is enabled', () => {
        const config = { agy_theme_ansi: true };
        for (const coder of ['bash', 'pwsh', 'claude', 'pi', 'opencode']) {
            const theme = getTerminalTheme(coder, '#7c6af7', config, 'purple');
            expect(theme.blue).toBe(DEFAULT_ANSI_THEME.blue);
            expect(theme.cyan).toBe(DEFAULT_ANSI_THEME.cyan);
            expect(theme.magenta).toBe(DEFAULT_ANSI_THEME.magenta);
            expect(theme.red).toBe(DEFAULT_ANSI_THEME.red);
            expect(theme.green).toBe(DEFAULT_ANSI_THEME.green);
            expect(theme.cursor).toBe('#7c6af7');
        }
    });

    it('returns default ANSI theme for agy when agy_theme_ansi is disabled', () => {
        const config = { agy_theme_ansi: false };
        const theme = getTerminalTheme('agy', '#7c6af7', config, 'purple');
        expect(theme.blue).toBe(DEFAULT_ANSI_THEME.blue);
        expect(theme.cyan).toBe(DEFAULT_ANSI_THEME.cyan);
        expect(theme.magenta).toBe(DEFAULT_ANSI_THEME.magenta);
        expect(theme.cursor).toBe('#7c6af7');
    });

    it('returns harmonised ANSI palette for agy when agy_theme_ansi is enabled', () => {
        const config = { agy_theme_ansi: true };
        const purpleTokens = ACCENT_COLORS.purple;
        const theme = getTerminalTheme('agy', null, config, 'purple');

        expect(theme.cyan).toBe(purpleTokens.accent);
        expect(theme.brightCyan).toBe(purpleTokens.accentBright);
        expect(theme.magenta).toBe(purpleTokens.accent);
        expect(theme.brightMagenta).toBe(purpleTokens.accentBright);
        expect(theme.blue).toBe(purpleTokens.accentDim);
        expect(theme.brightBlue).toBe(purpleTokens.accentBright);
        expect(theme.cursor).toBe(purpleTokens.accent);
        expect(theme.selectionBackground).toBe(`${purpleTokens.accent}40`);

        // Semantic colours must remain intact
        expect(theme.red).toBe(DEFAULT_ANSI_THEME.red);
        expect(theme.green).toBe(DEFAULT_ANSI_THEME.green);
        expect(theme.yellow).toBe(DEFAULT_ANSI_THEME.yellow);
        expect(theme.black).toBe(DEFAULT_ANSI_THEME.black);
        expect(theme.white).toBe(DEFAULT_ANSI_THEME.white);
    });

    it('adapts to different active themes for agy (e.g. gold, emerald)', () => {
        const config = { agy_theme_ansi: true };
        const goldTokens = ACCENT_COLORS.gold;
        const goldTheme = getTerminalTheme('agy', null, config, 'gold');

        expect(goldTheme.cyan).toBe(goldTokens.accent);
        expect(goldTheme.magenta).toBe(goldTokens.accent);
        expect(goldTheme.blue).toBe(goldTokens.accentDim);
        expect(goldTheme.brightBlue).toBe(goldTokens.accentBright);

        const emeraldTokens = ACCENT_COLORS.emerald;
        const emeraldTheme = getTerminalTheme('agy', null, config, 'emerald');

        expect(emeraldTheme.cyan).toBe(emeraldTokens.accent);
        expect(emeraldTheme.magenta).toBe(emeraldTokens.accent);
        expect(emeraldTheme.blue).toBe(emeraldTokens.accentDim);
        expect(emeraldTheme.brightBlue).toBe(emeraldTokens.accentBright);
    });
});

describe('TabManager.applyThemeToAllActiveTerminals', () => {
    it('updates agy and non-agy tabs with appropriate palettes', () => {
        const tabManager = Object.create(TabManager.prototype);
        tabManager.app = {
            config: { agy_theme_ansi: true },
        };
        tabManager.tabs = new Map();

        const bashTerm = { options: { theme: { ...DEFAULT_ANSI_THEME } } };
        const agyTerm = { options: { theme: { ...DEFAULT_ANSI_THEME } } };

        tabManager.tabs.set('tab-1', { coder: 'bash', term: bashTerm });
        tabManager.tabs.set('tab-2', { coder: 'agy', term: agyTerm });

        document.documentElement.setAttribute('data-theme-color', 'cyan');
        document.documentElement.style.setProperty('--accent', '#06b6d4');

        tabManager.applyThemeToAllActiveTerminals('#06b6d4');

        // bash tab receives updated cursor only
        expect(bashTerm.options.theme.cursor).toBe('#06b6d4');
        expect(bashTerm.options.theme.cyan).toBe(DEFAULT_ANSI_THEME.cyan);

        // agy tab receives harmonised cyan palette
        const cyanTokens = ACCENT_COLORS.cyan;
        expect(agyTerm.options.theme.cursor).toBe(cyanTokens.accent);
        expect(agyTerm.options.theme.cyan).toBe(cyanTokens.accent);
        expect(agyTerm.options.theme.blue).toBe(cyanTokens.accentDim);
        expect(agyTerm.options.theme.brightBlue).toBe(cyanTokens.accentBright);
    });
});

describe('Settings Modal Agy Theme ANSI toggle', () => {
    it('renders the checkbox and toggles agy_theme_ansi', async () => {
        const fetchMock = mockFetch(() => ({
            ok: true,
            json: async () => ({ enabled: true }),
        }));
        const app = {
            config: { agy_theme_ansi: false },
            tabManager: {
                applyThemeToAllActiveTerminals: vi.fn(),
                applyFontToAllActiveTerminals: vi.fn(),
            },
            applyAccentTheme: vi.fn(),
            sessionsManager: { workspaces: [] },
        };

        openSettingsModal(app, ACCENT_COLORS);

        const checkbox = document.getElementById('settings-agy-theme-ansi');
        expect(checkbox).not.toBeNull();
        expect(checkbox.checked).toBe(false);

        // Toggle on
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));

        expect(app.config.agy_theme_ansi).toBe(true);
        expect(app.tabManager.applyThemeToAllActiveTerminals).toHaveBeenCalled();

        // Check POST request
        const postCall = fetchMock.mock.calls.find(
            (c) => c[0] === '/api/config/agy-theme-ansi',
        );
        expect(postCall).toBeTruthy();
        expect(postCall[1].method).toBe('POST');
        expect(JSON.parse(postCall[1].body)).toEqual({ enabled: true });
    });
});
