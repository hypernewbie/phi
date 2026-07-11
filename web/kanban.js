import { escapeHtml as escapeHtmlUtil, priorityMeta, isDoneBucket as bucketIsDone, extractVikunjaError, safeHexColor } from './util.js';

export class KanbanManager {
    constructor(app) {
        this.app = app;
        this.activeDetailPanel = null;
        this.activeOverlay = null;
        this.escListener = null;
        this.taskCache = {};
        this._dragActive = false;
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
        if (!tab) return;

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
        localStorage.removeItem('phi_kanban_open');
    }

    async initTabContainer(container, isAutoRetry = false) {
        container.innerHTML = '';
        container.className = 'term-container kanban-panel';
        
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
            } catch (err) {
                console.error("Headless autologin failed:", err);
                autologinError = err;
            }
        }

        // If no saved credentials or autologin failed, render login form prefilled
        this.renderLoginForm(container);
        if (savedPw) {
            const pwInput = container.querySelector('#kanban-password-input');
            const chkInput = container.querySelector('#kanban-remember-input');
            if (pwInput) pwInput.value = savedPw;
            if (chkInput) chkInput.checked = true;
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
            if (!res.ok) return null;
            const data = await res.json();
            return data.password || null;
        } catch (e) {
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
                } else {
                    fetch('/api/config/kanban-vault', { method: 'DELETE' }).catch(e => console.error("Vault delete error:", e));
                }

                await this.loadAndRenderBoard(container);
            } catch (err) {
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
            let currentProject = projects.find(p => p.id == selectedProjectId);
            if (!currentProject) {
                currentProject = projects[0];
                selectedProjectId = currentProject.id;
            }
            
            // Fetch views for project
            const views = await this.apiGet(`/projects/${selectedProjectId}/views?per_page=500`);
            const kanbanView = views ? views.find(v => v.view_kind === 'kanban') : null;
            
            if (!kanbanView) {
                this.renderBoardLayout(container, projects, currentProject, null, []);
                return;
            }
            
            // Fetch buckets and tasks
            const bucketsWithTasks = await this.apiGet(`/projects/${selectedProjectId}/views/${kanbanView.id}/tasks?per_page=500`);
            
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
                bucketsWithTasks.forEach(bucket => {
                    if (bucket.tasks) {
                        bucket.tasks.forEach(task => {
                            this.taskCache[task.id] = task;
                        });
                    }
                });
            }

            this.renderBoardLayout(container, projects, currentProject, kanbanView, bucketsWithTasks);
        } catch (err) {
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
        let boardContentHtml = '';
        
        if (!kanbanView) {
            boardContentHtml = `
                <div class="kanban-no-view-wrapper">
                    <h3>No Kanban View Available</h3>
                    <p>This project does not have a Kanban view configured in Vikunja.</p>
                </div>
            `;
        } else if (!bucketsWithTasks || bucketsWithTasks.length === 0) {
            boardContentHtml = `
                <div class="kanban-no-view-wrapper">
                    <h3>No Buckets Found</h3>
                    <p>There are no buckets configured in this Kanban view.</p>
                </div>
            `;
        } else {
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
                            ${projects.map(p => `<option value="${p.id}" ${p.id == currentProject.id ? 'selected' : ''}>${this.escapeHtml(p.title)}</option>`).join('')}
                        </select>
                        <div class="kanban-search-wrapper" style="margin-left: 8px;">
                            <input type="text" id="kanban-search-input" class="kanban-search-input" placeholder="Filter tasks..." />
                        </div>
                        <button id="kanban-refresh-btn" class="toolbar-btn" title="Refresh Board">
                            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="23 4 23 10 17 10"></polyline>
                                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                            </svg>
                        </button>
                        <button id="kanban-add-column-btn" class="toolbar-btn" title="Add Column">
                            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="3" y="4" width="18" height="16" rx="2"></rect>
                                <line x1="12" y1="10" x2="12" y2="14"></line>
                                <line x1="10" y1="12" x2="14" y2="12"></line>
                            </svg>
                            <span>Column</span>
                        </button>
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
                if (!title) return;
                try {
                    await this.createBucket(title, container);
                } catch (err) {
                    this.app.showToast(`Failed to add column: ${err.message}`, { type: 'error', title: 'Kanban' });
                }
            });
        }

        // Column rename: click the title to edit inline. Blur or Enter saves,
        // Escape cancels. Reverts to the original text if the input is empty
        // or unchanged.
        container.querySelectorAll('.column-title').forEach(titleEl => {
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
                input.focus();
                input.select();

                let finished = false;
                const finish = async (save) => {
                    if (finished) return;
                    finished = true;
                    const next = save ? input.value.trim() : current;
                    if (save && next && next !== current) {
                        try {
                            await this.updateBucket(id, next, container);
                        } catch (err) {
                            this.app.showToast(`Rename failed: ${err.message}`, { type: 'error', title: 'Kanban' });
                            // Restore the original title without a full reload.
                            input.replaceWith(titleEl);
                            titleEl.textContent = current;
                        }
                    } else {
                        // No change or cancel: restore the title span.
                        input.replaceWith(titleEl);
                        titleEl.textContent = current;
                    }
                };
                input.addEventListener('blur', () => finish(true));
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
                    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
                });
            });
        });

        // Column edit + delete icons next to each column header.
        container.querySelectorAll('.column-edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.bucketId;
                const titleEl = container.querySelector(`.column-title[data-bucket-id="${id}"]`);
                if (titleEl) titleEl.click();
            });
        });
        container.querySelectorAll('.column-delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.dataset.bucketId;
                const titleEl = container.querySelector(`.column-title[data-bucket-id="${id}"]`);
                const name = titleEl ? titleEl.textContent : `#${id}`;
                if (!confirm(`Delete column "${name}" and all its tasks? This cannot be undone.`)) return;
                try {
                    await this.deleteBucket(id, container);
                } catch (err) {
                    this.app.showToast(`Failed to delete column: ${err.message}`, { type: 'error', title: 'Kanban' });
                }
            });
        });

        // Inline card delete (the X button revealed on hover). Confirms, then
        // calls deleteTask which clears the cache and reloads the board.
        container.querySelectorAll('.kanban-card-delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.dataset.taskId;
                const task = this.taskCache[id];
                const label = task ? `"${task.title}"` : `#${id}`;
                if (!confirm(`Delete task ${label}? This cannot be undone.`)) return;
                try {
                    await this.deleteTask(id, container);
                } catch (err) {
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
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    const query = searchInput.value.trim().toLowerCase();
                    const cards = container.querySelectorAll('.kanban-card');
                    cards.forEach(card => {
                        const taskId = card.dataset.taskId;
                        const task = this.taskCache[taskId];
                        if (!query) {
                            card.classList.remove('hidden-by-filter');
                            return;
                        }
                        let match = false;
                        if (task) {
                            if (task.title && task.title.toLowerCase().includes(query)) match = true;
                            if (task.identifier && task.identifier.toLowerCase().includes(query)) match = true;
                            if (task.labels && task.labels.some(l => l.title && l.title.toLowerCase().includes(query))) match = true;
                        }
                        if (match) {
                            card.classList.remove('hidden-by-filter');
                        } else {
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
                    input.focus();
                    
                    const reset = () => {
                        wrapper.innerHTML = `<button class="kanban-add-task-btn">+ Add Task</button>`;
                        addWrapperSetup();
                    };

                    input.addEventListener('keydown', async (ev) => {
                        if (ev.key === 'Escape') {
                            reset();
                        } else if (ev.key === 'Enter') {
                            const val = input.value.trim();
                            if (!val) { reset(); return; }
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
                            } catch (err) {
                                alert(`Failed to create task: ${err.message}`);
                                reset();
                            }
                        }
                    });

                    input.addEventListener('blur', () => {
                        setTimeout(() => {
                            if (document.activeElement !== input && !input.value.trim()) reset();
                        }, 150);
                    });
                };
            });
        };
        addWrapperSetup();
        
        // Initialize Sortable if buckets are rendered
        if (kanbanView && bucketsWithTasks && bucketsWithTasks.length > 0) {
            this.initSortable(container, bucketsWithTasks);
        }
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
                    ${tasks.map(task => this.renderCard(task)).join('')}
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
                    ${task.labels.map(lbl => {
                        const hex = safeHexColor(lbl.hex_color);
                        const style = hex ? `style="background-color: #${hex}25; color: #${hex}; border: 1px solid #${hex}40;"` : '';
                        return `<span class="kanban-label-pill" ${style} title="${this.escapeHtml(lbl.title || '')}">${this.escapeHtml(lbl.title)}</span>`;
                    }).join('')}
                </div>
            `;
        }
        
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
                    
                    if (oldBucketId === newBucketId) return;
                    
                    // Optimistically update card done styling
                    const targetBucket = (this.buckets || []).find(b => b.id == newBucketId);
                    const isDoneBucket = bucketIsDone(targetBucket);
                    if (isDoneBucket) {
                        evt.item.classList.add('kanban-card--done');
                    } else {
                        evt.item.classList.remove('kanban-card--done');
                    }

                    this.updateColumnCounts(container);
                    
                    try {
                        await this.moveTask(taskId, newBucketId);
                        this.app.showToast('Task updated successfully.', { type: 'success' });
                    } catch (err) {
                        console.error('Failed to move task:', err);
                        this.app.showToast(`Failed to move task: ${err.message}`, { type: 'error' });
                        
                        // Revert drag
                        evt.from.appendChild(evt.item);
                        
                        // Revert done styling
                        const originalBucket = (this.buckets || []).find(b => b.id == oldBucketId);
                        const isOriginalDone = bucketIsDone(originalBucket);
                        if (isOriginalDone) {
                            evt.item.classList.add('kanban-card--done');
                        } else {
                            evt.item.classList.remove('kanban-card--done');
                        }

                        this.updateColumnCounts(container);
                    }
                }
            });

            // Register card click to open details
            list.addEventListener('click', (evt) => {
                if (this._dragActive) return;
                const card = evt.target.closest('.kanban-card');
                if (!card) return;
                
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
            const task = await this.apiGet(`/tasks/${taskId}`);
            this.renderDetailPanelContent(panel, task, cardEl, container);
        } catch (err) {
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
                    ${task.labels.map(lbl => {
                        const hex = safeHexColor(lbl.hex_color);
                        const style = hex ? `style="background-color: #${hex}25; color: #${hex}; border: 1px solid #${hex}40;"` : '';
                        return `<span class="kanban-label-pill kdp-label-removable" data-label-id="${lbl.id}" ${style}>${this.escapeHtml(lbl.title)}<button class="kdp-label-remove-btn" data-label-id="${lbl.id}" title="Remove label" aria-label="Remove label">×</button></span>`;
                    }).join('')}
                </div>
            `;
        } else {
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

                <div class="kdp-field">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                        <label for="kdp-description" style="margin-bottom: 0;">Description</label>
                        <button id="kdp-desc-toggle-btn" class="dropup-action-btn" title="Edit description" style="width: 24px; height: 24px; padding: 0;">
                            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 13px; height: 13px; display: block;">
                                <path d="M12 20h9"></path>
                                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                            </svg>
                        </button>
                    </div>
                    <div id="kdp-description-view" class="kanban-desc-html">${this.escapeHtml(task.description || '') || '<span style="color: var(--text-muted); font-style: italic;">No description provided</span>'}</div>
                    <textarea id="kdp-description" class="hidden" placeholder="No description provided" style="font-family: var(--font-mono); font-size: 12px; height: 160px; line-height: 1.5;">${this.escapeHtml(task.description || '')}</textarea>
                </div>

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

        // Wire events
        const toggleBtn = panel.querySelector('#kdp-desc-toggle-btn');
        const descView = panel.querySelector('#kdp-description-view');
        const descInput = panel.querySelector('#kdp-description');

        const PENCIL_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 13px; height: 13px; display: block;"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
        const EYE_SVG = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 13px; height: 13px; display: block;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;

        toggleBtn.addEventListener('click', () => {
            if (descInput.classList.contains('hidden')) {
                descInput.classList.remove('hidden');
                descView.classList.add('hidden');
                toggleBtn.innerHTML = EYE_SVG;
                toggleBtn.title = 'Preview description';
            } else {
                descInput.classList.add('hidden');
                descView.classList.remove('hidden');
                // XSS-safe: escape the textarea value before injecting as HTML.
                // The view already renders the (escaped) original description; we
                // re-escape here so user-typed content cannot inject markup and
                // so escape sequences round-trip consistently.
                descView.innerHTML = this.escapeHtml(descInput.value) || '<span style="color: var(--text-muted); font-style: italic;">No description provided</span>';
                toggleBtn.innerHTML = PENCIL_SVG;
                toggleBtn.title = 'Edit description';
            }
        });

        // Label picker: populate the dropdown with all labels (minus ones
        // already on this task), enable Add when a real option is chosen, and
        // wire remove-X on each existing label pill.
        this._wireLabelPicker(panel, task, container);

        panel.querySelector('.kdp-close-btn').addEventListener('click', () => this.closeDetailPanel());
        panel.querySelector('.kdp-cancel-btn').addEventListener('click', () => this.closeDetailPanel());

        // Detail-panel Delete button. Confirms, then deletes the task and closes
        // the panel. The container ref is captured so the board reloads.
        const deleteBtn = panel.querySelector('.kdp-delete-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async () => {
                if (!confirm(`Delete task "${task.title}"? This cannot be undone.`)) return;
                deleteBtn.disabled = true;
                try {
                    await this.deleteTask(task.id, container);
                    this.closeDetailPanel();
                } catch (err) {
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
                const newPriority = parseInt(panel.querySelector('#kdp-priority').value);
                const newDueDateVal = panel.querySelector('#kdp-due-date').value;
                const newDone = panel.querySelector('#kdp-done').checked;
                const newDescription = panel.querySelector('#kdp-description').value;

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
            } catch (err) {
                console.error('Failed to save task detail:', err);
                this.app.showToast(`Failed to save task: ${err.message}`, { type: 'error' });
            } finally {
                // FIN-1: re-enable the button even if loadAndRenderBoard throws
                // after a successful save (the catch-only path left it stuck).
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save';
            }
        });
    }

    async saveTaskDetail(task, formData, cardEl, container) {
        const payload = {
            ...task,
            title: formData.title,
            priority: formData.priority,
            description: formData.description,
            done: formData.done,
            due_date: formData.due_date || '0001-01-01T00:00:00Z',
            labels: (task.labels || []).map(l => ({ id: l.id })),
            assignees: (task.assignees || []).map(a => ({ id: a.id }))
        };

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
        if (container) await this.loadAndRenderBoard(container);
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
        if (!t) throw new Error('Bucket title cannot be empty.');
        await this.apiPut(
            `/projects/${this.currentProjectId}/views/${this.currentViewId}/buckets`,
            { title: t }
        );
        if (container) await this.loadAndRenderBoard(container);
    }

    // updateBucket renames a bucket via POST /projects/{p}/views/{v}/buckets/{b}.
    async updateBucket(bucketId, title, container) {
        if (!this.currentProjectId || !this.currentViewId) {
            throw new Error('Bucket update failed: project or view not loaded yet.');
        }
        const t = (title || '').trim();
        if (!t) throw new Error('Bucket title cannot be empty.');
        await this.apiPost(
            `/projects/${this.currentProjectId}/views/${this.currentViewId}/buckets/${bucketId}`,
            { title: t }
        );
        if (container) await this.loadAndRenderBoard(container);
    }

    // deleteBucket removes a bucket. Drops cached tasks that belonged to it.
    async deleteBucket(bucketId, container) {
        if (!this.currentProjectId || !this.currentViewId) {
            throw new Error('Bucket delete failed: project or view not loaded yet.');
        }
        await this.apiDelete(
            `/projects/${this.currentProjectId}/views/${this.currentViewId}/buckets/${bucketId}`
        );
        for (const [id, t] of Object.entries(this.taskCache)) {
            if (t.bucket_id == bucketId) delete this.taskCache[id];
        }
        this.buckets = (this.buckets || []).filter(b => b.id != bucketId);
        if (container) await this.loadAndRenderBoard(container);
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
        if (!picker || !addBtn) return;

        // Try to populate; if the call fails (offline, no permission), the
        // picker stays empty but the rest of the panel still works.
        try {
            const all = (await this.fetchAllLabels()) || [];
            const have = new Set((task.labels || []).map(l => l.id));
            const opts = ['<option value="">Add label…</option>']
                .concat(all.filter(l => !have.has(l.id))
                          .map(l => `<option value="${l.id}">${this.escapeHtml(l.title || '(unnamed)')}</option>`));
            picker.innerHTML = opts.join('');
        } catch (_) {
            // Leave the placeholder only; user can still X-off existing labels.
        }

        picker.addEventListener('change', () => {
            addBtn.disabled = !picker.value;
        });
        addBtn.addEventListener('click', async () => {
            const id = parseInt(picker.value, 10);
            if (!id) return;
            addBtn.disabled = true;
            try {
                await this.addLabelToTask(task.id, id);
                // Re-render the labels section + repopulate the picker.
                const fresh = this.taskCache[task.id] || task;
                this._refreshDetailPanelLabels(panel, fresh, container);
            } catch (err) {
                this.app.showToast(`Failed to add label: ${err.message}`, { type: 'error', title: 'Kanban' });
                addBtn.disabled = false;
            }
        });

        // Remove buttons on each existing label pill.
        panel.querySelectorAll('.kdp-label-remove-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = parseInt(btn.dataset.labelId, 10);
                if (!id) return;
                btn.disabled = true;
                try {
                    await this.removeLabelFromTask(task.id, id);
                    const fresh = this.taskCache[task.id] || task;
                    this._refreshDetailPanelLabels(panel, fresh, container);
                } catch (err) {
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
                        ${task.labels.map(lbl => {
                            const hex = safeHexColor(lbl.hex_color);
                            const style = hex ? `style="background-color: #${hex}25; color: #${hex}; border: 1px solid #${hex}40;"` : '';
                            return `<span class="kanban-label-pill kdp-label-removable" data-label-id="${lbl.id}" ${style}>${this.escapeHtml(lbl.title)}<button class="kdp-label-remove-btn" data-label-id="${lbl.id}" title="Remove label" aria-label="Remove label">×</button></span>`;
                        }).join('')}
                    </div>
                `;
            } else {
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
            this.taskCache[taskId].labels = this.taskCache[taskId].labels.filter(l => l.id != labelId);
        }
    }

    async moveTask(taskId, newBucketId) {
        const existing = this.taskCache[taskId];
        if (!existing) throw new Error(`Task ${taskId} not in cache`);

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
        await this.apiPost(
            `/projects/${this.currentProjectId}/views/${this.currentViewId}/buckets/${targetBucketId}/tasks`,
            { task_id: parseInt(taskId, 10) }
        );

        // Mirror the move in the local cache so the UI is consistent until
        // the next refresh; the dedicated endpoint doesn't return the updated
        // task, so we just adjust the fields we know changed.
        existing.bucket_id = targetBucketId;
    }

    async apiGet(path) {
        const token = sessionStorage.getItem('vikunja_token');
        const url = localStorage.getItem('vikunja_url');
        const proxyUrl = `/api/proxy?url=${encodeURIComponent(url + '/api/v1' + path)}`;
        
        const res = await fetch(proxyUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (res.status === 401) {
            sessionStorage.removeItem('vikunja_token');
            throw new Error('Session expired. Please reconnect.');
        }
        
        if (!res.ok) {
            const text = await res.text();
            throw new Error(text || `Request failed with status ${res.status}`);
        }
        
        return await res.json();
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
        if (res.status === 204 || !ctype.includes('application/json')) return null;
        return await res.json();
    }
}
