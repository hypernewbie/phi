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
    it.each([true, false])(
        'auto-reconnect applies locally before persistence (banner method=%s)',
        (hasBanner) => {
            vi.stubGlobal(
                'fetch',
                vi.fn(() => new Promise(() => {})),
            );
            const app = buildApp();
            const update = vi.fn();
            if (hasBanner) app.tabManager.updateDisconnectBanner = update;
            openSettingsModal(app, ACCENTS, { standalone: true });
            const row = [...document.querySelectorAll('.settings-row')].find(
                (element) =>
                    element.textContent.includes(
                        'Auto-reconnect disconnected terminals (all tabs when visible)',
                    ),
            );
            expect(row).toBeTruthy();
            const toggle = row.querySelector('input');
            toggle.checked = false;
            toggle.dispatchEvent(new Event('change', { bubbles: true }));
            expect(app.config.auto_reconnect).toBe('off');
            if (hasBanner) expect(update).toHaveBeenCalledOnce();
            expect(fetch).toHaveBeenCalledWith(
                '/api/config/auto-reconnect',
                expect.objectContaining({ method: 'POST' }),
            );
        },
    );
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

    it('native config popout closes its owning window instead of blanking it', () => {
        const close = vi.spyOn(window, 'close').mockImplementation(() => {});

        openSettingsModal(buildApp(), ACCENTS, {
            standalone: true,
            nativePopout: true,
        });
        const overlay = document.querySelector('.settings-overlay');
        document.querySelector('.modal-close-btn').click();

        expect(close).toHaveBeenCalledTimes(1);
        // In Electron the document goes away with its BrowserWindow. Keeping
        // this mounted here proves the renderer does not leave a black child
        // behind by unmounting its only surface first.
        expect(document.querySelector('.settings-overlay')).toBe(overlay);
    });

    it('desktop Config action (?desktop=1) opens the named child window, not the in-page modal', () => {
        window.history.replaceState(null, '', '/?desktop=1');
        const open = vi.spyOn(window, 'open').mockReturnValue({ opener: null });

        openSettingsModal(buildApp(), ACCENTS, {});

        expect(open).toHaveBeenCalledTimes(1);
        expect(open).toHaveBeenCalledWith(
            '/config.html?desktop-popout=1',
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
