import { escapeHtml as escapeHtmlUtil, priorityMeta, isDoneBucket as bucketIsDone, extractVikunjaError, safeHexColor } from './util.js';
import { buildFeatures, featureProgress, featureStats, featureTimeline, portfolioTimeline } from './kanban-features.js';
export class KanbanManager {
    app;
    activeDetailPanel;
    activeOverlay;
    escListener;
    taskCache;
    _dragActive;
    statsCharts;
    boardMode;
    showDoneFeatures;
    currentProjectId;
    currentViewId;
    buckets;
    constructor(app) {
        this.app = app;
        this.activeDetailPanel = null;
        this.activeOverlay = null;
        this.escListener = null;
        this.taskCache = {};
        this._dragActive = false;
        this.statsCharts = [];
        this.boardMode = 'board';
        this.showDoneFeatures = false;
    }
    async openBoard() {
        const paneId = 'kanban-board';
        const sessionId = 'kanban-board';
        const title = 'Kanban';
        const coder = 'kanban';
        const existing = this.app.tabManager.tabs.get(paneId);
        if (existing) {
            // BUG-4 fix: if the panel container was wiped (e.g. hot reload that
            // rebuilt the DOM but kept the tabs map), re-init it before showing.
            if (existing.termContainer && !existing.termContainer.querySelector('.kanban-toolbar, .kanban-login-form')) {
                this.initTabContainer(existing.termContainer);
            }
            this.app.tabManager.switchTab(paneId);
            return;
        }
        const activeWorkspace = this.app.sessionsManager.activeWorkspace || '';
        const activeCWD = this.app.sessionsManager.activeCWD || '';
        // BUG-2 fix: mark the tab as open so restoreTabsState reopens it on reload.
        localStorage.setItem('phi_kanban_open', '1');
        this.app.tabManager.createTab(paneId, sessionId, title, coder, activeWorkspace, activeCWD);
        const tab = this.app.tabManager.tabs.get(paneId);
        if (!tab)
            return;
        this.initTabContainer(tab.termContainer);
    }
    // BUG-3 fix: tear down everything kanban added to the page when the tab closes.
    // Without this the ESC keydown listener, modal overlays, drag state, and
    // detail panel can outlive the tab and fire on the wrong pane.
    cleanup() {
        if (this.escListener) {
            document.removeEventListener('keydown', this.escListener);
            this.escListener = null;
        }
        if (this.activeDetailPanel && this.activeDetailPanel.parentNode) {
            this.activeDetailPanel.parentNode.removeChild(this.activeDetailPanel);
        }
        this.activeDetailPanel = null;
        if (this.activeOverlay && this.activeOverlay.parentNode) {
            this.activeOverlay.parentNode.removeChild(this.activeOverlay);
        }
        this.activeOverlay = null;
        this._dragActive = false;
        this.destroyStatsCharts();
        localStorage.removeItem('phi_kanban_open');
    }
    async initTabContainer(container, isAutoRetry = false) {
        container.innerHTML = '';
        // Add kanban-panel without overwriting className — createTab →
        // switchTab already added `.active` to make the panel visible, and
        // blowing it away leaves the kanban invisible (display:none from the
        // base .kanban-panel rule). Bug was a permanent black screen on first
        // click; subsequent header-kanban-btn clicks hit the `activePaneId ===
        // paneId` early-return in switchTab, which never re-adds `.active`.
        container.classList.add('kanban-panel');
        const token = sessionStorage.getItem('vikunja_token');
        if (token) {
            await this.loadAndRenderBoard(container, isAutoRetry);
            return;
        }
        this.renderLoading(container, 'Checking saved Kanban credentials...');
        const savedPw = await this.getSavedVaultPassword();
        const urlVal = (localStorage.getItem('vikunja_url') || 'http://charon:3456').replace(/\/$/, '');
        const userVal = localStorage.getItem('vikunja_username');
        let autologinError = null;
        if (savedPw && userVal && urlVal) {
            this.renderLoading(container, 'Logging in to Vikunja...');
            try {
                const loginToken = await this.attemptLogin(urlVal, userVal, savedPw);
                sessionStorage.setItem('vikunja_token', loginToken);
                await this.loadAndRenderBoard(container, isAutoRetry);
                return;
            }
            catch (err) {
                console.error("Headless autologin failed:", err);
                autologinError = err;
            }
        }
        // If no saved credentials or autologin failed, render login form prefilled
        this.renderLoginForm(container);
        if (savedPw) {
            const pwInput = container.querySelector('#kanban-password-input');
            const chkInput = container.querySelector('#kanban-remember-input');
            if (pwInput)
                pwInput.value = savedPw;
            if (chkInput)
                chkInput.checked = true;
        }
        if (autologinError) {
            const errorEl = container.querySelector('#kanban-login-error');
            if (errorEl) {
                errorEl.textContent = `Saved login failed: ${autologinError.message}`;
                errorEl.classList.remove('hidden');
            }
        }
    }
    renderLoading(container, message) {
        container.innerHTML = `
            <div class="kanban-loading-wrapper">
                <div class="spinner-ring"></div>
                <div class="loader-text">${message}</div>
            </div>
        `;
    }
    async getSavedVaultPassword() {
        try {
            const res = await fetch('/api/config/kanban-vault');
            if (!res.ok)
                return null;
            const data = await res.json();
            return data.password || null;
        }
        catch (e) {
            console.error("Failed to check kanban vault:", e);
            return null;
        }
    }
    async attemptLogin(url, username, password) {
        const proxyUrl = `/api/proxy?url=${encodeURIComponent(url + '/api/v1/login')}`;
        const res = await fetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(errText || `Login failed with status ${res.status}`);
        }
        const data = await res.json();
        if (!data.token) {
            throw new Error('No token returned from server');
        }
        return data.token;
    }
    renderLoginForm(container) {
        container.innerHTML = `
            <div class="kanban-login-container">
                <div class="kanban-login-card">
                    <h2>🔌 Connect Vikunja Board</h2>
                    <p class="kanban-login-desc">Enter your Vikunja instance URL and login credentials to view your boards.</p>
                    <div class="form-group">
                        <label for="kanban-url-input">Server URL</label>
                        <input type="text" id="kanban-url-input" value="${localStorage.getItem('vikunja_url') || 'http://charon:3456'}" placeholder="http://localhost:3456">
                    </div>
                    <div class="form-group">
                        <label for="kanban-username-input">Username</label>
                        <input type="text" id="kanban-username-input" value="${localStorage.getItem('vikunja_username') || ''}" placeholder="username">
                    </div>
                    <div class="form-group">
                        <label for="kanban-password-input">Password</label>
                        <input type="password" id="kanban-password-input" placeholder="password">
                    </div>
                    <div class="form-group" style="display: flex; flex-direction: column; gap: 4px; margin-top: 4px;">
                        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; font-weight: normal; color: var(--text-primary);">
                            <input type="checkbox" id="kanban-remember-input" style="cursor: pointer;">
                            Remember Password
                        </label>
                        <span style="font-size: 11px; color: var(--text-muted);">⚠️ Saved locally in backend config via binary-stored AES key.</span>
                    </div>
                    <button id="kanban-login-btn" class="btn btn-accent" style="margin-top: 12px;">Connect</button>
                    <div id="kanban-login-error" class="login-error-msg hidden"></div>
                </div>
            </div>
        `;
        const loginBtn = container.querySelector('#kanban-login-btn');
        loginBtn.addEventListener('click', async () => {
            const urlInput = container.querySelector('#kanban-url-input').value.trim().replace(/\/$/, '');
            const usernameInput = container.querySelector('#kanban-username-input').value.trim();
            const passwordInput = container.querySelector('#kanban-password-input').value;
            const rememberInput = container.querySelector('#kanban-remember-input')?.checked;
            const errorEl = container.querySelector('#kanban-login-error');
            if (!urlInput || !usernameInput || !passwordInput) {
                errorEl.textContent = 'All fields are required.';
                errorEl.classList.remove('hidden');
                return;
            }
            loginBtn.disabled = true;
            loginBtn.textContent = 'Connecting...';
            errorEl.classList.add('hidden');
            try {
                const token = await this.attemptLogin(urlInput, usernameInput, passwordInput);
                sessionStorage.setItem('vikunja_token', token);
                localStorage.setItem('vikunja_url', urlInput);
                localStorage.setItem('vikunja_username', usernameInput);
                // Save or clear vault password
                if (rememberInput) {
                    fetch('/api/config/kanban-vault', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password: passwordInput })
                    }).catch(e => console.error("Vault save error:", e));
                }
                else {
                    fetch('/api/config/kanban-vault', { method: 'DELETE' }).catch(e => console.error("Vault delete error:", e));
                }
                await this.loadAndRenderBoard(container);
            }
            catch (err) {
                errorEl.textContent = `Error: ${err.message}`;
                errorEl.classList.remove('hidden');
                loginBtn.disabled = false;
                loginBtn.textContent = 'Connect';
            }
        });
    }
    async loadAndRenderBoard(container, isAutoRetry = false) {
        container.innerHTML = `
            <div class="kanban-loading-wrapper">
                <div class="spinner-ring"></div>
                <div class="loader-text">Loading Kanban data...</div>
            </div>
        `;
        try {
            // Fetch projects
            const projects = await this.apiGet('/projects?per_page=500');
            if (!projects || projects.length === 0) {
                container.innerHTML = `
                    <div class="kanban-empty-wrapper">
                        <h3>No projects found</h3>
                        <p>Create a project in Vikunja to get started.</p>
                        <button id="kanban-retry-btn" class="btn btn-accent">Retry</button>
                    </div>
                `;
                container.querySelector('#kanban-retry-btn').addEventListener('click', () => this.initTabContainer(container));
                return;
            }
            let selectedProjectId = localStorage.getItem('vikunja_selected_project');
            let currentProject = projects.find((p) => p.id == selectedProjectId);
            if (!currentProject) {
                currentProject = projects[0];
                selectedProjectId = currentProject.id;
            }
            // Fetch views for project
            const views = await this.apiGet(`/projects/${selectedProjectId}/views?per_page=500`);
            const kanbanView = views ? views.find((v) => v.view_kind === 'kanban') : null;
            if (!kanbanView) {
                this.renderBoardLayout(container, projects, currentProject, null, []);
                return;
            }
            // Keep the bucket endpoint unexpanded. Vikunja's `subtasks`
            // expansion changes its Kanban-view response, which means cards
            // can lose the authoritative bucket state Phi needs to render
            // Todo / Review / Done correctly. Fetch hierarchy separately and
            // merge only its relation map onto the unmodified board tasks.
            const bucketsWithTasks = await this.apiGet(`/projects/${selectedProjectId}/views/${kanbanView.id}/tasks?per_page=500`);
            let projectTasks = [];
            try {
                projectTasks = await this.apiGet(`/projects/${selectedProjectId}/tasks?per_page=500&expand=subtasks`) || [];
            }
            catch (err) {
                // Features are additive. A hierarchy fetch must never make the
                // regular board unavailable when an older Vikunja lacks it.
                console.warn('Failed to load Kanban subtask hierarchy:', err);
            }
            const projectTasksById = new Map(projectTasks.map(task => [String(task.id), task]));
            // Rebuild taskCache
            this.taskCache = {};
            // Cache the active view id and project id on the manager so later
            // bucket-move calls can hit Vikunja's dedicated
            //   POST /projects/{projectID}/views/{viewID}/buckets/{bucketID}/tasks
            // endpoint (a plain task update doesn't relocate it).
            this.currentProjectId = parseInt(selectedProjectId, 10);
            this.currentViewId = parseInt(kanbanView.id, 10);
            this.buckets = bucketsWithTasks || [];
            if (bucketsWithTasks) {
                bucketsWithTasks.forEach((bucket) => {
                    if (bucket.tasks) {
                        bucket.tasks = bucket.tasks.map((boardTask) => {
                            const hierarchyTask = projectTasksById.get(String(boardTask.id));
                            const task = hierarchyTask?.related_tasks
                                ? { ...boardTask, related_tasks: hierarchyTask.related_tasks }
                                : boardTask;
                            this.taskCache[task.id] = task;
                            return task;
                        });
                    }
                });
            }
            // A feature parent may not itself be in a bucket. Retain it for
            // the Features view without changing what the board renders.
            projectTasks.forEach(task => {
                if (task?.id != null && !this.taskCache[task.id])
                    this.taskCache[task.id] = task;
            });
            this.renderBoardLayout(container, projects, currentProject, kanbanView, bucketsWithTasks);
        }
        catch (err) {
            console.error('Kanban Load Error:', err);
            if (err.message.includes('Session expired') && !isAutoRetry) {
                console.log("Session expired. Attempting automatic headless reconnect...");
                sessionStorage.removeItem('vikunja_token');
                this.initTabContainer(container, true);
                return;
            }
            container.innerHTML = `
                <div class="kanban-error-wrapper">
                    <h3>Failed to load board</h3>
                    <p>${err.message}</p>
                    <div class="error-actions">
                        <button id="kanban-retry-btn" class="btn btn-primary">Retry</button>
                        <button id="kanban-reconnect-btn" class="btn btn-accent">Reconnect Server</button>
                    </div>
                </div>
            `;
            container.querySelector('#kanban-retry-btn').addEventListener('click', () => this.loadAndRenderBoard(container, isAutoRetry));
            container.querySelector('#kanban-reconnect-btn').addEventListener('click', () => {
                sessionStorage.removeItem('vikunja_token');
                this.initTabContainer(container);
            });
        }
    }
    renderBoardLayout(container, projects, currentProject, kanbanView, bucketsWithTasks) {
        this.destroyStatsCharts();
        let boardContentHtml = '';
        if (!kanbanView) {
            boardContentHtml = `
                <div class="kanban-no-view-wrapper">
                    <h3>No Kanban View Available</h3>
                    <p>This project does not have a Kanban view configured in Vikunja.</p>
                </div>
            `;
        }
        else if (this.boardMode === 'features') {
            boardContentHtml = this.renderFeaturesView();
        }
        else if (this.boardMode === 'stats') {
            boardContentHtml = this.renderStatsView();
        }
        else if (!bucketsWithTasks || bucketsWithTasks.length === 0) {
            boardContentHtml = `
                <div class="kanban-no-view-wrapper">
                    <h3>No Buckets Found</h3>
                    <p>There are no buckets configured in this Kanban view.</p>
                </div>
            `;
        }
        else {
            boardContentHtml = `
                <div class="kanban-columns-wrapper">
                    ${bucketsWithTasks.map(bucket => this.renderColumn(bucket)).join('')}
                </div>
            `;
        }
        container.innerHTML = `
            <div class="kanban-board">
                <div class="kanban-toolbar">
                    <div class="toolbar-left">
                        <span class="toolbar-label">Project:</span>
                        <select id="kanban-project-select" class="kanban-select">
                            ${projects.map((p) => `<option value="${p.id}" ${p.id == currentProject.id ? 'selected' : ''}>${this.escapeHtml(p.title)}</option>`).join('')}
                        </select>
                        <div class="kanban-view-switch" role="group" aria-label="Kanban view">
                            <button class="kanban-view-btn ${this.boardMode === 'board' ? 'active' : ''}" data-kanban-mode="board">Board</button>
                            <button class="kanban-view-btn ${this.boardMode === 'features' ? 'active' : ''}" data-kanban-mode="features">Features</button>
                            <button class="kanban-view-btn ${this.boardMode === 'stats' ? 'active' : ''}" data-kanban-mode="stats">Stats</button>
                        </div>
                        ${this.boardMode !== 'stats' ? `
                            <div class="kanban-search-wrapper" style="margin-left: 8px;">
                                <input type="text" id="kanban-search-input" class="kanban-search-input" placeholder="Filter ${this.boardMode === 'features' ? 'features' : 'tasks'}..." />
                            </div>
                        ` : ''}
                        <button id="kanban-refresh-btn" class="toolbar-btn" title="Refresh Board">
                            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="23 4 23 10 17 10"></polyline>
                                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                            </svg>
                        </button>
                        ${this.boardMode === 'board' ? `
                            <button id="kanban-add-column-btn" class="toolbar-btn" title="Add Column">
                                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <rect x="3" y="4" width="18" height="16" rx="2"></rect>
                                    <line x1="12" y1="10" x2="12" y2="14"></line>
                                    <line x1="10" y1="12" x2="14" y2="12"></line>
                                </svg>
                                <span>Column</span>
                            </button>
                        ` : ''}
                    </div>
                    <div class="toolbar-right">
                        <button id="kanban-disconnect-btn" class="toolbar-btn text-danger" title="Disconnect Server">
                            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
                                <line x1="12" y1="2" x2="12" y2="12"></line>
                            </svg>
                            <span>Disconnect</span>
                        </button>
                    </div>
                </div>
                <div class="kanban-content">
                    ${boardContentHtml}
                </div>
            </div>
        `;
        // Attach listeners
        container.querySelectorAll('.kanban-view-btn').forEach((button) => {
            button.addEventListener('click', () => {
                const mode = button.dataset.kanbanMode;
                this.boardMode = mode === 'features' || mode === 'stats' ? mode : 'board';
                this.renderBoardLayout(container, projects, currentProject, kanbanView, bucketsWithTasks);
            });
        });
        const projectSelect = container.querySelector('#kanban-project-select');
        projectSelect.addEventListener('change', () => {
            localStorage.setItem('vikunja_selected_project', projectSelect.value);
            this.loadAndRenderBoard(container);
        });
        container.querySelector('#kanban-refresh-btn').addEventListener('click', () => {
            this.loadAndRenderBoard(container);
        });
        // Add Column toolbar button. Prompts for a name; re-loads on success.
        const addColBtn = container.querySelector('#kanban-add-column-btn');
        if (addColBtn) {
            addColBtn.addEventListener('click', async () => {
                const title = (prompt('New column name:') || '').trim();
                if (!title)
                    return;
                try {
                    await this.createBucket(title, container);
                }
                catch (err) {
                    this.app.showToast(`Failed to add column: ${err.message}`, { type: 'error', title: 'Kanban' });
                }
            });
        }
        // Column rename: click the title to edit inline. Blur or Enter saves,
        // Escape cancels. Reverts to the original text if the input is empty
        // or unchanged.
        container.querySelectorAll('.column-title').forEach((titleEl) => {
            titleEl.addEventListener('click', () => {
                const id = titleEl.dataset.bucketId;
                const current = titleEl.textContent;
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'column-title-edit';
                input.value = current;
                input.style.width = '100%';
                input.style.font = 'inherit';
                input.style.color = 'inherit';
                input.style.background = 'rgba(255,255,255,0.04)';
                input.style.border = '1px solid var(--accent-soft, #444)';
                input.style.borderRadius = '3px';
                input.style.padding = '1px 4px';
                titleEl.replaceWith(input);
                input.focus({ preventScroll: true });
                input.select();
                let finished = false;
                const finish = async (save) => {
                    if (finished)
                        return;
                    finished = true;
                    const next = save ? input.value.trim() : current;
                    if (save && next && next !== current) {
                        try {
                            await this.updateBucket(id, next, container);
                        }
                        catch (err) {
                            this.app.showToast(`Rename failed: ${err.message}`, { type: 'error', title: 'Kanban' });
                            // Restore the original title without a full reload.
                            input.replaceWith(titleEl);
                            titleEl.textContent = current;
                        }
                    }
                    else {
                        // No change or cancel: restore the title span.
                        input.replaceWith(titleEl);
                        titleEl.textContent = current;
                    }
                };
                input.addEventListener('blur', () => finish(true));
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        input.blur();
                    }
                    else if (e.key === 'Escape') {
                        e.preventDefault();
                        finish(false);
                    }
                });
            });
        });
        // Column edit + delete icons next to each column header.
        container.querySelectorAll('.column-edit-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.bucketId;
                const titleEl = container.querySelector(`.column-title[data-bucket-id="${id}"]`);
                if (titleEl)
                    titleEl.click();
            });
        });
        container.querySelectorAll('.column-delete-btn').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.dataset.bucketId;
                const titleEl = container.querySelector(`.column-title[data-bucket-id="${id}"]`);
                const name = titleEl ? titleEl.textContent : `#${id}`;
                if (!confirm(`Delete column "${name}" and all its tasks? This cannot be undone.`))
                    return;
                try {
                    await this.deleteBucket(id, container);
                }
                catch (err) {
                    this.app.showToast(`Failed to delete column: ${err.message}`, { type: 'error', title: 'Kanban' });
                }
            });
        });
        // Inline card delete (the X button revealed on hover). Confirms, then
        // calls deleteTask which clears the cache and reloads the board.
        container.querySelectorAll('.kanban-card-delete-btn').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.dataset.taskId;
                const task = this.taskCache[id];
                const label = task ? `"${task.title}"` : `#${id}`;
                if (!confirm(`Delete task ${label}? This cannot be undone.`))
                    return;
                try {
                    await this.deleteTask(id, container);
                }
                catch (err) {
                    this.app.showToast(`Failed to delete task: ${err.message}`, { type: 'error', title: 'Kanban' });
                }
            });
        });
        container.querySelector('#kanban-disconnect-btn').addEventListener('click', () => {
            sessionStorage.removeItem('vikunja_token');
            fetch('/api/config/kanban-vault', { method: 'DELETE' }).catch(e => console.error("Vault delete error:", e));
            this.initTabContainer(container);
        });
        // Fuzzy Search Filter Listener
        const searchInput = container.querySelector('#kanban-search-input');
        if (searchInput) {
            let debounceTimer = null;
            searchInput.addEventListener('input', () => {
                if (debounceTimer)
                    clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    const query = searchInput.value.trim().toLowerCase();
                    const cards = container.querySelectorAll('.kanban-card, .kanban-feature-row');
                    cards.forEach(card => {
                        const taskId = card.dataset.taskId;
                        const task = this.taskCache[taskId];
                        if (!query) {
                            card.classList.remove('hidden-by-filter');
                            return;
                        }
                        let match = false;
                        if (task) {
                            if (task.title && task.title.toLowerCase().includes(query))
                                match = true;
                            if (task.identifier && task.identifier.toLowerCase().includes(query))
                                match = true;
                            if (task.labels && task.labels.some((l) => l.title && l.title.toLowerCase().includes(query)))
                                match = true;
                        }
                        if (match) {
                            card.classList.remove('hidden-by-filter');
                        }
                        else {
                            card.classList.add('hidden-by-filter');
                        }
                    });
                }, 150);
            });
        }
        // Add Task Button Listeners
        const addWrapperSetup = () => {
            const addBtns = container.querySelectorAll('.kanban-add-task-btn');
            addBtns.forEach(btn => {
                btn.onclick = (e) => {
                    const wrapper = e.target.closest('.kanban-add-task-wrapper');
                    const bucketId = wrapper.dataset.bucketId;
                    wrapper.innerHTML = `
                        <input type="text" class="kanban-quick-add-input" placeholder="Task title... (Enter to save)" />
                    `;
                    const input = wrapper.querySelector('.kanban-quick-add-input');
                    input.focus({ preventScroll: true });
                    const reset = () => {
                        wrapper.innerHTML = `<button class="kanban-add-task-btn">+ Add Task</button>`;
                        addWrapperSetup();
                    };
                    input.addEventListener('keydown', async (ev) => {
                        if (ev.key === 'Escape') {
                            reset();
                        }
                        else if (ev.key === 'Enter') {
                            const val = input.value.trim();
                            if (!val) {
                                reset();
                                return;
                            }
                            input.disabled = true;
                            try {
                                const selectedProjectId = localStorage.getItem('vikunja_selected_project');
                                // Vikunja's create-task endpoint is PUT (not POST) and
                                // requires project_id in the body alongside title
                                // and bucket_id. Path is /projects/{id}/tasks.
                                const pid = parseInt(selectedProjectId, 10);
                                await this.apiPut(`/projects/${pid}/tasks`, {
                                    title: val,
                                    project_id: pid,
                                    bucket_id: parseInt(bucketId, 10)
                                });
                                await this.loadAndRenderBoard(container);
                            }
                            catch (err) {
                                alert(`Failed to create task: ${err.message}`);
                                reset();
                            }
                        }
                    });
                    input.addEventListener('blur', () => {
                        setTimeout(() => {
                            if (document.activeElement !== input && !input.value.trim())
                                reset();
                        }, 150);
                    });
                };
            });
        };
        addWrapperSetup();
        const showDoneFeaturesButton = container.querySelector('#kanban-show-done-features-btn');
        if (showDoneFeaturesButton) {
            showDoneFeaturesButton.addEventListener('click', () => {
                this.showDoneFeatures = !this.showDoneFeatures;
                this.renderBoardLayout(container, projects, currentProject, kanbanView, bucketsWithTasks);
            });
        }
        // Feature rows deliberately use the same task detail panel as cards;
        // completion applies to the parent only and never cascades silently.
        container.querySelectorAll('.kanban-feature-row').forEach((row) => {
            const rowElement = row;
            const open = () => {
                const taskId = rowElement.dataset.taskId;
                this.openTaskDetail(taskId, rowElement, container);
            };
            rowElement.addEventListener('click', (event) => {
                if (event.target.closest('button'))
                    return;
                open();
            });
            rowElement.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    open();
                }
            });
        });
        container.querySelectorAll('.kanban-feature-done-btn').forEach((button) => {
            button.addEventListener('click', async (event) => {
                event.stopPropagation();
                const task = this.taskCache[button.dataset.taskId];
                if (!task)
                    return;
                const progress = featureProgress(task);
                if (!task.done && progress.completed < progress.total && !confirm(`Mark "${task.title}" done with ${progress.total - progress.completed} unfinished subtask${progress.total - progress.completed === 1 ? '' : 's'}?`))
                    return;
                const doneButton = button;
                doneButton.disabled = true;
                try {
                    await this.setTaskDone(task, !task.done);
                    await this.loadAndRenderBoard(container);
                }
                catch (err) {
                    this.app.showToast(`Failed to update feature: ${err.message}`, { type: 'error', title: 'Kanban' });
                    doneButton.disabled = false;
                }
            });
        });
        if (this.boardMode === 'stats') {
            this.initStatsCharts(container);
        }
        // Initialize Sortable if buckets are rendered
        if (this.boardMode === 'board' && kanbanView && bucketsWithTasks && bucketsWithTasks.length > 0) {
            this.initSortable(container, bucketsWithTasks);
        }
    }
    renderFeaturesView() {
        const allFeatures = buildFeatures(Object.values(this.taskCache));
        const completedFeatures = allFeatures.filter(feature => feature.task.done);
        const features = this.showDoneFeatures
            ? allFeatures
            : allFeatures.filter(feature => !feature.task.done);
        if (allFeatures.length === 0) {
            return `
                <div class="kanban-no-view-wrapper">
                    <h3>No features yet</h3>
                    <p>Add a subtask in a task’s detail panel and it will appear here automatically.</p>
                </div>
            `;
        }
        return `
            <div class="kanban-features-view">
                <div class="kanban-features-heading">
                    <div>
                        <h3>Features</h3>
                        <p>Progress is calculated from direct Vikunja subtasks.</p>
                    </div>
                    <div class="kanban-features-actions">
                        ${completedFeatures.length > 0 ? `<button id="kanban-show-done-features-btn" class="toolbar-btn">${this.showDoneFeatures ? 'Hide done' : `Show done (${completedFeatures.length})`}</button>` : ''}
                        <span class="column-count">${features.length}${this.showDoneFeatures ? '' : `/${allFeatures.length}`}</span>
                    </div>
                </div>
                ${features.length > 0 ? `
                    <div class="kanban-features-list">
                        ${features.map(feature => this.renderFeatureRow(feature)).join('')}
                    </div>
                ` : `
                    <div class="kanban-features-empty">
                        <strong>All ${allFeatures.length} feature${allFeatures.length === 1 ? ' is' : 's are'} done.</strong>
                        <span>Use Show done to review them.</span>
                    </div>
                `}
            </div>
        `;
    }
    renderStatsView() {
        const stats = featureStats(buildFeatures(Object.values(this.taskCache)));
        if (stats.totalFeatures === 0) {
            return `
                <div class="kanban-no-view-wrapper">
                    <h3>No feature stats yet</h3>
                    <p>Add subtasks to a task and the portfolio statistics will appear here.</p>
                </div>
            `;
        }
        const formatDate = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
        const forecast = stats.remainingFeatures === 0
            ? '<strong>All features are done.</strong><span>No remaining feature parents.</span>'
            : stats.estimatedDaysRemaining == null
                ? '<strong>Waiting for velocity.</strong><span>No feature was marked done in the last 28 days.</span>'
                : `<strong>~${stats.estimatedDaysRemaining} day${stats.estimatedDaysRemaining === 1 ? '' : 's'} remaining</strong><span>Projected finish: ${formatDate(stats.projectedCompletionDate)}</span>`;
        return `
            <div class="kanban-stats-view">
                <div class="kanban-stats-heading">
                    <div>
                        <h3>Feature stats</h3>
                        <p>Current portfolio progress and completion velocity.</p>
                    </div>
                </div>
                <div class="kanban-stats-grid">
                    <section class="kanban-stat-card">
                        <span>Features done</span>
                        <strong>${stats.completedFeatures}/${stats.totalFeatures}</strong>
                        <em>${stats.featurePercent}% complete</em>
                    </section>
                    <section class="kanban-stat-card">
                        <span>Subtasks done</span>
                        <strong>${stats.completedSubtasks}/${stats.totalSubtasks}</strong>
                        <em>${stats.subtaskPercent}% complete</em>
                    </section>
                    <section class="kanban-stat-card">
                        <span>Current velocity</span>
                        <strong>${stats.velocityPerDay.toFixed(2)}<small>/day</small></strong>
                        <em>${stats.completedInWindow} feature${stats.completedInWindow === 1 ? '' : 's'} done in ${stats.velocityWindowDays} days</em>
                    </section>
                    <section class="kanban-stat-card kanban-stat-card--forecast">
                        <span>Forecast</span>
                        ${forecast}
                    </section>
                </div>
                <div class="kanban-stats-charts">
                    <section class="kanban-stats-chart-card kanban-stats-chart-card--health">
                        <div class="kanban-stats-chart-heading">
                            <div><h4>Feature health</h4><p>Done vs open feature parents.</p></div>
                        </div>
                        <div class="kanban-chart-wrap"><canvas id="kanban-feature-health-chart"></canvas></div>
                    </section>
                    <section class="kanban-stats-chart-card kanban-stats-chart-card--burnup">
                        <div class="kanban-stats-chart-heading">
                            <div><h4>Scope burn-up</h4><p>Features filed against features marked done.</p></div>
                        </div>
                        <div class="kanban-chart-wrap"><canvas id="kanban-feature-burnup-chart"></canvas></div>
                    </section>
                    <section class="kanban-stats-chart-card kanban-stats-chart-card--velocity">
                        <div class="kanban-stats-chart-heading">
                            <div><h4>Completion velocity</h4><p>Last ${stats.velocityWindowDays} days, with rolling daily average.</p></div>
                            <span>${stats.completedInWindow} completed</span>
                        </div>
                        <div class="kanban-chart-wrap"><canvas id="kanban-feature-velocity-chart"></canvas></div>
                    </section>
                    <section class="kanban-stats-chart-card kanban-stats-chart-card--flow">
                        <div class="kanban-stats-chart-heading">
                            <div><h4>Project flow</h4><p>Tasks currently distributed across Kanban buckets.</p></div>
                        </div>
                        <div class="kanban-chart-wrap"><canvas id="kanban-bucket-flow-chart"></canvas></div>
                    </section>
                </div>
            </div>
        `;
    }
    destroyStatsCharts() {
        (this.statsCharts || []).forEach(chart => {
            try {
                chart.destroy();
            }
            catch (_) {
                // A detached canvas can already have been cleaned up by Chart.
            }
        });
        this.statsCharts = [];
    }
    chartColor(name, fallback) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    }
    chartColorWithAlpha(color, alpha) {
        const hex = color.replace('#', '').trim();
        if (/^[0-9a-f]{3}$/i.test(hex)) {
            const [r, g, b] = hex.split('').map(component => parseInt(component + component, 16));
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        if (/^[0-9a-f]{6}$/i.test(hex)) {
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        return color;
    }
    chartDateLabel(date) {
        return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    }
    bucketFlow() {
        const buckets = (this.buckets || []).filter(bucket => Array.isArray(bucket.tasks));
        if (buckets.length === 0)
            return { labels: ['No bucketed tasks'], values: [1] };
        return {
            labels: buckets.map(bucket => bucket.title || 'Untitled'),
            values: buckets.map(bucket => bucket.tasks.length)
        };
    }
    initStatsCharts(container) {
        const Chart = window.Chart;
        if (!Chart)
            return;
        const features = buildFeatures(Object.values(this.taskCache));
        const stats = featureStats(features);
        if (stats.totalFeatures === 0)
            return;
        const accent = this.chartColor('--accent', '#7c6af7');
        const muted = this.chartColor('--text-muted', '#a4a3a9');
        const border = this.chartColor('--bg-border', '#303038');
        const panel = this.chartColor('--bg-panel', '#17171c');
        const text = this.chartColor('--text-primary', '#f4f4f5');
        const uiFont = this.chartColor('--font-ui', 'Inter, system-ui, sans-serif');
        const monoFont = this.chartColor('--font-mono', 'ui-monospace, monospace');
        const accentFill = this.chartColorWithAlpha(accent, 0.18);
        const accentMid = this.chartColorWithAlpha(accent, 0.58);
        const accentSoft = this.chartColorWithAlpha(accent, 0.28);
        const quiet = this.chartColorWithAlpha(muted, 0.28);
        const baseOptions = {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 360 },
            plugins: {
                legend: {
                    labels: { color: muted, boxWidth: 8, boxHeight: 8, usePointStyle: true, font: { family: uiFont, size: 11 } }
                },
                tooltip: {
                    backgroundColor: panel,
                    borderColor: border,
                    borderWidth: 1,
                    titleColor: text,
                    bodyColor: muted,
                    padding: 10
                }
            }
        };
        const push = (canvasId, config) => {
            const canvas = container.querySelector(`#${canvasId}`);
            if (canvas)
                this.statsCharts.push(new Chart(canvas, config));
        };
        push('kanban-feature-health-chart', {
            type: 'doughnut',
            data: {
                labels: ['Done', 'Open'],
                datasets: [{
                        data: [stats.completedFeatures, stats.remainingFeatures],
                        backgroundColor: [accent, quiet],
                        borderColor: [panel, panel],
                        borderWidth: 3,
                        hoverOffset: 5
                    }]
            },
            options: {
                ...baseOptions,
                cutout: '72%',
                plugins: {
                    ...baseOptions.plugins,
                    title: { display: true, text: `${stats.featurePercent}% complete`, color: text, font: { family: uiFont, size: 15, weight: '600' } }
                }
            }
        });
        const burnup = portfolioTimeline(features);
        const burnupLabels = burnup.length > 0 ? burnup.map(point => this.chartDateLabel(point.date)) : ['Today'];
        const filed = burnup.length > 0 ? burnup.map(point => point.filed) : [stats.totalFeatures];
        const completed = burnup.length > 0 ? burnup.map(point => point.completed) : [stats.completedFeatures];
        push('kanban-feature-burnup-chart', {
            type: 'line',
            data: {
                labels: burnupLabels,
                datasets: [
                    { label: 'Filed', data: filed, borderColor: muted, backgroundColor: quiet, borderDash: [5, 4], tension: 0.25, pointRadius: 2, fill: true },
                    { label: 'Completed', data: completed, borderColor: accent, backgroundColor: accentFill, tension: 0.25, pointRadius: 2, fill: true }
                ]
            },
            options: {
                ...baseOptions,
                interaction: { intersect: false, mode: 'index' },
                scales: {
                    x: { grid: { display: false }, border: { color: border }, ticks: { color: muted, maxTicksLimit: 6, font: { family: monoFont, size: 10 } } },
                    y: { beginAtZero: true, grid: { color: this.chartColorWithAlpha(border, 0.65) }, border: { color: border }, ticks: { color: muted, precision: 0, font: { family: monoFont, size: 10 } } }
                }
            }
        });
        push('kanban-feature-velocity-chart', {
            type: 'bar',
            data: {
                labels: stats.dailyCompletions.map(day => this.chartDateLabel(day.date)),
                datasets: [
                    { type: 'bar', label: 'Completed', data: stats.dailyCompletions.map(day => day.completed), backgroundColor: accentMid, borderRadius: 3, borderSkipped: false },
                    { type: 'line', label: '28-day average', data: stats.dailyCompletions.map(() => stats.velocityPerDay), borderColor: accent, borderDash: [4, 3], pointRadius: 0, borderWidth: 1.5 }
                ]
            },
            options: {
                ...baseOptions,
                interaction: { intersect: false, mode: 'index' },
                scales: {
                    x: { grid: { display: false }, border: { color: border }, ticks: { color: muted, maxTicksLimit: 7, font: { family: monoFont, size: 9 } } },
                    y: { beginAtZero: true, grid: { color: this.chartColorWithAlpha(border, 0.65) }, border: { color: border }, ticks: { color: muted, precision: 0, font: { family: monoFont, size: 10 } } }
                }
            }
        });
        const flow = this.bucketFlow();
        const flowColors = flow.labels.map((_, index) => [accent, accentMid, accentSoft, quiet][index % 4]);
        push('kanban-bucket-flow-chart', {
            type: 'doughnut',
            data: {
                labels: flow.labels,
                datasets: [{ data: flow.values, backgroundColor: flowColors, borderColor: [panel], borderWidth: 3, hoverOffset: 5 }]
            },
            options: { ...baseOptions, cutout: '62%' }
        });
    }
    renderFeatureProgress(progress) {
        return `
            <div class="kanban-feature-progress" aria-label="${progress.completed} of ${progress.total} subtasks complete">
                <div class="kanban-feature-progress-meta"><span>${progress.completed}/${progress.total}</span><strong>${progress.percent}%</strong></div>
                <div class="kanban-feature-progress-track"><span style="width: ${progress.percent}%"></span></div>
            </div>
        `;
    }
    renderFeatureRow(progress) {
        const task = progress.task;
        const idLabel = task.identifier || `#${task.index || task.id}`;
        return `
            <div class="kanban-feature-row ${task.done ? 'kanban-feature-row--done' : ''}" data-task-id="${task.id}" tabindex="0" role="button">
                <div class="kanban-feature-main">
                    <span class="kanban-feature-id">${this.escapeHtml(idLabel)}</span>
                    <span class="kanban-feature-title">${this.escapeHtml(task.title || '')}</span>
                </div>
                ${this.renderFeatureProgress(progress)}
                <button class="btn ${task.done ? 'btn-primary' : 'btn-accent'} kanban-feature-done-btn" data-task-id="${task.id}">${task.done ? 'Reopen' : 'Mark done'}</button>
            </div>
        `;
    }
    renderFeatureTimeline(subtasks) {
        const timeline = featureTimeline(subtasks);
        if (timeline.length === 0) {
            return '<div class="kdp-feature-timeline-empty">No dated subtask activity yet.</div>';
        }
        const width = 260;
        const height = 54;
        const maximum = Math.max(1, ...timeline.map(point => Math.max(point.filed, point.completed)));
        const x = (index) => timeline.length === 1 ? width : (index / (timeline.length - 1)) * width;
        const y = (value) => height - ((value / maximum) * height);
        const points = (field) => timeline.map((point, index) => `${x(index).toFixed(1)},${y(point[field]).toFixed(1)}`).join(' ');
        const firstDate = new Date(`${timeline[0].date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const lastDate = new Date(`${timeline[timeline.length - 1].date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const last = timeline[timeline.length - 1];
        return `
            <div class="kdp-feature-timeline" aria-label="Subtasks filed and completed over time">
                <div class="kdp-feature-timeline-legend"><span><i class="filed"></i>Filed ${last.filed}</span><span><i class="completed"></i>Completed ${last.completed}</span></div>
                <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Cumulative subtasks filed and completed from ${firstDate} to ${lastDate}">
                    <polyline class="kdp-timeline-filed" points="${points('filed')}"></polyline>
                    <polyline class="kdp-timeline-completed" points="${points('completed')}"></polyline>
                    <circle class="kdp-timeline-filed-point" cx="${x(timeline.length - 1).toFixed(1)}" cy="${y(last.filed).toFixed(1)}" r="2"></circle>
                    <circle class="kdp-timeline-completed-point" cx="${x(timeline.length - 1).toFixed(1)}" cy="${y(last.completed).toFixed(1)}" r="2"></circle>
                </svg>
                <div class="kdp-feature-timeline-dates"><span>${firstDate}</span><span>${lastDate}</span></div>
            </div>
        `;
    }
    renderFeatureDetailSection(task) {
        const progress = featureProgress(task);
        const subtaskRows = progress.subtasks.length === 0
            ? '<div class="kdp-subtasks-empty">Add a subtask to turn this task into a feature.</div>'
            : progress.subtasks.map(subtask => `
                <div class="kdp-subtask-row ${subtask.done ? 'done' : ''}">
                    <input type="checkbox" class="kdp-subtask-done" data-subtask-id="${subtask.id}" aria-label="Mark ${this.escapeHtml(subtask.title || 'subtask')} done" ${subtask.done ? 'checked' : ''}>
                    <button class="kdp-subtask-open" data-subtask-id="${subtask.id}" title="Open subtask">${this.escapeHtml(subtask.title || '')}</button>
                </div>
            `).join('');
        return `
            <section class="kdp-feature-section">
                <div class="kdp-feature-section-heading">
                    <label>Subtasks</label>
                    ${progress.total > 0 ? `<span>${progress.completed}/${progress.total} · ${progress.percent}%</span>` : ''}
                </div>
                ${progress.total > 0 ? this.renderFeatureProgress(progress) : ''}
                <div class="kdp-subtasks-list">${subtaskRows}</div>
                <div class="kdp-add-subtask-row">
                    <input id="kdp-new-subtask" type="text" placeholder="Add subtask…">
                    <button id="kdp-add-subtask-btn" class="btn btn-primary">Add</button>
                </div>
                ${progress.total > 0 ? this.renderFeatureTimeline(progress.subtasks) : ''}
            </section>
        `;
    }
    withSubtask(parent, subtask) {
        const children = featureProgress(parent).subtasks;
        const existing = children.findIndex(child => String(child.id) === String(subtask.id));
        const nextChildren = existing >= 0
            ? children.map((child, index) => index === existing ? { ...child, ...subtask } : child)
            : [...children, subtask];
        const nextParent = {
            ...parent,
            related_tasks: { ...(parent.related_tasks || {}), subtask: nextChildren }
        };
        this.taskCache[nextParent.id] = nextParent;
        this.taskCache[subtask.id] = { ...(this.taskCache[subtask.id] || {}), ...subtask };
        return nextParent;
    }
    replaceFeatureDetailSection(panel, task, cardEl, container) {
        const current = panel.querySelector('.kdp-feature-section');
        if (!current)
            return;
        current.outerHTML = this.renderFeatureDetailSection(task);
        this.wireFeatureDetailSection(panel, task, cardEl, container);
    }
    wireFeatureDetailSection(panel, task, cardEl, container) {
        panel.querySelectorAll('.kdp-subtask-done').forEach((input) => {
            input.addEventListener('change', async () => {
                const checkbox = input;
                const child = featureProgress(task).subtasks.find(item => String(item.id) === checkbox.dataset.subtaskId);
                if (!child)
                    return;
                checkbox.disabled = true;
                try {
                    const updatedChild = await this.setTaskDone(child, checkbox.checked);
                    const parent = this.withSubtask(task, updatedChild);
                    this.replaceFeatureDetailSection(panel, parent, cardEl, container);
                    await this.loadAndRenderBoard(container);
                }
                catch (err) {
                    checkbox.checked = !checkbox.checked;
                    checkbox.disabled = false;
                    this.app.showToast(`Failed to update subtask: ${err.message}`, { type: 'error', title: 'Kanban' });
                }
            });
        });
        panel.querySelectorAll('.kdp-subtask-open').forEach((button) => {
            button.addEventListener('click', () => {
                const childId = button.dataset.subtaskId;
                this.openTaskDetail(childId, button, container);
            });
        });
        const input = panel.querySelector('#kdp-new-subtask');
        const addButton = panel.querySelector('#kdp-add-subtask-btn');
        if (!input || !addButton)
            return;
        const create = async () => {
            const title = input.value.trim();
            if (!title)
                return;
            input.disabled = true;
            addButton.disabled = true;
            try {
                const child = await this.createSubtask(task, title);
                const parent = this.withSubtask(task, child);
                this.replaceFeatureDetailSection(panel, parent, cardEl, container);
                await this.loadAndRenderBoard(container);
                this.app.showToast('Subtask added.', { type: 'success', title: 'Kanban' });
            }
            catch (err) {
                this.app.showToast(`Failed to add subtask: ${err.message}`, { type: 'error', title: 'Kanban' });
                input.disabled = false;
                addButton.disabled = false;
            }
        };
        addButton.addEventListener('click', create);
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                void create();
            }
        });
    }
    renderColumn(bucket) {
        const tasks = bucket.tasks || [];
        const taskCount = tasks.length;
        // Inline X on the column header so users can rename/delete the column
        // without an extra menu. Both buttons are aria-hidden-on-default-styling;
        // they appear on hover for a clean default look. Clicks stopPropagation
        // so they don't trigger the "switch to this bucket" behaviour.
        return `
            <div class="kanban-column" data-bucket-id="${bucket.id}">
                <div class="kanban-column-header">
                    <span class="column-title" data-bucket-id="${bucket.id}" title="Click to rename">${this.escapeHtml(bucket.title)}</span>
                    <span class="column-count">${taskCount}</span>
                    <button class="column-action-btn column-edit-btn" data-bucket-id="${bucket.id}" title="Rename bucket" aria-label="Rename bucket">
                        <svg class="icon-small" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 20h9"></path>
                            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                        </svg>
                    </button>
                    <button class="column-action-btn column-delete-btn" data-bucket-id="${bucket.id}" title="Delete bucket" aria-label="Delete bucket">
                        <svg class="icon-small" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
                <div class="kanban-cards-list" data-bucket-id="${bucket.id}">
                    ${tasks.map((task) => this.renderCard(task)).join('')}
                </div>
                <div class="kanban-add-task-wrapper" data-bucket-id="${bucket.id}">
                    <button class="kanban-add-task-btn">+ Add Task</button>
                </div>
            </div>
        `;
    }
    renderCard(task) {
        // Priority styles mapping
        let priorityBadge = '';
        if (task.priority > 0) {
            const { label: prioLabel, className: prioClass } = priorityMeta(task.priority);
            priorityBadge = `<span class="kanban-badge ${prioClass}">${prioLabel}</span>`;
        }
        // Labels layout
        let labelsHtml = '';
        if (task.labels && task.labels.length > 0) {
            labelsHtml = `
                <div class="kanban-card-labels">
                    ${task.labels.map((lbl) => {
                const hex = safeHexColor(lbl.hex_color);
                const style = hex ? `style="background-color: #${hex}25; color: #${hex}; border: 1px solid #${hex}40;"` : '';
                return `<span class="kanban-label-pill" ${style} title="${this.escapeHtml(lbl.title || '')}">${this.escapeHtml(lbl.title)}</span>`;
            }).join('')}
                </div>
            `;
        }
        const progress = featureProgress(task);
        const featureProgressHtml = progress.total > 0 ? this.renderFeatureProgress(progress) : '';
        // Due Date rendering
        let dueHtml = '';
        if (task.due_date && !task.due_date.startsWith('0001-01-01')) {
            const date = new Date(task.due_date);
            const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            const isOverdue = date < new Date() && !task.done;
            const dueClass = isOverdue ? 'due-overdue' : '';
            dueHtml = `
                <span class="kanban-due-date ${dueClass}">
                    <svg class="icon-small" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                        <line x1="16" y1="2" x2="16" y2="6"></line>
                        <line x1="8" y1="2" x2="8" y2="6"></line>
                        <line x1="3" y1="10" x2="21" y2="10"></line>
                    </svg>
                    <span>${dateStr}</span>
                </span>
            `;
        }
        const idLabel = task.identifier || `#${task.index || task.id}`;
        return `
            <div class="kanban-card ${task.done ? 'kanban-card--done' : ''}" data-task-id="${task.id}">
                <button class="kanban-card-delete-btn" data-task-id="${task.id}" title="Delete task" aria-label="Delete task">
                    <svg class="icon-small" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
                <div class="kanban-card-title">${this.escapeHtml(task.title)}</div>
                ${labelsHtml}
                ${featureProgressHtml}
                <div class="kanban-card-meta">
                    <div class="meta-left">
                        <span class="kanban-task-id">${this.escapeHtml(idLabel)}</span>
                        ${dueHtml}
                    </div>
                    <div class="meta-right">
                        ${priorityBadge}
                    </div>
                </div>
            </div>
        `;
    }
    escapeHtml(str) {
        return escapeHtmlUtil(str);
    }
    initSortable(container, buckets) {
        const lists = container.querySelectorAll('.kanban-cards-list');
        lists.forEach(list => {
            if (typeof window.Sortable === 'undefined') {
                console.error('SortableJS not loaded!');
                return;
            }
            window.Sortable.create(list, {
                group: 'kanban-cards',
                animation: 150,
                ghostClass: 'kanban-card-ghost',
                dragClass: 'kanban-card-dragging',
                onStart: () => {
                    this._dragActive = true;
                },
                onEnd: async (evt) => {
                    setTimeout(() => {
                        this._dragActive = false;
                    }, 100);
                    const taskId = evt.item.dataset.taskId;
                    const oldBucketId = evt.from.dataset.bucketId;
                    const newBucketId = evt.to.dataset.bucketId;
                    if (oldBucketId === newBucketId)
                        return;
                    // Optimistically update card done styling
                    const targetBucket = (this.buckets || []).find((b) => b.id == newBucketId);
                    const isDoneBucket = bucketIsDone(targetBucket);
                    if (isDoneBucket) {
                        evt.item.classList.add('kanban-card--done');
                    }
                    else {
                        evt.item.classList.remove('kanban-card--done');
                    }
                    this.updateColumnCounts(container);
                    try {
                        await this.moveTask(taskId, newBucketId);
                        this.app.showToast('Task updated successfully.', { type: 'success' });
                    }
                    catch (err) {
                        console.error('Failed to move task:', err);
                        this.app.showToast(`Failed to move task: ${err.message}`, { type: 'error' });
                        // Revert drag
                        evt.from.appendChild(evt.item);
                        // Revert done styling
                        const originalBucket = (this.buckets || []).find((b) => b.id == oldBucketId);
                        const isOriginalDone = bucketIsDone(originalBucket);
                        if (isOriginalDone) {
                            evt.item.classList.add('kanban-card--done');
                        }
                        else {
                            evt.item.classList.remove('kanban-card--done');
                        }
                        this.updateColumnCounts(container);
                    }
                }
            });
            // Register card click to open details
            list.addEventListener('click', (evt) => {
                if (this._dragActive)
                    return;
                const card = evt.target.closest('.kanban-card');
                if (!card)
                    return;
                this.openTaskDetail(card.dataset.taskId, card, container);
            });
        });
    }
    async openTaskDetail(taskId, cardEl, container) {
        this.closeDetailPanel();
        // 1. Render overlay
        const overlay = document.createElement('div');
        overlay.className = 'kanban-detail-overlay';
        overlay.addEventListener('click', () => this.closeDetailPanel());
        document.body.appendChild(overlay);
        this.activeOverlay = overlay;
        // 2. Render panel with loading state
        const panel = document.createElement('div');
        panel.className = 'kanban-detail-panel';
        panel.innerHTML = `
            <div class="kdp-header">
                <span class="kdp-identifier">Loading...</span>
                <button class="kdp-close-btn">✕</button>
            </div>
            <div class="kdp-spinner-container">
                <div class="spinner-ring"></div>
                <div class="loader-text">Fetching task details...</div>
            </div>
        `;
        panel.querySelector('.kdp-close-btn').addEventListener('click', () => this.closeDetailPanel());
        document.body.appendChild(panel);
        this.activeDetailPanel = panel;
        // Escape key to close
        this.escListener = (e) => {
            if (e.key === 'Escape') {
                this.closeDetailPanel();
            }
        };
        document.addEventListener('keydown', this.escListener);
        try {
            const fetchedTask = await this.apiGet(`/tasks/${taskId}`);
            const cachedTask = this.taskCache[taskId];
            // Some Vikunja versions only include the expanded relation map on
            // collection endpoints. Preserve that map when the detail response
            // omits it so feature progress stays visible in the drawer.
            const task = {
                ...cachedTask,
                ...fetchedTask,
                related_tasks: fetchedTask?.related_tasks?.subtask ? fetchedTask.related_tasks : cachedTask?.related_tasks
            };
            this.taskCache[task.id] = task;
            this.renderDetailPanelContent(panel, task, cardEl, container);
        }
        catch (err) {
            console.error('Failed to load task details:', err);
            panel.innerHTML = `
                <div class="kdp-header">
                    <span class="kdp-identifier">Error</span>
                    <button class="kdp-close-btn">✕</button>
                </div>
                <div class="kdp-body">
                    <div class="kanban-error-wrapper">
                        <h3>Failed to load task</h3>
                        <p>${this.escapeHtml(err.message)}</p>
                    </div>
                </div>
            `;
            panel.querySelector('.kdp-close-btn').addEventListener('click', () => this.closeDetailPanel());
        }
    }
    sanitizeTaskDescription(description) {
        if (!description)
            return '';
        if (!window.DOMPurify?.sanitize)
            return this.escapeHtml(description);
        return String(window.DOMPurify.sanitize(description, {
            USE_PROFILES: { html: true },
            FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
            FORBID_ATTR: ['style']
        }));
    }
    taskDescriptionIcon(mode) {
        if (mode === 'preview') {
            return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
        }
        return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>';
    }
    taskDescriptionPreview(description) {
        return this.sanitizeTaskDescription(description) || '<span class="kanban-desc-empty">No description provided</span>';
    }
    // One description component serves every task detail surface. Board cards,
    // feature parents, and subtasks all open the same detail panel and therefore
    // use the same HTML sanitization, preview, editor, and save field.
    renderTaskDescriptionField(description) {
        return `
            <div class="kdp-field kdp-description-field">
                <div class="kdp-description-heading">
                    <label for="kdp-description">Description</label>
                    <button class="dropup-action-btn kdp-description-toggle" title="Edit description" aria-label="Edit description">
                        ${this.taskDescriptionIcon('edit')}
                    </button>
                </div>
                <div class="kanban-desc-html kdp-description-view">${this.taskDescriptionPreview(description)}</div>
                <textarea id="kdp-description" class="hidden kdp-description-input" placeholder="No description provided">${this.escapeHtml(description)}</textarea>
            </div>
        `;
    }
    wireTaskDescriptionField(scope) {
        const toggle = scope.querySelector('.kdp-description-toggle');
        const preview = scope.querySelector('.kdp-description-view');
        const input = scope.querySelector('.kdp-description-input');
        if (!toggle || !preview || !input)
            return;
        toggle.addEventListener('click', () => {
            const editing = input.classList.contains('hidden');
            input.classList.toggle('hidden', !editing);
            preview.classList.toggle('hidden', editing);
            if (editing) {
                toggle.innerHTML = this.taskDescriptionIcon('preview');
                toggle.title = 'Preview description';
                toggle.setAttribute('aria-label', 'Preview description');
                input.focus({ preventScroll: true });
            }
            else {
                preview.innerHTML = this.taskDescriptionPreview(input.value);
                toggle.innerHTML = this.taskDescriptionIcon('edit');
                toggle.title = 'Edit description';
                toggle.setAttribute('aria-label', 'Edit description');
            }
        });
    }
    taskDescriptionValue(scope) {
        return scope.querySelector('.kdp-description-input')?.value || '';
    }
    renderDetailPanelContent(panel, task, cardEl, container) {
        const idLabel = task.identifier || `#${task.index || task.id}`;
        let formattedDate = '';
        if (task.due_date && !task.due_date.startsWith('0001-01-01')) {
            formattedDate = task.due_date.substring(0, 10);
        }
        let labelsHtml = '';
        if (task.labels && task.labels.length > 0) {
            labelsHtml = `
                <div class="kdp-labels-current">
                    ${task.labels.map((lbl) => {
                const hex = safeHexColor(lbl.hex_color);
                const style = hex ? `style="background-color: #${hex}25; color: #${hex}; border: 1px solid #${hex}40;"` : '';
                return `<span class="kanban-label-pill kdp-label-removable" data-label-id="${lbl.id}" ${style}>${this.escapeHtml(lbl.title)}<button class="kdp-label-remove-btn" data-label-id="${lbl.id}" title="Remove label" aria-label="Remove label">×</button></span>`;
            }).join('')}
                </div>
            `;
        }
        else {
            labelsHtml = '<span style="color: var(--text-muted); font-size: 12px; font-style: italic;">No labels</span>';
        }
        const createdDate = task.created ? new Date(task.created).toLocaleString() : 'N/A';
        const updatedDate = task.updated ? new Date(task.updated).toLocaleString() : 'N/A';
        panel.innerHTML = `
            <div class="kdp-header">
                <span class="kdp-identifier">${this.escapeHtml(idLabel)}</span>
                <button class="kdp-close-btn">✕</button>
            </div>
            <div class="kdp-body">
                <div class="kdp-field">
                    <label for="kdp-title">Title</label>
                    <input id="kdp-title" type="text" value="${this.escapeHtml(task.title)}">
                </div>

                <div class="kdp-field-row">
                    <div class="kdp-field">
                        <label for="kdp-priority">Priority</label>
                        <select id="kdp-priority">
                            <option value="0" ${task.priority === 0 ? 'selected' : ''}>None</option>
                            <option value="1" ${task.priority === 1 ? 'selected' : ''}>Low</option>
                            <option value="2" ${task.priority === 2 ? 'selected' : ''}>Medium</option>
                            <option value="3" ${task.priority === 3 ? 'selected' : ''}>High</option>
                            <option value="4" ${task.priority === 4 ? 'selected' : ''}>Urgent</option>
                            <option value="5" ${task.priority === 5 ? 'selected' : ''}>DOOM</option>
                        </select>
                    </div>
                    <div class="kdp-field">
                        <label for="kdp-due-date">Due Date</label>
                        <input id="kdp-due-date" type="date" value="${formattedDate}">
                    </div>
                </div>

                <div class="kdp-field">
                    <label class="kdp-checkbox-label">
                        <input id="kdp-done" type="checkbox" ${task.done ? 'checked' : ''}>
                        <span>Mark as Done</span>
                    </label>
                </div>

                <div class="kdp-field">
                    <label>Labels</label>
                    <div class="kdp-labels-display">
                        ${labelsHtml}
                    </div>
                    <div class="kdp-labels-add-row">
                        <select id="kdp-label-picker" class="kdp-label-picker">
                            <option value="">Add label…</option>
                        </select>
                        <button id="kdp-label-add-btn" class="btn btn-primary" disabled>+ Add</button>
                    </div>
                </div>

                ${this.renderFeatureDetailSection(task)}

                ${this.renderTaskDescriptionField(task.description || '')}

                <div class="kdp-meta">
                    <div>Created: ${createdDate}</div>
                    <div>Updated: ${updatedDate}</div>
                </div>
            </div>
            <div class="kdp-footer">
                <button class="btn kdp-delete-btn">Delete</button>
                <div class="kdp-footer-right">
                    <button class="btn btn-primary kdp-cancel-btn">Cancel</button>
                    <button class="btn btn-accent kdp-save-btn">Save</button>
                </div>
            </div>
        `;
        // The same HTML description component is wired for ordinary tasks and
        // feature parents because both surfaces use this detail renderer.
        this.wireTaskDescriptionField(panel);
        // Label picker: populate the dropdown with all labels (minus ones
        // already on this task), enable Add when a real option is chosen, and
        // wire remove-X on each existing label pill.
        this._wireLabelPicker(panel, task, container);
        this.wireFeatureDetailSection(panel, task, cardEl, container);
        panel.querySelector('.kdp-close-btn').addEventListener('click', () => this.closeDetailPanel());
        panel.querySelector('.kdp-cancel-btn').addEventListener('click', () => this.closeDetailPanel());
        // Detail-panel Delete button. Confirms, then deletes the task and closes
        // the panel. The container ref is captured so the board reloads.
        const deleteBtn = panel.querySelector('.kdp-delete-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async () => {
                if (!confirm(`Delete task "${task.title}"? This cannot be undone.`))
                    return;
                deleteBtn.disabled = true;
                try {
                    await this.deleteTask(task.id, container);
                    this.closeDetailPanel();
                }
                catch (err) {
                    this.app.showToast(`Failed to delete task: ${err.message}`, { type: 'error', title: 'Kanban' });
                    deleteBtn.disabled = false;
                }
            });
        }
        panel.querySelector('.kdp-save-btn').addEventListener('click', async () => {
            const saveBtn = panel.querySelector('.kdp-save-btn');
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
            try {
                const newTitle = panel.querySelector('#kdp-title').value.trim();
                const newPriority = parseInt(panel.querySelector('#kdp-priority').value, 10);
                const newDueDateVal = panel.querySelector('#kdp-due-date').value;
                const newDone = panel.querySelector('#kdp-done').checked;
                const newDescription = this.taskDescriptionValue(panel);
                let newDueDate = null;
                if (newDueDateVal) {
                    newDueDate = new Date(newDueDateVal).toISOString();
                }
                await this.saveTaskDetail(task, {
                    title: newTitle,
                    priority: newPriority,
                    due_date: newDueDate,
                    done: newDone,
                    description: newDescription
                }, cardEl, container);
                this.closeDetailPanel();
            }
            catch (err) {
                console.error('Failed to save task detail:', err);
                this.app.showToast(`Failed to save task: ${err.message}`, { type: 'error' });
            }
            finally {
                // FIN-1: re-enable the button even if loadAndRenderBoard throws
                // after a successful save (the catch-only path left it stuck).
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save';
            }
        });
    }
    taskUpdatePayload(task, updates) {
        return {
            ...task,
            ...updates,
            due_date: updates.due_date === undefined ? task.due_date : (updates.due_date || '0001-01-01T00:00:00Z'),
            labels: (task.labels || []).map((label) => ({ id: label.id })),
            assignees: (task.assignees || []).map((assignee) => ({ id: assignee.id }))
        };
    }
    async setTaskDone(task, done) {
        const payload = this.taskUpdatePayload(task, { done });
        // Vikunja's UPDATE endpoint is POST /tasks/{id} (not PUT — only CREATE is PUT).
        const response = await this.apiPost(`/tasks/${task.id}`, payload);
        const next = { ...task, ...(response || {}), done };
        // Normally the API returns done_at. Retain a local timestamp when an
        // older server responds with 204 so the burn-up chart updates at once.
        if (done && !next.done_at)
            next.done_at = new Date().toISOString();
        this.taskCache[next.id] = next;
        return next;
    }
    async createSubtask(parent, title) {
        const trimmed = title.trim();
        if (!trimmed)
            throw new Error('Subtask title cannot be empty.');
        const projectId = this.currentProjectId || parent.project_id;
        if (!projectId)
            throw new Error('Subtask create failed: project not loaded yet.');
        const payload = { title: trimmed, project_id: projectId };
        if (parent.bucket_id != null)
            payload.bucket_id = parent.bucket_id;
        const child = await this.apiPut(`/projects/${projectId}/tasks`, payload);
        if (!child?.id)
            throw new Error('Vikunja did not return the new subtask.');
        try {
            await this.apiPut(`/tasks/${parent.id}/relations`, {
                other_task_id: child.id,
                relation_kind: 'subtask'
            });
        }
        catch (err) {
            // Creation and relation linking are separate upstream calls. Do not
            // leave an unexpected orphan behind when the second call fails.
            try {
                await this.apiDelete(`/tasks/${child.id}`);
            }
            catch (cleanupErr) {
                console.error('Failed to clean up unlinked subtask:', cleanupErr);
            }
            throw err;
        }
        return child;
    }
    async saveTaskDetail(task, formData, cardEl, container) {
        const payload = this.taskUpdatePayload(task, formData);
        // Vikunja's UPDATE endpoint is POST /tasks/{id} (not PUT — only CREATE is PUT).
        await this.apiPost(`/tasks/${task.id}`, payload);
        this.app.showToast('Task updated successfully.', { type: 'success' });
        // Update taskCache
        this.taskCache[task.id] = payload;
        await this.loadAndRenderBoard(container);
    }
    closeDetailPanel() {
        if (this.activeDetailPanel) {
            this.activeDetailPanel.remove();
            this.activeDetailPanel = null;
        }
        if (this.activeOverlay) {
            this.activeOverlay.remove();
            this.activeOverlay = null;
        }
        if (this.escListener) {
            document.removeEventListener('keydown', this.escListener);
            this.escListener = null;
        }
    }
    updateColumnCounts(container) {
        container.querySelectorAll('.kanban-column').forEach(col => {
            const count = col.querySelectorAll('.kanban-card').length;
            col.querySelector('.column-count').textContent = count;
        });
    }
    // ============================================================
    // Task CRUD
    // ============================================================
    // deleteTask removes a task via Vikunja's DELETE /tasks/{id}.
    async deleteTask(taskId, container) {
        await this.apiDelete(`/tasks/${taskId}`);
        delete this.taskCache[taskId];
        if (container)
            await this.loadAndRenderBoard(container);
    }
    // ============================================================
    // Bucket CRUD (kanban columns)
    // ============================================================
    // createBucket PUTs a new bucket via /projects/{p}/views/{v}/buckets.
    async createBucket(title, container) {
        if (!this.currentProjectId || !this.currentViewId) {
            throw new Error('Bucket create failed: project or view not loaded yet.');
        }
        const t = (title || '').trim();
        if (!t)
            throw new Error('Bucket title cannot be empty.');
        await this.apiPut(`/projects/${this.currentProjectId}/views/${this.currentViewId}/buckets`, { title: t });
        if (container)
            await this.loadAndRenderBoard(container);
    }
    // updateBucket renames a bucket via POST /projects/{p}/views/{v}/buckets/{b}.
    async updateBucket(bucketId, title, container) {
        if (!this.currentProjectId || !this.currentViewId) {
            throw new Error('Bucket update failed: project or view not loaded yet.');
        }
        const t = (title || '').trim();
        if (!t)
            throw new Error('Bucket title cannot be empty.');
        await this.apiPost(`/projects/${this.currentProjectId}/views/${this.currentViewId}/buckets/${bucketId}`, { title: t });
        if (container)
            await this.loadAndRenderBoard(container);
    }
    // deleteBucket removes a bucket. Drops cached tasks that belonged to it.
    async deleteBucket(bucketId, container) {
        if (!this.currentProjectId || !this.currentViewId) {
            throw new Error('Bucket delete failed: project or view not loaded yet.');
        }
        await this.apiDelete(`/projects/${this.currentProjectId}/views/${this.currentViewId}/buckets/${bucketId}`);
        for (const [id, t] of Object.entries(this.taskCache)) {
            if (t.bucket_id == bucketId)
                delete this.taskCache[id];
        }
        this.buckets = (this.buckets || []).filter((b) => b.id != bucketId);
        if (container)
            await this.loadAndRenderBoard(container);
    }
    // ============================================================
    // Labels (per-task)
    // ============================================================
    // fetchAllLabels queries Vikunja for the available labels.
    async fetchAllLabels() {
        return await this.apiGet('/labels');
    }
    // _wireLabelPicker populates the add-label dropdown in the detail panel
    // (omitting labels already on the task), enables the Add button when a
    // real option is chosen, and binds remove-X on each existing label pill.
    // _refreshDetailPanelLabels(panel) is exported as a callback so we can
    // re-render the pills after add/remove without re-opening the whole panel.
    async _wireLabelPicker(panel, task, container) {
        const picker = panel.querySelector('#kdp-label-picker');
        const addBtn = panel.querySelector('#kdp-label-add-btn');
        if (!picker || !addBtn)
            return;
        // Try to populate; if the call fails (offline, no permission), the
        // picker stays empty but the rest of the panel still works.
        try {
            const all = (await this.fetchAllLabels()) || [];
            const have = new Set((task.labels || []).map((l) => l.id));
            const opts = ['<option value="">Add label…</option>']
                .concat(all.filter((l) => !have.has(l.id))
                .map((l) => `<option value="${l.id}">${this.escapeHtml(l.title || '(unnamed)')}</option>`));
            picker.innerHTML = opts.join('');
        }
        catch (_) {
            // Leave the placeholder only; user can still X-off existing labels.
        }
        picker.addEventListener('change', () => {
            addBtn.disabled = !picker.value;
        });
        addBtn.addEventListener('click', async () => {
            const id = parseInt(picker.value, 10);
            if (!id)
                return;
            addBtn.disabled = true;
            try {
                await this.addLabelToTask(task.id, id);
                // Re-render the labels section + repopulate the picker.
                const fresh = this.taskCache[task.id] || task;
                await this._refreshDetailPanelLabels(panel, fresh, container);
            }
            catch (err) {
                this.app.showToast(`Failed to add label: ${err.message}`, { type: 'error', title: 'Kanban' });
                addBtn.disabled = false;
            }
        });
        // Remove buttons on each existing label pill.
        panel.querySelectorAll('.kdp-label-remove-btn').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = parseInt(btn.dataset.labelId, 10);
                if (!id)
                    return;
                btn.disabled = true;
                try {
                    await this.removeLabelFromTask(task.id, id);
                    const fresh = this.taskCache[task.id] || task;
                    await this._refreshDetailPanelLabels(panel, fresh, container);
                }
                catch (err) {
                    this.app.showToast(`Failed to remove label: ${err.message}`, { type: 'error', title: 'Kanban' });
                    btn.disabled = false;
                }
            });
        });
    }
    // _refreshDetailPanelLabels re-renders the labels block + re-wires the
    // picker for the current task. Cheap — only the labels section is rebuilt.
    async _refreshDetailPanelLabels(panel, task, container) {
        const containerEl = panel.querySelector('.kdp-labels-display');
        if (containerEl) {
            if (task.labels && task.labels.length > 0) {
                containerEl.innerHTML = `
                    <div class="kdp-labels-current">
                        ${task.labels.map((lbl) => {
                    const hex = safeHexColor(lbl.hex_color);
                    const style = hex ? `style="background-color: #${hex}25; color: #${hex}; border: 1px solid #${hex}40;"` : '';
                    return `<span class="kanban-label-pill kdp-label-removable" data-label-id="${lbl.id}" ${style}>${this.escapeHtml(lbl.title)}<button class="kdp-label-remove-btn" data-label-id="${lbl.id}" title="Remove label" aria-label="Remove label">×</button></span>`;
                }).join('')}
                    </div>
                `;
            }
            else {
                containerEl.innerHTML = '<span style="color: var(--text-muted); font-size: 12px; font-style: italic;">No labels</span>';
            }
        }
        await this._wireLabelPicker(panel, task, container);
    }
    // addLabelToTask puts a label on a task via PUT /tasks/{task}/labels.
    async addLabelToTask(taskId, labelId) {
        const updated = await this.apiPut(`/tasks/${taskId}/labels`, { label_id: labelId });
        if (this.taskCache[taskId]) {
            this.taskCache[taskId].labels = updated || [];
        }
        return updated;
    }
    // removeLabelFromTask strips a label via DELETE /tasks/{task}/labels/{label}.
    async removeLabelFromTask(taskId, labelId) {
        await this.apiDelete(`/tasks/${taskId}/labels/${labelId}`);
        if (this.taskCache[taskId] && Array.isArray(this.taskCache[taskId].labels)) {
            this.taskCache[taskId].labels = this.taskCache[taskId].labels.filter((l) => l.id != labelId);
        }
    }
    async moveTask(taskId, newBucketId) {
        const existing = this.taskCache[taskId];
        if (!existing)
            throw new Error(`Task ${taskId} not in cache`);
        // Vikunja exposes a dedicated bucket-relocation endpoint:
        //   POST /projects/{projectID}/views/{viewID}/buckets/{bucketID}/tasks
        //   body: { task_id: <id> }
        // The plain task UPDATE endpoint does NOT change bucket_id reliably,
        // so we route drags through here. Without project_id and view_id
        // cached (set by loadAndRenderBoard), there's nothing to call.
        if (!this.currentProjectId || !this.currentViewId) {
            throw new Error('Move failed: project or view not loaded yet.');
        }
        const targetBucketId = parseInt(newBucketId, 10);
        await this.apiPost(`/projects/${this.currentProjectId}/views/${this.currentViewId}/buckets/${targetBucketId}/tasks`, { task_id: parseInt(taskId, 10) });
        // Mirror the move in the local cache so the UI is consistent until
        // the next refresh; the dedicated endpoint doesn't return the updated
        // task, so we just adjust the fields we know changed.
        existing.bucket_id = targetBucketId;
    }
    async apiGet(path) {
        return this.apiRequest(path, 'GET');
    }
    async apiPost(path, body) {
        return this.apiRequest(path, 'POST', body);
    }
    async apiPut(path, body) {
        return this.apiRequest(path, 'PUT', body);
    }
    async apiDelete(path, body) {
        return this.apiRequest(path, 'DELETE', body);
    }
    // Make a request to the upstream Vikunja instance via the local
    // /api/proxy. Handles auth, 401 -> drop token, and extracts a readable
    // message from Vikunja's JSON error envelope instead of dumping raw
    // HTML / JSON to the user.
    async apiRequest(path, method, body) {
        const token = sessionStorage.getItem('vikunja_token');
        const url = localStorage.getItem('vikunja_url');
        const proxyUrl = `/api/proxy?url=${encodeURIComponent(url + '/api/v1' + path)}`;
        const headers = {
            'Content-Type': 'application/json'
        };
        if (token && token !== 'null' && token !== 'undefined') {
            headers['Authorization'] = `Bearer ${token}`;
        }
        const res = await fetch(proxyUrl, {
            method,
            headers,
            body: body == null ? undefined : JSON.stringify(body)
        });
        if (res.status === 401) {
            sessionStorage.removeItem('vikunja_token');
            throw new Error('Session expired. Please reconnect.');
        }
        if (!res.ok) {
            const text = await res.text();
            throw new Error(extractVikunjaError(text, res.status));
        }
        // Some Vikunja endpoints return 204 No Content (e.g. some PUTs).
        const ctype = res.headers.get('content-type') || '';
        if (res.status === 204 || !ctype.includes('application/json'))
            return null;
        return await res.json();
    }
}
