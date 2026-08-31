import { escapeHtml, getLastFolderName as getLastFolderNameUtil, formatWorkspaceLabel as formatWorkspaceLabelUtil, worktreeGlyph, displayHostname, } from './util.js';
import { openPiRpcChatTab } from './chat-pi/tab.js';
import { createReviewTranscriptView } from './review-transcript.js';
export function normalizePath(p) {
    if (!p)
        return '';
    let normalized = p.replace(/\\/g, '/');
    if (normalized.endsWith('/') && normalized.length > 1) {
        normalized = normalized.slice(0, -1);
    }
    return normalized.toLowerCase();
}
export class SessionsManager {
    app;
    activeCoder;
    activeWorkspace;
    activeCWD;
    config;
    sessionList;
    newSessionBtn;
    workspaceSelect;
    addWorkspaceBtn;
    removeWorkspaceBtn;
    wsModal;
    wsModalClose;
    wsModalInput;
    wsModalSuggestions;
    wsModalCancelBtn;
    wsModalAddBtn;
    selectedSuggestionIndex;
    worktreeDirtyRequestId;
    _measureSpan = null;
    _contextMenu;
    _ctxDismissMousedown;
    _ctxDismissKey;
    constructor(app) {
        this.app = app;
        this.activeCoder = 'opencode';
        this.activeWorkspace = '';
        this.activeCWD = '';
        this.sessionList = document.getElementById('session-list');
        this.newSessionBtn = document.getElementById('new-session-btn');
        // Workspace Controls
        this.workspaceSelect = document.getElementById('workspace-select');
        this.addWorkspaceBtn = document.getElementById('add-workspace-btn');
        this.removeWorkspaceBtn = document.getElementById('remove-workspace-btn');
        // Workspace Modal Controls
        this.wsModal = document.getElementById('ws-modal');
        this.wsModalClose = document.getElementById('ws-modal-close');
        this.wsModalInput = document.getElementById('ws-modal-input');
        this.wsModalSuggestions = document.getElementById('ws-modal-suggestions');
        this.wsModalCancelBtn = document.getElementById('ws-modal-cancel-btn');
        this.wsModalAddBtn = document.getElementById('ws-modal-add-btn');
        this.selectedSuggestionIndex = -1;
        this.worktreeDirtyRequestId = 0;
        this._contextMenu = null;
        this._ctxDismissMousedown = null;
        this._ctxDismissKey = null;
        this.setupEventListeners();
    }
    setupEventListeners() {
        // Coder Selector Tabs
        document.querySelectorAll('.coder-tab').forEach((tab) => {
            tab.addEventListener('click', (e) => {
                document
                    .querySelector('.coder-tab.active')
                    .classList.remove('active');
                tab.classList.add('active');
                this.activeCoder = tab.getAttribute('data-coder');
                this.loadSessions();
            });
        });
        // New Session Trigger
        this.newSessionBtn.addEventListener('click', () => {
            this.spawnNewSession();
        });
        // Workspace Toggle and Auto-Width Formatter
        this.workspaceSelect.addEventListener('change', () => {
            this.activeWorkspace = this.workspaceSelect.value;
            localStorage.setItem('phi_last_chosen_project', this.activeWorkspace);
            this.updateWorkspaceSelectWidth();
            this.loadWorktrees();
            // Refresh diff on current active worktree (which is updated inside loadWorktrees)
            setTimeout(() => {
                this.app.diffController.refreshDiff();
                if (this.app.markdownManager) {
                    this.app.markdownManager.refreshFiles({ force: false });
                }
            }, 100);
        });
        window.addEventListener('resize', () => this.updateWorkspaceSelectWidth());
        this.addWorkspaceBtn.addEventListener('click', () => {
            this.openWorkspaceModal();
        });
        this.removeWorkspaceBtn.addEventListener('click', () => {
            if (confirm(`Remove workspace: ${this.activeWorkspace}?`)) {
                this.removeWorkspace(this.activeWorkspace);
            }
        });
        // Modal Action Bindings
        this.wsModalClose.addEventListener('click', () => this.closeWorkspaceModal());
        this.wsModalCancelBtn.addEventListener('click', () => this.closeWorkspaceModal());
        this.wsModalAddBtn.addEventListener('click', () => this.submitWorkspaceModal());
        this.wsModalInput.addEventListener('input', () => {
            this.fetchAutocompleteSuggestions();
        });
        this.wsModalInput.addEventListener('keydown', (e) => {
            const items = this.wsModalSuggestions.querySelectorAll('.suggestion-item');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.selectedSuggestionIndex =
                    (this.selectedSuggestionIndex + 1) % items.length;
                this.highlightSuggestion(items);
            }
            else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.selectedSuggestionIndex =
                    (this.selectedSuggestionIndex - 1 + items.length) %
                        items.length;
                this.highlightSuggestion(items);
            }
            else if (e.key === 'Enter') {
                e.preventDefault();
                if (this.selectedSuggestionIndex >= 0 &&
                    this.selectedSuggestionIndex < items.length) {
                    this.wsModalInput.value = items[this.selectedSuggestionIndex].innerText;
                    this.wsModalSuggestions.classList.add('hidden');
                    this.selectedSuggestionIndex = -1;
                }
                else {
                    this.submitWorkspaceModal();
                }
            }
            else if (e.key === 'Escape') {
                e.preventDefault();
                this.closeWorkspaceModal();
            }
        });
    }
    getLastFolderName(path) {
        return getLastFolderNameUtil(path);
    }
    formatWorkspaceLabel(ws, allWorkspaces) {
        return formatWorkspaceLabelUtil(ws, allWorkspaces);
    }
    updateWorkspaceSelectWidth() {
        if (!this.workspaceSelect)
            return;
        const idx = this.workspaceSelect.selectedIndex;
        const selectedOpt = idx >= 0 ? this.workspaceSelect.options[idx] : null;
        const text = selectedOpt
            ? selectedOpt.text || selectedOpt.innerText || selectedOpt.value
            : '';
        if (!text)
            return;
        if (!this._measureSpan) {
            this._measureSpan = document.createElement('span');
            this._measureSpan.style.position = 'absolute';
            this._measureSpan.style.visibility = 'hidden';
            this._measureSpan.style.height = '0';
            this._measureSpan.style.overflow = 'hidden';
            this._measureSpan.style.whiteSpace = 'pre';
            this._measureSpan.style.top = '-9999px';
            this._measureSpan.style.left = '-9999px';
            document.body.appendChild(this._measureSpan);
        }
        const style = window.getComputedStyle(this.workspaceSelect);
        this._measureSpan.style.fontFamily = style.fontFamily;
        this._measureSpan.style.fontSize = style.fontSize;
        this._measureSpan.style.fontWeight = style.fontWeight;
        this._measureSpan.style.letterSpacing = style.letterSpacing;
        this._measureSpan.textContent = text;
        const textWidth = this._measureSpan.getBoundingClientRect().width;
        const isMobile = window.innerWidth <= 768;
        const padding = isMobile ? 24 : 28;
        const calculatedWidth = Math.ceil(textWidth + padding);
        const minW = isMobile ? 50 : 60;
        const maxW = isMobile ? 130 : 280;
        const finalWidth = Math.max(minW, Math.min(maxW, calculatedWidth));
        this.workspaceSelect.style.width = `${finalWidth}px`;
        this.workspaceSelect.title =
            this.activeWorkspace || this.workspaceSelect.value || '';
        const emptyWs = document.getElementById('empty-workspace-path');
        if (emptyWs)
            emptyWs.textContent =
                this.activeWorkspace || this.workspaceSelect.value || 'Default';
    }
    async loadConfig() {
        try {
            const res = await fetch('/api/config');
            const data = await res.json();
            this.config = data;
            // Mirror the raw config onto the App: terminal.js reads
            // app.config.auto_reconnect to gate automatic reconnects.
            this.app.config = data;
            this.workspaceSelect.innerHTML = '';
            data.workspaces.forEach((ws) => {
                const opt = document.createElement('option');
                opt.value = ws;
                opt.innerText = this.formatWorkspaceLabel(ws, data.workspaces);
                opt.title = ws;
                this.workspaceSelect.appendChild(opt);
            });
            const lastChosen = localStorage.getItem('phi_last_chosen_project');
            if (lastChosen && data.workspaces.includes(lastChosen)) {
                this.activeWorkspace = lastChosen;
            }
            else {
                this.activeWorkspace =
                    data.active_cwd || data.workspaces[0] || '';
            }
            this.workspaceSelect.value = this.activeWorkspace;
            this.updateWorkspaceSelectWidth();
            if (data.theme_color) {
                // applyAccentTheme sets data-theme-color on <html>;
                // that's what the Settings modal reads on open to
                // pre-select the active swatch.
                this.app.applyAccentTheme(data.theme_color);
            }
            // Save the model presets list, quick commands, and terminal commands, then redraw current tab presets.
            this.app.modelPresets = data.model_presets || {};
            this.app.quickCommands = data.quick_commands || [];
            this.app.terminalCommands = data.terminal_commands || [];
            this.app.markdownDirs = data.markdown_dirs || [];
            this.app.useExistingTerminalTab = !!data.use_existing_terminal_tab;
            this.app.useHiddenTerminal = !!data.use_hidden_terminal;
            this.app.applyFastMode?.();
            // Ingest appearance settings and apply so the Settings
            // modal opens with the persisted values + the body shows
            // the chosen UI font / size immediately. terminalFontFamily
            // is read by new terminals (see terminal.js), so no live
            // re-apply needed here.
            let ls = null;
            try {
                ls = JSON.parse(localStorage.getItem('phi_appearance') || 'null');
            }
            catch {
                /* ignore */
            }
            this.app.uiFontFamily =
                (ls?.ui_font_family ?? data.ui_font_family) || '';
            this.app.uiFontSize =
                Number(ls?.ui_font_size ?? data.ui_font_size) || 0;
            this.app.terminalFontFamily =
                (ls?.terminal_font_family ??
                    data.terminal_font_family) || '';
            this.app.terminalFontSize =
                Number(ls?.terminal_font_size ?? data.terminal_font_size) || 0;
            this.app.customFontName = ls?.custom_font_name || '';
            this.app.applyUIFont?.();
            await this.app.loadCustomFont?.();
            const activeTab = this.app.tabManager.getActiveTab();
            if (activeTab) {
                this.app.tabManager.renderPresets(activeTab.coder);
            }
            if (data.hostname) {
                // app.hostname keeps the server's raw value; only the rendered
                // surfaces drop the macOS .local suffix.
                this.app.hostname = data.hostname;
                const shown = displayHostname(data.hostname);
                const hostEl = document.getElementById('hostname-display');
                if (hostEl) {
                    hostEl.innerText = shown;
                }
                // TabManager owns the composable Φ / ϕ / ● title grammar
                // and the matching header cursor. Re-render now that the
                // hostname half of the title is known.
                this.app.tabManager.updateDocumentTitle();
                const emptyHostEl = document.getElementById('empty-state-hostname');
                if (emptyHostEl) {
                    emptyHostEl.innerText = shown;
                }
            }
            await this.loadSessions();
        }
        catch (e) {
            console.error('[config] Failed to load workspace config:', e);
        }
    }
    async addWorkspace(path) {
        try {
            const res = await fetch('/api/config/workspaces', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path }),
            });
            if (res.ok) {
                await this.loadConfig();
                this.workspaceSelect.value = path;
                this.activeWorkspace = path;
                this.updateWorkspaceSelectWidth();
                this.loadWorktrees();
            }
        }
        catch (e) {
            console.error('[config] Failed to add workspace:', e);
        }
    }
    async removeWorkspace(path) {
        try {
            const res = await fetch('/api/config/workspaces', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path }),
            });
            if (res.ok) {
                await this.loadConfig();
                this.updateWorkspaceSelectWidth();
            }
        }
        catch (e) {
            console.error('[config] Failed to remove workspace:', e);
        }
    }
    async loadSessions() {
        await this.loadWorktrees();
    }
    switchCoder(coderId, skipReload = false) {
        // pi-rpc is a chat tab (eye icon) — never hijack the left Pi tab's
        // terminal view. The Pi coder stays as 'pi'.
        if (coderId === 'review' ||
            coderId === 'kanban' ||
            coderId === 'pi-rpc')
            return;
        if (this.activeCoder === coderId)
            return;
        this.activeCoder = coderId;
        document.querySelectorAll('.coder-tab').forEach((tab) => {
            if (tab.getAttribute('data-coder') === coderId) {
                tab.classList.add('active');
            }
            else {
                tab.classList.remove('active');
            }
        });
        if (!skipReload) {
            this.loadSessions();
        }
        // The Ctrl+Shift+X chip is rendered inside the presets-container row
        // by renderPresets() based on the *active tab's* coder, so it appears
        // exactly when the user is in a pi session — not just when the sidebar
        // coder-tab is set to pi. The keybinding itself remains global.
    }
    highlightActiveWorktree(cwdPath) {
        if (!cwdPath)
            return;
        document.querySelectorAll('.worktree-section').forEach((sec) => {
            const secPath = sec.getAttribute('data-worktree-path');
            if (normalizePath(secPath) === normalizePath(cwdPath)) {
                sec.classList.add('active');
                sec.classList.add('expanded');
                const container = sec.querySelector('.worktree-sessions-container');
                if (container &&
                    (container.innerHTML === '' ||
                        container.innerHTML.includes('Scanning sessions...'))) {
                    this.loadWorktreeSessions(secPath, container);
                }
            }
            else {
                sec.classList.remove('active');
                sec.classList.remove('expanded');
            }
        });
    }
    async loadWorktrees(targetCwd = null) {
        this.sessionList.innerHTML =
            '<div style="padding: 16px; color: var(--text-muted); font-size: 13px;">Scanning git worktrees...</div>';
        try {
            const res = await fetch(`/api/git/worktrees?cwd=${encodeURIComponent(this.activeWorkspace)}`);
            if (!res.ok)
                throw new Error('Failed to scan worktrees');
            const worktrees = await res.json();
            this.sessionList.innerHTML = '';
            if (!worktrees || worktrees.length === 0) {
                this.sessionList.innerHTML =
                    '<div style="padding: 16px; color: var(--text-muted); font-size: 13px; text-align: center;">No worktrees found</div>';
                return;
            }
            if (targetCwd) {
                this.activeCWD = targetCwd;
            }
            else {
                const hasCwd = worktrees.some((wt) => normalizePath(wt.path) ===
                    normalizePath(this.activeCWD));
                if (!hasCwd) {
                    const activeWT = worktrees.find((wt) => wt.active);
                    if (activeWT) {
                        this.activeCWD = activeWT.path;
                    }
                    else {
                        this.activeCWD = worktrees[0].path;
                    }
                }
            }
            localStorage.setItem('phi_last_chosen_project', this.activeWorkspace);
            // Append a faint "-- No workspace --" section for sessions with no cwd.
            // Only relevant for agy (others don't have unworkspaced sessions).
            // Rendered after real worktrees, collapsed by default.
            const appendNoWorkspaceSection = () => {
                if (this.activeCoder !== 'agy')
                    return;
                const nwSection = document.createElement('div');
                nwSection.className = 'worktree-section no-workspace-section';
                nwSection.setAttribute('data-worktree-path', '--no-workspace--');
                nwSection.innerHTML = `
                    <div class="worktree-header">
                        <svg class="icon chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                        <span class="worktree-name">— no workspace —</span>
                    </div>
                    <div class="worktree-sessions-container"></div>
                `;
                const header = nwSection.querySelector('.worktree-header');
                header.addEventListener('click', async () => {
                    const isExpanded = nwSection.classList.toggle('expanded');
                    if (isExpanded) {
                        await this.loadWorktreeSessions('--no-workspace--', nwSection.querySelector('.worktree-sessions-container'));
                    }
                });
                this.sessionList.appendChild(nwSection);
            };
            worktrees.forEach((wt) => {
                const wtSection = document.createElement('div');
                wtSection.className = 'worktree-section';
                wtSection.setAttribute('data-worktree-path', wt.path);
                const isCurrentCWD = normalizePath(wt.path) === normalizePath(this.activeCWD);
                if (wt.expanded || isCurrentCWD) {
                    wtSection.classList.add('expanded');
                }
                if (isCurrentCWD) {
                    wtSection.classList.add('active');
                }
                const parts = wt.path.split(/[/\\]/);
                const baseName = parts[parts.length - 1] || wt.path;
                // Same glyph as the tab uses for this path - lets the
                // user visually match tabs in the strip to their
                // worktree section in the left panel without reading
                // anything.
                const wtGlyph = worktreeGlyph(wt.path);
                // Cartouche (oval ring + bar) wraps the glyph when the
                // worktree has any live/open tab. Egyptian cartouches
                // historically framed royal names; reusing the motif
                // here marks the worktree as "live / inscribed."
                let hasLiveTab = false;
                if (this.app &&
                    this.app.tabManager &&
                    this.app.tabManager.tabs) {
                    const wtPathNorm = normalizePath(wt.path);
                    for (const t of this.app.tabManager.tabs.values()) {
                        if (t.cwd && normalizePath(t.cwd) === wtPathNorm) {
                            hasLiveTab = true;
                            break;
                        }
                    }
                }
                if (hasLiveTab) {
                    wtSection.classList.add('has-live-tab');
                }
                wtSection.innerHTML = `
                    <div class="worktree-header">
                        <svg class="icon chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                        <span class="worktree-glyph-cell"><span class="worktree-section-glyph" aria-hidden="true" title="${wt.path}">${wtGlyph}</span></span>
                        <span class="worktree-name" title="${wt.path}">${baseName}</span>
                        ${wt.branch ? `<span class="worktree-branch">[${wt.branch}]</span>` : ''}
                        <span class="worktree-dirty-indicator hidden" title="Unstaged changes" aria-hidden="true">★</span>
                    </div>
                    <div class="worktree-sessions-container">
                        <div class="scanning-sessions">Scanning sessions...</div>
                    </div>
                `;
                const header = wtSection.querySelector('.worktree-header');
                header.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const isExpanded = wtSection.classList.toggle('expanded');
                    document
                        .querySelectorAll('.worktree-section')
                        .forEach((sec) => {
                        sec.classList.remove('active');
                        if (sec !== wtSection) {
                            sec.classList.remove('expanded');
                        }
                    });
                    wtSection.classList.add('active');
                    this.activeCWD = wt.path;
                    this.app.diffController.refreshDiff();
                    const activeTab = this.app.tabManager.getActiveTab();
                    if (activeTab && activeTab.coder === this.activeCoder) {
                        this.highlightActiveSession(activeTab.sessionId);
                    }
                    await this.saveWorktreeState();
                    if (isExpanded) {
                        await this.loadWorktreeSessions(wt.path, wtSection.querySelector('.worktree-sessions-container'));
                    }
                });
                this.sessionList.appendChild(wtSection);
                if (wt.expanded || isCurrentCWD) {
                    this.loadWorktreeSessions(wt.path, wtSection.querySelector('.worktree-sessions-container'));
                }
            });
            appendNoWorkspaceSection();
            this.loadWorktreeDirtyStates(this.activeWorkspace, ++this.worktreeDirtyRequestId);
        }
        catch (e) {
            this.sessionList.innerHTML = `<div style="padding: 16px; color: var(--red); font-size: 13px;">Error scanning worktrees: ${escapeHtml(e.message)}</div>`;
        }
    }
    async loadWorktreeDirtyStates(workspace, requestId) {
        try {
            const res = await fetch(`/api/git/worktree-dirty?cwd=${encodeURIComponent(workspace)}`);
            if (!res.ok)
                throw new Error('Failed to load worktree dirty state');
            const dirtyStates = await res.json();
            if (requestId !== this.worktreeDirtyRequestId ||
                workspace !== this.activeWorkspace) {
                return;
            }
            this.sessionList
                .querySelectorAll('.worktree-section')
                .forEach((section) => {
                const path = section.getAttribute('data-worktree-path');
                if (!path || path === '--no-workspace--')
                    return;
                const indicator = section.querySelector('.worktree-dirty-indicator');
                if (!indicator)
                    return;
                if (dirtyStates[path]) {
                    indicator.classList.remove('hidden');
                }
                else {
                    indicator.classList.add('hidden');
                }
            });
        }
        catch (e) {
            if (requestId === this.worktreeDirtyRequestId) {
                console.error('[worktrees] Failed to load dirty state:', e);
            }
        }
    }
    async loadWorktreeSessions(wtPath, container) {
        container.innerHTML =
            '<div class="scanning-sessions">Scanning sessions...</div>';
        try {
            const requestCoder = this.activeCoder === 'pi-rpc' ? 'pi' : this.activeCoder;
            const res = await fetch(`/api/sessions?coder=${requestCoder}&cwd=${encodeURIComponent(wtPath)}`);
            if (!res.ok) {
                const errMsg = await res.text();
                throw new Error(errMsg || 'Failed to scan sessions');
            }
            const sessions = await res.json();
            container.innerHTML = '';
            if (!sessions || sessions.length === 0) {
                container.innerHTML =
                    '<div class="no-sessions-found">No sessions found</div>';
                return;
            }
            sessions.forEach((sess) => {
                const item = document.createElement('div');
                item.className = 'session-item';
                item.setAttribute('data-session-id', sess.id);
                item.setAttribute('data-worktree-path', wtPath);
                const timeStr = new Date(sess.time_updated).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                });
                let isRunning = false;
                let isIdleAlive = false;
                for (const t of this.app.tabManager.tabs.values()) {
                    if (t.sessionId === sess.id &&
                        t.coder === this.activeCoder &&
                        !t.isDead) {
                        // btop redraws the whole screen multiple times per
                        // second; its isBusy stays true forever. Skip it so
                        // the ankh/djed glyph doesn't pin on the row.
                        if (t.isBusy && !t.isBtop) {
                            isRunning = true;
                        }
                        else {
                            // Tab exists and is alive, but the watcher
                            // is just monitoring it (not generating
                            // output). Eye of Horus = "being watched."
                            isIdleAlive = true;
                        }
                        break;
                    }
                }
                // Three glyph states for a live session row:
                //   ☥  ankh     — actively running, recent (< 2 min)
                //   𓊽  djed    — running, stable (> 2 min)
                //   𓂀  eye     — alive but idle, watcher is monitoring
                //                   (no current output, tab still open)
                // No glyph when there's no live tab at all.
                let statusGlyph = '';
                let statusClass = '';
                if (isRunning) {
                    const ageMs = Date.now() - new Date(sess.time_updated).getTime();
                    const isStable = ageMs > 2 * 60 * 1000;
                    statusGlyph = isStable ? '𓊽' : '☥';
                    if (isStable)
                        statusClass = 'stable';
                }
                else if (isIdleAlive) {
                    statusGlyph = '𓂀';
                    statusClass = 'idle';
                }
                item.innerHTML = `
                    <div class="session-meta-top">
                        <span class="session-title">${sess.title}</span>
                        ${statusGlyph ? `<span class="session-dot ${statusClass}">${statusGlyph}</span>` : ''}
                    </div>
                    <span class="session-time">${timeStr}</span>
                    <div class="session-actions">
                        ${this.activeCoder === 'opencode' ||
                    this.activeCoder === 'pi'
                    ? `
                        <button class="session-action-btn review-btn" title="${this.activeCoder === 'pi' ? 'Open Pi RPC' : 'Review Transcript'}" aria-label="${this.activeCoder === 'pi' ? 'Open Pi RPC' : 'Review Transcript'}">
                            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                        </button>
                        `
                    : ''}
                        ${this.activeCoder === 'agy' ||
                    this.activeCoder === 'claude'
                    ? `
                        <button class="session-action-btn rename-btn" title="Rename Session">
                            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                        </button>
                        `
                    : ''}
                    </div>
                `;
                if (this.activeCoder === 'pi-rpc') {
                    item.addEventListener('click', (e) => {
                        if (e.target.closest('.session-action-btn'))
                            return;
                        openPiRpcChatTab(this.app.tabManager, sess.cwd ?? wtPath, sess.session_path, sess.title);
                    });
                }
                else {
                    if (sess.coder === 'pi' && this.activeCoder !== 'pi') {
                        const link = document.createElement('a');
                        link.href = '#';
                        link.className = 'session-action-btn';
                        link.textContent = 'Pi chat';
                        link.addEventListener('click', (ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            openPiRpcChatTab(this.app.tabManager, sess.cwd ?? '', sess.session_path, sess.title);
                        });
                        item.querySelector('.session-actions')?.appendChild(link);
                    }
                    item.addEventListener('click', (e) => {
                        if (e.target.closest('.session-action-btn'))
                            return;
                        this.launchSession(sess.id, sess.title);
                        const sidebar = document.getElementById('sidebar-panel');
                        if (sidebar) {
                            sidebar.classList.remove('drawer-open');
                        }
                    });
                    item.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this._showSessionContextMenu(e, item, sess);
                    });
                }
                if (this.activeCoder === 'opencode' ||
                    this.activeCoder === 'pi') {
                    const reviewBtn = item.querySelector('.review-btn');
                    if (reviewBtn) {
                        reviewBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            if (this.activeCoder === 'pi') {
                                openPiRpcChatTab(this.app.tabManager, sess.cwd ?? wtPath, sess.session_path, sess.title);
                            }
                            else {
                                this.openReviewTab(sess);
                            }
                            const sidebar = document.getElementById('sidebar-panel');
                            if (sidebar) {
                                sidebar.classList.remove('drawer-open');
                            }
                        });
                    }
                }
                if (this.activeCoder === 'agy' ||
                    this.activeCoder === 'claude') {
                    const renameBtn = item.querySelector('.rename-btn');
                    if (renameBtn) {
                        renameBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            this.openInlineRenamer(item, sess.id, sess.title);
                        });
                    }
                }
                container.appendChild(item);
            });
            const activeTab = this.app.tabManager.getActiveTab();
            if (activeTab && activeTab.coder === this.activeCoder) {
                this.highlightActiveSession(activeTab.sessionId);
            }
        }
        catch (e) {
            container.innerHTML = `<div class="error-sessions">Error: ${escapeHtml(e.message)}</div>`;
        }
    }
    async saveWorktreeState() {
        const expandedStates = {};
        document.querySelectorAll('.worktree-section').forEach((sec) => {
            const path = sec.getAttribute('data-worktree-path');
            expandedStates[path] = sec.classList.contains('expanded');
        });
        try {
            await fetch('/api/config/worktree-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspace: this.activeWorkspace,
                    active_worktree: this.activeCWD,
                    expanded: expandedStates,
                }),
            });
        }
        catch (e) {
            console.error('[worktree-state] Failed to save worktree state:', e);
        }
    }
    highlightActiveSession(sessionId) {
        document.querySelectorAll('.session-item').forEach((item) => {
            if (item.getAttribute('data-session-id') === sessionId) {
                item.classList.add('active');
            }
            else {
                item.classList.remove('active');
            }
        });
    }
    async spawnNewSession() {
        if (this.activeCoder === 'pi-rpc') {
            openPiRpcChatTab(this.app.tabManager, this.activeCWD);
            return;
        }
        try {
            let coderName = 'Shell';
            if (this.activeCoder === 'opencode')
                coderName = 'OpenCode';
            else if (this.activeCoder === 'claude')
                coderName = 'Claude';
            else if (this.activeCoder === 'pi')
                coderName = 'Pi';
            else if (this.activeCoder === 'agy')
                coderName = 'Agy';
            const title = `+ ${coderName}`;
            const res = await fetch('/api/terminals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    coder: this.activeCoder,
                    cwd: this.activeCWD,
                    session_id: '',
                    title: title,
                    workspace: this.activeWorkspace,
                }),
            });
            if (!res.ok) {
                const errText = await res.text().catch(() => 'unknown error');
                throw new Error(errText.trim() || 'Failed to spawn session');
            }
            const data = await res.json();
            this.app.tabManager.createTab(data.pane_id, data.session_id, title, this.activeCoder, this.activeWorkspace, this.activeCWD);
            this.loadSessions();
        }
        catch (e) {
            this.app.showToast(e.message, { type: 'error' });
        }
    }
    async launchSession(sessionId, title, extraArgs = []) {
        try {
            const res = await fetch('/api/terminals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    coder: this.activeCoder,
                    cwd: this.activeCWD,
                    session_id: sessionId,
                    extra_args: extraArgs,
                    title: title,
                    workspace: this.activeWorkspace,
                }),
            });
            if (!res.ok) {
                const errText = await res.text().catch(() => 'unknown error');
                throw new Error(errText.trim() || 'Failed to connect session');
            }
            const data = await res.json();
            this.app.tabManager.createTab(data.pane_id, data.session_id, title, this.activeCoder, this.activeWorkspace, this.activeCWD);
            this.highlightActiveSession(sessionId);
        }
        catch (e) {
            this.app.showToast(e.message, { type: 'error' });
        }
    }
    _showSessionContextMenu(e, item, sess) {
        this._dismissContextMenu();
        const menu = document.createElement('div');
        menu.className = 'session-ctx-menu';
        menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:9999`;
        const mkItem = (label, onClick) => {
            const el = document.createElement('div');
            el.className = 'session-ctx-item';
            el.textContent = label;
            el.addEventListener('click', () => {
                this._dismissContextMenu();
                onClick();
            });
            menu.appendChild(el);
        };
        mkItem('▶ Launch', () => {
            this.launchSession(sess.id, sess.title);
            const sidebar = document.getElementById('sidebar-panel');
            if (sidebar)
                sidebar.classList.remove('drawer-open');
        });
        mkItem('⚙ Launch with args…', () => {
            this._openArgsInput(item, sess);
        });
        if (this.activeCoder === 'agy' || this.activeCoder === 'claude') {
            mkItem('✏ Rename', () => {
                this.openInlineRenamer(item, sess.id, sess.title);
            });
        }
        document.body.appendChild(menu);
        this._contextMenu = menu;
        // Adjust if menu would overflow viewport bottom
        const rect = menu.getBoundingClientRect();
        if (rect.bottom > window.innerHeight) {
            menu.style.top = `${e.clientY - rect.height}px`;
        }
        this._ctxDismissMousedown = (ev) => {
            if (!menu.contains(ev.target))
                this._dismissContextMenu();
        };
        this._ctxDismissKey = (ev) => {
            if (ev.key === 'Escape')
                this._dismissContextMenu();
        };
        setTimeout(() => {
            document.addEventListener('mousedown', this._ctxDismissMousedown);
            document.addEventListener('keydown', this._ctxDismissKey);
        }, 0);
    }
    _dismissContextMenu() {
        if (this._contextMenu) {
            this._contextMenu.remove();
            this._contextMenu = null;
        }
        if (this._ctxDismissMousedown) {
            document.removeEventListener('mousedown', this._ctxDismissMousedown);
            this._ctxDismissMousedown = null;
        }
        if (this._ctxDismissKey) {
            document.removeEventListener('keydown', this._ctxDismissKey);
            this._ctxDismissKey = null;
        }
    }
    _openArgsInput(item, sess) {
        const existing = item.nextElementSibling;
        if (existing && existing.classList.contains('args-input-row'))
            existing.remove();
        const row = document.createElement('div');
        row.className = 'args-input-row';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'rename-input args-input';
        input.placeholder = 'extra args...';
        const hint = document.createElement('span');
        hint.className = 'args-input-hint';
        hint.textContent = '↵ launch · Esc cancel';
        row.appendChild(input);
        row.appendChild(hint);
        item.insertAdjacentElement('afterend', row);
        input.focus({ preventScroll: true });
        const submit = () => {
            const argsStr = input.value.trim();
            const extraArgs = argsStr
                ? argsStr.split(/\s+/).filter(Boolean)
                : [];
            row.remove();
            this.launchSession(sess.id, sess.title, extraArgs);
            const sidebar = document.getElementById('sidebar-panel');
            if (sidebar)
                sidebar.classList.remove('drawer-open');
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submit();
            }
            else if (e.key === 'Escape') {
                e.preventDefault();
                row.remove();
            }
        });
        input.addEventListener('blur', () => {
            setTimeout(() => {
                if (document.body.contains(row))
                    row.remove();
            }, 150);
        });
    }
    openInlineRenamer(itemEl, sessionId, currentTitle) {
        const titleEl = itemEl.querySelector('.session-title');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'rename-input';
        input.value = currentTitle;
        titleEl?.replaceWith(input);
        input.focus({ preventScroll: true });
        input.select();
        const saveRename = async () => {
            const newName = input.value.trim();
            if (newName && newName !== currentTitle) {
                try {
                    const res = await fetch('/api/session-meta', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: sessionId, name: newName }),
                    });
                    if (res.ok) {
                        this.loadSessions();
                    }
                    else {
                        throw new Error('Failed to save');
                    }
                }
                catch (e) {
                    alert(`Failed to rename: ${e.message}`);
                    this.loadSessions();
                }
            }
            else {
                this.loadSessions();
            }
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                saveRename();
            }
            else if (e.key === 'Escape') {
                this.loadSessions();
            }
        });
        input.addEventListener('blur', () => {
            saveRename();
        });
    }
    openWorkspaceModal() {
        this.wsModalInput.value = '';
        this.wsModalSuggestions.innerHTML = '';
        this.wsModalSuggestions.classList.add('hidden');
        this.selectedSuggestionIndex = -1;
        this.wsModal.classList.remove('hidden');
        setTimeout(() => this.wsModalInput.focus({ preventScroll: true }), 50);
    }
    closeWorkspaceModal() {
        this.wsModal.classList.add('hidden');
    }
    submitWorkspaceModal() {
        const path = this.wsModalInput.value.trim();
        if (path) {
            this.addWorkspace(path);
            this.closeWorkspaceModal();
        }
    }
    async fetchAutocompleteSuggestions() {
        const val = this.wsModalInput.value;
        if (!val) {
            this.wsModalSuggestions.innerHTML = '';
            this.wsModalSuggestions.classList.add('hidden');
            this.selectedSuggestionIndex = -1;
            return;
        }
        try {
            const res = await fetch(`/api/fs/autocomplete?path=${encodeURIComponent(val)}`);
            if (!res.ok)
                throw new Error();
            const suggestions = await res.json();
            this.wsModalSuggestions.innerHTML = '';
            this.selectedSuggestionIndex = -1;
            if (suggestions.length === 0) {
                this.wsModalSuggestions.classList.add('hidden');
                return;
            }
            this.wsModalSuggestions.classList.remove('hidden');
            suggestions.forEach((sugg, idx) => {
                const div = document.createElement('div');
                div.className = 'suggestion-item';
                div.innerText = sugg;
                div.addEventListener('click', () => {
                    this.wsModalInput.value = sugg;
                    this.wsModalSuggestions.classList.add('hidden');
                    this.selectedSuggestionIndex = -1;
                    this.wsModalInput.focus({ preventScroll: true });
                });
                this.wsModalSuggestions.appendChild(div);
            });
        }
        catch (e) {
            console.error('[autocomplete] Suggestion fetch error:', e);
        }
    }
    highlightSuggestion(items) {
        items.forEach((item, idx) => {
            if (idx === this.selectedSuggestionIndex) {
                item.classList.add('selected');
                item.scrollIntoView({ block: 'nearest' });
            }
            else {
                item.classList.remove('selected');
            }
        });
    }
    async openReviewTab(sess) {
        const paneId = 'review-' + sess.id;
        if (this.app.tabManager.tabs.has(paneId)) {
            this.app.tabManager.switchTab(paneId);
            return;
        }
        this.app.tabManager.createTab(paneId, sess.id, `Review: ${sess.title}`, 'review', this.activeWorkspace, sess.cwd);
        const activeTab = this.app.tabManager.tabs.get(paneId);
        if (!activeTab)
            return;
        const view = createReviewTranscriptView(activeTab.termContainer, {
            title: `Review: ${sess.title}`,
            coder: sess.coder,
            refresh: true,
            copyText: (text) => this.app.tabManager.copyTextRobustly(text, true),
        });
        const loadData = async () => {
            view.contentBody.innerHTML = `
                <div class="review-loading">
                    <span class="spinner"></span>
                    <span>Loading session transcript...</span>
                </div>
            `;
            try {
                const res = await fetch(`/api/session-transcript?coder=${sess.coder}&id=${sess.id}&cwd=${encodeURIComponent(sess.cwd || '')}`);
                if (!res.ok)
                    throw new Error('Failed to load transcript');
                const messages = await res.json();
                if (!Array.isArray(messages) || messages.length === 0) {
                    view.showEmpty();
                    return;
                }
                view.setMessages(messages.map((message) => ({
                    role: String(message.role || 'assistant'),
                    text: String(message.text || ''),
                })));
                setTimeout(() => {
                    view.transcript.scrollTop = view.transcript.scrollHeight;
                }, 150);
            }
            catch (e) {
                view.contentBody.innerHTML = `
                    <div class="review-error">
                        <h3>Error loading transcript</h3>
                        <p>${e.message}</p>
                    </div>
                `;
            }
        };
        view.refreshButton?.addEventListener('click', loadData);
        await loadData();
    }
}
