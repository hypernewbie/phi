/* Φ phi — Session Explorer & Workspace Controller */

export class SessionsManager {
    constructor(app) {
        this.app = app;
        this.activeCoder = 'opencode';
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
        
        this.setupEventListeners();
    }
    
    setupEventListeners() {
        // Coder Selector Tabs
        document.querySelectorAll('.coder-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                document.querySelector('.coder-tab.active').classList.remove('active');
                tab.classList.add('active');
                this.activeCoder = tab.getAttribute('data-coder');
                this.loadSessions();
            });
        });
        
        // New Session Trigger
        this.newSessionBtn.addEventListener('click', () => {
            this.spawnNewSession();
        });
        
        // Workspace Toggle
        this.workspaceSelect.addEventListener('change', () => {
            this.activeCWD = this.workspaceSelect.value;
            localStorage.setItem('phi_last_chosen_project', this.activeCWD);
            this.loadSessions();
            this.app.diffController.refreshDiff(); // Refresh diff panel on workspace change
        });
        
        this.addWorkspaceBtn.addEventListener('click', () => {
            this.openWorkspaceModal();
        });
        
        this.removeWorkspaceBtn.addEventListener('click', () => {
            if (confirm(`Remove workspace: ${this.activeCWD}?`)) {
                this.removeWorkspace(this.activeCWD);
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
                this.selectedSuggestionIndex = (this.selectedSuggestionIndex + 1) % items.length;
                this.highlightSuggestion(items);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.selectedSuggestionIndex = (this.selectedSuggestionIndex - 1 + items.length) % items.length;
                this.highlightSuggestion(items);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (this.selectedSuggestionIndex >= 0 && this.selectedSuggestionIndex < items.length) {
                    this.wsModalInput.value = items[this.selectedSuggestionIndex].innerText;
                    this.wsModalSuggestions.classList.add('hidden');
                    this.selectedSuggestionIndex = -1;
                } else {
                    this.submitWorkspaceModal();
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.closeWorkspaceModal();
            }
        });
    }
    
    async loadConfig() {
        try {
            const res = await fetch('/api/config');
            const data = await res.json();
            
            this.workspaceSelect.innerHTML = '';
            data.workspaces.forEach(ws => {
                const opt = document.createElement('option');
                opt.value = ws;
                opt.innerText = ws;
                this.workspaceSelect.appendChild(opt);
            });
            
            const lastChosen = localStorage.getItem('phi_last_chosen_project');
            if (lastChosen && data.workspaces.includes(lastChosen)) {
                this.activeCWD = lastChosen;
            } else {
                this.activeCWD = data.active_cwd || data.workspaces[0] || '';
            }
            this.workspaceSelect.value = this.activeCWD;
            
            if (data.theme_color) {
                this.app.accentColorSelect.value = data.theme_color;
                this.app.applyAccentTheme(data.theme_color);
            }

            if (data.hostname) {
                const hostEl = document.getElementById('hostname-display');
                if (hostEl) {
                    hostEl.innerText = ` — ${data.hostname}`;
                }
            }
            
            this.loadSessions();
        } catch (e) {
            console.error("[config] Failed to load workspace config:", e);
        }
    }
    
    async addWorkspace(path) {
        try {
            const res = await fetch('/api/config/workspaces', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path })
            });
            if (res.ok) {
                await this.loadConfig();
                this.workspaceSelect.value = path;
                this.activeCWD = path;
                localStorage.setItem('phi_last_chosen_project', path);
                this.loadSessions();
            }
        } catch (e) {
            console.error("[config] Failed to add workspace:", e);
        }
    }
    
    async removeWorkspace(path) {
        try {
            const res = await fetch('/api/config/workspaces', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path })
            });
            if (res.ok) {
                await this.loadConfig();
            }
        } catch (e) {
            console.error("[config] Failed to remove workspace:", e);
        }
    }
    
    async loadSessions() {
        this.sessionList.innerHTML = '<div style="padding: 16px; color: var(--text-muted); font-size: 13px;">Scanning sessions...</div>';
        try {
            const res = await fetch(`/api/sessions?coder=${this.activeCoder}&cwd=${encodeURIComponent(this.activeCWD)}`);
            if (!res.ok) throw new Error("Failed to scan");
            
            const sessions = await res.json();
            this.sessionList.innerHTML = '';
            
            if (!sessions || sessions.length === 0) {
                this.sessionList.innerHTML = '<div style="padding: 16px; color: var(--text-muted); font-size: 13px; text-align: center;">No sessions found</div>';
                return;
            }
            
            sessions.forEach(sess => {
                const item = document.createElement('div');
                item.className = 'session-item';
                item.setAttribute('data-session-id', sess.id);
                
                const timeStr = new Date(sess.time_updated).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
                
                // Check if actively running in TabManager
                let isRunning = false;
                for (const t of this.app.tabManager.tabs.values()) {
                    if (t.sessionId === sess.id && t.coder === this.activeCoder && !t.isDead) {
                        isRunning = true;
                        break;
                    }
                }
                
                item.innerHTML = `
                    <div class="session-meta-top">
                        <span class="session-title">${sess.title}</span>
                        ${isRunning ? '<span class="session-dot"></span>' : ''}
                    </div>
                    <span class="session-time">${timeStr}</span>
                    <div class="session-actions">
                        ${this.activeCoder === 'agy' ? `
                        <button class="session-action-btn rename-btn" title="Rename Session">
                            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                        </button>
                        ` : ''}
                    </div>
                `;
                
                // Launch / Resume Session Click Listener
                item.addEventListener('click', (e) => {
                    // Prevent launch trigger if clicking action buttons
                    if (e.target.closest('.session-action-btn')) return;
                    this.launchSession(sess.id, sess.title);
                    
                    // On mobile, automatically close the sidebar drawer
                    const sidebar = document.getElementById('sidebar-panel');
                    if (sidebar) {
                        sidebar.classList.remove('drawer-open');
                    }
                });
                
                // Inline rename logic for Agy
                if (this.activeCoder === 'agy') {
                    const renameBtn = item.querySelector('.rename-btn');
                    renameBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.openInlineRenamer(item, sess.id, sess.title);
                    });
                }
                
                this.sessionList.appendChild(item);
            });
            
            // Re-highlight active item if running
            const activeTab = this.app.tabManager.getActiveTab();
            if (activeTab && activeTab.coder === this.activeCoder) {
                this.highlightActiveSession(activeTab.sessionId);
            }
        } catch (e) {
            this.sessionList.innerHTML = `<div style="padding: 16px; color: var(--red); font-size: 13px;">Error scanning sessions: ${e.message}</div>`;
        }
    }
    
    highlightActiveSession(sessionId) {
        document.querySelectorAll('.session-item').forEach(item => {
            if (item.getAttribute('data-session-id') === sessionId) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });
    }
    
    async spawnNewSession() {
        // Spawns a fresh session (no sessionId passed to trigger empty launcher)
        try {
            const res = await fetch('/api/terminals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    coder: this.activeCoder,
                    cwd: this.activeCWD,
                    session_id: ''
                })
            });
            if (!res.ok) throw new Error("Failed to spawn session");
            
            const data = await res.json();
            let coderName = 'Shell';
            if (this.activeCoder === 'opencode') coderName = 'OpenCode';
            else if (this.activeCoder === 'claude') coderName = 'Claude';
            else if (this.activeCoder === 'agy') coderName = 'Agy';
            
            this.app.tabManager.createTab(data.pane_id, data.session_id, `+ ${coderName}`, this.activeCoder);
            
            // Refresh list
            this.loadSessions();
        } catch (e) {
            alert(`Failed to launch new session: ${e.message}`);
        }
    }
    
    async launchSession(sessionId, title) {
        try {
            const res = await fetch('/api/terminals', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    coder: this.activeCoder,
                    cwd: this.activeCWD,
                    session_id: sessionId
                })
            });
            if (!res.ok) throw new Error("Failed to connect session");
            
            const data = await res.json();
            this.app.tabManager.createTab(data.pane_id, data.session_id, title, this.activeCoder);
            
            // Mark active item
            this.highlightActiveSession(sessionId);
        } catch (e) {
            alert(`Failed to launch session: ${e.message}`);
        }
    }
    
    openInlineRenamer(itemEl, sessionId, currentTitle) {
        const titleEl = itemEl.querySelector('.session-title');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'rename-input';
        input.value = currentTitle;
        
        titleEl.replaceWith(input);
        input.focus();
        input.select();
        
        const saveRename = async () => {
            const newName = input.value.trim();
            if (newName && newName !== currentTitle) {
                try {
                    const res = await fetch('/api/session-meta', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: sessionId, name: newName })
                    });
                    if (res.ok) {
                        this.loadSessions();
                    } else {
                        throw new Error("Failed to save");
                    }
                } catch (e) {
                    alert(`Failed to rename: ${e.message}`);
                    this.loadSessions();
                }
            } else {
                this.loadSessions();
            }
        };
        
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                saveRename();
            } else if (e.key === 'Escape') {
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
        setTimeout(() => this.wsModalInput.focus(), 50);
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
            if (!res.ok) throw new Error();
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
                    this.wsModalInput.focus();
                });
                
                this.wsModalSuggestions.appendChild(div);
            });
        } catch (e) {
            console.error("[autocomplete] Suggestion fetch error:", e);
        }
    }

    highlightSuggestion(items) {
        items.forEach((item, idx) => {
            if (idx === this.selectedSuggestionIndex) {
                item.classList.add('selected');
                item.scrollIntoView({ block: 'nearest' });
            } else {
                item.classList.remove('selected');
            }
        });
    }
}
