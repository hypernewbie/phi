/* Φ phi — AI Sync Board Manager */
import { escapeHtml as escapeHtmlUtil, buildProxyUrl, openExternalLink, } from './util.js';
// Sync Board desktop-alert markers: a message whose key or value carries
// one of these signals the desktop shell via a transient page title
// (see signalDesktopAlert). Display data only — never a remote action.
const SYNC_NOTIF_MARKER = 'PHI_NOTIF';
const SYNC_ALARM_MARKER = 'PHI_ALARM';
const SYNC_TITLE_MAX = 120;
export function parseActionPayload(val) {
    let obj = null;
    if (typeof val === 'object' && val !== null) {
        obj = val;
    }
    else if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
                obj = JSON.parse(trimmed);
            }
            catch {
                return null;
            }
        }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj))
        return null;
    const hasRichKeys = 'preview' in obj ||
        'image' in obj ||
        'file' in obj ||
        'url' in obj ||
        'link' in obj ||
        'actions' in obj ||
        'title' in obj ||
        'description' in obj ||
        'desc' in obj ||
        'toast' in obj ||
        'auto_open' in obj ||
        'autoOpen' in obj;
    if (hasRichKeys) {
        return obj;
    }
    return null;
}
export class SyncManager {
    app;
    panelEl;
    pollInterval;
    coordinatorInput;
    addBtn;
    clearBtn;
    formContainer;
    formKey;
    formValue;
    formCancel;
    formSubmit;
    messagesList;
    _handledAutoOpenKeys = new Set();
    _handledToastKeys = new Set();
    _syncDebounce = null;
    constructor(app) {
        this.app = app;
        this.panelEl = document.getElementById('sync-panel');
        this.pollInterval = null;
        this.setupPanel();
    }
    setupPanel() {
        if (!this.panelEl)
            return;
        this.panelEl.innerHTML = `
            <div class="sync-header">
                <div class="sync-coordinator-bar">
                    <label for="sync-coordinator-input">Coordinator:</label>
                    <input type="text" id="sync-coordinator-input" class="sync-input" placeholder="http://localhost:7070">
                </div>
                <div class="sync-header-actions">
                    <button id="sync-clear-btn" class="sync-btn-secondary" title="Clear all messages">Clear all</button>
                    <button id="sync-add-btn" class="sync-btn-primary" title="Add Message">
                        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                    </button>
                </div>
            </div>

            <div id="sync-form-container" class="sync-form-container hidden">
                <input type="text" id="sync-form-key" class="sync-input" placeholder="key (e.g. status_check)">
                <textarea id="sync-form-value" class="sync-textarea" placeholder="value (arbitrary string)"></textarea>
                <div class="sync-form-actions">
                    <button id="sync-form-cancel" class="sync-btn-secondary">Cancel</button>
                    <button id="sync-form-submit" class="sync-btn-primary">Save</button>
                </div>
            </div>

            <div id="sync-messages-list" class="sync-messages-list">
                <div class="sync-empty-state">No messages synced.</div>
            </div>
        `;
        this.coordinatorInput = document.getElementById('sync-coordinator-input');
        this.addBtn = document.getElementById('sync-add-btn');
        this.formContainer = document.getElementById('sync-form-container');
        this.formKey = document.getElementById('sync-form-key');
        this.formValue = document.getElementById('sync-form-value');
        this.formCancel = document.getElementById('sync-form-cancel');
        this.formSubmit = document.getElementById('sync-form-submit');
        this.messagesList = document.getElementById('sync-messages-list');
        this.clearBtn = document.getElementById('sync-clear-btn');
        // Event listeners
        this.coordinatorInput.addEventListener('blur', () => this.saveCoordinator());
        this.coordinatorInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.coordinatorInput.blur();
            }
        });
        this.addBtn.addEventListener('click', () => {
            this.formContainer.classList.remove('hidden');
            this.formKey.value = '';
            this.formValue.value = '';
            this.formKey.disabled = false;
            this.formKey.focus({ preventScroll: true });
        });
        this.formCancel.addEventListener('click', () => {
            this.formContainer.classList.add('hidden');
        });
        this.formSubmit.addEventListener('click', () => this.submitMessage());
        this.clearBtn.addEventListener('click', () => this.clearAllMessages());
        this.startPolling();
    }
    async saveCoordinator() {
        const url = this.coordinatorInput.value.trim();
        try {
            await fetch('/api/config/sync-coordinator', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sync_coordinator: url }),
            });
            await this.app.sessionsManager.loadConfig(); // reload global config
            this.refreshMessages();
        }
        catch (e) {
            console.error('Failed to save sync coordinator:', e);
            this.app.showToast(`Failed to save coordinator: ${e.message}`, { type: 'error' });
        }
    }
    startPolling() {
        if (this.pollInterval)
            clearInterval(this.pollInterval);
        this.refreshMessages();
        this.pollInterval = setInterval(() => {
            const diffCtrl = this.app.diffController;
            if (diffCtrl?.isPanelOpen && diffCtrl.activeTab === 'sync') {
                this.refreshMessages();
            }
        }, 15000);
    }
    async getCoordinatorUrl() {
        const config = this.app.sessionsManager.config;
        return config?.sync_coordinator || 'http://localhost:7070';
    }
    async fetchWithProxy(endpoint, options = {}) {
        const coordinator = await this.getCoordinatorUrl();
        const proxyUrl = buildProxyUrl(coordinator, endpoint);
        const res = await fetch(proxyUrl, options);
        if (!res.ok) {
            const text = await res.text().catch(() => 'Unknown error');
            throw new Error(text || `HTTP ${res.status}`);
        }
        return res;
    }
    async refreshMessages() {
        try {
            if (document.activeElement !== this.coordinatorInput) {
                this.coordinatorInput.value = await this.getCoordinatorUrl();
            }
            const res = await this.fetchWithProxy('/api/sync/messages');
            const messages = await res.json();
            this.renderMessages(messages);
            this.signalDesktopAlert(messages);
        }
        catch (e) {
            console.error('[sync] Failed to refresh:', e);
            this.messagesList.innerHTML = `<div class="sync-error-state">Error: ${this.escapeHtml(e.message)}</div>`;
        }
    }
    onSyncChanged(_control) {
        if (this._syncDebounce)
            clearTimeout(this._syncDebounce);
        this._syncDebounce = setTimeout(() => {
            this._syncDebounce = null;
            void this.refreshMessages();
        }, 60);
    }
    openFilePreview(relPath) {
        const cleanPath = relPath.trim();
        const name = cleanPath.split('/').pop() || cleanPath;
        const activeTab = this.app.tabManager?.getActiveTab();
        const cwd = activeTab?.cwd || this.app.sessionsManager?.activeCWD || '';
        if (this.app.markdownManager?.previewFile) {
            void this.app.markdownManager.previewFile({ path: cleanPath, name }, cwd);
        }
        else {
            this.app.showToast(`Cannot preview ${name}: file preview not available`, { type: 'error' });
        }
    }
    renderMessages(messages) {
        if (!messages || messages.length === 0) {
            this.messagesList.innerHTML =
                '<div class="sync-empty-state">No messages synced.</div>';
            return;
        }
        messages.sort((a, b) => new Date(b.updated_at) -
            new Date(a.updated_at));
        this.messagesList.innerHTML = '';
        messages.forEach((msg) => {
            const card = document.createElement('div');
            card.className = 'sync-card';
            const localTime = new Date(msg.updated_at).toLocaleTimeString();
            const actionData = parseActionPayload(msg.value);
            // Handle auto_open & toast for recent action messages (< 15 seconds)
            if (actionData) {
                const msgTime = new Date(msg.updated_at || msg.created_at).getTime();
                const isRecent = !isNaN(msgTime) && Date.now() - msgTime < 15000;
                const updateKey = `${msg.key}:${msg.updated_at || msg.created_at}`;
                if (this._handledToastKeys.size > 200)
                    this._handledToastKeys.clear();
                if (this._handledAutoOpenKeys.size > 200)
                    this._handledAutoOpenKeys.clear();
                if (actionData.toast &&
                    isRecent &&
                    !this._handledToastKeys.has(updateKey)) {
                    this._handledToastKeys.add(updateKey);
                    this.app.showToast(actionData.toast, { type: 'info' });
                }
                const shouldAutoOpen = actionData.auto_open === true ||
                    actionData.autoOpen === true;
                if (shouldAutoOpen &&
                    isRecent &&
                    !this._handledAutoOpenKeys.has(updateKey)) {
                    this._handledAutoOpenKeys.add(updateKey);
                    const previewTarget = actionData.preview ||
                        actionData.image ||
                        actionData.file;
                    if (previewTarget) {
                        this.openFilePreview(previewTarget);
                    }
                    else if (actionData.url || actionData.link) {
                        const rawUrl = actionData.url || actionData.link;
                        if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
                            openExternalLink(rawUrl);
                        }
                    }
                }
            }
            const headerHtml = `
                <div class="sync-card-header">
                    <span class="sync-card-key" title="${this.escapeHtml(msg.key)}">${this.escapeHtml(msg.key)}</span>
                    <div class="sync-card-actions">
                        <button class="sync-card-btn sync-edit-btn" title="Edit message">
                            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                        </button>
                        <button class="sync-card-btn sync-del-btn" title="Delete message">
                            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                        </button>
                    </div>
                </div>
            `;
            let bodyHtml = '';
            if (actionData) {
                const desc = actionData.description ||
                    actionData.desc ||
                    actionData.text ||
                    '';
                const previewTarget = actionData.preview || actionData.image || actionData.file;
                const rawUrl = actionData.url || actionData.link;
                const safeUrl = rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : null;
                const previewName = previewTarget
                    ? previewTarget.split('/').pop() || previewTarget
                    : '';
                const rawJsonStr = typeof msg.value === 'string'
                    ? msg.value
                    : JSON.stringify(msg.value, null, 2);
                const chipsHtml = previewTarget || safeUrl
                    ? `
                    <div class="sync-action-chips">
                        ${previewTarget
                        ? `<button type="button" class="sync-chip-btn sync-preview-btn" title="Preview ${this.escapeHtml(previewTarget)}">
                                    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                                    <span>Preview ${this.escapeHtml(previewName)}</span>
                                </button>`
                        : ''}
                        ${safeUrl
                        ? `<a href="${this.escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="sync-chip-btn sync-link-btn" title="Open ${this.escapeHtml(safeUrl)}">
                                    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                                    <span>Open Link</span>
                                </a>`
                        : ''}
                    </div>`
                    : '';
                const actionsList = Array.isArray(actionData.actions)
                    ? actionData.actions
                    : [];
                const actionsHtml = actionsList.length > 0
                    ? `
                    <div class="sync-action-btns">
                        ${actionsList
                        .map((act, idx) => {
                        const styleClass = act.style
                            ? ` style-${this.escapeHtml(act.style)}`
                            : '';
                        const label = act.label || act.name || 'Execute';
                        const cmd = act.command || act.cmd || act.input || '';
                        return `<button type="button" class="sync-action-cmd-btn${styleClass}" data-idx="${idx}" title="${this.escapeHtml(cmd)}">${this.escapeHtml(label)}</button>`;
                    })
                        .join('')}
                    </div>`
                    : '';
                bodyHtml = `
                    <div class="sync-action-card">
                        ${actionData.title ? `<div class="sync-action-title">${this.escapeHtml(actionData.title)}</div>` : ''}
                        ${desc ? `<div class="sync-action-desc">${this.escapeHtml(desc)}</div>` : ''}
                        ${chipsHtml}
                        ${actionsHtml}
                        <div class="sync-raw-toggle" title="Toggle raw JSON value">
                            <span class="sync-raw-toggle-arrow">▸</span> <span>Raw JSON</span>
                        </div>
                        <div class="sync-card-value sync-action-raw hidden">${this.escapeHtml(rawJsonStr)}</div>
                    </div>
                `;
            }
            else {
                bodyHtml = `<div class="sync-card-value collapsed">${this.escapeHtml(msg.value)}</div>`;
            }
            card.innerHTML = `
                ${headerHtml}
                ${bodyHtml}
                <div class="sync-card-footer">${localTime}</div>
            `;
            // Wire standard value click if collapsed
            const standardValEl = card.querySelector('.sync-card-value:not(.sync-action-raw)');
            if (standardValEl) {
                standardValEl.addEventListener('click', () => {
                    standardValEl.classList.toggle('collapsed');
                });
            }
            // Wire action card listeners
            if (actionData) {
                const previewTarget = actionData.preview || actionData.image || actionData.file;
                if (previewTarget) {
                    card.querySelector('.sync-preview-btn')?.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.openFilePreview(previewTarget);
                    });
                }
                const rawToggle = card.querySelector('.sync-raw-toggle');
                const rawEl = card.querySelector('.sync-action-raw');
                const arrow = card.querySelector('.sync-raw-toggle-arrow');
                rawToggle?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (rawEl) {
                        const isHidden = rawEl.classList.toggle('hidden');
                        if (arrow)
                            arrow.textContent = isHidden ? '▸' : '▾';
                    }
                });
                const actionBtns = card.querySelectorAll('.sync-action-cmd-btn');
                actionBtns.forEach((btn) => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const idx = Number(btn.dataset.idx);
                        const act = actionData.actions?.[idx];
                        if (!act)
                            return;
                        const cmd = act.command || act.cmd || act.input || '';
                        if (!cmd)
                            return;
                        if (act.stage) {
                            if (this.app.tabManager?.inputTextArea) {
                                this.app.tabManager.inputTextArea.value = cmd;
                                this.app.tabManager.inputTextArea.focus({
                                    preventScroll: true,
                                });
                                this.app.showToast(`Staged: ${act.label || cmd}`, { type: 'info' });
                            }
                        }
                        else {
                            if (this.app.tabManager?.sendRawInput) {
                                const payload = cmd.endsWith('\r') || cmd.endsWith('\n')
                                    ? cmd
                                    : `${cmd}\r`;
                                this.app.tabManager.sendRawInput(payload);
                                this.app.showToast(`Sent: ${act.label || cmd.trim()}`, { type: 'info' });
                            }
                        }
                    });
                });
            }
            card.querySelector('.sync-edit-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.formContainer.classList.remove('hidden');
                this.formKey.value = msg.key;
                this.formKey.disabled = true;
                this.formValue.value =
                    typeof msg.value === 'string'
                        ? msg.value
                        : JSON.stringify(msg.value, null, 2);
                this.formValue.focus({ preventScroll: true });
            });
            card.querySelector('.sync-del-btn')?.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm(`Delete sync key "${msg.key}"?`)) {
                    try {
                        await this.fetchWithProxy(`/api/sync/messages/${encodeURIComponent(msg.key)}`, {
                            method: 'DELETE',
                        });
                        this.refreshMessages();
                    }
                    catch (err) {
                        this.app.showToast(`Failed to delete: ${err.message}`, { type: 'error' });
                    }
                }
            });
            this.messagesList.appendChild(card);
        });
    }
    async submitMessage() {
        const key = this.formKey.value.trim();
        const value = this.formValue.value;
        if (!key) {
            this.app.showToast('Key is required', { type: 'error' });
            return;
        }
        try {
            await this.fetchWithProxy('/api/sync/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, value }),
            });
            this.formContainer.classList.add('hidden');
            this.refreshMessages();
        }
        catch (e) {
            this.app.showToast(`Failed to save message: ${e.message}`, { type: 'error' });
        }
    }
    escapeHtml(str) {
        return escapeHtmlUtil(str);
    }
    // Desktop-gated transient title signal: when a message's key or value
    // carries PHI_NOTIF / PHI_ALARM, write 'PHI_NOTIF <key>' (or
    // 'PHI_ALARM <key>') into document.title for the desktop shell to
    // observe through its existing page-title-updated event. The
    // terminal-activity title updater overwrites it on the next tick, so
    // the marker is transient by design; plain browser pages never set it
    // and the marker never leaves the page.
    signalDesktopAlert(messages) {
        if (!navigator.userAgent.includes('Electron') &&
            new URLSearchParams(location.search).get('desktop') !== '1') {
            return;
        }
        let marker = '';
        let key = '';
        for (const msg of messages) {
            const k = String(msg && msg.key !== undefined ? msg.key : '');
            const v = String(msg && msg.value !== undefined ? msg.value : '');
            if (k.includes(SYNC_ALARM_MARKER) ||
                v.includes(SYNC_ALARM_MARKER)) {
                marker = SYNC_ALARM_MARKER;
                key = k;
                break;
            }
            if (marker === '' &&
                (k.includes(SYNC_NOTIF_MARKER) || v.includes(SYNC_NOTIF_MARKER))) {
                marker = SYNC_NOTIF_MARKER;
                key = k;
            }
        }
        if (marker !== '') {
            document.title = `${marker} ${key}`.slice(0, SYNC_TITLE_MAX);
        }
    }
    // clearAllMessages DELETEs every entry on the current coordinator.
    // No dedicated bulk-delete endpoint exists; iterate the keys we just
    // rendered and DELETE each one. The list before iteration is the
    // source of truth — if a new key lands mid-drain (from another
    // machine), it'll survive this pass and show up on the next refresh,
    // which is the right UX (don't trash work-in-progress). All-or-
    // nothing confirmation matches the per-card delete pattern.
    async clearAllMessages() {
        let keys = [];
        try {
            const res = await this.fetchWithProxy('/api/sync/messages');
            const list = await res.json();
            if (Array.isArray(list))
                keys = list.map((m) => m.key).filter(Boolean);
        }
        catch (e) {
            this.app.showToast(`Failed to read messages: ${e.message}`, { type: 'error' });
            return;
        }
        if (keys.length === 0) {
            this.app.showToast('No messages to clear', { type: 'info' });
            return;
        }
        if (!confirm(`Delete all ${keys.length} sync message${keys.length === 1 ? '' : 's'} from this coordinator?`)) {
            return;
        }
        // Run DELETEs sequentially so a partial failure doesn't strand
        // an outage (parallel fan-out would multiply the load on the
        // coordinator). Each failure is reported but doesn't abort the
        // rest — best-effort clear.
        let failed = 0;
        for (const k of keys) {
            try {
                await this.fetchWithProxy(`/api/sync/messages/${encodeURIComponent(k)}`, {
                    method: 'DELETE',
                });
            }
            catch (e) {
                console.error('[sync] clear delete failed for', k, e);
                failed += 1;
            }
        }
        await this.refreshMessages();
        if (failed > 0) {
            this.app.showToast(`Cleared; ${failed} delete${failed === 1 ? '' : 's'} failed (see console)`, { type: 'error' });
        }
        else {
            this.app.showToast(`Cleared ${keys.length} message${keys.length === 1 ? '' : 's'}`, { type: 'success' });
        }
    }
}
