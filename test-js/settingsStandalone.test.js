// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { setupDomHarness } from './_dom.js';
import { openSettingsModal } from '../web/settings.js';

setupDomHarness();

const ACCENTS = { purple: { accent: '#7c6af7' } };

function buildApp() {
    return {
        versionInfo: {
            version: '0.12.1',
            commit: 'deadbeef1234567',
            date: '2026-07-19T16:00:00Z',
            buildSource: 'npm',
        },
        hostname: 'hammond',
        accessAuthEnabled: false,
        useExistingTerminalTab: false,
        config: {
            auto_reconnect: 'visible',
            fast_mode: false,
            pi_offline: false,
            claude_dangerously_skip_permissions: false,
        },
        uiFontFamily: '',
        uiFontSize: 0,
        terminalFontFamily: '',
        terminalFontSize: 0,
        customFontName: '',
        sessionsManager: { workspaces: ['/proj/a'] },
        tabManager: {},
    };
}

describe('standalone Config surface routing', () => {
    it('renders the settings surface in-page when standalone, even under ?desktop=1', () => {
        window.history.replaceState(null, '', '/config.html?desktop=1');
        const open = vi.spyOn(window, 'open');

        openSettingsModal(buildApp(), ACCENTS, { standalone: true });

        expect(open).not.toHaveBeenCalled();
        const overlay = document.querySelector('.settings-overlay');
        expect(overlay).toBeTruthy();
        expect(overlay.classList.contains('hidden')).toBe(false);
        expect(document.querySelector('.settings-modal')).toBeTruthy();
    });

    it('desktop Config action (?desktop=1) opens the named child window, not the in-page modal', () => {
        window.history.replaceState(null, '', '/?desktop=1');
        const open = vi.spyOn(window, 'open').mockReturnValue({ opener: null });

        openSettingsModal(buildApp(), ACCENTS, {});

        expect(open).toHaveBeenCalledTimes(1);
        expect(open).toHaveBeenCalledWith(
            '/config.html',
            'phi-config',
            'width=860,height=1000',
        );
        expect(document.querySelector('.settings-overlay')).toBeNull();
    });

    it('plain browser keeps the in-page modal fallback', () => {
        window.history.replaceState(null, '', '/');
        const open = vi.spyOn(window, 'open');

        openSettingsModal(buildApp(), ACCENTS, {});

        expect(open).not.toHaveBeenCalled();
        expect(document.querySelector('.settings-overlay')).toBeTruthy();
        expect(document.querySelector('.settings-modal')).toBeTruthy();
    });

    it('scopes window-filling styles to html[data-phi-config-page]', () => {
        const css = readFileSync('web/style.css', 'utf8').replace(
            /\/\*[\s\S]*?\*\//g,
            '',
        );

        const scopedOverlay = css.match(
            /html\[data-phi-config-page\]\s*\.settings-overlay\s*\{([\s\S]*?)\}/,
        );
        const scopedModal = css.match(
            /html\[data-phi-config-page\]\s*\.settings-modal\s*\{([\s\S]*?)\}/,
        );
        expect(
            scopedOverlay,
            'scoped .settings-overlay rule missing',
        ).toBeTruthy();
        expect(scopedOverlay[1]).toContain('align-items: stretch');
        expect(scopedModal, 'scoped .settings-modal rule missing').toBeTruthy();
        for (const decl of [
            'width: 100%',
            'height: 100%',
            'max-width: none',
            'max-height: none',
        ]) {
            expect(scopedModal[1]).toContain(decl);
        }

        const unscopedModal = css.match(
            /(?:^|\})\s*\.settings-modal\s*\{([\s\S]*?)\}/,
        );
        expect(
            unscopedModal,
            'unscoped .settings-modal rule missing',
        ).toBeTruthy();
        for (const decl of [
            'width: 100%',
            'height: 100%',
            'max-width: none',
            'max-height: none',
        ]) {
            expect(unscopedModal[1]).not.toContain(decl);
        }
    });
});

describe('standalone Settings attachment controls (M9)', () => {
    it('renders the same attachment controls in the in-page config surface', async () => {
        const app = buildApp();
        app.config.attachment_retention_age_seconds = 2592000;
        app.config.attachment_unleased_file_cap = 0;
        app.config.attachment_janitor_interval_seconds = 86400;
        openSettingsModal(app, ACCENTS, { standalone: true });
        expect(
            [...document.querySelectorAll('.settings-group-title')].some(
                (title) => title.textContent === 'Attachments',
            ),
        ).toBe(true);
        expect(
            document.getElementById('settings-attachment-retention-age'),
        ).not.toBeNull();
        expect(
            document.getElementById('settings-attachment-unleased-cap'),
        ).not.toBeNull();
        expect(
            document.getElementById('settings-attachment-janitor-interval'),
        ).not.toBeNull();
        expect(
            document.getElementById('settings-clear-attachment-cache'),
        ).not.toBeNull();
    });
});
