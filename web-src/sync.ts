/* Φ phi — AI Sync Board Manager */

import type { AppLike } from './types.js';
import {
    escapeHtml as escapeHtmlUtil,
    buildProxyUrl,
    openExternalLink,
    serverKey,
} from './util.js';
import { renderMarkdownSafe, highlightCodeIn } from './md-render.js';

// Sync Board desktop-alert markers: a message whose key or value carries
// one of these signals the desktop shell via a transient page title
// (see signalDesktopAlert). Display data only — never a remote action.
const SYNC_NOTIF_MARKER = 'PHI_NOTIF';
const SYNC_ALARM_MARKER = 'PHI_ALARM';
const SYNC_TITLE_MAX = 120;
const PUSHES_ENDPOINT = '/api/sync/pushes';
const PUSH_CACHE_KEY = 'phi_sync_pushes_v1';

interface SyncPushMessage {
    message_id: string;
    seq?: number;
    sender: string;
    recipient: string;
    value: string;
    updated_at_unix_ms: number;
    truncated?: boolean;
}

function parsePushMessages(value: unknown): SyncPushMessage[] | null {
    if (!Array.isArray(value) || value.length > 100) return null;
    for (const item of value) {
        const msg = asObject<SyncPushMessage>(item);
        if (
            !msg ||
            typeof msg.message_id !== 'string' ||
            !msg.message_id ||
            msg.message_id.length > 128 ||
            typeof msg.sender !== 'string' ||
            msg.sender.length > 128 ||
            typeof msg.recipient !== 'string' ||
            msg.recipient.length > 128 ||
            typeof msg.value !== 'string' ||
            msg.value.length > 4096 ||
            !Number.isFinite(msg.updated_at_unix_ms) ||
            (msg.seq !== undefined && !Number.isFinite(msg.seq)) ||
            (msg.truncated !== undefined &&
                typeof msg.truncated !== 'boolean')
        )
            return null;
    }
    return value as SyncPushMessage[];
}

/**
 * The mesh stamps the sender as the peer address it received from. The port
 * is transport detail, so the card shows the host and keeps the full address
 * in the title.
 */
function displaySender(sender: string): string {
    return sender.replace(/:\d+$/, '');
}

export interface SyncActionItem {
    label?: string;
    name?: string;
    command?: string;
    cmd?: string;
    input?: string;
    style?: 'primary' | 'danger' | 'success' | string;
    stage?: boolean;
}

export interface SyncDiffTarget {
    commit?: string;
    target?: string;
    files?: string[];
    modal?: boolean;
}

export interface SyncChecklistItem {
    label?: string;
    text?: string;
    name?: string;
    done?: boolean;
    checked?: boolean;
}

export interface SyncActionPayload {
    done?: string;
    machine?: string;
    title?: string;
    description?: string;
    desc?: string;
    text?: string;
    preview?: string;
    image?: string;
    file?: string;
    url?: string;
    link?: string;
    diff?: boolean | string | SyncDiffTarget;
    checklist?: Array<string | SyncChecklistItem>;
    actions?: SyncActionItem[];
    toast?: string;
    /** Sent by older senders; accepted and ignored — nothing auto-opens. */
    auto_open?: boolean;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function asObject<T extends object>(value: unknown): T | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    return value as T;
}

/** Scalar card fields whose only requirement is that they are strings. */
const STRING_FIELDS = [
    'done',
    'machine',
    'title',
    'description',
    'desc',
    'text',
    'toast',
    'preview',
    'image',
    'file',
    'url',
    'link',
] as const satisfies readonly (keyof SyncActionPayload)[];

/**
 * Reads one Sync Board value into the shape the cards render. Another
 * machine on the tailnet writes these values, so every field is checked
 * here instead of being cast: an entry with the wrong type is dropped and
 * the rest of the card still renders. A value with no recognizable field
 * returns null and displays as plain text.
 */
export function parseActionPayload(val: unknown): SyncActionPayload | null {
    let obj: unknown = null;
    if (typeof val === 'object' && val !== null) {
        obj = val;
    } else if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
                obj = JSON.parse(trimmed);
            } catch {
                return null;
            }
        }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const raw = obj as Record<string, unknown>;

    const payload: SyncActionPayload = {};
    for (const key of STRING_FIELDS) {
        const text = asString(raw[key]);
        if (text !== undefined) payload[key] = text;
    }
    if (typeof raw.auto_open === 'boolean') payload.auto_open = raw.auto_open;
    if (typeof raw.diff === 'boolean' || typeof raw.diff === 'string') {
        payload.diff = raw.diff;
    } else {
        const diffTarget = asObject<SyncDiffTarget>(raw.diff);
        if (diffTarget) payload.diff = diffTarget;
    }
    if (Array.isArray(raw.checklist)) {
        // A null entry used to throw inside the card renderer, which took
        // the whole board down; drop the unusable rows instead.
        const items = raw.checklist.filter(
            (item): item is string | SyncChecklistItem =>
                typeof item === 'string' ||
                (typeof item === 'object' &&
                    item !== null &&
                    !Array.isArray(item)),
        );
        if (items.length > 0) payload.checklist = items;
    }
    if (Array.isArray(raw.actions)) {
        const actions = raw.actions.filter(
            (act): act is SyncActionItem =>
                typeof act === 'object' && act !== null && !Array.isArray(act),
        );
        if (actions.length > 0) payload.actions = actions;
    }

    return Object.keys(payload).length > 0 ? payload : null;
}

export function formatDoneSummary(value: string): string {
    const words = value.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
    if (words.length <= 10) return words.join(' ');
    return `${words.slice(0, 10).join(' ')}…`;
}

// A string diff target is a commit hash, except for the legacy "modal"
// shortcut. An explicitly invalid commit must not fall back to unstaged.
export function getSyncDiffCommit(
    target: SyncActionPayload['diff'],
): string | undefined {
    if (typeof target === 'string' && target !== 'modal') return target.trim();
    if (typeof target === 'object' && target !== null && 'commit' in target) {
        return typeof target.commit === 'string' ? target.commit.trim() : '';
    }
    return undefined;
}

export class SyncManager {
    app: AppLike;
    panelEl: HTMLElement | null;
    pollInterval: ReturnType<typeof setInterval> | null;
    coordinatorInput!: HTMLInputElement;
    addBtn!: HTMLElement;
    clearBtn!: HTMLElement;
    formContainer!: HTMLElement;
    formKey!: HTMLInputElement;
    formValue!: HTMLTextAreaElement;
    formCancel!: HTMLElement;
    formSubmit!: HTMLElement;
    messagesList!: HTMLElement;
    pushSection!: HTMLElement;
    pushList!: HTMLElement;

    private _fileExistCache = new Map<string, Promise<boolean>>();
    private _handledToastKeys = new Set<string>();
    private _syncDebounce: ReturnType<typeof setTimeout> | null = null;
    private _pushRefresh: AbortController | null = null;
    private _pushScope: unknown;
    private _pushExpanded = new Set<string>();
    private _pushRendered = '';

    constructor(app: AppLike) {
        this.app = app;
        this.panelEl = document.getElementById('sync-panel');
        this.pollInterval = null;
        this.setupPanel();
    }

    setupPanel(): void {
        if (!this.panelEl) return;

        this.panelEl.innerHTML = `
            <div class="sync-header">
                <div class="sync-coordinator-bar">
                    <label for="sync-coordinator-input">Coordinator:</label>
                    <input type="text" id="sync-coordinator-input" class="sync-input" placeholder="This server (leave blank)">
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

            <div class="sync-sections">
                <div class="sync-section">
                    <div class="sync-section-header">
                        <div class="sync-section-title">Board</div>
                        <div class="sync-header-actions">
                            <button id="sync-clear-btn" class="sync-btn-secondary" title="Clear all board messages">Clear all</button>
                            <button id="sync-add-btn" class="sync-btn-primary" title="Add Message">
                                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                            </button>
                        </div>
                    </div>
                    <div id="sync-messages-list" class="sync-messages-list">
                        <div class="sync-empty-state">No messages synced.</div>
                    </div>
                </div>

                <div id="sync-push-section" class="sync-section hidden">
                    <div class="sync-section-title">Addressed messages · this server</div>
                    <div class="sync-push-note hidden" role="status"></div>
                    <div id="sync-push-list" class="sync-messages-list"></div>
                </div>
            </div>
        `;

        this.coordinatorInput = document.getElementById(
            'sync-coordinator-input',
        ) as HTMLInputElement;
        this.addBtn = document.getElementById('sync-add-btn') as HTMLElement;
        this.formContainer = document.getElementById(
            'sync-form-container',
        ) as HTMLElement;
        this.formKey = document.getElementById(
            'sync-form-key',
        ) as HTMLInputElement;
        this.formValue = document.getElementById(
            'sync-form-value',
        ) as HTMLTextAreaElement;
        this.formCancel = document.getElementById(
            'sync-form-cancel',
        ) as HTMLElement;
        this.formSubmit = document.getElementById(
            'sync-form-submit',
        ) as HTMLElement;
        this.messagesList = document.getElementById(
            'sync-messages-list',
        ) as HTMLElement;
        this.clearBtn = document.getElementById(
            'sync-clear-btn',
        ) as HTMLElement;
        this.pushSection = document.getElementById(
            'sync-push-section',
        ) as HTMLElement;
        this.pushList = document.getElementById(
            'sync-push-list',
        ) as HTMLElement;

        // Event listeners
        this.coordinatorInput.addEventListener('change', () =>
            this.saveCoordinator(),
        );
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

    async saveCoordinator(): Promise<void> {
        const url = this.coordinatorInput.value.trim();
        try {
            await fetch('/api/config/sync-coordinator', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sync_coordinator: url }),
            });
            await this.app.sessionsManager.loadConfig(); // reload global config
            this.refreshMessages();
        } catch (e) {
            console.error('Failed to save sync coordinator:', e);
            this.app.showToast(
                `Failed to save coordinator: ${(e as Error).message}`,
                { type: 'error' },
            );
        }
    }

    startPolling(scope?: any): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }

        this._fileExistCache.clear();
        this._handledToastKeys.clear();

        this.restorePushes();
        this.refreshMessages();

        const activeScope = scope || (this.app as any)?.scope;
        const tick = () => {
            if (activeScope?.aborted) return;
            const diffCtrl = this.app.diffController;
            if (diffCtrl?.isPanelOpen && diffCtrl.activeTab === 'sync') {
                this.refreshMessages();
            }
        };

        if (activeScope && typeof activeScope.interval === 'function') {
            this.pollInterval = activeScope.interval(tick, 15000);
        } else {
            this.pollInterval = setInterval(tick, 15000);
        }
    }

    async getCoordinatorUrl(): Promise<string> {
        const config = this.app.sessionsManager.config;
        return config?.sync_coordinator || window.location.origin;
    }

    async fetchWithProxy(
        endpoint: string,
        options: RequestInit = {},
    ): Promise<Response> {
        const coordinator = await this.getCoordinatorUrl();
        const proxyUrl = buildProxyUrl(coordinator, endpoint);

        const res = await fetch(proxyUrl, options);
        if (!res.ok) {
            const text = await res.text().catch(() => 'Unknown error');
            throw new Error(text || `HTTP ${res.status}`);
        }
        return res;
    }

    async refreshMessages(): Promise<void> {
        // Addressed messages are a local read, so they still refresh where the
        // board itself cannot be reached.
        void this.refreshPushes();
        if (
            window.location.protocol === 'phi-app:' &&
            !this.app.sessionsManager.config?.sync_coordinator
        ) {
            return;
        }
        try {
            if (document.activeElement !== this.coordinatorInput) {
                this.coordinatorInput.value = await this.getCoordinatorUrl();
            }

            const res = await this.fetchWithProxy('/api/sync/messages');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const messages: unknown = await res.json();
            if (!Array.isArray(messages))
                throw new Error('Unexpected board response.');
            const store = (this.app as any)?.getActiveStore?.();
            if (store) {
                store.responses.set(
                    '/api/sync/messages',
                    JSON.stringify(messages),
                );
            }

            this.renderMessages(messages);
            this.signalDesktopAlert(messages);
            this._setRefreshError(null);
        } catch (e: any) {
            if (e?.name === 'AbortError' || (this.app as any)?.scope?.aborted)
                return;
            console.error('[sync] Failed to refresh:', e);
            // A slow or broken link must not erase the board that is already
            // on screen, so the failure becomes one inline line.
            this._setRefreshError((e as Error)?.message || 'Request failed');
        }
    }

    /** Shows or clears the inline note above the board without touching it. */
    _setRefreshError(message: string | null): void {
        const existing = this.messagesList.querySelector('.sync-error-state');
        if (message === null) {
            existing?.remove();
            return;
        }
        const note =
            existing ??
            this.messagesList.insertBefore(
                document.createElement('div'),
                this.messagesList.firstChild,
            );
        note.className = 'sync-error-state sync-refresh-note';
        note.textContent = `Sync failed: ${message}. Showing the last board.`;
        if (!this.messagesList.querySelector('.sync-card, .sync-empty-state'))
            note.textContent = `Sync failed: ${message}.`;
    }

    onSyncChanged(_control?: any): void {
        if (this._syncDebounce) clearTimeout(this._syncDebounce);
        this._syncDebounce = setTimeout(() => {
            this._syncDebounce = null;
            void this.refreshMessages();
        }, 60);
    }

    isFileTargetValid(relPath: string): boolean {
        if (!relPath || typeof relPath !== 'string') return false;
        const clean = relPath.trim();
        if (!clean) return false;
        if (
            clean.startsWith('/') ||
            clean.startsWith('\\') ||
            /^[a-zA-Z]:[/\\]/.test(clean) ||
            clean.split(/[/\\]/).includes('..')
        ) {
            return false;
        }
        return true;
    }

    async checkFileExists(relPath: string, cwd: string): Promise<boolean> {
        if (!this.isFileTargetValid(relPath)) {
            return false;
        }
        const clean = relPath.trim();
        const cacheKey = `${cwd}:${clean}`;
        let pending = this._fileExistCache.get(cacheKey);
        if (!pending) {
            const url = `/api/file/asset?path=${encodeURIComponent(clean)}&cwd=${encodeURIComponent(cwd)}`;
            pending = fetch(url, { method: 'HEAD' })
                .then((res) => res.ok)
                .catch(() => false);
            this._fileExistCache.set(cacheKey, pending);
        }
        return pending;
    }

    async openFilePreview(relPath: string): Promise<void> {
        const cleanPath = relPath.trim();
        const name = cleanPath.split(/[/\\]/).pop() || cleanPath;
        const activeTab = this.app.tabManager?.getActiveTab();
        const cwd = activeTab?.cwd || this.app.sessionsManager?.activeCWD || '';

        if (!this.isFileTargetValid(cleanPath)) {
            this.app.showToast(
                `Cannot preview ${name}: path is invalid or outside the workspace`,
                { type: 'error' },
            );
            return;
        }

        const exists = await this.checkFileExists(cleanPath, cwd);
        if (!exists) {
            this.app.showToast(
                `Cannot preview ${name}: file does not exist on this machine`,
                { type: 'error' },
            );
            return;
        }

        if (this.app.markdownManager?.previewFile) {
            void this.app.markdownManager.previewFile(
                { path: cleanPath, name },
                cwd,
            );
        } else {
            this.app.showToast(
                `Cannot preview ${name}: file preview not available`,
                { type: 'error' },
            );
        }
    }

    openDiffView(
        diffTarget: boolean | string | SyncDiffTarget | undefined,
        modalOverride?: boolean,
    ): void {
        const diffCtrl = this.app.diffController;
        if (!diffCtrl) return;

        const prefersModal =
            modalOverride ??
            (diffTarget === 'modal' ||
                (typeof diffTarget === 'object' &&
                    diffTarget !== null &&
                    diffTarget.modal === true));
        const commit = getSyncDiffCommit(diffTarget);
        if (commit !== undefined) {
            if (!/^[0-9a-f]{4,64}$/i.test(commit)) {
                this.app.showToast(
                    'Cannot show diff: invalid Git commit hash',
                    {
                        type: 'error',
                    },
                );
                return;
            }
            if (typeof diffCtrl.openCommitDiff !== 'function') {
                this.app.showToast('Commit diff viewer is unavailable', {
                    type: 'error',
                });
                return;
            }
            void diffCtrl
                .openCommitDiff(commit, prefersModal)
                .catch((e: Error) => {
                    this.app.showToast(
                        `Cannot show commit diff: ${e.message}`,
                        {
                            type: 'error',
                        },
                    );
                });
            return;
        }

        if (prefersModal && typeof diffCtrl.openRichDiffModal === 'function') {
            void diffCtrl.openRichDiffModal();
            return;
        }

        if (typeof diffCtrl.togglePanel === 'function') {
            diffCtrl.togglePanel(true);
        }
        const diffTabBtn = document.querySelector(
            '.diff-tab-btn[data-tab="diff"]',
        ) as HTMLElement | null;
        if (diffTabBtn) {
            diffTabBtn.click();
        } else if (typeof diffCtrl.refreshDiff === 'function') {
            diffCtrl.activeTab = 'diff';
            diffCtrl.refreshDiff(false);
        }
    }

    /** Paint synchronously on startup and backend switches, even offline. */
    restorePushes(store = this.app.getActiveStore?.()): void {
        let messages: SyncPushMessage[] | null = null;
        try {
            messages = parsePushMessages(
                JSON.parse(
                    store?.responses.get(PUSHES_ENDPOINT) ??
                        localStorage.getItem(serverKey(PUSH_CACHE_KEY)) ??
                        '[]',
                ),
            );
        } catch {
            /* A damaged or unavailable cache is not a UI error. */
        }
        this._pushExpanded.clear();
        this._pushRendered = '';
        this.renderPushes(messages ?? []);
        this.setPushError(false);
    }

    /** Read the owning Phi, not the remote board coordinator. */
    async refreshPushes(): Promise<void> {
        const scope = this.app.scope;
        if (scope?.aborted) return;
        if (this._pushRefresh && this._pushScope === scope) return;
        this._pushRefresh?.abort();
        const controller = new AbortController();
        this._pushRefresh = controller;
        this._pushScope = scope;
        const store = this.app.getActiveStore?.();
        const cacheKey = serverKey(PUSH_CACHE_KEY);
        const current = () =>
            !scope?.aborted &&
            !controller.signal.aborted &&
            this.app.scope === scope &&
            this.app.getActiveStore?.() === store;
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
            const res = await fetch(PUSHES_ENDPOINT, {
                signal: controller.signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            // A bare array, the same shape /api/sync/messages returns.
            const messages = parsePushMessages(await res.json());
            if (!messages)
                throw new Error('Unexpected addressed messages response');
            if (!current()) return;
            const cached = JSON.stringify(messages);
            store?.responses.set(PUSHES_ENDPOINT, cached);
            try {
                localStorage.setItem(cacheKey, cached);
            } catch {
                /* Storage can be full. */
            }
            this.renderPushes(messages);
            this.setPushError(false);
        } catch {
            if (
                !scope?.aborted &&
                this._pushRefresh === controller &&
                this.app.scope === scope
            ) {
                this.setPushError(true);
            }
        } finally {
            clearTimeout(timer);
            if (this._pushRefresh === controller) this._pushRefresh = null;
        }
    }

    private setPushError(failed: boolean): void {
        const note = this.pushSection?.querySelector('.sync-push-note');
        if (!note) return;
        note.textContent = failed
            ? this.pushList.children.length
                ? 'Refresh unavailable. Showing saved addressed messages.'
                : 'Refresh unavailable.'
            : '';
        note.classList.toggle('hidden', !failed);
        this.pushSection.classList.toggle(
            'hidden',
            !failed && this.pushList.children.length === 0,
        );
    }

    renderPushes(messages: SyncPushMessage[]): void {
        if (!this.pushSection || !this.pushList) return;
        const rendered = JSON.stringify(messages);
        if (rendered === this._pushRendered) return;
        this._pushRendered = rendered;
        this.pushSection.classList.toggle('hidden', messages.length === 0);
        const ids = new Set(messages.map((msg) => msg.message_id));
        for (const id of this._pushExpanded)
            if (!ids.has(id)) this._pushExpanded.delete(id);
        const focused =
            document.activeElement?.closest<HTMLDetailsElement>(
                '.sync-card-push',
            )?.dataset.messageId;
        const sorted = [...messages].sort(
            (a, b) =>
                b.updated_at_unix_ms - a.updated_at_unix_ms ||
                // The mesh stamps milliseconds, so two messages can share a
                // timestamp. The hub sequence is the publish order.
                (b.seq ?? 0) - (a.seq ?? 0),
        );
        const frag = document.createDocumentFragment();
        for (const msg of sorted) {
            const card = document.createElement('details');
            card.className = 'sync-card sync-card-push';
            card.dataset.messageId = msg.message_id;
            card.open = this._pushExpanded.has(msg.message_id);
            const when = new Date(msg.updated_at_unix_ms).toLocaleString();
            const sender = msg.sender || 'unknown';
            card.innerHTML = `
                <summary class="sync-push-summary">
                    <span class="sync-card-header">
                        <span class="sync-card-key" title="${this.escapeHtml(sender)}">${this.escapeHtml(displaySender(sender))} → ${this.escapeHtml(msg.recipient)}</span>
                        <span class="sync-push-disclosure" aria-hidden="true">▸</span>
                    </span>
                    <span class="sync-push-preview" aria-hidden="true">${this.escapeHtml(msg.value)}</span>
                    <span class="sync-card-footer">${this.escapeHtml(when)}${msg.truncated ? ' · body limited to 4 KiB' : ''}</span>
                </summary>
                <div class="sync-card-value">${this.escapeHtml(msg.value)}</div>
            `;
            card.addEventListener('toggle', () => {
                if (!card.isConnected) return;
                if (card.open) this._pushExpanded.add(msg.message_id);
                else this._pushExpanded.delete(msg.message_id);
            });
            frag.appendChild(card);
        }
        this.pushList.replaceChildren(frag);
        if (focused) {
            const card = [
                ...this.pushList.querySelectorAll<HTMLDetailsElement>(
                    '.sync-card-push',
                ),
            ].find((item) => item.dataset.messageId === focused);
            card?.querySelector('summary')?.focus({ preventScroll: true });
        }
    }

    renderMessages(messages: any[]): void {
        if (!messages || messages.length === 0) {
            this.messagesList.innerHTML =
                '<div class="sync-empty-state">No messages synced.</div>';
            return;
        }

        messages.sort(
            (a, b) =>
                (new Date(b.updated_at) as any) -
                (new Date(a.updated_at) as any),
        );

        this.messagesList.innerHTML = '';
        messages.forEach((msg) => {
            const card = document.createElement('div');
            card.className = 'sync-card';

            const localTime = new Date(msg.updated_at).toLocaleTimeString();
            const actionData = parseActionPayload(msg.value);
            const doneText =
                typeof actionData?.done === 'string'
                    ? actionData.done
                    : undefined;
            const displayKey = doneText === undefined ? msg.key : 'Done';
            if (doneText !== undefined) card.classList.add('sync-card-done');

            // Handle toast for recent action messages (< 15 seconds)
            if (actionData) {
                const msgTime = new Date(
                    msg.updated_at || msg.created_at,
                ).getTime();
                const isRecent =
                    !isNaN(msgTime) && Date.now() - msgTime < 15000;
                const updateKey = `${msg.key}:${msg.updated_at || msg.created_at}`;

                if (this._handledToastKeys.size > 200)
                    this._handledToastKeys.clear();

                if (
                    actionData.toast &&
                    isRecent &&
                    !this._handledToastKeys.has(updateKey)
                ) {
                    this._handledToastKeys.add(updateKey);
                    this.app.showToast(actionData.toast, { type: 'info' });
                }
            }

            const headerHtml = `
                <div class="sync-card-header">
                    <span class="sync-card-key" title="${this.escapeHtml(msg.key)}">${this.escapeHtml(displayKey)}</span>
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
            let descHtml = '';
            if (doneText !== undefined && actionData) {
                const summary = formatDoneSummary(doneText);
                const sourceMachine =
                    typeof actionData.machine === 'string' &&
                    actionData.machine.trim()
                        ? actionData.machine.trim().replace(/\s+/g, ' ')
                        : 'Unknown machine';
                bodyHtml = `
                    <div class="sync-done-card" role="status" aria-label="Done: ${this.escapeHtml(summary || 'No summary provided')} — ${this.escapeHtml(sourceMachine)}">
                        <span class="sync-done-icon" aria-hidden="true">✅</span>
                        <span class="sync-done-summary" title="${this.escapeHtml(doneText.trim())}">${this.escapeHtml(summary || 'No summary provided.')}</span>
                        <span class="sync-done-machine" title="From ${this.escapeHtml(sourceMachine)}">
                            <span aria-hidden="true">🖥️</span>
                            <span>${this.escapeHtml(sourceMachine)}</span>
                        </span>
                    </div>
                `;
            } else if (actionData) {
                const desc =
                    actionData.description ||
                    actionData.desc ||
                    actionData.text ||
                    '';
                descHtml = desc ? renderMarkdownSafe(desc) : '';
                const previewTarget =
                    actionData.preview || actionData.image || actionData.file;
                const rawUrl = actionData.url || actionData.link;
                const safeUrl =
                    rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : null;
                const previewName = previewTarget
                    ? previewTarget.split(/[/\\]/).pop() || previewTarget
                    : '';
                const rawJsonStr =
                    typeof msg.value === 'string'
                        ? msg.value
                        : JSON.stringify(msg.value, null, 2);

                const diffTarget = actionData.diff;
                let diffChipHtml = '';
                if (diffTarget) {
                    let fileCount = 0;
                    if (
                        typeof diffTarget === 'object' &&
                        diffTarget !== null &&
                        Array.isArray(diffTarget.files)
                    ) {
                        fileCount = diffTarget.files.length;
                    }
                    const commit = getSyncDiffCommit(diffTarget);
                    if (commit !== undefined) {
                        const shortHash = this.escapeHtml(commit.slice(0, 12));
                        diffChipHtml = `
                            <div class="sync-pretty-diff-row">
                                <button type="button" class="sync-chip-btn sync-pretty-diff-btn pretty-diff-btn" title="Open commit ${this.escapeHtml(commit)} in the pretty diff viewer">Open Pretty Diff · ${shortHash}</button>
                            </div>
                        `;
                    } else {
                        const label =
                            fileCount > 0
                                ? `Review Diff (${fileCount} files)`
                                : 'Review Diff';
                        diffChipHtml = `
                            <button type="button" class="sync-chip-btn sync-diff-btn" title="Review Git Diff">
                                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;"><circle cx="18" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><path d="M13 6h3a2 2 0 0 1 2 2v7"></path><line x1="6" y1="9" x2="6" y2="21"></line></svg>
                                <span>${this.escapeHtml(label)}</span>
                            </button>
                        `;
                    }
                }

                const checklist = Array.isArray(actionData.checklist)
                    ? actionData.checklist
                    : [];
                const checklistHtml =
                    checklist.length > 0
                        ? `
                    <div class="sync-checklist-group">
                        ${checklist
                            .map((item) => {
                                const label =
                                    typeof item === 'string'
                                        ? item
                                        : item.label ||
                                          item.text ||
                                          item.name ||
                                          '';
                                const isDone =
                                    typeof item === 'object' && item !== null
                                        ? Boolean(item.done || item.checked)
                                        : false;
                                return `
                                    <div class="sync-checklist-item${isDone ? ' is-done' : ''}">
                                        <input type="checkbox" class="sync-checklist-check" ${isDone ? 'checked' : ''} disabled />
                                        <span class="sync-checklist-label">${this.escapeHtml(label)}</span>
                                    </div>
                                `;
                            })
                            .join('')}
                    </div>`
                        : '';

                const chipsHtml =
                    previewTarget || safeUrl || diffTarget
                        ? `
                    <div class="sync-action-chips">
                        ${previewTarget ? `<span class="sync-preview-slot"></span>` : ''}
                        ${diffChipHtml}
                        ${
                            safeUrl
                                ? `<a href="${this.escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="sync-chip-btn sync-link-btn" title="Open ${this.escapeHtml(safeUrl)}">
                                    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                                    <span>Open Link</span>
                                </a>`
                                : ''
                        }
                    </div>`
                        : '';

                const actionsList = Array.isArray(actionData.actions)
                    ? actionData.actions
                    : [];
                const actionsHtml =
                    actionsList.length > 0
                        ? `
                    <div class="sync-action-btns">
                        ${actionsList
                            .map((act, idx) => {
                                const styleClass = act.style
                                    ? ` style-${this.escapeHtml(act.style)}`
                                    : '';
                                const label =
                                    act.label || act.name || 'Execute';
                                const cmd =
                                    act.command || act.cmd || act.input || '';
                                return `<button type="button" class="sync-action-cmd-btn${styleClass}" data-idx="${idx}" title="${this.escapeHtml(cmd)}">${this.escapeHtml(label)}</button>`;
                            })
                            .join('')}
                    </div>`
                        : '';

                bodyHtml = `
                    <div class="sync-action-card">
                        ${actionData.title ? `<div class="sync-action-title">${this.escapeHtml(actionData.title)}</div>` : ''}
                        ${descHtml ? `<div class="sync-action-desc md-rendered">${descHtml}</div>` : ''}
                        ${checklistHtml}
                        ${previewTarget ? `<div class="sync-image-preview-slot"></div>` : ''}
                        ${chipsHtml}
                        ${actionsHtml}
                        <div class="sync-raw-toggle" title="Toggle raw JSON value">
                            <span class="sync-raw-toggle-arrow">▸</span> <span>Raw JSON</span>
                        </div>
                        <div class="sync-card-value sync-action-raw hidden">${this.escapeHtml(rawJsonStr)}</div>
                    </div>
                `;
            } else {
                bodyHtml = `<div class="sync-card-value collapsed">${this.escapeHtml(msg.value)}</div>`;
            }

            card.innerHTML = `
                ${headerHtml}
                ${bodyHtml}
                <div class="sync-card-footer">${localTime}</div>
            `;

            // Wire standard value click if collapsed
            const standardValEl = card.querySelector(
                '.sync-card-value:not(.sync-action-raw)',
            );
            if (standardValEl) {
                standardValEl.addEventListener('click', () => {
                    standardValEl.classList.toggle('collapsed');
                });
            }

            // Wire action card listeners
            if (actionData) {
                const previewTarget =
                    actionData.preview || actionData.image || actionData.file;
                const previewName = previewTarget
                    ? previewTarget.split(/[/\\]/).pop() || previewTarget
                    : '';
                if (previewTarget) {
                    const previewSlot = card.querySelector(
                        '.sync-preview-slot',
                    ) as HTMLElement | null;
                    const imgSlot = card.querySelector(
                        '.sync-image-preview-slot',
                    ) as HTMLElement | null;
                    const isImage =
                        /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(
                            previewTarget,
                        );
                    const activeTab = this.app.tabManager?.getActiveTab();
                    const cwd =
                        activeTab?.cwd ||
                        this.app.sessionsManager?.activeCWD ||
                        '';

                    void this.checkFileExists(previewTarget, cwd).then(
                        (exists) => {
                            if (!exists) return;

                            if (previewSlot) {
                                previewSlot.innerHTML = `
                                    <button type="button" class="sync-chip-btn sync-preview-btn" title="Preview ${this.escapeHtml(previewTarget)}">
                                        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                                        <span>Preview ${this.escapeHtml(previewName)}</span>
                                    </button>
                                `;
                                previewSlot
                                    .querySelector('.sync-preview-btn')
                                    ?.addEventListener('click', (e) => {
                                        e.stopPropagation();
                                        void this.openFilePreview(
                                            previewTarget,
                                        );
                                    });
                            }

                            if (isImage && imgSlot) {
                                const assetUrl = `/api/file/asset?path=${encodeURIComponent(previewTarget.trim())}&cwd=${encodeURIComponent(cwd)}`;
                                imgSlot.innerHTML = `
                                    <div class="sync-image-card-preview" title="Click to preview ${this.escapeHtml(previewName)}">
                                        <img src="${this.escapeHtml(assetUrl)}" class="sync-image-thumb" alt="${this.escapeHtml(previewName)}" loading="lazy" />
                                    </div>
                                `;
                                imgSlot
                                    .querySelector('.sync-image-thumb')
                                    ?.addEventListener('click', (e) => {
                                        e.stopPropagation();
                                        void this.openFilePreview(
                                            previewTarget,
                                        );
                                    });
                            }
                        },
                    );
                }

                const rawToggle = card.querySelector('.sync-raw-toggle');
                const rawEl = card.querySelector('.sync-action-raw');
                const arrow = card.querySelector('.sync-raw-toggle-arrow');
                rawToggle?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (rawEl) {
                        const isHidden = rawEl.classList.toggle('hidden');
                        if (arrow) arrow.textContent = isHidden ? '▸' : '▾';
                    }
                });

                const actionBtns = card.querySelectorAll<HTMLButtonElement>(
                    '.sync-action-cmd-btn',
                );
                actionBtns.forEach((btn) => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const idx = Number(btn.dataset.idx);
                        const act = actionData.actions?.[idx];
                        if (!act) return;
                        const cmd = act.command || act.cmd || act.input || '';
                        if (!cmd) return;
                        if (act.stage) {
                            if (this.app.tabManager?.inputTextArea) {
                                this.app.tabManager._resetPiRecall?.({
                                    flush: true,
                                });
                                this.app.tabManager.inputTextArea.value = cmd;
                                this.app.tabManager.inputTextArea.focus({
                                    preventScroll: true,
                                });
                                this.app.showToast(
                                    `Staged: ${act.label || cmd}`,
                                    { type: 'info' },
                                );
                            }
                        } else {
                            if (this.app.tabManager?.sendRawInput) {
                                const payload =
                                    cmd.endsWith('\r') || cmd.endsWith('\n')
                                        ? cmd
                                        : `${cmd}\r`;
                                this.app.tabManager.sendRawInput(payload);
                                this.app.showToast(
                                    `Sent: ${act.label || cmd.trim()}`,
                                    { type: 'info' },
                                );
                            }
                        }
                    });
                });

                if (descHtml) {
                    highlightCodeIn(card);
                }

                if (actionData.diff) {
                    const commit = getSyncDiffCommit(actionData.diff);
                    const diffBtn = card.querySelector(
                        commit !== undefined
                            ? '.sync-pretty-diff-btn'
                            : '.sync-diff-btn',
                    );
                    diffBtn?.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.openDiffView(
                            actionData.diff,
                            commit !== undefined ? true : undefined,
                        );
                    });
                }
            }

            card.querySelector('.sync-edit-btn')?.addEventListener(
                'click',
                (e) => {
                    e.stopPropagation();
                    this.formContainer.classList.remove('hidden');
                    this.formKey.value = msg.key;
                    this.formKey.disabled = true;
                    this.formValue.value =
                        typeof msg.value === 'string'
                            ? msg.value
                            : JSON.stringify(msg.value, null, 2);
                    this.formValue.focus({ preventScroll: true });
                },
            );

            card.querySelector('.sync-del-btn')?.addEventListener(
                'click',
                async (e) => {
                    e.stopPropagation();
                    if (confirm(`Delete sync key "${msg.key}"?`)) {
                        try {
                            await this.fetchWithProxy(
                                `/api/sync/messages/${encodeURIComponent(msg.key)}`,
                                {
                                    method: 'DELETE',
                                },
                            );
                            this.refreshMessages();
                        } catch (err) {
                            this.app.showToast(
                                `Failed to delete: ${(err as Error).message}`,
                                { type: 'error' },
                            );
                        }
                    }
                },
            );

            this.messagesList.appendChild(card);
        });
    }

    async submitMessage(): Promise<void> {
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
        } catch (e) {
            this.app.showToast(
                `Failed to save message: ${(e as Error).message}`,
                { type: 'error' },
            );
        }
    }

    escapeHtml(str: string): string {
        return escapeHtmlUtil(str);
    }

    // Desktop-gated transient title signal: when a message's key or value
    // carries PHI_NOTIF / PHI_ALARM, write 'PHI_NOTIF <key>' (or
    // 'PHI_ALARM <key>') into document.title for the desktop shell to
    // observe through its existing page-title-updated event. The
    // terminal-activity title updater overwrites it on the next tick, so
    // the marker is transient by design; plain browser pages never set it
    // and the marker never leaves the page.
    signalDesktopAlert(messages: any[]): void {
        if (
            !navigator.userAgent.includes('Electron') &&
            new URLSearchParams(location.search).get('desktop') !== '1'
        ) {
            return;
        }
        let marker = '';
        let key = '';
        for (const msg of messages) {
            const k = String(msg && msg.key !== undefined ? msg.key : '');
            const v = String(msg && msg.value !== undefined ? msg.value : '');
            if (
                k.includes(SYNC_ALARM_MARKER) ||
                v.includes(SYNC_ALARM_MARKER)
            ) {
                marker = SYNC_ALARM_MARKER;
                key = k;
                break;
            }
            if (
                marker === '' &&
                (k.includes(SYNC_NOTIF_MARKER) || v.includes(SYNC_NOTIF_MARKER))
            ) {
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
    async clearAllMessages(): Promise<void> {
        let keys: string[] = [];
        try {
            const res = await this.fetchWithProxy('/api/sync/messages');
            const list = await res.json();
            if (Array.isArray(list))
                keys = list.map((m: any) => m.key).filter(Boolean);
        } catch (e) {
            this.app.showToast(
                `Failed to read messages: ${(e as Error).message}`,
                { type: 'error' },
            );
            return;
        }

        if (keys.length === 0) {
            this.app.showToast('No messages to clear', { type: 'info' });
            return;
        }

        if (
            !confirm(
                `Delete all ${keys.length} sync message${keys.length === 1 ? '' : 's'} from this coordinator?`,
            )
        ) {
            return;
        }

        // Run DELETEs sequentially so a partial failure doesn't strand
        // an outage (parallel fan-out would multiply the load on the
        // coordinator). Each failure is reported but doesn't abort the
        // rest — best-effort clear.
        let failed = 0;
        for (const k of keys) {
            try {
                await this.fetchWithProxy(
                    `/api/sync/messages/${encodeURIComponent(k)}`,
                    {
                        method: 'DELETE',
                    },
                );
            } catch (e) {
                console.error('[sync] clear delete failed for', k, e);
                failed += 1;
            }
        }
        await this.refreshMessages();
        if (failed > 0) {
            this.app.showToast(
                `Cleared; ${failed} delete${failed === 1 ? '' : 's'} failed (see console)`,
                { type: 'error' },
            );
        } else {
            this.app.showToast(
                `Cleared ${keys.length} message${keys.length === 1 ? '' : 's'}`,
                { type: 'success' },
            );
        }
    }
}
