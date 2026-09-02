import { displayHostname } from './util.js';
import { setAccessPassword, clearAccessPassword } from './auth.js';
import { tryNative } from './desktop.js';

export function broadcastConfigSync(type, payload = {}) {
    try {
        if (typeof BroadcastChannel !== 'undefined') {
            const ch = new BroadcastChannel('phi_config_sync');
            ch.postMessage({ type, ...payload });
            ch.close();
        }
    } catch {}
}

export function openSettingsModal(app, accentColors, opts = {}) {
    if (document.querySelector('.settings-overlay')) return;
    if (!opts.standalone && tryNative('config', {})) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay settings-overlay hidden';

    const modal = document.createElement('div');
    modal.className = 'modal-content settings-modal';

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
        app.uiFontFamily,
    );
    appGroup.appendChild(uiFontRow);

    const uiSizeRow = _buildNumberRow(
        'UI font size',
        'settings-ui-font-size',
        app.uiFontSize || 14,
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
        app.terminalFontFamily,
    );
    appGroup.appendChild(termFontRow);

    const termSizeRow = _buildNumberRow(
        'Terminal font size',
        'settings-term-font-size',
        app.terminalFontSize || 14,
        8,
        32,
    );
    appGroup.appendChild(termSizeRow);

    const uploadRow = document.createElement('div');
    uploadRow.className = 'settings-row';
    const uploadLabel = document.createElement('label');
    uploadLabel.htmlFor = 'settings-font-upload';
    uploadLabel.textContent = 'Upload font…';
    uploadRow.appendChild(uploadLabel);
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'settings-font-upload';
    fileInput.accept = '.woff2,.woff,.ttf,.otf';
    uploadRow.appendChild(fileInput);
    appGroup.appendChild(uploadRow);

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
        'Auto-reconnect disconnected terminals (active tab)',
        'settings-auto-reconnect',
        (app.config?.auto_reconnect || 'visible') === 'visible',
    );
    behGroup.appendChild(autoReconnectRow);
    const fastModeRow = _buildCheckboxRow(
        'Fast mode (disable expensive visual effects)',
        'settings-fast-mode',
        !!app.config?.fast_mode,
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
        document.removeEventListener('keydown', onKeydown);
        overlay.classList.add('hidden');
        overlay.remove();
    };
    const onKeydown = (e) => {
        if (e.key === 'Escape') close();
    };
    closeBtn.addEventListener('click', close);
    doneBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKeydown);

    let persistTimer = null;
    const debouncedPersist = () => {
        clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
            app.persistAppearance();
            broadcastConfigSync('appearance');
        }, 300);
    };
    uiFontRow.querySelector('select')?.addEventListener('change', (e) => {
        app.uiFontFamily = e.target.value;
        app.applyUIFont();
        app._saveAppearanceLocal();
        debouncedPersist();
    });
    uiSizeRow.querySelector('input')?.addEventListener('input', (e) => {
        const n = parseInt(e.target.value, 10);
        if (!Number.isFinite(n) || n < 10 || n > 24) return;
        app.uiFontSize = n;
        app.applyUIFont();
        app._saveAppearanceLocal();
        debouncedPersist();
    });
    termFontRow.querySelector('select')?.addEventListener('change', (e) => {
        app.terminalFontFamily = e.target.value;
        app.tabManager?.applyFontToAllActiveTerminals(
            app.terminalFontFamily || 'JetBrains Mono, monospace',
        );
        app._saveAppearanceLocal();
        debouncedPersist();
    });
    termSizeRow.querySelector('input')?.addEventListener('input', (e) => {
        const n = parseInt(e.target.value, 10);
        if (!Number.isFinite(n) || n < 8 || n > 32) return;
        app.terminalFontSize = n;
        app.tabManager?.applyTerminalFontSizeToAll(n);
        app._saveAppearanceLocal();
        debouncedPersist();
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
    resetBtn.addEventListener('click', async () => {
        try {
            localStorage.removeItem('phi_appearance');
        } catch {}
        document.getElementById('phi-prepaint-appearance')?.remove();
        await app.clearCustomFont?.();
        app.uiFontFamily = '';
        app.uiFontSize = 0;
        app.terminalFontFamily = '';
        app.terminalFontSize = 0;
        app.customFontName = '';
        app.applyUIFont();
        app.tabManager?.applyFontToAllActiveTerminals(
            'JetBrains Mono, monospace',
        );
        app.tabManager?.applyTerminalFontSizeToAll(0);
        app.persistAppearance();
        broadcastConfigSync('appearance');
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
            await fetch('/api/config/use-hidden-terminal', {
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
            await fetch('/api/config/use-existing-terminal-tab', {
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
            try {
                await fetch('/api/config/auto-reconnect', {
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
    fastModeRow
        .querySelector('input')
        ?.addEventListener('change', async (e) => {
            const enabled = !!e.target.checked;
            if (app.config) app.config.fast_mode = enabled;
            app.applyFastMode();
            try {
                await fetch('/api/config/fast-mode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled }),
                });
                broadcastConfigSync('behavior');
            } catch (err) {
                console.warn(
                    '[settings] failed to persist fast-mode toggle',
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
                await fetch('/api/config/pi-offline', {
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
                await fetch('/api/config/claude-dangerously-skip-permissions', {
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
            await setAccessPassword(newPw);
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
            await clearAccessPassword();
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

    if (opts.standalone) {
        overlay.classList.remove('hidden');
    } else {
        requestAnimationFrame(() => overlay.classList.remove('hidden'));
    }
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
