import {
    displayHostname,
    setServerHostOverride,
    readLowPowerLocal,
    writeLowPowerLocal,
} from './util.js';
import { setAccessPassword, clearAccessPassword, bootstrapAccessAuth } from './auth.js';
import { tryNative } from './desktop.js';
import {
    currentAppearanceProfile, readProfileOverride, writeProfileOverride,
    appearanceOwner, captureAppearanceScope, legacyAppearanceKey,
} from './mobile-appearance.js';

export function broadcastConfigSync(type, payload = {}) {
    try {
        if (typeof BroadcastChannel !== 'undefined') {
            const ch = new BroadcastChannel('phi_config_sync');
            ch.postMessage({ type, owner: appearanceOwner(captureAppearanceScope()), ...payload });
            ch.close();
        }
    } catch {}
}

export function openSettingsModal(app, accentColors, opts = {}) {
    if (document.querySelector('.settings-overlay')) return;
    if (!opts.standalone && tryNative('config', { page: opts.page })) return;
    const scope = app.scope || captureAppearanceScope();
    const context = app.authContext;
    const request = context?.fetch || ((...args) => fetch(...args));
    const owner = appearanceOwner(scope);
    const broadcast = (type, payload = {}) => broadcastConfigSync(type, { owner, ...payload });
    const opener = opts.opener || document.activeElement;
    const desktop = app.desktopAppearance || {
        ui_font_family: app.uiFontFamily, ui_font_size: app.uiFontSize,
        terminal_font_family: app.terminalFontFamily, terminal_font_size: app.terminalFontSize,
    };

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay settings-overlay hidden';

    const modal = document.createElement('div');
    modal.className = 'modal-content settings-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Phi Settings');
    modal.tabIndex = -1;

    const header = document.createElement('div');
    header.className = 'modal-header settings-header';

    const identity = document.createElement('div');
    identity.className = 'settings-identity';

    const logo = document.createElement('div');
    logo.className = 'settings-logo';
    logo.textContent = '\u03A6';
    identity.appendChild(logo);

    const idText = document.createElement('div');
    const titleEl = document.createElement('h3');
    titleEl.textContent = 'Phi';
    const verEl = document.createElement('div');
    verEl.className = 'settings-version';
    const v = app.versionInfo || {};
    const short = (v.commit || '').slice(0, 7);
    verEl.textContent = v.version
        ? `v${v.version}${short ? ` · ${short}` : ''}`
        : 'v?';
    verEl.title =
        [v.date, v.buildSource].filter(Boolean).join(' · ') || 'unknown build';
    idText.appendChild(titleEl);
    idText.appendChild(verEl);
    identity.appendChild(idText);
    header.appendChild(identity);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close-btn';
    closeBtn.type = 'button';
    closeBtn.textContent = '\u00d7';
    closeBtn.title = 'Close';
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body settings-body';

    const navigation = document.createElement('div');
    navigation.className = 'settings-navigation';
    const desktopButton = document.createElement('button');
    desktopButton.className = 'btn btn-primary'; desktopButton.type = 'button'; desktopButton.textContent = 'Settings';
    desktopButton.id = 'settings-desktop-view';
    const mobileButton = document.createElement('button');
    mobileButton.className = 'btn btn-primary'; mobileButton.type = 'button'; mobileButton.textContent = 'Mobile Settings';
    mobileButton.id = 'settings-mobile-view';
    navigation.append(desktopButton, mobileButton);
    body.appendChild(navigation);

    const profileGroup = _buildSettingsGroup('This browser');
    const profileRow = _buildSelectRow('Appearance profile', 'settings-appearance-profile', [
        { value: 'auto', label: 'Auto' }, { value: 'desktop', label: 'Desktop' }, { value: 'mobile', label: 'Mobile' },
    ], readProfileOverride());
    profileGroup.appendChild(profileRow);
    const profileWarning = document.createElement('p');
    profileWarning.className = 'settings-row-hint';
    profileGroup.appendChild(profileWarning);
    const profileSelect = profileRow.querySelector('select');
    if (new URLSearchParams(location.search).get('desktop') === '1' || new URLSearchParams(location.search).get('desktop-popout') === '1' || window.__phiDesktop || location.protocol === 'phi-app:') {
        profileSelect.disabled = true;
        profileWarning.textContent = 'Native desktop always uses the desktop appearance.';
    }
    body.appendChild(profileGroup);
    const mobileGroup = _buildSettingsGroup('Mobile appearance');
    mobileGroup.id = 'settings-mobile-appearance';
    body.appendChild(mobileGroup);

    const appGroup = _buildSettingsGroup('Appearance');
    body.appendChild(appGroup);

    const activeColor =
        document.documentElement.getAttribute('data-theme-color') || 'purple';
    const swatchRow = _buildSwatchRow(app, activeColor, accentColors);
    appGroup.appendChild(swatchRow);

    const uiFontOptions = [
        { value: '', label: 'System default' },
        { value: 'Inter, system-ui, sans-serif', label: 'Inter' },
        { value: 'system-ui, -apple-system, sans-serif', label: 'System UI' },
        { value: '"Segoe UI", system-ui, sans-serif', label: 'Segoe UI' },
        {
            value: '"Helvetica Neue", Arial, sans-serif',
            label: 'Helvetica Neue',
        },
        {
            value: 'ui-monospace, "Cascadia Code", "Source Code Pro", monospace',
            label: 'Mono / dev-style',
        },
    ];
    if (app.customFontName) {
        uiFontOptions.push({
            value: 'Phi Custom Font',
            label: `Custom: ${app.customFontName}`,
        });
    }
    const uiFontRow = _buildSelectRow(
        'UI font',
        'settings-ui-font',
        uiFontOptions,
        desktop.ui_font_family,
    );
    appGroup.appendChild(uiFontRow);

    const uiSizeRow = _buildNumberRow(
        'UI font size',
        'settings-ui-font-size',
        desktop.ui_font_size || 14,
        10,
        24,
    );
    appGroup.appendChild(uiSizeRow);

    const termFontOptions = [
        { value: '', label: 'Default (JetBrains Mono)' },
        { value: "'Fira Code', ui-monospace, monospace", label: 'Fira Code' },
        {
            value: "'Cascadia Code', ui-monospace, monospace",
            label: 'Cascadia Code',
        },
        {
            value: "ui-monospace, 'SF Mono', Menlo, monospace",
            label: 'SF Mono / Menlo',
        },
        { value: "Consolas, 'Cascadia Mono', monospace", label: 'Consolas' },
        {
            value: "'Source Code Pro', ui-monospace, monospace",
            label: 'Source Code Pro',
        },
        {
            value: "'JetBrainsMono Nerd Font Mono', 'JetBrainsMono Nerd Font', 'JetBrains Mono', ui-monospace, monospace",
            label: 'JetBrainsMono Nerd Font',
        },
        {
            value: "'FiraCode Nerd Font Mono', 'FiraCode Nerd Font', 'Fira Code', ui-monospace, monospace",
            label: 'FiraCode Nerd Font',
        },
        {
            value: "'Hack Nerd Font Mono', 'Hack Nerd Font', Hack, ui-monospace, monospace",
            label: 'Hack Nerd Font',
        },
        {
            value: "'MesloLGS NF', 'MesloLGM Nerd Font Mono', Menlo, ui-monospace, monospace",
            label: 'MesloLGS NF',
        },
        {
            value: "'CaskaydiaCove Nerd Font Mono', 'CaskaydiaCove Nerd Font', 'Cascadia Code', ui-monospace, monospace",
            label: 'CaskaydiaCove Nerd Font',
        },
        {
            value: "'SauceCodePro Nerd Font Mono', 'SauceCodePro Nerd Font', 'Source Code Pro', ui-monospace, monospace",
            label: 'SauceCodePro Nerd Font',
        },
        { value: 'monospace', label: 'System monospace' },
    ];
    if (
        app.terminalFontFamily &&
        !termFontOptions.some((o) => o.value === app.terminalFontFamily)
    ) {
        termFontOptions.splice(1, 0, {
            value: app.terminalFontFamily,
            label: `Current: ${app.terminalFontFamily}`,
        });
    }
    if (app.customFontName) {
        termFontOptions.push({
            value: 'Phi Custom Font',
            label: `Custom: ${app.customFontName}`,
        });
    }
    const termFontRow = _buildSelectRow(
        'Terminal font',
        'settings-term-font',
        termFontOptions,
        desktop.terminal_font_family,
    );
    appGroup.appendChild(termFontRow);

    const termSizeRow = _buildNumberRow(
        'Terminal font size',
        'settings-term-font-size',
        desktop.terminal_font_size || 14,
        8,
        32,
    );
    appGroup.appendChild(termSizeRow);
    const mobile = _buildMobileAppearance(app, mobileGroup, context, uiFontOptions, termFontOptions);

    // Mobile-only lane: shrinks xterm history under the fast-mode gate
    // (forced on for mobile viewports). 0 = full history, same as
    // desktop. Applies to new tabs; existing tabs keep their buffer.
    const mobileScrollRow = _buildNumberRow(
        'Mobile scrollback rows (0 = full, new tabs)',
        'settings-mobile-scrollback',
        app.mobileScrollbackRows || 0,
        0,
        10000,
    );
    appGroup.appendChild(mobileScrollRow);

    const uploadRow = document.createElement('div');
    uploadRow.className = 'settings-row';
    const uploadLabel = document.createElement('label');
    uploadLabel.htmlFor = 'settings-font-upload';
    uploadLabel.textContent = 'Upload font (this browser only)…';
    uploadRow.appendChild(uploadLabel);
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'settings-font-upload';
    fileInput.accept = '.woff2,.woff,.ttf,.otf';
    uploadRow.appendChild(fileInput);
    appGroup.appendChild(uploadRow);

    const bgRow = document.createElement('div');
    bgRow.className = 'settings-row';
    const bgLabel = document.createElement('label');
    bgLabel.htmlFor = 'settings-bg-upload';
    bgLabel.textContent = app.terminalBgName
        ? `Terminal background (${app.terminalBgName})`
        : 'Terminal background…';
    bgRow.appendChild(bgLabel);

    const bgControls = document.createElement('div');
    bgControls.className = 'settings-row-controls';
    bgControls.style.display = 'flex';
    bgControls.style.gap = '8px';
    bgControls.style.alignItems = 'center';

    const bgFileInput = document.createElement('input');
    bgFileInput.type = 'file';
    bgFileInput.id = 'settings-bg-upload';
    bgFileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
    bgControls.appendChild(bgFileInput);

    if (app.terminalBgName) {
        const removeBgBtn = document.createElement('button');
        removeBgBtn.className = 'btn';
        removeBgBtn.type = 'button';
        removeBgBtn.id = 'settings-bg-remove';
        removeBgBtn.textContent = 'Remove';
        bgControls.appendChild(removeBgBtn);
    }
    bgRow.appendChild(bgControls);
    appGroup.appendChild(bgRow);

    const bgDarknessRow = _buildNumberRow(
        'Background dimming % (darkened)',
        'settings-bg-darkness',
        typeof app.terminalBgDarkness === 'number'
            ? app.terminalBgDarkness
            : 98,
        50,
        99,
    );
    appGroup.appendChild(bgDarknessRow);

    const bgBlurRow = _buildNumberRow(
        'Background blur (px)',
        'settings-bg-blur',
        typeof app.terminalBgBlur === 'number' ? app.terminalBgBlur : 0,
        0,
        40,
    );
    appGroup.appendChild(bgBlurRow);
    const assetHint = document.createElement('p');
    assetHint.className = 'settings-row-hint';
    assetHint.textContent = 'Font and background files stay in this browser. Saving preferences does not upload them to other devices.';
    appGroup.appendChild(assetHint);

    const resetRow = document.createElement('div');
    resetRow.className = 'settings-row';
    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn';
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset appearance';
    resetRow.appendChild(resetBtn);
    appGroup.appendChild(resetRow);

    const behGroup = _buildSettingsGroup('Behavior');
    body.appendChild(behGroup);
    // Alternate server hostname for socket URLs. Blank (default) means
    // the page host — fully backwards compatible. Applies to sockets
    // opened after the change; live sockets stay put.
    const hostRow = document.createElement('div');
    hostRow.className = 'settings-row';
    const hostLabel = document.createElement('label');
    hostLabel.htmlFor = 'settings-hostname-override';
    hostLabel.textContent = 'Hostname label (blank = real hostname)';
    hostLabel.title =
        "A display label for this machine in phi's UI, push titles, and status dumps. Purely cosmetic: it never affects how sockets connect, so it does not need to be a real hostname (any short text works).";
    hostRow.appendChild(hostLabel);
    const hostInput = document.createElement('input');
    hostInput.type = 'text';
    hostInput.id = 'settings-hostname-override';
    hostInput.placeholder = 'e.g. dusty_potato, europa, homelab';
    hostInput.value = app.hostnameOverride || '';
    hostInput.autocomplete = 'off';
    hostInput.spellcheck = false;
    hostRow.appendChild(hostInput);
    behGroup.appendChild(hostRow);
    hostInput.addEventListener('input', () => {
        app.hostnameOverride = hostInput.value.trim();
        setServerHostOverride(app.hostnameOverride);
        app._saveAppearanceLocal();
        debouncedPersist({ hostname_override: app.hostnameOverride });
    });
    const hiddenRow = _buildCheckboxRow(
        'Use separate hidden terminal for commands',
        'settings-use-hidden-terminal',
        !!app.useHiddenTerminal,
    );
    behGroup.appendChild(hiddenRow);
    const reuseRow = _buildCheckboxRow(
        'Reuse shell tab for terminal commands',
        'settings-reuse-shell-tab',
        !!app.useExistingTerminalTab,
    );
    if (app.useHiddenTerminal) {
        reuseRow.classList.add('disabled');
        const rInput = reuseRow.querySelector('input');
        if (rInput) rInput.disabled = true;
    }
    behGroup.appendChild(reuseRow);
    const autoReconnectRow = _buildCheckboxRow(
        'Auto-reconnect disconnected terminals (all tabs when visible)',
        'settings-auto-reconnect',
        (app.config?.auto_reconnect || 'visible') === 'visible',
    );
    behGroup.appendChild(autoReconnectRow);
    // Low power mode is a browser preference (localStorage), not a server
    // flag: an explicit local choice wins, otherwise the legacy per-server
    // fast_mode seeds the checkbox until the first toggle migrates it.
    const storedLowPower = readLowPowerLocal();
    const fastModeRow = _buildCheckboxRow(
        'Low power mode (disable expensive visual effects)',
        'settings-fast-mode',
        storedLowPower !== null ? storedLowPower : !!app.config?.fast_mode,
    );
    fastModeRow.classList.add('settings-fast-mode-row');
    behGroup.appendChild(fastModeRow);

    const PASSWORD_MIN_LENGTH = 8;
    const securityGroup = _buildSettingsGroup('Security');
    body.appendChild(securityGroup);

    const headerRow = document.createElement('div');
    headerRow.className = 'settings-row settings-access-header';
    const headerLabel = document.createElement('span');
    headerLabel.className = 'settings-access-title';
    headerLabel.textContent = 'Access password';
    const stateDot = document.createElement('span');
    stateDot.className = `settings-access-dot ${app.accessAuthEnabled ? 'is-on' : 'is-off'}`;
    const stateText = document.createElement('span');
    stateText.className = 'settings-access-state-text';
    stateText.textContent = app.accessAuthEnabled ? 'Enabled' : 'Disabled';
    headerRow.append(headerLabel, stateDot, stateText);
    securityGroup.appendChild(headerRow);

    const newInput = document.createElement('input');
    newInput.type = 'password';
    newInput.id = 'settings-access-new';
    newInput.autocomplete = 'new-password';
    newInput.placeholder = 'New password';
    const newRow = document.createElement('div');
    newRow.className = 'settings-row';
    newRow.appendChild(newInput);
    securityGroup.appendChild(newRow);

    const confirmInput = document.createElement('input');
    confirmInput.type = 'password';
    confirmInput.id = 'settings-access-confirm';
    confirmInput.autocomplete = 'new-password';
    confirmInput.placeholder = 'Confirm new password';
    const confirmRow = document.createElement('div');
    confirmRow.className = 'settings-row';
    confirmRow.appendChild(confirmInput);
    securityGroup.appendChild(confirmRow);

    const hintRow = document.createElement('div');
    hintRow.className = 'settings-row settings-access-hint-row';
    const hint = document.createElement('span');
    hint.className = 'settings-access-hint';
    hint.textContent = `${PASSWORD_MIN_LENGTH}+ characters.`;
    const inlineError = document.createElement('span');
    inlineError.className = 'settings-access-error';
    inlineError.setAttribute('role', 'alert');
    hintRow.append(hint, inlineError);
    securityGroup.appendChild(hintRow);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'settings-row settings-access-actions-row';
    const setPasswordBtn = document.createElement('button');
    setPasswordBtn.className = 'btn btn-accent settings-access-primary';
    setPasswordBtn.type = 'button';
    setPasswordBtn.textContent = app.accessAuthEnabled
        ? 'Update password'
        : 'Set password';

    const removeLink = document.createElement('button');
    removeLink.className = 'settings-access-remove-link';
    removeLink.type = 'button';
    removeLink.textContent = '·  Remove password';
    removeLink.classList.toggle('hidden', !app.accessAuthEnabled);

    const confirmRemoveBtn = document.createElement('button');
    confirmRemoveBtn.className =
        'btn btn-red settings-access-confirm-remove hidden';
    confirmRemoveBtn.type = 'button';
    confirmRemoveBtn.textContent = 'Confirm remove';

    const actionsSpacer = document.createElement('span');
    actionsSpacer.className = 'settings-access-spacer';
    actionsRow.append(
        actionsSpacer,
        setPasswordBtn,
        removeLink,
        confirmRemoveBtn,
    );
    securityGroup.appendChild(actionsRow);

    const showError = (msg) => {
        inlineError.textContent = msg;
        if (msg) {
            newInput.classList.add('is-invalid');
            confirmInput.classList.add('is-invalid');
        } else {
            newInput.classList.remove('is-invalid');
            confirmInput.classList.remove('is-invalid');
        }
    };
    const clearInputs = () => {
        newInput.value = '';
        confirmInput.value = '';
        showError('');
    };

    const aboutGroup = _buildSettingsGroup('About');
    body.appendChild(aboutGroup);
    const hName = displayHostname(app.hostname);
    aboutGroup.appendChild(_buildAboutRow('Hostname', hName.toUpperCase()));
    if (v.buildSource) {
        aboutGroup.appendChild(_buildAboutRow('Build source', v.buildSource));
    }
    aboutGroup.appendChild(
        _buildAboutRow(
            'Workspaces',
            `${(app.sessionsManager?.workspaces || []).length}`,
        ),
    );

    modal.appendChild(header);
    modal.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'modal-footer settings-footer';
    const doneBtn = document.createElement('button');
    doneBtn.className = 'btn btn-accent';
    doneBtn.type = 'button';
    doneBtn.textContent = 'Close';
    footer.appendChild(doneBtn);
    modal.appendChild(footer);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = () => {
        document.removeEventListener('keydown', onKeydown, true);
        document.removeEventListener('focusin', onFocusin, true);
        overlay.removeEventListener('phi-settings-refresh', refreshShared);
        mobile.unsubscribe();
        clearTimeout(persistTimer);
        flushLegacy();
        // config.html fills an Electron child BrowserWindow. Removing its
        // only overlay leaves the native window alive but black; close the
        // owning popup instead. The marker is attached only by tryNative(),
        // so normal in-page settings keep their existing modal behavior.
        if (opts.nativePopout) {
            window.close();
            return;
        }
        overlay.classList.add('hidden');
        overlay.remove();
        const bounds = opener?.isConnected ? opener.getBoundingClientRect() : null;
        const visible = bounds && bounds.width > 0 && bounds.height > 0 &&
            bounds.right > 0 && bounds.left < innerWidth && bounds.bottom > 0 && bounds.top < innerHeight;
        const focusTarget = visible ? opener : document.getElementById('mobile-sidebar-toggle');
        focusTarget?.focus();
    };
    const onFocusin = (e) => {
        if (!overlay.classList.contains('hidden') && !modal.contains(e.target) &&
            !document.querySelector('.access-auth-overlay')) closeBtn.focus({ preventScroll: true });
    };
    const onKeydown = (e) => {
        if (document.querySelector('.access-auth-overlay')) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close();
        } else if (e.key === 'Tab') {
            e.stopPropagation();
            const controls = Array.from(modal.querySelectorAll(
                'button, input, textarea, select, [tabindex="0"]',
            )).filter(el => !el.disabled && !el.closest('[hidden], .hidden') && getComputedStyle(el).display !== 'none');
            const index = controls.indexOf(document.activeElement);
            if ((e.shiftKey && index <= 0) || (!e.shiftKey && (index < 0 || index === controls.length - 1))) {
                e.preventDefault();
                (e.shiftKey ? controls.at(-1) : controls[0])?.focus();
            }
        }
    };
    closeBtn.addEventListener('click', close);
    doneBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('focusin', onFocusin, true);

    let persistTimer = null;
    let legacyPatch = {};
    const flushLegacy = () => {
        if (!Object.keys(legacyPatch).length) return;
        const fields = legacyPatch;
        legacyPatch = {};
        app.persistAppearance(fields);
        broadcast('appearance');
    };
    const debouncedPersist = (fields) => {
        Object.assign(legacyPatch, fields);
        clearTimeout(persistTimer);
        persistTimer = setTimeout(flushLegacy, 300);
    };
    uiFontRow.querySelector('select')?.addEventListener('change', (e) => {
        app.uiFontFamily = e.target.value;
        app.applyUIFont();
        app._saveAppearanceLocal();
        debouncedPersist({ ui_font_family: app.uiFontFamily });
    });
    uiSizeRow.querySelector('input')?.addEventListener('input', (e) => {
        const n = parseInt(e.target.value, 10);
        if (!Number.isFinite(n) || n < 10 || n > 24) return;
        app.uiFontSize = n;
        app.applyUIFont();
        app._saveAppearanceLocal();
        debouncedPersist({ ui_font_size: app.uiFontSize });
    });
    termFontRow.querySelector('select')?.addEventListener('change', (e) => {
        app.terminalFontFamily = e.target.value;
        app.tabManager?.applyFontToAllActiveTerminals(
            app.terminalFontFamily || 'JetBrains Mono, monospace',
        );
        app._saveAppearanceLocal();
        debouncedPersist({ terminal_font_family: app.terminalFontFamily });
    });
    termSizeRow.querySelector('input')?.addEventListener('input', (e) => {
        const n = parseInt(e.target.value, 10);
        if (!Number.isFinite(n) || n < 8 || n > 32) return;
        app.terminalFontSize = n;
        app.tabManager?.applyTerminalFontSizeToAll(n);
        app._saveAppearanceLocal();
        debouncedPersist({ terminal_font_size: app.terminalFontSize });
    });
    mobileScrollRow.querySelector('input')?.addEventListener('input', (e) => {
        const raw = e.target.value.trim();
        // 0/blank = full history (the unset sentinel). Otherwise clamp
        // to the server range; out-of-range input is ignored, never
        // half-applied.
        if (raw === '') {
            app.mobileScrollbackRows = 0;
        } else {
            const n = parseInt(raw, 10);
            if (!Number.isFinite(n) || n < 0 || n > 10000) return;
            if (n !== 0 && n < 500) return;
            app.mobileScrollbackRows = n;
        }
        app._saveAppearanceLocal();
        debouncedPersist({ mobile_scrollback_rows: app.mobileScrollbackRows });
    });
    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const MAX = 8 * 1024 * 1024;
        if (file.size > MAX) {
            app.showToast('Font too large (max 8MB)', { type: 'error' });
            return;
        }
        try {
            await app._putCustomFont(file.name, file);
            app._injectCustomFontFace(file);
            app.customFontName = file.name;
            mobile.refresh();
            app._saveAppearanceLocal();
            broadcastConfigSync('appearance');
            app.showToast(
                `Loaded ${file.name}. Pick "Custom: ${file.name}" in the font dropdowns.`,
                { type: 'success' },
            );
        } catch (err) {
            app.showToast(`Font upload failed: ${err.message}`, {
                type: 'error',
            });
        }
    });
    function wireRemoveBgBtn(btn) {
        btn.addEventListener('click', async () => {
            await app.clearCustomBg?.();
            bgFileInput.value = '';
            bgLabel.textContent = 'Terminal background…';
            btn.remove();
            broadcastConfigSync('appearance');
            app.showToast('Terminal background removed.', { type: 'info' });
        });
    }

    const existingRemoveBtn = bgControls.querySelector('#settings-bg-remove');
    if (existingRemoveBtn) {
        wireRemoveBgBtn(existingRemoveBtn);
    }

    bgFileInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const MAX = 16 * 1024 * 1024;
        if (file.size > MAX) {
            app.showToast('Background image too large (max 16MB)', {
                type: 'error',
            });
            return;
        }
        try {
            await app._putCustomBg(file.name, file);
            app.terminalBgName = file.name;
            app.applyTerminalBg(file);
            app._saveAppearanceLocal();
            broadcastConfigSync('appearance');
            bgLabel.textContent = `Terminal background (${file.name})`;
            let removeBtn = bgControls.querySelector('#settings-bg-remove');
            if (!removeBtn) {
                removeBtn = document.createElement('button');
                removeBtn.className = 'btn';
                removeBtn.type = 'button';
                removeBtn.id = 'settings-bg-remove';
                removeBtn.textContent = 'Remove';
                bgControls.appendChild(removeBtn);
                wireRemoveBgBtn(removeBtn);
            }
            app.showToast(`Loaded background ${file.name}.`, {
                type: 'success',
            });
        } catch (err) {
            app.showToast(`Background upload failed: ${err.message}`, {
                type: 'error',
            });
        }
    });

    const bgDarknessInput = bgDarknessRow.querySelector('input');
    bgDarknessInput?.addEventListener('input', (e) => {
        let val = Number(e.target.value);
        if (Number.isNaN(val)) return;
        val = Math.max(50, Math.min(99, val));
        app.terminalBgDarkness = val;
        app.applyTerminalBgStyles?.();
        app._saveAppearanceLocal();
        broadcastConfigSync('appearance');
    });

    const bgBlurInput = bgBlurRow.querySelector('input');
    bgBlurInput?.addEventListener('input', (e) => {
        let val = Number(e.target.value);
        if (Number.isNaN(val)) return;
        val = Math.max(0, Math.min(40, val));
        app.terminalBgBlur = val;
        app.applyTerminalBgStyles?.();
        app._saveAppearanceLocal();
        broadcastConfigSync('appearance');
    });

    resetBtn.addEventListener('click', async () => {
        try {
            localStorage.removeItem(legacyAppearanceKey(scope));
        } catch {}
        document.getElementById('phi-prepaint-appearance')?.remove();
        await app.clearCustomFont?.();
        await app.clearCustomBg?.();
        app.uiFontFamily = '';
        app.uiFontSize = 0;
        app.terminalFontFamily = '';
        app.terminalFontSize = 0;
        app.customFontName = '';
        app.terminalBgName = '';
        app.terminalBgDarkness = 98;
        app.terminalBgBlur = 0;
        const removeBgBtn = bgControls.querySelector('#settings-bg-remove');
        if (removeBgBtn) removeBgBtn.remove();
        bgFileInput.value = '';
        bgLabel.textContent = 'Terminal background…';
        const darknessEl = document.getElementById('settings-bg-darkness');
        if (darknessEl) darknessEl.value = '98';
        const blurEl = document.getElementById('settings-bg-blur');
        if (blurEl) blurEl.value = '0';
        app.applyUIFont();
        app.tabManager?.applyFontToAllActiveTerminals(
            'JetBrains Mono, monospace',
        );
        app.tabManager?.applyTerminalFontSizeToAll(0);
        app._saveAppearanceLocal();
        app.persistAppearance({ ui_font_family: '', ui_font_size: 0, terminal_font_family: '', terminal_font_size: 0 });
        broadcast('appearance');
        document.getElementById('settings-ui-font').value = '';
        document.getElementById('settings-ui-font-size').value = '14';
        document.getElementById('settings-term-font').value = '';
        document.getElementById('settings-term-font-size').value = '14';
    });
    hiddenRow.querySelector('input')?.addEventListener('change', async (e) => {
        app.useHiddenTerminal = !!e.target.checked;
        const rInput = reuseRow.querySelector('input');
        if (app.useHiddenTerminal) {
            reuseRow.classList.add('disabled');
            if (rInput) rInput.disabled = true;
        } else {
            reuseRow.classList.remove('disabled');
            if (rInput) rInput.disabled = false;
        }
        try {
            await request('/api/config/use-hidden-terminal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: app.useHiddenTerminal }),
            });
            broadcastConfigSync('behavior');
        } catch (err) {
            console.warn(
                '[settings] failed to persist hidden-terminal toggle',
                err,
            );
        }
    });
    reuseRow.querySelector('input')?.addEventListener('change', async (e) => {
        app.useExistingTerminalTab = !!e.target.checked;
        try {
            await request('/api/config/use-existing-terminal-tab', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: app.useExistingTerminalTab }),
            });
            broadcastConfigSync('behavior');
        } catch (err) {
            console.warn('[settings] failed to persist reuse-tab toggle', err);
        }
    });
    autoReconnectRow
        .querySelector('input')
        ?.addEventListener('change', async (e) => {
            const enabled = !!e.target.checked;
            if (app.config)
                app.config.auto_reconnect = enabled ? 'visible' : 'off';
            app.tabManager?.updateDisconnectBanner?.();
            try {
                await request('/api/config/auto-reconnect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled }),
                });
                broadcastConfigSync('behavior');
            } catch (err) {
                console.warn(
                    '[settings] failed to persist auto-reconnect toggle',
                    err,
                );
            }
        });
    // Browser-stored: delegate to the app's single writer (localStorage +
    // re-apply + same-origin broadcast). No server POST — per-server
    // persistence was the wrong home for a this-machine GPU preference.
    // Prefer app.setLowPowerMode when the host provides it; otherwise
    // (duck-typed hosts in tests) fall back to the same steps inline.
    fastModeRow
        .querySelector('input')
        ?.addEventListener('change', async (e) => {
            const enabled = !!e.target.checked;
            try {
                if (typeof app.setLowPowerMode === 'function') {
                    app.setLowPowerMode(enabled);
                } else {
                    writeLowPowerLocal(enabled);
                    if (app.config) app.config.fast_mode = enabled;
                    app.applyFastMode?.();
                    broadcastConfigSync('low-power', { enabled });
                }
            } catch (err) {
                console.warn(
                    '[settings] failed to persist low-power toggle',
                    err,
                );
            }
        });

    const piOfflineRow = _buildCheckboxRow(
        'Start pi with --offline (new tabs only)',
        'settings-pi-offline',
        !!app.config?.pi_offline,
    );
    behGroup.appendChild(piOfflineRow);
    piOfflineRow
        .querySelector('input')
        ?.addEventListener('change', async (e) => {
            const enabled = !!e.target.checked;
            if (app.config) app.config.pi_offline = enabled;
            try {
                await request('/api/config/pi-offline', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled }),
                });
            } catch (err) {
                console.warn(
                    '[settings] failed to persist pi-offline toggle',
                    err,
                );
            }
        });

    const piBridgeNoInjectRow = _buildCheckboxRow(
        'Skip Phi bridge injection for pi (manual install, new tabs only)',
        'settings-pi-bridge-no-inject',
        !!app.config?.pi_bridge_no_inject,
    );
    behGroup.appendChild(piBridgeNoInjectRow);
    piBridgeNoInjectRow
        .querySelector('input')
        ?.addEventListener('change', async (e) => {
            const enabled = !!e.target.checked;
            if (app.config) app.config.pi_bridge_no_inject = enabled;
            try {
                await request('/api/config/pi-bridge-no-inject', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled }),
                });
            } catch (err) {
                console.warn(
                    '[settings] failed to persist pi-bridge-no-inject toggle',
                    err,
                );
            }
        });

    const claudeSkipPermsRow = _buildCheckboxRow(
        'Start Claude with --dangerously-skip-permissions (new tabs only)',
        'settings-claude-skip-permissions',
        !!app.config?.claude_dangerously_skip_permissions,
    );
    behGroup.appendChild(claudeSkipPermsRow);
    claudeSkipPermsRow
        .querySelector('input')
        ?.addEventListener('change', async (e) => {
            const enabled = !!e.target.checked;
            if (app.config)
                app.config.claude_dangerously_skip_permissions = enabled;
            try {
                await request('/api/config/claude-dangerously-skip-permissions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled }),
                });
            } catch (err) {
                console.warn(
                    '[settings] failed to persist claude-skip-permissions toggle',
                    err,
                );
            }
        });

    const agyThemeAnsiRow = _buildCheckboxRow(
        'Harmonise Agy terminal colours with active Phi theme',
        'settings-agy-theme-ansi',
        !!app.config?.agy_theme_ansi,
    );
    behGroup.appendChild(agyThemeAnsiRow);
    agyThemeAnsiRow
        .querySelector('input')
        ?.addEventListener('change', async (e) => {
            const enabled = !!e.target.checked;
            if (app.config) app.config.agy_theme_ansi = enabled;
            app.tabManager?.applyThemeToAllActiveTerminals?.();
            try {
                await request('/api/config/agy-theme-ansi', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled }),
                });
            } catch (err) {
                console.warn(
                    '[settings] failed to persist agy-theme-ansi toggle',
                    err,
                );
            }
        });

    const openCodeIdleOptions = [
        { value: '0', label: 'Off' },
        { value: '15', label: '15 min' },
        { value: '30', label: '30 min' },
        { value: '60', label: '1 hr' },
        { value: '120', label: '2 hr' },
        { value: '240', label: '4 hr' },
    ];
    const currentIdleMins = String(app.config?.opencode_idle_stop_minutes || 0);
    const openCodeIdleRow = _buildSelectRow(
        'Stop OpenCode server when idle',
        'settings-opencode-idle-stop',
        openCodeIdleOptions,
        openCodeIdleOptions.some((o) => o.value === currentIdleMins)
            ? currentIdleMins
            : '0',
    );
    behGroup.appendChild(openCodeIdleRow);

    const openCodeIdleHint = document.createElement('div');
    openCodeIdleHint.className = 'settings-row-hint';
    openCodeIdleHint.textContent =
        'Stops OpenCode\u2019s background server after no OpenCode activity in Phi. Assumes OpenCode is only used through Phi.';
    behGroup.appendChild(openCodeIdleHint);

    openCodeIdleRow
        .querySelector('select')
        ?.addEventListener('change', async (e) => {
            const minutes = parseInt(e.target.value, 10) || 0;
            if (app.config) app.config.opencode_idle_stop_minutes = minutes;
            try {
                await request('/api/config/opencode-idle-stop', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ minutes }),
                });
            } catch (err) {
                console.warn(
                    '[settings] failed to persist opencode-idle-stop setting',
                    err,
                );
            }
        });

    setPasswordBtn.addEventListener('click', async () => {
        const newPw = newInput.value;
        const confirmPw = confirmInput.value;
        if (!newPw || newPw.length < PASSWORD_MIN_LENGTH) {
            showError(`At least ${PASSWORD_MIN_LENGTH} characters.`);
            newInput.focus();
            return;
        }
        if (newPw !== confirmPw) {
            showError('Passwords don\u2019t match.');
            confirmInput.focus();
            return;
        }
        setPasswordBtn.disabled = true;
        showError('');
        try {
            await setAccessPassword(newPw, context);
            clearInputs();
            app.accessAuthEnabled = true;
            stateDot.className = 'settings-access-dot is-on';
            stateText.textContent = 'Enabled';
            setPasswordBtn.textContent = 'Update password';
            removeLink.classList.remove('hidden');
            confirmRemoveBtn.classList.add('hidden');
            app.showToast('Password updated', { type: 'success' });
        } catch (err) {
            app.showToast(
                err instanceof Error
                    ? err.message
                    : 'Unable to save access password',
                { type: 'error' },
            );
        } finally {
            setPasswordBtn.disabled = false;
        }
    });

    removeLink.addEventListener('click', () => {
        removeLink.classList.add('hidden');
        confirmRemoveBtn.classList.remove('hidden');
        confirmRemoveBtn.focus();
    });
    confirmRemoveBtn.addEventListener('click', async () => {
        confirmRemoveBtn.disabled = true;
        try {
            await clearAccessPassword(context);
            app.accessAuthEnabled = false;
            stateDot.className = 'settings-access-dot is-off';
            stateText.textContent = 'Disabled';
            setPasswordBtn.textContent = 'Set password';
            removeLink.classList.add('hidden');
            confirmRemoveBtn.classList.add('hidden');
            app.showToast('Password removed', { type: 'success' });
        } catch (err) {
            app.showToast(
                err instanceof Error
                    ? err.message
                    : 'Unable to clear access password',
                { type: 'error' },
            );
        } finally {
            confirmRemoveBtn.disabled = false;
        }
    });

    [newInput, confirmInput].forEach((el) => {
        el.addEventListener('input', () => showError(''));
    });

    const desktopRows = [uiFontRow, uiSizeRow, termFontRow, termSizeRow, resetRow];
    let page = opts.page === 'mobile' || currentAppearanceProfile() === 'mobile' ? 'mobile' : 'desktop';
    const selectView = (selected) => {
        page = currentAppearanceProfile() === 'mobile' ? 'mobile' : selected;
        desktopButton.hidden = currentAppearanceProfile() === 'mobile';
        desktopButton.setAttribute('aria-pressed', String(page === 'desktop'));
        desktopButton.classList.toggle('btn-accent', page === 'desktop');
        mobileButton.classList.toggle('btn-accent', page === 'mobile');
        mobileButton.setAttribute('aria-pressed', String(page === 'mobile'));
        mobileGroup.hidden = page !== 'mobile';
        for (const row of desktopRows) row.hidden = page === 'mobile';
        appGroup.querySelector('h4').textContent = page === 'mobile' ? 'Shared appearance' : 'Appearance';
        if (page === 'mobile') mobileGroup.appendChild(mobileScrollRow);
        else appGroup.insertBefore(mobileScrollRow, uploadRow);
    };
    desktopButton.addEventListener('click', () => selectView('desktop'));
    mobileButton.addEventListener('click', () => { selectView('mobile'); void app.mobileAppearanceStore?.refresh(); });
    profileSelect.addEventListener('change', () => {
        profileWarning.textContent = writeProfileOverride(profileSelect.value) ? '' : 'Profile choice is memory-only; browser storage is unavailable.';
        app.applyAppearanceProfile?.();
        selectView(page);
    });
    selectView(page);

    // Reconcile authorized shared controls in place; never erase an edited input.
    const sharedNote = document.createElement('p');
    sharedNote.className = 'settings-row-hint';
    body.insertBefore(sharedNote, behGroup);
    body.addEventListener('input', event => { event.target.dataset.settingsEdited = '1'; });
    body.addEventListener('change', event => { event.target.dataset.settingsEdited = '1'; });
    const refreshShared = () => {
        mobile.refresh?.();
        const ready = app.settingsReady !== false;
        sharedNote.textContent = ready ? '' : 'Shared server settings are unavailable until the background refresh succeeds.';
        for (const group of [behGroup, securityGroup]) for (const control of group.querySelectorAll('input, select, button')) control.disabled = !ready;
        mobileScrollRow.querySelector('input').disabled = !ready;
        if (ready && app.config) {
            for (const [id, key] of Object.entries({
                'settings-use-hidden-terminal': 'use_hidden_terminal', 'settings-reuse-shell-tab': 'use_existing_terminal_tab',
                'settings-pi-offline': 'pi_offline', 'settings-pi-bridge-no-inject': 'pi_bridge_no_inject',
                'settings-claude-skip-permissions': 'claude_dangerously_skip_permissions', 'settings-agy-theme-ansi': 'agy_theme_ansi',
            })) {
                const control = overlay.querySelector(`#${id}`);
                if (!control.dataset.settingsEdited) control.checked = !!app.config[key];
            }
            if (!hostInput.dataset.settingsEdited) hostInput.value = app.hostnameOverride || '';
            const scroll = mobileScrollRow.querySelector('input');
            if (!scroll.dataset.settingsEdited) scroll.value = String(app.mobileScrollbackRows || 0);
            const reconnect = autoReconnectRow.querySelector('input');
            if (!reconnect.dataset.settingsEdited) reconnect.checked = (app.config.auto_reconnect || 'visible') === 'visible';
            const idle = openCodeIdleRow.querySelector('select');
            if (!idle.dataset.settingsEdited) idle.value = String(app.config.opencode_idle_stop_minutes || 0);
            const lowPower = fastModeRow.querySelector('input');
            if (!lowPower.dataset.settingsEdited && storedLowPower === null) lowPower.checked = !!app.config.fast_mode;
            if (app.useHiddenTerminal) reuseRow.querySelector('input').disabled = true;
        }
    };
    overlay.addEventListener('phi-settings-refresh', refreshShared);
    refreshShared();
    void app.mobileAppearanceStore?.refresh();
    const reveal = () => {
        if (!overlay.isConnected) return;
        overlay.classList.remove('hidden');
        closeBtn.focus({ preventScroll: true });
    };
    if (opts.standalone) reveal();
    else requestAnimationFrame(reveal);
}

function _buildMobileAppearance(app, group, context, uiFontOptions, termFontOptions) {
    const store = app.mobileAppearanceStore;
    const invalidSizes = new Set();
    const edit = (fields) => {
        store.edit(fields);
        if (invalidSizes.size) store.invalidateInput();
    };
    const families = [
        { key: 'ui_font_family', label: 'Mobile UI font', id: 'settings-mobile-ui-font', options: uiFontOptions },
        { key: 'terminal_font_family', label: 'Mobile terminal font', id: 'settings-mobile-term-font', options: termFontOptions },
    ].map(field => {
        const row = _buildSelectRow(field.label, field.id, [
            { value: 'null', label: 'Inherit desktop' },
            ...field.options.map(option => ({ ...option, value: JSON.stringify(option.value) })),
        ], JSON.stringify(store?.values[field.key] ?? null));
        const control = row.querySelector('select');
        control.addEventListener('change', () => edit({ [field.key]: JSON.parse(control.value) }));
        group.appendChild(row);
        return { ...field, control };
    });
    const sizes = [
        { key: 'ui_font_size', label: 'Mobile UI font size', id: 'settings-mobile-ui-font-size', resetId: 'settings-mobile-size-reset', fallback: 17, min: 10, max: 24 },
        { key: 'terminal_font_size', label: 'Mobile terminal font size', id: 'settings-mobile-term-font-size', resetId: 'settings-mobile-term-size-reset', fallback: 14, min: 8, max: 32 },
    ].map(field => {
        const row = _buildNumberRow(field.label, field.id, store?.values[field.key] ?? field.fallback, field.min, field.max);
        const control = row.querySelector('input');
        const reset = document.createElement('button');
        reset.type = 'button'; reset.className = 'btn btn-primary'; reset.id = field.resetId; reset.textContent = `Default (${field.fallback})`;
        row.appendChild(reset);
        group.appendChild(row);
        control.addEventListener('input', () => {
            const n = Number(control.value);
            if (!control.value.trim() || !Number.isInteger(n) || n < field.min || n > field.max) {
                invalidSizes.add(field.key);
                control.setAttribute('aria-invalid', 'true');
                store.invalidateInput();
                return;
            }
            invalidSizes.delete(field.key);
            control.removeAttribute('aria-invalid');
            edit({ [field.key]: n });
        });
        reset.addEventListener('click', () => {
            invalidSizes.delete(field.key);
            control.removeAttribute('aria-invalid');
            control.value = String(field.fallback);
            edit({ [field.key]: null });
        });
        return { ...field, control, reset };
    });
    const fontNote = document.createElement('p'); fontNote.className = 'settings-row-hint'; fontNote.id = 'settings-mobile-font-note'; group.appendChild(fontNote);
    const resetAll = document.createElement('button');
    resetAll.type = 'button'; resetAll.className = 'btn btn-primary'; resetAll.id = 'settings-mobile-reset'; resetAll.textContent = 'Reset mobile appearance';
    resetAll.addEventListener('click', () => {
        invalidSizes.clear();
        for (const field of sizes) { field.control.removeAttribute('aria-invalid'); field.control.value = String(field.fallback); }
        edit({ ui_font_family: null, ui_font_size: null, terminal_font_family: null, terminal_font_size: null });
    });
    group.appendChild(resetAll);
    const status = document.createElement('p');
    status.id = 'settings-mobile-status'; status.className = 'settings-row-hint'; status.setAttribute('role', 'status');
    group.appendChild(status);
    const desired = document.createElement('p'); desired.className = 'settings-row-hint'; group.appendChild(desired);
    const actions = document.createElement('div'); actions.className = 'settings-row-controls'; group.appendChild(actions);
    const action = (id, label, run) => {
        const button = document.createElement('button');
        button.id = id; button.type = 'button'; button.className = 'btn btn-primary'; button.textContent = label;
        button.addEventListener('click', () => { void Promise.resolve(run()).catch(error => {
            status.textContent = error instanceof Error ? error.message : 'Changes are retained; action failed.';
        }); });
        actions.appendChild(button); return button;
    };
    const save = action('settings-mobile-save', 'Save my changes', () => store.saveMyChanges());
    const useServer = action('settings-mobile-use-server', 'Use server values', () => store.useServerValues());
    const resolve = action('settings-mobile-resolve', 'Resolve', () => store.resolve());
    const refresh = action('settings-mobile-refresh', 'Refresh', () => store.refresh(true));
    const signIn = action('settings-mobile-sign-in', 'Sign in again', async () => {
        await bootstrapAccessAuth(context);
        await store.refresh(true);
    });
    const drafts = document.createElement('div'); drafts.id = 'settings-mobile-drafts'; group.appendChild(drafts);
    if (!store) {
        for (const control of group.querySelectorAll('input, select, button')) control.disabled = true;
        actions.hidden = true;
        status.textContent = 'Mobile settings are unavailable in this view.';
        return { unsubscribe() {}, refresh() {} };
    }
    let deadlineTimer = null;
    const render = () => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        status.textContent = store.status;
        for (const field of sizes)
            if (document.activeElement !== field.control && !invalidSizes.has(field.key)) field.control.value = String(store.values[field.key] ?? field.fallback);
        for (const field of families) {
            const value = store.values[field.key];
            const inherited = store.inheritance?.[field.key] || (field.key === 'ui_font_family' ? 'System default' : 'Default (JetBrains Mono)');
            field.control.options[0].textContent = `Inherit desktop — ${inherited}`;
            const encoded = JSON.stringify(value);
            if (![...field.control.options].some(option => option.value === encoded)) field.control.add(new Option(`Current: ${value}`, encoded));
            if (app.customFontName && ![...field.control.options].some(option => option.value === JSON.stringify('Phi Custom Font'))) field.control.add(new Option(`Custom: ${app.customFontName}`, JSON.stringify('Phi Custom Font')));
            field.control.value = encoded;
        }
        const missingCustom = families.some(field => (store.values[field.key] ?? store.inheritance?.[field.key]) === 'Phi Custom Font') && !document.getElementById('phi-custom-fonts');
        fontNote.textContent = [missingCustom ? 'Saved font unavailable on this device. Using a readable fallback; the saved choice is unchanged.' : '', store.inheritanceWarning || ''].filter(Boolean).join(' ');
        const attempt = store.attempt;
        desired.textContent = attempt ? `Desired values: ${JSON.stringify(attempt.fields)}. The save may already have applied. Resolve checks the server and blocks older pending saves.` : '';
        save.hidden = !store.pending;
        save.disabled = !!attempt || store.invalid || !!store.storageWarning;
        useServer.hidden = !store.pending; useServer.disabled = !!attempt;
        resolve.hidden = !attempt;
        resolve.textContent = attempt?.fences.length ? 'Resolve again' : 'Resolve';
        const remaining = (attempt?.fences.at(-1)?.deadline || 0) - Date.now();
        resolve.disabled = remaining > 0;
        if (remaining > 0) deadlineTimer = setTimeout(render, remaining + 1);
        refresh.hidden = !store.unavailable && !store.storageWarning && !store.error;
        signIn.hidden = !store.error.includes('Sign in');
        drafts.replaceChildren();
        for (const draft of store.records.drafts) {
            if (draft.id === store.draft.id || !Object.keys(draft.fields).length) continue;
            const row = document.createElement('div'); row.className = 'settings-recovery-entry';
            const label = document.createElement('p');
            const owned = draft.owner === store.owner;
            label.textContent = `${owned ? 'Retained draft' : 'Other backend (read-only)'} #${draft.id}: ${JSON.stringify(draft.fields)}${owned ? '' : ` — ${draft.owner}`}`;
            row.appendChild(label);
            if (owned) {
                const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'btn btn-primary'; restore.textContent = 'Restore';
                restore.dataset.draftId = String(draft.id);
                restore.addEventListener('click', () => { void store.restore(draft.id); });
                const discard = document.createElement('button'); discard.type = 'button'; discard.className = 'btn btn-primary'; discard.textContent = 'Discard';
                discard.disabled = attempt?.draftId === draft.id;
                discard.addEventListener('click', () => { void store.discard(draft.id); });
                row.append(restore, discard);
            }
            drafts.appendChild(row);
        }
    };
    render();
    const unsubscribe = store.subscribe(render);
    return { refresh: render, unsubscribe() { unsubscribe(); if (deadlineTimer) clearTimeout(deadlineTimer); } };
}

function _buildSettingsGroup(title) {
    const group = document.createElement('div');
    group.className = 'settings-group';
    const h = document.createElement('h4');
    h.className = 'settings-group-title';
    h.textContent = title;
    group.appendChild(h);
    return group;
}

function _buildSwatchRow(app, activeColor, accentColors) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const label = document.createElement('label');
    label.textContent = 'Highlight color';
    row.appendChild(label);
    const grid = document.createElement('div');
    grid.className = 'settings-swatch-grid';
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', 'Highlight color');
    Object.entries(accentColors).forEach(([key, theme]) => {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'settings-swatch';
        sw.setAttribute('role', 'radio');
        sw.setAttribute('aria-checked', key === activeColor ? 'true' : 'false');
        sw.dataset.color = key;
        sw.style.setProperty('--swatch', theme.accent);
        sw.title = key;
        sw.addEventListener('click', () => {
            app.applyAccentTheme(key);
            app.saveTheme(key);
            broadcastConfigSync('theme', { color: key });
            grid.querySelectorAll('.settings-swatch').forEach((s) => {
                s.setAttribute(
                    'aria-checked',
                    s.dataset.color === key ? 'true' : 'false',
                );
            });
        });
        grid.appendChild(sw);
    });
    row.appendChild(grid);
    return row;
}

function _buildSelectRow(labelText, id, options, current) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = labelText;
    row.appendChild(label);
    const sel = document.createElement('select');
    sel.id = id;
    options.forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        if (o.value === current) opt.selected = true;
        sel.appendChild(opt);
    });
    row.appendChild(sel);
    return row;
}

function _buildNumberRow(labelText, id, current, min, max) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = labelText;
    row.appendChild(label);
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.id = id;
    inp.min = String(min);
    inp.max = String(max);
    inp.value = String(current || min);
    row.appendChild(inp);
    return row;
}

function _buildCheckboxRow(labelText, id, checked) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = labelText;
    row.appendChild(label);
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.id = id;
    inp.checked = !!checked;
    row.appendChild(inp);
    return row;
}

function _buildAboutRow(k, v) {
    const row = document.createElement('div');
    row.className = 'settings-about-row';
    const key = document.createElement('span');
    key.textContent = k;
    const val = document.createElement('span');
    val.textContent = v;
    row.appendChild(key);
    row.appendChild(val);
    return row;
}
