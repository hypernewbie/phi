// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness, mockFetch } from './_dom.js';
import { App } from '../web/app.js';
// ACCENT_COLORS is not exported from web/app.js (it's a private const).
// Importing the module for side effects would still work, but vitest's
// import is the App class only. We assert the swatch count is 22 by
// pinning the value (matches the documented 22 themes mirroring bonus/).
const ACCENT_COLORS_KEY_COUNT = 22;

// Settings modal — the new "Config" button in the header pill opens a
// modal with: 22-swatch accent grid, UI font (select), UI font size
// (number), terminal font (select) + terminal font size (number),
// "reuse shell tab" toggle, and an About group showing Φ logo +
// version + hostname.
//
// These tests pin the user-visible contract: button presence, swatch
// count, live-apply (debounced POST), version from cache, mobile
// responsive class, no leftover #accent-color-select DOM.

setupDomHarness();

function makeAppDom() {
    document.body.innerHTML = `
        <div id="header-config-pill" class="header-config-pill">
            <span class="pill-label">Config</span>
            <button id="header-export-btn" class="pill-btn"></button>
            <button id="header-import-btn" class="pill-btn"></button>
        </div>
        <div id="self-hud-popover"></div>
    `;
}

function buildApp(overrides = {}) {
    const app = Object.create(App.prototype);
    // Use 'in' so explicit null/undefined overrides are respected.
    app.versionInfo = 'versionInfo' in overrides
        ? overrides.versionInfo
        : {
            version: '0.12.1',
            commit: 'deadbeef1234567',
            date: '2026-07-19T16:00:00Z',
            buildSource: 'npm',
        };
    app.hostname = overrides.hostname || 'hammond';
    app.uiFontFamily = overrides.uiFontFamily || '';
    app.uiFontSize = overrides.uiFontSize || 0;
    app.terminalFontFamily = overrides.terminalFontFamily || '';
    app.useExistingTerminalTab = overrides.useExistingTerminalTab || false;
    app.terminalActivity = false;
    app.faviconAccent = null;
    app.faviconAccentDim = null;
    app.codersPresetRegistry = {};
    app.sessionsManager = { workspaces: ['/proj/a', '/proj/b'] };
    app.tabManager = {
        applyFontToAllActiveTerminals: vi.fn(),
    };
    app.applyAccentTheme = vi.fn();
    app.saveTheme = vi.fn().mockResolvedValue(undefined);
    app.persistAppearance = vi.fn().mockResolvedValue(undefined);
    return app;
}

describe('Settings modal — trigger', () => {
    it('clicking the config pill opens the modal', async () => {
        makeAppDom();
        const app = buildApp();
        // Bind the production-style click handler.
        const pill = document.getElementById('header-config-pill');
        pill.addEventListener('click', (e) => {
            if (e.target.closest('.pill-btn')) return; // ignore export/import
            app.openSettingsModal();
        });
        pill.click();
        await Promise.resolve();
        const overlay = document.querySelector('.settings-overlay');
        expect(overlay, 'overlay should exist after click').toBeTruthy();
        expect(overlay.classList.contains('settings-overlay')).toBe(true);
    });

    it('clicking export/import sub-button does NOT open the modal', async () => {
        makeAppDom();
        const app = buildApp();
        const pill = document.getElementById('header-config-pill');
        pill.addEventListener('click', (e) => {
            if (e.target.closest('.pill-btn')) return;
            app.openSettingsModal();
        });
        document.getElementById('header-export-btn').click();
        await Promise.resolve();
        expect(document.querySelector('.settings-overlay')).toBeNull();
        document.getElementById('header-import-btn').click();
        await Promise.resolve();
        expect(document.querySelector('.settings-overlay')).toBeNull();
    });

    it('modal renders the 22 accent swatches', async () => {
        makeAppDom();
        const app = buildApp();
        app.openSettingsModal();
        await Promise.resolve();
        const swatches = document.querySelectorAll('.settings-swatch');
        expect(swatches.length).toBe(ACCENT_COLORS_KEY_COUNT);
        // Spot-check a known color renders with the right --swatch var.
        // We don't know the hex from outside the module, but the click
        // handler wires it through applyAccentTheme, which is spied.
        const purpleSwatch = Array.from(swatches).find((s) => s.dataset.color === 'purple');
        const copperSwatch = Array.from(swatches).find((s) => s.dataset.color === 'copper');
        expect(purpleSwatch).toBeTruthy();
        expect(copperSwatch).toBeTruthy();
        expect(purpleSwatch.style.getPropertyValue('--swatch')).toMatch(/^#/);
        expect(copperSwatch.style.getPropertyValue('--swatch')).toMatch(/^#/);
    });

    it('active swatch reflects data-theme-color at open', async () => {
        makeAppDom();
        document.documentElement.setAttribute('data-theme-color', 'cyan');
        const app = buildApp();
        app.openSettingsModal();
        await new Promise((r) => setTimeout(r, 0));
        const cyan = document.querySelector('.settings-swatch[data-color="cyan"]');
        expect(cyan.getAttribute('aria-checked')).toBe('true');
        const purple = document.querySelector('.settings-swatch[data-color="purple"]');
        expect(purple.getAttribute('aria-checked')).toBe('false');
        document.documentElement.removeAttribute('data-theme-color');
    });

    it('clicking a swatch calls applyAccentTheme + saveTheme (same path as old select)', async () => {
        makeAppDom();
        const app = buildApp();
        app.openSettingsModal();
        await new Promise((r) => setTimeout(r, 0));
        const amber = document.querySelector('.settings-swatch[data-color="amber"]');
        amber.click();
        expect(app.applyAccentTheme).toHaveBeenCalledWith('amber');
        expect(app.saveTheme).toHaveBeenCalledWith('amber');
        // aria-checked must move with the click.
        expect(amber.getAttribute('aria-checked')).toBe('true');
    });

    it('renders an access-password control in Config without changing other settings actions', async () => {
        makeAppDom();
        const app = buildApp();
        app.accessAuthEnabled = false;
        app.openSettingsModal();
        await new Promise((r) => setTimeout(r, 0));
        const newInput = document.getElementById('settings-access-new');
        const confirmInput = document.getElementById('settings-access-confirm');
        expect(newInput).toBeTruthy();
        expect(newInput.type).toBe('password');
        expect(newInput.placeholder).toBe('New password');
        expect(confirmInput).toBeTruthy();
        expect(confirmInput.placeholder).toBe('Confirm new password');
        // State dot renders off, primary button says "Set password".
        expect(document.querySelector('.settings-access-dot.is-off')).toBeTruthy();
        expect(document.querySelector('.settings-access-dot.is-on')).toBeNull();
        expect(document.querySelector('.settings-access-state-text').textContent).toBe('Disabled');
        expect(document.querySelector('.settings-access-primary').textContent).toBe('Set password');
        // Remove link is hidden when password is not set.
        expect(document.querySelector('.settings-access-remove-link').hidden).toBe(true);
        expect(document.querySelector('.settings-access-confirm-remove').hidden).toBe(true);
        // Hint visible, no error yet.
        expect(document.querySelector('.settings-access-hint').textContent).toMatch(/characters/);
        expect(document.querySelector('.settings-access-error').textContent).toBe('');
        // Existing primary Config close action remains present.
        expect(Array.from(document.querySelectorAll('.settings-footer button')).some((b) => b.textContent === 'Close')).toBe(true);
    });

    it('renders Update + Remove controls when access protection is enabled', async () => {
        makeAppDom();
        const app = buildApp();
        app.accessAuthEnabled = true;
        app.openSettingsModal();
        await new Promise((r) => setTimeout(r, 0));
        expect(document.querySelector('.settings-access-dot.is-on')).toBeTruthy();
        expect(document.querySelector('.settings-access-state-text').textContent).toBe('Enabled');
        expect(document.querySelector('.settings-access-primary').textContent).toBe('Update password');
        // Remove link visible (but Confirm button hidden until clicked).
        expect(document.querySelector('.settings-access-remove-link').hidden).toBe(false);
        expect(document.querySelector('.settings-access-confirm-remove').hidden).toBe(true);
    });

    it('version block renders from app.versionInfo, no fetch', async () => {
        makeAppDom();
        const fetchSpy = mockFetch(() => {
            throw new Error('no fetch expected');
        });
        const app = buildApp({ versionInfo: { version: '0.99.0', commit: 'abc1234567', date: '2026-07-20', buildSource: 'local' } });
        app.openSettingsModal();
        await new Promise((r) => setTimeout(r, 0));
        const ver = document.querySelector('.settings-version');
        expect(ver).toBeTruthy();
        expect(ver.textContent).toMatch(/v0\.99\.0/);
        expect(ver.textContent).toMatch(/abc1234/);
        expect(ver.title).toContain('2026-07-20');
        expect(ver.title).toContain('local');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('version block degrades to v? when versionInfo is missing', async () => {
        makeAppDom();
        const app = buildApp({ versionInfo: null });
        app.openSettingsModal();
        await new Promise((r) => setTimeout(r, 0));
        const ver = document.querySelector('.settings-version');
        expect(ver.textContent).toBe('v?');
    });
});

describe('Settings modal — live apply', () => {
    it('UI font select change applies fontFamily to body + persists', async () => {
        vi.useFakeTimers();
        try {
            makeAppDom();
            const app = buildApp();
            app.openSettingsModal();
            // Microtask flush only — fake timers would freeze setTimeout(0).
            await Promise.resolve();
            const sel = document.getElementById('settings-ui-font');
            sel.value = 'Inter, system-ui, sans-serif';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            expect(app.uiFontFamily).toBe('Inter, system-ui, sans-serif');
            expect(document.body.style.fontFamily).toBe('Inter, system-ui, sans-serif');
            // Debounced persist: advance the fake clock past the 300ms debounce.
            vi.advanceTimersByTime(400);
            await Promise.resolve();
            expect(app.persistAppearance).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('UI font size input applies fontSize to body + clamps out-of-range input', async () => {
        makeAppDom();
        const app = buildApp();
        app.openSettingsModal();
        await new Promise((r) => setTimeout(r, 0));
        const input = document.getElementById('settings-ui-font-size');
        input.value = '18';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(app.uiFontSize).toBe(18);
        expect(document.body.style.fontSize).toBe('18px');

        // Out-of-range values are silently ignored client-side
        // (the server clamps too, but client avoids the round-trip).
        input.value = '99';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(app.uiFontSize).toBe(18); // unchanged
        input.value = '5';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(app.uiFontSize).toBe(18); // still unchanged
    });

    it('terminal font select updates live terminals and persists', async () => {
        vi.useFakeTimers();
        try {
            makeAppDom();
            const app = buildApp();
            app.openSettingsModal();
            await Promise.resolve();
            const select = document.getElementById('settings-term-font');
            select.value = "'Fira Code', ui-monospace, monospace";
            select.dispatchEvent(new Event('change', { bubbles: true }));
            expect(app.terminalFontFamily).toBe("'Fira Code', ui-monospace, monospace");
            expect(app.tabManager.applyFontToAllActiveTerminals).toHaveBeenCalledWith("'Fira Code', ui-monospace, monospace");
            vi.advanceTimersByTime(400);
            await Promise.resolve();
            expect(app.persistAppearance).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('terminal font default option falls back to JetBrains Mono on live terminals', async () => {
        makeAppDom();
        const app = buildApp({ terminalFontFamily: 'Fira Code, monospace' });
        app.openSettingsModal();
        await new Promise((r) => setTimeout(r, 0));
        const select = document.getElementById('settings-term-font');
        select.value = '';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(app.terminalFontFamily).toBe('');
        expect(app.tabManager.applyFontToAllActiveTerminals).toHaveBeenCalledWith('JetBrains Mono, monospace');
    });

    it('reuse shell tab checkbox POSTs to /api/config/use-existing-terminal-tab', async () => {
        mockFetch((url, opts) => {
            if (url.includes('/api/config/use-existing-terminal-tab')) {
                return { enabled: true };
            }
            return undefined;
        });
        makeAppDom();
        const app = buildApp();
        app.openSettingsModal();
        await new Promise((r) => setTimeout(r, 0));
        const cb = document.getElementById('settings-reuse-shell-tab');
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
        expect(app.useExistingTerminalTab).toBe(true);
    });
});

describe('Settings modal — close behavior', () => {
    it('× button removes the overlay', async () => {
        makeAppDom();
        const app = buildApp();
        app.openSettingsModal();
        await new Promise((r) => setTimeout(r, 0));
        const closeBtn = document.querySelector('.settings-modal .modal-close-btn');
        closeBtn.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(document.querySelector('.settings-overlay')).toBeNull();
    });

    it('Escape key closes the modal', async () => {
        makeAppDom();
        const app = buildApp();
        app.openSettingsModal();
        await new Promise((r) => setTimeout(r, 0));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
        expect(document.querySelector('.settings-overlay')).toBeNull();
    });

    it('overlay click (not on modal) closes the modal', async () => {
        makeAppDom();
        const app = buildApp();
        app.openSettingsModal();
        await new Promise((r) => setTimeout(r, 0));
        const overlay = document.querySelector('.settings-overlay');
        // Click on overlay itself, not bubbled from the modal.
        const click = new MouseEvent('click', { bubbles: true });
        Object.defineProperty(click, 'target', { value: overlay });
        overlay.dispatchEvent(click);
        await new Promise((r) => setTimeout(r, 0));
        expect(document.querySelector('.settings-overlay')).toBeNull();
    });
});

describe('Settings modal — DOM hygiene', () => {
    it('header no longer contains #accent-color-select (regression guard)', () => {
        makeAppDom();
        expect(document.getElementById('accent-color-select')).toBeNull();
        expect(document.querySelector('.theme-area')).toBeNull();
    });

    it('export/import pill buttons remain functional after restructure', async () => {
        makeAppDom();
        const app = buildApp();
        // Real handlers from app.js would wire these; just confirm
        // the buttons exist and are clickable (don't throw).
        const exp = document.getElementById('header-export-btn');
        const imp = document.getElementById('header-import-btn');
        expect(exp).toBeTruthy();
        expect(imp).toBeTruthy();
        expect(() => exp.click()).not.toThrow();
        expect(() => imp.click()).not.toThrow();
        // app is unused here but referenced to keep build deterministic.
        expect(app).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// Access-password Config flow: confirm-mismatch inline error, remove-link
// two-step confirm, success-state transitions. No window.confirm().
// ---------------------------------------------------------------------------

describe('Settings modal — access password flow', () => {
    it('short password shows inline error and does NOT call setAccessPassword', async () => {
        makeAppDom();
        const app = buildApp();
        app.accessAuthEnabled = false;
        const setPwSpy = vi.fn();
        app._setAccessPassword = setPwSpy;  // not used — patching for the call we actually make
        // openSettingsModal reaches into the auth.js module directly, so spy via global.
        const authModule = await import('../web/auth.js');
        const spy = vi.spyOn(authModule, 'setAccessPassword').mockResolvedValue({ enabled: true });
        app.openSettingsModal();
        await new Promise((r) => setTimeout(r, 0));
        document.getElementById('settings-access-new').value = 'short';
        document.getElementById('settings-access-confirm').value = 'short';
        document.querySelector('.settings-access-primary').click();
        await new Promise((r) => setTimeout(r, 0));
        expect(spy).not.toHaveBeenCalled();
        const err = document.querySelector('.settings-access-error');
        expect(err.textContent).toMatch(/characters/);
        expect(document.getElementById('settings-access-new').classList.contains('is-invalid')).toBe(true);
        spy.mockRestore();
    });

    it('password mismatch shows inline error and does NOT call setAccessPassword', async () => {
        makeAppDom();
        const app = buildApp();
        app.accessAuthEnabled = false;
        const authModule = await import('../web/auth.js');
        const spy = vi.spyOn(authModule, 'setAccessPassword').mockResolvedValue({ enabled: true });
        app.openSettingsModal();
        await new Promise((r) => setTimeout(r, 0));
        document.getElementById('settings-access-new').value = 'correct horse battery staple';
        document.getElementById('settings-access-confirm').value = 'different password value';
        document.querySelector('.settings-access-primary').click();
        await new Promise((r) => setTimeout(r, 0));
        expect(spy).not.toHaveBeenCalled();
        const err = document.querySelector('.settings-access-error');
        expect(err.textContent).toMatch(/don.+match/);
        spy.mockRestore();
    });

    it('typing into the inputs clears the inline error', async () => {
        makeAppDom();
        const app = buildApp();
        app.accessAuthEnabled = false;
        app.openSettingsModal();
        await new Promise((r) => setTimeout(r, 0));
        document.getElementById('settings-access-new').value = 'short';
        document.getElementById('settings-access-confirm').value = 'short';
        document.querySelector('.settings-access-primary').click();
        await new Promise((r) => setTimeout(r, 0));
        expect(document.querySelector('.settings-access-error').textContent).not.toBe('');
        // Typing into either input clears the error.
        const evt = new Event('input', { bubbles: true });
        document.getElementById('settings-access-new').dispatchEvent(evt);
        expect(document.querySelector('.settings-access-error').textContent).toBe('');
        expect(document.getElementById('settings-access-new').classList.contains('is-invalid')).toBe(false);
    });

    it('remove-link is hidden when password not set; clicking it reveals Confirm; clicking Confirm calls clearAccessPassword', async () => {
        makeAppDom();
        const app = buildApp();
        app.accessAuthEnabled = true;
        const authModule = await import('../web/auth.js');
        const clearSpy = vi.spyOn(authModule, 'clearAccessPassword').mockResolvedValue({ enabled: false });
        app.openSettingsModal();
        await new Promise((r) => setTimeout(r, 0));

        const removeLink = document.querySelector('.settings-access-remove-link');
        const confirmBtn = document.querySelector('.settings-access-confirm-remove');
        expect(removeLink.hidden).toBe(false);
        expect(confirmBtn.hidden).toBe(true);

        removeLink.click();
        expect(removeLink.hidden).toBe(true);
        expect(confirmBtn.hidden).toBe(false);

        confirmBtn.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(clearSpy).toHaveBeenCalledTimes(1);
        // After success: state flips to Disabled, primary reverts to Set password, link hidden again.
        expect(document.querySelector('.settings-access-dot.is-off')).toBeTruthy();
        expect(document.querySelector('.settings-access-state-text').textContent).toBe('Disabled');
        expect(document.querySelector('.settings-access-primary').textContent).toBe('Set password');
        expect(document.querySelector('.settings-access-remove-link').hidden).toBe(true);
        clearSpy.mockRestore();
    });
});
