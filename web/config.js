import { App } from './app.js';
import { bootstrapAccessAuth } from './auth.js';

async function bootConfigPage() {
    try {
        const auth = await bootstrapAccessAuth();
        const app = Object.create(App.prototype);
        app.accessAuthEnabled = auth.enabled;

        app.tabManager = {
            applyFontToAllActiveTerminals() {},
            applyTerminalFontSizeToAll() {},
            applyThemeToAllActiveTerminals() {},
        };
        app.sessionsManager = { workspaces: [] };

        const res = await fetch('/api/config');
        if (!res.ok) throw new Error(`Failed to load config (HTTP ${res.status})`);
        const data = await res.json();

        app.config = data;
        app.hostname = data.hostname;
        app.useExistingTerminalTab = !!data.use_existing_terminal_tab;
        app.sessionsManager.workspaces = data.workspaces || [];

        if (data.theme_color) {
            app.applyAccentTheme(data.theme_color);
        }
        app.applyFastMode();

        let ls = null;
        try { ls = JSON.parse(localStorage.getItem('phi_appearance') || 'null'); } catch {}
        app.uiFontFamily = (ls?.ui_font_family ?? data.ui_font_family) || '';
        app.uiFontSize = Number(ls?.ui_font_size ?? data.ui_font_size) || 0;
        app.terminalFontFamily = (ls?.terminal_font_family ?? data.terminal_font_family) || '';
        app.terminalFontSize = Number(ls?.terminal_font_size ?? data.terminal_font_size) || 0;
        app.customFontName = ls?.custom_font_name || '';
        app.applyUIFont();
        await app.loadCustomFont();

        try {
            const vres = await fetch('/api/version');
            if (vres.ok) app.versionInfo = await vres.json();
        } catch {}

        App.prototype.openSettingsModal.call(app, { standalone: true });
    } catch (err) {
        console.error('[config] Settings page failed to load:', err);
        const overlay = document.createElement('div');
        overlay.className = 'access-auth-overlay';
        const dialog = document.createElement('div');
        dialog.className = 'access-auth-dialog';
        const title = document.createElement('h1');
        title.textContent = 'Unable to open Settings';
        const detail = document.createElement('p');
        detail.textContent = err instanceof Error ? err.message : 'Settings could not be loaded';
        dialog.append(title, detail);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    }
}

bootConfigPage();
