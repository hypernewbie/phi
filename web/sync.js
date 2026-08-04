/* Φ phi — AI Sync Board Manager */
import { escapeHtml as escapeHtmlUtil, buildProxyUrl } from './util.js';
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
                body: JSON.stringify({ sync_coordinator: url })
            });
            await this.app.sessionsManager.loadConfig(); // reload global config
            this.refreshMessages();
        }
        catch (e) {
            console.error('Failed to save sync coordinator:', e);
            this.app.showToast('Failed to save coordinator: ' + e.message, { type: 'error' });
        }
    }
    startPolling() {
        if (this.pollInterval)
            clearInterval(this.pollInterval);
        this.refreshMessages();
        this.pollInterval = setInterval(() => {
            const diffCtrl = this.app.diffController;
            if (diffCtrl && diffCtrl.isPanelOpen && diffCtrl.activeTab === 'sync') {
                this.refreshMessages();
            }
        }, 15000);
    }
    async getCoordinatorUrl() {
        const config = this.app.sessionsManager.config;
        return (config && config.sync_coordinator) || 'http://localhost:7070';
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
        }
        catch (e) {
            console.error('[sync] Failed to refresh:', e);
            this.messagesList.innerHTML = `<div class="sync-error-state">Error: ${this.escapeHtml(e.message)}</div>`;
        }
    }
    renderMessages(messages) {
        if (!messages || messages.length === 0) {
            this.messagesList.innerHTML = '<div class="sync-empty-state">No messages synced.</div>';
            return;
        }
        messages.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
        this.messagesList.innerHTML = '';
        messages.forEach(msg => {
            const card = document.createElement('div');
            card.className = 'sync-card';
            const localTime = new Date(msg.updated_at).toLocaleTimeString();
            card.innerHTML = `
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
                <div class="sync-card-value collapsed">${this.escapeHtml(msg.value)}</div>
                <div class="sync-card-footer">${localTime}</div>
            `;
            const valEl = card.querySelector('.sync-card-value');
            valEl.addEventListener('click', () => {
                valEl.classList.toggle('collapsed');
            });
            card.querySelector('.sync-edit-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.formContainer.classList.remove('hidden');
                this.formKey.value = msg.key;
                this.formKey.disabled = true;
                this.formValue.value = msg.value;
                this.formValue.focus({ preventScroll: true });
            });
            card.querySelector('.sync-del-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm(`Delete sync key "${msg.key}"?`)) {
                    try {
                        await this.fetchWithProxy(`/api/sync/messages/${encodeURIComponent(msg.key)}`, {
                            method: 'DELETE'
                        });
                        this.refreshMessages();
                    }
                    catch (err) {
                        this.app.showToast('Failed to delete: ' + err.message, { type: 'error' });
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
                body: JSON.stringify({ key, value })
            });
            this.formContainer.classList.add('hidden');
            this.refreshMessages();
        }
        catch (e) {
            this.app.showToast('Failed to save message: ' + e.message, { type: 'error' });
        }
    }
    escapeHtml(str) {
        return escapeHtmlUtil(str);
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
            this.app.showToast('Failed to read messages: ' + e.message, { type: 'error' });
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
