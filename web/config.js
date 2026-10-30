import { App } from './app.js';
import { bootstrapAccessAuth } from './auth.js';
import { captureAppearanceScope, appearanceRequestContext, appearanceOwner } from './mobile-appearance.js';

// Only the controls this page renders belong in its authorized last-good cache.
const SHARED_FIELDS = [
    'hostname', 'hostname_override', 'workspaces', 'theme_color', 'ui_font_family', 'ui_font_size',
    'terminal_font_family', 'terminal_font_size', 'mobile_scrollback_rows',
    'use_existing_terminal_tab', 'use_hidden_terminal', 'auto_reconnect', 'fast_mode',
    'pi_offline', 'pi_bridge_no_inject', 'claude_dangerously_skip_permissions',
    'agy_theme_ansi', 'opencode_idle_stop_minutes',
];

async function bootConfigPage() {
    try {
        // Capture before auth: an old embedded popup must never follow the active backend.
        const scope = captureAppearanceScope();
        const context = appearanceRequestContext(scope);
        const auth = await bootstrapAccessAuth(context);
        const app = Object.create(App.prototype);
        app.scope = scope;
        app.authContext = context;
        app.accessAuthEnabled = auth.enabled;
        app.tabManager = {
            applyFontToAllActiveTerminals() {},
            applyTerminalFontSizeToAll() {},
            applyThemeToAllActiveTerminals() {},
        };
        app.sessionsManager = { workspaces: [] };
        const cacheKey = `phi:settings-config:v1:${appearanceOwner(scope)}`;
        let cached = null;
        try {
            const value = JSON.parse(localStorage.getItem(cacheKey) || 'null');
            if (value?.schema === 1 && value.config && typeof value.config === 'object') cached = value.config;
        } catch { /* keep defaults */ }
        const ingest = data => {
            app.config = data;
            app.hostname = data.hostname || '';
            app.useExistingTerminalTab = !!data.use_existing_terminal_tab;
            app.useHiddenTerminal = !!data.use_hidden_terminal;
            app.sessionsManager.workspaces = data.workspaces || [];
            if (data.theme_color) app.applyAccentTheme(data.theme_color);
            app.applyFastMode();
            app.ingestAppearance(data);
        };
        app.settingsReady = !!cached;
        app.initAppearance(cached || {});
        ingest(cached || {});
        void app.loadCustomFont();
        void app.loadCustomBg();
        const params = new URLSearchParams(location.search);
        app.openSettingsModal({ standalone: true, page: params.get('page'), nativePopout: params.get('desktop-popout') === '1' });

        // The local Settings view is already mounted. Reconcile without replacing it.
        void context.fetch('/api/config', { cache: 'no-store' }).then(async response => {
            if (!response.ok) throw new Error(`Config refresh failed (HTTP ${response.status})`);
            const data = await response.json();
            if (scope.aborted) return;
            ingest(data);
            app.settingsReady = true;
            try {
                const config = Object.fromEntries(SHARED_FIELDS.filter(key => key in data).map(key => [key, data[key]]));
                localStorage.setItem(cacheKey, JSON.stringify({ schema: 1, config }));
            } catch { /* keep rendered state */ }
            document.querySelector('.settings-overlay')?.dispatchEvent(new Event('phi-settings-refresh'));
        }).catch(() => {
            document.querySelector('.settings-overlay')?.dispatchEvent(new Event('phi-settings-refresh'));
        });
        void context.fetch('/api/version').then(async response => {
            if (!response.ok) return;
            app.versionInfo = await response.json();
            if (scope.aborted) return;
            const version = document.querySelector('.settings-version');
            if (version) version.textContent = app.versionInfo.version ? `v${app.versionInfo.version}` : 'v?';
        }).catch(() => {});
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
